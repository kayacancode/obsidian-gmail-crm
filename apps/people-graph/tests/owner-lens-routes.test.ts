import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {makeSession,sessionCookie} from '../src/session';
import {rankOwnerLens} from '../src/helper-brief';
import {jevServer,scoreA} from './granola-jev-extractor.test';

const fields={focus:'Building a clinic scheduling tool.',needs:'Validate nurse shift handoffs.',offers:''};
const lens=()=>({revision:'rev',enabled:false,fields,updatedAt:null,suggestions:[],sources:[],honcho:{configured:false,status:'disabled',lastSync:null}});
async function fixture(){
 const calls:string[]=[];let value:any=lens();
 const stub:any={bindOwner:async()=>calls.push('bind'),getOwnerLens:async()=>{calls.push('get');return value;},updateOwnerLens:async(input:any)=>{calls.push('save');assert.equal(input.revision,'rev');if(value instanceof Error)throw value;return value;},graph:async()=>{calls.push('graph');return {nodes:[],themeSignals:[]};},helperContext:async()=>[]};
 const env:any={TOKEN_SECRET:'test',GOOGLE_CLIENT_ID:'test',MAIL:{getByName(owner:string){assert.equal(owner,'owner@example.test');calls.push('owner');return stub;}}};
 const cookie=sessionCookie(await makeSession('owner@example.test','test')).split(';')[0];
 const request=(path:string,body?:any,options:any={})=>worker.fetch(new Request('https://people.test'+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{origin:'https://people.test'}),...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)}),...options}),env);
 return {calls,env,stub,request,set:(v:any)=>value=v};
}
test('owner lens routes require authentication, same origin and bounded valid actions before touching storage',async()=>{
 const f=await fixture();
 assert.equal((await worker.fetch(new Request('https://people.test/api/lens'),f.env)).status,401);
 assert.equal((await worker.fetch(new Request('https://people.test/api/lens/matches',{method:'POST'}),f.env)).status,401);
 assert.deepEqual(f.calls,[]);
 const foreign=await f.request('/api/lens',{action:'save',revision:'rev',fields},{headers:{cookie:sessionCookie(await makeSession('owner@example.test','test')).split(';')[0],origin:'https://evil.test'}});
 assert.equal(foreign.status,403);assert.deepEqual(f.calls,[]);
 for(const body of [{action:'save',revision:'rev',fields:{...fields,focus:'x'.repeat(501)}},{action:'save',revision:'rev',fields:{...fields,secret:'x'}},{action:'learning',revision:'rev',enabled:'yes'},{action:'refresh',revision:'rev',note:'x'.repeat(3001)},{action:'bogus',revision:'rev'},null])assert.equal((await f.request('/api/lens',body)).status,400);
 assert.deepEqual(f.calls,[]);
 const read=await f.request('/api/lens');assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.deepEqual(await read.json(),lens());
 f.calls.length=0;assert.equal((await f.request('/api/lens',{action:'save',revision:'rev',fields})).status,200);assert.deepEqual(f.calls,['owner','bind','save']);
 f.set(Error('owner_lens_conflict'));assert.equal((await f.request('/api/lens',{action:'save',revision:'rev',fields})).status,409);
 f.set(Error('raw private content'));const failed=await f.request('/api/lens',{action:'save',revision:'rev',fields});assert.equal(failed.status,500);assert.deepEqual(await failed.json(),{error:'server_error'});
});
test('owner matches use stored confirmed fields, never browser-supplied profile or pending suggestions',async()=>{
 const f=await fixture();f.set({...lens(),fields:{focus:'',needs:'',offers:''},suggestions:[{id:'draft',kind:'focus',text:'Building clinic software',sourceIds:['source']}]});
 assert.equal((await f.request('/api/lens/matches',{fields})).status,400);
 const response=await f.request('/api/lens/matches',{});assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.status,'no_owner_context');assert.deepEqual(body.results,[]);
 assert.equal((await f.request('/api/lens/matches')).status,405);
});
test('owner match search discards results if the saved lens changes during the search',async()=>{
 const f=await fixture();f.stub.graph=async()=>{f.set({...lens(),revision:'new',fields:{...fields,focus:'Changed work'}});return {nodes:[],themeSignals:[]};};
 const response=await f.request('/api/lens/matches',{});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'owner_lens_conflict'});
});
test('unaccepted background profile updates do not invalidate matches for unchanged confirmed fields',async()=>{
 const f=await fixture();f.stub.graph=async()=>{f.set({...lens(),revision:'new',suggestions:[{id:'draft',kind:'focus',text:'Unaccepted update',sourceIds:['s']}]});return {nodes:[],themeSignals:[]};};
 assert.equal((await f.request('/api/lens/matches',{})).status,200);
});
test('owner matching needs no graph self node and verifies the first eligible contact using the full private excerpt',async()=>{
 const old=globalThis.fetch;const date=new Date().toISOString();let generated=false,audited=false;
 const excerpt='I led moderated usability interviews with hospital nurses about shift handoffs.';
 const graph={source:'email_accounts',nodes:[{id:'first',name:'Max'}],themeSignals:[{personId:'first',evidenceRef:'gmail-context:first',sourceType:'gmail_body_derived',summary:'Clipped display preview',visibility:'private',observedAt:date}],helperContext:[{personId:'first',evidenceRef:'gmail-context:first',sourceType:'gmail_body_derived',summary:excerpt,visibility:'private',observedAt:date}]};
 const ai:any={run:async(_model:any,input:any)=>{const state=JSON.parse(input.input[1].content);assert.equal(state.selected.label,'YOU');
  if(input.text.format.schema.properties.matches){generated=true;assert.match(state.selected.brief,/clinic scheduling/);assert.equal(state.candidates[0].evidence[0].summary,excerpt);return {status:'completed',output_text:JSON.stringify({matches:[{candidate:'c0',reason:'You are building a clinic scheduling tool. PERSON_B has interviewed nurses about shift handoffs.',conversation:'Which nurse handoff assumptions should your scheduling tool test first?',anchorRefs:[],candidateRefs:['c0e0']}]})};}
  audited=true;assert.match(state.selected.userBrief,/nurse shift handoffs/);return {status:'completed',output_text:JSON.stringify({sourceReadings:state.candidate.evidence.map((s:any)=>({sourceRef:s.ref,workSubject:'person_or_team',polarity:'affirmed',sentenceIds:[s.sentences[0].id],ownWork:s.sentences[0].text})),grounded:true,attributed:true,specific:true,reason:'The candidate passage supports the requested workflow discussion.'})};
 }};
 try{globalThis.fetch=jevServer(()=>scoreA(3)).fake;const result=await rankOwnerLens({TYPESAFE_API_KEY:'test',AI:ai},graph,fields);assert.equal(result.status,'ready');assert.equal(result.considered,1);assert.equal(result.results[0].personId,'first');assert.match(result.results[0].reason,/You are/);assert.match(result.results[0].reason,/Max/);assert.equal(result.results[0].evidence[0].summary,excerpt);assert.ok(generated&&audited);assert.equal(graph.nodes.length,1);
 }finally{globalThis.fetch=old;}
});
test('empty owner fields perform no model calls and shared graphs cannot supply private owner matches',async()=>{
 const ai:any={run:()=>{throw Error('must not run');}};
 const result=await rankOwnerLens({AI:ai},{nodes:[],themeSignals:[]},{focus:'',needs:'',offers:''});assert.equal(result.status,'no_owner_context');
 await assert.rejects(()=>rankOwnerLens({AI:ai},{source:'workspace',nodes:[]},fields),/invalid_request/);
});
