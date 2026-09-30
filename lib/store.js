const $=selector=>document.querySelector(selector);
const standalone=document.body.dataset.storePage==='standalone'; // store/index.html (framed by the game homepage) versus the card on the Stickers & market page.
const api=standalone?'../api/':'./api/'; // The standalone page lives one folder down.
let data=null,csrf='',owner='',busy=false,loading=false,epoch=0,sku='',requestId='',current=null,sdk=null,buttons=null,recipient='',friends=null; // recipient: a friend's id when the coin pack is a gift; friends: accepted friends for the picker.
const visible=()=>standalone||location.hash==='#stickers'; // The card is only live on its page; the standalone store is always live.
function node(tag,text,className){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;} // Text nodes only: catalogue names come from the server, never as markup.
const money=(cents,currency)=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format(cents/100); // Prices are whole cents on the wire; only the display formats them.
const ASSET_LABEL={diamonds:'diamonds',coins:'LiDollCoins'};
const amountText=pack=>pack.amount.toLocaleString()+' '+(ASSET_LABEL[pack.asset]??pack.asset); // "1,000 LiDollCoins", "15 diamonds".
function status(text){$('#store-status').textContent=text;}
function signedOut(out){ // The standalone page shows a sign-in link instead of the card; the Stickers page simply hides the card (its own sign-in prompt is elsewhere).
  $('#store-card').hidden=out||!data?.enabled;
  const link=$('#store-sign-in');if(link)link.hidden=!out;
  const closed=$('#store-disabled');if(closed)closed.hidden=out||Boolean(data?.enabled);
}
async function request(route,input){ // Same-origin, CSRF-protected calls; a failed session hides the card instead of showing stale packs.
  const response=await fetch(api+route,{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},...(input?{body:JSON.stringify(input)}:{})});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'The store request failed.'),{status:response.status});return result;
}
function choose(next){sku=next;requestId=crypto.randomUUID();current=null;if(data?.catalog.find(p=>p.sku===sku)?.asset!=='coins')recipient='';render();} // A fresh idempotency key per selection, so one double click cannot open two PayPal orders; only coin packs keep a gift recipient.
const friendLabel=id=>friends?.find(f=>f.participantId===id)?.label??'a friend'; // Names come from the friends list; someone no longer a friend is just "a friend".
async function loadFriends(){if(friends)return friends;try{friends=(await request('friends')).friends.filter(f=>f.state==='accepted');}catch{friends=[];}return friends;} // Loaded once per page visit, only when a coin pack is selected.
function giftRow(){ // The "send as a gift" picker, built on demand under the pack grid and shown for coin packs only.
  let row=$('#store-gift-row');
  if(!row){row=node('div',undefined,'store-gift-row');row.id='store-gift-row';const label=node('label','Send as a gift to');label.htmlFor='store-gift';const select=node('select');select.id='store-gift';select.addEventListener('change',()=>{recipient=select.value;requestId=crypto.randomUUID();current=null;render();});row.append(label,select,node('p','Gifts go straight into your friend\'s wallet, and you both get 30 days of the ★ supporter star.','field-help'));$('#store-packs').after(row);}
  return row;
}
function render(){ // Rebuild the pack list, the supporter line and the recent purchases from the last server payload.
  const packs=$('#store-packs');packs.replaceChildren();
  if(!data)return;
  for(const asset of ['diamonds','coins']){ // Diamonds first, then coins, each under its own little heading.
    const group=data.catalog.filter(pack=>pack.asset===asset);if(!group.length)continue;
    packs.append(node('h3',asset==='coins'?'Coin packs':'Diamond packs','store-pack-group'));
    for(const pack of group){
      const label=node('label',undefined,'store-pack store-pack-'+asset+(pack.sku===sku?' selected':'')),input=node('input');input.type='radio';input.name='store-pack';input.value=pack.sku;input.checked=pack.sku===sku;input.disabled=busy;
      input.addEventListener('change',()=>choose(pack.sku));
      label.append(input,node('span',pack.name,'store-pack-name'),node('span',amountText(pack),'store-pack-diamonds'),node('span',money(pack.price_cents,pack.currency),'store-pack-price'));
      packs.append(label);
    }
  }
  const chosen=data.catalog.find(p=>p.sku===sku),row=giftRow();row.hidden=chosen?.asset!=='coins';
  if(!row.hidden){const select=row.querySelector('select');select.disabled=busy;if(!friends){void loadFriends().then(render);select.replaceChildren(new Option('Myself',''));}else{select.replaceChildren(new Option('Myself',''),...friends.map(f=>new Option(f.label,f.participantId)));select.value=friends.some(f=>f.participantId===recipient)?recipient:'';recipient=select.value;}}
  const until=data.supporter_until?new Date(data.supporter_until):null;
  $('#store-supporter').textContent=until?'★ Supporter star active until '+until.toLocaleDateString()+'. Another pack adds 30 more days.':'Every pack adds 30 days of the ★ supporter star beside your name here and in LiDollQuest.';
  const history=$('#store-history');history.replaceChildren();
  for(const row of data.purchases.slice(0,10)){const pack=data.catalog.find(p=>p.sku===row.sku),gift=row.received?' · gift from '+friendLabel(row.from):row.recipient?' · gift to '+friendLabel(row.recipient):'';history.append(node('li',new Date(row.created_at).toLocaleDateString()+' · '+(pack?.name??row.sku)+' · '+amountText(row)+gift+' · '+(row.received?'received':row.price_cents?money(row.price_cents,row.currency):'staff grant')+' · '+row.status));}
  if(!data.purchases.length)history.append(node('li','No purchases yet.'));
  $('#store-paypal').hidden=!sku||busy;
}
function successDialog(){ // One <dialog> built on demand so both the Stickers card and the standalone page share it without duplicating markup.
  let dialog=$('#store-success');
  if(dialog)return dialog;
  dialog=node('dialog',undefined,'store-success');dialog.id='store-success';dialog.setAttribute('aria-labelledby','store-success-title');
  const card=node('div',undefined,'store-success-card');
  card.append(node('p','✨💎✨','store-success-sparkle'),node('h2','Thank you!','store-success-title'),node('p','','store-success-diamonds'),node('p','','store-success-balance'),node('p','','store-success-star'));
  card.querySelector('h2').id='store-success-title';
  const close=node('button','Back to the wallet','button primary');close.type='button';close.autofocus=true;close.addEventListener('click',()=>dialog.close());
  card.append(close);dialog.append(card);
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();}); // A click on the dim backdrop closes it, like the market dialog.
  document.body.append(dialog);return dialog;
}
function celebrate(receipt){ // The successful-purchase modal: what arrived, the new balance and how long the star lasts.
  const dialog=successDialog(),pack=data?.catalog.find(p=>p.sku===receipt.sku);
  dialog.querySelector('.store-success-sparkle').textContent=receipt.asset==='coins'?'✨🪙✨':'✨💎✨';
  if(receipt.recipient){ // A gift: the coins went to the friend, the star went to both.
    dialog.querySelector('.store-success-sparkle').textContent='🎁✨🪙';
    dialog.querySelector('.store-success-diamonds').textContent=(pack?pack.name+': ':'')+amountText(receipt)+' were sent to '+friendLabel(receipt.recipient)+'.';
    dialog.querySelector('.store-success-balance').textContent='Your own wallet is unchanged.';
    dialog.querySelector('.store-success-star').textContent='★ You both wear the supporter star'+(receipt.supporter_until?' (yours until '+new Date(receipt.supporter_until).toLocaleDateString()+')':'')+'.';
  } else {
    dialog.querySelector('.store-success-diamonds').textContent=(pack?pack.name+': ':'')+amountText(receipt)+' have been added to your wallet.';
    dialog.querySelector('.store-success-balance').textContent='You now have '+receipt.balance.toLocaleString()+' '+(ASSET_LABEL[receipt.asset]??receipt.asset)+'.';
    dialog.querySelector('.store-success-star').textContent=receipt.supporter_until?'★ Your supporter star shines until '+new Date(receipt.supporter_until).toLocaleDateString()+'.':'';
  }
  if(!dialog.open)dialog.showModal();
}
function loadSdk(){ // Load PayPal's buttons script once, from the host matching the server's environment, with the catalogue currency.
  if(sdk)return sdk;
  sdk=new Promise((resolve,reject)=>{
    const host=data.environment==='live'?'https://www.paypal.com':'https://www.sandbox.paypal.com';
    const script=document.createElement('script');script.src=host+'/sdk/js?'+new URLSearchParams({'client-id':data.client_id,currency:data.currency,intent:'capture',components:'buttons','disable-funding':'paylater,venmo'});
    script.async=true;script.addEventListener('load',()=>window.paypal?resolve(window.paypal):reject(new Error('PayPal did not load.')));script.addEventListener('error',()=>reject(new Error('PayPal could not be loaded. Check your connection or content blockers.')));
    document.head.append(script);
  }).catch(error=>{sdk=null;throw error;});
  return sdk;
}
async function mountButtons(){ // Render the Smart Buttons once; createOrder and onApprove talk only to our server, which owns prices and fulfilment.
  if(buttons||!data?.enabled)return;
  const paypal=await loadSdk();
  buttons=paypal.Buttons({
    style:{layout:'vertical',shape:'pill',label:'pay'},
    createOrder:async()=>{if(!sku)throw new Error('Choose a pack first.');busy=true;render();$('#store-paypal').hidden=false;status('Starting your purchase...');try{current=await request('store/order',{sku,requestId,...(recipient?{recipient}:{})});return current.order_id;}catch(error){busy=false;render();status(error.message);throw error;}},
    onApprove:async()=>{status('Payment approved. Adding your diamonds...');try{const receipt=await request('store/capture',{id:current.id});status(receipt.recipient?'Gift sent! '+amountText(receipt)+' to '+friendLabel(receipt.recipient)+'.':'Thank you! '+amountText(receipt)+' added.');window.dispatchEvent(new CustomEvent('little-log-store-purchased',{detail:receipt}));celebrate(receipt);}catch(error){status(error.message+' If you were charged, the purchase completes automatically within a few minutes; contact support if it does not.');}finally{busy=false;choose('');await refresh();}},
    onCancel:()=>{busy=false;choose(sku);status('Purchase cancelled. Nothing was charged.');},
    onError:error=>{busy=false;render();status(error?.message||'PayPal reported a problem. Nothing was charged unless you see a receipt from PayPal.');},
  });
  await buttons.render('#store-paypal');
}
async function refresh(){ // Load the catalogue and this account's purchases; the card stays hidden for signed-out visitors and disabled stores.
  if(loading)return;loading=true;const version=++epoch;
  try{
    const result=await request('store');if(version!==epoch)return;
    data=result;csrf=result.csrf;owner=result.participant.id;
    signedOut(false);
    if(data.enabled){render();status(data.environment==='sandbox'?'Sandbox mode: test payments only.':'');await mountButtons();}
  }catch(error){
    if(version!==epoch)return;
    if(error.status===401||error.status===403){data=null;csrf='';owner='';signedOut(true);return;}
    $('#store-card').hidden=false;status(error.message);
  }finally{if(version===epoch)loading=false;}
}
window.addEventListener('hashchange',()=>{if(visible())void refresh();});
window.addEventListener('little-log-economy-status',event=>{if(visible()&&event.detail?.connected&&!data)void refresh();}); // The wallet loaded first: fetch the store as soon as the account is known.
if(standalone){window.addEventListener('focus',()=>{if(!busy&&!owner)void refresh();});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!busy&&!owner)void refresh();});} // Sign-in opens in a new tab; coming back re-checks the session.
if(visible())void refresh();
