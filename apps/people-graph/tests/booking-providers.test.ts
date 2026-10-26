import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../src/booking-providers';
import {b64, digest, seal, unseal} from '../src/mail-model';
import {bookingCalendarBusy, bookingEventId, cancelBookingEvent, createBookingEvent, createBookingOAuth, exchangeBookingOAuth, findBookingEvent} from '../src/booking-providers';
import type {BookingCalendarRecord, BookingEnv, BookingRequestRecord, BookingSettings} from '../src/booking-types';

const owner='owner@example.com', origin='https://people.example.com', verifier='a'.repeat(43);
const scopes='openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';
const env={GOOGLE_CLIENT_ID:'booking-client',GOOGLE_CLIENT_SECRET:'client-secret',MAIL_TOKEN_KEY:'test-encryption-secret',APP_ORIGIN:origin} as BookingEnv;
const start='2026-11-03T15:00:00.000Z', end='2026-11-03T15:30:00.000Z';
const keyPair=crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
async function identity(overrides:Record<string,unknown>={}){
 const keys=await keyPair, now=Math.floor(Date.now()/1000);
 const head=b64(new TextEncoder().encode(JSON.stringify({alg:'RS256',kid:'test-key',typ:'JWT'})));
 const body=b64(new TextEncoder().encode(JSON.stringify({iss:'https://accounts.google.com',aud:env.GOOGLE_CLIENT_ID,sub:'google-owner',email:owner,email_verified:true,iat:now,exp:now+3600,nonce:await digest(verifier),...overrides})));
 const signature=b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(head+'.'+body))));
 return head+'.'+body+'.'+signature;
}
async function record():Promise<BookingCalendarRecord>{return {owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'booking-refresh',scopes:scopes.split(' ')}),env.MAIL_TOKEN_KEY!)};}
const refresh=()=>Response.json({access_token:'calendar-access',token_type:'Bearer',expires_in:3600,scope:scopes});
function mockFetch(t:TestContext, handler:(url:string,init:RequestInit)=>Promise<Response>|Response){t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init:RequestInit={})=>handler(String(input),init));}
async function oauthMock(t:TestContext, overrides:Record<string,unknown>={}, claims:Record<string,unknown>={}){
 const id=await identity(claims), jwk=await crypto.subtle.exportKey('jwk',(await keyPair).publicKey);
 mockFetch(t, (url,init)=>{
  if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[{...jwk,kid:'test-key',use:'sig',alg:'RS256'}]});
  assert.equal(url,'https://oauth2.googleapis.com/token');
  const body=new URLSearchParams(init.body as string);assert.equal(body.get('code_verifier'),verifier);assert.equal(body.get('redirect_uri'),origin+'/api/accounts/callback');
  return Response.json({access_token:'calendar-access',refresh_token:'booking-refresh',token_type:'Bearer',expires_in:3600,scope:scopes,id_token:id,...overrides});
 });
}

