import PostalMime from 'postal-mime';
import {authoredSchedulingText,schedulingAddress,schedulingHeader,schedulingMailboxes,schedulingMessageId,type SchedulingInboundEmail} from './scheduling-email-policy';
import type {SchedulingEmailEnv} from './scheduling-email-coordinator';

const MAX_RAW=262144;
export function schedulingEmailConfiguration(env:Pick<SchedulingEmailEnv,'SCHEDULING_EMAIL_ADDRESS'|'SCHEDULING_EMAIL_REPLY_DOMAIN'|'SCHEDULING_EMAIL_SEND'|'BOOKING_OWNER_EMAIL'>):{owner:string;address:string;replyDomain:string}|null {
 try{
  if(!env.SCHEDULING_EMAIL_ADDRESS||!env.SCHEDULING_EMAIL_REPLY_DOMAIN||!env.SCHEDULING_EMAIL_SEND||!env.BOOKING_OWNER_EMAIL)return null;
  const address=schedulingAddress(env.SCHEDULING_EMAIL_ADDRESS),owner=schedulingAddress(env.BOOKING_OWNER_EMAIL),replyDomain=env.SCHEDULING_EMAIL_REPLY_DOMAIN.toLowerCase();
  if(schedulingAddress('scheduling@'+replyDomain)!=='scheduling@'+replyDomain||address===owner)return null;
  return {owner,address,replyDomain};
 }catch{return null;}
}
export async function parseSchedulingEmail(raw:string|ArrayBuffer,envelopeTo:string):Promise<SchedulingInboundEmail>{
 if((typeof raw==='string'?new TextEncoder().encode(raw).length:raw.byteLength)>MAX_RAW)throw Error('email_too_large');
 const parsed=await PostalMime.parse(raw,{forceRfc822Attachments:true,maxNestingDepth:12,maxHeadersSize:16384,maxPartCount:64,maxRfc822NestingDepth:0});
 const headers=parsed.headers.map(h=>({name:h.key,value:h.value}));
 const auto=schedulingHeader(headers,'auto-submitted'),precedence=schedulingHeader(headers,'precedence');
 if(auto&&auto.toLowerCase()!=='no'||/^(?:bulk|list|junk)$/i.test(precedence)||schedulingHeader(headers,'list-id')||schedulingHeader(headers,'x-autoreply')||schedulingHeader(headers,'x-autorespond'))throw Error('automatic_email_ignored');
 const from=schedulingMailboxes(schedulingHeader(headers,'from'));if(from.length!==1||/^(?:mailer-daemon|postmaster|no-?reply)@/.test(from[0]))throw Error('invalid_email_mailbox');
 if(schedulingHeader(headers,'bcc'))throw Error('invalid_email_header');
 const inReplyTo=schedulingHeader(headers,'in-reply-to'),references=schedulingHeader(headers,'references');
 const ref=references?references.split(/\s+/).map(schedulingMessageId):[];if(ref.length>30)throw Error('email_thread_too_long');
 const text=authoredSchedulingText(parsed.text??'');if(!text)throw Error('email_text_required');
 return {messageId:schedulingMessageId(schedulingHeader(headers,'message-id')),envelopeTo:schedulingAddress(envelopeTo),from:from[0],to:schedulingMailboxes(schedulingHeader(headers,'to')),cc:schedulingMailboxes(schedulingHeader(headers,'cc')),subject:(parsed.subject??'').replace(/[\r\n\x00-\x1f\x7f]/g,'').slice(0,160),text,inReplyTo:inReplyTo?schedulingMessageId(inReplyTo):null,references:ref};
}
export async function schedulingEmail(message:ForwardableEmailMessage,env:SchedulingEmailEnv):Promise<void>{
 const configuration=schedulingEmailConfiguration(env);
 if(!configuration||!env.SCHEDULING_EMAIL){message.setReject('Scheduling email is not configured.');return;}
 if(message.rawSize>MAX_RAW){message.setReject('Message is too large.');return;}
 const reader=message.raw.getReader();const chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_RAW){await reader.cancel();throw Error('email_too_large');}chunks.push(value);}
  const raw=new Uint8Array(length);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const parsed=await parseSchedulingEmail(raw.buffer,message.to);
  await env.SCHEDULING_EMAIL.getByName(configuration.owner).receive(configuration.owner,parsed);
 }catch(error){
  // Avoid reflecting message content, addresses or provider diagnostics into logs.
  if(error instanceof Error&&error.message==='automatic_email_ignored')return;
  message.setReject('This message could not be accepted for scheduling.');
 }finally{reader.releaseLock();}
}
