import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {authoredSchedulingText,parseSchedulingChoice,schedulingCounterpart,parseOwnerSchedulingWindow,schedulingAddress,isSchedulingKickoff} from '../src/scheduling-email-policy';
import {SchedulingEmailCoordinator} from '../src/scheduling-email-coordinator';
import {parseSchedulingEmail} from '../src/scheduling-email';
import {schedulingOwnerRoute} from '../src/scheduling-routes';

const owner='owner@example.com',agent='scheduling@agent.example.com',peer='peer@example.com';
const slot={id:'slot-one',start:'2030-01-03T15:00:00.000Z',end:'2030-01-03T15:30:00.000Z'};
const offer={revision:'revision-one',expiresAt:Date.now()+86400000,slots:[slot,{...slot,id:'slot-two',start:'2030-01-04T15:00:00.000Z',end:'2030-01-04T15:30:00.000Z'}]};
const result=(status='pending_approval')=>({requestId:'request-one',status,timezone:'America/New_York',offer:structuredClone(offer),replyText:'PRIVATE INSTRUCTIONS',recommendation:{summary:'PRIVATE LENS',reasons:['PRIVATE REASONS'],uncertainties:[]}});
function incoming(patch:any={}){return {messageId:'<kickoff@example.com>',envelopeTo:agent,from:owner,to:[peer],cc:[agent],subject:'Meeting',text:'Please find a time to meet.',inReplyTo:null,references:[],...patch};}
function fixture(t:TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const sent:any[]=[],confirmed:any[]=[];let prepares=0,refreshes=0,unknown=false,booking=false;
 const ctx:any={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=/^\s*(SELECT|PRAGMA)/i.test(sql)?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},setAlarm:async()=>{},deleteAlarm:async()=>{},transactionSync(fn:any){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const core:any={prepareScheduling:async(o:string,input:any,authority:any)=>{assert.equal(o,owner);assert.equal(input.email,peer);assert.equal(authority.channel,'owner_email');prepares++;return result();},refreshScheduling:async()=>{refreshes++;return {...result(),offer:{...offer,revision:'revision-two'}};},confirmScheduling:async(o:string,id:string,input:any)=>{confirmed.push(input);return result(booking?'booking':'booked');},getScheduling:async()=>result(booking?'booking':'pending_approval')};
 const env:any={APP_ORIGIN:'https://people.example.com',BOOKING_OWNER_EMAIL:owner,SCHEDULING_EMAIL_ADDRESS:agent,SCHEDULING_EMAIL_REPLY_DOMAIN:'agent.example.com',SCHEDULING_EMAIL_SEND:{send:async(message:any)=>{sent.push(message);if(unknown)throw Error('timeout after accept');return {messageId:`<outbound-${sent.length}@cloudflare.net>`};}},BOOKING:{getByName:()=>core},MAIL:{getByName:()=>({bindOwner:async()=>{},verifySchedulingKickoff:async()=>({gmailId:'gmail-one',messageId:'<kickoff@example.com>',owner,from:owner,to:[peer],cc:[agent],subject:'Meeting',text:'Please find a time to meet.',receivedAt:Date.now()})})}};
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
test('unsupported owner constraints or excessive guests produce owner-only clarification without preparing',async t=>{
 for(const patch of [{text:'Please find a time next week, only afternoons.'},{to:[peer,'a@example.com','b@example.com','c@example.com','d@example.com','e@example.com'] }]){
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
const reviewResult=(tier='review')=>({...result(),offer:null,requiresReview:true,decision:{tier,reasons:['PRIVATE assessment reason'],uncertainties:['PRIVATE missing context'],policyRevision:3,fit:{fit:tier==='async'?'weak':'uncertain',reasons:[],evidence:[],model:'test'},people:{status:'unavailable',reason:'PRIVATE source unavailable'}}});
test('review and weak decisions send only the owner a private explanation and retain the conversation',async t=>{
 for(const tier of ['review','async']){
  const f=fixture(t);f.env.BOOKING.getByName().prepareScheduling=async()=>reviewResult(tier);
  await f.service.receive(owner,incoming());assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[owner]);assert.deepEqual(f.sent[0].cc,[]);
  assert.match(f.sent[0].text,/PRIVATE assessment reason/);assert.match(f.sent[0].text,/https:\/\/people\.example\.com\/booking\?request=request-one/);assert.equal(f.sent[0].replyTo,undefined);
  const thread=JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data);assert.equal(thread.status,'awaiting_review');assert.equal(thread.capabilityHash,null);assert.equal(thread.offer,null);
 }
});
test('strong assessed offers use canonical context and keep private assessment away from the counterpart',async t=>{
 const f=fixture(t),mail=f.env.MAIL.getByName();let context='';f.env.MAIL.getByName=()=>({...mail,verifySchedulingKickoff:async()=>({...await mail.verifySchedulingKickoff(),context:'Untrusted canonical purpose: our shared project proposal.'})});
 f.env.BOOKING.getByName().prepareScheduling=async(_o:string,input:any)=>{context=input.context;return {...result(),requiresReview:false,decision:{...reviewResult().decision,tier:'priority'}};};
 await f.service.receive(owner,incoming());assert.equal(context,'Untrusted canonical purpose: our shared project proposal.');assert.deepEqual(f.sent[0].to,[peer]);assert.deepEqual(f.sent[0].cc,[owner]);assert.match(f.sent[0].text,/available times/);assert.doesNotMatch(f.sent[0].text,/PRIVATE/);
});
test('approved review resumes once across duplicate calls and restarts without rotating a delivered offer',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>reviewResult();core.getScheduling=async()=>({...result(),requiresReview:false});
 await f.service.receive(owner,incoming());await f.service.resumeApproved(owner,'request-one');assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);const address=f.sent[1].replyTo;
 await f.restart().resumeApproved(owner,'request-one');await f.service.resumeApproved(owner,'request-one');assert.equal(f.sent.length,2);
 const thread=JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data);assert.equal(thread.replyAddress,address);assert.equal(thread.latestMessageId,'<outbound-2@cloudflare.net>');
 await assert.rejects(f.service.resumeApproved('attacker@example.com','request-one'),/disabled|owner/);
});
test('resume does not bypass a current review and never replays an uncertain approval offer',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>reviewResult();core.getScheduling=async()=>reviewResult();
 await f.service.receive(owner,incoming());await f.service.resumeApproved(owner,'request-one');assert.equal(f.sent.length,1);
 core.getScheduling=async()=>({...result(),requiresReview:false});f.setUnknown(true);await assert.rejects(f.service.resumeApproved(owner,'request-one'),/delivery_unknown/);assert.equal(f.sent.length,2);
 f.setUnknown(false);await assert.rejects(f.restart().resumeApproved(owner,'request-one'),/delivery_unknown/);await f.restart().alarm();assert.equal(f.sent.length,2);
});
test('legacy offer acceptance reassesses privately instead of retrying confirmation without review',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());const core=f.env.BOOKING.getByName();core.confirmScheduling=async()=>{throw Error('assessment_required');};core.refreshScheduling=async()=>reviewResult();
 await f.service.receive(owner,incoming({messageId:'<legacy-choice@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'}));
 assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[owner]);assert.deepEqual(f.sent[1].cc,[]);await f.restart().alarm();assert.equal(f.sent.length,2);
});
test('confirmation review results remain private without refreshing into an automatic offer',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.env.BOOKING.getByName().confirmScheduling=async()=>reviewResult();
 await f.service.receive(owner,incoming({messageId:'<review-choice@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Option 1 works'}));
 assert.equal(f.refreshes(),0);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[owner]);assert.deepEqual(f.sent[1].cc,[]);
});
test('review notice and resumable conversation persist together after storage failure',async t=>{
 const f=fixture(t);f.env.BOOKING.getByName().prepareScheduling=async()=>reviewResult();const exec=f.ctx.storage.sql.exec;let fail=true;
 f.ctx.storage.sql.exec=(sql:string,...args:any[])=>{if(fail&&sql.startsWith('INSERT OR IGNORE INTO scheduling_email_outbox')){fail=false;throw Error('storage interrupted');}return exec(sql,...args);};
 await f.service.receive(owner,incoming());assert.equal(f.sent.length,0);await f.restart().alarm();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[owner]);
});
test('pending offers are cancelled when a policy change requires private review',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.sent.length=0;
 // Model a restart after queue persistence but before its first delivery.
 f.db.prepare("UPDATE scheduling_email_outbox SET status='ready',message_id=NULL").run();f.env.BOOKING.getByName().getScheduling=async()=>reviewResult();
 await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[owner]);assert.deepEqual(f.sent[0].cc,[]);
});
test('approval resume never duplicates an already delivered original priority offer',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.env.BOOKING.getByName().getScheduling=async()=>({...result(),requiresReview:false});const replyTo=f.sent[0].replyTo;
 await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,1);assert.equal(JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data).replyAddress,replyTo);
});
test('uncertain preparation reuses frozen canonical evidence when a retry cannot reread thread context',async t=>{
 const f=fixture(t),mail=f.env.MAIL.getByName(),core=f.env.BOOKING.getByName();let reads=0,prepared:any;
 f.env.MAIL.getByName=()=>({...mail,verifySchedulingKickoff:async()=>({...await mail.verifySchedulingKickoff(),...(!reads++?{context:'Canonical project purpose from the prior thread.'}:{})})});
 core.prepareScheduling=async(_o:string,input:any)=>{if(!prepared){prepared=structuredClone(input);throw Error('transport interrupted after preparation');}if(JSON.stringify(prepared)!==JSON.stringify(input))throw Error('idempotency_conflict');return reviewResult();};
 await f.service.receive(owner,incoming());assert.equal(f.sent.length,0);await f.restart().alarm();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[owner]);
});
function ownerAction(f:ReturnType<typeof fixture>,action:string,body:unknown={}){
 return schedulingOwnerRoute(new Request('https://people.example.com/api/booking/scheduling/requests/request-one/'+action,{method:'POST',headers:{origin:'https://people.example.com','content-type':'application/json'},body:JSON.stringify(body)}),f.env,owner);
}
test('owner refresh downgrade invalidates the existing email capability before a participant replies',async t=>{
 const f=fixture(t);f.env.SCHEDULING_EMAIL={getByName:()=>f.service};await f.service.receive(owner,incoming());const original=f.sent[0];
 const core=f.env.BOOKING.getByName();core.getScheduling=async()=>reviewResult();core.refreshScheduling=async()=>reviewResult();
 assert.equal((await ownerAction(f,'refresh')).status,200);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[owner]);assert.deepEqual(f.sent[1].cc,[]);
 const thread=JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data);assert.equal(thread.status,'awaiting_review');assert.equal(thread.capabilityHash,null);
 await f.service.receive(owner,incoming({messageId:'<downgrade-clarify@example.com>',from:peer,envelopeTo:original.replyTo,to:[original.replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Maybe option 1'}));
 assert.equal(f.sent.length,2);assert.equal(f.confirmed.length,0);
});
test('clarification checks current assessment without re-running a model when review is already required',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.env.BOOKING.getByName().getScheduling=async()=>reviewResult();
 await f.service.receive(owner,incoming({messageId:'<stale-clarify@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Maybe option 1'}));
 assert.equal(f.refreshes(),0);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[owner]);assert.deepEqual(f.sent[1].cc,[]);assert.equal(f.confirmed.length,0);
});
test('clarification refreshes only when the current eligible offer is no longer available',async t=>{
 const f=fixture(t);await f.service.receive(owner,incoming());f.env.BOOKING.getByName().getScheduling=async()=>({...result('needs_new_slot'),requiresReview:false,offer:null});
 await f.service.receive(owner,incoming({messageId:'<expired-current-clarify@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Maybe option 1'}));
 assert.equal(f.refreshes(),1);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.equal(JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data).offer.revision,'revision-two');
});
test('API-only owner approval succeeds with an unconfigured email binding and exact owner is still required',async t=>{
 const f=fixture(t);f.env.SCHEDULING_EMAIL={getByName:()=>f.service};delete f.env.SCHEDULING_EMAIL_ADDRESS;let approved=false;
 f.env.BOOKING.getByName().approveScheduling=async()=>{approved=true;return {...result(),requiresReview:false};};
 const response=await ownerAction(f,'approve',{policyRevision:3});assert.equal(approved,true);assert.equal(response.status,200,await response.text());assert.equal(f.sent.length,0);
 await assert.rejects(f.service.resumeApproved('attacker@example.com','no-email-request'),/owner/);
});
test('temporary no-availability closure resumes with fresh eligible times after owner reassessment',async t=>{
 for(const initial of ['owner-approval','participant-refresh']){
  const f=fixture(t),core=f.env.BOOKING.getByName();f.env.SCHEDULING_EMAIL={getByName:()=>f.service};
  if(initial==='owner-approval')core.prepareScheduling=async()=>reviewResult();
  await f.service.receive(owner,incoming());const unavailable=async()=>({...result('needs_new_slot'),offer:null,requiresReview:false});core.getScheduling=unavailable;
  if(initial==='owner-approval'){core.approveScheduling=unavailable;assert.equal((await ownerAction(f,'approve',{policyRevision:3})).status,200);}
  else{core.refreshScheduling=unavailable;await f.service.receive(owner,incoming({messageId:'<no-options@example.com>',from:peer,envelopeTo:f.sent[0].replyTo,to:[f.sent[0].replyTo],cc:[owner],inReplyTo:'<outbound-1@cloudflare.net>',text:'Other options please'}));}
  const sentBefore=f.sent.length;core.getScheduling=async()=>({...result(),offer:{...offer,revision:'available-again'},requiresReview:false});core.refreshScheduling=core.getScheduling;
  assert.equal((await ownerAction(f,'refresh')).status,200);assert.equal(f.sent.length,sentBefore+1);assert.deepEqual(f.sent.at(-1).to,[peer]);assert.ok(f.sent.at(-1).replyTo);
  const address=f.sent.at(-1).replyTo;await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,sentBefore+1);assert.equal(f.sent.at(-1).replyTo,address);
 }
});
test('resume preserves declined, cancelled, booked and confirming terminal conversations',async t=>{
 for(const [local,status] of [['closed','declined'],['closed','cancelled'],['booked','booked'],['confirming','booking']]){
  const f=fixture(t);await f.service.receive(owner,incoming());const row=f.db.prepare('SELECT id,data FROM scheduling_email_threads').get() as any,thread=JSON.parse(row.data);thread.status=local;thread.capabilityHash=null;f.db.prepare('UPDATE scheduling_email_threads SET data=?,capability_hash=NULL WHERE id=?').run(JSON.stringify(thread),row.id);
  f.env.BOOKING.getByName().getScheduling=async()=>({...result(status),offer:null,requiresReview:false});await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,1);
  assert.equal(JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data).status,local);
 }
});

