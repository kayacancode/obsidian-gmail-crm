import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestIntroductions,rankIntroductions} from '../src/workspace-introductions';
import {jevServer,noulA,scoreA,choiceA} from './granola-jev-extractor.test';
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

test('helper brief ranks complementary evidence without exporting private shared context',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');
 const now=new Date().toISOString();const g:any={source:'workspace',nodes:[{id:'a',name:'Angelica'},{id:'b',name:'Max'},{id:'c',name:'Hidden'}],themeSignals:[{id:'s',personId:'b',summary:'Ran moderated usability interviews with hospital nurses',sourceType:'granola',visibility:'firm',observedAt:now},{id:'private',personId:'c',summary:'SECRET',sourceType:'granola',visibility:'private',observedAt:now}]};
 const original=globalThis.fetch;try{globalThis.fetch=jevServer((id:string,q:any,state:any)=>{assert.ok(!JSON.stringify({state,q}).includes('SECRET'));return id.startsWith('fit')?scoreA(3):noulA(.98);}).fake;
 const env={TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,anchorRefs:[]})};
 const result=await rankHelperBrief(env,g,'a','Needs feedback on a clinical scheduling prototype');assert.equal(result.results[0].personId,'b');assert.equal(result.results[0].evidence[0].ref,'s');assert.equal(result.checked,true);
 globalThis.fetch=async()=>new Response('',{status:503});const failed=await rankHelperBrief(env,g,'a','Needs prototype feedback');assert.equal(failed.status,'unavailable');assert.deepEqual(failed.results,[]);
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

test('automatic helper suggestions use dated context without a manual brief',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()},clinicGraph(),'a','');assert.equal(result.results.length,1);assert.equal(result.automatic,true);assert.equal(result.anchorEvidence[0].ref,'a1');assert.equal(result.results[0].anchorEvidence[0].ref,'a1');
 }finally{globalThis.fetch=original;}
});

test('helper route ranks the current graph outside the long-running sync object',async()=>{
 const {helperRoute}=await import('../src/mail-routes');
 const graph=clinicGraph(),original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const env:any={TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,anchorRefs:[]}),MAIL:{getByName:()=>({bindOwner:async()=>{},refreshHelperContext:async()=>{},helperContext:async()=>[],recommendationMemory:async()=>({revision:'empty',people:{}}),graph:async()=>graph})}};
 const response=await helperRoute(new Request('https://example.com/api/people/helpers',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:JSON.stringify({personId:'a',brief:'Clinic scheduling feedback'})}),env,'owner');
 assert.equal(response.status,200);assert.equal((await response.json() as any).results[0].personId,'b');
 }finally{globalThis.fetch=original;}
});

test('automatic helper suggestions allow a specific peer conversation without inventing a need',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');
 const g={nodes:[{id:'a'},{id:'b'}],themeSignals:[helperSignal('a','a1','We are building decision models for coding agents.'),helperSignal('b','b1','We built an evaluation harness for coding agent decisions.')]};
 const proposal={...groundedProposal,reason:'PERSON_A builds coding-agent decision models. PERSON_B built a coding-agent evaluation harness, supporting a comparison of how to measure decision failures.',conversation:'Which coding-agent decision failures should an evaluation harness measure?'};
 const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI(proposal)},g,'a','');
 assert.equal(result.results.length,1);assert.equal(result.results[0].personId,'b');assert.equal(result.results[0].conversation,proposal.conversation);
 globalThis.fetch=jevServer((id:string)=>id.startsWith('fit')?scoreA(.8):noulA(.98)).fake;
 assert.equal((await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI(proposal)},g,'a','')).results.length,0);
 }finally{globalThis.fetch=original;}
});

test('automatic helpers do not lower the relevance floor to force a result',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=jevServer((id:string)=>id.startsWith('fit')?{...scoreA(1.83),probabilities:{'0':.22,'1':.11,'2':.28,'3':.39}}:noulA(.98)).fake;
 assert.equal((await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()},clinicGraph(),'a','')).results.length,0);
 }finally{globalThis.fetch=original;}
});

test('helper decisions scope each candidate to its own excerpts and exclude social greetings',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');
 const g={nodes:[{id:'a'},{id:'b'},{id:'c'},{id:'d'}],themeSignals:[helperSignal('a','a1','We build coding agent decision models.'),helperSignal('b','b1','We evaluate coding agent decisions.'),helperSignal('c','c1','I hope you had a great time at the launch!'),helperSignal('d','d1','We build clinical scheduling tools.')]};
 const original=globalThis.fetch;
 try{globalThis.fetch=jevServer((id:string,q:any,state:any)=>{
 if(!id.startsWith('fit'))return noulA(.98);
 assert.equal(state.candidates,undefined);assert.equal(q.instructions.candidate.length,1);
 return scoreA(q.instructions.candidate[0].summary.includes('coding')?3:0);
 }).fake;
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()},g,'a','');assert.equal(result.considered,2);assert.deepEqual(result.results.map((r:any)=>r.personId),['b']);
 }finally{globalThis.fetch=original;}
});

