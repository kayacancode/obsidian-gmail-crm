import type {BookingEnv,BookingRequestRecord} from './booking-types';
import {bookingNotificationKey} from './booking-notifications';
import {parseBookingApproval} from './booking-approval-policy';
import {schedulingAddress,schedulingMessageId,type SchedulingInboundEmail} from './scheduling-email-policy';
import {digest} from './mail-model';

export interface BookingApprovalSnapshot {key:string;requestId:string;expires:number;name:string;subject:string;slots:{start:string;end:string}[]}
export type BookingEmailAction={kind:'approve';index:number}|{kind:'decline'};
type Capability={address:string;data:string;action:string|null};
type Job={id:string;address:string;message_id:string;attempts:number};
const expiryMs=7*86400000;

/** Owner-only replies, frozen before Calendar I/O. Lives in the same DO as all
 * booking mutations so UI changes cannot race the final selection check. */
export class BookingEmailApprovals {
 constructor(private sql:SqlStorage,private env:BookingEnv){
  for(const statement of [
   'CREATE TABLE IF NOT EXISTS booking_approval_capabilities(address TEXT PRIMARY KEY,notification_key TEXT UNIQUE,data TEXT NOT NULL,action TEXT)',
   'CREATE TABLE IF NOT EXISTS booking_approval_messages(address TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(address,message_id))',
   'CREATE TABLE IF NOT EXISTS booking_approval_inbox(id TEXT PRIMARY KEY,address TEXT NOT NULL,message_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL)',
   'CREATE TABLE IF NOT EXISTS booking_approval_receipts(id TEXT PRIMARY KEY,address TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL)'
  ])sql.exec(statement);
  sql.exec("UPDATE booking_approval_receipts SET status='unknown' WHERE status='sending'");
 }
 private rows<T extends Record<string,SqlStorageValue>>(sql:string,...args:SqlStorageValue[]){return this.sql.exec<T>(sql,...args).toArray();}
 replyTo(r:BookingRequestRecord):string|undefined{
  const key=bookingNotificationKey(r);if(!key||!this.env.SCHEDULING_EMAIL_REPLY_DOMAIN)return;
  let domain:string;try{domain=this.env.SCHEDULING_EMAIL_REPLY_DOMAIN.toLowerCase();if(schedulingAddress('scheduling@'+domain)!==schedulingAddress(this.env.SCHEDULING_EMAIL_ADDRESS||''))return;}catch{return;}
  const found=this.rows<{address:string}>('SELECT address FROM booking_approval_capabilities WHERE notification_key=?',key)[0];if(found)return found.address;
  const token=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');
  const address=`scheduling+b${token}@${domain}`;
  const data:BookingApprovalSnapshot={key,requestId:r.id,expires:Date.now()+expiryMs,name:r.name,subject:'Meeting request: '+r.name,slots:r.proposedTimes?.slots??[{start:r.slotStart!,end:r.slotEnd!}]};
  this.sql.exec('INSERT INTO booking_approval_capabilities(address,notification_key,data) VALUES(?,?,?)',address,key,JSON.stringify(data));return address;
 }
 renew(key:string){
  const address=this.rows<{address:string}>('SELECT address FROM booking_approval_capabilities WHERE notification_key=?',key)[0]?.address;
  if(address){this.sql.exec('DELETE FROM booking_approval_capabilities WHERE address=?',address);this.sql.exec('DELETE FROM booking_approval_messages WHERE address=?',address);}
 }
 delivered(address:string|undefined,messageId:string){
  if(!address)return;
  try{const id=schedulingMessageId(messageId.startsWith('<')?messageId:'<'+messageId+'>');this.sql.exec('INSERT OR IGNORE INTO booking_approval_messages(address,message_id) VALUES(?,?)',address,id);}catch{/* Unknown provider ID cannot authorize a reply. Dashboard remains available. */}
 }
 async enqueue(owner:string,input:SchedulingInboundEmail){
  if(owner!==this.env.BOOKING_OWNER_EMAIL?.toLowerCase()||input.from!==owner)return {status:'ignored'};
  schedulingMessageId(input.messageId);schedulingAddress(input.envelopeTo);
  const cap=this.rows<Capability>('SELECT address,data,action FROM booking_approval_capabilities WHERE address=?',input.envelopeTo)[0];if(!cap)return {status:'ignored'};
  const id=await digest(input.envelopeTo+'\0'+input.messageId);if(this.rows('SELECT id FROM booking_approval_inbox WHERE id=?',id).length)return {status:'duplicate'};
  if((this.rows<{n:number}>('SELECT COUNT(*) AS n FROM booking_approval_inbox WHERE next_attempt>?',Date.now()-86400000)[0]?.n??0)>=200)throw Error('booking_reply_rate_limited');
  this.sql.exec("INSERT INTO booking_approval_inbox(id,address,message_id,status,next_attempt) VALUES(?,?,?,'queued',?)",id,input.envelopeTo,input.messageId,Date.now());return {status:'accepted'};
 }
 nextAttempt():number|null{return this.rows<{at:number|null}>("SELECT MIN(at) AS at FROM (SELECT MIN(next_attempt) AS at FROM booking_approval_inbox WHERE status='queued' UNION ALL SELECT MIN(next_attempt) AS at FROM booking_approval_receipts WHERE status='ready')")[0]?.at??null;}
 async process(owner:string,execute:(snapshot:BookingApprovalSnapshot,action:BookingEmailAction)=>Promise<string>){
  for(const job of this.rows<Job>("SELECT id,address,message_id,attempts FROM booking_approval_inbox WHERE status='queued' AND next_attempt<=? ORDER BY next_attempt LIMIT 5",Date.now())){
   const cap=this.rows<Capability>('SELECT address,data,action FROM booking_approval_capabilities WHERE address=?',job.address)[0];if(!cap){this.done(job.id);continue;}
   const snapshot=JSON.parse(cap.data) as BookingApprovalSnapshot;
   try{
    if(owner!==this.env.BOOKING_OWNER_EMAIL?.toLowerCase())throw Error('invalid_owner_reply');
    let frozen=cap.action?JSON.parse(cap.action) as {id:string;choice:BookingEmailAction}:null;
    if(!frozen||frozen.id!==job.id){
     const mail=this.env.MAIL.getByName(owner);await mail.bindOwner(owner);
     const canonical=await mail.verifyBookingApproval(job.message_id,job.address);
     if(canonical.owner!==owner||canonical.from!==owner||canonical.messageId!==job.message_id||!canonical.to.concat(canonical.cc).includes(job.address)||canonical.to.concat(canonical.cc).some(address=>address!==owner&&address!==job.address)||!canonical.inReplyTo||!this.rows('SELECT message_id FROM booking_approval_messages WHERE address=? AND message_id=?',job.address,canonical.inReplyTo).length)throw Error('invalid_owner_reply');
     if(frozen){this.receipt(owner,job,snapshot,'This request has already been handled. Open the request to see its current status.');continue;}
     if(snapshot.expires<=Date.now()){this.receipt(owner,job,snapshot,'This email approval has expired. Open the request to review the current time.');continue;}
     const choice=parseBookingApproval(canonical.text,snapshot.slots.length);
     if(choice.kind==='clarify'){this.receipt(owner,job,snapshot,snapshot.slots.length===1?'Please reply with just Approve or Decline. Nothing has been booked.':'Please reply with Approve 1, Approve 2'+(snapshot.slots.length===3?', Approve 3':'')+', or Decline. Nothing has been booked.',true);continue;}
     frozen={id:job.id,choice};this.sql.exec('UPDATE booking_approval_capabilities SET action=? WHERE address=?',JSON.stringify(frozen),job.address);
    }
    this.receipt(owner,job,snapshot,await execute(snapshot,frozen.choice));
   }catch(error){
    const message=error instanceof Error?error.message:'';
    if(/invalid_|grant_revoked|mail_not_connected|body_consent_required/.test(message)){this.done(job.id);continue;}
    if(job.attempts>=7){
     // A frozen action proves owner authority. Unverified inbound mail never
     // creates backscatter or exposes request details.
     if(JSON.parse(this.rows<{action:string|null}>('SELECT action FROM booking_approval_capabilities WHERE address=?',job.address)[0]?.action??'null')?.id===job.id)this.receipt(owner,job,snapshot,'I could not confirm this action yet. Please open the request to check its status before trying again.');
     else this.done(job.id);
    }else this.sql.exec('UPDATE booking_approval_inbox SET attempts=attempts+1,next_attempt=? WHERE id=?',Date.now()+Math.min(900000,30000*2**job.attempts),job.id);
   }
  }
 }
 private done(id:string){this.sql.exec("UPDATE booking_approval_inbox SET status='done' WHERE id=?",id);}
 private receipt(owner:string,job:Job,snapshot:BookingApprovalSnapshot,result:string,reply=false){
  const url=new URL('/booking',this.env.APP_ORIGIN);url.searchParams.set('request',snapshot.requestId);
  const text=`${result}\n\nRequest: ${snapshot.name.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,150)}\n\nReview request: ${url.href}`;
  const html='<p>'+text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)).replace(/\n/g,'<br>')+'</p>';
  const message={from:this.env.SCHEDULING_EMAIL_ADDRESS,to:owner,subject:('Re: '+snapshot.subject).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180),text,html,...(reply?{replyTo:job.address}:{}),headers:{'In-Reply-To':job.message_id,'References':job.message_id,'Auto-Submitted':'auto-replied'}};
  this.sql.exec("INSERT OR IGNORE INTO booking_approval_receipts(id,address,data,status,next_attempt) VALUES(?,?,?,'ready',?)",job.id,job.address,JSON.stringify(message),Date.now());this.done(job.id);
 }
 async flush(){
  for(const row of this.rows<{id:string;address:string;data:string;attempts:number}>("SELECT id,address,data,attempts FROM booking_approval_receipts WHERE status='ready' AND next_attempt<=? ORDER BY next_attempt LIMIT 5",Date.now())){
   if(!this.env.SCHEDULING_EMAIL_SEND)continue;
   const message=JSON.parse(row.data);if(message.to!==this.env.BOOKING_OWNER_EMAIL?.toLowerCase()){this.sql.exec("UPDATE booking_approval_receipts SET status='cancelled' WHERE id=?",row.id);continue;}
   this.sql.exec("UPDATE booking_approval_receipts SET status='sending' WHERE id=?",row.id);
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const result=await Promise.race([this.env.SCHEDULING_EMAIL_SEND.send(message),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('email_delivery_unknown')),15000);})]);
    if(!result?.messageId)throw Error('email_delivery_unknown');
    if(message.replyTo)this.delivered(row.address,result.messageId);
    this.sql.exec("UPDATE booking_approval_receipts SET status='sent' WHERE id=?",row.id);
   }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?error.code:'';
    if((code==='E_RATE_LIMIT_EXCEEDED'||code==='E_DAILY_LIMIT_EXCEEDED')&&row.attempts<7)this.sql.exec("UPDATE booking_approval_receipts SET status='ready',attempts=attempts+1,next_attempt=? WHERE id=?",Date.now()+(code==='E_DAILY_LIMIT_EXCEEDED'?86400000:60000*2**row.attempts),row.id);
    else this.sql.exec("UPDATE booking_approval_receipts SET status='unknown' WHERE id=?",row.id);
   }finally{if(timer!==undefined)clearTimeout(timer);}
  }
 }
}
