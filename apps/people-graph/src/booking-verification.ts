import {b64,opaque} from './mail-model';
import {BookingStore} from './booking-store';
import {normalizeBookingEmail} from './booking-policy';
import {sendBookingCode} from './booking-providers';
import type {BookingEnv,BookingSettings} from './booking-types';

const BROWSER='__Host-people-booking-browser',VISITOR='__Host-people-booking-visitor';
export const randomBookingToken=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export function bookingCookie(request:Request,name:string){return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';}
export function setBookingCookie(name:string,value:string,seconds:number){return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;}
export async function issueBookingChallenge(env:BookingEnv,settings:BookingSettings,request:Request,input:unknown){
 const email=normalizeBookingEmail(input),store=new BookingStore(env.DB),now=Date.now();
 const supplied=bookingCookie(request,BROWSER),browser=/^[A-Za-z0-9_-]{43}$/.test(supplied)?supplied:randomBookingToken();
 const browserHash=await opaque('booking-browser',browser,env.TOKEN_SECRET);
 const ip=await opaque('booking-ip',request.headers.get('CF-Connecting-IP')||'unknown',env.TOKEN_SECRET);
 await store.cleanup(now);
 await store.limit('issue-ip:'+ip,20,3600000,now);
 await store.limit('issue-browser:'+browserHash,10,3600000,now);
 await store.limit('issue-email:'+await opaque(settings.owner,email,env.TOKEN_SECRET),5,3600000,now);
 const id=randomBookingToken();
 let random=0;do{random=crypto.getRandomValues(new Uint32Array(1))[0];}while(random>=4294000000);
 const code=String(random%1000000).padStart(6,'0'),hash=await opaque('booking-code',id+':'+code,env.TOKEN_SECRET);
 // A resend invalidates older challenges for this browser/email, limiting guess budgets.
 await env.DB.batch([
  env.DB.prepare('DELETE FROM booking_challenges WHERE owner=? AND email=? AND browser=?').bind(settings.owner,email,browserHash),
  env.DB.prepare('INSERT INTO booking_challenges(id,owner,slug,email,browser,code_hash,expires) VALUES(?,?,?,?,?,?,?)').bind(id,settings.owner,settings.slug,email,browserHash,hash,now+600000),
 ]);
 try{await sendBookingCode(env,email,code,settings.displayName);}catch{await env.DB.prepare('DELETE FROM booking_challenges WHERE id=?').bind(id).run();throw Error('email_unavailable');}
 return {challengeId:id,cookie:setBookingCookie(BROWSER,browser,86400)};
}
export async function verifyBookingChallenge(env:BookingEnv,settings:BookingSettings,request:Request,input:Record<string,unknown>){
 if(typeof input.challengeId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.challengeId)||typeof input.code!=='string'||!/^\d{6}$/.test(input.code))throw Error('invalid_code');
 const browser=bookingCookie(request,BROWSER);if(!browser)throw Error('invalid_code');
 const browserHash=await opaque('booking-browser',browser,env.TOKEN_SECRET),now=Date.now();
 const hash=await opaque('booking-code',input.challengeId+':'+input.code,env.TOKEN_SECRET);
 const row=await env.DB.prepare(`UPDATE booking_challenges SET attempts=attempts+1,used=CASE WHEN code_hash=? THEN 1 ELSE 0 END
  WHERE id=? AND owner=? AND slug=? AND browser=? AND expires>? AND attempts<5 AND used=0 RETURNING email,used`)
  .bind(hash,input.challengeId,settings.owner,settings.slug,browserHash,now).first<{email:string;used:number}>();
 if(!row?.used)throw Error('invalid_code');
 const token=randomBookingToken(),tokenHash=await opaque('booking-session',token,env.TOKEN_SECRET);
 await env.DB.prepare('INSERT INTO booking_sessions(token_hash,owner,slug,email,browser,expires) VALUES(?,?,?,?,?,?)').bind(tokenHash,settings.owner,settings.slug,row.email,browserHash,now+3600000).run();
 return {email:row.email,cookie:setBookingCookie(VISITOR,token,3600)};
}
export async function bookingVisitor(env:BookingEnv,settings:BookingSettings,request:Request):Promise<string>{
 const token=bookingCookie(request,VISITOR),browser=bookingCookie(request,BROWSER);if(!token||!browser)throw Error('verification_required');
 const hash=await opaque('booking-session',token,env.TOKEN_SECRET),browserHash=await opaque('booking-browser',browser,env.TOKEN_SECRET);
 const row=await env.DB.prepare('SELECT email FROM booking_sessions WHERE token_hash=? AND owner=? AND slug=? AND browser=? AND expires>?').bind(hash,settings.owner,settings.slug,browserHash,Date.now()).first<{email:string}>();
 if(!row)throw Error('verification_required');return row.email;
}
