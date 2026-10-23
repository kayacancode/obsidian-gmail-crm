import {boundedJSON} from './bounded-json';
import type {GmailMessage,GmailPart} from './mail-model';
import {authoredSchedulingText,isSchedulingKickoff,schedulingAddress,schedulingHeader,schedulingMailboxes,schedulingMessageId,type VerifiedSchedulingKickoff} from './scheduling-email-policy';

interface VerificationOptions {owner:string;agentAddress:string;messageId:string;accessToken:string;current:()=>boolean;fetch?:typeof fetch;now?:number}
function canonicalSchedulingText(message:GmailMessage):string {
 const parts:GmailPart[]=[];let nodes=0,bytes=0;
 const visit=(part:GmailPart,depth:number)=>{
  if(++nodes>64||depth>12||!part||typeof part!=='object')throw Error('invalid_owner_kickoff');
  if(part.filename||part.body?.attachmentId||part.mimeType==='message/rfc822'||part.headers?.some(h=>h.name.toLowerCase()==='content-disposition'&&/^attachment\b/i.test(h.value)))return;
  if(part.parts){if(!Array.isArray(part.parts))throw Error('invalid_owner_kickoff');for(const child of part.parts)visit(child,depth+1);}
  else if(part.mimeType==='text/plain')parts.push(part);
 };
 if(message.payload)visit(message.payload,0);
 // Gmail normally supplies a plain-text alternative. HTML-only requests need
 // clarification rather than risk hiding a constraint in rendering/quoting.
 if(!parts.length)throw Error('invalid_owner_kickoff');
 const text=parts.map(part=>{
  const data=part.body?.data;if(typeof data!=='string'||data.length>45000||! /^[A-Za-z0-9_-]*={0,2}$/.test(data))throw Error('invalid_owner_kickoff');
  const raw=Uint8Array.from(atob(data.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));bytes+=raw.length;if(bytes>32768)throw Error('invalid_owner_kickoff');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw);
 }).join('\n');
 return authoredSchedulingText(text);
}
/** The received email supplies only an ID. All authority and text comes from the
 * exact owner's Gmail SENT copy; no transit header is treated as proof of identity. */
export async function verifySentSchedulingKickoff(options:VerificationOptions):Promise<VerifiedSchedulingKickoff>{
 const id=schedulingMessageId(options.messageId),owner=schedulingAddress(options.owner),agent=schedulingAddress(options.agentAddress),now=options.now??Date.now();
 const check=()=>{if(!options.current())throw Error('scheduling_grant_revoked');};check();
 const read=async(url:URL)=>{
  check();const r=await (options.fetch??fetch)(url.href,{headers:{authorization:'Bearer '+options.accessToken},signal:AbortSignal.timeout(10000)});check();
  if(!r.ok){await r.body?.cancel();throw Error('scheduling_gmail_unavailable');}
  const data=await boundedJSON(r,262144);check();return data;
 };
 const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('q','rfc822msgid:'+id);url.searchParams.set('labelIds','SENT');url.searchParams.set('maxResults','2');
 const listing=await read(url) as {messages?:{id:string}[];nextPageToken?:string};
 if(listing.messages?.length!==1||listing.nextPageToken||! /^[A-Za-z0-9_-]{1,200}$/.test(listing.messages[0].id))throw Error('owner_kickoff_not_found');
 const gmailId=listing.messages[0].id,detail=new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailId)}`);
 detail.searchParams.set('format','full');detail.searchParams.set('fields','id,labelIds,internalDate,payload');
 const canonical=await read(detail) as GmailMessage&{labelIds?:string[]};
 try{
  const receivedAt=Number(canonical.internalDate),headers=canonical.payload?.headers??[];
  if(canonical.id!==gmailId||!canonical.labelIds?.includes('SENT')||canonical.labelIds.includes('DRAFT')||!Number.isFinite(receivedAt)||receivedAt<now-86400000||receivedAt>now+300000)throw Error();
  if(schedulingMessageId(schedulingHeader(headers,'message-id'))!==id||schedulingHeader(headers,'bcc'))throw Error();
  const from=schedulingMailboxes(schedulingHeader(headers,'from'));if(from.length!==1||from[0]!==owner)throw Error();
  const to=schedulingMailboxes(schedulingHeader(headers,'to')),cc=schedulingMailboxes(schedulingHeader(headers,'cc'));
  if(![...to,...cc].includes(agent))throw Error();
  const text=canonicalSchedulingText(canonical);
  if(!isSchedulingKickoff(text))throw Error();
  const verified={gmailId,messageId:id,owner,from:owner,to,cc,subject:schedulingHeader(headers,'subject').slice(0,160),text,receivedAt};check();return verified;
 }catch(error){if(error instanceof Error&&error.message==='scheduling_grant_revoked')throw error;throw Error('invalid_owner_kickoff');}
}
