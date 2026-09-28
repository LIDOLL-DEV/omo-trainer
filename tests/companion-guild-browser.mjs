import {startIdentityFixture} from './identity-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/companion-guild-browser-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await (async()=>{await startIdentityFixture();return import('../scripts/serve.mjs');})();if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];

// One synthetic companion snapshot with a guild: the page under test is the real companion; only the wallet gateway is stubbed. (2026-09-28)
const sheet={description:'',description_revision:0,available:true,online:true,source:'online',updatedAt:'2026-09-30T12:00:00Z',name:'Tabs Tester',level:4,class_id:'knight',player_info:{str:9,def:4,playerHealth:40,playerHealthMax:60},equipment:[],inventory:[],tush:{item_id:'',name:'Nothing',is_diaper:false,status:'Bare',wet_absorbed:0,mess_absorbed:0,capacity:0,bulk:0}};
const guild={id:'g-1',name:'Night Nappers',tag:'NAP',motd:'Be kind, stay dry.',crest:'',leader:'char-2',rank:'officer',status:'active',open:true,memberCap:30,
 members:[{id:'char-2',name:'Alice',rank:'leader',online:true,zone:'princess-rose',joined:1,donated:500},{id:'char-1',name:'Tabs Tester',rank:'officer',online:true,zone:'princess-rose',joined:2,donated:100},{id:'char-3',name:'Carol',rank:'member',online:false,zone:null,joined:3,donated:0}],
 treasury:{balance:600,ledger:[{id:2,characterId:'char-2',name:'Alice',kind:'donation',amount:500,note:'',at:1759233600000},{id:1,characterId:'char-1',name:'Tabs Tester',kind:'donation',amount:100,note:'',at:1759230000000}]},
 goal:{weekStart:1759104000000,endsAt:1759708800000,points:12,target:50,reward:150,dives:2,quests:3,accidents:0,lastWeek:null},
 upgrades:{cap:0,motd:0,crest:false,prices:{cap:2000,motd:500,crest:1500},capMax:4,motdMax:2,motdLength:240},
 applications:[{id:'app-1',characterId:'char-9',name:'Dave',created:1759230000000}]};
const snapshot={coins:120,dailyRemaining:50,dailyCap:100,characters:[{id:'char-1',name:'Tabs Tester',revision:3}],character:{id:'char-1',revision:3},bank:{page:0,pages:1,count:0,capacity:40,items:[]},sheet,capabilities:{guilds:true},
 guildSupport:true,guildChatSupport:true,guildRules:{fee:1000,cap:30,nameMin:3,nameMax:24,tagMin:2,tagMax:4,motdMax:240,chatMax:240,donationPresets:[100,500,1000],donationMax:9999},
 guild,guildInvitations:[],guildApplications:[],guildChat:[{seq:1,name:'Alice',text:'hello guild',channel:'guild',emote:false},{seq:2,name:'Carol',text:'waves',channel:'guild',emote:true}],
 guildLeaderboard:[{id:'g-1',name:'Night Nappers',tag:'NAP',crest:'',members:3,points:12,target:50},{id:'g-2',name:'Free Folk',tag:'FF',crest:'',members:1,points:0,target:50}]};
const posted=[]; // Every zones/action body the page sent, in order.

