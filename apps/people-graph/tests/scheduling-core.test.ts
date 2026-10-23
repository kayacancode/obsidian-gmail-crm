import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingCoordinator,publicBookingRequest} from '../src/booking-coordinator';
import {BookingStore} from '../src/booking-store';
import {defaultBookingSettings,decideBooking} from '../src/booking-policy';
import {seal} from '../src/mail-model';
import type {BookingRequestRecord,BookingVisitorIdentity} from '../src/booking-types';
const owner='owner@example.com';
const visitor:BookingVisitorIdentity={email:'visitor@example.com',subject:'a'.repeat(43),emailAuthoritative:true};
const submission={name:'Visitor',project:'Agent memory',purpose:'Private discussion',projectUrl:'',referrer:''};
const fit={fit:'strong' as const,reasons:['Fits.'],evidence:['Agent memory'],model:'test'};
export async function schedulingFixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:'),durable=new DatabaseSync(':memory:');t.after(()=>{sqlite.close();durable.close();});
 const db:any={prepare(sql:string){let args:any[]=[];const stmt:any={bind(...values:any[]){args=values;return stmt;},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return stmt;},async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()));}};
 let alarms=0;
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){const rows=durable.prepare(sql).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{alarms++;}}};
 const env:any={DB:db,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',MAIL_TOKEN_KEY:'test-key',TOKEN_SECRET:'test-session',BOOKING_OWNER_EMAIL:owner,AI:{run:async()=>({output_text:JSON.stringify({fit:fit.fit,reasons:fit.reasons,evidence:['SECRET CONTEXT']})})}};
 const store=new BookingStore(db);await store.init();
 const settings={...defaultBookingSettings(owner),revision:1,enabled:true,autoBookPriority:true,slug:'test-host',thesis:'Meet founders building infrastructure and durable memory for AI agents.',vipEmails:[visitor.email]};
 await store.saveSettings(settings,0);
 await store.saveCalendar({owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}),env.MAIL_TOKEN_KEY)});
 const service=new BookingCoordinator(ctx as any,env);
 function record(patch:Partial<BookingRequestRecord>={}):BookingRequestRecord{return {...submission,id:crypto.randomUUID(),owner,email:visitor.email,visitorSubject:visitor.subject,emailAuthoritative:true,createdAt:Date.now(),updatedAt:Date.now(),status:'pending_approval',decision:decideBooking(settings,visitor.email,fit,{status:'matched',email:visitor.email,lastSync:new Date().toISOString(),reason:'Exact contact.'}),slotStart:null,slotEnd:null,eventId:null,idempotencyKey:crypto.randomUUID(),...patch};}
 return {sqlite,durable,env,store,settings,service,record,alarms:()=>alarms};
}


