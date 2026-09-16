import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';

test('reward key setup is repeatable, keeps unrelated settings, and rejects mismatches without writing',()=>{
 const directory=mkdtempSync(resolve('artifacts/reward-config-')),tracker=resolve(directory,'tracker.env'),bot=resolve(directory,'bot.env');
 writeFileSync(tracker,'DATA_DIR=/synthetic/path\n');writeFileSync(bot,'LIDOLLCOIN_ENABLED=true\n');
 const run=()=>spawnSync(process.execPath,['scripts/configure-reward-authority.mjs','--tracker-env',tracker,'--bot-env',bot],{encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);
 const a=readFileSync(tracker,'utf8'),b=readFileSync(bot,'utf8'),key=parseEnv(b).LIDOLLCOIN_REWARD_KEY;
 assert.match(key,/^[A-Za-z0-9_-]{43}$/);assert.equal(JSON.parse(parseEnv(a).LIDOLLCOIN_REWARD_KEYS).lidollbot,key);
 assert.equal(parseEnv(a).DATA_DIR,'/synthetic/path');assert.equal(result.stdout.includes(key),false);
 assert.equal(run().status,0);assert.equal(readFileSync(tracker,'utf8'),a);assert.equal(readFileSync(bot,'utf8'),b);
 writeFileSync(bot,b.replace(key,'x'.repeat(43)));result=run();assert.notEqual(result.status,0);assert.equal(readFileSync(tracker,'utf8'),a);
 writeFileSync(bot,b+'LIDOLLCOIN_REWARD_KEY='+key+'\n');assert.notEqual(run().status,0);assert.equal(readFileSync(tracker,'utf8'),a);
});
