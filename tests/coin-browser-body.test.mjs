import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {coinBrowserApi} from '../server/coin-browser-api.mjs';

test('browser gameplay accepts bounded loadouts without widening wallet access', async t => {
  const received=[];
  const upstream=http.createServer(async (req,res)=>{ // Observe the real gateway transport without requiring a live game service.
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received.push({url:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const previous=process.env.LIDOLLQUEST_API_URL;
  process.env.LIDOLLQUEST_API_URL=`http://127.0.0.1:${upstream.address().port}/`;
  const database={economy:{coins(method,secret){
    if(secret!=='test-wallet')throw Object.assign(Error('Sign in.'),{status:401});
    if(method==='grant')return {owner:'test-player'};
    if(method==='browserSession')return {csrf:'test-csrf',linked:true};
    throw Error('Unexpected wallet operation: '+method);
  }}};
  const login={origin:'',checkIdentity:async()=>{}};
  const gateway=http.createServer((req,res)=>coinBrowserApi(database,login,req,res,new URL(req.url,login.origin).pathname.replace('/tracker/api/lidollcoin/browser/','')));
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  login.origin=`http://127.0.0.1:${gateway.address().port}`;
  t.after(async()=>{ // Restore process configuration and close connections even if a boundary assertion fails.
    if(previous===undefined)delete process.env.LIDOLLQUEST_API_URL;else process.env.LIDOLLQUEST_API_URL=previous;
    for(const server of [gateway,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
  async function post(body,route='zones/action',headers={}) {
    const response=await fetch(login.origin+'/tracker/api/lidollcoin/browser/'+route,{method:'POST',headers:{Origin:login.origin,'Content-Type':'application/json',Cookie:'lidollquest_wallet=test-wallet','X-CSRF-Token':'test-csrf',...headers},body});
    return {status:response.status,body:await response.json()};
  }
  const command={action:'enter',character_id:'test-character',loadout:{player_info:{level:5},inventory:Array.from({length:100},()=>({item_id:'apple',description:'A regular inventory item. '.repeat(10)}))}};
  const body=JSON.stringify(command);
  assert.ok(Buffer.byteLength(body)>8192);

  await t.test('inventory over 8 KiB reaches the service unchanged',async()=>{
    assert.equal((await post(body)).status,200);
    assert.deepEqual(received[0],{url:'/zones/action',authorization:'Bearer test-wallet',body:command});
  });
  await t.test('256 KiB boundary is accepted and one byte more is rejected',async()=>{
    const exact=JSON.stringify({payload:'x'.repeat(256*1024-14)});
    assert.equal(Buffer.byteLength(exact),256*1024);
    assert.equal((await post(exact)).status,200);
    const count=received.length;
    assert.equal((await post(exact+' ')).status,413);
    assert.equal(received.length,count);
  });
  await t.test('wallet operations retain their 8 KiB limit',async()=>{
    const count=received.length;
    for(const route of ['operations','connect','revoke'])assert.equal((await post(body,route)).status,413);
    assert.equal(received.length,count);
  });
  await t.test('larger gameplay requests still require origin, wallet and CSRF',async()=>{
    const count=received.length;
    assert.equal((await post(body,'zones/action',{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await post(body,'zones/action',{Cookie:''})).status,401);
    assert.equal((await post(body,'zones/action',{'X-CSRF-Token':'incorrect'})).status,403);
    assert.equal(received.length,count);
  });
});
