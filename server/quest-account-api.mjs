export const questRoutes=new Set(['zones/inspect','cloud','cloud/action','characters/action']);
export function requireQuestMethod(route,method){
 if(method!==(route.endsWith('/action')?'POST':'GET'))throw Object.assign(Error('Method not allowed.'),{status:405});
} // The route allowlist includes verbs; unsupported methods cannot become implicit reads in the proxy.
export function questScope(route,method){return route.startsWith('cloud')||route.startsWith('characters')?(method==='GET'?'saves:read':'saves:write'):(method==='GET'?'social:read':'social:write');}
export function questSocialApi(database,secret,method,query,input){
 if(!['GET','POST'].includes(method))throw Object.assign(Error('Method not allowed.'),{status:405});
 const identity=database.economy.coins('grant',secret,questScope('social',method));
 if(identity.client!=='lidollquest')throw Object.assign(Error('This interface is for LiDollQuest.'),{status:403});
 return method==='GET'?database.questSocial.read(identity.owner,Object.fromEntries(query)):database.questSocial.act(identity.owner,input);
} // A wallet grant cannot read records or invoke social actions without its separately consented scopes.
