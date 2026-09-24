const $=selector=>document.querySelector(selector);
let csrf='',characters=[],active='',bank=null,page=0,busy=false,snapshot=null;
let pendingRoll=null; // {character,shop,body}: one roll's request, kept until the server answers definitively so a dropped connection retries that roll instead of paying for a second.
let descriptionDraft=null; // Keep the target and description version fixed while polling refreshes the rest of the character.
const gateway='../api/lidollcoin/browser/'; // Same-origin gateway: the wallet cookie is Path-scoped to it and never leaves the tracker.
const coins=value=>Number(value).toLocaleString();
const text=(tag,value,className)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;};

// ── Item categories: a port of the game's own item viewer, so a tab means the same thing in both places. ──
const clothing=new Set(['torso','dress','pants','skirt','panties','diaper_cover','socks','shoes','head','mouth','bra','corset','gloves','plug','accessory','special']); // inv_is_clothing_category()
const drink=item=>item.category==='drink'||item.is_drink===true; // inv_item_is_drink(): bottled "food" counts as a drink.
const groups=[ // The game's four battle tabs (inv_battle_overlay_groups) plus All, so quest items and future categories stay reachable.
 {id:'all',label:'ALL',title:'All items',match:()=>true},
 {id:'clothes',label:'CLOTHES',title:'Clothes',match:item=>clothing.has(item.category)},
 {id:'weapons',label:'WPNS',title:'Weapons',match:item=>item.category==='weapon'},
 {id:'food',label:'FOOD',title:'Food',match:item=>item.category==='food'&&!drink(item)},
 {id:'drinks',label:'DRINKS',title:'Drinks',match:item=>item.category==='drink'||(item.category==='food'&&drink(item))}
]; // inv_item_matches_group(), rule for rule.
const shortLabels={weapon:'Weapon',food:'Food',drink:'Drink',quest_item:'Key',torso:'Torso',dress:'Dress',pants:'Pants',skirt:'Skirt',panties:'Panties',diaper_cover:'Cover',
 socks:'Socks',shoes:'Shoes',head:'Head',mouth:'Mouth',bra:'Bra',corset:'Corset',gloves:'Gloves',plug:'Plug',accessory:'Accessory',special:'Special'}; // inv_category_short_label()
const statLabels={atk:'ATK',def:'DEF',bulk:'Bulk',bulk_threshold:'Bulk threshold',childish:'Childish',wet_resist:'Wet resist',tum_resist:'Tum resist',hp_regen:'HP regen',
 atk_mod:'ATK mod',def_mod:'DEF mod',dex_mod:'DEX mod',int_mod:'INT mod',cha_mod:'CHA mod',hp_max_mod:'Max HP',shame_delta:'Shame'}; // Stat lines a rolled item can carry (companion-shops.mjs VIEW_STATS).
const shopBlurbs={atelier:'Diapers and pull-ups, each a random style and cut.',emporium:'Dresses, tops, legwear, underwear, shoes, socks, gloves and diaper covers.'};
const capital=value=>String(value).charAt(0).toUpperCase()+String(value).slice(1);
let tab=(()=>{try{return sessionStorage.getItem('lidoll.companion.tab')??'all';}catch{return 'all';}})(); // A remembered tab survives the 15-second refresh and a reload; it holds no private detail.

