import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/infinite-feed-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));
// Seed 45 posts, a minute apart in the past, so the ten-per-minute limit never applies.
let time=Date.now()-2*86400000;const db=openDatabase(resolve(directory,'little-log.sqlite'),{now:()=>time}),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'a','Alice');
for(let i=1;i<=45;i++,time+=61000)await db.social.publish(alice.id,{requestId:'p'+i,body:'Post '+i,audience:'friends'});
let browser;const errors=[];
const bodies=page=>page.$$eval('#status-feed .status-card .social-body',n=>n.map(x=>x.textContent)); // Post texts, top to bottom.
const toBottom=page=>page.$eval('#feed-more',n=>n.scrollIntoView({block:'end'})); // Scroll whichever container holds the feed.
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();
 await context.setCookie({name:'little_log',value:db.createSession(alice.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844});
 await page.goto(origin+'/tracker/#feed',{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});
 await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length>=20);
 assert.deepEqual((await bodies(page)).slice(0,3),['Post 45','Post 44','Post 43'],'Newest first');
 await toBottom(page);await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length>=40);
 await toBottom(page);await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length===45&&!document.querySelector('#feed-end').hidden);
 const all=await bodies(page);assert.deepEqual(all,Array.from({length:45},(_,i)=>'Post '+(45-i)),'Every post once, in order, with no gaps or duplicates');
 assert.equal(await page.$eval('#feed-older',n=>n.hidden),true,'No more pages: the fallback button hides');
 assert.equal(await page.$eval('#feed-end',n=>n.textContent),"You're all caught up ✨");
 const visible=await page.evaluate(()=>{for(const n of [document.scrollingElement,...document.querySelectorAll('*')])if(n.scrollHeight>n.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(n).overflowY)||n===document.scrollingElement)n.scrollTop=n.scrollHeight; // Scroll every scroller fully down, like a finger would.
  const note=document.querySelector('#feed-end').getBoundingClientRect(),bar=document.querySelector('.social-navigation')?.getBoundingClientRect();return note.bottom<=(bar?bar.top:innerHeight)+1;});
 assert.equal(visible,true,'The caught-up note can be scrolled into view above the bottom bar');
 await page.screenshot({path:resolve(directory,'end-390.png')});
 // Changing the filter starts over from the newest page.
 await page.select('#feed-kind','auto');await page.waitForFunction(()=>/No auto-updates yet/.test(document.querySelector('#feed-status').textContent));
 assert.equal(await page.$$eval('#status-feed .status-card',n=>n.length),0);assert.equal(await page.$eval('#feed-end',n=>n.hidden),true,'No end note on an empty feed');
 await page.select('#feed-kind','all');await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length===20);
 // Without scrolling, the manual button loads the next page too.
 await page.$eval('#feed-older',n=>n.click());await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length>=40);
 // A tall screen keeps loading until it is filled or the feed ends.
 await page.setViewport({width:1024,height:9000});await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length===45,{timeout:15000});
 assert.deepEqual(errors,[]);
 console.log('PASS: infinite feed loads pages on scroll in order without duplicates, ends with a caught-up note, resets on filter change, keeps a manual button and fills tall screens. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
