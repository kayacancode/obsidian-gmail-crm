import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidateSpans,GranolaJevExtractor,type JevExtraction} from '../src/granola-jev-extractor';
import {estimateTokens,JevError} from '../src/jev';
import {THEME_TOPICS} from '../src/theme-extractor';

const KEY='ts_fictional_key_123456';
const normalise=(s:string)=>s.replace(/\s+/g,' ').trim();
async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}

const ADA='ada@example.test',BOB='bob@example.test';
const attendees=[{email:ADA,name:'Ada'},{email:BOB,name:'Bob'}];
const SUMMARY='Ada asked for an intro to a fintech founder. Short. Bob promised to send the updated pricing deck by Friday.';
const NOTES='remember to send the deck\nchase the legal review next week';
const TRANSCRIPT='Ada: We should talk about the pilot next week.\nBob: I will follow up with the security questionnaire.';
const input=()=>({summary:SUMMARY,privateNotes:NOTES,transcript:TRANSCRIPT,attendees});
const full=()=>({...input(),title:'Pilot kickoff',folders:[{id:'fol_1234567890abcd',name:'Pilot'}]});

/** Answers every question in the request with `answer(id,question,state)`, like the Jev API does. */
export function jevServer(answer:(id:string,question:any,state:any)=>unknown){
 const requests:{state:any;questions:Record<string,any>;model:string}[]=[];
 const fake=(async(input:any,init:any)=>{
  assert.equal(String(input),'https://api.typesafe.ai/v1/systemone');
  const body=JSON.parse(init.body);requests.push(body);
  const answers:Record<string,unknown>={};
  for(const [id,question] of Object.entries<any>(body.questions))answers[id]=answer(id,question,body.state);
  return Response.json({model:'jev-2026-09-01',answers,usage:{input_tokens:estimateTokens(body),output_tokens:0}});
 }) as typeof fetch;
 return {fake,requests};
}
export const noulA=(v:number)=>({type:'noul',noul:v});
export const choiceA=(choice:string,p:number,rest:Record<string,number>={})=>({type:'choice',choice,probabilities:{[choice]:p,...rest},confidence:p});
export const scoreA=(s:number,p=0.8)=>({type:'score',score:s,legend:{'0':'a','1':'b','2':'c','3':'d'},probabilities:{[String(s)]:p},confidence:p});
/** Keeps every span, attributes it to Ada as an intro with urgency 2, openLoop .5, theirAsk 1. */
export function defaultAnswer(id:string,question?:any){
 if(id.startsWith('g'))return noulA(0.9);
 if(id.startsWith('a'))return choiceA(ADA,0.9,{none:0.05});
 if(id.startsWith('k'))return choiceA('intro',0.8);
 if(id.startsWith('u'))return scoreA(2);
 if(id.startsWith('o'))return noulA(0.5);
 if(id.startsWith('r'))return noulA(1);
 if(id==='note_topic')return choiceA('business_strategy',0.7,{none:0.1});
 if(id==='note_theme')return choiceA(Object.keys(question?.criteria??{}).find(k=>k!=='none')??'none',0.9,{none:0.05});
 throw Error('unexpected question id '+id);
}
const env={TYPESAFE_API_KEY:KEY};

test('candidateSpans keeps 20-300 character spans whose offsets round-trip into the normalised source',()=>{
 const spans=candidateSpans(input());
 const sources={summary:normalise(SUMMARY),private_notes:normalise(NOTES),transcript:normalise(TRANSCRIPT)};
 for(const s of spans)assert.equal(sources[s.source].slice(s.offset,s.offset+s.text.length),s.text,s.text);
 assert.deepEqual(spans.map(s=>s.source),['summary','summary','private_notes','private_notes','transcript','transcript']);
 assert.equal(spans[0].text,'Ada asked for an intro to a fintech founder.');
 assert.equal(spans[0].offset,0);
 assert.ok(!spans.some(s=>s.text==='Short.'),'spans under 20 characters are dropped');
 assert.ok(spans.every(s=>s.text.length>=20&&s.text.length<=300));
});

test('candidateSpans drops over-long spans, caps at 400 and puts transcript spans last',()=>{
 const long='x'.repeat(400)+'.';
 const many=Array.from({length:500},(_,i)=>`Sentence number ${i} is long enough to keep.`).join('\n');
 const spans=candidateSpans({summary:long+' A sentence that is definitely long enough.',privateNotes:'',transcript:many,attendees});
 assert.equal(spans.length,400);
 assert.equal(spans[0].text,'A sentence that is definitely long enough.');
 assert.equal(spans[0].source,'summary');
 assert.ok(spans.slice(1).every(s=>s.source==='transcript'));
 const normalised=normalise(many);
 for(const s of spans.slice(1))assert.equal(normalised.slice(s.offset,s.offset+s.text.length),s.text);
});