// A positive first-pass relevance score is not evidence that a useful introduction exists.
// These fixtures exercise the final grounded-result boundary independently of retrieval scores.
const helperSignal=(personId:string,id:string,summary:string)=>({personId,id,evidenceRef:id,summary,sourceType:'gmail_body_derived',visibility:'private',observedAt:new Date().toISOString()});
const clinicGraph=()=>({nodes:[{id:'a',name:'Angelica'},{id:'b',name:'Max'}],themeSignals:[helperSignal('a','a1','We are building scheduling tools for clinics and need to validate nurse handoff workflows.'),helperSignal('b','b1','I led moderated usability interviews with hospital nurses about shift handoffs.')]});
const groundedProposal={candidate:'c0',reason:'PERSON_A needs nurse workflow validation for a clinic scheduling project. PERSON_B has run nurse interviews about handoffs.',conversation:'Which handoff assumptions should the clinic scheduling prototype test with nurses first?',anchorRefs:['a0'],candidateRefs:['c0e0']};
function helperResponse(value:any){return {status:'completed',output_text:JSON.stringify(value)};}
function helperAuditValue(input:any,audit:any={grounded:true,attributed:true,specific:true,reason:'The cited facts support this specific proposed conversation.'}){
 const state=JSON.parse(input.input[1].content),sources=[...(state.selected.evidence||[]),...state.candidate.evidence];
 return {sourceReadings:sources.map((s:any)=>({sourceRef:s.ref,workSubject:'person_or_team',polarity:'affirmed',sentenceIds:[s.sentences?.[0]?.id],ownWork:s.sentences?.[0]?.text})),...audit};
}
function helperAI(proposal:any=groundedProposal,audit:any={grounded:true,attributed:true,specific:true,reason:'The cited facts support this specific proposed conversation.'}){return {run:async(_model:any,input:any)=>helperResponse(input.text.format.schema.properties.matches?{matches:proposal?[proposal]:[]}:helperAuditValue(input,audit))} as any;}
function groundedJev(specific=.98,supported=.98){return jevServer((id:string)=>id.startsWith('fit')?scoreA(3):id.startsWith('kind')?choiceA('feedback',.98):id.startsWith('supported')?noulA(supported):noulA(specific)).fake;}

test('helper models retain verified Gmail authorship without assigning authors to mixed or meeting context',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g:any=clinicGraph();g.themeSignals[0].provenance={title:'Email sender’s own words · building'};
 g.themeSignals[1].evidenceRef='gmail-context:verified-b';
 const thirdParty='A person I met once led usability interviews with nurses. I have not worked on clinical workflows myself.';
 const mixed={...helperSignal('b','mixed',thirdParty),observedAt:new Date(Date.now()-1000).toISOString()};
 const meeting={...helperSignal('b','meeting','We discussed clinic workflows.'),sourceType:'granola',observedAt:new Date(Date.now()-2000).toISOString()};
 g.themeSignals.push(mixed,meeting);
 let generated=false,audited=false;
 const ai={run:async(_model:any,input:any)=>{
  const state=JSON.parse(input.input[1].content);
  assert.equal(state.selected.evidence[0].authoredBy,'PERSON_A');
  assert.equal(state.selected.evidence[0].sourceKind,'sender_own_words');
  if(input.text.format.schema.properties.matches){
   generated=true;const sources=state.candidates[0].evidence;
   assert.equal(sources[0].authoredBy,'PERSON_B');
   assert.equal(sources[1].authoredBy,'unknown');assert.equal(sources[1].sourceKind,'reported_context');
   assert.equal(sources[1].summary,thirdParty,'the full ownership and negation context must remain intact');
   assert.equal(sources[2].authoredBy,'unknown');
   return helperResponse({matches:[groundedProposal]});
  }
  audited=true;assert.equal(state.candidate.evidence[0].authoredBy,'PERSON_B');
  assert.deepEqual(state.candidate.backgroundEvidence.map((e:any)=>e.authoredBy),['PERSON_B','unknown','unknown']);
  return helperResponse(helperAuditValue(input,{grounded:true,attributed:true,specific:true,reason:'Only the verified sender excerpt establishes who is speaking.'}));
 }} as any;
 try{globalThis.fetch=groundedJev();const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:ai},g,'a','');assert.equal(result.results.length,1);assert.equal(generated,true);assert.equal(audited,true);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers reject the Riyad Dennis beta onboarding match after a positive shortlist',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g={nodes:[{id:'a'},{id:'b'}],themeSignals:[helperSignal('a','a1','We are currently in beta for iOS, iterating daily improvements.'),helperSignal('b','b1',"We've been trying to meet with 1 person/day to show them our new onboarding")]};
 try{globalThis.fetch=groundedJev(.08,.98);
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,reason:'PERSON_A and PERSON_B are improving early products and could exchange feedback.',conversation:'What feedback do you have on the product?'},{grounded:true,attributed:true,specific:false,reason:'Both sources are generic product activity without a concrete bridge.'})} as any,g,'a','');
 assert.equal(result.checked,true);assert.deepEqual(result.results,[],'a broad final proposal must be discarded even after a strong shortlist score');
 }finally{globalThis.fetch=original;}
});

