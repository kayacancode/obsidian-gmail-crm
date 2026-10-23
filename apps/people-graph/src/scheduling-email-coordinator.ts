import {DurableObject} from 'cloudflare:workers';
import type {BookingEnv} from './booking-types';
import {BookingStore} from './booking-store';
import {digest} from './mail-model';
import {schedulingEmailConfiguration} from './scheduling-email';
import {parseSchedulingChoice,schedulingAddress,schedulingCounterpart,schedulingMessageId,schedulingOfferText,schedulingSlotText,parseOwnerSchedulingWindow,type SchedulingInboundEmail,type VerifiedSchedulingKickoff} from './scheduling-email-policy';
import type {SchedulingConfirmation,SchedulingOffer,SchedulingResult} from './scheduling-types';

export interface SchedulingEmailEnv extends BookingEnv {
 SCHEDULING_EMAIL?:DurableObjectNamespace<SchedulingEmailCoordinator>;
 SCHEDULING_EMAIL_ADDRESS?:string;SCHEDULING_EMAIL_REPLY_DOMAIN?:string;SCHEDULING_EMAIL_SEND?:SendEmail;
}
interface Conversation {
 id:string;owner:string;peer:string;gmailId:string;subject:string;kickoffMessageId:string;requestId:string|null;
 status:'offered'|'confirming'|'booked'|'closed'|'needs_attention';offer:SchedulingOffer|null;timezone:string;
 capabilityHash:string|null;replyAddress:string|null;latestMessageId:string|null;
 selection?:SchedulingConfirmation&{start:string;end:string};attempts:number;lastInbound:string;
}
type InboxRow={id:string;data:string;attempts:number};
type OutboxRow={id:string;thread:string;data:string};
type Outgoing={from:string;to:string[];cc:string[];subject:string;text:string;replyTo?:string;headers:Record<string,string>};

/** Per-owner durable conversations. BookingCoordinator remains the only calendar
 * writer. An accepted-but-unacknowledged email is deliberately never resent. */
