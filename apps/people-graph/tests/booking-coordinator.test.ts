import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingCoordinator,bookingReadiness,publicBookingRequest} from '../src/booking-coordinator';
import {BookingStore} from '../src/booking-store';
import {defaultBookingSettings,decideBooking} from '../src/booking-policy';
import {seal} from '../src/mail-model';
import type {BookingRequestRecord,BookingVisitorIdentity} from '../src/booking-types';

const owner='owner@example.com';
const visitor:BookingVisitorIdentity={email:'visitor@example.com',subject:'a'.repeat(43),emailAuthoritative:true};
const submission={name:'Visitor',project:'We are building durable memory for agents.',purpose:'Discuss our developer tooling and design partners.',projectUrl:'',referrer:''};
const fit={fit:'strong' as const,reasons:['Agent infrastructure fits.'],evidence:['durable memory for agents'],model:'test'};
function returningContact(){return {owner,email:visitor.email,name:'Known Visitor',score:70,checkedAt:Date.now(),sourceUpdatedAt:Date.now()-60000};}
function returningSource(env:any,value:ReturnType<typeof returningContact>|null){
 const source={bindOwner:async(boundOwner:string)=>{assert.equal(boundOwner,owner);},bookingContact:async(email:string)=>{assert.equal(email,visitor.email);return value;}};
 env.MAIL={getByName:(requestedOwner:string)=>{assert.equal(requestedOwner,owner);return source;}};
 return source;
}
async function fixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:'),durable=new DatabaseSync(':memory:');t.after(()=>{sqlite.close();durable.close();});
 const db:any={prepare(sql:string){let args:any[]=[];const stmt:any={bind(...values:any[]){args=values;return stmt;},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return stmt;},async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()));}};
 let alarms=0,alarmAt:number|null=null;
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){const rows=durable.prepare(sql).all(...args);return {toArray:()=>rows};}},setAlarm:async(at:number)=>{alarms++;alarmAt=at;},deleteAlarm:async()=>{alarmAt=null;}}};
 const env:any={DB:db,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',MAIL_TOKEN_KEY:'test-key',TOKEN_SECRET:'test-session',BOOKING_OWNER_EMAIL:owner,PEOPLEGRAPH_HOST:'https://source.test',PEOPLEGRAPH_TOKEN:'source-token',PEOPLEGRAPH_OWNER_EMAIL:owner,AI:{run:async()=>({output_text:JSON.stringify({fit:fit.fit,reasons:fit.reasons,evidence:fit.evidence})})}};
 const store=new BookingStore(db);await store.init();
 const settings={...defaultBookingSettings(owner),revision:1,enabled:true,autoBookPriority:true,slug:'test-host',thesis:'Meet founders building infrastructure and durable memory for AI agents.',vipEmails:[visitor.email]};
 await store.saveSettings(settings,0);
 await store.saveCalendar({owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}),env.MAIL_TOKEN_KEY)});
 const service=new BookingCoordinator(ctx as any,env);
 function record(patch:Partial<BookingRequestRecord>={}):BookingRequestRecord{return {...submission,id:crypto.randomUUID(),owner,email:visitor.email,visitorSubject:visitor.subject,emailAuthoritative:true,createdAt:Date.now(),updatedAt:Date.now(),status:'pending_approval',decision:decideBooking(settings,visitor.email,fit,{status:'matched',email:visitor.email,lastSync:new Date().toISOString(),reason:'Exact contact.'}),slotStart:null,slotEnd:null,eventId:null,idempotencyKey:crypto.randomUUID(),...patch};}
 return {sqlite,durable,env,store,settings,service,record,ctx,alarms:()=>alarms,alarmAt:()=>alarmAt};
}

