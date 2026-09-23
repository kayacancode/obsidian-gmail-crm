import {EXTRACTOR_VERSION} from './theme-extractor';

export const PUBLIC_EXTRACTOR_VERSION=`public-v1:${EXTRACTOR_VERSION}`;
export type PublicSourceError='unsafe_public_source'|'public_dns_failed'|'public_redirect_limit'|'public_content_type'|'public_too_large'|'public_parse_failed'|'public_timeout'|'public_fetch_failed'|'ai_unavailable'|'invalid_extraction';
export interface PublicSourcePreview {canonicalUrl:string;publisherHost:string;visibility:'public';maxBytes:1000000;maxRedirects:3;timeoutMs:20000}
export interface PublicSourceInput {url:string;personId?:string;idempotencyKey:string;graphSource?:'mail'|'obsidian'}
export interface PublicSourceState {
 id:string;owner:string;canonicalUrl:string;publisherHost:string;personId?:string;visibility:'public';graphSource?:'mail'|'obsidian';
 status:'queued'|'running'|'complete'|'failed';generation:string;pendingRefresh?:string;dueAt:number;updatedAt:string;
 observedAt?:string;retrievedAt?:string;timeBasis?:'observed';etag?:string;lastModified?:string;contentHash?:string;
 extractorVersion:string;sourceType?:'public_url'|'public_feed';error?:PublicSourceError;
 attempts:number;textBytes:number;assertions:number;
}
/** Text exists only in transient local variables between fetch and extraction. Never return this from RPC. */
export interface PublicFetchResult {
 canonicalUrl:string;publisherHost:string;visibility:'public';notModified:boolean;
 text:string;textBytes:number;contentHash?:string;etag?:string;lastModified?:string;
 observedAt:string;retrievedAt:string;timeBasis:'observed';sourceType:'public_url'|'public_feed';
}
export type PublicCheckpoint=Pick<PublicSourceState,'etag'|'lastModified'|'contentHash'|'observedAt'|'retrievedAt'|'publisherHost'|'sourceType'>;

/** Conservative public DNS names only: even globally routable IP literals are not accepted. */
export async function previewPublicSource(value:unknown):Promise<PublicSourcePreview>{
 const u=publicURL(value);
 return {canonicalUrl:u.href,publisherHost:u.hostname,visibility:'public',maxBytes:1_000_000,maxRedirects:3,timeoutMs:20_000};
}
export function publicURL(value:unknown):URL {
 try {
  if(typeof value!=='string'||value.length>2048||/[\s\u0000-\u001f\u007f\\#]/u.test(value)||!/^https?:\/\//i.test(value))throw Error();
  const authority=value.split('/')[2];if(!authority||/[@%\[\]]/.test(authority))throw Error();
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)throw Error();
  const host=u.hostname;
  if(host.length>253||!host.includes('.')||host.endsWith('.')||/^[\d.]+$/.test(host)||!/[a-z]$/i.test(host))throw Error();
  const labels=host.split('.');
  if(labels.some(label=>!/^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/i.test(label)||['localhost','local','internal','intranet','home','lan','test','invalid','onion'].includes(label)))throw Error();
  return u;
 }catch{throw Error('unsafe_public_source');}
}

export async function withPublicDeadline<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController(),expires=Date.now()+20_000,timer=setTimeout(()=>controller.abort(),20_000);
 try{const value=await publicAwait(work(controller.signal),controller.signal);if(Date.now()>=expires)throw Error('public_timeout');return value;}finally{clearTimeout(timer);controller.abort();}
}
export function publicAwait<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const cleanup=()=>signal.removeEventListener('abort',abort);
  const abort=()=>{cleanup();reject(Error('public_timeout'));};
  signal.addEventListener('abort',abort,{once:true});
  promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(signal.aborted?Error('public_timeout'):error);});
  if(signal.aborted)abort();
 });
}
function check(signal:AbortSignal){if(signal.aborted)throw Error('public_timeout');}
export function safePublicError(error:unknown):PublicSourceError {
 const message=error instanceof Error?error.message:'';
 return ['unsafe_public_source','public_dns_failed','public_redirect_limit','public_content_type','public_too_large','public_parse_failed','public_timeout','public_fetch_failed','ai_unavailable','invalid_extraction'].includes(message)?message as PublicSourceError:'public_fetch_failed';
}

