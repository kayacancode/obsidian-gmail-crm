import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeGmailMessage} from '../src/gmail-body';
const part=(mimeType:string,text:string,rest={})=>({mimeType,body:{data:Buffer.from(text).toString('base64url')},...rest});
const message=(payload:any)=>({id:'m1',internalDate:'1700000000000',payload});
for(const tag of ['script','style']){
 for(const [label,whitespace] of [['U+00A0','\u00a0'],['U+000B','\u000b'],['U+2003','\u2003']]){
  test(`round2 ${tag} rejects non-HTML closing whitespace ${label}`,()=>{
   const html=`<${tag}>HIDDEN_PAYLOAD</${tag}${whitespace}>RAW_SECRET`;
   assert.throws(()=>decodeGmailMessage(message(part('text/html',html)),10000),{message:'retrieval_failed'});
  });
 }
 for(const [label,whitespace] of [['TAB','\u0009'],['LF','\u000a'],['FF','\u000c'],['CR','\u000d'],['SPACE','\u0020']]){
  test(`round2 ${tag} accepts HTML ASCII closing whitespace ${label}`,()=>{
   const html=`<${tag}>HIDDEN_PAYLOAD</${tag.toUpperCase()}${whitespace}><p>Useful text</p>`;
   assert.equal(decodeGmailMessage(message(part('text/html',html)),10000).text,'Useful text');
  });
 }
}
test('round1 base64 never materializes bytes beyond tiny or quantum-boundary budgets',()=>{
 const originalAtob=globalThis.atob,originalDecode=TextDecoder.prototype.decode;
 try{
  for(const budget of [0,1,2,3,4,5,3071,3072,3073,4096]){
   let binaryBytes=0,utf8Bytes=0;
   globalThis.atob=(value:string)=>{const decoded=originalAtob(value);binaryBytes+=decoded.length;return decoded;};
   TextDecoder.prototype.decode=function(input:any,options:any){utf8Bytes+=input?.byteLength??0;return originalDecode.call(this,input,options);};
   const result=decodeGmailMessage(message(part('text/plain','x'.repeat(6000))),budget);
   assert.ok(binaryBytes<=budget);assert.equal(utf8Bytes,budget);assert.equal(result.bytes,budget);assert.equal(result.text.length,budget);
  }
 }finally{globalThis.atob=originalAtob;TextDecoder.prototype.decode=originalDecode;}
});
test('round1 HTML script and style stay raw text despite ancestor and nested-looking tags',()=>{
 for(const html of ['<div><script>const s="</div>"; SCRIPT_PAYLOAD;</script><p>Useful</p></div>','<DIV><ScRiPt>const s="<style> </DIV>"; SCRIPT_PAYLOAD;</sCrIpT><p>Useful</p></DIV>','<div><style>p::before {content:"</div>"} STYLE_PAYLOAD</style><p>Useful</p></div>']){
  assert.equal(decodeGmailMessage(message(part('text/html',html)),10000).text,'Useful');
 }
});
test('round1 HTML malformed and unclosed raw-text regions fail closed',()=>{
 for(const html of ['<script>PAYLOAD','<style>PAYLOAD</style bad>','<script>one<script>two</script>PAYLOAD</script>','<div><script>PAYLOAD</div>','<script/>PAYLOAD','<style>PAYLOAD</STYLE-x>'])
  assert.throws(()=>decodeGmailMessage(message(part('text/html',html)),10000),{message:'retrieval_failed'});
});
test('nested MIME prefers plain text, omits attachments, quotes and signature tails',()=>{
 const decoded=decodeGmailMessage(message({mimeType:'multipart/mixed',parts:[part('text/plain','ATTACHMENT SECRET',{filename:'secret.txt'}),{mimeType:'multipart/alternative',parts:[part('text/html','HTML ALTERNATIVE'),part('text/plain','current answer\n-- \nSIGNATURE SECRET\nOn Monday wrote:\n> QUOTED SECRET')]}]}),1024);
 assert.equal(decoded.text,'current answer');assert.equal(decoded.messageId,'m1');assert.equal(decoded.internalDate,1700000000000);
 assert.ok(decoded.bytes<=1024);
});
test('HTML removes nested quote blocks, scripts, styles, trackers, links and signatures',()=>{
 const decoded=decodeGmailMessage(message(part('text/html','<style>STYLE SECRET</style><script>SCRIPT SECRET</script><p>Current &amp; useful</p><img src="https://tracker.test/pixel"><blockquote><p>QUOTE SECRET</p><blockquote>INNER QUOTE</blockquote></blockquote><div class="gmail_quote">GMAIL QUOTE</div><div class="gmail_signature">SIGNATURE SECRET</div>')),10000);
 assert.equal(decoded.text,'Current & useful');
});
test('decoder charges bytes before stripping, stops at remaining budget and does not split UTF-8',()=>{
 const d=decodeGmailMessage(message(part('text/plain','🙂'.repeat(1000))),7);
 assert.equal(d.text,'🙂');assert.equal(d.bytes,7);assert.ok(Buffer.byteLength(d.text)<=7);
 const stripped=decodeGmailMessage(message(part('text/plain','-- \n'+'SECRET '.repeat(1000))),100);
 assert.equal(stripped.text,'');assert.equal(stripped.bytes,100);
 assert.equal(decodeGmailMessage(message(part('text/plain','hello')),0).text,'');
});
test('invalid base64url, invalid dates, excessive nesting and malformed parts fail safely',()=>{
 for(const data of ['%SECRET','a','abcd=garbage','////'])assert.throws(()=>decodeGmailMessage(message({mimeType:'text/plain',body:{data}}),100),{message:'retrieval_failed'});
 assert.throws(()=>decodeGmailMessage({...message(part('text/plain','hi')),internalDate:'secret'},100),{message:'retrieval_failed'});
 let nested:any=part('text/plain','secret');for(let i=0;i<40;i++)nested={mimeType:'multipart/mixed',parts:[nested]};
 assert.throws(()=>decodeGmailMessage(message(nested),100),{message:'retrieval_failed'});
});
test('decoder rejects noncanonical padding and strips common thanks and forward tails',()=>{
 for(const data of ['YWJj=','YQ=','YQ===','Y==='])assert.throws(()=>decodeGmailMessage(message({mimeType:'text/plain',body:{data}}),100),{message:'retrieval_failed'});
 for(const tail of ['Thanks,\nAda\nCEO at Acme','---------- Forwarded message ---------\nPRIVATE HISTORY'])assert.equal(decodeGmailMessage(message(part('text/plain','Current answer\n'+tail)),1000).text,'Current answer');
});
test('HTML nesting and UTF-8 errors fail closed within the decoding budget',()=>{
 assert.throws(()=>decodeGmailMessage(message(part('text/html','<div>'.repeat(1000)+'SECRET'+'</div>'.repeat(1000))),100000),{message:'retrieval_failed'});
 assert.throws(()=>decodeGmailMessage(message({mimeType:'text/plain',body:{data:Buffer.from([0xff,0xfe]).toString('base64url')}}),100),{message:'retrieval_failed'});
});