test('booking readiness requires Google credentials without a custom-email binding',async t=>{
 const f=await fixture(t);assert.equal((await bookingReadiness(f.env,owner)).signIn,true);
 for(const field of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','MAIL_TOKEN_KEY','TOKEN_SECRET'])assert.equal((await bookingReadiness({...f.env,[field]:''},owner)).signIn,false,field);
});
test('legacy booking settings hydrate returning defaults without rewriting or publishing the saved revision',async t=>{
 const f=await fixture(t),legacy={...f.settings,enabled:false} as Record<string,unknown>;
 delete legacy.returningContactsEnabled;delete legacy.returningScoreThreshold;
 const saved=JSON.stringify(legacy);
 f.sqlite.prepare('UPDATE booking_settings SET data=? WHERE owner=?').run(saved,owner);
 for(const loaded of [await f.store.settings(owner),await f.store.slug(f.settings.slug)]){
  assert.equal(loaded?.returningContactsEnabled,true);assert.equal(loaded?.returningScoreThreshold,70);
  assert.equal(loaded?.revision,1);assert.equal(loaded?.enabled,false);
 }
 assert.equal((f.sqlite.prepare('SELECT data FROM booking_settings WHERE owner=?').get(owner) as any).data,saved);
 const next=await f.service.saveSettings(owner,{revision:1,displayName:'Owner'});
 assert.equal(next.revision,2);assert.equal(next.returningContactsEnabled,true);assert.equal(next.returningScoreThreshold,70);
});
test('returning submission resolves contact identity server-side and keeps VIPs in review without AI or Rust',async t=>{
 const f=await fixture(t),contact=returningContact();returningSource(f.env,contact);
 let aiCalls=0,externalCalls=0;
 f.env.AI.run=async()=>{aiCalls++;return {output_text:JSON.stringify(fit)};};
 t.mock.method(globalThis,'fetch',async()=>{externalCalls++;throw Error('unexpected external lookup');});
 const r=await f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',note:'  Catch up about the latest project.  ',idempotencyKey:'returning_request_key',name:'Spoofed name',email:'spoofed@example.com',score:100,project:submission.project,projectUrl:'https://example.com',referrer:'VIP',purpose:'Forged project thesis',emailAuthoritative:false,visitorSubject:'forged'});
 assert.equal(r.name,'Known Visitor');assert.equal(r.email,visitor.email);assert.equal(r.visitorSubject,visitor.subject);assert.equal(r.emailAuthoritative,true);
 assert.equal(r.project,'');assert.equal(r.projectUrl,'');assert.equal(r.referrer,'');assert.equal(r.purpose,'Catch up about the latest project.');
 assert.equal(r.intakeKind,'returning');assert.equal(r.status,'pending_approval');assert.equal(r.decision.tier,'review');assert.equal(r.decision.fit.fit,'uncertain');assert.deepEqual(r.decision.fit.evidence,[]);
 assert.equal(r.decision.people.status,'matched');assert.equal(r.decision.people.score,70);assert.equal(r.decision.people.lastSync,new Date(contact.sourceUpdatedAt).toISOString());
 assert.ok(r.decision.reasons.some(reason=>/approval|review/i.test(reason)));assert.ok(r.decision.uncertainties.some(reason=>/thesis|fit/i.test(reason)));
 assert.equal(r.policySnapshot?.vipMatch,true);assert.equal(aiCalls,0);assert.equal(externalCalls,0);
 assert.equal((await f.store.request(owner,r.id))?.intakeKind,'returning');
});
test('returning requests accept an omitted or empty note and validate its text bounds',async t=>{
 const f=await fixture(t);returningSource(f.env,returningContact());
 for(const [index,note] of [undefined,'','x'.repeat(2000)].entries()){
  const r=await f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',note,idempotencyKey:'optional_note_key_'+index});
  assert.equal(r.purpose,note??'');assert.equal(r.status,'pending_approval');
 }
});
test('returning request note rejects malformed text without saving a request',async t=>{
 const f=await fixture(t);returningSource(f.env,returningContact());
 for(const [index,note] of [null,42,{},'x'.repeat(2001),'bad\u0000note'].entries())await assert.rejects(f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',note,idempotencyKey:'invalid_note_key_'+index}),/invalid_note/);
 assert.deepEqual(await f.store.requests(owner),[]);
});
test('returning submissions require current eligibility and never save a request on fallback',async t=>{
 const cases=[{contact:null},{contact:{...returningContact(),score:69}},{contact:returningContact(),disabled:true},{contact:returningContact(),threshold:71},{contact:returningContact(),authoritative:false}];
 for(const [index,item] of cases.entries()){
  const f=await fixture(t);returningSource(f.env,item.contact);
  if(item.disabled||item.threshold)await f.store.saveSettings({...f.settings,revision:2,returningContactsEnabled:!item.disabled,returningScoreThreshold:item.threshold??70},1);
  await assert.rejects(f.service.submit(owner,{...visitor,emailAuthoritative:item.authoritative??true},f.settings.slug,{kind:'returning',note:'Catch up',idempotencyKey:'ineligible_request_'+index,name:'Forged Known Visitor',score:100,email:visitor.email}),/intake_required/);
  assert.deepEqual(await f.store.requests(owner),[]);
 }
});
test('returning retry recovers only the owned request before rechecking lost eligibility or rate limits',async t=>{
 const f=await fixture(t);returningSource(f.env,returningContact());
 const input={kind:'returning',note:'Catch up',idempotencyKey:'returning_retry_key'};
 const original=await f.service.submit(owner,visitor,f.settings.slug,input);
 returningSource(f.env,null);
 for(let index=0;index<6;index++)assert.equal((await f.service.submit(owner,visitor,f.settings.slug,input)).id,original.id);
 await assert.rejects(f.service.submit(owner,{...visitor,subject:'b'.repeat(43)},f.settings.slug,input),/not_found/);
 await assert.rejects(f.service.submit(owner,visitor,f.settings.slug,{...input,idempotencyKey:'returning_new_retry_key'}),/intake_required/);
 assert.equal((await f.store.requests(owner)).length,1);
});
test('returning eligibility is checked after the submission rate limit',async t=>{
 const f=await fixture(t);let sourceCalls=0;
 const source=returningSource(f.env,returningContact());source.bookingContact=async()=>{sourceCalls++;return null;};
 for(let index=0;index<5;index++)await f.store.limit('submit:'+owner+':'+visitor.email,5,86400000);
 await assert.rejects(f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',idempotencyKey:'rate_limited_returning'}),/rate_limited/);
 assert.equal(sourceCalls,0);assert.deepEqual(await f.store.requests(owner),[]);
});
test('returning slot selection preserves owner approval even when priority auto-booking and VIP match are enabled',async t=>{
 const f=await fixture(t);returningSource(f.env,returningContact());
 const r=await f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',idempotencyKey:'returning_slot_request'});
 let eventWrites=0,sourceReads=0;
 t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const url=String(input);
  if(url.startsWith('https://source.test')){sourceReads++;throw Error('must not query');}
  if(url.includes('/token'))return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'});
  if(url.endsWith('/freeBusy')){const body=JSON.parse(init.body);return Response.json({kind:'calendar#freeBusy',timeMin:body.timeMin,timeMax:body.timeMax,calendars:{primary:{busy:[]}}});}
  eventWrites++;throw Error('must not insert event');
 });
 const slots=await f.service.slots(owner,visitor,f.settings.slug,r.id);assert.ok(slots.length);assert.ok(Date.parse(slots[0].start)>=r.createdAt+7*86400000);
 const selected=await f.service.selectSlot(owner,visitor,f.settings.slug,r.id,slots[0].start);
 assert.equal(selected.status,'pending_approval');assert.equal(selected.decision.tier,'review');assert.equal(selected.slotStart,slots[0].start);assert.equal(selected.eventId,null);
 assert.equal(sourceReads,0);assert.equal(eventWrites,0);
});
test('standard submissions retain required questionnaire validation even for a known contact',async t=>{
 const f=await fixture(t);returningSource(f.env,returningContact());
 for(const kind of [undefined,'standard'])await assert.rejects(f.service.submit(owner,visitor,f.settings.slug,{kind,name:'Known Visitor',note:'Catch up',idempotencyKey:'standard_required_'+String(kind)}),/invalid_project/);
 assert.deepEqual(await f.store.requests(owner),[]);
});
test('calendar slots include late month availability and selecting it still requires returning approval',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-01T12:00:00Z'));
 const f=await fixture(t);returningSource(f.env,returningContact());
 const r=await f.service.submit(owner,visitor,f.settings.slug,{kind:'returning',idempotencyKey:'returning_month_request'});
 t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const url=String(input);
  if(url.includes('/token'))return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'});
  if(url.endsWith('/freeBusy')){const body=JSON.parse(init.body);return Response.json({kind:'calendar#freeBusy',timeMin:body.timeMin,timeMax:body.timeMax,calendars:{primary:{busy:[]}}});}
  assert.fail('Selecting a returning request must not insert an event or query People');
 });
 const slots=await f.service.slots(owner,visitor,f.settings.slug,r.id);
 const start='2026-10-28T20:30:00.000Z';
 assert.ok(slots.some(slot=>slot.start===start));assert.ok(slots.length>100);
 assert.ok(slots.every(slot=>Date.parse(slot.start)>=r.createdAt+7*86400000));
 assert.ok(slots.every(slot=>Date.parse(slot.end)<=Date.parse('2026-10-29T12:00:00Z')));
 const selected=await f.service.selectSlot(owner,visitor,f.settings.slug,r.id,start);
 assert.equal(selected.status,'pending_approval');assert.equal(selected.decision.tier,'review');assert.equal(selected.slotStart,start);assert.equal(selected.eventId,null);
});
test('public request recovery exposes the intake kind without contact evidence or private decisions',async t=>{
 const f=await fixture(t),r=f.record({intakeKind:'returning'});
 assert.deepEqual(publicBookingRequest(r),{id:r.id,status:'pending_approval',slotStart:null,slotEnd:null,intakeKind:'returning'});
 assert.equal(publicBookingRequest(f.record()).intakeKind,'standard');
});
test('legacy custom-email outbox is inert after an alarm wakeup',async t=>{
 const f=await fixture(t);
 f.durable.exec('CREATE TABLE booking_outbox(id TEXT PRIMARY KEY,email TEXT,subject TEXT,body TEXT,attempts INTEGER DEFAULT 0)');
 f.durable.prepare('INSERT INTO booking_outbox(id,email,subject,body) VALUES(?,?,?,?)').run('old-notice',visitor.email,'Old notice','Old body');
 f.durable.prepare('INSERT INTO booking_identity(owner) VALUES(?)').run(owner);
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Legacy notification must not send');});
 await f.service.alarm();assert.equal(f.alarms(),0);
 assert.equal((f.durable.prepare('SELECT count(*) n FROM booking_outbox').get() as any).n,1);
});
test('non-authoritative Google email never queries People or receives VIP priority',async t=>{
 const f=await fixture(t);let lookups=0;
 t.mock.method(globalThis,'fetch',async()=>{lookups++;throw Error('must not query');});
 const r=await f.service.submit(owner,{...visitor,emailAuthoritative:false},f.settings.slug,{...submission,idempotencyKey:'non_authoritative_key',email:'attacker@example.com',visitorSubject:'forged',emailAuthoritative:true});
 assert.equal(lookups,0);assert.equal(r.email,visitor.email);assert.equal(r.visitorSubject,visitor.subject);assert.equal(r.emailAuthoritative,false);
 assert.equal(r.decision.tier,'review');assert.equal(r.decision.people.status,'unavailable');assert.equal(r.policySnapshot?.vipMatch,false);
 assert.ok(r.decision.uncertainties.length);
});
test('request idempotency cannot recover another Google subject or a legacy email-only record',async t=>{
 const f=await fixture(t),r=f.record();await f.store.add(r);
 assert.equal((await f.service.submit(owner,visitor,f.settings.slug,{idempotencyKey:r.idempotencyKey})).id,r.id);
 await assert.rejects(f.service.submit(owner,{...visitor,subject:'b'.repeat(43)},f.settings.slug,{idempotencyKey:r.idempotencyKey}),/not_found/);
 const legacy=f.record({visitorSubject:undefined,emailAuthoritative:undefined});await f.store.add(legacy);
 await assert.rejects(f.service.submit(owner,visitor,f.settings.slug,{idempotencyKey:legacy.idempotencyKey}),/not_found/);
});
test('slots and selection require both the saved Google subject and email',async t=>{
 const f=await fixture(t),r=f.record();await f.store.add(r);
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Unauthorized request must not access Calendar or People');});
 for(const identity of [{...visitor,subject:'b'.repeat(43)},{...visitor,email:'different@example.com'}]){
  await assert.rejects(f.service.slots(owner,identity,f.settings.slug,r.id),/not_found/);
  await assert.rejects(f.service.selectSlot(owner,identity,f.settings.slug,r.id,'2027-01-01T14:00:00.000Z'),/not_found/);
 }
 const legacy=f.record({visitorSubject:undefined});await f.store.add(legacy);
 await assert.rejects(f.service.slots(owner,visitor,f.settings.slug,legacy.id),/not_found/);
});
test('current or original email uncertainty keeps a cached priority request in review',async t=>{
 const f=await fixture(t);let sourceReads=0,eventWrites=0;
 t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const url=String(input);
  if(url.startsWith('https://source.test')){sourceReads++;throw Error('must not query');}
  if(url.includes('/token'))return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'});
  if(url.endsWith('/freeBusy')){const body=JSON.parse(init.body);return Response.json({kind:'calendar#freeBusy',timeMin:body.timeMin,timeMax:body.timeMax,calendars:{primary:{busy:[]}}});}
  eventWrites++;throw Error('must not insert event');
 });
 for(const [original,current] of [[false,true],[true,false]]){
  const r=f.record({emailAuthoritative:original});await f.store.add(r);
  const identity={...visitor,emailAuthoritative:current};
  const slots=await f.service.slots(owner,identity,f.settings.slug,r.id);assert.ok(slots.length);assert.ok(Date.parse(slots[0].start)>=r.createdAt+7*86400000);
  const selected=await f.service.selectSlot(owner,identity,f.settings.slug,r.id,slots[0].start);assert.equal(selected.status,'pending_approval');assert.equal(selected.decision.tier,'review');
 }
 assert.equal(sourceReads,0);assert.equal(eventWrites,0);
});


