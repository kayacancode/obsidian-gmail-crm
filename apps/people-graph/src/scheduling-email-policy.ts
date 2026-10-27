import {addressParser} from 'postal-mime';
import type {SchedulingOffer,SchedulingResult} from './scheduling-types';

export interface SchedulingInboundEmail {
 messageId:string;envelopeTo:string;from:string;to:string[];cc:string[];subject:string;text:string;
 inReplyTo:string|null;references:string[];
}
export interface VerifiedSchedulingKickoff {
 gmailId:string;messageId:string;owner:string;from:string;to:string[];cc:string[];subject:string;text:string;receivedAt:number;
 context?:string;
}
export function schedulingAddress(value:string):string {
 const normalized=value.trim().toLowerCase();
 if(normalized.length>254||normalized.split('@')[0].length>64||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(normalized)||normalized.includes('..'))throw Error('invalid_email_mailbox');
 return normalized;
}
export function schedulingMailboxes(value:string):string[] {
 if(!value.trim())return [];
 if(value.length>4096||/[\r\n\x00-\x1f\x7f]/.test(value))throw Error('invalid_email_mailbox');
 const parsed=addressParser(value);
 if(!parsed.length||parsed.length>12)throw Error('invalid_email_mailbox');
 return parsed.map(item=>{
  if(item.group||!item.address)throw Error('invalid_email_mailbox');
  const address=schedulingAddress(item.address);
  if(item.name.includes('@')&&schedulingAddress(item.name)!==address)throw Error('invalid_email_mailbox');
  return address;
 });
}
export function schedulingMessageId(value:string):string {
 if(typeof value!=='string'||value.length>254||!/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value))throw Error('invalid_message_id');
 return value;
}
export function schedulingHeader(headers:{name:string;value:string}[],name:string):string {
 const found=headers.filter(h=>h.name.toLowerCase()===name.toLowerCase());
 if(found.length>1||found.some(h=>/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(h.value)||h.value.length>4096))throw Error('invalid_email_header');
 return found[0]?.value.trim()??'';
}
export function authoredSchedulingText(value:string):string {
 const out:string[]=[];
 for(const line of value.replace(/\r\n?/g,'\n').split('\n')){
  if(/^\s*(?:On\s+.+wrote:|[-_]{2,}\s*(?:Original|Forwarded) message|Begin forwarded message:|From:\s|--\s*$|Sent from my\b)/i.test(line))break;
  if(/^\s*>/.test(line))continue;
  out.push(line);
 }
 const text=out.join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim();
 if(text.length>4000)throw Error('email_text_too_large');return text;
}
export function isSchedulingKickoff(text:string):boolean {
 const fresh=authoredSchedulingText(text);
 if(/\b(?:not|no|never|don['’]?t|can['’]?t|cannot|won['’]?t|shouldn['’]?t|wouldn['’]?t|isn['’]?t|aren['’]?t|hasn['’]?t|haven['’]?t|without|cancel|reschedule)\b/i.test(fresh))return false;
 return /(?:^|\n)\s*(?:(?:agent|scheduling|scheduler|assistant|hi|hey|hello),\s*)?(?:(?:(?:can|could|would|will) you\s+)?please\s+|(?:can|could|would|will) you\s+)?(?:(?:schedule|book|set up)\b[^\n]{0,80}\b(?:meeting|call|time|chat|us)\b|find\s+(?:(?:us|me)\s+)?(?:(?:a|some)\s+)?(?:time|times)\b)/i.test(fresh);
}
export function schedulingCounterpart(message:{from:string;to:string[];cc:string[]},owner:string,agent:string):string {
 const peers=schedulingParticipants(message,owner,agent);
 if(peers.length!==1)throw Error('scheduling_requires_one_counterpart');
 return peers[0];
}
export function schedulingParticipants(message:{from:string;to:string[];cc:string[]},owner:string,agent:string):string[] {
 if(message.from!==owner||![...message.to,...message.cc].includes(agent))throw Error('invalid_owner_kickoff');
 const peers=[...new Set([...message.to,...message.cc].map(schedulingAddress).filter(address=>address!==owner&&address!==agent))];
 if(!peers.length||peers.length>5)throw Error('invalid_scheduling_participants');
 return peers;
}
export function parseOwnerSchedulingWindow(text:string,timezone:string,now=Date.now()):{kind:'ready';window:{windowStart?:string;windowEnd?:string}}|{kind:'clarify'} {
 const authored=authoredSchedulingText(text),weeks=authored.match(/\b(this|next) week\b/gi)??[];
 if(weeks.length>1)return {kind:'clarify'};
 const rest=authored.replace(/\b(this|next) week\b/gi,'').replace(/\bI am\b/gi,'');
 // These constraints require more than the supported calendar-week window. Do
 // not quietly replace an owner's explicit instruction with saved defaults.
 if(/\b(?:only|except|avoid|before|after|between|until|within|unless|provided|must|prefer|ideally|around|approximately|today|tomorrow|tonight|mornings?|afternoons?|evenings?|noon|midnight|weekends?|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|january|february|march|april|may|june|july|august|september|october|november|december|am|pm|utc|gmt|est|edt|pst|pdt|cst|cdt|eastern|pacific|central)\b|\d|\b\w+\/\w+\b|as long as/i.test(rest))return {kind:'clarify'};
 if(!weeks.length)return {kind:'ready',window:{}};
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const parts=(instant:number)=>{const p=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(value=>[value.type,value.value]));return {year:Number(p.year),month:Number(p.month),day:Number(p.day),hour:Number(p.hour),minute:Number(p.minute),second:Number(p.second)};};
 const local=parts(now),civil=Date.UTC(local.year,local.month-1,local.day),day=86400000;
 const monday=civil-((new Date(civil).getUTCDay()+6)%7)*day+(weeks[0]!.toLowerCase().startsWith('next')?7*day:0);
 const instant=(target:number)=>{let estimate=target;for(let i=0;i<4;i++){const p=parts(estimate),observed=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);estimate+=target-observed;}return new Date(estimate).toISOString();};
 return {kind:'ready',window:{windowStart:instant(monday),windowEnd:instant(monday+7*day)}};
}
export type SchedulingEmailChoice={kind:'select';slotId:string}|{kind:'refresh'}|{kind:'clarify'};
export function parseSchedulingChoice(text:string,offer:SchedulingOffer):SchedulingEmailChoice {
 const fresh=authoredSchedulingText(text).toLowerCase().replace(/[.!]+$/,'').trim();
 if(/^(?:none of (?:these|those)(?: times)? (?:work|works)(?: for me)?[.!]?\s*)?(?:other options|different times|more times)(?: please)?$/.test(fresh))return {kind:'refresh'};
 if(/^(?:none of (?:these|those)(?: times)? (?:work|works)(?: for me)?)$/.test(fresh))return {kind:'refresh'};
 // Restrict the whole authored reply, not just a matching fragment. Additional
 // commands, qualifiers, negation and multiple choices must never select a slot.
 const value=fresh.replace(/^(?:hi(?: there)?[,!]\s*)/,'').replace(/(?:[,!]?\s*(?:thanks|thank you)[!]?)$/,'').trim();
 const match=value.match(/^(?:(?:let['’]?s do|i choose|i confirm|please book|book)\s+)?(?:the\s+)?(?:option\s+)?(1|2|3|first|second|third)(?:\s+option)?(?:\s+(?:works(?: for me)?|is good(?: for me)?|please))?$/);
 if(!match)return {kind:'clarify'};
 const index=({first:0,second:1,third:2} as Record<string,number>)[match[1]]??Number(match[1])-1;
 const slot=offer.slots[index];return slot?{kind:'select',slotId:slot.id}:{kind:'clarify'};
}
export function schedulingSlotText(start:string,end:string,timezone:string):string {
 const date=new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const time=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 return `${date.format(new Date(start))} – ${time.format(new Date(end))}`;
}
export function schedulingOfferText(result:SchedulingResult,clarify=false):string {
 if(!result.offer?.slots.length)return 'I could not find an available time within the owner’s scheduling rules. Please follow up with the owner to choose a different window.';
 return `${clarify?'Please choose exactly one option from the current list.':'Here are the available times:'}\n\n${result.offer.slots.map((slot,i)=>`${i+1}. ${schedulingSlotText(slot.start,slot.end,result.timezone)}`).join('\n')}\n\nReply with “Option 1 works”, “Option 2 works”, or the number you choose. Reply “Other options please” to request fresh times. These options expire ${new Intl.DateTimeFormat('en-US',{timeZone:result.timezone,dateStyle:'medium',timeStyle:'short'}).format(result.offer.expiresAt)} (${result.timezone}). A time is booked only after I confirm it.`;
}
