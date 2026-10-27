import {dkimVerify} from 'mailauth/lib/dkim/verify';
import {arc as verifyArc} from 'mailauth/lib/arc';
import {formatRelaxedLine,parseDkimHeaders,stripSignatureValue,toLineBytes} from 'mailauth/lib/tools';
import {verify as verifySignature} from 'node:crypto';
import {schedulingMailboxes,schedulingMessageId,type SchedulingInboundEmail} from './scheduling-email-policy';

const MAX_RAW=262144,MAX_HEADERS=16384,MAX_DNS_BYTES=16384,MAX_SIGNATURES=4,MAX_DNS_QUERIES=4;
const ACTION_HEADERS=['from','to','cc','message-id','in-reply-to','references','mime-version','content-type','content-transfer-encoding'];
type Header={name:string;value:string};
type DnsAnswer={name:string;type:number;data:string};
type VerificationOptions={fetch?:typeof fetch;timeoutMs?:number};
type SignatureResult=Awaited<ReturnType<typeof dkimVerify>>['results'][number];
export class SchedulingSenderAuthUnavailable extends Error {
 readonly code='scheduling_sender_auth_unavailable';
 constructor(){super('scheduling_sender_auth_unavailable');this.name='SchedulingSenderAuthUnavailable';}
}

function signaturePassed(signature:SignatureResult):boolean{
 if(signature.status.result==='pass')return true;
 // Workerd recognizes the digest name "sha256", while mailauth supplies the
 // Node/OpenSSL alias "rsa-sha256". Retry ONLY that unsupported-alias failure,
 // after the library has validated DKIM syntax, body hash and DNS key policy.
 // No other verification error may enter this compatibility path.
 if(signature.status.result!=='neutral'||signature.status.comment!=='Unknown digest: rsa-sha256'||signature.algo!=='rsa-sha256'||!signature.publicKey||!signature.signature||!signature.signingHeaders?.canonicalizedHeader||!signature.bodyHash||signature.bodyHash!==signature.bodyHashExpecting||(signature.modulusLength??0)<2048||signature.signatureTimeValid!==true||signature.canonBodyLengthLimited!==false)return false;
 const decode=(value:string)=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
 try{return verifySignature('sha256',decode(signature.signingHeaders.canonicalizedHeader),signature.publicKey,decode(signature.signature));}catch{return false;}
}
function fullSignaturePassed(signature:SignatureResult):boolean{
 return signaturePassed(signature)&&!signature.status.testing&&signature.canonBodyLengthLimited===false&&signature.signatureTimeValid!==false&&['rsa-sha256','ed25519-sha256'].includes(signature.algo??'');
}
function signedNames(signature:SignatureResult):Set<string>{return new Set(signature.signingHeaders?.headers.map(line=>line.slice(0,line.indexOf(':')).toLowerCase())??[]);}
function arcCoversDkim(ams:SignatureResult,dkim:SignatureResult):boolean{
 const canonical=atob(dkim.signingHeaders?.canonicalizedHeader??'');
 return (ams.signingHeaders?.headers??[]).filter(line=>/^dkim-signature:/i.test(line)).some(line=>{
  try{
   if(parseDkimHeaders(line).parsed?.b?.value!==dkim.signature)return false;
   const normalized=stripSignatureValue((dkim.format??'simple/simple').split('/')[0].toLowerCase()==='relaxed'?formatRelaxedLine(line):toLineBytes(line),true).toString('binary');
   // Match both the signature value and every canonicalized tag of precisely
   // the DKIM header that Google's ARC message signature actually covered.
   return canonical.endsWith('\r\n'+normalized);
  }catch{return false;}
 });
}

