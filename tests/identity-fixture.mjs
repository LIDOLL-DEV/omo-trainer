import {createServer} from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
export async function startIdentityFixture(){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});let issuer;
 const key={...publicKey.export({format:'jwk'}),kid:'browser-fixture',alg:'RS256'};
 const server=createServer(async(req,res)=>{
  res.setHeader('Connection','close');res.setHeader('Content-Type','application/json');
  if(req.url==='/jwks')return res.end(JSON.stringify({keys:[key]}));
  if(req.url!=='/account/status'||req.method!=='POST'){res.writeHead(404);return res.end('{}');}
  const chunks=[];for await(const part of req)chunks.push(part);const {subject,nonce}=JSON.parse(Buffer.concat(chunks));
  const payload=Buffer.from(JSON.stringify({issuer,subject,nonce,version:0,disabled:false})).toString('base64url');
  res.end(JSON.stringify({kid:key.kid,payload,signature:sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));server.unref();issuer='http://127.0.0.1:'+server.address().port;process.env.OIDC_ISSUER=issuer;return server;
} // Browser fixtures use an isolated signed identity service, never a production authentication bypass.
