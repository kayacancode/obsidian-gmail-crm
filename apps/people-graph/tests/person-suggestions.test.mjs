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

test('what-if helpers need recent specific evidence on both sides and show at most three',async()=>{
 const {helperSuggestions,helperDraft}=await import('../public/relationship-graph/helper-suggestions.mjs');
 const now=Date.parse('2026-10-15');const g={...graph,nodes:[...nodes,...['b','c','d'].map(id=>({id,name:id}))],themeSignals:[...graph.themeSignals,...['b','c','d'].map(id=>signal(id,id,'Developing agent memory interfaces'))]};
 const matches=helperSuggestions(g,'k',now);assert.equal(matches.length,3);assert.ok(matches.every(m=>m.anchorEvidence&&m.evidence));assert.match(helperDraft('Kaspian',matches[0]),/Would you both be open/);
 assert.deepEqual(helperSuggestions({...g,themeSignals:g.themeSignals.map(s=>({...s,summary:'Recorded topic: AI agents'}))},'k',now),[]);
 assert.deepEqual(helperSuggestions({...g,themeSignals:g.themeSignals.map(s=>({...s,observedAt:'2020-01-01'}))},'k',now),[]);
 assert.deepEqual(helperSuggestions({...g,source:'workspace',themeSignals:g.themeSignals.map(s=>({...s,visibility:'private'}))},'k',now),[]);
});

test('grounded helper drafts lead with the specific reason and conversation without copying private excerpts',async()=>{
 const {helperDraft}=await import('../public/relationship-graph/helper-suggestions.mjs');
 const item={person:{name:'Max'},reason:'Max has researched nurse handoffs and could help test Angelica’s clinic workflow.',conversation:'Which handoff assumptions should the prototype test first?',anchorEvidence:{summary:'PRIVATE ORIGINAL EMAIL'},evidence:{summary:'PRIVATE CANDIDATE EMAIL'}};
 const draft=helperDraft('Angelica',item);assert.match(draft,/researched nurse handoffs/);assert.match(draft,/Which handoff assumptions/);assert.doesNotMatch(draft,/PRIVATE/);
});
