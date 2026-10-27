import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {dkimSign} from 'mailauth/lib/dkim/sign';
import {sealMessage} from 'mailauth/lib/arc';
import {verifySchedulingSender,verifyGoogleReceivedSchedulingSender,SchedulingSenderAuthUnavailable} from '../src/scheduling-sender-auth';
import type {SchedulingInboundEmail} from '../src/scheduling-email-policy';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const key=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
const reply='scheduling+'+'a'.repeat(48)+'@agent.example.com';
const signedHeaders=['From','To','Cc','Message-ID','In-Reply-To','References','MIME-Version','Content-Type','Content-Transfer-Encoding'];
const email:SchedulingInboundEmail={from:'shiv@limma.ai',to:[reply],cc:['berend@limma.ai','owner@example.com'],messageId:'<choice@limma.ai>',inReplyTo:'<options@agent.example.com>',references:['<options@agent.example.com>'],subject:'Meeting',text:'Option 1 works',envelopeTo:reply};
const unsigned=[
 'From: Shiv <shiv@limma.ai>',`To: ${reply}`,'Cc: berend@limma.ai, owner@example.com',
 'Message-ID: <choice@limma.ai>','In-Reply-To: <options@agent.example.com>','References: <options@agent.example.com>',
 'Subject: Meeting','MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: 7bit','','Option 1 works',''
].join('\r\n');
async function sign(options:any={},source=unsigned){const result=await dkimSign(source,{headerList:signedHeaders,signatureData:[{signingDomain:'limma.ai',selector:'test',privateKey,...options}]});assert.equal(result.errors.length,0);return result.signatures+source;}
function dns(overrides:Record<string,unknown>={}){return async(input:RequestInfo|URL)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.origin,'https://cloudflare-dns.com');assert.equal(url.searchParams.get('type'),'TXT');const name=url.searchParams.get('name');return Response.json({Status:0,TC:false,Question:[{name,type:16}],Answer:[{name,type:16,data:JSON.stringify('v=DKIM1; k=rsa; p='+key)}],...overrides});};}
const check=async(raw:string,fetcher=dns(),parsed=email)=>verifySchedulingSender(new TextEncoder().encode(raw),parsed,{fetch:fetcher as typeof fetch});
const arcHeaders=['DKIM-Signature','From','To','Cc','Message-ID','In-Reply-To','References','MIME-Version'];
async function googleReceived(options:{authResults?:string;arcDomain?:string;headerList?:string[];dkimHeaders?:string[];source?:string}={}){
 const dkim=await sign({signingDomain:'limma-ai.20251104.gappssmtp.com',headerList:options.dkimHeaders??signedHeaders},options.source??unsigned);
 const seal=await sealMessage(dkim,{signingDomain:options.arcDomain??'google.com',selector:'arc-test',privateKey,headerList:options.headerList??arcHeaders,authResults:options.authResults??'mx.google.com; spf=pass smtp.mailfrom=shiv@limma.ai; dmarc=pass header.from=limma.ai'});
 assert.ok(seal.length);return seal.toString()+dkim;
}
const checkGoogle=async(raw:string,fetcher=dns())=>verifyGoogleReceivedSchedulingSender(new TextEncoder().encode(raw),email,{fetch:fetcher as typeof fetch});