test('extract gates spans, judges the survivors and derives statement numbers',async()=>{
 const server=jevServer(defaultAnswer);
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract(full()));
 assert.equal(out.engine,'jev');
 assert.equal(out.calls,server.requests.length);
 assert.equal(out.returned.topics,1);
 assert.equal(out.returned.statements,6);
 assert.equal(out.statements.length,6);
 const s=out.statements.find(x=>x.quote==='Ada asked for an intro to a fintech founder.')!;
 assert.equal(s.email,ADA);assert.equal(s.kind,'intro');assert.equal(s.source,'summary');assert.equal(s.offset,0);
 assert.ok(Math.abs(s.probability-0.9*0.8)<1e-12);
 assert.ok(Math.abs(s.urgency-2/3)<1e-12);
 assert.equal(s.openLoop,0.5);assert.equal(s.theirAsk,1);
 assert.deepEqual(out.topics,[{topicId:'business_strategy',confidence:0.7}]);
 assert.deepEqual(out.themeChoice,{kind:'folder',id:'fol_1234567890abcd',probability:0.9});
});

test('extract drops gated-out spans, none attendees and weak attendee probabilities',async()=>{
 const server=jevServer((id)=>{
  if(id==='g0')return noulA(0.2);                       // gated out
  if(id.startsWith('g'))return noulA(0.9);
  if(id==='a0')return choiceA('none',0.9);              // no attendee
  if(id==='a1')return choiceA(ADA,0.3,{none:0.7});      // below the 0.4 floor
  if(id.startsWith('a'))return choiceA(BOB,0.6,{none:0.1});
  return defaultAnswer(id);
 });
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract(full()));
 assert.equal(out.returned.statements,5,'five spans survived the gate and were judged');
 assert.equal(out.statements.length,3);
 assert.ok(out.statements.every(x=>x.email===BOB));
 assert.ok(!out.statements.some(x=>x.quote==='Ada asked for an intro to a fintech founder.'),'the gated-out span is never judged');
});

test('extract keeps a topic only above 0.35 and reports a none theme choice',async()=>{
 const server=jevServer((id)=>{
  if(id==='note_topic')return choiceA('research',0.3,{none:0.2});
  if(id==='note_theme')return choiceA('none',0.8,{fol_1234567890abcd:0.2});
  return defaultAnswer(id);
 });
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract(full()));
 assert.deepEqual(out.topics,[]);
 assert.deepEqual(out.themeChoice,{kind:'none',id:'',probability:0.8});
});

test('extract asks no folder question when the note has no folders',async()=>{
 const server=jevServer(defaultAnswer);
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract({...full(),folders:[]}));
 assert.equal(out.themeChoice,undefined);
 assert.equal(server.requests.filter(r=>'note_topic' in r.questions).length,1);
 assert.ok(!server.requests.some(r=>'note_theme' in r.questions));
});

test('extract sends only the title, attendees, spans, folders and the fixed topic list',async()=>{
 const server=jevServer(defaultAnswer);
 await withFetch(server.fake,()=>new GranolaJevExtractor({...env,JEV_MODEL:'jev-pinned'}).extract(full()));
 for(const request of server.requests){
  assert.equal(request.model,'jev-pinned');
  assert.ok(Object.keys(request.state).every(k=>['attendees','folders','spans','summary','title','topics'].includes(k)),Object.keys(request.state).join(','));
  assert.ok(Array.isArray(request.state.spans)&&request.state.spans.every((s:unknown)=>typeof s==='string'));
  if('attendees' in request.state)assert.deepEqual(request.state.attendees,attendees);
  if('folders' in request.state)assert.deepEqual(request.state.folders,[{id:'fol_1234567890abcd',name:'Pilot'}]);
  assert.equal(request.state.title,'Pilot kickoff');
  const body=JSON.stringify(request);
  assert.ok(!body.includes(KEY));
  assert.ok(!body.includes('other-note'));
 }
 const topics=server.requests.find(r=>'topics' in r.state)!.state.topics;
 assert.deepEqual(topics.map((t:any)=>t.id),Object.keys(THEME_TOPICS));
});

