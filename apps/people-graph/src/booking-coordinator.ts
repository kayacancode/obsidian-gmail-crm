import {DurableObject} from 'cloudflare:workers';
import type {BookingEnv,BookingRequestRecord,BookingCalendarRecord,BookingReadiness,BookingSettings,BookingVisitorIdentity,BookingSubmission,BookingDecision,BookingSlot} from './booking-types';
import {BookingStore} from './booking-store';
import {defaultBookingSettings,validateBookingSettings,validateBookingSubmission,validateReturningBookingNote,decideBooking,generateBookingSlots,normalizeBookingEmail,parseBookingProposals,suggestedBookingSlotAvailable} from './booking-policy';
import {lookupBookingPerson} from './booking-people';
import {getReturningBookingContact} from './booking-returning';
import {assessBookingFit} from './booking-fit';
import {bookingCalendarBusy,bookingEventId,findBookingEvent,createBookingEvent,cancelBookingEvent} from './booking-providers';
import type {SchedulingAuthority,SchedulingConfirmation,SchedulingInput,SchedulingResult} from './scheduling-types';
import {validateSchedulingInput,validateSchedulingAuthority,validateSchedulingConfirmation,schedulingWindow,schedulingOffer,schedulingResult} from './scheduling-policy';
import {schedulingRecommendation} from './scheduling-context';

export async function bookingReadiness(env:BookingEnv,owner:string):Promise<BookingReadiness>{
 const calendar=!!await new BookingStore(env.DB).calendar(owner);
 const signIn=[env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,env.MAIL_TOKEN_KEY,env.TOKEN_SECRET].every(value=>typeof value==='string'&&!!value.trim());
 const pilot=env.BOOKING_OWNER_EMAIL?.toLowerCase()===owner;
 const people=!!(env.PEOPLEGRAPH_HOST&&env.PEOPLEGRAPH_TOKEN&&env.PEOPLEGRAPH_OWNER_EMAIL?.toLowerCase()===owner);
 return {signIn,calendar,people,pilot,issues:[...(!pilot?['Booking is not enabled for this account yet.']:[]),...(!signIn?['Configure Google sign-in before visitors can request a meeting.']:[]),...(!calendar?['Connect Google Calendar to check and reserve times.']:[]),...(!people?['Your Rust PeopleGraph source is not connected. Requests will need your review.']:[])]};
}
export function publicBookingRequest(r:BookingRequestRecord){return {id:r.id,status:r.status,slotStart:r.slotStart,slotEnd:r.slotEnd,intakeKind:r.intakeKind==='returning'?'returning':'standard',...(r.proposedTimes?{proposedTimes:{timezone:r.proposedTimes.timezone,revision:r.proposedTimes.revision,slots:r.proposedTimes.slots.map(slot=>({start:slot.start,end:slot.end}))}}:{}),...(r.slotSource?{slotSource:r.slotSource}:{})};}
const uncertainEmail=()=>({status:'unavailable' as const,reason:'Google has not established authority over this email address. The owner must review this request.'});
function verifiedVisitor(visitor:BookingVisitorIdentity):BookingVisitorIdentity{
 if(!visitor||typeof visitor.subject!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(visitor.subject)||typeof visitor.emailAuthoritative!=='boolean')throw Error('verification_required');
 return {email:normalizeBookingEmail(visitor.email),subject:visitor.subject,emailAuthoritative:visitor.emailAuthoritative};
}

/** One coordinator per owner. Every mutation uses the same queue; durable request
 * status/event IDs survive a restart, including uncertain Calendar writes. */