const proposalNow=Date.parse('2026-10-23T12:00:00Z');
const proposalInput={timezone:'America/New_York',times:['2026-11-01T18:20','2026-11-02T18:20']};
function proposalCalendar(t:TestContext){
 const state={busy:[] as {start:string;end:string}[],writes:[] as any[],lostWrite:false,found:false};
 t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const url=String(input);
  if(url.includes('/token'))return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'});
  if(url.endsWith('/freeBusy')){const body=JSON.parse(init.body);return Response.json({kind:'calendar#freeBusy',timeMin:body.timeMin,timeMax:body.timeMax,calendars:{primary:{busy:state.busy}}});}
  if(url.includes('/events/')&&(!init?.method||init.method==='GET'))return state.found?Response.json({id:url.split('/').at(-1),status:'confirmed'}):Response.json({error:'not found'},{status:404});
  if(url.includes('/events')&&init?.method==='POST'){const body=JSON.parse(init.body);state.writes.push(body);if(state.lostWrite)throw Error('lost response');return Response.json({id:body.id,status:'confirmed'});}
  assert.fail('Unexpected provider call '+url);
 });return state;
}
test('suggested times save privately, never auto-book, and identical retries recover before rate limiting',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record();await f.store.add(r);
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('Saving preferences cannot query or book Calendar');});
 const saved=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput);
 assert.equal(saved.status,'pending_approval');assert.equal(saved.slotStart,null);assert.equal(saved.eventId,null);assert.equal(saved.slotSource,'suggested');assert.equal(saved.proposedTimes?.slots.length,2);assert.ok(saved.proposedTimes?.revision);
 for(let i=0;i<12;i++)assert.equal((await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,{...proposalInput,times:[...proposalInput.times].reverse()})).proposedTimes?.revision,saved.proposedTimes?.revision);
 const projected=publicBookingRequest(saved);assert.deepEqual(projected.proposedTimes,saved.proposedTimes);assert.equal(projected.slotSource,'suggested');assert.equal('email' in projected,false);assert.equal('decision' in projected,false);
 const replaced=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,{...proposalInput,times:['2026-11-03T18:20']});assert.notEqual(replaced.proposedTimes?.revision,saved.proposedTimes?.revision);
});
test('suggested times require request identity and mutable state and cannot upgrade async decisions',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record();await f.store.add(r);
 for(const identity of [{...visitor,subject:'b'.repeat(43)},{...visitor,email:'other@example.com'}])await assert.rejects(f.service.proposeTimes(owner,identity,f.settings.slug,r.id,proposalInput),/not_found/);
 for(const status of ['booking','booked','cancelling','cancelled','declined','expired','async_submitted'] as const){const closed=f.record({status});await f.store.add(closed);await assert.rejects(f.service.proposeTimes(owner,visitor,f.settings.slug,closed.id,proposalInput),/request_closed/);}
 const asyncRequest=f.record({decision:{...r.decision,tier:'async'}});await f.store.add(asyncRequest);await assert.rejects(f.service.proposeTimes(owner,visitor,f.settings.slug,asyncRequest.id,proposalInput),/request_closed/);
 const reviewed=f.record({decision:{...r.decision,tier:'review'}});await f.store.add(reviewed);await assert.rejects(f.service.proposeTimes(owner,visitor,f.settings.slug,reviewed.id,{timezone:'UTC',times:['2026-10-29T18:00']}),/invalid_proposal_time/);
});
test('owner approves an exact current suggestion outside working hours with stable retry identity',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record({decision:{...f.record().decision,tier:'review'}});await f.store.add(r);const state=proposalCalendar(t);
 const saved=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput),set=saved.proposedTimes!;
 await assert.rejects(f.service.approveProposal(owner,r.id,set.slots[0].start,'old-revision'),/proposal_changed/);
 await assert.rejects(f.service.approveProposal(owner,r.id,'2026-11-01T23:21:00.000Z',set.revision),/proposal_changed/);
 const booked=await f.service.approveProposal(owner,r.id,set.slots[0].start,set.revision);
 assert.equal(booked.status,'booked');assert.equal(booked.slotSource,'suggested');assert.equal(booked.slotStart,set.slots[0].start);assert.equal(state.writes.length,1);
 assert.equal((await f.service.approveProposal(owner,r.id,set.slots[0].start,set.revision)).eventId,booked.eventId);assert.equal(state.writes.length,1);
 await assert.rejects(f.service.approveProposal(owner,r.id,set.slots[1].start,set.revision),/request_closed/);
});
test('suggested approval rejects replaced proposals and current duration, busy, buffer, notice or capacity conflicts',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record();await f.store.add(r);const state=proposalCalendar(t);
 const saved=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput),old=saved.proposedTimes!;
 const replacement=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,{...proposalInput,times:['2026-11-03T18:20']}),set=replacement.proposedTimes!,start=set.slots[0].start;
 await assert.rejects(f.service.approveProposal(owner,r.id,old.slots[0].start,old.revision),/proposal_changed/);
 state.busy=[{start:'2026-11-03T23:55:00Z',end:'2026-11-04T00:30:00Z'}];assert.equal((await f.service.approveProposal(owner,r.id,start,set.revision)).status,'needs_new_slot');state.busy=[];
 await f.store.saveSettings({...f.settings,revision:2,durationMinutes:45},1);assert.equal((await f.service.approveProposal(owner,r.id,start,set.revision)).status,'needs_new_slot');
 await f.store.saveSettings({...f.settings,revision:3,dailyLimit:1},2);
 await f.store.add(f.record({status:'booked',slotStart:'2026-11-03T14:00:00.000Z',slotEnd:'2026-11-03T14:30:00.000Z'}));assert.equal((await f.service.approveProposal(owner,r.id,start,set.revision)).status,'needs_new_slot');
 assert.equal(state.writes.length,0);assert.equal((await f.store.request(owner,r.id))?.slotStart,null);
});
test('offered selection and owner request-times clear alternatives without retaining a stale choice',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record({decision:{...f.record().decision,tier:'review'}});await f.store.add(r);proposalCalendar(t);
 await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput);
 const slots=await f.service.slots(owner,visitor,f.settings.slug,r.id),selected=await f.service.selectSlot(owner,visitor,f.settings.slug,r.id,slots[0].start);
 assert.equal(selected.proposedTimes,undefined);assert.equal(selected.slotSource,'offered');assert.ok(selected.slotStart);
 const cleared=await f.service.requestTimes(owner,r.id);assert.equal(cleared.status,'needs_new_slot');assert.equal(cleared.slotStart,null);assert.equal(cleared.slotEnd,null);assert.equal(cleared.slotSource,undefined);assert.equal(cleared.proposedTimes,undefined);
 const proposed=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput);const again=await f.service.requestTimes(owner,r.id);assert.equal(again.proposedTimes,undefined);
 await assert.rejects(f.service.approveProposal(owner,r.id,proposed.proposedTimes!.slots[0].start,proposed.proposedTimes!.revision),/proposal_changed/);
});
test('uncertain suggested Calendar writes retain the chosen start and event id through retry and reject edits',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);const f=await fixture(t),r=f.record();await f.store.add(r);const state=proposalCalendar(t);
 const saved=await f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput),set=saved.proposedTimes!;
 state.lostWrite=true;await assert.rejects(f.service.approveProposal(owner,r.id,set.slots[0].start,set.revision),/booking_in_progress/);
 const pending=await f.store.request(owner,r.id);assert.equal(pending?.status,'booking');assert.ok(pending?.eventId);assert.equal(state.writes.length,1);
 await assert.rejects(f.service.proposeTimes(owner,visitor,f.settings.slug,r.id,proposalInput),/request_closed/);await assert.rejects(f.service.requestTimes(owner,r.id),/request_closed/);await assert.rejects(f.service.approveProposal(owner,r.id,set.slots[1].start,set.revision),/request_closed/);
 state.lostWrite=false;const booked=await f.service.approveProposal(owner,r.id,set.slots[0].start,set.revision);assert.equal(booked.status,'booked');assert.equal(booked.eventId,pending?.eventId);assert.equal(state.writes.length,2);assert.equal(state.writes[1].id,state.writes[0].id);assert.deepEqual(state.writes[1].start,state.writes[0].start);
});

