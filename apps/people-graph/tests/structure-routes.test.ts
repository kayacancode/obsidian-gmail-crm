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
