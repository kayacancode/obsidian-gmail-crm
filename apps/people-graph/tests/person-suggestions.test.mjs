import test from 'node:test';
import assert from 'node:assert/strict';
import {personSuggestions} from '../public/relationship-graph/person-suggestions.mjs';
const nodes=[{id:'k',name:'Kaspian'},{id:'n',name:'Nicole'},{id:'a',name:'Alex'},{id:'x',name:'Unknown',identityResolved:false}];
const signal=(id,personId,summary)=>({id,personId,summary,sourceType:'granola',observedAt:'2026-09-20',evidenceRef:'workspace:j:'+id});
const graph={nodes,members:[{id:'j',name:'John'}],edges:[],themeSignals:[signal('k1','k','Exploring agent memory interfaces'),signal('a1','a','Building agent memory interfaces'),signal('n1','n','Planning a holiday'),signal('x1','x','Building agent memory interfaces')]};
test('suggestions use the selected person context, not their neighbors or membership',()=>{const r=personSuggestions(graph,'k');assert.deepEqual(r.map(x=>x.person.id),['a']);assert.equal(r[0].anchorEvidence.ref,'k1');assert.equal(r[0].evidence.ref,'a1');assert.match(r[0].reason,/memory/);});
test('missing context has no filler; explicit intent can match dated candidate evidence',()=>{assert.deepEqual(personSuggestions({...graph,themeSignals:[]},'k'),[]);assert.equal(personSuggestions({...graph,themeSignals:[graph.themeSignals[1]]},'k','agent memory')[0].person.id,'a');assert.deepEqual(personSuggestions(graph,'k','biotech'),[]);});
test('source selection, existing direct links, invalid dates and ambiguous people are respected',()=>{assert.deepEqual(personSuggestions(graph,'k','', 'missing'),[]);assert.deepEqual(personSuggestions({...graph,edges:[{source:'k',target:'a',kind:'personal'}]},'k'),[]);assert.deepEqual(personSuggestions({...graph,themeSignals:graph.themeSignals.map(s=>({...s,observedAt:'invalid'}))},'k'),[]);});
test('newer email subjects cannot crowd out conversation evidence',()=>{
 const subjects=Array.from({length:25},(_,i)=>({...signal('subject'+i,'k','Newsletter '+i),sourceType:'gmail_subject',observedAt:'2026-09-25'}));
 assert.equal(personSuggestions({...graph,themeSignals:[...graph.themeSignals,...subjects]},'k')[0]?.person.id,'a');
});

test('sanitized topic boilerplate cannot create a match',()=>{assert.deepEqual(personSuggestions({...graph,themeSignals:[signal('k','k','Recorded topic: Agent memory'),signal('a','a','Recorded topic: Climate finance')]},'k'),[]);});