function notificationSender(f:Awaited<ReturnType<typeof fixture>>){
 const messages:any[]=[];
 f.env.APP_ORIGIN='https://people.test';f.env.SCHEDULING_EMAIL_ADDRESS='scheduling@agent.test';
 f.env.SCHEDULING_EMAIL_SEND={send:async(message:any)=>{messages.push(message);return {messageId:'sent-'+messages.length};}};
 return messages;
}
async function alertSelection(t:TestContext){
 const clock={now:proposalNow};t.mock.method(Date,'now',()=>clock.now);
 const f=await fixture(t),messages=notificationSender(f),calendar=proposalCalendar(t);
 const r=f.record({decision:{...f.record().decision,tier:'review'}});await f.store.add(r);
 const slots=await f.service.slots(owner,visitor,f.settings.slug,r.id);
 await f.service.selectSlot(owner,visitor,f.settings.slug,r.id,slots[0].start);
 return {...f,messages,calendar,r,slots,clock};
}
test('booking alerts persist selection intent and send once after restart, without booking',async t=>{
 const f=await alertSelection(t);assert.equal(f.messages.length,0);
 const restarted=new BookingCoordinator(f.ctx as any,f.env);
 await restarted.alarm();assert.equal(f.messages.length,1);assert.equal(f.messages[0].to,owner);
 assert.match(f.messages[0].text,/durable memory/);assert.ok(f.messages[0].text.includes('/booking?request='+f.r.id));
 assert.equal(f.calendar.writes.length,0);assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');
 await restarted.selectSlot(owner,visitor,f.settings.slug,f.r.id,f.slots[0].start);
 await restarted.alarm();assert.equal(f.messages.length,1);
});
test('booking alerts ignore superseded selections and requests declined before sending',async t=>{
 const f=await alertSelection(t);
 await f.service.selectSlot(owner,visitor,f.settings.slug,f.r.id,f.slots[1].start);
 await f.service.alarm();assert.equal(f.messages.length,1);
 const another=f.record({decision:{...f.r.decision,tier:'review'}});await f.store.add(another);
 await f.service.selectSlot(owner,visitor,f.settings.slug,another.id,f.slots[2].start);
 await f.service.act(owner,another.id,'decline');await f.service.alarm();assert.equal(f.messages.length,1);
});
test('booking alerts keep an uncertain delivery visible without replaying after restart',async t=>{
 const f=await alertSelection(t);let attempts=0;
 f.env.SCHEDULING_EMAIL_SEND.send=async()=>{attempts++;throw Error('lost provider acknowledgment');};
 await f.service.alarm();assert.equal(attempts,1);
 const restarted=new BookingCoordinator(f.ctx as any,f.env);await restarted.alarm();assert.equal(attempts,1);
 const status=await restarted.notificationStatus(owner);assert.equal(status.deliveryUnknown,1);
 assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');
});
test('booking alerts retry a provider rate limit but never retry an accepted send',async t=>{
 const f=await alertSelection(t);let attempts=0;
 f.env.SCHEDULING_EMAIL_SEND.send=async(message:any)=>{attempts++;if(attempts===1)throw Object.assign(Error('rate limited'),{code:'E_RATE_LIMIT_EXCEEDED'});f.messages.push(message);return {messageId:'accepted'};};
 await f.service.alarm();assert.equal(attempts,1);assert.equal((await f.service.notificationStatus(owner)).pending,1);
 f.clock.now=proposalNow+3600000;
 await f.service.alarm();await f.service.alarm();assert.equal(attempts,2);assert.equal(f.messages.length,1);
});
test('booking alerts never send to a changed configured owner and expose failure',async t=>{
 const f=await alertSelection(t);f.env.BOOKING_OWNER_EMAIL='different@example.com';
 await f.service.alarm();assert.equal(f.messages.length,0);
 assert.equal((await f.service.notificationStatus(owner)).configured,false);
});

