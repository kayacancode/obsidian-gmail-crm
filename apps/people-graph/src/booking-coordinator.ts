import {DurableObject} from 'cloudflare:workers';
import type {BookingEnv,BookingRequestRecord,BookingCalendarRecord,BookingReadiness,BookingSettings} from './booking-types';
import {BookingStore} from './booking-store';
import {defaultBookingSettings,validateBookingSettings,validateBookingSubmission,decideBooking,generateBookingSlots} from './booking-policy';
import {lookupBookingPerson} from './booking-people';
import {assessBookingFit} from './booking-fit';
import {bookingCalendarBusy,bookingEventId,findBookingEvent,createBookingEvent,cancelBookingEvent,sendBookingNotice} from './booking-providers';

export async function bookingReadiness(env:BookingEnv,owner:string):Promise<BookingReadiness>{
 const calendar=!!await new BookingStore(env.DB).calendar(owner);
 const email=!!(env.BOOKING_EMAIL&&env.BOOKING_EMAIL_FROM&&env.BOOKING_EMAIL_READY==='true');
 const pilot=env.BOOKING_OWNER_EMAIL?.toLowerCase()===owner;
 const people=!!(env.PEOPLEGRAPH_HOST&&env.PEOPLEGRAPH_TOKEN&&env.PEOPLEGRAPH_OWNER_EMAIL?.toLowerCase()===owner);
 return {email,calendar,people,pilot,issues:[...(!pilot?['Booking is not enabled for this account yet.']:[]),...(!email?[`Verify ${env.BOOKING_EMAIL_FROM||'your booking sender'} before visitors can receive email codes.`]:[]),...(!calendar?['Connect Google Calendar to check and reserve times.']:[]),...(!people?['Your Rust PeopleGraph source is not connected. Requests will need your review.']:[])]};
}
export function publicBookingRequest(r:BookingRequestRecord){return {id:r.id,status:r.status,slotStart:r.slotStart,slotEnd:r.slotEnd};}

/** One coordinator per owner. Every mutation uses the same queue; durable request
 * status/event IDs survive a restart, including uncertain Calendar writes. */
