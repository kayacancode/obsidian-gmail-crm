import {normalizeBookingEmail} from './booking-policy';
import type {BookingRequestRecord,BookingSettings,BookingSlot} from './booking-types';
import type {SchedulingAuthority,SchedulingConfirmation,SchedulingInput,SchedulingOffer,SchedulingResult} from './scheduling-types';

function object(input:unknown):Record<string,unknown>{if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_request');return input as Record<string,unknown>;}
function text(input:unknown,max:number,key:string,min=0):string{if(typeof input!=='string'||input.trim().length<min||input.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input))throw Error('invalid_'+key);return input.trim();}
function instant(input:unknown):string{
 const value=text(input,40,'window',1);
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))throw Error('invalid_window');
 return new Date(value).toISOString();
}
export function validateSchedulingInput(input:unknown):SchedulingInput{
 const value=object(input),allowed=['email','name','context','instructions','timezone','windowStart','windowEnd','idempotencyKey'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('invalid_request');
 const idempotencyKey=text(value.idempotencyKey,100,'request_key',16);if(!/^[A-Za-z0-9_-]+$/.test(idempotencyKey))throw Error('invalid_request_key');
 const result:SchedulingInput={email:normalizeBookingEmail(value.email),context:text(value.context,8000,'context'),idempotencyKey};
 if(value.name!==undefined)result.name=text(value.name,120,'name');
 if(value.instructions!==undefined)result.instructions=text(value.instructions,2000,'instructions');
 if(value.timezone!==undefined){const timezone=text(value.timezone,100,'timezone',1);try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw Error('invalid_timezone');}result.timezone=timezone;}
 if(value.windowStart!==undefined)result.windowStart=instant(value.windowStart);
 if(value.windowEnd!==undefined)result.windowEnd=instant(value.windowEnd);
 if(result.windowStart&&result.windowEnd&&result.windowStart>=result.windowEnd)throw Error('invalid_window');
 return result;
}
export function validateSchedulingAuthority(input:unknown):SchedulingAuthority{
 try{const value=object(input);if(Object.keys(value).some(key=>!['channel','evidenceId'].includes(key))||!['owner_api','owner_email'].includes(String(value.channel)))throw Error();return {channel:value.channel as SchedulingAuthority['channel'],evidenceId:text(value.evidenceId,500,'authority',1)};}catch{throw Error('invalid_authority');}
}
export function validateSchedulingConfirmation(input:unknown):SchedulingConfirmation{
 const value=object(input);if(Object.keys(value).some(key=>!['revision','slotId','evidenceId'].includes(key)))throw Error('invalid_request');
 return {revision:text(value.revision,100,'revision',1),slotId:text(value.slotId,100,'slot',1),evidenceId:text(value.evidenceId,500,'evidence',1)};
}
export function schedulingWindow(input:SchedulingInput,settings:BookingSettings,now=Date.now()){
 const start=Math.max(now,Date.parse(input.windowStart??new Date(now).toISOString())),end=Math.min(now+settings.horizonDays*86400000,Date.parse(input.windowEnd??new Date(now+settings.horizonDays*86400000).toISOString()));
 if(start>=end)throw Error('invalid_window');return {windowStart:new Date(start).toISOString(),windowEnd:new Date(end).toISOString()};
}
/** Prefer different local dates, then separated choices within a narrow window. */
export function schedulingOffer(slots:BookingSlot[],timezone:string,now=Date.now()):SchedulingOffer|null{
 const options=slots.filter(slot=>Date.parse(slot.start)>now+1),chosen:BookingSlot[]=[],dates=new Set<string>();
 const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
 for(const slot of options){const date=format.format(new Date(slot.start));if(dates.has(date))continue;chosen.push(slot);dates.add(date);if(chosen.length===3)break;}
 if(chosen.length<3)for(const slot of options){if(chosen.every(value=>Math.abs(Date.parse(value.start)-Date.parse(slot.start))>=2*3600000)){chosen.push(slot);if(chosen.length===3)break;}}
 if(!chosen.length)return null;chosen.sort((a,b)=>a.start.localeCompare(b.start));
 return {revision:crypto.randomUUID(),expiresAt:Math.min(now+48*3600000,Date.parse(chosen[0].start)-1),slots:chosen.map(slot=>({...slot,id:crypto.randomUUID()}))};
}
export function schedulingResult(record:BookingRequestRecord,currentRevision?:number,now=Date.now()):SchedulingResult{
 const saved=record.scheduling;if(!saved)throw Error('not_found');
 const mutable=['pending_approval','needs_new_slot'].includes(record.status),fresh=saved.offer&&saved.offer.expiresAt>now&&(currentRevision===undefined||saved.settingsRevision===currentRevision);
 const offer=mutable&&fresh?saved.offer:null,status=mutable&&!offer?'needs_new_slot':record.status;
 const format=new Intl.DateTimeFormat('en-US',{timeZone:saved.timezone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const replyText=status==='booked'&&record.slotStart?'Booked for '+format.format(new Date(record.slotStart))+'.':status==='booking'?'The calendar confirmation is still pending.':offer?'Please choose one of these times:\n'+offer.slots.map((slot,index)=>`${index+1}. ${format.format(new Date(slot.start))}`).join('\n'):status==='needs_new_slot'?'No current times are available. Please request fresh options.':'This scheduling request is closed.';
 return {requestId:record.id,status,timezone:saved.timezone,offer,replyText,recommendation:saved.recommendation};
}
