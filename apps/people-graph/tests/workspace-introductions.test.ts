import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestIntroductions,rankIntroductions} from '../src/workspace-introductions';
import {jevServer,noulA,scoreA} from './granola-jev-extractor.test';
function fixture():any{return {nodes:[{id:'a',name:'Ada',relationships:[{memberId:'one'}]},{id:'b',name:'Bo',relationships:[{memberId:'two'}]},{id:'c',name:'Cy',relationships:[{memberId:'two'}]}],edges:[],themes:[{id:'t1',name:'Interface design'},{id:'t2',name:'Interface design'}],themeSignals:[{personId:'a',themeId:'t1',sourceType:'obsidian_note',observedAt:'2026-09-23T12:00:00Z',summary:'Building interfaces for creative tools'},{personId:'b',themeId:'t2',sourceType:'granola',observedAt:'2026-09-22T12:00:00Z',summary:'Researching interface design for artists'}]};}
test('introductions require evidence for both people across contributors and never invent edges',()=>{
 const g=fixture(),p=suggestIntroductions(g);assert.equal(p.length,1);assert.deepEqual(p[0].personIds,['a','b']);assert.equal(p[0].evidence.length,2);assert.equal(g.edges.length,0);assert.equal(p[0].relationship,'no_recorded_connection');
 g.edges.push({source:'b',target:'a'});assert.equal(suggestIntroductions(g).length,0);
 g.edges=[];g.nodes[1].relationships=[{memberId:'one'}];assert.equal(suggestIntroductions(g).length,0);
 g.nodes[1].relationships=[{memberId:'two'}];g.nodes[1].sources=['obsidian'];assert.equal(suggestIntroductions(g).length,0);
 g.nodes[1].identityMatchReady=true;assert.equal(suggestIntroductions(g).length,1);
 g.themeSignals=[];assert.equal(suggestIntroductions(g).length,0);
});
test('introduction candidates are bounded and diverse on a 5000-person graph',()=>{
 const g=fixture();g.nodes=Array.from({length:5000},(_,i)=>({id:'p'+i,name:'Person '+i,relationships:[{memberId:String(i%3)}]}));g.themeSignals=g.nodes.map((n:any)=>({...g.themeSignals[0],personId:n.id}));
 const p=suggestIntroductions(g);assert.ok(p.length<=12);const counts=new Map();for(const row of p)for(const id of row.personIds)counts.set(id,(counts.get(id)||0)+1);assert.ok([...counts.values()].every(n=>n<=2));
});
test('Jev ranks existing introductions only and a failure preserves evidence-based fallback without retries',async()=>{
 const original=globalThis.fetch,g=fixture();try{
  globalThis.fetch=jevServer((id:string,_question:any,state:any)=>{assert.ok(!JSON.stringify(state).includes('personId'));return id==='fit0'?scoreA(3):noulA(.95);}).fake;
  const ranked=await rankIntroductions({TYPESAFE_API_KEY:'test'},g);assert.equal(ranked.checked,true);assert.equal(ranked.suggestions.length,1);
  globalThis.fetch=jevServer((id:string)=>id==='fit0'?scoreA(0):noulA(.1)).fake;assert.equal((await rankIntroductions({TYPESAFE_API_KEY:'test'},g)).suggestions.length,0);
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'10'}});};
  const fallback=await rankIntroductions({TYPESAFE_API_KEY:'test'},g);assert.equal(fallback.checked,false);assert.equal(fallback.suggestions.length,1);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

test('helper brief ranks complementary evidence without a keyword gate and never exports private shared context',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const {choiceA}=await import('./granola-jev-extractor.test');
 const now=new Date().toISOString();const g:any={source:'workspace',nodes:[{id:'a',name:'Angelica'},{id:'b',name:'Max'},{id:'c',name:'Hidden'}],themeSignals:[{id:'s',personId:'b',summary:'Ran moderated usability interviews with hospital nurses',sourceType:'granola',visibility:'firm',observedAt:now},{id:'private',personId:'c',summary:'SECRET',sourceType:'granola',visibility:'private',observedAt:now}]};
 const original=globalThis.fetch;try{globalThis.fetch=jevServer((id:string,_q:any,state:any)=>{assert.equal(state.candidates.length,1);assert.ok(!JSON.stringify(state).includes('SECRET'));return id.startsWith('fit')?scoreA(3):choiceA('experience',.9);}).fake;
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test'},g,'a','Needs feedback on a clinical scheduling prototype');assert.equal(result.results[0].personId,'b');assert.equal(result.results[0].evidence[0].ref,'s');assert.equal(result.checked,true);
 globalThis.fetch=async()=>new Response('',{status:503});const failed=await rankHelperBrief({TYPESAFE_API_KEY:'test'},g,'a','Needs prototype feedback');assert.equal(failed.status,'unavailable');assert.deepEqual(failed.results,[]);
 }finally{globalThis.fetch=original;}
});

test('helper brief excludes incoming personal shares, stale notes, metadata and denied people',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');
 const graph:any={nodes:[{id:'a'},{id:'b'},{id:'c',permission:'denied'}],themeSignals:[
 {personId:'b',sourceType:'granola',summary:'Private incoming shared work',observedAt:new Date().toISOString(),evidenceRef:'share:other:1'},
 {personId:'b',sourceType:'granola',summary:'Old work',observedAt:'2020-01-01'},
 {personId:'b',sourceType:'gmail_subject',summary:'Clinical scheduling',observedAt:new Date().toISOString()},
 {personId:'c',sourceType:'granola',summary:'Denied work',observedAt:new Date().toISOString()}]};
 const result=await rankHelperBrief({},graph,'a','Clinical scheduling');assert.equal(result.status,'no_evidence');assert.equal(result.considered,0);
 await assert.rejects(()=>rankHelperBrief({},graph,'unknown','Clinical scheduling'),/invalid_request/);
});