test('grounded helpers return a concrete conversation and only the cited pair evidence',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()} as any,clinicGraph(),'a','');
 assert.equal(result.checked,true);assert.equal(result.results.length,1);assert.equal(result.results[0].conversation,groundedProposal.conversation);
 assert.equal(result.results[0].reason,'Angelica needs nurse workflow validation for a clinic scheduling project. Max has run nurse interviews about handoffs.');assert.deepEqual(result.results[0].anchorEvidence.map((e:any)=>e.ref),['a1']);assert.deepEqual(result.results[0].evidence.map((e:any)=>e.ref),['b1']);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers reject invented or cross-person citations and unsupported claims',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 for(const candidateRefs of [['invented'],['a0']]){
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,candidateRefs})} as any,clinicGraph(),'a','');assert.deepEqual(result.results,[]);
 }
 globalThis.fetch=groundedJev(.98,.2);
 const unsupported=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,reason:'PERSON_A is validating nurse workflows. PERSON_B built a clinical scheduling company and can introduce hospital buyers.'},{grounded:false,attributed:true,specific:true,reason:'The source does not say they built a scheduling company or know hospital buyers.'})} as any,clinicGraph(),'a','');assert.deepEqual(unsupported.results,[]);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers need the explanation model and preserve manual brief provenance',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const missing=await rankHelperBrief({TYPESAFE_API_KEY:'test'},clinicGraph(),'a','');assert.equal(missing.status,'unavailable');assert.deepEqual(missing.results,[]);
 const manual=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,anchorRefs:[]})} as any,clinicGraph(),'a','Need feedback on nurse handoffs');assert.equal(manual.automatic,false);assert.deepEqual(manual.anchorEvidence,[]);assert.deepEqual(manual.results[0].anchorEvidence,[]);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers replace clipped Gmail evidence with full private context but never on shared graphs',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g:any=clinicGraph();g.themeSignals[0].summary='We are building scheduling tools.';g.helperContext=[helperSignal('a','a1','We are building scheduling tools for clinics and need to validate nurse handoff workflows.'),helperSignal('a','a1','We are building scheduling tools for clinics and need to validate nurse handoff workflows.')];
 try{globalThis.fetch=groundedJev();
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()} as any,g,'a','');assert.equal(result.anchorEvidence.length,1);assert.match(result.anchorEvidence[0].summary,/handoff workflows/);
 g.source='workspace';g.themeSignals.forEach((s:any)=>s.visibility='firm');
 const shared=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()} as any,g,'a','');assert.doesNotMatch(shared.anchorEvidence[0].summary,/handoff workflows/);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers never fall back to legacy fragments when full private context is still syncing',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g:any=clinicGraph();g.themeSignals[0].id=g.themeSignals[0].evidenceRef='gmail-context:legacy';g.helperContext=[];
 try{globalThis.fetch=groundedJev();
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()},g,'a','');
 assert.equal(result.status,'no_anchor_context');assert.deepEqual(result.anchorEvidence,[]);assert.deepEqual(result.results,[]);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers reject unfinished explanations and inline source markers',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 for(const reason of [
  'PERSON_A needs handoff validation, and PERSON_B has',
  'PERSON_A needs clinic workflow testing [a0], and PERSON_B has nurse interview experience [c0e0].',
  'PERSON_A needs testing from PERSON_B. '+Array(50).fill('relevant').join(' ')+'.'
 ]){
  const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,reason})},clinicGraph(),'a','');
  assert.deepEqual(result.results,[],'unfinished or unreadable generated explanations are not recommendations');
 }
 }finally{globalThis.fetch=original;}
});

