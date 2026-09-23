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
