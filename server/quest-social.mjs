import {createHash} from 'node:crypto';
const account=id=>createHash('sha256').update('lidollquest:'+id).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function createQuestSocial(db,friends){
 db.exec('CREATE TABLE IF NOT EXISTS quest_social_accounts(account_id TEXT PRIMARY KEY,participant_id TEXT UNIQUE NOT NULL REFERENCES participants(id))');
 function register(id){db.prepare('INSERT OR IGNORE INTO quest_social_accounts VALUES (?,?)').run(account(id),id);}
 for(const row of db.prepare('SELECT id FROM participants').all())register(row.id);
 function member(id){const row=db.prepare('SELECT id,label FROM participants WHERE id=? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=participants.id AND a.disabled=1)').get(id);if(!row)fail(404,'Member is unavailable.');return {account_id:account(id),label:row.label};}
 function resolve(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))fail(400,'Choose a member.');const row=db.prepare('SELECT participant_id FROM quest_social_accounts WHERE account_id=?').get(id);if(!row)fail(404,'Member not found.');member(row.participant_id);return row.participant_id;}
 function view(row){const {participantId,avatarVersion,...rest}=row;return {...rest,...member(participantId)};}
 function read(owner,query={}){
  const self=member(owner);
  if(query.account_id){const target=resolve(query.account_id);return {member:member(target),friend:friends.list(owner).filter(f=>f.participantId===target).map(view)[0]??null,self:target===owner};}
  const links=friends.list(owner),byMember=new Map(links.map(row=>[row.participantId,row]));
  return {self,friends:(query.q?friends.search(owner,query.q).map(row=>({...row,...byMember.get(row.participantId)})):links).map(view)};
 }
 function act(owner,input){member(owner);return friends.act(owner,input?.action==='request'?{action:'request',participantId:resolve(input.account_id)}:{action:input?.action,id:input?.id});}
 return {register,read,act};
} // One relationship store serves both apps; Quest sees only its existing opaque account IDs.
