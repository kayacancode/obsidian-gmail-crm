import {GranolaClientError} from './granola-client';
import type {MailEnv} from './mail-sync';
import type {GranolaRange} from './granola-sync';

const MAX_REQUEST_BYTES=8*1024;
const API_KEY=/^grn_[\x21-\x7e]{4,508}$/;
const FOLDER_ID=/^fol_[a-zA-Z0-9]{14}$/;

export async function granolaRoute(request:Request,env:MailEnv,owner:string):Promise<Response>{
 const url=new URL(request.url),path=url.pathname,method=request.method,stub=env.MAIL.getByName(owner);
 if(url.search)return error('invalid_request','Granola request is invalid.',400);
 // Bind the owner before any Granola work: a Granola-first owner otherwise syncs into an
 // object with no owner, which skips extraction and returns a null graph.
 await stub.bindOwner(owner);
 if(path==='/api/granola/status'){if(method!=='GET')return error('method_not_allowed','Use GET for status.',405);return json(await stub.granolaStatus());}
 if(request.headers.get('origin')!==url.origin)return error('invalid_origin','Request origin is not allowed.',403);
 try{
  if(path==='/api/granola/connect'){
   if(method!=='POST')return error('method_not_allowed','Use POST to connect.',405);
   const body=await jsonBody(request);if(!body||!record(body)||!sameKeys(body,['apiKey','range']))return invalid();
   if(typeof body.apiKey!=='string'||!API_KEY.test(body.apiKey)||(body.range!=='recent'&&body.range!=='all'))return invalid();
   return json(await stub.granolaConnect(body.apiKey,body.range as GranolaRange));
  }
  if(path==='/api/granola/folders'){
   if(method!=='PATCH')return error('method_not_allowed','Use PATCH to change folders.',405);
   const body=await jsonBody(request);if(!body||!record(body)||!sameKeys(body,['excluded'])||!Array.isArray(body.excluded)||body.excluded.length>500||body.excluded.some(id=>typeof id!=='string'||!FOLDER_ID.test(id)))return invalid();
   return json(await stub.granolaExcluded(body.excluded as string[]));
  }
  if(path==='/api/granola/sync'){if(method!=='POST')return error('method_not_allowed','Use POST to sync.',405);return json(await stub.granolaSyncNow());}
  if(path==='/api/granola/connection'){if(method!=='DELETE')return error('method_not_allowed','Use DELETE to disconnect.',405);await stub.granolaDisconnect();return json({ok:true});}
  return error('not_found','Granola route not found.',404);
 }catch(cause){
  if(cause instanceof RequestTooLarge)return error('request_too_large','Granola request is too large.',413);
  if(cause instanceof UnsupportedMedia)return error('unsupported_media_type','Content-Type must be application/json.',415);
  if(cause instanceof GranolaClientError)return clientError(cause);
  const code=cause instanceof Error?cause.message:'';
  if(code.startsWith('granola:')){const [,failure,diagnostic]=code.split(':');return granolaFailure(failure,diagnostic);}
  if(code==='mail_not_configured')return error('mail_not_configured','Granola connections are not enabled on this server yet.',503);
  if(code==='invalid_key'||code==='invalid_folder')return invalid();
  return error('granola_unavailable','Granola is temporarily unavailable.',502);
 }
}
async function jsonBody(request:Request):Promise<unknown>{
 if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new UnsupportedMedia();
 const declared=Number(request.headers.get('content-length'));if(Number.isFinite(declared)&&declared>MAX_REQUEST_BYTES)throw new RequestTooLarge();
 const raw=await request.text();if(raw.length>MAX_REQUEST_BYTES)throw new RequestTooLarge();
 try{return JSON.parse(raw);}catch{return null;}
}
const invalid=()=>error('invalid_request','Granola request is invalid.',400);
function sameKeys(body:Record<string,unknown>,keys:string[]){return Object.keys(body).sort().join(',')===[...keys].sort().join(',');}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
function error(code:string,message:string,status:number):Response{return json({error:code,message},status);}
function clientError(cause:GranolaClientError):Response{return granolaFailure(cause.failure,cause.diagnostic);}
function granolaFailure(failure:string,diagnostic?:string):Response{
 if(failure==='unauthorized')return error('granola_unauthorized','Granola rejected this API key.',422);
 if(failure==='forbidden')return error('granola_forbidden','Granola denied access to this resource.',422);
 if(failure==='rate_limited')return error('granola_rate_limited','Granola rate limit reached. Try again shortly.',429);
 if(failure==='timeout')return error('granola_timeout','Granola did not respond in time.',504);
 return json({error:'granola_unavailable',message:'Granola is temporarily unavailable.',diagnostic},502);
}
class RequestTooLarge extends Error{}
class UnsupportedMedia extends Error{}
