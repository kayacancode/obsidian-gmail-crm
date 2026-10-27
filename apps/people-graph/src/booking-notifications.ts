import type {BookingRequestRecord,BookingSettings} from './booking-types';
import {schedulingAddress} from './scheduling-email-policy';

/** Public booking notifications track the visitor's choice, not unrelated updates. */
export function bookingNotificationKey(r:BookingRequestRecord):string|null{
 if(r.scheduling||r.status!=='pending_approval')return null;
 if(r.proposedTimes?.slots.length&&r.proposedTimes.revision)return 'public-booking:'+JSON.stringify([r.id,'proposal',r.proposedTimes.revision]);
 if(r.slotSource!=='suggested'&&r.slotStart&&r.slotEnd)return 'public-booking:'+JSON.stringify([r.id,'slot',r.slotStart,r.slotEnd,...(r.selectionRevision?[r.selectionRevision]:[])]);
 return null;
}

function bounded(value:string,max:number):string{
 const text=value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
 return text.length>max?text.slice(0,max-1)+'…':text;
}
function escapeHtml(value:string):string{return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}
function reviewUrl(origin:string,id:string):string{
 try{
  const url=new URL(origin);
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.pathname!=='/'||url.search||url.hash||/[\x00-\x20\x7f]/.test(origin))throw Error();
  url.pathname='/booking';url.searchParams.set('request',id);return url.href;
 }catch{throw Error('booking_notification_invalid_origin');}
}

function approvalReplyTo(value:string,from:string):string{
 try{
  if(/[\x00-\x20\x7f]/.test(value))throw Error();
  const address=schedulingAddress(value),sender=schedulingAddress(from);
  if(!/^scheduling\+b[0-9a-f]{48}@/.test(address)||address.split('@')[1]!==sender.split('@')[1])throw Error();
  return address;
 }catch{throw Error('booking_notification_invalid_reply_to');}
}

export function bookingRequestEmail(r:BookingRequestRecord,settings:BookingSettings,config:{from:string;origin:string;replyTo?:string}):{from:string;to:string;subject:string;text:string;html:string;replyTo?:string;headers:Record<string,string>}|null{
 if(!bookingNotificationKey(r))return null;
 const url=reviewUrl(config.origin,r.id),name=bounded(r.name,100)||bounded(r.email,254);
 const replyTo=config.replyTo===undefined?undefined:approvalReplyTo(config.replyTo,config.from);
 const date=new Intl.DateTimeFormat('en-US',{timeZone:settings.timezone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const proposed=r.proposedTimes,slots=proposed?proposed.slots.slice(0,3):[{start:r.slotStart!,end:r.slotEnd!}];
 const times=slots.map(slot=>`${date.format(new Date(slot.start))} – ${date.format(new Date(slot.end))}`);
 const context:[string,string][]=[
  ['Name',name],['Email',bounded(r.email,254)],['Project (visitor-provided)',bounded(r.project,1600)],
  ['Purpose (visitor-provided)',bounded(r.purpose,1600)],['Project URL (visitor-provided)',bounded(r.projectUrl,1000)],['Referrer (claimed by visitor)',bounded(r.referrer,300)]
 ].filter(([,value])=>!!value) as [string,string][];
 const reasons=r.decision.reasons.slice(0,6).map(value=>bounded(value,400)).filter(Boolean);
 const uncertainties=r.decision.uncertainties.slice(0,6).map(value=>bounded(value,400)).filter(Boolean);
 const timeHeading=proposed?'Proposed alternative times':'Selected time';
 const timezone=`Times shown in your timezone: ${bounded(settings.timezone,100)}.`;
 const visitorTimezone=proposed?`Visitor's suggested timezone: ${bounded(proposed.timezone,100)}.`:'';
 const review='Sign in to review this request and approve or decline. This meeting is not booked.';
 const reply=replyTo?`${slots.length===1?'Reply “Approve” to approve this time':`Reply with exactly one of ${slots.map((_,index)=>`“Approve ${index+1}”`).join(', ')} to approve that time`}, or “Decline” to decline the request. Send your reply from ${bounded(r.owner,254)}. The meeting is booked only after you receive confirmation.`:'';
 const text=[
  'Meeting request awaiting your review',context.map(([label,value])=>`${label}: ${value}`).join('\n'),
  [timeHeading,timezone,...times.map((time,index)=>replyTo?`${index+1}. ${time}`:time),visitorTimezone].filter(Boolean).join('\n'),
  ...(reasons.length||uncertainties.length?['Private assessment for the owner',...(reasons.length?['Reasons:\n'+reasons.map(value=>'- '+value).join('\n')]:[]),...(uncertainties.length?['Uncertainties:\n'+uncertainties.map(value=>'- '+value).join('\n')]:[])]:[]),
  ...(reply?[reply]:[]),review,`Review request: ${url}`
 ].join('\n\n');
 const list=(items:string[])=>'<ul>'+items.map(item=>'<li>'+escapeHtml(item)+'</li>').join('')+'</ul>';
 const html='<!doctype html><html><body style="font-family:Arial,sans-serif;color:#202020;line-height:1.5">'
  +'<h1 style="font-size:22px">Meeting request awaiting your review</h1>'
  +context.map(([label,value])=>`<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')
  +`<h2 style="font-size:18px">${timeHeading}</h2><p>${escapeHtml(timezone)}</p>`+(replyTo?'<ol>'+times.map(time=>'<li>'+escapeHtml(time)+'</li>').join('')+'</ol>':list(times))+(visitorTimezone?`<p>${escapeHtml(visitorTimezone)}</p>`:'')
  +(reasons.length||uncertainties.length?'<h2 style="font-size:18px">Private assessment for the owner</h2>'+(reasons.length?'<h3 style="font-size:16px">Reasons</h3>'+list(reasons):'')+(uncertainties.length?'<h3 style="font-size:16px">Uncertainties</h3>'+list(uncertainties):''):'')
  +(reply?`<p>${escapeHtml(reply)}</p>`:'')
  +`<p>${escapeHtml(review)}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 18px;background:#202020;color:#fff;text-decoration:none;border-radius:6px">Review request</a></p></body></html>`;
 return {from:config.from,to:r.owner,subject:bounded(`Meeting request: ${name}`,180),text,html,...(replyTo?{replyTo}:{}),headers:{'Auto-Submitted':'auto-generated'}};
}
