import type {BookingEnv,BookingRequestRecord} from './booking-types';
import {BookingStore} from './booking-store';
import {bookingReadiness,publicBookingRequest} from './booking-coordinator';
import {defaultBookingSettings} from './booking-policy';
import {boundedJSON} from './bounded-json';
import {bookingCookie,setBookingCookie,randomBookingToken,issueBookingChallenge,verifyBookingChallenge,bookingVisitor} from './booking-verification';
import {createBookingOAuth,exchangeBookingOAuth} from './booking-providers';
import {opaque,seal,unseal} from './mail-model';

const OAUTH_COOKIE='__Host-people-booking-connect';
function json(data:unknown,status=200,cookie?:string){return Response.json(data,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer',...(cookie?{'set-cookie':cookie}:{})}});}
async function body(request:Request):Promise<Record<string,unknown>>{
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('invalid_request');
 const value=await boundedJSON(new Response(request.body,{headers:request.headers}),16000).catch(()=>{throw Error('invalid_request');});
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_request');return value as Record<string,unknown>;
}
function origin(request:Request){if(request.headers.get('origin')!==new URL(request.url).origin)throw Error('invalid_origin');}
export function bookingError(error:unknown){
 const raw=error instanceof Error?error.message:'';
 const code=raw==='booking_calendar_reconnect_required'?'calendar_unavailable':raw;
 const codes=['invalid_origin','not_found','verification_required','invalid_code','rate_limited','invalid_request','invalid_request_key','booking_unavailable','email_unavailable','calendar_unavailable','booking_in_progress','request_closed','no_pending_slot','slot_unavailable','settings_changed','settings_conflict','thesis_required','unknown_setting','slug_taken','setup_required','invalid_oauth_state','wrong_owner'];
 // Provider bodies and model output must never become public error messages.
 const safe=codes.includes(code)?code:code.startsWith('invalid_')&&/^[a-z_]{1,60}$/.test(code)?code:'booking_failed';
 return json({error:safe},safe==='invalid_origin'?403:safe==='not_found'?404:safe==='verification_required'?401:safe==='rate_limited'?429:['settings_changed','settings_conflict','thesis_required','unknown_setting','slug_taken','slot_unavailable','request_closed','booking_in_progress'].includes(safe)?409:['email_unavailable','calendar_unavailable','booking_unavailable','booking_failed'].includes(safe)?503:400);
}
export async function bookingOwnerRoute(request:Request,env:BookingEnv,owner:string):Promise<Response>{
 try{
  const url=new URL(request.url),path=url.pathname,store=new BookingStore(env.DB);await store.init();
  if(request.method==='GET'&&path==='/api/booking'){
   const [settings,requests,readiness,calendar]=await Promise.all([store.settings(owner),store.requests(owner),bookingReadiness(env,owner),store.calendar(owner)]);
   let lens=null;try{const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);const saved=await stub.getOwnerLens();lens=saved.fields;}catch{}
   return json({account:{email:owner},settings:settings||defaultBookingSettings(owner),requests,readiness,lens,calendar:calendar?{email:calendar.email}:null});
  }
  if(request.method!=='POST')return json({error:'not_found'},404);origin(request);
  if(env.BOOKING_OWNER_EMAIL?.toLowerCase()!==owner)throw Error('booking_unavailable');
  const stub=env.BOOKING.getByName(owner);
  if(path==='/api/booking/settings')return json({settings:await stub.saveSettings(owner,await body(request))});
  if(path==='/api/booking/calendar/connect'){
   if(!env.GOOGLE_CLIENT_SECRET||!env.MAIL_TOKEN_KEY)throw Error('setup_required');
   const nonce=randomBookingToken(),cookie=randomBookingToken(),verifier=randomBookingToken();
   const state='booking.'+nonce;
   const authUrl=await createBookingOAuth(env,url.origin,state,verifier);
   await store.cleanup();
   await env.DB.prepare('INSERT INTO booking_oauth(id,owner,cookie_hash,verifier,expires) VALUES(?,?,?,?,?)').bind(nonce,owner,await opaque('booking-oauth',cookie,env.TOKEN_SECRET),await seal(verifier,env.MAIL_TOKEN_KEY),Date.now()+600000).run();
   return json({url:authUrl},200,setBookingCookie(OAUTH_COOKIE,cookie,600));
  }
  if(path==='/api/booking/calendar/disconnect'){await stub.disconnectCalendar(owner);return json({ok:true});}
  const action=path.match(/^\/api\/booking\/requests\/([\w-]{1,100})\/(approve|decline|cancel)$/);
  if(action)return json({request:await stub.act(owner,action[1],action[2] as 'approve'|'decline'|'cancel')});
  return json({error:'not_found'},404);
 }catch(e){return bookingError(e);}
}
export async function bookingOAuthCallback(request:Request,env:BookingEnv):Promise<Response>{
 const clear=setBookingCookie(OAUTH_COOKIE,'',0),url=new URL(request.url);
 try{
  const state=url.searchParams.get('state')||'',cookie=bookingCookie(request,OAUTH_COOKIE);
  if(!/^booking\.[A-Za-z0-9_-]{43}$/.test(state)||!cookie||!env.MAIL_TOKEN_KEY)throw Error('invalid_oauth_state');
  const store=new BookingStore(env.DB);await store.init();
  // Atomically consume the nonce before exchanging the code; replay cannot attach another grant.
  const row=await env.DB.prepare('DELETE FROM booking_oauth WHERE id=? AND cookie_hash=? AND expires>? RETURNING owner,verifier').bind(state.slice(8),await opaque('booking-oauth',cookie,env.TOKEN_SECRET),Date.now()).first<{owner:string;verifier:string}>();
  if(!row)throw Error('invalid_oauth_state');
  const code=url.searchParams.get('code');if(!code||code.length>4000||url.searchParams.has('error'))throw Error('invalid_oauth_state');
  const record=await exchangeBookingOAuth(env,url.origin,code,await unseal(row.verifier,env.MAIL_TOKEN_KEY),row.owner);
  await env.BOOKING.getByName(row.owner).saveCalendar(row.owner,record);
  return new Response(null,{status:303,headers:{location:'/booking?calendar=connected','set-cookie':clear,'cache-control':'no-store','referrer-policy':'no-referrer'}});
 }catch{return new Response(null,{status:303,headers:{location:'/booking?calendar=failed','set-cookie':clear,'cache-control':'no-store','referrer-policy':'no-referrer'}});}
}
function next(r:BookingRequestRecord){return r.status==='needs_new_slot'?'select_slot':r.status==='async_submitted'?'async':r.status==='booked'?'booked':r.slotStart?'pending_approval':'select_slot';}
export async function bookingPublicRoute(request:Request,env:BookingEnv):Promise<Response>{
 try{
  const url=new URL(request.url),match=url.pathname.match(/^\/api\/public\/booking\/([a-z0-9-]{3,64})(\/.*)?$/);if(!match)return json({error:'not_found'},404);
  const store=new BookingStore(env.DB);await store.init();const settings=await store.slug(match[1]);if(!settings)return json({error:'not_found'},404);
  const path=match[2]||'',ready=await bookingReadiness(env,settings.owner),available=settings.enabled&&ready.email&&ready.calendar&&ready.pilot;
  if(request.method==='GET'&&!path)return json({page:{displayName:settings.displayName,intro:settings.intro,timezone:settings.timezone,durationMinutes:settings.durationMinutes},available,recoveryAvailable:ready.email&&ready.pilot});
  if(request.method!=='GET'&&request.method!=='POST')return json({error:'not_found'},404);
  if(request.method==='POST')origin(request);
  const statusRead=request.method==='GET'&&(path==='/requests'||/^\/requests\/[\w-]{1,100}$/.test(path));
  const statusVerification=request.method==='POST'&&['/challenge','/verify'].includes(path)&&ready.email&&ready.pilot;
  if(!available&&!statusRead&&!statusVerification)throw Error('booking_unavailable');
  if(request.method==='POST'&&path==='/challenge'){
   const input=await body(request),result=await issueBookingChallenge(env,settings,request,input.email);return json({challengeId:result.challengeId},200,result.cookie);
  }
  if(request.method==='POST'&&path==='/verify'){
   const result=await verifyBookingChallenge(env,settings,request,await body(request));return json({verified:true,email:result.email},200,result.cookie);
  }
  const email=await bookingVisitor(env,settings,request),stub=env.BOOKING.getByName(settings.owner);
  if(path==='/requests'&&request.method==='POST'){
   const r=await stub.submit(settings.owner,email,settings.slug,await body(request));return json({request:publicBookingRequest(r),next:next(r)});
  }
  if(path==='/requests'&&request.method==='GET')return json({requests:(await store.requests(settings.owner)).filter(r=>r.email===email).slice(0,10).map(r=>({request:publicBookingRequest(r),next:next(r)}))});
  if(path==='/slots'&&request.method==='GET')return json({slots:await stub.slots(settings.owner,email,settings.slug,url.searchParams.get('requestId')||'')});
  const record=path.match(/^\/requests\/([\w-]{1,100})(\/slot)?$/);
  if(record){
   if(record[2]&&request.method==='POST'){
    const input=await body(request);if(typeof input.start!=='string'||input.start.length>40)throw Error('invalid_request');
    const r=await stub.selectSlot(settings.owner,email,settings.slug,record[1],input.start);return json({request:publicBookingRequest(r),next:next(r)});
   }
   if(!record[2]&&request.method==='GET'){const r=await store.request(settings.owner,record[1]);if(!r||r.email!==email)throw Error('not_found');return json({request:publicBookingRequest(r),next:next(r)});}
  }
  return json({error:'not_found'},404);
 }catch(e){return bookingError(e);}
}