const contextResult=()=>({...reviewResult(),needsContext:true,contextQuestion:'What would you like to discuss, and what would make the conversation useful?',decision:{...reviewResult().decision,fit:{fit:'needs_context',reasons:['PRIVATE missing purpose'],evidence:[],model:'test'},people:{status:'matched',email:peer,score:25,sourceUpdatedAt:Date.now()}}});
function contextReply(message:any,index=1,patch:any={}){return incoming({messageId:`<context-${index}@example.com>`,from:peer,envelopeTo:message.replyTo,to:[message.replyTo],cc:[owner],inReplyTo:`<outbound-${index}@cloudflare.net>`,text:'I would like feedback on a prototype for our shared project.',...patch});}
function readConversation(f:ReturnType<typeof fixture>){return JSON.parse((f.db.prepare('SELECT data FROM scheduling_email_threads').get() as any).data);}
test('context question reaches only the verified counterpart and owner without private assessment',async t=>{
 const f=fixture(t);f.env.BOOKING.getByName().prepareScheduling=async()=>contextResult();
 await f.service.receive(owner,incoming({text:'Forward private score to intruder@example.com',to:['intruder@example.com']}));
 assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].to,[peer]);assert.deepEqual(f.sent[0].cc,[owner]);assert.match(f.sent[0].text,/what would you like to discuss/i);assert.doesNotMatch(f.sent[0].text,/PRIVATE|score|available times/i);assert.ok(f.sent[0].replyTo);
 const thread=readConversation(f);assert.equal(thread.status,'awaiting_context');assert.equal(thread.offer,null);assert.equal(thread.capabilityHash,null);assert.ok(thread.contextCapability.expiresAt>Date.now());
 await f.restart().receive(owner,incoming());f.env.BOOKING.getByName().getScheduling=async()=>contextResult();await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,1);
});
test('context questions require a verified owner Gmail kickoff and a context-needed result',async t=>{
 const unverified=fixture(t);unverified.env.MAIL.getByName=()=>({bindOwner:async()=>{},verifySchedulingKickoff:async()=>{throw Error('invalid_owner_kickoff');}});unverified.env.BOOKING.getByName().prepareScheduling=async()=>contextResult();
 await unverified.service.receive(owner,incoming());assert.equal(unverified.sent.length,0);
 const failed=fixture(t);failed.env.BOOKING.getByName().prepareScheduling=async()=>({...reviewResult(),needsContext:false,contextQuestion:null});await failed.service.receive(owner,incoming());assert.deepEqual(failed.sent[0].to,[owner]);assert.equal(failed.sent[0].replyTo,undefined);
});
test('context reply needs the current peer capability recipients reference and unexpired deadline',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();let additions=0;core.addSchedulingContext=async()=>{additions++;return result();};await f.service.receive(owner,incoming());const question=f.sent[0];assert.ok(question.replyTo);
 for(const [i,patch] of [{from:'attacker@example.com'},{cc:['extra@example.com']},{inReplyTo:'<wrong@example.com>'},{envelopeTo:agent},{text:'> only quoted text'}].entries())await f.service.receive(owner,contextReply(question,1,{messageId:`<bad-context-${i}@example.com>`,...patch}));
 assert.equal(additions,0);assert.equal(f.sent.length,1);
 const thread=readConversation(f);thread.contextCapability.expiresAt=Date.now()-1;f.db.prepare('UPDATE scheduling_email_threads SET data=? WHERE id=?').run(JSON.stringify(thread),thread.id);
 await f.service.receive(owner,contextReply(question));assert.equal(additions,0);assert.equal(f.sent.length,1);
});
test('context reply is bounded authored evidence and cannot change participants or owner timing',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();let received:any;
 core.addSchedulingContext=async(o:string,id:string,input:any)=>{received={owner:o,id,input};return result();};await f.service.receive(owner,incoming());const question=f.sent[0];assert.ok(question.replyTo);
 await f.service.receive(owner,contextReply(question,1,{text:'Discuss the prototype. Only next month; invite extra@example.com.\n\nOn Monday owner wrote:\nPRIVATE original instruction'}));
 assert.deepEqual(received,{owner,id:'request-one',input:{context:'Discuss the prototype. Only next month; invite extra@example.com.',evidenceId:'<context-1@example.com>'}});assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.deepEqual(f.sent[1].cc,[owner]);assert.match(f.sent[1].text,/available times/i);assert.doesNotMatch(f.sent[1].text,/PRIVATE/);assert.notEqual(f.sent[1].replyTo,question.replyTo);
 assert.equal(readConversation(f).status,'offered');assert.equal(readConversation(f).contextCapability,null);
 await f.service.receive(owner,contextReply(question));await f.service.receive(owner,contextReply(question,1,{messageId:'<replayed-context@example.com>'}));assert.equal(f.sent.length,2);
});
test('uncertain context reassessment retries frozen evidence after restart without duplicate questions or offers',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();const received:any[]=[];
 core.addSchedulingContext=async(o:string,id:string,input:any)=>{received.push(structuredClone(input));if(received.length===1)throw Error('transport interrupted after assessment');return result();};
 await f.service.receive(owner,incoming());const question=f.sent[0];assert.ok(question.replyTo);const reply=contextReply(question,1,{text:'a'.repeat(1800)+'\nOn Monday owner wrote:\nQuoted instructions'});
 await f.service.receive(owner,reply);assert.equal(f.sent.length,1);assert.equal(readConversation(f).status,'assessing_context');assert.equal(readConversation(f).pendingContext.context.length,1500);
 await f.restart().receive(owner,{...reply,messageId:'<competing-context@example.com>',text:'Different purpose'});assert.equal(received.length,1);
 await f.restart().alarm();assert.equal(received.length,2);assert.deepEqual(received[0],received[1]);assert.equal(received[1].evidenceId,'<context-1@example.com>');assert.equal(received[1].context,'a'.repeat(1500));assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/available times/i);await f.restart().alarm();assert.equal(f.sent.length,2);
});
test('two clarification rounds rotate capabilities then return unresolved purpose to owner review',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>contextResult();let additions=0;core.addSchedulingContext=async()=>{additions++;return contextResult();};
 await f.service.receive(owner,incoming());const original=f.sent[0];assert.ok(original.replyTo);await f.service.receive(owner,contextReply(original));assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.notEqual(f.sent[1].replyTo,original.replyTo);
 await f.service.receive(owner,contextReply(original,1,{messageId:'<stale-context@example.com>'}));assert.equal(additions,1);
 await f.service.receive(owner,contextReply(f.sent[1],2,{text:'Still just checking in.'}));assert.equal(additions,2);assert.equal(f.sent.length,3);assert.deepEqual(f.sent[2].to,[owner]);assert.deepEqual(f.sent[2].cc,[]);assert.equal(f.sent[2].replyTo,undefined);assert.equal(readConversation(f).status,'awaiting_review');assert.equal(readConversation(f).contextCapability,null);
 await f.restart().alarm();await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,3);
});
test('context assessment service failure moves to owner review after bounded durable retries',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();core.addSchedulingContext=async()=>{throw Error('model service unavailable PRIVATE');};await f.service.receive(owner,incoming());assert.ok(f.sent[0].replyTo);
 await f.service.receive(owner,contextReply(f.sent[0]));for(let i=0;i<3;i++)await f.restart().alarm();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[owner]);assert.deepEqual(f.sent[1].cc,[]);assert.equal(readConversation(f).status,'awaiting_review');assert.equal(readConversation(f).pendingContext,undefined);assert.doesNotMatch(f.sent[1].text,/PRIVATE/);
 core.getScheduling=async()=>contextResult();await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,2);assert.equal(readConversation(f).status,'awaiting_review');
});
test('confirmation reassessment asks for missing purpose using a distinct context capability',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();await f.service.receive(owner,incoming());const original=f.sent[0];core.confirmScheduling=async()=>contextResult();
 await f.service.receive(owner,contextReply(original,1,{text:'Option 1 works'}));assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.deepEqual(f.sent[1].cc,[owner]);assert.match(f.sent[1].text,/what would you like to discuss/i);assert.doesNotMatch(f.sent[1].text,/PRIVATE/);assert.notEqual(f.sent[1].replyTo,original.replyTo);assert.equal(readConversation(f).status,'awaiting_context');
});
test('context question persists atomically with its capability across storage failure and uncertain delivery',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();const exec=f.ctx.storage.sql.exec;let fail=true;f.ctx.storage.sql.exec=(sql:string,...args:any[])=>{if(fail&&sql.startsWith('INSERT OR IGNORE INTO scheduling_email_outbox')){fail=false;throw Error('storage interrupted');}return exec(sql,...args);};
 await f.service.receive(owner,incoming());assert.equal(f.sent.length,0);await f.restart().alarm();assert.equal(f.sent.length,1);assert.ok(f.sent[0].replyTo);
 const uncertain=fixture(t);uncertain.env.BOOKING.getByName().prepareScheduling=async()=>contextResult();uncertain.setUnknown(true);await uncertain.service.receive(owner,incoming());uncertain.setUnknown(false);uncertain.env.BOOKING.getByName().getScheduling=async()=>contextResult();await uncertain.restart().alarm();await assert.rejects(uncertain.restart().resumeApproved(owner,'request-one'),/delivery_unknown/);assert.equal(uncertain.sent.length,1);
});
test('explicit owner reassessment can replace an expired context question within the two-question limit',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();f.env.SCHEDULING_EMAIL={getByName:()=>f.service};core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>contextResult();core.refreshScheduling=async()=>contextResult();let additions=0;core.addSchedulingContext=async()=>{additions++;return result();};
 const expire=()=>{const thread=readConversation(f);thread.contextCapability.expiresAt=Date.now()-1;f.db.prepare('UPDATE scheduling_email_threads SET data=? WHERE id=?').run(JSON.stringify(thread),thread.id);};
 await f.service.receive(owner,incoming());const original=f.sent[0];expire();await f.restart().alarm();await f.service.receive(owner,contextReply(original));assert.equal(f.sent.length,1);assert.equal(additions,0);
 assert.equal((await ownerAction(f,'refresh')).status,200);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.notEqual(f.sent[1].replyTo,original.replyTo);assert.equal(readConversation(f).contextRounds,2);assert.ok(readConversation(f).contextCapability.expiresAt>Date.now());
 await f.restart().resumeApproved(owner,'request-one');await f.service.receive(owner,contextReply(original,1,{messageId:'<expired-old-context@example.com>'}));assert.equal(f.sent.length,2);assert.equal(additions,0);
 expire();await f.restart().alarm();assert.equal(f.sent.length,2);assert.equal((await ownerAction(f,'refresh')).status,200);assert.equal(f.sent.length,3);assert.deepEqual(f.sent[2].to,[owner]);assert.deepEqual(f.sent[2].cc,[]);assert.equal(readConversation(f).status,'awaiting_review');
 await f.restart().resumeApproved(owner,'request-one');await f.restart().alarm();assert.equal(f.sent.length,3);
});
test('owner approval supersedes a pending context retry and delivers its eligible offer once',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();f.env.SCHEDULING_EMAIL={getByName:()=>f.service};let current:any=contextResult(),additions=0;
 core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>current;core.addSchedulingContext=async()=>{additions++;throw Error('transport interrupted before context write');};core.approveScheduling=async()=>{current={...result(),requiresReview:false,needsContext:false,contextQuestion:null};return current;};
 await f.service.receive(owner,incoming());const question=f.sent[0];await f.service.receive(owner,contextReply(question));assert.equal(readConversation(f).status,'assessing_context');assert.equal(f.sent.length,1);
 assert.equal((await ownerAction(f,'approve',{policyRevision:3})).status,200);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.match(f.sent[1].text,/available times/i);assert.equal(readConversation(f).status,'offered');assert.equal(readConversation(f).pendingContext,undefined);assert.equal(readConversation(f).contextCapability,null);
 await f.restart().alarm();await f.restart().resumeApproved(owner,'request-one');await f.service.receive(owner,contextReply(question,1,{messageId:'<stale-after-approval@example.com>'}));assert.equal(f.sent.length,2);assert.equal(additions,1);
});
test('a context retry recovers an owner-approved offer after the approval notification was interrupted',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();let current:any=contextResult(),additions=0;core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>current;core.addSchedulingContext=async()=>{additions++;throw Error(additions===1?'transport interrupted before context write':'context_not_requested');};
 await f.service.receive(owner,incoming());await f.service.receive(owner,contextReply(f.sent[0]));assert.equal(readConversation(f).status,'assessing_context');assert.equal(f.sent.length,1);
 current={...result(),requiresReview:false,needsContext:false,contextQuestion:null};await f.restart().alarm();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.match(f.sent[1].text,/available times/i);assert.equal(readConversation(f).status,'offered');assert.equal(readConversation(f).pendingContext,undefined);
 await f.restart().alarm();assert.equal(f.sent.length,2);assert.equal(additions,2);
});
test('an eligible approval result cannot interrupt an email confirmation or completed booking',async t=>{
 for(const status of ['confirming','booked']){
  const f=fixture(t);await f.service.receive(owner,incoming());const thread=readConversation(f);thread.status=status;thread.capabilityHash=null;f.db.prepare('UPDATE scheduling_email_threads SET data=?,capability_hash=NULL WHERE id=?').run(JSON.stringify(thread),thread.id);
  f.env.BOOKING.getByName().getScheduling=async()=>({...result(),requiresReview:false,needsContext:false,contextQuestion:null});assert.deepEqual(await f.restart().resumeApproved(owner,'request-one'),{status});assert.equal(f.sent.length,1);assert.equal(readConversation(f).status,status);
 }
});
test('an unfinished persisted context assessment survives owner resume until its frozen evidence is retried',async t=>{
 const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>({...reviewResult(),needsContext:false,contextQuestion:null});let additions=0;core.addSchedulingContext=async()=>{if(!additions++)throw Error('transport interrupted during persisted assessment');return result();};
 await f.service.receive(owner,incoming());await f.service.receive(owner,contextReply(f.sent[0]));assert.equal(readConversation(f).status,'assessing_context');assert.equal(f.sent.length,1);
 assert.deepEqual(await f.restart().resumeApproved(owner,'request-one'),{status:'assessing_context'});assert.equal(readConversation(f).pendingContext.evidenceId,'<context-1@example.com>');assert.equal(f.sent.length,1);
 await f.restart().alarm();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].to,[peer]);assert.equal(readConversation(f).status,'offered');assert.equal(additions,2);
});
test('terminal context reassessment results close the email thread without an availability message',async t=>{
 for(const status of ['declined','cancelled','expired','async_submitted']){
  const f=fixture(t),core=f.env.BOOKING.getByName();core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>contextResult();let additions=0;core.addSchedulingContext=async()=>{if(!additions++)throw Error('transport interrupted after persisted context');return {...result(status),offer:null,requiresReview:false,needsContext:false,contextQuestion:null};};
  await f.service.receive(owner,incoming());const question=f.sent[0];await f.service.receive(owner,contextReply(question));assert.equal(readConversation(f).status,'assessing_context');await f.restart().alarm();assert.equal(f.sent.length,1,status);assert.equal(readConversation(f).status,'closed');assert.equal(readConversation(f).pendingContext,undefined);assert.equal(readConversation(f).contextCapability,null);
  await f.restart().alarm();await f.service.receive(owner,contextReply(question,1,{messageId:`<stale-${status}@example.com>`}));assert.equal(f.sent.length,1);assert.equal(additions,2);
 }
});
test('approved no-availability results finish pending context through owner resume or retry recovery',async t=>{
 for(const trigger of ['owner-resume','alarm']){
  const f=fixture(t),core=f.env.BOOKING.getByName();f.env.SCHEDULING_EMAIL={getByName:()=>f.service};let current:any=contextResult(),additions=0;const approved={...result('needs_new_slot'),offer:null,requiresReview:false,needsContext:false,contextQuestion:null};core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>current;core.approveScheduling=async()=>{current=approved;return current;};core.addSchedulingContext=async()=>{additions++;throw Error(additions===1?'transport interrupted before context write':'context_not_requested');};
  await f.service.receive(owner,incoming());await f.service.receive(owner,contextReply(f.sent[0]));assert.equal(readConversation(f).status,'assessing_context');
  if(trigger==='owner-resume')assert.equal((await ownerAction(f,'approve',{policyRevision:3})).status,200);else{current=approved;await f.restart().alarm();}
  assert.equal(f.sent.length,2,trigger);assert.deepEqual(f.sent[1].to,[peer]);assert.deepEqual(f.sent[1].cc,[owner]);assert.match(f.sent[1].text,/could not find an available time/i);assert.equal(f.sent[1].replyTo,undefined);assert.equal(readConversation(f).status,'closed');assert.equal(readConversation(f).pendingContext,undefined);
  await f.restart().alarm();await f.restart().resumeApproved(owner,'request-one');assert.equal(f.sent.length,2);assert.equal(additions,trigger==='owner-resume'?1:2);
 }
});
test('expired or unresolved offer projections cannot replace frozen context evidence',async t=>{
 for(const offered of [{...offer,expiresAt:Date.now()-1},null]){
  const f=fixture(t),core=f.env.BOOKING.getByName();let current:any=contextResult();core.prepareScheduling=async()=>contextResult();core.getScheduling=async()=>current;core.addSchedulingContext=async()=>{throw Error('transport interrupted');};await f.service.receive(owner,incoming());await f.service.receive(owner,contextReply(f.sent[0]));
  current={...result(),offer:offered,requiresReview:false,needsContext:false,contextQuestion:null};assert.deepEqual(await f.restart().resumeApproved(owner,'request-one'),{status:'assessing_context'});await f.restart().alarm();assert.equal(f.sent.length,1);assert.equal(readConversation(f).status,'assessing_context');assert.equal(readConversation(f).pendingContext.evidenceId,'<context-1@example.com>');
 }
});