export async function fetchPublicSource(value:string,transport:typeof fetch=fetch,checkpoint?:PublicCheckpoint,signal?:AbortSignal,deadline=Date.now()+20_000):Promise<PublicFetchResult>{
 if(!signal)return withPublicDeadline(s=>fetchPublicSource(value,transport,checkpoint,s,deadline));
 let raw='';
 try {
  const canonical=publicURL(value);let target=canonical;
  for(let redirects=0;redirects<=3;redirects++){
   check(signal);
   await guardDNS(target.hostname,transport,signal);
   // Build headers anew. In particular, never forward cookies, credentials, or a caller's headers.
   const headers=new Headers({accept:'text/html, text/plain, application/rss+xml, application/atom+xml'});
   // Validators belong to the previously observed publisher only, never another redirect host.
   if(checkpoint?.publisherHost===target.hostname){if(safeETag(checkpoint.etag))headers.set('if-none-match',checkpoint.etag!);if(safeModified(checkpoint.lastModified))headers.set('if-modified-since',checkpoint.lastModified!);}
   // credentials:omit also makes injected browser-compatible transports safe. Workers
   // fetch has no ambient cookie jar and does not implement this browser option.
   const init={headers,redirect:'manual' as const,credentials:'omit' as const,signal};
   const response=await publicAwait(transport(target.href,init),signal);
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');cancelBody(response);
    if(redirects===3)throw Error('public_redirect_limit');
    if(!location)throw Error('unsafe_public_source');
    // Resolve relative references, but reject URL-parser repairs before normalization.
    if(/[\s\u0000-\u001f\u007f\\#]/u.test(location))throw Error('unsafe_public_source');
    if(/^https?:/i.test(location))publicURL(location);
    else if(location.startsWith('//'))publicURL(target.protocol+location);
    target=publicURL(new URL(location,target).href);continue;
   }
   const now=new Date().toISOString();
   if(response.status===304){
    cancelBody(response);
    if(!checkpoint?.contentHash||checkpoint.publisherHost!==target.hostname||(!headers.has('if-none-match')&&!headers.has('if-modified-since')))throw Error('public_fetch_failed');
    return {canonicalUrl:canonical.href,publisherHost:target.hostname,visibility:'public',notModified:true,text:'',textBytes:0,contentHash:checkpoint.contentHash,etag:safeETag(response.headers.get('etag'))??checkpoint.etag,lastModified:safeModified(response.headers.get('last-modified'))??checkpoint.lastModified,observedAt:checkpoint.observedAt??now,retrievedAt:now,timeBasis:'observed',sourceType:checkpoint.sourceType??'public_url'};
   }
   if(response.status!==200){cancelBody(response);throw Error('public_fetch_failed');}
   const contentType=response.headers.get('content-type')??'',mime=contentType.split(';')[0].trim().toLowerCase();
   if(!mime||!['text/html','text/plain','application/rss+xml','application/atom+xml'].includes(mime)){cancelBody(response);throw Error('public_content_type');}
   const charsets=[...contentType.matchAll(/;\s*charset\s*=\s*([^;]+)/gi)];
   if(charsets.length>1||charsets.some(match=>! /^(?:utf-8|us-ascii|"utf-8"|"us-ascii")$/i.test(match[1].trim()))){cancelBody(response);throw Error('public_content_type');}
   const charset=charsets[0]?.[1].trim().replace(/^"|"$/g,'').toLowerCase();
   const body=await readBounded(response,1_000_000,signal);raw=body.text;
   if(mime==='application/rss+xml'||mime==='application/atom+xml')validateXmlEncoding(raw,charset);
   const text=mime==='text/html'?visibleHTML(raw,signal,deadline):mime==='text/plain'?clean(raw):feedText(raw,canonical,signal,deadline);
   check(signal);
   const hash=await publicAwait(crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)),signal);
   check(signal);
   return {canonicalUrl:canonical.href,publisherHost:target.hostname,visibility:'public',notModified:false,text,textBytes:body.bytes,contentHash:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join(''),etag:safeETag(response.headers.get('etag')),lastModified:safeModified(response.headers.get('last-modified')),observedAt:now,retrievedAt:now,timeBasis:'observed',sourceType:mime==='application/rss+xml'||mime==='application/atom+xml'?'public_feed':'public_url'};
  }
  throw Error('public_redirect_limit');
 }catch(error){throw Error(safePublicError(error));}finally{raw='';}
}
function cancelBody(response:Response){void response.body?.cancel().catch(()=>{});}
async function readBounded(response:Response,limit:number,signal:AbortSignal):Promise<{text:string;bytes:number}>{
 const reader=response.body?.getReader();if(!reader)throw Error('public_parse_failed');
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let text='',bytes=0;
 try{
  while(true){check(signal);const part=await publicAwait(reader.read(),signal);if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw Error('public_too_large');text+=decoder.decode(part.value,{stream:true});}
  text+=decoder.decode();check(signal);return {text,bytes};
 }catch(error){if(signal.aborted)throw Error('public_timeout');if(error instanceof TypeError)throw Error('public_parse_failed');throw error;}
 finally{text='';void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function safeETag(value:unknown):string|undefined{return typeof value==='string'&&/^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/.test(value)?value:undefined;}
function safeModified(value:unknown):string|undefined {
 if(typeof value!=='string'||value.length>80)return;
 const time=Date.parse(value);return Number.isFinite(time)&&time>0&&time<=Date.now()?new Date(time).toUTCString():undefined;
}

/**
 * Worker fetch has no socket peer-IP inspection or general arbitrary-host DNS pinning.
 * Check both DNS families on every hop, fail closed on unknown/mixed answers, and rely
 * on the platform's public fetch egress for the final connection. This preflight cannot
 * eliminate DNS rebinding between resolution and fetch; it is not a pinned connection.
 */
async function guardDNS(host:string,transport:typeof fetch,signal:AbortSignal){
 let addresses=0;
 for(const family of ['A','AAAA']){
  const endpoint=new URL('https://cloudflare-dns.com/dns-query');endpoint.searchParams.set('name',host);endpoint.searchParams.set('type',family);
  const init={headers:{accept:'application/dns-json'},redirect:'manual' as const,credentials:'omit' as const,signal};
  const response=await publicAwait(transport(endpoint.href,init),signal);
  if(response.status!==200){cancelBody(response);throw Error('public_dns_failed');}
  let result:unknown;try{result=JSON.parse((await readBounded(response,65_536,signal)).text);}catch(error){check(signal);throw Error('public_dns_failed');}
  if(!record(result)||result.Status!==0||(result.Answer!==undefined&&!Array.isArray(result.Answer)))throw Error('public_dns_failed');
  const answers=(result.Answer??[]) as unknown[];if(answers.length>128)throw Error('public_dns_failed');
  for(const answer of answers){
   if(!record(answer)||typeof answer.data!=='string')throw Error('public_dns_failed');
   if(answer.type===5){publicURL(`https://${answer.data.replace(/\.$/,'')}/`);continue;}
   if(answer.type!==1&&answer.type!==28)throw Error('public_dns_failed');
   if(!publicAddress(answer.data))throw Error('unsafe_public_source');addresses++;
  }
 }
 if(!addresses)throw Error('public_dns_failed');
}
function publicAddress(address:string):boolean {
 if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){
  const parts=address.split('.');if(parts.some(p=>String(Number(p))!==p||Number(p)>255))return false;
  const [a,b,c]=parts.map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
 }
 // Only unambiguous native global-unicast IPv6. Transition and special-purpose
 // 2001::/23, 2002::/16, documentation 2001:db8::/32 and 3fff::/20 are excluded.
 try{if(!/^[0-9a-f:]+$/i.test(address)||new URL(`http://[${address}]/`).hostname==='')return false;
  const first=parseInt(address.split(':')[0],16),second=parseInt(address.split(':')[1]||'0',16);
  return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&(second<0x200||second===0xdb8))&&!(first===0x3fff&&second<0x1000);
 }catch{return false;}
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function clean(value:string):string{return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim();}
function entities(value:string):string {
 return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,e:string)=>{if(e.startsWith('#')){const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[e.toLowerCase()];});
}
/** Deliberately conservative tokenizer. Ambiguous/unbalanced markup fails closed. */
function visibleHTML(value:string,signal:AbortSignal,deadline:number):string {
 const stack:{tag:string;hidden:boolean}[]=[];const output:string[]=[];let pos=0,tokens=0;
 const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
 const blocked=new Set(['script','style','head','svg','math','iframe','object','template','noscript','form','nav','footer']);
 while(pos<value.length){
  if(++tokens>100_000||stack.length>64)throw Error('public_parse_failed');check(signal);if(Date.now()>=deadline)throw Error('public_timeout');
  if(value.startsWith('<!--',pos)){const end=value.indexOf('-->',pos+4);if(end<0)throw Error('public_parse_failed');pos=end+3;continue;}
  if(value[pos]!=='<'){const end=value.indexOf('<',pos),next=end<0?value.length:end;if(!stack.some(s=>s.hidden))output.push(value.slice(pos,next));pos=next;continue;}
  // Quoted attributes may contain >; find the real boundary in one linear scan.
  let end=pos+1,quote='';for(;end<value.length;end++){const char=value[end];if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;}
  if(end===value.length)throw Error('public_parse_failed');
  const token=value.slice(pos,end+1);pos=end+1;
  if(/^<!doctype html\s*>$/i.test(token))continue;
  const match=token.match(/^<(\/)?([a-z][a-z0-9-]*)([\s\S]*?)>$/i);if(!match)throw Error('public_parse_failed');
  const tag=match[2].toLowerCase(),closing=!!match[1],attrs=match[3];
  if(closing){if(attrs.trim()||stack.at(-1)?.tag!==tag)throw Error('public_parse_failed');stack.pop();output.push(' ');continue;}
  // In HTML a trailing slash does not close an ordinary element. Reject rather
  // than let hidden/template descendants escape their containing subtree.
  const selfClosing=attrs.trimEnd().endsWith('/');let svg=-1;
  for(let index=0;index<stack.length;index++)if(stack[index].tag==='svg')svg=index;
  const svgPath=selfClosing&&tag==='path'&&svg>=0&&!stack.slice(svg+1).some(item=>['foreignobject','desc','title'].includes(item.tag));
  if(selfClosing&&!voids.has(tag)&&!svgPath)throw Error('public_parse_failed');
  if(tag==='script'||tag==='style'){
   const close=new RegExp(`</${tag}[\\t\\n\\f\\r ]*>`,'ig');close.lastIndex=pos;const found=close.exec(value);if(!found)throw Error('public_parse_failed');pos=close.lastIndex;continue;
  }
  // Without a CSS renderer, inline-styled subtrees are conservatively omitted.
  const hidden=stack.some(s=>s.hidden)||blocked.has(tag)||/(?:\s|^)(?:style\s*=|hidden(?:\s|=|\/|$))|aria-hidden\s*=\s*["']?true|tracking|tracker/i.test(entities(attrs));
  if(!voids.has(tag)&&!svgPath)stack.push({tag,hidden});output.push(' ');
 }
 if(stack.length)throw Error('public_parse_failed');
 return clean(entities(output.join('')));
}

function feedText(value:string,base:URL,signal:AbortSignal,deadline:number):string {
 const stack:string[]=[],output:string[]=[];let field='',parts:string[]=[],entries=0,nodes=0,root='';
 // A constrained XML reader: no DTD/entities/external resources, attributes are inert.
 const tokens=/<\?xml[^?]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/gy;
 let position=0;
 while(position<value.length){
  check(signal);if(Date.now()>=deadline)throw Error('public_timeout');if(++nodes>100_000||stack.length>64)throw Error('public_parse_failed');tokens.lastIndex=position;const found=tokens.exec(value);if(!found)throw Error('public_parse_failed');position=tokens.lastIndex;const token=found[0];
  if(token.startsWith('<?xml')||token.startsWith('<!--'))continue;
  if(token.startsWith('<![CDATA[')){if(field)parts.push(token.slice(9,-3));continue;}
  if(!token.startsWith('<')){const decoded=xmlText(token);if(field)parts.push(decoded);else if(!stack.length&&token.trim())throw Error('public_parse_failed');continue;}
  const match=token.match(/^<(\/)?([a-z][\w:.-]*)(\s[^<>]*?|\/?)>$/i);if(!match)throw Error('public_parse_failed');
  const tag=match[2].toLowerCase(),closing=!!match[1],attrs=match[3],self=attrs.endsWith('/');
  if(closing){
   if(attrs.trim()||stack.at(-1)!==tag)throw Error('public_parse_failed');
   if(field&&tag===field){
    const text=parts.join('');
    if(['title','description','summary'].includes(field))output.push(visibleHTML(text,signal,deadline));
    else if(field==='link'){try{output.push(publicURL(new URL(text.trim(),base).href).href);}catch{/* Links are optional and never fetched. */}}
    // Publisher dates are unverified claims; intentionally use observed time instead.
    field='';parts=[];
   }
   stack.pop();continue;
  }
  xmlAttributes(self?attrs.slice(0,-1):attrs);
  if(!root){root=tag;if(!['rss','feed'].includes(root))throw Error('public_parse_failed');}else if(!stack.length)throw Error('public_parse_failed');
  if(tag==='item'||tag==='entry'){if(++entries>100)throw Error('public_parse_failed');}
  const item=stack.at(-1)==='item'||stack.at(-1)==='entry';
  if(item&&['title','description','summary','pubdate','published','updated','link'].includes(tag)){
   if(self&&tag==='link'){const href=attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);if(href)try{output.push(publicURL(new URL(entities(href[1]??href[2]),base).href).href);}catch{/* Ignore unsafe links. */}}
   else if(!self){field=tag;parts=[];}
  }else if(field)throw Error('public_parse_failed');
  if(!self)stack.push(tag);
 }
 if(stack.length||!root)throw Error('public_parse_failed');return clean(output.join(' '));
}
function validateXmlEncoding(value:string,httpCharset?:string):void {
 const declarations=[...value.matchAll(/<\?xml(?:[\x20\t\r\n][\s\S]*?)?\?>/gi)];
 if(declarations.length>1)throw Error('public_content_type');
 const declaration=declarations[0];if(!declaration)return;
 if(value.slice(0,declaration.index).replace(/^\uFEFF/,'').trim())throw Error('public_parse_failed');
 const parsed=declaration[0].match(/^<\?xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(?:"1\.[01]"|'1\.[01]')(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\t\r\n]*\?>$/);
 if(!parsed)throw Error('public_content_type');
 const encoding=(parsed[1]??parsed[2])?.toLowerCase();
 if(encoding&&!['utf-8','us-ascii'].includes(encoding)||encoding&&httpCharset&&encoding!==httpCharset)throw Error('public_content_type');
}
function xmlText(value:string):string {
 if(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(value))throw Error('public_parse_failed');
 return entities(value);
}
function xmlAttributes(value:string):void {
 const pattern=/\s+([a-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/iy,names=new Set<string>();let pos=0;
 while(pos<value.length){if(!value.slice(pos).trim())return;pattern.lastIndex=pos;const m=pattern.exec(value);if(!m||names.has(m[1]))throw Error('public_parse_failed');names.add(m[1]);xmlText(m[2]??m[3]);pos=pattern.lastIndex;}
}
