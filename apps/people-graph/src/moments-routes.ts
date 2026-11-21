import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const ERROR_STATUS:Record<string,number>={invalid_request:400,note_too_long:400,note_limit:409,not_found:404};

/** Owner-private curiosity notes and moments. Reads are GET; writes need same-origin JSON. */
export async function momentsRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 try{
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  if(method==='GET'){
   if(path==='/api/people/mind'){
    const keys=[...url.searchParams.keys()];
    if(keys.some(k=>k!=='includeArchived')||keys.length>1)return json({error:'invalid_request'},400);
    return json(await stub.listCuriosityNotes(url.searchParams.get('includeArchived')==='1'));
   }
   if(path==='/api/people/moments'){
    const keys=[...url.searchParams.keys()],today=url.searchParams.get('today');
    if(keys.some(k=>k!=='today')||keys.length>1||(today!==null&&today!=='1'))return json({error:'invalid_request'},400);
    return json(await stub.moments({today:today==='1'}));
   }
   return json({error:'method_not_allowed'},405);
  }
  if(method!=='POST')return json({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(url.search)return json({error:'invalid_request'},400);
  let body:unknown;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),8_000);}catch{return json({error:'invalid_request'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_request'},400);
  const input=body as Record<string,unknown>,keys=Object.keys(input);
  if(path==='/api/people/mind'){
   if(keys.some(k=>k!=='text'&&k!=='id'))return json({error:'invalid_request'},400);
   return json(await stub.setCuriosityNote(input));
  }
  if(path==='/api/people/mind/archive'){
   if(keys.join(',')!=='id'||typeof input.id!=='string')return json({error:'invalid_request'},400);
   return json(await stub.archiveCuriosityNote(input.id));
  }
  if(path==='/api/people/moments/update'){
   if(keys.sort().join(',')!=='action,id'||typeof input.id!=='string'||typeof input.action!=='string')return json({error:'invalid_request'},400);
   return json(await stub.updateMoment(input.id,input.action));
  }
  if(path==='/api/people/moments/settings'){
   if(keys.join(',')!=='budget'||typeof input.budget!=='number')return json({error:'invalid_request'},400);
   return json(await stub.setMomentBudget(input.budget));
  }
  return json({error:'method_not_allowed'},405);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(code.startsWith('note_invalid:'))return json({error:'note_invalid',heading:code.slice('note_invalid:'.length)},400);
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('moments_route_unavailable');return json({error:'people_unavailable'},503);
 }
}
