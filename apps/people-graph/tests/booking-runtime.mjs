import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Production routing, D1, SQLite coordinator, verification and provider code.
// Only the email transport and external Google/Rust services are synthetic.
const fixture=`
import worker from './src/index';
import {BookingCoordinator as Coordinator} from './src/booking-coordinator';
import {BookingStore} from './src/booking-store';
import {defaultBookingSettings} from './src/booking-policy';
import {makeSession,sessionCookie} from './src/session';
import {seal} from './src/mail-model';
import {bookingCalendarBusy} from './src/booking-providers';
const owner='owner@example.com';
function wrap(env){return {...env,BOOKING_EMAIL:{async send(message){await env.DB.prepare('INSERT INTO fixture_mail(email,body) VALUES(?,?)').bind(message.to,message.text).run();return {messageId:'fixture'};}},AI:{async run(){const row=await env.DB.prepare("SELECT body FROM fixture_mail WHERE email='__model' ORDER BY rowid DESC LIMIT 1").first();if(!row)throw Error('model unavailable');return {output_text:row.body};}},MAIL:{getByName(){return {bindOwner:async()=>{},getOwnerLens:async()=>({fields:{focus:'Agent interfaces',needs:'Founders',offers:'Product feedback'}})}}}};}
export class TestBookingCoordinator extends Coordinator {constructor(ctx,env){super(ctx,wrap(env));} restartForTest(){this.ctx.abort('fixture restart');}}
export default {async fetch(request,env){env=wrap(env);const url=new URL(request.url),store=new BookingStore(env.DB);
 if(url.pathname==='/fixture'){await store.init();await env.DB.prepare('CREATE TABLE IF NOT EXISTS fixture_mail(email TEXT,body TEXT)').run();
 const settings={...defaultBookingSettings(owner),displayName:'Test host',slug:'test-host',thesis:'I meet founders building new interfaces for AI agents.',revision:1,enabled:true,weekdays:[0,1,2,3,4,5],startTime:'09:00',endTime:'17:00'};
 await store.saveSettings(settings,0);
 await store.saveCalendar({owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}),env.MAIL_TOKEN_KEY)});
 return Response.json({cookie:sessionCookie(await makeSession(owner,env.TOKEN_SECRET)),settings});}
 if(url.pathname==='/fixture/busy'){try{return Response.json({busy:await bookingCalendarBusy(env,await store.calendar(owner),new Date().toISOString(),new Date(Date.now()+86400000).toISOString())});}catch(e){return Response.json({error:e.message});}}
 if(url.pathname==='/fixture/restart'){try{await env.BOOKING.getByName(owner).restartForTest();}catch{}return Response.json({ok:true});}
 if(url.pathname==='/fixture/token'){return Response.json({cookie:sessionCookie(await makeSession(url.searchParams.get('email'),env.TOKEN_SECRET))});}
 if(url.pathname==='/fixture/sql'){const b=await request.json();return Response.json(await env.DB.prepare(b.sql).bind(...(b.args||[])).all());}
 return worker.fetch(request,env);}};
`;

