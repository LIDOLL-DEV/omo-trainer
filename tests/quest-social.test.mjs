import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {questSocialApi} from '../server/quest-account-api.mjs';
test('Quest friends use the same account relationships without exposing participant IDs or records',()=>{
 const db=openDatabase(':memory:');try{
  const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob'),secret=db.economy.coins('browserIssue',a.id),account=createHash('sha256').update('lidollquest:'+b.id).digest('hex');
  const q=new URLSearchParams();const request=questSocialApi(db,secret,'POST',q,{action:'request',account_id:account});
  const incoming=db.friends.list(b.id);assert.equal(incoming[0].id,request.id);assert.equal(incoming[0].direction,'incoming');
  db.friends.act(b.id,{action:'accept',id:request.id});
  const friend=questSocialApi(db,secret,'GET',q).friends[0];assert.equal(friend.state,'accepted');assert.equal(friend.account_id,account);assert.equal(friend.participantId,undefined);
  assert.equal(questSocialApi(db,secret,'GET',new URLSearchParams({q:'Bob'})).friends[0].id,request.id,'search results retain their actionable relationship ID');
  assert.equal(questSocialApi(db,secret,'GET',new URLSearchParams({account_id:account})).member.label,'Bob');
  questSocialApi(db,secret,'POST',q,{action:'remove',id:request.id});assert.equal(db.friends.list(b.id).length,0);
  assert.throws(()=>questSocialApi(db,secret,'POST',q,{action:'request',account_id:'bad'}),/Choose/);
  assert.throws(()=>questSocialApi(db,secret,'DELETE',q),e=>e.status===405);
 }finally{db.close();}
});
