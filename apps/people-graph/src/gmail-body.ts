import type {GmailMessage, GmailPart} from './mail-model';

export interface DecodedMessage {text:string;bytes:number;internalDate:number;messageId:string}

/** Transient only. The byte charge includes content subsequently removed by sanitation. */
export function decodeGmailMessage(message:GmailMessage,remainingBytes:number):DecodedMessage {
 try {
  const date=Number(message.internalDate);
  if(!message.id||!Number.isFinite(date)||date<=0||date>Date.now()+86_400_000)throw Error();
  const budget=Math.max(0,Math.min(1_000_000,Math.floor(remainingBytes)));
  if(!Number.isFinite(budget))throw Error();
  let nodes=0;
  const leaves:GmailPart[]=[];
  function visit(part:GmailPart,depth:number){
   if(++nodes>1024||depth>20||!part||typeof part!=='object')throw Error();
   if(part.filename||part.body?.attachmentId||part.headers?.some(h=>h.name.toLowerCase()==='content-disposition'&&/^attachment\b/i.test(h.value)))return;
   if(part.parts){if(!Array.isArray(part.parts))throw Error();for(const child of part.parts)visit(child,depth+1);}
   else if(part.mimeType==='text/plain'||part.mimeType==='text/html')leaves.push(part);
  }
  if(message.payload)visit(message.payload,0);
  const selected=leaves.some(p=>p.mimeType==='text/plain')?leaves.filter(p=>p.mimeType==='text/plain'):leaves;
  let used=0;const texts:string[]=[];
  for(const part of selected){
   if(used>=budget)break;
   const data=part.body?.data;if(data===undefined)continue;
   if(typeof data!=='string'||!/^[A-Za-z0-9_-]*={0,2}$/.test(data)||data.replace(/=+$/,'').length%4===1)throw Error();
   const encoded=data.replace(/=+$/,'');
   if(data.includes('=')&&(data.length%4!==0||data.length-encoded.length!==(4-encoded.length%4)%4))throw Error();
   const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let decoded='';let consumed=0;
   const total=Math.floor(encoded.length*3/4);
   for(let pos=0;consumed<total&&used<budget;){
    const count=Math.min(3072,total-consumed,budget-used),whole=count-count%3;
    let bytes:Uint8Array;
    if(whole){
     const chars=whole/3*4,binary=atob(encoded.slice(pos,pos+chars).replace(/-/g,'+').replace(/_/g,'/'));
     bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));pos+=chars;
    }else{
     // A partial quantum must never decode/materialize its unused second/third byte.
     const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
     const a=alphabet.indexOf(encoded[pos]),b=alphabet.indexOf(encoded[pos+1]);
     bytes=new Uint8Array(count);bytes[0]=(a<<2)|(b>>4);
     if(count===2)bytes[1]=((b<<4)|alphabet.indexOf(encoded[pos+2])>>2)&255;
     pos+=count+1;
    }
    decoded+=decoder.decode(bytes,{stream:true});used+=bytes.length;consumed+=bytes.length;
   }
   if(consumed===Math.floor(encoded.length*3/4))decoded+=decoder.decode();
   texts.push(cleanText(part.mimeType==='text/html'?htmlText(decoded):decoded));
  }
  // Joining MIME sections must not add bytes beyond the caller's cap.
  const text=texts.filter(Boolean).join(' ').slice(0,budget);
  const encoded=new TextEncoder().encode(text);
  const safe=encoded.length<=budget?text:new TextDecoder().decode(encoded.subarray(0,budget)).replace(/\uFFFD$/,'');
  return {text:safe,bytes:used,internalDate:date,messageId:message.id};
 }catch{throw Error('retrieval_failed');}
}

function htmlText(html:string):string {
 const stack:{tag:string;skip:boolean}[]=[];let result='',tokens=0,rawText:string|undefined;
 // Bounded tokenizer, not a browser parser: malformed tags conservatively lose content.
 for(const token of html.match(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|[^<]+/g)??[]){
  if(++tokens>100_000||stack.length>64)throw Error('retrieval_failed');
  if(rawText){
   // HTML tag whitespace excludes Unicode spaces and vertical tab.
   if(new RegExp(`^</${rawText}[\\t\\n\\f\\r ]*>$`,'i').test(token))rawText=undefined;
   continue;
  }
  if(token.startsWith('<!--'))continue;
  if(token.startsWith('<')){
   const closing=/^<\//.test(token),tag=token.match(/^<\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();if(!tag)continue;
   if(tag==='script'||tag==='style'){
    if(closing||!token.endsWith('>'))throw Error('retrieval_failed');
    rawText=tag;continue;
   }
   if(closing){const index=stack.map(s=>s.tag).lastIndexOf(tag);if(index>=0)stack.splice(index);result+='\n';continue;}
   const skip=stack.some(s=>s.skip)||/^(script|style|blockquote|head|svg|iframe|object|template)$/.test(tag)||/gmail_quote|gmail_signature|yahoo_quoted|moz-signature|display\s*:\s*none|visibility\s*:\s*hidden/i.test(token);
   if(!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)&&!token.endsWith('/>'))stack.push({tag,skip});
   if(/^(p|div|br|li|tr|hr)$/.test(tag))result+='\n';
  }else if(!stack.some(s=>s.skip))result+=token;
 }
 if(rawText)throw Error('retrieval_failed');
 return result.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity:string)=>{
  if(entity[0]==='#'){const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';}
  return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[entity.toLowerCase()];
 });
}

function cleanText(text:string):string {
 const lines=text.replace(/\r\n?/g,'\n').split('\n');const out:string[]=[];
 for(const line of lines){
  if(/^\s*(?:--\s*$|On\s+.+wrote:|[-_]{2,}\s*(?:Original|Forwarded) message|Begin forwarded message:|Sent from my\b|(?:Best regards|Kind regards|Regards|Sincerely|Cheers|Best|Thanks|Thank you)[,!]?\s*$)/i.test(line))break;
  if(/^\s*>/.test(line))continue;
  // Token scanning is linear even for very long unbroken base64-like body text.
  out.push(line.split(/\s+/).map(word=>word.includes('@')||/^https?:\/\//i.test(word)?'':word).join(' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,''));
 }
 return out.join('\n').replace(/[ \t]+/g,' ').replace(/\n{2,}/g,'\n').trim();
}
