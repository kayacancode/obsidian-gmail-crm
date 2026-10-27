import {boundedJSON} from './bounded-json';
import {bytes, digest, seal, unseal} from './mail-model';
import type {BookingBusy, BookingCalendarRecord, BookingEnv, BookingRequestRecord, BookingSettings, BookingVisitorIdentity} from './booking-types';

const TOKEN_URL='https://oauth2.googleapis.com/token';
// Google's OpenID discovery document publishes this signing-key endpoint.
const KEYS_URL='https://www.googleapis.com/oauth2/v3/certs';
const CALENDAR_URL='https://www.googleapis.com/calendar/v3';
const EVENTS_SCOPE='https://www.googleapis.com/auth/calendar.events';
const BUSY_SCOPE='https://www.googleapis.com/auth/calendar.freebusy';
const SCOPES=['openid','email',EVENTS_SCOPE,BUSY_SCOPE];
const TIMEOUT_MS=10_000;
type ObjectValue=Record<string,unknown>;
type CalendarGrant={owner:string;email:string;refreshToken:string;scopes:string[]};

function object(value:unknown):ObjectValue {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('booking_provider_invalid_response');
 return value as ObjectValue;
}
function string(value:unknown,max:number):value is string{return typeof value==='string'&&value.length>0&&value.length<=max;}
function email(value:unknown):string {
 if(!string(value,254)||! /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(value))throw Error('booking_email_invalid');
 return value.toLowerCase();
}
function safeText(value:string,max:number):string{return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function html(value:string):string{return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
function credentials(env:BookingEnv):{clientId:string;clientSecret:string;key:string} {
 if(!string(env.GOOGLE_CLIENT_ID,1024)||!string(env.GOOGLE_CLIENT_SECRET,4096)||!string(env.MAIL_TOKEN_KEY,4096))throw Error('booking_calendar_not_configured');
 return {clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,key:env.MAIL_TOKEN_KEY};
}
function callback(env:BookingEnv,origin:string):string {
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.origin!==origin||env.APP_ORIGIN!==origin)throw Error('booking_oauth_invalid_origin');
 return origin+'/api/accounts/callback';
}
function validVerifier(verifier:string){if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw Error('booking_oauth_invalid_verifier');}
function permissionScopes(value:unknown):string[] {
 if(!string(value,4096))throw Error('booking_calendar_permission_missing');
 const scopes=value.split(/\s+/);
 if(!scopes.includes(EVENTS_SCOPE)||!scopes.includes(BUSY_SCOPE))throw Error('booking_calendar_permission_missing');
 return scopes;
}
async function deadline<T>(operation:()=>Promise<T>,failure:string):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(failure)),TIMEOUT_MS);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
// Deadline covers both receiving headers and reading the bounded response body.
async function provider(url:string,init:RequestInit={},maxBytes=32_768):Promise<{status:number;data:ObjectValue|null}> {
 const controller=new AbortController();
 try{return await deadline(async()=>{
  const response=await fetch(url,{...init,redirect:'manual',signal:controller.signal});
  if(!response.ok||response.status===204){await response.body?.cancel().catch(()=>{});return {status:response.status,data:null};}
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){await response.body?.cancel().catch(()=>{});throw Error('booking_provider_invalid_response');}
  return {status:response.status,data:object(await boundedJSON(response,maxBytes))};
 },'booking_provider_unavailable');}
 catch{throw Error('booking_provider_unavailable');}
 finally{controller.abort();}
}
function success(result:{status:number;data:ObjectValue|null}):ObjectValue {
 if(result.status===401||result.status===403)throw Error('booking_calendar_reconnect_required');
 if(result.status<200||result.status>=300||!result.data)throw Error('booking_provider_unavailable');
 return result.data;
}
function accessToken(data:ObjectValue):string {
 if(!string(data.access_token,8192)||/[\s\u0000-\u001f]/.test(data.access_token)||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>86_400)throw Error('booking_provider_invalid_response');
 return data.access_token;
}