test('booking alerts bound a hung provider and retain an unknown delivery without blocking the owner',async t=>{
 const f=await alertSelection(t);f.env.SCHEDULING_EMAIL_SEND.send=()=>new Promise(()=>{});
 const realTimeout=setTimeout;let watchdog:ReturnType<typeof setTimeout>|undefined;
 t.mock.method(globalThis,'setTimeout',((callback:()=>void)=>realTimeout(callback,0)) as typeof setTimeout);
 try{await Promise.race([f.service.alarm(),new Promise((_,reject)=>{watchdog=realTimeout(()=>reject(Error('notification provider blocked coordinator')),250);})]);}
 finally{clearTimeout(watchdog);}
 assert.equal((await f.service.notificationStatus(owner)).deliveryUnknown,1);
 await f.service.act(owner,f.r.id,'decline');assert.equal((await f.store.request(owner,f.r.id))?.status,'declined');
});
test('booking alerts do not send an unsaved selection and recover its retry after a D1 failure',async t=>{
 t.mock.method(Date,'now',()=>proposalNow);
 const f=await fixture(t),messages=notificationSender(f);proposalCalendar(t);
 const r=f.record({decision:{...f.record().decision,tier:'review'}});await f.store.add(r);
 const slots=await f.service.slots(owner,visitor,f.settings.slug,r.id);
 f.sqlite.exec("CREATE TRIGGER fixture_reject_update BEFORE UPDATE ON booking_requests BEGIN SELECT RAISE(ABORT, 'fixture outage'); END");
 await assert.rejects(f.service.selectSlot(owner,visitor,f.settings.slug,r.id,slots[0].start),/fixture outage/);
 await f.service.alarm();assert.equal(messages.length,0);
 f.sqlite.exec('DROP TRIGGER fixture_reject_update');
 await f.service.selectSlot(owner,visitor,f.settings.slug,r.id,slots[0].start);await f.service.alarm();assert.equal(messages.length,1);
});
test('booking alert diagnostics stay readable while a provider send is still pending',async t=>{
 const f=await alertSelection(t);let accept!:(value:{messageId:string})=>void,started!:()=>void;
 const sending=new Promise<void>(resolve=>{started=resolve;});
 f.env.SCHEDULING_EMAIL_SEND.send=()=>{started();return new Promise(resolve=>{accept=resolve;});};
 const flush=f.service.alarm();await sending;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const status=await Promise.race([f.service.notificationStatus(owner),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('diagnostics blocked on provider')),100);})]);assert.equal(status.pending,1);}
 finally{clearTimeout(timer);accept({messageId:'accepted'});await flush;}
 await assert.rejects(async()=>f.service.notificationStatus('other@example.com'),/wrong_owner/);
});
test('booking alerts retain a wakeup through a prolonged D1 outage and drain after recovery',async t=>{
 const f=await alertSelection(t);
 const outage=t.mock.method(f.env.DB,'batch',async()=>{throw Error('D1 temporarily unavailable');});
 for(let i=0;i<8;i++){
  f.clock.now+=60000;
  await assert.rejects(f.service.alarm(),/D1 temporarily unavailable/);
  assert.ok(f.alarmAt()!==null&&f.alarmAt()!>f.clock.now,'D1 failure must leave a future wakeup beyond platform retry limits');
 }
 outage.mock.restore();await f.service.alarm();assert.equal(f.messages.length,1);assert.equal(f.alarmAt(),null);
});

