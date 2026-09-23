import type {MailEnv,RetrievalPreview,RetrievalScope} from './mail-sync';
import type {RelevanceFeedbackInput} from './relevance-store';
import type {RelevanceLens,Theme,ThemeSignal} from './relevance-model';
import {MAX_PUSH_THEMES,MAX_PUSH_THEME_SIGNALS} from '../../../shared/relevance-contract';

const MAX_JSON_BYTES=16*1024;
const LENSES=new Set<RelevanceLens>(['my','firm','public']);
const MUTATION_KEY=/^[\x21-\x7e]{16,128}$/;
const OPAQUE_ID=/^[A-Za-z0-9:_-]{1,200}$/;

type RelevanceStub={
 bindOwner?(owner:string):Promise<void>;
 hasMailGraph?():Promise<boolean>;
 relevance(lens:RelevanceLens):Promise<unknown>;
 evidence(themeId:string,lens:RelevanceLens):Promise<unknown>;
 previewRetrieval(input:RetrievalScope):Promise<unknown>;
 confirmRetrieval(input:RetrievalPreview&{idempotencyKey:string}):Promise<unknown>;
 retrievalStatus(id:string):Promise<unknown>;
 recordRelevanceFeedback(input:RelevanceFeedbackInput):Promise<unknown>;
 previewPublicSource(input:{url:string;personId?:string;graphSource?:'obsidian'}):Promise<unknown>;
 confirmPublicSource(input:{url:string;personId?:string;idempotencyKey:string;graphSource?:'obsidian'}):Promise<unknown>;
 publicSourceStatus(id:string,graphSource:'mail'|'obsidian'):Promise<unknown>;
 relevanceFromPushedGraph(graph:PushedGraphPayload,lens:RelevanceLens):Promise<unknown>;
 evidenceFromPushedGraph(graph:PushedGraphPayload,themeId:string,lens:RelevanceLens):Promise<unknown>;
 recordPushedRelevanceFeedback(input:RelevanceFeedbackInput,graph:PushedGraphPayload):Promise<unknown>;
};
type RouteEnv=MailEnv&{DB?:{prepare(sql:string):{bind(...values:unknown[]):unknown;first<T>():Promise<T|null>}}};

