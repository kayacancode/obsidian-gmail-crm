import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, focus, metrics, daysAgo } from './model.mjs';

const graph = {nodes:[{id:'a',name:'Ada',company:'Design'},{id:'b',name:'Bo',company:'Labs'},{id:'c',name:'Cy',company:'Design'}],edges:[{source:'a',target:'b',types:['mentioned'],contexts:['Climate workshop']},{source:'a',target:'c',types:['introduced'],contexts:['Research intro']}]};
test('matching edge context retains both endpoints, without unrelated edges',()=>{
 const result=focus(normalize(graph),'climate');
 assert.deepEqual(result.nodes.map(n=>n.id),['a','b']);
 assert.equal(result.edges.length,1);
});
test('mentions count as connections but not introductions',()=>{
 const m=metrics(normalize(graph)).get('a');
 assert.equal(m.connections,2); assert.equal(m.introductions,1); assert.equal(m.companies,2);
});
test('invalid imports and dangling edges cannot silently look like a complete graph',()=>{
 assert.throws(()=>normalize({nodes:[{id:'a'},{id:'a'}],edges:[]}));
 assert.throws(()=>normalize({nodes:[],edges:[{source:'a',target:'b'}]}));
});
test('missing and future dates do not imply recent contact',()=>{
 assert.equal(daysAgo(null,'2026-09-09'),null);
 assert.equal(daysAgo('2026-09-10','2026-09-09'),null);
 assert.equal(daysAgo('2026-09-01','2026-09-09'),8);
});
