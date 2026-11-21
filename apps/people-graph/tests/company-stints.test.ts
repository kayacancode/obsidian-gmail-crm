import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {opaque} from '../src/mail-model';
import {deriveStints,mergeStints,overlaps,type CompanyStint} from '../src/company-stints';
import {queryPeople} from '../src/cli-query';
import type {PeopleEnv} from '../src/people-service';

const OWNER='owner@example.test',INBOX='inbox@example.test';
const at=(y:number,m:number)=>Date.UTC(y,m-1,15);
const now=Date.UTC(2026,10,21);

test('stints: one stint per work domain; the newest stays open and personal mail is ignored',()=>{
 const stints=deriveStints('p',[{email:'maya@acme.com',first:at(2023,1),last:at(2024,6)},{email:'maya@zeta.io',first:at(2024,7),last:at(2026,10)},{email:'maya@gmail.com',first:at(2020,1),last:at(2026,11)}],now);
 assert.deepEqual(stints.map(s=>[s.company,s.domain,s.from,s.to,s.source]),[['acme','acme.com','2023-01','2024-06','email_domain'],['zeta','zeta.io','2024-07',null,'email_domain']]);
});

test('stints: an owner correction replaces the derived stint for that company',()=>{
 const derived=deriveStints('p',[{email:'maya@acme.com',first:at(2023,1),last:at(2024,6)}],now);
 const owner:CompanyStint={id:'o1',personId:'p',company:'Acme',domain:'',from:'2022-09',to:'2024-06',source:'owner'};
 assert.deepEqual(mergeStints(derived,[owner]).map(s=>[s.company,s.from,s.source]),[['Acme','2022-09','owner']]);
});

test('stints: overlap reports the shared period or nothing',()=>{
 const a:CompanyStint={id:'a',personId:'a',company:'acme',domain:'acme.com',from:'2023-01',to:'2024-06',source:'email_domain'};
 assert.equal(overlaps(a,{...a,id:'b',personId:'b',from:'2024-03',to:null}),'2024-03..2024-06');
 assert.equal(overlaps(a,{...a,id:'c',personId:'c',from:'2024-07',to:null}),null);
});

type Db={prepare(sql:string):{run(...args:unknown[]):unknown}};
const contribution=(f:{db:Db},email:string,name:string,date:number)=>f.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run(INBOX,email,email,name,date,'Hello',1,1);
type Listed={id:string;formerly?:unknown};
/** Narrow a who-knows payload to its people list. */
function people(data:unknown):Listed[]{
 assert.ok(data&&typeof data==='object'&&'people' in data&&Array.isArray(data.people));
 return data.people;
}
test('stints: the same name on two work domains is a job-move proposal until merged',async()=>{
 const f=await fixture();
 contribution(f,'maya@acme.com','Maya Rivera',at(2024,5));contribution(f,'maya@zeta.io','Maya Rivera',at(2026,10));
 const {candidates}=await f.service.jobMoveCandidates();
 assert.equal(candidates.length,1);
 assert.equal(candidates[0].name,'Maya Rivera');
 assert.deepEqual(candidates[0].people.map(p=>p.domain),['zeta.io','acme.com']);
 const [newer,older]=candidates[0].people.map(p=>p.personId);
 await f.service.setPersonMerge(older,newer);
 assert.deepEqual((await f.service.jobMoveCandidates()).candidates,[]);
 const stints=(await f.service.companyStints(newer)).stints;
 assert.deepEqual(stints.map(s=>[s.domain,s.to===null]),[['acme.com',false],['zeta.io',true]]);
 assert.deepEqual((await f.service.formerAt('acme')).personIds,[newer]);
});

test('stints: teammates overlap at the same domain',async()=>{
 const f=await fixture();
 contribution(f,'maya@acme.com','Maya Rivera',at(2024,5));contribution(f,'lee@acme.com','Lee Park',at(2024,4));
 const maya=await opaque(OWNER,'maya@acme.com',f.env.TOKEN_SECRET),lee=await opaque(OWNER,'lee@acme.com',f.env.TOKEN_SECRET);
 const {teammates}=await f.service.teammates(maya);
 assert.deepEqual(teammates.map(t=>[t.personId,t.domain]),[[lee,'acme.com']]);
});

test('stints: teammates and former colleagues on a big shared domain resolve identities once per call',async()=>{
 const f=await fixture();
 for(let i=0;i<300;i++)contribution(f,`person${i}@acme.com`,`Person ${i}`,at(2024,5));
 contribution(f,'person0@zeta.io','Person 0',at(2026,10));
 // Element access is the test seam: count the expensive identity map rebuilds.
 const service=f.service as unknown as {mergeIdentities():Promise<Map<string,string>>};
 const original=service.mergeIdentities.bind(f.service);let rebuilds=0;
 service.mergeIdentities=async()=>{rebuilds++;return original();};
 const maya=await opaque(OWNER,'person1@acme.com',f.env.TOKEN_SECRET);
 assert.equal((await f.service.teammates(maya)).teammates.length,299);
 assert.ok(rebuilds<=3,`teammates rebuilt identities ${rebuilds} times`);
 rebuilds=0;
 await f.service.formerAt('acme');
 assert.ok(rebuilds<=3,`formerAt rebuilt identities ${rebuilds} times`);
});

test('stints: an owner stint can be set and forgotten',async()=>{
 const f=await fixture();
 const stint=await f.service.setCompanyStint({personId:f.personId,company:'Analytical Engines',from:'2025-01',to:null});
 assert.equal(stint.source,'owner');
 assert.ok((await f.service.companyStints(f.personId)).stints.some(s=>s.company==='Analytical Engines'));
 await assert.rejects(f.service.setCompanyStint({personId:f.personId,company:'X',from:'2025-13',to:null}),/invalid_request/);
 assert.equal((await f.service.forgetCompanyStint(stint.id)).removed,true);
});

test('stints: who-knows can include former colleagues, labelled',async()=>{
 const graph={source:'email_accounts',nodes:[{id:'a',name:'Ada',company:'acme.test',combined:80},{id:'x',name:'Xia',company:'zeta.test',combined:70}],edges:[]};
 const env={MAIL:{getByName:()=>({graph:async()=>graph,bindOwner:async()=>{},formerAt:async()=>({personIds:['x'],stints:{x:{from:'2022-01',to:'2024-06'}}})})}} as unknown as PeopleEnv;
 const current=await queryPeople(env,OWNER,{command:'who-knows',company:'acme'});
 assert.deepEqual(people(current.data).map(p=>p.id),['a']);
 const all=await queryPeople(env,OWNER,{command:'who-knows',company:'acme',include_former:true});
 assert.deepEqual(people(all.data).map(p=>[p.id,p.formerly??null]),[['a',null],['x',{from:'2022-01',to:'2024-06'}]]);
});
