import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractConnectionOrigin} from '../src/connection-origin';
import type {GmailMessage} from '../src/mail-model';
const target={email:'marie@example.com',name:'Marie Chen'},viewers=['kaya@example.com','kaya@work.example'];
function message(text:string,headers:Record<string,string>={},mimeType='text/plain'):GmailMessage{
 return {id:'m1',threadId:'thread1',internalDate:'1700000000000',payload:{mimeType,headers:Object.entries({From:'Analisa Park <analisa@example.com>',To:'Kaya Jones <kaya@example.com>',Cc:'Marie Chen <marie@example.com>',Subject:'Kaya <> Marie',...headers}).map(([name,value])=>({name,value})),body:{data:Buffer.from(text).toString('base64url')}}};
}

test('connection origin recognizes a named current introduction by the actual email sender',()=>{
 const text='Kaya, meet Marie. Marie is building scheduling software for nurses.';
 assert.deepEqual(extractConnectionOrigin(message(text),viewers,target),{introducerName:'Analisa Park',observedAt:new Date(1700000000000).toISOString(),subject:'Kaya <> Marie',quote:'Kaya, meet Marie.',messageId:'m1',threadId:'thread1'});
});

test('connection origin accepts bounded two-recipient introduction phrases and viewer aliases',()=>{
 for(const text of ['Introducing you two.','Connecting you two.','Making the intro here.','I wanted to connect you both.','Wanted to connect you both.','Hi Kaya and Marie,\nI am introducing you two.','Marie, meet Kaya.','Kaya Jones, please meet Marie Chen.','Kaya — meet Marie.']){
  const found=extractConnectionOrigin(message(text,{To:'Kaya Jones <kaya@work.example>',Cc:'Marie Chen <marie@example.com>, Kaya <kaya@example.com>'}),viewers,target);
  assert.equal(found?.introducerName,'Analisa Park',text);assert.ok(found?.quote&&text.includes(found.quote));
 }
});

test('connection origin recognizes adding a recipient followed by a directed named introduction',()=>{
 const participant={email:'sam@example.com',name:'Sam Park'},owner=['alex@example.com'];
 const headers={From:'Taylor Lee <taylor@example.com>',To:'Sam Park <sam@example.com>',Cc:'Alex River <alex@example.com>',Subject:'A useful connection'};
 for(const recommendation of ['@Alex you should meet Sam, who runs the repair workshop.','Alex, you should meet Sam Park, who runs the repair workshop.']){
  const addition='Adding Alex here, they return on Friday and can arrange a call.';
  const evidence=extractConnectionOrigin(message(`${addition}\n\n${recommendation}`,headers),owner,participant);
  assert.equal(evidence?.introducerName,'Taylor Lee',recommendation);
  assert.equal(evidence?.quote,`${addition}\n${recommendation.replace('@Alex','')}`);
 }
});

test('connection origin does not count adding or a recommendation without both introduction anchors',()=>{
 const participant={email:'sam@example.com',name:'Sam Park'},owner=['alex@example.com'];
 const headers={From:'Taylor Lee <taylor@example.com>',To:'Sam Park <sam@example.com>',Cc:'Alex River <alex@example.com>',Subject:'A useful connection'};
 for(const text of [
  'Adding Alex here.',
  '@Alex you should meet Sam, who runs the repair workshop.',
  'Adding Morgan here.\nAlex, you should meet Sam.',
  'Adding Alex here.\nMorgan, you should meet Sam.',
  'Adding Alex here.\nAlex, you should meet Sasha.',
  'I will be adding Alex here.\nAlex, you should meet Sam.',
  'Adding Alex here if they agree.\nAlex, you should meet Sam.',
  'Adding Alex here.\nAlex, you should meet Sam next week.',
  'If you agree.\nAdding Alex here.\nAlex, you should meet Sam.',
  'An example:\nAdding Alex here.\nAlex, you should meet Sam.',
  'Morgan wrote:\nAdding Alex here.\nAlex, you should meet Sam.',
  'Adding Alex here.\nMorgan wrote:\nAlex, you should meet Sam.',
  'Adding Alex here.\n> Alex, you should meet Sam.',
  'Adding Alex here.\nOn Monday, Morgan wrote:\nAlex, you should meet Sam.'
 ])assert.equal(extractConnectionOrigin(message(text,headers),owner,participant),null,text);
});

test('connection origin does not infer introductions from subject or shared recipients',()=>{
 for(const text of ['Looking forward to the demo.','Great to meet you two.','Your onboarding looks useful.','Can you introduce me to Marie?','Would you introduce Kaya to Marie?','Thanks for introducing us.','John introduced Kaya to Marie.','I met Marie through John.'])assert.equal(extractConnectionOrigin(message(text,{Subject:'Introduction: Kaya and Marie'}),viewers,target),null,text);
});

