import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryTerms,keywordRank,keywordScores,jevScores,topResults,type SearchCandidate} from '../src/network-search';
import {JevError} from '../src/jev';
import {jevServer,noulA,scoreA} from './granola-jev-extractor.test';

const KEY='ts_fictional_key_123456';
async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}

function person(overrides:Partial<SearchCandidate>&{personId:string}):SearchCandidate{
 return {name:'Someone',company:null,lastContact:'2026-01-01T00:00:00.000Z',evidence:[],contexts:[],themes:[],...overrides};
}
const evidence=(summary:string,day:number,title?:string)=>({summary,observedAt:`2026-09-${String(day).padStart(2,'0')}T11:00:00.000Z`,...(title?{title}:{})});

test('query terms lowercase, split punctuation and drop stopwords and single letters',()=>{
 assert.deepEqual(queryTerms('Who can help with FINTECH fundraising?'),['fintech','fundraising'],'the placeholder’s own words are noise, not search terms');
 assert.deepEqual(queryTerms('a the and of'),[]);
 assert.deepEqual(queryTerms('agent-memory, agent memory'),['agent','memory']);
 assert.deepEqual(queryTerms('   '),[]);
});

test('keyword ranking weighs name and company three times other evidence and breaks ties by recency',()=>{
 const people=[
  person({personId:'name-hit',name:'Fintech Rivera',lastContact:'2026-01-01T00:00:00.000Z'}),
  person({personId:'company-hit',company:'fintech.example',lastContact:'2026-01-01T00:00:00.000Z'}),
  person({personId:'evidence-hit',evidence:[evidence('Wants an intro to fintech people',3)],lastContact:'2026-05-01T00:00:00.000Z'}),
  person({personId:'theme-hit',themes:['Fintech'],lastContact:'2026-06-01T00:00:00.000Z'}),
  person({personId:'context-hit',contexts:['Fintech pilot kickoff'],lastContact:'2026-07-01T00:00:00.000Z'}),
  person({personId:'title-hit',evidence:[evidence('Nothing related',4,'Fintech review')],lastContact:'2026-08-01T00:00:00.000Z'}),
  person({personId:'miss',lastContact:'2026-09-01T00:00:00.000Z'}),
 ];
 const ranked=keywordRank('fintech',people);
 assert.deepEqual(ranked.slice(0,6).map(r=>r.personId),['name-hit','company-hit','title-hit','context-hit','theme-hit','evidence-hit'],
  'name and company weigh 3, everything else 1, and equal scores fall back to the most recent contact');
 assert.deepEqual(ranked.slice(0,6).map(r=>r.hits),[3,3,1,1,1,1]);
 assert.deepEqual(ranked.map(r=>r.personId).slice(6),['miss'],'a person with no hits only ever fills the tail');
});

test('keyword ranking keeps the 40 best hits, or the 40 most recent when fewer than ten hit',()=>{
 const many=Array.from({length:60},(_,i)=>person({personId:`p${i}`,name:`Fintech ${i}`,lastContact:`2026-01-${String((i%28)+1).padStart(2,'0')}T00:00:00.000Z`}));
 assert.equal(keywordRank('fintech',many).length,40);
 const few=Array.from({length:60},(_,i)=>person({personId:`q${i}`,name:i<5?'Fintech person':'Someone else',
  lastContact:new Date(Date.UTC(2026,0,1)+i*86400000).toISOString()}));
 const sparse=keywordRank('fintech',few);
 assert.equal(sparse.length,40);
 assert.deepEqual(sparse.slice(0,5).map(r=>r.personId),['q4','q3','q2','q1','q0'],'the few hits still lead');
 assert.equal(sparse[5].personId,'q59','fewer than ten hits fills up with the most recent people so the model still has candidates');
 assert.ok(sparse.slice(5).every(r=>r.hits===0));
 assert.deepEqual(keywordRank('fintech',[]),[]);
});

test('keyword scores normalise to [0,1] against the best hit in the candidate set',()=>{
 const ranked=keywordRank('fintech',[person({personId:'a',name:'Fintech Rivera'}),person({personId:'b',themes:['Fintech']})]);
 assert.deepEqual(keywordScores(ranked),[1,1/3]);
 assert.deepEqual(keywordScores(keywordRank('fintech',[person({personId:'a'})])),[0],'no hits anywhere scores zero, never NaN');
});

