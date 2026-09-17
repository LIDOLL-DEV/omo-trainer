import {rewardSignature} from './reward-signing-helper.mjs';
﻿import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {cookie} from '../server/login.mjs';

async function fixture(run) {
  const db=openDatabase(':memory:',{stickerCatalog:[]}),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob');
  const login={origin:'',session:req=>db.session(cookie(req,'little_log'))};
  const api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice('/tracker/api/'.length)));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
  const base=login.origin+'/tracker/api/lidollcoin/browser/';
  const post=(route,input,headers={})=>fetch(base+route,{method:'POST',redirect:'manual',headers:{Origin:login.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  try {await run({db,alice,bob,base,login,post});}finally{await new Promise(r=>server.close(r));db.close();}
}

test('Quest social/cloud routes require expanded consent, correct verbs and browser CSRF while native grants share friendships',()=>fixture(async({db,alice,bob,base,login,post})=>{
 const call=(method,...args)=>db.economy.coins(method,...args);
 const native=(user,scope)=>{const d=call('begin',{client_id:'lidollquest',scope},'quest-test');call('approve',user.id,{user_code:d.user_code,approve:true});return call('token',{client_id:'lidollquest',device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}).access_token;};
 const legacy=native(alice,'wallet:read'),external=login.origin+'/tracker/api/lidollcoin/v1/';
 for(const route of ['social','cloud','zones/inspect'])assert.equal((await fetch(external+route+'?client_id=lidollquest',{headers:{Authorization:'Bearer '+legacy}})).status,403);
 assert.equal((await fetch(external+'wallet?client_id=lidollquest',{headers:{Authorization:'Bearer '+legacy}})).status,200,'old currency permissions remain usable');
 const a=call('browserIssue',alice.id),b=native(bob,'wallet:read social:read social:write saves:read saves:write'),headers={Cookie:'lidollquest_wallet='+a,'X-CSRF-Token':call('browserSession',a).csrf};
 const switched=await fetch(base+'social?expected_account='+call('balance',b).account_id,{headers});assert.equal(switched.status,409);assert.equal((await switched.json()).error,'account_changed');
 const target=call('balance',b).account_id,input={action:'request',account_id:target};
 assert.equal((await post('social',input,{Cookie:headers.Cookie})).status,403);
 assert.equal((await post('social',input,{...headers,Origin:'https://evil.invalid'})).status,403);
 const request=await (await post('social',input,headers)).json();assert.ok(request.id);
 const nativeHeaders={Authorization:'Bearer '+b,'Content-Type':'application/json'};
 const incoming=await (await fetch(external+'social?client_id=lidollquest',{headers:nativeHeaders})).json();assert.equal(incoming.friends[0].id,request.id);
 assert.equal((await fetch(external+'social?client_id=lidollquest',{method:'POST',headers:nativeHeaders,body:JSON.stringify({action:'accept',id:request.id})})).status,200);
 assert.equal(db.friends.list(alice.id)[0].state,'accepted');
 assert.equal((await fetch(external+'cloud?client_id=lidollquest',{method:'DELETE',headers:nativeHeaders})).status,405);
 assert.equal((await fetch(base+'cloud/action',{headers})).status,405);
 assert.equal((await post('cloud/action',{action:'begin'}, {Cookie:headers.Cookie})).status,403);
 assert.equal((await fetch(base+'characters/action',{headers})).status,405);
 assert.equal((await post('characters/action',{action:'delete'}, {Cookie:headers.Cookie})).status,403);
 assert.equal((await post('characters/action',{action:'rename'}, {...headers,Origin:'https://evil.invalid'})).status,403);
 assert.equal((await fetch(external+'characters/action?client_id=lidollquest',{method:'POST',headers:{Authorization:'Bearer '+legacy,'Content-Type':'application/json'},body:JSON.stringify({action:'delete'})})).status,403);
 db.admin.bootstrap(alice.id);const row=db.admin.users(alice.id).find(u=>u.id===bob.id);db.admin.updateUser(alice.id,{action:'update',id:bob.id,role:'participant',disabled:true,version:row.version});
 assert.equal((await fetch(external+'social?client_id=lidollquest',{headers:nativeHeaders})).status,401);
 assert.equal((await (await fetch(base+'social',{headers})).json()).friends.length,0);
}));

test('browser sign-in requires consent and creates a wallet-only HttpOnly session with a fixed return URL',()=>fixture(async({db,alice,base,login,post})=>{
  const guest=await fetch(base+'connect',{redirect:'manual'});assert.equal(guest.status,303);assert.equal(guest.headers.get('location'),'/tracker/auth/login?returnTo=game-wallet');
  assert.deepEqual(await (await fetch(base+'session')).json(),{linked:false});
  const science=db.createSession(alice.id),headers={Cookie:'little_log='+science};
  const page=await fetch(base+'connect',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}});assert.equal(page.status,200,'top-level OAuth return may have a cross-site redirect chain');
  assert.match(await page.text(),/Allow and return to game/);assert.match(page.headers.get('content-security-policy'),/form-action 'self'/);
  assert.equal((await post('connect',{decision:'allow'},headers)).status,403);
  const csrf=db.session(science).csrf;
  const denied=await post('connect',{decision:'deny',csrf},headers);assert.equal(denied.headers.get('location'),'/game/?wallet=cancelled');assert.equal(denied.headers.get('set-cookie'),null);
  const linked=await post('connect',{decision:'allow',csrf,returnTo:'https://evil.example'},headers);assert.equal(linked.status,303);assert.equal(linked.headers.get('location'),'/game/');
  const setCookie=linked.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);assert.match(setCookie,/Path=\/tracker\/api\/lidollcoin\/browser\//);
  const walletCookie=setCookie.split(';')[0];
  const session=await (await fetch(base+'session',{headers:{Cookie:walletCookie}})).json();assert.equal(session.linked,true);assert.equal(session.balance,50);assert.ok(session.csrf);assert.equal(session.access_token,undefined);
  assert.equal((await fetch(login.origin+'/tracker/api/session',{headers:{Cookie:walletCookie}})).status,401,'wallet cookie cannot read science');
  assert.equal((await fetch(login.origin+'/tracker/api/lidollcoin/v1/wallet?client_id=lidollquest',{headers:{Cookie:walletCookie}})).status,401,'browser cookie is not an external bearer credential');
  assert.equal((await fetch(base+'session',{headers})).status,200);assert.deepEqual(await (await fetch(base+'session',{headers})).json(),{linked:false},'Little Log session alone never grants wallet access');
  const returning=await fetch(base+'connect',{headers});assert.match(await returning.text(),/data-approved="true"/);
}));

