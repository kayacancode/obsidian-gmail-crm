import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';

const OWNER='owner@example.test';
const recorded=(output:unknown)=>({run:async()=>({response:output})}) as unknown as Ai;
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});

test('ask route: a signed owner gets the interpretation and the answer',async()=>{
 const f=await fixture();
 f.env.AI=recorded({intent:'catch_up',params:{person:'Ada'},confidence:0.9});
 const response=await f.request('/api/people/ask',{question:'catch me up on Ada'});
 assert.equal(response.status,200);
 const body=await response.json() as {interpretation:{intent:string};answers:{name:string}[]};
 assert.equal(body.interpretation.intent,'catch_up');
 assert.equal(body.answers[0].name,'Ada');
});

test('ask route: cross-origin and oversized questions are refused',async()=>{
 const f=await fixture();
 f.env.AI=recorded({intent:'reconnect',params:{},confidence:0.9});
 assert.equal((await f.request('/api/people/ask',{question:'who should I reconnect with'},{origin:'https://evil.test'})).status,403);
 assert.equal((await f.request('/api/people/ask',{question:'x'.repeat(501)})).status,400);
 assert.equal((await f.request('/api/people/ask',{question:'hi',extra:true})).status,400);
});

test('ask route: a read-only machine credential may ask',async()=>{
 const f=await fixture();
 f.env.AI=recorded({intent:'network_ask',params:{person:'Ada'},confidence:0.9});
 const response=await peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'POST',path:'/api/people/ask',body:{question:'does anyone know Ada'}})}),f.env as Parameters<typeof peopleMachineRequest>[1],principal(['people:read']));
 assert.equal(response.status,200);
 assert.equal((await response.json() as {interpretation:{intent:string}}).interpretation.intent,'network_ask');
});
