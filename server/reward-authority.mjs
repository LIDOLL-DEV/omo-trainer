import {createHmac,timingSafeEqual} from 'node:crypto';
export function requireRewardAuthority(client,token,input,signature,raw=process.env.LIDOLLCOIN_REWARD_KEYS){
 if(!['credit','refund'].includes(input?.kind))return;
 let key;try{key=JSON.parse(raw??'{}')[client];}catch{}
 if(typeof key!=='string'||! /^[A-Za-z0-9_-]{43,128}$/.test(key))throw Object.assign(Error('Server reward authorization is not configured for this game.'),{status:403,code:'reward_authorization'});
 const expected=createHmac('sha256',key).update(client+'\n'+token+'\n'+JSON.stringify(input)).digest();
 if(typeof signature!=='string'||! /^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw Object.assign(Error('A trusted game server must authorize credits and refunds.'),{status:403,code:'reward_authorization'});
} // Bind server authority to this client's exact recipient token and immutable operation, including its retry ID.