test('shared scheduling sender verifies a full aligned DKIM signature with signed action headers',async()=>{
 assert.equal(await check(await sign()),'shiv@limma.ai');
 assert.equal(await check(await sign({canonicalization:'simple/simple'})),'shiv@limma.ai');
});
test('shared scheduling sender ignores forged authentication results and rejects changed signed content',async()=>{
 assert.equal(await check('Authentication-Results: mx.cloudflare.net; dkim=pass header.d=limma.ai\r\n'+unsigned),null);
 const raw=await sign();
 for(const changed of [raw.replace('Option 1 works','Option 2 works'),raw.replace('Shiv <shiv@limma.ai>','Berend <berend@limma.ai>'),raw.replace('<options@agent.example.com>','<different@agent.example.com>'),raw.replace('<choice@limma.ai>','<different@limma.ai>'),raw.replace(reply,reply.replace('a','b')),raw.replace('7bit','base64')])assert.equal(await check(changed),null);
});
test('shared scheduling sender rejects unsigned routing and action headers, body limits and unrelated signers',async()=>{
 for(const omit of ['From','To','Cc','Message-ID','In-Reply-To','References','Content-Type','Content-Transfer-Encoding']){
  // mailauth itself refuses signing without From; keep a valid From signature to test each other omission.
  if(omit==='From')continue;
  assert.equal(await check(await sign({headerList:signedHeaders.filter(h=>h!==omit)})),null,omit);
 }
 assert.equal(await check(await sign({maxBodyLength:5})),null);
 assert.equal(await check(await sign({signingDomain:'unrelated.example'})),null);
 assert.equal(await check(await sign({signingDomain:'sub.limma.ai'})),null);
});
test('shared scheduling sender rejects duplicate critical headers and mismatched parsed identity',async()=>{
 const raw=await sign();
 for(const header of ['From: Berend <berend@limma.ai>','To: outsider@example.com','Message-ID: <added@limma.ai>','In-Reply-To: <added@limma.ai>','Content-Type: text/html'])assert.equal(await check(header+'\r\n'+raw),null);
 assert.equal(await check(raw,dns(),{...email,from:'berend@limma.ai'}),null);
 assert.equal(await check(raw,dns(),{...email,inReplyTo:'<other@agent.example.com>'}),null);
});
test('shared scheduling sender fails closed on DNS errors, unbound answers and oversize data',async()=>{
 const raw=await sign();
 for(const values of [{Status:3},{TC:true},{Answer:[{name:'other._domainkey.limma.ai',type:16,data:JSON.stringify('v=DKIM1; k=rsa; p='+key)}]},{Question:[{name:'wrong.example',type:16}]}])assert.equal(await check(raw,dns(values)),null);
 assert.equal(await check(raw,async()=>new Response('x'.repeat(17000))),null);
 await assert.rejects(check(raw,async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example'}})),SchedulingSenderAuthUnavailable);
 await assert.rejects(check(raw,async()=>{throw Error('network');}),SchedulingSenderAuthUnavailable);
 for(const Status of [2,5])await assert.rejects(check(raw,dns({Status})),SchedulingSenderAuthUnavailable);
 await assert.rejects(verifySchedulingSender(new TextEncoder().encode(raw),email,{fetch:(async(_input,init)=>new Promise((_,reject)=>{init?.signal?.addEventListener('abort',()=>reject(Error('aborted')));})) as typeof fetch,timeoutMs:10}),SchedulingSenderAuthUnavailable);
});
test('shared scheduling sender accepts split TXT keys through a resolver CNAME and rejects expired signatures',async()=>{
 const raw=await sign();
 assert.equal(await check(raw,dns({Answer:[{name:'test._domainkey.limma.ai',type:5,data:'keys.example.net.'},{name:'keys.example.net.',type:16,data:JSON.stringify('v=DKIM1; k=rsa; p='+key.slice(0,150))+' '+JSON.stringify(key.slice(150))}]})),'shiv@limma.ai');
 const expired=await dkimSign(unsigned,{headerList:signedHeaders,signTime:new Date(Date.now()-120000),expires:new Date(Date.now()-60000),signatureData:[{signingDomain:'limma.ai',selector:'test',privateKey}]});
 assert.equal(expired.errors.length,0);assert.equal(await check(expired.signatures+unsigned),null);
});
test('shared scheduling sender bounds raw size and signature count before DNS',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected DNS');};
 assert.equal(await check(unsigned+'x'.repeat(262144),fetcher),null);
 const raw=await sign(),signature=raw.slice(0,raw.indexOf('From:'));
 assert.equal(await check(signature.repeat(5)+unsigned,fetcher),null);assert.equal(calls,0);
});
test('canonical Gmail sender requires a valid Google ARC seal and aligned authenticated sender, not gappssmtp spelling',async()=>{
 const raw=await googleReceived();assert.equal(await checkGoogle(raw),'shiv@limma.ai');
 assert.equal(await check(await sign({signingDomain:'limma-ai.20251104.gappssmtp.com'})),null);
 for(const authResults of ['mx.google.com; spf=pass smtp.mailfrom=other@limma.ai; dmarc=pass header.from=limma.ai','mx.google.com; spf=fail smtp.mailfrom=shiv@limma.ai; dmarc=pass header.from=limma.ai','mx.google.com; spf=pass smtp.mailfrom=shiv@limma.ai; dmarc=fail header.from=limma.ai','mx.attacker.test; spf=pass smtp.mailfrom=shiv@limma.ai; dmarc=pass header.from=limma.ai'])assert.equal(await checkGoogle(await googleReceived({authResults})),null);
 assert.equal(await checkGoogle(await googleReceived({arcDomain:'attacker.test'})),null);
 assert.equal(await checkGoogle('Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=shiv@limma.ai; dmarc=pass header.from=limma.ai\r\n'+await googleReceived({authResults:'mx.google.com; arc=none'})),null);
});
test('canonical Gmail sender binds unsigned MIME headers through the exact DKIM signature covered by ARC',async()=>{
 const raw=await googleReceived();
 for(const changed of [raw.replace('Option 1 works','Option 2 works'),raw.replace('Content-Type: text/plain; charset=utf-8','Content-Type: text/html; charset=utf-8'),raw.replace('Content-Transfer-Encoding: 7bit','Content-Transfer-Encoding: base64'),raw.replace('spf=pass smtp.mailfrom=shiv@limma.ai','spf=pass smtp.mailfrom=berend@limma.ai')])assert.equal(await checkGoogle(changed),null);
 assert.equal(await checkGoogle(await googleReceived({headerList:arcHeaders.filter(name=>name!=='DKIM-Signature')})),null);
 assert.equal(await checkGoogle(await googleReceived({dkimHeaders:signedHeaders.filter(name=>name!=='Content-Type')})),null);
 assert.equal(await checkGoogle(await googleReceived({headerList:arcHeaders.filter(name=>name!=='In-Reply-To')})),null);
});
test('canonical Gmail sender validates both Google ARC seals on an outbound plus received chain',async()=>{
 const original=await googleReceived({authResults:'mx.google.com; arc=none'});
 const seal=await sealMessage(original,{signingDomain:'google.com',selector:'arc-test',privateKey,headerList:arcHeaders,cv:'pass',authResults:'mx.google.com; spf=pass smtp.mailfrom=shiv@limma.ai; dmarc=pass header.from=limma.ai'});
 const raw=seal.toString()+original;
 assert.match(raw,/ARC-Seal: i=2;/);assert.equal(await checkGoogle(raw),'shiv@limma.ai');
 assert.equal(await checkGoogle(raw.replace('arc=none','arc=pass')),null);
 assert.equal(await checkGoogle(raw.replace('cv=pass','cv=fail')),null);
 await assert.rejects(checkGoogle(raw,dns({Status:2})),SchedulingSenderAuthUnavailable);
});
