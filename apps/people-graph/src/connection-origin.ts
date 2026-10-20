import {parseMessage,type GmailMessage} from './mail-model';
import {decodeGmailMessage} from './gmail-body';
export interface ConnectionOriginEvidence {introducerName:string;observedAt:string;subject:string;quote:string;messageId:string;threadId?:string}
export interface DirectConnectionContext {direction:'sent'|'received';observedAt:string;subject:string;quote:string;messageId:string;threadId?:string}
const opaqueMessageId=/^[A-Za-z0-9_-]{1,200}$/;
const emailPattern=/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const noAddress=(s:string)=>s.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]');
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function nameForms(names:string[]):string[]{
 const values=new Set<string>();
 for(const raw of names){
  const name=raw.trim().replace(/^(?:dr|mr|mrs|ms)\.?\s+/i,'').replace(/\s+/g,' ');
  if(!name||name.includes('@')||name.length>120||!/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name))continue;
  values.add(name);const first=name.split(' ')[0];if(first.length>=2)values.add(first);
 }
 return [...values].sort((a,b)=>b.length-a.length);
}
/** A source-backed two-party email introduction. Co-recipients and subjects alone never count. */
export function extractConnectionOrigin(message:GmailMessage,viewerEmails:string[],target:{email:string;name:string}):ConnectionOriginEvidence|null{
 try{
  if(!message||!opaqueMessageId.test(message.id||'')||!Array.isArray(viewerEmails)||!target||typeof target.email!=='string'||typeof target.name!=='string')return null;
  const viewers=new Set(viewerEmails.filter(v=>typeof v==='string'&&emailPattern.test(v)).map(v=>v.toLowerCase()));
  const targetEmail=target.email.trim().toLowerCase(),at=Number(message.internalDate);
  if(!viewers.size||!emailPattern.test(targetEmail)||viewers.has(targetEmail)||!Number.isFinite(at)||at<=0||at>Date.now())return null;
  const headers=message.payload?.headers||[];
  if(!Array.isArray(headers)||headers.some(h=>typeof h?.name!=='string'||typeof h?.value!=='string'||h.value.length>8000))return null;
  const from=headers.filter(h=>h.name.toLowerCase()==='from');
  if(from.length!==1||headers.some(h=>['list-id','list-unsubscribe','resent-from'].includes(h.name.toLowerCase())))return null;
  // Reuse the mailbox parser's address handling without confusing sender and recipients.
  const senders=parseMessage({...message,payload:{headers:from}},'')?.participants||[];
  if(senders.length!==1)return null;
  const sender=senders[0];
  if(viewers.has(sender.email)||sender.email===targetEmail||/^(?:no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(sender.email))return null;
  const recipientsText=headers.filter(h=>['to','cc'].includes(h.name.toLowerCase())).map(h=>h.value).join(', ');
  const recipients=parseMessage({...message,payload:{headers:[{name:'From',value:recipientsText}]}},'')?.participants||[];
  const viewerRecipients=recipients.filter(r=>viewers.has(r.email)),targetRecipient=recipients.find(r=>r.email===targetEmail);
  if(!viewerRecipients.length||!targetRecipient||recipients.some(r=>!viewers.has(r.email)&&r.email!==targetEmail&&r.email!==sender.email))return null;
  const subject=headers.filter(h=>h.name.toLowerCase()==='subject').map(h=>h.value).join(' ').trim().slice(0,160);
  if(/^(?:fwd?|fw)\s*:/i.test(subject))return null;
  const decoded=decodeGmailMessage(message,24000);
  const parts=decoded.text.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);
  const sentences:{text:string;start:number;end:number}[]=[];let offset=0;
  for(const part of parts.slice(0,80)){
   const start=decoded.text.indexOf(part,offset),end=start+part.length;offset=end;
   const previous=sentences.at(-1);
   // Plain-text hard wraps and closing inline HTML tags are not sentence endings.
   // Keep greetings and attribution/example labels separate from the next sentence.
   if(previous&&!/[.!?:]$/.test(previous.text)&&!/^(?:hi|hey|hello)\s+[^.!?:]{1,120},$/i.test(previous.text)){
    previous.text+=' '+part;previous.end=end;
   }else sentences.push({text:part,start,end});
  }
  // Never match a sentence whose qualifying words could be beyond either input cap.
  if(decoded.bytes>=24000||parts.length>80)sentences.pop();
  const pieces=sentences.map(s=>s.text);
  const viewerNames=nameForms(viewerRecipients.map(r=>r.name)),targetNames=nameForms([target.name,targetRecipient.name]);
  const pair=(left:string[],right:string[])=>left.length&&right.length?new RegExp(`^(?:(?:Hi|Hey|Hello)\\s+)?(?:${left.map(escaped).join('|')})\\s*[,—–:-]\\s*(?:please\\s+)?meet\\s+(?:${right.map(escaped).join('|')})(?:\\s*[,—–:-]\\s*[^!?]{1,300})?[.!]?$`,'iu'):null;
  const named=[pair(viewerNames,targetNames),pair(targetNames,viewerNames)].filter((p):p is RegExp=>!!p);
  const sharedAct=/^(?:just\s+)?(?:(?:I(?:['’]m| am)\s+)?(?:introducing|connecting)|(?:(?:I\s+)?(?:wanted|want)\s+to|I(?:['’]d| would)\s+like\s+to|let me|happy to)\s+(?:introduce|connect))\s+you\s+(?:two|both)(?:\s+(?:here|by email))?(?:\s*(?:[,—–-]|because|as|so)\s+[^!?]{1,300})?[.!]?$/i;
  const makingAct=/^making (?:the|this) (?:intro|introduction) (?:here|by email)[.!]?$/i;
  const addingAct=viewerNames.length?new RegExp(`^(?:I(?:['’]m| am)\\s+)?adding\\s+(?:${viewerNames.map(escaped).join('|')})\\s+here(?:\\s*[,—–:-]\\s*[^!?]{1,300})?[.!]?$`,'iu'):null;
  // The body sanitizer removes @name tokens. A bare "you" is only sufficient
  // immediately after the sender explicitly adds the known viewer to this pair.
  const addedRecommendation=viewerNames.length&&targetNames.length?new RegExp(`^(?:(?:${viewerNames.map(escaped).join('|')})\\s*[,—–:-]?\\s+)?you\\s+should\\s+meet\\s+(?:${targetNames.map(escaped).join('|')})(?:\\s*[,—–:-]\\s*[^!?]{1,300})?[.!]?$`,'iu'):null;
  const notAnAct=/\b(?:if|unless|once|when|tomorrow|later|eventually|someday|next\s+(?:week|month|year|time)|not|never|declined|refused|cannot|can't|won't|wouldn't|didn't|don't|doesn't|example|template|sample|quote|quoted|draft|wording)\b|\b(?:can|could|would|will) you\b|\b(?:please )?(?:write|say)\s*:/i;
  for(let i=0;i<pieces.length;i++){
   const quote=pieces[i];let end=sentences[i].end;if(quote.length>500||notAnAct.test(quote))continue;
   // A preceding hypothetical/example label cannot become a factual introduction.
   if(i&&/(?:\bif\b|\bunless\b|\bwhen\b|\bonce\b|\bexample\b|\bsample\b|\btemplate\b|\b(?:write|wrote|say|said|draft|quoted?)\s*:)\s*[^.!?]{0,200}[.:]?$/i.test(pieces[i-1]))continue;
   if(!named.some(p=>p.test(quote))&&!sharedAct.test(quote)&&!makingAct.test(quote)){
    const next=pieces[i+1];
    if(!addingAct?.test(quote)||/\b(?:write|wrote|say|said|draft|quoted?)\s*:/i.test(quote)||!next||next.length>500||notAnAct.test(next)||!addedRecommendation?.test(next))continue;
    end=sentences[i+1].end;
   }
   const sourceQuote=decoded.text.slice(sentences[i].start,end);if(sourceQuote.length>1200)continue;
   const introducerName=noAddress(sender.name||sender.email.split('@')[0]).slice(0,160);
   return {introducerName,observedAt:new Date(at).toISOString(),subject:noAddress(subject).slice(0,160),quote:noAddress(sourceQuote),messageId:message.id!,...(opaqueMessageId.test(message.threadId||'')?{threadId:message.threadId}: {})};
  }
  return null;
 }catch{return null;}
}