test('booking OAuth separates Calendar permission from Gmail and binds PKCE to the registered callback',async()=>{
 const url=new URL(await createBookingOAuth(env,origin,'server-state',verifier));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('redirect_uri'),origin+'/api/accounts/callback');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('code_challenge'),await digest(verifier));
 assert.equal(url.searchParams.get('state'),'server-state');assert.equal(url.searchParams.get('nonce'),await digest(verifier));
 const requested=url.searchParams.get('scope')!.split(' ');assert.ok(requested.includes('https://www.googleapis.com/auth/calendar.events'));assert.ok(requested.includes('https://www.googleapis.com/auth/calendar.freebusy'));assert.ok(!requested.some(s=>s.includes('gmail')));
 assert.notEqual(url.searchParams.get('include_granted_scopes'),'true');
 await assert.rejects(createBookingOAuth(env,'https://attacker.example','state',verifier));
});
test('booking OAuth stores only an encrypted owner-bound refresh grant after signed identity validation',async t=>{
 await oauthMock(t);const result=await exchangeBookingOAuth(env,origin,'code',verifier,owner);
 assert.equal(result.owner,owner);assert.equal(result.email,owner);assert.ok(!result.grant.includes('booking-refresh'));
 const decrypted=JSON.parse(await unseal(result.grant,env.MAIL_TOKEN_KEY!));assert.equal(decrypted.refreshToken,'booking-refresh');assert.equal(decrypted.owner,owner);assert.equal(decrypted.access_token,undefined);assert.equal(decrypted.id_token,undefined);
});
for(const [label,claims] of Object.entries({owner:{email:'other@example.com'},verified:{email_verified:false},audience:{aud:'other-client'},issuer:{iss:'https://attacker.example'},expiry:{exp:1},nonce:{nonce:'other-nonce'}})){
 test('booking OAuth rejects incorrect '+label,async t=>{await oauthMock(t,{},claims);await assert.rejects(exchangeBookingOAuth(env,origin,'code',verifier,owner));});
}
test('booking OAuth rejects forged signatures',async t=>{
 const signed=await identity();await oauthMock(t,{id_token:signed.slice(0,signed.lastIndexOf('.')+1)+'A'.repeat(342)});
 await assert.rejects(exchangeBookingOAuth(env,origin,'code',verifier,owner));
});
for(const [label,overrides] of Object.entries({scope:{scope:'openid email https://www.googleapis.com/auth/calendar.events.readonly'},refresh:{refresh_token:undefined},access:{access_token:''}})){
 test('booking OAuth rejects missing '+label+' capability',async t=>{await oauthMock(t,overrides);await assert.rejects(exchangeBookingOAuth(env,origin,'code',verifier,owner));});
}
test('calendar availability returns validated intervals from the owner primary calendar',async t=>{
 mockFetch(t,(url,init)=>{if(url.includes('/token'))return refresh();assert.equal(init.headers&&new Headers(init.headers).get('authorization'),'Bearer calendar-access');assert.deepEqual(JSON.parse(init.body as string).items,[{id:'primary'}]);return Response.json({kind:'calendar#freeBusy',timeMin:start,timeMax:end,calendars:{primary:{busy:[{start,end}]}}});});
 assert.deepEqual(await bookingCalendarBusy(env,await record(),start,end),[{start,end}]);
});
for(const [label,payload] of Object.entries({missing:{calendars:{}},errors:{calendars:{primary:{errors:[{domain:'global',reason:'notFound'}],busy:[]}}},malformed:{calendars:{primary:{busy:[{start:'bad',end}]}}},absent:{calendars:{primary:{}}},reverse:{calendars:{primary:{busy:[{start:end,end:start}]}}},rollover:{calendars:{primary:{busy:[{start:'2026-02-30T15:00:00Z',end:'2026-03-03T15:00:00Z'}]}}}})){
 test('calendar availability fails closed on '+label+' data',async t=>{mockFetch(t,url=>url.includes('/token')?refresh():Response.json({kind:'calendar#freeBusy',timeMin:start,timeMax:end,...payload}));await assert.rejects(bookingCalendarBusy(env,await record(),start,end));});
}
test('calendar grant cannot be reassigned to a different owner',async t=>{
 let fetched=false;mockFetch(t,()=>{fetched=true;return refresh();});const stored=await record();await assert.rejects(bookingCalendarBusy(env,{...stored,owner:'other@example.com',email:'other@example.com'},start,end));assert.equal(fetched,false);
});
test('calendar provider rejects oversized bodies and revoked refresh credentials without leaking response details',async t=>{
 mockFetch(t,url=>url.includes('/token')?refresh():Response.json({padding:'x'.repeat(300_000)}));await assert.rejects(bookingCalendarBusy(env,await record(),start,end));
 t.mock.restoreAll();mockFetch(t,()=>Response.json({error:'invalid_grant',error_description:'secret account'}, {status:400}));await assert.rejects(bookingCalendarBusy(env,await record(),start,end),e=>e instanceof Error&&!e.message.includes('secret'));
});
async function booking(){return {id:'request-123',owner,email:'visitor@example.com',name:'<Visitor>\nName',project:'A project & <script>bad</script>',purpose:'Discuss collaboration',projectUrl:'https://private.example',referrer:'Private referrer',slotStart:start,slotEnd:end,eventId:await bookingEventId('request-123'),status:'booking',decision:{reasons:['PRIVATE REASON'],people:{reason:'PRIVATE GRAPH'}}} as BookingRequestRecord;}
const settings={owner,displayName:'Kaya',timezone:'America/New_York',durationMinutes:30} as BookingSettings;
test('booking event IDs are stable Google-valid identifiers that do not expose request IDs',async()=>{
 const id=await bookingEventId('request-123');assert.match(id,/^[0-9a-v]{5,1024}$/);assert.equal(id,await bookingEventId('request-123'));assert.notEqual(id,await bookingEventId('request-124'));assert.ok(!id.includes('request'));
});
test('calendar event includes only bounded visitor context and sends updates to the verified email',async t=>{
 const request=await booking();mockFetch(t,(url,init)=>{if(url.includes('/token'))return refresh();assert.ok(url.endsWith('/calendars/primary/events?sendUpdates=all'));const payload=JSON.parse(init.body as string);assert.equal(payload.id,request.eventId);assert.deepEqual(payload.attendees,[{email:'visitor@example.com'}]);assert.equal(payload.start.dateTime,start);assert.equal(payload.end.dateTime,end);assert.equal(payload.visibility,'private');assert.equal(payload.guestsCanInviteOthers,false);const json=JSON.stringify(payload);assert.ok(!json.includes('PRIVATE'));assert.ok(!json.includes('private.example'));assert.ok(!json.includes('referrer'));assert.ok(!payload.description.includes('<script>'));return Response.json({id:request.eventId,status:'confirmed'});});
 assert.deepEqual(await createBookingEvent(env,await record(),request,settings),{id:request.eventId});
});
for(const mode of ['conflict','timeout'])test('calendar creation reconciles '+mode+' using the persisted event ID',async t=>{
 const request=await booking();let inserts=0;mockFetch(t,(url,init)=>{if(url.includes('/token'))return refresh();if(init.method==='POST'){inserts++;if(mode==='timeout')throw new DOMException('timed out','TimeoutError');return Response.json({error:{code:409}},{status:409});}assert.ok(url.includes('/events/'+request.eventId));return Response.json({id:request.eventId,status:'confirmed'});});
 assert.deepEqual(await createBookingEvent(env,await record(),request,settings),{id:request.eventId});assert.equal(inserts,1);
});
test('calendar creation does not claim success when event reconciliation is cancelled',async t=>{
 const request=await booking();mockFetch(t,(url,init)=>url.includes('/token')?refresh():init.method==='POST'?Response.json({error:{code:409}},{status:409}):Response.json({id:request.eventId,status:'cancelled'}));await assert.rejects(createBookingEvent(env,await record(),request,settings));
});
test('calendar creation keeps an uncertain result when recovery finds no event',async t=>{
 const request=await booking();mockFetch(t,(url,init)=>url.includes('/token')?refresh():new Response(null,{status:init.method==='POST'?503:404}));
 await assert.rejects(createBookingEvent(env,await record(),request,settings));
});
test('calendar lookup never confirms a different or tentative event',async t=>{
 const stored=await record(),id=await bookingEventId('request-123');
 for(const event of [{id:'other-event',status:'confirmed'},{id,status:'tentative'},{id}]){
  t.mock.restoreAll();mockFetch(t,url=>url.includes('/token')?refresh():Response.json(event));await assert.rejects(findBookingEvent(env,stored,id));
 }
});
test('calendar event requires a persisted matching ID and matching owner before any external action',async t=>{
 let fetched=false;mockFetch(t,()=>{fetched=true;return refresh();});const request=await booking(),stored=await record();await assert.rejects(createBookingEvent(env,stored,{...request,eventId:null},settings));await assert.rejects(createBookingEvent(env,stored,{...request,owner:'other@example.com'},settings));assert.equal(fetched,false);
});
test('calendar event lookup distinguishes not found from provider failure',async t=>{
 const stored=await record(),id=await bookingEventId('request-123');mockFetch(t,url=>url.includes('/token')?refresh():new Response(null,{status:404}));assert.equal(await findBookingEvent(env,stored,id),null);
 t.mock.restoreAll();mockFetch(t,url=>url.includes('/token')?refresh():new Response(null,{status:503}));await assert.rejects(findBookingEvent(env,stored,id));
});
test('calendar cancellation sends attendee updates and tolerates an already deleted event',async t=>{
 const stored=await record(),id=await bookingEventId('request-123');mockFetch(t,(url,init)=>{if(url.includes('/token'))return refresh();assert.equal(init.method,'DELETE');assert.ok(url.endsWith('/events/'+id+'?sendUpdates=all'));return new Response(null,{status:410});});await cancelBookingEvent(env,stored,id);
});
test('calendar cancellation fails when Google does not acknowledge deletion',async t=>{
 mockFetch(t,url=>url.includes('/token')?refresh():new Response(null,{status:503}));await assert.rejects(cancelBookingEvent(env,await record(),await bookingEventId('request-123')));
});
test('calendar availability rejects a response for a different query interval',async t=>{
 mockFetch(t,url=>url.includes('/token')?refresh():Response.json({kind:'calendar#freeBusy',timeMin:'2026-01-01T00:00:00Z',timeMax:'2026-01-02T00:00:00Z',calendars:{primary:{busy:[]}}}));
 await assert.rejects(bookingCalendarBusy(env,await record(),start,end));
});
test('calendar availability deadline also bounds a stalled response body and aborts the request',async t=>{
 const nativeTimeout=globalThis.setTimeout;let signal:AbortSignal|undefined;
 t.mock.method(globalThis,'setTimeout',(handler:()=>void)=>nativeTimeout(handler,20));
 mockFetch(t,(url,init)=>{if(url.includes('/token'))return refresh();signal=init.signal!;return new Response(new ReadableStream({start(controller){signal!.addEventListener('abort',()=>controller.error(Error('aborted')),{once:true});}}),{headers:{'content-type':'application/json'}});});
 await assert.rejects(bookingCalendarBusy(env,await record(),start,end));assert.equal(signal?.aborted,true);
});
test('visitor Google sign-in requests only identity with online access and PKCE',async()=>{
 const url=new URL(await providers.createBookingVisitorOAuth(env,origin,'booking-visitor.state',verifier));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('scope'),'openid email');
 assert.equal(url.searchParams.get('access_type'),'online');assert.equal(url.searchParams.get('prompt'),'select_account');
 assert.equal(url.searchParams.get('include_granted_scopes'),'false');assert.equal(url.searchParams.get('redirect_uri'),origin+'/api/accounts/callback');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('code_challenge'),await digest(verifier));
 assert.equal(url.searchParams.get('nonce'),await digest(verifier));assert.equal(url.searchParams.get('state'),'booking-visitor.state');
 await assert.rejects(providers.createBookingVisitorOAuth(env,'https://attacker.example','state',verifier));
});
test('visitor Google sign-in accepts a different account without a refresh grant and returns identity only',async t=>{
 await oauthMock(t,{scope:'openid email',refresh_token:undefined},{email:'Visitor@gmail.com',sub:'visitor-sub'});
 assert.deepEqual(await providers.exchangeBookingVisitorOAuth(env,origin,'code',verifier),{email:'visitor@gmail.com',subject:'visitor-sub',emailAuthoritative:true});
});
test('visitor identity distinguishes Workspace and external-email Google accounts',async t=>{
 await oauthMock(t,{scope:'openid email',refresh_token:undefined},{email:'visitor@example.com',sub:'visitor-sub',hd:'example.com'});
 assert.equal((await providers.exchangeBookingVisitorOAuth(env,origin,'code',verifier)).emailAuthoritative,true);
 t.mock.restoreAll();await oauthMock(t,{scope:'openid email',refresh_token:undefined},{email:'visitor@example.com',sub:'visitor-sub'});
 assert.equal((await providers.exchangeBookingVisitorOAuth(env,origin,'code',verifier)).emailAuthoritative,false);
});
for(const [label,claims] of Object.entries({verified:{email_verified:false},audience:{aud:'other-client'},issuer:{iss:'https://attacker.example'},expiry:{exp:1},nonce:{nonce:'other-nonce'},subject:{sub:''},authorizedParty:{azp:'attacker'},futureIssued:{iat:Math.floor(Date.now()/1000)+900},invalidExpiry:{exp:'forever'}})){
 test('visitor Google sign-in rejects incorrect '+label,async t=>{await oauthMock(t,{scope:'openid email'},claims);await assert.rejects(providers.exchangeBookingVisitorOAuth(env,origin,'code',verifier));});
}
test('visitor Google sign-in rejects a forged identity',async t=>{
 const signed=await identity();await oauthMock(t,{id_token:signed.slice(0,signed.lastIndexOf('.')+1)+'A'.repeat(342)});
 await assert.rejects(providers.exchangeBookingVisitorOAuth(env,origin,'code',verifier));
});
