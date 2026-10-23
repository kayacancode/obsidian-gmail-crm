import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Production routing, D1, SQLite coordinator, verification and provider code.
// External providers use fixtures. Email ingress, routing, D1 and both SQLite coordinators run in workerd; no real mail or invitations are sent.
const fixture=`
import worker from './src/index';
import {BookingCoordinator as Coordinator} from './src/booking-coordinator';
import {SchedulingEmailCoordinator as EmailCoordinator} from './src/scheduling-email-coordinator';
import {BookingStore} from './src/booking-store';
import {defaultBookingSettings} from './src/booking-policy';
import {makeSession,sessionCookie} from './src/session';
import {seal} from './src/mail-model';
import {bookingCalendarBusy} from './src/booking-providers';
import {bookingReadiness} from './src/booking-coordinator';
const owner='owner@example.com';
function wrap(env){return {...env,AI:{async run(){const row=await env.DB.prepare("SELECT body FROM fixture_control WHERE key='__model' ORDER BY rowid DESC LIMIT 1").first();if(!row)throw Error('model unavailable');return {output_text:row.body};}},MAIL:{getByName(scopedOwner){return {bindOwner:async()=>{},verifySchedulingKickoff:async(messageId,agentAddress)=>{const row=await env.DB.prepare('SELECT body FROM fixture_control WHERE key=? ORDER BY rowid DESC LIMIT 1').bind('__kickoff:'+messageId).first();if(!row)throw Error('invalid_owner_kickoff');return JSON.parse(row.body);},getOwnerLens:async()=>({fields:{focus:'Agent interfaces',needs:'Founders',offers:'Product feedback'}}),bookingContact:async(email)=>{const row=await env.DB.prepare('SELECT body FROM fixture_control WHERE key=? ORDER BY rowid DESC LIMIT 1').bind('__contact:'+scopedOwner+':'+email).first();if(!row)return null;const value=JSON.parse(row.body);if(value.fail)throw Error('private source failure');return value;}}}}};}
function emailWrap(env){return {...wrap(env),SCHEDULING_EMAIL_ADDRESS:'scheduling@agent.test',SCHEDULING_EMAIL_REPLY_DOMAIN:'agent.test',SCHEDULING_EMAIL_SEND:{async send(message){const id='<'+crypto.randomUUID()+'@mail.test>';await env.DB.prepare('INSERT INTO fixture_control(key,body) VALUES(?,?)').bind('__sent',JSON.stringify({...message,messageId:id})).run();const failure=await env.DB.prepare("SELECT body FROM fixture_control WHERE key='__email_send_unknown' ORDER BY rowid DESC LIMIT 1").first();if(failure?.body==='true')throw Error('ambiguous provider response');return {messageId:id};}}};}
export class TestSchedulingEmailCoordinator extends EmailCoordinator {constructor(ctx,env){super(ctx,emailWrap(env));} restartForTest(){this.ctx.abort('email fixture restart');}}
export class TestBookingCoordinator extends Coordinator {constructor(ctx,env){super(ctx,wrap(env));} restartForTest(){this.ctx.abort('fixture restart');} async legacyOutboxForTest(){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_outbox(id TEXT PRIMARY KEY,email TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');this.ctx.storage.sql.exec("INSERT OR IGNORE INTO booking_outbox(id,email,subject,body) VALUES('old','visitor@example.com','Old notice','Deprecated')");await this.ctx.storage.deleteAlarm();await this.alarm();return {alarm:await this.ctx.storage.getAlarm()};}}
export default {async fetch(request,env){env=wrap(env);const url=new URL(request.url),store=new BookingStore(env.DB);
 if(url.pathname==='/fixture'){await store.init();await env.DB.prepare('CREATE TABLE IF NOT EXISTS fixture_control(key TEXT,body TEXT)').run();
 const settings={...defaultBookingSettings(owner),displayName:'Test host',slug:'test-host',thesis:'I meet founders building new interfaces for AI agents.',revision:1,enabled:true,weekdays:[0,1,2,3,4,5],startTime:'09:00',endTime:'17:00'};
 await store.saveSettings(settings,0);
 await store.saveCalendar({owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}),env.MAIL_TOKEN_KEY)});
 return Response.json({cookie:sessionCookie(await makeSession(owner,env.TOKEN_SECRET)),settings});}
 if(url.pathname==='/fixture/email'){const input=await request.json();let rejection=null;const bytes=new TextEncoder().encode(input.raw);await worker.email({to:input.to,from:input.from,rawSize:bytes.length,raw:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),setReject(reason){rejection=reason;}},emailWrap(env));return Response.json({rejection});}
 if(url.pathname==='/fixture/email-alarm'){await env.SCHEDULING_EMAIL.getByName(owner).alarm();return Response.json({ok:true});}
 if(url.pathname==='/fixture/email-restart'){try{await env.SCHEDULING_EMAIL.getByName(owner).restartForTest();}catch{}return Response.json({ok:true});}
 if(url.pathname==='/fixture/readiness'){const key=url.searchParams.get('missing');return Response.json(await bookingReadiness({...env,...(key?{[key]:undefined}:{})},owner));}
 if(url.pathname==='/fixture/legacy-outbox')return Response.json(await env.BOOKING.getByName(owner).legacyOutboxForTest());
 if(url.pathname==='/fixture/busy'){try{return Response.json({busy:await bookingCalendarBusy(env,await store.calendar(owner),new Date().toISOString(),new Date(Date.now()+86400000).toISOString())});}catch(e){return Response.json({error:e.message});}}
 if(url.pathname==='/fixture/restart'){try{await env.BOOKING.getByName(owner).restartForTest();}catch{}return Response.json({ok:true});}
 if(url.pathname==='/fixture/token'){return Response.json({cookie:sessionCookie(await makeSession(url.searchParams.get('email'),env.TOKEN_SECRET))});}
 if(url.pathname==='/fixture/sql'){const b=await request.json();return Response.json(await env.DB.prepare(b.sql).bind(...(b.args||[])).all());}
 return worker.fetch(request,env);}};
`;

