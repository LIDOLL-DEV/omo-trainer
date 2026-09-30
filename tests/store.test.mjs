import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {cookie} from '../server/login.mjs';
import {createPayPalClient} from '../server/paypal-client.mjs';
import {storeCatalog,DEFAULT_CATALOG,SUPPORTER_DAYS} from '../server/store.mjs';

async function fakePayPal(){ // A tiny PayPal: OAuth, order create/capture/get, webhook verification and refunds, all recorded for assertions.
 const orders=new Map(),calls=[],state={verify:'SUCCESS',captureStatus:'COMPLETED',declineNext:false,captured:0};
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const text=Buffer.concat(chunks).toString('utf8');calls.push({method:req.method,url:req.url,auth:req.headers.authorization,requestId:req.headers['paypal-request-id']});
  const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/v1/oauth2/token')return json(200,{access_token:'fake-token',expires_in:3600});
  if(req.headers.authorization!=='Bearer fake-token')return json(401,{error:'invalid_token'});
  if(req.url==='/v2/checkout/orders'&&req.method==='POST'){const body=JSON.parse(text),id='ORDER-'+(orders.size+1);orders.set(id,{id,status:'CREATED',unit:body.purchase_units[0]});return json(201,{id,status:'CREATED'});}
  const capture=/^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(req.url);
  if(capture&&req.method==='POST'){const o=orders.get(capture[1]);if(!o)return json(404,{});if(state.declineNext){state.declineNext=false;return json(422,{details:[{issue:'INSTRUMENT_DECLINED'}]});}if(o.captured)return json(422,{details:[{issue:'ORDER_ALREADY_CAPTURED'}]});o.captured={id:'CAP-'+(++state.captured),status:state.captureStatus,custom_id:o.unit.custom_id,amount:o.unit.amount};o.status='COMPLETED';return json(201,orderView(o));}
  const read=/^\/v2\/checkout\/orders\/([^/]+)$/.exec(req.url);
  if(read&&req.method==='GET'){const o=orders.get(read[1]);return o?json(200,orderView(o)):json(404,{});}
  if(req.url==='/v1/notifications/verify-webhook-signature')return json(200,{verification_status:state.verify});
  if(/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(req.url))return json(201,{id:'REF-1',status:'COMPLETED'});
  json(404,{});
 });
 function orderView(o){return {id:o.id,status:o.status,payer:{payer_id:'PAYER-1'},purchase_units:[{...o.unit,payments:o.captured?{captures:[o.captured]}:undefined}]};}
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {orders,calls,state,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}