function headersFrom(raw:Uint8Array):Header[]{
 if(!raw.length||raw.length>MAX_RAW)throw Error('invalid_email_size');
 const prefix=String.fromCharCode(...raw.subarray(0,MAX_HEADERS+4)),end=prefix.indexOf('\r\n\r\n');
 // Email ingress has already parsed MIME, but authentication rejects ambiguous
 // bare line endings and duplicate action fields instead of guessing a parser.
 if(end<0||end>MAX_HEADERS)throw Error('invalid_email_headers');
 const lines=prefix.slice(0,end).split('\r\n'),headers:Header[]=[];
 for(const line of lines){
  if(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line))throw Error('invalid_email_headers');
  if(/^[ \t]/.test(line)){if(!headers.length)throw Error('invalid_email_headers');headers[headers.length-1].value+=' '+line.trim();continue;}
  const match=line.match(/^([!-9;-~]+):[ \t]*(.*)$/);if(!match)throw Error('invalid_email_headers');
  headers.push({name:match[1].toLowerCase(),value:match[2].trim()});if(headers.length>128)throw Error('invalid_email_headers');
 }
 for(const name of ACTION_HEADERS)if(headers.filter(header=>header.name===name).length>1)throw Error('duplicate_action_header');
 const signatures=headers.filter(header=>header.name==='dkim-signature');
 if(!signatures.length||signatures.length>MAX_SIGNATURES||headers.filter(header=>header.name.startsWith('arc-')).length>12)throw Error('invalid_signature_count');
 return headers;
}
function sameAddresses(actual:string[],expected:string[]):boolean{return actual.length===expected.length&&actual.every((address,index)=>address===expected[index]);}
function validateParsedHeaders(headers:Header[],email:SchedulingInboundEmail):void{
 const field=(name:string)=>headers.find(header=>header.name===name)?.value??'';
 if(!sameAddresses(schedulingMailboxes(field('from')),[email.from])||!sameAddresses(schedulingMailboxes(field('to')),email.to)||!sameAddresses(schedulingMailboxes(field('cc')),email.cc))throw Error('parsed_header_mismatch');
 if(schedulingMessageId(field('message-id'))!==email.messageId||!email.inReplyTo||schedulingMessageId(field('in-reply-to'))!==email.inReplyTo)throw Error('parsed_header_mismatch');
 if(![...email.to,...email.cc].includes(email.envelopeTo))throw Error('unsigned_reply_address');
 const references=field('references').split(/\s+/).filter(Boolean).map(schedulingMessageId);
 if(references.length!==email.references.length||references.some((value,index)=>value!==email.references[index]))throw Error('parsed_header_mismatch');
}
function dnsName(value:string):string{
 const normalized=value.toLowerCase().replace(/\.$/,'');
 if(normalized.length>253||!normalized.split('.').every(label=>label.length>0&&label.length<=63&&/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label)))throw Error('invalid_dns_name');
 return normalized;
}
function txtChunks(value:string):string[]{
 if(value.length>8192)throw Error('dns_key_too_large');
 const chunks:string[]=[];let pos=0,total=0;
 while(pos<value.length){
  while(value[pos]===' '||value[pos]==='\t')pos++;
  if(pos===value.length)break;if(value[pos++]!=='"')throw Error('invalid_dns_txt');
  let chunk='',closed=false;
  while(pos<value.length){
   let char=value[pos++];if(char==='"'){closed=true;break;}
   if(char==='\\'){
    const digits=value.slice(pos,pos+3);
    if(/^\d{3}$/.test(digits)){const code=Number(digits);if(code>127)throw Error('invalid_dns_txt');char=String.fromCharCode(code);pos+=3;}
    else {char=value[pos++];if(char!=='"'&&char!=='\\')throw Error('invalid_dns_txt');}
   }
   if(!char||!/^[\x20-\x7e]$/.test(char))throw Error('invalid_dns_txt');chunk+=char;
  }
  total+=chunk.length;if(!closed||total>4096||chunks.length>=32)throw Error('invalid_dns_txt');chunks.push(chunk);
 }
 if(!chunks.length)throw Error('invalid_dns_txt');return chunks;
}
async function boundedDnsJson(response:Response):Promise<unknown>{
 if(!response.ok||!response.body)throw new SchedulingSenderAuthUnavailable();
 const reader=response.body.getReader();let length=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await reader.read().catch(()=>{throw new SchedulingSenderAuthUnavailable();});if(part.done)break;length+=part.value.length;if(length>MAX_DNS_BYTES){await reader.cancel();throw Error('dns_response_too_large');}chunks.push(part.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new SchedulingSenderAuthUnavailable();}
}

/** Authenticate a guest's authored reply; a shared reply address is not identity.
 * Only the mail ingress calls this on the original bytes. Authentication-Results
 * headers are deliberately ignored because they can arrive from the sender.
 */
export async function verifySchedulingSender(raw:Uint8Array,email:SchedulingInboundEmail,options:VerificationOptions={}):Promise<string|null>{return verifySender(raw,email,options,false);}
/** ONLY for a canonical received copy fetched from the owner's authenticated
 * Gmail API. Trust comes from Google's verified ARC seal and its aligned
 * SPF/DMARC assessment, never the spelling of a Workspace default DKIM domain.
 */
