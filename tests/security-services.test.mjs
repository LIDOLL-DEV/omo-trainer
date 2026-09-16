import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {createPublicKey,randomBytes,verify} from 'node:crypto';
import {openAuthStore} from '../auth/store.mjs';
async function service(kind){
 const directory=mkdtempSync(resolve('artifacts/security-service-'));
 const child=spawn(process.execPath,[kind==='tracker'?'scripts/serve.mjs':'scripts/auth-server.mjs'],{windowsHide:true,env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',BASE_PATH:'/tracker/',DATA_DIR:directory,PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4180',AUTH_HOST:'127.0.0.1',AUTH_PORT:'0',AUTH_DATA_DIR:directory,AUTH_ISSUER:'http://127.0.0.1:4180'},stdio:['ignore','pipe','pipe']});
 child.stderr.resume();const timeout=setTimeout(()=>child.kill(),20000);
 const port=await new Promise((done,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;const match=text.match(kind==='tracker'?/127\.0\.0\.1:(\d+)\/tracker/:/listening on port (\d+)/);if(match)done(Number(match[1]));});child.once('exit',()=>reject(Error('Service exited before ready')));});
 return {directory,port,origin:'http://127.0.0.1:'+port,close:async()=>{clearTimeout(timeout);const exit=once(child,'exit');child.kill();await exit;}};
}
for(const kind of ['tracker','identity'])test(kind+' returns 400 for a malformed request and remains available',async()=>{
 const s=await service(kind);try{
  const response=await new Promise((done,reject)=>{let data='';const socket=connect(s.port,'127.0.0.1',()=>socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));socket.on('data',b=>data+=b);socket.on('error',reject);socket.on('close',()=>done(data));});
  assert.match(response,/HTTP\/1\.1 400/);assert.equal((await fetch(s.origin+(kind==='tracker'?'/tracker/':'/jwks'))).status,200);
  if(kind==='identity'){
   const store=openAuthStore(s.directory);try{
    const account=await store.setPassword('security-user','synthetic-password-for-test-1234',true),nonce=randomBytes(32).toString('base64url');
    const status=async()=>{const response=await fetch(s.origin+'/account/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:account.id,nonce})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const value=await response.json();const jwks=await (await fetch(s.origin+'/jwks')).json();assert.ok(verify('RSA-SHA256',Buffer.from(value.payload),createPublicKey({key:jwks.keys.find(k=>k.kid===value.kid),format:'jwk'}),Buffer.from(value.signature,'base64url')));const payload=JSON.parse(Buffer.from(value.payload,'base64url'));assert.equal(payload.nonce,nonce);return payload;};
    assert.equal((await status()).version,0);await store.setPassword('security-user','synthetic-new-password-for-test-1234');assert.equal((await status()).version,1);store.disable('security-user');assert.equal((await status()).disabled,true);
   }finally{store.close();}
  }
 }finally{await s.close();}
});
