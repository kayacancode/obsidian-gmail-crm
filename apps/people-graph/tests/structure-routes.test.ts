import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';
import {opaque} from '../src/mail-model';

const OWNER='owner@example.test',DAY=86_400_000;
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});

/** Maya wrote yesterday and the owner has not replied; Bo is suppressed but also waiting. */
async function waiting(){
 const f=await fixture();
 const received=(email:string,name:string,thread:string)=>f.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('inbox@example.test',thread,email,name,Date.now()-DAY,'Quick question',0,1);
 received('maya@acme.test','Maya Rivera','thread-maya');
 received('bo@example.test','Bo','thread-bo');
 const maya=await opaque(OWNER,'maya@acme.test',f.env.TOKEN_SECRET),bo=await opaque(OWNER,'bo@example.test',f.env.TOKEN_SECRET);
 await f.service.setPersonFeedback(bo,'suppress');
 return {f,maya,bo};
}

test('structure routes: why-now finds who is waiting on a reply, never suppressed people',async()=>{
 const {f,maya,bo}=await waiting();
 const result=await f.service.whyNow(10);
 assert.equal(result.interpretation,null);
 const answer=result.answers.find(a=>a.personId===maya);
 assert.ok(answer,JSON.stringify(result));
 assert.deepEqual(answer.why.map(w=>w.trigger),['owes_reply']);
 assert.ok(!result.answers.some(a=>a.personId===bo));
});

test('structure routes: why-now is a read route for sessions and read-only machines',async()=>{
 const {f,maya}=await waiting();
 const session=await f.request('/api/people/why-now?limit=5');
 assert.equal(session.status,200);
 assert.ok(((await session.json()) as {answers:{personId:string}[]}).answers.some(a=>a.personId===maya));
 const machine=await peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'GET',path:'/api/people/why-now'})}),f.env as Parameters<typeof peopleMachineRequest>[1],principal(['people:read']));
 assert.equal(machine.status,200);
 assert.equal((await f.request('/api/people/why-now?limit=0')).status,400);
 assert.equal((await f.request('/api/people/why-now?other=1')).status,400);
});

test('structure routes: contrast, widen and bridges answer with the shared envelope and validate input',async()=>{
 const {f}=await waiting();
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 for(const path of ['/api/people/contrast?topic=acme','/api/people/contrast?topic=acme&claim=nobody%20pays','/api/people/widen','/api/people/bridges','/api/people/bridges?topic=quick']){
  const response=await f.request(path);
  assert.equal(response.status,200,path);
  const body=await response.json() as Record<string,unknown>;
  assert.deepEqual(Object.keys(body).sort(),['answers','gaps','interpretation','result'],path);
 }
 const widen=await (await f.request('/api/people/widen')).json() as {gaps:string[]};
 assert.match(widen.gaps.join(),/Not enough recent activity/);
 for(const path of ['/api/people/contrast','/api/people/contrast?topic=','/api/people/widen?x=1','/api/people/bridges?topic='+'x'.repeat(201)])
  assert.equal((await f.request(path)).status,400,path);
 for(const path of ['/api/people/contrast?topic=acme','/api/people/widen','/api/people/bridges']){
  const machine=await peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'GET',path})}),f.env as Parameters<typeof peopleMachineRequest>[1],principal(['people:read']));
  assert.equal(machine.status,200,path);
 }
});
