import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectGranolaMeetingTopics,collectGranolaOwnerPassages,type GranolaOwnerContextInput} from '../src/granola-owner-context';

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

test('Granola meeting topics preserve a specific discussion about another participant without owner attribution',async()=>{
 const summary='Alex demonstrated a retrieval tool for law firms.  It finds contradictory clauses across client contracts.';
 const f=fake([{start:0,end:1}]);
 assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary}),[summary]);assert.equal(f.calls.length,1);
 assert.match(f.calls[0].messages[0].content,/meeting activity/i);assert.match(f.calls[0].messages[0].content,/not.*owner/i);
 const sent=JSON.parse(f.calls[0].messages[1].content);assert.deepEqual(sent.sentences,summary.split('  '));
 assert.ok(!Object.hasOwn(sent,'ownerIdentities'));
});

test('Granola meeting topics never send or select private notes',async()=>{
 const summary='The team compared experimental data workflows used by climate laboratories.';
 const privateNotes='Private: Alex needs confidential advice about a personal medical diagnosis.';
 const f=fake([{start:0,end:0}]);
 assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary,privateNotes}),[summary]);
 assert.ok(!JSON.stringify(f.calls).includes(privateNotes));
 const empty=fake([{start:0,end:0}]);assert.deepEqual(await collectGranolaMeetingTopics({AI:empty.ai},{summary:'',privateNotes}),[]);assert.equal(empty.calls.length,0);
});

test('Granola meeting topics reject malformed indexes and preserve independently valid exact ranges',async()=>{
 const summary='Alex demonstrated a retrieval tool that finds contradictory clauses in legal contracts.';
 for(const bad of [null,{start:'0',end:0},{start:-1,end:0},{start:1,end:0},{start:0,end:1},{start:0,end:0,quote:'generated'}]){
  const f=fake([bad,{start:0,end:0}]);assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary}),[summary]);
  await assert.rejects(collectGranolaMeetingTopics({AI:fake([bad]).ai},{summary}),/invalid_extraction/);
 }
});

test('Granola meeting topics enforce three passages, four sentences, 1200 characters and paragraph boundaries',async()=>{
 const summary=Array.from({length:5},(_,i)=>`Project ${i} helps climate laboratories compare experiment results.`).join(' ');
 const three=fake([{start:0,end:0},{start:1,end:1},{start:2,end:2}]);assert.equal((await collectGranolaMeetingTopics({AI:three.ai},{summary})).length,3);
 await assert.rejects(collectGranolaMeetingTopics({AI:fake(Array.from({length:4},(_,i)=>({start:i,end:i}))).ai},{summary}),/invalid_extraction/);
 await assert.rejects(collectGranolaMeetingTopics({AI:fake([{start:0,end:4}]).ai},{summary}),/invalid_extraction/);
 const long='The project compares '+'climate laboratory experiments '.repeat(50)+'.';
 assert.deepEqual(await collectGranolaMeetingTopics({AI:fake([{start:0,end:0}]).ai},{summary:long}),[]);
 const separate='Alex demonstrated a contract retrieval tool.\n\nThe group compared robotics hiring projects.';
 assert.deepEqual(await collectGranolaMeetingTopics({AI:fake([{start:0,end:1}]).ai},{summary:separate}),[]);
});

test('Granola meeting topics omit generic logistics and deduplicate repeated exact discussion',async()=>{
 const summary='We are in beta for iOS. Alex demonstrated a contract retrieval tool for law firms. Alex demonstrated a contract retrieval tool for law firms.';
 assert.deepEqual(await collectGranolaMeetingTopics({AI:fake([{start:0,end:0},{start:1,end:1},{start:2,end:2}]).ai},{summary}),['Alex demonstrated a contract retrieval tool for law firms.']);
 const prompt=fake([]);await collectGranolaMeetingTopics({AI:prompt.ai},{summary});
 assert.match(prompt.calls[0].messages[0].content,/untrusted/i);assert.match(prompt.calls[0].messages[0].content,/credentials/i);assert.match(prompt.calls[0].messages[0].content,/personal health/i);assert.match(prompt.calls[0].messages[0].content,/financial/i);assert.match(prompt.calls[0].messages[0].content,/scheduling/i);
});

test('Granola meeting topics cap the sent source and exclude its clipped final sentence',async()=>{
 const f=fake([{start:0,end:0}]),first='Alex demonstrated a retrieval tool for legal contracts.';
 const summary=first+' '+'A'.repeat(30_000)+'.';
 assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary}),[first]);
 assert.deepEqual(JSON.parse(f.calls[0].messages[1].content).sentences,[first]);
});

