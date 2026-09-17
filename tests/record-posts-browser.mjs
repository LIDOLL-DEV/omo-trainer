import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
import {rollProbability} from '../lib/model.js';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/record-posts-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));
// Seed: Alice shares her records with friends, logs one of each kind through the real sync path, and writes one normal post.
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'a','Alice'),bob=db.ensureParticipant(process.env.OIDC_ISSUER,'b','Bob');
const f=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:f.id});
db.social.saveRecordPreferences(alice.id,{enabled:true,rolls:true,audience:'friends',version:0});
const at='2026-09-15T12:00:00-07:00',wet=(id,category)=>({id,mutationId:id,baseVersion:0,entry:{id,kind:'wetting',occurredAt:at,category,position:'sitting',diaperNumber:7}});
db.sync(alice.id,[wet('used','voluntary'),wet('potty','used-the-potty'),wet('oops','involuntary'),
 {id:'change',mutationId:'change',baseVersion:0,entry:{id:'change',kind:'diaper-change',occurredAt:at,diaperNumber:7,wettingsCount:2}},
 {id:'water',mutationId:'water',baseVersion:0,entry:{id:'water',kind:'observation',occurredAt:at,liquidsMl:250,liquidsMode:'interval',diaperNumber:7}}]);
const roll=(id,minute,result,desperate)=>{const t=`2026-09-15T13:0${minute}:00-07:00`;return {id,mutationId:id,baseVersion:0,entry:{id,kind:'roll',occurredAt:t,rolledAt:t,result,rolledResult:result,source:'random',...(desperate?rollProbability(50,()=>99,true):{probability:50})}};}; // Two holds then a pee.
db.sync(alice.id,[roll('hold1',1,'hold',false)]);db.sync(alice.id,[roll('hold2',2,'hold',true)]);db.sync(alice.id,[roll('pee1',3,'pee',false)]);
await db.social.publish(alice.id,{requestId:'manual',body:'A real status update',audience:'friends'});
let browser;const errors=[];
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();
 await context.setCookie({name:'little_log',value:db.createSession(bob.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:1400});
 await page.goto(origin+'/tracker/#feed',{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelectorAll('#status-feed .status-card').length===9);
 const lines=await page.$$eval('.record-post .record-line',nodes=>nodes.map(n=>n.querySelector('.record-sentence').textContent));
 for(const text of ['Alice drank 250 mL of water','Alice changed their diaper after 2 wettings','Alice had an accident in their diaper!','Alice used the potty :(','Alice used their diaper!'])assert.ok(lines.includes(text),'missing: '+text+' in '+JSON.stringify(lines));
 assert.equal(await page.$$eval('.record-post',n=>n.length),8,'Only automatic posts use the record layout');
 const rolls=await page.$$eval('.record-post[data-record-kind="roll"]',nodes=>nodes.map(n=>[n.querySelector('.record-sentence').textContent,[...n.querySelectorAll('.roll-chip')].map(c=>c.textContent)]));
 assert.deepEqual(rolls,[['Alice rolled PEE and had to go (50% chance)',['Normal mode','after 2 holds in a row']],['Alice rolled HOLD and held it! (25% chance)',['\u{1F525} Desperation mode','2 holds in a row']],['Alice rolled HOLD and held it! (50% chance)',['Normal mode','1 hold in a row']]],'Roll posts show result, chance, mode and streak (newest first)');
 await page.screenshot({path:resolve(directory,'rolls-390.png'),fullPage:true});
 const shown=async kind=>{await page.select('#feed-kind',kind);await page.waitForFunction(()=>!document.querySelector('#feed-kind').disabled);return page.$$eval('#status-feed .status-card',n=>n.map(c=>c.classList.contains('record-post')));}; // Pick a filter, return which cards are auto-updates.
 assert.deepEqual(await shown('posts'),[false],'Posts shows only written updates');
 const autos=await shown('auto');assert.equal(autos.length,8);assert.ok(autos.every(Boolean),'Auto-updates shows only record posts');
 await page.screenshot({path:resolve(directory,'filter-auto-390.png')});
 assert.equal((await shown('all')).length,9,'All shows everything again');
 assert.equal(await page.$$eval('.record-post .social-body',n=>n.length),0,'Record posts replace the summary body with the activity line');
 assert.equal(await page.$eval('.status-card:not(.record-post) .social-body',n=>n.textContent),'A real status update');
 assert.match(await page.$eval('.record-post .record-meta',n=>n.textContent),/^Auto-logged · /);assert.match(await page.$eval('.record-post .record-when',n=>n.textContent),/^Recorded Sep 1[45], 2026/);
 assert.equal(await page.$eval('.record-post .record-name',n=>n.getAttribute('href')),'#profile?id='+encodeURIComponent(alice.id));
 assert.ok(await page.$$eval('.record-post',nodes=>nodes.every(n=>n.querySelector('.post-menu')&&n.querySelector('.like-action')&&n.querySelector('.social-comments'))),'Record posts keep likes, comments and Options');
 for(const theme of ['little-tracker','caregiver-tracker'])for(const width of [320,390,1024]){await page.evaluate(async theme=>{document.documentElement.dataset.theme=theme;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));},theme);await page.setViewport({width,height:1400});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' width '+width);await page.screenshot({path:resolve(directory,`${theme}-${width}.png`)});}
 assert.deepEqual(errors,[]);
 console.log('PASS: automatic record posts render as activity lines (water, diaper change, accident, potty, diaper use, rolls with mode and hold streak), manual posts keep their body, profile links, reactions and responsive themes. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