export class SchedulingEmailCoordinator extends DurableObject<SchedulingEmailEnv>{
 private tail:Promise<unknown>=Promise.resolve();
 constructor(ctx:DurableObjectState,env:SchedulingEmailEnv){
  super(ctx,env);
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS scheduling_email_threads(id TEXT PRIMARY KEY,gmail_id TEXT UNIQUE,capability_hash TEXT,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS scheduling_email_inbox(id TEXT PRIMARY KEY,data TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,received INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS scheduling_email_outbox(id TEXT PRIMARY KEY,thread TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT);`);
  // A previous instance may have died after the remote service accepted a send.
  ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='unknown' WHERE status='sending'");
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const task=this.tail.then(fn,fn);this.tail=task.catch(()=>{});return task;}
 private config(owner:string){const config=schedulingEmailConfiguration(this.env);if(!config||config.owner!==owner)throw Error('scheduling_email_disabled');return config;}
 private rows<T extends Record<string,SqlStorageValue>>(sql:string,...args:SqlStorageValue[]){return this.ctx.storage.sql.exec<T>(sql,...args).toArray();}
 private thread(id:string):Conversation|null {const row=this.rows<{data:string}>('SELECT data FROM scheduling_email_threads WHERE id=?',id)[0];return row?JSON.parse(row.data):null;}
 private save(thread:Conversation){this.ctx.storage.sql.exec('INSERT INTO scheduling_email_threads(id,gmail_id,capability_hash,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET capability_hash=excluded.capability_hash,data=excluded.data',thread.id,thread.gmailId,thread.capabilityHash,JSON.stringify(thread));}
 private core(owner:string){return this.env.BOOKING.getByName(owner);}
 async receive(owner:string,input:SchedulingInboundEmail):Promise<{status:string}>{return this.serial(async()=>{
  const config=this.config(owner);
  // RPC is internal, but bound its input as well as the raw-email adapter.
  if(JSON.stringify(input).length>16384||input.text.length>4000||input.to.length+input.cc.length>12)throw Error('invalid_scheduling_email');
  schedulingMessageId(input.messageId);schedulingAddress(input.from);schedulingAddress(input.envelopeTo);
  const base='scheduling@'+config.replyDomain;
  if(input.envelopeTo!==config.address&&input.envelopeTo!==base&&!new RegExp('^scheduling\\+[a-f0-9]{48}@'+config.replyDomain.replace(/[.]/g,'\\.')+'$').test(input.envelopeTo))return {status:'ignored'};
  const id=await digest(input.envelopeTo+'\0'+input.from+'\0'+input.messageId);
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_inbox WHERE id=?',id).length)return {status:'duplicate'};
  const count=this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE received>?',Date.now()-86400000)[0]?.n??0;
  if(count>=200)throw Error('scheduling_email_rate_limited');
  this.ctx.storage.sql.exec("INSERT INTO scheduling_email_inbox(id,data,status,received) VALUES(?,?,'queued',?)",id,JSON.stringify(input),Date.now());
  await this.ctx.storage.setAlarm(Date.now()+30000);
  await this.process(owner,{id,data:JSON.stringify(input),attempts:0});await this.flush(owner);return {status:'accepted'};
 });}
 private async process(owner:string,row:InboxRow){
  const input=JSON.parse(row.data) as SchedulingInboundEmail,config=this.config(owner);
  try{
   if(input.envelopeTo.startsWith('scheduling+'))await this.participant(owner,row.id,input);
   else if(input.from===owner&&(input.envelopeTo===config.address||input.envelopeTo==='scheduling@'+config.replyDomain))await this.kickoff(owner,row.id,input);
   this.ctx.storage.sql.exec("UPDATE scheduling_email_inbox SET status='done' WHERE id=?",row.id);
  }catch(error){
   const message=error instanceof Error?error.message:'';
   const permanent=/invalid_|one_counterpart|grant_revoked|rate_limited|request_closed/.test(message);
   this.ctx.storage.sql.exec('UPDATE scheduling_email_inbox SET status=?,attempts=attempts+1 WHERE id=?',permanent||row.attempts>=2?'ignored':'queued',row.id);
  }
 }
 private async kickoff(owner:string,inboxId:string,input:SchedulingInboundEmail){
  const config=this.config(owner),mail=this.env.MAIL.getByName(owner);await mail.bindOwner(owner);
  const canonical:VerifiedSchedulingKickoff=await mail.verifySchedulingKickoff(input.messageId,config.address);
  if(canonical.owner!==owner||canonical.from!==owner)throw Error('invalid_owner_kickoff');
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_threads WHERE gmail_id=?',canonical.gmailId).length)return;
  let peer:string;
  try{peer=schedulingCounterpart(canonical,owner,config.address);}catch{
   this.ownerClarification(owner,inboxId,canonical,'Please start a scheduling thread with exactly one counterpart and the scheduling agent.');return;
  }
  const settings=await new BookingStore(this.env.DB).settings(owner);if(!settings)throw Error('scheduling_settings_unavailable');
  const window=parseOwnerSchedulingWindow(canonical.text,settings.timezone);
  if(window.kind==='clarify'){
   this.ownerClarification(owner,inboxId,canonical,'I need a clearer scheduling window before contacting your counterpart. I can use your saved scheduling rules, “this week”, or “next week”. Please remove other timing constraints or set them in your booking settings, then send a fresh request.');return;
  }
  const id='email_'+await digest(owner+'\0'+canonical.gmailId),result=await this.core(owner).prepareScheduling(owner,{email:peer,context:canonical.text,timezone:settings.timezone,...window.window,idempotencyKey:id},{channel:'owner_email',evidenceId:canonical.gmailId});
  const thread:Conversation={id,owner,peer,gmailId:canonical.gmailId,subject:canonical.subject,kickoffMessageId:canonical.messageId,requestId:result.requestId,status:'offered',offer:null,timezone:result.timezone,capabilityHash:null,replyAddress:null,latestMessageId:null,attempts:0,lastInbound:canonical.messageId};
  await this.offer(thread,result,inboxId);
 }
 private ownerClarification(owner:string,inboxId:string,canonical:VerifiedSchedulingKickoff,text:string){
  const config=this.config(owner);
  this.queue(inboxId,'owner:'+canonical.gmailId,{from:config.address,to:[owner],cc:[],subject:this.subject(canonical.subject),text,headers:{'In-Reply-To':canonical.messageId,'References':canonical.messageId,'Auto-Submitted':'auto-replied'}});
 }
 private async participant(owner:string,inboxId:string,input:SchedulingInboundEmail){
  const config=this.config(owner),token=input.envelopeTo.split('@')[0].slice('scheduling+'.length),hash=await digest(token);
  const found=this.rows<{data:string}>('SELECT data FROM scheduling_email_threads WHERE capability_hash=?',hash)[0];if(!found)return;
  const thread=JSON.parse(found.data) as Conversation;
  if(thread.owner!==owner||thread.status!=='offered'||!thread.offer||input.envelopeTo!==thread.replyAddress||input.from!==thread.peer||!thread.latestMessageId||input.inReplyTo!==thread.latestMessageId)return;
  const allowed=new Set([owner,thread.peer,config.address,thread.replyAddress!]);
  if([...input.to,...input.cc].some(address=>!allowed.has(address)))return;
  if(this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE thread=?',thread.id)[0].n>=12){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
  thread.lastInbound=input.messageId;
  if(thread.offer.expiresAt<=Date.now()){await this.offer(thread,await this.core(owner).refreshScheduling(owner,thread.requestId!),inboxId);return;}
  const choice=parseSchedulingChoice(input.text,thread.offer);
  if(choice.kind==='clarify'){
   await this.offer(thread,{requestId:thread.requestId!,status:'pending_approval',timezone:thread.timezone,offer:thread.offer,replyText:'',recommendation:{summary:'',reasons:[],uncertainties:[]}},inboxId,true);return;
  }
  if(choice.kind==='refresh'){await this.offer(thread,await this.core(owner).refreshScheduling(owner,thread.requestId!),inboxId);return;}
  const slot=thread.offer.slots.find(value=>value.id===choice.slotId)!;
  thread.selection={revision:thread.offer.revision,slotId:slot.id,evidenceId:input.messageId,start:slot.start,end:slot.end};
  thread.status='confirming';thread.capabilityHash=null;thread.attempts=0;this.save(thread);
  await this.ctx.storage.setAlarm(Date.now()+30000);
  await this.confirm(thread,inboxId);
 }
 private async confirm(thread:Conversation,key:string){
  if(!thread.selection||!thread.requestId)return;
  try{
   const {revision,slotId,evidenceId}=thread.selection;
   const result=await this.core(thread.owner).confirmScheduling(thread.owner,thread.requestId,{revision,slotId,evidenceId});
   await this.reconciled(thread,result,key);
  }catch(error){
   if(error instanceof Error&&error.message==='request_closed'){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
   if(error instanceof Error&&/^(?:offer_changed|offer_expired|settings_changed)$/.test(error.message)){
    await this.offer(thread,await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId),key);return;
   }
   // The booking service may have persisted an intent before transport failed.
   // Retain the same selection and evidence for its stable event reconciliation.
   thread.attempts++;if(thread.attempts>=8)thread.status='needs_attention';this.save(thread);
  }
 }
 private async reconciled(thread:Conversation,result:SchedulingResult,key:string){
  if(result.status==='booked'){
   thread.status='booked';thread.capabilityHash=null;this.save(thread);
   const selected=thread.selection;if(!selected)return;
   this.queue(thread.id+':booked',thread.id,this.outgoing(thread,`The meeting is booked for ${schedulingSlotText(selected.start,selected.end,thread.timezone)}. Please see the calendar invitation.`,false));return;
  }
  if(result.status==='booking'){thread.status='confirming';thread.attempts++;if(thread.attempts>=8)thread.status='needs_attention';this.save(thread);return;}
  if(result.status==='needs_new_slot'||result.status==='pending_approval'){
   await this.offer(thread,result.offer?result:await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId!),key);return;
  }
  thread.status='closed';thread.capabilityHash=null;this.save(thread);
 }
 private async offer(thread:Conversation,result:SchedulingResult,key:string,clarify=false){
  // A refresh/prepare result contains no proof that its booking is our exact
  // selected revision and slot. Another channel may have reserved a different
  // time while the refresh was in flight. Only confirm() may acknowledge it.
  if(result.status==='booking'||result.status==='booked'){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
  const outboxId=key+':offer:'+(result.offer?.revision??'none');
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_outbox WHERE id=?',outboxId).length)return;
  thread.offer=result.offer;thread.timezone=result.timezone;thread.status=result.offer?'offered':'closed';thread.selection=undefined;thread.attempts=0;
  thread.latestMessageId=null;thread.capabilityHash=null;thread.replyAddress=null;
  if(result.offer){const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');thread.capabilityHash=await digest(token);thread.replyAddress=`scheduling+${token}@${this.config(thread.owner).replyDomain}`;}
  this.save(thread);this.queue(outboxId,thread.id,this.outgoing(thread,schedulingOfferText(result,clarify),true));
 }
 private subject(value:string){return 'Re: '+value.replace(/^(?:re:\s*)+/i,'').replace(/[\r\n\x00-\x1f\x7f]/g,'').slice(0,150);}
 private outgoing(thread:Conversation,text:string,reply:boolean):Outgoing {
  const config=this.config(thread.owner),references=[thread.kickoffMessageId,thread.lastInbound].filter((id,i,ids)=>ids.indexOf(id)===i).join(' ');
  return {from:config.address,to:[thread.peer],cc:[thread.owner],subject:this.subject(thread.subject),text,...(reply&&thread.replyAddress?{replyTo:thread.replyAddress}:{}),headers:{'In-Reply-To':thread.lastInbound,'References':references,'Auto-Submitted':'auto-replied'}};
 }
 private queue(id:string,thread:string,message:Outgoing){this.ctx.storage.sql.exec("INSERT OR IGNORE INTO scheduling_email_outbox(id,thread,data,status) VALUES(?,?,?,'ready')",id,thread,JSON.stringify(message));}
 private async flush(owner:string){
  const config=this.config(owner);
  for(const row of this.rows<OutboxRow>("SELECT id,thread,data FROM scheduling_email_outbox WHERE status='ready' LIMIT 5")){
   this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='sending' WHERE id=? AND status='ready'",row.id);
   try{
    const message=JSON.parse(row.data) as Outgoing;if(message.from!==config.address)throw Error('sender_configuration_changed');
    const result=await this.env.SCHEDULING_EMAIL_SEND!.send(message);
    const messageId=schedulingMessageId(result.messageId.startsWith('<')?result.messageId:'<'+result.messageId+'>');
    this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='sent',message_id=? WHERE id=?",messageId,row.id);
    const thread=this.thread(row.thread);if(thread&&thread.status==='offered'){thread.latestMessageId=messageId;this.save(thread);}
   }catch{this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='unknown' WHERE id=?",row.id);}
  }
 }
 async alarm():Promise<void>{return this.serial(async()=>{
  const config=schedulingEmailConfiguration(this.env);if(!config)return;
  for(const row of this.rows<InboxRow>("SELECT id,data,attempts FROM scheduling_email_inbox WHERE status='queued' ORDER BY received LIMIT 5"))await this.process(config.owner,row);
  for(const row of this.rows<{data:string}>("SELECT data FROM scheduling_email_threads WHERE json_extract(data,'$.status')='confirming' LIMIT 5")){
   const thread=JSON.parse(row.data) as Conversation;
   try{
    // This checks the persisted revision/slot even if another channel has
    // already booked. A generic booked status cannot confirm our selected time.
    await this.confirm(thread,thread.id+':reconcile');
   }catch{thread.attempts++;if(thread.attempts>=8)thread.status='needs_attention';this.save(thread);}
  }
  await this.flush(config.owner);
  const pending=this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE status='queued'")[0].n+this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status')='confirming'")[0].n+this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='ready'")[0].n;
  if(pending)await this.ctx.storage.setAlarm(Date.now()+60000);
 });}
 async diagnostics(owner:string):Promise<{pending:number;deliveryUnknown:number;needsAttention:number}>{return this.serial(async()=>{
  if(schedulingAddress(this.env.BOOKING_OWNER_EMAIL??'')!==owner)throw Error('wrong_owner');
  const count=(sql:string)=>this.rows<{n:number}>(sql)[0].n;
  return {pending:count("SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE status='queued'")+count("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='ready'")+count("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status')='confirming'"),deliveryUnknown:count("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='unknown'"),needsAttention:count("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status')='needs_attention'")};
 });}
}