export async function relevanceRoute(request:Request,env:RouteEnv,owner:string):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 try{
  let idempotencyKey:string|undefined;
  if(request.method==='POST'&&isMutationPath(path)){const guarded=mutation(request,url);if(guarded instanceof Response)return guarded;idempotencyKey=guarded;}
  const stub=env.MAIL.getByName(owner) as unknown as RelevanceStub;
  await stub.bindOwner?.(owner);
  if(path==='/api/relevance'){
   if(request.method!=='GET')return error('method_not_allowed',405);
   const lens=queryLens(url);if(!lens)return error('invalid_request',400);
   const selected=source(url);if(selected===null)return error('invalid_request',400);
   const graph=await sourceGraph(stub,env,owner,selected);
   return json(graph?await stub.relevanceFromPushedGraph(graph,lens):await stub.relevance(lens));
  }
  const evidence=matchId(path,/^\/api\/themes\/([^/]+)\/evidence$/);
  if(evidence!==undefined){
   if(request.method!=='GET')return error('method_not_allowed',405);
   const lens=queryLens(url);if(!lens||!validId(evidence))return error('invalid_request',400);
   const selected=source(url);if(selected===null)return error('invalid_request',400);
   const graph=await sourceGraph(stub,env,owner,selected);
   return json(graph?await stub.evidenceFromPushedGraph(graph,evidence,lens):await stub.evidence(evidence,lens));
  }
  if(path==='/api/retrieval/preview'){
   if(request.method!=='POST')return error('method_not_allowed',405);
   if(url.search)return error('invalid_request',400);
   const body=await bodyJSON(request),input=retrievalScope(body);
   if(!input)return error('invalid_request',400);
   return json(await stub.previewRetrieval(input));
  }
  if(path==='/api/retrieval/confirm'){
   if(request.method!=='POST')return error('method_not_allowed',405);
   if(url.search)return error('invalid_request',400);
   const body=await bodyJSON(request),input=retrievalConfirm(body);
   if(!input)return error('invalid_request',400);
   return json(await stub.confirmRetrieval({...input,idempotencyKey:idempotencyKey!}));
  }
  const retrieval=matchId(path,/^\/api\/retrieval\/([^/]+)$/);
  if(retrieval!==undefined){
   if(request.method!=='GET')return error('method_not_allowed',405);
   if(!validId(retrieval)||url.search)return error('invalid_request',400);
   const value=await stub.retrievalStatus(retrieval);
   return value===null?error('not_found',404):json(value);
  }
  const feedbackTheme=matchId(path,/^\/api\/themes\/([^/]+)\/feedback$/);
  if(feedbackTheme!==undefined){
   if(request.method!=='POST')return error('method_not_allowed',405);
   const selected=sourceOnly(url);if(selected===null)return error('invalid_request',400);
   const body=await bodyJSON(request),input=feedback(body,feedbackTheme);
   if(!input)return error('invalid_request',400);
   const withKey={...input,idempotencyKey:idempotencyKey!};
   const graph=await sourceGraph(stub,env,owner,selected);
   return json(graph?await stub.recordPushedRelevanceFeedback(withKey,graph):await stub.recordRelevanceFeedback(withKey));
  }
  if(path==='/api/public-sources/preview'){
   if(request.method!=='POST')return error('method_not_allowed',405);
   const selected=sourceOnly(url);if(selected===null)return error('invalid_request',400);
   const body=await bodyJSON(request),input=publicInput(body);
   if(!input)return error('invalid_request',400);
   const graph=await sourceGraph(stub,env,owner,selected);
   return json(await stub.previewPublicSource({...input,...(graph?{graphSource:'obsidian' as const}:{})}));
  }
  if(path==='/api/public-sources/confirm'){
   if(request.method!=='POST')return error('method_not_allowed',405);
   const selected=sourceOnly(url);if(selected===null)return error('invalid_request',400);
   const body=await bodyJSON(request),input=publicInput(body);
   if(!input)return error('invalid_request',400);
   const graph=await sourceGraph(stub,env,owner,selected);
   return json(await stub.confirmPublicSource({...input,idempotencyKey:idempotencyKey!,...(graph?{graphSource:'obsidian' as const}:{})}));
  }
  const publicId=matchId(path,/^\/api\/public-sources\/([^/]+)$/);
  if(publicId!==undefined){
   if(request.method!=='GET')return error('method_not_allowed',405);
   const selected=sourceOnly(url);if(selected===null||!validId(publicId))return error('invalid_request',400);
   const graph=await sourceGraph(stub,env,owner,selected);
   const value=await stub.publicSourceStatus(publicId,graph?'obsidian':'mail');
   return value===null?error('not_found',404):json(value);
  }
  return error('not_found',404);
 }catch(value){
  if(value instanceof RouteError)return error(value.code,value.status);
  const code=value instanceof Error?value.message:'';
  if(['retrieval_failed','invalid_relevance_feedback','invalid_relevance_person','unsafe_public_source'].includes(code))return error(code,400);
  if(code==='public_source_conflict')return error(code,409);
  if(code==='public_source_limit')return error(code,429);
  return error('server_error',500);
 }
}

export function isRelevancePath(path:string):boolean{
 return path==='/api/relevance'||path.startsWith('/api/retrieval/')||path.startsWith('/api/themes/')||path.startsWith('/api/public-sources/');
}
function isMutationPath(path:string){return path==='/api/retrieval/confirm'||path==='/api/public-sources/confirm'||/^\/api\/themes\/[^/]+\/feedback$/.test(path);}