test('grounded helpers supply only cited source evidence to the independent audit',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const AI:any={run:async(_model:any,input:any)=>{
  if(input.text.format.schema.properties.matches)return helperResponse({matches:[groundedProposal]});
  const state=JSON.parse(input.input[1].content);
  const hasPair=state.selected?.evidence?.[0]?.summary.includes('handoff')&&state.candidate?.evidence?.[0]?.summary.includes('nurses')&&state.proposal?.conversation;
  return helperResponse(helperAuditValue(input,{grounded:!!hasPair,attributed:true,specific:true,reason:'The independently supplied sources support the statements.'}));
 }};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');assert.equal(result.results.length,1);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers reject a source-audit veto even when the relevance judge is positive',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 let calls=0;const AI:any={run:async(_model:any,input:any)=>++calls===1?helperResponse({matches:[groundedProposal]}):helperResponse(helperAuditValue(input,{grounded:false,attributed:true,specific:true,reason:'The stated experience is not supported by the source.'}))};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');assert.deepEqual(result.results,[]);assert.equal(result.checked,true);
 }finally{globalThis.fetch=original;}
});

test('grounded helpers report an incomplete source audit as unavailable',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 for(const fail of [false,true]){let calls=0;const AI:any={run:async()=>{if(++calls===1)return helperResponse({matches:[groundedProposal]});if(fail)throw Error('provider unavailable');return helperResponse({grounded:'true',attributed:true,specific:true,reason:'Malformed field'});}};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');assert.equal(result.status,'unavailable');assert.equal(result.checked,false);assert.deepEqual(result.results,[]);}
 }finally{globalThis.fetch=original;}
});

test('helper source proofs require complete sentences from the correct cited passage',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 for(const invalid of ['missing','wrong-source','partial-quote']){
  const AI:any={run:async(_model:any,input:any)=>{
   if(input.text.format.schema.properties.matches)return helperResponse({matches:[groundedProposal]});
   const audit=helperAuditValue(input);
   if(invalid==='missing')delete audit.sourceReadings;
   else if(invalid==='wrong-source')audit.sourceReadings[1].sentenceIds=audit.sourceReadings[0].sentenceIds;
   else audit.sourceReadings[1].ownWork='led moderated usability interviews';
   return helperResponse(audit);
  }};
  const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');
  assert.equal(result.status,'unavailable');assert.deepEqual(result.results,[]);
 }
 }finally{globalThis.fetch=original;}
});

test('helper source readings veto third-party and negated work despite positive final verdicts',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 for(const reading of [{workSubject:'third_party',polarity:'affirmed'},{workSubject:'person_or_team',polarity:'negated'}]){
  const AI:any={run:async(_model:any,input:any)=>{
   if(input.text.format.schema.properties.matches)return helperResponse({matches:[groundedProposal]});
   const audit=helperAuditValue(input);Object.assign(audit.sourceReadings[1],reading);return helperResponse(audit);
  }};
  const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');
  assert.equal(result.checked,true);assert.deepEqual(result.results,[]);
 }
 }finally{globalThis.fetch=original;}
});

test('helper pair audits preserve valid recommendations when another proof is malformed',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const graph:any=clinicGraph();graph.nodes.push({id:'c',name:'Casey'});
 graph.themeSignals.push({...helperSignal('c','c1','We tested nurse handoff prototypes with ward staff.'),observedAt:new Date(Date.now()-1000).toISOString()});
 let mode='one-failure';
 const AI:any={run:async(_model:any,input:any)=>{
  if(input.text.format.schema.properties.matches)return helperResponse({matches:[groundedProposal,{...groundedProposal,candidate:'c1',candidateRefs:['c1e0']}]});
  const state=JSON.parse(input.input[1].content),audit=helperAuditValue(input);
  if(mode==='all-fail'||(mode==='one-failure'&&state.candidate.evidence[0].summary.startsWith('I led')))delete audit.sourceReadings;
  if(mode==='semantic-veto')audit.specific=false;
  return helperResponse(audit);
 }};
 try{globalThis.fetch=groundedJev();
 const partial=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},graph,'a','');assert.equal(partial.status,'ready');assert.equal(partial.checked,true);assert.deepEqual(partial.results.map(r=>r.personId),['c']);
 mode='all-fail';const failed=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},graph,'a','');assert.equal(failed.status,'unavailable');assert.equal(failed.checked,false);
 mode='semantic-veto';const empty=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},graph,'a','');assert.equal(empty.status,'ready');assert.equal(empty.checked,true);assert.deepEqual(empty.results,[]);
 }finally{globalThis.fetch=original;}
});