await test('Booking Worker integration with real D1 and SQLite coordinator',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'people-booking-runtime-'));let mf;
 const events=new Map();let inserts=0,failInsert=false,failLookup=false,failDelete=false,sourceMissing=false,externalBusy=[];
 try{
  await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],outfile:join(dir,'worker.mjs')});
  const scopes='openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';
  mf=new Miniflare({modules:true,modulesRoot:dir,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2025-05-01',assets:{directory:join(process.cwd(),'public'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},d1Databases:{DB:'booking-test'},durableObjects:{BOOKING:{className:'TestBookingCoordinator',useSQLite:true}},bindings:{GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-client-secret',TOKEN_SECRET:'test-session-secret',MAIL_TOKEN_KEY:'test-encryption',APP_ORIGIN:'https://people.test',BOOKING_OWNER_EMAIL:'owner@example.com',BOOKING_EMAIL_FROM:'bookings@betaworks.com',BOOKING_EMAIL_READY:'true',PEOPLEGRAPH_HOST:'https://source.test',PEOPLEGRAPH_TOKEN:'test-source-secret',PEOPLEGRAPH_OWNER_EMAIL:'owner@example.com'},outboundService:async req=>{
   const u=new URL(req.url);
   if(u.hostname==='source.test')return Response.json({ok:!sourceMissing,command:'score',stats:{user_email:'owner@example.com',last_sync:new Date(Date.now()-1000).toISOString(),matched:sourceMissing?0:1},...(sourceMissing?{error:{kind:'not_found'}}:{data:{email:u.searchParams.get('email'),name:'Visitor',score:{combined:40}}})},{status:sourceMissing?400:200});
   if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture-access',token_type:'Bearer',expires_in:3600,scope:scopes});
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
   const res=await mf.dispatchFetch('https://people.test'+path,{method,headers:{origin,cookie,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});let value;try{value=await res.json();}catch{value={};}return {res,value};
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
  async function challenge(email){
   const x=await api(prefix+'/challenge',{method:'POST',data:{email}});assert.equal(x.res.status,200,JSON.stringify(x.value));
   const browser=x.res.headers.get('set-cookie').split(';')[0],mail=(await sql('SELECT body FROM fixture_mail WHERE email=? ORDER BY rowid DESC LIMIT 1',[email]))[0];
   const code=mail.body.match(/is (\d{6})/)[1];assert.equal(JSON.stringify(x.value).includes(code),false);return {...x.value,browser,code};
  }
  async function visitor(email){const c=await challenge(email);const v=await api(prefix+'/verify',{method:'POST',cookie:c.browser,data:{challengeId:c.challengeId,code:c.code}});assert.equal(v.res.status,200);return c.browser+'; '+v.res.headers.get('set-cookie').split(';')[0];}
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
  await t.test('codes bind to browser, allow five attempts, expire, and cannot replay',async()=>{
   const c=await challenge('wrong@example.com');
   assert.equal((await api(prefix+'/verify',{method:'POST',data:{challengeId:c.challengeId,code:c.code}})).res.status,400);
   for(let i=0;i<5;i++)assert.equal((await api(prefix+'/verify',{method:'POST',cookie:c.browser,data:{challengeId:c.challengeId,code:c.code==='000000'?'000001':'000000'}})).res.status,400);
   assert.equal((await api(prefix+'/verify',{method:'POST',cookie:c.browser,data:{challengeId:c.challengeId,code:c.code}})).res.status,400);
   const exp=await challenge('expired@example.com');await sql('UPDATE booking_challenges SET expires=0 WHERE id=?',[exp.challengeId]);
   assert.equal((await api(prefix+'/verify',{method:'POST',cookie:exp.browser,data:{challengeId:exp.challengeId,code:exp.code}})).res.status,400);
   const good=await challenge('visitor@example.com');
   const attempts=await Promise.all([0,1].map(()=>api(prefix+'/verify',{method:'POST',cookie:good.browser,data:{challengeId:good.challengeId,code:good.code}})));
   assert.deepEqual(attempts.map(a=>a.res.status).sort(),[200,400]);const valid=attempts.find(a=>a.res.status===200);visitorCookie=good.browser+'; '+valid.res.headers.get('set-cookie').split(';')[0];
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
   await sql("INSERT INTO fixture_mail(email,body) VALUES('__model',?)",[JSON.stringify({fit:'possible',reasons:['Potential thesis fit'],evidence:['I build interfaces that help people work with AI agents.']})]);
   settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,autoBookPriority:true}})).value.settings;
   const cookie=await visitor('auto@example.com'),r=await submit(cookie),s=(await api(prefix+'/slots?requestId='+r.id,{cookie})).value.slots[0];
   assert.ok(Date.parse(s.start)<Date.now()+7*86400000);const before=inserts;sourceMissing=true;
   const downgraded=await api(prefix+'/requests/'+r.id+'/slot',{method:'POST',cookie,data:{start:s.start}});assert.equal(downgraded.value.request.status,'needs_new_slot');assert.equal(inserts,before);
   sourceMissing=false;const r2=await submit(cookie),s2=(await api(prefix+'/slots?requestId='+r2.id,{cookie})).value.slots[0];
   const booked=await api(prefix+'/requests/'+r2.id+'/slot',{method:'POST',cookie,data:{start:s2.start}});assert.equal(booked.value.request.status,'booked',JSON.stringify(booked.value));assert.equal(inserts,before+1);
   await sql("DELETE FROM fixture_mail WHERE email='__model'");settings=(await api('/api/booking/settings',{method:'POST',cookie:ownerCookie,data:{...settings,autoBookPriority:false}})).value.settings;
  });
  await t.test('active reservations are not hidden by a large history inbox',async()=>{
   const r=JSON.parse((await sql('SELECT data FROM booking_requests WHERE id=?',[first.id]))[0].data);
   await sql('UPDATE booking_requests SET created_at=0 WHERE id=?',[first.id]);
   await sql(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO booking_requests SELECT 'history-'||x,'owner@example.com','history@example.com','key-'||x,?,json_set(?,'$.id','history-'||x,'$.status','async_submitted') FROM n`,[Date.now(),JSON.stringify(r)]);
   const all=(await api('/api/booking',{cookie:ownerCookie})).value.requests;assert.equal(all.length,1000);
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
 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
