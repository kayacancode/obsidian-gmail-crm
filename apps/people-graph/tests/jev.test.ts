import {test} from 'node:test';
import assert from 'node:assert/strict';
import {askJev,jevConfigured,estimateTokens,batchQuestions,noul,choice,score,JevError,type JevQuestion} from '../src/jev';

const KEY='ts_fictional_key_123456';
async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}

function okBody(overrides:Record<string,unknown> = {}){
 return {model:'jev-2026-09-01',answers:{q1:{type:'noul',noul:0.7}},usage:{input_tokens:12,output_tokens:0},...overrides};
}

test('jevConfigured reflects presence of the key',()=>{
 assert.equal(jevConfigured({}),false);
 assert.equal(jevConfigured({TYPESAFE_API_KEY:''}),false);
 assert.equal(jevConfigured({TYPESAFE_API_KEY:KEY}),true);
});

test('askJev throws jev_unconfigured when the key is absent',async()=>{
 await assert.rejects(askJev({},{},{}),(e:any)=>e instanceof JevError&&e.code==='jev_unconfigured');
});

test('askJev sends the expected request shape',async()=>{
 let seenUrl='';let seenInit:any=null;
 const questions:Record<string,JevQuestion>={q1:noul('is this true?')};
 await withFetch((async(input:any,init:any)=>{seenUrl=String(input);seenInit=init;return Response.json(okBody());}) as typeof fetch,async()=>{
  await askJev({TYPESAFE_API_KEY:KEY},{a:1},questions);
 });
 assert.equal(seenUrl,'https://api.typesafe.ai/v1/systemone');
 assert.equal(seenInit.method,'POST');
 assert.equal(seenInit.headers.authorization,`Bearer ${KEY}`);
 assert.equal(seenInit.headers['content-type'],'application/json');
 const body=JSON.parse(seenInit.body);
 assert.deepEqual(body,{state:{a:1},model:'jev-latest',questions:{q1:{type:'noul',instructions:'is this true?'}}});
});

test('askJev uses JEV_MODEL when provided',async()=>{
 let body:any=null;
 await withFetch((async(_input:any,init:any)=>{body=JSON.parse(init.body);return Response.json(okBody());}) as typeof fetch,async()=>{
  await askJev({TYPESAFE_API_KEY:KEY,JEV_MODEL:'jev-pinned'},'state',{q1:noul('x')});
 });
 assert.equal(body.model,'jev-pinned');
});

test('askJev maps 401 to jev_unauthorized without a retry',async()=>{
 let calls=0;
 await withFetch((async()=>{calls++;return new Response('nope',{status:401});}) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>e instanceof JevError&&e.code==='jev_unauthorized');
 });
 assert.equal(calls,1);
});

test('askJev retries once on 429 honouring Retry-After, then succeeds',async()=>{
 let calls=0;const waited:number[]=[];
 const {__setJevSleepForTests}=await import('../src/jev');
 __setJevSleepForTests(async(ms:number)=>{waited.push(ms);});
 try{
  await withFetch((async()=>{
   calls++;
   if(calls===1)return new Response('slow down',{status:429,headers:{'retry-after':'3'}});
   return Response.json(okBody());
  }) as typeof fetch,async()=>{
   const result=await askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')});
   assert.equal(result.model,'jev-2026-09-01');
  });
 }finally{__setJevSleepForTests(null);}
 assert.equal(calls,2);
 assert.deepEqual(waited,[3000]);
});

test('askJev caps the Retry-After wait at 10s and defaults to 2s when not numeric',async()=>{
 const {__setJevSleepForTests}=await import('../src/jev');
 const waited:number[]=[];
 __setJevSleepForTests(async(ms:number)=>{waited.push(ms);});
 try{
  let calls=0;
  await withFetch((async()=>{calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'999'}}):Response.json(okBody());}) as typeof fetch,async()=>{
   await askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')});
  });
  calls=0;
  await withFetch((async()=>{calls++;return calls===1?new Response('',{status:429}):Response.json(okBody());}) as typeof fetch,async()=>{
   await askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')});
  });
 }finally{__setJevSleepForTests(null);}
 assert.deepEqual(waited,[10000,2000]);
});

test('askJev maps a second 429 after the retry to jev_rate_limited',async()=>{
 const {__setJevSleepForTests}=await import('../src/jev');
 __setJevSleepForTests(async()=>{});
 try{
  let calls=0;
  await withFetch((async()=>{calls++;return new Response('',{status:429});}) as typeof fetch,async()=>{
   await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>e instanceof JevError&&e.code==='jev_rate_limited');
  });
  assert.equal(calls,2);
 }finally{__setJevSleepForTests(null);}
});