export async function createBookingOAuth(env:BookingEnv,origin:string,state:string,verifier:string):Promise<string> {
 const config=credentials(env),redirect=callback(env,origin);validVerifier(verifier);
 if(!string(state,2000)||/[\u0000-\u001f]/.test(state))throw Error('booking_oauth_invalid_state');
 const challenge=await digest(verifier),url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
 const params={client_id:config.clientId,redirect_uri:redirect,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent select_account',include_granted_scopes:'false',state,nonce:challenge,code_challenge:challenge,code_challenge_method:'S256'};
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
 return url.href;
}

/** Visitor authentication requests identity only, with no Calendar grant. */
export async function createBookingVisitorOAuth(env:BookingEnv,origin:string,state:string,verifier:string):Promise<string> {
 const url=new URL(await createBookingOAuth(env,origin,state,verifier));
 url.searchParams.set('scope','openid email');url.searchParams.set('access_type','online');url.searchParams.set('prompt','select_account');
 return url.href;
}

function jwtPart(value:string):ObjectValue {
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('booking_oauth_invalid_identity');
 return object(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes(value))));
}
async function verifyIdentity(token:unknown,clientId:string,verifier:string):Promise<BookingVisitorIdentity> {
 try{
  if(!string(token,16_384))throw Error();
  const parts=token.split('.');if(parts.length!==3||! /^[A-Za-z0-9_-]+$/.test(parts[2]))throw Error();
  const header=jwtPart(parts[0]),claims=jwtPart(parts[1]),now=Math.floor(Date.now()/1000);
  if(header.alg!=='RS256'||!string(header.kid,256)||claims.aud!==clientId||(claims.azp!==undefined&&claims.azp!==clientId)||(claims.iss!=='https://accounts.google.com'&&claims.iss!=='accounts.google.com')||claims.email_verified!==true||!string(claims.sub,255)||typeof claims.exp!=='number'||!Number.isFinite(claims.exp)||claims.exp<=now||typeof claims.iat!=='number'||!Number.isFinite(claims.iat)||claims.iat>now+300||claims.iat<now-86_400||claims.nonce!==await digest(verifier))throw Error();
  const data=success(await provider(KEYS_URL)),keys=data.keys;
  if(!Array.isArray(keys)||keys.length>32)throw Error();
  const matches=keys.map(object).filter(key=>key.kid===header.kid);
  if(matches.length!==1)throw Error();
  const key=matches[0];if(key.kty!=='RSA'||key.use!=='sig'||key.alg!=='RS256'||!string(key.n,2048)||!string(key.e,16)||key.d!==undefined)throw Error();
  const publicKey=await crypto.subtle.importKey('jwk',{kty:'RSA',n:key.n,e:key.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,bytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw Error();
  const address=email(claims.email);
  return {email:address,subject:claims.sub,emailAuthoritative:address.endsWith('@gmail.com')||string(claims.hd,253)};
 }catch{throw Error('booking_oauth_invalid_identity');}
}

export async function exchangeBookingOAuth(env:BookingEnv,origin:string,code:string,verifier:string,owner:string):Promise<BookingCalendarRecord> {
 const config=credentials(env),redirect=callback(env,origin),account=email(owner);validVerifier(verifier);
 if(!string(code,4096))throw Error('booking_oauth_invalid_code');
 const data=success(await provider(TOKEN_URL,{method:'POST',body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:redirect,grant_type:'authorization_code',code,code_verifier:verifier})}));
 accessToken(data);const scopes=permissionScopes(data.scope);
 if(!string(data.refresh_token,8192))throw Error('booking_calendar_offline_access_missing');
 if((await verifyIdentity(data.id_token,config.clientId,verifier)).email!==account)throw Error('booking_oauth_invalid_identity');
 const grant:CalendarGrant={owner:account,email:account,refreshToken:data.refresh_token,scopes};
 return {owner:account,email:account,grant:await seal(JSON.stringify(grant),config.key),connectedAt:Date.now()};
}

