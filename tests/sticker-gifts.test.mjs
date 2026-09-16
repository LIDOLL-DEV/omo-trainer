import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {createStickerGifts} from '../server/sticker-gifts.mjs';
const collection=[{id:'rose',name:'Rose',url:'stickers/rose.png'}]; // One design keeps every earned sticker predictable.
const observation=id=>({id,kind:'observation',occurredAt:'2026-09-12T12:00:00+00:00',liquidsMl:100,liquidsMode:'interval',diaperNumber:1});
function fixture(){
 const db=openDatabase(':memory:',{stickerCatalog:collection});
 const [a,b,c]=['alice','bob','cara'].map(name=>db.ensureParticipant('issuer',name,name[0].toUpperCase()+name.slice(1)));
 return {db,a,b,c};
}
const earn=(db,user,count)=>{for(let i=0;i<count;i++)db.sync(user.id,[{id:user.id+'-obs'+i,mutationId:randomUUID(),baseVersion:0,entry:observation(user.id+'-obs'+i)}]);}; // Each synced observation earns one sticker.
const roses=(db,user)=>db.economy.snapshot(user.id).types.find(t=>t.id==='rose')?.quantity??0;
function connect(db,a,b){const row=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:row.id});}
const post=(db,user)=>db.social.publish(user.id,{requestId:randomUUID(),body:'Look!',audience:'public',pictures:[]});

test('sticker comments move one sticker to the post owner or replied-to author, once per request',async()=>{
 const {db,a,b,c}=fixture();try {
  earn(db,a,2);earn(db,c,1);const {id:postId}=await post(db,b);
  const gift={requestId:'gift-1',postId,body:'',sticker:'rose'};
  const first=db.social.comment(a.id,gift);assert.equal(first.sticker,'rose');
  assert.equal(db.social.comment(a.id,gift).id,first.id); // A retry returns the same comment...
  assert.equal(roses(db,a),1);assert.equal(roses(db,b),1); // ...and moved only one sticker.
  const shown=db.social.commentList(b.id,postId).items[0];assert.deepEqual(shown.sticker,{id:'rose',name:'Rose',url:'stickers/rose.png'});assert.equal(shown.body,'');
  assert.throws(()=>db.social.comment(a.id,{...gift,body:'changed'}),e=>e.status===409);assert.equal(roses(db,a),1); // Conflicting retry keeps the original gift.
  const cara=db.social.comment(c.id,{requestId:'cara',postId,body:'Pretty'});
  db.social.comment(a.id,{requestId:'reply',postId,parentId:cara.id,body:'For you',sticker:'rose'});
  assert.equal(roses(db,c),2);assert.equal(roses(db,a),0); // Replies gift the comment author, not the post owner.
  assert.equal(db.economy.snapshot(a.id).history.filter(row=>row.reason==='Sticker gift sent').length,2);
  assert.throws(()=>db.social.comment(a.id,{requestId:'empty',postId,body:'',sticker:'rose'}),e=>e.status===409); // Nothing left to give.
  assert.equal(db.social.commentList(a.id,postId).items.length,3); // The failed gift saved no comment.
  assert.throws(()=>db.social.comment(b.id,{requestId:'self',postId,body:'',sticker:'rose'}),e=>e.status===400);assert.equal(roses(db,b),1); // No gifts to yourself.
  assert.throws(()=>db.social.comment(c.id,{requestId:'blank',postId,body:''}),e=>e.status===400); // Text stays required without a sticker.
 }finally{db.close();}
});

test('sticker messages go to the friend, stay with them after removal and need friendship',()=>{
 const {db,a,b,c}=fixture();try {
  earn(db,a,2);
  assert.throws(()=>db.social.sendMessage(a.id,{requestId:'stranger',participantId:c.id,body:'',sticker:'rose'}),e=>e.status===403);assert.equal(roses(db,a),2);
  connect(db,a,b);const sent=db.social.sendMessage(a.id,{requestId:'hello',participantId:b.id,body:'Hi!',sticker:'rose'});
  assert.equal(roses(db,b),1);const [message]=db.social.messages(b.id,a.id).items;assert.equal(message.sticker.name,'Rose');assert.equal(message.body,'Hi!');
  assert.equal(db.social.conversations(b.id)[0].latest.sticker.id,'rose'); // Inbox previews know about the sticker.
  db.social.deleteMessage(a.id,sent.id);assert.equal(db.social.messages(b.id,a.id).items[0].sticker,null);assert.equal(roses(db,b),1); // Removing the message never takes the gift back.
  assert.deepEqual(db.social.stickers(a.id).map(s=>[s.id,s.quantity]),[['rose',1]]);
 }finally{db.close();}
});

test('a failed save returns the sticker, and the reconciler settles or returns interrupted gifts',()=>{
 const {db,a,b}=fixture();try {
  earn(db,a,3);let saved=false;
  const social={stickerRecipient:(owner,kind,input)=>({recipient:b.id,source:kind+':'+input.requestId}),stickerContentSaved:()=>saved,requireUser(){},comment:()=>{throw Object.assign(Error('Post not found.'),{status:404});}};
  const gifts=createStickerGifts(social,db.economy);
  assert.throws(()=>gifts.comment(a.id,{requestId:'lost',sticker:'rose'}),e=>e.status===404);
  assert.equal(roses(db,a),3);assert.equal(roses(db,b),0); // Returned immediately.
  assert.throws(()=>gifts.comment(a.id,{requestId:'lost',sticker:'rose'}),e=>e.status===409); // A returned receipt cannot be reused.
  db.economy.gifts('give',a.id,{source:'message:crash-saved',recipient:b.id,sticker:'rose'}); // Crash after the market commit, content saved.
  saved=true;assert.equal(gifts.reconcile(Date.now()+1000),1);assert.equal(roses(db,b),1);
  db.economy.gifts('give',a.id,{source:'message:crash-lost',recipient:b.id,sticker:'rose'}); // Crash after the market commit, content lost...
  db.economy.act(b.id,{requestId:'sell',action:'bank-sell',sticker:'rose',quantity:2,expectedPrice:db.economy.snapshot(b.id).types[0].price}); // ...and the recipient already sold it.
  saved=false;assert.equal(gifts.reconcile(Date.now()+1000),1);assert.equal(roses(db,b),0);assert.equal(roses(db,a),1); // Kept: balances never go negative.
  assert.equal(gifts.reconcile(Date.now()+1000),0); // Nothing is left pending.
 }finally{db.close();}
});
