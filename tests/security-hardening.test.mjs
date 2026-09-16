import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {openAuthStore} from '../auth/store.mjs';
import {createLogin} from '../server/login.mjs';
import {createIdentityStatus} from '../server/identity-status.mjs';
import {createUploadAdmission} from '../server/upload-admission.mjs';
import {requireRewardAuthority} from '../server/reward-authority.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'audit-key',alg:'RS256'};
function verifierFixture(){
 let now=0,version=0,disabled=false,fail=false,tamper=false,nonceWrong=false,calls=0;
 const identity={issuer:'http://127.0.0.1:4180',subject:'synthetic-subject'};
 const verify=createIdentityStatus(identity.issuer,{now:()=>now,fetcher:async(url,options)=>{
  if(fail)throw Error('Offline');if(url.pathname==='/jwks')return Response.json({keys:[jwk]});
  calls++;const input=JSON.parse(options.body),payload=Buffer.from(JSON.stringify({issuer:identity.issuer,subject:input.subject,nonce:nonceWrong?'wrong':input.nonce,version,disabled})).toString('base64url');
  return Response.json({kid:jwk.kid,payload,signature:tamper?'bad':sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')});
 }});
 return {identity,verify,advance:()=>now+=30001,version:v=>version=v,disable:()=>disabled=true,offline:()=>fail=true,tamper:()=>tamper=true,nonceWrong:()=>nonceWrong=true,calls:()=>calls};
}
test('identity status validates issuer, signature and nonce; cache expires and outages fail closed',async()=>{
 const f=verifierFixture();assert.equal((await f.verify(f.identity)).version,0);f.version(1);
 assert.equal((await f.verify(f.identity)).version,0);assert.equal(f.calls(),1);f.advance();assert.equal((await f.verify(f.identity)).version,1);
 f.disable();f.advance();assert.equal((await f.verify(f.identity)).disabled,true);f.offline();f.advance();await assert.rejects(f.verify(f.identity));
 for(const mode of ['tamper','nonceWrong']){const g=verifierFixture();g[mode]();await assert.rejects(g.verify(g.identity));}
 await assert.rejects(f.verify({...f.identity,issuer:'https://evil.invalid'}));
});
test('security epoch changes revoke app, wallet, report and statistics credentials; stale status cannot roll back',async()=>{
 const db=openDatabase(':memory:'),f=verifierFixture();try{
  const user=db.ensureParticipant(f.identity.issuer,f.identity.subject,'Member');db.admin.bootstrap(user.id);
  const login=createLogin(db,'/tracker/',{verifyIdentity:f.verify}),token=db.createSession(user.id),request={headers:{cookie:'little_log='+token}};
  const wallet=db.economy.coins('browserIssue',user.id),report=db.aiAnalysis.integrations.create(user.id,{name:'Report'}),stats=db.statistics.create(user.id,{name:'Stats'});
  assert.ok(await login.session(request));f.version(1);f.advance();await assert.rejects(login.session(request),e=>e.status===401);
  assert.equal(db.session(token),null);assert.throws(()=>db.economy.coins('grant',wallet),e=>e.status===401);
  assert.throws(()=>db.aiAnalysis.integrations.authorize(report.token),e=>e.status===401);assert.throws(()=>db.statistics.authorize(stats.token),e=>e.status===401);
  assert.throws(()=>db.identityStatus(user.id,{version:0,disabled:false}),e=>e.status===401);
  const fresh=db.createSession(user.id);assert.ok(await login.session({headers:{cookie:'little_log='+fresh}}));
  f.disable();f.advance();await assert.rejects(login.session({headers:{cookie:'little_log='+fresh}}),e=>e.status===401);assert.equal(db.session(fresh),null);
 }finally{db.close();}
});
test('password resets and identity disables advance the persistent security epoch',async()=>{
 const directory=mkdtempSync(resolve('artifacts/identity-epoch-'));let store=openAuthStore(directory);
 try{const account=await store.setPassword('audit-user','synthetic-test-password-12345',true);assert.deepEqual(store.security(account.id),{version:0,disabled:false});
  await store.setPassword('audit-user','synthetic-replacement-password-12345');assert.deepEqual(store.security(account.id),{version:1,disabled:false});
  const verifying=store.verify('audit-user','synthetic-replacement-password-12345');store.disable('audit-user');assert.equal(await verifying,null,'A disable during password hashing must reject the in-flight login');
  store.close();store=openAuthStore(directory);assert.deepEqual(store.security(account.id),{version:2,disabled:true});assert.equal(store.account(account.id),undefined);
 }finally{store.close();}
});
test('upload admission bounds concurrent body readers and persists attempt limits; failures release slots',async()=>{
 const directory=mkdtempSync(resolve('artifacts/upload-budget-')),path=resolve(directory,'uploads.sqlite');let db=new DatabaseSync(path),now=0;
 try{let admission=createUploadAdmission(db,{now:()=>now,globalLimit:2,accountLimit:1,attemptLimit:2}),finishA,finishB;
  const a=admission.run('a',()=>new Promise(r=>finishA=r)),b=admission.run('b',()=>new Promise(r=>finishB=r));
  await assert.rejects(admission.run('a',()=>assert.fail('Reader must not start')),e=>e.status===429);await assert.rejects(admission.run('c',()=>assert.fail('Global slots full')),e=>e.status===429);
  finishA();finishB();await Promise.all([a,b]);await assert.rejects(admission.run('a',()=>{throw Error('Decode failed');}),/Decode failed/);
  db.close();db=new DatabaseSync(path);admission=createUploadAdmission(db,{now:()=>now,attemptLimit:2});await assert.rejects(admission.run('a',()=>assert.fail('Persistent quota')),e=>e.status===429);
  now=60000;assert.equal(await admission.run('a',()=>42),42);
 }finally{db.close();}
});
const record=(id,wettingsCount=10000)=>({id,mutationId:id,baseVersion:0,entry:{id,kind:'diaper-change',occurredAt:'2026-09-16T12:00:00-07:00',diaperNumber:1,wettingsCount}});
test('bulk record sync saves every record but bounds posts, notifications and record coin payouts',async()=>{
 let now=Date.now();const db=openDatabase(':memory:',{now:()=>now}),a=db.ensureParticipant('test','a','A'),b=db.ensureParticipant('test','b','B');try{
  const link=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:link.id});db.social.saveRecordPreferences(a.id,{enabled:true,audience:'public',version:0});
  const batch=Array.from({length:100},(_,i)=>record('bounded-'+i));db.sync(a.id,batch);
  assert.equal(db.records(a.id).length,100);assert.equal(db.social.feed(b.id,{audience:'public'}).items.length,10);assert.equal(db.activity.list(b.id).items.length,10);
  assert.equal(db.economy.snapshot(a.id).wallet.coins,310);assert.equal(db.records(a.id)[0].entry.wettingsCount,10000);
  await assert.rejects(db.social.publish(a.id,{requestId:'blocked-picture',pictures:[{data:'invalid'}]}),e=>e.status===429);
  db.sync(a.id,batch);assert.equal(db.economy.snapshot(a.id).wallet.coins,310);
 }finally{db.close();}
});
test('credits and refunds require a server proof bound to client, recipient and exact operation',()=>{
 const key='synthetic-server-reward-key-0000000000000000000',keys=JSON.stringify({lidollbot:key}),token='recipient-token';
 const input={kind:'credit',asset:'diamonds',amount:100,request_id:'award-1'},signature=createHmac('sha256',key).update('lidollbot\n'+token+'\n'+JSON.stringify(input)).digest('hex');
 requireRewardAuthority('lidollbot',token,input,signature,keys);
 for(const [client,secret,body,proof,config] of [['lidollbot',token,input,undefined,keys],['lidollbot','other',input,signature,keys],['other',token,input,signature,keys],['lidollbot',token,{...input,amount:101},signature,keys],['lidollbot',token,{kind:'refund',original_id:'purchase',request_id:'refund'},signature,keys],['lidollbot',token,input,signature,'{}']])assert.throws(()=>requireRewardAuthority(client,secret,body,proof,config),e=>e.status===403);
 requireRewardAuthority('lidollbot',token,{kind:'debit',amount:1},undefined,'{}');
});

