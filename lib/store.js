const $=selector=>document.querySelector(selector);
let data=null,csrf='',owner='',busy=false,loading=false,epoch=0,sku='',requestId='',current=null,sdk=null,buttons=null;
const visible=()=>location.hash==='#stickers'; // The store card lives on the Stickers & market page beside the diamond exchange.
function node(tag,text,className){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;} // Text nodes only: catalogue names come from the server, never as markup.
const money=(cents,currency)=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format(cents/100); // Prices are whole cents on the wire; only the display formats them.
function status(text){$('#store-status').textContent=text;}
async function request(route,input){ // Same-origin, CSRF-protected calls; a failed session hides the card instead of showing stale packs.
  const response=await fetch('./api/'+route,{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},...(input?{body:JSON.stringify(input)}:{})});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'The store request failed.'),{status:response.status});return result;
}
function choose(next){sku=next;requestId=crypto.randomUUID();current=null;render();} // A fresh idempotency key per selection, so one double click cannot open two PayPal orders.
function render(){ // Rebuild the pack list, the supporter line and the recent purchases from the last server payload.
  const packs=$('#store-packs');packs.replaceChildren();
  if(!data)return;
  for(const pack of data.catalog){
    const label=node('label',undefined,'store-pack'+(pack.sku===sku?' selected':'')),input=node('input');input.type='radio';input.name='store-pack';input.value=pack.sku;input.checked=pack.sku===sku;input.disabled=busy;
    input.addEventListener('change',()=>choose(pack.sku));
    label.append(input,node('span',pack.name,'store-pack-name'),node('span',pack.diamonds.toLocaleString()+' diamonds','store-pack-diamonds'),node('span',money(pack.price_cents,pack.currency),'store-pack-price'));
    packs.append(label);
  }
  const until=data.supporter_until?new Date(data.supporter_until):null;
  $('#store-supporter').textContent=until?'★ Supporter star active until '+until.toLocaleDateString()+'. Another pack adds 30 more days.':'Every pack adds 30 days of the ★ supporter star beside your name here and in LiDollQuest.';
  const history=$('#store-history');history.replaceChildren();
  for(const row of data.purchases.slice(0,10)){const pack=data.catalog.find(p=>p.sku===row.sku);history.append(node('li',new Date(row.created_at).toLocaleDateString()+' · '+(pack?.name??row.sku)+' · '+row.diamonds+' diamonds · '+(row.price_cents?money(row.price_cents,row.currency):'staff grant')+' · '+row.status));}
  if(!data.purchases.length)history.append(node('li','No purchases yet.'));
  $('#store-paypal').hidden=!sku||busy;
}
function loadSdk(){ // Load PayPal's buttons script once, from the host matching the server's environment, with the catalogue currency.
  if(sdk)return sdk;
  sdk=new Promise((resolve,reject)=>{
    const host=data.environment==='live'?'https://www.paypal.com':'https://www.sandbox.paypal.com';
    const script=document.createElement('script');script.src=host+'/sdk/js?'+new URLSearchParams({'client-id':data.client_id,currency:data.currency,intent:'capture',components:'buttons','disable-funding':'paylater,venmo'});
    script.async=true;script.addEventListener('load',()=>window.paypal?resolve(window.paypal):reject(new Error('PayPal did not load.')));script.addEventListener('error',()=>reject(new Error('PayPal could not be loaded. Check your connection or content blockers.')));
    document.head.append(script);
  }).catch(error=>{sdk=null;throw error;});
  return sdk;
}
async function mountButtons(){ // Render the Smart Buttons once; createOrder and onApprove talk only to our server, which owns prices and fulfilment.
  if(buttons||!data?.enabled)return;
  const paypal=await loadSdk();
  buttons=paypal.Buttons({
    style:{layout:'vertical',shape:'pill',label:'pay'},
    createOrder:async()=>{if(!sku)throw new Error('Choose a pack first.');busy=true;render();$('#store-paypal').hidden=false;status('Starting your purchase...');try{current=await request('store/order',{sku,requestId});return current.order_id;}catch(error){busy=false;render();status(error.message);throw error;}},
    onApprove:async()=>{status('Payment approved. Adding your diamonds...');try{const receipt=await request('store/capture',{id:current.id});status('Thank you! '+receipt.diamonds+' diamonds added. You now have '+receipt.balance.toLocaleString()+'.');window.dispatchEvent(new CustomEvent('little-log-store-purchased',{detail:receipt}));}catch(error){status(error.message+' If you were charged, the purchase completes automatically within a few minutes; contact support if it does not.');}finally{busy=false;choose('');await refresh();}},
    onCancel:()=>{busy=false;choose(sku);status('Purchase cancelled. Nothing was charged.');},
    onError:error=>{busy=false;render();status(error?.message||'PayPal reported a problem. Nothing was charged unless you see a receipt from PayPal.');},
  });
  await buttons.render('#store-paypal');
}
async function refresh(){ // Load the catalogue and this account's purchases; the card stays hidden for signed-out visitors and disabled stores.
  if(loading)return;loading=true;const version=++epoch;
  try{
    const result=await request('store');if(version!==epoch)return;
    data=result;csrf=result.csrf;owner=result.participant.id;
    $('#store-card').hidden=!data.enabled;
    if(data.enabled){render();status(data.environment==='sandbox'?'Sandbox mode: test payments only.':'');await mountButtons();}
  }catch(error){
    if(version!==epoch)return;
    if(error.status===401||error.status===403){data=null;csrf='';owner='';$('#store-card').hidden=true;return;}
    $('#store-card').hidden=false;status(error.message);
  }finally{if(version===epoch)loading=false;}
}
window.addEventListener('hashchange',()=>{if(visible())void refresh();});
window.addEventListener('little-log-economy-status',event=>{if(visible()&&event.detail?.connected&&!data)void refresh();}); // The wallet loaded first: fetch the store as soon as the account is known.
if(visible())void refresh();
