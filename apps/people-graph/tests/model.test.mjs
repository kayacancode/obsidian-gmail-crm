import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize,search,sceneData,loadLocal,saveLocal,safePhoto} from '../public/model.mjs';
const raw={nodes:[{id:'a',name:'Ada',company:'Alpha',role:'Researcher'},{id:'b',name:'Bo',company:'Beta'},{id:'c',name:'Cy',company:'Beta'}],edges:[{source:'a',target:'b',types:['shared_meeting'],contexts:['Context engineering workshop']}]};
test('retrieval returns source evidence, not ungrounded matches',()=>{const g=normalize(raw);const r=search(g,'Who works on context engineering?');assert.equal(r.length,2);assert.match(r[0].reasons.join(' '),/Context engineering workshop/);assert.equal(search(g,'quantum teleportation').length,0);assert.equal(search(g,'Researcher')[0].node.id,'a');});
test('scene caps people without changing the complete search result count',()=>{const g=normalize(raw);assert.equal(sceneData(g,search(g,''),1).people.length,1);assert.equal(search(g,'').length,3);});
test('normalization rejects duplicate identity and dangling edges',()=>{assert.throws(()=>normalize({nodes:[{id:'a'},{id:'a'}],edges:[]}));assert.throws(()=>normalize({nodes:[],edges:raw.edges}));});
test('photos cannot introduce script URLs or arbitrary tracking domains',()=>{assert.equal(safePhoto('javascript:alert(1)'),null);assert.equal(safePhoto('https://evil.example/pic'),null);assert.equal(safePhoto('https://lh3.googleusercontent.com/pic'),'https://lh3.googleusercontent.com/pic');});
test('persisted state is scoped to authenticated account and handles corrupted storage',()=>{const m=new Map(),storage={getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};saveLocal(storage,'a',{shortlist:['one'],drafts:{one:'hello'}});assert.deepEqual(loadLocal(storage,'b').shortlist,[]);assert.equal(loadLocal(storage,'a').drafts.one,'hello');storage.setItem('people-spatial:a','{');assert.deepEqual(loadLocal(storage,'a').shortlist,[]);});
test('exact names and companies are searchable even when they are conversational stopwords',()=>{const g=normalize({nodes:[{id:'x',name:'An',company:'Now'}],edges:[]});assert.equal(search(g,'An')[0]?.node.id,'x');assert.equal(search(g,'Now')[0]?.node.id,'x');});

test('scene includes every matching person by default',()=>{const g=normalize({nodes:Array.from({length:554},(_,i)=>({id:String(i),name:'Person '+i})),edges:[]});assert.equal(sceneData(g,search(g,'')).people.length,554);});