export async function exchangeBookingVisitorOAuth(env:BookingEnv,origin:string,code:string,verifier:string):Promise<BookingVisitorIdentity> {
 const config=credentials(env),redirect=callback(env,origin);validVerifier(verifier);
 if(!string(code,4096))throw Error('booking_oauth_invalid_code');
 const data=success(await provider(TOKEN_URL,{method:'POST',body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:redirect,grant_type:'authorization_code',code,code_verifier:verifier})}));
 // Identity is the only retained result. Access/refresh tokens are discarded.
 return verifyIdentity(data.id_token,config.clientId,verifier);
}

async function calendarAccess(env:BookingEnv,record:BookingCalendarRecord):Promise<string> {
 const config=credentials(env);let grant:ObjectValue;
 try{
  if(!string(record.grant,32_768)||email(record.owner)!==email(record.email))throw Error();
  grant=object(JSON.parse(await unseal(record.grant,config.key)));
  if(grant.owner!==record.owner||grant.email!==record.email||!string(grant.refreshToken,8192)||!Array.isArray(grant.scopes)||!grant.scopes.every(scope=>string(scope,512)))throw Error();
  permissionScopes(grant.scopes.join(' '));
 }catch{throw Error('booking_calendar_reconnect_required');}
 const response=await provider(TOKEN_URL,{method:'POST',body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,refresh_token:grant.refreshToken as string,grant_type:'refresh_token'})});
 if(response.status===400)throw Error('booking_calendar_reconnect_required');
 const data=success(response);if(data.scope!==undefined)permissionScopes(data.scope);
 return accessToken(data);
}
function instant(value:unknown):string {
 if(!string(value,40)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('booking_calendar_invalid_time');
 // Date.parse normalizes nonexistent dates (for example February 30).
 const local=new Date(value.slice(0,19)+'Z');
 if(!Number.isFinite(local.getTime())||local.toISOString().slice(0,19)!==value.slice(0,19))throw Error('booking_calendar_invalid_time');
 return new Date(value).toISOString();
}
function interval(start:unknown,end:unknown):BookingBusy {
 const result={start:instant(start),end:instant(end)};
 if(result.start>=result.end)throw Error('booking_calendar_invalid_time');
 return result;
}
function authorization(access:string){return {authorization:'Bearer '+access,'content-type':'application/json'};}

export async function bookingCalendarBusy(env:BookingEnv,record:BookingCalendarRecord,start:string,end:string):Promise<BookingBusy[]> {
 const range=interval(start,end);
 if(Date.parse(range.end)-Date.parse(range.start)>93*86_400_000)throw Error('booking_calendar_invalid_time');
 const access=await calendarAccess(env,record),data=success(await provider(CALENDAR_URL+'/freeBusy',{method:'POST',headers:authorization(access),body:JSON.stringify({timeMin:range.start,timeMax:range.end,timeZone:'UTC',items:[{id:'primary'}]})},262_144));
 if(data.kind!=='calendar#freeBusy'||instant(data.timeMin)!==range.start||instant(data.timeMax)!==range.end)throw Error('booking_calendar_unavailable');
 const calendars=object(data.calendars),calendar=object(calendars.primary);
 if(data.error||(calendar.errors!==undefined&&(!Array.isArray(calendar.errors)||calendar.errors.length))||!Array.isArray(calendar.busy)||calendar.busy.length>5000)throw Error('booking_calendar_unavailable');
 return calendar.busy.map(value=>{const item=object(value);return interval(item.start,item.end);});
}

export async function bookingEventId(requestId:string):Promise<string> {
 if(!string(requestId,256))throw Error('booking_calendar_invalid_request');
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('people-booking\0'+requestId)));
 return 'b'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
}
function validEventId(eventId:string){if(!/^b[0-9a-f]{64}$/.test(eventId))throw Error('booking_calendar_invalid_event');}
function eventResult(data:ObjectValue,eventId:string):{id:string}|null {
 if(data.id!==eventId)throw Error('booking_calendar_invalid_event');
 if(data.status==='cancelled')return null;
 if(data.status!=='confirmed')throw Error('booking_calendar_unconfirmed_event');
 return {id:eventId};
}
async function lookup(access:string,eventId:string):Promise<{id:string}|null> {
 const result=await provider(CALENDAR_URL+'/calendars/primary/events/'+eventId,{headers:authorization(access)});
 if(result.status===404||result.status===410)return null;
 return eventResult(success(result),eventId);
}

