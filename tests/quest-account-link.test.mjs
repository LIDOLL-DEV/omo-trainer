import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCoinApiStore,coinApps} from '../server/coin-api-store.mjs';
import {coinApi} from '../server/coin-api.mjs';
import {createServer} from 'node:http';

test('MommyBot resolves only its own game account while wallet IDs remain app-specific',async()=>{
 const db=new DatabaseSync(':memory:');let enabled=true;
 const apps=coinApps(JSON.stringify(['lidollquest','lidollbot','unrelated'].map(id=>({id,name:id,origins:[],dailyLimit:100}))));
 const store=createCoinApiStore(db,()=>({coins:50}),()=>{},()=>enabled,apps);
 const connect=(owner,client,scope='wallet:read')=>store.exchange(owner,client,scope,owner+client+scope).access_token;
 const bot=connect('alice','lidollbot'),game=connect('alice','lidollquest'),other=connect('bob','lidollbot'),foreign=connect('alice','unrelated'),noScope=connect('alice','lidollbot','stars:read');
 const login={origin:'http://localhost',checkIdentity:async()=>{}},database={economy:{coins:(method,...args)=>store[method](...args)}};
 const server=createServer((req,res)=>coinApi(database,login,req,res,new URL(req.url,login.origin).pathname.slice(1)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root='http://127.0.0.1:'+server.address().port;
 const get=(token=bot,client='lidollbot',query='')=>fetch(root+'/quest-account?client_id='+client+query,{headers:{Authorization:'Bearer '+token}});
 try{
  assert.notEqual(store.balance(bot).account_id,store.balance(game).account_id);
  const response=await get(),body=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(body,{account_id:store.balance(game).account_id,wallet_account_id:store.balance(bot).account_id,client_id:'lidollquest'});
  assert.deepEqual(await(await get(bot,'lidollbot','&owner=bob&account_id='+store.balance(other).account_id)).json(),body,'query parameters cannot select someone else');
  assert.notEqual((await(await get(other)).json()).account_id,body.account_id);
  for(const [token,client,status] of [[game,'lidollbot',403],[game,'lidollquest',403],[foreign,'unrelated',403],[noScope,'lidollbot',403],['missing','lidollbot',401]])assert.equal((await get(token,client)).status,status);
  assert.equal((await fetch(root+'/quest-account?client_id=lidollbot',{method:'POST',headers:{Authorization:'Bearer '+bot,'Content-Type':'application/json'},body:'{}'})).status,405);
  enabled=false;assert.equal((await get()).status,401);enabled=true;
  store.revoke('alice',store.grant(bot).id);assert.equal((await get()).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});
