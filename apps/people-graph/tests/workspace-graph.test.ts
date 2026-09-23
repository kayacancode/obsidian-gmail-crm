import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFixture} from './workspace-routes.test';
import {buildWorkspaceGraph} from '../src/workspace-graph';
async function setup(){
 const f=workspaceFixture(),id=await f.create(),token=await f.invite(id,'member@example.com');
 await f.call('workspace-invites/accept','POST',{token},'member@example.com');
 for(const me of ['owner@example.com','member@example.com'])await f.call('/'+id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'themes'},me);
 f.env.MAIL={getByName:(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>({slice:{owner,exportedAt:Date.now(),people:[{email:'contact@example.test',name:'Contact Name',lastContact:null,meetings:1}],edges:[],themes:[],signals:[]},relationships:{'contact@example.test':{score:owner==='owner@example.com'?80:30,scoreVersion:'email-v1',lastContact:null,observedAt:new Date().toISOString(),evidenceCategory:'email'}},truncated:false})})};return {...f,id};
}
test('workspace graph merges identities but keeps separate measured member relationships',async()=>{
 const f=await setup(),g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(g.nodes.length,1);assert.equal(g.nodes[0].relationships.length,2);
 assert.deepEqual(g.nodes[0].relationships.map(r=>r.score).sort(),[30,80]);
 assert.equal(g.nodes[0].directRelationship,false);assert.equal(g.nodes[0].combined,null);
 assert.equal(JSON.stringify(g).includes('contact@example.test'),false);
 await assert.rejects(buildWorkspaceGraph(f.env,f.id,'outsider@example.com'),/workspace_unavailable/);
});
test('workspace graph handles unavailable members and membership removal during export',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>owner==='member@example.com'?{bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{throw Error('offline');}}:original(owner);
 const partial=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(partial.coverage.unavailable.length,1);assert.equal(partial.nodes.length,1);
 const members:any=await (await f.call('/'+f.id+'/members')).json(),member=members.members.find((m:any)=>!m.isMe);
 f.env.MAIL.getByName=(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{await f.call('/'+f.id+'/members/'+member.id,'DELETE');return original(owner).exportWorkspaceSlice();}});
 await assert.rejects(buildWorkspaceGraph(f.env,f.id,'member@example.com'),/workspace_unavailable/);
});

test('workspace search and drafts use only permitted member graph, and disabled contributions disappear',async()=>{
 const f=await setup();
 const graph=await buildWorkspaceGraph(f.env,f.id,'owner@example.com'),person=graph.nodes[0],memberId=person.relationships[0].memberId;
 const search:any=await (await f.call('/'+f.id+'/search','POST',{query:'Contact'})).json();assert.equal(search.results[0].personId,person.id);
 const noMatch:any=await (await f.call('/'+f.id+'/search','POST',{query:'private-inbox-secret'})).json();assert.equal(noMatch.results.length,0);
 assert.equal((await f.call('/'+f.id+'/draft','POST',{personId:'private-person-id',memberId})).status,404);
 const draft:any=await (await f.call('/'+f.id+'/draft','POST',{personId:person.id,memberId})).json();assert.match(draft.body,/Contact Name/);assert.equal(draft.introVia,person.relationships[0].memberName);
 for(const me of ['owner@example.com','member@example.com'])await f.call('/'+f.id+'/contribution','PUT',{enabled:false,scope:{kind:'all'},level:'names'},me);
 const empty=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(empty.nodes.length,0);
});

test('workspace keeps contributor edge observations and shared topic relevance',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{
 const v=await original(owner).exportWorkspaceSlice();v.slice.people.push({email:'second@example.test',name:'Second Person',lastContact:null,meetings:0});
 v.slice.edges=[{a:'contact@example.test',b:'second@example.test',weight:1,types:[owner.startsWith('owner')?'shared_email':'shared_meeting'],contexts:[]}];
 v.slice.themes=[{id:'t',name:'UI design'}];v.slice.signals=[{email:'contact@example.test',themeId:'t',summary:'Working on UI design',observedAt:new Date().toISOString(),sourceType:'gmail_body_derived',confidence:1}];return v;}});
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(g.edges[0].evidence.length,2);assert.ok(g.edges[0].evidence.every(e=>e.owner&&e.title));
 assert.equal(g.relevance.themes.length,2);assert.equal(g.relevance.themes[0].nodeIds.length,1);
 const {normalizeGraph}=await import('../public/relationship-graph/model.mjs');const normalized=normalizeGraph(g);assert.equal(normalized.edges[0].evidence.length,2);assert.ok(normalized.edges[0].evidence.every((e:any)=>e.owner));assert.equal(normalized.relevance.themes[0].name,'UI Design');
});

