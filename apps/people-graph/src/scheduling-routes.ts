import type {BookingEnv} from './booking-types';
import type {SchedulingEmailEnv} from './scheduling-email-coordinator';
import type {SchedulingResult} from './scheduling-types';
import {boundedJSON} from './bounded-json';
import {validateSchedulingInput,validateSchedulingConfirmation,validateSchedulingContext} from './scheduling-policy';
import {authenticateScheduling,createSchedulingCredential,listSchedulingCredentials,revokeSchedulingCredential,requireSchedulingOwner,requireSchedulingScope,schedulingOrigin,schedulingScopes,type SchedulingPrincipal,type SchedulingCredentialDelegation} from './scheduling-auth';
import {schedulingMcpRoute} from './scheduling-mcp';
import {schedulingEmailConfiguration} from './scheduling-email';

export type SchedulingRouteEnv=SchedulingEmailEnv;
export type SchedulingAction='prepare'|'refresh'|'confirm'|'get'|'context';
export const schedulingInstructionsMessage='Free-text scheduling constraints are not supported. Omit instructions and use UTC windowStart/windowEnd with the owner’s saved rules; ask for clarification if the constraint cannot be represented.';
export function schedulingJSON(data:unknown,status=200){return Response.json(data,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});}
export function schedulingErrorCode(error:unknown){
 const code=error instanceof Error?error.message:'';
 const safe=['scheduling_unauthorized','scheduling_forbidden','insufficient_scope','invalid_origin','not_found','booking_unavailable','calendar_unavailable','booking_calendar_reconnect_required','booking_in_progress','request_closed','slot_unavailable','settings_changed','settings_conflict','offer_expired','offer_changed','assessment_required','context_not_requested','scheduling_email_delivery_unknown','idempotency_conflict','rate_limited','scheduling_failed'];
 return safe.includes(code)||/^invalid_[a-z_]{1,60}$/.test(code)?code:'scheduling_failed';
}
export function schedulingError(error:unknown){
 const code=schedulingErrorCode(error);
 const status=code==='scheduling_unauthorized'?401:['scheduling_forbidden','insufficient_scope','invalid_origin'].includes(code)?403:code==='not_found'?404:code==='rate_limited'?429:['booking_in_progress','request_closed','slot_unavailable','settings_changed','settings_conflict','offer_expired','offer_changed','assessment_required','context_not_requested','scheduling_email_delivery_unknown','idempotency_conflict'].includes(code)?409:['scheduling_failed','booking_unavailable','calendar_unavailable','booking_calendar_reconnect_required'].includes(code)?503:400;
 const response=schedulingJSON({error:code,...(code==='invalid_instructions'?{message:schedulingInstructionsMessage}:{})},status);if(status===401)response.headers.set('www-authenticate','Bearer realm="scheduling"');return response;
}
export async function schedulingBody(request:Request):Promise<Record<string,unknown>>{
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error('invalid_request');
 const value=await boundedJSON(new Response(request.body,{headers:request.headers}),16000).catch(()=>{throw Error('invalid_request');});
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_request');return value as Record<string,unknown>;
}
function fields(value:Record<string,unknown>,allowed:string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('invalid_request');}
/** Shared REST/MCP operation; only authenticated server-created principals reach it. */
export async function runSchedulingAction(env:BookingEnv,principal:SchedulingPrincipal,action:SchedulingAction,input:Record<string,unknown>,requestId?:string):Promise<SchedulingResult>{
 requireSchedulingScope(principal,action==='get'?'scheduling:read':'scheduling:write');
 if(action!=='prepare'&&(!requestId||! /^[\w-]{1,100}$/.test(requestId)))throw Error('invalid_request');
 if(action==='prepare'){
  fields(input,['email','name','context','instructions','timezone','windowStart','windowEnd','idempotencyKey']);
  const validated=validateSchedulingInput(input);if(validated.instructions)throw Error('invalid_instructions');
  return env.BOOKING.getByName(principal.owner).prepareScheduling(principal.owner,validated,{channel:'owner_api',evidenceId:principal.credentialId});
 }
 if(action==='confirm'){
  fields(input,['revision','slotId']);
  const selection=validateSchedulingConfirmation({...input,evidenceId:principal.credentialId});
  return env.BOOKING.getByName(principal.owner).confirmScheduling(principal.owner,requestId!,selection);
 }
 if(action==='context'){
  fields(input,['context','evidenceId']);
  return env.BOOKING.getByName(principal.owner).addSchedulingContext(principal.owner,requestId!,validateSchedulingContext(input));
 }
 fields(input,[]);
 const service=env.BOOKING.getByName(principal.owner);
 return action==='refresh'?service.refreshScheduling(principal.owner,requestId!):service.getScheduling(principal.owner,requestId!);
}
async function actionRoute(request:Request,env:BookingEnv,principal:SchedulingPrincipal,path:string){
 if(path==='/prepare'&&request.method==='POST')return schedulingJSON(await runSchedulingAction(env,principal,'prepare',await schedulingBody(request)));
 const match=path.match(/^\/requests\/([\w-]{1,100})(?:\/(refresh|confirm|context))?$/);
 if(match&&request.method===(match[2]?'POST':'GET'))return schedulingJSON(await runSchedulingAction(env,principal,(match[2]||'get') as SchedulingAction,match[2]?await schedulingBody(request):{},match[1]));
 return schedulingJSON({error:'not_found'},404);
}
export async function schedulingOwnerRoute(request:Request,env:SchedulingRouteEnv,owner:string,delegation?:SchedulingCredentialDelegation):Promise<Response>{
 try{
  owner=owner.toLowerCase();requireSchedulingOwner(env,owner);schedulingOrigin(request,request.method!=='GET');
  const url=new URL(request.url),path=url.pathname.slice('/api/booking/scheduling'.length);
  if(request.method==='GET'&&path==='/status'){
   const email=env.SCHEDULING_EMAIL?schedulingEmailConfiguration(env):null;
   let emailActivity:{pending:number;deliveryUnknown:number;needsAttention:number}|null=null;
   if(email)try{emailActivity=await env.SCHEDULING_EMAIL!.getByName(owner).diagnostics(owner);}catch{}
   return schedulingJSON({readiness:{emailConfigured:!!email,emailAddress:email?.address??null,emailActivity,apiUrl:url.origin+'/api/scheduling',mcpUrl:url.origin+'/api/scheduling/mcp',tokenExpiresInDays:90,scopes:schedulingScopes}});
  }
  if(path==='/tokens'){
   if(request.method==='GET')return schedulingJSON({tokens:await listSchedulingCredentials(env.DB,owner)});
   if(request.method==='POST')return schedulingJSON(await createSchedulingCredential(env.DB,owner,await schedulingBody(request),delegation),201);
  }
  const revoke=path.match(/^\/tokens\/([\w-]{1,100})\/revoke$/);
  if(request.method==='POST'&&revoke){fields(await schedulingBody(request),[]);await revokeSchedulingCredential(env.DB,owner,revoke[1]);return schedulingJSON({ok:true});}
  // Judgment overrides are deliberate owner UI actions, never scheduling-token
  // capabilities or text supplied by an email participant.
  const review=path.match(/^\/requests\/([\w-]{1,100})\/(approve|refresh)$/);
  if(request.method==='POST'&&review){
   const body=await schedulingBody(request),service=env.BOOKING.getByName(owner);
   fields(body,review[2]==='approve'?['policyRevision']:[]);
   if(review[2]==='approve'&&(!Number.isSafeInteger(body.policyRevision)||Number(body.policyRevision)<1))throw Error('invalid_policy_revision');
   const result=review[2]==='approve'?await service.approveScheduling(owner,review[1],body.policyRevision as number):await service.refreshScheduling(owner,review[1]);
   if(['pending_approval','needs_new_slot'].includes(result.status)&&env.SCHEDULING_EMAIL)await env.SCHEDULING_EMAIL.getByName(owner).resumeApproved(owner,review[1]);
   return schedulingJSON(result);
  }
  return await actionRoute(request,env,{owner,credentialId:'owner-session:'+owner,scopes:schedulingScopes},path);
 }catch(error){return schedulingError(error);}
}
export async function schedulingMachineRoute(request:Request,env:BookingEnv,_ctx?:ExecutionContext):Promise<Response>{
 try{
  schedulingOrigin(request);
  const principal=await authenticateScheduling(request,env),path=new URL(request.url).pathname.slice('/api/scheduling'.length);
  if(path==='/mcp')return await schedulingMcpRoute(request,env,principal);
  return await actionRoute(request,env,principal,path);
 }catch(error){return schedulingError(error);}
}
