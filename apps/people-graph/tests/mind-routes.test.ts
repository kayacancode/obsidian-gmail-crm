import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {NOTE} from './curiosity.test';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';

const OWNER='owner@example.test';
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
type MachineEnv=Parameters<typeof peopleMachineRequest>[1];
const machine=(env:unknown,scopes:PeopleMemoryPrincipal['scopes'],method:string,path:string,body?:unknown)=>peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})}),env as MachineEnv,principal(scopes));

interface Saved {note:{id:string;title:string;fringes:string[];people:{name:string;personId:string|null}[]};gaps:string[]}

test('mind: a saved note resolves exact names and reports the rest',async()=>{
 const f=await fixture();
 const response=await f.request('/api/people/mind',{text:NOTE});
 assert.equal(response.status,200);
 const saved=await response.json() as Saved;
 assert.equal(saved.note.title,'Agentic networks');
 assert.equal(saved.note.fringes.length,2);
 assert.equal(saved.note.people.find(p=>p.name==='Ada')?.personId,f.personId);
 for(const missing of ['example','maya@acme.test','Zed Nobody'])assert.ok(saved.gaps.some(g=>g.includes(missing)),missing);
 const listed=await (await f.request('/api/people/mind')).json() as {notes:{id:string}[]};
 assert.deepEqual(listed.notes.map(n=>n.id),[saved.note.id]);
});

test('mind: three active notes at most, unknown headings named, archive hides',async()=>{
 const f=await fixture();
 const ids:string[]=[];
 for(let i=0;i<3;i++)ids.push((await (await f.request('/api/people/mind',{text:`Note ${i}\n\n## The fringes\n- topic ${i}\n`})).json() as Saved).note.id);
 const fourth=await f.request('/api/people/mind',{text:'## The fringes\n- one too many\n'});
 assert.equal(fourth.status,409);
 assert.deepEqual(await fourth.json(),{error:'note_limit'});
 const invalid=await f.request('/api/people/mind',{text:'## Random thoughts\n- x\n'});
 assert.equal(invalid.status,400);
 assert.deepEqual(await invalid.json(),{error:'note_invalid',heading:'Random thoughts'});
 // Replacing an active note in place is not a fourth note.
 const replaced=await f.request('/api/people/mind',{id:ids[0],text:'Renamed\n\n## The fringes\n- topic 0\n'});
 assert.equal(replaced.status,200,await replaced.clone().text());
 const archived=await f.request('/api/people/mind/archive',{id:ids[1]});
 assert.equal(archived.status,200,await archived.clone().text());
 const active=await (await f.request('/api/people/mind')).json() as {notes:{id:string;title:string}[]};
 assert.deepEqual(active.notes.map(n=>n.id).sort(),[ids[0],ids[2]].sort());
 assert.equal(active.notes.find(n=>n.id===ids[0])?.title,'Renamed');
 const all=await (await f.request('/api/people/mind?includeArchived=1')).json() as {notes:{id:string;status:string}[]};
 assert.equal(all.notes.find(n=>n.id===ids[1])?.status,'archived');
 assert.equal((await f.request('/api/people/mind',{text:'## The fringes\n- now there is room\n'})).status,200);
});

test('mind: machines read with people:read and write only with people:write',async()=>{
 const f=await fixture();
 assert.equal((await machine(f.env,['people:read'],'POST','/api/people/mind',{text:NOTE})).status,403);
 assert.equal((await machine(f.env,['people:read','people:write'],'POST','/api/people/mind',{text:NOTE})).status,200);
 const listed=await machine(f.env,['people:read'],'GET','/api/people/mind');
 assert.equal(listed.status,200);
 assert.equal(((await listed.json()) as {notes:unknown[]}).notes.length,1);
});
