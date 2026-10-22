import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getReturningBookingContact} from '../src/booking-returning';
import {defaultBookingSettings} from '../src/booking-policy';
import type {BookingEnv,BookingVisitorIdentity} from '../src/booking-types';

const owner='owner@example.com',email='friend@example.com',now=Date.parse('2026-10-22T12:00:00Z');
const visitor:BookingVisitorIdentity={email,subject:'s'.repeat(43),emailAuthoritative:true};
const settings=()=>({...defaultBookingSettings(owner),returningContactsEnabled:true,returningScoreThreshold:70});
const contact=()=>({owner,email,name:'A Friend',score:70,checkedAt:now,sourceUpdatedAt:now-1000});
function fixture(value:unknown=contact()){
 const calls:string[]=[];
 const env={MAIL:{getByName(name:string){calls.push(name);return {async bindOwner(bound:string){calls.push(bound);},async bookingContact(address:string){calls.push(address);return value;}}}}} as unknown as BookingEnv;
 return {env,calls};
}

test('returning booking uses an exact authoritative identity and the inclusive configurable People score cutoff',async()=>{
 const {env,calls}=fixture();
 assert.deepEqual(await getReturningBookingContact(env,settings(),visitor,now),{email,name:'A Friend',score:70,lastSync:new Date(now-1000).toISOString()});
 assert.deepEqual(calls,[owner,owner,email]);
 assert.equal(await getReturningBookingContact(env,{...settings(),returningScoreThreshold:71},visitor,now),null);
 assert.ok(await getReturningBookingContact(env,{...settings(),returningScoreThreshold:69},{...visitor,email:' FRIEND@EXAMPLE.COM '},now));
});
test('returning booking does not look up disabled rules or untrusted visitor emails',async()=>{
 for(const [s,v] of [[{...settings(),returningContactsEnabled:false},visitor],[settings(),{...visitor,emailAuthoritative:false}],[settings(),{...visitor,subject:''}],[settings(),{...visitor,email:'invalid'}],[{...settings(),returningScoreThreshold:NaN},visitor]] as const){
  const {env,calls}=fixture();assert.equal(await getReturningBookingContact(env,s,v,now),null);assert.deepEqual(calls,[]);
 }
});
test('returning booking rejects stale, future, malformed and cross-owner source data',async()=>{
 const bad=[null,{},'bad',{...contact(),owner:'other@example.com'},{...contact(),email:'alias@example.com'},
  {...contact(),score:69},{...contact(),score:101},{...contact(),score:NaN},{...contact(),score:'95'},
  {...contact(),name:''},{...contact(),name:'x'.repeat(101)},{...contact(),name:'bad\u0000name'},
  {...contact(),checkedAt:now-3600000},{...contact(),checkedAt:now+600000},
  {...contact(),sourceUpdatedAt:now-86400001},{...contact(),sourceUpdatedAt:now+600000},
  {...contact(),sourceUpdatedAt:null},{...contact(),sourceUpdatedAt:'2026-10-22'}];
 for(const value of bad){assert.equal(await getReturningBookingContact(fixture(value).env,settings(),visitor,now),null,JSON.stringify(value));}
});
test('returning booking source failures fall back to normal intake without leaking errors',async()=>{
 const env={MAIL:{getByName(){throw Error('private provider details');}}} as unknown as BookingEnv;
 assert.equal(await getReturningBookingContact(env,settings(),visitor,now),null);
 assert.equal(await getReturningBookingContact({} as BookingEnv,settings(),visitor,now),null);
});
