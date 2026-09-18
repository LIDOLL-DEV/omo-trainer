import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/companion-browser-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];

// One synthetic sheet covering every tab rule, including the bottled "food" the game files under Drinks.
const inventory=[
 {index:0,item_id:'iron_dagger',name:'Rusty dagger',category:'weapon',atk:7},
 {index:1,item_id:'frilly_dress',name:'Frilly dress',category:'dress',bulk:2},
 {index:2,item_id:'diaper_cover_lace',name:'Lace cover',category:'diaper_cover'},
 {index:3,item_id:'cupcake',name:'Cupcake',category:'food',hp_restore:12},
 {index:4,item_id:'water_bottle',name:'Water bottle',category:'food',is_drink:true},
 {index:5,item_id:'juice_box',name:'Juice box',category:'drink'},
 {index:6,item_id:'rusted_key',name:'Rusted key',category:'quest_item'}
];
const snapshot={coins:120,dailyRemaining:50,dailyCap:100,characters:[{id:'char-1',name:'Tabs Tester',revision:3}],
 character:{id:'char-1',revision:3},bank:{page:0,pages:1,count:0,capacity:40,items:[]},
 sheet:{available:true,online:true,source:'online',updatedAt:'2026-09-17T12:00:00Z',name:'Tabs Tester',level:4,class_id:'knight',
  player_info:{str:9,def:4,playerHealth:40,playerHealthMax:60},equipment:[{slot:'weapon',name:'Rusty dagger',item_id:'iron_dagger'}],
  inventory,tush:{item_id:'thick_medical_diaper',name:'Thick medical diaper',is_diaper:true,status:'Damp',wet_absorbed:2,mess_absorbed:0,capacity:6,bulk:3}}};

const labels=page=>page.$$eval('#inventory-tabs button',nodes=>nodes.map(node=>node.firstChild.textContent));
const counts=page=>page.$$eval('#inventory-tabs .companion-tab-count',nodes=>nodes.map(node=>Number(node.textContent)));
const rows=page=>page.$$eval('#inventory tbody tr td:first-child',cells=>cells.map(cell=>cell.textContent));
const selected=page=>page.$eval('#inventory-tabs [aria-selected="true"]',node=>node.id);