export class BookingCoordinator extends DurableObject<BookingEnv>{
 private tail:Promise<unknown>=Promise.resolve();
 private store:BookingStore;
 constructor(ctx:DurableObjectState,env:BookingEnv){
  super(ctx,env);this.store=new BookingStore(env.DB);
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_identity(owner TEXT PRIMARY KEY)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS booking_reconcile(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0)');
  // Legacy email outbox/history tables remain untouched and inert. Old alarms
  // may wake once, but only Calendar reconciliation can schedule another alarm.
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
  if(settings.enabled){const ready=await bookingReadiness(this.env,owner);if(!ready.pilot||!ready.signIn||!ready.calendar)throw Error('setup_required');}
  await this.store.saveSettings(settings,current.revision);return settings;
 });}
 async saveCalendar(owner:string,record:BookingCalendarRecord){return this.serial(owner,async()=>{if(record.owner!==owner||record.email!==owner)throw Error('wrong_owner');await this.store.saveCalendar(record);});}
 async disconnectCalendar(owner:string){return this.serial(owner,async()=>{
  if((await this.store.reservations(owner)).some(r=>['booking','cancelling'].includes(r.status)))throw Error('booking_in_progress');
  await this.store.deleteCalendar(owner);
  const s=await this.store.settings(owner);if(s)await this.store.saveSettings({...s,enabled:false,revision:s.revision+1},s.revision);
 });}
 async prepareScheduling(owner:string,input:SchedulingInput,authority:SchedulingAuthority):Promise<SchedulingResult>{return this.serial(owner,async()=>{
  const verified=validateSchedulingAuthority(authority),valid=validateSchedulingInput(input);
  if(valid.email===owner)throw Error('invalid_email');
  const key='scheduling:'+verified.channel+':'+valid.idempotencyKey;
  const previous=await this.store.prior(owner,valid.email,key);
  if(previous){
   if(!previous.scheduling||JSON.stringify(previous.scheduling.input)!==JSON.stringify(valid)||JSON.stringify(previous.scheduling.authority)!==JSON.stringify(verified))throw Error('idempotency_conflict');
   return schedulingResult(previous,(await this.store.settings(owner))?.revision);
  }
  const settings=await this.schedulingSettings(owner),now=Date.now(),window=schedulingWindow(valid,settings,now);
  await this.store.limit(`scheduling:prepare:${owner}`,50,86400000);
  const recommendation=await schedulingRecommendation(this.env,owner,valid.email,now,valid.instructions);
  const record:BookingRequestRecord={id:crypto.randomUUID(),owner,email:valid.email,name:valid.name||valid.email,project:'',purpose:'Owner-authorized meeting.',projectUrl:'',referrer:'',createdAt:now,updatedAt:now,status:'pending_approval',slotStart:null,slotEnd:null,eventId:null,idempotencyKey:key,
   decision:{tier:'review',reasons:['The owner explicitly authorized this scheduling request.'],uncertainties:[],fit:{fit:'uncertain',reasons:['Public intake classification does not apply to owner-authorized scheduling.'],evidence:[],model:'not_assessed'},people:{status:'unavailable',reason:'Private scheduling context is stored separately.'},policyRevision:settings.revision},
   scheduling:{authority:verified,input:valid,timezone:valid.timezone||settings.timezone,settingsRevision:settings.revision,...window,offer:null,recommendation}};
  await this.replaceSchedulingOffer(settings,record);
  await this.store.add(record);return schedulingResult(record,settings.revision);
 });}
 async refreshScheduling(owner:string,id:string):Promise<SchedulingResult>{return this.serial(owner,async()=>{
  const r=await this.requiredScheduling(owner,id);
  if(!['pending_approval','needs_new_slot'].includes(r.status))return schedulingResult(r);
  const s=await this.schedulingSettings(owner);await this.store.limit(`scheduling:refresh:${owner}`,100,3600000);
  r.scheduling!.recommendation=await schedulingRecommendation(this.env,owner,r.email,Date.now(),r.scheduling!.input.instructions);
  await this.replaceSchedulingOffer(s,r);await this.store.update(r);return schedulingResult(r,s.revision);
 });}
 async confirmScheduling(owner:string,id:string,input:SchedulingConfirmation):Promise<SchedulingResult>{return this.serial(owner,async()=>{
  const confirmation=validateSchedulingConfirmation(input),r=await this.requiredScheduling(owner,id),saved=r.scheduling!;
  if(['booked','booking'].includes(r.status)){
   if(saved.confirmation?.revision!==confirmation.revision||saved.confirmation?.slotId!==confirmation.slotId)throw Error('request_closed');
   if(r.status==='booked')return schedulingResult(r);
   const s=await this.store.settings(owner);if(!s)throw Error('booking_unavailable');
   return this.finishScheduling(s,r);
  }
  if(!['pending_approval','needs_new_slot'].includes(r.status))throw Error('request_closed');
  const s=await this.schedulingSettings(owner);
  if(saved.settingsRevision!==s.revision)throw Error('settings_changed');
  if(!saved.offer||saved.offer.revision!==confirmation.revision)throw Error('offer_changed');
  if(saved.offer.expiresAt<=Date.now())throw Error('offer_expired');
  const slot=saved.offer.slots.find(value=>value.id===confirmation.slotId);if(!slot)throw Error('offer_changed');
  if(!(await this.available(s,r,slot.start)).some(value=>value.start===slot.start&&value.end===slot.end)){
   r.status='needs_new_slot';saved.offer=null;r.updatedAt=Date.now();await this.store.update(r);return schedulingResult(r,s.revision);
  }
  r.slotStart=slot.start;r.slotEnd=slot.end;r.slotSource='offered';saved.confirmation=confirmation;r.updatedAt=Date.now();
  await this.store.update(r);return this.finishScheduling(s,r);
 });}
 async getScheduling(owner:string,id:string):Promise<SchedulingResult>{return this.serial(owner,async()=>{
  const r=await this.requiredScheduling(owner,id);return schedulingResult(r,(await this.store.settings(owner))?.revision);
 });}
 private async schedulingSettings(owner:string){
  const s=await this.store.settings(owner),ready=await bookingReadiness(this.env,owner);
  if(!s||!s.enabled||!ready.pilot||!ready.signIn||!ready.calendar)throw Error('booking_unavailable');return s;
 }
 private async requiredScheduling(owner:string,id:string){const r=await this.required(owner,id);if(!r.scheduling)throw Error('not_found');return r;}
 private async replaceSchedulingOffer(s:BookingSettings,r:BookingRequestRecord){
  const saved=r.scheduling!;saved.settingsRevision=s.revision;
  saved.offer=schedulingOffer(await this.available(s,r),saved.timezone);
  delete saved.confirmation;r.slotStart=null;r.slotEnd=null;delete r.slotSource;r.updatedAt=Date.now();
  r.status=saved.offer?'pending_approval':'needs_new_slot';
 }
 private async finishScheduling(s:BookingSettings,r:BookingRequestRecord):Promise<SchedulingResult>{
  try{await this.book(s,r);}catch(error){
   // A lost write or a later lookup outage cannot release its durable reservation.
   // Read storage so failures before persisting booking do not look successful.
   const saved=await this.requiredScheduling(r.owner,r.id);
   if(saved.status!=='booking'||!saved.eventId)throw error;
   return schedulingResult(saved,s.revision);
  }
  if(r.status==='needs_new_slot')r.scheduling!.offer=null;
  await this.store.update(r);return schedulingResult(r,s.revision);
 }
 async submit(owner:string,identity:BookingVisitorIdentity,slug:string,input:Record<string,unknown>){return this.serial(owner,async()=>{
  const visitor=verifiedVisitor(identity),email=visitor.email;
  const settings=await this.active(owner,slug);
  if(typeof input.idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey))throw Error('invalid_request_key');
  const previous=await this.store.prior(owner,email,input.idempotencyKey);if(previous){this.assertVisitor(previous,visitor);return previous;}
  await this.store.limit(`submit:${owner}:${email}`,5,86400000);
  const intakeKind=input.kind==='returning'?'returning':'standard';
  let submission:BookingSubmission,decision:BookingDecision;
  if(intakeKind==='returning'){
   const contact=await getReturningBookingContact(this.env,settings,visitor);if(!contact)throw Error('intake_required');
   submission={name:contact.name,project:'',purpose:validateReturningBookingNote(input.note),projectUrl:'',referrer:''};
   // Relationship recognition skips questions; it establishes neither thesis fit nor approval.
   decision={tier:'review',reasons:['This returning contact skipped the intake questionnaire; owner approval is still required.'],uncertainties:['Thesis fit was not assessed because the intake questionnaire was skipped.'],fit:{fit:'uncertain',reasons:['The optional catch-up note has not been assessed for thesis fit.'],evidence:[],model:'not_assessed'},people:{status:'matched',name:contact.name,email:contact.email,score:contact.score,lastSync:contact.lastSync,reason:'The verified email exactly matches a fresh My Network contact.'},policyRevision:settings.revision};
  }else{
   submission=validateBookingSubmission(input);
   const [fit,people]=await Promise.all([assessBookingFit(this.env,settings,submission),visitor.emailAuthoritative?lookupBookingPerson(this.env,owner,email):Promise.resolve(uncertainEmail())]);
   decision=decideBooking(settings,email,fit,people);
  }
  const now=Date.now();
  const {vipEmails,...snapshot}=settings;
  const record:BookingRequestRecord={...submission,id:crypto.randomUUID(),owner,email,visitorSubject:visitor.subject,emailAuthoritative:visitor.emailAuthoritative,intakeKind,createdAt:now,updatedAt:now,status:decision.tier==='async'?'async_submitted':'pending_approval',decision,slotStart:null,slotEnd:null,eventId:null,idempotencyKey:input.idempotencyKey};
  record.policySnapshot={...snapshot,vipMatch:visitor.emailAuthoritative&&vipEmails.includes(email)};
  await this.store.add(record);
  return record;
 });}
 async slots(owner:string,identity:BookingVisitorIdentity,slug:string,id:string){return this.serial(owner,async()=>{
  const visitor=verifiedVisitor(identity),email=visitor.email;
  const s=await this.active(owner,slug),r=await this.required(owner,id);this.assertVisitor(r,visitor);
  if(!['pending_approval','needs_new_slot'].includes(r.status))throw Error('request_closed');
  await this.reviewUncertainIdentity(s,r,visitor);
  await this.store.limit(`slots:${owner}:${email}`,30,3600000);
  return this.available(s,r);
 });}
 async selectSlot(owner:string,identity:BookingVisitorIdentity,slug:string,id:string,start:string){return this.serial(owner,async()=>{
  const visitor=verifiedVisitor(identity),email=visitor.email;
  const settings=await this.active(owner,slug),r=await this.required(owner,id);this.assertVisitor(r,visitor);
  if(['booked','booking','cancelling'].includes(r.status))return r;
  if(!['pending_approval','needs_new_slot'].includes(r.status))throw Error('request_closed');
  await this.reviewUncertainIdentity(settings,r,visitor);
  if(r.status==='pending_approval'&&r.slotStart===start&&!r.proposedTimes&&r.slotSource!=='suggested')return r;
  await this.store.limit(`select:${owner}:${email}`,10,86400000);
  if(!Number.isFinite(Date.parse(start)))throw Error('invalid_request');
  const slot=(await this.available(settings,r,start)).find(s=>s.start===start);if(!slot)throw Error('slot_unavailable');
  r.slotStart=slot.start;r.slotEnd=slot.end;r.status='pending_approval';r.slotSource='offered';delete r.proposedTimes;r.updatedAt=Date.now();
  await this.store.update(r);
  // A policy change always falls back to approval; it never upgrades an old decision.
  if(visitor.emailAuthoritative&&r.emailAuthoritative===true&&settings.autoBookPriority&&r.decision.tier==='priority'&&settings.revision===r.decision.policyRevision){
   // Recheck source at selection, so cached tier cannot outlive source availability.
   const people=await lookupBookingPerson(this.env,owner,email);
   const checked=decideBooking(settings,email,r.decision.fit,people);
   r.initialDecision=r.initialDecision||r.decision;r.decision=checked;await this.store.update(r);
   if(checked.tier==='priority')return this.book(settings,r);
   if(!(await this.available(settings,r,start)).some(s=>s.start===start&&s.end===r.slotEnd)){
    r.status='needs_new_slot';await this.store.update(r);return r;
   }
  }
  return r;
 });}
 async proposeTimes(owner:string,identity:BookingVisitorIdentity,slug:string,id:string,input:unknown){return this.serial(owner,async()=>{
  const visitor=verifiedVisitor(identity),s=await this.active(owner,slug),r=await this.required(owner,id);this.assertVisitor(r,visitor);
  this.assertMutable(r);await this.reviewUncertainIdentity(s,r,visitor);
  const proposed=parseBookingProposals(input,s.durationMinutes);
  if(r.proposedTimes?.timezone===proposed.timezone&&JSON.stringify(r.proposedTimes.slots)===JSON.stringify(proposed.slots))return r;
  await this.store.limit(`proposals:${owner}:${visitor.email}`,10,86400000);
  if(proposed.slots.some(slot=>!suggestedBookingSlotAvailable(s,r,slot,[],[])))throw Error('invalid_proposal_time');
  r.proposedTimes={...proposed,revision:crypto.randomUUID()};r.slotSource='suggested';r.slotStart=null;r.slotEnd=null;r.status='pending_approval';r.updatedAt=Date.now();
  await this.store.update(r);return r;
 });}
 async approveProposal(owner:string,id:string,start:string,revision:string){return this.serial(owner,async()=>{
  const r=await this.required(owner,id),s=await this.store.settings(owner);if(!s)throw Error('not_found');
  const slot=r.proposedTimes?.slots.find(value=>value.start===start);
  if(!slot||r.proposedTimes?.revision!==revision)throw Error('proposal_changed');
  if(['booking','booked'].includes(r.status)){
   if(r.slotSource!=='suggested'||r.slotStart!==slot.start||r.slotEnd!==slot.end)throw Error('request_closed');
   return r.status==='booked'?r:this.book(s,r);
  }
  this.assertMutable(r);
  if(!await this.suggestedAvailable(s,r,slot)){r.status='needs_new_slot';r.slotStart=null;r.slotEnd=null;r.updatedAt=Date.now();await this.store.update(r);return r;}
  r.slotStart=slot.start;r.slotEnd=slot.end;r.slotSource='suggested';r.updatedAt=Date.now();await this.store.update(r);
  return this.book(s,r);
 });}
 async requestTimes(owner:string,id:string){return this.serial(owner,async()=>{
  const r=await this.required(owner,id);this.assertMutable(r);
  if(r.scheduling){r.scheduling.offer=null;delete r.scheduling.confirmation;}
  r.status='needs_new_slot';r.slotStart=null;r.slotEnd=null;delete r.proposedTimes;delete r.slotSource;r.updatedAt=Date.now();await this.store.update(r);return r;
 });}
 private assertMutable(r:BookingRequestRecord){if(!['pending_approval','needs_new_slot'].includes(r.status)||r.decision.tier==='async')throw Error('request_closed');}
 private async suggestedAvailable(s:BookingSettings,r:BookingRequestRecord,slot:BookingSlot){
  if(!suggestedBookingSlotAvailable(s,r,slot,[],[]))return false;
  const calendar=await this.store.calendar(s.owner);if(!calendar)throw Error('calendar_unavailable');
  const busy=await bookingCalendarBusy(this.env,calendar,new Date(Date.parse(slot.start)-s.bufferMinutes*60000).toISOString(),new Date(Date.parse(slot.end)+s.bufferMinutes*60000).toISOString());
  return suggestedBookingSlotAvailable(s,r,slot,busy,await this.store.reservations(s.owner));
 }
 async act(owner:string,id:string,action:'approve'|'decline'|'cancel'){return this.serial(owner,async()=>{
  const r=await this.required(owner,id),s=await this.store.settings(owner);if(!s)throw Error('not_found');
  if(action==='approve'){
   if(r.status==='booked')return r;
   if(r.status==='booking')return this.book(s,r);
   if(r.scheduling)throw Error('request_closed');
   if(r.proposedTimes||r.slotSource==='suggested')throw Error('proposal_changed');
   if(!['pending_approval','needs_new_slot'].includes(r.status)||!r.slotStart)throw Error('no_pending_slot');
   const available=await this.available(s,r,r.slotStart);
   if(!available.some(v=>v.start===r.slotStart&&v.end===r.slotEnd)){r.status='needs_new_slot';r.updatedAt=Date.now();await this.store.update(r);return r;}
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
  return r;
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
  return r;
 }
 private async active(owner:string,slug:string){const s=await this.store.settings(owner);const ready=await bookingReadiness(this.env,owner);if(!s||s.slug!==slug||!s.enabled||!ready.signIn||!ready.calendar||!ready.pilot)throw Error('booking_unavailable');return s;}
 private async required(owner:string,id:string){const r=await this.store.request(owner,id);if(!r)throw Error('not_found');return r;}
 private assertVisitor(r:BookingRequestRecord,visitor:BookingVisitorIdentity){if(!r.visitorSubject||r.visitorSubject!==visitor.subject||r.email!==visitor.email)throw Error('not_found');}
 private async reviewUncertainIdentity(settings:BookingSettings,r:BookingRequestRecord,visitor:BookingVisitorIdentity){
  if(visitor.emailAuthoritative&&r.emailAuthoritative===true)return;
  // A later login cannot upgrade the authority under which the request began.
  // Conversely, a loss of email authority invalidates any cached VIP decision.
  r.initialDecision=r.initialDecision||r.decision;
  r.decision=decideBooking(settings,r.email,r.decision.fit,uncertainEmail());
  r.emailAuthoritative=false;r.updatedAt=Date.now();
  if(r.policySnapshot)r.policySnapshot={...r.policySnapshot,vipMatch:false};
  await this.store.update(r);
 }
 private async available(s:BookingSettings,r:BookingRequestRecord,targetStart?:string){
  const calendar=await this.store.calendar(s.owner);if(!calendar)throw Error('calendar_unavailable');
  const now=Date.now(),busy=await bookingCalendarBusy(this.env,calendar,new Date(now).toISOString(),new Date(now+(s.horizonDays+1)*86400000).toISOString());
  // Review delay starts when the visitor applies, not again whenever the owner
  // opens the request. Minimum notice still moves with the actual current time.
  const earliest=Math.max(!r.scheduling&&r.decision.tier==='review'?r.createdAt+s.reviewDelayDays*86400000:0,targetStart?Date.parse(targetStart):0,r.scheduling?Date.parse(r.scheduling.windowStart):0);
  // The calendar needs every date in the configured horizon (at most 90 days
  // with 96 quarter-hour starts per day); targeted rechecks retain the small cap.
  return generateBookingSlots({...s,minNoticeHours:Math.max(s.minNoticeHours,(earliest-now)/3600000)},!r.scheduling&&r.decision.tier==='async'?'async':'priority',busy,(await this.store.reservations(s.owner)).filter(v=>v.id!==r.id),now,targetStart?100:90*96).filter(slot=>!r.scheduling||Date.parse(slot.end)<=Date.parse(r.scheduling.windowEnd));
 }
 private async book(s:BookingSettings,r:BookingRequestRecord){
  const calendar=await this.store.calendar(s.owner);if(!calendar)throw Error('calendar_unavailable');
  if(!r.slotStart||!r.slotEnd)throw Error('no_pending_slot');
  if(r.status==='booking'&&r.eventId){
   const event=await findBookingEvent(this.env,calendar,r.eventId);
   if(event){r.status='booked';r.updatedAt=Date.now();await this.store.update(r);this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',r.id);return r;}
   // Recover an existing event after any policy change, but never create a new
   // write under superseded authorization. Keep its uncertain reservation.
   if(r.scheduling&&(!s.enabled||r.scheduling.settingsRevision!==s.revision))throw Error('booking_in_progress');
   // Keep the reservation on an uncertain write; retry only the same event ID.
   const busy=await bookingCalendarBusy(this.env,calendar,new Date(Date.parse(r.slotStart)-s.bufferMinutes*60000).toISOString(),new Date(Date.parse(r.slotEnd)+s.bufferMinutes*60000).toISOString());
   if(busy.length)throw Error('booking_in_progress');
   if(Date.parse(r.slotStart)<Date.now()+s.minNoticeHours*3600000)throw Error('booking_in_progress');
   s={...s,durationMinutes:(Date.parse(r.slotEnd)-Date.parse(r.slotStart))/60000};
   if(r.slotSource==='suggested'&&!await this.suggestedAvailable(s,r,{start:r.slotStart,end:r.slotEnd}))throw Error('booking_in_progress');
  }else if(r.slotSource==='suggested'?!await this.suggestedAvailable(s,r,{start:r.slotStart,end:r.slotEnd}):!(await this.available(s,r,r.slotStart)).some(slot=>slot.start===r.slotStart&&slot.end===r.slotEnd)){
   r.status='needs_new_slot';if(r.slotSource==='suggested'){r.slotStart=null;r.slotEnd=null;}r.updatedAt=Date.now();return this.store.update(r);
  }
  r.status='booking';r.eventId=r.eventId||await bookingEventId(r.id);r.updatedAt=Date.now();
  await this.store.update(r);
  this.ctx.storage.sql.exec('INSERT OR IGNORE INTO booking_reconcile(id) VALUES(?)',r.id);
  await this.ctx.storage.setAlarm(Date.now()+60000);
  try{await createBookingEvent(this.env,calendar,r,s);}catch{throw Error('booking_in_progress');}
  r.status='booked';r.updatedAt=Date.now();await this.store.update(r);
  this.ctx.storage.sql.exec('DELETE FROM booking_reconcile WHERE id=?',r.id);
  return r;
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
   if(this.ctx.storage.sql.exec('SELECT id FROM booking_reconcile WHERE attempts<8 LIMIT 1').toArray().length)await this.ctx.storage.setAlarm(Date.now()+300000);
  });
 }
}
