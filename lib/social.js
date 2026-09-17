import {createPostGallery,clearPostGalleries} from './post-gallery.js';
import {createAvatar,createIdentity} from './avatar.js';
import {preparePicture,compactPictures} from './picture-upload.js';
const $=selector=>document.querySelector(selector),el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
let account=null,epoch=0,feedBusy=false,chatBusy=false,posting=false,sending=false,preparing=false,pictures=[],postRetry=null,messageRetry=null,peer='',feedBefore=null,feedNext=null,messageBefore=null,messageNext=null;
const stamp=value=>new Date(value).toLocaleString();
const route=()=>location.hash.split('?')[0]==='#social'?'#feed':location.hash.split('?')[0];
let composeBusy=false,memberBusy=false,memberBefore=null,memberNext=null;
let activityBusy=false,activityBefore=null,activityNext=null,activityLatest=null;
const mobileSocial=matchMedia('(max-width:680px)'),messageDrafts=new Map();
let conversationCache=[],threadOpen=false,archiveBusy=false,messagePicker=null; // messagePicker is created once the message form is wired up.
function messageLayout(){
 $('#page-messages').dataset.thread=String(Boolean(peer&&threadOpen));
 const current=conversationCache.find(c=>c.friend.id===peer);
 $('#message-peer').replaceChildren(...(current?[createIdentity(current.friend)]:[]));
 $('#message-archive').textContent=current?.archived?'Restore':'Archive';
 $('#message-archive').disabled=!current?.latest||chatBusy||sending||archiveBusy;
} // Mobile opens one pane at a time; desktop continues showing both existing sections.
const previewText=message=>message.body||(message.sticker?'🎁 Sent a sticker: '+message.sticker.name:''); // Sticker-only messages still get a readable preview.
function stickerImage(sticker){ // Show a gifted sticker; retired assets fall back to a labelled gift.
 const figure=el('figure',undefined,'social-sticker');
 if(sticker.url){const img=el('img');img.src=sticker.url;img.alt=sticker.name;img.loading='lazy';img.width=120;img.height=90;figure.append(img);}
 figure.append(el('figcaption','🎁 '+sticker.name));return figure;
}
function stickerPicker(onChange){ // "Add sticker" control shared by comment boxes and the message form; the chosen sticker is a gift to the recipient.
 const root=el('div',undefined,'sticker-picker'),toggle=linkButton('🎁 Add sticker',()=>void open()),grid=el('div',undefined,'sticker-choices'),chosen=el('div',undefined,'sticker-chosen');
 grid.hidden=true;chosen.hidden=true;root.append(toggle,chosen,grid);let selected=null;
 async function open(){ // Load the current inventory each time so counts stay accurate after gifts and trades.
  if(!grid.hidden){grid.hidden=true;return;}
  grid.replaceChildren(el('p','Loading your stickers...','field-help'));grid.hidden=false;
  try{const {stickers}=await request('stickers');grid.replaceChildren();
   if(!stickers.length)grid.append(el('p','You have no stickers to give yet. Log records to earn some!','field-help'));
   for(const sticker of stickers){const choice=el('button',undefined,'sticker-choice');choice.type='button';choice.setAttribute('aria-label','Send '+sticker.name+' ('+sticker.quantity+' available)');choice.append(stickerImage(sticker),el('small','×'+sticker.quantity));choice.addEventListener('click',()=>set(sticker));grid.append(choice);}
  }catch(error){grid.replaceChildren(el('p',error.message,'field-help'));}
 }
 function set(sticker,silent=false){ // Show the chosen sticker (or clear it) and let the form update its retry and required-text state.
  selected=sticker;grid.hidden=true;toggle.hidden=Boolean(sticker);chosen.hidden=!sticker;
  chosen.replaceChildren(...(sticker?[stickerImage(sticker),el('span','This sticker leaves your collection and goes to them.','field-help'),linkButton('Remove sticker',()=>set(null))]:[]));
  if(!silent)onChange();
 }
 return {root,set,get selected(){return selected;},get value(){return selected?.id??null;},set disabled(value){toggle.disabled=value;for(const n of root.querySelectorAll('button'))n.disabled=value;}};
}
function renderConversations(){
 const list=$('#conversation-list'),query=$('#message-search').value.trim().toLocaleLowerCase(),folder=$('#message-filter').value;list.replaceChildren();
 for(const convo of conversationCache){
  if(mobileSocial.matches&&(!convo.latest||(folder==='inbox'&&convo.archived)||(folder==='unread'&&(convo.archived||!convo.unread))||(folder==='archived'&&!convo.archived)||!`${convo.friend.label} ${convo.latest.deleted?'':previewText(convo.latest)}`.toLocaleLowerCase().includes(query)))continue;
  const row=el('div',undefined,'conversation-row'+(convo.unread?' is-unread':'')+(convo.friend.id===peer?' is-selected':''));row.dataset.peer=convo.friend.id;
  const open=button('Message'+(convo.unread?' · '+convo.unread+' unread':''),()=>choosePeer(convo.friend.id));open.classList.add('conversation-button');
  if(mobileSocial.matches){
   const avatar=el('a',undefined,'social-identity');avatar.href='#profile?id='+encodeURIComponent(convo.friend.id);avatar.setAttribute('aria-label',convo.friend.label+' profile');avatar.append(createAvatar(convo.friend));
   open.replaceChildren(el('strong',convo.friend.label),el('span',convo.latest.deleted?'Message removed':previewText(convo.latest),'conversation-preview'),el('small',stamp(convo.latest.created)+(convo.unread?' · '+convo.unread+' unread':''),'conversation-meta'));row.append(avatar,open);
  }else row.append(createIdentity(convo.friend),open);
  list.append(row);
 }
 $('#inbox-status').textContent=list.children.length?'':query?'No matches.':'No conversations here.';
} // Search and folders filter the fetched inbox locally without fetching or reading a hidden thread.
function buttons(){
 $('#post-refresh').disabled=composeBusy||posting;
 $('#feed-audience').disabled=feedBusy;for(const id of ['feed-older','feed-newest'])$('#'+id).disabled=feedBusy;for(const n of document.querySelectorAll('#status-picture-preview input,#status-picture-preview button'))n.disabled=posting;
 $('#status-post').disabled=composeBusy||posting||preparing||!account||!navigator.onLine;$('#status-pictures').disabled=posting||preparing;$('#status-text').disabled=posting;$('#status-audience').disabled=posting;
 $('#message-send').disabled=sending||archiveBusy||!peer||!account||!navigator.onLine;$('#message-text').disabled=sending;if(messagePicker)messagePicker.disabled=sending||!peer;$('#message-friend').disabled=sending||chatBusy||archiveBusy;$('#message-new').disabled=sending||chatBusy||archiveBusy;
 $('#feed-refresh').disabled=feedBusy;$('#message-refresh').disabled=chatBusy||archiveBusy;$('#feed-older').hidden=feedNext===null;$('#feed-newest').hidden=feedBefore===null;$('#messages-older').hidden=messageNext===null;$('#messages-newest').hidden=messageBefore===null;
 messageLayout();
}
function clearViews(){epoch++;conversationCache=[];memberBusy=false;$('#member-details').replaceChildren();clearPostGalleries($('#member-posts'));$('#member-status').textContent='';memberNext=null;memberControls();$('#activity-list').replaceChildren();$('#activity-status').textContent='';$('#activity-read-all').disabled=true;activityLatest=null;clearPostGalleries($('#status-feed'));$('#conversation-list').replaceChildren();$('#message-list').replaceChildren();$('#message-friend').replaceChildren();feedNext=null;messageNext=null;buttons();} // Private views are never retained in an offline cache.
function reset(){messageDrafts.clear();conversationCache=[];threadOpen=false;$('#message-search').value='';$('#message-filter').value='inbox';$('#page-messages').dataset.compose='false';memberBefore=null;clearViews();$('#status-view-post').hidden=true;$('#status-view-post').href='#feed';$('#post-status').textContent='Sign in to post an update.';account=null;pictures=[];peer='';activityBefore=null;activityNext=null;postRetry=null;messageRetry=null;feedBefore=null;messageBefore=null;$('#status-text').value='';$('#status-audience').value='friends';$('#status-pictures').value='';$('#status-picture-preview').replaceChildren();$('#message-text').value='';messageSticker(null);buttons();}
async function request(path,input,compacted=false){
 const requestEpoch=epoch;
 const response=await fetch('./api/social/'+path,{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(input?.pictures?.length?60000:15000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':account?.csrf??''}:{},...(input?{body:JSON.stringify(input)}:{})});
 if(response.status===413&&path==='posts'&&input?.pictures?.length&&!compacted){await response.body?.cancel();if(requestEpoch!==epoch||!account)throw Error('Please reopen Post before trying again.');$('#status-compose-status').textContent='Resizing pictures to fit the server...';const smaller=await compactPictures(input.pictures);if(requestEpoch!==epoch||!account)throw Error('Please reopen Post before trying again.');input.pictures=smaller;return request(path,input,true);} // Keep the compact payload for retries if the response is lost after saving; never retry across account or page changes.
 let value;try{value=await response.json();}catch{throw Error(response.status===413?'The server rejected the upload size even after resizing. Please try again later.':'The server could not complete this request. Please retry.');}
 if(!response.ok){if(requestEpoch===epoch){if(response.status===401)window.dispatchEvent(new Event('little-log-social-denied'));else if(response.status===403)reset();}throw Error(value.error||'Could not load this page.');}
 if(value.participant){if(account&&account.participant.id!==value.participant.id){reset();throw Error('Your account changed. Refresh before posting or messaging.');}account={...account,participant:value.participant,...(value.csrf?{csrf:value.csrf}:{})};}return value;
} // Every read uses the current session; mutation retries reuse their request ID and original content.
function button(label,handler){const n=el('button',label,'button small secondary');n.type='button';n.addEventListener('click',handler);return n;}
function renderPictures(){
 const container=$('#status-picture-preview');container.replaceChildren();
 pictures.forEach((picture,index)=>{const card=el('div',undefined,'status-picture-preview'),img=el('img');img.src='data:image/jpeg;base64,'+picture.data;img.alt='Selected picture '+(index+1);
  const label=el('label','Picture description (optional)'),input=el('input');input.maxLength=200;input.value=picture.alt;input.addEventListener('input',()=>{picture.alt=input.value;postRetry=null;});label.append(input);
  card.append(img,label,button('Remove picture',()=>{pictures.splice(index,1);postRetry=null;renderPictures();}));container.append(card);
 });
}
$('#status-pictures').addEventListener('change',async()=>{
 if(preparing||posting)return;const files=[...$('#status-pictures').files];$('#status-pictures').value='';if(pictures.length+files.length>4){$('#status-compose-status').textContent='Choose up to four pictures per update.';return;}
 preparing=true;buttons();const ticket=epoch;$('#status-compose-status').textContent='Resizing pictures...';
 try{const ready=[];for(const file of files)ready.push(await preparePicture(file));if(ticket!==epoch)return;pictures.push(...ready);postRetry=null;renderPictures();$('#status-compose-status').textContent='Pictures ready. Review the audience before posting.';}
 catch(error){$('#status-compose-status').textContent=error.message;}finally{preparing=false;buttons();}
});
async function loadComposer(){if(composeBusy||posting||!navigator.onLine)return;composeBusy=true;buttons();const ticket=epoch;
 try{await request('session');if(ticket===epoch)$('#post-status').textContent='Ready to post.';}
 catch(error){if(ticket===epoch||route()==='#post')$('#post-status').textContent=error.message;}finally{composeBusy=false;buttons();}
} // Initialize posting independently; switching social tabs keeps the unsent text, audience and prepared pictures in memory.
$('#post-refresh').addEventListener('click',()=>void loadComposer());
for(const id of ['status-text','status-audience'])$('#'+id).addEventListener('input',()=>{postRetry=null;});
$('#status-form').addEventListener('submit',async event=>{
 event.preventDefault();if(posting||preparing||!account)return;posting=true;buttons();const ticket=epoch;
 try{postRetry??={requestId:crypto.randomUUID(),body:$('#status-text').value,audience:$('#status-audience').value,pictures:pictures.map(p=>({...p}))};const result=await request('posts',postRetry);if(ticket!==epoch)return;
  $('#status-compose-status').textContent=result.deleted?'This post was already deleted.':'Status posted to '+(postRetry.audience==='public'?'Public':'Friends')+'.';$('#status-view-post').hidden=Boolean(result.deleted);$('#status-view-post').href='#feed?post='+encodeURIComponent(result.id);$('#status-text').value='';pictures=[];postRetry=null;renderPictures();feedBefore=null;
 }catch(error){$('#status-compose-status').textContent=error.message;return;}finally{posting=false;buttons();}
});
function renderPosts(posts,container,{detail=false,refresh=loadFeed,status=$('#feed-status')}={}){
  for(const post of posts){const card=el('article',undefined,'status-card'+(post.record?' record-post':'')),header=el('div',undefined,'card-heading'),side=el('div',undefined,'post-meta-side'),postStatus=el('p','','field-help');postStatus.setAttribute('role','status');
   const pills=el('div',undefined,'post-pills');if(post.author.fullTime){const badge=el('span','24/7','badge-247');badge.title=post.author.label+' wears protection 24/7';pills.append(badge);} // Author's 24/7 badge, left of the audience pill.
   pills.append(el('span',post.audience==='public'?'Public':'Friends','pill'));side.append(pills,postMenu(post,{refresh,status,postStatus})); // Report/Delete live in the dropdown under the audience pill.
   if(post.record){card.dataset.recordKind=post.record.kind;header.append(recordLine(post),side);const meta=el('p','Auto-logged · ','field-help record-meta');meta.append(when(post.created));card.append(header,meta);} // Automatic logs: one activity sentence instead of a status body.
   else {header.append(createIdentity(post.author,'h3'),side);const posted=el('p',undefined,'field-help');posted.append(when(post.created));card.append(header,posted);}
   const copy=el('p',post.body,'social-body');if(!post.record)card.append(copy);if(!post.record&&(post.body.length>400||post.body.split('\n').length>5)){copy.classList.add('post-copy-collapsed');const more=button('More',()=>{const collapsed=copy.classList.toggle('post-copy-collapsed');more.textContent=collapsed?'More':'Less';more.setAttribute('aria-expanded',String(!collapsed));});more.classList.add('social-mobile-only');more.setAttribute('aria-expanded','false');card.append(more);}
   if(post.pictures.length)card.append(createPostGallery(post));
   card.append(postActions(post,postStatus));if(detail)card.append(button('Back to feed',()=>{location.hash='#feed';}));container.append(card);
  }
}
const wettingText={forced:'was made to use their diaper!','semi-forced':'was nudged into using their diaper!',voluntary:'used their diaper!','semi-involuntary':'almost held it... and used their diaper!',involuntary:'had an accident in their diaper!',bedwetting:'wet the bed!','used-the-potty':'used the potty :('}; // One playful phrase per wetting category.
function recordText(record){
 if(record.kind==='observation')return {icon:'\u{1F964}',text:'drank '+record.liquidsMl+' mL of water'}; // cup with straw
 if(record.kind==='diaper-change'){const n=record.wettingsCount;return {icon:'\u{1F9F7}',text:'changed their diaper'+(Number.isInteger(n)&&n>0?' after '+n+' wetting'+(n===1?'':'s'):'')};} // safety pin
 return {icon:record.category==='used-the-potty'?'\u{1F6BD}':'\u{1F4A7}',text:wettingText[record.category]??'logged a wetting'}; // toilet for potty visits, droplet otherwise
} // Turns an automatic record into "<name> <what happened>" wording.
function recordLine(post){
 const {icon,text}=recordText(post.record),box=el('div',undefined,'record-summary'),line=el('p',undefined,'record-line'),badge=el('span',icon,'record-icon'),sentence=el('span',undefined,'record-sentence'),name=el('a',post.author.label,'record-name');
 badge.setAttribute('aria-hidden','true');name.href='#profile?id='+encodeURIComponent(post.author.id); // Name still opens the member's profile.
 sentence.append(name,' '+text);line.append(badge,createAvatar(post.author),sentence);box.append(line); // Name + action wrap together as one sentence.
 const at=new Date(post.record.occurredAt);if(!Number.isNaN(at.getTime()))box.append(el('p','Recorded '+at.toLocaleString([],{dateStyle:'medium',timeStyle:'short'}),'record-when')); // Recorded time can differ from posting time (offline/backdated logs).
 return box;
}
const relative=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
function when(value){
 const seconds=Math.round((value-Date.now())/1000),time=el('time',undefined,'social-time');time.dateTime=new Date(value).toISOString();time.title=stamp(value); // Hover shows the exact date and time.
 const unit=[['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]].find(([,size])=>Math.abs(seconds)>=size); // Largest unit that fits.
 time.textContent=unit?relative.format(Math.round(seconds/unit[1]),unit[0]):'just now';return time;
} // Relative "3 hours ago" style timestamps.
function linkButton(label,handler,className=''){const n=el('button',label,('link-action '+className).trim());n.type='button';n.addEventListener('click',handler);return n;} // Compact text-link actions (Like · Reply · Report).
function postMenu(post,{refresh,status,postStatus}){
 const menu=el('details',undefined,'post-menu'),summary=el('summary','Options'),list=el('div',undefined,'post-menu-list');summary.setAttribute('aria-label','Post options');list.setAttribute('role','menu');
 const item=(label,handler,danger=false)=>{const n=el('button',label,'post-menu-item'+(danger?' is-danger':''));n.type='button';n.setAttribute('role','menuitem');n.addEventListener('click',()=>{menu.open=false;handler();});return n;}; // Choosing an item closes the menu first.
 if(post.author.id===account.participant.id)list.append(item('Delete post',async()=>{if(!confirm('Delete this status and its pictures?'))return;try{await request('posts/delete',{id:post.id});await refresh();}catch(error){status.textContent=error.message;}},true)); // Only the author can delete.
 else list.append(item('Report post',()=>reportContent('post',post.id,postStatus))); // Everyone else can report.
 menu.append(summary,list);return menu;
}
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.post-menu[open]'))if(!menu.contains(event.target))menu.open=false;}); // Clicking elsewhere closes open post menus.
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;for(const menu of document.querySelectorAll('.post-menu[open]')){menu.open=false;menu.querySelector('summary').focus();}}); // Escape closes and returns focus.
async function loadFeed(){
 if(feedBusy||!navigator.onLine)return;feedBusy=true;buttons();const ticket=epoch;$('#feed-status').textContent='Loading updates…';
 try{const postId=new URLSearchParams(location.hash.split('?')[1]??'').get('post');const value=await request(postId?'post?id='+encodeURIComponent(postId):'feed?audience='+$('#feed-audience').value+(feedBefore?'&before='+feedBefore:''));if(ticket!==epoch)return;
  const container=$('#status-feed');clearPostGalleries(container);feedNext=value.nextBefore;
  renderPosts(value.items,container,{detail:Boolean(postId)});
  $('#feed-status').textContent=value.items.length?(mobileSocial.matches?'':'Updates are visible to the audience shown on each post.'):'No updates yet. Share a little of your day.';
 }catch(error){clearPostGalleries($('#status-feed'));$('#feed-status').textContent=error.message;}finally{feedBusy=false;buttons();}
}
async function loadChat(){
 if(chatBusy||sending||archiveBusy||!navigator.onLine)return;chatBusy=true;buttons();const ticket=epoch;
 try{const data=await request('conversations');if(ticket!==epoch)return;
  conversationCache=data.conversations;const select=$('#message-friend');select.replaceChildren(new Option('Choose a friend',''));$('#conversation-list').replaceChildren();
  for(const convo of data.conversations)select.append(new Option(convo.friend.label+(convo.unread?' ('+convo.unread+' unread)':''),convo.friend.id));
  if(!data.conversations.some(c=>c.friend.id===peer)){peer='';$('#message-text').value='';messageRetry=null;}select.value=peer;renderConversations();messageLayout();
  if(mobileSocial.matches&&(!peer||!threadOpen))return;
  if(!peer){$('#message-list').replaceChildren();$('#message-status').textContent=data.conversations.length?'Choose a friend to open your conversation.':'Accept a friend request before messaging.';return;}
  const value=await request('messages?participantId='+encodeURIComponent(peer)+(messageBefore?'&before='+messageBefore:''));if(ticket!==epoch)return;
  messageNext=value.nextBefore;const list=$('#message-list'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60,scroll=list.scrollTop;list.replaceChildren();
  const currentConversation=data.conversations.find(c=>c.friend.id===peer);
  for(const message of value.items){const own=message.sender===account.participant.id,card=el('article',undefined,'message-bubble'+(own?' message-own':''));card.append(createIdentity(own?account.participant:currentConversation.friend,'strong',own?'You':currentConversation.friend.label));if(message.deleted||message.body)card.append(el('p',message.deleted?'Message removed':message.body,'social-body'));if(message.sticker)card.append(stickerImage(message.sticker));card.append(el('small',stamp(message.created))); // Sticker-only messages skip the empty text line.
   if(!own&&!message.deleted)card.append(button('Report message',()=>reportContent('message',message.id,$('#message-status'))));
   if(own&&!message.deleted)card.append(button('Remove message',async()=>{try{await request('messages/delete',{id:message.id});await loadChat();}catch(error){$('#message-status').textContent=error.message;}}));list.append(card);
  }
  list.scrollTop=messageBefore?0:atBottom?list.scrollHeight:scroll;
  $('#message-status').textContent=value.items.length?(mobileSocial.matches?'':'Private between you and this friend. Administrators can review messages that either of you reports.'):'Say hello to your friend.';
  if(value.items.length&&!document.hidden&&(!mobileSocial.matches||threadOpen)){
   await request('messages/read',{participantId:peer,seq:value.items.at(-1).seq});window.dispatchEvent(new Event('little-log-messages-updated'));if(ticket!==epoch)return;
   if(value.items.at(-1).seq>=(currentConversation.latest?.seq??0)){ // Clear the visible unread labels only when this page reaches the latest known message.
    select.selectedOptions[0].textContent=currentConversation.friend.label;
    currentConversation.unread=0;renderConversations();
   }
  }
 }catch(error){$('#message-list').replaceChildren();$('#message-status').textContent=error.message;$('#inbox-status').textContent=error.message;}finally{chatBusy=false;buttons();}
} // Poll only the visible conversation; CSRF-protected read markers never advance beyond messages actually loaded.
function choosePeer(id,load=true){if(sending||chatBusy||archiveBusy)return;if(peer!==id){if(peer)messageDrafts.set(peer,{body:$('#message-text').value,retry:messageRetry,sticker:messagePicker?.selected??null});peer=id;messageBefore=null;const draft=messageDrafts.get(id);messageSticker(draft?.sticker??null);messageRetry=draft?.retry??null;$('#message-text').value=draft?.body??'';$('#message-list').replaceChildren();}threadOpen=Boolean(id);$('#page-messages').dataset.compose='false';messageLayout();if(load)void loadChat();} // Keep each unsent reply in memory while switching conversations.
$('#message-back').addEventListener('click',()=>{threadOpen=false;messageLayout();renderConversations();$('#message-new').focus();});
$('#message-new').addEventListener('click',()=>{$('#page-messages').dataset.compose='true';$('#message-friend').focus();});
$('#message-search').addEventListener('input',renderConversations);$('#message-filter').addEventListener('change',renderConversations);
$('#message-archive').addEventListener('click',async()=>{
 const current=conversationCache.find(c=>c.friend.id===peer);if(!current||archiveBusy||chatBusy||sending)return;archiveBusy=true;buttons();const ticket=epoch;
 try{await request('messages/archive',{participantId:peer,archived:!current.archived});if(ticket!==epoch)return;threadOpen=false;messageLayout();}
 catch(error){$('#message-status').textContent=error.message;}finally{archiveBusy=false;buttons();}await loadChat();
}); // Archiving changes only this account's inbox; new messages bring the conversation back.
mobileSocial.addEventListener('change',()=>{renderConversations();messageLayout();if(route()==='#messages')void loadChat();});
$('#message-text').addEventListener('keydown',event=>{if(mobileSocial.matches&&event.ctrlKey&&event.key==='Enter'&&!$('#message-send').disabled){event.preventDefault();$('#message-form').requestSubmit();}});
$('#message-friend').addEventListener('change',()=>choosePeer($('#message-friend').value));
$('#message-text').addEventListener('input',()=>{messageRetry=null;});
messagePicker=stickerPicker(()=>{messageRetry=null;messageSticker(messagePicker.selected);}); // Changing the sticker starts a fresh request.
function messageSticker(sticker){if(!messagePicker)return;messagePicker.set(sticker,true);$('#message-text').required=!sticker;} // Text is optional once a sticker is attached.
$('#message-send').before(messagePicker.root);
$('#message-form').addEventListener('submit',async event=>{
 event.preventDefault();if(sending||!peer||!account)return;sending=true;buttons();const ticket=epoch;
 try{messageRetry??={requestId:crypto.randomUUID(),participantId:peer,body:$('#message-text').value,...(messagePicker.value?{sticker:messagePicker.value}:{})};await request('messages',messageRetry);if(ticket!==epoch)return;if(messageRetry.sticker)window.dispatchEvent(new Event('little-log-rewards-updated'));messageDrafts.delete(peer);messageSticker(null);messageRetry=null;$('#message-text').value='';messageBefore=null;/* A sent sticker refreshes the collection view. */}
 catch(error){$('#message-status').textContent=error.message;return;}finally{sending=false;buttons();}await loadChat();
});
$('#feed-audience').addEventListener('change',()=>{feedBefore=null;if(location.hash.includes('?'))location.hash='#feed';else void loadFeed();});$('#feed-refresh').addEventListener('click',()=>void loadFeed());
$('#feed-older').addEventListener('click',()=>{feedBefore=feedNext;void loadFeed();});$('#feed-newest').addEventListener('click',()=>{feedBefore=null;void loadFeed();});
$('#message-refresh').addEventListener('click',()=>void loadChat());$('#messages-older').addEventListener('click',()=>{messageBefore=messageNext;void loadChat();});$('#messages-newest').addEventListener('click',()=>{messageBefore=null;void loadChat();});
function memberControls(){for(const id of ['member-refresh','member-newest','member-older'])$('#'+id).disabled=memberBusy||!navigator.onLine;$('#member-newest').hidden=memberBefore===null;$('#member-older').hidden=memberNext===null;}
async function loadMember(){
 if(memberBusy||!navigator.onLine||route()!=='#profile')return;memberBusy=true;memberControls();const ticket=epoch;
 const query=new URLSearchParams(location.hash.split('?')[1]??'');if(memberBefore)query.set('before',memberBefore);$('#member-status').textContent='Loading profile...';
 try{const value=await request('member?'+query);if(ticket!==epoch)return;memberNext=value.nextBefore;const member=value.member,details=$('#member-details'),heading=el('div',undefined,'member-heading'),actions=el('div',undefined,'social-actions');heading.append(createAvatar(member),el('h2',member.label));details.replaceChildren(heading);
  if(member.isSelf){const edit=el('a','Edit profile picture','button small secondary');edit.href='#settings';actions.append(edit);}
  else if(member.isFriend)actions.append(button('Message',()=>document.dispatchEvent(new CustomEvent('little-log-message-friend',{detail:member.id}))));
  const friends=el('a',member.isSelf?'Friends & search':member.isFriend?'Manage friendship':'Find friends','button small secondary');friends.href='#friends';actions.append(friends);details.append(actions);
  const posts=$('#member-posts');clearPostGalleries(posts);renderPosts(value.items,posts,{refresh:loadMember,status:$('#member-status')});$('#member-status').textContent=value.items.length?(member.isSelf?'Your posts. Each post shows its audience.':'Posts shared with you.'):member.isSelf?'No posts yet. Share an update from Post.':'No posts shared with you yet.';
 }catch(error){if(ticket===epoch){$('#member-details').replaceChildren();clearPostGalleries($('#member-posts'));$('#member-status').textContent=error.message;}else if(route()==='#profile'&&!account)$('#member-status').textContent=error.message;}
 finally{if(ticket===epoch){memberBusy=false;memberControls();}}
} // Profile paging rechecks the viewer's current friendship and never requests private tracking records.
$('#member-refresh').addEventListener('click',()=>void loadMember());$('#member-older').addEventListener('click',()=>{memberBefore=memberNext;void loadMember();});$('#member-newest').addEventListener('click',()=>{memberBefore=null;void loadMember();});
function visible(){if(route()==='#profile')void loadMember();if(route()==='#post')void loadComposer();if(route()==='#feed')void loadFeed();if(route()==='#messages')void loadChat();if(route()==='#activity')void loadActivity();}
window.addEventListener('hashchange',()=>{memberBefore=null;clearViews();visible();});window.addEventListener('online',visible);
window.addEventListener('offline',()=>{reset();$('#feed-status').textContent='Reconnect to view or post updates.';$('#message-status').textContent='Reconnect to read or send messages.';});
window.addEventListener('little-log-social-locked',reset);window.addEventListener('little-log-social-ready',visible);window.addEventListener('little-log-signout',reset);window.addEventListener('storage',e=>{if((e.key==='lidoll.little-log.v1'||e.key===null)&&!e.newValue)reset();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearViews();else visible();});
document.addEventListener('little-log-message-friend',e=>{choosePeer(e.detail,location.hash==='#messages');if(location.hash!=='#messages')location.hash='#messages';});
setInterval(()=>{if(!document.hidden&&location.hash==='#messages')void loadChat();},10000);
async function reportContent(kind,id,status) {
 const reason=prompt('Why are you reporting this '+kind+'?'+(kind==='message'?' Administrators will be able to review this message.':''));if(!reason?.trim())return;
 try{await request('report',{kind,id,reason});status.textContent='Report sent to the administrators.';}catch(error){status.textContent=error.message;}
} // Reporting is explicit; the server verifies access before allowing a moderator to review a private message.
const likeLabel=(liked,likes)=>(liked?'Liked':'Like')+' · '+likes; // Shared text for post and comment like toggles.
function likeToggle(target,path,input,status){
 const like=linkButton(likeLabel(target.liked,target.likes),async()=>{like.disabled=true;
  try{const result=await request(path,{...input,liked:!target.liked});target.liked=result.liked;target.likes=result.likes;like.textContent=likeLabel(target.liked,target.likes);like.setAttribute('aria-pressed',String(target.liked));}
  catch(error){status.textContent=error.message;}finally{like.disabled=false;}
 },'like-action');like.setAttribute('aria-pressed',String(target.liked));return like;
} // One toggle for posts and comments; the server returns the fresh count so the label never drifts.
function postActions(post,status) {
 const box=el('div'),actions=el('div',undefined,'post-action-bar');
 actions.append(likeToggle(post,'like',{postId:post.id},status)); // Report moved to the Options dropdown.
 const details=el('details',undefined,'social-comments'),summary=el('summary','Comments · '+post.comments),list=el('div',undefined,'comment-thread'),older=button('Older comments',()=>void load(next));
 const top=composer({label:'Write a comment',submitLabel:'Post comment',gifts:post.author.id!==account?.participant.id,onSubmit:body=>send(body,null)}); // Stickers are gifts, so your own post's comment box has no picker.
 older.hidden=true;details.append(summary,list,older,top.form);box.append(actions,status,details);
 let busy=false,next=null,openReply=null;const ticket=epoch;
 const setCount=delta=>{post.comments=Math.max(0,post.comments+delta);summary.textContent='Comments · '+post.comments;}; // Keep the summary count in step with changes.
 function composer({label,submitLabel,onSubmit,onCancel,gifts=false}){
  const form=el('form',undefined,onCancel?'reply-form':''),caption=el('label',label),input=el('textarea'),row=el('div',undefined,'reply-buttons'),submit=el('button',submitLabel,'button primary');
  input.maxLength=2000;input.required=true;input.rows=onCancel?2:3;caption.append(input);submit.type='submit';row.append(submit);
  if(onCancel)row.append(linkButton('Cancel',onCancel));
  let retry=null;input.addEventListener('input',()=>{retry=null;}); // Editing the draft starts a fresh request ID.
  const picker=gifts?stickerPicker(()=>{retry=null;input.required=!picker.value;}):null; // Choosing or removing a sticker also starts a fresh request.
  form.append(caption,...(picker?[picker.root]:[]),row);
  form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;submit.disabled=true;input.disabled=true;if(picker)picker.disabled=true;
   try{retry??={requestId:crypto.randomUUID(),body:input.value,...(picker?.value?{sticker:picker.value}:{})};if(await onSubmit(retry)===false)return;input.value='';picker?.set(null);retry=null;}
   catch(error){status.textContent=error.message;}finally{busy=false;submit.disabled=false;input.disabled=false;if(picker)picker.disabled=false;}
  });
  return {form,input};
 } // Shared by the bottom comment box and every inline reply box.
 async function send(draft,parentId){
  const result=await request('comments',{requestId:draft.requestId,postId:post.id,body:draft.body,...(draft.sticker?{sticker:draft.sticker}:{}),...(parentId?{parentId}:{})});if(ticket!==epoch)return false;
  if(draft.sticker)window.dispatchEvent(new Event('little-log-rewards-updated')); // The sticker left this collection.
  if(!result.repeated)setCount(1);status.textContent=draft.sticker?'Sticker sent!':parentId?'Reply posted.':'Comment posted.';busy=false;await load();return true;
 } // Posting refreshes the current thread page so the new comment appears in place.
 function renderComment(comment,children,depth){
  const card=el('article',undefined,'social-comment'+(comment.removed?' is-removed':''));card.dataset.commentId=comment.id;
  if(comment.removed)card.append(el('p','Comment removed','comment-removed')); // Placeholder keeps replies attached to their thread.
  else {
   const head=el('div',undefined,'comment-head'),controls=el('div',undefined,'comment-actions'),own=comment.author.id===account.participant.id;
   head.append(createIdentity(comment.author),when(comment.created));
   controls.append(likeToggle(comment,'comments/like',{commentId:comment.id},status),linkButton('Reply',()=>startReply(card,comment)));
   if(own)controls.append(linkButton('Delete',async()=>{if(!confirm('Delete this comment?'))return;try{await request('comments/delete',{id:comment.id});setCount(-1);await load();}catch(error){status.textContent=error.message;}},'is-danger')); // Authors only - post owners can't delete others' comments.
   else controls.append(linkButton('Report',()=>reportContent('comment',comment.id,status)));
   card.append(head);if(comment.body)card.append(el('p',comment.body,'social-body'));if(comment.sticker)card.append(stickerImage(comment.sticker));card.append(controls); // Sticker-only comments skip the empty text line.
  }
  const replies=el('div',undefined,'comment-replies');for(const child of children(comment.id))replies.append(renderComment(child,children,depth+1));
  if(replies.childElementCount)card.append(replies);return card;
 } // Replies nest under their parent; CSS stops indenting after a few levels so phones stay readable.
 function startReply(card,comment){
  openReply?.remove();const box=composer({label:'Reply to '+comment.author.label,submitLabel:'Reply',gifts:comment.author.id!==account.participant.id,onSubmit:body=>send(body,comment.id),onCancel:()=>{box.form.remove();openReply=null;}}); // Only one reply box open per post.
  openReply=box.form;card.querySelector(':scope > .comment-actions').after(box.form);box.input.focus();
 }
 async function load(before=null){if(busy)return;busy=true;top.form.querySelector('button').disabled=true;older.disabled=true; // No cursor = newest page of threads.
  try{const value=await request('comments?postId='+encodeURIComponent(post.id)+(before?'&before='+before:''));if(ticket!==epoch)return;list.replaceChildren();openReply=null;next=value.nextBefore;older.hidden=next===null;
   const byParent=new Map();for(const c of value.items){const k=c.parentId??'';byParent.set(k,[...(byParent.get(k)??[]),c]);} // Group replies under their parent comment.
   const live=id=>(byParent.get(id)??[]).some(c=>!c.removed||live(c.id)); // True when a comment has any visible reply below it.
   const children=id=>(byParent.get(id)??[]).filter(c=>!c.removed||live(c.id)); // Drop removed comments that no longer anchor anything.
   for(const root of children(''))list.append(renderComment(root,children,0));
   if(!list.childElementCount)list.append(el('p','No comments yet.','field-help'));
  }catch(error){status.textContent=error.message;list.replaceChildren();}finally{busy=false;top.form.querySelector('button').disabled=false;older.disabled=false;}
 }
 details.addEventListener('toggle',()=>{if(details.open)void load();});
 return box;
} // Comments load on demand; retry IDs are tied to each draft and user text is always rendered literally.
async function loadActivity(){if(activityBusy||!navigator.onLine)return;activityBusy=true;const ticket=epoch;
 for(const id of ['activity-refresh','activity-read-all','activity-older','activity-newest'])$('#'+id).disabled=true;
 try{const value=await request('activity'+(activityBefore?'?before='+activityBefore:''));if(ticket!==epoch)return;activityNext=value.nextBefore;activityLatest=value.latest;const list=$('#activity-list');list.replaceChildren();
  $('#activity-status').textContent=value.unread+' unread notification'+(value.unread===1?'':'s')+(value.items.length?'':'. No activity yet.');
  for(const item of value.items){const card=el('article',undefined,'activity-card'+(item.read?'':' activity-unread'));card.append(el('h3',item.title),el('p',item.body,'social-body'),el('small',stamp(item.created)));const controls=el('div',undefined,'social-actions');
   if(item.messagePeer)controls.append(button('Open conversation',()=>document.dispatchEvent(new CustomEvent('little-log-message-friend',{detail:item.messagePeer}))));
   if(item.postId)controls.append(button('View post',async()=>{try{await request('activity/read',{id:item.id});if(ticket===epoch)location.hash='#feed?post='+encodeURIComponent(item.postId);}catch(error){$('#activity-status').textContent=error.message;}}));
   if(!item.read)controls.append(button('Mark as read',async()=>{try{await request('activity/read',{id:item.id});await loadActivity();}catch(error){$('#activity-status').textContent=error.message;}}));card.append(controls);list.append(card);
  }
 }catch(error){$('#activity-list').replaceChildren();$('#activity-status').textContent=error.message;}finally{activityBusy=false;$('#activity-refresh').disabled=false;$('#activity-read-all').disabled=!activityLatest;$('#activity-older').disabled=false;$('#activity-newest').disabled=false;$('#activity-older').hidden=activityNext===null;$('#activity-newest').hidden=activityBefore===null;}
} // Activity is fetched with the current session and cleared when hidden, offline or signed out.
$('#activity-refresh').addEventListener('click',()=>void loadActivity());$('#activity-older').addEventListener('click',()=>{activityBefore=activityNext;void loadActivity();});$('#activity-newest').addEventListener('click',()=>{activityBefore=null;void loadActivity();});
$('#activity-read-all').addEventListener('click',async()=>{if(activityBusy||!activityLatest)return;try{await request('activity/read',{through:activityLatest});await loadActivity();}catch(error){$('#activity-status').textContent=error.message;}});
setInterval(()=>{if(!document.hidden&&route()==='#activity')void loadActivity();},15000);
buttons();visible();
