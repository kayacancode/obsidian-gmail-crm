import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {LifeSignalStore} from '../src/life-signals';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';

const OWNER='owner@example.test';
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});

test('peer routes: the directory lists the owner\'s own contacts with their addresses',async()=>{
 const f=await fixture();
 const response=await f.request('/api/people/peer-directory');
 assert.equal(response.status,200);
 const body=await response.json() as {people:{personId:string;emails:string[]}[]};
 assert.deepEqual(body.people.find(p=>p.personId===f.personId)?.emails,['ada@example.test']);
 assert.ok(!body.people.some(p=>p.emails.includes(OWNER)));
});

test('peer routes: knows is coarse, catch-up never carries sensitive signals or quotes',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 const store=new LifeSignalStore(f.ctx.storage),now=Date.now();
 store.add(f.personId,{category:'travel',tier:'open',summary:'Back from Japan',quote:'I just got back from Japan last week.'},'gmail','a:m1',now,0);
 store.add(f.personId,{category:'milestone',tier:'personal',summary:'Got married',quote:'We got married in June, it was lovely.'},'gmail','a:m2',now,0);
 store.add(f.personId,{category:'health',tier:'sensitive',summary:'Recovering from surgery',quote:'I am recovering from knee surgery now.'},'gmail','a:m3',now,0);
 const knows=await (await f.request('/api/people/peer-answer?personId='+encodeURIComponent(f.personId)+'&type=knows')).json() as {known:boolean;band:string;lastContactMonth:string};
 assert.equal(knows.known,true);
 assert.ok(['strong','some','light'].includes(knows.band));
 assert.match(knows.lastContactMonth,/^\d{4}-\d{2}$/);
 const catchUp=await (await f.request('/api/people/peer-answer?personId='+encodeURIComponent(f.personId)+'&type=catch_up')).json() as {signals:Record<string,unknown>[]};
 assert.deepEqual(catchUp.signals.map(s=>[s.category,s.tier]).sort(),[['milestone','personal'],['travel','open']]);
 assert.ok(catchUp.signals.every(s=>!('quote' in s)&&!('sourceRef' in s)));
});

test('peer routes: an unknown person is not known and has no signals',async()=>{
 const f=await fixture();
 assert.deepEqual(await (await f.request('/api/people/peer-answer?personId=unknown-person-id&type=knows')).json(),{known:false});
 assert.deepEqual(await (await f.request('/api/people/peer-answer?personId=unknown-person-id&type=catch_up')).json(),{signals:[]});
});

test('peer routes: a read-only machine credential may use both routes',async()=>{
 const f=await fixture();
 for(const path of ['/api/people/peer-directory','/api/people/peer-answer?personId='+encodeURIComponent(f.personId)+'&type=knows']){
  const response=await peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'GET',path})}),f.env as Parameters<typeof peopleMachineRequest>[1],principal(['people:read']));
  assert.equal(response.status,200,path);
 }
});