test('extract batches spans so no request exceeds the token budget',async()=>{
 const server=jevServer(defaultAnswer);
 const transcript=Array.from({length:300},(_,i)=>`Line ${i}: ${'context '.repeat(20)}ends here.`).join('\n');
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract({...full(),transcript}));
 assert.ok(server.requests.length>2,'many spans need several requests, got '+server.requests.length);
 assert.equal(out.calls,server.requests.length);
 for(const request of server.requests)assert.ok(estimateTokens(request)<=20_000,'request over budget: '+estimateTokens(request));
 assert.equal(out.returned.statements,60,'at most 60 spans are judged');
 assert.equal(out.statements.length,60);
});

test('extract keeps the 60 highest-probability spans from the gate',async()=>{
 const transcript=Array.from({length:100},(_,i)=>`Line ${String(i).padStart(3,'0')} is a long enough candidate span.`).join('\n');
 // Gate probability rises with the span index, so only the last 60 lines survive the cap.
 const server=jevServer((id,_q,state)=>{
  if(id.startsWith('g')){const text=state.spans[Number(id.slice(1))] as string;const n=Number(text.match(/Line (\d+)/)?.[1]??0);return noulA(0.5+n/1000);}
  return defaultAnswer(id);
 });
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract({...full(),summary:'',privateNotes:'',transcript}));
 assert.equal(out.statements.length,60);
 const numbers=out.statements.map(s=>Number(s.quote.match(/Line (\d+)/)![1])).sort((a,b)=>a-b);
 assert.equal(numbers[0],40);
 assert.equal(numbers[59],99);
});

test('extract surfaces Jev errors to the caller',async()=>{
 await withFetch((async()=>new Response('nope',{status:401})) as typeof fetch,async()=>{
  await assert.rejects(new GranolaJevExtractor(env).extract(full()),(e:any)=>e instanceof JevError&&e.code==='jev_unauthorized');
 });
 await assert.rejects(new GranolaJevExtractor({}).extract(full()),(e:any)=>e instanceof JevError&&e.code==='jev_unconfigured');
});

test('extract judges nothing when the note has no attendees but still places the note',async()=>{
 const server=jevServer(defaultAnswer);
 const out:JevExtraction=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract({...full(),attendees:[]}));
 assert.deepEqual(out.statements,[]);
 assert.equal(out.returned.statements,0);
 assert.deepEqual(out.topics,[{topicId:'business_strategy',confidence:0.7}]);
 assert.deepEqual(out.themeChoice,{kind:'folder',id:'fol_1234567890abcd',probability:0.9});
 assert.equal(server.requests.length,1,'only the per-note request is made');
 const state=server.requests[0].state;
 assert.deepEqual(Object.keys(state).sort(),['folders','spans','summary','title','topics']);
 assert.equal(state.summary,normalise(SUMMARY),'the note-level request carries the summary excerpt');
 // With no attendees nothing is gated, so the candidates themselves stand in for the note.
 assert.ok(state.spans.includes('Ada asked for an intro to a fintech founder.'));
});

test('the per-note topic and theme are judged in their own request, on up to 12 spans',async()=>{
 const transcript=Array.from({length:100},(_,i)=>`Line ${String(i).padStart(3,'0')} is a long enough candidate span.`).join('\n');
 // Gate probability rises with the line number, so the 12 sent are the 12 strongest kept.
 const server=jevServer((id,q,state)=>{
  if(id.startsWith('g')){const text=state.spans[Number(id.slice(1))] as string;return noulA(0.5+Number(text.match(/Line (\d+)/)?.[1]??0)/1000);}
  return defaultAnswer(id,q);
 });
 const out=await withFetch(server.fake,()=>new GranolaJevExtractor(env).extract({...full(),transcript}));
 assert.equal(out.returned.statements,60);
 const noteRequests=server.requests.filter(r=>'note_topic' in r.questions);
 assert.equal(noteRequests.length,1,'exactly one per-note request');
 const state=noteRequests[0].state;
 assert.equal(state.spans.length,12);
 assert.deepEqual(state.spans.map((t:string)=>Number(t.match(/Line (\d+)/)![1])),[99,98,97,96,95,94,93,92,91,90,89,88]);
 assert.equal(state.summary,normalise(SUMMARY));
 assert.ok(!('attendees' in state),'the per-note request carries no span judgments');
 assert.ok(server.requests.filter(r=>'a0' in r.questions).every(r=>!('note_topic' in r.questions)),'judge batches carry no per-note questions');
});
