import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryPeople} from '../src/cli-query';
import {loadPeopleNetwork} from '../src/people-service';
import {fixture as mailFixture} from './person-context.test';
const graph={source:'email_accounts',scoreModel:'test',pushedAt:'2026-09-20T00:00:00Z',nodes:[{id:'a',name:'Ada',company:'acme.test',combined:80,lastContact:'2026-01-01'},{id:'b',name:'Ada',company:'other.test',combined:50,lastContact:null},{id:'c',name:'Bo',company:'acme.test',combined:60,lastContact:'2026-02-01'}],edges:[{source:'a',target:'c',weight:2},{source:'a',target:'hidden',weight:10}]};
function fixture(g:any=graph){return {DB:{prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})},MAIL:{getByName:()=>({graph:async()=>g,bindOwner:async()=>{},resolveOwnEmail:async(e:string)=>e==='ada@acme.test'?'a':null,searchPeople:async()=>({results:[]}),ownerIdentity:async()=>({personIds:[],names:[]})})}} as any;}
test('CLI uses the same snapshot and exposes its score provenance',async()=>{const env=fixture();assert.deepEqual((await loadPeopleNetwork(env,'owner@test')).graph,graph);const r=await queryPeople(env,'owner@test',{command:'find-person',query:'Ada'});assert.equal(r.ok,true);assert.equal((r.data as any).people.length,2);assert.equal(r.stats?.scoreModel,'test');});
test('CLI query stats name the owner whose network answered',async()=>{const env=fixture();const r=await queryPeople(env,'owner@test',{command:'who-knows',company:'acme'});assert.equal(r.stats?.owner,'owner@test');});
test('CLI ambiguous singular identity returns candidates; email resolves only own recorded people',async()=>{const env=fixture();assert.equal((await queryPeople(env,'owner@test',{command:'contact-card',query:'Ada'})).error?.kind,'ambiguous_person');assert.equal((await queryPeople(env,'owner@test',{command:'score',email:'ada@acme.test'})).ok,true);assert.equal((await queryPeople(env,'owner@test',{command:'score',email:'shared@other.test'})).error?.kind,'not_found');});
test('CLI neighbors and edges cannot expose nodes outside the visible snapshot',async()=>{const env=fixture();const r=await queryPeople(env,'owner@test',{command:'get-neighbors',personId:'a'});assert.deepEqual((r.data as any).people.map((x:any)=>x.id),['c']);assert.equal((await queryPeople(env,'owner@test',{command:'get-edges',from:'a',to:'hidden'})).error?.kind,'not_found');});
test('CLI reconnect skips missing dates; queries enforce bounded input and read-only commands',async()=>{const env=fixture();const r=await queryPeople(env,'owner@test',{command:'reconnect'});assert.deepEqual((r.data as any).people.map((x:any)=>x.id),['a','c']);for(const input of [{command:'find-person',query:'Ada',limit:201},{command:'find-person',query:''},{command:'apply-merge'}])assert.equal((await queryPeople(env,'owner@test',input as any)).ok,false);});
test('CLI missing score stays null and an empty network is readable',async()=>{const env=fixture({...graph,nodes:[{id:'x',name:'X'}],edges:[]});assert.equal((await queryPeople(env,'owner@test',{command:'score',personId:'x'})).data?.['score'],null);assert.deepEqual((await queryPeople(fixture(null),'owner@test',{command:'find-person',query:'Ada'})).data,{people:[],hints:[],excludedSelf:0});});
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

// Hosted find-person follows the local contract while keeping data.people.
type Found={id:string;name:string;name_match:string|null;matched_by:string};
const people=[{id:'o1',name:'Kaya Jones',company:'forever22.com',combined:90},{id:'o2',name:'Kaya Jones',company:'gmail.com',combined:85},
 {id:'j1',name:'Jon Slemp',company:'intrinsic-labs.ai',combined:40},{id:'j2',name:'jonchin',company:'betaworks.com',combined:70},
 {id:'j3',name:'Chin Jon',company:'example.test',combined:30},{id:'r1',name:'Rae Park',company:'jonesco.test',combined:60},{id:'s1',name:'Sam Lee',company:'granola.so',combined:50}];
