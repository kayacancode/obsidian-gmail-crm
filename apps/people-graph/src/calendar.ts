// RSVP records are scheduled context, never proof that a meeting happened.
export interface CalendarRecord {key:string;at:string;end:string;allDay:boolean;title:string;status:'accepted'|'invited';people:string[];acceptedPeople:string[];url:string|null}
export function normalizeCalendarEvent(raw:any,owner:string):CalendarRecord|null {
 if(!raw||typeof raw.id!=='string'||raw.status==='cancelled')return null;
 const start=raw.start?.dateTime??raw.start?.date,end=raw.end?.dateTime??raw.end?.date;
 if(!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))return null;
 const attendees=Array.isArray(raw.attendees)?raw.attendees:[];
 const self=attendees.find((a:any)=>a.self||a.email?.toLowerCase()===owner);
 if(self?.responseStatus==='declined')return null;
 const people=[...new Set<string>(attendees.filter((a:any)=>!a.self&&!a.resource&&a.responseStatus!=='declined'&&typeof a.email==='string'&&a.email.toLowerCase()!==owner&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)).slice(0,200).map((a:any)=>a.email.toLowerCase()))];
 if(!people.length)return null;
 const accepted=self?.responseStatus==='accepted'||raw.organizer?.self===true||raw.organizer?.email?.toLowerCase()===owner;
 const at=new Date(start).toISOString();let url:null|string=null;
 try{const u=new URL(raw.htmlLink);if(u.protocol==='https:'&&u.hostname==='calendar.google.com'&&!u.username&&!u.password)url=u.href;}catch{}
 return {key:JSON.stringify([raw.iCalUID||owner+':'+raw.id,at]),at,end:new Date(end).toISOString(),allDay:!raw.start?.dateTime,title:String(raw.summary||'Calendar event').slice(0,500),status:accepted?'accepted':'invited',people,acceptedPeople:accepted?people.filter(email=>attendees.some((a:any)=>a.email?.toLowerCase()===email&&a.responseStatus==='accepted')):[],url};
}
export interface PersonFeedback {action:'boost'|'suppress'|'snooze';at:number;until:number;delta:number}
