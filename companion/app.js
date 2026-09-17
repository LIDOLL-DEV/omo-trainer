import {drawCharacter} from './paperdoll.js';
const $=selector=>document.querySelector(selector);
let csrf='',characters=[],active='',bank=null,page=0,busy=false,snapshot=null;
const gateway='../api/lidollcoin/browser/'; // Same-origin gateway: the wallet cookie is Path-scoped to it and never leaves the tracker.
const coins=value=>Number(value).toLocaleString();
const text=(tag,value,className)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;};

async function request(route,input,query='') { // Every companion read and sale is an authenticated same-origin call; no token is ever exposed to this page.
  const response=await fetch(gateway+route+query,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),...(input?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)}:{})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(Error(value.error_description||value.error||'The companion could not reach LiDollQuest.'),{status:response.status,code:value.error});
  return value;
}
function unlinked(message){ // A missing or revoked wallet connection is an invitation to link, never an error message.
  characters=[];bank=null;snapshot=null;active='';page=0;csrf='';clearSheet();$('#bank').replaceChildren();$('#wallet').textContent='';$('#content').hidden=true;$('#link').hidden=false;$('#status').textContent=message;
}
function controls(){
  for(const id of ['character','reload','previous','next'])$('#'+id).disabled=busy;
  $('#previous').hidden=!bank||bank.page<=0;
  $('#next').hidden=!bank||bank.page>=bank.pages-1;
  document.querySelectorAll('#bank button').forEach(button=>{button.disabled=busy;});
}
async function run(work){ // One request at a time, so a sale and a page change can never interleave on the same revision.
  if(busy)return;busy=true;controls();
  try{await work();}
  catch(error){
    if([401,403].includes(error.status))unlinked('Your LiDollQuest connection ended. Connect again to view your character.');
    else {$('#status').textContent=error.message;clearSheet();bank=null;snapshot=null;renderBank();}
  }finally{busy=false;controls();}
}
function clearSheet(){
  for(const id of ['sheet','equipment','inventory','paperdoll','tush-status','tush-art'])$('#'+id).replaceChildren();
  $('#freshness').textContent='';$('#inventory-summary').textContent='';
} // Clear every character panel together, including private details after unlinking or a failed selection.
function renderSheet(){
  clearSheet();const sheet=snapshot?.sheet,host=$('#sheet');
  if(!sheet?.available){host.append(text('p','No synced character details yet. Save this character in the game with cloud sync enabled, or enter an online hub.','field-help'));return;}
  const info=sheet.player_info??{};
  $('#freshness').textContent=(sheet.online?'Playing online · updates every 15 seconds':sheet.source==='cloud'?'Latest cloud save':'Last synced online state')+(sheet.updatedAt?' · '+new Date(sheet.updatedAt).toLocaleString():'');
  host.append(text('h3',sheet.name,'companion-name'));
  const facts=text('dl',undefined,'companion-facts');
  const ratio=(value,max)=>value===undefined?undefined:String(value)+(max===undefined?'':' / '+max);
  const stats=[['Level',sheet.level],['Class',sheet.class_id],['XP',info.xp],['Health',ratio(info.playerHealth,info.playerHealthMax)],['MP',ratio(sheet.player_mp,sheet.player_mp_max)],
   ['Strength',info.str],['Defence',info.def],['Dexterity',info.dex],['Intelligence',info.int],['Charisma',info.cha],['Stat points',info.stat_points],
   ['Stamina',info.stamina],['Hunger',info.hunger],['Thirst',info.thirst],['Wet',info.wet],['Tum',info.tum],['Shame',info.shame],['Excitement',info.excitement],
   ['Childishness',sheet.childish],['Smell',info.diaper_tum_absorbed],['Accidents',info.accident_bulk],['Incontinence',info.incontinence],['Freeze',info.grossout_chance]];
  for(const [label,value] of stats)if(value!==undefined&&value!==null)facts.append(text('dt',label),text('dd',String(value)));
  host.append(facts);
  for(const slot of sheet.equipment??[]){const row=text('div',undefined,'companion-slot');row.append(text('span',slot.slot.replace(/_/g,' '),'companion-slot-name'),text('strong',slot.name));if(slot.item?.cursed)row.append(text('span','Cursed','field-help'));$('#equipment').append(row);}
  const inventory=sheet.inventory??[];$('#inventory-summary').textContent=inventory.length+' carried item'+(inventory.length===1?'':'s');
  if(!inventory.length)$('#inventory').append(text('p','Your bag is empty.','field-help'));
  else {
   const table=document.createElement('table'),head=document.createElement('thead'),heading=document.createElement('tr'),body=document.createElement('tbody');
   for(const value of ['Item','Type','Details']){const cell=text('th',value);cell.scope='col';heading.append(cell);}head.append(heading);table.append(head,body);
   for(const item of inventory){const row=document.createElement('tr'),detail=[];for(const key of ['atk','def','bulk','childish','hp_restore','mp_restore'])if(item[key]!==undefined)detail.push(key.replace(/_/g,' ')+': '+item[key]);if(item.cursed)detail.push('Cursed');if((item.quantity??item.count??1)>1)detail.push('Quantity: '+(item.quantity??item.count));row.append(text('td',item.name,'wrap'),text('td',item.category),text('td',detail.join(' · ')||'—','wrap'));body.append(row);}
   $('#inventory').append(table);
  }
  const tush=sheet.tush;$('#tush-status').append(text('strong',tush.name),text('p',tush.status));
  if(tush.is_diaper){const meter=document.createElement('progress');meter.max=tush.capacity;meter.value=tush.wet_absorbed+tush.mess_absorbed;meter.setAttribute('aria-label','Absorption used');$('#tush-status').append(meter,text('p',tush.wet_absorbed+' wet + '+tush.mess_absorbed+' messy / '+tush.capacity+' capacity','field-help'));}
  if(tush.item_id)$('#tush-status').append(text('p','Bulk: '+tush.bulk,'field-help'));
  void drawCharacter(sheet,$('#paperdoll'),$('#tush-art'));
} // Every displayed field comes from the same selected-character snapshot; inventory entries keep their individual rolled stats.
function renderBank(){
  const host=$('#bank');host.replaceChildren();
  if(!bank){$('#bank-summary').textContent='';return;}
  $('#bank-summary').textContent=bank.count+' of '+bank.capacity+' slots used'+(bank.pages>1?' · page '+(bank.page+1)+' of '+bank.pages:'');
  if(!bank.items.length){host.append(text('p','Nothing stored in this character’s bank.','field-help'));return;}
  const table=document.createElement('table'),head=document.createElement('thead'),headRow=document.createElement('tr');
  for(const title of ['Item','Sells for','']){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;headRow.append(cell);}
  head.append(headRow);table.append(head);
  const body=document.createElement('tbody');
  for(const entry of bank.items){
    const row=document.createElement('tr'),item=entry.item??{};
    const name=document.createElement('td');name.className='wrap';name.textContent=item.name??item.item_id??'Unknown item';row.append(name);
    const price=document.createElement('td');price.textContent=item.online_sell_price>0?coins(item.online_sell_price)+' LiDollCoins':'Not sellable';row.append(price);
    const action=document.createElement('td');
    if(item.online_sell_price>0&&item.online_item)action.append(sellButton(entry,item));
    else action.append(text('span','—','field-help')); // Untracked loot and quest items carry no sale right; the server is still the authority.
    row.append(action);body.append(row);
  }
  table.append(body);host.append(table);
}
function sellButton(entry,item){
  const button=text('button','Sell','button small secondary');button.type='button';
  button.addEventListener('click',()=>void run(async()=>{
    const character=characters.find(row=>row.id===snapshot.character?.id);
    const result=await request('zones/action',{action:'bank_sell',character_id:character.id,revision:character.revision,controller:controller(),request_id:crypto.randomUUID(),bank_item:entry.id,item_instance:item.online_item});
    apply(result);$('#bank-status').textContent='Sold '+(item.name??item.item_id)+' for '+coins(item.online_sell_price)+' LiDollCoins.';
  }));
  return button;
}
function controller(){ // A stable per-tab controller id keeps the arena's single-window rules satisfied without claiming a zone.
  try{let value=sessionStorage.getItem('lidoll.companion.controller');if(!value){value=crypto.randomUUID();sessionStorage.setItem('lidoll.companion.controller',value);}return value;}
  catch{return 'companion';}
}
function apply(value){
  snapshot=value; // A bank_sell reply already carries the companion-visible bank, so a sale needs no second read.
  characters=snapshot.characters??[];
  if(snapshot.character)characters=characters.map(row=>row.id===snapshot.character.id?{...row,revision:snapshot.character.revision}:row);
  if(active&&!characters.some(row=>row.id===active))active='';
  $('#character').replaceChildren(new Option('Currently playing / latest character',''),...characters.map(row=>new Option(row.name,row.id)));
  $('#character').value=active;
  $('#wallet').textContent=snapshot.coins===undefined?'':coins(snapshot.coins)+' LiDollCoins · '+coins(snapshot.dailyRemaining??0)+' of today’s '+coins(snapshot.dailyCap??0)+'-coin selling allowance left';
  bank=snapshot.bank;if(bank)page=bank.page;
  $('#content').hidden=!characters.length;$('#link').hidden=true;
  $('#status').textContent=characters.length?'':'This account has no LiDollQuest characters yet. Start one in the game and come back.';
  renderBank();renderSheet();
}
async function load(){
  const session=await request('session');
  if(session.linked===false)return unlinked('Connect LiDollQuest to view your character and bank.');
  csrf=session.csrf??'';
  const snapshot=await request('zones',null,'?view=companion'+(active?'&character_id='+encodeURIComponent(active):'')+'&bank_page='+page);
  apply(snapshot);
}
$('#character').addEventListener('change',()=>{active=$('#character').value;page=0;clearSheet();bank=null;snapshot=null;renderBank();$('#status').textContent='Loading character?';$('#bank-status').textContent='';void run(load);});
$('#reload').addEventListener('click',()=>{$('#bank-status').textContent='';void run(load);});
$('#previous').addEventListener('click',()=>{page=Math.max(0,(bank?.page??0)-1);void run(load);});
$('#next').addEventListener('click',()=>{page=(bank?.page??0)+1;void run(load);});
window.addEventListener('pagehide',()=>{csrf='';snapshot=null;bank=null;clearSheet();renderBank();}); // Never retain a CSRF token or private character details after leaving the page.
window.addEventListener('online',()=>void run(load));
void run(load);

setInterval(()=>{if(!document.hidden&&!$('#content').hidden)void run(load);},15000); // Refresh committed state without entering a zone or taking control from the game.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void run(load);});

window.addEventListener('pageshow',event=>{if(event.persisted)void run(load);}); // Restore a fresh private view after browser back/forward cache navigation.
