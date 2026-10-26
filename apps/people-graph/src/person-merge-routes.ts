import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';
import {validContextPerson} from './person-context';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
/** Session ownership is supplied by the router, never by the submitted record. */
export async function personMergeRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url);
 if(!['GET','POST','DELETE'].includes(request.method))return json({error:'method_not_allowed'},405);
 if(url.search)return json({error:'invalid_request'},400);
 let body:{sourceId:string;targetId?:string}|undefined;
 if(request.method!=='GET'){
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  let value:unknown;try{value=await boundedJSON(new Response(request.body,{headers:request.headers}),1500);}catch{return json({error:'invalid_request'},400);}
  if(!value||typeof value!=='object'||Array.isArray(value))return json({error:'invalid_request'},400);
  const fields=value as Record<string,unknown>,allowed=request.method==='POST'?['sourceId','targetId']:['sourceId'];
  if(Object.keys(fields).length!==allowed.length||Object.keys(fields).some(key=>!allowed.includes(key))||allowed.some(key=>!validContextPerson(fields[key])))return json({error:'invalid_request'},400);
  body=fields as typeof body;
 }
 try{
  const service=env.MAIL.getByName(owner);await service.bindOwner(owner);
  return json(request.method==='GET'?await service.getPersonMerges():request.method==='POST'?await service.setPersonMerge(body!.sourceId,body!.targetId!):await service.deletePersonMerge(body!.sourceId));
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(code==='unknown_person')return json({error:code},404);
  if(code==='merge_conflict')return json({error:code},409);
  if(['invalid_person_merge','merge_limit'].includes(code))return json({error:code},400);
  throw error;
 }
}
