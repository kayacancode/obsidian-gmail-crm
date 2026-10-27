import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bookingNotificationKey,bookingRequestEmail} from '../src/booking-notifications';
import {defaultBookingSettings} from '../src/booking-policy';
import type {BookingRequestRecord} from '../src/booking-types';

const owner='owner@example.com';
const settings=defaultBookingSettings(owner);
const config={from:'meetings@example.com',origin:'https://people.example.com'};
function request(patch:Partial<BookingRequestRecord>={}):BookingRequestRecord{return {
 id:'request-1',owner,email:'visitor@example.com',name:'Alex Visitor',project:'Agent tools',purpose:'Discuss design partners',projectUrl:'https://project.example.com',referrer:'Jordan',
 createdAt:1,updatedAt:2,status:'pending_approval',slotStart:'2026-10-28T15:00:00.000Z',slotEnd:'2026-10-28T15:30:00.000Z',slotSource:'offered',eventId:null,idempotencyKey:'intake-key',
 decision:{tier:'review',reasons:['Owner review required.'],uncertainties:['Relationship context is unavailable.'],fit:{fit:'uncertain',reasons:[],evidence:[],model:'test'},people:{status:'unavailable',reason:'Lookup failed.'},policyRevision:1},...patch
};}

test('booking notification ignores unfinished intake, closed requests, and private scheduling',()=>{
 const ineligible:Partial<BookingRequestRecord>[]=[{slotStart:null,slotEnd:null},{slotEnd:null},{slotSource:'suggested'},{status:'booked'},{status:'booking'},{status:'declined'},{status:'async_submitted'},{status:'needs_new_slot'},{scheduling:{} as BookingRequestRecord['scheduling']},{proposedTimes:{timezone:'UTC',slots:[],revision:'p1'},slotStart:null,slotEnd:null}];
 for(const patch of ineligible){const r=request(patch);assert.equal(bookingNotificationKey(r),null);assert.equal(bookingRequestEmail(r,settings,config),null);}
 assert.ok(bookingNotificationKey(request({slotSource:undefined})), 'legacy offered slots remain eligible');
});

test('booking notification key follows the selected time and ignores unrelated record changes',()=>{
 const r=request(),before=structuredClone(r),key=bookingNotificationKey(r);
 assert.ok(key);assert.equal(bookingNotificationKey(r),key);assert.deepEqual(r,before);
 assert.equal(bookingNotificationKey(request({updatedAt:999,name:'New name'})),key);
 for(const patch of [{id:'request-2'},{slotStart:'2026-10-29T15:00:00.000Z',slotEnd:'2026-10-29T15:30:00.000Z'},{slotEnd:'2026-10-28T16:00:00.000Z'}])assert.notEqual(bookingNotificationKey(request(patch)),key);
});

test('booking notification key follows proposal revision without depending on updatedAt',()=>{
 const proposedTimes={timezone:'America/Los_Angeles',revision:'proposal-1',slots:[{start:'2026-10-28T15:00:00.000Z',end:'2026-10-28T15:30:00.000Z'}]};
 const r=request({proposedTimes,slotStart:null,slotEnd:null,slotSource:'suggested'}),before=structuredClone(r),key=bookingNotificationKey(r);
 assert.ok(key);assert.notEqual(key,bookingNotificationKey(request()));
 assert.equal(bookingNotificationKey({...r,updatedAt:1000}),key);
 assert.notEqual(bookingNotificationKey({...r,proposedTimes:{...proposedTimes,revision:'proposal-2'}}),key);
 assert.deepEqual(r,before);
});

