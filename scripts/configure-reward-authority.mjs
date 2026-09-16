import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,renameSync,chmodSync,chownSync} from 'node:fs';
import {resolve} from 'node:path';
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
if(!args.includes('--tracker-env')||!args.includes('--bot-env'))throw Error('Usage: node scripts/configure-reward-authority.mjs --tracker-env PATH --bot-env PATH [--client lidollbot]');
const client=args.includes('--client')?value('--client'):'lidollbot';if(!/^[a-z0-9_-]{1,64}$/.test(client))throw Error('Invalid client ID.');
function source(path){path=resolve(path);const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Environment must be a regular, non-symlink file: '+path);const text=readFileSync(path,'utf8');return {path,info,text,env:parseEnv(text)};}
const tracker=source(value('--tracker-env')),bot=source(value('--bot-env'));if(tracker.path===bot.path)throw Error('Use separate tracker and bot environment files.');
const keys=JSON.parse(tracker.env.LIDOLLCOIN_REWARD_KEYS??'{}');if(!keys||typeof keys!=='object'||Array.isArray(keys))throw Error('Invalid tracker reward-key mapping.');
for(const [id,secret] of Object.entries(keys))if(!/^[a-z0-9_-]{1,64}$/.test(id)||typeof secret!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(secret))throw Error('Invalid existing reward-key entry.');
for(const [file,name] of [[tracker,'LIDOLLCOIN_REWARD_KEYS'],[bot,'LIDOLLCOIN_REWARD_KEY']])if((file.text.match(new RegExp('^\\s*(?:export\\s+)?'+name+'\\s*=','gm'))??[]).length>1)throw Error('Duplicate setting: '+name);
const a=keys[client],b=bot.env.LIDOLLCOIN_REWARD_KEY;
for(const key of [a,b])if(key&&!/^[A-Za-z0-9_-]{43,128}$/.test(key))throw Error('An existing reward key is invalid.');
if(a&&b&&a!==b)throw Error('Existing reward keys disagree. Resolve the configuration before rerunning.');
const key=a??b??randomBytes(32).toString('base64url');keys[client]=key;
function save(file,name,value){
 const pattern=new RegExp('^[\\t ]*(?:export[\\t ]+)?'+name+'[\\t ]*=.*$','gm'),matches=file.text.match(pattern)??[];if(matches.length>1)throw Error('Duplicate setting: '+name);
 const line=name+'='+value,next=matches.length?file.text.replace(pattern,()=>line):file.text.replace(/\s*$/,'')+'\n'+line+'\n';if(next===file.text)return;
 const suffix='.reward-key-'+randomBytes(6).toString('hex'),backup=file.path+suffix+'.bak',temp=file.path+suffix+'.tmp';
 writeFileSync(backup,file.text,{flag:'wx',mode:0o600});writeFileSync(temp,next,{flag:'wx',mode:0o600});
 if(process.platform!=='win32'){chownSync(temp,file.info.uid,file.info.gid);chmodSync(temp,file.info.mode&0o777);}
 renameSync(temp,file.path);console.log('Updated '+file.path+'; private backup: '+backup);
} // Preserve ownership and mode, write atomically, and reuse an existing key after an interrupted two-file update.
save(tracker,'LIDOLLCOIN_REWARD_KEYS',"'"+JSON.stringify(keys)+"'");save(bot,'LIDOLLCOIN_REWARD_KEY',key);
console.log('Reward authorization configured for '+client+'. No secret was printed. Restart services after deploying compatible code.');
