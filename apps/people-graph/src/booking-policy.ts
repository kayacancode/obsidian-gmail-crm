import type {BookingBusy,BookingDecision,BookingFit,BookingPeopleContext,BookingRequestRecord,BookingSettings,BookingSlot,BookingSubmission,BookingTier} from './booking-types';

const MINUTE=60_000;
const DAY=86_400_000;

/** Normalization deliberately does not remove dots or plus tags or infer aliases. */
export function normalizeBookingEmail(value:unknown):string{
 if(typeof value!=='string')throw Error('invalid_email');
 const email=value.trim().toLowerCase();
 if(email.length>254||!/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)||email.includes('..')||email.startsWith('.')||email.includes('.@'))throw Error('invalid_email');
 return email;
}

export function defaultBookingSettings(owner:string):BookingSettings{
 const email=normalizeBookingEmail(owner);
 const local=email.split('@')[0].replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
 return {owner:email,revision:0,slug:local.length>=3?local:'meet-'+local,displayName:'',intro:'Tell me what you are building and what you would like to discuss.',thesis:'',timezone:'America/New_York',durationMinutes:30,bufferMinutes:10,minNoticeHours:24,horizonDays:28,reviewDelayDays:7,dailyLimit:4,weeklyLimit:12,weekdays:[1,2,3,4,5],startTime:'09:00',endTime:'17:00',vipEmails:[],enabled:false,autoBookPriority:false};
}

export function validateBookingSettings(input:unknown,current:BookingSettings):BookingSettings{
 if(!record(input))throw Error('invalid_settings');
 const allowed=new Set(Object.keys(defaultBookingSettings(current.owner)));
 for(const key of Object.keys(input))if(!allowed.has(key))throw Error('unknown_setting');
 if(input.owner!==undefined&&input.owner!==current.owner)throw Error('invalid_owner');
 if(input.revision!==undefined&&input.revision!==current.revision)throw Error('settings_conflict');
 const value={...current,...input};
 const slug=boundedText(value.slug,48,'slug',3);
 if(!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(slug))throw Error('invalid_slug');
 const timezone=boundedText(value.timezone,100,'timezone',1);
 try{new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();}catch{throw Error('invalid_timezone');}
 const durationMinutes=integer(value.durationMinutes,15,120,'duration');
 if(durationMinutes%5)throw Error('invalid_duration');
 const bufferMinutes=integer(value.bufferMinutes,0,120,'buffer');
 const minNoticeHours=integer(value.minNoticeHours,0,720,'notice');
 const horizonDays=integer(value.horizonDays,7,90,'horizon');
 const reviewDelayDays=integer(value.reviewDelayDays,7,60,'review_delay');
 if(reviewDelayDays>horizonDays)throw Error('invalid_review_delay');
 const dailyLimit=integer(value.dailyLimit,1,20,'daily_limit');
 const weeklyLimit=integer(value.weeklyLimit,1,100,'weekly_limit');
 if(!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.length>7||value.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))throw Error('invalid_weekdays');
 const weekdays=[...new Set(value.weekdays)].sort();
 const startTime=boundedText(value.startTime,5,'start_time',5),endTime=boundedText(value.endTime,5,'end_time',5);
 if(!validTime(startTime)||!validTime(endTime)||timeMinute(endTime)-timeMinute(startTime)<durationMinutes)throw Error('invalid_working_hours');
 if(!Array.isArray(value.vipEmails)||value.vipEmails.length>200)throw Error('invalid_vip_emails');
 const vipEmails=[...new Set(value.vipEmails.map(normalizeBookingEmail))];
 if(typeof value.enabled!=='boolean'||typeof value.autoBookPriority!=='boolean')throw Error('invalid_booking_mode');
 const thesis=boundedText(value.thesis,6000,'thesis');
 if((value.enabled||value.autoBookPriority)&&!meaningfulThesis(thesis))throw Error('thesis_required');
 return {owner:current.owner,revision:current.revision+1,slug,displayName:boundedText(value.displayName,100,'display_name'),intro:boundedText(value.intro,2000,'intro'),thesis,timezone,durationMinutes,bufferMinutes,minNoticeHours,horizonDays,reviewDelayDays,dailyLimit,weeklyLimit,weekdays,startTime,endTime,vipEmails,enabled:value.enabled,autoBookPriority:value.autoBookPriority};
}

export function validateBookingSubmission(input:unknown):BookingSubmission{
 if(!record(input))throw Error('invalid_submission');
 const name=boundedText(input.name,100,'name',1),project=boundedText(input.project,4000,'project',10),purpose=boundedText(input.purpose,2000,'purpose',10);
 const referrer=boundedText(input.referrer??'',300,'referrer');
 const projectUrl=boundedText(input.projectUrl??'',2000,'project_url');
 if(projectUrl){try{const url=new URL(projectUrl);if(url.protocol!=='https:'||!url.hostname||url.username||url.password)throw Error();}catch{throw Error('invalid_project_url');}}
 return {name,project,purpose,projectUrl,referrer};
}

