import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractConnectionOrigin,extractDirectConnectionContext} from '../src/connection-origin';
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

test('connection origin reads wrapped introduction sentences and keeps the original source slice',()=>{
 const participant={email:'sam@example.com',name:'Sam Park'},owner=['alex@example.com'];
 const headers={From:'Taylor Lee <taylor@example.com>',To:'Sam Park <sam@example.com>',Cc:'Alex River <alex@example.com>',Subject:'A useful connection'};
 const fixtures=[
  {text:'Adding Alex here, they coordinate visits\nfor the team.\nAlex, you should meet Sam, who leads the workshop.'},
  {text:'Adding Alex here, they coordinate visits for the team.\nAlex, you should meet\nSam, who leads the workshop.'},
  {text:'Alex —\nmeet Sam.'},
  {text:'<p>Adding <span>Alex</span> here, they coordinate visits for the team.</p><p>Alex, you should meet Sam, who leads the workshop.</p>',html:true,quote:'Adding Alex\n here, they coordinate visits for the team.\nAlex, you should meet Sam, who leads the workshop.'},
  {text:'<p>Adding Alex here, they coordinate <span>visits</span> for the team.</p><p>Alex, you should meet Sam, who leads the workshop.</p>',html:true,quote:'Adding Alex here, they coordinate visits\n for the team.\nAlex, you should meet Sam, who leads the workshop.'}
 ];
 for(const fixture of fixtures){
  const evidence=extractConnectionOrigin(message(fixture.text,headers,fixture.html?'text/html':'text/plain'),owner,participant);
  assert.equal(evidence?.introducerName,'Taylor Lee',fixture.text);
  assert.equal(evidence?.quote,fixture.quote??fixture.text);
 }
});