async function fixture(run,{paypal=true,catalog=DEFAULT_CATALOG}={}){ // Real database, real API router, real session cookies; only PayPal and the clock are fakes.
 const pp=await fakePayPal();let clock=Date.parse('2026-10-01T12:00:00Z');const now=()=>clock;
 const client=paypal?createPayPalClient({clientId:'cid',secret:'sec',baseUrl:pp.url,webhookId:'WH-1',environment:'sandbox',now}):null;
 const db=openDatabase(':memory:',{stickerCatalog:[],now,store:{paypal:client,catalog,publicOrigin:'https://lidoll.test',now}});
 const alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob'),admin=db.ensureParticipant('test','admin','Admin');db.admin.bootstrap(admin.id);
 const login={origin:'',session:req=>db.session(cookie(req,'little_log'))};
 const api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice('/tracker/api/'.length)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const as=user=>{const token=db.createSession(user.id);return {
  get:async route=>{const r=await fetch(login.origin+'/tracker/api/'+route,{headers:{Cookie:'little_log='+token}});return {status:r.status,body:await r.json()};},
  post:async(route,input,csrf)=>{if(csrf===undefined)csrf=(await fetch(login.origin+'/tracker/api/session',{headers:{Cookie:'little_log='+token}}).then(r=>r.json())).csrf;const r=await fetch(login.origin+'/tracker/api/'+route,{method:'POST',headers:{Cookie:'little_log='+token,Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};},
 };};
 const webhook=async(event,headers={})=>{const r=await fetch(login.origin+'/tracker/api/store/paypal-webhook',{method:'POST',headers:{'Content-Type':'application/json','paypal-transmission-id':'t1','paypal-transmission-sig':'s','paypal-transmission-time':'now','paypal-cert-url':'https://api.paypal.com/cert','paypal-auth-algo':'SHA256withRSA',...headers},body:JSON.stringify(event)});return {status:r.status,body:await r.json()};};
 try{await run({db,alice,bob,admin,as,webhook,pp,login,advance:ms=>{clock+=ms;}});}
 finally{await new Promise(r=>server.close(r));db.close();await pp.close();}
}
const captureEvent=(id,o,type='PAYMENT.CAPTURE.COMPLETED',extra={})=>({id,event_type:type,resource:{id:o.captured?.id??'CAP-X',custom_id:o.unit.custom_id,amount:o.unit.amount,supplementary_data:{related_ids:{order_id:o.id}},...extra}});

test('catalogue validation rejects free, duplicate or mixed-currency packs and accepts a clean override',()=>{
 assert.equal(storeCatalog(undefined),DEFAULT_CATALOG);
 assert.throws(()=>storeCatalog('nope'));assert.throws(()=>storeCatalog('[]'));
 assert.throws(()=>storeCatalog(JSON.stringify([{sku:'a',name:'A',asset:'diamonds',amount:1,price_cents:0,currency:'USD'}])));
 assert.throws(()=>storeCatalog(JSON.stringify([{sku:'a',name:'A',asset:'stars',amount:1,price_cents:99,currency:'USD'}])),'stars are earned, never sold');
 assert.throws(()=>storeCatalog(JSON.stringify([{sku:'a',name:'A',asset:'diamonds',amount:1,price_cents:99,currency:'USD'},{sku:'a',name:'B',asset:'coins',amount:2,price_cents:199,currency:'USD'}])));
 assert.throws(()=>storeCatalog(JSON.stringify([{sku:'a',name:'A',asset:'diamonds',amount:1,price_cents:99,currency:'USD'},{sku:'b',name:'B',asset:'coins',amount:2,price_cents:199,currency:'EUR'}])));
 assert.deepEqual(storeCatalog(JSON.stringify([{sku:'mini',name:'Mini',asset:'coins',amount:300,price_cents:99,currency:'EUR',extra:true}])),[{sku:'mini',name:'Mini',asset:'coins',amount:300,price_cents:99,currency:'EUR'}]);
});

test('a disabled store hides itself, refuses orders and webhooks, and leaves supporter lookups false',()=>fixture(async({alice,as,webhook,db})=>{
 const a=as(alice);const view=await a.get('store');assert.equal(view.status,200);assert.equal(view.body.enabled,false);assert.equal(view.body.client_id,null);assert.deepEqual(view.body.catalog,DEFAULT_CATALOG);
 assert.equal((await a.post('store/order',{sku:'pouch',requestId:'req-00000001'})).status,503);
 assert.equal((await webhook({id:'E1',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{}})).status,503);
 assert.equal(db.economy.supporter(alice.id),false);assert.equal(db.economy.supporterUntil(alice.id),null);
},{paypal:false}));

test('a purchase is priced by the server, captured once, credits diamonds, grants 30 supporter days and shows the star everywhere',()=>fixture(async({db,alice,bob,as,pp,advance})=>{
 const a=as(alice),b=as(bob);
 const view=await a.get('store');assert.equal(view.body.enabled,true);assert.equal(view.body.environment,'sandbox');assert.equal(view.body.client_id,'cid');assert.equal(view.body.supporter_until,null);
 assert.equal((await a.post('store/order',{sku:'nope',requestId:'req-00000001'})).status,400);
 assert.equal((await a.post('store/order',{sku:'pouch',requestId:'short'})).status,400);
 const order=await a.post('store/order',{sku:'pouch',requestId:'req-00000001'});assert.equal(order.status,200);assert.equal(order.body.order_id,'ORDER-1');
 const created=pp.orders.get('ORDER-1');assert.equal(created.unit.amount.value,'4.99');assert.equal(created.unit.amount.currency_code,'USD');assert.equal(created.unit.custom_id,order.body.id,'our purchase id rides along as custom_id');
 assert.deepEqual((await a.post('store/order',{sku:'pouch',requestId:'req-00000001'})).body,order.body,'the same request id returns the same order');
 assert.equal((await a.post('store/order',{sku:'chest',requestId:'req-00000001'})).status,409,'a reused request id cannot switch packs');
 assert.equal((await b.post('store/capture',{id:order.body.id})).status,404,'another account cannot capture it');
 const receipt=await a.post('store/capture',{id:order.body.id});assert.equal(receipt.status,200);assert.equal(receipt.body.status,'fulfilled');assert.equal(receipt.body.asset,'diamonds');assert.equal(receipt.body.amount,15);assert.equal(receipt.body.balance,15);assert.deepEqual(receipt.body.wallet,{coins:50,stars:0,diamonds:15},'the 50-coin welcome bonus is already there');
 assert.equal(receipt.body.supporter_until,Date.parse('2026-10-01T12:00:00Z')+SUPPORTER_DAYS*86400000);
 assert.deepEqual((await a.post('store/capture',{id:order.body.id})).body,receipt.body,'capture retries return the same receipt');
 assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,15);assert.equal(pp.calls.filter(c=>/capture$/.test(c.url)).length,1,'a fulfilled row never asks PayPal again');
 assert.equal(db.economy.snapshot(alice.id).history[0].reason,'Diamond pack purchase');
 assert.equal(db.social.avatarInfo(alice.id).supporter,true);assert.equal(db.social.avatarInfo(bob.id).supporter,undefined);
 assert.equal((await a.get('social/session')).body.participant.supporter,true,'the session participant carries the star');
 const second=await a.post('store/order',{sku:'purse',requestId:'req-00000002'});const coins=await a.post('store/capture',{id:second.body.id});
 assert.equal(coins.body.asset,'coins');assert.equal(coins.body.amount,1000);assert.equal(coins.body.balance,1050,'coin packs credit the coin balance (on top of the welcome bonus)');assert.equal(pp.orders.get(second.body.order_id).unit.amount.value,'1.99');
 assert.equal(db.economy.snapshot(alice.id).wallet.coins,1050);assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,15,'the diamond balance is untouched by a coin pack');assert.equal(db.economy.snapshot(alice.id).history[0].reason,'Coin pack purchase');
 assert.equal(db.economy.supporterUntil(alice.id),Date.parse('2026-10-01T12:00:00Z')+2*SUPPORTER_DAYS*86400000,'a second pack (of either currency) extends the window');
 advance(61*86400000);assert.equal(db.economy.supporterUntil(alice.id),null);assert.equal(db.social.avatarInfo(alice.id).supporter,undefined,'the star expires on its own');
 assert.equal((await a.get('store')).body.purchases.length,2);assert.ok(!('payer_id' in (await a.get('store')).body.purchases[0]),'buyers never see payer ids');
}));

