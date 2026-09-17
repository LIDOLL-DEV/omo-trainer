const $=name=>document.getElementById('badge-'+name);
let account=null,busy=false,epoch=0;
const visible=()=>location.hash.split('?')[0]==='#settings'&&!document.hidden&&navigator.onLine;
function controls(){const disabled=busy||!account||!visible();for(const name of ['full-time','save'])$(name).disabled=disabled;$('refresh').disabled=busy||!visible();} // The badge can only change after this account's saved choice has loaded.
function clear(){epoch++;account=null;$('full-time').checked=false;$('status').textContent='Sign in to manage your 24/7 badge.';controls();} // Sign-out and account changes never leave another member's badge ticked.
async function request(input){
 const response=await fetch('./api/social/badges',{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:input?{'Content-Type':'application/json','X-CSRF-Token':account?.csrf??''}:{},...(input?{body:JSON.stringify(input)}:{})});
 const value=await response.json();if(!response.ok){if([401,403,409].includes(response.status))clear();throw Error(value.error||'Could not save your badge.');}return value;
} // Authenticated, versioned setting shared across devices and kept out of the offline cache.
const describe=value=>value.fullTime?'Your posts show the 24/7 badge'+(value.since?' (since '+new Date(value.since).toLocaleDateString()+')':'')+'.':'Your posts do not show the 24/7 badge.'; // Status line text.
function apply(value){account=value;$('full-time').checked=value.fullTime;}
async function load(){if(busy||!visible())return;busy=true;controls();const ticket=epoch;
 try{const value=await request();if(ticket!==epoch)return;apply(value);$('status').textContent=describe(value);}
 catch(error){if(visible())$('status').textContent=error.message;}finally{busy=false;controls();}
} // Refresh deliberately reloads the server choice after another device changes it.
$('form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!account||!visible())return;busy=true;controls();const ticket=epoch;
 try{const value=await request({fullTime:$('full-time').checked,version:account.version});if(ticket!==epoch)return;apply(value);$('status').textContent='Saved. '+describe(value);}
 catch(error){if(visible())$('status').textContent=error.message;}finally{busy=false;controls();}
}); // Saving sends the loaded version so a stale device cannot overwrite a newer choice.
$('refresh').addEventListener('click',()=>void load());
window.addEventListener('hashchange',()=>{clear();void load();});window.addEventListener('little-log-signout',clear);window.addEventListener('offline',clear);window.addEventListener('online',()=>void load());
document.addEventListener('visibilitychange',()=>{clear();void load();});window.addEventListener('storage',event=>{if((event.key==='lidoll.little-log.v1'||event.key===null)&&!event.newValue)clear();});
if(visible())void load();else controls();
