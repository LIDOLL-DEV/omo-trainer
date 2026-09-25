import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {questProxy,knownOnly} from '../server/quest-proxy.mjs';

test('zone reads and actions forward the snapshot-cache hint and nothing else new',async()=>{ // The quest service swaps pieces the game already holds for stubs (Lidollquest-server snapshot-cache.mjs).
 assert.equal(knownOnly(new URLSearchParams({known:'0123456789abcdef',character_id:'x',view:'companion'})).toString(),'known=0123456789abcdef','actions forward known only');
 assert.equal(knownOnly(new URLSearchParams({character_id:'x'})).toString(),'','no hint, nothing forwarded');
 assert.equal(knownOnly(null).toString(),'');
 const observed=[];const server=createServer((req,res)=>{observed.push(req.url);res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}); // Stand-in quest service recording forwarded URLs.
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const previous=process.env.LIDOLLQUEST_API_URL;process.env.LIDOLLQUEST_API_URL='http://127.0.0.1:'+server.address().port+'/';
 try{
  await questProxy('synthetic-token','zones',new URLSearchParams({character_id:'char-1',known:'0123456789abcdef,fedcba9876543210',token:'must-not-forward'}));
  await questProxy('synthetic-token','zones',new URLSearchParams({character_id:'char-1',known:''})); // Empty: "caching, holding nothing yet".
  await questProxy('synthetic-token','zones/action',knownOnly(new URLSearchParams({known:'0123456789abcdef',character_id:'must-not-forward'})),{action:'heartbeat'});
  assert.deepEqual(observed,['/zones?character_id=char-1&known=0123456789abcdef%2Cfedcba9876543210','/zones?character_id=char-1&known=','/zones/action?known=0123456789abcdef']);
 }finally{if(previous===undefined)delete process.env.LIDOLLQUEST_API_URL;else process.env.LIDOLLQUEST_API_URL=previous;await new Promise(resolve=>server.close(resolve));}
});
