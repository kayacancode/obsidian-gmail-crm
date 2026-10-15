import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedHomeRows,sharedHomeTitle} from '../public/relationship-graph/shared-home.mjs';
const tie=memberId=>({memberId,evidenceCategory:'email',activity:{sent:2,received:2,meetings:0}});
const graph={members:[{id:'me',name:'kaya@betaworks.com',isMe:true},{id:'j',name:'john@betaworks.com'}],nodes:[{id:'a',name:'Alex',type:'person',relationships:[tie('me'),tie('j')]},{id:'b',name:'Bob',type:'person',relationships:[tie('j')]}],themes:[],themeSignals:[]};
test('shared home has a human title and one bounded deduplicated list',()=>{
 assert.equal(sharedHomeTitle(graph),'You + John');
 const result=sharedHomeRows(graph);assert.equal(result.rows[0].person.id,'a');assert.match(result.rows[0].reason,/share/);
 assert.ok(result.rows.length<=6);assert.equal(new Set(result.rows.map(r=>r.person.id)).size,result.rows.length);
 assert.ok(result.message.includes('No suggestions'));
});
test('search replaces the shortlist, excludes missing records, and keeps an empty answer empty',()=>{
 const result=sharedHomeRows(graph,{query:'Bob',results:[{personId:'b',reasons:[{summary:'Works on design'}]},{personId:'missing'}]});
 assert.deepEqual(result.rows.map(r=>r.person.id),['b']);assert.equal(result.rows[0].reason,'Works on design');
 assert.equal(sharedHomeRows(graph,{query:'nothing',results:[]}).rows.length,0);
});
test('unresolved and denied identities are never presented as recommendations or contacts',()=>{
 const result=sharedHomeRows({...graph,nodes:graph.nodes.map(n=>({...n,permission:'denied'}))});assert.equal(result.rows.length,0);
});