test('record and chart reward budgets survive restarts and reset by server day without rewarding old zero receipts',()=>{
 const directory=mkdtempSync(resolve('artifacts/reward-budget-')),path=resolve(directory,'science.sqlite');let now=Date.UTC(2026,8,16,12);
 const options={now:()=>now,stickerCatalog:[{id:'test',name:'Test',url:'test.png'}]};let db=openDatabase(path,options);
 try {
  const user=db.ensureParticipant('test','budget','Budget'),batch=Array.from({length:25},(_,i)=>record('budget-'+i));db.sync(user.id,batch);
  const stars=Object.fromEntries(Array.from({length:55},(_,i)=>[new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)+':water',true]));
  const chart={name:'Budget',since:'2026-01-01',refusals:0,escaped:false,rows:[{id:'potty',label:'Potty',note:''},{id:'water',label:'Water',note:''}],stars};
  db.saveGrowthChart(user.id,{chart,baseVersion:0,mutationId:'chart-budget'});
  let snapshot=db.economy.snapshot(user.id);assert.equal(snapshot.wallet.coins,310);assert.equal(snapshot.wallet.stars,50);assert.equal(snapshot.types[0].quantity,20);
  db.close();db=openDatabase(path,options);db.sync(user.id,[record('same-day-extra')]);assert.equal(db.economy.snapshot(user.id).wallet.coins,310);
  now+=86400000;db.sync(user.id,batch);snapshot=db.economy.snapshot(user.id);assert.equal(snapshot.wallet.coins,310);assert.equal(snapshot.wallet.stars,50);assert.equal(snapshot.types[0].quantity,20);
  db.sync(user.id,[record('next-day')]);snapshot=db.economy.snapshot(user.id);assert.equal(snapshot.wallet.coins,380);assert.equal(snapshot.types[0].quantity,21);
  db.saveGrowthChart(user.id,{chart:{...chart,stars:{...stars,'2026-08-01:water':true}},baseVersion:1,mutationId:'chart-next-day'});
  assert.equal(db.economy.snapshot(user.id).wallet.stars,51);
 }finally{db.close();}
});

test('activity retention keeps only the latest thousand notifications and removes their old delivery rows',()=>{
 const directory=mkdtempSync(resolve('artifacts/activity-retention-')),path=resolve(directory,'science.sqlite'),db=openDatabase(path);
 try {
  const user=db.ensureParticipant('test','activity-owner','Owner');
  const first=db.activity.record(user.id,{source:'first',kind:'reminder'}),raw=new DatabaseSync(path);
  try {
   raw.prepare('INSERT INTO activity_deliveries(notification_id,owner,endpoint) VALUES (?,?,?)').run(first,user.id,'https://synthetic.invalid/push');
   for(let i=0;i<1001;i++)db.activity.record(user.id,{source:'notification-'+i,kind:'reminder'});
   assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM activity_notifications WHERE owner=?').get(user.id).n,1000);
   assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM activity_deliveries').get().n,0);
   assert.equal(db.activity.list(user.id).unread,1000);
  }finally{raw.close();}
 }finally{db.close();}
});
