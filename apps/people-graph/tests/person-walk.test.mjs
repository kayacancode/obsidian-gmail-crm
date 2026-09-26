import {test} from 'node:test';import assert from 'node:assert/strict';
import {personWalk} from '../public/relationship-graph/person-walk.mjs';
const r=memberId=>({memberId,memberName:memberId,evidenceCategory:'email'});
const graph={source:'workspace',members:[{id:'me',name:'Me',isMe:true},{id:'j',name:'John'}],nodes:[{id:'mutual',name:'Mutual',type:'person',relationships:[r('me'),r('j')]},{id:'p',name:'Person',type:'person',relationships:[r('j')]}],edges:[]};
test('selection finds an actual viewer-to-person walk',()=>{const w=personWalk(graph,'p');assert.deepEqual(w.nodes.map(n=>n.name),['You (Me)','Mutual','John','Person']);assert.equal(w.edges.length,3);});
test('sharing ownership is not an introduction path',()=>{const w=personWalk({...graph,nodes:[graph.nodes[1]]},'p');assert.equal(w.edges.length,0);assert.equal(w.nodes.length,1);assert.match(w.message,/No recorded path/);assert.equal(w.contributors[0].name,'John');});
test('unmatched vault person gets an actionable identity explanation',()=>{const w=personWalk({...graph,nodes:[{...graph.nodes[1],sources:['obsidian'],identityMatchReady:false}]},'p');assert.match(w.message,/fresh vault/);assert.equal(w.edges.length,0);});