try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:1280,height:1000});
  await page.setRequestInterception(true); // Stub only the wallet gateway; the companion page, script and styles are served for real.
  page.on('request',request=>{
    const url=request.url();
    if(url.includes('/api/lidollcoin/browser/session'))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({linked:true,csrf:'test-csrf'})});
    if(url.includes('/api/lidollcoin/browser/zones'))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(snapshot)});
    return void request.continue();
  });
  await page.goto(origin+'companion/',{waitUntil:'networkidle0'});
  await page.waitForSelector('#inventory-tabs button');

  // ── The strip mirrors the game's battle tabs, in order, behind an All catch-all ──
  assert.deepEqual(await labels(page),['ALL','CLOTHES','WPNS','FOOD','DRINKS'],'tab order must match inv_battle_overlay_groups() after All');
  assert.deepEqual(await counts(page),[7,2,1,1,2],'counts follow inv_item_matches_group(): the bottled water is a drink, not food');
  assert.equal(await selected(page),'inventory-tab-all');
  assert.deepEqual(await rows(page),inventory.map(item=>item.name),'All shows every carried item, quest items included');
  assert.deepEqual(await page.$$eval('#inventory tbody tr td:nth-child(2)',cells=>cells.map(cell=>cell.textContent)),
   ['Weapon','Dress','Cover','Food','Drink','Drink','Key'],'the Type column uses inv_category_short_label(), with bottled food reading "Drink" as every game grid draws it');

  // ── Each tab filters to exactly the game's group ──
  for(const [id,expected] of [['clothes',['Frilly dress','Lace cover']],['weapons',['Rusty dagger']],['food',['Cupcake']],['drinks',['Water bottle','Juice box']]]){
    await page.click('#inventory-tab-'+id);
    assert.deepEqual(await rows(page),expected,id+' must list exactly the items the game puts on that tab');
    assert.equal(await page.$eval('#inventory',node=>node.getAttribute('aria-labelledby')),'inventory-tab-'+id);
  }
  await page.click('#inventory-tab-weapons');
  assert.equal((await rows(page)).includes('Rusted key'),false,'a quest item never appears on a category tab');

  // ── Keyboard: arrows cycle and wrap like the game's shoulder buttons ──
  await page.focus('#inventory-tab-weapons');
  await page.keyboard.press('ArrowRight');assert.equal(await selected(page),'inventory-tab-food');
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');assert.equal(await selected(page),'inventory-tab-clothes');
  await page.keyboard.press('End');assert.equal(await selected(page),'inventory-tab-drinks');
  await page.keyboard.press('ArrowRight');assert.equal(await selected(page),'inventory-tab-all','the strip wraps at both ends');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'inventory-tab-all','arrow keys carry focus with the selection');
  assert.equal(await page.$$eval('#inventory-tabs button',nodes=>nodes.filter(node=>node.tabIndex===0).length),1,'a roving tabindex keeps the strip one Tab stop');

  // ── A refresh redraws the sheet without losing the chosen tab ──
  await page.click('#inventory-tab-drinks');
  await page.click('#reload');await page.waitForFunction(()=>document.querySelector('#inventory tbody tr'));
  assert.equal(await selected(page),'inventory-tab-drinks','the 15-second refresh must not throw the reader back to All');
  assert.deepEqual(await rows(page),['Water bottle','Juice box']);
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#inventory-tabs button');
  assert.equal(await selected(page),'inventory-tab-drinks','the remembered tab survives a reload of this browser tab');

  // ── An empty group explains itself instead of showing a bare table ──
  snapshot.sheet.inventory=[inventory[0]];
  await page.click('#reload');await page.waitForFunction(()=>document.querySelector('#inventory p'));
  assert.match(await page.$eval('#inventory p',node=>node.textContent),/No drinks in this character/);
  assert.deepEqual(await counts(page),[1,0,1,0,0]);

  // ── Nothing carried at all still reads as an empty bag, on every tab ──
  snapshot.sheet.inventory=[];
  await page.click('#reload');await page.waitForFunction(()=>document.querySelector('#inventory p')?.textContent.includes('bag is empty'));
  assert.equal(await page.$eval('#inventory-summary',node=>node.textContent),'0 carried items · showing 0 in drinks');

  for(const width of [320,390,680,1024,1280]){ // The strip wraps rather than pushing the page sideways on a phone.
    await page.setViewport({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`companion overflows at ${width}px`);
  }
  snapshot.sheet.inventory=inventory;await page.click('#reload');await page.waitForSelector('#inventory tbody tr');
  for(const theme of ['little-tracker','caregiver-tracker']){ // The pills use theme tokens, so the selected tab must stay legible in both.
    await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    const colours=await page.$eval('#inventory-tabs [aria-selected="true"]',node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,color:style.color};});
    assert.notEqual(colours.background,colours.color,`the selected tab must not be invisible in ${theme}`);
    assert.doesNotMatch(colours.background,/rgba\(0, 0, 0, 0\)/,`${theme} must fill the selected tab rather than fall back to a transparent pill`);
    await page.setViewport({width:390,height:844});await page.screenshot({path:resolve(directory,`${theme}-mobile.png`),fullPage:true});
    await page.setViewport({width:1280,height:1000});await page.screenshot({path:resolve(directory,`${theme}-desktop.png`),fullPage:true});
  }

  assert.deepEqual(errors,[],'the companion page must raise no script errors');
  console.log('companion category tabs verified; screenshots in '+directory);
}finally{
  await browser?.close();
  await new Promise(done=>server.close(done));
}
