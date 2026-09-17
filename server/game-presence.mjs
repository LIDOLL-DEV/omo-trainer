const fail=message=>{throw Object.assign(Error(message),{status:400});};
export function createGamePresence(db,friends,{activity,now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_game_sessions(owner TEXT NOT NULL REFERENCES participants(id),session TEXT NOT NULL,seen INTEGER NOT NULL,PRIMARY KEY(owner,session));
 CREATE INDEX IF NOT EXISTS quest_game_seen ON quest_game_sessions(seen);
 CREATE TABLE IF NOT EXISTS quest_game_activity(owner TEXT PRIMARY KEY REFERENCES participants(id),started INTEGER NOT NULL,notified INTEGER);`);
 const active=owner=>Boolean(db.prepare('SELECT 1 FROM quest_game_sessions WHERE owner=? AND seen>?').get(owner,now()-90000));
 function read(owner,target){
  if(!friends.accepted(owner,target))return {};
  const playing=active(target);return {playing,gameStarted:playing?db.prepare('SELECT started FROM quest_game_activity WHERE owner=?').get(target)?.started??0:0};
 } // Only accepted friends see current activity; a crashed or disconnected game expires after 90 seconds.
 function act(owner,input){
  if(typeof input.session!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(input.session)||typeof input.playing!=='boolean')fail('Choose a valid game presence session.');
  db.exec('BEGIN IMMEDIATE');try{
   const instant=now();db.prepare('DELETE FROM quest_game_sessions WHERE seen<=?').run(instant-90000);
   if(!input.playing)db.prepare('DELETE FROM quest_game_sessions WHERE owner=? AND session=?').run(owner,input.session);
   else {
    const wasPlaying=active(owner),previous=db.prepare('SELECT * FROM quest_game_activity WHERE owner=?').get(owner);
    const existing=db.prepare('SELECT 1 FROM quest_game_sessions WHERE owner=? AND session=?').get(owner,input.session);
    if(!existing&&db.prepare('SELECT COUNT(*) AS n FROM quest_game_sessions WHERE owner=?').get(owner).n>=8)fail('Too many active game sessions.');
    db.prepare('INSERT INTO quest_game_sessions VALUES (?,?,?) ON CONFLICT(owner,session) DO UPDATE SET seen=excluded.seen').run(owner,input.session,instant);
    if(!wasPlaying){
     const notify=previous?.notified==null||instant-previous.notified>=300000;
     db.prepare('INSERT INTO quest_game_activity VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET started=excluded.started,notified=excluded.notified').run(owner,instant,notify?instant:previous.notified);
     if(notify)for(const friend of friends.list(owner).filter(f=>f.state==='accepted'))activity.record(friend.participantId,{source:'lidollquest-playing:'+owner+':'+instant,kind:'friend-playing',actor:owner,created:instant},true);
    }
   }
   db.exec('COMMIT');return {playing:active(owner),expiresIn:90};
  }catch(error){db.exec('ROLLBACK');throw error;}
 } // Account activity spans windows. Heartbeats and quick reconnects never flood friends with repeat alerts.
 return {read,act,active};
}
