export function createUploadAdmission(db,{now=Date.now,globalLimit=4,accountLimit=2,attemptLimit=20}={}){
 db.exec('CREATE TABLE IF NOT EXISTS social_upload_attempts(owner TEXT PRIMARY KEY,started INTEGER NOT NULL,attempts INTEGER NOT NULL)');
 const active=new Map(),permits=new Set();let total=0;
 const fail=()=>{throw Object.assign(Error('Uploads are busy. Please try again in a minute.'),{status:429});};
 async function run(owner,work){
  if(total>=globalLimit||(active.get(owner)??0)>=accountLimit)fail();
  const time=now();db.prepare('DELETE FROM social_upload_attempts WHERE started<=?').run(time-60000);
  const row=db.prepare('INSERT INTO social_upload_attempts VALUES (?,?,1) ON CONFLICT(owner) DO UPDATE SET attempts=attempts+1 RETURNING attempts').get(owner,time);if(row.attempts>attemptLimit)fail();
  const permit={owner};permits.add(permit);total++;active.set(owner,(active.get(owner)??0)+1);
  try{return await work(permit);}finally{permits.delete(permit);total--;const left=active.get(owner)-1;if(left)active.set(owner,left);else active.delete(owner);}
 }
 return {run,valid:(owner,permit)=>permits.has(permit)&&permit.owner===owner};
} // Reserve before buffering or decoding; bounded attempts persist across restarts and slots always release.