const now=Date.parse('2026-10-23T12:00:00Z');
const input={email:visitor.email,name:'Visitor',context:'SECRET CONTEXT',instructions:'SECRET INSTRUCTIONS',idempotencyKey:'scheduling_test_key'};
const authority={channel:'owner_api' as const,evidenceId:'credential-1'};
function calendar(t:TestContext){
 const state={busy:[] as {start:string;end:string}[],writes:[] as any[],uncertain:false,found:false};
 t.mock.method(globalThis,'fetch',async(value:any,init:any)=>{
  const url=String(value);
  if(url.includes('/token'))return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600});
  if(url.endsWith('/freeBusy')){const body=JSON.parse(init.body);return Response.json({kind:'calendar#freeBusy',timeMin:body.timeMin,timeMax:body.timeMax,calendars:{primary:{busy:state.busy}}});}
  if(url.includes('/events/')&&(!init?.method||init.method==='GET'))return state.found?Response.json({id:url.split('/').at(-1),status:'confirmed'}):new Response('',{status:404});
  if(url.includes('/events?')){const event=JSON.parse(init.body);state.writes.push(event);if(state.uncertain)throw Error('lost response');state.found=true;return Response.json({id:event.id,status:'confirmed'});}
  throw Error('unexpected provider '+url);
 });return state;
}
function source(env:any,contact?:any){
 const lens={revision:'lens-v1',fields:{focus:'PRIVATE FOCUS',needs:'PRIVATE NEEDS',offers:'PRIVATE OFFERS'},suggestions:[{text:'UNCONFIRMED SECRET'}]};
 env.MAIL={getByName:(who:string)=>{assert.equal(who,owner);return {bindOwner:async(who:string)=>assert.equal(who,owner),bookingContact:async(email:string)=>{assert.equal(email,visitor.email);return contact??{owner,email:visitor.email,name:'Known Visitor',score:72,checkedAt:Date.now(),sourceUpdatedAt:Date.now()-60000};},bookingPerson:async()=>({...(contact??{owner,email:visitor.email,name:'Known Visitor',score:72,checkedAt:Date.now(),sourceUpdatedAt:Date.now()-60000}),status:'matched'}),getOwnerLens:async()=>lens};}};return lens;
}
test('scheduling priority assessment offers immediate permitted dates without a visitor identity or Rust',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);delete f.env.PEOPLEGRAPH_HOST;
 assert.equal(typeof (f.service as any).prepareScheduling,'function');
 const r=await f.service.prepareScheduling(owner,input,authority);
 assert.equal(r.status,'pending_approval');assert.equal(r.offer?.slots.length,3);
 assert.ok(Date.parse(r.offer!.slots[0].start)<now+7*86400000);assert.ok(r.offer!.expiresAt<=now+48*3600000);assert.ok(r.offer!.expiresAt<Date.parse(r.offer!.slots[0].start));
 assert.equal(new Set(r.offer!.slots.map(slot=>slot.start.slice(0,10))).size,3);
 const saved=await f.store.request(owner,r.requestId);assert.equal(saved?.visitorSubject,undefined);assert.equal(saved?.emailAuthoritative,undefined);assert.equal(saved?.decision.tier,'priority');
 assert.deepEqual(saved?.scheduling?.authority,authority);
 assert.ok(r.recommendation.reasons.some(reason=>reason.includes('72')));assert.ok(!JSON.stringify(r.recommendation).includes('PRIVATE FOCUS'));
 assert.ok(!JSON.stringify(r.recommendation).includes('UNCONFIRMED'));
 assert.ok(!r.replyText.includes('SECRET'));assert.ok(!r.replyText.includes('PRIVATE'));
 await assert.rejects(f.service.slots(owner,visitor,f.settings.slug,r.requestId),/not_found/);
 assert.ok(!JSON.stringify(publicBookingRequest(saved!)).includes('PRIVATE'));
});
test('scheduling validates authority and unknown caller fields before any request is stored',async t=>{
 const f=await schedulingFixture(t);calendar(t);
 assert.equal(typeof (f.service as any).prepareScheduling,'function');
 for(const bad of [{channel:'visitor',evidenceId:'x'},{channel:'owner_api',evidenceId:''},null])await assert.rejects(f.service.prepareScheduling(owner,input,bad as any),/invalid_authority/);
 for(const bad of [{...input,owner:'other@example.com'},{...input,authority},{...input,timezone:'Mars'},{...input,windowStart:'2026-02-30T12:00:00Z'},{...input,email:owner}])await assert.rejects(f.service.prepareScheduling(owner,bad as any,authority),/invalid_/);
 assert.equal((await f.store.requests(owner)).length,0);
});
test('scheduling bounds explicit windows by horizon and preserves original request on idempotent prepare',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);
 assert.equal(typeof (f.service as any).prepareScheduling,'function');
 const windowed={...input,windowStart:'2026-10-27T15:00:00Z',windowEnd:'2026-10-27T20:00:00Z',timezone:'America/Los_Angeles'};
 const r=await f.service.prepareScheduling(owner,windowed,authority);
 assert.ok(r.offer!.slots.every(slot=>slot.start>='2026-10-27T15:00:00.000Z'&&slot.end<='2026-10-27T20:00:00.000Z'));assert.equal(r.timezone,'America/Los_Angeles');
 assert.deepEqual(await f.service.prepareScheduling(owner,windowed,authority),r);
 await assert.rejects(f.service.prepareScheduling(owner,{...windowed,context:'Changed'},authority),/idempotency_conflict/);
 await assert.rejects(f.service.prepareScheduling(owner,{...input,idempotencyKey:'outside_horizon_key',windowStart:'2027-01-01T12:00:00Z'},authority),/invalid_window/);
});
test('scheduling exact current offers automatically book and keep calendar descriptions neutral',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);
 assert.equal(typeof (f.service as any).prepareScheduling,'function');
 const prepared=await f.service.prepareScheduling(owner,input,authority),offer=prepared.offer!,confirmation={revision:offer.revision,slotId:offer.slots[0].id,evidenceId:'reply-1'};
 await assert.rejects(f.service.confirmScheduling(owner,prepared.requestId,{...confirmation,slotId:'not-offered'}),/offer_changed/);
 const booked=await f.service.confirmScheduling(owner,prepared.requestId,confirmation);assert.equal(booked.status,'booked');assert.equal(booked.offer,null);
 assert.equal(cal.writes.length,1);assert.deepEqual(cal.writes[0].attendees,[{email:visitor.email}]);assert.ok(!JSON.stringify(cal.writes).match(/SECRET|PRIVATE|UNCONFIRMED/));
 assert.equal((await f.service.confirmScheduling(owner,prepared.requestId,confirmation)).status,'booked');assert.equal(cal.writes.length,1);
 await assert.rejects(f.service.confirmScheduling(owner,prepared.requestId,{...confirmation,slotId:offer.slots[1].id}),/request_closed/);
});
test('scheduling expired and superseded offers cannot book and refresh creates a distinct current revision',async t=>{
 let clock=now;t.mock.method(Date,'now',()=>clock);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);
 const first=await f.service.prepareScheduling(owner,input,authority),original=first.offer!;
 clock=original.expiresAt;
 await assert.rejects(f.service.confirmScheduling(owner,first.requestId,{revision:original.revision,slotId:original.slots[0].id,evidenceId:'expired-reply'}),/offer_expired/);
 assert.equal((await f.service.getScheduling(owner,first.requestId)).offer,null);
 const fresh=await f.service.refreshScheduling(owner,first.requestId);assert.notEqual(fresh.offer?.revision,original.revision);
 await assert.rejects(f.service.confirmScheduling(owner,first.requestId,{revision:original.revision,slotId:original.slots[0].id,evidenceId:'old-reply'}),/offer_changed/);
 await f.store.saveSettings({...f.settings,revision:2,durationMinutes:60},1);
 assert.equal((await f.service.getScheduling(owner,first.requestId)).status,'pending_approval');
 await assert.rejects(f.service.confirmScheduling(owner,first.requestId,{revision:fresh.offer!.revision,slotId:fresh.offer!.slots[0].id,evidenceId:'policy-reply'}),/settings_changed/);
 const current=await f.service.refreshScheduling(owner,first.requestId);assert.equal(Date.parse(current.offer!.slots[0].end)-Date.parse(current.offer!.slots[0].start),3600000);assert.equal(cal.writes.length,0);
});
test('scheduling stale and mismatched private sources yield uncertainty without invented matches',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);
 for(const [index,patch] of [{owner:'other@example.com'},{email:'other@example.com'},{sourceUpdatedAt:now-86400001},{checkedAt:now-300001},{score:NaN}].entries()){
  const lens=source(f.env,{owner,email:visitor.email,name:'Known Visitor',score:72,checkedAt:now,sourceUpdatedAt:now-60000,...patch});lens.fields={focus:'',needs:'',offers:''};
  const result=await f.service.prepareScheduling(owner,{...input,idempotencyKey:'invalid_contact_key_'+index},authority);
  assert.equal(result.offer,null);assert.equal(result.requiresReview,true);assert.ok(result.recommendation.uncertainties.length>=1);assert.ok(!JSON.stringify(result).includes('UNCONFIRMED'));
 }
 delete f.env.MAIL;const result=await f.service.prepareScheduling(owner,{...input,idempotencyKey:'missing_context_key'},authority);assert.equal(result.offer,null);assert.equal(result.requiresReview,true);
});
test('scheduling confirmation serializes cross-request conflicts against the existing reservation store',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);
 const a=await f.service.prepareScheduling(owner,input,authority),b=await f.service.prepareScheduling(owner,{...input,idempotencyKey:'second_scheduling_key'},authority);
 const choose=(r:any)=>({revision:r.offer.revision,slotId:r.offer.slots[0].id,evidenceId:'reply-'+r.requestId});
 const results=await Promise.all([f.service.confirmScheduling(owner,a.requestId,choose(a)),f.service.confirmScheduling(owner,b.requestId,choose(b))]);
 assert.deepEqual(results.map(r=>r.status),['booked','needs_new_slot']);assert.equal(cal.writes.length,1);assert.equal(results[1].offer,null);
});
test('scheduling uncertain writes preserve one event across expiry, policy change and coordinator restart',async t=>{
 let clock=now;t.mock.method(Date,'now',()=>clock);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);cal.uncertain=true;
 const r=await f.service.prepareScheduling(owner,input,authority),offer=r.offer!,confirmation={revision:offer.revision,slotId:offer.slots[0].id,evidenceId:'reply-uncertain'};
 assert.equal((await f.service.confirmScheduling(owner,r.requestId,confirmation)).status,'booking');
 const saved=await f.store.request(owner,r.requestId);assert.equal(saved?.status,'booking');assert.ok(saved?.eventId);
 clock=offer.expiresAt+1;await f.store.saveSettings({...f.settings,revision:2,enabled:false},1);
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){return {toArray:()=>f.durable.prepare(sql).all(...args)};}},setAlarm:async()=>{}}};
 const restarted=new BookingCoordinator(ctx as any,f.env);
 assert.equal((await restarted.confirmScheduling(owner,r.requestId,confirmation)).status,'booking');assert.equal(cal.writes.length,1);
 cal.found=true;assert.equal((await restarted.confirmScheduling(owner,r.requestId,confirmation)).status,'booked');assert.equal(cal.writes.length,1);
 assert.equal((await f.store.request(owner,r.requestId))?.eventId,saved?.eventId);
});
test('scheduling uncertain recovery returns durable booking state during provider lookup outage',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);cal.uncertain=true;
 const r=await f.service.prepareScheduling(owner,input,authority),confirmation={revision:r.offer!.revision,slotId:r.offer!.slots[0].id,evidenceId:'reply-outage'};
 assert.equal((await f.service.confirmScheduling(owner,r.requestId,confirmation)).status,'booking');
 t.mock.method(globalThis,'fetch',async()=>{throw Error('provider down');});
 assert.equal((await f.service.confirmScheduling(owner,r.requestId,confirmation)).status,'booking');
});
test('owner request-times invalidates old scheduling offers rather than accepting the stale selection',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);
 const r=await f.service.prepareScheduling(owner,input,authority);
 await f.service.requestTimes(owner,r.requestId);
 assert.equal((await f.service.getScheduling(owner,r.requestId)).offer,null);
 await assert.rejects(f.service.confirmScheduling(owner,r.requestId,{revision:r.offer!.revision,slotId:r.offer!.slots[0].id,evidenceId:'old-slot'}),/offer_changed/);
});
test('legacy owner approve cannot bypass a scheduling offer after a pre-write Calendar failure',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);
 const r=await f.service.prepareScheduling(owner,input,authority),slot=r.offer!.slots[0];
 const saved=(await f.store.request(owner,r.requestId))!;
 // A crash between persisted selection and the second fresh Calendar check leaves
 // a preference, not an in-flight reservation. Ordinary approval must not book it.
 saved.slotStart=slot.start;saved.slotEnd=slot.end;saved.slotSource='offered';saved.scheduling!.confirmation={revision:r.offer!.revision,slotId:slot.id,evidenceId:'reply-before-failure'};await f.store.update(saved);
 await f.store.saveSettings({...f.settings,revision:2},1);
 await assert.rejects(f.service.act(owner,r.requestId,'approve'),/request_closed/);assert.equal(cal.writes.length,0);
});
test('private scheduling advice states that freeform constraints have not been validated',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);
 const r=await f.service.prepareScheduling(owner,{...input,instructions:'Only Wednesday mornings'},authority);
 assert.ok(r.recommendation.uncertainties.some(value=>/instructions.*not.*validated/i.test(value)));
 assert.ok(!r.replyText.includes('Wednesday mornings'));
});

