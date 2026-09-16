import {createHmac} from 'node:crypto';
const key='synthetic-reward-authority-key-for-tests-only-0001';
process.env.LIDOLLCOIN_REWARD_KEYS=JSON.stringify({lidollquest:key,lidollbot:key});
export const rewardSignature=(token,input,client='lidollquest')=>createHmac('sha256',key).update(client+'\n'+token+'\n'+JSON.stringify(input)).digest('hex');