async function request(route,input,query='') { // Every companion read and sale is an authenticated same-origin call; no token is ever exposed to this page.
  const response=await fetch(gateway+route+query,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),...(input?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)}:{})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(Error(value.error_description||value.error||'The companion could not reach LiDollQuest.'),{status:response.status,code:value.error});
  return value;
}
function unlinked(message){ // A missing or revoked wallet connection is an invitation to link, never an error message.
  resetDescription();
  characters=[];bank=null;snapshot=null;active='';page=0;csrf='';pendingRoll=null;clearSheet();$('#bank').replaceChildren();$('#wallet').textContent='';$('#content').hidden=true;$('#link').hidden=false;$('#status').textContent=message;
}
function controls(){
  for(const id of ['character','reload','previous','next'])$('#'+id).disabled=busy;
  $('#previous').hidden=!bank||bank.page<=0;
  $('#next').hidden=!bank||bank.page>=bank.pages-1;
  document.querySelectorAll('#bank button, button[data-equipment], #shops button, #shop-result button').forEach(button=>{button.disabled=busy||button.dataset.locked==='true';});
  $('#description-edit').disabled=busy;
  $('#description-save').disabled=busy||!snapshot?.character||Array.from($('#description-input').value).length>2000;
  $('#description-input').disabled=busy||Boolean(descriptionDraft?.pending);
  $('#description-cancel').disabled=busy||Boolean(descriptionDraft?.pending);
  $('#description-save').textContent=descriptionDraft?.pending?'Retry save':descriptionDraft?.conflict?'Save over latest description':'Save description';
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
  for(const id of ['sheet','equipment','inventory','inventory-tabs','tush-status','shops','shop-result'])$('#'+id).replaceChildren();
  $('#shops-card').hidden=true;$('#shop-result').hidden=true;
  $('#freshness').textContent='';$('#inventory-summary').textContent='';
  $('#description').textContent='';$('#description-panel').hidden=!descriptionDraft;
} // Clear every character panel together, including private details after unlinking or a failed selection.
function renderSheet(){
  clearSheet();const sheet=snapshot?.sheet,host=$('#sheet');
  renderDescription();
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
  for(const slot of sheet.equipment??[]){const row=text('div',undefined,'companion-slot');row.append(text('span',slot.slot.replace(/_/g,' '),'companion-slot-name'),text('strong',slot.name));if(slot.item?.cursed)row.append(text('span','Cursed','field-help'));if(slot.item_id)row.append(equipmentButton('Unequip','companion_unequip',slot.slot,slot.item_id,slot.locked));$('#equipment').append(row);}
  renderInventory();
  const tush=sheet.tush;$('#tush-status').append(text('strong',tush.name),text('p',tush.status));
  if(tush.is_diaper){const meter=document.createElement('progress');meter.max=tush.capacity;meter.value=tush.wet_absorbed+tush.mess_absorbed;meter.setAttribute('aria-label','Absorption used');$('#tush-status').append(meter,text('p',tush.wet_absorbed+' wet + '+tush.mess_absorbed+' messy / '+tush.capacity+' capacity','field-help'));}
  if(tush.item_id)$('#tush-status').append(text('p','Bulk: '+tush.bulk,'field-help'));
} // Every displayed field comes from the same selected-character snapshot; inventory entries keep their individual rolled stats.
function resetDescription(){
  descriptionDraft=null;$('#description-input').value='';$('#description-form').hidden=true;$('#description-edit').hidden=false;$('#description-status').textContent='';$('#description-panel').hidden=true;
} // Account changes and explicit character selection discard the old character's private draft.
function renderDescription(){
  const character=snapshot?.character,sheet=snapshot?.sheet;
  if(descriptionDraft&&descriptionDraft.character!==character?.id)resetDescription();
  $('#description-panel').hidden=!character;
  $('#description').textContent=sheet?.description||'No description yet.'; // Plain text only: player-authored HTML is never interpreted.
  $('#description-edit').hidden=Boolean(descriptionDraft);
  $('#description-edit').disabled=busy;
  $('#description-form').hidden=!descriptionDraft;
  $('#description-count').textContent=Array.from($('#description-input').value).length+' / 2,000 characters';
}
$('#description-edit').addEventListener('click',()=>{
  if(busy||!snapshot?.character)return;
  descriptionDraft={character:snapshot.character.id,version:snapshot.sheet?.description_revision??0,pending:null};
  $('#description-input').value=snapshot.sheet?.description??'';$('#description-status').textContent='';renderDescription();controls();$('#description-input').focus();
});
$('#description-input').addEventListener('input',()=>{renderDescription();controls();});
$('#description-cancel').addEventListener('click',()=>{if(busy||descriptionDraft?.pending)return;resetDescription();renderDescription();controls();});
$('#description-form').addEventListener('submit',event=>{
  event.preventDefault();if(busy||!descriptionDraft||descriptionDraft.character!==snapshot?.character?.id)return;
  if(Array.from($('#description-input').value).length>2000){$('#description-status').textContent='Please shorten your description to 2,000 characters.';return;}
  void run(async()=>{
    const draft=descriptionDraft;
    draft.pending??={action:'description',character_id:draft.character,description_revision:draft.version,description:$('#description-input').value,request_id:crypto.randomUUID()};
    controls();
    try{
      const result=await request('characters/action',draft.pending);
      snapshot.sheet={...snapshot.sheet,description:result.description,description_revision:result.description_revision};
      if(Number.isSafeInteger(result.revision))snapshot.character.revision=result.revision; // Subsequent bank or equipment actions use the newly committed character revision.
      resetDescription();renderDescription();$('#description-status').textContent='Description saved.';
    }catch(error){
      if(error.status&&error.status<500&&error.status!==429)draft.pending=null; // Uncertain responses keep the same receipt for safe retries.
      if(error.code==='description_conflict'){
        await load();
        if(descriptionDraft===draft){draft.version=snapshot.sheet?.description_revision??0;draft.conflict=true;$('#description-status').textContent='Changed on another device. Your draft is kept below; review the latest description above before saving over it.';}
      }else if([401,403].includes(error.status))throw error;
      else $('#description-status').textContent=draft.pending?'Connection interrupted. Retry save to check whether it was saved.':error.message;
    }
  });
}); // Editing is free, and its independent version never conflicts merely because the player moved online.
function renderInventory(){ // Draws the tab strip and the rows of the selected tab only; filtering never leaves this page.
  const inventory=snapshot?.sheet?.inventory??[],tabs=$('#inventory-tabs'),panel=$('#inventory');
  const held=tabs.contains(document.activeElement); // Keep keyboard focus on the strip when the 15-second refresh redraws it.
  if(!groups.some(group=>group.id===tab))tab='all'; // A stale or hand-edited tab id falls back to the catch-all instead of hiding everything.
  const current=groups.find(group=>group.id===tab),counts=new Map(groups.map(group=>[group.id,inventory.filter(group.match).length]));
  tabs.replaceChildren();panel.replaceChildren();
  for(const group of groups){
    const button=text('button',group.label,'companion-tab'),selected=group.id===tab;
    button.type='button';button.id='inventory-tab-'+group.id;button.title=group.title;button.setAttribute('role','tab');
    button.setAttribute('aria-label',group.title+' · '+counts.get(group.id)+' item'+(counts.get(group.id)===1?'':'s'));
    button.setAttribute('aria-selected',String(selected));button.setAttribute('aria-controls','inventory');
    button.tabIndex=selected?0:-1; // Roving tabindex: the whole strip is one Tab stop, and arrow keys move within it.
    button.append(text('span',String(counts.get(group.id)),'companion-tab-count'));
    button.addEventListener('click',()=>selectTab(group.id));
    tabs.append(button);
  }
  panel.setAttribute('aria-labelledby','inventory-tab-'+tab);
  if(held)$('#inventory-tab-'+tab).focus();
  const shown=inventory.filter(current.match);
  $('#inventory-summary').textContent=inventory.length+' carried item'+(inventory.length===1?'':'s')+(tab==='all'?'':' · showing '+shown.length+' in '+current.title.toLowerCase());
  if(!inventory.length)return void panel.append(text('p','Your bag is empty.','field-help'));
  if(!shown.length)return void panel.append(text('p','No '+current.title.toLowerCase()+' in this character’s bag.','field-help'));
  const table=document.createElement('table'),head=document.createElement('thead'),heading=document.createElement('tr'),body=document.createElement('tbody');
  for(const value of ['Item','Type','Details','Action']){const cell=text('th',value);cell.scope='col';heading.append(cell);}head.append(heading);table.append(head,body);
  for(const item of shown){
    const row=document.createElement('tr'),detail=[];
    for(const key of ['atk','def','bulk','childish','hp_restore','mp_restore'])if(item[key]!==undefined)detail.push(key.replace(/_/g,' ')+': '+item[key]);
    if(item.cursed)detail.push('Cursed');
    if((item.quantity??item.count??1)>1)detail.push('Quantity: '+(item.quantity??item.count));
    row.append(text('td',item.name,'wrap'),text('td',drink(item)?'Drink':shortLabels[item.category]??'Item'),text('td',detail.join(' · ')||'—','wrap')); // Bottled food reads "Drink" and unknown categories read "Item", exactly as the game's own grids label them.
    const action=text('td');if(item.equippable)action.append(equipmentButton('Equip','companion_equip',item.index,item.item_id,false));row.append(action);
    body.append(row);
  }
  panel.append(table);
} // The snapshot is never re-fetched to change tabs: every category is already in the one sheet the page holds.
function selectTab(id,focus){
  if(id===tab)return;
  tab=id;try{sessionStorage.setItem('lidoll.companion.tab',id);}catch{} // Private-mode storage failures must never break the strip.
  renderInventory();
  if(focus)$('#inventory-tab-'+id).focus(); // Arrow-key moves carry focus along; a click leaves it where the pointer put it.
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
    if(snapshot?.capabilities?.companionWithdraw&&snapshot.sheet?.available)action.append(withdrawButton(entry.id,item.item_id,'Withdraw',false));
    if(item.online_sell_price>0&&item.online_item)action.append(sellButton(entry,item));
    else if(!action.childNodes.length)action.append(text('span','—','field-help')); // Untracked loot and quest items carry no sale right; the server is still the authority.
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
function equipmentButton(label,action,slot,itemId,locked){
 const button=text('button',label,'button small secondary');button.type='button';button.dataset.equipment='true';
 button.dataset.locked=String(Boolean(locked)||!snapshot.sheet.equipmentEditable);button.disabled=busy||button.dataset.locked==='true';
 button.title=locked?'This cursed item cannot be removed.':!snapshot.sheet.equipmentEditable?'Finish combat or the current game action before changing equipment.':label+' this item';
 button.addEventListener('click',()=>void run(async()=>{
  const result=await request('zones/action',{action,character_id:snapshot.character.id,revision:snapshot.character.revision,controller:controller(),request_id:crypto.randomUUID(),slot,item_id:itemId,equipment_version:snapshot.sheet.equipment_version});
  apply(result);$('#status').textContent=label==='Equip'?'Item equipped.':'Item unequipped.';
 }));
 return button;
} // Revision and source tokens prevent an old inventory row from selecting a different item after a game action.
function renderShops(){ // Diaper Atelier and Clothes Emporium: rolls go to the selected character's bank.
  const shops=snapshot?.shops,host=$('#shops');host.replaceChildren();
  $('#shops-card').hidden=!shops||!snapshot.character;
  if($('#shops-card').hidden)return renderReveal();
  $('#shops-summary').textContent='Rolls go straight to '+snapshot.character.name+'’s bank · '+coins(shops.bankFree)+' free slot'+(shops.bankFree===1?'':'s')+'. Sell them here, or wear them now or in LiDollQuest.';
  const mine=pendingRoll?.character===snapshot.character.id?pendingRoll:null;
  const oddsList=(label,rows)=>{ // One rarity-dot line per tier that can actually drop.
    const odds=text('ul',undefined,'companion-odds');odds.setAttribute('aria-label',label);
    for(const row of rows)if(row.chance>0){const dot=text('span',undefined,'companion-rarity-dot');dot.style.background=row.colour;const item=text('li');item.append(dot,text('span',capital(row.rarity)+' '+row.chance+'%'));odds.append(item);}
    return odds;
  };
  for(const shop of shops.shops){
    const panel=text('section',undefined,'companion-shop'),retry=mine?.shop===shop.id,retryMode=retry?(mine.mode??'coins'):''; // Only the roll that was interrupted offers Retry.
    const reason=!shop.available?'Nothing to roll here right now.':shops.bankFree<1?'This bank is full. Sell or withdraw something first.':mine&&!retry?'Finish your other roll first.':shops.pending&&!retry?'A purchase is still settling. Refresh in a moment.':'';
    const rollButton=(label,mode)=>{ // Shared lock state for the coin and diamond buttons; a pending roll only unlocks its own Retry.
      const button=text('button',label,mode==='diamond'?'button':'button primary');button.type='button';
      const lock=reason||(retry&&retryMode!==mode?'Finish your other roll first.':'');
      button.dataset.locked=String(Boolean(lock));button.disabled=busy||Boolean(lock);button.title=lock;button.dataset.mode=mode;
      button.addEventListener('click',()=>void rollShop(shop,mode));
      return button;
    };
    panel.append(text('h3',shop.name),text('p',shopBlurbs[shop.id]??'','field-help'),oddsList(shop.name+' odds',shop.odds),
      rollButton(retryMode==='coins'?'Retry roll':'Roll for '+coins(shop.price)+' LiDollCoin'+(shop.price===1?'':'s'),'coins'));
    if(shop.diamond&&snapshot.capabilities?.companionDiamondRolls){ // The premium mode: exactly one diamond, never below the server's rarity floor.
      const block=text('div',undefined,'companion-diamond');
      block.append(text('p','Diamond roll · never below '+capital(shop.diamond.floor),'field-help'),oddsList(shop.name+' diamond odds',shop.diamond.odds),
        rollButton(retryMode==='diamond'?'Retry diamond roll':'Roll for '+coins(shop.diamond.price)+' diamond'+(shop.diamond.price===1?'':'s'),'diamond'));
      panel.append(block);
    }
    host.append(panel);
  }
  renderReveal();
}
function rollShop(shop,mode='coins'){ // `mode`: 'coins' (the shop price) or 'diamond' (exactly one diamond, rarity floor).
  return run(async()=>{
    const character=snapshot.character;
    if(!(pendingRoll?.character===character.id&&pendingRoll.shop===shop.id&&(pendingRoll.mode??'coins')===mode))
      pendingRoll={character:character.id,shop:shop.id,mode,body:{action:'companion_roll',character_id:character.id,revision:character.revision,controller:controller(),request_id:crypto.randomUUID(),shop:shop.id,mode,price:mode==='diamond'?shop.diamond.price:shop.price}};
    $('#shop-status').textContent='Rolling…';
    try{
      const result=await request('zones/action',pendingRoll.body);
      pendingRoll=null;apply(result);
      const last=snapshot.shops?.last;
      $('#shop-status').textContent=last?.status==='delivered'?'You got '+last.item.name+'!':last?.status==='declined'?(last.currency==='diamonds'?'Not enough diamonds. Nothing was rolled.':'Not enough LiDollCoins. Nothing was rolled.'):'Your payment is still settling. Refresh in a moment; you will not be charged twice.';
    }catch(error){
      if(error.status&&error.status<500&&error.status!==429)pendingRoll=null; // A definite refusal charged nothing; uncertain failures keep the same request for Retry.
      if(error.code==='insufficient_scope'){$('#shop-status').textContent='This connection has not approved diamond spending. Reconnect the tracker to LiDollQuest and allow diamonds, then roll again.';renderShops();return;} // Consent, not a broken link: keep the page linked.
      if([401,403].includes(error.status))throw error;
      $('#shop-status').textContent=pendingRoll?'Connection interrupted. Press Retry roll to finish the same roll; you will not be charged twice.':error.message;
      if(error.code==='price_changed')await load(); // Show the new price before the player confirms again.
      else renderShops();
    }
  });
} // The price sent is the one shown; the server refuses a roll if it has changed since.
function renderReveal(){ // The last roll, tinted by its rarity, with the actions still possible for it.
  const host=$('#shop-result'),last=snapshot?.shops?.last,item=last?.status==='delivered'?last.item:null;
  host.replaceChildren();host.hidden=!item;
  if(!item)return;
  host.style.setProperty('--rarity',item.colour);
  host.append(text('p',(snapshot.shops.shops.find(shop=>shop.id===last.shop)?.name??'Shop')+' · last roll'+(last.currency==='diamonds'?' · 1 diamond':''),'companion-reveal-label'),text('h3',item.name,'companion-reveal-name'),
    text('p',capital(item.rarity)+(item.ilvl?' · Item level '+item.ilvl:'')+' · '+(shortLabels[item.category]??'Item'),'field-help'));
  const stats=Object.entries(item.stats??{});
  if(stats.length){const list=text('ul',undefined,'companion-reveal-stats');for(const [key,value] of stats)list.append(text('li',(statLabels[key]??key)+' '+(value>0?'+':'')+value));host.append(list);}
  if(item.desc)host.append(text('p',item.desc,'companion-reveal-desc'));
  const actions=text('div',undefined,'notification-actions');
  if(last.in_bank){
    if(snapshot.capabilities?.companionWithdraw&&snapshot.sheet?.available)actions.append(withdrawButton(last.bank_item,item.item_id,'Wear now',true));
    if(item.sell>0&&last.item_instance)actions.append(sellButton({id:last.bank_item},{name:item.name,online_item:last.item_instance,online_sell_price:item.sell}));
  }else actions.append(text('p','No longer in the bank.','field-help'));
  host.append(actions);
}
function withdrawButton(bankItem,itemId,label,wear){ // Bank to bag from anywhere; "Wear now" equips the withdrawn copy straight after.
  const button=text('button',label,'button small '+(wear?'primary':'secondary'));button.type='button';button.dataset.equipment='true';
  button.dataset.locked=String(!snapshot.sheet?.equipmentEditable);button.disabled=busy||button.dataset.locked==='true';
  button.title=snapshot.sheet?.equipmentEditable?(wear?'Move to your bag and wear it':'Move to your bag'):'Finish combat or the current game action first.';
  button.addEventListener('click',()=>void run(async()=>{
    const character=snapshot.character;
    const result=await request('zones/action',{action:'companion_withdraw',character_id:character.id,revision:character.revision,controller:controller(),request_id:crypto.randomUUID(),bank_item:bankItem,equipment_version:snapshot.sheet.equipment_version});
    apply(result);
    const carried=(snapshot.sheet?.inventory??[]).filter(row=>row.item_id===itemId).at(-1); // A withdrawn single joins the end of the bag.
    if(!wear||!carried?.equippable){$('#status').textContent='Moved to your bag.';return;}
    try{
      apply(await request('zones/action',{action:'companion_equip',character_id:snapshot.character.id,revision:snapshot.character.revision,controller:controller(),request_id:crypto.randomUUID(),slot:carried.index,item_id:carried.item_id,equipment_version:snapshot.sheet.equipment_version}));
      $('#status').textContent='Now wearing '+carried.name+'.';
    }catch(error){
      if([401,403].includes(error.status))throw error;
      $('#status').textContent='Moved to your bag, but it could not be worn: '+error.message;
    }
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
  renderBank();renderSheet();renderShops();
}
async function load(){
  const session=await request('session');
  if(session.linked===false)return unlinked('Connect LiDollQuest to view your character and bank.');
  csrf=session.csrf??'';
  const snapshot=await request('zones',null,'?view=companion'+(active?'&character_id='+encodeURIComponent(active):'')+'&bank_page='+page);
  apply(snapshot);
}
$('#character').addEventListener('change',()=>{resetDescription();active=$('#character').value;page=0;clearSheet();bank=null;snapshot=null;renderBank();$('#status').textContent='Loading character?';$('#bank-status').textContent='';$('#shop-status').textContent='';void run(load);});
$('#inventory-tabs').addEventListener('keydown',event=>{ // Arrow keys cycle tabs the way the game's shoulder buttons do, wrapping at both ends.
  const step={ArrowLeft:-1,ArrowRight:1,Home:'first',End:'last'}[event.key];if(step===undefined)return;
  const index=groups.findIndex(group=>group.id===tab);
  const next=step==='first'?0:step==='last'?groups.length-1:(index+step+groups.length)%groups.length;
  event.preventDefault();selectTab(groups[next].id,true);
});
$('#reload').addEventListener('click',()=>{$('#bank-status').textContent='';void run(load);});
$('#previous').addEventListener('click',()=>{page=Math.max(0,(bank?.page??0)-1);void run(load);});
$('#next').addEventListener('click',()=>{page=(bank?.page??0)+1;void run(load);});
window.addEventListener('pagehide',()=>{resetDescription();csrf='';snapshot=null;bank=null;clearSheet();renderBank();}); // Never retain a CSRF token or private character details after leaving the page.
window.addEventListener('online',()=>void run(load));
void run(load);

setInterval(()=>{if(!document.hidden&&!$('#content').hidden)void run(load);},15000); // Refresh committed state without entering a zone or taking control from the game.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void run(load);});

window.addEventListener('pageshow',event=>{if(event.persisted)void run(load);}); // Restore a fresh private view after browser back/forward cache navigation.
