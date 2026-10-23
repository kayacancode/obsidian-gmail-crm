import {b64,opaque,seal,unseal} from './mail-model';
import {BookingStore} from './booking-store';
import {createBookingVisitorOAuth,exchangeBookingVisitorOAuth} from './booking-providers';
import type {BookingEnv,BookingSettings,BookingVisitorIdentity} from './booking-types';

const BROWSER='__Host-people-booking-browser',VISITOR='__Host-people-booking-visitor';
const STATE_PREFIX='booking-visitor.';
export const randomBookingToken=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export function bookingCookie(request:Request,name:string){return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';}
export function setBookingCookie(name:string,value:string,seconds:number){return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;}

export async function beginBookingSignIn(env:BookingEnv,settings:BookingSettings,request:Request,input:Record<string,unknown>){
 if(!env.MAIL_TOKEN_KEY||!env.TOKEN_SECRET)throw Error('setup_required');
 const requestId=input.requestId??'';
 if(typeof requestId!=='string'||(requestId&&!/^[\w-]{1,100}$/.test(requestId)))throw Error('invalid_request');
 const store=new BookingStore(env.DB),now=Date.now(),supplied=bookingCookie(request,BROWSER);
 const browser=/^[A-Za-z0-9_-]{43}$/.test(supplied)?supplied:randomBookingToken();
 const browserHash=await opaque('booking-browser',browser,env.TOKEN_SECRET);
 const ip=await opaque('booking-ip',request.headers.get('CF-Connecting-IP')||'unknown',env.TOKEN_SECRET);
 await store.cleanup(now);
 await store.limit('sign-in-ip:'+ip,40,3600000,now);
 await store.limit('sign-in-browser:'+browserHash,12,3600000,now);
 const id=randomBookingToken(),verifier=randomBookingToken();
 const url=await createBookingVisitorOAuth(env,new URL(request.url).origin,STATE_PREFIX+id,verifier);
 await env.DB.batch([
  env.DB.prepare('DELETE FROM booking_visitor_oauth WHERE owner=? AND slug=? AND browser=?').bind(settings.owner,settings.slug,browserHash),
  env.DB.prepare('INSERT INTO booking_visitor_oauth(id,owner,slug,browser,verifier,request_id,expires) VALUES(?,?,?,?,?,?,?)').bind(id,settings.owner,settings.slug,browserHash,await seal(verifier,env.MAIL_TOKEN_KEY),requestId,now+600000),
 ]);
 return {url,cookie:setBookingCookie(BROWSER,browser,86400)};
}

export async function completeBookingSignIn(env:BookingEnv,request:Request):Promise<Response>{
 let destination='',requestId='';
 try{
  const url=new URL(request.url),state=url.searchParams.get('state')||'',browser=bookingCookie(request,BROWSER);
  if(!/^booking-visitor\.[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(browser)||!env.MAIL_TOKEN_KEY)throw Error('invalid_oauth_state');
  const store=new BookingStore(env.DB);await store.init();
  // Atomic consumption binds this callback to the initiating browser and prevents replay.
  const row=await env.DB.prepare('DELETE FROM booking_visitor_oauth WHERE id=? AND browser=? RETURNING owner,slug,verifier,request_id,expires')
   .bind(state.slice(STATE_PREFIX.length),await opaque('booking-browser',browser,env.TOKEN_SECRET)).first<{owner:string;slug:string;verifier:string;request_id:string;expires:number}>();
  if(!row)throw Error('invalid_oauth_state');
  destination='/book/'+encodeURIComponent(row.slug);requestId=row.request_id;
  if(row.expires<=Date.now())throw Error('invalid_oauth_state');
  const settings=await store.slug(row.slug);
  if(!settings||settings.owner!==row.owner||env.BOOKING_OWNER_EMAIL?.toLowerCase()!==row.owner)throw Error('invalid_oauth_state');
  const code=url.searchParams.get('code');if(!code||code.length>4000||url.searchParams.has('error'))throw Error('invalid_oauth_state');
  const identity=await exchangeBookingVisitorOAuth(env,url.origin,code,await unseal(row.verifier,env.MAIL_TOKEN_KEY));
  const subject=await opaque('booking-google-sub',identity.subject,env.TOKEN_SECRET);
  const token=randomBookingToken(),tokenHash=await opaque('booking-google-session',token,env.TOKEN_SECRET);
  await env.DB.prepare('INSERT INTO booking_google_sessions(token_hash,owner,slug,email,subject,email_authoritative,browser,expires) VALUES(?,?,?,?,?,?,?,?)')
   .bind(tokenHash,row.owner,row.slug,identity.email,subject,identity.emailAuthoritative?1:0,await opaque('booking-browser',browser,env.TOKEN_SECRET),Date.now()+3600000).run();
  const params=new URLSearchParams({signed_in:'1'});if(row.request_id)params.set('request',row.request_id);
  return new Response(null,{status:303,headers:{location:destination+'?'+params,'set-cookie':setBookingCookie(VISITOR,token,3600),'cache-control':'no-store','referrer-policy':'no-referrer'}});
 }catch{
  if(destination){const params=new URLSearchParams();if(requestId)params.set('request',requestId);params.set('sign_in','failed');return new Response(null,{status:303,headers:{location:destination+'?'+params,'cache-control':'no-store','referrer-policy':'no-referrer'}});}
  return Response.json({error:'invalid_oauth_state'},{status:400,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
 }
}

export async function bookingVisitor(env:BookingEnv,settings:BookingSettings,request:Request):Promise<BookingVisitorIdentity>{
 const token=bookingCookie(request,VISITOR),browser=bookingCookie(request,BROWSER);
 if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^[A-Za-z0-9_-]{43}$/.test(browser))throw Error('verification_required');
 const hash=await opaque('booking-google-session',token,env.TOKEN_SECRET),browserHash=await opaque('booking-browser',browser,env.TOKEN_SECRET);
 const row=await env.DB.prepare('SELECT email,subject,email_authoritative FROM booking_google_sessions WHERE token_hash=? AND owner=? AND slug=? AND browser=? AND expires>?')
  .bind(hash,settings.owner,settings.slug,browserHash,Date.now()).first<{email:string;subject:string;email_authoritative:number}>();
 if(!row)throw Error('verification_required');return {email:row.email,subject:row.subject,emailAuthoritative:row.email_authoritative===1};
}