function hosted(){
 const env=fixture({...graph,nodes:people,edges:[]});const stub=env.MAIL.getByName();
 Object.assign(stub,{ownerIdentity:async()=>({personIds:['o2'],names:['Kaya Jones']}),searchPeople:async()=>({results:[{personId:'s1'},{personId:'o1'}]})});
 env.MAIL.getByName=()=>stub;return env;
}
const find=async(env:unknown,query:string,extra:Record<string,unknown>={})=>{const r=await queryPeople(env as any,'kaya@betaworks.test',{command:'find-person',query,...extra} as any);return r.data as {people:Found[];hints:string[];excludedSelf:number};};

test('hosted find-person leaves the owner out unless include_self, by known id or by the owner\'s own name',async()=>{
 const env=hosted();
 const result=await find(env,'Kaya');
 assert.deepEqual(result.people.filter(p=>p.id==='o1'||p.id==='o2'),[]);
 assert.equal(result.excludedSelf,2);
 const all=await find(env,'Kaya',{include_self:true});
 assert.deepEqual(all.people.map(p=>p.id).sort(),['o1','o2']);assert.equal(all.excludedSelf,0);
});

test('hosted find-person labels how each person matched and ranks names before companies',async()=>{
 const jon=(await find(hosted(),'Jon')).people;
 assert.deepEqual(jon.slice(0,2).map(p=>[p.id,p.name_match,p.matched_by]),[['j1','partial','name'],['j3','partial','name']]);
 const company=jon.findIndex(p=>p.id==='r1');
 assert.deepEqual([jon[company].name_match,jon[company].matched_by],[null,'company']);
 assert.ok(jon.slice(0,company).every(p=>p.matched_by==='name'),'every name match ranks before a company match');
 for(const p of jon.filter(p=>p.id==='j2'))assert.equal(p.name_match,'fuzzy');
 assert.deepEqual((await find(hosted(),'jon slemp')).people[0],{...people[2],name_match:'exact',matched_by:'name'});
 assert.ok((await find(hosted(),'Jon Chin')).people.some(p=>p.id==='j3'&&p.name_match==='reordered'));
 assert.ok(!(await find(hosted(),'Jon Chin',{strict_name_order:true})).people.some(p=>p.name_match==='reordered'));
 assert.ok((await find(hosted(),'Jon Slmp')).people.some(p=>p.id==='j1'&&p.name_match==='fuzzy'));
});

test('hosted find-person marks evidence-only results and suggests near names when nothing matches by name',async()=>{
 const result=await find(hosted(),'Zebulon');
 assert.ok(result.people.every(p=>p.matched_by==='evidence'&&p.name_match===null),JSON.stringify(result.people));
 assert.deepEqual(result.people.map(p=>p.id),['s1'],'the owner never comes back through evidence');
 assert.deepEqual((await find(hosted(),'Slemmp')).hints,['Jon Slemp']);
 assert.deepEqual((await find(hosted(),'Jon')).hints,[]);
});

test('hosted find-person recognizes the owner under another address by the name on their own mail',async()=>{
 const f=await mailFixture();
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 // Mail between the owner's own accounts carries their name; an unconnected address of theirs uses it too.
 f.add('inbox@example.test','Owner Person');f.add('owner.elsewhere@other.test','Owner Person');
 assert.deepEqual((await f.service.ownerIdentity()).names,['Owner Person']);
 const found=async(extra={})=>((await queryPeople(f.env as any,'owner@example.test',{command:'find-person',query:'Owner Person',...extra})).data as {people:{name:string}[];excludedSelf:number});
 assert.deepEqual((await found()).people,[]);
 assert.deepEqual((await found({include_self:true})).people.map(p=>p.name),['Owner Person']);
});