async function replyFixture(t:TestContext){
 const f=await alertSelection(t);f.env.SCHEDULING_EMAIL_REPLY_DOMAIN='agent.test';
 f.env.SCHEDULING_EMAIL_SEND.send=async(message:any)=>{f.messages.push(message);return {messageId:`<notice-${f.messages.length}@agent.test>`};};
 const canonical=new Map<string,any>();
 f.env.MAIL={getByName:(o:string)=>{assert.equal(o,owner);return {bindOwner:async()=>{},verifyBookingApproval:async(id:string,address:string)=>{const value=canonical.get(id);if(!value)throw Error('owner_kickoff_not_found');assert.ok(value.to.includes(address));return value;}};}};
 await f.service.alarm();
 async function reply(text:string,options:{notice?:any;canonicalText?:string;unverified?:boolean;from?:string;id?:string}={}){
  const notice=options.notice??f.messages[0],id=options.id??`<reply-${crypto.randomUUID()}@owner.test>`;
  const inbound={messageId:id,envelopeTo:notice.replyTo,from:options.from??owner,to:[notice.replyTo],cc:[],subject:'Re: '+notice.subject,text,inReplyTo:'<notice-1@agent.test>',references:[]};
  if(!options.unverified)canonical.set(id,{...inbound,gmailId:'canonical-id',owner,receivedAt:Date.now(),text:options.canonicalText??text});
  await f.service.receiveApprovalEmail(owner,inbound);await f.service.alarm();return inbound;
 }
 return {...f,reply,canonical};
}
test('booking email approval uses canonical owner text, books once and confirms only after Calendar success',async t=>{
 const f=await replyFixture(t);assert.match(f.messages[0].replyTo,/^scheduling\+b[a-f0-9]{48}@agent\.test$/);
 const inbound=await f.reply('Decline',{canonicalText:'Approve'});
 assert.equal((await f.store.request(owner,f.r.id))?.status,'booked');assert.equal(f.calendar.writes.length,1);
 assert.ok(f.messages.some(m=>/confirmed/i.test(m.text)&&m.to===owner));
 await f.service.receiveApprovalEmail(owner,inbound);await f.service.alarm();assert.equal(f.calendar.writes.length,1);assert.equal(f.messages.length,2);
});
test('booking email approval never trusts spoofed From or an unverified reply',async t=>{
 const f=await replyFixture(t);await f.reply('Approve',{from:'attacker@example.com'});await f.reply('Approve',{unverified:true});
 assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');assert.equal(f.calendar.writes.length,0);
});
test('booking email approval rejects stale time revisions even after selecting the original time again',async t=>{
 const f=await replyFixture(t);
 await f.service.selectSlot(owner,visitor,f.settings.slug,f.r.id,f.slots[1].start);await f.service.selectSlot(owner,visitor,f.settings.slug,f.r.id,f.slots[0].start);
 await f.reply('Approve');assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');assert.equal(f.calendar.writes.length,0);
 assert.ok(f.messages.some(m=>/changed|outdated/i.test(m.text)));
});
test('booking email approval declines without creating an event and refuses later approval',async t=>{
 const f=await replyFixture(t);await f.reply('Decline');await f.reply('Approve');
 assert.equal((await f.store.request(owner,f.r.id))?.status,'declined');assert.equal(f.calendar.writes.length,0);
});
test('booking email approval handles ambiguous replies and occupied time without booking',async t=>{
 const f=await replyFixture(t);await f.reply('Approve if free after 3pm');
 assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');assert.ok(f.messages.some(m=>/reply.*Approve/i.test(m.text)));
 f.calendar.busy=[f.slots[0]];await f.reply('Approve');assert.equal((await f.store.request(owner,f.r.id))?.status,'needs_new_slot');assert.equal(f.calendar.writes.length,0);
});
test('booking email approval resumes an uncertain Calendar write after restart without a second event',async t=>{
 const f=await replyFixture(t);f.calendar.lostWrite=true;await f.reply('Approve');
 assert.equal((await f.store.request(owner,f.r.id))?.status,'booking');assert.equal(f.calendar.writes.length,1);
 const restarted=new BookingCoordinator(f.ctx as any,f.env);f.calendar.found=true;f.clock.now+=120000;await restarted.alarm();
 assert.equal((await f.store.request(owner,f.r.id))?.status,'booked');assert.equal(f.calendar.writes.length,1);assert.ok(f.messages.some(m=>/confirmed/i.test(m.text)));
});

