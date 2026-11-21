import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advance,proposeIntroduction,expire,fromWorkspaceRequest,recordOutcome,type Introduction,type IntroductionStatus,type ProposalInput} from '../src/introductions';
import type {IntroductionRequest} from '../src/introduction-store';

const NOW=Date.parse('2026-11-21T12:00:00.000Z'),DAY=86_400_000;
const propose=(over:Partial<ProposalInput>={},existing:Introduction[]=[])=>proposeIntroduction({introducer:'p-john',parties:['owner','p-maya'],reason:'Both building nurse scheduling',evidence:[],...over},existing,NOW);
const walk=(intro:Introduction,steps:IntroductionStatus[])=>steps.reduce((i,to)=>advance(i,{to},NOW),intro);

test('introductions: the double opt-in path, step by step',()=>{
 const intro=propose();
 assert.equal(intro.status,'proposed');
 assert.equal(intro.startedBy,'owner');
 const made=walk(intro,['asked_introducer','introducer_accepted','target_opted_in','made']);
 assert.equal(made.status,'made');
 assert.equal(recordOutcome(made,{result:'met',note:'Coffee went well'},NOW).outcome?.result,'met');
});

test('introductions: illegal steps are refused, and the owner as introducer skips asking themselves',()=>{
 const intro=propose();
 for(const to of ['introducer_accepted','target_opted_in','made','met','proposed'] as IntroductionStatus[])
  assert.throws(()=>advance(intro,{to},NOW),/introduction_state_invalid/,to);
 assert.throws(()=>advance(walk(intro,['declined']),{to:'asked_introducer'},NOW),/introduction_state_invalid/);
 assert.throws(()=>recordOutcome(walk(intro,['asked_introducer']),{result:'met',note:null},NOW),/introduction_state_invalid/);
 const own=propose({introducer:'owner',parties:['p-ada','p-maya']});
 assert.equal(walk(own,['introducer_accepted','target_opted_in','made']).status,'made');
 assert.throws(()=>advance(own,{to:'asked_introducer'},NOW),/introduction_state_invalid/);
});

test('introductions: a vouch is the owner-introducer\'s, once they have accepted',()=>{
 const own=propose({introducer:'owner',parties:['p-ada','p-maya']});
 assert.throws(()=>advance(own,{to:'introducer_accepted',vouch:'x'.repeat(501)},NOW),/invalid_request/);
 assert.equal(advance(own,{to:'introducer_accepted',vouch:'Ada ships; Maya will like her'},NOW).vouch,'Ada ships; Maya will like her');
 assert.throws(()=>advance(propose(),{to:'asked_introducer',vouch:'mine'},NOW),/invalid_request/);
});

test('introductions: thirty quiet days expire an open introduction, on read',()=>{
 const intro=propose();
 assert.equal(expire(intro,NOW+29*DAY).status,'proposed');
 assert.equal(expire(intro,NOW+31*DAY).status,'expired');
 const made=walk(intro,['asked_introducer','introducer_accepted','target_opted_in','made']);
 assert.equal(expire(made,NOW+90*DAY).status,'made');
});

test('introductions: five open per introducer, five proposals a day',()=>{
 const asks:Introduction[]=[];
 for(let i=0;i<5;i++)asks.push({...propose({parties:['owner',`p-${i}`]},asks),createdAt:new Date(NOW-2*DAY).toISOString()});
 assert.throws(()=>propose({parties:['owner','p-6']},asks),/introduction_budget/);
 const today:Introduction[]=[];
 for(let i=0;i<5;i++)today.push(propose({introducer:`p-intro-${i}`,parties:['owner',`p-${i}`]},today));
 assert.throws(()=>propose({introducer:'p-intro-9',parties:['owner','p-9']},today),/introduction_rate_limited/);
 // Closed introductions free the budget.
 const closed=asks.map(a=>({...a,status:'declined' as const}));
 assert.equal(propose({parties:['owner','p-6']},closed).status,'proposed');
});

test('introductions: workspace requests map read-only onto three parties',()=>{
 const request:IntroductionRequest={id:'r1',workspaceId:'w1',requesterId:'m-kaya',recipientId:'m-john',clientRequestId:'c1',personId:'p-maya',message:'Would love an intro',evidenceRefs:[],state:'checking_interest',revision:2,reply:null,alternativePersonId:null,createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString()};
 const mapped=fromWorkspaceRequest(request);
 assert.deepEqual([mapped.introducer,mapped.parties,mapped.status,mapped.source,mapped.readOnly],['m-john',['m-kaya','p-maya'],'introducer_accepted','workspace',true]);
 const states:[IntroductionRequest['state'],IntroductionStatus][]=[['requested','asked_introducer'],['agreed','target_opted_in'],['completed','made'],['declined','declined'],['cancelled','declined'],['alternative_suggested','declined']];
 for(const [state,status] of states)assert.equal(fromWorkspaceRequest({...request,state}).status,status,state);
 assert.equal(fromWorkspaceRequest({...request,state:'alternative_suggested',alternativePersonId:'p-sam'}).alternativePersonId,'p-sam');
 assert.equal(mapped.vouch,null);
});