test('Granola meeting topics accept structured JSON and string envelopes while failing closed on bad output',async()=>{
 const summary='The group discussed retrieval evaluation for legal contract comparison.';
 for(const output of [{passages:[{start:0,end:0}]},{response:JSON.stringify({passages:[{start:0,end:0}]})}])assert.deepEqual(await collectGranolaMeetingTopics({AI:{run:async()=>output} as any},{summary}),[summary]);
 for(const output of [{response:'not JSON'},{response:{passages:'wrong'}},{response:{passages:[],extra:'generated prose'}}])await assert.rejects(collectGranolaMeetingTopics({AI:{run:async()=>output} as any},{summary}),/invalid_extraction/);
 await assert.rejects(collectGranolaMeetingTopics({},{summary}),/ai_unavailable/);
 await assert.rejects(collectGranolaMeetingTopics({AI:{run:async()=>{throw Error('secret provider detail');}} as any},{summary}),/^Error: ai_unavailable$/);
});

test('Granola meeting topics stop one stalled AI call at the 20-second deadline',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,signal:AbortSignal|undefined;
 const ai={run(_model:string,_input:unknown,options:{signal:AbortSignal}){calls++;signal=options.signal;return new Promise(()=>{});}};
 const pending=collectGranolaMeetingTopics({AI:ai as any},{summary:'The group discussed retrieval evaluation for legal contract comparison.'});
 const rejected=assert.rejects(pending,/ai_unavailable/);t.mock.timers.tick(20_000);await rejected;assert.equal(calls,1);assert.equal(signal?.aborted,true);
});

test('Granola meeting topics retain exact heading and bullet context across single line breaks',async()=>{
 const summary='Contract retrieval evaluation\n  - Alex demonstrated a tool for law firms.\n  - It finds contradictory clauses across client contracts.';
 const f=fake([{start:0,end:2}]);assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary}),[summary]);
 const sent=JSON.parse(f.calls[0].messages[1].content);assert.deepEqual(sent.paragraphIds,[0,0,0]);
 assert.match(f.calls[0].messages[0].content,/paragraphIds/);assert.match(f.calls[0].messages[0].content,/single line/i);
});

test('Granola meeting topics recognize blank lines containing spaces or CRLF as paragraph boundaries',async()=>{
 for(const gap of ['\n\n','\n  \n','\r\n\r\n','\r\n \t\r\n']){
  const summary='Contract retrieval evaluation\n- Alex demonstrated a tool for law firms.'+gap+'Hiring research scientists\n- The group discussed interviews for climate scientists.';
  const f=fake([{start:0,end:2},{start:0,end:1}]);
  assert.deepEqual(await collectGranolaMeetingTopics({AI:f.ai},{summary}),['Contract retrieval evaluation\n- Alex demonstrated a tool for law firms.']);
  assert.deepEqual(JSON.parse(f.calls[0].messages[1].content).paragraphIds,[0,0,1,1]);
 }
});

test('Granola meeting diagnostics contain only static labels and numeric counts, never source or provider contents',async()=>{
 const original=console.info,logs:string[]=[];console.info=(value:unknown)=>{logs.push(String(value));};
 const secret='PRIVATE_SOURCE_SENTINEL';
 try{
  const first='Alex demonstrated a contract retrieval tool for law firms.';
  const summary=first+'\n\n'+secret+' is a medical detail that must never appear in logs.';
  assert.deepEqual(await collectGranolaMeetingTopics({AI:fake([{start:0,end:1},{start:0,end:0},{start:0,end:0}]).ai},{summary}),[first]);
  await assert.rejects(collectGranolaMeetingTopics({AI:{run:async()=>({response:'SECRET_PROVIDER_SENTINEL'})} as any},{summary}),/invalid_extraction/);
  assert.deepEqual(await collectGranolaMeetingTopics({},{summary:''}),[]);
  assert.equal(logs.length,3);assert.ok(!logs.join('').includes(secret));assert.ok(!logs.join('').includes('SECRET_PROVIDER_SENTINEL'));assert.ok(!logs.join('').includes(first));
  const success=JSON.parse(logs[0]);assert.equal(success.event,'granola_meeting_selection');assert.equal(success.summaryChars,summary.length);assert.equal(success.sentenceCount,2);assert.equal(success.modelSelected,3);assert.equal(success.accepted,1);assert.equal(success.rejectedParagraph,1);assert.equal(success.rejectedDuplicate,1);
  const empty=JSON.parse(logs[2]);assert.equal(empty.summaryChars,0);assert.equal(empty.sentenceCount,0);assert.equal(empty.modelSelected,0);assert.equal(empty.accepted,0);
  for(const log of logs){const data=JSON.parse(log);for(const [key,value] of Object.entries(data))if(key!=='event')assert.ok(Number.isInteger(value)&&Number(value)>=0,key);}
 }finally{console.info=original;}
});