/** Called only after the route has established verified inbox control. */
export function decideBooking(settings:BookingSettings,email:string,fit:BookingFit,people:BookingPeopleContext):BookingDecision{
 const decision:BookingDecision={tier:'review',reasons:[],uncertainties:[],fit,people,policyRevision:settings.revision};
 if(!['matched','not_found'].includes(people.status))decision.uncertainties.push(people.reason||'The relationship source could not be verified.');
 if(fit.fit==='uncertain')decision.uncertainties.push('Thesis fit could not be established reliably.');
 let normalized:string;
 try{normalized=normalizeBookingEmail(email);}catch{decision.uncertainties.push('The verified email is invalid.');normalized='';}
 if(['matched','not_found'].includes(people.status)){
  if(!people.lastSync||!Number.isFinite(Date.parse(people.lastSync)))decision.uncertainties.push('Source freshness was not established.');
  if(people.status==='matched'){
   try{if(normalizeBookingEmail(people.email)!==normalized)decision.uncertainties.push('The source identity does not match the verified email.');}
   catch{decision.uncertainties.push('The source identity could not be verified.');}
  }
 }
 if(decision.uncertainties.length){decision.reasons.push('Owner review is required because context is uncertain.');return decision;}
 if(settings.vipEmails.includes(normalized)){decision.tier='priority';decision.reasons.push('The verified email is on the owner’s VIP list.');}
 else if(fit.fit==='strong'){decision.tier='priority';decision.reasons.push('The submission strongly matches the saved meeting thesis.');}
 else if(fit.fit==='possible'&&people.status==='matched'){decision.tier='priority';decision.reasons.push('The verified email exactly matches an existing contact, and the meeting purpose plausibly fits the saved thesis.');}
 else if(fit.fit==='weak'){decision.tier='async';decision.reasons.push('The submission does not match the saved meeting thesis.');}
 else decision.reasons.push('The owner should review the meeting purpose and available context.');
 decision.reasons.push(...fit.reasons.slice(0,3));
 return decision;
}

/** Capacity counts confirmed bookings and in-flight reservations, never pending preferences.
 * Local working hours are converted per date; nonexistent/duplicated DST wall times are omitted.
 */
export function generateBookingSlots(settings:BookingSettings,tier:BookingTier,busy:BookingBusy[],existing:BookingRequestRecord[],now=Date.now()):BookingSlot[]{
 if(tier==='async'||!Number.isFinite(now))return [];
 const format=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const active=existing.filter(item=>item.owner===settings.owner&&['booked','booking','cancelling'].includes(item.status));
 const intervals:{start:number;end:number}[]=[];
 for(const item of [...busy,...active.map(item=>({start:item.slotStart??'',end:item.slotEnd??''}))]){
  const start=Date.parse(item.start),end=Date.parse(item.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return [];
  intervals.push({start,end});
 }
 const daily=new Map<number,number>(),weekly=new Map<number,number>();
 for(const item of active){const date=localDate(format,Date.parse(item.slotStart!)),week=weekStart(date);daily.set(date,(daily.get(date)||0)+1);weekly.set(week,(weekly.get(week)||0)+1);}
 const earliest=now+Math.max(settings.minNoticeHours*60*MINUTE,tier==='review'?Math.max(7,settings.reviewDelayDays)*DAY:0);
 const latest=now+settings.horizonDays*DAY,buffer=settings.bufferMinutes*MINUTE;
 const slots:BookingSlot[]=[],firstDate=localDate(format,now);
 for(let date=firstDate;date<=firstDate+(settings.horizonDays+1)*DAY;date+=DAY){
  if(!settings.weekdays.includes(new Date(date).getUTCDay())||(daily.get(date)||0)>=settings.dailyLimit||(weekly.get(weekStart(date))||0)>=settings.weeklyLimit)continue;
  const offsets=new Set<number>();
  for(let hour=-36;hour<=36;hour+=6){const instant=date+hour*60*MINUTE;offsets.add(localStamp(format,instant)-instant);}
  for(let minute=timeMinute(settings.startTime);minute+settings.durationMinutes<=timeMinute(settings.endTime);minute+=15){
   const starts=wallInstants(format,date+minute*MINUTE,offsets),ends=wallInstants(format,date+(minute+settings.durationMinutes)*MINUTE,offsets);
   if(starts.length!==1||ends.length!==1)continue;
   const start=starts[0],end=ends[0];
   if(start<earliest||end>latest||end-start!==settings.durationMinutes*MINUTE)continue;
   if(intervals.some(item=>start-buffer<item.end&&end+buffer>item.start))continue;
   slots.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});
   if(slots.length>=100)return slots;
  }
 }
 return slots;
}

export function meaningfulThesis(value:string):boolean{return value.trim().length>=20&&(value.trim().match(/[\p{L}\p{N}]+/gu)?.length??0)>=4;}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function boundedText(value:unknown,max:number,label:string,min=0):string{if(typeof value!=='string')throw Error('invalid_'+label);const text=value.trim();if(text.length<min||text.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error('invalid_'+label);return text;}
function integer(value:unknown,min:number,max:number,label:string):number{if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw Error('invalid_'+label);return value;}
function validTime(value:string):boolean{return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);}
function timeMinute(value:string):number{const [h,m]=value.split(':').map(Number);return h*60+m;}
function localStamp(format:Intl.DateTimeFormat,instant:number):number{const parts=format.formatToParts(instant),p:Record<string,number>={};for(const part of parts)if(part.type!=='literal')p[part.type]=Number(part.value);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);}
function localDate(format:Intl.DateTimeFormat,instant:number):number{const stamp=localStamp(format,instant);return Math.floor(stamp/DAY)*DAY;}
function weekStart(date:number):number{return date-((new Date(date).getUTCDay()+6)%7)*DAY;}
function wallInstants(format:Intl.DateTimeFormat,wall:number,offsets:Set<number>):number[]{const matches:number[]=[];for(const offset of offsets){const instant=wall-offset;if(localStamp(format,instant)===wall)matches.push(instant);}return matches;}
