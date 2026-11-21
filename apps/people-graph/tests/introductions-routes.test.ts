import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';
import {opaque} from '../src/mail-model';

const OWNER='owner@example.test';
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
type MachineEnv=Parameters<typeof peopleMachineRequest>[1];
const machine=(env:unknown,scopes:PeopleMemoryPrincipal['scopes'],method:string,path:string,body?:unknown)=>peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})}),env as MachineEnv,principal(scopes));
interface Intro {id:string;status:string;vouch:string|null;source:string;readOnly?:boolean;parties:string[]}

const WORKSPACE={id:'w1',name:'Studio',revision:3,members:[{id:'m-owner',email:OWNER,name:'Owner',role:'member'},{id:'m-john',email:'john@example.test',name:'John',role:'member'}]};
const REQUEST={id:'r1',workspaceId:'w1',requesterId:'m-owner',recipientId:'m-john',clientRequestId:'c1',personId:'p-sam',message:'Would love to meet Sam',evidenceRefs:[],state:'agreed',revision:2,reply:null,alternativePersonId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};

/** D1 with one shared workspace holding one introduction request from the owner. */
function workspaceDb(){
 return {prepare(sql:string){const rows=sql.includes('FROM workspaces')?[{data:JSON.stringify(WORKSPACE),revision:3}]:sql.includes('FROM introduction_requests')?[{data:JSON.stringify(REQUEST)}]:[];return {bind(){return this;},all:async()=>({results:rows}),first:async()=>rows[0]??null,run:async()=>({meta:{changes:0}})};}};
}

async function owner(){
 const f=await fixture();
 f.env.DB=workspaceDb();
 f.add('maya@acme.test','Maya Rivera');
 return {f,ada:f.personId,maya:await opaque(OWNER,'maya@acme.test',f.env.TOKEN_SECRET)};
}

test('introductions: the owner introduces two contacts, vouches, records the outcome, and the brief counts it',async()=>{
 const {f,ada,maya}=await owner();
 const proposed=await f.request('/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:'Both building nurse scheduling'});
 assert.equal(proposed.status,200,await proposed.clone().text());
 const {introduction}=await proposed.json() as {introduction:Intro};
 for(const [to,vouch] of [['introducer_accepted','Ada ships fast'],['target_opted_in',undefined],['made',undefined]] as [string,string|undefined][]){
  const step=await f.request('/api/people/introductions/advance',{id:introduction.id,to,...(vouch?{vouch}:{})});
  assert.equal(step.status,200,`${to}: ${await step.clone().text()}`);
 }
 assert.equal((await f.request('/api/people/introductions/outcome',{id:introduction.id,result:'met',note:'They are piloting together'})).status,200);
 const listed=await (await f.request('/api/people/introductions')).json() as {introductions:Intro[]};
 const own=listed.introductions.find(i=>i.id===introduction.id)!;
 assert.deepEqual([own.status,own.vouch],['met','Ada ships fast']);
 const brief=await (await f.request('/api/people/brief?personId='+encodeURIComponent(ada))).json() as {answers:{whether:{introductions:{made:number;met:number}}}[]};
 assert.deepEqual(brief.answers[0].whether.introductions,{made:1,met:1});
});

test('introductions: workspace requests appear read-only beside the owner\'s own',async()=>{
 const {f}=await owner();
 const listed=await (await f.request('/api/people/introductions')).json() as {introductions:Intro[]};
 const shared=listed.introductions.find(i=>i.source==='workspace')!;
 assert.deepEqual([shared.status,shared.readOnly,shared.parties],['target_opted_in',true,['m-owner','p-sam']]);
 assert.equal((await f.request('/api/people/introductions/advance',{id:shared.id,to:'made'})).status,404);
});

test('introductions: parties must be the owner\'s people, and the rules surface as errors',async()=>{
 const {f,ada,maya}=await owner();
 assert.equal((await f.request('/api/people/introductions',{introducer:'owner',parties:[ada,'not-a-person-id'],reason:'x'})).status,400);
 assert.equal((await f.request('/api/people/introductions',{introducer:'owner',parties:['owner',ada],reason:'x'})).status,400);
 const {introduction}=await (await f.request('/api/people/introductions',{introducer:ada,parties:['owner',maya],reason:'Ada knows Maya'})).json() as {introduction:Intro};
 const skip=await f.request('/api/people/introductions/advance',{id:introduction.id,to:'made'});
 assert.equal(skip.status,409);
 assert.deepEqual(await skip.json(),{error:'introduction_state_invalid'});
 for(let i=0;i<4;i++)await f.request('/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:`again ${i}`});
 const limited=await f.request('/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:'one too many'});
 assert.equal(limited.status,429);
});

test('introductions: machines read with people:read and record steps only with people:write',async()=>{
 const {f,ada,maya}=await owner();
 assert.equal((await machine(f.env,['people:read'],'GET','/api/people/introductions')).status,200);
 assert.equal((await machine(f.env,['people:read'],'POST','/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:'x'})).status,403);
 assert.equal((await machine(f.env,['people:read','people:write'],'POST','/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:'x'})).status,200);
});

test('introductions: made introductions reach the owner\'s graph as connectors, without vouches or the owner',async()=>{
 const {f,ada,maya}=await owner();
 const {introduction}=await (await f.request('/api/people/introductions',{introducer:'owner',parties:[ada,maya],reason:'Both building nurse scheduling'})).json() as {introduction:Intro};
 for(const [to,vouch] of [['introducer_accepted','Private vouch text'],['target_opted_in',undefined],['made',undefined]] as [string,string|undefined][])
  await f.request('/api/people/introductions/advance',{id:introduction.id,to,...(vouch?{vouch}:{})});
 const open=await (await f.request('/api/people/introductions',{introducer:ada,parties:['owner',maya],reason:'Still open'})).json() as {introduction:Intro};
 const {graph}=await (await f.request('/api/graph')).json() as {graph:{introductions?:{id:string;personIds:string[];status:string}[]}};
 assert.deepEqual(graph.introductions,[{id:introduction.id,personIds:[ada,maya],status:'made'}]);
 assert.ok(!JSON.stringify(graph).includes('Private vouch text'));
 assert.ok(!JSON.stringify(graph.introductions).includes(open.introduction.id));
});
