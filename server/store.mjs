import {randomUUID} from 'node:crypto';
export const SUPPORTER_DAYS=30; // Every fulfilled pack grants this many days of the supporter star; repeat purchases extend the current window.
export const DEFAULT_CATALOG=[ // Placeholder packs anchored to the 50-coin exchange; STORE_CATALOG in the environment replaces the whole list.
 {sku:'handful',name:'Handful of diamonds',diamonds:5,price_cents:199,currency:'USD'},
 {sku:'pouch',name:'Pouch of diamonds',diamonds:15,price_cents:499,currency:'USD'},
 {sku:'chest',name:'Chest of diamonds',diamonds:40,price_cents:999,currency:'USD'},
 {sku:'hoard',name:'Diamond hoard',diamonds:100,price_cents:1999,currency:'USD'},
];
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code});}; // Safe, actionable errors for the authenticated API.
const CLAWBACK_EVENTS={'PAYMENT.CAPTURE.REFUNDED':'refunded','PAYMENT.CAPTURE.REVERSED':'refunded','PAYMENT.CAPTURE.DENIED':'failed','CUSTOMER.DISPUTE.CREATED':'disputed'}; // Webhook types that take diamonds back, and the status each leaves behind.

export function storeCatalog(source=process.env.STORE_CATALOG){ // Validate the catalogue once at boot so a typo cannot sell free or negative diamonds.
 if(!source)return DEFAULT_CATALOG;
 let list;try{list=JSON.parse(source);}catch{throw Error('STORE_CATALOG must be a JSON array.');}
 if(!Array.isArray(list)||!list.length)throw Error('STORE_CATALOG must list at least one pack.');
 const seen=new Set(),currency=list[0]?.currency;
 for(const p of list){
  if(typeof p?.sku!=='string'||!/^[a-z0-9_-]{1,32}$/.test(p.sku)||seen.has(p.sku))throw Error('Each STORE_CATALOG pack needs a unique lowercase sku.');seen.add(p.sku);
  if(typeof p.name!=='string'||!p.name.trim()||p.name.length>80)throw Error('Each STORE_CATALOG pack needs a name.');
  if(!Number.isSafeInteger(p.diamonds)||p.diamonds<1||p.diamonds>100000)throw Error('Pack diamonds must be a whole number between 1 and 100000.');
  if(!Number.isSafeInteger(p.price_cents)||p.price_cents<50||p.price_cents>100000)throw Error('Pack price_cents must be a whole number between 50 and 100000.');
  if(p.currency!==currency||!/^[A-Z]{3}$/.test(currency))throw Error('Every pack must share one three-letter currency code.');
 }
 return list.map(({sku,name,diamonds,price_cents,currency})=>({sku,name,diamonds,price_cents,currency}));
}

