export function createNotificationComposer({request,authorized}) { // Keeps drafts and private delivery history only in memory, with explicit audience selection.
 const $=id=>document.getElementById('push-'+id);
 let current=null,busy=false,requestId=null,epoch=0,loadError='';
 function audience(){return current?.recipients.filter(user=>!$('recipient').value||user.id===$('recipient').value)??[];}
 function unavailable() { // Explain every disabled state next to Send, including the steps needed on a receiving device.
  if(!authorized())return 'Sign in with an administrator account to send notifications.';
  if(busy)return 'Checking notification availability...';
  if(loadError)return 'Could not check notification availability. '+loadError+' Press Refresh delivery status to try again.';
  if(!current)return 'Refresh delivery status to load the audience.';
  if(!audience().length)return $('recipient').value
   ? 'This member can no longer receive notifications; their account may have been disabled. Choose another recipient.'
   : 'No enabled members can receive notifications yet. Press Refresh delivery status once an account exists.';
  if(!$('heading').value.trim())return 'Enter a notification title to enable Send notification.';
  if(!$('body').value.trim())return 'Write a message to enable Send notification.';
  return '';
 }
 function controls(){
  const members=audience(),devices=members.reduce((sum,user)=>sum+user.subscriptions,0),push=current?.configured&&devices;
  $('audience').textContent=members.length+' member'+(members.length===1?'':'s')+' in-app / '+devices+' device'+(devices===1?'':'s')+' with push'; // Two separate reaches: everyone gets the in-app copy, only opted-in devices also get a push.
  for(const id of ['recipient','heading','body','reload'])$(id).disabled=busy||!authorized();
  document.querySelectorAll('#push-history button').forEach(button=>button.disabled=busy||!authorized());
  const reason=unavailable();$('send').disabled=Boolean(reason);
  $('readiness').textContent=reason||(push?'Ready to send. Everyone in the audience sees this on their Notifications page; '+devices+' device'+(devices===1?'':'s')+' also get a push notification.'
   :current?.configured?'Ready to send. Everyone in the audience sees this on their Notifications page. No devices have opted into push, so no lock-screen alerts go out.'
   :'Ready to send in-app only. Web Push is not configured on this server, so nobody receives a lock-screen alert. Set PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT in the tracker service environment and restart to enable push.'); // Keep readiness separate from delivery results so refresh cannot hide either.
 }
 function preview(){ $('preview-title').textContent=$('heading').value; $('preview-body').textContent=$('body').value||'Your message appears here.'; controls(); }
 function history(){ // Render authored text literally and label delivery counts without claiming that a member read the message.
  const table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr');
  for(const title of ['Message','Audience','Queued','Accepted','Failed / uncertain','Skipped / cancelled','Action']){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;row.append(cell);}head.append(row);table.append(head);
  // Push counts below describe devices only; the in-app copy is stored for every member in the audience the moment the message is queued.
  const body=document.createElement('tbody');
  for(const message of current.messages){
   const tr=document.createElement('tr');
   for(const value of [message.title+'\n'+message.body+'\n'+new Date(message.created).toLocaleString(),message.members+' in-app / '+message.devices+' push devices',message.queued,message.accepted,message.failed,message.skipped]){const td=document.createElement('td');td.textContent=value;td.className='wrap';tr.append(td);}
   const cell=document.createElement('td');
   if(message.queued){const button=document.createElement('button');button.type='button';button.className='button small secondary';button.textContent='Cancel queued';button.disabled=busy;button.addEventListener('click',async()=>{if(busy)return;busy=true;controls();button.disabled=true;try{const result=await request('notifications/cancel',{id:message.id});$('status').textContent='Cancelled '+result.cancelled+' queued device deliver'+(result.cancelled===1?'y':'ies')+' and removed '+result.retracted+' unread in-app cop'+(result.retracted===1?'y':'ies')+'. Copies already read stay in members’ history.';await fetchLatest();}catch(error){$('status').textContent=error.message;}finally{busy=false;controls();if(current)history();}});cell.append(button);}
   tr.append(cell);body.append(tr);
  }
  table.append(body);$('history').replaceChildren(table);
  if(!current.messages.length)$('history').textContent='No notifications sent yet.';
 }
 async function fetchLatest(){
  const version=epoch,result=await request('notifications');if(version!==epoch||!authorized())return;
  const previous=$('recipient').value;current=result;loadError='';
  $('recipient').replaceChildren(new Option('Everyone',''),...result.recipients.map(user=>new Option(user.label+' / '+user.id.slice(0,8)+(user.subscriptions?' · '+user.subscriptions+' push device'+(user.subscriptions===1?'':'s'):' · in-app only'),user.id))); // Label each member with how the message will actually reach them.
  if(previous&&!result.recipients.some(user=>user.id===previous))$('recipient').append(new Option('Selected member can no longer receive notifications',previous)); // An unavailable individual must never silently become an everyone broadcast.
  $('recipient').value=previous;history();controls();
 }
 async function load(){if(busy||!authorized())return;busy=true;controls();try{const wasFailed=Boolean(loadError);await fetchLatest();if(wasFailed)$('status').textContent='';}catch(error){loadError=error.message;current=null;$('status').textContent=error.message;}finally{busy=false;controls();}}
 for(const id of ['heading','body','recipient'])$(id).addEventListener('input',()=>{requestId=null;preview();});
 $('reload').addEventListener('click',()=>void load());
 $('form').addEventListener('submit',async event=>{
  event.preventDefault();if($('send').disabled)return;busy=true;controls();
  requestId??=crypto.randomUUID();const version=epoch;
  try{
   const result=await request('notifications',{requestId,title:$('heading').value,body:$('body').value,participantId:$('recipient').value});
   if(version!==epoch)return;
   $('status').textContent=result.repeated?'This message was already queued; it was not sent twice.':'Sent. It is already on every recipient’s Notifications page; push delivery to opted-in devices starts within a minute and quiet hours may delay it.';
   $('body').value='';requestId=null;preview();await fetchLatest();
  }catch(error){$('status').textContent=error.message+' You can retry the same message safely.';}
  finally{busy=false;controls();}
 });
 const refreshVisible=()=>{if(location.hash==='#notifications'&&!document.hidden)void load();};
 setInterval(refreshVisible,15000);document.addEventListener('visibilitychange',refreshVisible);
 return {load,clear(){epoch++;current=null;requestId=null;loadError='';$('readiness').textContent='';$('body').value='';$('heading').value='Little Log';$('history').replaceChildren();$('recipient').replaceChildren(new Option('Everyone',''));$('status').textContent='';preview();$('send').disabled=true;}};
}
