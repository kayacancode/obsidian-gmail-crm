import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';

const OWNER='owner@example.test';
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
const machine=(env:unknown,actor:PeopleMemoryPrincipal,input:unknown)=>peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),env as Parameters<typeof peopleMachineRequest>[1],actor);

test('life routes: a signed owner turns signals on and lists them',async()=>{
 const f=await fixture();
 const on=await f.request('/api/people/signals/settings',{enabled:true});
 assert.equal(on.status,200);assert.deepEqual(await on.json(),{enabled:true});
 const listed=await f.request('/api/people/signals');
 assert.equal(listed.status,200);assert.deepEqual(await listed.json(),{enabled:true,signals:[]});
});

test('life routes: writes from another origin are refused',async()=>{
 const f=await fixture();
 const response=await f.request('/api/people/signals/settings',{enabled:true},{origin:'https://evil.test'});
 assert.equal(response.status,403);
});

test('life routes: a brief by name returns the envelope; a shared name returns candidates',async()=>{
 const f=await fixture();
 const brief=await f.request('/api/people/brief?query=Ada');
 assert.equal(brief.status,200);
 const body=await brief.json() as {answers:{name:string}[];gaps:string[]};
 assert.equal(body.answers[0].name,'Ada');
 assert.ok(body.gaps.includes('No life signals: signals are off'));
 f.add('ada.k@other.test','Ada');
 const ambiguous=await f.request('/api/people/brief?query=Ada');
 assert.equal(ambiguous.status,409);
 assert.equal((await ambiguous.json() as {candidates:unknown[]}).candidates.length,2);
});

test('life routes: timeline and stints round-trip through the session API',async()=>{
 const f=await fixture();
 const added=await f.request('/api/people/timeline',{text:'Moved to Lisbon',date:'2026-03-01'});
 assert.equal(added.status,200);
 const {id}=await added.json() as {id:string};
 assert.equal((await f.request('/api/people/timeline',{id},{method:'DELETE'})).status,200);
 const stint=await f.request('/api/people/stints',{personId:f.personId,company:'Engines',from:'2025-01',to:null});
 assert.equal(stint.status,200);
 assert.equal((await f.request('/api/people/stints?personId='+encodeURIComponent(f.personId))).status,200);
 assert.equal((await f.request('/api/people/job-moves')).status,200);
});

test('life routes: machine credentials need people:write to change settings',async()=>{
 const f=await fixture();
 const input={method:'POST',path:'/api/people/signals/settings',body:{enabled:true}};
 const denied=await machine(f.env,principal(['people:read']),input);
 assert.equal(denied.status,403);
 assert.equal((await denied.json() as {error:string}).error,'insufficient_scope');
 assert.equal((await machine(f.env,principal(['people:read','people:write']),input)).status,200);
 assert.equal((await machine(f.env,principal(['people:read']),{method:'GET',path:'/api/people/brief?query=Ada'})).status,200);
});