test('connection origin rejects promises, requests, hypotheticals and negated introductions',()=>{
 for(const text of ["I'll introduce you two next week.",'I wanted to connect you both next week.','I wanted to connect you both, but Marie declined.','I did not introduce you two.','If it helps, Kaya, meet Marie.','Please write: Kaya, meet Marie.','For example: Kaya, meet Marie.','Can you say “Kaya, meet Marie”?','I wanted to connect you both if you are interested.','If you both agree.\nMaking the intro here.','John wrote:\nKaya, meet Marie.','Here is a sample:\nIntroducing you two.'])assert.equal(extractConnectionOrigin(message(text),viewers,target),null,text);
});

test('connection origin requires both identities in To or Cc and no unrelated third recipient',()=>{
 for(const headers of [{Cc:''},{To:'Someone <someone@example.com>'},{Cc:'Marie <marie@example.com>, Bob <bob@example.com>'},{To:'Kaya <kaya@example.com>',Cc:'Wrong Marie <other@example.com>'},{To:'Kaya <kaya@example.com>',Cc:'',Bcc:'Marie <marie@example.com>'}])assert.equal(extractConnectionOrigin(message('Introducing you two.',headers),viewers,target),null,JSON.stringify(headers));
});

test('connection origin rejects viewer target and automated senders',()=>{
 for(const from of ['Kaya <kaya@example.com>','Kaya <kaya@work.example>','Marie <marie@example.com>','No Reply <noreply@example.com>'])assert.equal(extractConnectionOrigin(message('Introducing you two.',{From:from}),viewers,target),null,from);
 assert.equal(extractConnectionOrigin(message('Introducing you two.',{'List-ID':'product.example.com'}),viewers,target),null);
});

test('connection origin ignores forwarded quoted and signature introductions',()=>{
 for(const text of ['Please see below.\nOn Monday, Analisa wrote:\nKaya, meet Marie.','Forwarding this.\n---------- Forwarded message ---------\nKaya, meet Marie.','A reply.\n> Kaya, meet Marie.','A reply.\n--\nKaya, meet Marie.'])assert.equal(extractConnectionOrigin(message(text),viewers,target),null,text);
 assert.equal(extractConnectionOrigin(message('<p>A reply.</p><blockquote>Kaya, meet Marie.</blockquote>',{},'text/html'),viewers,target),null);
 assert.equal(extractConnectionOrigin(message('Kaya, meet Marie.',{Subject:'Fwd: Introduction'}),viewers,target),null);
});

test('connection origin matches target name from headers but never an unrelated named pair',()=>{
 assert.equal(extractConnectionOrigin(message('Kaya, meet Marie.'),viewers,{email:target.email,name:'marie@example.com'})?.introducerName,'Analisa Park');
 for(const text of ['Kaya, meet Bob.','Alice, meet Marie.','Kaya, meet Marielle.'])assert.equal(extractConnectionOrigin(message(text),viewers,target),null,text);
});

test('connection origin keeps source evidence bounded and contains no raw addresses',()=>{
 const evidence=extractConnectionOrigin(message('Kaya, meet Marie.',{Subject:'Intro kaya@example.com to marie@example.com',From:'analisa@example.com'}),viewers,target)!;
 assert.equal(evidence.introducerName,'analisa');assert.ok(!JSON.stringify(evidence).includes('@'));assert.ok(evidence.quote.length<=500);
 const longSubject=extractConnectionOrigin(message('Kaya, meet Marie.',{Subject:'a@b.co '.repeat(30)}),viewers,target)!;assert.ok(longSubject.subject.length<=160);
});

test('connection origin fails closed for malformed bodies headers and dates',()=>{
 assert.equal(extractConnectionOrigin({...message('Kaya, meet Marie.'),internalDate:String(Date.now()+10000)},viewers,target),null);
 assert.equal(extractConnectionOrigin({...message('Kaya, meet Marie.'),id:'bad@example.com'},viewers,target),null);
 const malformed=message('Kaya, meet Marie.');malformed.payload!.body!.data='%invalid';assert.equal(extractConnectionOrigin(malformed,viewers,target),null);
 const ambiguous=message('Kaya, meet Marie.');ambiguous.payload!.headers!.push({name:'From',value:'John <john@example.com>'});assert.equal(extractConnectionOrigin(ambiguous,viewers,target),null);
 const prefix='Kaya, meet Marie';assert.equal(extractConnectionOrigin(message(' '.repeat(24000-prefix.length)+prefix+' next week.'),viewers,target),null,'A body byte limit must not turn a truncated future promise into a current introduction');
});
