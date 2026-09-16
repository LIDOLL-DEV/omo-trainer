import {createPublicKey,randomBytes,verify} from 'node:crypto';
export function createIdentityStatus(issuer,{fetcher=fetch,now=Date.now}={}) {
 const origin=new URL(issuer).origin,cache=new Map(),pending=new Map();let keys=null,keysAt=0;
 async function json(path,options={}){
  const response=await fetcher(new URL(path,origin),{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok){await response.body?.cancel();throw Error('Identity check unavailable');}
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error('Identity response too large');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks));
 }
 async function check(identity,force=false){
  if(identity.issuer!==origin)throw Error('Identity issuer mismatch');
  const key=identity.subject,old=cache.get(key);if(!force&&old&&old.until>now())return old.value;
  if(pending.has(key))return pending.get(key);if(pending.size>=32)throw Error('Identity checks busy');
  const promise=(async()=>{
   const nonce=randomBytes(32).toString('base64url'),signed=await json('/account/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:key,nonce})});
   if(!keys||keysAt+300000<=now()||!keys.some(k=>k.kid===signed.kid)){keys=(await json('/jwks')).keys;keysAt=now();}
   const jwk=keys?.find(k=>k.kid===signed.kid&&k.kty==='RSA'&&k.alg==='RS256');
   if(!jwk||typeof signed.payload!=='string'||typeof signed.signature!=='string'||!verify('RSA-SHA256',Buffer.from(signed.payload),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(signed.signature,'base64url')))throw Error('Invalid identity signature');
   const value=JSON.parse(Buffer.from(signed.payload,'base64url'));
   if(value.issuer!==origin||value.subject!==key||value.nonce!==nonce||!Number.isSafeInteger(value.version)||value.version<0||typeof value.disabled!=='boolean')throw Error('Invalid identity status');
   if(cache.size>=1000)cache.delete(cache.keys().next().value);cache.set(key,{value,until:now()+30000});return value;
  })();pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
 }
 return check;
} // Short-lived signed checks fail closed; nonce binding prevents replaying an old enabled status.
