import type {BookingEnv,BookingRequestRecord,BookingSettings} from './booking-types';
import type {BookingEmailApprovals} from './booking-email-approvals';
import type {BookingStore} from './booking-store';
import {normalizeBookingEmail} from './booking-policy';
import {bookingNotificationKey,bookingRequestEmail} from './booking-notifications';

function configuration(env:BookingEnv,owner:string){
 try{
  const from=normalizeBookingEmail(env.SCHEDULING_EMAIL_ADDRESS),origin=new URL(env.APP_ORIGIN||'');
  if(normalizeBookingEmail(env.BOOKING_OWNER_EMAIL)!==owner||!env.SCHEDULING_EMAIL_SEND||origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return null;
  return {from,origin:origin.origin};
 }catch{return null;}
}

/** Separate from the retired verification-email outbox. Only public time
 * requests explicitly queued by the current coordinator can produce mail. */
export class BookingNotificationOutbox {
 constructor(private sql:SqlStorage,private env:BookingEnv,private approvals?:BookingEmailApprovals){
  sql.exec(`CREATE TABLE IF NOT EXISTS booking_request_notifications(
   id TEXT PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL,
   attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
   message_id TEXT)`);
  // Sending may have succeeded before eviction. Without provider idempotency,
  // never resend an ambiguous write automatically.
  sql.exec("UPDATE booking_request_notifications SET status='unknown' WHERE status='sending'");
 }
 queue(r:BookingRequestRecord){
  const id=bookingNotificationKey(r);if(!id)return;
  this.sql.exec(`INSERT INTO booking_request_notifications(id,request_id,status,next_attempt) VALUES(?,?,'ready',?)
   ON CONFLICT(id) DO UPDATE SET status='ready',next_attempt=excluded.next_attempt,attempts=0 WHERE status='cancelled'`,id,r.id,Date.now());
 }
 resend(r:BookingRequestRecord){
  const key=bookingNotificationKey(r);if(!key)throw Error('no_pending_slot');
  this.approvals?.renew(key);
  this.sql.exec('DELETE FROM booking_request_notifications WHERE id=?',key);this.queue(r);
 }
 nextAttempt():number|null{return this.sql.exec<{at:number|null}>("SELECT MIN(next_attempt) AS at FROM booking_request_notifications WHERE status='ready'").toArray()[0]?.at??null;}
 status(owner:string){
  const counts=Object.fromEntries(this.sql.exec<{status:string;n:number}>('SELECT status,COUNT(*) AS n FROM booking_request_notifications GROUP BY status').toArray().map(row=>[row.status,row.n]));
  return {configured:!!configuration(this.env,owner),recipient:owner,pending:(counts.ready??0)+(counts.sending??0),failed:counts.failed??0,deliveryUnknown:counts.unknown??0};
 }
 async flush(owner:string,store:BookingStore,settings:BookingSettings|null){
  for(const row of this.sql.exec<{id:string;request_id:string;attempts:number}>("SELECT id,request_id,attempts FROM booking_request_notifications WHERE status='ready' AND next_attempt<=? ORDER BY next_attempt LIMIT 5",Date.now()).toArray()){
   const r=await store.request(owner,row.request_id);
   // Approval, cancellation, a new selection or a failed D1 write can make
   // the queued intent obsolete. Do not email an outdated approval request.
   if(!r||r.owner!==owner||bookingNotificationKey(r)!==row.id){this.setStatus(row.id,'cancelled');continue;}
   const config=configuration(this.env,owner);
   if(!config||!settings){this.retry(row.id,row.attempts);continue;}
   let message;
   try{message=bookingRequestEmail(r,settings,{...config,replyTo:this.approvals?.replyTo(r)});}catch{this.setStatus(row.id,'failed');continue;}
   if(!message){this.setStatus(row.id,'cancelled');continue;}
   this.setStatus(row.id,'sending');
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const result=await Promise.race([this.env.SCHEDULING_EMAIL_SEND!.send(message),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('email_delivery_unknown')),15000);})]);
    if(!result?.messageId)throw Error('email_delivery_unknown');
    this.sql.exec("UPDATE booking_request_notifications SET status='sent',message_id=? WHERE id=?",result.messageId,row.id);
    this.approvals?.delivered(message.replyTo,result.messageId);
   }catch(error){
    const code=error&&typeof error==='object'&&'code' in error?error.code:'';
    // These explicit rejections establish that the service did not accept the
    // message. Network errors and ambiguous server errors are not replayed.
    if(code==='E_RATE_LIMIT_EXCEEDED'||code==='E_DAILY_LIMIT_EXCEEDED')this.retry(row.id,row.attempts,code==='E_DAILY_LIMIT_EXCEEDED'?86400000:undefined);
    else if(typeof code==='string'&&/^E_(?:VALIDATION_ERROR|FIELD_MISSING|TOO_MANY_RECIPIENTS|SENDER_NOT_VERIFIED|RECIPIENT_NOT_ALLOWED|RECIPIENT_SUPPRESSED|SENDER_DOMAIN_NOT_AVAILABLE|CONTENT_TOO_LARGE|HEADER_.*|HEADERS_.*)$/.test(code))this.setStatus(row.id,'failed');
    else this.setStatus(row.id,'unknown');
   }finally{if(timer!==undefined)clearTimeout(timer);}
  }
 }
 private setStatus(id:string,status:string){this.sql.exec('UPDATE booking_request_notifications SET status=? WHERE id=?',status,id);}
 private retry(id:string,attempts:number,delay?:number){
  this.sql.exec('UPDATE booking_request_notifications SET status=?,attempts=?,next_attempt=? WHERE id=?',attempts>=7?'failed':'ready',attempts+1,Date.now()+(delay??Math.min(3600000,60000*2**attempts)),id);
 }
}
