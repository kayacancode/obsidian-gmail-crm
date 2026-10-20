import {parseMessage,type GmailMessage} from './mail-model';
import {decodeGmailMessage} from './gmail-body';
export interface ConnectionOriginEvidence {introducerName:string;observedAt:string;subject:string;quote:string;messageId:string;threadId?:string}
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
