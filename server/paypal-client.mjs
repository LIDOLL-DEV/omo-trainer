const HOSTS={sandbox:'https://api-m.sandbox.paypal.com',live:'https://api-m.paypal.com'}; // REST API hosts; the browser SDK uses www.[sandbox.]paypal.com instead.
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code});}; // Errors carry an HTTP status so the API layer can relay them safely.

export function paypalConfig(env=process.env){ // Read the store configuration once; the store is simply disabled until both credentials exist.
 const clientId=env.PAYPAL_CLIENT_ID??'',secret=env.PAYPAL_CLIENT_SECRET??'',environment=env.PAYPAL_ENV==='live'?'live':'sandbox';
 return {enabled:Boolean(clientId&&secret),clientId,secret,environment,webhookId:env.PAYPAL_WEBHOOK_ID??'',baseUrl:env.PAYPAL_API_URL??HOSTS[environment]}; // PAYPAL_API_URL exists for the test fixture only.
}

export function createPayPalClient({clientId,secret,baseUrl,webhookId='',environment='sandbox',fetcher=fetch,now=Date.now}={}){ // Thin Orders v2 / Payments v2 wrapper with a cached OAuth token.
 if(!clientId||!secret)fail(503,'The diamond store is not configured.','store_disabled');
 const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol))fail(500,'Invalid PayPal API URL.','store_misconfigured');
 let token=null,expires=0; // Access tokens last hours; refresh a minute early so a request never carries a stale one.
 async function call(method,path,body,headers={}){ // Every call is bounded (timeout + response size) so a slow gateway cannot pin the worker.
  const response=await fetcher(new URL(path,base),{method,headers,body,redirect:'error',signal:AbortSignal.timeout(15000)});
  const chunks=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.length;if(size>262144)fail(502,'PayPal response too large.','paypal_unavailable');chunks.push(Buffer.from(chunk));}
  const text=Buffer.concat(chunks).toString('utf8');let data={};if(text){try{data=JSON.parse(text);}catch{fail(502,'PayPal returned an unreadable response.','paypal_unavailable');}}
  return {status:response.status,ok:response.ok,data};
 }
 async function accessToken(){ // Client-credentials grant; the secret never leaves this module.
  if(token&&expires>now()+60000)return token;
  const r=await call('POST','/v1/oauth2/token','grant_type=client_credentials',{Authorization:'Basic '+Buffer.from(clientId+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'});
  if(!r.ok||typeof r.data.access_token!=='string')fail(502,'PayPal sign-in failed.','paypal_unavailable');
  token=r.data.access_token;expires=now()+Math.max(60,Number(r.data.expires_in)||0)*1000;return token;
 }
 async function api(method,path,body,requestId){ // JSON call with a PayPal-Request-Id so our retries are idempotent on their side too.
  const headers={Authorization:'Bearer '+await accessToken(),'Content-Type':'application/json',...(requestId?{'PayPal-Request-Id':requestId}:{})};
  const r=await call(method,path,body===undefined?undefined:JSON.stringify(body),headers);
  if(r.status===401){token=null;return api(method,path,body,requestId);} // One transparent retry after an expired token.
  return r;
 }
 async function getOrder(orderId){const r=await api('GET','/v2/checkout/orders/'+encodeURIComponent(orderId));if(!r.ok)fail(502,'PayPal could not read this order.','paypal_unavailable');return summarise(r.data);} // Read-only view used after a lost capture response.
 return {
  environment,clientId, // Public facts the storefront needs to load the matching PayPal SDK; the secret stays closed over.
  async createOrder({purchaseId,amountCents,currency,description,returnUrl,cancelUrl}){ // The order carries our purchase id as custom_id so capture and webhooks can be tied back to it.
   const value=(amountCents/100).toFixed(2);
   const r=await api('POST','/v2/checkout/orders',{intent:'CAPTURE',purchase_units:[{reference_id:purchaseId,custom_id:purchaseId,description,amount:{currency_code:currency,value}}],payment_source:{paypal:{experience_context:{user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING',brand_name:'LiDollQuest',return_url:returnUrl,cancel_url:cancelUrl}}}},purchaseId);
   if(!r.ok||typeof r.data.id!=='string')fail(502,'PayPal could not start this purchase.','paypal_unavailable');
   return {id:r.data.id,status:r.data.status};
  },
  async captureOrder(orderId){ // Returns the first capture's verified facts; the store compares them to the catalogue before crediting.
   const r=await api('POST','/v2/checkout/orders/'+encodeURIComponent(orderId)+'/capture',{},'capture-'+orderId);
   if(r.status===422&&r.data?.details?.some(d=>d.issue==='ORDER_ALREADY_CAPTURED'))return getOrder(orderId); // A lost response earlier: read the existing capture instead of failing.
   if(!r.ok)fail(r.status===422?409:502,r.status===422?'PayPal declined this payment.':'PayPal could not complete this payment.',r.status===422?'payment_declined':'paypal_unavailable');
   return summarise(r.data);
  },
  getOrder,
  async refundCapture(captureId,{amountCents,currency,note}){ // Full refund of one capture; the store performs the clawback after PayPal accepts it.
   const r=await api('POST','/v2/payments/captures/'+encodeURIComponent(captureId)+'/refund',{amount:{currency_code:currency,value:(amountCents/100).toFixed(2)},note_to_payer:note},'refund-'+captureId);
   if(!r.ok)fail(502,'PayPal did not accept the refund.','paypal_unavailable');
   return {id:r.data.id,status:r.data.status};
  },
  async verifyWebhook(headers,rawBody){ // PayPal's own verification endpoint checks the transmission signature against the registered webhook id.
   if(!webhookId)fail(503,'Webhook id is not configured.','store_misconfigured');
   let event;try{event=JSON.parse(rawBody);}catch{fail(400,'Invalid webhook body.','invalid_webhook');}
   const pick=name=>headers[name]??headers[name.toLowerCase()]??'';
   const r=await api('POST','/v1/notifications/verify-webhook-signature',{auth_algo:pick('paypal-auth-algo'),cert_url:pick('paypal-cert-url'),transmission_id:pick('paypal-transmission-id'),transmission_sig:pick('paypal-transmission-sig'),transmission_time:pick('paypal-transmission-time'),webhook_id:webhookId,webhook_event:event});
   if(!r.ok||r.data.verification_status!=='SUCCESS')fail(400,'Webhook signature verification failed.','invalid_webhook');
   return event;
  },
 };
}

function summarise(order){ // Flatten the parts of an order the store needs: status, capture id, payer and the captured money.
 const unit=order?.purchase_units?.[0],capture=unit?.payments?.captures?.[0];
 return {id:order?.id,status:capture?.status??order?.status,customId:unit?.custom_id??capture?.custom_id??null,captureId:capture?.id??null,payerId:order?.payer?.payer_id??null,amountCents:capture?Math.round(Number(capture.amount?.value)*100):null,currency:capture?.amount?.currency_code??null};
}