test('grounded helper audit checks uncited newer updates before accepting older work',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g:any=clinicGraph();g.themeSignals[1].observedAt=new Date(Date.now()-2*86400000).toISOString();
 g.themeSignals.push(helperSignal('b','b2','We stopped all healthcare research and no longer advise on nurse workflows.'));
 try{globalThis.fetch=groundedJev();
 const AI:any={run:async(_model:any,input:any)=>{
  if(input.text.format.schema.properties.matches)return helperResponse({matches:[{...groundedProposal,candidateRefs:['c0e1']}]});
  const state=JSON.parse(input.input[1].content);
  const superseded=state.candidate?.backgroundEvidence?.some((e:any)=>e.summary.includes('stopped all healthcare'));
  return helperResponse(helperAuditValue(input,{grounded:!superseded,attributed:true,specific:true,reason:superseded?'The older work is superseded by a newer explicit update.':'The cited older work seems relevant.'}));
 }};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','');assert.deepEqual(result.results,[]);
 }finally{globalThis.fetch=original;}
});

test('grounded helper names replace fixed labels only after source verification',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const g:any=clinicGraph();g.nodes[0].name='Angelica';g.nodes[1].name='Max PERSON_A';
 const proposal={...groundedProposal,reason:'PERSON_A needs to test clinic handoffs; PERSON_B has interviewed nurses about handoffs. They could compare workflow assumptions.'};
 try{globalThis.fetch=groundedJev();
 const AI:any={run:async(_model:any,input:any)=>{
  if(input.text.format.schema.properties.matches)return helperResponse({matches:[proposal]});
  const state=JSON.parse(input.input[1].content),labelsIntact=state.proposal.reason.includes('PERSON_A')&&state.proposal.reason.includes('PERSON_B');
  assert.ok(!JSON.stringify(state).includes('Angelica'),'real identities are not needed for the audit');
  return helperResponse(helperAuditValue(input,{grounded:labelsIntact,attributed:true,specific:true,reason:'The two anonymous source owners support these descriptions.'}));
 }};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','');
 assert.equal(result.results[0].reason,'Angelica needs to test clinic handoffs; Max PERSON_A has interviewed nurses about handoffs. They could compare workflow assumptions.');
 }finally{globalThis.fetch=original;}
});

test('helper reasoning model reads final response text and never reasoning content',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();let calls=0;
 const AI:any={run:async(model:string,input:any)=>{
  assert.equal(model,'@cf/openai/gpt-oss-120b');assert.equal(input.reasoning.effort,'medium');assert.equal(input.text.format.type,'json_schema');
  const final=++calls===1?{matches:[groundedProposal]}:helperAuditValue(input,{grounded:true,attributed:true,specific:true,reason:'The cited source passages support this proposed comparison.'});
  return {status:'completed',output:[{type:'reasoning',content:[{type:'reasoning_text',text:'Private internal reasoning must never be parsed or returned.'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(final)}]}]};
 }};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');assert.equal(result.results.length,1);assert.doesNotMatch(JSON.stringify(result),/Private internal reasoning/);
 }finally{globalThis.fetch=original;}
});

test('helper reasoning model rejects incomplete malformed or reasoning-only responses',async()=>{
 const {runHelperModel}=await import('../src/helper-model');
 const input={instructions:'Return the supplied synthetic test.',state:{synthetic:true},schema:{type:'object'},name:'test',maxOutputTokens:8192};
 for(const output of [
  {status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"matches":[]}'},
  {status:'completed',error:{message:'provider failed'},output_text:'{"matches":[]}'},
  {status:'completed',output:[{type:'reasoning',content:[{type:'reasoning_text',text:'{"matches":[]}'}]}]},
  {status:'completed',output_text:'{"matches":'},
  {status:'completed',output_text:'x'.repeat(24_001)},
 ])await assert.rejects(()=>runHelperModel({run:async()=>output} as any,input,AbortSignal.timeout(1000)),/invalid_helper_output/);
 let called=false;await assert.rejects(()=>runHelperModel({run:async()=>{called=true;return {};}} as any,input,AbortSignal.abort()),/ai_unavailable/);assert.equal(called,false);
});

test('helper model constrains opaque candidate keys separately from prose identity labels',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 try{globalThis.fetch=groundedJev();
 const AI:any={run:async(_model:any,input:any)=>{
  assert.equal(input.input[0].role,'system');assert.equal(input.input[1].role,'user');
  const properties=input.text.format.schema.properties;
  if(properties.matches){const candidate=properties.matches.items.properties.candidate.enum?.[0]||'PERSON_B';return helperResponse({matches:[{...groundedProposal,candidate}]});}
  return helperResponse(helperAuditValue(input,{grounded:true,attributed:true,specific:true,reason:'The separate source owners and concrete bridge are supported.'}));
 }};
 const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},clinicGraph(),'a','');assert.equal(result.results.length,1);
 }finally{globalThis.fetch=original;}
});