test('booking notification sends owner-only context and a safe sign-in review link',()=>{
 const r=request({id:'request & /?approve=true'}),before=structuredClone(r);
 const email=bookingRequestEmail(r,{...settings,owner:'other@example.com'},config)!;
 assert.ok(email);assert.equal(email.to,owner);assert.equal(email.from,config.from);
 assert.equal(email.headers['Auto-Submitted'],'auto-generated');
 assert.match(email.subject,/Alex Visitor/);assert.match(email.text,/Alex Visitor/);assert.match(email.text,/visitor@example.com/);
 assert.match(email.text,/Oct 28, 2026/);assert.match(email.text,/11:00 AM/);assert.match(email.text,/11:30 AM/);assert.match(email.text,/America\/New_York/);
 for(const value of ['Agent tools','Discuss design partners','https://project.example.com','Jordan','Owner review required.','Relationship context is unavailable.'])assert.ok(email.text.includes(value),value);
 assert.match(email.text,/claimed/i);assert.match(email.text,/private/i);assert.match(email.text,/sign in.*approve or decline/i);assert.match(email.text,/not booked/i);
 const href=email.html.match(/href="([^"]+)"/)?.[1];assert.ok(href);
 const review=new URL(href);assert.equal(review.origin,config.origin);assert.equal(review.pathname,'/booking');assert.equal(review.searchParams.get('request'),r.id);assert.deepEqual([...review.searchParams.keys()],['request']);
 assert.match(email.html,/>Review request<\/a>/);assert.ok(email.text.includes(review.href));assert.deepEqual(r,before);
});

test('booking notification renders proposed alternatives in the owner timezone and labels the visitor timezone',()=>{
 const proposedTimes={timezone:'America/Los_Angeles',revision:'proposal-1',slots:[{start:'2026-10-28T15:00:00.000Z',end:'2026-10-28T15:30:00.000Z'},{start:'2026-10-29T18:00:00.000Z',end:'2026-10-29T18:30:00.000Z'}]};
 const email=bookingRequestEmail(request({proposedTimes,slotStart:null,slotEnd:null,slotSource:'suggested'}),settings,config)!;
 assert.match(email.text,/proposed alternative/i);assert.match(email.text,/Oct 28, 2026/);assert.match(email.text,/Oct 29, 2026/);assert.match(email.text,/2:00 PM/);assert.match(email.text,/America\/New_York/);assert.match(email.text,/visitor.*America\/Los_Angeles/i);
 assert.doesNotMatch(email.text,/strong fit/i);
});