test('captures that do not match the purchase to the cent are refused, declines are reported, and pending orders expire',()=>fixture(async({db,alice,as,pp,advance})=>{
 const a=as(alice);
 const order=await a.post('store/order',{sku:'chest',requestId:'req-00000010'});
 pp.orders.get(order.body.order_id).unit.amount.value='0.10'; // Simulate a tampered/mismatched capture amount.
 const bad=await a.post('store/capture',{id:order.body.id});assert.equal(bad.status,409);assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,0);
 const declined=await a.post('store/order',{sku:'chest',requestId:'req-00000011'});pp.state.declineNext=true;
 const result=await a.post('store/capture',{id:declined.body.id});assert.equal(result.status,409);assert.match(result.body.error,/declined/);
 const lost=await a.post('store/order',{sku:'handful',requestId:'req-00000013'}),lo=pp.orders.get(lost.body.order_id);lo.captured={id:'CAP-L',status:'COMPLETED',custom_id:lo.unit.custom_id,amount:lo.unit.amount}; // PayPal captured earlier but our response was lost.
 const recovered=await a.post('store/capture',{id:lost.body.id});assert.equal(recovered.status,200);assert.equal(recovered.body.status,'fulfilled');assert.equal(recovered.body.balance,5,'ORDER_ALREADY_CAPTURED falls back to reading the order');
 const stale=await a.post('store/order',{sku:'handful',requestId:'req-00000012'});advance(4*86400000);
 assert.equal(db.economy.store('expirePending'),3,'the mismatched, declined and abandoned orders all expire');assert.equal(db.economy.store('list').find(r=>r.id===stale.body.id).status,'cancelled');
 assert.equal((await a.post('store/capture',{id:stale.body.id})).status,409);
}));

