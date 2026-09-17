const $=selector=>document.querySelector(selector);
let csrf='',characters=[],active='',bank=null,page=0,busy=false,sheets=new Map();
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
  characters=[];bank=null;$('#content').hidden=true;$('#link').hidden=false;$('#status').textContent=message;
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
    else $('#status').textContent=error.message;
  }finally{busy=false;controls();}
}
function renderSheet(){
  const sheet=sheets.get(active),host=$('#sheet');host.replaceChildren();
  if(!sheet){host.append(text('p','Character details are unavailable right now.','field-help'));$('#equipment').replaceChildren();return;}
  const info=sheet.player_info??{};
  host.append(text('p',sheet.name,'companion-name'));
  const facts=text('dl',undefined,'companion-facts');
  for(const [label,value] of [['Level',sheet.level],['Class',sheet.class_id],['Health',info.playerHealth!==undefined?info.playerHealth+' / '+info.playerHealthMax:null],['Strength',info.str],['Defence',info.def]]){
    if(value===null||value===undefined)continue;
    facts.append(text('dt',label),text('dd',String(value)));
  }
  host.append(facts);
  const gear=$('#equipment');gear.replaceChildren();
  for(const slot of sheet.equipment??[]){
    const row=text('div',undefined,'companion-slot');
    row.append(text('span',slot.slot.replace(/_/g,' '),'companion-slot-name'),text('strong',slot.name));
    gear.append(row);
  } // The inspect projection already resolved item names; it never exposes raw inventory or private survival fields.
}
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
    const character=characters.find(row=>row.id===active);
    const result=await request('zones/action',{action:'bank_sell',character_id:active,revision:character.revision,controller:controller(),request_id:crypto.randomUUID(),bank_item:entry.id,item_instance:item.online_item});
    apply(result);$('#bank-status').textContent='Sold '+(item.name??item.item_id)+' for '+coins(item.online_sell_price)+' LiDollCoins.';
  }));
  return button;
}
function controller(){ // A stable per-tab controller id keeps the arena's single-window rules satisfied without claiming a zone.
  try{let value=sessionStorage.getItem('lidoll.companion.controller');if(!value){value=crypto.randomUUID();sessionStorage.setItem('lidoll.companion.controller',value);}return value;}
  catch{return 'companion';}
}
function apply(snapshot){ // A bank_sell reply already carries the companion-visible bank, so a sale needs no second read.
  characters=snapshot.characters??[];
  if(snapshot.character)characters=characters.map(row=>row.id===snapshot.character.id?{...row,revision:snapshot.character.revision}:row);
  if(!characters.some(row=>row.id===active))active=characters[0]?.id??'';
  $('#character').replaceChildren(...characters.map(row=>new Option(row.name,row.id)));
  $('#character').value=active;
  $('#wallet').textContent=snapshot.coins===undefined?'':coins(snapshot.coins)+' LiDollCoins · '+coins(snapshot.dailyRemaining??0)+' of today’s '+coins(snapshot.dailyCap??0)+'-coin selling allowance left';
  if(snapshot.sheet)sheets.set(snapshot.sheet.character_id,snapshot.sheet); // The companion view carries the sheet, so no presence-bound inspect call is needed.
  bank=snapshot.bank;if(bank)page=bank.page;
  $('#content').hidden=!characters.length;$('#link').hidden=true;
  $('#status').textContent=characters.length?'':'This account has no LiDollQuest characters yet. Start one in the game and come back.';
  renderBank();
}
async function load(){
  const session=await request('session');
  if(session.linked===false)return unlinked('Connect LiDollQuest to view your character and bank.');
  csrf=session.csrf??'';
  const snapshot=await request('zones',null,'?view=companion'+(active?'&character_id='+encodeURIComponent(active):'')+'&bank_page='+page);
  apply(snapshot);
  renderSheet();
}
$('#character').addEventListener('change',()=>{active=$('#character').value;page=0;$('#bank-status').textContent='';void run(load);});
$('#reload').addEventListener('click',()=>{$('#bank-status').textContent='';void run(load);});
$('#previous').addEventListener('click',()=>{page=Math.max(0,(bank?.page??0)-1);void run(load);});
$('#next').addEventListener('click',()=>{page=(bank?.page??0)+1;void run(load);});
window.addEventListener('pagehide',()=>{csrf='';sheets.clear();}); // Never retain a CSRF token or private character details after leaving the page.
window.addEventListener('online',()=>void run(load));
void run(load);
