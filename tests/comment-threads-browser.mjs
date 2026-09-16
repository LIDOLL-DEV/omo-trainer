import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/comment-threads-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));
// Seed: Alice posts, Bob comments, Alice replies to Bob - so Alice's view has someone else's comment and her own reply.
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'a','Alice'),bob=db.ensureParticipant(process.env.OIDC_ISSUER,'b','Bob');
const f=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:f.id});
const post=await db.social.publish(alice.id,{requestId:'seed',body:'Threaded discussion post',audience:'friends'});
const root=db.social.comment(bob.id,{requestId:'root',postId:post.id,body:'Bob top-level comment'});
db.social.comment(alice.id,{requestId:'reply',postId:post.id,parentId:root.id,body:'Alice first reply'});
let browser;const errors=[];
async function open(page,path){await page.bringToFront();await page.goto(origin+'/tracker/'+path,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});}
async function button(page,selector,text){await page.waitForFunction((selector,text)=>[...document.querySelectorAll(selector)].some(n=>n.textContent===text&&!n.disabled&&n.offsetParent),{},selector,text);await page.$$eval(selector,(nodes,text)=>nodes.find(n=>n.textContent===text&&n.offsetParent).click(),text);} // Clicks only visible controls, like a person would.
const labels=(page,selector)=>page.$$eval(selector,nodes=>nodes.map(n=>n.textContent));
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,bob]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b]=pages;
 // Alice (post owner): Options menu holds Delete only; Bob's comment offers Report but never Delete.
 await open(a,'#feed');await a.waitForSelector('.post-menu');assert.deepEqual(await labels(a,'.post-menu-item'),['Delete post']);
 await a.click('.post-menu summary');await a.waitForFunction(()=>document.querySelector('.post-menu').open);await a.click('.social-body');await a.waitForFunction(()=>!document.querySelector('.post-menu').open); // outside click closes it
 await a.click('.social-comments summary');await a.waitForFunction(()=>document.querySelectorAll('.social-comment').length===2);
 const bobCard=`.social-comment[data-comment-id="${root.id}"] > .comment-actions button`;
 assert.deepEqual(await labels(a,bobCard),['Like · 0','Reply','Report'],'Post owners cannot delete other members\' comments');
 assert.equal(await a.$eval(`.social-comment[data-comment-id="${root.id}"] > .comment-replies .social-comment .social-body`,n=>n.textContent),'Alice first reply');
 assert.match((await labels(a,`.social-comment[data-comment-id="${root.id}"] > .comment-replies .comment-actions button`)).join('|'),/Delete/,'Authors can delete their own replies');
 await a.screenshot({path:resolve(directory,'owner-thread-390.png'),fullPage:true});
 // Bob (not the owner): Options menu holds Report only; he likes Alice's reply and replies to it (nested).
 await open(b,'#feed');await b.waitForSelector('.post-menu');assert.deepEqual(await labels(b,'.post-menu-item'),['Report post']);
 await b.click('.post-menu summary');await b.waitForFunction(()=>document.querySelector('.post-menu').open);await b.screenshot({path:resolve(directory,'options-menu-390.png')});await b.keyboard.press('Escape');
 await b.click('.social-comments summary');await b.waitForFunction(()=>document.querySelectorAll('.social-comment').length===2);
 const reply='.comment-replies .social-comment > .comment-actions button';
 await button(b,reply,'Like · 0');await b.waitForFunction(s=>[...document.querySelectorAll(s)].some(n=>n.textContent==='Liked · 1'&&n.getAttribute('aria-pressed')==='true'),{},reply);
 await button(b,reply,'Reply');await b.waitForSelector('.reply-form textarea');assert.match(await b.$eval('.reply-form label',n=>n.textContent),/Reply to Alice/);
 await b.type('.reply-form textarea','Nested <i>literal</i> answer');await b.click('.reply-form button[type="submit"]');
 await b.waitForFunction(()=>document.querySelector('.comment-replies .comment-replies .social-body')?.textContent==='Nested <i>literal</i> answer');assert.equal(await b.$$eval('.social-comment i',n=>n.length),0,'Reply text is rendered literally');
 assert.equal(await b.$eval('.social-comments summary',n=>n.textContent),'Comments · 3');
 // Alice gets reply and comment-like alerts.
 await open(a,'#activity');await a.waitForFunction(()=>/Bob liked your comment/.test(document.querySelector('#activity-list').textContent)&&/Bob replied to your comment/.test(document.querySelector('#activity-list').textContent));
 // Bob deletes his top-level comment: it becomes a placeholder and the replies stay.
 await open(b,'#feed');await b.click('.social-comments summary');await b.waitForFunction(()=>document.querySelectorAll('.social-comment').length===3);b.once('dialog',d=>d.accept());
 await button(b,`.social-comment[data-comment-id="${root.id}"] > .comment-actions button`,'Delete');
 await b.waitForFunction(()=>document.querySelector('.social-comment.is-removed > .comment-removed')?.textContent==='Comment removed'&&document.querySelectorAll('.social-comment').length===3);
 for(const theme of ['little-tracker','caregiver-tracker'])for(const width of [320,390,1024]){await b.evaluate(async theme=>{document.documentElement.dataset.theme=theme;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},theme);await b.setViewport({width,height:900});assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' width '+width);await b.screenshot({path:resolve(directory,`${theme}-${width}.png`),fullPage:true});}
 assert.deepEqual(errors,[]);
 console.log('PASS: options dropdown (owner delete / member report), outside-click and Escape closing, threaded replies, nested reply form, comment likes, author-only deletion, removed-parent placeholders, activity alerts and responsive themes. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