await test('Booking Worker integration with real D1 and SQLite coordinator',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'people-booking-runtime-'));let mf;
 const googleCodes=new Map(),keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey),encode=value=>Buffer.from(value).toString('base64url');
 async function identity(claims){const now=Math.floor(Date.now()/1000),head=encode(JSON.stringify({alg:'RS256',kid:'fixture-key'})),body=encode(JSON.stringify({iss:'https://accounts.google.com',aud:'test-client',iat:now,exp:now+3600,email_verified:true,...claims})),signature=encode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(head+'.'+body)));return head+'.'+body+'.'+signature;}
 const events=new Map();let inserts=0,failInsert=false,failLookup=false,failDelete=false,sourceMissing=false,externalBusy=[];
 try{
  await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','cloudflare:email','node:*'],outfile:join(dir,'worker.mjs')});
  const scopes='openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';
  mf=new Miniflare({modules:true,modulesRoot:dir,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2025-05-01',compatibilityFlags:['nodejs_compat'],assets:{directory:join(process.cwd(),'public'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},d1Databases:{DB:'booking-test'},durableObjects:{BOOKING:{className:'TestBookingCoordinator',useSQLite:true},SCHEDULING_EMAIL:{className:'TestSchedulingEmailCoordinator',useSQLite:true}},bindings:{GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-client-secret',TOKEN_SECRET:'test-session-secret',MAIL_TOKEN_KEY:'test-encryption',APP_ORIGIN:'https://people.test',BOOKING_OWNER_EMAIL:'owner@example.com',PEOPLEGRAPH_HOST:'https://source.test',PEOPLEGRAPH_TOKEN:'test-source-secret',PEOPLEGRAPH_OWNER_EMAIL:'owner@example.com'},outboundService:async req=>{
   const u=new URL(req.url);
   if(u.hostname==='source.test')return Response.json({ok:!sourceMissing,command:'score',stats:{user_email:'owner@example.com',last_sync:new Date(Date.now()-1000).toISOString(),matched:sourceMissing?0:1},...(sourceMissing?{error:{kind:'not_found'}}:{data:{email:u.searchParams.get('email'),name:'Visitor',score:{combined:40}}})},{status:sourceMissing?400:200});
   if(u.pathname==='/oauth2/v3/certs')return Response.json({keys:[{...jwk,kid:'fixture-key',use:'sig',alg:'RS256'}]});
   if(u.hostname==='oauth2.googleapis.com'){
    const input=new URLSearchParams(await req.text());
    if(input.get('grant_type')==='authorization_code'){
     const code=input.get('code'),claims=googleCodes.get(code);googleCodes.delete(code);
     if(!claims||encode(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.get('code_verifier'))))!==claims.nonce)return Response.json({error:'invalid_grant'},{status:400});
     assert.equal(input.get('redirect_uri'),'https://people.test/api/accounts/callback');
     return Response.json({access_token:'fixture-access',token_type:'Bearer',expires_in:3600,scope:'openid email',id_token:await identity(claims)});
    }
    return Response.json({access_token:'fixture-access',token_type:'Bearer',expires_in:3600,scope:scopes});
   }
   if(u.pathname.endsWith('/freeBusy')){const query=await req.json();return Response.json({kind:'calendar#freeBusy',timeMin:query.timeMin,timeMax:query.timeMax,calendars:{primary:{busy:[...externalBusy,...[...events.values()].filter(e=>e.status!=='cancelled').map(e=>({start:e.start.dateTime,end:e.end.dateTime}))]}}});}
   if(u.pathname.endsWith('/events')&&req.method==='POST'){
    const e=await req.json();inserts++;
    if(events.has(e.id))return new Response(null,{status:409});
    events.set(e.id,{...e,status:'confirmed'});if(failInsert)return new Response(null,{status:503});return Response.json(events.get(e.id));
   }
   const id=u.pathname.split('/').pop();
   if(req.method==='GET'&&u.pathname.includes('/events/'))return failLookup?new Response(null,{status:503}):events.has(id)?Response.json(events.get(id)):new Response(null,{status:404});
   if(req.method==='DELETE'&&u.pathname.includes('/events/')){if(events.has(id))events.get(id).status='cancelled';return new Response(null,{status:failDelete?503:204});}
   throw Error('Unexpected external request '+u.origin+u.pathname);
  }});
  async function api(path,{method='GET',data,cookie='',origin='https://people.test'}={}){
   const res=await mf.dispatchFetch('https://people.test'+path,{method,redirect:'manual',headers:{origin,cookie,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});let value;try{value=await res.json();}catch{value={};}return {res,value};
  }
  await t.test('booking pages serve HTML directly without a redirect loop or losing the public slug',async()=>{
   for(const [path,title] of [['/booking','Booking · People'],['/book/test-host','A conversation · People']]){
    const res=await mf.dispatchFetch('https://people.test'+path,{redirect:'manual'});
    assert.equal(res.status,200);assert.equal(res.headers.get('location'),null);
    assert.match(res.headers.get('content-type'),/text\/html/);assert.equal(res.headers.get('cache-control'),'no-store');
    assert.ok((await res.text()).includes('<title>'+title+'</title>'));
   }
  });
  const setup=await api('/fixture'),ownerCookie=setup.value.cookie.split(';')[0];let settings=setup.value.settings;
  const sql=async(sql,args=[])=> (await api('/fixture/sql',{method:'POST',data:{sql,args}})).value.results;
  const prefix='/api/public/booking/test-host';
  async function startSignIn(email,claims={},data={}){
   const x=await api(prefix+'/sign-in',{method:'POST',data});assert.equal(x.res.status,200,JSON.stringify(x.value));
   const auth=new URL(x.value.url),browser=x.res.headers.get('set-cookie').split(';')[0],code=crypto.randomUUID();
   assert.equal(auth.searchParams.get('scope'),'openid email');assert.equal(auth.searchParams.get('access_type'),'online');
   googleCodes.set(code,{email,sub:'subject-'+email,hd:'example.com',nonce:auth.searchParams.get('nonce'),...claims});
   return {browser,state:auth.searchParams.get('state'),callback:'/api/accounts/callback?'+new URLSearchParams({state:auth.searchParams.get('state'),code})};
  }
  async function visitor(email,claims={}){const c=await startSignIn(email,claims),v=await api(c.callback,{cookie:c.browser});assert.equal(v.res.status,303);assert.ok(v.res.headers.get('location').includes('signed_in=1'));assert.ok(!v.res.headers.get('set-cookie').includes('__Host-people-session='));return c.browser+'; '+v.res.headers.get('set-cookie').split(';')[0];}
  async function submit(cookie,key=crypto.randomUUID()){
   const r=await api(prefix+'/requests',{method:'POST',cookie,data:{name:'Test Visitor',project:'I build interfaces that help people work with AI agents.',purpose:'I would like product feedback on the new interface.',projectUrl:'https://example.com/deck',referrer:'A claimed referral',idempotencyKey:key}});assert.equal(r.res.status,200,JSON.stringify(r.value));return r.value.request;
  }
  let visitorCookie,first,slot;
  assert.ok((await api('/fixture/busy')).value.busy,JSON.stringify((await api('/fixture/busy')).value));
  await t.test('private endpoints require owner auth and reject cross-origin writes',async()=>{
   assert.equal((await api('/api/booking')).res.status,401);
   assert.equal((await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,origin:'https://evil.test',data:settings})).res.status,403);
   const dashboard=await api('/api/booking',{cookie:ownerCookie});assert.equal(dashboard.value.account.email,'owner@example.com');assert.equal(dashboard.value.lens.focus,'Agent interfaces');
   assert.equal(JSON.stringify(dashboard.value).includes('fixture-refresh'),false);
   const otherCookie=(await api('/fixture/token?email=other@example.com')).value.cookie.split(';')[0];assert.equal((await api('/api/booking/settings',{method:'POST',cookie:otherCookie,data:{...settings,owner:'other@example.com',slug:'stolen',revision:0,enabled:false}})).res.status,503);
  });
  await t.test('Google sign-in works without email sending; all Google prerequisites are required',async()=>{
   assert.equal((await api(prefix)).value.available,true);
   assert.equal((await api('/fixture/readiness')).value.signIn,true);
   for(const key of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','MAIL_TOKEN_KEY','TOKEN_SECRET'])assert.equal((await api('/fixture/readiness?missing='+key)).value.signIn,false);
   for(const endpoint of ['/challenge','/verify'])assert.equal((await api(prefix+endpoint,{method:'POST',data:{}})).res.status,404);
   assert.equal((await api(prefix+'/sign-in',{method:'POST',origin:'https://evil.test',data:{}})).res.status,403);
   const legacy=await api('/fixture/legacy-outbox');assert.equal(legacy.value.alarm,null);
  });
  await t.test('Google callback binds browser, expires, cannot replay, and cannot create an owner session',async()=>{
   const c=await startSignIn('wrong@example.com');
   assert.equal((await api(c.callback)).res.status,400);
   assert.equal((await api(c.callback,{cookie:'__Host-people-booking-browser='+'x'.repeat(43)})).res.status,400);
   const exp=await startSignIn('expired@example.com',{}, {requestId:'old-request'});await sql('UPDATE booking_visitor_oauth SET expires=0 WHERE id=?',[exp.state.slice('booking-visitor.'.length)]);
   const expired=await api(exp.callback,{cookie:exp.browser});assert.equal(expired.res.status,303);assert.equal(expired.res.headers.get('location'),'/book/test-host?request=old-request&sign_in=failed');assert.equal(expired.res.headers.get('set-cookie'),null);
   const good=await startSignIn('visitor@example.com',{}, {requestId:'saved-request'});
   const attempts=await Promise.all([0,1].map(()=>api(good.callback,{cookie:good.browser})));
   assert.deepEqual(attempts.map(a=>a.res.status).sort(),[303,400]);const valid=attempts.find(a=>a.res.status===303);
   assert.equal(valid.res.headers.get('location'),'/book/test-host?signed_in=1&request=saved-request');
   visitorCookie=good.browser+'; '+valid.res.headers.get('set-cookie').split(';')[0];
   assert.equal((await api('/api/booking',{cookie:visitorCookie})).res.status,401);
   const metadata=(await api(prefix,{cookie:visitorCookie})).value;assert.equal(metadata.visitor.email,'visitor@example.com');assert.ok(metadata.visitor.identityKey);assert.equal(JSON.stringify(metadata).includes('subject-visitor'),false);
   const sessions=await sql('SELECT * FROM booking_google_sessions');assert.equal(JSON.stringify(sessions).includes('fixture-access'),false);assert.equal(JSON.stringify(sessions).includes('subject-visitor'),false);
  });
  await t.test('denied or invalid Google identity returns a safe retry without establishing a session',async()=>{
   for(const claims of [{email_verified:false},{aud:'other-client'},{nonce:'wrong'}]){
    const c=await startSignIn('invalid@example.com',claims),before=(await sql('SELECT count(*) AS count FROM booking_google_sessions'))[0].count;
    const response=await api(c.callback,{cookie:c.browser});assert.equal(response.res.status,303);assert.equal(response.res.headers.get('location'),'/book/test-host?sign_in=failed');assert.equal(response.res.headers.get('set-cookie'),null);
    assert.equal((await sql('SELECT count(*) AS count FROM booking_google_sessions'))[0].count,before);
   }
   const denied=await startSignIn('denied@example.com',{}, {requestId:'return-here'}),response=await api('/api/accounts/callback?'+new URLSearchParams({state:denied.state,error:'access_denied'}),{cookie:denied.browser});
   assert.equal(response.res.status,303);assert.equal(response.res.headers.get('location'),'/book/test-host?request=return-here&sign_in=failed');assert.equal(response.res.headers.get('set-cookie'),null);
   assert.equal((await api(denied.callback,{cookie:denied.browser})).res.status,400);
  });
  async function setContact(email,overrides={}){
   await sql('INSERT INTO fixture_control(key,body) VALUES(?,?)',['__contact:owner@example.com:'+email,JSON.stringify({owner:'owner@example.com',email,name:'Known Friend',score:70,checkedAt:Date.now(),sourceUpdatedAt:Date.now()-1000,privateContext:'PRIVATE NOTE',...overrides})]);
  }
  await t.test('returning metadata recognizes only the authoritative signed-in contact and exposes no private score',async()=>{
   const email='returning@example.com';await setContact(email);
   assert.equal((await api(prefix)).value.returningContact,null);
   const cookie=await visitor(email),metadata=(await api(prefix,{cookie})).value;
   assert.deepEqual(metadata.returningContact,{name:'Known Friend'});
   assert.equal(metadata.visitor.email,email);
   for(const hidden of ['score','threshold','PRIVATE NOTE','sourceUpdatedAt','lastSync'])assert.equal(JSON.stringify(metadata).includes(hidden),false,hidden);
   const other=await visitor('unknown@example.com');assert.equal((await api(prefix,{cookie:other})).value.returningContact,null);
   const external=await visitor(email,{hd:undefined});assert.equal((await api(prefix,{cookie:external})).value.returningContact,null);
   await setContact(email,{score:69});assert.equal((await api(prefix,{cookie})).value.returningContact,null);
   await setContact(email,{fail:true});assert.equal((await api(prefix,{cookie})).value.returningContact,null);
  });
  await t.test('returning submission resolves known identity on the server and still requires review',async()=>{
   const email='catchup@example.com';await setContact(email);
   const cookie=await visitor(email),key=crypto.randomUUID();
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,vipEmails:[email],autoBookPriority:true}})).value.settings;
   const response=await api(prefix+'/requests',{method:'POST',cookie,data:{kind:'returning',note:'Would love to catch up.',name:'Forged Name',email:'other@example.com',score:100,idempotencyKey:key}});
   assert.equal(response.res.status,200,JSON.stringify(response.value));assert.equal(response.value.next,'select_slot');
   const r=response.value.request;assert.equal(r.intakeKind,'returning');assert.equal(JSON.stringify(response.value).includes('score'),false);
   const saved=(await api('/api/booking',{cookie:ownerCookie})).value.requests.find(v=>v.id===r.id);
   assert.equal(saved.name,'Known Friend');assert.equal(saved.email,email);assert.equal(saved.project,'');assert.equal(saved.purpose,'Would love to catch up.');assert.equal(saved.decision.tier,'review');
   const choices=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots;assert.ok(choices.length);assert.ok(Date.parse(choices[0].start)>=Date.now()+7*86400000-1000);
   const before=inserts,chosen=await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:choices[0].start}});assert.equal(chosen.value.request.status,'pending_approval');assert.equal(inserts,before);
   await setContact(email,{score:1});const retry=await api(prefix+'/requests',{method:'POST',cookie,data:{kind:'returning',idempotencyKey:key}});assert.equal(retry.value.request.id,r.id);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,vipEmails:[],autoBookPriority:false}})).value.settings;
  });
  await t.test('returning eligibility loss requests full intake without creating records or leaking source errors',async()=>{
   const email='fallback@example.com',cookie=await visitor(email);await setContact(email);
   assert.deepEqual((await api(prefix,{cookie})).value.returningContact,{name:'Known Friend'});
   for(const change of [{score:69},{sourceUpdatedAt:Date.now()-2*86400000},{owner:'other@example.com'},{fail:true}]){
    await setContact(email,change);
    const before=(await sql('SELECT count(*) AS count FROM booking_requests WHERE email=?',[email]))[0].count;
    const response=await api(prefix+'/requests',{method:'POST',cookie,data:{kind:'returning',note:'Keep my note',idempotencyKey:crypto.randomUUID()}});
    assert.equal(response.res.status,409,JSON.stringify(response.value));assert.deepEqual(response.value,{error:'intake_required'});
    assert.equal((await sql('SELECT count(*) AS count FROM booking_requests WHERE email=?',[email]))[0].count,before);
   }
  });
  await t.test('returning controls persist and paused pages never expose a returning profile',async()=>{
   const email='rules@example.com',cookie=await visitor(email);await setContact(email);
   for(const input of [{returningScoreThreshold:71},{returningScoreThreshold:70,returningContactsEnabled:false},{returningContactsEnabled:true,enabled:false}]){
    const response=await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,...input}});assert.equal(response.res.status,200,JSON.stringify(response.value));settings=response.value.settings;
    assert.equal((await api(prefix,{cookie})).value.returningContact,null);
   }
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,enabled:true}})).value.settings;
   assert.deepEqual((await api(prefix,{cookie})).value.returningContact,{name:'Known Friend'});
  });
  await t.test('unverified and cross-owner visitors cannot create or read requests',async()=>{
   assert.equal((await api(prefix+'/requests',{method:'POST',data:{}})).res.status,401);
   const other={...settings,owner:'other@example.com',slug:'other-host'};await sql('INSERT INTO booking_settings VALUES(?,?,?,?)',[other.owner,other.slug,other.revision,JSON.stringify(other)]);
   assert.equal((await api('/api/public/booking/other-host/requests',{cookie:visitorCookie})).res.status,401);
  });
  await t.test('duplicate submissions are one request and public output excludes decisions',async()=>{
   const key=crypto.randomUUID();const rs=await Promise.all([submit(visitorCookie,key),submit(visitorCookie,key)]);assert.equal(rs[0].id,rs[1].id);first=rs[0];
   assert.equal('decision' in first,false);assert.equal('email' in first,false);
   const privateR=(await api('/api/booking',{cookie:ownerCookie})).value.requests.find(r=>r.id===first.id);assert.equal(privateR.decision.tier,'review');assert.equal(privateR.referrer,'A claimed referral');
  });
  await t.test('a different Google account with the same email cannot read or reuse a request',async()=>{
   const different=await visitor('visitor@example.com',{sub:'different-subject'});
   assert.equal((await api(prefix+'/requests/'+first.id,{cookie:different})).res.status,404);
   assert.deepEqual((await api(prefix+'/requests',{cookie:different})).value.requests,[]);
   assert.equal((await api(prefix+'/slots?requestId='+first.id,{cookie:different})).res.status,404);
   const record=JSON.parse((await sql('SELECT data FROM booking_requests WHERE id=?',[first.id]))[0].data);
   const reused=await api(prefix+'/requests',{method:'POST',cookie:different,data:{idempotencyKey:record.idempotencyKey}});assert.notEqual(reused.res.status,200);
  });
  await t.test('external-email Google accounts cannot claim VIP or network priority',async()=>{
   await sql("INSERT INTO fixture_control(key,body) VALUES('__model',?)",[JSON.stringify({fit:'strong',reasons:['Thesis fit'],evidence:['I build interfaces that help people work with AI agents.']})]);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,vipEmails:['external@example.net'],autoBookPriority:true}})).value.settings;
   const cookie=await visitor('external@example.net',{hd:undefined}),r=await submit(cookie),saved=(await api('/api/booking',{cookie:ownerCookie})).value.requests.find(v=>v.id===r.id);
   assert.equal(saved.decision.tier,'review');assert.equal(saved.policySnapshot.vipMatch,false);assert.equal(saved.emailAuthoritative,false);
   const offered=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots;assert.ok(Date.parse(offered[0].start)>=Date.now()+7*86400000-1000);
   await sql("DELETE FROM fixture_control WHERE key='__model'");settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,vipEmails:[],autoBookPriority:false}})).value.settings;
  });
  await t.test('review visitor chooses a later slot; delayed approval keeps original eligibility',async()=>{
   const slots=await api(prefix+'/slots?requestId='+first.id,{cookie:visitorCookie});assert.equal(slots.res.status,200,JSON.stringify(slots.value));assert.ok(slots.value.slots.length);slot=slots.value.slots[0];assert.ok(Date.parse(slot.start)>=Date.now()+7*86400000-1000);
   const chosen=await api(prefix+'/requests/'+first.id+'/slot',{method:'POST',cookie:visitorCookie,data:{start:slot.start}});assert.equal(chosen.value.request.status,'pending_approval');assert.equal(inserts,0);
   const result=await api('/api/booking/requests/'+first.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(result.value.request.status,'booked',JSON.stringify(result.value));assert.equal(inserts,1);
   const again=await api('/api/booking/requests/'+first.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(again.value.request.eventId,result.value.request.eventId);assert.equal(inserts,1);
  });
  await t.test('another visitor cannot see or reuse a request and occupied slots disappear',async()=>{
   const cookie=await visitor('second@example.com'),r=await submit(cookie);
   assert.equal((await api(prefix+'/requests/'+first.id,{cookie})).res.status,404);
   const slots=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots;assert.equal(slots.some(s=>s.start===slot.start),false);
   assert.equal((await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:slot.start}})).res.status,409);
  });
  await t.test('settings CAS rejects stale edits and public status still works when paused',async()=>{
   const saved=await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,enabled:false}});assert.equal(saved.res.status,200);settings=saved.value.settings;
   assert.equal((await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,revision:settings.revision-1}})).res.status,409);
   assert.equal((await api(prefix+'/requests/'+first.id,{cookie:visitorCookie})).value.request.status,'booked');
   const recovered=await visitor('visitor@example.com');assert.equal((await api(prefix+'/requests/'+first.id,{cookie:recovered})).value.request.status,'booked');
   assert.equal((await api(prefix+'/requests',{method:'POST',cookie:visitorCookie,data:{}})).res.status,503);
   const resumed=await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,enabled:true}});settings=resumed.value.settings;
  });
  await t.test('duration changes cannot approve an old longer slot',async()=>{
   const cookie=await visitor('duration@example.com'),r=await submit(cookie),s=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots[0];
   await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}});
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,durationMinutes:15}})).value.settings;
   const before=inserts,result=await api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(result.value.request.status,'needs_new_slot');assert.equal(inserts,before);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,durationMinutes:30}})).value.settings;
  });
  await t.test('uncertain Calendar response reconciles the same persisted event without duplicate insert',async()=>{
   const cookie=await visitor('reconcile@example.com'),r=await submit(cookie),s=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots[0];
   await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}});failInsert=true;const before=inserts;
   const result=await api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(result.value.request.status,'booked',JSON.stringify(result.value));assert.equal(inserts,before+1);failInsert=false;
  });
  await t.test('simultaneous approvals for the same preferred time produce one booking',async()=>{
   const a=await visitor('race-a@example.com'),b=await visitor('race-b@example.com'),ra=await submit(a),rb=await submit(b);
   const s=(await api(prefix+'/slots?requestId='+ra.id,{cookie:a})).value.slots[0];
   for(const [cookie,r] of [[a,ra],[b,rb]])assert.equal((await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}})).res.status,200);
   const before=inserts,results=await Promise.all([ra,rb].map(r=>api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie})));
   assert.deepEqual(results.map(r=>r.value.request.status).sort(),['booked','needs_new_slot']);assert.equal(inserts,before+1);
  });
  await t.test('uncertain writes survive coordinator restart and reconcile without a second insertion',async()=>{
   const cookie=await visitor('restart@example.com'),r=await submit(cookie),s=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots[0];
   await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}});failInsert=true;failLookup=true;const before=inserts;
   const result=await api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(result.res.status,409);assert.equal((await api(prefix+'/requests/'+r.id,{cookie})).value.request.status,'booking');
   assert.equal((await api('/api/booking/calendar/disconnect',{method:'POST',cookie:ownerCookie})).res.status,409);
   await api('/fixture/restart');failInsert=false;failLookup=false;
   const retry=await api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie});assert.equal(retry.value.request.status,'booked',JSON.stringify(retry.value));assert.equal(inserts,before+1);
  });
  await t.test('automatic priority booking rechecks fit plus relationship state before creating an event',async()=>{
   await sql("INSERT INTO fixture_control(key,body) VALUES('__model',?)",[JSON.stringify({fit:'possible',reasons:['Potential thesis fit'],evidence:['I build interfaces that help people work with AI agents.']})]);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,autoBookPriority:true}})).value.settings;
   const cookie=await visitor('auto@example.com'),r=await submit(cookie),s=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots[0];
   assert.ok(Date.parse(s.start)<Date.now()+7*86400000);const before=inserts;sourceMissing=true;
   const downgraded=await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}});assert.equal(downgraded.value.request.status,'needs_new_slot');assert.equal(inserts,before);
   sourceMissing=false;const r2=await submit(cookie),s2=(await api(prefix+'/slots?requestId='+r2.id,{cookie})).value.slots[0];
   const booked=await api(prefix+'/requests/'+r2.id+'/slot',{method:'POST',cookie,data:{start:s2.start}});assert.equal(booked.value.request.status,'booked',JSON.stringify(booked.value));assert.equal(inserts,before+1);
   await sql("DELETE FROM fixture_control WHERE key='__model'");settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,autoBookPriority:false}})).value.settings;
  });
  await t.test('active reservations are not hidden by a large history inbox',async()=>{
   const r=JSON.parse((await sql('SELECT data FROM booking_requests WHERE id=?',[first.id]))[0].data);
   await sql('UPDATE booking_requests SET created_at=0 WHERE id=?',[first.id]);
   await sql(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO booking_requests SELECT 'history-'||x,'owner@example.com','history@example.com','key-'||x,?,json_set(?,'$.id','history-'||x,'$.status','async_submitted') FROM n`,[Date.now(),JSON.stringify(r)]);
   const all=(await api('/api/booking',{cookie:ownerCookie})).value.requests;assert.equal(all.length,1000);
   assert.ok((await api(prefix+'/requests',{cookie:visitorCookie})).value.requests.some(item=>item.request.id===first.id),'Visitors recover their requests even outside the owner inbox cap');
   const cookie=await visitor('history@example.com'),newRequest=await submit(cookie);
   assert.equal((await api(prefix+'/requests/'+newRequest.id+'/slot',{method:'POST',cookie,data:{start:slot.start}})).res.status,409);
  });
  await t.test('lost cancellation response recovers after restart without resurrecting the meeting',async()=>{
   const r=JSON.parse((await sql("SELECT data FROM booking_requests WHERE email='restart@example.com'"))[0].data);
   // Model an insert acknowledged by Google but still awaiting local reconciliation.
   r.status='booking';await sql('UPDATE booking_requests SET data=? WHERE id=?',[JSON.stringify(r),r.id]);
   failDelete=true;const before=inserts;
   assert.equal((await api('/api/booking/requests/'+r.id+'/cancel',{method:'POST',cookie:ownerCookie})).res.status,409);
   assert.equal(JSON.parse((await sql('SELECT data FROM booking_requests WHERE id=?',[r.id]))[0].data).status,'cancelling');
   assert.equal((await api('/api/booking/requests/'+r.id+'/approve',{method:'POST',cookie:ownerCookie})).res.status,400);
   await api('/fixture/restart');failDelete=false;
   const retry=await api('/api/booking/requests/'+r.id+'/cancel',{method:'POST',cookie:ownerCookie});assert.equal(retry.value.request.status,'cancelled');assert.equal(inserts,before);
  });
  await t.test('cancellation updates Calendar and never reveals private reasons to visitors',async()=>{
   const result=await api('/api/booking/requests/'+first.id+'/cancel',{method:'POST',cookie:ownerCookie});assert.equal(result.value.request.status,'cancelled');assert.equal(events.get(result.value.request.eventId).status,'cancelled');
   const publicState=await api(prefix+'/requests/'+first.id,{cookie:visitorCookie});assert.equal(publicState.value.request.status,'cancelled');assert.equal(JSON.stringify(publicState.value).includes('decision'),false);
  });
  function proposalInput(days,hour=22){const date=new Date(Date.now()+days*86400000);date.setUTCHours(hour,0,0,0);return {timezone:'UTC',times:[date.toISOString().slice(0,16)]};}
  async function propose(cookie,r,input){const response=await api(prefix+'/requests/'+r.id+'/proposals',{method:'POST',cookie,data:input});assert.equal(response.res.status,200,JSON.stringify(response.value));return response.value.request;}
  async function approveProposal(r,start=r.proposedTimes.slots[0].start){return api('/api/booking/requests/'+r.id+'/approve-proposal',{method:'POST',cookie:ownerCookie,data:{start,revision:r.proposedTimes.revision}});}
  await t.test('visitor proposals use Google ownership and origin checks, survive resume, and remain unreserved',async()=>{
   const email='suggestions@example.com',cookie=await visitor(email),r=await submit(cookie),input=proposalInput(12),path=prefix+'/requests/'+r.id+'/proposals',before=inserts;
   assert.equal((await api(path,{method:'POST',data:input})).res.status,401);
   assert.equal((await api(path,{method:'POST',cookie,origin:'https://evil.test',data:input})).res.status,403);
   const foreign=await visitor(email,{sub:'other-google-subject'});
   assert.equal((await api(path,{method:'POST',cookie:foreign,data:input})).res.status,404);
   for(const invalid of [{...input,times:[]},{...input,times:Array(4).fill(input.times[0])},{...input,timezone:'Not/A_Zone'},{...input,times:['2026-99-01T25:00']},{...input,times:[input.times[0],input.times[0]]}]){
    assert.equal((await api(path,{method:'POST',cookie,data:invalid})).res.status,400,'invalid proposal data cannot reach Calendar');
   }
   const saved=await propose(cookie,r,input);assert.equal(saved.status,'pending_approval');assert.equal(saved.slotStart,null);assert.equal(inserts,before);
   assert.deepEqual(saved.proposedTimes.slots,[{start:input.times[0]+':00.000Z',end:input.times[0].slice(0,14)+'30:00.000Z'}]);
   const retry=await propose(cookie,r,input);assert.equal(retry.proposedTimes.revision,saved.proposedTimes.revision,'same suggestions are idempotent');
   const status=await api(prefix+'/requests/'+r.id,{cookie});assert.equal(status.value.next,'pending_approval');assert.deepEqual(status.value.request.proposedTimes,saved.proposedTimes);
   const history=(await api(prefix+'/requests',{cookie})).value.requests.find(item=>item.request.id===r.id);assert.equal(history.next,'pending_approval');
   for(const privateField of ['decision','owner','email','purpose','policySnapshot'])assert.equal(privateField in status.value.request,false,privateField);
   const privateRecord=(await api('/api/booking',{cookie:ownerCookie})).value.requests.find(item=>item.id===r.id);assert.deepEqual(privateRecord.proposedTimes,saved.proposedTimes);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,enabled:false}})).value.settings;
   assert.equal((await api(path,{method:'POST',cookie,data:input})).res.status,503);
   assert.equal((await api(prefix+'/requests/'+r.id,{cookie})).value.next,'pending_approval');
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,enabled:true}})).value.settings;
   assert.equal((await api('/api/booking/requests/'+r.id+'/approve-proposal',{method:'POST',data:{start:saved.proposedTimes.slots[0].start,revision:saved.proposedTimes.revision}})).res.status,401);
   assert.equal((await api('/api/booking/requests/'+r.id+'/approve-proposal',{method:'POST',cookie:ownerCookie,origin:'https://evil.test',data:{start:saved.proposedTimes.slots[0].start,revision:saved.proposedTimes.revision}})).res.status,403);
   const approved=await approveProposal(saved);assert.equal(approved.res.status,200,JSON.stringify(approved.value));assert.equal(approved.value.request.status,'booked');assert.equal(approved.value.request.slotSource,'suggested');assert.equal(inserts,before+1,'explicit owner approval books an evening outside normal hours');
   assert.equal((await approveProposal(saved)).value.request.eventId,approved.value.request.eventId);assert.equal(inserts,before+1);
   assert.equal((await api(path,{method:'POST',cookie,data:proposalInput(13)})).res.status,409,'booked alternatives cannot be changed');
  });
  await t.test('replaced proposal revisions cannot book; owner can request new times and offered choices clear proposals',async()=>{
   const cookie=await visitor('revised-times@example.com'),r=await submit(cookie),firstSet=await propose(cookie,r,proposalInput(14));
   const secondSet=await propose(cookie,r,proposalInput(15));assert.notEqual(firstSet.proposedTimes.revision,secondSet.proposedTimes.revision);
   const before=inserts,stale=await approveProposal(firstSet);assert.equal(stale.res.status,409);assert.equal(stale.value.error,'proposal_changed');assert.equal(inserts,before);
   const asked=await api('/api/booking/requests/'+r.id+'/request-times',{method:'POST',cookie:ownerCookie});assert.equal(asked.value.request.status,'needs_new_slot');assert.ok(!asked.value.request.proposedTimes);
   assert.equal((await api(prefix+'/requests/'+r.id,{cookie})).value.next,'select_slot');
   await propose(cookie,r,proposalInput(15));
   const slots=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots;
   const chosen=await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:slots[0].start}});assert.equal(chosen.res.status,200,JSON.stringify(chosen.value));assert.ok(!chosen.value.request.proposedTimes);assert.equal(chosen.value.request.status,'pending_approval');assert.equal(inserts,before);
  });
  await t.test('serialized alternative approvals allow only one meeting at a shared instant',async()=>{
   const a=await visitor('proposal-race-a@example.com'),b=await visitor('proposal-race-b@example.com'),ra=await submit(a),rb=await submit(b),input=proposalInput(18);
   const savedA=await propose(a,ra,input),savedB=await propose(b,rb,input),before=inserts;
   const results=await Promise.all([savedA,savedB].map(r=>approveProposal(r)));
   assert.deepEqual(results.map(result=>result.value.request?.status).sort(),['booked','needs_new_slot'],JSON.stringify(results.map(result=>result.value)));
   assert.equal(inserts,before+1);
  });
  await t.test('suggested-time uncertain writes survive restart with one persisted Calendar event',async()=>{
   const cookie=await visitor('proposal-retry@example.com'),r=await submit(cookie),saved=await propose(cookie,r,proposalInput(20)),before=inserts;
   failInsert=true;failLookup=true;
   const uncertain=await approveProposal(saved);assert.equal(uncertain.res.status,409,JSON.stringify(uncertain.value));
   assert.equal((await api(prefix+'/requests/'+r.id,{cookie})).value.request.status,'booking');
   assert.equal((await api(prefix+'/requests/'+r.id+'/proposals',{method:'POST',cookie,data:proposalInput(21)})).res.status,409,'in-flight suggestions stay fixed');
   await api('/fixture/restart');failInsert=false;failLookup=false;
   const recovered=await approveProposal(saved);assert.equal(recovered.value.request.status,'booked',JSON.stringify(recovered.value));assert.equal(inserts,before+1);
   assert.equal(recovered.value.request.slotStart,saved.proposedTimes.slots[0].start);
  });
  await t.test('owner scheduling setup and scoped machine credentials use separate authorization',async()=>{
   const status=await api('/api/booking/scheduling/status',{cookie:ownerCookie});assert.equal(status.res.status,200,JSON.stringify(status.value));assert.equal(status.value.readiness.emailConfigured,false);
   assert.equal((await api('/api/booking/scheduling/tokens',{method:'POST',cookie:ownerCookie,origin:'https://evil.test',data:{name:'Blocked',scopes:['scheduling:read']}})).res.status,403);
   const minted=await api('/api/booking/scheduling/tokens',{method:'POST',cookie:ownerCookie,data:{name:'Runtime scheduling',scopes:['scheduling:read','scheduling:write']}});assert.equal(minted.res.status,201,JSON.stringify(minted.value));
   const token=minted.value.token,credentialId=minted.value.credential.id;
   const machine=async(path,data,key=token)=>{const res=await mf.dispatchFetch('https://people.test/api/scheduling'+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {res,value:await res.json()};};
   assert.equal((await api('/api/scheduling/requests/missing',{cookie:ownerCookie})).res.status,401,'owner browser cookie is not a machine credential');
   const ownerWithMachine=await mf.dispatchFetch('https://people.test/api/booking',{headers:{Authorization:'Bearer '+token}});assert.equal(ownerWithMachine.status,401,'scheduling credentials cannot read the owner dashboard');
   const listed=await api('/api/booking/scheduling/tokens',{cookie:ownerCookie});assert.equal(JSON.stringify(listed.value).includes(token),false);
   const read=await api('/api/booking/scheduling/tokens',{method:'POST',cookie:ownerCookie,data:{name:'Read requests only',scopes:['scheduling:read']}});assert.equal(read.res.status,201);
   const input={email:'delegate@example.com',name:'Delegate',context:'Private discussion notes that must not enter the Calendar invitation',idempotencyKey:'runtime_scheduling_credential_test'};
   assert.equal((await machine('/prepare',input,read.value.token)).res.status,403);
   const prepared=await machine('/prepare',input);assert.equal(prepared.res.status,200,JSON.stringify(prepared.value));assert.ok(prepared.value.offer?.slots.length);assert.equal(prepared.value.offer.slots.length<=3,true);
   const repeated=await machine('/prepare',input);assert.equal(repeated.value.requestId,prepared.value.requestId);assert.equal(repeated.value.offer.revision,prepared.value.offer.revision);
   const privateRequest=(await sql('SELECT data FROM booking_requests WHERE id=?',[prepared.value.requestId])).map(row=>JSON.parse(row.data))[0];assert.equal(privateRequest.visitorSubject,undefined);assert.equal(privateRequest.scheduling.authority.channel,'owner_api');assert.equal(privateRequest.scheduling.authority.evidenceId,credentialId);
   const before=inserts,selection={revision:prepared.value.offer.revision,slotId:prepared.value.offer.slots[0].id};
   const confirmed=await machine('/requests/'+prepared.value.requestId+'/confirm',selection);assert.equal(confirmed.res.status,200,JSON.stringify(confirmed.value));assert.equal(confirmed.value.status,'booked');assert.equal(inserts,before+1);
   const retry=await machine('/requests/'+prepared.value.requestId+'/confirm',selection);assert.equal(retry.value.status,'booked');assert.equal(inserts,before+1);
   const event=[...events.values()].find(event=>event.attendees?.[0]?.email==='delegate@example.com');assert.ok(event);assert.equal(event.description.includes('Private discussion notes'),false);
   assert.equal((await machine('/requests/'+prepared.value.requestId,undefined,read.value.token)).value.status,'booked');
   const revoked=await api('/api/booking/scheduling/tokens/'+credentialId+'/revoke',{method:'POST',cookie:ownerCookie,data:{}});assert.equal(revoked.res.status,200);
   assert.equal((await machine('/requests/'+prepared.value.requestId)).res.status,401);
  });
  await t.test('verified email kickoff and current reply capability book once through the production Worker email handler',async()=>{
   const peer='email-peer@example.com',agent='scheduling@agent.test',kickId='<verified-kickoff@example.com>';
   const canonical={gmailId:'runtime-gmail-kickoff',messageId:kickId,owner:'owner@example.com',from:'owner@example.com',to:[peer],cc:[agent],subject:'Meet',text:'Please find us a time to meet.',receivedAt:Date.now()};
   const incoming=async({id,from,to,cc='owner@example.com',reply,text})=>api('/fixture/email',{method:'POST',data:{to,from,raw:['From: '+from,'To: '+to,'Cc: '+cc,'Message-ID: '+id,'Subject: Meet',...(reply?['In-Reply-To: '+reply]:[]),'Content-Type: text/plain; charset=utf-8','',''+text].join('\r\n')}});
   const sent=async()=> (await sql("SELECT body FROM fixture_control WHERE key='__sent' ORDER BY rowid")).map(row=>JSON.parse(row.body));
   const initialMail=(await sent()).length,before=inserts;
   await incoming({id:'<spoofed-owner@example.com>',from:'owner@example.com',to:agent,text:'Please find us a time to meet.'});
   assert.equal((await sent()).length,initialMail,'a spoofed From without the exact canonical owner SENT message cannot send options');assert.equal(inserts,before);
   await sql('INSERT INTO fixture_control(key,body) VALUES(?,?)',['__kickoff:'+kickId,JSON.stringify(canonical)]);
   const kickoff={id:kickId,from:'owner@example.com',to:agent,cc:peer,text:'Untrusted inbound body must never replace canonical Gmail text.'};
   assert.equal((await incoming(kickoff)).value.rejection,null);
   const offer=(await sent()).at(-1);assert.equal((await sent()).length,initialMail+1);assert.deepEqual(offer.to,[peer]);assert.deepEqual(offer.cc,['owner@example.com']);assert.match(offer.replyTo,/^scheduling\+[a-f0-9]{48}@agent\.test$/);assert.match(offer.text,/Option 1 works/);assert.doesNotMatch(offer.text,/Untrusted inbound|People score|Product feedback/);
   await incoming(kickoff);assert.equal((await sent()).length,initialMail+1,'duplicate ingress never sends a second offer');
   const record=(await sql("SELECT data FROM booking_requests WHERE json_extract(data,'$.email')=?",[peer])).map(row=>JSON.parse(row.data))[0];assert.ok(record.scheduling);assert.equal(record.scheduling.authority.channel,'owner_email');assert.equal(record.scheduling.authority.evidenceId,canonical.gmailId);assert.equal(record.purpose.includes('Untrusted inbound'),false);
   await incoming({id:'<wrong-peer@example.com>',from:'stranger@example.com',to:offer.replyTo,reply:offer.messageId,text:'Option 1 works'});assert.equal(inserts,before);
   await incoming({id:'<wrong-offer@example.com>',from:peer,to:offer.replyTo,reply:'<old-offer@example.com>',text:'Option 1 works'});assert.equal(inserts,before);
   const selection={id:'<peer-choice@example.com>',from:peer,to:offer.replyTo,reply:offer.messageId,text:'Option 1 works'};
   assert.equal((await incoming(selection)).value.rejection,null);assert.equal(inserts,before+1);
   const booked=JSON.parse((await sql('SELECT data FROM booking_requests WHERE id=?',[record.id]))[0].data);assert.equal(booked.status,'booked');assert.equal(booked.visitorSubject,undefined);assert.equal(events.get(booked.eventId).attendees[0].email,peer);
   assert.match((await sent()).at(-1).text,/meeting is booked/);
   await api('/fixture/email-restart');await incoming(selection);await api('/fixture/email-alarm');assert.equal(inserts,before+1);assert.equal((await sent()).length,initialMail+2,'restart and repeated reply keep one offer and one confirmation');
  });
  await t.test('unknown email delivery is not blindly retried after coordinator restart',async()=>{
   const id='<unknown-send@example.com>',agent='scheduling@agent.test',peer='unknown-send-peer@example.com';
   await sql('INSERT INTO fixture_control(key,body) VALUES(?,?)',['__kickoff:'+id,JSON.stringify({gmailId:'runtime-gmail-unknown',messageId:id,owner:'owner@example.com',from:'owner@example.com',to:[peer],cc:[agent],subject:'Meet',text:'Please find us a time to meet.',receivedAt:Date.now()})]);
   await sql("INSERT INTO fixture_control(key,body) VALUES('__email_send_unknown','true')");
   const sentBefore=(await sql("SELECT body FROM fixture_control WHERE key='__sent'")).length,before=inserts;
   const raw=['From: owner@example.com','To: '+peer,'Cc: '+agent,'Message-ID: '+id,'Subject: Meet','Content-Type: text/plain','','Please find us a time to meet.'].join('\r\n');
   await api('/fixture/email',{method:'POST',data:{to:agent,from:'owner@example.com',raw}});
   assert.equal((await sql("SELECT body FROM fixture_control WHERE key='__sent'")).length,sentBefore+1);
   await sql("INSERT INTO fixture_control(key,body) VALUES('__email_send_unknown','false')");await api('/fixture/email-restart');await api('/fixture/email-alarm');
   assert.equal((await sql("SELECT body FROM fixture_control WHERE key='__sent'")).length,sentBefore+1);assert.equal(inserts,before);
  });
  await t.test('expired visitor sessions require Google sign-in again and recover only their own history',async()=>{
   await sql("UPDATE booking_google_sessions SET expires=0 WHERE email='visitor@example.com'");
   assert.equal((await api(prefix+'/requests/'+first.id,{cookie:visitorCookie})).res.status,401);
   assert.equal((await api(prefix,{cookie:visitorCookie})).value.visitor,null);
   const renewed=await visitor('visitor@example.com');assert.equal((await api(prefix+'/requests/'+first.id,{cookie:renewed})).value.request.status,'cancelled');
  });

 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
