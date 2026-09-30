export function createStorePanel({request,authorized}) { // Diamond store oversight: purchase list, manual grants and PayPal refunds through the audited admin session.
  const $=id=>document.getElementById('store-'+id);let epoch=0,busy=false,users=[],catalog=[];
  const label=id=>users.find(u=>u.id===id)?.label??id; // Owner ids resolve to labels client-side from the same response.
  const money=(cents,currency)=>cents?new Intl.NumberFormat(undefined,{style:'currency',currency}).format(cents/100):'grant';
  async function refresh(){ // Rebuild the table and the grant form choices from one authoritative read.
    const version=epoch,value=await request('store');if(version!==epoch||!authorized())return;
    users=value.users;catalog=value.catalog;
    $('owner').replaceChildren(...users.map(u=>new Option(u.label,u.id)));$('sku').replaceChildren(...catalog.map(p=>new Option(p.name+' ('+p.diamonds+' diamonds)',p.sku)));
    const table=document.createElement('table');table.className='admin-table';const head=table.createTHead().insertRow();for(const h of ['When','Member','Pack','Diamonds','Paid','Status','Star until','Note','Refund'])head.append(Object.assign(document.createElement('th'),{textContent:h}));
    const body=table.createTBody();
    for(const row of value.purchases){
      const tr=body.insertRow();
      for(const text of [new Date(row.created_at).toLocaleString(),label(row.owner),row.sku,row.diamonds+(row.clawback_short?' (short '+row.clawback_short+')':''),money(row.price_cents,row.currency),row.status,row.supporter_until?new Date(row.supporter_until).toLocaleDateString():'—',row.note||''])tr.insertCell().textContent=text;
      const cell=tr.insertCell();
      if(row.status==='fulfilled'){const button=document.createElement('button');button.type='button';button.className='button secondary small';button.textContent=row.capture_id?'Refund via PayPal':'Take back grant';button.addEventListener('click',()=>void perform(async()=>{const reason=$('reason').value.trim();if(!reason)throw new Error('Enter a reason first.');await request('store/refund',{id:row.id,reason});$('status').textContent='Refunded '+row.diamonds+' diamonds from '+label(row.owner)+'.';await refresh();}));cell.append(button);} // Refunds reuse the shared reason box so every decision is explained in the audit log.
    }
    $('list').replaceChildren(table);if(!value.purchases.length)$('list').textContent='No purchases yet.';
  }
  async function perform(action){if(busy||!authorized())return;const version=epoch;busy=true;$('grant').disabled=true;try{await action();}catch(error){if(version===epoch)$('status').textContent=error.message;}finally{if(version===epoch){busy=false;$('grant').disabled=false;}}}
  $('form').addEventListener('submit',event=>{event.preventDefault();void perform(async()=>{
    const reason=$('reason').value.trim();if(!reason)throw new Error('Enter a reason first.');
    const value=await request('store/grant',{owner:$('owner').value,sku:$('sku').value,reason});
    $('status').textContent='Granted '+value.diamonds+' diamonds to '+label($('owner').value)+'. Their star lasts until '+new Date(value.supporter_until).toLocaleDateString()+'.';await refresh();
  });});
  $('refresh').addEventListener('click',()=>void perform(refresh));
  return {load:()=>perform(refresh),clear(){epoch++;busy=false;users=[];catalog=[];$('form').reset();for(const id of ['list','status'])$(id).textContent='';$('owner').replaceChildren();$('sku').replaceChildren();}};
}
