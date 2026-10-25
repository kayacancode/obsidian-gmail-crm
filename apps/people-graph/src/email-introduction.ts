import {parseMessage,type GmailMessage} from './mail-model';
import {extractConnectionOrigin} from './connection-origin';

export interface EmailIntroductionParticipant {email:string;name:string}
export interface EmailIntroductionEvidence {
 introducer:EmailIntroductionParticipant;
 participants:[EmailIntroductionParticipant,EmailIntroductionParticipant];
 observedAt:string;
 subject:string;
 quote:string;
 messageId:string;
 threadId:string;
}

const opaqueId=/^[A-Za-z0-9_-]{1,200}$/;
const displayName=(participant:EmailIntroductionParticipant)=>({
 email:participant.email,
 name:participant.name.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,160),
});

/** Private identity-mapping evidence, never an instruction to send an introduction.
 * A result relates the two actual recipients, including when the owner sent it.
 * Co-recipients, subjects and quoted/forwarded requests alone never establish it.
 */
export function extractEmailIntroductions(message:GmailMessage):EmailIntroductionEvidence[] {
 try {
  if(!message||!opaqueId.test(message.id||'')||!opaqueId.test(message.threadId||''))return [];
  const headers=message.payload?.headers;
  if(!Array.isArray(headers)||headers.length>100||headers.some(h=>typeof h?.name!=='string'||typeof h?.value!=='string'||h.value.length>8000))return [];
  if(headers.some(h=>h.name.toLowerCase()==='bcc'&&h.value.trim()||h.name.toLowerCase()==='auto-submitted'&&h.value.trim().toLowerCase()!=='no'||h.name.toLowerCase()==='precedence'&&/^(?:bulk|list|junk)$/i.test(h.value.trim())))return [];
  const from=headers.filter(h=>h.name.toLowerCase()==='from');
  if(from.length!==1)return [];
  const senders=parseMessage({...message,payload:{headers:from}},'')?.participants||[];
  const recipientHeaders=headers.filter(h=>['to','cc'].includes(h.name.toLowerCase()));
  const recipients=parseMessage({...message,payload:{headers:[{name:'From',value:recipientHeaders.map(h=>h.value).join(', ')}]}},'')?.participants||[];
  if(senders.length!==1||recipients.length!==2||recipients.some(p=>p.email===senders[0].email))return [];
  const subject=headers.filter(h=>h.name.toLowerCase()==='subject').map(h=>h.value).join(' ').trim();
  if(/^(?:re\s*:\s*)*(?:fwd?|fw)\s*:/i.test(subject))return [];
  // Both orientations permit the existing directed "adding X; X, meet Y" form.
  // That parser also validates actual mailbox headers before trusting these roles.
  const evidence=extractConnectionOrigin(message,[recipients[0].email],recipients[1])
   ||extractConnectionOrigin(message,[recipients[1].email],recipients[0]);
  if(!evidence)return [];
  return [{introducer:displayName(senders[0]),participants:[displayName(recipients[0]),displayName(recipients[1])],
   observedAt:evidence.observedAt,subject:evidence.subject,quote:evidence.quote,messageId:evidence.messageId,threadId:message.threadId!}];
 } catch {return [];}
}