test('shared assessment gates uncertain and weak scheduling requests before availability or Calendar writes',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);delete f.env.PEOPLEGRAPH_HOST;
 await f.store.saveSettings({...f.settings,revision:2,vipEmails:[]},1);
 for(const [index,kind] of ['uncertain','weak'].entries()){
  f.env.AI.run=async()=>({output_text:JSON.stringify({fit:kind,reasons:['Meeting context does not establish fit.'],evidence:kind==='weak'?['SECRET CONTEXT']:[]})});
  const result=await f.service.prepareScheduling(owner,{...input,idempotencyKey:'gated_request_key_'+index},authority);
  assert.equal(result.offer,null);assert.equal((result as any).requiresReview,true);assert.equal(result.status,'pending_approval');
  assert.equal((result as any).decision.fit.fit,kind);assert.equal(result.decision?.tier,kind==='weak'?'async':'review');assert.ok(!result.replyText.includes('SECRET'));assert.equal(cal.writes.length,0);
 }
});
test('shared assessment requires explicit owner approval and invalidates that approval when policy changes',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);delete f.env.PEOPLEGRAPH_HOST;delete f.env.AI;
 const result=await f.service.prepareScheduling(owner,input,authority);assert.equal(result.offer,null);
 assert.equal(typeof (f.service as any).approveScheduling,'function');
 await assert.rejects((f.service as any).approveScheduling(owner,result.requestId,0),/settings_changed/);
 const approved=await (f.service as any).approveScheduling(owner,result.requestId,1);assert.ok(approved.offer?.slots.length);assert.equal(approved.requiresReview,false);assert.equal(approved.decision.tier,'review');
 await f.store.saveSettings({...f.settings,revision:2},1);
 assert.equal((await f.service.getScheduling(owner,result.requestId) as any).requiresReview,true);
 await assert.rejects(f.service.confirmScheduling(owner,result.requestId,{revision:approved.offer.revision,slotId:approved.offer.slots[0].id,evidenceId:'stale-policy'}),/settings_changed/);
 await assert.rejects((f.service as any).approveScheduling(owner,result.requestId,2),/settings_changed/);assert.equal(cal.writes.length,0);
});
test('shared assessment blocks legacy unassessed offers before read and confirmation',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);
 const legacy=f.record({visitorSubject:undefined,emailAuthoritative:undefined,scheduling:{authority,input,timezone:f.settings.timezone,settingsRevision:1,windowStart:new Date(now).toISOString(),windowEnd:new Date(now+86400000*7).toISOString(),recommendation:{summary:'Old delegated request',reasons:[],uncertainties:[]},offer:{revision:'old',expiresAt:now+3600000,slots:[{id:'old-slot',start:'2026-10-26T13:00:00.000Z',end:'2026-10-26T13:30:00.000Z'}]}}});await f.store.add(legacy);
 const result=await f.service.getScheduling(owner,legacy.id);assert.equal(result.offer,null);assert.equal((result as any).requiresReview,true);
 await assert.rejects(f.service.confirmScheduling(owner,legacy.id,{revision:'old',slotId:'old-slot',evidenceId:'old-reply'}),/assessment_required/);assert.equal(cal.writes.length,0);
});