function mutation(request:Request,url:URL):string|Response{
 if(request.headers.get('origin')!==url.origin)return error('invalid_origin',403);
 const key=request.headers.get('idempotency-key')??'';
 return MUTATION_KEY.test(key)?key:error('invalid_idempotency_key',400);
}
function queryLens(url:URL):RelevanceLens|null{
 if([...url.searchParams.keys()].some(key=>key!=='lens'&&key!=='source')||url.searchParams.getAll('lens').length!==1||url.searchParams.getAll('source').length>1)return null;
 const lens=url.searchParams.get('lens');return LENSES.has(lens as RelevanceLens)?lens as RelevanceLens:null;
}
function source(url:URL):'obsidian'|undefined|null{const value=url.searchParams.get('source');return value===null?undefined:value==='obsidian'?'obsidian':null;}
function sourceOnly(url:URL):'obsidian'|undefined|null{if([...url.searchParams.keys()].some(key=>key!=='source')||url.searchParams.getAll('source').length>1)return null;return source(url);}
function matchId(path:string,pattern:RegExp):string|undefined{
 const match=path.match(pattern);if(!match)return undefined;
 try{return decodeURIComponent(match[1]);}catch{return '';}
}
function validId(value:unknown):value is string{return typeof value==='string'&&OPAQUE_ID.test(value)&&!value.includes('@');}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function exact(value:Record<string,unknown>,allowed:string[],required:string[]):boolean{
 const keys=Object.keys(value);return required.every(key=>Object.hasOwn(value,key))&&keys.every(key=>allowed.includes(key));
}
function retrievalScope(value:unknown):RetrievalScope|null{
 if(!record(value)||!exact(value,['account','personId','themeId','windowDays'],['account','personId']))return null;
 if(typeof value.account!=='string'||value.account.length<3||value.account.length>320||!value.account.includes('@')||!validId(value.personId))return null;
 if(value.themeId!==undefined&&!validId(value.themeId))return null;
 if(value.windowDays!==undefined&&value.windowDays!==30&&value.windowDays!==90)return null;
 return {account:value.account,personId:value.personId,...(value.themeId===undefined?{}:{themeId:value.themeId}),...(value.windowDays===undefined?{}:{windowDays:value.windowDays})} as RetrievalScope;
}
function retrievalConfirm(value:unknown):RetrievalPreview|null{
 const allowed=['account','personId','themeId','windowDays','maxMessages','maxBytes','before','after','expiresAt','fingerprint'];
 const required=allowed.filter(key=>key!=='themeId');
 if(!record(value)||!exact(value,allowed,required))return null;
 const scope=retrievalScope(Object.fromEntries(['account','personId','themeId','windowDays'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]])));
 if(!scope||value.maxMessages!==50||value.maxBytes!==1_000_000||!Number.isSafeInteger(value.before)||!Number.isSafeInteger(value.after)||!Number.isSafeInteger(value.expiresAt)||typeof value.fingerprint!=='string'||!/^[A-Za-z0-9_-]{32,200}$/.test(value.fingerprint))return null;
 if(value.after!==(value.before as number)-(scope.windowDays??30)*86400)return null;
 return {...scope,windowDays:scope.windowDays??30,maxMessages:50,maxBytes:1_000_000,before:value.before as number,after:value.after as number,expiresAt:value.expiresAt as number,fingerprint:value.fingerprint};
}
function feedback(value:unknown,themeId:string):Omit<RelevanceFeedbackInput,'idempotencyKey'>|null{
 const allowed=['action','personId','replacementThemeId','expiresAt'];
 if(!validId(themeId)||!record(value)||!exact(value,allowed,['action'])||!['pin','mute','correct','expire'].includes(String(value.action)))return null;
 if(value.personId!==undefined&&!validId(value.personId))return null;
 if(value.replacementThemeId!==undefined&&!validId(value.replacementThemeId))return null;
 if(value.action==='correct'&&!validId(value.replacementThemeId)||value.action!=='correct'&&value.replacementThemeId!==undefined)return null;
 if(value.expiresAt!==undefined&&(typeof value.expiresAt!=='string'||value.expiresAt.length>40||!Number.isFinite(Date.parse(value.expiresAt))))return null;
 return {themeId,action:value.action as RelevanceFeedbackInput['action'],...(value.personId===undefined?{}:{personId:value.personId}),...(value.replacementThemeId===undefined?{}:{replacementThemeId:value.replacementThemeId}),...(value.expiresAt===undefined?{}:{expiresAt:value.expiresAt})};
}
function publicInput(value:unknown):{url:string;personId?:string}|null{
 if(!record(value)||!exact(value,['url','personId'],['url'])||typeof value.url!=='string'||value.url.length>2048)return null;
 if(value.personId!==undefined&&!validId(value.personId))return null;
 return {url:value.url,...(value.personId===undefined?{}:{personId:value.personId})};
}

class RouteError extends Error{constructor(readonly code:string,readonly status:number){super(code);}}
async function ownerGraph(env:RouteEnv,owner:string):Promise<PushedGraphPayload>{
 if(!env.DB)throw new RouteError('graph_unavailable',404);
 const statement=env.DB.prepare('SELECT json, updated_at FROM graphs WHERE email = ?');
 const bound=statement.bind(owner) as typeof statement;
 const row=await bound.first<{json:string}>();if(!row)throw new RouteError('graph_unavailable',404);
 let value:unknown;try{value=JSON.parse(row.json);}catch{throw new RouteError('invalid_graph',500);}
 const graph=normalizePushedGraph(value);if(!graph)throw new RouteError('invalid_graph',500);return graph;
}
async function sourceGraph(stub:RelevanceStub,env:RouteEnv,owner:string,selected:'obsidian'|undefined):Promise<PushedGraphPayload|null>{
 if(selected==='obsidian')return ownerGraph(env,owner);
 if(!stub.hasMailGraph||await stub.hasMailGraph())return null;
 try{return await ownerGraph(env,owner);}catch(value){if(value instanceof RouteError&&value.code==='graph_unavailable')return null;throw value;}
}
async function bodyJSON(request:Request):Promise<unknown>{
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>MAX_JSON_BYTES)throw new RouteError('request_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw new RouteError('invalid_json',400);
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let bytes=0,text='';
 try{
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_JSON_BYTES)throw new RouteError('request_too_large',413);text+=decoder.decode(part.value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text);
 }catch(value){if(value instanceof RouteError)throw value;throw new RouteError('invalid_json',400);}
 finally{text='';await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function error(code:string,status:number){return json({error:code},status);}
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'cache-control':'no-store'}});}

