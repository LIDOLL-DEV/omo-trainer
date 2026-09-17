import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
const wet=id=>({id,mutationId:id,baseVersion:0,entry:{id,kind:'wetting',occurredAt:'2026-09-15T12:00:00+00:00',category:'voluntary',position:'sitting',diaperNumber:1}});

test('the feed filters all updates, written posts or auto-updates, with paging per filter',async()=>{
 let time=Date.parse('2026-09-15T14:00:00Z');const db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time});try{ // Clock advances past the ten-posts-per-minute limit.
  const a=db.ensureParticipant('test','a','Alice');
  db.social.saveRecordPreferences(a.id,{enabled:true,audience:'public',version:0});
  for(let i=0;i<3;i++,time+=60001)await db.social.publish(a.id,{requestId:'post'+i,body:'Post '+i,audience:'public',pictures:[]});
  for(let i=0;i<22;i++,time+=60001)db.sync(a.id,[wet('wet'+i)]); // 22 auto-updates: more than one page.
  const page=kind=>db.social.feed(a.id,{audience:'public',kind});
  assert.equal(page('all').items.length,20);assert.equal(page().items.length,20,'all is the default');
  assert.deepEqual(page('posts').items.map(p=>p.body),['Post 2','Post 1','Post 0']);assert.equal(page('posts').nextBefore,null);
  const auto=page('auto');assert.equal(auto.items.length,20);assert.ok(auto.items.every(p=>p.record?.kind==='wetting'));
  const older=db.social.feed(a.id,{audience:'public',kind:'auto',before:auto.nextBefore});assert.equal(older.items.length,2,'Paging stays inside the filter');assert.ok(older.items.every(p=>p.record));
  assert.equal(db.social.feed(a.id,{kind:'posts'}).items.length,3,'Works with the Friends & me feed too');
  assert.throws(()=>page('pictures'),e=>e.status===400);
 }finally{db.close();}
});
