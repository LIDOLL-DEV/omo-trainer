import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {questRoutes,questScope,requireQuestMethod} from '../server/quest-account-api.mjs';
import {questProxy} from '../server/quest-proxy.mjs';
test('account gateways route managed artwork with social scope and bounded delivery',async()=>{
 assert.ok(questRoutes.has('content/asset'));assert.equal(questScope('content/asset','GET'),'social:read');assert.throws(()=>requireQuestMethod('content/asset','POST'),/Method/);
 let observed;const server=createServer((req,res)=>{observed={url:req.url,authorization:req.headers.authorization};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'managed-test',png:'A'.repeat(300000),frames:1}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const previous=process.env.LIDOLLQUEST_API_URL;process.env.LIDOLLQUEST_API_URL='http://127.0.0.1:'+server.address().port+'/';
 try{const result=await questProxy('synthetic-token','content/asset',new URLSearchParams({asset_id:'managed-test',token:'must-not-forward'}));assert.equal(result.png.length,300000);assert.equal(observed.url,'/content/asset?asset_id=managed-test');assert.equal(observed.authorization,'Bearer synthetic-token');}finally{if(previous===undefined)delete process.env.LIDOLLQUEST_API_URL;else process.env.LIDOLLQUEST_API_URL=previous;await new Promise(resolve=>server.close(resolve));}
});