test('browser wallet mutations enforce origin, CSRF, account isolation, replay and revocation',()=>fixture(async({db,alice,bob,base,login,post})=>{
  const call=(method,...args)=>db.economy.coins(method,...args),a=call('browserIssue',alice.id),b=call('browserIssue',bob.id);
  const headers={Cookie:'lidollquest_wallet='+a,'X-CSRF-Token':call('browserSession',a).csrf};
  const operation={kind:'credit',amount:40,request_id:'browser-earned'};
  assert.equal((await post('operations',operation,headers)).status,403);
  headers['X-Reward-Signature']=rewardSignature(a,operation);
  assert.equal((await post('operations',operation,{Cookie:headers.Cookie})).status,403);
  assert.equal((await post('operations',operation,{...headers,Origin:'https://evil.example'})).status,403);
  assert.equal((await post('operations',operation,{...headers,'Sec-Fetch-Site':'cross-site'})).status,403);
  const first=await (await post('operations',operation,headers)).json();assert.equal(first.balance,90);
  assert.deepEqual(await (await post('operations',operation,headers)).json(),first);
  const star={kind:'credit',asset:'stars',amount:8,request_id:'browser-star'};
  assert.equal((await post('operations',star,{Cookie:headers.Cookie})).status,403);
  assert.equal((await post('operations',star,{...headers,Origin:'https://evil.example'})).status,403);
  headers['X-Reward-Signature']=rewardSignature(a,star);
  const starReceipt=await (await post('operations',star,headers)).json();assert.equal(starReceipt.currency,'Stars');assert.equal(starReceipt.balance,8);
  assert.deepEqual(await (await post('operations',star,headers)).json(),starReceipt);
  assert.equal(call('browserSession',a).balance,90);assert.equal(call('browserSession',a).stars,8);assert.equal(call('browserSession',b).stars,0);
  assert.equal(call('browserSession',b).balance,50);
  assert.notEqual(call('browserSession',b).account_id,call('browserSession',a).account_id);
  const refreshed=call('browserIssue',alice.id);assert.equal(call('browserSession',refreshed).account_id,call('browserSession',a).account_id);
  assert.deepEqual(call('operation',refreshed,operation),first,'signing in again retains operation idempotency');
  assert.equal((await post('revoke',{},headers)).status,200);
  assert.deepEqual(await (await fetch(base+'session',{headers})).json(),{linked:false});
  assert.equal((await post('operations',{...operation,request_id:'revoked'},headers)).status,401);
  assert.equal(call('browserApproved',alice.id),false);
  const connection=call('grant',b);call('revoke',alice.id,connection.id);assert.equal(call('browserSession',b).linked,true,'another user cannot revoke Bob');
}));

test('embedded game linking preserves only its fixed website return through sign-in, consent and cancel',()=>fixture(async({db,alice,base,post})=>{
  const guest=await fetch(base+'connect?view=embedded',{redirect:'manual'});assert.equal(guest.headers.get('location'),'/tracker/auth/login?returnTo=game-wallet-embedded');
  const science=db.createSession(alice.id),headers={Cookie:'little_log='+science},csrf=db.session(science).csrf;
  const page=await fetch(base+'connect?view=embedded',{headers});const html=await page.text();assert.match(html,/name="view" value="embedded"/);assert.match(html,/returnTo=game-wallet-embedded&amp;reauth=1/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const denied=await post('connect',{decision:'deny',csrf,view:'embedded'},headers);assert.equal(denied.headers.get('location'),'/?wallet=cancelled');
  const allowed=await post('connect',{decision:'allow',csrf,view:'embedded'},headers);assert.equal(allowed.headers.get('location'),'/');assert.match(allowed.headers.get('set-cookie'),/HttpOnly/);
  const malicious=await post('connect',{decision:'allow',csrf,view:'https://evil.example'},headers);assert.equal(malicious.headers.get('location'),'/game/');
  const expired=await post('connect',{decision:'allow',csrf,view:'embedded'});assert.equal(expired.headers.get('location'),'/tracker/auth/login?returnTo=game-wallet-embedded');
}));
