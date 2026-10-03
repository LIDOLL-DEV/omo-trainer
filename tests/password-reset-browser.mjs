import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdir,mkdtemp} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/password-reset-'));
const TOKEN='t'.repeat(43),PASSWORD='Fresh_password-0123456789abcdef',resets=[];
const reset=createServer(async(req,res)=>{ // Stand-in for the identity service's private endpoint; it records only what the tracker sent.
 const chunks=[];for await(const part of req)chunks.push(part);resets.push({auth:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({subject:resets.at(-1).body.subject,username:'alice',disabled:false,password:PASSWORD}));
});await new Promise(r=>reset.listen(0,'127.0.0.1',r));
const port=await new Promise(r=>{const probe=createServer().listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>r(value));});}); // POSTs need PUBLIC_ORIGIN to match the real port.
Object.assign(process.env,{DATA_DIR:directory,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:'http://127.0.0.1:'+port,
 AUTH_ADMIN_URL:'http://127.0.0.1:'+reset.address().port+'/admin/reset-password',AUTH_ADMIN_TOKEN:TOKEN});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
const db=openDatabase(resolve(directory,'little-log.sqlite')),admin=db.ensureParticipant(process.env.OIDC_ISSUER,'admin','Admin'),alice=db.ensureParticipant(process.env.OIDC_ISSUER,'alice','Alice');db.admin.bootstrap(admin.id);
const aliceSession=db.createSession(alice.id);
let browser;const errors=[];
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const context=await browser.createBrowserContext();
 await context.setCookie({name:'little_log',value:db.createSession(admin.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1000});
 await page.goto(origin+'/tracker/admin/#users',{waitUntil:'networkidle0'});await page.waitForSelector('#user-table [data-reset-password]');
 assert.equal(await page.$eval('[data-reset-password="'+admin.id+'"]',b=>b.disabled),true,'Admins cannot reset their own password here');
 assert.equal(await page.$eval('#password-reset-result',e=>e.hidden),true);
 let prompt='';page.once('dialog',async dialog=>{prompt=dialog.message();await dialog.dismiss();});
 await page.click('[data-reset-password="'+alice.id+'"]');await new Promise(r=>setTimeout(r,300));
 assert.match(prompt,/Reset the LiD0llID password for Alice\?/);assert.equal(resets.length,0,'Cancelling the confirmation sends nothing');
 page.once('dialog',dialog=>dialog.accept());await page.click('[data-reset-password="'+alice.id+'"]');
 await page.waitForFunction(()=>!document.querySelector('#password-reset-result').hidden,{timeout:8000}).catch(async e=>{throw Error('Reset panel did not appear: '+await page.$eval('#admin-status',s=>s.textContent),{cause:e});});
 assert.equal(resets.length,1);assert.equal(resets[0].auth,'Bearer '+TOKEN);assert.deepEqual(resets[0].body,{subject:'alice'});
 assert.equal(await page.$eval('#password-reset-value',e=>e.textContent),PASSWORD);
 assert.match(await page.$eval('#password-reset-summary',e=>e.textContent),/Alice.*alice.*signed out everywhere/);
 assert.equal(db.session(aliceSession),null,'Alice is signed out of Little Log');
 await page.screenshot({path:resolve(directory,'reset-desktop.png')});
 for(const width of [320,390,768]){await page.setViewport({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal scroll at '+width);}
 await page.setViewport({width:390,height:900});await page.$eval('#password-reset-result',e=>e.scrollIntoView());await page.screenshot({path:resolve(directory,'reset-mobile.png')});
 await page.click('#password-reset-done');
 assert.equal(await page.$eval('#password-reset-result',e=>e.hidden),true);assert.equal(await page.$eval('#password-reset-value',e=>e.textContent),'','Done removes the password from the page');
 await page.goto(origin+'/tracker/admin/#audit',{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#audit-table')?.textContent.includes('reset-password'));
 assert.equal(await page.evaluate(p=>document.body.innerHTML.includes(p),PASSWORD),false,'The audit view never contains the password');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
 console.log('PASS: confirm/cancel, one-time display, bearer back-channel, target sign-out, own-row lockout, audit without password, mobile layout. '+directory);
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r));reset.close();}
