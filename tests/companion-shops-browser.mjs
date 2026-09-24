import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/companion-shops-browser-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];

// A stub of LiDollQuest's companion view and the four shop-related actions (companion-shops.mjs, zones.mjs).
const odds=[['common',60,'#ffffff'],['uncommon',25,'#4fd06b'],['rare',10,'#4f9cff'],['epic',4,'#b45fff'],['legendary',1,'#ff9f1c']].map(([rarity,chance,colour])=>({rarity,chance,colour}));
const game={revision:5,version:'v1',price:3,bank:[],inventory:[],equipped:'',last:null,sold:[],rolls:new Map(),dropNextRoll:true};
const rolled=n=>({item_id:'gen_cottage_pull_up',name:'Crinkly Cottage Pull-Up of Whispers '+n,category:'panties',is_diaper:true,online_item:'token-'+n,online_sell_price:3,loot:{rarity:'rare',ilvl:12}});
const diamondOdds=odds.map(o=>['common','uncommon'].includes(o.rarity)?{...o,chance:0}:{...o,chance:o.rarity==='rare'?66.67:o.rarity==='epic'?26.67:6.66}); // Floored at rare.
const view=()=>({coins:120,dailyRemaining:9999,dailyCap:9999,capabilities:{companionShops:true,companionWithdraw:true,companionDiamondRolls:true},
 characters:[{id:'char-1',name:'Shop Tester',revision:game.revision}],character:{id:'char-1',name:'Shop Tester',revision:game.revision},
 bank:{page:0,pages:1,count:game.bank.length,capacity:512,items:game.bank},
 shops:{bankFree:512-game.bank.length,pending:false,last:game.last&&{...game.last,in_bank:game.bank.some(e=>e.id===game.last.bank_item)},
  shops:[{id:'atelier',name:'Diaper Atelier',price:game.price,available:true,odds,diamond:{price:1,floor:'rare',odds:diamondOdds}},{id:'emporium',name:'Clothes Emporium',price:game.price,available:true,odds,diamond:{price:1,floor:'rare',odds:diamondOdds}}]},
 sheet:{available:true,online:false,source:'online',equipmentEditable:true,equipment_version:game.version,name:'Shop Tester',level:12,class_id:'fighter',player_info:{},
  equipment:[{slot:'panties',item_id:game.equipped,name:game.equipped?'Cottage Pull-Up':'(empty)'}],
  inventory:game.inventory.map((item,index)=>({index,item_id:item.item_id,name:item.name,category:item.category,equippable:true})),
  tush:{item_id:'',name:'No undergarment',is_diaper:false,status:'No undergarment',wet_absorbed:0,mess_absorbed:0,capacity:1,bulk:0}}});
const conflict=(code,message)=>({status:409,body:{error:code,error_description:message}});
function act(input){
 if(input.revision!==game.revision&&!(input.action==='companion_roll'&&game.rolls.has(input.request_id)))return conflict('stale','Character changed; refresh before choosing another action.');
 if(input.action==='companion_roll'){
  if(game.rolls.has(input.request_id))return {status:200,body:view()}; // A replay returns the committed receipt.
  const cost=input.mode==='diamond'?1:game.price; // The diamond mode is always exactly one diamond.
  if(input.price!==cost)return conflict('price_changed',input.mode==='diamond'?'A diamond roll costs exactly 1 diamond. Review it and roll again.':'The price changed to '+game.price+' LiDollCoins. Review it and roll again.');
  const n=game.rolls.size+1,entry={id:'bank-'+n,item:rolled(n)};game.rolls.set(input.request_id,entry);game.bank.push(entry);game.revision++;
  game.last={id:'p'+n,shop:input.shop,status:'delivered',price:cost,mode:input.mode??'coins',currency:input.mode==='diamond'?'diamonds':'coins',bank_item:entry.id,item_instance:entry.item.online_item,
   item:{item_id:entry.item.item_id,name:entry.item.name,category:'panties',rarity:'rare',colour:'#4f9cff',ilvl:12,desc:'Cottage pull-up. Tiny flowers on soft cotton.',is_diaper:true,stats:{wet_resist:-3,bulk:1,cha_mod:3},value:35,sell:3}};
  if(game.dropNextRoll){game.dropNextRoll=false;return {status:503,body:{}};} // Committed on the server, but the reply is lost.
  return {status:200,body:view()};
 }
 if(input.action==='companion_withdraw'){
  assert.equal(input.equipment_version,game.version);
  const index=game.bank.findIndex(e=>e.id===input.bank_item);if(index<0)return conflict('bank_conflict','That item is no longer in your bank.');
  game.inventory.push(game.bank.splice(index,1)[0].item);game.revision++;game.version='v'+game.revision;return {status:200,body:view()};
 }
 if(input.action==='companion_equip'){
  assert.equal(input.equipment_version,game.version);assert.equal(game.inventory[input.slot]?.item_id,input.item_id);
  game.equipped=game.inventory.splice(input.slot,1)[0].item_id;game.revision++;game.version='v'+game.revision;return {status:200,body:view()};
 }
 if(input.action==='bank_sell'){
  const index=game.bank.findIndex(e=>e.id===input.bank_item);assert.equal(game.bank[index]?.item.online_item,input.item_instance);
  game.sold.push(game.bank.splice(index,1)[0]);game.revision++;return {status:200,body:view()};
 }
 throw Error('unexpected action '+input.action);
}
const status=(page,selector,text)=>page.waitForFunction((s,t)=>document.querySelector(s).textContent.includes(t),{},selector,text);
const idle=page=>page.waitForFunction(()=>!document.querySelector('#reload').disabled);