test('booking notification escapes visitor content and bounds email output without adding recipient headers',()=>{
 const r=request({name:'<img src=x onerror=alert(1)>\r\nBcc: thief@example.com',project:'<script>alert("project")</script>'+ 'x'.repeat(20_000),purpose:'"quoted" & <context>'+ 'y'.repeat(20_000),projectUrl:'javascript:alert(1)',referrer:'<b>Jordan</b>\u0000'});
 r.decision.reasons=Array(100).fill('<reason>'+ 'r'.repeat(10_000));r.decision.uncertainties=Array(100).fill('<uncertain>'+ 'u'.repeat(10_000));
 const email=bookingRequestEmail(r,settings,config)!;
 assert.equal(email.to,owner);assert.doesNotMatch(email.subject,/[\r\n\x00-\x1f\x7f]/);assert.ok(email.subject.length<=180);
 assert.doesNotMatch(email.html,/<(?:script|img|b|reason|uncertain)\b/i);assert.match(email.html,/&lt;script&gt;/);assert.match(email.html,/&quot;quoted&quot; &amp; &lt;context&gt;/);
 assert.doesNotMatch(email.html,/href="javascript:/i);assert.doesNotMatch(email.text,/\u0000/);
 assert.deepEqual(Object.keys(email.headers),['Auto-Submitted']);assert.ok(email.text.length<15_000);assert.ok(email.html.length<25_000);
});

test('booking notification rejects unsafe configured review origins',()=>{
 for(const origin of ['http://people.example.com','javascript:alert(1)','https://user:pass@people.example.com','https://people.example.com/path','https://people.example.com?redirect=evil','https://people.example.com#evil','not a URL']){
  assert.throws(()=>bookingRequestEmail(request(),settings,{...config,origin}),/booking_notification_invalid_origin/,origin);
 }
 assert.ok(bookingRequestEmail(request(),settings,{...config,origin:config.origin+'/'}));
});

test('booking notification keeps an email fallback subject compact without shortening the visitor email in context',()=>{
 const visitorEmail='a'.repeat(64)+'@'+'example.'.repeat(20)+'com';
 const email=bookingRequestEmail(request({name:'',email:visitorEmail}),settings,config)!;
 assert.ok(email);assert.ok(email.subject.length<=180);assert.ok(email.text.includes(visitorEmail));
});

test('booking notification offers explicit owner replies without exposing the approval capability in the message',()=>{
 const replyTo='scheduling+b'+'a'.repeat(48)+'@example.com';
 const email=bookingRequestEmail(request(),settings,{...config,replyTo})!;
 assert.equal(email.replyTo,replyTo);
 assert.match(email.text,/1\. .*Oct 28, 2026/);
 assert.match(email.text,/reply.*[“"]Approve[”"]/i);
 assert.match(email.text,/[“"]Decline[”"]/i);
 assert.match(email.text,/from (?:your (?:owner )?email(?: address)?[,:]? )?owner@example\.com/i);
 assert.match(email.text,/booked only after.*confirm/i);
 assert.match(email.html,/Approve/);assert.match(email.html,/Decline/);assert.match(email.html,/<ol>/);
 assert.match(email.html,/>Review request<\/a>/);
 for(const value of [replyTo,'a'.repeat(48)]){
  assert.ok(!email.text.includes(value));assert.ok(!email.html.includes(value));assert.ok(!email.subject.includes(value));
 }
 assert.deepEqual(email.headers,{'Auto-Submitted':'auto-generated'});
});

test('booking notification numbers alternative times and requires an explicit numbered approval',()=>{
 const proposedTimes={timezone:'UTC',revision:'proposal-1',slots:[{start:'2026-10-28T15:00:00.000Z',end:'2026-10-28T15:30:00.000Z'},{start:'2026-10-29T18:00:00.000Z',end:'2026-10-29T18:30:00.000Z'},{start:'2026-10-30T18:00:00.000Z',end:'2026-10-30T18:30:00.000Z'}]};
 const email=bookingRequestEmail(request({proposedTimes,slotStart:null,slotEnd:null,slotSource:'suggested'}),settings,{...config,replyTo:'scheduling+b'+'0'.repeat(48)+'@example.com'})!;
 for(const [number,day] of [[1,28],[2,29],[3,30]])assert.match(email.text,new RegExp(`${number}\\. .*Oct ${day}, 2026`));
 for(const command of ['Approve 1','Approve 2','Approve 3']){assert.ok(email.text.includes(command));assert.ok(email.html.includes(command));}
 assert.match(email.text,/exactly one/i);
});

test('booking notification rejects malformed or cross-domain reply capabilities',()=>{
 const token='a'.repeat(48),valid='scheduling+b'+token+'@example.com';
 for(const replyTo of ['','owner@example.com','scheduling+'+token+'@example.com','scheduling+b'+token+'@other.example.com','scheduling+b'+token+'@example.com.evil.test','scheduling+b'+'a'.repeat(47)+'@example.com','scheduling+b'+'a'.repeat(49)+'@example.com','scheduling+b'+'g'.repeat(48)+'@example.com','Owner <'+valid+'>',valid+'\r\nBcc: thief@example.com',valid+'\n',valid+'\u0000']){
  assert.throws(()=>bookingRequestEmail(request(),settings,{...config,replyTo}),/booking_notification_invalid_reply_to/,replyTo);
 }
 assert.equal(bookingRequestEmail(request(),settings,{...config,replyTo:valid.toUpperCase()})!.replyTo,valid);
 assert.equal(bookingRequestEmail(request(),settings,config)!.replyTo,undefined);
});
