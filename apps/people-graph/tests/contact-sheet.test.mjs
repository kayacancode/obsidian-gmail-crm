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
test('recent context retains source, date and contributor without inferring attendance',async()=>{
 const {personContext}=await import('../public/relationship-graph/contact-sheet.mjs');
 const context=personContext({...graph,source:'workspace',themeSignals:[{id:'old',personId:'p',summary:'Earlier context',observedAt:'2026-01-01',sourceType:'obsidian_note',evidenceRef:'workspace:me:old'},{id:'new',personId:'p',summary:'Discussed interface design',observedAt:'2026-09-20',sourceType:'granola',evidenceRef:'workspace:j:new',provenance:{title:'Design conversation',canonicalUrl:'https://granola.ai/'}},{id:'other',personId:'other',summary:'Private other person',observedAt:'2026-09-21'}]},'p');
 assert.equal(context.length,2);assert.equal(context[0].contributor,'John');assert.equal(context[0].sourceLabel,'Granola note context');assert.equal(context[0].url,null);assert.equal(context[1].contributor,'You');
});
test('one-way email is not an introduction route but keeps its activity evidence',()=>{
 const c=contactCard({...graph,nodes:[{id:'p',relationships:[{memberId:'j',evidenceCategory:'email',activity:{sent:0,received:1,meetings:0}}]}]},'p');assert.equal(c.routes.length,0);assert.equal(c.relationships[0].activity.received,1);
});
test('graph normalization preserves activity direction and viewer inbox provenance',async()=>{
 const {normalizeGraph}=await import('../public/relationship-graph/model.mjs');
 const g=normalizeGraph({source:'workspace',nodes:[{id:'p',name:'P',relationships:[{memberId:'me',evidenceCategory:'email',activity:{sent:0,received:1,meetings:0},inboxes:['own@example.com']}]}],edges:[]});
 assert.equal(g.nodes[0].relationships[0].activity.sent,0);assert.deepEqual(g.nodes[0].relationships[0].inboxes,['own@example.com']);
});
