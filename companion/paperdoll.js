let catalogPromise;
const images=new Map();
const catalog=()=>catalogPromise??=fetch('./art.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Character artwork is unavailable.');return r.json();}).catch(e=>{catalogPromise=null;throw e;});
function picture(art,name){
 const entry=art.sprites[name];if(!entry)return Promise.resolve(null);
 if(!images.has(name))images.set(name,new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>{images.delete(name);reject(Error('Character artwork could not load.'));};image.src='./'+entry.src;}));
 return images.get(name);
} // Only the exported art manifest supplies image URLs, never character-controlled strings.
export async function drawCharacter(sheet,dollHost,tushHost){
 const doll=document.createElement('canvas'),tush=document.createElement('canvas');
 doll.width=387;doll.height=875;doll.setAttribute('role','img');doll.setAttribute('aria-label',sheet.name+' wearing the equipment listed below');
 tush.width=360;tush.height=270;tush.setAttribute('role','img');tush.setAttribute('aria-label',sheet.tush.name+': '+sheet.tush.status);
 dollHost.replaceChildren(doll);tushHost.replaceChildren(tush);
 try{
  const art=await catalog(),p=sheet.player_info,has=name=>Object.hasOwn(art.sprites,name),layers=['TQ_Base_3'];
  const hair='sprTQ_Hair_'+p.hair_style+'_'+p.hair_color;
  if(p.hair_style===4)layers.push(hair+'_Back');
  if(p.has_breasts)layers.push('sprTQ_Breasts_1');
  if(p.nipple_style>0)layers.push('sprTQ_Nipples_'+p.nipple_style);
  if(!p.equipped_panties){if(p.pubes_style>0)layers.push('sprTQ_Pubes_'+p.pubes_style);if(p.penis_style>0)layers.push('sprTQ_Penis_'+p.penis_style);}
  const expression=String(p.face_expression||'cheeky'),face='sprTQ_Face_'+expression[0].toUpperCase()+expression.slice(1)+p.gender+'_'+p.inspection_embarrassment;
  layers.push(has(face)?face:'sprTQ_Face_CheekyFemale_0');
  for(const slot of ['socks','panties','diaper_cover','bra','pants','shoes','torso','gloves','special','accessory_1','accessory_2','accessory_3','mouth','weapon','plug']){
   let id=p['equipped_'+slot];if(!id||(slot==='pants'&&id===p.equipped_torso))continue;
   if(slot==='panties'){
    id=({diaper_hugger_diaper:'blessed_pottypants_diaper',diaper_school_issued:'thick_medical_diaper'})[id]??id;
    if(art.items[id]?.is_diaper){const variant=id.replace(/_[123]$/,'')+(p.diaper_tum_absorbed>0?'_3':p.diaper_wet_absorbed>0?'_2':'_1');if(has('sprTQ_'+variant))id=variant;}
   }
   layers.push('sprTQ_'+id);
  }
  layers.push(hair);if(p.hair_style===4)layers.push(hair+'_Front');if(p.equipped_head)layers.push('sprTQ_'+p.equipped_head);
  const state=p.diaper_tum_absorbed>=3?3:p.diaper_tum_absorbed>=1?2:1;
  let rear='sprTQ_'+p.equipped_panties+'_ButtCam_'+state;
  if(!has(rear))rear=sheet.tush.is_diaper?'sprTQ_dq_clothing_large_diaper1_ButtCam_'+state:'sprTQ_Base_ButtCam_'+(state===1?'1a':'2');
  const loaded=await Promise.all(layers.map(name=>picture(art,name))),back=await picture(art,rear);
  if(!doll.isConnected)return; // A slower previous character cannot paint over the currently selected one.
  const ctx=doll.getContext('2d');for(let i=0;i<loaded.length;i++)if(loaded[i]){ctx.globalAlpha=p.equipped_plug&&layers[i]==='sprTQ_'+p.equipped_plug?0.7:1;ctx.drawImage(loaded[i],0,0,doll.width,doll.height);}ctx.globalAlpha=1;
  if(back){const ctx=tush.getContext('2d'),crop=Math.min(back.height,back.width*tush.height/tush.width);ctx.drawImage(back,0,0,back.width,crop,0,0,tush.width,tush.height);}
  doll.dataset.ready='true';tush.dataset.ready=back?'true':'false';
 }catch(error){if(doll.isConnected){const message=document.createElement('p');message.textContent=error.message;dollHost.replaceChildren(message);tushHost.replaceChildren();}}
} // Reuse the game's authored body, appearance, clothing and accident-state artwork as layered browser previews.
