import type {MailEnv} from './mail-sync';
import type {PeopleEnv} from './people-service';
import {boundedJSON} from './bounded-json';
import {ensureWorkspaces,type Workspace} from './workspace-store';
import {listIntroductionRequests} from './introduction-store';
import {fromWorkspaceRequest,type Introduction} from './introductions';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const ERROR_STATUS:Record<string,number>={invalid_request:400,not_found:404,introduction_state_invalid:409,introduction_budget:409,introduction_rate_limited:429};

/** The owner's own introductions plus shared-workspace requests (read-only), newest first per source. */
export async function listAllIntroductions(env:PeopleEnv,owner:string,stub:{listIntroductions():Promise<{introductions:Introduction[]}>}){
 return {introductions:[...(await stub.listIntroductions()).introductions,...await workspaceIntroductions(env,owner)]};
}

/** Workspace requests where the owner is the requester or the introducer, as read-only introductions. */
async function workspaceIntroductions(env:PeopleEnv,owner:string):Promise<Introduction[]>{
 await ensureWorkspaces(env.DB);
 const rows=await env.DB.prepare("SELECT data FROM workspaces WHERE EXISTS (SELECT 1 FROM json_each(data,'$.members') WHERE json_extract(value,'$.email')=?)").bind(owner).all<{data:string}>();
 const introductions:Introduction[]=[];
 for(const row of rows.results){
  const workspace=JSON.parse(row.data) as Workspace,member=workspace.members.find(m=>m.email===owner);
  if(!member)continue;
  const page=await listIntroductionRequests(env.DB,workspace.id,member.id);
  introductions.push(...page.requests.map(fromWorkspaceRequest));
 }
 return introductions;
}

/** Three-party introductions: the owner's own, plus shared-workspace requests shown read-only. People never sends anything. */
export async function ownerIntroductionRoute(request:Request,env:PeopleEnv&MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 try{
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  if(method==='GET'){
   if(path!=='/api/people/introductions'||url.search)return json({error:'invalid_request'},400);
   return json(await listAllIntroductions(env,owner,stub));
  }
  if(method!=='POST')return json({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(url.search)return json({error:'invalid_request'},400);
  let body:unknown;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),8_000);}catch{return json({error:'invalid_request'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_request'},400);
  const input=body as Record<string,unknown>,keys=Object.keys(input),only=(allowed:string[])=>keys.every(k=>allowed.includes(k));
  if(path==='/api/people/introductions'){
   if(!only(['introducer','parties','reason','evidence']))return json({error:'invalid_request'},400);
   return json(await stub.proposeIntroduction(input));
  }
  if(path==='/api/people/introductions/advance'){
   if(!only(['id','to','vouch'])||typeof input.id!=='string'||typeof input.to!=='string'||(input.vouch!==undefined&&typeof input.vouch!=='string'))return json({error:'invalid_request'},400);
   return json(await stub.advanceIntroduction(input.id,input.to,input.vouch));
  }
  if(path==='/api/people/introductions/outcome'){
   if(!only(['id','result','note'])||typeof input.id!=='string'||typeof input.result!=='string'||(input.note!==undefined&&typeof input.note!=='string'))return json({error:'invalid_request'},400);
   return json(await stub.recordIntroductionOutcome(input.id,input.result,input.note??null));
  }
  return json({error:'method_not_allowed'},405);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('introduction_route_unavailable');return json({error:'people_unavailable'},503);
 }
}
