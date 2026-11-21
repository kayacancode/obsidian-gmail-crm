import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';

const OWNER='owner@example.test',DAY=86_400_000;
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
type MachineEnv=Parameters<typeof peopleMachineRequest>[1];
const machine=(env:unknown,scopes:PeopleMemoryPrincipal['scopes'],method:string,path:string,body?:unknown)=>peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})}),env as MachineEnv,principal(scopes));
interface Listed {moments:{id:string;kind:string;personIds:string[];status:string}[];stats:{acted:number;dismissed:number;shownLast30:number}}

/** An owner with a note naming Wen and Kit, people they have not spoken with in two months. */
async function owner(){
 const f=await fixture();
 const ago=(days:number)=>new Date(Date.now()-days*DAY).toISOString();
 const person=(id:string,name:string)=>({id,name,company:'acme.test',strength:40,combined:40,lastContact:ago(60),directLastContact:ago(60),directRelationship:true});
 let reads=0;
 const graph={nodes:[person('p-wen','Wen'),person('p-kit','Kit'),person('p-lou','Lou')],edges:[],activity:[],themeSignals:[],themes:[],personAliases:{},personFeedback:{}};
 Object.assign(f.service,{graph:async()=>{reads++;return graph;}});
 const saved=await f.request('/api/people/mind',{text:'Agents\n\n## The fringes\n- nurse scheduling\n\n## Who I want to talk to about it\n- Wen\n- Kit\n- Lou\n'});
 assert.equal(saved.status,200);
 return {f,reads:()=>reads};
}

test('moments: generated once a day within the budget, then read back as stored',async()=>{
 const {f}=await owner();
 assert.equal((await f.request('/api/people/moments/settings',{budget:2})).status,200);
 const first=await (await f.request('/api/people/moments?today=1')).json() as Listed;
 assert.deepEqual(first.moments.map(m=>m.kind),['want_to_talk','want_to_talk']);
 const second=await (await f.request('/api/people/moments?today=1')).json() as Listed;
 assert.deepEqual(second.moments.map(m=>m.id),first.moments.map(m=>m.id));
 assert.deepEqual(first.stats,{acted:0,dismissed:0,shownLast30:2});
});

test('moments: act, snooze and dismiss; only connections count as success',async()=>{
 const {f}=await owner();
 const [a,b,c]=(await (await f.request('/api/people/moments?today=1')).json() as Listed).moments;
 for(const [id,action] of [[a.id,'act'],[b.id,'snooze'],[c.id,'dismiss']])
  assert.equal((await f.request('/api/people/moments/update',{id,action})).status,200,action);
 const after=await (await f.request('/api/people/moments?today=1')).json() as Listed;
 assert.deepEqual(after.moments.map(m=>[m.id,m.status]),[[a.id,'acted']]);
 assert.deepEqual(after.stats,{acted:1,dismissed:1,shownLast30:3});
 assert.equal((await f.request('/api/people/moments/update',{id:a.id,action:'like'})).status,400);
 assert.equal((await f.request('/api/people/moments/update',{id:'nope',action:'act'})).status,404);
 assert.equal((await f.request('/api/people/moments/settings',{budget:11})).status,400);
});

test('moments: generation makes no outbound calls and no peer questions',async()=>{
 const {f}=await owner();
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=(async(...args:Parameters<typeof fetch>)=>{calls++;return original(...args);}) as typeof fetch;
 try{assert.equal((await f.request('/api/people/moments?today=1')).status,200);}finally{globalThis.fetch=original;}
 assert.equal(calls,0);
});

test('moments: machines read with people:read and act only with people:write',async()=>{
 const {f}=await owner();
 const listed=await machine(f.env,['people:read'],'GET','/api/people/moments?today=1');
 assert.equal(listed.status,200);
 const id=((await listed.json()) as Listed).moments[0].id;
 assert.equal((await machine(f.env,['people:read'],'POST','/api/people/moments/update',{id,action:'act'})).status,403);
 assert.equal((await machine(f.env,['people:read','people:write'],'POST','/api/people/moments/update',{id,action:'act'})).status,200);
});
