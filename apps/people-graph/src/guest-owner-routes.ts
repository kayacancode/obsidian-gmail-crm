import type {MailEnv} from './mail-sync';
import type {PeopleEnv} from './people-service';
import {boundedJSON} from './bounded-json';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const ERROR_STATUS:Record<string,number>={invalid_request:400,answer_not_anonymous:400,not_found:404,guest_ask_state_invalid:409};
export const GUEST_OWNER_PATHS=['/api/people/guest-asks','/api/people/guest-asks/answer','/api/people/guest-asks/decline','/api/people/guest-asks/settings'];

/** The owner reviews guest questions: nothing reaches a guest until the owner answers here. */
export async function guestOwnerRoute(request:Request,env:PeopleEnv&MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 try{
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  if(method==='GET'){
   if(path!=='/api/people/guest-asks'||url.search)return json({error:'invalid_request'},400);
   return json(await stub.listGuestAsks());
  }
  if(method!=='POST')return json({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(url.search)return json({error:'invalid_request'},400);
  let body:unknown;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),16_000);}catch{return json({error:'invalid_request'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_request'},400);
  const input=body as Record<string,unknown>,keys=Object.keys(input),only=(allowed:string[])=>keys.every(k=>allowed.includes(k));
  if(path==='/api/people/guest-asks/answer'){
   if(!only(['id','answer'])||typeof input.id!=='string')return json({error:'invalid_request'},400);
   return json(await stub.answerGuestAsk(input.id,input.answer));
  }
  if(path==='/api/people/guest-asks/decline'){
   if(!only(['id'])||typeof input.id!=='string')return json({error:'invalid_request'},400);
   return json(await stub.declineGuestAsk(input.id));
  }
  if(path==='/api/people/guest-asks/settings'){
   if(!only(['enabled'])||typeof input.enabled!=='boolean')return json({error:'invalid_request'},400);
   return json(await stub.setGuestAsk(input.enabled));
  }
  return json({error:'method_not_allowed'},405);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  // Owner-only: say which word identifies someone, so the owner can rewrite it.
  if(code.startsWith('answer_not_anonymous:'))return json({error:'answer_not_anonymous',term:code.slice('answer_not_anonymous:'.length)},400);
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('guest_owner_route_unavailable');return json({error:'people_unavailable'},503);
 }
}