export async function verifyGoogleReceivedSchedulingSender(raw:Uint8Array,email:SchedulingInboundEmail,options:VerificationOptions={}):Promise<string|null>{return verifySender(raw,email,options,true);}
async function verifySender(raw:Uint8Array,email:SchedulingInboundEmail,options:VerificationOptions,googleReceived:boolean):Promise<string|null>{
 let timeout:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
 try{
  const headers=headersFrom(raw);validateParsedHeaders(headers,email);
  const domain=email.from.slice(email.from.lastIndexOf('@')+1),required=ACTION_HEADERS.filter(name=>headers.some(header=>header.name===name));
  let queries=0,unavailable=false;const fetcher=options.fetch??fetch;
  const resolver=async(name:string,rr:string)=>{
   if(rr!=='TXT'||controller.signal.aborted||++queries>(googleReceived?8:MAX_DNS_QUERIES))throw Error('dns_lookup_limit');
   const query=dnsName(name),keyDomain=query.split('._domainkey.');
   if(keyDomain.length!==2||!(keyDomain[1]===domain||googleReceived&&(keyDomain[1]==='google.com'||keyDomain[1].endsWith('.gappssmtp.com'))))throw Error('unrelated_signing_domain');
   const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',query);url.searchParams.set('type','TXT');
   let response:Response;
   try{response=await fetcher(url,{headers:{accept:'application/dns-json'},redirect:'manual',signal:controller.signal});}catch{unavailable=true;throw new SchedulingSenderAuthUnavailable();}
   let data:{Status?:number;TC?:boolean;Question?:{name:string;type:number}[];Answer?:DnsAnswer[]};
   try{data=await boundedDnsJson(response) as typeof data;}catch(error){if(error instanceof SchedulingSenderAuthUnavailable)unavailable=true;throw error;}
   if(data.Status===2||data.Status===5){unavailable=true;throw new SchedulingSenderAuthUnavailable();}
   if(data.Status!==0||data.TC||data.Question?.length!==1||dnsName(data.Question[0].name)!==query||data.Question[0].type!==16||!Array.isArray(data.Answer)||data.Answer.length>16)throw Error('invalid_dns_answer');
   const allowed=new Set([query]);
   // The trusted recursive resolver follows CNAMEs; accept keys only on that
   // answer chain, never an unrelated TXT record from the same DNS response.
   for(let step=0;step<8;step++)for(const answer of data.Answer)if(answer.type===5&&allowed.has(dnsName(answer.name)))allowed.add(dnsName(answer.data));
   const records=data.Answer.filter(answer=>answer.type===16&&allowed.has(dnsName(answer.name))).map(answer=>txtChunks(answer.data));
   if(!records.length)throw Error('dns_no_key');return records;
  };
  const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new SchedulingSenderAuthUnavailable());},Math.min(5000,Math.max(1,options.timeoutMs??5000)));});
  // mailauth streams byte arrays into its Node-compatible Writable; preserving
  // the original bytes avoids UTF-8 decoding changing the signed MIME body.
  const verification=await Promise.race([dkimVerify(raw,{resolver,minBitLength:2048,strict:true,rejectRsaSha1:true}),deadline]);
  if(verification.fromFields!==1)return null;
  if(googleReceived){
   const chain=verification.arc,last=chain?.lastEntry,ams=last?.messageSignature;
   if(chain&&last&&ams&&last['arc-seal']?.parsed?.d?.value==='google.com'&&ams.signingDomain==='google.com'&&fullSignaturePassed(ams)){
    const signed=signedNames(ams),mime=new Set(['mime-version','content-type','content-transfer-encoding']);
    const actionsBound=required.filter(name=>!mime.has(name)).every(name=>signed.has(name));
    const missingMime=required.filter(name=>mime.has(name)&&!signed.has(name));
    // Google can omit top-level MIME headers from AMS while signing the exact
    // original DKIM header. That DKIM signature must independently validate and
    // cover every missing MIME field; changing a decoding header then fails.
    const mimeBound=!missingMime.length||verification.results.some(signature=>{
     const signer=signature.signingDomain?.toLowerCase()??'';
     return (signer===domain||signer.endsWith('.gappssmtp.com'))&&fullSignaturePassed(signature)&&missingMime.every(name=>signedNames(signature).has(name))&&arcCoversDkim(ams,signature);
    });
    if(actionsBound&&mimeBound){
     // The same guarded Workers digest-alias retry was already checked above.
     ams.status.result='pass';
     const sealed=await Promise.race([verifyArc(chain,{resolver,minBitLength:2048,strict:true}),deadline]),assessment=sealed.authenticationResults;
     if(sealed.status.result==='pass'&&assessment?.mta==='mx.google.com'&&assessment.spf?.result==='pass'&&assessment.spf.smtp?.mailfrom===email.from&&assessment.dmarc?.result==='pass'&&assessment.dmarc.header?.from===domain)return email.from;
    }
   }
  }else for(const signature of verification.results){
   if(signature.signingDomain?.toLowerCase()===domain&&fullSignaturePassed(signature)&&required.every(name=>signedNames(signature).has(name)))return email.from;
  }
  if(unavailable)throw new SchedulingSenderAuthUnavailable();return null;
 }catch(error){if(error instanceof SchedulingSenderAuthUnavailable)throw error;return null;}
 finally{if(timeout!==undefined)clearTimeout(timeout);controller.abort();}
}