test('helper explanations allow a complete concise sentence just over forty words',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const original=globalThis.fetch;
 const reason='PERSON_A is building a scheduling tool for clinics and wants to test nurse handoff workflows. PERSON_B has led interviews with hospital nurses and tested handoff prototypes, giving them concrete experience to discuss which workflow assumptions the new tool should validate first.';
 assert.equal(reason.split(/\s+/).length,41);
 try{globalThis.fetch=groundedJev();const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI({...groundedProposal,reason})},clinicGraph(),'a','');assert.equal(result.results.length,1);
 }finally{globalThis.fetch=original;}
});

const memoryPerson=(personId:string,overrides:Record<string,unknown>={})=>({personId,text:'',revision:'memory-'+personId,updatedAt:Date.parse('2020-01-01T00:00:00Z'),company:'',building:'',needs:'',offers:'',interests:[],pointPersonId:null,notBefore:null,relationship:'neutral',entries:[],...overrides});
test('relationship memory enables durable owner-reported candidate evidence with full attribution and audit',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const previous=globalThis.fetch;
 const passage='Max has interviewed nurses about handoffs. '+('The interviews covered clinic staffing and continuity. '.repeat(24))+'He has not worked on hospital procurement.';
 const g:any={nodes:[{id:'a',name:'Angelica'},{id:'b',name:'Max'},{id:'p',name:'Jordan'}],themeSignals:[],recommendationMemory:{revision:'one',people:{b:memoryPerson('b',{pointPersonId:'p',entries:[{id:'entry',sourceKind:'voice_transcript',createdAt:Date.parse('2020-01-01T00:00:00Z'),text:passage}]})}}};
 let audits=0;
 const AI:any={run:async(_model:any,input:any)=>{const state=JSON.parse(input.input[1].content),source=state.candidates?.[0]?.evidence[0]||state.candidate?.evidence[0];
  assert.equal(source.authoredBy,'OWNER');assert.equal(source.subject,'PERSON_B');assert.equal(source.sourceKind,'owner_report');assert.equal(source.summary,passage);
  if(state.candidates)return helperResponse({matches:[{...groundedProposal,anchorRefs:[]}]});
  audits++;assert.match(source.sentences.at(-1).text,/not worked on hospital procurement/);return helperResponse(helperAuditValue(input));
 }};
 try{globalThis.fetch=groundedJev();const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','Needs to validate nurse handoffs.');
  assert.equal(result.status,'ready');assert.equal(result.results.length,1);assert.equal(audits,1);assert.equal(result.results[0].evidence[0].sourceType,'owner_context');assert.equal(result.results[0].evidence[0].sourceLabel,'Your saved context');assert.deepEqual((result.results[0] as any).pointPerson,{personId:'p',name:'Jordan'});
 }finally{globalThis.fetch=previous;}
});

test('relationship memory supplies selected evidence while explicit refinement wins and shared matching ignores private memory',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const previous=globalThis.fetch;
 const g:any=clinicGraph();g.themeSignals=g.themeSignals.filter((s:any)=>s.personId==='b');g.recommendationMemory={revision:'one',people:{a:memoryPerson('a',{building:'Clinic scheduling tool.',needs:'Validate nurse handoffs.',entries:[{id:'one',text:'Angelica is testing the workflow with a nursing team.',sourceKind:'text',createdAt:Date.now()}]})}};
 let explicitMode=false;const AI:any={run:async(_model:any,input:any)=>{const state=JSON.parse(input.input[1].content);
  if(explicitMode){assert.equal(state.selected.brief||state.selected.userBrief,'Override only');assert.equal(state.selected.evidence,undefined);}
  else{assert.match(state.selected.evidence[0].summary,/Clinic scheduling/);assert.equal(state.selected.evidence[0].authoredBy,'OWNER');assert.equal(state.selected.evidence[0].subject,'PERSON_A');assert.equal(state.selected.evidence[0].sourceKind,'owner_report');}
  return helperResponse(state.candidates?{matches:[{...groundedProposal,anchorRefs:explicitMode?[]:['a0']}]}:helperAuditValue(input));}};
 try{globalThis.fetch=groundedJev();const saved=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','');assert.equal(saved.automatic,true);assert.equal(saved.results.length,1);assert.match((saved as any).brief,/nursing team/);assert.ok(saved.anchorEvidence.every(e=>e.sourceType==='owner_context'));
  explicitMode=true;const explicit=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','Override only');assert.equal((explicit as any).brief,'Override only');assert.equal(explicit.automatic,false);
  g.source='workspace';g.themeSignals=[];const shared=await rankHelperBrief({},g,'a','');assert.equal(shared.status,'no_anchor_context');assert.deepEqual(shared.results,[]);
 }finally{globalThis.fetch=previous;}
});

