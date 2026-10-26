import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractEmailIntroductions} from '../src/email-introduction';
import type {GmailMessage} from '../src/mail-model';

function message(text:string,headers:Record<string,string>={},mimeType='text/plain'):GmailMessage {
 return {id:'message1',threadId:'thread1',internalDate:'1700000000000',payload:{mimeType,
  headers:Object.entries({From:'Morgan Vale <morgan@example.com>',To:'Alex River <alex@example.com>',Cc:'Sam Park <sam@example.com>',Subject:'A useful connection',...headers}).map(([name,value])=>({name,value})),
  body:{data:Buffer.from(text).toString('base64url')}}};
}

test('email introduction extracts an actual sender and two recipients from the source message',()=>{
 assert.deepEqual(extractEmailIntroductions(message('Alex, meet Sam. Sam is designing a repair workshop.')),[{
  introducer:{email:'morgan@example.com',name:'Morgan Vale'},
  participants:[{email:'alex@example.com',name:'Alex River'},{email:'sam@example.com',name:'Sam Park'}],
  observedAt:new Date(1700000000000).toISOString(),subject:'A useful connection',quote:'Alex, meet Sam.',messageId:'message1',threadId:'thread1'
 }]);
});

test('email introduction includes owner-sent introductions without requiring the owner as a recipient',()=>{
 const result=extractEmailIntroductions(message('Connecting you both.',{From:'Owner <owner@example.com>'}));
 assert.equal(result.length,1);
 assert.equal(result[0].introducer.email,'owner@example.com');
 assert.deepEqual(result[0].participants.map(p=>p.email),['alex@example.com','sam@example.com']);
});

test('email introduction accepts either recipient direction and deduplicates repeated To and Cc mailboxes',()=>{
 for(const [text,headers] of [
  ['Sam, meet Alex.',{}],
  ['Adding Sam here. Sam, you should meet Alex, who runs the workshop.',{}],
  ['Introducing you two.',{To:'Sam Park <SAM@example.com>, Alex River <alex@example.com>',Cc:'Sam <sam@example.com>'}],
  ['Making the intro here.',{To:'',Cc:'Alex River <alex@example.com>, Sam Park <sam@example.com>'}],
 ] as [string,Record<string,string>][]){
  const result=extractEmailIntroductions(message(text,headers));
  assert.equal(result.length,1,text);
  assert.deepEqual(new Set(result[0].participants.map(p=>p.email)),new Set(['alex@example.com','sam@example.com']));
 }
});

test('email introduction never treats subjects, shared recipients, promises or quoted text as introductions',()=>{
 for(const text of [
  'The workshop is scheduled for Friday.',
  'Thanks for introducing us.',
  'I will introduce you two next week.',
  'Connecting you both if you agree.',
  'Alex, meet Sam next week.',
  'Can you introduce me to Sam?',
  'An example:\nAlex, meet Sam.',
  'Morgan wrote:\nIntroducing you two.',
  'See below.\n> Alex, meet Sam.',
  'See below.\nOn Monday, Morgan wrote:\nIntroducing you two.',
  'See below.\n---------- Forwarded message ---------\nIntroducing you two.',
  'See below.\n--\nIntroducing you two.',
 ])assert.deepEqual(extractEmailIntroductions(message(text,{Subject:'Introduction: Alex and Sam'})),[],text);
 assert.deepEqual(extractEmailIntroductions(message('<p>See below.</p><blockquote>Introducing you two.</blockquote>',{},'text/html')),[]);
 for(const Subject of ['Fwd: A useful connection','Re: Fwd: A useful connection'])assert.deepEqual(extractEmailIntroductions(message('Introducing you two.',{Subject})),[]);
});

test('email introduction rejects ambiguous recipients, sender self-copies and hidden participants',()=>{
 for(const headers of [
  {Cc:''},
  {Cc:'Sam <sam@example.com>, Riley <riley@example.com>'},
  {Cc:'Sam <sam@example.com>, Morgan <morgan@example.com>'},
  {To:'Morgan <morgan@example.com>'},
  {Cc:'',Bcc:'Sam <sam@example.com>'},
  {Bcc:'Riley <riley@example.com>'},
 ])assert.deepEqual(extractEmailIntroductions(message('Introducing you two.',headers)),[],JSON.stringify(headers));
});

test('email introduction rejects automated, ambiguous or spoofed sender and recipient headers',()=>{
 for(const headers of [
  {From:'No Reply <noreply@example.com>'},
  {From:'Morgan <morgan@example.com>, Riley <riley@example.com>'},
  {From:'"Morgan morgan@example.com" <other@example.com>'},
  {To:'"Alex alex@example.com" <other@example.com>'},
  {'List-ID':'workshop.example.com'},
  {'Auto-Submitted':'auto-replied'},
  {'Precedence':'bulk'},
 ])assert.deepEqual(extractEmailIntroductions(message('Introducing you two.',headers)),[],JSON.stringify(headers));
 const duplicate=message('Introducing you two.');duplicate.payload!.headers!.push({name:'From',value:'Riley <riley@example.com>'});
 assert.deepEqual(extractEmailIntroductions(duplicate),[]);
});

test('email introduction requires valid message and thread provenance and a nonfuture date',()=>{
 for(const overrides of [{threadId:undefined},{threadId:'bad@source.example'},{id:'bad@source.example'},{internalDate:String(Date.now()+60000)},{internalDate:'not-a-date'}]){
  assert.deepEqual(extractEmailIntroductions({...message('Introducing you two.'),...overrides}),[]);
 }
 const malformed=message('Introducing you two.');malformed.payload!.body!.data='%invalid';
 assert.deepEqual(extractEmailIntroductions(malformed),[]);
});

test('email introduction keeps returned excerpts bounded and display text free of raw addresses',()=>{
 const [result]=extractEmailIntroductions(message('Introducing you two, alex@example.com and sam@example.com.',{Subject:'A connection alex@example.com to sam@example.com',From:'morgan@example.com'}));
 assert.ok(result);
 assert.equal(result.introducer.name,'morgan');
 for(const text of [result.introducer.name,result.subject,result.quote,...result.participants.map(p=>p.name)])assert.ok(!text.includes('@'));
 assert.ok(result.quote.length<=1200);
 assert.ok(result.subject.length<=160);
 assert.equal(extractEmailIntroductions(message('Introducing you two. '.repeat(1000))).length,1);
 assert.deepEqual(extractEmailIntroductions(message(' '.repeat(23980)+'Introducing you two next week.')),[]);
});
