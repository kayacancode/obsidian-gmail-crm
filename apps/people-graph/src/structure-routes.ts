import type {MailEnv} from './mail-sync';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const ERROR_STATUS:Record<string,number>={invalid_request:400};

/** Exactly the allowed query parameters, each at most once; anything else is rejected. */
function only(url:URL,allowed:string[]):Record<string,string>|null{
 const entries=[...url.searchParams];
 if(entries.some(([key])=>!allowed.includes(key))||new Set(entries.map(([key])=>key)).size!==entries.length)return null;
 return Object.fromEntries(entries);
}

/** Owner-only answers about the shape of the network. Read-only GET routes. */
export async function structureRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname;
 if(request.method!=='GET')return json({error:'method_not_allowed'},405);
 try{
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  if(path==='/api/people/why-now'){
   const q=only(url,['limit']);if(!q)return json({error:'invalid_request'},400);
   const limit=q.limit===undefined?10:Number(q.limit);
   return json(await stub.whyNow(limit));
  }
  return json({error:'not_found'},404);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('structure_route_unavailable');return json({error:'people_unavailable'},503);
 }
}
