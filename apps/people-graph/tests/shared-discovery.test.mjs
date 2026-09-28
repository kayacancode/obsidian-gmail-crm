import test from 'node:test';import assert from 'node:assert/strict';
import {sharedDiscoveries} from '../public/relationship-graph/shared-discovery.mjs';
const r=(memberId,score=30)=>({memberId,memberName:memberId,evidenceCategory:'email',score,activity:{sent:4,received:3,meetings:0}});
const graph={source:'workspace',members:[{id:'me',name:'Kaya',isMe:true},{id:'j',name:'John'}],nodes:[{id:'known',name:'Known',type:'person',relationships:[r('me')]},{id:'new',name:'New',type:'person',relationships:[r('j',60)]},{id:'oneway',name:'Cold',type:'person',relationships:[{...r('j'),activity:{sent:1,received:0,meetings:0}}]}],edges:[],themes:[{id:'a',name:'Agent memory'},{id:'b',name:'Agent memory'}],themeSignals:[{id:'s1',personId:'known',themeId:'a',sourceType:'granola',observedAt:'2026-09-01',summary:'Recorded topic: Agent memory',evidenceRef:'workspace:me:s1'},{id:'s2',personId:'new',themeId:'b',sourceType:'granola',observedAt:'2026-09-02',summary:'Recorded topic: Agent memory',evidenceRef:'workspace:j:s2'}]};
test('discovery bridges viewer context to someone new via another member without inventing a path',()=>{const [d]=sharedDiscoveries(graph,[],Date.parse('2026-09-28'));assert.equal(d.person.id,'new');assert.equal(d.routes[0].memberId,'j');assert.deepEqual(d.topics,['Agent memory']);assert.equal(d.walk.edges.length,0);assert.match(d.reason,/Agent memory/);assert.equal(d.evidence.length,2);});
test('known contacts and one-way email do not become intro recommendations',()=>{const result=sharedDiscoveries(graph,[],Date.parse('2026-09-28'));assert.equal(result.length,1);});
test('future and subject metadata never drive matching; available routes stay labelled as such',()=>{const result=sharedDiscoveries({...graph,themeSignals:graph.themeSignals.map(s=>({...s,sourceType:'gmail_subject'}))},[],Date.parse('2026-09-28'));assert.equal(result[0].relevant,false);assert.equal(result[0].topics.length,0);});
test('readiness separates missing identity, unknown relationships and supported new introductions',async()=>{
 const {relationshipReadiness}=await import('../public/relationship-graph/shared-discovery.mjs');
 const result=relationshipReadiness({...graph,nodes:[...graph.nodes,{id:'u',name:'Unknown',type:'person',sources:['obsidian'],identityMatchReady:true,relationships:[{memberId:'j',evidenceCategory:'unknown'}]},{id:'old',name:'Old',type:'person',sources:['obsidian'],identityMatchReady:false,relationships:[r('j')]}]});
 const john=result.find(r=>r.member.id==='j');assert.equal(john.shared,4);assert.equal(john.supported,1);assert.equal(john.newPeople,1);assert.equal(john.needsReview,2);assert.equal(john.needsIdentity,1);
});
test('published scores support discovery and walks without manufacturing confirmation',()=>{
 const g={...graph,nodes:graph.nodes.map(n=>n.id==='new'?{...n,relationships:[{memberId:'j',memberName:'John',evidenceCategory:'score',score:55,scoreVersion:'obsidian-published-v1',observedAt:'2026-09-20',publishedScore:{strength:70,momentum:40,combined:55}}]}:n)};
 const [d]=sharedDiscoveries(g,[],Date.parse('2026-09-28'));assert.equal(d.person.id,'new');assert.equal(d.routes[0].confirmedAt,undefined);assert.equal(d.routes[0].score,55);
});
test('equally relevant candidates prefer the stronger published contributor score',()=>{
 const person=(id,score)=>({id,name:id,type:'person',relationships:[{memberId:'j',memberName:'John',score,evidenceCategory:'score',observedAt:'2026-09-20'}]});
 const ranked=sharedDiscoveries({...graph,themeSignals:[],nodes:[person('A weak',35),person('Z strong',80)]},[],Date.parse('2026-09-28'));
 assert.equal(ranked[0].person.id,'Z strong');
});
test('a generic pair reason without source evidence cannot make a recommendation',()=>{
 const result=sharedDiscoveries({...graph,themeSignals:[]},[{personIds:['known','new'],reason:'Worth meeting',evidence:[]}],Date.parse('2026-09-28'));
 assert.equal(result[0].relevant,false);
});
test('browse preserves contacts beyond the recommendation cap',()=>{
 const nodes=Array.from({length:25},(_,i)=>({id:'person'+i,name:'Person '+i,type:'person',relationships:[r('j')]}));
 const result=sharedDiscoveries({...graph,nodes,themeSignals:[]},[],Date.parse('2026-09-28'));
 assert.equal(result.length,25);assert.ok(result.every(d=>!d.relevant));
});
