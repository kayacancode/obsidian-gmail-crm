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
 let alarms=0;
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){const rows=durable.prepare(sql).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{alarms++;}}};
 const env:any={DB:db,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',MAIL_TOKEN_KEY:'test-key',TOKEN_SECRET:'test-session',BOOKING_OWNER_EMAIL:owner,PEOPLEGRAPH_HOST:'https://source.test',PEOPLEGRAPH_TOKEN:'source-token',PEOPLEGRAPH_OWNER_EMAIL:owner,AI:{run:async()=>({output_text:JSON.stringify({fit:fit.fit,reasons:fit.reasons,evidence:fit.evidence})})}};
 const store=new BookingStore(db);await store.init();
 const settings={...defaultBookingSettings(owner),revision:1,enabled:true,autoBookPriority:true,slug:'test-host',thesis:'Meet founders building infrastructure and durable memory for AI agents.',vipEmails:[visitor.email]};
 await store.saveSettings(settings,0);
 await store.saveCalendar({owner,email:owner,connectedAt:Date.now(),grant:await seal(JSON.stringify({owner,email:owner,refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}),env.MAIL_TOKEN_KEY)});
 const service=new BookingCoordinator(ctx as any,env);
 function record(patch:Partial<BookingRequestRecord>={}):BookingRequestRecord{return {...submission,id:crypto.randomUUID(),owner,email:visitor.email,visitorSubject:visitor.subject,emailAuthoritative:true,createdAt:Date.now(),updatedAt:Date.now(),status:'pending_approval',decision:decideBooking(settings,visitor.email,fit,{status:'matched',email:visitor.email,lastSync:new Date().toISOString(),reason:'Exact contact.'}),slotStart:null,slotEnd:null,eventId:null,idempotencyKey:crypto.randomUUID(),...patch};}
 return {sqlite,durable,env,store,settings,service,record,alarms:()=>alarms};
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