try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
  await page.setViewport({width:1280,height:1400});
  await page.setRequestInterception(true);
  page.on('request',request=>{
    const url=request.url();
    if(url.includes('/api/lidollcoin/browser/session'))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({linked:true,csrf:'test-csrf'})});
    if(url.includes('/api/lidollcoin/browser/zones/action')){
      const input=JSON.parse(request.postData());posted.push(input);
      assert.equal(request.headers()['x-csrf-token'],'test-csrf');assert.equal(input.character_id,'char-1');assert.equal(input.revision,3);assert.equal(input.companion,true,'guild writes ask for the slim view');assert.ok(input.request_id&&input.controller);
      if(input.action==='guild_chat')snapshot.guildChat.push({seq:snapshot.guildChat.length+1,name:'Tabs Tester',text:input.text,channel:'guild',emote:false});
      if(input.action==='guild_motd')guild.motd=input.text;
      if(input.action==='guild_donate'&&input.amount===7)return void request.respond({status:409,contentType:'application/json',body:JSON.stringify({error:'guild_conflict',error_description:'Donate between 1 and 9999 LiDollCoins.'})});
      if(input.action==='guild_leave'){snapshot.guild=null;}
      return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(snapshot)});
    }
    if(url.includes('/api/lidollcoin/browser/zones'))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(snapshot)});
    return void request.continue();
  });
  await page.goto(origin+'companion/',{waitUntil:'networkidle0'});
  await page.waitForSelector('#guild-roster tbody tr');

  // ── Member view: tag, MOTD, roster with online dots, goal, chat, treasury ──
  assert.equal(await page.$eval('#guild-tag',e=>e.textContent),'[NAP] Night Nappers');
  assert.equal(await page.$eval('#guild-motd',e=>e.textContent),'Be kind, stay dry.');
  assert.deepEqual(await page.$$eval('#guild-roster tbody tr td:nth-child(2)',cells=>cells.map(c=>c.textContent)),['Leader','Officer','Member']);
  assert.deepEqual(await page.$$eval('#guild-roster .companion-online',dots=>dots.map(d=>d.classList.contains('is-online'))),[true,true,false]);
  assert.match(await page.$eval('#guild-summary',e=>e.textContent),/Officer · 3 of 30 members · 2 online/);
  assert.equal(await page.$eval('#guild-goal-meter',e=>e.value+'/'+e.max),'12/50');
  assert.deepEqual(await page.$$eval('#guild-chat li',items=>items.map(i=>i.textContent)),['Alice: hello guild','* Carol waves']);
  assert.match(await page.$eval('#guild-treasury-summary',e=>e.textContent),/^600 LiDollCoins/);
  assert.equal(await page.$$eval('#guild-ledger tbody tr',rows=>rows.length),2);
  assert.equal(await page.$('#guild-upgrades button'),null,'officers see no upgrade buttons');
  assert.equal(await page.$eval('#guild-manage',e=>e.hidden),false,'officers get the officer tools');
  assert.match(await page.$eval('#guild-applications',e=>e.textContent),/Dave wants to join/);
  assert.equal(await page.$eval('#guild-disband',e=>e.hidden),true);
  const rosterButtons=await page.$$eval('#guild-roster tbody tr td:last-child',cells=>cells.map(c=>Array.from(c.querySelectorAll('button')).map(b=>b.textContent)));
  assert.deepEqual(rosterButtons,[[],[],['Remove']],'an officer may only remove plain members');

  // ── Chat post: the composer sends guild_chat with companion:true and the draft survives a refresh ──
  await page.type('#guild-chat-input','from the tracker');
  await page.click('#reload');await page.waitForFunction(()=>!document.querySelector('#reload').disabled);
  assert.equal(await page.$eval('#guild-chat-input',e=>e.value),'from the tracker','refresh keeps an unsent chat line');
  await page.click('#guild-chat-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelectorAll('#guild-chat li').length===3);
  assert.equal(posted.at(-1).action,'guild_chat');assert.equal(posted.at(-1).text,'from the tracker');
  assert.equal(await page.$eval('#guild-chat-input',e=>e.value),'');

  // ── Donate preset and a refused custom amount ──
  await page.click('#guild-donate-presets button');await page.waitForFunction(()=>document.querySelector('#guild-status').textContent.startsWith('Donation sent'));
  assert.deepEqual([posted.at(-1).action,posted.at(-1).amount],['guild_donate',100]);
  await page.type('#guild-donate-amount','7');await page.click('#guild-donate-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#guild-status').textContent.includes('Donate between 1 and 9999'));
  assert.equal(await page.$eval('#guild-card',e=>e.hidden),false,'a guild error never clears the card');

  // ── MOTD edit as an officer ──
  await page.click('#guild-motd-edit');await page.$eval('#guild-motd-input',e=>{e.value='New MOTD';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#guild-motd-form button[type=submit]');await page.waitForFunction(()=>document.querySelector('#guild-motd').textContent==='New MOTD');
  assert.equal(posted.at(-1).action,'guild_motd');

  // ── Leader view: upgrades and roster management appear; a leader with members cannot simply leave ──
  guild.rank='leader';guild.leader='char-1';guild.members[0].rank='officer';guild.members[1].rank='leader';
  await page.click('#reload');await page.waitForFunction(()=>document.querySelectorAll('#guild-upgrades button').length===3);
  assert.equal(await page.$eval('#guild-leave',e=>e.hidden),true);assert.equal(await page.$eval('#guild-disband',e=>e.hidden),false);
  const locked=await page.$$eval('#guild-upgrades button',buttons=>buttons.map(b=>b.disabled));
  assert.deepEqual(locked,[true,false,true],'only the 500-coin MOTD upgrade is affordable with 600 in the treasury');
  const leaderButtons=await page.$$eval('#guild-roster tbody tr td:last-child',cells=>cells.map(c=>Array.from(c.querySelectorAll('button')).map(b=>b.textContent)));
  assert.deepEqual(leaderButtons.map(list=>list.join(',')),['Demote,Make leader,Remove','','Promote,Make leader,Remove'],'the stub keeps its row order: Alice (now officer), me (leader), Carol (member)');

  // ── Guildless view: invitations, create and apply forms, leaderboard Apply buttons ──
  snapshot.guild=null;snapshot.guildInvitations=[{id:'inv-1',guild:'g-2',name:'Free Folk',tag:'FF',sender:'Erin',expires:1759708800000}];
  await page.click('#reload');await page.waitForSelector('#guild-invites li');
  assert.equal(await page.$eval('#guild-home',e=>e.hidden),true);assert.equal(await page.$eval('#guild-join',e=>e.hidden),false);
  assert.match(await page.$eval('#guild-invites',e=>e.textContent),/\[FF\] Free Folk invited you \(from Erin\)/);
  assert.equal(await page.$$eval('#guild-board tbody button',buttons=>buttons.length),2,'guildless players may apply from the leaderboard');
  await page.click('#guild-invites button');await page.waitForFunction(()=>document.querySelector('#guild-status').textContent.startsWith('You joined'));
  assert.deepEqual([posted.at(-1).action,posted.at(-1).invitation],['guild_accept','inv-1']);
  await page.type('#guild-create-name','Sleepy Bears');await page.type('#guild-create-tag','zzz');await page.click('#guild-create-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#guild-status').textContent.includes('founded')||document.querySelector('#guild-status').textContent.includes('Charter'));
  assert.deepEqual([posted.at(-1).action,posted.at(-1).name,posted.at(-1).tag],['guild_create','Sleepy Bears','ZZZ'],'tags are upper-cased before sending');
  assert.equal(posted.some(body=>'guild_page' in body||Object.keys(body).some(k=>k.startsWith('guild_'))),false,'no game-only fields leak into requests');
  assert.deepEqual(errors,[]);
  console.log('companion guild browser checks passed');
}finally{
  await browser?.close();server.close();
}
