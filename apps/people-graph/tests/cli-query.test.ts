import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryPeople} from '../src/cli-query';
import {loadPeopleNetwork} from '../src/people-service';
const graph={source:'email_accounts',scoreModel:'test',pushedAt:'2026-09-20T00:00:00Z',nodes:[{id:'a',name:'Ada',company:'acme.test',combined:80,lastContact:'2026-01-01'},{id:'b',name:'Ada',company:'other.test',combined:50,lastContact:null},{id:'c',name:'Bo',company:'acme.test',combined:60,lastContact:'2026-02-01'}],edges:[{source:'a',target:'c',weight:2},{source:'a',target:'hidden',weight:10}]};
function fixture(g:any=graph){return {DB:{prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})},MAIL:{getByName:()=>({graph:async()=>g,bindOwner:async()=>{},resolveOwnEmail:async(e:string)=>e==='ada@acme.test'?'a':null,searchPeople:async()=>({results:[]})})}} as any;}
test('CLI uses the same snapshot and exposes its score provenance',async()=>{const env=fixture();assert.deepEqual((await loadPeopleNetwork(env,'owner@test')).graph,graph);const r=await queryPeople(env,'owner@test',{command:'find-person',query:'Ada'});assert.equal(r.ok,true);assert.equal((r.data as any).people.length,2);assert.equal(r.stats?.scoreModel,'test');});
test('CLI ambiguous singular identity returns candidates; email resolves only own recorded people',async()=>{const env=fixture();assert.equal((await queryPeople(env,'owner@test',{command:'contact-card',query:'Ada'})).error?.kind,'ambiguous_person');assert.equal((await queryPeople(env,'owner@test',{command:'score',email:'ada@acme.test'})).ok,true);assert.equal((await queryPeople(env,'owner@test',{command:'score',email:'shared@other.test'})).error?.kind,'not_found');});
test('CLI neighbors and edges cannot expose nodes outside the visible snapshot',async()=>{const env=fixture();const r=await queryPeople(env,'owner@test',{command:'get-neighbors',personId:'a'});assert.deepEqual((r.data as any).people.map((x:any)=>x.id),['c']);assert.equal((await queryPeople(env,'owner@test',{command:'get-edges',from:'a',to:'hidden'})).error?.kind,'not_found');});
test('CLI reconnect skips missing dates; queries enforce bounded input and read-only commands',async()=>{const env=fixture();const r=await queryPeople(env,'owner@test',{command:'reconnect'});assert.deepEqual((r.data as any).people.map((x:any)=>x.id),['a','c']);for(const input of [{command:'find-person',query:'Ada',limit:201},{command:'find-person',query:''},{command:'apply-merge'}])assert.equal((await queryPeople(env,'owner@test',input as any)).ok,false);});
test('CLI missing score stays null and an empty network is readable',async()=>{const env=fixture({...graph,nodes:[{id:'x',name:'X'}],edges:[]});assert.equal((await queryPeople(env,'owner@test',{command:'score',personId:'x'})).data?.['score'],null);assert.deepEqual((await queryPeople(fixture(null),'owner@test',{command:'find-person',query:'Ada'})).data,{people:[]});});
test('CLI shared loader preserves an explicit empty web source without loading vault fallback',async()=>{
 const env=fixture(null);let vaultReads=0;const original=env.DB.prepare;
 env.DB.prepare=(sql:string)=>{if(sql.includes('FROM graphs'))vaultReads++;return original(sql);};
 assert.deepEqual(await loadPeopleNetwork(env,'owner@test','web'),{account:'owner@test',graph:null});
 assert.equal(vaultReads,0);
});
test('CLI contact lookup resolves a merged alias to its visible canonical profile',async()=>{
 const env=fixture({...graph,personAliases:{old:'a'}});const stub=env.MAIL.getByName();stub.resolveOwnEmail=async()=> 'old';env.MAIL.getByName=()=>stub;
 const result=await queryPeople(env,'owner@test',{command:'contact-card',email:'alias@acme.test'});
 assert.equal(result.ok,true);assert.equal((result.data as any).person.id,'a');
});
