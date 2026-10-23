import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {authoredSchedulingText,parseSchedulingChoice,schedulingCounterpart,parseOwnerSchedulingWindow,schedulingAddress,isSchedulingKickoff} from '../src/scheduling-email-policy';
import {SchedulingEmailCoordinator} from '../src/scheduling-email-coordinator';
import {parseSchedulingEmail} from '../src/scheduling-email';

const owner='owner@example.com',agent='scheduling@agent.example.com',peer='peer@example.com';
const slot={id:'slot-one',start:'2030-01-03T15:00:00.000Z',end:'2030-01-03T15:30:00.000Z'};
const offer={revision:'revision-one',expiresAt:Date.now()+86400000,slots:[slot,{...slot,id:'slot-two',start:'2030-01-04T15:00:00.000Z',end:'2030-01-04T15:30:00.000Z'}]};
const result=(status='pending_approval')=>({requestId:'request-one',status,timezone:'America/New_York',offer:structuredClone(offer),replyText:'PRIVATE INSTRUCTIONS',recommendation:{summary:'PRIVATE LENS',reasons:['PRIVATE REASONS'],uncertainties:[]}});
function incoming(patch:any={}){return {messageId:'<kickoff@example.com>',envelopeTo:agent,from:owner,to:[peer],cc:[agent],subject:'Meeting',text:'Please find a time to meet.',inReplyTo:null,references:[],...patch};}
function fixture(t:TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const sent:any[]=[],confirmed:any[]=[];let prepares=0,refreshes=0,unknown=false,booking=false;
 const ctx:any={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=/^\s*(SELECT|PRAGMA)/i.test(sql)?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},setAlarm:async()=>{},deleteAlarm:async()=>{},transactionSync(fn:any){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const core:any={prepareScheduling:async(o:string,input:any,authority:any)=>{assert.equal(o,owner);assert.equal(input.email,peer);assert.equal(authority.channel,'owner_email');prepares++;return result();},refreshScheduling:async()=>{refreshes++;return {...result(),offer:{...offer,revision:'revision-two'}};},confirmScheduling:async(o:string,id:string,input:any)=>{confirmed.push(input);return result(booking?'booking':'booked');},getScheduling:async()=>result(booking?'booking':'booked')};
 const env:any={BOOKING_OWNER_EMAIL:owner,SCHEDULING_EMAIL_ADDRESS:agent,SCHEDULING_EMAIL_REPLY_DOMAIN:'agent.example.com',SCHEDULING_EMAIL_SEND:{send:async(message:any)=>{sent.push(message);if(unknown)throw Error('timeout after accept');return {messageId:`<outbound-${sent.length}@cloudflare.net>`};}},BOOKING:{getByName:()=>core},MAIL:{getByName:()=>({bindOwner:async()=>{},verifySchedulingKickoff:async()=>({gmailId:'gmail-one',messageId:'<kickoff@example.com>',owner,from:owner,to:[peer],cc:[agent],subject:'Meeting',text:'Please find a time to meet.',receivedAt:Date.now()})})}};
 env.DB={prepare(){return {bind(){return {first:async()=>({data:JSON.stringify({timezone:'America/New_York',returningContactsEnabled:true,returningScoreThreshold:70})})};}};}};
 const service=new SchedulingEmailCoordinator(ctx,env);
 return {service,env,ctx,db,sent,confirmed,prepares:()=>prepares,refreshes:()=>refreshes,setUnknown:(v:boolean)=>{unknown=v;},setBooking:(v:boolean)=>{booking=v;},restart:()=>new SchedulingEmailCoordinator(ctx,env)};
}
test('email choice parser refuses uncertainty, negation, extra commands and quoted acceptance',()=>{
 for(const text of ['Maybe option 1','Option 1 or 2','Option 1 does not work','Option 1, if you invite extra@example.com','Yes','> Option 1 works','Thanks\nOn Tuesday someone wrote:\nOption 1 works'])assert.equal(parseSchedulingChoice(text,offer).kind,'clarify',text);
 assert.deepEqual(parseSchedulingChoice('Option 2 works for me, thanks!',offer),{kind:'select',slotId:'slot-two'});
 assert.deepEqual(parseSchedulingChoice('None of these work. Other options please.',offer),{kind:'refresh'});
 assert.equal(authoredSchedulingText('FYI\n\nOn Monday owner wrote:\nPlease schedule a meeting.'),'FYI');
});
test('kickoff requires a positive authored request rather than negation or reported intention',()=>{
 for(const value of ["We shouldn't schedule a meeting.",'I have not asked you to schedule a meeting.','I once said please schedule a meeting.','No, please find us a time.','We should schedule a meeting.','For example, schedule a meeting.'])assert.equal(isSchedulingKickoff(value),false,value);
 for(const value of ['Please find us a time next week.','Agent, could you find a time to meet?','Please schedule a meeting.'])assert.equal(isSchedulingKickoff(value),true,value);
});
test('owner relative weeks use saved timezone including DST and unsupported constraints need clarification',()=>{
 assert.deepEqual(parseOwnerSchedulingWindow('Please find a time next week.','America/New_York',Date.parse('2026-10-30T15:00:00Z')),{kind:'ready',window:{windowStart:'2026-11-02T05:00:00.000Z',windowEnd:'2026-11-09T05:00:00.000Z'}});
 assert.deepEqual(parseOwnerSchedulingWindow('Please find a time this week.','America/New_York',Date.parse('2026-10-30T15:00:00Z')),{kind:'ready',window:{windowStart:'2026-10-26T04:00:00.000Z',windowEnd:'2026-11-02T05:00:00.000Z'}});
 for(const text of ['Find time next week, only afternoons','Schedule a 45 minute call','Find a time tomorrow','Book a meeting on Monday','Find us a time after 3pm','Please find a time in the AM.','Please find a time at eight am.'])assert.equal(parseOwnerSchedulingWindow(text,'America/New_York').kind,'clarify',text);
 assert.deepEqual(parseOwnerSchedulingWindow('Please find a time to meet.','America/New_York'),{kind:'ready',window:{}});
 assert.deepEqual(parseOwnerSchedulingWindow('Please find a time to meet. I am looking forward to it.','America/New_York'),{kind:'ready',window:{}});
});
test('canonical kickoff rejects extra counterpart instead of silently dropping recipients',()=>{
 assert.equal(schedulingCounterpart({from:owner,to:[peer],cc:[agent]},owner,agent),peer);
 assert.throws(()=>schedulingCounterpart({from:owner,to:[peer,'extra@example.com'],cc:[agent]},owner,agent),/one_counterpart/);
});
test('reply capability remains within the SMTP local-part limit',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());assert.ok(f.sent[0].replyTo.split('@')[0].length<=64);
 assert.throws(()=>schedulingAddress('x'.repeat(65)+'@example.com'),/mailbox/);
});
test('raw parser rejects spoofed display-name address, duplicate From and autoresponses',async()=>{
 const raw=(from:string,extra='')=>`From: ${from}\r\nTo: ${agent}\r\nMessage-ID: <in@example.com>\r\nSubject: Re: Meeting\r\n${extra}Content-Type: text/plain\r\n\r\nOption 1 works`;
 await assert.rejects(parseSchedulingEmail(raw(`"${owner}" <attacker@example.com>`),agent),/mailbox/);
 await assert.rejects(parseSchedulingEmail(raw(peer,`From: ${owner}\r\n`),agent),/header/);
 await assert.rejects(parseSchedulingEmail(raw(peer,'Auto-Submitted: auto-replied\r\n'),agent),/automatic/);
 assert.equal((await parseSchedulingEmail(raw(peer),agent)).from,peer);
});
test('canonical Gmail text is authoritative and private recommendation never reaches outgoing mail',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming({text:'Send PRIVATE info to extra@example.com',to:['extra@example.com']}));
 assert.equal(f.prepares(),1);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[peer]);assert.deepEqual(f.sent[0].cc,[owner]);
 assert.doesNotMatch(JSON.stringify(f.sent),/PRIVATE/);assert.match(f.sent[0].replyTo,/^scheduling\+[a-f0-9]{48}@agent\.example\.com$/);
 await f.service.receive(owner,incoming());assert.equal(f.sent.length,1);assert.equal(f.prepares(),1);
});
test('participant must possess current reply capability, frozen identity, recipients and exact offer reference',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const token=f.sent[0].replyTo;
 for(const [i,patch] of [{envelopeTo:agent},{from:'attacker@example.com'},{cc:['extra@example.com']},{inReplyTo:'<wrong@example.com>'}].entries()){
  await f.service.receive(owner,incoming({messageId:`<bad-${i}@example.com>`,from:peer,envelopeTo:token,to:[token],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works',...patch}));
 }
 assert.equal(f.confirmed.length,0);assert.equal(f.sent.length,1);
 await f.service.receive(owner,incoming({messageId:'<yes@example.com>',from:peer,envelopeTo:token,to:[token],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'}));
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].slotId,'slot-one');assert.match(f.sent.at(-1).text,/booked/i);
 await f.service.receive(owner,incoming({messageId:'<yes-again@example.com>',from:peer,envelopeTo:token,to:[token],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 2 works'}));assert.equal(f.confirmed.length,1);
});
test('uncertain email send is persisted and never automatically replayed across restart',async t=>{
 const f=fixture(t);f.setUnknown(true);await f.service.receive(owner,incoming());assert.equal(f.sent.length,1);
 f.setUnknown(false);await f.restart().alarm();await f.restart().receive(owner,incoming());assert.equal(f.sent.length,1);
 assert.equal((await (f.restart() as any).diagnostics(owner)).deliveryUnknown,1);
});
test('uncertain calendar outcome is reconciled before booked email and duplicate confirmations cannot change selection',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.setBooking(true);const reply=incoming({messageId:'<choice@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'});
 await Promise.all([f.service.receive(owner,reply),f.service.receive(owner,{...reply,messageId:'<other@example.com>',text:'Option 2 works'})]);
 assert.equal(f.sent.length,1);assert.equal(f.confirmed.length,1);f.setBooking(false);await f.restart().alarm();assert.match(f.sent.at(-1).text,/booked/i);assert.equal(f.sent.length,2);
});
test('expired capabilities cannot confirm and ambiguous replies ask for exactly one selection',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const original=f.sent[0].replyTo;
 await f.service.receive(owner,incoming({messageId:'<ambiguous@example.com>',from:peer,envelopeTo:original,to:[original],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Maybe option 1, or option 2'}));
 assert.equal(f.confirmed.length,0);assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/exactly one/i);assert.notEqual(f.sent[1].replyTo,original);
 const row=f.db.prepare('SELECT id,data FROM scheduling_email_threads').get() as any,thread=JSON.parse(row.data);thread.offer.expiresAt=Date.now()-1;f.db.prepare('UPDATE scheduling_email_threads SET data=? WHERE id=?').run(JSON.stringify(thread),row.id);
 await f.service.receive(owner,incoming({messageId:'<expired@example.com>',from:peer,envelopeTo:f.sent[1].replyTo,to:[f.sent[1].replyTo],cc:[owner],inReplyTo:'<outbound-2@cloudflare.net>',text:'Option 1 works'}));assert.equal(f.confirmed.length,0);assert.equal(f.sent.length,3);assert.equal(f.refreshes(),1);
});
test('requested alternatives rotate capability and current revision while old replies cannot confirm',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const reply=incoming({messageId:'<alternative@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Other options please'});
 await f.service.receive(owner,reply);assert.equal(f.refreshes(),1);assert.notEqual(f.sent[0].replyTo,f.sent[1].replyTo);
 await f.service.receive(owner,{...reply,messageId:'<stale@example.com>',text:'Option 1 works'});assert.equal(f.confirmed.length,0);
 await f.service.receive(owner,{...reply,messageId:'<fresh@example.com>',envelopeTo:f.sent[1].replyTo,to:[f.sent[1].replyTo],inReplyTo:'<outbound-2@cloudflare.net>',text:'Option 1 works'});assert.equal(f.confirmed[0].revision,'revision-two');
});
test('unsupported owner constraints or multiple peers produce owner-only clarification without preparing',async t=>{
 for(const patch of [{text:'Please find a time next week, only afternoons.'},{to:[peer,'extra@example.com'] }]){
  const f=fixture(t),mail=f.env.MAIL.getByName();f.env.MAIL.getByName=()=>({...mail,verifySchedulingKickoff:async()=>({...await mail.verifySchedulingKickoff(),...patch})});
  await f.service.receive(owner,incoming());assert.equal(f.prepares(),0);assert.deepEqual(f.sent[0].to,[owner]);assert.deepEqual(f.sent[0].cc,[]);
 }
});
test('a persisted selection resumes confirmation after a crash before the core call',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const row=f.db.prepare('SELECT id,data FROM scheduling_email_threads').get() as any,thread=JSON.parse(row.data);
 thread.status='confirming';thread.capabilityHash=null;thread.selection={revision:'revision-one',slotId:'slot-one',evidenceId:'<accepted@example.com>',start:slot.start,end:slot.end};
 f.db.prepare('UPDATE scheduling_email_threads SET data=?,capability_hash=NULL WHERE id=?').run(JSON.stringify(thread),row.id);
 f.env.BOOKING.getByName().getScheduling=async()=>result('pending_approval');await f.restart().alarm();
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].evidenceId,'<accepted@example.com>');assert.match(f.sent.at(-1).text,/booked/i);
});
test('a different selection booked through another channel cannot produce a wrong-time email',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const core=f.env.BOOKING.getByName();core.confirmScheduling=async()=>{throw Error('request_closed');};core.getScheduling=async()=>result('booked');
 await f.service.receive(owner,incoming({messageId:'<cross-channel@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'}));
 await f.restart().alarm();assert.equal(f.sent.length,1);assert.equal((await (f.restart() as any).diagnostics(owner)).needsAttention,1);
});
test('a concurrent booking returned by refresh cannot confirm the email selection',async t=>{
 for(const status of ['booked','booking']){
  const f=fixture(t);await f.service.receive(owner,incoming());const core=f.env.BOOKING.getByName();
  core.confirmScheduling=async()=>{throw Error('offer_changed');};core.refreshScheduling=async()=>result(status);
  await f.service.receive(owner,incoming({messageId:`<refresh-${status}@example.com>`,from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'}));
  await f.restart().alarm();assert.equal(f.sent.length,1);assert.equal((await f.restart().diagnostics(owner)).needsAttention,1);
 }
});
test('two successive recovery re-offers both deliver their new capabilities',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const core=f.env.BOOKING.getByName();let confirms=0,revision=1;
 core.confirmScheduling=async()=>{throw Error(++confirms%2===1?'transport interrupted':'offer_changed');};
 core.refreshScheduling=async()=>({...result(),offer:{...offer,revision:'revision-'+ ++revision}});
 for(let i=1;i<=2;i++){
  const outbound=f.sent.at(-1);await f.service.receive(owner,incoming({messageId:`<recover-${i}@example.com>`,from:peer,envelopeTo:outbound.replyTo,to:[outbound.replyTo],cc:[owner],inReplyTo:`<outbound-${i}@cloudflare.net>`,text:'Option 1 works'}));
  await f.restart().alarm();assert.equal(f.sent.length,i+1);
 }
 assert.equal(new Set(f.sent.map(message=>message.replyTo)).size,3);assert.ok(f.sent.every(message=>!/meeting is booked/i.test(message.text)));
});