test('selected voice memory preserves owner pronouns and full passages through shortlist and independent source audit',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const previous=globalThis.fetch;
 const passage='I am building a clinic scheduling tool; Pat needs help with pricing. '+('Our discussion covered the upcoming product planning session. '.repeat(24))+'Pat has not worked on nurse handoffs.';
 const g:any=clinicGraph();g.nodes[0].name='Pat';g.recommendationMemory={revision:'one',people:{a:memoryPerson('a',{entries:[{id:'voice',sourceKind:'voice_transcript',createdAt:Date.now(),text:passage}]})}};
 let shortlistCalls=0,audits=0;
 const assertOwnerSource=(source:any)=>{assert.equal(source.summary,passage);assert.equal(source.authoredBy,'OWNER');assert.equal(source.subject,'PERSON_A');assert.equal(source.sourceKind,'owner_report');};
 try{
  globalThis.fetch=jevServer((_id:string,q:any,state:any)=>{shortlistCalls++;assert.equal(state.selectedContext.userBrief,undefined);assert.equal(state.selectedContext.evidence.length,1);assertOwnerSource(state.selectedContext.evidence[0]);assert.match(q.instructions.task,/I\/my[^.]*owner/i);return scoreA(3);}).fake;
  for(const reading of [{workSubject:'third_party',polarity:'affirmed'},{workSubject:'person_or_team',polarity:'negated'}]){
   const AI:any={run:async(_model:any,input:any)=>{const state=JSON.parse(input.input[1].content);assertOwnerSource(state.selected.evidence[0]);assert.match(input.input[0].content,/I\/my[^.]*owner/i);
    if(state.candidates)return helperResponse({matches:[groundedProposal]});
    audits++;assertOwnerSource(state.selected.backgroundEvidence[0]);const source=state.selected.evidence[0];assert.match(source.sentences.at(-1).text,/Pat has not worked on nurse handoffs/);
    const audit=helperAuditValue(input),sentence=reading.polarity==='negated'?source.sentences.at(-1):source.sentences[0];Object.assign(audit.sourceReadings[0],reading,{sentenceIds:[sentence.id],ownWork:sentence.text});return helperResponse(audit);
   }};
   const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','');assert.equal(result.checked,true);assert.equal(result.status,'ready');assert.deepEqual(result.results,[],'selected-side third-party or negated readings must veto positive audit verdicts');assert.equal((result as any).brief,passage);
  }
  assert.equal(shortlistCalls,2);assert.equal(audits,2);
 }finally{globalThis.fetch=previous;}
});

test('relationship memory timing and feedback filter candidates without treating weaker relationships as exclusions',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const previous=globalThis.fetch;
 const ids=['closer','neutral','weaker','deferred','suppressed','snoozed'];const g:any={nodes:[{id:'a'},...ids.map(id=>({id,name:id}))],themeSignals:ids.map(id=>helperSignal(id,id,'I interviewed nurses about clinic handoffs.')),personFeedback:{suppressed:{action:'suppress'},snoozed:{action:'snooze',until:Date.now()+86400000}},recommendationMemory:{revision:'one',people:Object.fromEntries(ids.map(id=>[id,memoryPerson(id,{relationship:['closer','weaker'].includes(id)?id:'neutral',notBefore:id==='deferred'?'2099-01-01':null})]))}};
 const AI:any={run:async(_model:any,input:any)=>{const state=JSON.parse(input.input[1].content);return helperResponse(state.candidates?{matches:state.candidates.map((c:any)=>({...groundedProposal,candidate:c.candidate,anchorRefs:[],candidateRefs:[c.evidence[0].ref]})).reverse()}:helperAuditValue(input));}};
 try{globalThis.fetch=groundedJev();const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI},g,'a','Needs nurse handoff validation.');assert.equal(result.considered,3);assert.deepEqual(result.results.map(r=>r.personId),['closer','neutral','weaker']);assert.ok(result.results.every(r=>r.score===3),'relationship preference must not rewrite evidence fit scores');}finally{globalThis.fetch=previous;}
});

