import {boundedJSON} from './bounded-json';
import {createPeopleMemoryCredential,listPeopleMemoryCredentials,revokePeopleMemoryCredential,peopleMemoryOrigin,peopleMemoryScopeDescriptions,type PeopleMemoryPrincipal,type PeopleMemoryScope} from './people-memory-auth';
import {ownerLensRoute} from './owner-lens-routes';
import {personContextRoute} from './person-context-routes';
import {relationshipMemoryRoute} from './relationship-memory-routes';
import {personMergeRoute} from './person-merge-routes';
import {mailRoute,draftRoute,connectionOriginRoute,helperRoute,searchRoute,personFeedbackRoute} from './mail-routes';
import {granolaRoute} from './granola-routes';
import {relevanceRoute} from './relevance-routes';
import {shareRoute} from './share-routes';
import {workspaceRoute} from './workspace-routes';
import {bookingOwnerRoute} from './booking-routes';
import {deviceRoute} from './cli-auth';
import {loadPeopleNetwork} from './people-service';
import type {SchedulingEmailEnv} from './scheduling-email-coordinator';

type Method='GET'|'POST'|'PUT'|'PATCH'|'DELETE';
type Handler='lens'|'context'|'memory'|'merges'|'accounts'|'draft'|'connection'|'helpers'|'search'|'feedback'|'granola'|'relevance'|'shares'|'workspaces'|'booking'|'integrations'|'devices'|'graph';
interface Capability {method:Method;path:string;requiredScopes:PeopleMemoryScope[];handler:Handler;pattern:RegExp;query:string[];browserPath?:string}
const read:PeopleMemoryScope[]=['people:read'],edit:PeopleMemoryScope[]=['people:read','people:write'],sources:PeopleMemoryScope[]=['sources:manage'],sourceData:PeopleMemoryScope[]=['people:read','sources:manage'],sharing:PeopleMemoryScope[]=['sharing:manage'],sharedData:PeopleMemoryScope[]=['people:read','sharing:manage'],booking:PeopleMemoryScope[]=['booking:manage'],integrations:PeopleMemoryScope[]=['integrations:manage'];
function capability(method:Method,path:string,requiredScopes:PeopleMemoryScope[],handler:Handler,query:string[]=[],browserPath?:string):Capability{
 // Placeholders accept opaque IDs only. A path cannot add another segment or escape into another family.
 const pattern=new RegExp('^'+path.split('/').map(part=>part.startsWith(':')?'[A-Za-z0-9:_-]{1,200}':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/')+'$');
 return {method,path,requiredScopes,handler,pattern,query,browserPath};
}

/** The complete machine surface is enumerated here; no prefix grants or arbitrary Worker recursion. */
const capabilities:Capability[]=[
 capability('GET','/api/graph',read,'graph',['source']),
 capability('GET','/api/lens',read,'lens'),capability('POST','/api/lens',edit,'lens'),capability('POST','/api/lens/matches',read,'lens'),
 capability('GET','/api/people/context',read,'context',['personId']),capability('POST','/api/people/context',edit,'context'),
 capability('GET','/api/people/memory',read,'memory',['personId']),capability('POST','/api/people/memory',edit,'memory'),capability('POST','/api/people/memory/structure',read,'memory'),capability('DELETE','/api/people/memory/entry',edit,'memory'),
 capability('GET','/api/people/person-merges',read,'merges'),capability('POST','/api/people/person-merges',edit,'merges'),capability('DELETE','/api/people/person-merges',edit,'merges'),
 capability('POST','/api/people/feedback',edit,'feedback'),capability('POST','/api/people/draft',read,'draft'),capability('POST','/api/people/connection-origin',read,'connection'),capability('POST','/api/people/helpers',read,'helpers'),capability('POST','/api/people/search',read,'search'),
 capability('GET','/api/accounts',sources,'accounts'),capability('POST','/api/accounts/connect',sources,'accounts',[],'/accounts'),capability('POST','/api/accounts/context',sources,'accounts'),capability('POST','/api/accounts/sync',sources,'accounts'),capability('POST','/api/accounts/disconnect',sources,'accounts'),
 capability('GET','/api/granola/status',sources,'granola'),capability('GET','/api/granola/identities',sources,'granola'),capability('POST','/api/granola/connect',sources,'granola'),capability('PATCH','/api/granola/folders',sources,'granola'),capability('POST','/api/granola/identities',sources,'granola'),capability('POST','/api/granola/sync',sources,'granola'),capability('DELETE','/api/granola/connection',sources,'granola'),
 capability('GET','/api/relevance',read,'relevance',['lens','source']),capability('GET','/api/themes/:themeId/evidence',read,'relevance',['lens','source']),capability('POST','/api/themes/:themeId/feedback',edit,'relevance',['source']),
 capability('POST','/api/retrieval/preview',sourceData,'relevance'),capability('POST','/api/retrieval/confirm',sourceData,'relevance'),capability('GET','/api/retrieval/:retrievalId',sourceData,'relevance'),
 capability('POST','/api/public-sources/preview',sourceData,'relevance',['source']),capability('POST','/api/public-sources/confirm',sourceData,'relevance',['source']),capability('GET','/api/public-sources/:sourceId',sourceData,'relevance',['source']),
 capability('GET','/api/shares',sharing,'shares'),capability('POST','/api/shares',sharing,'shares'),capability('DELETE','/api/shares',sharing,'shares'),capability('POST','/api/shares/hide',sharing,'shares'),
 capability('GET','/api/workspaces',sharing,'workspaces'),capability('POST','/api/workspaces',sharing,'workspaces'),capability('DELETE','/api/workspaces/:workspaceId',sharing,'workspaces'),capability('POST','/api/workspace-invites/accept',sharing,'workspaces'),
 capability('GET','/api/workspaces/:workspaceId/members',sharing,'workspaces'),capability('POST','/api/workspaces/:workspaceId/invites',sharing,'workspaces'),capability('DELETE','/api/workspaces/:workspaceId/invites/:inviteId',sharing,'workspaces'),capability('DELETE','/api/workspaces/:workspaceId/members/:memberId',sharing,'workspaces'),capability('POST','/api/workspaces/:workspaceId/transfer',sharing,'workspaces'),capability('PUT','/api/workspaces/:workspaceId/contribution',sharing,'workspaces'),
 ...(['person-merges','relationship-confirmations','excluded-people'] as const).flatMap(path=>[capability('POST','/api/workspaces/:workspaceId/'+path,sharing,'workspaces'),capability('DELETE','/api/workspaces/:workspaceId/'+path,sharing,'workspaces')]),
 capability('GET','/api/workspaces/:workspaceId/graph',sharedData,'workspaces'),
 ...(['search','search-stream','draft','introductions','helpers'] as const).map(path=>capability('POST','/api/workspaces/:workspaceId/'+path,sharedData,'workspaces')),
 capability('GET','/api/workspaces/:workspaceId/intro-requests',sharedData,'workspaces',['cursor']),capability('POST','/api/workspaces/:workspaceId/intro-requests',sharedData,'workspaces'),capability('GET','/api/workspaces/:workspaceId/intro-requests/:requestId',sharedData,'workspaces'),capability('POST','/api/workspaces/:workspaceId/intro-requests/:requestId/reply',sharedData,'workspaces'),
 capability('GET','/api/booking',['people:read','booking:manage'],'booking'),capability('POST','/api/booking/settings',booking,'booking'),capability('POST','/api/booking/calendar/connect',booking,'booking',[],'/booking'),capability('POST','/api/booking/calendar/disconnect',booking,'booking'),
 ...(['email','approve-proposal','request-times','approve','decline','cancel'] as const).map(action=>capability('POST','/api/booking/requests/:requestId/'+action,booking,'booking')),
 capability('GET','/api/booking/scheduling/status',booking,'booking'),capability('POST','/api/booking/scheduling/prepare',booking,'booking'),capability('GET','/api/booking/scheduling/requests/:requestId',booking,'booking'),
 ...(['refresh','confirm','context','approve'] as const).map(action=>capability('POST','/api/booking/scheduling/requests/:requestId/'+action,booking,'booking')),
 capability('GET','/api/booking/scheduling/tokens',['booking:manage','integrations:manage'],'booking'),capability('POST','/api/booking/scheduling/tokens',['booking:manage','integrations:manage'],'booking'),capability('POST','/api/booking/scheduling/tokens/:credentialId/revoke',['booking:manage','integrations:manage'],'booking'),
 capability('GET','/api/people/integrations',integrations,'integrations'),capability('POST','/api/people/integrations',integrations,'integrations'),capability('POST','/api/people/integrations/:credentialId/revoke',integrations,'integrations'),
 capability('GET','/api/cli/devices',integrations,'devices'),capability('POST','/api/cli/devices/revoke',integrations,'devices'),
];
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
const failure=(error:string,status:number,extra:Record<string,unknown>={})=>json({error,...extra},status);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function peopleMachineStatus(principal:PeopleMemoryPrincipal,origin:string){
 return {protocolVersion:1,owner:principal.owner,credential:{id:principal.credentialId,name:principal.name??null,scopes:[...principal.scopes],expiresAt:principal.expiresAt??null},apiUrl:origin+'/api/people-agent',mcpUrl:origin+'/api/people-mcp',scopeDescriptions:peopleMemoryScopeDescriptions,capabilities:capabilities.map(({method,path,requiredScopes,query,browserPath})=>({method,path,requiredScopes:[...requiredScopes],query:[...query],available:requiredScopes.every(scope=>principal.scopes.includes(scope)),mode:browserPath?'browser_handoff':'request',...(browserPath?{browserHandoff:{url:origin+browserPath}}:{})}))};
}

/** Only a verified server-created principal may reach this adapter. Owner handlers keep their business checks. */
export async function peopleMachineRequest(request:Request,env:SchedulingEmailEnv,principal:PeopleMemoryPrincipal):Promise<Response>{
 try{
  if(request.method!=='POST')return failure('method_not_allowed',405);
  peopleMemoryOrigin(request);
  if(new URL(request.url).search)return failure('invalid_request',400);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return failure('invalid_request',400);
  let input:unknown;try{input=await boundedJSON(new Response(request.body,{headers:request.headers}),100_000);}catch{return failure('invalid_request',400);}
  if(!record(input)||Object.keys(input).some(key=>!['method','path','body','idempotencyKey'].includes(key))||typeof input.method!=='string'||typeof input.path!=='string'||input.path.length>2048)return failure('invalid_request',400);
  if(!['GET','POST','PUT','PATCH','DELETE'].includes(input.method))return failure('method_not_allowed',405);
  const path=input.path;
  if(!path.startsWith('/api/')||/[\\#\u0000-\u0020\u007f]/.test(path)||path.split('?')[0].includes('%'))return failure('invalid_request',400);
  const origin=new URL(request.url).origin,url=new URL(path,origin);
  if(url.origin!==origin||url.pathname!==path.split('?')[0])return failure('invalid_request',400);
  const matching=capabilities.filter(entry=>entry.pattern.test(url.pathname));
  if(!matching.length)return failure('not_found',404);
  const selected=matching.find(entry=>entry.method===input.method);if(!selected)return failure('method_not_allowed',405);
  const params=[...url.searchParams.keys()];if(params.some(key=>!selected.query.includes(key))||new Set(params).size!==params.length)return failure('invalid_request',400);
  if(input.method==='GET'&&('body' in input||'idempotencyKey' in input)||'body' in input&&!record(input.body))return failure('invalid_request',400);
  if(input.idempotencyKey!==undefined&&(typeof input.idempotencyKey!=='string'||!/^[\x21-\x7e]{16,128}$/.test(input.idempotencyKey)))return failure('invalid_idempotency_key',400);
  const missing=selected.requiredScopes.filter(scope=>!principal.scopes.includes(scope));if(missing.length)return failure('insufficient_scope',403,{requiredScopes:selected.requiredScopes});
  if(selected.browserPath)return json({requiresBrowser:true,browserHandoff:{url:origin+selected.browserPath,reason:'provider_oauth_requires_browser'}});
  const body=record(input.body)?input.body:{};
  // Construct a fresh request from the bounded allowlist envelope. Never forward credentials, cookies, or arbitrary headers.
  const headers=new Headers({'content-type':'application/json',origin});if(typeof input.idempotencyKey==='string')headers.set('idempotency-key',input.idempotencyKey);
  const adapted=new Request(url,{method:input.method,headers,signal:request.signal,...(input.method==='GET'?{}:{body:JSON.stringify(body)})});
  const owner=principal.owner;
  switch(selected.handler){
   case 'lens':return await ownerLensRoute(adapted,env,owner);
   case 'context':return await personContextRoute(adapted,env,owner);
   case 'memory':return await relationshipMemoryRoute(adapted,env,owner);
   case 'merges':return await personMergeRoute(adapted,env,owner);
   case 'accounts':return await mailRoute(adapted,env,owner);
   case 'draft':return await draftRoute(adapted,env,owner);
   case 'connection':return await connectionOriginRoute(adapted,env,owner);
   case 'helpers':return await helperRoute(adapted,env,owner);
   case 'search':return await searchRoute(adapted,env,owner);
   case 'feedback':return await personFeedbackRoute(adapted,env,owner);
   case 'granola':return await granolaRoute(adapted,env,owner);
   case 'relevance':return await relevanceRoute(adapted,env,owner);
   case 'shares':return await shareRoute(adapted,env,owner);
   case 'workspaces':return await workspaceRoute(adapted,env,owner);
   case 'booking':return await bookingOwnerRoute(adapted,env,owner,{expiresAt:principal.expiresAt});
   case 'devices':return await deviceRoute(adapted,env,owner);
   case 'graph':{
    const source=url.searchParams.get('source');if(source!==null&&!['web','obsidian'].includes(source))return failure('invalid_request',400);
    return json(await loadPeopleNetwork(env,owner,source??undefined));
   }
   case 'integrations':{
    if(input.method==='GET')return json({tokens:await listPeopleMemoryCredentials(env.DB,owner),apiUrl:origin+'/api/people-agent',mcpUrl:origin+'/api/people-mcp',scopes:[...principal.scopes],scopeDescriptions:peopleMemoryScopeDescriptions});
    if(url.pathname==='/api/people/integrations')return json(await createPeopleMemoryCredential(env.DB,owner,body,principal),201);
    if(Object.keys(body).length)return failure('invalid_request',400);
    await revokePeopleMemoryCredential(env.DB,owner,url.pathname.split('/')[4]);return json({ok:true});
   }
  }
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(code==='invalid_origin'||code==='insufficient_scope')return failure(code,403);
  if(code==='not_found')return failure(code,404);
  if(/^invalid_[a-z_]{1,60}$/.test(code))return failure(code,400);
  return failure('people_request_failed',503);
 }
}
