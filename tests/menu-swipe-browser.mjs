import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/menu-swipe-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];
const isOpen=page=>page.$eval('#main-navigation',n=>n.open); // Drawer state.
async function drag(page,from,to){ // One finger moved in eight steps. Events are dispatched in-page so Chrome's own back-swipe cannot leave the test page.
 await page.evaluate((from,to)=>{
  const target=document.elementFromPoint(from.x,from.y)??document.body;
  const fire=(type,x,y)=>{const touch=new Touch({identifier:1,target,clientX:x,clientY:y});target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));};
  fire('touchstart',from.x,from.y);
  for(let i=1;i<=8;i++)fire('touchmove',from.x+(to.x-from.x)*i/8,from.y+(to.y-from.y)*i/8);
  fire('touchend',to.x,to.y);
 },from,to);
 await new Promise(r=>setTimeout(r,250)); // Let the drawer animation settle.
}
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true,defaultViewport:{width:390,height:844,hasTouch:true,isMobile:true}}); // Touch settings at launch: changing them later reloads the page.
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin,{waitUntil:'networkidle0'});await page.waitForSelector('#menu-toggle',{visible:true});
 await drag(page,{x:150,y:400},{x:330,y:400});assert.equal(await isOpen(page),false,'A swipe from the middle of the screen does nothing');
 await drag(page,{x:10,y:400},{x:40,y:400});assert.equal(await isOpen(page),false,'A short edge swipe does nothing');
 await drag(page,{x:10,y:300},{x:40,y:600});assert.equal(await isOpen(page),false,'A mostly vertical edge drag is a scroll');
 await drag(page,{x:8,y:400},{x:200,y:420});assert.equal(await isOpen(page),true,'Swiping right from the left edge opens the menu');
 assert.equal(await page.$eval('#menu-toggle',n=>n.getAttribute('aria-expanded')),'true');
 await page.screenshot({path:resolve(directory,'open-390.png')});
 await drag(page,{x:250,y:400},{x:40,y:400});assert.equal(await isOpen(page),false,'Swiping left closes the menu');
 assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('navigation-open')),false);
 await page.click('#menu-toggle');assert.equal(await isOpen(page),true,'The Menu button still works');await page.click('#menu-toggle');
 await page.setViewport({width:1024,height:800,hasTouch:true,isMobile:true});await page.waitForSelector('#menu-toggle',{hidden:true});await drag(page,{x:8,y:400},{x:300,y:400});
 assert.equal(await isOpen(page),false,'Desktop keeps its sidebar and ignores the swipe');
 assert.deepEqual(errors,[]);
 console.log('PASS: left-edge swipe opens the phone menu, swipe left closes it, middle/short/vertical drags ignored, Menu button intact, desktop unaffected. Screenshots: '+directory);
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