test('booking email approval expires and an explicit resend replaces the old capability',async t=>{
 const f=await replyFixture(t);const old=f.messages[0];f.clock.now+=8*86400000;
 await f.reply('Approve');assert.equal((await f.store.request(owner,f.r.id))?.status,'pending_approval');assert.equal(f.calendar.writes.length,0);
 // Move the clock back only inside this fixed test fixture; resend is an owner action.
 f.clock.now=proposalNow;
 await f.service.emailRequest(owner,f.r.id);await f.service.alarm();
 const renewed=f.messages.filter(m=>m.subject.startsWith('Meeting request:')).at(-1);assert.notEqual(renewed.replyTo,old.replyTo);
 await f.reply('Approve',{notice:old});assert.equal(f.calendar.writes.length,0);
});

test('booking email approval deduplicates within its reply address without suppressing another request',async t=>{
 const f=await replyFixture(t),second=f.record({decision:{...f.record().decision,tier:'review'}});await f.store.add(second);
 await f.service.selectSlot(owner,visitor,f.settings.slug,second.id,f.slots[1].start);await f.service.alarm();
 const other=f.messages.find(m=>m.text.includes('/booking?request='+second.id)),id='<same-owner-message@owner.test>';
 await f.service.receiveApprovalEmail(owner,{messageId:id,envelopeTo:other.replyTo,from:owner,to:[f.messages[0].replyTo],cc:[],subject:'Re: Meeting request',text:'Approve',inReplyTo:'<notice-1@agent.test>',references:[]});
 await f.reply('Approve',{id});
 assert.equal((await f.store.request(owner,f.r.id))?.status,'booked');assert.equal((await f.store.request(owner,second.id))?.status,'pending_approval');assert.equal(f.calendar.writes.length,1);
});
