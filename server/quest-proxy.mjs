export async function questProxy(secret,route,query,input){
 const configured=process.env.LIDOLLQUEST_API_URL;if(!configured)throw Object.assign(Error('The online arena service is not configured.'),{status:503});
 const base=new URL(configured);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('Invalid arena service URL');
 if(!['zones','zones/action','zones/inspect','cloud','cloud/action','characters/action'].includes(route))throw Object.assign(Error('Endpoint not found.'),{status:404});
 const url=new URL(route,base);for(const k of ['character_id','target','controller','revision','part','history'])if(query?.has(k))url.searchParams.set(k,query.get(k));
 const result=await fetch(url,{method:input?'POST':'GET',headers:{Authorization:'Bearer '+secret,...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});
 let length=0;const parts=[];for await(const part of result.body){length+=part.length;if(length>262144)throw Error('Arena response too large');parts.push(Buffer.from(part));}
 const body=JSON.parse(Buffer.concat(parts));if(!result.ok)throw Object.assign(Error(body.error_description??'Arena request failed.'),{status:result.status,code:body.error});return body;
} // A thin authenticated transport keeps browser wallet cookies private; gameplay and storage belong to the separate service.
