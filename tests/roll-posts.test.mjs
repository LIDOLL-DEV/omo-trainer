import test from 'node:test';
import assert from 'node:assert/strict';
import {rollProbability} from '../lib/model.js';
import {openDatabase} from '../server/database.mjs';
const at=minute=>`2026-09-15T12:${String(minute).padStart(2,'0')}:00+00:00`; // One roll per minute keeps the order obvious.
const roll=(id,minute,result='hold',desperate=false)=>({id,kind:'roll',occurredAt:at(minute),rolledAt:at(minute),result,rolledResult:result,source:'random',...(desperate?rollProbability(50,()=>99,true):{probability:50})});
const change=(entry,baseVersion=0)=>({id:entry.id,mutationId:entry.id+'-'+baseVersion,baseVersion,entry});
function fixture(){
 const db=openDatabase(':memory:',{stickerCatalog:[]}),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');
 const f=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:f.id});
 const prefs=input=>db.social.saveRecordPreferences(a.id,{enabled:false,rolls:false,audience:'friends',...input,version:db.social.recordPreferences(a.id).version});
 const records=()=>db.social.feed(b.id).items.map(p=>p.record).reverse(); // Oldest first.
 return {db,a,b,prefs,records};
}

test('rolls post only with their own opt-in, independently of bathroom logs',()=>{
 const {db,a,prefs,records}=fixture();try{
  assert.deepEqual(db.social.recordPreferences(a.id),{enabled:false,rolls:false,audience:'friends',version:0});
  prefs({enabled:true});db.sync(a.id,[change(roll('r0',0))]);assert.equal(records().length,0,'Bathroom-log sharing alone does not post rolls');
  prefs({enabled:false,rolls:true});db.sync(a.id,[change({id:'wet',kind:'wetting',occurredAt:at(1),category:'voluntary',position:'sitting',diaperNumber:1})]);assert.equal(records().length,0,'Roll sharing alone does not post wettings');
  db.sync(a.id,[change(roll('r1',2))]);assert.equal(records().length,1);
  const saved=db.social.saveRecordPreferences(a.id,{enabled:false,audience:'public',version:db.social.recordPreferences(a.id).version});assert.equal(saved.rolls,true,'Older clients that omit rolls keep the saved choice');
  assert.throws(()=>db.social.saveRecordPreferences(a.id,{enabled:false,rolls:'yes',audience:'public',version:saved.version}),e=>e.status===400);
 }finally{db.close();}
});

test('roll posts show the result, chance, desperation mode and hold streak',()=>{
 const {db,a,prefs,records}=fixture();try{
  db.sync(a.id,[change(roll('before',0,'hold'))]); // Not posted, but counts toward the streak.
  prefs({rolls:true});
  db.sync(a.id,[change(roll('h1',1,'hold',true))]);
  db.sync(a.id,[change({id:'wet',kind:'wetting',occurredAt:at(2),category:'voluntary',position:'sitting',diaperNumber:1})]); // Not a roll: streak continues.
  db.sync(a.id,[change(roll('h2',3,'hold'))]);
  db.sync(a.id,[change(roll('p1',4,'pee',true))]);
  db.sync(a.id,[change(roll('p2',5,'pee'))]);
  db.sync(a.id,[change(roll('h3',6,'hold'))]);
  assert.deepEqual(records().map(r=>[r.result,r.desperationMode,r.holdStreak]),[['hold',true,2],['hold',false,3],['pee',true,3],['pee',false,0],['hold',false,1]]);
  const [first]=records();assert.equal(first.kind,'roll');assert.equal(first.probability,25);assert.equal(first.position,undefined,'Position stays private');
  const bodies=db.social.feed(a.id).items.map(p=>p.body).reverse();
  assert.match(bodies[0],/^Roll · Hold \(25% chance\) · Desperation mode\nHold streak: 2 in a row\nRecorded: /);
  assert.match(bodies[2],/^Roll · Pee \(25% chance\) · Desperation mode\nHad to go after 3 holds in a row\n/);
  assert.match(bodies[3],/^Roll · Pee \(50% chance\)\nRecorded: /,'No streak line after a pee');
  db.sync(a.id,[change({...roll('h3',6,'hold'),edited:true},1)]);assert.equal(records().at(-1).holdStreak,1,'Edits keep the streak');
  db.sync(a.id,[{id:'h3',mutationId:'delete-h3',baseVersion:2,entry:null}]);assert.equal(records().length,4,'Deleting the roll removes its post');
 }finally{db.close();}
});