export async function findBookingEvent(env:BookingEnv,record:BookingCalendarRecord,eventId:string):Promise<{id:string}|null> {
 validEventId(eventId);return lookup(await calendarAccess(env,record),eventId);
}

export async function createBookingEvent(env:BookingEnv,record:BookingCalendarRecord,request:BookingRequestRecord,settings:BookingSettings):Promise<{id:string}> {
 if(request.owner!==record.owner||settings.owner!==record.owner||request.status!=='booking'||!request.eventId||request.eventId!==await bookingEventId(request.id))throw Error('booking_calendar_invalid_request');
 const range=interval(request.slotStart,request.slotEnd),attendee=email(request.email);
 const guestInput=request.scheduling?.input.attendees??[attendee];
 if(!Array.isArray(guestInput)||guestInput.length<1||guestInput.length>5)throw Error('booking_calendar_invalid_request');
 const guests=[...new Set(guestInput.map(email))];
 if(!guests.includes(attendee)||(guests.length>1&&(guests.includes(record.owner)||request.scheduling?.authority.channel!=='owner_email')))throw Error('booking_calendar_invalid_request');
 if(Date.parse(range.end)-Date.parse(range.start)!==settings.durationMinutes*60_000)throw Error('booking_calendar_invalid_time');
 try{new Intl.DateTimeFormat('en',{timeZone:settings.timezone});}catch{throw Error('booking_calendar_invalid_time');}
 const name=safeText(request.name,120),host=safeText(settings.displayName,120);
 const event={id:request.eventId,summary:safeText(`${host||'Meeting'} with ${name||attendee}`,250),description:html(`Name: ${name}\nProject: ${safeText(request.project,1200)}\nPurpose: ${safeText(request.purpose,1200)}`),start:{dateTime:range.start,timeZone:settings.timezone},end:{dateTime:range.end,timeZone:settings.timezone},attendees:guests.map(email=>({email})),visibility:'private',transparency:'opaque',guestsCanInviteOthers:false,guestsCanModify:false,guestsCanSeeOtherGuests:false};
 const access=await calendarAccess(env,record);
 try{
  const response=await provider(CALENDAR_URL+'/calendars/primary/events?sendUpdates=all',{method:'POST',headers:authorization(access),body:JSON.stringify(event)});
  if(response.status!==409&&response.status<500){const result=eventResult(success(response),request.eventId);if(result)return result;throw Error('booking_calendar_unconfirmed_event');}
 }catch{
  // The insert may have committed even if the response was lost or malformed.
  const recovered=await lookup(access,request.eventId);if(recovered)return recovered;
  throw Error('booking_calendar_unconfirmed_event');
 }
 const recovered=await lookup(access,request.eventId);if(recovered)return recovered;
 throw Error('booking_calendar_unconfirmed_event');
}

export async function cancelBookingEvent(env:BookingEnv,record:BookingCalendarRecord,eventId:string):Promise<void> {
 validEventId(eventId);const access=await calendarAccess(env,record);
 const response=await provider(CALENDAR_URL+'/calendars/primary/events/'+eventId+'?sendUpdates=all',{method:'DELETE',headers:authorization(access)});
 if(response.status!==204&&response.status!==404&&response.status!==410)throw Error('booking_calendar_cancel_failed');
}