try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.setViewport({width:1280,height:1000});
 const requests=[];
 await page.setRequestInterception(true); // Stub only the wallet gateway; the companion page, script and styles are served for real.
 page.on('request',request=>{
  const url=request.url(),json=(status,body)=>request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
  if(url.includes('/api/lidollcoin/browser/session'))return void json(200,{linked:true,csrf:'test-csrf'});
  if(url.includes('/api/lidollcoin/browser/zones/action')){
   assert.equal(request.headers()['x-csrf-token'],'test-csrf');const input=JSON.parse(request.postData());requests.push(input);
   const result=act(input);return void json(result.status,result.body);
  }
  if(url.includes('/api/lidollcoin/browser/zones'))return void json(200,view());
  return void request.continue();
 });
 await page.goto(origin+'companion/',{waitUntil:'networkidle0'});
 await page.waitForSelector('#shops .companion-shop');

 // ── Both shops show price, odds and the destination character ──
 assert.equal(await page.$eval('#shops-card',n=>n.hidden),false);
 assert.deepEqual(await page.$$eval('#shops h3',n=>n.map(e=>e.textContent)),['Diaper Atelier','Clothes Emporium']);
 assert.deepEqual(await page.$$eval('#shops .button',n=>n.map(e=>e.textContent)),['Roll for 3 LiDollCoins','Roll for 3 LiDollCoins']);
 assert.match(await page.$eval('#shops-summary',n=>n.textContent),/Shop Tester’s bank · 512 free slots/);
 assert.equal(await page.$$eval('.companion-odds',n=>n[0].children.length),5);
 assert.equal(await page.$eval('#shop-result',n=>n.hidden),true,'nothing to reveal before the first roll');

 // ── A lost reply keeps the same request for Retry, so the player is never charged twice ──
 await page.click('#shops .companion-shop:first-child .button');
 await status(page,'#shop-status','Retry roll');
 assert.equal(await page.$eval('#shops .companion-shop:first-child .button',n=>n.textContent),'Retry roll');
 assert.equal(await page.$eval('#shops .companion-shop:last-child .button',n=>n.disabled),true,'the other shop waits for the uncertain roll');
 await page.click('#shops .companion-shop:first-child .button');
 await status(page,'#shop-status','You got Crinkly Cottage Pull-Up of Whispers 1!');
 const rolls=requests.filter(r=>r.action==='companion_roll');
 assert.equal(rolls.length,2);assert.equal(rolls[0].request_id,rolls[1].request_id);assert.equal(rolls[0].price,3);assert.equal(game.rolls.size,1);

 // ── The reveal shows the rolled item, tinted by its rarity ──
 assert.equal(await page.$eval('#shop-result',n=>n.hidden),false);
 assert.equal(await page.$eval('#shop-result h3',n=>n.textContent),'Crinkly Cottage Pull-Up of Whispers 1');
 assert.equal(await page.$eval('#shop-result',n=>n.style.getPropertyValue('--rarity')),'#4f9cff');
 assert.deepEqual(await page.$$eval('.companion-reveal-stats li',n=>n.map(e=>e.textContent)),['Wet resist -3','Bulk +1','CHA mod +3']);
 assert.deepEqual(await page.$$eval('#shop-result .button',n=>n.map(e=>e.textContent)),['Wear now','Sell']);
 await page.screenshot({path:resolve(directory,'reveal-desktop.png'),fullPage:true});

 // ── Wear now: withdraw from the bank, then equip the withdrawn copy ──
 await page.click('#shop-result .button.primary');
 await status(page,'#status','Now wearing Crinkly Cottage Pull-Up of Whispers 1.');
 assert.equal(game.equipped,'gen_cottage_pull_up');assert.equal(game.bank.length,0);
 assert.deepEqual(requests.slice(-2).map(r=>r.action),['companion_withdraw','companion_equip']);
 assert.match(await page.$eval('#shop-result',n=>n.textContent),/No longer in the bank/);

 // ── A changed price is refused and the new price is shown before the player confirms again ──
 game.price=5;
 await page.click('#shops .companion-shop:last-child .button');
 await status(page,'#shop-status','The price changed to 5');await idle(page);
 assert.equal(await page.$eval('#shops .companion-shop:last-child .button',n=>n.textContent),'Roll for 5 LiDollCoins');
 assert.equal(game.rolls.size,1,'no roll was reserved at the old price');

 // ── Sell straight from the reveal ──
 await page.click('#shops .companion-shop:last-child .button');
 await status(page,'#shop-status','You got Crinkly Cottage Pull-Up of Whispers 2!');await idle(page);
 assert.equal(await page.$$eval('#bank tbody tr',n=>n.length),1);
 assert.deepEqual(await page.$$eval('#bank tbody .button',n=>n.map(e=>e.textContent)),['Withdraw','Sell'],'bank rows offer withdraw beside sell');
 await page.click('#shop-result .button.secondary');
 await status(page,'#bank-status','Sold Crinkly Cottage Pull-Up of Whispers 2 for 3 LiDollCoins.');
 assert.equal(game.sold.length,1);assert.equal(game.bank.length,0);

 for(const width of [320,390,680,1024,1280]){
  await page.setViewport({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`companion overflows at ${width}px`);
 }
 for(const theme of ['little-tracker','caregiver-tracker']){
  await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  await page.setViewport({width:390,height:844});await page.screenshot({path:resolve(directory,`${theme}-mobile.png`),fullPage:true});
  await page.setViewport({width:1280,height:1000});await page.screenshot({path:resolve(directory,`${theme}-desktop.png`),fullPage:true});
 }
 assert.deepEqual(errors,[],'the companion page must raise no script errors');
 console.log('companion shops verified; screenshots in '+directory);
}finally{
 await browser?.close();
 await new Promise(done=>server.close(done));
}
