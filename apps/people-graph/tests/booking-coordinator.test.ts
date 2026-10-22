import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingCoordinator,bookingReadiness} from '../src/booking-coordinator';
import {BookingStore} from '../src/booking-store';
import {defaultBookingSettings,decideBooking} from '../src/booking-policy';
import {seal} from '../src/mail-model';
import type {BookingRequestRecord,BookingVisitorIdentity} from '../src/booking-types';

const owner='owner@example.com';
const visitor:BookingVisitorIdentity={email:'visitor@example.com',subject:'a'.repeat(43),emailAuthoritative:true};
const submission={name:'Visitor',project:'We are building durable memory for agents.',purpose:'Discuss our developer tooling and design partners.',projectUrl:'',referrer:''};
const fit={fit:'strong' as const,reasons:['Agent infrastructure fits.'],evidence:['durable memory for agents'],model:'test'};
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