export class BookingCoordinator extends DurableObject<BookingEnv>{
 private tail:Promise<unknown>=Promise.resolve();
 private store:BookingStore;
 constructor(ctx:DurableObjectState,env:BookingEnv){
  super(ctx,env);this.store=new BookingStore(env.DB);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_identity(owner TEXT PRIMARY KEY)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_outbox(id TEXT PRIMARY KEY,email TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_reconcile(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_notice_sent(id TEXT PRIMARY KEY)');
 }
 private serial<T>(owner:string,fn:()=>Promise<T>):Promise<T>{
  const run=this.tail.then(async()=>{
   const identity=this.ctx.storage.sql.exec<{owner:string}>('SELECT owner FROM booking_identity LIMIT 1').toArray()[0];
   if(identity&&identity.owner!==owner)throw Error('wrong_owner');
   if(!identity)this.ctx.storage.sql.exec('INSERT INTO booking_identity(owner) VALUES(?)',owner);
   await this.store.init();return fn();
  });this.tail=run.catch(()=>{});return run;
 }
 async saveSettings(owner:string,input:unknown){return this.serial(owner,async()=>{
  const current=await this.store.settings(owner)||defaultBookingSettings(owner);
  if(!input||typeof input!=='object'||(input as Record<string,unknown>).revision!==current.revision)throw Error('settings_changed');
  const settings=validateBookingSettings(input,current);
  if(settings.enabled){const ready=await bookingReadiness(this.env,owner);if(!ready.pilot||!ready.email||!ready.calendar)throw Error('setup_required');}
  await this.store.saveSettings(settings,current.revision);return settings;
 });}
 async saveCalendar(owner:string,record:BookingCalendarRecord){return this.serial(owner,async()=>{if(record.owner!==owner||record.email!==owner)throw Error('wrong_owner');await this.store.saveCalendar(record);});}
 async disconnectCalendar(owner:string){return this.serial(owner,async()=>{
  if((await this.store.reservations(owner)).some(r=>['booking','cancelling'].includes(r.status)))throw Error('booking_in_progress');
  await this.store.deleteCalendar(owner);
  const s=await this.store.settings(owner);if(s)await this.store.saveSettings({...s,enabled:false,revision:s.revision+1},s.revision);
 });}
 async submit(owner:string,email:string,slug:string,input:Record<string,unknown>){return this.serial(owner,async()=>{
  const settings=await this.active(owner,slug);
  if(typeof input.idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey))throw Error('invalid_request_key');
  const previous=await this.store.prior(owner,email,input.idempotencyKey);if(previous)return previous;
  await this.store.limit(`submit:${owner}:${email}`,5,86400000);
  const submission=validateBookingSubmission(input),[fit,people]=await Promise.all([assessBookingFit(this.env,settings,submission),lookupBookingPerson(this.env,owner,email)]);
  const decision=decideBooking(settings,email,fit,people),now=Date.now();
  const {vipEmails,...snapshot}=settings;
  const record:BookingRequestRecord={...submission,id:crypto.randomUUID(),owner,email,createdAt:now,updatedAt:now,status:decision.tier==='async'?'async_submitted':'pending_approval',decision,slotStart:null,slotEnd:null,eventId:null,idempotencyKey:input.idempotencyKey};
  record.policySnapshot={...snapshot,vipMatch:vipEmails.includes(email)};
  await this.store.add(record);
  if(record.status==='async_submitted')await this.notice(owner,record.id+':submitted','New submission in People Booking','Someone shared their project. Review it in '+this.origin()+'/booking');
  return record;
 });}
 async slots(owner:string,email:string,slug:string,id:string){return this.serial(owner,async()=>{
  const s=await this.active(owner,slug),r=await this.required(owner,id);if(r.email!==email)throw Error('not_found');
  if(!['pending_approval','needs_new_slot'].includes(r.status))throw Error('request_closed');
  await this.store.limit(`slots:${owner}:${email}`,30,3600000);
  return this.available(s,r);
 });}
 async selectSlot(owner:string,email:string,slug:string,id:string,start:string){return this.serial(owner,async()=>{
  const settings=await this.active(owner,slug),r=await this.required(owner,id);if(r.email!==email)throw Error('not_found');
  if(['booked','booking','cancelling'].includes(r.status))return r;
  if(!['pending_approval','needs_new_slot'].includes(r.status))throw Error('request_closed');
  if(r.status==='pending_approval'&&r.slotStart===start)return r;
  await this.store.limit(`select:${owner}:${email}`,10,86400000);
  if(!Number.isFinite(Date.parse(start)))throw Error('invalid_request');
  const slot=(await this.available(settings,r,start)).find(s=>s.start===start);if(!slot)throw Error('slot_unavailable');
  r.slotStart=slot.start;r.slotEnd=slot.end;r.status='pending_approval';r.updatedAt=Date.now();
  await this.store.update(r);
  // A policy change always falls back to approval; it never upgrades an old decision.
  if(settings.autoBookPriority&&r.decision.tier==='priority'&&settings.revision===r.decision.policyRevision){
   // Recheck source at selection, so cached tier cannot outlive source availability.
   const people=await lookupBookingPerson(this.env,owner,email);
   const checked=decideBooking(settings,email,r.decision.fit,people);
   r.initialDecision=r.initialDecision||r.decision;r.decision=checked;await this.store.update(r);
   if(checked.tier==='priority')return this.book(settings,r);
   if(!(await this.available(settings,r,start)).some(s=>s.start===start&&s.end===r.slotEnd)){
    r.status='needs_new_slot';await this.store.update(r);return r;
   }
  }
  await this.notice(owner,r.id+':review','Booking request to review','A visitor requested a time. Approve or decline in '+this.origin()+'/booking');
  return r;
 });}
 async act(owner:string,id:string,action:'approve'|'decline'|'cancel'){return this.serial(owner,async()=>{
  const r=await this.required(owner,id),s=await this.store.settings(owner);if(!s)throw Error('not_found');
  if(action==='approve'){
   if(r.status==='booked')return r;
   if(r.status==='booking')return this.book(s,r);
   if(!['pending_approval','needs_new_slot'].includes(r.status)||!r.slotStart)throw Error('no_pending_slot');
   const available=await this.available(s,r,r.slotStart);
   if(!available.some(v=>v.start===r.slotStart&&v.end===r.slotEnd)){r.status='needs_new_slot';r.updatedAt=Date.now();await this.store.update(r);await this.notice(r.email,r.id+':newslot','Please choose another time','That time is no longer available. Open '+this.origin()+'/book/'+s.slug+' and verify your email to choose another time.');return r;}
   return this.book(s,r);
  }
  if(action==='decline'){
   if(r.status==='declined')return r;
   if(['booking','booked','cancelling','cancelled'].includes(r.status))throw Error('request_closed');
   r.status='declined';
  }else{
   return this.cancel(r);
  }
  r.updatedAt=Date.now();await this.store.update(r);
  await this.notice(r.email,r.id+':'+r.status,r.status==='declined'?'An update on your meeting request':'Your meeting was cancelled',r.status==='declined'?'Thanks for sharing your work. A meeting is not possible right now. Your submission has been received.':'Your meeting has been cancelled.');return r;
 });}
 private async cancel(r:BookingRequestRecord){
  if(r.status==='cancelled')return r;
  if(!['booking','booked','cancelling'].includes(r.status)||!r.eventId)throw Error('request_closed');
  const calendar=await this.store.calendar(r.owner);if(!calendar)throw Error('calendar_unavailable');
  // Unknown insert outcome must be resolved before deletion, but a known
  // cancellation can safely retry DELETE after a lost response or eviction.
  if(r.status==='booking'&&!await findBookingEvent(this.env,calendar,r.eventId))throw Error('booking_in_progress');
  r.status='cancelling';r.updatedAt=Date.now();await this.store.update(r);
  this.ctx.storage.sql.exec('INSERT OR IGNORE INTO booking_reconcile(id) VALUES(?)',r.id);
  await this.ctx.storage.setAlarm(Date.now()+60000);
  try{await cancelBookingEvent(this.env,calendar,r.eventId);}catch{throw Error('booking_in_progress');}
  r.status='cancelled';r.updatedAt=Date.now();await this.store.update(r);
  this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',r.id);
  await this.notice(r.email,r.id+':cancelled','Your meeting was cancelled','Your meeting has been cancelled.');return r;
 }
 private async active(owner:string,slug:string){const s=await this.store.settings(owner);const ready=await bookingReadiness(this.env,owner);if(!s||s.slug!==slug||!s.enabled||!ready.email||!ready.calendar||!ready.pilot)throw Error('booking_unavailable');return s;}
 private async required(owner:string,id:string){const r=await this.store.request(owner,id);if(!r)throw Error('not_found');return r;}
 private async available(s:BookingSettings,r:BookingRequestRecord,targetStart?:string){
  const calendar=await this.store.calendar(s.owner);if(!calendar)throw Error('calendar_unavailable');
  const now=Date.now(),busy=await bookingCalendarBusy(this.env,calendar,new Date(now).toISOString(),new Date(now+(s.horizonDays+1)*86400000).toISOString());
  // Review delay starts when the visitor applies, not again whenever the owner
  // opens the request. Minimum notice still moves with the actual current time.
  const earliest=Math.max(r.decision.tier==='review'?r.createdAt+s.reviewDelayDays*86400000:0,targetStart?Date.parse(targetStart):0);
  return generateBookingSlots({...s,minNoticeHours:Math.max(s.minNoticeHours,(earliest-now)/3600000)},r.decision.tier==='async'?'async':'priority',busy,(await this.store.reservations(s.owner)).filter(v=>v.id!==r.id),now);
 }
 private async book(s:BookingSettings,r:BookingRequestRecord){
  const calendar=await this.store.calendar(s.owner);if(!calendar)throw Error('calendar_unavailable');
  if(!r.slotStart||!r.slotEnd)throw Error('no_pending_slot');
  if(r.status==='booking'&&r.eventId){
   const event=await findBookingEvent(this.env,calendar,r.eventId);
   if(event){r.status='booked';r.updatedAt=Date.now();await this.store.update(r);this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',r.id);return r;}
   // Keep the reservation on an uncertain write; retry only the same event ID.
   const busy=await bookingCalendarBusy(this.env,calendar,new Date(Date.parse(r.slotStart)-s.bufferMinutes*60000).toISOString(),new Date(Date.parse(r.slotEnd)+s.bufferMinutes*60000).toISOString());
   if(busy.length)throw Error('booking_in_progress');
   if(Date.parse(r.slotStart)<Date.now()+s.minNoticeHours*3600000)throw Error('booking_in_progress');
   s={...s,durationMinutes:(Date.parse(r.slotEnd)-Date.parse(r.slotStart))/60000};
  }else if(!(await this.available(s,r,r.slotStart)).some(slot=>slot.start===r.slotStart&&slot.end===r.slotEnd)){
   r.status='needs_new_slot';r.updatedAt=Date.now();return this.store.update(r);
  }
  r.status='booking';r.eventId=r.eventId||await bookingEventId(r.id);r.updatedAt=Date.now();
  await this.store.update(r);
  this.ctx.storage.sql.exec('INSERT OR IGNORE INTO booking_reconcile(id) VALUES(?)',r.id);
  await this.ctx.storage.setAlarm(Date.now()+60000);
  try{await createBookingEvent(this.env,calendar,r,s);}catch{throw Error('booking_in_progress');}
  r.status='booked';r.updatedAt=Date.now();await this.store.update(r);
  this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',r.id);
  await this.notice(s.owner,r.id+':booked','Meeting booked in People','A meeting has been added to your Calendar. View details in '+this.origin()+'/booking');return r;
 }
 private origin(){return this.env.APP_ORIGIN||'https://people-graph.kayarjones901.workers.dev';}
 private async notice(email:string,id:string,subject:string,body:string){
  if(this.ctx.storage.sql.exec('SELECT id FROM booking_notice_sent WHERE id=?',id).toArray().length)return;
  this.ctx.storage.sql.exec('INSERT OR IGNORE INTO booking_outbox(id,email,subject,body) VALUES(?,?,?,?)',id,email,subject,body);
  await this.ctx.storage.setAlarm(Date.now()+1000);
 }
 async alarm(){
  const owner=this.ctx.storage.sql.exec<{owner:string}>('SELECT owner FROM booking_identity LIMIT 1').toArray()[0]?.owner;if(!owner)return;
  await this.serial(owner,async()=>{
   const pending=this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM booking_reconcile WHERE attempts<8 LIMIT 3').toArray();
   const settings=await this.store.settings(owner);
   for(const item of pending){
    const r=await this.store.request(owner,item.id);
    if(!r||!['booking','cancelling'].includes(r.status)){this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',item.id);continue;}
    this.ctx.storage.sql.exec('UPDATE booking_reconcile SET attempts=attempts+1 WHERE id=?',item.id);
    if(settings)try{if(r.status==='cancelling')await this.cancel(r);else await this.book(settings,r);}catch{}
   }
   const rows=this.ctx.storage.sql.exec<{id:string;email:string;subject:string;body:string;attempts:number}>('SELECT * FROM booking_outbox WHERE attempts<8 LIMIT 10').toArray();
   for(const row of rows){try{await sendBookingNotice(this.env,row.email,row.subject,row.body);this.ctx.storage.sql.exec('INSERT OR IGNORE INTO booking_notice_sent(id) VALUES(?)',row.id);this.ctx.storage.sql.exec('DELETE FROM booking_outbox WHERE id=?',row.id);}catch{this.ctx.storage.sql.exec('UPDATE booking_outbox SET attempts=attempts+1 WHERE id=?',row.id);}}
   if(this.ctx.storage.sql.exec('SELECT id FROM booking_outbox WHERE attempts<8 UNION ALL SELECT id FROM booking_reconcile WHERE attempts<8 LIMIT 1').toArray().length)await this.ctx.storage.setAlarm(Date.now()+300000);
  });
 }
}