test('webhooks need a verified signature, fulfil pending orders once, and claw back refunds and disputes without going negative',()=>fixture(async({db,alice,as,webhook,pp})=>{
 const a=as(alice);
 const order=await a.post('store/order',{sku:'pouch',requestId:'req-00000020'}),o=pp.orders.get(order.body.order_id);
 pp.state.verify='FAILURE';assert.equal((await webhook(captureEvent('E-bad',o))).status,400);pp.state.verify='SUCCESS';
 assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,0);
 o.captured={id:'CAP-9',status:'COMPLETED',custom_id:o.unit.custom_id,amount:o.unit.amount}; // PayPal finished the capture but our browser never called back.
 assert.deepEqual((await webhook(captureEvent('E-1',o))).body,{ok:true,fulfilled:order.body.id});
 assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,15);assert.ok(db.economy.supporter(alice.id));
 assert.deepEqual((await webhook(captureEvent('E-1',o))).body,{ok:true,duplicate:true},'the same event id acts once');
 assert.deepEqual((await webhook(captureEvent('E-2',o))).body,{ok:true,fulfilled:order.body.id});assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,15,'a second completed event is harmless');
 assert.equal(db.economy.act(alice.id,{requestId:'spend',action:'diamond-exchange',quantity:10}).coins,500,'the player spends most of the pack');
 assert.deepEqual((await webhook(captureEvent('E-3',o,'PAYMENT.CAPTURE.REFUNDED',{id:'REF-1'}))).body,{ok:true,clawback:order.body.id});
 const row=db.economy.store('list').find(r=>r.id===order.body.id);assert.equal(row.status,'refunded');assert.equal(row.clawback_short,10,'only 5 diamonds were left to take back');
 assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,0);assert.equal(db.economy.supporter(alice.id),false,'the refunded pack loses its supporter days');
 assert.deepEqual((await webhook({id:'E-4',event_type:'CUSTOMER.DISPUTE.CREATED',resource:{disputed_transactions:[{seller_transaction_id:'CAP-9'}]}})).body,{ok:true,clawback:order.body.id},'disputes resolve through the capture id');
 assert.deepEqual((await webhook({id:'E-5',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{custom_id:'unknown'}})).body,{ok:true,ignored:'no matching purchase'});
}));

test('admins grant packs manually and refund through PayPal with audit rows; members cannot reach the staff routes',()=>fixture(async({db,alice,admin,as,pp})=>{
 const a=as(alice),staff=as(admin);
 assert.equal((await a.get('admin/store')).status,403);assert.equal((await a.post('admin/store/grant',{owner:alice.id,sku:'hoard',reason:'x'})).status,403);
 assert.equal((await staff.post('admin/store/grant',{owner:alice.id,sku:'hoard',reason:''})).status,400,'grants need a reason');
 const grant=await staff.post('admin/store/grant',{owner:alice.id,sku:'hoard',reason:'Payment link #7'});assert.equal(grant.status,200);assert.equal(grant.body.amount,100);assert.equal(grant.body.balance,100);
 assert.ok(db.economy.supporter(alice.id));assert.equal(db.economy.snapshot(alice.id).history[0].reason,'Diamond pack grant');
 const coinGrant=await staff.post('admin/store/grant',{owner:alice.id,sku:'vault',reason:'Stream giveaway'});assert.equal(coinGrant.body.asset,'coins');assert.equal(db.economy.snapshot(alice.id).wallet.coins,13050);
 const coinBack=await staff.post('admin/store/refund',{id:coinGrant.body.id,reason:'Wrong winner'});assert.equal(coinBack.status,200);assert.equal(db.economy.snapshot(alice.id).wallet.coins,50,'coin clawbacks come out of the coin balance');assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,100);
 const listing=await staff.get('admin/store');assert.equal(listing.body.purchases[0].note,'Payment link #7');assert.equal(listing.body.users.find(u=>u.id===alice.id).label,'Alice');
 const paid=await a.post('store/order',{sku:'handful',requestId:'req-00000030'});await a.post('store/capture',{id:paid.body.id});
 const refund=await staff.post('admin/store/refund',{id:paid.body.id,reason:'Player asked within an hour'});assert.equal(refund.status,200);assert.equal(refund.body.status,'refunded');
 assert.ok(pp.calls.some(c=>/\/v2\/payments\/captures\/CAP-1\/refund$/.test(c.url)),'PayPal was asked to refund the capture');
 assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,100);
 const taken=await staff.post('admin/store/refund',{id:grant.body.id,reason:'Duplicate grant'});assert.equal(taken.status,200);assert.equal(db.economy.snapshot(alice.id).wallet.diamonds,0);assert.equal(db.economy.supporter(alice.id),false);
 assert.equal((await staff.post('admin/store/refund',{id:grant.body.id,reason:'again'})).status,409);
 const actions=db.admin.auditList(admin.id).map(r=>r.action);assert.ok(actions.includes('store-grant')&&actions.filter(x=>x==='store-refund').length===3);
}));

