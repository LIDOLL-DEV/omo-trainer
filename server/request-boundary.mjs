export function requestBoundary(handler) {
 return (request,response)=>{void Promise.resolve().then(()=>{
  if(!request.url?.startsWith('/')||request.url.startsWith('//')||request.url.includes('\\'))throw Object.assign(Error('Invalid request target'),{status:400});
  new URL(request.url,'http://localhost');
  return handler(request,response);
 }).catch(error=>{
  if(response.destroyed)return;
  if(response.headersSent){response.destroy();return;}
  response.writeHead(error.status===400?400:500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
  response.end(error.status===400?'Invalid request target.':'Request could not be completed.');
 });};
} // Catch URL parsing and asynchronous failures without terminating the HTTP service.