const directContextFiller=[
 /^(?:hi|hey|hello|dear)(?:[\s,]+[\p{L}'’.-]+){0,4}$/iu,
 /^(?:thanks|thank you)(?: so much| very much| again| for (?:your time|the update|letting me know|reaching out))?$/i,
 /^(?:sounds|looks) (?:good|great)(?:,? thanks)?$/i,
 /^(?:i |we )?hope (?:you are|you're|you’re) (?:well|doing well)$/i,
 /^(?:i |we )?(?:am |are )?looking forward to (?:it|this|meeting|connecting|chatting)(?: with you)?$/i,
 /^(?:great|nice|good) to (?:meet|connect|chat)(?: with you)?$/i,
 /^(?:can|could|shall) we (?:meet|chat|talk|connect)(?: (?:on|at|next|this|sometime|soon)\b.{0,80})?$/i,
 /^(?:are you|would you be) (?:free|available)(?: (?:today|tomorrow|this week|next week|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)))(?: (?:morning|afternoon|evening))?$/i,
 /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at [\d: apm]{1,12})? works(?: for me| for us)?$/i,
 /^(?:i|we)(?:'ll|’ll| will| can| have|'ve|’ve)? (?:send|sent|share|shared) (?:a|the|you a|you the) (?:calendar )?invite$/i,
 /^(?:please )?use (?:this|the) link to (?:book|schedule) (?:a time|time|a call|a meeting)$/i,
];
function meaningfulDirectContext(text:string){
 const normalized=(s:string)=>s.replace(/\s+/g,' ').replace(/[.!?,:;]+$/,'').trim();
 const filler=(s:string)=>directContextFiller.some(pattern=>pattern.test(normalized(s)));
 const parts=text.split(/(?<=[.!?])\s+|\n+/).filter(s=>s.trim());
 return text.length>=24&&(text.match(/\p{L}[\p{L}\p{M}'’-]*/gu)||[]).length>=5&&!filler(text)&&!parts.every(filler);
}
/** An authored direct exchange, not a claim about who introduced the participants. */
export function extractDirectConnectionContext(message:GmailMessage,viewerEmails:string[],target:{email:string;name:string}):DirectConnectionContext|null{
 try{
  if(!message||!opaqueMessageId.test(message.id||'')||!Array.isArray(viewerEmails)||!target||typeof target.email!=='string'||typeof target.name!=='string')return null;
  const viewers=new Set(viewerEmails.filter(v=>typeof v==='string'&&emailPattern.test(v)).map(v=>v.toLowerCase()));
  const targetEmail=target.email.trim().toLowerCase(),at=Number(message.internalDate);
  if(!viewers.size||!emailPattern.test(targetEmail)||viewers.has(targetEmail)||!Number.isFinite(at)||at<=0||at>Date.now())return null;
  const headers=message.payload?.headers||[];
  if(!Array.isArray(headers)||headers.some(h=>typeof h?.name!=='string'||typeof h?.value!=='string'||h.value.length>8000))return null;
  const from=headers.filter(h=>h.name.toLowerCase()==='from');
  if(from.length!==1||headers.some(h=>['list-id','list-unsubscribe','resent-from'].includes(h.name.toLowerCase())||h.name.toLowerCase()==='auto-submitted'&&h.value.trim().toLowerCase()!=='no'||h.name.toLowerCase()==='precedence'&&/^(?:bulk|list|junk)$/i.test(h.value.trim())))return null;
  const senders=parseMessage({...message,payload:{headers:from}},'')?.participants||[];
  if(senders.length!==1)return null;
  const sender=senders[0];
  if(/^(?:no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(sender.email)||/^(?:no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(targetEmail))return null;
  const recipientsText=headers.filter(h=>['to','cc'].includes(h.name.toLowerCase())).map(h=>h.value).join(', ');
  const recipients=parseMessage({...message,payload:{headers:[{name:'From',value:recipientsText}]}},'')?.participants||[];
  const direction=viewers.has(sender.email)&&recipients.some(r=>r.email===targetEmail)?'sent':sender.email===targetEmail&&recipients.some(r=>viewers.has(r.email))?'received':null;
  if(!direction)return null;
  const subject=headers.filter(h=>h.name.toLowerCase()==='subject').map(h=>h.value).join(' ').trim();
  if(/^(?:re\s*:\s*)*(?:fwd?|fw)\s*:/i.test(subject))return null;
  const decoded=decodeGmailMessage(message,24000),parts=decoded.text.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  if(decoded.bytes>=24000)parts.pop();
  const sentences:{text:string;start:number;end:number}[]=[];let offset=0;
  for(const part of parts.slice(0,80)){const start=decoded.text.indexOf(part,offset);offset=start+part.length;sentences.push({text:part,start,end:offset});}
  for(let i=0;i<sentences.length;i++){
   const first=sentences[i];if(first.text.length>1200||!meaningfulDirectContext(first.text))continue;
   let end=first.end;
   for(let j=i+1;j<Math.min(sentences.length,i+4);j++){
    if(sentences[j].end-first.start>1200)break;
    if(meaningfulDirectContext(sentences[j].text))end=sentences[j].end;
   }
   return {direction,observedAt:new Date(at).toISOString(),subject:noAddress(subject).slice(0,160),quote:decoded.text.slice(first.start,end),messageId:message.id!,...(opaqueMessageId.test(message.threadId||'')?{threadId:message.threadId}: {})};
  }
  return null;
 }catch{return null;}
}