test('connection origin keeps wrapped future and conditional qualifiers attached to their sentences',()=>{
 const participant={email:'sam@example.com',name:'Sam Park'},owner=['alex@example.com'];
 const headers={From:'Taylor Lee <taylor@example.com>',To:'Sam Park <sam@example.com>',Cc:'Alex River <alex@example.com>',Subject:'A useful connection'};
 for(const text of [
  'Introducing you two\nnext week.',
  'Alex, meet Sam\nif you agree.',
  'Adding Alex here.\nAlex, you should meet Sam\nnext week.',
  'Adding Alex here\nif they agree.\nAlex, you should meet Sam.',
  'For example:\nAdding Alex here, they coordinate visits\nfor the team.\nAlex, you should meet Sam.',
  'Morgan wrote:\nAdding Alex here, they coordinate visits\nfor the team.\nAlex, you should meet Sam.'
 ])assert.equal(extractConnectionOrigin(message(text,headers),owner,participant),null,text);
 assert.equal(extractConnectionOrigin(message('<p>Adding Alex here.</p><p>Alex, you should meet <span>Sam</span> next week.</p>',headers,'text/html'),owner,participant),null);
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

const directTarget={email:'sam@example.com',name:'Sam Park'},directViewers=['alex@example.com','alex@work.example'];
function directMessage(text:string,headers:Record<string,string>={},mimeType='text/plain'){
 return message(text,{From:'Alex River <alex@example.com>',To:'Sam Park <sam@example.com>',Cc:'',Subject:'Workshop at Studio',...headers},mimeType);
}

test('direct connection context preserves a meaningful authored email without claiming an introduction',()=>{
 const evidence=extractDirectConnectionContext(directMessage('Hey Sam! Jordan told me you were asking about the workshop on Thursday.'),directViewers,directTarget);
 assert.deepEqual(evidence,{direction:'sent',observedAt:new Date(1700000000000).toISOString(),subject:'Workshop at Studio',quote:'Jordan told me you were asking about the workshop on Thursday.',messageId:'m1',threadId:'thread1'});
 assert.equal('introducerName' in evidence!,false);
});

test('direct connection context identifies target replies and viewer aliases from actual headers',()=>{
 const text='I can help your volunteers repair the broken sewing machines. We could start with the needle assemblies.';
 assert.equal(extractDirectConnectionContext(directMessage(text,{From:'Sam Park <sam@example.com>',To:'Alex River <alex@work.example>'}),directViewers,directTarget)?.direction,'received');
 assert.equal(extractDirectConnectionContext(directMessage(text,{From:'Alex River <alex@work.example>',To:'Team <team@example.com>',Cc:'Sam Park <sam@example.com>'}),directViewers,directTarget)?.direction,'sent');
 for(const headers of [
  {From:'Jordan <jordan@example.com>',To:'Sam Park <sam@example.com>',Cc:'Alex <alex@example.com>'},
  {To:'Someone <someone@example.com>'},
  {From:'Sam Park <sam@example.com>',To:'Someone <someone@example.com>'},
  {To:'',Bcc:'Sam Park <sam@example.com>'}
 ])assert.equal(extractDirectConnectionContext(directMessage(text,headers),directViewers,directTarget),null,JSON.stringify(headers));
});

test('connection context rejects mailbox identities disguised by display-name email addresses',()=>{
 const text='We are designing a repair program for local libraries.';
 for(const headers of [
  {From:'"Alex alex@example.com" <sender@external.example>',To:'Sam <sam@example.com>',Cc:'Alex <alex@example.com>'},
  {To:'"Sam sam@example.com" <someone@external.example>'},
  {From:'Sam <sam@example.com>',To:'"Alex alex@example.com" <someone@external.example>'},
  {From:'"Alex, alex@example.com" <sender@external.example>'},
  {From:'"alex@example.com" <invalid-mailbox>'},
  {To:'"sam@example.com"'}
 ])assert.equal(extractDirectConnectionContext(directMessage(text,headers),directViewers,directTarget),null,JSON.stringify(headers));
 const introHeaders={From:'Jordan <jordan@example.com>',To:'Alex <alex@example.com>',Cc:'Sam <sam@example.com>'};
 for(const headers of [
  {...introHeaders,From:'"Jordan jordan@example.com" <alex@example.com>'},
  {...introHeaders,To:'"Alex alex@example.com" <someone@external.example>'},
  {...introHeaders,Cc:'"Sam sam@example.com" <someone@external.example>'}
 ])assert.equal(extractConnectionOrigin(directMessage('Introducing you two.',headers),directViewers,directTarget),null,JSON.stringify(headers));
});

test('connection context permits normal quoted names and repeated identical display addresses',()=>{
 const text='We are designing a repair program for local libraries.';
 for(const headers of [
  {From:'"River, Alex" <alex@example.com>',To:'"Park, Sam" <sam@example.com>'},
  {From:'"Alex alex@example.com" <alex@example.com>',To:'"Sam sam@example.com" <sam@example.com>'},
  {From:'Alex <alex@example.com>',To:'Sam <sam@example.com>, "Lee, Jordan" <jordan@example.com>'}
 ])assert.equal(extractDirectConnectionContext(directMessage(text,headers),directViewers,directTarget)?.direction,'sent',JSON.stringify(headers));
 assert.equal(extractConnectionOrigin(directMessage('Introducing you two.',{From:'"Jordan jordan@example.com" <jordan@example.com>',To:'"River, Alex" <alex@example.com>',Cc:'"Park, Sam" <sam@example.com>'}),directViewers,directTarget)?.introducerName,'Jordan');
});

test('direct connection context skips greetings acknowledgments scheduling and quoted bodies',()=>{
 for(const text of [
  'Hey Sam!',
  'Thanks so much!',
  'Sounds good, thanks!',
  'Hope you are doing well. Looking forward to it!',
  'Can we meet on Thursday? I will send a calendar invite.',
  'Are you available tomorrow afternoon?',
  'Tuesday at 3 works for me.',
  'Please use this link to book a time: https://example.com/schedule',
  'Thanks!\nOn Monday, Jordan wrote:\nWe are designing a repair program for local libraries.',
  'Sounds good!\n> We are designing a repair program for local libraries.',
  'Best,\nAlex\nWe are designing a repair program for local libraries.'
 ])assert.equal(extractDirectConnectionContext(directMessage(text),directViewers,directTarget),null,text);
 assert.equal(extractDirectConnectionContext(directMessage('<p>Thanks!</p><blockquote>We are designing a repair program for local libraries.</blockquote>',{},'text/html'),directViewers,directTarget),null);
});

test('direct connection context rejects forwarded automated list and malformed mail',()=>{
 const text='We are designing a repair program for local libraries.';
 for(const headers of [
  {Subject:'Fwd: Workshop at Studio'},
  {Subject:'Re: Fwd: Workshop at Studio'},
  {'List-ID':'workshop.example.com'},
  {'List-Unsubscribe':'https://example.com/unsubscribe'},
  {'Auto-Submitted':'auto-generated'},
  {Precedence:'bulk'},
  {'Resent-From':'sender@example.com'}
 ])assert.equal(extractDirectConnectionContext(directMessage(text,headers),directViewers,directTarget),null,JSON.stringify(headers));
 assert.equal(extractDirectConnectionContext(directMessage(text,{From:'No Reply <noreply@example.com>',To:'Alex <alex@example.com>'}),directViewers,{email:'noreply@example.com',name:'No Reply'}),null);
 assert.equal(extractDirectConnectionContext({...directMessage(text),id:'bad@example.com'},directViewers,directTarget),null);
 assert.equal(extractDirectConnectionContext({...directMessage(text),internalDate:String(Date.now()+10000)},directViewers,directTarget),null);
 const ambiguous=directMessage(text);ambiguous.payload!.headers!.push({name:'From',value:'Jordan <jordan@example.com>'});assert.equal(extractDirectConnectionContext(ambiguous,directViewers,directTarget),null);
 const malformed=directMessage(text);malformed.payload!.body!.data='%invalid';assert.equal(extractDirectConnectionContext(malformed,directViewers,directTarget),null);
});

test('direct connection context keeps exact wrapped source bounded without raw addresses',()=>{
 const text='The repair program is intended for local libraries.\nTheir volunteers need help with sewing machines and small appliances.';
 const evidence=extractDirectConnectionContext(directMessage(text,{Subject:'Workshop with sam@example.com'}),directViewers,directTarget)!;
 assert.equal(evidence.quote,text);assert.ok(!JSON.stringify(evidence).includes('@'));
 const long=Array.from({length:60},(_,i)=>`The workshop plan includes repair session ${i} for the library volunteers.`).join(' ');
 const bounded=extractDirectConnectionContext(directMessage(long,{Subject:'a@b.co '.repeat(30)}),directViewers,directTarget)!;
 assert.ok(bounded.quote.length<=1200);assert.ok(long.includes(bounded.quote));assert.ok(bounded.subject.length<=160);
 assert.equal(extractDirectConnectionContext(directMessage('x'.repeat(24000)),directViewers,directTarget),null);
});