test('private feedback overlay is never returned to a teammate',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspacePersonalScores:async()=>owner==='owner@example.com'?{'contact@example.test':{base:80,delta:-10,score:70}}:{}});
 const own=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(own.nodes[0].viewerScore?.score,70);
 const teammate=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(teammate.nodes[0].viewerScore,undefined);
 assert.equal(teammate.nodes[0].relationships.find(r=>r.memberName==='owner@example.com')?.score,80);
});

test('workspace identity uses private viewer photos without exposing them to teammates',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspaceProfiles:async()=>owner==='owner@example.com'?{'contact@example.test':{name:'My Known Contact',photoUrl:'https://lh3.googleusercontent.com/own'}}:{}});
 const own=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(own.nodes[0].photoUrl,'https://lh3.googleusercontent.com/own');assert.equal(own.nodes[0].name,'My Known Contact');
 const other=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(other.nodes[0].photoUrl,null);assert.equal(other.nodes[0].name,'Contact Name');
});
test('workspace prefers identified names and allows shared photos only with explicit consent',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),exportWorkspaceSlice:async()=>{const v=await original(owner).exportWorkspaceSlice();v.slice.people[0].name=owner==='owner@example.com'?'Someone at example.test':'Contact Name';return {...v,profiles:{'contact@example.test':{name:'Contact Profile',photoUrl:'https://lh3.googleusercontent.com/shared'}}};}});
 const before=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(before.nodes[0].name,'Contact Name');assert.equal(before.nodes[0].photoUrl,null);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',shareProfiles:true},'member@example.com');
 const after=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(after.nodes[0].name,'Contact Name');assert.equal(after.nodes[0].photoUrl,'https://lh3.googleusercontent.com/shared');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',shareProfiles:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].photoUrl,null);
});

test('workspace retains human display names over viewer email-handle fallbacks',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspaceProfiles:async()=>({'contact@example.test':{name:'contact',photoUrl:null}})});
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].name,'Contact Name');
});

test('workspace Obsidian source requires consent, retains photos, excludes private context and scores',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 const snapshot={coverage:{totalContacts:4900},nodes:[{id:'vault-a',name:'Ada Vault',company:'Design',photoUrl:'https://lh3.googleusercontent.com/ada',combined:99},{id:'vault-b',name:'Bo Vault'}],edges:[{source:'vault-a',target:'vault-b',contexts:['PRIVATE EMAIL SUBJECT'],weight:88}]};
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify(snapshot),1700000000);
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.length,1);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true,shareProfiles:true},'member@example.com');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(g.nodes.length,3);
 const ada=g.nodes.find(n=>n.name==='Ada Vault')!;assert.equal(ada.photoUrl,'https://lh3.googleusercontent.com/ada');assert.equal(ada.relationships[0].score,null);
 assert.ok(!JSON.stringify(g).includes('PRIVATE EMAIL SUBJECT'));
 const coverage=g.coverage.sources.find(s=>s.source==='obsidian'&&s.included>0)!;assert.equal(coverage.available,2);assert.equal(coverage.vaultTotal,4900);assert.equal(coverage.limited,true);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'people',personIds:['obsidian:vault-a']},level:'names',includeObsidian:true,shareProfiles:false},'member@example.com');
 const scoped=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(scoped.nodes.some(n=>n.name==='Bo Vault'),false);assert.equal(scoped.nodes.find(n=>n.name==='Ada Vault')!.photoUrl,null);
 const own=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(own.nodes.find(n=>n.name==='Ada Vault')!.photoUrl,'https://lh3.googleusercontent.com/ada');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.some(n=>n.name==='Ada Vault'),false);
});
test('workspace includes a 4900-person uploaded vault without the web sharing cap',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:Array.from({length:4900},(_,i)=>({id:'vault-'+i,name:'Person '+i})),edges:[]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'member@example.com');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(g.nodes.length,4901);assert.equal(g.coverage.sources.find(s=>s.source==='obsidian'&&s.included>0)!.included,4900);
});

test('workspace vault address-shaped names require profile consent except for the owner',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:[{id:'vault-a',name:'privatehandle@example.test'}],edges:[]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true,shareProfiles:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.find(n=>n.sources?.includes('obsidian'))!.name,'Name unavailable');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'member@example.com')).nodes.find(n=>n.sources?.includes('obsidian'))!.name,'privatehandle');
});
