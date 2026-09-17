import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
const day=86400000;
function fixture(){let time=Date.parse('2026-09-15T14:00:00Z');const db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time});const [a,b,c]=['a','b','c'].map(n=>db.ensureParticipant('test',n,n.toUpperCase()));return {db,a,b,c,advance:ms=>time+=ms};}
function admin(db,a){db.admin.bootstrap(a.id);} // First member becomes the administrator.
const badges=(db,a)=>db.social.moderation(a.id,{view:'badges'});

test('24/7 badge is off by default, versioned, shown on posts and keeps its start date',async()=>{
 const {db,a,b,advance}=fixture();try{
  assert.deepEqual(db.social.badgePreferences(b.id),{fullTime:false,since:null,version:0});
  const {id}=await db.social.publish(b.id,{requestId:'p',body:'Hi',audience:'public',pictures:[]});
  assert.equal(db.social.post(a.id,id).author.fullTime,false);
  const on=db.social.saveBadgePreferences(b.id,{fullTime:true,version:0});assert.equal(on.fullTime,true);assert.equal(on.version,1);
  assert.equal(db.social.post(a.id,id).author.fullTime,true); // Older posts show the current badge too.
  assert.throws(()=>db.social.saveBadgePreferences(b.id,{fullTime:false,version:0}),e=>e.status===409); // Stale device.
  advance(day);const again=db.social.saveBadgePreferences(b.id,{fullTime:true,version:1});assert.equal(again.since,on.since); // Re-saving keeps "since".
  for(const bad of [null,{fullTime:'yes',version:2},{fullTime:true,version:-1}])assert.throws(()=>db.social.saveBadgePreferences(b.id,bad),e=>e.status===400);
  db.social.saveBadgePreferences(b.id,{fullTime:false,version:2});assert.equal(db.social.post(a.id,id).author.fullTime,false);assert.equal(db.social.badgePreferences(b.id).since,null);
 }finally{db.close();}
});

test('admin badge statistics count active wearers and recent changes, admin only',()=>{
 const {db,a,b,c,advance}=fixture();try{
  admin(db,a);assert.throws(()=>badges(db,b),e=>e.status===403);
  db.social.saveBadgePreferences(b.id,{fullTime:true,version:0});db.social.saveBadgePreferences(c.id,{fullTime:true,version:0});db.social.saveBadgePreferences(c.id,{fullTime:true,version:1}); // Repeat save is not a change.
  let view=badges(db,a);assert.deepEqual(view.summary,{wearers:2,members:3,percent:66.7,enabled30:2,disabled30:0});assert.deepEqual(view.items.map(i=>i.label),['C','B']);
  db.social.saveBadgePreferences(c.id,{fullTime:false,version:2});view=badges(db,a);assert.equal(view.summary.wearers,1);assert.equal(view.summary.disabled30,1);
  advance(31*day);assert.deepEqual(badges(db,a).summary,{wearers:1,members:3,percent:33.3,enabled30:0,disabled30:0}); // Old changes leave the 30-day window.
  const row=db.admin.users(a.id).find(u=>u.id===b.id);db.admin.updateUser(a.id,{action:'update',id:b.id,role:'participant',disabled:true,version:row.version});
  view=badges(db,a);assert.equal(view.summary.wearers,0);assert.equal(view.summary.members,2);assert.equal(view.items.length,0); // Disabled accounts are excluded.
 }finally{db.close();}
});

test('paused social accounts cannot change their badge',()=>{
 const {db,a,b}=fixture();try{
  admin(db,a);db.social.moderate(a.id,{action:'restrict',participantId:b.id,reason:'test'});
  assert.throws(()=>db.social.saveBadgePreferences(b.id,{fullTime:true,version:0}),e=>e.status===403);
 }finally{db.close();}
});
