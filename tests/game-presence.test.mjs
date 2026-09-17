import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {questSocialApi} from '../server/quest-account-api.mjs';
const base=Date.parse('2026-09-17T14:00:00Z');
const pref=(extra={})=>({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/games',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},timeZone:'UTC',quietStart:0,quietEnd:0,communitySupport:false,...extra});
function fixture(){
 let time=base;const sent=[],db=openDatabase(':memory:',{now:()=>time,notifications:{send:async(s,p)=>sent.push(p),random:()=>99}});
 const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob'),c=db.ensureParticipant('test','c','Cara');
 const link=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:link.id});
 db.friends.act(a.id,{action:'request',participantId:c.id});
 return {db,a,b,c,link,sent,time:value=>time=value,play:(session='window-one',playing=true)=>db.questSocial.act(a.id,{action:'presence',session,playing})};
}
test('accepted friends see live play in both apps; heartbeats, windows and reconnects do not duplicate notices',()=>{
 const f=fixture();try{
  f.play();f.play();f.play('window-two');
  assert.equal(f.db.activity.list(f.b.id).items.length,1);assert.equal(f.db.activity.list(f.c.id).items.length,0);
  assert.equal(f.db.friends.list(f.b.id)[0].playing,true);assert.equal(f.db.questSocial.read(f.b.id).friends[0].playing,true);
  assert.equal(f.db.questSocial.read(f.c.id).friends[0].playing,undefined);
  f.play('window-one',false);assert.equal(f.db.friends.list(f.b.id)[0].playing,true);
  f.play('window-two',false);assert.equal(f.db.friends.list(f.b.id)[0].playing,false);
  f.time(base+10000);f.play();assert.equal(f.db.activity.list(f.b.id).items.length,1);
  f.time(base+100001);assert.equal(f.db.friends.list(f.b.id)[0].playing,false,'crashed clients expire');
  f.time(base+300001);f.play();assert.equal(f.db.activity.list(f.b.id).items.length,2);
  assert.equal(f.db.activity.list(f.b.id).items[0].body,'Alice started playing LiDollQuest.');
 }finally{f.db.close();}
});
test('game pushes are opt-in and delivered once; they never contain character or tracking data',async()=>{
 const f=fixture();try{
  f.db.notifications.save(f.b.id,pref());assert.equal(f.db.notifications.status(f.b.id).preferences.friendGames,0);
  f.play();await f.db.notifications.tick(base);assert.equal(f.sent.length,0);assert.equal(f.db.activity.list(f.b.id).unread,1);
  f.db.notifications.save(f.b.id,pref({friendGames:true}));f.time(base+300001);f.play();await f.db.notifications.tick(base+300001);await f.db.notifications.tick(base+300001);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].body,'Alice started playing LiDollQuest.');assert.equal(f.sent[0].kind,'social-activity');
 }finally{f.db.close();}
});
test('quiet hours, opt-outs, disconnects and unfriending suppress stale game pushes',async()=>{
 for(const reason of ['quiet','optout','disconnect','unfriend']){
  const f=fixture();try{
   f.db.notifications.save(f.b.id,pref({friendGames:true,...(reason==='quiet'?{quietStart:13,quietEnd:15}:{})}));f.play();
   if(reason==='optout')f.db.notifications.save(f.b.id,pref({friendGames:false}));
   if(reason==='disconnect')f.play('window-one',false);
   if(reason==='unfriend')f.db.friends.act(f.b.id,{action:'remove',id:f.link.id});
   await f.db.notifications.tick(base);assert.equal(f.sent.length,0);
   f.time(base+3600000);await f.db.notifications.tick(base+3600000);assert.equal(f.sent.length,0);
   if(reason==='unfriend')assert.equal(f.db.activity.list(f.b.id).items.length,0);
  }finally{f.db.close();}
 }
});
test('the game activity API uses scoped authenticated identity and rejects invalid sessions',()=>{
 const f=fixture();try{
  const database={...f.db,economy:{coins:(action,secret,scope)=>{assert.equal(scope,'social:write');assert.equal(secret,'token');return {owner:f.a.id,client:'lidollquest'};}}};
  questSocialApi(database,'token','POST',new URLSearchParams(),{action:'presence',session:'window-one',playing:true,owner:f.c.id});
  assert.equal(f.db.gamePresence.active(f.a.id),true);assert.equal(f.db.gamePresence.active(f.c.id),false);
  assert.throws(()=>f.play('bad'),/session/);assert.throws(()=>f.play('window-one','yes'),/session/);
  assert.throws(()=>questSocialApi(database,'token','DELETE',new URLSearchParams(),{}),/Method not allowed/);
 }finally{f.db.close();}
});