test('askJev maps 500 to jev_unavailable',async()=>{
 await withFetch((async()=>new Response('boom',{status:500})) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>e instanceof JevError&&e.code==='jev_unavailable');
 });
});

test('askJev maps a transport failure to jev_unavailable and never leaks the key',async()=>{
 await withFetch((async()=>{throw new Error(`network down for ${KEY}`);}) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>{
   assert.ok(e instanceof JevError&&e.code==='jev_unavailable');
   assert.ok(!String(e.message).includes(KEY));
   return true;
  });
 });
});

test('askJev validates noul answers are numbers in [0,1]',async()=>{
 await withFetch((async()=>Response.json(okBody({answers:{q1:{type:'noul',noul:1.4}}}))) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>e instanceof JevError&&e.code==='jev_invalid');
 });
});

test('askJev validates choice answers pick a criteria key with numeric probabilities',async()=>{
 const questions:Record<string,JevQuestion>={q1:choice('pick one',{a:'A',b:'B'})};
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'choice',choice:'a',probabilities:{a:0.9,b:0.1},confidence:0.8}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  const result=await askJev({TYPESAFE_API_KEY:KEY},{},questions);
  assert.deepEqual(result.answers.q1,{type:'choice',choice:'a',probabilities:{a:0.9,b:0.1},confidence:0.8});
 });
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'choice',choice:'z',probabilities:{a:0.9,b:0.1},confidence:0.8}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},questions),(e:any)=>e instanceof JevError&&e.code==='jev_invalid');
 });
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'choice',choice:'a',probabilities:{a:'x'},confidence:0.8}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},questions),(e:any)=>e instanceof JevError&&e.code==='jev_invalid');
 });
});

test('askJev validates score answers',async()=>{
 const questions:Record<string,JevQuestion>={q1:score('rate it',['low','high'])};
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'score',score:1,legend:{'0':'low','1':'high'},probabilities:{'0':0.2,'1':0.8},confidence:0.6}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  const result=await askJev({TYPESAFE_API_KEY:KEY},{},questions);
  assert.equal(result.answers.q1.type,'score');
 });
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'score',score:1,legend:{'0':'low'},probabilities:{'0':'nope'},confidence:0.6}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},questions),(e:any)=>e instanceof JevError&&e.code==='jev_invalid');
 });
});

test('askJev rejects a mismatched answer type for the question',async()=>{
 await withFetch((async()=>Response.json({model:'m',answers:{q1:{type:'choice',choice:'a',probabilities:{a:1},confidence:1}},usage:{input_tokens:1,output_tokens:0}})) as typeof fetch,async()=>{
  await assert.rejects(askJev({TYPESAFE_API_KEY:KEY},{},{q1:noul('x')}),(e:any)=>e instanceof JevError&&e.code==='jev_invalid');
 });
});

test('noul/choice/score builders shape questions correctly',()=>{
 assert.deepEqual(noul('q'),{type:'noul',instructions:'q'});
 assert.deepEqual(noul('q',{true:'yes',false:'no'}),{type:'noul',instructions:'q',criteria:{true:'yes',false:'no'}});
 assert.deepEqual(choice('q',{a:'A'}),{type:'choice',instructions:'q',criteria:{a:'A'}});
 assert.deepEqual(score('q',['low','high']),{type:'score',instructions:'q',criteria:['low','high']});
});

test('estimateTokens is JSON length / 4 rounded up',()=>{
 assert.equal(estimateTokens('abc'),Math.ceil(JSON.stringify('abc').length/4));
 assert.equal(estimateTokens({a:1,b:2}),Math.ceil(JSON.stringify({a:1,b:2}).length/4));
 assert.equal(estimateTokens(''),Math.ceil(JSON.stringify('').length/4));
});

test('batchQuestions splits by budget, preserving order',()=>{
 const items=[1,2,3,4,5];
 const batches=batchQuestions(items,(n)=>n,6);
 assert.deepEqual(batches,[[1,2,3],[4],[5]]);
 assert.deepEqual(batches.flat(),items);
});

test('batchQuestions keeps an over-budget item alone rather than dropping it',()=>{
 const batches=batchQuestions([1,20,2],(n)=>n,5);
 assert.deepEqual(batches,[[1],[20],[2]]);
});

test('batchQuestions returns no batches for an empty input',()=>{
 assert.deepEqual(batchQuestions([],(n:number)=>n,10),[]);
});