test('raw parser accepts matching address display names but rejects address impersonation',async()=>{
 const raw=(from:string)=>`From: ${from}\r\nTo: ${agent}\r\nMessage-ID: <name@example.com>\r\nContent-Type: text/plain\r\n\r\nOption 1 works`;
 assert.equal((await parseSchedulingEmail(raw('"peer@example.com" <peer@example.com>'),agent)).from,peer);
 await assert.rejects(parseSchedulingEmail(raw('"owner@example.com" <peer@example.com>'),agent),/mailbox/);
});
function groupFixture(t:TestContext){
 const f=fixture(t),mail=f.env.MAIL.getByName();
 f.env.MAIL.getByName=()=>({...mail,verifySchedulingKickoff:async()=>({...await mail.verifySchedulingKickoff(),cc:[agent,'second@example.com']})});
 return f;
}
function groupReply(to:string,from:string,parent:string,id:string,text='Option 1 works'){
 return incoming({authenticatedSender:from,messageId:`<${id}@example.com>`,envelopeTo:to,from,to:[to],cc:[owner],inReplyTo:parent,text});
}
test('group waits for every guest and keeps original offer reply valid after acknowledgements and restart',async t=>{
 const f=groupFixture(t);let attendees:string[]=[];
 const prepare=f.env.BOOKING.getByName().prepareScheduling;
 f.env.BOOKING.getByName().prepareScheduling=async(o:string,input:any,a:any)=>{attendees=input.attendees;return prepare(o,input,a);};
 await f.service.receive(owner,incoming());
 assert.deepEqual(attendees,[peer,'second@example.com']);assert.equal(f.sent.length,1);
 assert.deepEqual(f.sent[0].to,[peer,'second@example.com']);assert.deepEqual(f.sent[0].cc,[owner]);
 assert.doesNotMatch(JSON.stringify(f.sent),/PRIVATE/);
 const a=f.sent[0].replyTo,b=f.sent[0].replyTo;
 await f.service.receive(owner,{...groupReply(a,'second@example.com','<outbound-1@cloudflare.net>','impersonation'),authenticatedSender:peer});
 assert.equal(f.confirmed.length,0);assert.equal(f.sent.length,1);
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 assert.equal(f.confirmed.length,0);assert.match(f.sent.at(-1).text,/waiting/i);
 // Guest two's original offer is still current after guest one's status email.
 await f.restart().receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second'));
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].slotId,'slot-one');
 assert.deepEqual(f.sent.at(-1).to,[peer,'second@example.com']);assert.deepEqual(f.sent.at(-1).cc,[owner]);assert.match(f.sent.at(-1).text,/booked/i);
 await f.restart().receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','duplicate-selection'));
 assert.equal(f.confirmed.length,1);
});
test('group conflicting choices never book and a later same-option reply resolves consensus',async t=>{
 const f=groupFixture(t);await f.service.receive(owner,incoming());assert.equal(f.sent.length,1);
 const a=f.sent[0].replyTo,b=f.sent[0].replyTo;
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','different','Option 2 works'));
 assert.equal(f.confirmed.length,0);assert.match(f.sent.at(-1).text,/different|same option/i);
 await f.restart().receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','changed','Option 2 works'));
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].slotId,'slot-two');
});
test('group refresh resets every agreement and invalidates all old reply capabilities',async t=>{
 const f=groupFixture(t);await f.service.receive(owner,incoming());assert.equal(f.sent.length,1);
 const a=f.sent[0].replyTo,b=f.sent[0].replyTo;
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','refresh','Other options please'));
 f.env.BOOKING.getByName().getScheduling=async()=>({...result(),offer:{...offer,revision:'revision-two'}});
 const newOffers=f.sent.slice(-1),start=f.sent.length;
 assert.notEqual(newOffers[0].replyTo,a);assert.notEqual(newOffers[0].replyTo,b);
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','stale'));
 assert.equal(f.confirmed.length,0);
 await f.service.receive(owner,groupReply(newOffers[0].replyTo,'second@example.com',`<outbound-${start}@cloudflare.net>`,'new-second'));
 assert.equal(f.confirmed.length,0);
 await f.service.receive(owner,groupReply(newOffers[0].replyTo,peer,`<outbound-${start}@cloudflare.net>`,'new-first'));
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].revision,'revision-two');
});