export type PushedGraphTheme=Omit<Theme,'owner'|'createdAt'|'updatedAt'>;
export type PushedGraphSignal=Omit<ThemeSignal,'owner'|'modelId'>;
export type PushedGraphPayload=Record<string,unknown>&{nodes:unknown[];edges:unknown[];themes:PushedGraphTheme[];themeSignals:PushedGraphSignal[]};

/** Validates only the additive relevance fields and leaves graph identity/layout untouched. */
export function normalizePushedGraph(value:unknown):PushedGraphPayload|null{
 if(!record(value)||!Array.isArray(value.nodes)||!Array.isArray(value.edges))return null;
 if(value.themes!==undefined&&!Array.isArray(value.themes)||value.themeSignals!==undefined&&!Array.isArray(value.themeSignals))return null;
 const themes=value.themes??[],signals=value.themeSignals??[];
 if(themes.length>MAX_PUSH_THEMES||signals.length>MAX_PUSH_THEME_SIGNALS)return null;
 const nodeIds=new Set<string>();
 for(const node of value.nodes){if(!record(node)||typeof node.id!=='string'||node.id.includes('@'))return null;if(node.workspaceIdentities!==undefined){
   if(!record(node.workspaceIdentities)||Object.keys(node.workspaceIdentities).length>8||Object.entries(node.workspaceIdentities).some(([id,token])=>!/^[a-zA-Z0-9-]{1,80}$/.test(id)||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)))return null;
  }nodeIds.add(node.id);}
 const themeIds=new Set<string>();const cleanThemes:PushedGraphTheme[]=[];
 for(const item of themes){
  if(!record(item)||!exact(item,['id','canonicalName','aliases','description','status'],['id','canonicalName','aliases','description','status'])||!validId(item.id)||themeIds.has(item.id)||typeof item.canonicalName!=='string'||!item.canonicalName.trim()||item.canonicalName.length>80||!Array.isArray(item.aliases)||item.aliases.length>20||item.aliases.some(alias=>typeof alias!=='string'||!alias.trim()||alias.length>80)||typeof item.description!=='string'||item.description.length>240||item.status!=='active')return null;
  themeIds.add(item.id);cleanThemes.push({id:item.id,canonicalName:item.canonicalName.trim(),aliases:item.aliases as string[],description:item.description,status:'active'});
 }
 const signalIds=new Set<string>();const cleanSignals:PushedGraphSignal[]=[];
 for(const item of signals){
  const keys=['id','personId','themeId','sourceType','visibility','observedAt','ingestedAt','confidence','summary','evidenceRef','contentHash','extractorVersion'];
  if(!record(item)||!exact(item,keys,keys)||!validId(item.id)||signalIds.has(item.id)||typeof item.personId!=='string'||item.personId.includes('@')||!nodeIds.has(item.personId)||!validId(item.themeId)||!themeIds.has(item.themeId)||!['calendar','granola','obsidian_note'].includes(String(item.sourceType))||!['private','firm'].includes(String(item.visibility))||!validTime(item.observedAt)||!validTime(item.ingestedAt)||typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||typeof item.summary!=='string'||item.summary.length>240||containsEmail(item.summary)||typeof item.evidenceRef!=='string'||item.evidenceRef.length>500||!item.evidenceRef.startsWith('obsidian:')||containsEmail(item.evidenceRef)||typeof item.contentHash!=='string'||!item.contentHash||item.contentHash.length>128||containsEmail(item.contentHash)||item.extractorVersion!=='local-theme-v1')return null;
  signalIds.add(item.id);cleanSignals.push({id:item.id,personId:item.personId,themeId:item.themeId,sourceType:item.sourceType as PushedGraphSignal['sourceType'],visibility:item.visibility as PushedGraphSignal['visibility'],observedAt:item.observedAt,ingestedAt:item.ingestedAt,confidence:item.confidence,summary:item.summary,evidenceRef:item.evidenceRef,contentHash:item.contentHash,extractorVersion:'local-theme-v1'});
 }
 return {...value,nodes:value.nodes,edges:value.edges,themes:cleanThemes,themeSignals:cleanSignals};
}
function validTime(value:unknown):value is string{return typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));}
function containsEmail(value:string):boolean{return /[\p{Letter}\p{Number}._%+-]+@[\p{Letter}\p{Number}.-]+\.[\p{Letter}]{2,}/u.test(value);}
