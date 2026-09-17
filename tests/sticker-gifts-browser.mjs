import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/sticker-gifts-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));
// Seed: Alice and Bob are friends, Bob posts, Alice earns two real stickers from synced observations.
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'a','Alice'),bob=db.ensureParticipant(process.env.OIDC_ISSUER,'b','Bob');
const f=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:f.id});
await db.social.publish(bob.id,{requestId:'seed',body:'Bob needs cheering up',audience:'friends'});
for(const id of ['obs-1','obs-2'])db.sync(alice.id,[{id,mutationId:id,baseVersion:0,entry:{id,kind:'observation',occurredAt:'2026-09-12T12:00:00+00:00',liquidsMl:100,liquidsMode:'interval',diaperNumber:1}}]);
const count=user=>db.economy.snapshot(user.id).types.reduce((n,t)=>n+t.quantity,0); // Total available stickers for one member.
assert.equal(count(alice),2);
let browser;const errors=[];
const tap=(page,selector)=>page.$eval(selector,n=>{n.scrollIntoView({block:'center'});n.click();}); // Centre first: the fixed Social bar covers the page's bottom edge.
async function open(page,path){await page.bringToFront();await page.goto(origin+'/tracker/'+path,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});}
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,bob]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b]=pages;
 // Bob's own post has no sticker picker (stickers are gifts for someone else).
 await open(b,'#feed');await b.click('.social-comments summary');await b.waitForSelector('.social-comments form');
 assert.equal(await b.$$eval('.social-comments .sticker-picker',n=>n.length),0);
 // Alice sends a sticker-only comment on Bob's post.
 await open(a,'#feed');await a.click('.social-comments summary');await a.waitForSelector('.social-comments .sticker-picker .link-action');
 await tap(a,'.social-comments .sticker-picker .link-action');await a.waitForSelector('.social-comments .sticker-choice');
 assert.equal(await a.$$eval('.social-comments .sticker-choice small',n=>n.map(x=>Number(x.textContent.slice(1))).reduce((s,x)=>s+x,0)),2,'Picker shows both earned stickers');
 await a.screenshot({path:resolve(directory,'picker-390.png'),fullPage:true});
 await tap(a,'.social-comments .sticker-choice');await a.waitForSelector('.social-comments .sticker-chosen .social-sticker');
 assert.equal(await a.$eval('.social-comments textarea',n=>n.required),false,'Text becomes optional with a sticker');
 await tap(a,'.social-comments form button[type="submit"]');
 await a.waitForFunction(()=>document.querySelector('.social-comment .social-sticker img')?.complete&&document.querySelector('.social-comment .social-sticker img').naturalWidth>0);
 assert.equal(await a.$eval('.social-comments textarea',n=>n.required),true,'The picker resets after sending');
 assert.equal(count(alice),1);assert.equal(count(bob),1);
 await a.screenshot({path:resolve(directory,'comment-sticker-390.png'),fullPage:true});
 // Alice messages Bob with text and her last sticker.
 await a.setViewport({width:1024,height:900});await open(a,'#messages');await a.waitForSelector(`#message-friend option[value="${bob.id}"]`);
 await a.select('#message-friend',bob.id);await a.waitForFunction(()=>!document.querySelector('#page-messages .sticker-picker .link-action').disabled);
 await tap(a,'#page-messages .sticker-picker .link-action');await a.waitForSelector('#page-messages .sticker-choice');await tap(a,'#page-messages .sticker-choice');
 await a.type('#message-text','A present for you');await tap(a,'#message-send');
 await a.waitForFunction(()=>document.querySelector('.message-bubble .social-sticker')&&/A present for you/.test(document.querySelector('.message-bubble').textContent));
 assert.equal(count(alice),0);assert.equal(count(bob),2);
 await a.screenshot({path:resolve(directory,'message-sticker-1024.png'),fullPage:true});
 // With nothing left, the picker says so.
 await tap(a,'#page-messages .sticker-picker .link-action');await a.waitForFunction(()=>/no stickers to give/.test(document.querySelector('#page-messages .sticker-choices').textContent));
 // Bob sees the sticker in his conversation.
 await b.setViewport({width:1024,height:900});await open(b,'#messages');await b.waitForSelector(`#message-friend option[value="${alice.id}"]`);await b.select('#message-friend',alice.id);
 await b.waitForFunction(()=>document.querySelector('.message-bubble .social-sticker figcaption')?.textContent.startsWith('🎁'));
 // Phone layout: Bob (who now owns 2 stickers) opens the thread and the picker at 412px.
 await b.setViewport({width:412,height:915,isMobile:true,hasTouch:true});await open(b,'#messages');await b.waitForSelector('#conversation-list .conversation-button');await tap(b,'#conversation-list .conversation-button');
 await b.waitForSelector('.message-bubble .social-sticker');await tap(b,'#page-messages .sticker-picker .link-action');await b.waitForSelector('#page-messages .sticker-choice');
 const layout=await b.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect(),text=box('#message-text'),send=box('#message-send'),picker=box('#page-messages .sticker-picker'),form=box('#message-form'),grid=document.querySelector('#page-messages .sticker-choices'),tops=[...grid.children].map(n=>Math.round(n.getBoundingClientRect().top)),bubble=[...document.querySelectorAll('.message-bubble')].find(n=>n.querySelector('.social-sticker')),name=bubble.querySelector('.social-identity,strong').getBoundingClientRect(),sticker=bubble.querySelector('.social-sticker').getBoundingClientRect();
  return {sendBesideText:send.left>=text.right&&send.top<text.bottom,pickerBelow:picker.top>=text.bottom,pickerFullWidth:Math.abs(picker.width-form.width)<2,oneRow:new Set(tops).size===1,noPageOverflow:document.documentElement.scrollWidth<=innerWidth,stickerUnderName:sticker.top>=name.bottom-1};});
 assert.deepEqual(layout,{sendBesideText:true,pickerBelow:true,pickerFullWidth:true,oneRow:true,noPageOverflow:true,stickerUnderName:true});
 await b.screenshot({path:resolve(directory,'message-picker-412.png')});
 await tap(b,'#page-messages .sticker-choice');await b.waitForSelector('#page-messages .sticker-chosen .social-sticker');await b.screenshot({path:resolve(directory,'message-chosen-412.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: own-post picker hidden, sticker picker counts, sticker-only comment, optional text, picker reset, sticker message, empty inventory notice and recipient view. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