test('results keep the ten best, with reasons that share a query term or the two newest',()=>{
 const people=Array.from({length:14},(_,i)=>person({personId:`p${i}`,name:`Fintech ${i}`,company:'example.com',
  lastContact:new Date(Date.UTC(2026,0,1)+i*86400000).toISOString(),
  evidence:[evidence('Runs a fintech fund',1,'Pilot sync'),evidence('Asked about hiring',2),evidence('Fintech regulation notes',3),evidence('Unrelated chatter',4)]}));
 const ranked=keywordRank('fintech',people);
 const results=topResults('fintech',ranked,ranked.map((_,i)=>1-i/100));
 assert.equal(results.length,10);
 assert.deepEqual(results[0].reasons.map(r=>r.summary),['Fintech regulation notes','Runs a fintech fund'],
  'reasons are the newest evidence sharing a query term');
 assert.equal(results[0].reasons[1].title,'Pilot sync');
 assert.deepEqual(Object.keys(results[0]).sort(),['company','lastContact','name','personId','reasons','score']);
 const unrelated=keywordRank('fintech',[person({personId:'x',name:'Fintech Rivera',
  evidence:[evidence('Older note',1),evidence('Newest note',5),evidence('Middle note',3)]})]);
 assert.deepEqual(topResults('fintech',unrelated,[1])[0].reasons.map(r=>r.summary),['Newest note','Middle note'],
  'no shared term falls back to the two newest evidence items');
});

test('Jev ranks each candidate from its own evidence and combines score and noul as 0.7/0.3',async()=>{
 const people=[person({personId:'ada',name:'Ada Rivera',company:'example.com',evidence:Array.from({length:8},(_,i)=>evidence(`Note ${i}`,i+1))}),
  person({personId:'bo',name:'Bo Chen',company:'other.com',evidence:[evidence('Runs payments',2)]})];
 const ranked=keywordRank('fintech fundraising',people);
 const jev=jevServer((id)=>id.startsWith('r')?scoreA(id==='r0'?3:1):noulA(id==='h0'?1:0.5));
 const scores=await withFetch(jev.fake,()=>jevScores({TYPESAFE_API_KEY:KEY},'fintech fundraising',ranked));
 assert.deepEqual(scores,[0.7*(3/3)+0.3*1,0.7*(1/3)+0.3*0.5]);
 assert.equal(jev.requests.length,1);
 const {state,questions}=jev.requests[0];
 assert.equal(state.query,'fintech fundraising');
 assert.deepEqual(state.people.map((p:any)=>[p.i,p.name,p.company]),[[0,'Ada Rivera','example.com'],[1,'Bo Chen','other.com']]);
 assert.equal(state.people[0].evidence.length,5,'at most the five newest evidence items per person');
 assert.deepEqual(state.people[0].evidence.map((e:any)=>e.summary),['Note 7','Note 6','Note 5','Note 4','Note 3']);
 assert.deepEqual(Object.keys(questions).sort(),['h0','h1','r0','r1']);
 assert.equal(questions.r0.type,'score');
 assert.deepEqual(questions.r0.criteria,['Unrelated','Loosely related','Relevant','Exactly who they are looking for']);
 assert.ok(String(questions.r0.instructions).includes('`people[0]`'));
 assert.equal(questions.h1.type,'noul');
 assert.ok(String(questions.h1.instructions).includes('`people[1]`'));
 assert.ok(!JSON.stringify(jev.requests[0]).includes('@'),'no email address ever reaches Jev');
 assert.ok(!JSON.stringify(jev.requests[0]).includes('personId'),'opaque ids stay on the server');
});

test('Jev ranking batches candidates under the token budget and keeps every answer in place',async()=>{
 const people=Array.from({length:30},(_,i)=>person({personId:`p${i}`,name:`Person ${i}`,
  evidence:[evidence('x'.repeat(3000),1)]}));
 const ranked=keywordRank('fintech',people);
 const jev=jevServer((id,_q,state)=>{
  const index=Number(id.slice(1));
  assert.ok(state.people[index],`question ${id} must address a person in its own request`);
  return id.startsWith('r')?scoreA(3):noulA(1);
 });
 const scores=await withFetch(jev.fake,()=>jevScores({TYPESAFE_API_KEY:KEY},'fintech',ranked));
 assert.ok(jev.requests.length>1,'30 large candidates do not fit one 20k-token request');
 for(const request of jev.requests)assert.ok(JSON.stringify(request).length/4<32_000,'each request stays under the documented limit');
 assert.deepEqual(scores,ranked.map(()=>1));
 assert.equal(jev.requests.reduce((total,request)=>total+request.state.people.length,0),ranked.length);
});

test('Jev ranking surfaces JevError so the caller can fall back to keywords',async()=>{
 const ranked=keywordRank('fintech',[person({personId:'ada',name:'Ada'})]);
 const unauthorized=(async()=>new Response('{"error":"no"}',{status:401})) as typeof fetch;
 await assert.rejects(withFetch(unauthorized,()=>jevScores({TYPESAFE_API_KEY:KEY},'fintech',ranked)),(error:unknown)=>error instanceof JevError);
 await assert.rejects(jevScores({},'fintech',ranked),(error:unknown)=>error instanceof JevError);
});