test('group confirmation receipt recovers after storage interruption without losing the booked result',async t=>{
 const f=groupFixture(t);await f.service.receive(owner,incoming());
 const a=f.sent[0].replyTo,b=f.sent[0].replyTo;
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 const exec=f.ctx.storage.sql.exec;let fail=true;
 f.ctx.storage.sql.exec=(sql:string,...args:any[])=>{
  if(fail&&sql.startsWith('INSERT OR IGNORE INTO scheduling_email_outbox')&&String(args[0]).endsWith(':booked')){fail=false;throw Error('storage interrupted');}
  return exec(sql,...args);
 };
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second'));
 assert.equal(f.sent.filter(message=>message.text.startsWith('The meeting is booked')).length,0);
 await f.restart().alarm();
 assert.equal(f.sent.filter(message=>message.text.startsWith('The meeting is booked')).length,1);
 await f.restart().alarm();
 assert.equal(f.sent.filter(message=>message.text.startsWith('The meeting is booked')).length,1);
});

test('group clarification and repeated owner approval preserve votes and the original offer parent',async t=>{
 const f=groupFixture(t);await f.service.receive(owner,incoming());
 const a=f.sent[0].replyTo,b=f.sent[0].replyTo;
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 await f.restart().resumeApproved(owner,'request-one');
 assert.equal(f.sent.length,2);
 for(let i=0;i<21;i++){
  const parent=i===0?'<outbound-1@cloudflare.net>':`<outbound-${f.sent.length}@cloudflare.net>`;
  await f.service.receive(owner,groupReply(b,'second@example.com',parent,`clarify-${i}`,'Maybe'));
 }
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second'));
 assert.equal(f.confirmed.length,1);
});
test('group delivery bookkeeping never records sent without its reply parent after a storage failure',async t=>{
 const f=groupFixture(t),exec=f.ctx.storage.sql.exec;let fail=true;
 f.ctx.storage.sql.exec=(sql:string,...args:any[])=>{
  if(fail&&f.sent.length===1&&sql.startsWith('INSERT INTO scheduling_email_threads')){fail=false;throw Error('parent storage interrupted');}
  return exec(sql,...args);
 };
 await f.service.receive(owner,incoming());
 const row=f.db.prepare("SELECT status,message_id FROM scheduling_email_outbox WHERE json_extract(data,'$.to[0]')=?").get(peer) as any;
 assert.equal(row.status,'unknown');assert.equal(row.message_id,null);
 assert.equal((await f.restart().diagnostics(owner)).deliveryUnknown,1);
 await f.restart().alarm();assert.equal(f.sent.filter(message=>message.to[0]===peer).length,1);
});

