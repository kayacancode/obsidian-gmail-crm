import {boundedJSON} from './bounded-json';

export type FolderPage={folders:{id:string;name:string;parentFolderId:string|null}[];hasMore:boolean;cursor:string|null};
export type NotePage={notes:{id:string;title:string;createdAt:string;updatedAt:string}[];hasMore:boolean;cursor:string|null};
export type GranolaFailure='unauthorized'|'forbidden'|'rate_limited'|'timeout'|'unavailable';

export class GranolaClientError extends Error{
 constructor(readonly failure:GranolaFailure){super(failure);this.name='GranolaClientError';}
}

const BASE_URL='https://public-api.granola.ai';
const PAGE_SIZE=30;
const MAX_RESPONSE_BYTES=256*1024;
const DEADLINE_MS=15_000;
const FOLDER_ID=/^fol_[a-zA-Z0-9]{14}$/;
const NOTE_ID=/^not_[a-zA-Z0-9]{14}$/;

export async function listGranolaFolders(apiKey:string,cursor?:string):Promise<FolderPage>{
 const url=new URL('/v1/folders',BASE_URL);url.searchParams.set('page_size',String(PAGE_SIZE));if(cursor)url.searchParams.set('cursor',cursor);
 const raw=await granolaJSON(url,apiKey);const page=pagination(raw,'folders',cursor);
 return {folders:page.items.map(folder),hasMore:page.hasMore,cursor:page.cursor};
}

export async function listGranolaNotes(apiKey:string,folderId:string,cursor?:string):Promise<NotePage>{
 const url=new URL('/v1/notes',BASE_URL);url.searchParams.set('folder_id',folderId);url.searchParams.set('page_size',String(PAGE_SIZE));if(cursor)url.searchParams.set('cursor',cursor);
 const raw=await granolaJSON(url,apiKey);const page=pagination(raw,'notes',cursor);
 return {notes:page.items.map(note),hasMore:page.hasMore,cursor:page.cursor};
}

async function granolaJSON(url:URL,apiKey:string):Promise<unknown>{
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let timedOut=false;
 let rejectDeadline:(reason:GranolaClientError)=>void=()=>{};
 const deadline=new Promise<never>((_,reject)=>{rejectDeadline=reject;});
 const timer=setTimeout(()=>{
  timedOut=true;rejectDeadline(new GranolaClientError('timeout'));controller.abort();
  if(reader)void reader.cancel().catch(()=>{});
 },DEADLINE_MS);
 const operation=(async()=>{
  const response=await fetch(url,{method:'GET',headers:{authorization:`Bearer ${apiKey}`,accept:'application/json'},redirect:'error',signal:controller.signal});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw statusError(response.status);}
  if(!response.body)throw new GranolaClientError('unavailable');
  reader=response.body.getReader();
  const boundedBody=new ReadableStream<Uint8Array>({
   async pull(stream){const chunk=await reader!.read();if(chunk.done)stream.close();else stream.enqueue(chunk.value);},
   cancel(reason){return reader!.cancel(reason);},
  });
  return boundedJSON(new Response(boundedBody,{headers:response.headers}),MAX_RESPONSE_BYTES);
 })();
 try{return await Promise.race([operation,deadline]);}
 catch(error){
  if(timedOut)return Promise.reject(new GranolaClientError('timeout'));
  if(error instanceof GranolaClientError)throw error;
  throw new GranolaClientError('unavailable');
 }finally{
  clearTimeout(timer);controller.abort();
  try{reader?.releaseLock();}catch{}
 }
}

function statusError(status:number):GranolaClientError{
 if(status===401)return new GranolaClientError('unauthorized');
 if(status===403)return new GranolaClientError('forbidden');
 if(status===429)return new GranolaClientError('rate_limited');
 return new GranolaClientError('unavailable');
}

function pagination(value:unknown,key:'folders'|'notes',inputCursor?:string):{items:unknown[];hasMore:boolean;cursor:string|null}{
 if(!record(value)||!Array.isArray(value[key])||value[key].length>PAGE_SIZE||typeof value.hasMore!=='boolean'||!Object.hasOwn(value,'cursor'))invalid();
 const cursor=value.cursor;if(cursor!==null&&!validCursor(cursor))invalid();
 if(value.hasMore&&(cursor===null||cursor===''||cursor===inputCursor||value[key].length===0))invalid();
 if(!value.hasMore&&cursor!==null)invalid();
 return {items:value[key],hasMore:value.hasMore,cursor};
}

function folder(value:unknown):FolderPage['folders'][number]{
 if(!record(value)||typeof value.id!=='string'||!FOLDER_ID.test(value.id)||typeof value.name!=='string'||value.name.length>1_000||!Object.hasOwn(value,'parent_folder_id'))invalid();
 const parent=value.parent_folder_id;if(parent!==null&&(typeof parent!=='string'||!FOLDER_ID.test(parent)))invalid();
 return {id:value.id,name:value.name,parentFolderId:parent};
}

function note(value:unknown):NotePage['notes'][number]{
 if(!record(value)||typeof value.id!=='string'||!NOTE_ID.test(value.id)||(value.title!==null&&typeof value.title!=='string')||(typeof value.title==='string'&&value.title.length>2_000)||!validDate(value.created_at)||!validDate(value.updated_at))invalid();
 return {id:value.id,title:value.title===null?'Untitled meeting':value.title,createdAt:value.created_at,updatedAt:value.updated_at};
}

function validDate(value:unknown):value is string{
 if(typeof value!=='string'||value.length>64)return false;
 const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);if(!match)return false;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),offsetHour=Number(match[7]||0),offsetMinute=Number(match[8]||0);
 const monthDays=[31,(year%4===0&&year%100!==0)||year%400===0?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=monthDays[month-1]&&hour<=23&&minute<=59&&second<=59&&offsetHour<=23&&offsetMinute<=59&&Number.isFinite(Date.parse(value));
}
function validCursor(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=2_048&&!/[\x00-\x1f\x7f]/.test(value);}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function invalid():never{throw new GranolaClientError('unavailable');}