test('coin packs can be gifted to an accepted friend: the friend gets the coins, both get the star, and refunds unwind both',()=>fixture(async({db,alice,bob,as,pp,webhook})=>{
 const a=as(alice),b=as(bob);
 assert.equal((await a.post('store/order',{sku:'purse',requestId:'req-00000050',recipient:bob.id})).status,403,'strangers cannot receive gifts');
 const request=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:request.id});
 assert.equal((await a.post('store/order',{sku:'handful',requestId:'req-00000051',recipient:bob.id})).status,400,'diamond packs are not giftable');
 assert.equal((await a.post('store/order',{sku:'purse',requestId:'req-00000052',recipient:alice.id})).status,400,'a gift needs someone else');
 const order=await a.post('store/order',{sku:'purse',requestId:'req-00000053',recipient:bob.id});assert.equal(order.status,200);
 assert.equal((await a.post('store/order',{sku:'purse',requestId:'req-00000053'})).status,409,'the same request id cannot drop the recipient');
 assert.match(pp.orders.get(order.body.order_id).unit.description,/gift/);
 const receipt=await a.post('store/capture',{id:order.body.id});assert.equal(receipt.status,200);assert.equal(receipt.body.recipient,bob.id);assert.equal(receipt.body.balance,50,'the buyer\'s own coins are unchanged');
 assert.equal(db.economy.snapshot(bob.id).wallet.coins,1050);assert.equal(db.economy.snapshot(bob.id).history[0].reason,'Coin pack gift received');
 assert.ok(db.economy.supporter(alice.id)&&db.economy.supporter(bob.id),'both names light up');
 const mine=(await a.get('store')).body.purchases,theirs=(await b.get('store')).body.purchases;
 assert.equal(mine[0].recipient,bob.id);assert.equal(theirs[0].received,true);assert.equal(theirs[0].from,alice.id);
 const o=pp.orders.get(order.body.order_id);assert.deepEqual((await webhook({id:'E-gift',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:o.captured.id,custom_id:o.unit.custom_id,amount:o.unit.amount}})).body,{ok:true,clawback:order.body.id});
 assert.equal(db.economy.snapshot(bob.id).wallet.coins,50,'the refund comes out of the friend\'s wallet');assert.equal(db.economy.snapshot(alice.id).wallet.coins,50);
 assert.equal(db.economy.supporter(alice.id),false);assert.equal(db.economy.supporter(bob.id),false,'both stars go out');
}));

test('the LiDollQuest wallet route exposes supporter_until so the game can draw the star',()=>fixture(async({db,alice,as,login})=>{
 const call=(method,...args)=>db.economy.coins(method,...args);
 const d=call('begin',{client_id:'lidollquest',scope:'wallet:read'},'test');call('approve',alice.id,{user_code:d.user_code,approve:true});const token=call('token',{client_id:'lidollquest',device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}).access_token;
 const wallet=()=>fetch(login.origin+'/tracker/api/lidollcoin/v1/wallet?client_id=lidollquest',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
 assert.equal((await wallet()).supporter_until,null);
 const a=as(alice);const order=await a.post('store/order',{sku:'handful',requestId:'req-00000040'});await a.post('store/capture',{id:order.body.id});
 assert.equal((await wallet()).supporter_until,Date.parse('2026-10-01T12:00:00Z')+SUPPORTER_DAYS*86400000);
}));