test('group retries cannot overwrite a newer guest choice or clear it with an older refresh',async t=>{
 for(const oldText of ['Option 1 works','Other options please']){
  const f=groupFixture(t);await f.service.receive(owner,incoming());const a=f.sent[0].replyTo,b=f.sent[0].replyTo,core=f.env.BOOKING.getByName();
  const method=oldText.startsWith('Option')?'getScheduling':'refreshScheduling',normal=core[method];let fail=true;
  core[method]=async(...args:any[])=>{if(fail){fail=false;throw Error('temporary upstream failure');}return normal(...args);};
  await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','old',oldText));
  await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','new','Option 2 works'));
  await f.restart().alarm();
  assert.equal(f.refreshes(),0);
  await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second','Option 1 works'));
  assert.equal(f.confirmed.length,0);
  await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second-new','Option 2 works'));
  assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].slotId,'slot-two');
 }
});
test('a pending changed guest choice immediately withdraws their previous agreement',async t=>{
 const f=groupFixture(t);await f.service.receive(owner,incoming());const a=f.sent[0].replyTo,b=f.sent[0].replyTo,core=f.env.BOOKING.getByName();
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','first'));
 const normal=core.getScheduling;let fail=true;
 core.getScheduling=async()=>{if(fail){fail=false;throw Error('temporary upstream failure');}return normal();};
 await f.service.receive(owner,groupReply(a,peer,'<outbound-1@cloudflare.net>','changed','Option 2 works'));
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','second'));
 assert.equal(f.confirmed.length,0);
 await f.restart().alarm();assert.equal(f.confirmed.length,0);
 await f.service.receive(owner,groupReply(b,'second@example.com','<outbound-1@cloudflare.net>','changed-second','Option 2 works'));
 assert.equal(f.confirmed.length,1);assert.equal(f.confirmed[0].slotId,'slot-two');
});

test('a newer ambiguous or withdrawn group reply clears earlier agreement before another guest can book',async t=>{
 for(const text of ['Actually I can’t make it','Maybe option 2 instead']){
  const f=groupFixture(t);await f.service.receive(owner,incoming());const address=f.sent[0].replyTo;
  await f.service.receive(owner,groupReply(address,peer,'<outbound-1@cloudflare.net>','first'));
  await f.service.receive(owner,groupReply(address,peer,'<outbound-1@cloudflare.net>','withdrawn',text));
  await f.service.receive(owner,groupReply(address,'second@example.com','<outbound-1@cloudflare.net>','second'));
  assert.equal(f.confirmed.length,0);assert.match(f.sent.at(-1).text,/Waiting for peer@example.com/);
  await f.service.receive(owner,groupReply(address,peer,'<outbound-1@cloudflare.net>','reconfirmed'));
  assert.equal(f.confirmed.length,1);
 }
});
