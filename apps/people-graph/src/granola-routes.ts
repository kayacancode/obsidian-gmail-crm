import {GranolaClientError,listGranolaFolders,listGranolaNotes} from './granola-client';

const MAX_REQUEST_BYTES=8*1024;
const API_KEY=/^grn_[\x21-\x7e]{4,508}$/;
const FOLDER_ID=/^fol_[a-zA-Z0-9]{14}$/;

export async function granolaRoute(request:Request):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname!=='/api/granola/folders'&&url.pathname!=='/api/granola/notes')return error('not_found','Granola route not found.',404);
 if(request.method!=='POST')return error('method_not_allowed','Use POST for Granola requests.',405);
 if(request.headers.get('origin')!==url.origin)return error('invalid_origin','Request origin is not allowed.',403);
 if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return error('unsupported_media_type','Content-Type must be application/json.',415);
 if(url.search)return error('invalid_request','Granola request is invalid.',400);
 try{
  const raw=await requestText(request);let body:unknown;
  try{body=JSON.parse(raw);}catch{return error('invalid_request','Granola request is invalid.',400);}
  if(!record(body)||!validKeys(body,url.pathname.endsWith('/notes')))return error('invalid_request','Granola request is invalid.',400);
  if(typeof body.apiKey!=='string'||!API_KEY.test(body.apiKey))return error('invalid_request','Granola request is invalid.',400);
  if(body.cursor!==undefined&&!validCursor(body.cursor))return error('invalid_request','Granola request is invalid.',400);
  if(url.pathname.endsWith('/notes')){
   if(typeof body.folderId!=='string'||!FOLDER_ID.test(body.folderId))return error('invalid_request','Granola request is invalid.',400);
   return json(await listGranolaNotes(body.apiKey,{folderId:body.folderId,cursor:body.cursor as string|undefined}));
  }
  return json(await listGranolaFolders(body.apiKey,body.cursor as string|undefined));
 }catch(cause){
  if(cause instanceof RequestTooLarge)return error('request_too_large','Granola request is too large.',413);
  if(cause instanceof RequestInvalid)return error('invalid_request','Granola request is invalid.',400);
  if(cause instanceof GranolaClientError)return clientError(cause);
  return error('granola_unavailable','Granola is temporarily unavailable.',502);
 }
}

async function requestText(request:Request):Promise<string>{
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>MAX_REQUEST_BYTES)throw new RequestTooLarge();
 const reader=request.body?.getReader();if(!reader)return '';
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let bytes=0,text='';
 try{
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>MAX_REQUEST_BYTES)throw new RequestTooLarge();text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();return text;
 }catch(cause){if(cause instanceof RequestTooLarge)throw cause;throw new RequestInvalid();
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

function validKeys(body:Record<string,unknown>,notes:boolean):boolean{
 const allowed=notes?new Set(['apiKey','folderId','cursor']):new Set(['apiKey','cursor']);
 return Object.hasOwn(body,'apiKey')&&(!notes||Object.hasOwn(body,'folderId'))&&Object.keys(body).every(key=>allowed.has(key));
}
function validCursor(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=2_048&&!/[\x00-\x1f\x7f]/.test(value);}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
function error(code:string,message:string,status:number):Response{return json({error:code,message},status);}

function clientError(cause:GranolaClientError):Response{
 if(cause.failure==='unauthorized')return error('granola_unauthorized','Granola rejected this API key.',422);
 if(cause.failure==='forbidden')return error('granola_forbidden','Granola denied access to this resource.',422);
 if(cause.failure==='rate_limited')return error('granola_rate_limited','Granola rate limit reached. Try again shortly.',429);
 if(cause.failure==='timeout')return error('granola_timeout','Granola did not respond in time.',504);
 return json({error:'granola_unavailable',message:'Granola is temporarily unavailable.',diagnostic:cause.diagnostic},502);
}

class RequestTooLarge extends Error{}
class RequestInvalid extends Error{}
