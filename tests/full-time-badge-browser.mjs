import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/full-time-badge-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));
// Seed: Alice has a public post; Moderator is the administrator.
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'a','Alice'),moderator=db.ensureParticipant(process.env.OIDC_ISSUER,'admin','Moderator');db.admin.bootstrap(moderator.id);
await db.social.publish(alice.id,{requestId:'seed',body:'Padded and proud',audience:'public'});
let browser;const errors=[];
const tap=(page,selector)=>page.$eval(selector,n=>{n.scrollIntoView({block:'center'});n.click();}); // Centre first: fixed bars cover the page edges.
async function open(page,path){await page.bringToFront();await page.goto(origin+'/tracker/'+path,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});}
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,moderator]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,m]=pages;
 // No badge before opting in.
 await open(a,'#feed?audience=public');await a.select('#feed-audience','public');await a.waitForFunction(()=>/Padded and proud/.test(document.querySelector('#status-feed').textContent));
 assert.equal(await a.$$eval('#status-feed .badge-247',n=>n.length),0);
 // Turn the badge on in Settings.
 await open(a,'#settings');await a.waitForFunction(()=>!document.querySelector('#badge-full-time').disabled);
 await tap(a,'#badge-full-time');await tap(a,'#badge-save');await a.waitForFunction(()=>/^Saved\. Your posts show the 24\/7 badge/.test(document.querySelector('#badge-status').textContent));
 await a.screenshot({path:resolve(directory,'settings-390.png'),fullPage:true});
 assert.equal(db.social.badgePreferences(alice.id).fullTime,true);
 // The feed shows the chip to the left of the audience pill, on the same row.
 await open(a,'#feed');await a.select('#feed-audience','public');await a.waitForSelector('#status-feed .post-pills .badge-247');
 const layout=await a.$eval('#status-feed .post-pills',row=>{const b=row.querySelector('.badge-247').getBoundingClientRect(),p=row.querySelector('.pill').getBoundingClientRect();return {left:b.right<=p.left,sameRow:Math.abs((b.top+b.bottom)-(p.top+p.bottom))<4,text:row.textContent};});
 assert.deepEqual(layout,{left:true,sameRow:true,text:'24/7Public'});
 for(const width of [320,390,1024]){await a.setViewport({width,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'feed width '+width);await a.screenshot({path:resolve(directory,`feed-${width}.png`)});}
 // Admin console statistics.
 await m.setViewport({width:1024,height:900});await open(m,'admin/#moderation');await m.waitForSelector('#moderation-view');await m.select('#moderation-view','badges');
 await m.waitForFunction(()=>/1 of 2 active members show the 24\/7 badge \(50%\)/.test(document.querySelector('#moderation-list').textContent)&&/Alice/.test(document.querySelector('#moderation-list').textContent));
 assert.match(await m.$eval('#moderation-list',n=>n.textContent),/Last 30 days: 1 turned it on, 0 turned it off\./);
 await m.screenshot({path:resolve(directory,'admin-1024.png'),fullPage:true});
 // Turning it off removes the chip.
 await a.setViewport({width:390,height:900});await open(a,'#settings');await a.waitForFunction(()=>!document.querySelector('#badge-full-time').disabled&&document.querySelector('#badge-full-time').checked);
 await tap(a,'#badge-full-time');await tap(a,'#badge-save');await a.waitForFunction(()=>/do not show/.test(document.querySelector('#badge-status').textContent));
 await open(a,'#feed');await a.select('#feed-audience','public');await a.waitForFunction(()=>/Padded and proud/.test(document.querySelector('#status-feed').textContent));assert.equal(await a.$$eval('#status-feed .badge-247',n=>n.length),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: badge off by default, Settings save, chip left of the audience pill, responsive feed, admin 24/7 statistics and turning it off. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
