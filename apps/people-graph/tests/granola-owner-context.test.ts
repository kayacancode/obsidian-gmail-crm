import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGranolaOwnerPassages,type GranolaOwnerContextInput} from '../src/granola-owner-context';

const base:GranolaOwnerContextInput={ownerEmails:['kaya@example.test'],ownerNames:['Kaya Jones','Kaya'],summary:'',privateNotes:'',ownerTranscript:''};
const work='Kaya is building research tools that help climate scientists compare experimental results.';
const pick=(source='summary',start=0,end=start,anchor=start)=>({source,start,end,anchor,kind:'focus'});
function fake(passages:unknown){const calls:any[]=[];return {calls,ai:{async run(_model:string,input:any){calls.push(input);return {response:{passages}};}} as any};}
async function run(input:Partial<GranolaOwnerContextInput>,passages:unknown){const f=fake(passages);return {result:await collectGranolaOwnerPassages({AI:f.ai},{...base,...input}),...f};}

test('Granola owner context keeps exact named-owner summary and private-note excerpts',async()=>{
 const summary=`- ${work}\n\nAlex needs an introduction to a robotics recruiter.`;
 const privateNotes='Kaya Jones can help teams evaluate retrieval quality for legal document search.';
 const {result,calls}=await run({summary,privateNotes},[pick(),pick('privateNotes')]);
 assert.deepEqual(result,[`- ${work}`,privateNotes]);assert.equal(calls.length,1);
 assert.ok(summary.includes(result[0]));assert.ok(privateNotes.includes(result[1]));
 const system=calls[0].messages[0].content;
 assert.match(system,/untrusted/i);assert.match(system,/other attendees/i);assert.match(system,/specific/i);
});

test('Granola owner context accepts verified owner speech and preserves interior whitespace exactly',async()=>{
 const ownerTranscript='I am building a tool for climate researchers.  It compares experimental results across laboratories.';
 const {result}=await run({ownerTranscript},[pick('ownerTranscript',0,1,0)]);
 assert.deepEqual(result,[ownerTranscript]);
});

test('Granola owner context refuses unlabelled I/we in summaries and another attendee as subject',async()=>{
 const summary='I am building a tool for climate scientists. We need laboratory test partners. Alex needs an expert in retrieval quality. Alex asked Kaya to find a robotics recruiter.';
 const {result}=await run({summary},[pick('summary',0),pick('summary',1),pick('summary',2),pick('summary',3)]);
 assert.deepEqual(result,[]);
});

test('Granola owner context rejects third-party reports even when the owner is named',async()=>{
 const summary='Kaya said Alex needs an expert in retrieval quality. Kaya heard that Alex is building a robotics company. Kaya wants to introduce Alex, who needs hiring advice.';
 const ownerTranscript='I heard Alex needs an expert in retrieval quality. Alex: I am building a robotics company.';
 const {result}=await run({summary,ownerTranscript},[pick('summary',0),pick('summary',1),pick('summary',2),pick('ownerTranscript',0),pick('ownerTranscript',1)]);
 assert.deepEqual(result,[]);
});

test('Granola owner context never expands a named-owner passage into an adjacent attendee claim',async()=>{
 const summary=work+' Alex needs an introduction to a robotics recruiter.';
 const {result}=await run({summary},[pick('summary',0,1,0),pick('summary',0)]);
 assert.deepEqual(result,[work]);
});

test('Granola owner context rejects ambiguous first names and does not confuse another surname',async()=>{
 const summary=`Kaya Lee is building scheduling software for hospitals. ${work} Kaya Jones needs laboratory partners to evaluate a climate research tool.`;
 const {result}=await run({summary},[pick('summary',0),pick('summary',1),pick('summary',2)]);
 assert.deepEqual(result,['Kaya Jones needs laboratory partners to evaluate a climate research tool.']);
});

test('Granola owner context never recreates a short alias withheld by the caller',async()=>{
 const {result}=await run({ownerNames:['Kaya Jones'],summary:work},[pick()]);
 assert.deepEqual(result,[]);
});

test('Granola owner context notices a conflicting surname even when its first name is lower case',async()=>{
 const {result}=await run({summary:'kaya Smith is building a hospital scheduling tool. '+work},[pick('summary',1)]);
 assert.deepEqual(result,[]);
});

test('Granola owner context keeps a colon explaining the owners own work, not a speaker label',async()=>{
 const ownerTranscript='I am building a retrieval tool: it helps law firms find contradictory clauses.';
 assert.deepEqual((await run({ownerTranscript},[pick('ownerTranscript')])).result,[ownerTranscript]);
});

test('Granola owner context requires trusted identity and supports an exact owner email',async()=>{
 const {result}=await run({ownerNames:[],summary:'kaya@example.test needs climate laboratories to test a research comparison tool.'},[pick()]);
 assert.deepEqual(result,['kaya@example.test needs climate laboratories to test a research comparison tool.']);
 const missing=await run({ownerNames:[],ownerEmails:[],summary:work},[pick()]);assert.deepEqual(missing.result,[]);
});

test('Granola owner context removes repeated generic updates and deduplicates exact passages',async()=>{
 const ownerTranscript='We are in beta for iOS. We are in beta for iOS. I would love your feedback.';
 const summary=work+' '+work;
 const {result}=await run({ownerTranscript,summary},[pick('ownerTranscript',0),pick('ownerTranscript',1),pick('ownerTranscript',2),pick('summary',0),pick('summary',1)]);
 assert.deepEqual(result,[work]);
});

test('Granola owner context keeps valid selections beside malformed ranges without repairing them',async()=>{
 const {result}=await run({summary:work},[null,pick('summary',-1),pick('summary',0,40),{...pick(),start:'0'},pick()]);
 assert.deepEqual(result,[work]);
 await assert.rejects(run({summary:work},[pick('summary',0,40)]),/invalid_extraction/);
});

test('Granola owner context rejects long excerpts and never returns more than eight',async()=>{
 const summary='Kaya is building '+ 'climate research tools '.repeat(100)+'.';
 assert.deepEqual((await run({summary},[pick()])).result,[]);
 await assert.rejects(run({summary:work},Array.from({length:9},()=>pick())),/invalid_extraction/);
});

test('Granola owner context bounds inputs and ignores a clipped final sentence',async()=>{
 const summary='Kaya is building '+ 'climate research tools '.repeat(2000)+'.';
 const {result,calls}=await run({summary},[]);assert.deepEqual(result,[]);
 assert.ok(calls.length===0||calls[0].messages[1].content.length<40_000);
});

test('Granola owner context handles structured/string envelopes and fails closed on malformed output',async()=>{
 for(const output of [{passages:[pick()]},{response:JSON.stringify({passages:[pick()]})}]){
  const result=await collectGranolaOwnerPassages({AI:{run:async()=>output} as any},{...base,summary:work});assert.deepEqual(result,[work]);
 }
 for(const output of [{response:'not JSON'},{response:{passages:'wrong'}},{response:{passages:[],prose:work}}])await assert.rejects(collectGranolaOwnerPassages({AI:{run:async()=>output} as any},{...base,summary:work}),/invalid_extraction/);
 await assert.rejects(collectGranolaOwnerPassages({},{...base,summary:work}),/ai_unavailable/);
 await assert.rejects(collectGranolaOwnerPassages({AI:{run:async()=>{throw Error('secret provider detail');}} as any},{...base,summary:work}),/^Error: ai_unavailable$/);
});