test('shared assessment applies identical saved-thesis decisions to public intake and delegated requests',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);
 await f.store.saveSettings({...f.settings,revision:2,vipEmails:[]},1);
 const project='We are building durable memory for AI agents.',purpose='Discuss design partners and our developer tooling.',seen:any[]=[];
 for(const [index,kind] of ['strong','possible','weak','uncertain'].entries()){
  f.env.AI.run=async(_model:any,payload:any)=>{seen.push(payload);return {output_text:JSON.stringify({fit:kind,reasons:['Evidence assessed against the saved thesis.'],evidence:kind==='uncertain'?[]:['durable memory for AI agents']})};};
  const publicRequest=await f.service.submit(owner,visitor,f.settings.slug,{name:'Visitor',project,purpose,projectUrl:'',referrer:'',idempotencyKey:'public_parity_key_'+index});
  const delegated=await f.service.prepareScheduling(owner,{...input,context:project+' '+purpose,idempotencyKey:'delegated_parity_key_'+index},authority);
  assert.deepEqual(delegated.decision,publicRequest.decision);assert.equal(!!delegated.offer,publicRequest.decision.tier==='priority');
  assert.equal(delegated.requiresReview,publicRequest.decision.tier!=='priority');
 }
 assert.ok(seen.every(payload=>JSON.stringify(payload).includes(f.settings.thesis)));assert.ok(seen.every(payload=>!JSON.stringify(payload).includes('PRIVATE FOCUS')));
});
test('shared assessment rechecks relationship freshness at confirmation without rerunning fit',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t),cal=calendar(t);source(f.env);let fits=0;
 f.env.AI.run=async()=>{fits++;return {output_text:JSON.stringify({fit:'strong',reasons:['Fits the saved thesis.'],evidence:['SECRET CONTEXT']})};};
 const prepared=await f.service.prepareScheduling(owner,input,authority);assert.ok(prepared.offer);assert.equal(fits,1);
 source(f.env,{owner,email:visitor.email,name:'Known Visitor',score:72,checkedAt:now,sourceUpdatedAt:now-86400001});
 const blocked=await f.service.confirmScheduling(owner,prepared.requestId,{revision:prepared.offer!.revision,slotId:prepared.offer!.slots[0].id,evidenceId:'reply-during-outage'});
 assert.equal(blocked.requiresReview,true);assert.equal(blocked.offer,null);assert.equal(cal.writes.length,0);assert.equal(fits,1);
 const approved=await f.service.approveScheduling(owner,prepared.requestId,1);assert.equal(approved.requiresReview,false);assert.ok(approved.offer);assert.equal(approved.decision?.people.status,'stale');
 const booked=await f.service.confirmScheduling(owner,prepared.requestId,{revision:approved.offer!.revision,slotId:approved.offer!.slots[0].id,evidenceId:'owner-approved-reply'});assert.equal(booked.status,'booked');assert.equal(cal.writes.length,1);
});
test('shared assessment refresh replaces legacy bypass with a real review decision',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);calendar(t);source(f.env);delete f.env.AI;
 const legacy=f.record({visitorSubject:undefined,emailAuthoritative:undefined,scheduling:{authority,input,timezone:f.settings.timezone,settingsRevision:1,windowStart:new Date(now).toISOString(),windowEnd:new Date(now+86400000*7).toISOString(),recommendation:{summary:'Old delegated request',reasons:[],uncertainties:[]},offer:{revision:'old',expiresAt:now+3600000,slots:[{id:'old-slot',start:'2026-10-26T13:00:00.000Z',end:'2026-10-26T13:30:00.000Z'}]}}});await f.store.add(legacy);
 const result=await f.service.refreshScheduling(owner,legacy.id);assert.equal(result.offer,null);assert.equal(result.requiresReview,true);assert.equal(result.decision?.fit.fit,'uncertain');assert.equal((await f.store.request(owner,legacy.id))?.scheduling?.assessmentVersion,1);
});

test('shared assessment readiness recognizes only a fresh complete local relationship source',async t=>{
 t.mock.method(Date,'now',()=>now);const f=await schedulingFixture(t);source(f.env);
 const {bookingReadiness}=await import('../src/booking-coordinator');
 let ready=true,sourceUpdatedAt=now-1000,sourceOwner=owner;
 f.env.MAIL={getByName:()=>({bindOwner:async()=>{},bookingSourceStatus:async()=>({owner:sourceOwner,ready,checkedAt:now,sourceUpdatedAt})})};
 assert.equal((await bookingReadiness(f.env,owner)).people,true);
 ready=false;assert.equal((await bookingReadiness(f.env,owner)).people,false);ready=true;
 sourceUpdatedAt=now-86400001;assert.equal((await bookingReadiness(f.env,owner)).people,false);sourceUpdatedAt=now-1000;
 sourceOwner='other@example.com';assert.equal((await bookingReadiness(f.env,owner)).people,false);sourceOwner=owner;
 f.env.PEOPLEGRAPH_HOST='https://configured.test';assert.equal((await bookingReadiness(f.env,owner)).people,false);
});