test('helper route rejects a candidate memory change even when the selected brief is explicit',async()=>{
 const {helperRoute}=await import('../src/mail-routes');let revision='one';
 const stub:any={bindOwner:async()=>{},graph:async()=>clinicGraph(),recommendationMemory:async()=>({revision,people:{}}),helperContext:async()=>{revision='two';return [];}};
 const response=await helperRoute(new Request('https://people.test/api/people/helpers',{method:'POST',headers:{origin:'https://people.test'},body:JSON.stringify({personId:'a',brief:'Validate nurse handoffs.'})}),{MAIL:{getByName:()=>stub}} as any,'owner');
 assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'person_context_conflict'});
});

test('shared introduction explanations use only shared sources and discard unsupported pair prose',async()=>{
 const previous=globalThis.fetch,g:any=fixture();g.source='workspace';g.themeSignals.forEach((s:any)=>s.visibility='firm');g.recommendationMemory={revision:'private',people:{a:memoryPerson('a',{text:'SECRET OWNER NOTE'})}};g.viewerPrivateContext={b:[{summary:'SECRET PRIVATE EXCERPT'}]};g.themeSignals.push({...g.themeSignals[0],visibility:'private',summary:'SECRET PRIVATE SIGNAL',observedAt:new Date().toISOString()});
 const proposal={...groundedProposal,reason:'PERSON_A builds creative interfaces. PERSON_B researches interface workflows for artists.',conversation:'Which artist workflows could inform the creative interface?'};
 let supported=true,audits=0;const AI:any={run:async(_model:any,input:any)=>{assert.doesNotMatch(JSON.stringify(input),/SECRET/);if(input.text.format.schema.properties.matches)return helperResponse({matches:[proposal]});audits++;return helperResponse(helperAuditValue(input,{grounded:supported,attributed:true,specific:supported,reason:'Both shared passages establish the proposed interface conversation.'}));}};
 try{globalThis.fetch=groundedJev();const valid=await rankIntroductions({TYPESAFE_API_KEY:'test',AI} as any,g);assert.equal(valid.suggestions.length,1);assert.equal((valid.suggestions[0] as any).conversation,proposal.conversation);assert.equal(valid.suggestions[0].reason,'Ada builds creative interfaces. Bo researches interface workflows for artists.');assert.equal(audits,1);
  supported=false;const rejected=await rankIntroductions({TYPESAFE_API_KEY:'test',AI} as any,g);assert.deepEqual(rejected.suggestions,[]);
 }finally{globalThis.fetch=previous;}
});

test('relationship memory keeps full passages within explanation input limits for several detailed candidates',async()=>{
 const {rankHelperBrief}=await import('../src/helper-brief');const previous=globalThis.fetch;
 const fill=(size:number)=>'Nurses described clinic handoff workflows. '.repeat(Math.ceil(size/42)).slice(0,size);
 const ids=['a','b','c','d','e','f','g'];const people=Object.fromEntries(ids.map(id=>[id,memoryPerson(id,{company:fill(160),building:fill(600),needs:fill(600),offers:fill(600),interests:Array(8).fill(fill(80)),text:fill(1000),entries:Array.from({length:10},(_,i)=>({id:String(i),text:fill(2000),sourceKind:'text',createdAt:Date.now()-i}))})]));
 const g:any={nodes:ids.map(id=>({id,name:id})),themeSignals:ids.slice(1).flatMap(id=>[helperSignal(id,id+'-one',fill(1200)),helperSignal(id,id+'-two','Another observation. '+fill(1170))]),recommendationMemory:{revision:'one',people}};
 try{globalThis.fetch=groundedJev();const result=await rankHelperBrief({TYPESAFE_API_KEY:'test',AI:helperAI()},g,'a','');assert.equal(result.status,'ready');assert.equal(result.results.length,1);}finally{globalThis.fetch=previous;}
});

test('private recommendation routes reject feedback changes during graph loading',async()=>{
 const {helperRoute}=await import('../src/mail-routes'),{ownerLensRoute}=await import('../src/owner-lens-routes');
 for(const kind of ['helper','owner'] as const){let revision='one';
  const stub:any={bindOwner:async()=>{},recommendationMemory:async()=>({revision,people:{}}),graph:async()=>{revision='two';return clinicGraph();},helperContext:async()=>[],getOwnerLens:async()=>({fields:{focus:'Clinic scheduling.',needs:'Nurse handoff validation.',offers:''}})};
  const path=kind==='helper'?'/api/people/helpers':'/api/lens/matches',body=kind==='helper'?{personId:'a',brief:'Nurse handoff validation.'}:{};
  const response=await (kind==='helper'?helperRoute:ownerLensRoute)(new Request('https://people.test'+path,{method:'POST',headers:{origin:'https://people.test'},body:JSON.stringify(body)}),{MAIL:{getByName:()=>stub}} as any,'owner');
  assert.equal(response.status,409,kind+' must read the baseline revision before the graph');
 }
});
