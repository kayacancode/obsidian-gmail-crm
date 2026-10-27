import {DurableObject} from 'cloudflare:workers';
import type {BookingEnv} from './booking-types';
import {BookingStore} from './booking-store';
import {digest} from './mail-model';
import {schedulingEmailConfiguration,parseSchedulingEmail} from './scheduling-email';
import {verifySchedulingSender,SchedulingSenderAuthUnavailable} from './scheduling-sender-auth';
import {schedulingContextQuestion} from './scheduling-policy';
import {authoredSchedulingText,parseSchedulingChoice,schedulingAddress,schedulingParticipants,schedulingMessageId,schedulingOfferText,schedulingSlotText,parseOwnerSchedulingWindow,type SchedulingInboundEmail,type VerifiedSchedulingKickoff} from './scheduling-email-policy';
import type {SchedulingConfirmation,SchedulingInput,SchedulingOffer,SchedulingResult} from './scheduling-types';

export interface SchedulingEmailEnv extends BookingEnv {
 SCHEDULING_EMAIL?:DurableObjectNamespace<SchedulingEmailCoordinator>;
 SCHEDULING_EMAIL_ADDRESS?:string;SCHEDULING_EMAIL_REPLY_DOMAIN?:string;SCHEDULING_EMAIL_SEND?:SendEmail;
}
interface Conversation {
 id:string;owner:string;peer:string;gmailId:string;subject:string;kickoffMessageId:string;requestId:string|null;
 guests?:string[];participants?:GroupParticipant[];
 groupReply?:{hash:string;replyAddress:string;messageIds:string[]};
 status:'awaiting_context'|'assessing_context'|'awaiting_review'|'offered'|'confirming'|'booked'|'closed'|'needs_attention';offer:SchedulingOffer|null;timezone:string;
 capabilityHash:string|null;replyAddress:string|null;latestMessageId:string|null;
 contextCapability?:{hash:string;replyAddress:string;expiresAt:number;messageId:string|null}|null;contextRounds?:number;contextReviewReason?:string;
 pendingContext?:{context:string;evidenceId:string;key:string};
 selection?:SchedulingConfirmation&{start:string;end:string};attempts:number;lastInbound:string;
}
interface GroupParticipant {email:string;hash:string;replyAddress:string;messageIds:string[];latestInboundOrder?:number;choice?:{slotId:string;evidenceId:string}}
type InboxRow={id:string;data:string;attempts:number};
type OutboxRow={id:string;thread:string;data:string};
type Outgoing={from:string;to:string[];cc:string[];subject:string;text:string;replyTo?:string;headers:Record<string,string>};
const terminalSchedulingStatuses=new Set(['declined','cancelled','expired','async_submitted']);

/** Per-owner durable conversations. BookingCoordinator remains the only calendar
 * writer. An accepted-but-unacknowledged email is deliberately never resent. */