export function createStore(db,{wallet,adjust,enabled=()=>true,paypal=null,catalog=DEFAULT_CATALOG,publicOrigin='',now=Date.now,log=console.warn}={}){ // Diamond pack purchases inside market.sqlite; PayPal is the only payment rail, staff grants are the manual fallback.
 db.exec(`CREATE TABLE IF NOT EXISTS store_purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES economy_wallets(owner),request_id TEXT,order_id TEXT UNIQUE,sku TEXT NOT NULL,diamonds INTEGER NOT NULL CHECK(diamonds>0),price_cents INTEGER NOT NULL CHECK(price_cents>=0),currency TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','refunded','disputed','failed','cancelled')),capture_id TEXT,payer_id TEXT,clawback_short INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS store_purchase_owner ON store_purchases(owner,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS store_purchase_request ON store_purchases(owner,request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS store_purchase_capture ON store_purchases(capture_id);
  CREATE TABLE IF NOT EXISTS store_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,purchase_id TEXT,received_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS store_supporters(owner TEXT PRIMARY KEY REFERENCES economy_wallets(owner),until INTEGER NOT NULL);`); // Idempotent: adds tables beside the existing wallet without changing the market schema version.
 const stamp=()=>new Date(now()).toISOString(); // Row timestamps follow the injectable clock so tests can move time.
 const pack=sku=>catalog.find(p=>p.sku===sku)??fail(400,'Choose a diamond pack.','unknown_sku');
 const row=id=>db.prepare('SELECT * FROM store_purchases WHERE id=?').get(id);
 const publicRow=r=>({id:r.id,sku:r.sku,diamonds:r.diamonds,price_cents:r.price_cents,currency:r.currency,status:r.status,created_at:r.created_at,updated_at:r.updated_at}); // Buyers never see payer ids or staff notes.

 function supporterUntil(owner){const until=db.prepare('SELECT until FROM store_supporters WHERE owner=?').get(owner)?.until??null;return until!==null&&until>now()?until:null;} // Expired windows read as absent; the row is harmless to keep.
 function extendSupporter(owner,days=SUPPORTER_DAYS){ // A new pack adds days to the current window rather than restarting it, so buying twice never wastes a day.
  const base=Math.max(supporterUntil(owner)??0,now()),until=base+days*86400000;
  db.prepare('INSERT INTO store_supporters(owner,until) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET until=excluded.until').run(owner,until);return until;
 }
 function shrinkSupporter(owner,days=SUPPORTER_DAYS){ // Clawbacks remove the days that purchase granted; a window that would end in the past simply ends now.
  const current=supporterUntil(owner);if(current===null)return null;
  const until=Math.max(now(),current-days*86400000);db.prepare('UPDATE store_supporters SET until=? WHERE owner=?').run(until,owner);return until>now()?until:null;
 }
 function fulfil(id,{captureId=null,payerId=null,note}={}){ // The credit, ledger line, supporter extension and status change commit together, exactly once per purchase.
  db.exec('BEGIN IMMEDIATE');
  try{
   const r=row(id);if(!r)fail(404,'Unknown purchase.','unknown_purchase');
   if(r.status==='fulfilled'){db.exec('COMMIT');return receipt(r);} // A retry, or a webhook arriving after the capture, sees the finished row.
   if(r.status!=='pending')fail(409,'This purchase is '+r.status+'.','purchase_closed');
   wallet(r.owner);adjust(r.owner,'diamonds',r.diamonds,'store:'+r.id,r.order_id?'Diamond pack purchase':'Staff diamond grant');
   extendSupporter(r.owner);
   db.prepare("UPDATE store_purchases SET status='fulfilled',capture_id=COALESCE(?,capture_id),payer_id=COALESCE(?,payer_id),note=CASE WHEN ? IS NULL THEN note ELSE ? END,updated_at=? WHERE id=?").run(captureId,payerId,note??null,note??null,stamp(),id);
   db.exec('COMMIT');return receipt(row(id));
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function clawback(id,status,reason){ // Take back what the purchase granted without ever driving the balance negative; any shortfall is recorded for staff.
  db.exec('BEGIN IMMEDIATE');
  try{
   const r=row(id);if(!r){db.exec('COMMIT');return null;}
   if(r.status!=='fulfilled'){ // Pending or already clawed-back rows only pick up the new status; nothing was credited that could be removed.
    if(r.status==='pending')db.prepare('UPDATE store_purchases SET status=?,note=?,updated_at=? WHERE id=?').run(status,reason,stamp(),id);
    db.exec('COMMIT');return row(id);
   }
   const have=wallet(r.owner).diamonds,debit=Math.min(have,r.diamonds),short=r.diamonds-debit;
   if(debit>0)adjust(r.owner,'diamonds',-debit,'store-'+status+':'+r.id,status==='disputed'?'Diamond pack dispute':'Diamond pack refund');
   shrinkSupporter(r.owner);
   db.prepare('UPDATE store_purchases SET status=?,clawback_short=?,note=?,updated_at=? WHERE id=?').run(status,short,reason,stamp(),id);
   db.exec('COMMIT');return row(id);
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function receipt(r){return {...publicRow(r),balance:wallet(r.owner).diamonds,supporter_until:supporterUntil(r.owner)};} // What the buyer sees after a capture: the pack, their new balance and the star's end date.

 function view(owner){ // The storefront payload: nothing secret, and no purchase rows belonging to anyone else.
  return {enabled:Boolean(paypal),environment:paypal?.environment??null,client_id:paypal?.clientId??null,currency:catalog[0].currency,catalog,purchases:db.prepare('SELECT * FROM store_purchases WHERE owner=? ORDER BY created_at DESC,id LIMIT 20').all(owner).map(publicRow),supporter_until:supporterUntil(owner)};
 }
 async function begin(owner,input){ // Create the PayPal order with OUR price; the browser only names the pack and its idempotency key.
  if(!paypal)fail(503,'The diamond store is not available right now.','store_disabled');
  if(!enabled(owner))fail(403,'This account cannot make purchases.','account_disabled');
  if(!input||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId))fail(400,'Supply a unique request ID.','invalid_request');
  const existing=db.prepare('SELECT * FROM store_purchases WHERE owner=? AND request_id=?').get(owner,input.requestId);
  if(existing){if(existing.sku!==input.sku)fail(409,'This request ID already started a different purchase.','request_reused');return {id:existing.id,order_id:existing.order_id,status:existing.status};} // A double click returns the same order instead of opening two.
  const p=pack(input.sku),id=randomUUID(),at=stamp();wallet(owner);
  if(db.prepare("SELECT COUNT(*) AS n FROM store_purchases WHERE owner=? AND status='pending' AND created_at>?").get(owner,new Date(now()-3600000).toISOString()).n>=10)fail(429,'Finish or cancel your open purchases first.','too_many_pending'); // Abandoned checkouts cannot pile up PayPal orders.
  db.prepare("INSERT INTO store_purchases(id,owner,request_id,sku,diamonds,price_cents,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").run(id,owner,input.requestId,p.sku,p.diamonds,p.price_cents,p.currency,at,at);
  try{
   const order=await paypal.createOrder({purchaseId:id,amountCents:p.price_cents,currency:p.currency,description:p.name+' for LiDollQuest ('+p.diamonds+' diamonds)',returnUrl:publicOrigin+'/tracker/#stickers',cancelUrl:publicOrigin+'/tracker/#stickers'});
   db.prepare('UPDATE store_purchases SET order_id=?,updated_at=? WHERE id=?').run(order.id,stamp(),id);
   return {id,order_id:order.id,status:'pending'};
  }catch(error){db.prepare("UPDATE store_purchases SET status='failed',note=?,updated_at=? WHERE id=?").run('PayPal order creation failed.',stamp(),id);throw error;} // The row keeps the failure for staff; the buyer can simply try again.
 }
 async function capture(owner,input){ // Capture on our side, then verify every fact PayPal reports against the row before a single diamond moves.
  if(!paypal)fail(503,'The diamond store is not available right now.','store_disabled');
  const r=typeof input?.id==='string'?row(input.id):null;
  if(!r||r.owner!==owner)fail(404,'Unknown purchase.','unknown_purchase'); // Another account's purchase id reads as missing, never as forbidden-but-real.
  if(r.status==='fulfilled')return receipt(r);
  if(r.status!=='pending'||!r.order_id)fail(409,'This purchase can no longer be completed.','purchase_closed');
  const facts=await paypal.captureOrder(r.order_id);
  if(facts.status!=='COMPLETED')fail(409,'PayPal has not completed this payment yet.','payment_incomplete');
  if(facts.customId!==r.id||facts.amountCents!==r.price_cents||facts.currency!==r.currency){log('store: capture mismatch',{purchase:r.id,facts});fail(409,'The payment details did not match this purchase. Support has been notified.','payment_mismatch');} // Never credit a pack for a payment that does not match its price to the cent.
  return fulfil(r.id,{captureId:facts.captureId,payerId:facts.payerId});
 }
 async function webhook(headers,rawBody){ // PayPal's copy of events: the fallback fulfilment path and the only source of refunds, reversals and disputes.
  if(!paypal)fail(503,'The diamond store is not available right now.','store_disabled');
  const event=await paypal.verifyWebhook(headers,rawBody);
  if(typeof event?.id!=='string'||typeof event.event_type!=='string')fail(400,'Invalid webhook event.','invalid_webhook');
  const resource=event.resource??{},custom=resource.custom_id??null,orderId=resource.supplementary_data?.related_ids?.order_id??null,captureId=event.event_type.startsWith('PAYMENT.CAPTURE.')?resource.id??null:resource.disputed_transactions?.[0]?.seller_transaction_id??null;
  const target=(custom&&row(custom))??(orderId&&db.prepare('SELECT * FROM store_purchases WHERE order_id=?').get(orderId))??(captureId&&db.prepare('SELECT * FROM store_purchases WHERE capture_id=?').get(captureId))??null;
  if(!db.prepare('INSERT OR IGNORE INTO store_events(id,type,purchase_id,received_at) VALUES (?,?,?,?)').run(event.id,event.event_type,target?.id??null,stamp()).changes)return {ok:true,duplicate:true}; // PayPal retries deliveries; each event id acts once.
  if(!target)return {ok:true,ignored:'no matching purchase'};
  if(event.event_type==='PAYMENT.CAPTURE.COMPLETED'){
   const cents=Math.round(Number(resource.amount?.value)*100);
   if(cents!==target.price_cents||resource.amount?.currency_code!==target.currency){log('store: webhook amount mismatch',{purchase:target.id});return {ok:true,ignored:'amount mismatch'};}
   fulfil(target.id,{captureId:resource.id??null});return {ok:true,fulfilled:target.id};
  }
  if(CLAWBACK_EVENTS[event.event_type]){clawback(target.id,CLAWBACK_EVENTS[event.event_type],event.event_type+(event.summary?': '+String(event.summary).slice(0,200):''));return {ok:true,clawback:target.id};}
  return {ok:true,ignored:event.event_type}; // Other subscribed events (dispute resolved, etc.) stay in store_events for staff to read.
 }
 function list(){return db.prepare('SELECT * FROM store_purchases ORDER BY created_at DESC,id LIMIT 200').all().map(r=>({...r,supporter_until:supporterUntil(r.owner)}));} // Admin view: full rows including notes and shortfalls.
 function grant(owner,input){ // Manual fulfilment for payment links, itch.io keys or goodwill; recorded like a purchase with no PayPal order.
  if(!enabled(owner))fail(404,'That account is not available.','account_disabled');
  const p=pack(input?.sku),reason=typeof input?.reason==='string'?input.reason.trim().slice(0,500):'';if(!reason)fail(400,'Give a reason for the grant.','reason_required');
  const id=randomUUID(),at=stamp();wallet(owner);
  db.prepare("INSERT INTO store_purchases(id,owner,sku,diamonds,price_cents,currency,status,note,created_at,updated_at) VALUES (?,?,?,?,0,?,'pending',?,?,?)").run(id,owner,p.sku,p.diamonds,p.currency,reason,at,at);
  return fulfil(id,{note:reason});
 }
 async function refund(input){ // Staff refund: PayPal first, then the clawback; a grant with no capture is clawed back directly.
  const r=typeof input?.id==='string'?row(input.id):null;if(!r)fail(404,'Unknown purchase.','unknown_purchase');
  const reason=typeof input?.reason==='string'?input.reason.trim().slice(0,500):'';if(!reason)fail(400,'Give a reason for the refund.','reason_required');
  if(r.status!=='fulfilled')fail(409,'Only fulfilled purchases can be refunded.','purchase_closed');
  if(r.capture_id){if(!paypal)fail(503,'The diamond store is not available right now.','store_disabled');await paypal.refundCapture(r.capture_id,{amountCents:r.price_cents,currency:r.currency,note:reason.slice(0,255)});}
  return clawback(r.id,'refunded','Staff refund: '+reason);
 }
 function expirePending(olderThanMs=3*86400000){ // Housekeeping for the reward timer: PayPal orders expire after ~3 days, so mark abandoned checkouts cancelled.
  return db.prepare("UPDATE store_purchases SET status='cancelled',updated_at=? WHERE status='pending' AND created_at<?").run(stamp(),new Date(now()-olderThanMs).toISOString()).changes;
 }
 return {catalog:()=>catalog,view,begin,capture,webhook,list,grant,refund,expirePending,supporterUntil,supporter:owner=>supporterUntil(owner)!==null,fulfil,clawback};
}
