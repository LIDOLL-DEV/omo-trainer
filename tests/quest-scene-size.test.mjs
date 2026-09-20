import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {questProxy} from '../server/quest-proxy.mjs';
test('gameplay gateways carry bounded authored scenes; other routes stay small',async()=>{
 let size=300000;const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'a'.repeat(size)}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const previous=process.env.LIDOLLQUEST_API_URL;process.env.LIDOLLQUEST_API_URL='http://127.0.0.1:'+server.address().port+'/';
 try{for(const route of ['zones','zones/action'])assert.equal((await questProxy('synthetic',route,new URLSearchParams(),route.endsWith('action')?{action:'read'}:undefined)).text.length,size);await assert.rejects(questProxy('synthetic','sprites',new URLSearchParams()),/too large/);size=1048576;await assert.rejects(questProxy('synthetic','zones',new URLSearchParams()),/too large/);}finally{if(previous===undefined)delete process.env.LIDOLLQUEST_API_URL;else process.env.LIDOLLQUEST_API_URL=previous;await new Promise(r=>server.close(r));}
});