export class SchedulingEmailCoordinator extends DurableObject<SchedulingEmailEnv>{
 private tail:Promise<unknown>=Promise.resolve();
 constructor(ctx:DurableObjectState,env:SchedulingEmailEnv){
  super(ctx,env);
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS scheduling_email_threads(id TEXT PRIMARY KEY,gmail_id TEXT UNIQUE,capability_hash TEXT,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS scheduling_email_preparations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS scheduling_email_inbox(id TEXT PRIMARY KEY,data TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,received INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS scheduling_email_auth_inbox(id TEXT PRIMARY KEY,raw BLOB NOT NULL,envelope_to TEXT NOT NULL,received INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
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
 async receive(owner:string,input:SchedulingInboundEmail):Promise<{status:string}>{return this.serial(async()=>this.accept(owner,input));}
 private async accept(owner:string,input:SchedulingInboundEmail):Promise<{status:string}>{
  const config=this.config(owner);
  // RPC is internal, but bound its input as well as the raw-email adapter.
  if(JSON.stringify(input).length>16384||input.text.length>4000||input.to.length+input.cc.length>12)throw Error('invalid_scheduling_email');
  schedulingMessageId(input.messageId);schedulingAddress(input.from);schedulingAddress(input.envelopeTo);
  const base='scheduling@'+config.replyDomain;
  if(input.envelopeTo!==config.address&&input.envelopeTo!==base&&!new RegExp('^scheduling\\+[a-f0-9]{48}@'+config.replyDomain.replace(/[.]/g,'\\.')+'$').test(input.envelopeTo))return {status:'ignored'};
  const id=await digest(input.envelopeTo+'\0'+input.from+'\0'+input.messageId);
  const existing=this.rows<{status:string}>('SELECT status FROM scheduling_email_inbox WHERE id=?',id)[0];
  if(existing&&existing.status!=='awaiting_auth')return {status:'duplicate'};
  if(existing&&!input.authenticatedSender)return {status:'duplicate'};
  const count=this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE received>?',Date.now()-86400000)[0]?.n??0;
  if(!existing&&count>=200)throw Error('scheduling_email_rate_limited');
  this.ctx.storage.transactionSync(()=>{
   this.ctx.storage.sql.exec("INSERT INTO scheduling_email_inbox(id,data,status,received) VALUES(?,?,'queued',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,status='queued'",id,JSON.stringify(input),Date.now());
   this.ctx.storage.sql.exec('DELETE FROM scheduling_email_auth_inbox WHERE id=?',id);
  });
  await this.ctx.storage.setAlarm(Date.now()+30000);
  await this.process(owner,{id,data:JSON.stringify(input),attempts:0});await this.flush(owner);return {status:'accepted'};
 }
 /** Preserve original arrival order while a transient DNS failure prevents identity checks. */
 async deferSenderVerification(owner:string,raw:ArrayBuffer,envelopeTo:string):Promise<boolean>{return this.serial(async()=>{
  this.config(owner);const input=await parseSchedulingEmail(raw,envelopeTo);
  if(!/^scheduling\+[a-f0-9]{48}@/.test(input.envelopeTo))return false;
  const hash=await digest(input.envelopeTo.split('@')[0].slice('scheduling+'.length));
  const found=this.rows<{data:string}>('SELECT data FROM scheduling_email_threads WHERE capability_hash=?',hash)[0];
  const thread=found?JSON.parse(found.data) as Conversation:null;
  if(!thread?.groupReply||thread.owner!==owner||thread.status!=='offered'||!thread.guests?.includes(input.from))return false;
  if(input.envelopeTo!==thread.groupReply.replyAddress||!input.inReplyTo||!thread.groupReply.messageIds.includes(input.inReplyTo)&&!input.references.some(id=>thread.groupReply!.messageIds.includes(id)))return false;
  const recipients=new Set([owner,...thread.guests,this.config(owner).address,thread.groupReply.replyAddress]);if([...input.to,...input.cc].some(address=>!recipients.has(address)))return false;
  const id=await digest(input.envelopeTo+'\0'+input.from+'\0'+input.messageId);
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_inbox WHERE id=?',id).length)return true;
  const count=this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE received>?',Date.now()-86400000)[0]?.n??0;
  if(count>=200)throw Error('scheduling_email_rate_limited');
  this.ctx.storage.transactionSync(()=>{
   this.ctx.storage.sql.exec("INSERT INTO scheduling_email_inbox(id,data,status,received) VALUES(?,?,'awaiting_auth',?)",id,JSON.stringify(input),Date.now());
   this.ctx.storage.sql.exec('INSERT INTO scheduling_email_auth_inbox(id,raw,envelope_to,received) VALUES(?,?,?,?)',id,raw,input.envelopeTo,Date.now());
  });
  await this.ctx.storage.setAlarm(Date.now()+30000);return true;
 });}
 private async retrySenderVerification(owner:string){
  for(const row of this.rows<{id:string;raw:ArrayBuffer;envelope_to:string;received:number;attempts:number}>('SELECT id,raw,envelope_to,received,attempts FROM scheduling_email_auth_inbox ORDER BY received LIMIT 2')){
   try{
    if(Date.now()-row.received>900000)throw Error('sender_verification_expired');
    const input=await parseSchedulingEmail(row.raw,row.envelope_to);
    let sender=await verifySchedulingSender(new Uint8Array(row.raw),input);
    if(!sender){const mail=this.env.MAIL.getByName(owner);await mail.bindOwner(owner);sender=await mail.verifySchedulingGuestReply(input);}
    if(sender){input.authenticatedSender=sender;await this.accept(owner,input);continue;}
   }catch(error){
    if((error instanceof SchedulingSenderAuthUnavailable||error instanceof Error&&error.message==='scheduling_sender_auth_unavailable')&&row.attempts<2){this.ctx.storage.sql.exec('UPDATE scheduling_email_auth_inbox SET attempts=attempts+1 WHERE id=?',row.id);continue;}
   }
   // Never retain raw email after verification finishes or the bounded retry ends.
   this.ctx.storage.transactionSync(()=>{
    this.ctx.storage.sql.exec('DELETE FROM scheduling_email_auth_inbox WHERE id=?',row.id);
    this.ctx.storage.sql.exec("UPDATE scheduling_email_inbox SET status='auth_failed' WHERE id=? AND status='awaiting_auth'",row.id);
   });
  }
 }
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
  let guests:string[];
  try{guests=schedulingParticipants(canonical,owner,config.address);}catch{
   this.ownerClarification(owner,inboxId,canonical,'Please include one to five guests and the scheduling agent. Everyone in To and Cc will be invited.');return;
  }
  const peer=guests[0];
  const settings=await new BookingStore(this.env.DB).settings(owner);if(!settings)throw Error('scheduling_settings_unavailable');
  const window=parseOwnerSchedulingWindow(canonical.text,settings.timezone);
  if(window.kind==='clarify'){
   this.ownerClarification(owner,inboxId,canonical,'I need a clearer scheduling window before contacting your counterpart. I can use your saved scheduling rules, “this week”, or “next week”. Please remove other timing constraints or set them in your booking settings, then send a fresh request.');return;
  }
  const id='email_'+await digest(owner+'\0'+canonical.gmailId);
  // Freeze evidence and the interpreted window before the remote core call. A
  // retry after an uncertain response must keep exactly the same request even
  // if the optional Gmail context fetch later fails or settings have changed.
  this.ctx.storage.sql.exec('INSERT OR IGNORE INTO scheduling_email_preparations(id,data) VALUES(?,?)',id,JSON.stringify({email:peer,...(guests.length>1?{attendees:guests}:{}),context:canonical.context??canonical.text,timezone:settings.timezone,...window.window,idempotencyKey:id}));
  const prepared=JSON.parse(this.rows<{data:string}>('SELECT data FROM scheduling_email_preparations WHERE id=?',id)[0].data) as SchedulingInput;
  const result=await this.core(owner).prepareScheduling(owner,prepared,{channel:'owner_email',evidenceId:canonical.gmailId});
  const thread:Conversation={id,owner,peer,guests:prepared.attendees??[peer],gmailId:canonical.gmailId,subject:canonical.subject,kickoffMessageId:canonical.messageId,requestId:result.requestId,status:'offered',offer:null,timezone:result.timezone,capabilityHash:null,replyAddress:null,latestMessageId:null,attempts:0,lastInbound:canonical.messageId};
  await this.offer(thread,result,inboxId);
 }
 private ownerClarification(owner:string,inboxId:string,canonical:VerifiedSchedulingKickoff,text:string){
  const config=this.config(owner);
  this.queue(inboxId,'owner:'+canonical.gmailId,{from:config.address,to:[owner],cc:[],subject:this.subject(canonical.subject),text,headers:{'In-Reply-To':canonical.messageId,'References':canonical.messageId,'Auto-Submitted':'auto-replied'}});
 }
 private async participant(owner:string,inboxId:string,input:SchedulingInboundEmail){
  const config=this.config(owner),token=input.envelopeTo.split('@')[0].slice('scheduling+'.length),hash=await digest(token);
  const group=this.rows<{data:string}>("SELECT t.data FROM scheduling_email_threads t, json_each(t.data,'$.participants') p WHERE json_extract(p.value,'$.hash')=? LIMIT 1",hash)[0];
  if(group){await this.groupParticipant(JSON.parse(group.data) as Conversation,inboxId,input,hash);return;}
  const contextFound=this.rows<{data:string}>("SELECT data FROM scheduling_email_threads WHERE json_extract(data,'$.contextCapability.hash')=?",hash)[0];
  if(contextFound){
   const thread=JSON.parse(contextFound.data) as Conversation,capability=thread.contextCapability!;
   if(thread.owner!==owner||thread.status!=='awaiting_context'||thread.pendingContext||capability.expiresAt<=Date.now()||input.envelopeTo!==capability.replyAddress||input.from!==thread.peer||!capability.messageId||input.inReplyTo!==capability.messageId)return;
   const allowed=new Set([owner,thread.peer,config.address,capability.replyAddress]);if([...input.to,...input.cc].some(address=>!allowed.has(address)))return;
   const context=authoredSchedulingText(input.text).slice(0,1500).trim();if(!context)return;
   // Consume the capability and freeze this evidence before the remote call.
   // Neither a duplicate nor a competing reply can replace an uncertain result.
   thread.pendingContext={context,evidenceId:input.messageId,key:inboxId};thread.lastInbound=input.messageId;
   thread.contextCapability=null;thread.status='assessing_context';thread.attempts=0;this.save(thread);
   await this.ctx.storage.setAlarm(Date.now()+30000);await this.assessContext(thread);return;
  }
  const found=this.rows<{data:string}>('SELECT data FROM scheduling_email_threads WHERE capability_hash=?',hash)[0];if(!found)return;
  const thread=JSON.parse(found.data) as Conversation;
  if(thread.groupReply){await this.groupParticipant(thread,inboxId,input,hash);return;}
  if(thread.owner!==owner||thread.status!=='offered'||!thread.offer||input.envelopeTo!==thread.replyAddress||input.from!==thread.peer||!thread.latestMessageId||input.inReplyTo!==thread.latestMessageId)return;
  const allowed=new Set([owner,thread.peer,config.address,thread.replyAddress!]);
  if([...input.to,...input.cc].some(address=>!allowed.has(address)))return;
  if(this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE thread=?',thread.id)[0].n>=12){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
  thread.lastInbound=input.messageId;
  if(thread.offer.expiresAt<=Date.now()){await this.offer(thread,await this.core(owner).refreshScheduling(owner,thread.requestId!),inboxId);return;}
  const choice=parseSchedulingChoice(input.text,thread.offer);
  if(choice.kind==='clarify'){
   // The cached email offer may predate a policy change, source expiry or an
   // assessment performed through another channel. Read eligibility before
   // repeating times; an existing review decision needs no model rerun.
   const current=await this.core(owner).getScheduling(owner,thread.requestId!);
   const result=!current.requiresReview&&!current.offer&&['pending_approval','needs_new_slot'].includes(current.status)?await this.core(owner).refreshScheduling(owner,thread.requestId!):current;
   await this.offer(thread,result,inboxId,true);return;
  }
  if(choice.kind==='refresh'){await this.offer(thread,await this.core(owner).refreshScheduling(owner,thread.requestId!),inboxId);return;}
  const slot=thread.offer.slots.find(value=>value.id===choice.slotId)!;
  thread.selection={revision:thread.offer.revision,slotId:slot.id,evidenceId:input.messageId,start:slot.start,end:slot.end};
  thread.status='confirming';thread.capabilityHash=null;thread.attempts=0;this.save(thread);
  await this.ctx.storage.setAlarm(Date.now()+30000);
  await this.confirm(thread,inboxId);
 }
 private groupText(thread:Conversation,result:SchedulingResult,clarify=false):string {
  return `Finding a time for ${[thread.owner,...thread.guests!].join(', ')}. Please reply all with your preferred option. I’ll book once every guest agrees on the same time.\n\n${schedulingOfferText(result,clarify)}`;
 }
 private groupMessage(thread:Conversation,text:string):Outgoing {
  return {...this.outgoing(thread,text,false),replyTo:thread.groupReply!.replyAddress};
 }
 private async ensureGroupReply(thread:Conversation){
  if(thread.groupReply)return;
  const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');
  thread.groupReply={hash:await digest(token),replyAddress:`scheduling+${token}@${this.config(thread.owner).replyDomain}`,messageIds:[]};
  thread.capabilityHash=thread.groupReply.hash;thread.replyAddress=thread.groupReply.replyAddress;
 }
 private async groupOffer(thread:Conversation,result:SchedulingResult,key:string,clarify:boolean){
  const outboxId=key+':offer:'+(result.offer?.revision??'none');
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_outbox WHERE id=?',outboxId+':group').length)return;
  const same=thread.status==='offered'&&thread.offer?.revision===result.offer?.revision&&thread.participants?.length===thread.guests!.length;
  if(!same){
   thread.participants=result.offer?thread.guests!.map(email=>({email,hash:'',replyAddress:'',messageIds:[]})):undefined;
   thread.groupReply=undefined;
  }
  thread.offer=result.offer;thread.timezone=result.timezone;thread.status=result.offer?'offered':'closed';thread.selection=undefined;thread.attempts=0;
  thread.capabilityHash=null;thread.replyAddress=null;thread.latestMessageId=null;thread.contextCapability=null;thread.pendingContext=undefined;thread.contextReviewReason=undefined;
  if(result.offer){await this.ensureGroupReply(thread);thread.capabilityHash=thread.groupReply!.hash;thread.replyAddress=thread.groupReply!.replyAddress;}
  this.ctx.storage.transactionSync(()=>{
   this.save(thread);
   // A same-offer migration may have unsent private guest copies from a restart.
   // Retain delivered legacy capabilities, but send only the shared conversation.
   this.cancelPrivateCopies(thread);
   this.queue(outboxId+':group',thread.id,result.offer?this.groupMessage(thread,this.groupText(thread,result,clarify)):this.outgoing(thread,schedulingOfferText(result),false));
  });
 }
 private async groupParticipant(thread:Conversation,inboxId:string,input:SchedulingInboundEmail,hash:string){
  const shared=thread.groupReply?.hash===hash;
  const participant=thread.participants?.find(value=>shared?value.email===input.from:value.hash===hash),config=this.config(thread.owner);
  if(!participant||thread.status!=='offered'||!thread.offer||input.from!==participant.email||!input.inReplyTo)return;
  if(shared){
   if(input.authenticatedSender!==participant.email||input.envelopeTo!==thread.groupReply!.replyAddress)return;
   const parents=thread.groupReply!.messageIds;
   if(!parents.includes(input.inReplyTo)&&!input.references.some(id=>parents.includes(id)))return;
  }else if(input.envelopeTo!==participant.replyAddress||!participant.messageIds.includes(input.inReplyTo))return;
  const allowed=new Set([thread.owner,...(shared?thread.guests!:[participant.email]),config.address,shared?thread.groupReply!.replyAddress:participant.replyAddress]);
  if([...input.to,...input.cc].some(address=>!allowed.has(address)))return;
  if(this.rows<{n:number}>('SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE thread=?',thread.id)[0].n>=80){thread.status='needs_attention';thread.participants=undefined;thread.groupReply=undefined;this.save(thread);return;}
  const order=this.rows<{sequence:number}>('SELECT rowid AS sequence FROM scheduling_email_inbox WHERE id=?',inboxId)[0]?.sequence;
  if(!order||order<(participant.latestInboundOrder??0))return;
  const choice=parseSchedulingChoice(input.text,thread.offer);
  if(order>(participant.latestInboundOrder??0)){
   participant.latestInboundOrder=order;
   this.ctx.storage.sql.exec("UPDATE scheduling_email_inbox SET status='ignored' WHERE status='auth_failed' AND rowid<? AND json_extract(data,'$.from')=? AND json_extract(data,'$.envelopeTo')=?",order,participant.email,thread.groupReply?.replyAddress??'');
   // A newer choice or ambiguous reply withdraws previous agreement immediately,
   // before an availability read can fail or be retried out of arrival order.
   participant.choice=undefined;
   this.save(thread);
  }
  thread.lastInbound=input.messageId;
  if(shared)thread.groupReply!.messageIds=this.rememberParent(thread.groupReply!.messageIds,input.messageId);
  if(thread.offer.expiresAt<=Date.now()){await this.offer(thread,await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId!),inboxId);return;}
  if(choice.kind==='refresh'){await this.offer(thread,await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId!),inboxId);return;}
  // The owner's approval and policy may have changed since options were sent.
  const current=await this.core(thread.owner).getScheduling(thread.owner,thread.requestId!);
  if(current.requiresReview||current.needsContext||!current.offer||current.offer.revision!==thread.offer.revision||!['pending_approval','needs_new_slot'].includes(current.status)){
   await this.offer(thread,current,inboxId);return;
  }
  if(choice.kind==='clarify'){
   await this.ensureGroupReply(thread);
   this.ctx.storage.transactionSync(()=>{
    this.cancelPrivateCopies(thread);this.save(thread);this.queue(inboxId+':clarify',thread.id,this.groupMessage(thread,this.groupText(thread,current,true)));
   });return;
  }
  participant.choice={slotId:choice.slotId,evidenceId:input.messageId};
  const pendingIdentity=this.rows<{sequence:number;data:string}>("SELECT rowid AS sequence,data FROM scheduling_email_inbox WHERE status IN ('awaiting_auth','auth_failed')").some(row=>{const reply=JSON.parse(row.data) as SchedulingInboundEmail;return reply.envelopeTo===thread.groupReply?.replyAddress&&thread.participants!.some(guest=>guest.email===reply.from&&row.sequence>(guest.latestInboundOrder??0));});
  const agreed=!pendingIdentity&&thread.participants!.every(value=>value.choice?.slotId===choice.slotId);
  if(agreed){
   const slot=thread.offer.slots.find(value=>value.id===choice.slotId)!;
   thread.selection={revision:thread.offer.revision,slotId:slot.id,evidenceId:input.messageId,start:slot.start,end:slot.end};
   thread.status='confirming';thread.attempts=0;this.save(thread);
   await this.ctx.storage.setAlarm(Date.now()+30000);await this.confirm(thread,inboxId);return;
  }
  const waiting=thread.participants!.filter(value=>!value.choice).map(value=>value.email);
  const choices=thread.participants!.filter(value=>value.choice).map(value=>`${value.email}: Option ${thread.offer!.slots.findIndex(slot=>slot.id===value.choice!.slotId)+1}`).join('\n');
  const status=pendingIdentity?'A recent reply still needs sender verification. Please wait, or reply again with your preferred option.':waiting.length?`Waiting for ${waiting.join(', ')} to choose a time.`:'You chose different options. Please choose the same option so I can book for everyone.';
  const text=`${choices}\n\n${status} Nothing is booked yet.\n\n${this.groupText(thread,current)}`;
  await this.ensureGroupReply(thread);
  this.ctx.storage.transactionSync(()=>{
   this.cancelPrivateCopies(thread);this.save(thread);
   this.queue(inboxId+':waiting',thread.id,this.groupMessage(thread,text));
  });
 }
 private cancelPrivateCopies(thread:Conversation){this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready' AND json_extract(data,'$.replyTo') IS NOT NULL AND json_extract(data,'$.replyTo')!=?",thread.id,thread.groupReply?.replyAddress??'');}
 private rememberParent(ids:string[],id:string){const unique=[...new Set([...ids,id])];return unique.length>30?[unique[0],...unique.slice(-29)]:unique;}
 private async assessContext(thread:Conversation){
  if(!thread.pendingContext||!thread.requestId)return;
  try{
   const {context,evidenceId,key}=thread.pendingContext;
   const result=await this.core(thread.owner).addSchedulingContext(thread.owner,thread.requestId,{context,evidenceId});
   await this.offer(thread,result,key);
  }catch{
   // Reload after a failed transaction so a rolled-back offer cannot erase the
   // frozen reply. The core deduplicates this evidence even after a timeout.
   const current=this.thread(thread.id);if(!current||current.status!=='assessing_context'||!current.pendingContext)return;
   // The owner may have approved while this RPC was interrupted, so the same
   // evidence can now be refused even though the request is resolved. Recover
   // that authoritative result before turning a transport failure into review.
   try{
    const result=await this.core(current.owner).getScheduling(current.owner,current.requestId!);
    if(this.resolvedContextResult(result)){await this.offer({...current},result,current.pendingContext.key);return;}
   }catch{/* Retain the frozen reply if either the read or queue write fails. */}
   current.attempts++;
   if(current.attempts>=3)this.contextReview(current,'I could not reassess the conversation after receiving more context. Please review the request before offering times.');
   else this.save(current);
  }
 }
 private resolvedContextResult(result:SchedulingResult):boolean{
  if(terminalSchedulingStatuses.has(result.status))return true;
  if(result.requiresReview!==false||result.needsContext!==false)return false;
  if(result.status==='needs_new_slot'&&result.offer===null)return true;
  return ['pending_approval','needs_new_slot'].includes(result.status)&&!!result.offer?.slots.length&&result.offer.expiresAt>Date.now();
 }
 private contextReview(thread:Conversation,reason:string,result?:SchedulingResult){
  thread.contextReviewReason=reason;
  this.review(thread,result??{requestId:thread.requestId!,status:'pending_approval',timezone:thread.timezone,offer:null,replyText:'',recommendation:{summary:reason,reasons:[reason],uncertainties:[]},requiresReview:true,needsContext:false,contextQuestion:null},reason);
 }
 private async askContext(thread:Conversation,result:SchedulingResult){
  if(thread.contextReviewReason){this.contextReview(thread,thread.contextReviewReason,result);return;}
  if(thread.status==='awaiting_context'&&thread.contextCapability&&thread.contextCapability.expiresAt>Date.now()&&!thread.pendingContext)return;
  if((thread.contextRounds??0)>=2){this.contextReview(thread,'The conversation still needs your review after two requests for context.',result);return;}
  const round=(thread.contextRounds??0)+1,outboxId=thread.id+':context:'+round;
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_outbox WHERE id=?',outboxId).length)return;
  const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');
  thread.contextCapability={hash:await digest(token),replyAddress:`scheduling+${token}@${this.config(thread.owner).replyDomain}`,expiresAt:Date.now()+2*86400000,messageId:null};
  thread.contextRounds=round;thread.status='awaiting_context';thread.offer=null;thread.capabilityHash=null;thread.replyAddress=null;thread.latestMessageId=null;thread.selection=undefined;thread.pendingContext=undefined;thread.attempts=0;
  this.ctx.storage.transactionSync(()=>{
   this.save(thread);
   this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready' AND json_extract(data,'$.replyTo') IS NOT NULL",thread.id);
   // This public question is intentionally fixed; model diagnostics, policy,
   // private relationship evidence and scores never enter counterpart mail.
   this.queue(outboxId,thread.id,{...this.outgoing(thread,schedulingContextQuestion,false),replyTo:thread.contextCapability!.replyAddress});
  });
 }
 private async confirm(thread:Conversation,key:string){
  if(!thread.selection||!thread.requestId)return;
  try{
   const {revision,slotId,evidenceId}=thread.selection;
   const result=await this.core(thread.owner).confirmScheduling(thread.owner,thread.requestId,{revision,slotId,evidenceId},{channel:'owner_email',evidenceId});
   await this.reconciled(thread,result,key);
  }catch(error){
   if(error instanceof Error&&error.message==='request_closed'){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
   if(error instanceof Error&&/^(?:offer_changed|offer_expired|settings_changed|assessment_required)$/.test(error.message)){
    await this.offer(thread,await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId),key);return;
   }
   // The booking service may have persisted an intent before transport failed.
   // Retain the same selection and evidence for its stable event reconciliation.
   // A failed receipt transaction may have rolled back a tentative booked
   // state. Recover the persisted confirming selection, never save that draft.
   const current=this.thread(thread.id)??thread;
   current.attempts++;if(current.attempts>=8)current.status='needs_attention';this.save(current);
  }
 }
 private async reconciled(thread:Conversation,result:SchedulingResult,key:string){
  if(result.status==='booked'){
   thread.status='booked';thread.capabilityHash=null;thread.participants=undefined;thread.groupReply=undefined;
   const selected=thread.selection;if(!selected)return;
   this.ctx.storage.transactionSync(()=>{
    this.save(thread);
    this.queue(thread.id+':booked',thread.id,this.outgoing(thread,`The meeting is booked for ${schedulingSlotText(selected.start,selected.end,thread.timezone)}. Please see the calendar invitation.`,false));
   });return;
  }
  if(result.status==='booking'){thread.status='confirming';thread.attempts++;if(thread.attempts>=8)thread.status='needs_attention';this.save(thread);return;}
  if(result.needsContext===true&&['pending_approval','needs_new_slot'].includes(result.status)){await this.offer(thread,result,key);return;}
  if(result.requiresReview===true){this.review(thread,result);return;}
  if(result.status==='needs_new_slot'||result.status==='pending_approval'){
   await this.offer(thread,result.offer?result:await this.core(thread.owner).refreshScheduling(thread.owner,thread.requestId!),key);return;
  }
  thread.status='closed';thread.capabilityHash=null;this.save(thread);
 }
 private async offer(thread:Conversation,result:SchedulingResult,key:string,clarify=false){
  if(terminalSchedulingStatuses.has(result.status)){
   thread.status='closed';thread.offer=null;thread.capabilityHash=null;thread.replyAddress=null;thread.latestMessageId=null;thread.contextCapability=null;thread.pendingContext=undefined;thread.contextReviewReason=undefined;thread.selection=undefined;thread.participants=undefined;thread.groupReply=undefined;thread.attempts=0;
   this.ctx.storage.transactionSync(()=>{
    this.save(thread);
    this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready'",thread.id);
   });return;
  }
  // A refresh/prepare result contains no proof that its booking is our exact
  // selected revision and slot. Another channel may have reserved a different
  // time while the refresh was in flight. Only confirm() may acknowledge it.
  if(result.status==='booking'||result.status==='booked'){thread.status='needs_attention';thread.capabilityHash=null;this.save(thread);return;}
  if(result.needsContext===true&&['pending_approval','needs_new_slot'].includes(result.status)){
   if((thread.guests?.length??1)>1){this.review(thread,result);return;}
   await this.askContext(thread,result);return;
  }
  if(result.requiresReview===true){this.review(thread,result);return;}
  if((thread.guests?.length??1)>1){await this.groupOffer(thread,result,key,clarify);return;}
  const outboxId=key+':offer:'+(result.offer?.revision??'none');
  if(this.rows<{id:string}>('SELECT id FROM scheduling_email_outbox WHERE id=?',outboxId).length)return;
  thread.offer=result.offer;thread.timezone=result.timezone;thread.status=result.offer?'offered':'closed';thread.selection=undefined;thread.attempts=0;
  thread.latestMessageId=null;thread.capabilityHash=null;thread.replyAddress=null;
  thread.contextCapability=null;thread.pendingContext=undefined;thread.contextReviewReason=undefined;
  if(result.offer){const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');thread.capabilityHash=await digest(token);thread.replyAddress=`scheduling+${token}@${this.config(thread.owner).replyDomain}`;}
  this.ctx.storage.transactionSync(()=>{
   this.save(thread);
   this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready' AND json_extract(data,'$.replyTo') IS NOT NULL",thread.id);
   this.queue(outboxId,thread.id,this.outgoing(thread,schedulingOfferText(result,clarify),true));
  });
 }
 private review(thread:Conversation,result:SchedulingResult,contextReason?:string){
  const config=this.config(thread.owner),url=new URL('/booking',this.env.APP_ORIGIN);url.searchParams.set('request',thread.requestId!);
  if(url.protocol!=='https:')throw Error('scheduling_email_invalid_origin');
  thread.status='awaiting_review';thread.offer=null;thread.capabilityHash=null;thread.replyAddress=null;thread.latestMessageId=null;thread.selection=undefined;thread.participants=undefined;thread.groupReply=undefined;thread.attempts=0;
  thread.contextCapability=null;thread.pendingContext=undefined;
  const reasons=[...(contextReason?[contextReason]:[]),...((thread.guests?.length??1)>1?['Please approve offering times to this group. The current relationship assessment covers the first guest.']:[]),...(result.decision?.reasons??[]),...(result.decision?.uncertainties??[])].filter(value=>typeof value==='string').slice(0,8).map(value=>value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,600));
  const text=`The meeting request with ${(thread.guests??[thread.peer]).join(', ')} needs your review before I offer times.\n\n${reasons.length?reasons.map(reason=>'• '+reason).join('\n'):'There is not enough confirmed context to offer times automatically.'}\n\nReview the request in Booking and choose “Offer times anyway” if you want to proceed:\n${url.href}`;
  this.ctx.storage.transactionSync(()=>{
   this.save(thread);
   this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready' AND json_extract(data,'$.replyTo') IS NOT NULL",thread.id);
   this.queue(thread.id+':review:'+(contextReason?'context':result.decision?.policyRevision??'unknown'),thread.id,{from:config.address,to:[thread.owner],cc:[],subject:'Meeting request needs your review',text,headers:{'In-Reply-To':thread.kickoffMessageId,'References':thread.kickoffMessageId,'Auto-Submitted':'auto-replied'}});
  });
 }
 async resumeApproved(owner:string,requestId:string):Promise<{status:string}>{return this.serial(async()=>{
  if(schedulingAddress(this.env.BOOKING_OWNER_EMAIL??'')!==owner)throw Error('wrong_owner');
  const matches=this.rows<{data:string}>("SELECT data FROM scheduling_email_threads WHERE json_extract(data,'$.requestId')=? LIMIT 2",requestId);
  if(!matches.length)return {status:'not_found'};if(matches.length!==1)throw Error('invalid_scheduling_email_request');
  const thread=JSON.parse(matches[0].data) as Conversation;if(thread.owner!==owner)throw Error('wrong_owner');
  this.config(owner);
  const result=await this.core(owner).getScheduling(owner,requestId);
  // An explicit approval supersedes the pending reply, while an unfinished
  // assessment must retain its evidence for the alarm's idempotent retry.
  if(thread.status==='assessing_context'&&!this.resolvedContextResult(result))return {status:thread.status};
  // Approval has already been authenticated and persisted in BookingCoordinator.
  // A read may still require review after a policy change; never bypass it here.
  if(result.requiresReview===true&&result.needsContext!==true){this.review(thread,result);await this.flush(owner);return {status:'awaiting_review'};}
  // No availability also closes the email exchange. The core remains the
  // authority on whether fresh eligible times can reopen that conversation.
  const availableAgain=thread.status==='closed'&&['pending_approval','needs_new_slot'].includes(result.status)&&!!result.offer;
  if(['confirming','booked','needs_attention'].includes(thread.status)||thread.status==='closed'&&!availableAgain)return {status:thread.status};
  const groupExisting=thread.status==='offered'&&thread.offer?.revision===result.offer?.revision&&thread.participants?.length&&thread.groupReply;
  const existing=groupExisting?[{status:'group'}]:thread.status==='offered'&&(thread.guests?.length??1)===1&&thread.offer?.revision===result.offer?.revision&&thread.replyAddress
   ?this.rows<{status:string}>("SELECT status FROM scheduling_email_outbox WHERE thread=? AND json_extract(data,'$.replyTo')=?",thread.id,thread.replyAddress):[];
  if(!existing.length)await this.offer(thread,result,thread.id+':approved');
  // Do not send a review notice left queued by a restart after approval.
  if(thread.status==='offered')this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='cancelled' WHERE thread=? AND status='ready' AND json_extract(data,'$.replyTo') IS NULL",thread.id);
  await this.ctx.storage.setAlarm(Date.now()+30000);await this.flush(owner);
  const replyAddress=thread.contextCapability?.replyAddress??thread.replyAddress;
  if(thread.participants?.some(participant=>this.rows<{id:string}>("SELECT id FROM scheduling_email_outbox WHERE thread=? AND status='unknown' AND json_extract(data,'$.replyTo')=?",thread.id,participant.replyAddress).length))throw Error('scheduling_email_delivery_unknown');
  if(replyAddress&&this.rows<{id:string}>("SELECT id FROM scheduling_email_outbox WHERE thread=? AND status='unknown' AND json_extract(data,'$.replyTo')=?",thread.id,replyAddress).length)throw Error('scheduling_email_delivery_unknown');
  return {status:this.thread(thread.id)?.status??thread.status};
 });}
 private subject(value:string){return 'Re: '+value.replace(/^(?:re:\s*)+/i,'').replace(/[\r\n\x00-\x1f\x7f]/g,'').slice(0,150);}
 private outgoing(thread:Conversation,text:string,reply:boolean):Outgoing {
  const config=this.config(thread.owner),references=[thread.kickoffMessageId,thread.lastInbound].filter((id,i,ids)=>ids.indexOf(id)===i).join(' ');
  return {from:config.address,to:thread.guests??[thread.peer],cc:[thread.owner],subject:this.subject(thread.subject),text,...(reply&&thread.replyAddress?{replyTo:thread.replyAddress}:{}),headers:{'In-Reply-To':thread.lastInbound,'References':references,'Auto-Submitted':'auto-replied'}};
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
    this.ctx.storage.transactionSync(()=>{
     this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='sent',message_id=? WHERE id=?",messageId,row.id);
     const thread=this.thread(row.thread);if(thread&&thread.status==='offered'&&message.replyTo===thread.replyAddress&&message.to.includes(thread.peer)){thread.latestMessageId=messageId;this.save(thread);}
     if(thread?.status==='offered'&&thread.groupReply&&message.replyTo===thread.groupReply.replyAddress&&message.to.length===thread.guests?.length&&thread.guests.every(guest=>message.to.includes(guest))){
      thread.groupReply.messageIds=this.rememberParent(thread.groupReply.messageIds,messageId);this.save(thread);
     }
     const participant=thread?.status==='offered'?thread.participants?.find(value=>value.replyAddress===message.replyTo&&message.to.length===1&&message.to[0]===value.email):undefined;
     if(thread&&participant){
      const ids=[...new Set([...participant.messageIds,messageId])];
      participant.messageIds=ids.length>20?[ids[0],...ids.slice(-19)]:ids;this.save(thread);
     }
     if(thread?.status==='awaiting_context'&&thread.contextCapability&&message.replyTo===thread.contextCapability.replyAddress&&message.to.includes(thread.peer)){thread.contextCapability.messageId=messageId;this.save(thread);}
    });
   }catch{this.ctx.storage.sql.exec("UPDATE scheduling_email_outbox SET status='unknown' WHERE id=?",row.id);}
  }
 }
 async alarm():Promise<void>{return this.serial(async()=>{
  const config=schedulingEmailConfiguration(this.env);if(!config)return;
  await this.retrySenderVerification(config.owner);
  for(const row of this.rows<InboxRow>("SELECT id,data,attempts FROM scheduling_email_inbox WHERE status='queued' ORDER BY received LIMIT 5"))await this.process(config.owner,row);
  for(const row of this.rows<{data:string}>("SELECT data FROM scheduling_email_threads WHERE json_extract(data,'$.status')='assessing_context' LIMIT 5"))await this.assessContext(JSON.parse(row.data) as Conversation);
  for(const row of this.rows<{data:string}>("SELECT data FROM scheduling_email_threads WHERE json_extract(data,'$.status')='confirming' LIMIT 5")){
   const thread=JSON.parse(row.data) as Conversation;
   try{
    // This checks the persisted revision/slot even if another channel has
    // already booked. A generic booked status cannot confirm our selected time.
    await this.confirm(thread,thread.id+':reconcile');
   }catch{thread.attempts++;if(thread.attempts>=8)thread.status='needs_attention';this.save(thread);}
  }
  await this.flush(config.owner);
  const pending=this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE status IN ('queued','awaiting_auth')")[0].n+this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status') IN ('confirming','assessing_context')")[0].n+this.rows<{n:number}>("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='ready'")[0].n;
  if(pending)await this.ctx.storage.setAlarm(Date.now()+60000);
 });}
 async diagnostics(owner:string):Promise<{pending:number;deliveryUnknown:number;needsAttention:number}>{return this.serial(async()=>{
  if(schedulingAddress(this.env.BOOKING_OWNER_EMAIL??'')!==owner)throw Error('wrong_owner');
  const count=(sql:string)=>this.rows<{n:number}>(sql)[0].n;
  return {pending:count("SELECT COUNT(*) AS n FROM scheduling_email_inbox WHERE status IN ('queued','awaiting_auth')")+count("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='ready'")+count("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status') IN ('confirming','assessing_context')"),deliveryUnknown:count("SELECT COUNT(*) AS n FROM scheduling_email_outbox WHERE status='unknown'"),needsAttention:count("SELECT COUNT(*) AS n FROM scheduling_email_threads WHERE json_extract(data,'$.status')='needs_attention'")+count("SELECT COUNT(*) AS n FROM scheduling_email_threads t WHERE json_extract(t.data,'$.status')='offered' AND EXISTS(SELECT 1 FROM scheduling_email_inbox i WHERE i.status='auth_failed' AND json_extract(i.data,'$.envelopeTo')=json_extract(t.data,'$.groupReply.replyAddress'))")};
 });}
}
