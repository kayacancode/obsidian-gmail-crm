import {test} from 'node:test';import assert from 'node:assert/strict';import {contactCard} from '../public/relationship-graph/contact-sheet.mjs';
const graph={members:[{id:'me',isMe:true,name:'Me'},{id:'j',name:'John'}],nodes:[{id:'p',name:'Person',relationships:[{memberId:'j',evidenceCategory:'email',memberName:'John',score:45}]}],themeSignals:[]};
test('contact sheet derives real routes and never offers self intros',()=>{assert.equal(contactCard(graph,'p').routes[0].memberId,'j');assert.equal(contactCard(graph,'missing'),null);assert.deepEqual(contactCard({...graph,members:[{id:'j',isMe:true,name:'John'}]},'p').routes,[]);});
test('contact sheet requires resolved vault identity and preserves absent evidence',()=>{const c=contactCard({...graph,nodes:[{...graph.nodes[0],sources:['obsidian'],identityMatchReady:false}]},'p');assert.deepEqual(c.routes,[]);assert.deepEqual(c.evidence,[]);});

test('unknown matched relationships do not offer intro',()=>{assert.deepEqual(contactCard({...graph,nodes:[{...graph.nodes[0],identityMatchReady:true,relationships:[{memberId:'j',evidenceCategory:'unknown'}]}]},'p').routes,[]);});
test('unmatched vault records describe provenance and missing evidence',()=>{const c=contactCard({...graph,nodes:[{id:'p',name:'Alex',sources:['obsidian'],identityMatchReady:false,relationships:[{memberId:'j',evidenceCategory:'unknown'}]}]},'p');assert.equal(c.identityPending,true);assert.deepEqual(c.contributors.map(m=>m.name),['John']);assert.equal(c.relationshipUnverified,true);});
test('self and unmeasured contributor relationships remain visible independent of intro routes',()=>{
 const c=contactCard({...graph,nodes:[{id:'p',relationships:[{memberId:'me',evidenceCategory:'email',score:82},{memberId:'j',evidenceCategory:'unknown',score:null}]}]},'p');
 assert.equal(c.relationships.length,2);assert.equal(c.relationships[0].isMe,true);assert.equal(c.relationships[0].score,82);assert.equal(c.relationships[1].score,null);assert.equal(c.routes.length,0);
});
