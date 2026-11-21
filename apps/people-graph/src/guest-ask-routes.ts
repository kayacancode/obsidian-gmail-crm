import type {BookingEnv,BookingSettings,BookingVisitorIdentity} from './booking-types';
import {BookingStore} from './booking-store';
import {bookingReadiness} from './booking-coordinator';
import {beginBookingSignIn,bookingVisitor,GUEST_ASK_MARKER} from './booking-verification';
import {boundedJSON} from './bounded-json';
import {createMcpHandler} from 'agents/mcp/server';
import {GuestAgentTokens,guestMcpServer} from './guest-agent';

const HEADERS={'cache-control':'no-store','referrer-policy':'no-referrer'};
const json=(data:unknown,status=200,cookie?:string)=>Response.json(data,{status,headers:cookie?{...HEADERS,'set-cookie':cookie}:HEADERS});
const ERROR_STATUS:Record<string,number>={invalid_request:400,verification_required:401,invalid_origin:403,guest_ask_disabled:403,not_found:404,guest_ask_state_invalid:409,introduction_budget:409,guest_rate_limited:429};

/** What the public route needs from booking: the owner's page, the verified visitor, readiness and sign-in. */
export interface GuestAskDeps {
 settings(slug:string):Promise<BookingSettings|null>;
 visitor(settings:BookingSettings,request:Request):Promise<BookingVisitorIdentity>;
 ready(owner:string):Promise<boolean>;
 signIn(settings:BookingSettings,request:Request):Promise<{url:string;cookie:string}>;
}
function bookingDeps(env:BookingEnv):GuestAskDeps{
 return {
  settings:async slug=>{const store=new BookingStore(env.DB);await store.init();return store.slug(slug);},
  visitor:(settings,request)=>bookingVisitor(env,settings,request),
  ready:async owner=>{const ready=await bookingReadiness(env,owner);return ready.signIn&&ready.pilot;},
  signIn:(settings,request)=>beginBookingSignIn(env,settings,request,{requestId:GUEST_ASK_MARKER}),
 };
}

/**
 * Guest ask, public side: `/api/public/ask/<slug>`. Guests sign in with the booking Google sign-in,
 * ask the owner's network, and see only the owner's approved answers. Names appear only through
 * introductions the described person opted into.
 */
export async function guestAskPublicRoute(request:Request,env:BookingEnv,deps:GuestAskDeps=bookingDeps(env)):Promise<Response>{
 try{
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/public\/ask\/([a-z0-9-]{3,64})(\/.*)?$/);
  if(!match||url.search)return json({error:'not_found'},404);
  const settings=await deps.settings(match[1]);if(!settings)return json({error:'not_found'},404);
  const path=match[2]??'',stub=env.MAIL.getByName(settings.owner);await stub.bindOwner(settings.owner);
  const enabled=await stub.guestAskEnabled()&&await deps.ready(settings.owner);
  if(request.method==='GET'&&!path){
   let visitor=null;try{visitor={email:(await deps.visitor(settings,request)).email};}catch{}
   return json({page:{displayName:settings.displayName},enabled,visitor});
  }
  // The guest's own agent: bearer token instead of the browser session, same limits and switch.
  if(path==='/mcp'){
   const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization')??'')?.[1]??'';
   const guest=token?await new GuestAgentTokens(env.DB,env.TOKEN_SECRET).resolve(settings.owner,settings.slug,token):null;
   if(!guest)return Response.json({error:'guest_token_invalid'},{status:401,headers:{...HEADERS,'www-authenticate':'Bearer realm="guest-ask"'}});
   const parsed=request.method==='POST'?await boundedJSON(new Response(request.body,{headers:request.headers}),16_000).catch(()=>null):undefined;
   if(parsed===null)throw Error('invalid_request');
   const handler=createMcpHandler(()=>guestMcpServer(stub,guest,enabled),{route:url.pathname,corsOptions:false,allowedHostnames:[url.hostname],allowedOriginHostnames:[url.hostname]});
   const response=await handler.fetch(request,parsed===undefined?undefined:{parsedBody:parsed});
   response.headers.set('cache-control','no-store');response.headers.set('referrer-policy','no-referrer');
   return response;
  }
  if(request.method!=='GET'&&request.method!=='POST')return json({error:'not_found'},404);
  let input:Record<string,unknown>={};
  if(request.method==='POST'){
   if(request.headers.get('origin')!==url.origin)throw Error('invalid_origin');
   const body=await boundedJSON(new Response(request.body,{headers:request.headers}),4_000).catch(()=>null);
   if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_request');
   input=body as Record<string,unknown>;
  }
  if(request.method==='POST'&&path==='/sign-in'){
   if(!enabled)throw Error('guest_ask_disabled');
   const result=await deps.signIn(settings,request);return json({url:result.url},200,result.cookie);
  }
  const visitor=await deps.visitor(settings,request);
  if(path==='/agent-token'&&request.method==='POST'){
   if(!enabled)throw Error('guest_ask_disabled');
   const minted=await new GuestAgentTokens(env.DB,env.TOKEN_SECRET).mint(settings.owner,settings.slug,{email:visitor.email,subject:visitor.subject});
   return json({...minted,mcp:`${url.origin}/api/public/ask/${settings.slug}/mcp`});
  }
  if(path==='/questions'&&request.method==='GET')return json(await stub.guestAsksFor(visitor.subject));
  if(path==='/questions'&&request.method==='POST'){
   if(!enabled)throw Error('guest_ask_disabled');
   if(Object.keys(input).some(k=>k!=='question')||typeof input.question!=='string')throw Error('invalid_request');
   return json({question:(await stub.submitGuestAsk({key:visitor.subject,email:visitor.email},input.question)).ask});
  }
  const intro=path.match(/^\/questions\/(ga_[\w-]{1,80})\/introductions$/);
  if(intro&&request.method==='POST'){
   if(Object.keys(input).some(k=>k!=='ref')||typeof input.ref!=='string'||!/^p\d{1,2}$/.test(input.ref))throw Error('invalid_request');
   return json(await stub.requestGuestIntroduction(visitor.subject,intro[1],input.ref));
  }
  return json({error:'not_found'},404);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('guest_ask_public_unavailable');return json({error:'guest_ask_unavailable'},503);
 }
}
