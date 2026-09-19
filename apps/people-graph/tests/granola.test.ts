import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {makeSession,sessionCookie} from '../src/session';

const API_KEY='grn_fictional_key_123456';
const FOLDER_ID='fol_1234567890abcd';
const NOTE_ID='not_1234567890abcd';

function fixtureEnv(){
 let storageCalls=0;
 const forbidden=()=>{storageCalls++;throw Error('Granola metadata must not touch app storage');};
 return {
  TOKEN_SECRET:'fictional-session-secret',GOOGLE_CLIENT_ID:'fictional-client',
  DB:{prepare:forbidden},MAIL:{getByName:forbidden},AI:{run:forbidden},
  ASSETS:{fetch:async()=>new Response('asset')},
  storageCalls:()=>storageCalls,
 } as any;
}

async function granolaRequest(path:string,body:unknown,init:RequestInit={}){
 const env=fixtureEnv();
 const session=await makeSession('owner@example.test',env.TOKEN_SECRET);
 const headers=new Headers(init.headers);
 headers.set('cookie',sessionCookie(session).split(';')[0]);
 if(!headers.has('origin'))headers.set('origin','https://people.test');
 if(!headers.has('content-type'))headers.set('content-type','application/json');
 const request=new Request('https://people.test'+path,{method:'POST',body:JSON.stringify(body),...init,headers});
 return {env,response:await worker.fetch(request,env)};
}

async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{
 const original=globalThis.fetch;globalThis.fetch=fake;
 try{return await run();}finally{globalThis.fetch=original;}
}

test('Granola routes require an authenticated app session before external access',async()=>{
 let calls=0;const env=fixtureEnv();
 await withFetch((async()=>{calls++;return Response.json({});}) as typeof fetch,async()=>{
  const response=await worker.fetch(new Request('https://people.test/api/granola/folders',{method:'POST',headers:{origin:'https://people.test','content-type':'application/json'},body:JSON.stringify({apiKey:API_KEY})}),env);
  assert.equal(response.status,401);assert.equal(calls,0);assert.equal(env.storageCalls(),0);assert.equal(response.headers.get('cache-control'),'no-store');
 });
});

test('Granola folders use the fixed upstream and expose only allowlisted metadata',async()=>{
 let call:{url:string;init:RequestInit}|undefined;
 const fake=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  call={url:String(input),init:init||{}};
  return Response.json({folders:[{id:FOLDER_ID,name:'Pilot',parent_folder_id:null,owner:{email:'private@example.test'},private_notes:'SECRET'}],hasMore:false,cursor:null,unknown:'drop'});
 }) as typeof fetch;
 await withFetch(fake,async()=>{
  const {response,env}=await granolaRequest('/api/granola/folders',{apiKey:API_KEY});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{folders:[{id:FOLDER_ID,name:'Pilot',parentFolderId:null}],hasMore:false,cursor:null});
  assert.equal(env.storageCalls(),0);
 });
 assert.ok(call);const upstream=new URL(call.url);
 assert.equal(upstream.origin,'https://public-api.granola.ai');assert.equal(upstream.pathname,'/v1/folders');
 assert.deepEqual([...upstream.searchParams],[['page_size','30']]);
 assert.equal(call.init.method,'GET');assert.equal(call.init.redirect,'manual');
 const headers=new Headers(call.init.headers);assert.equal(headers.get('authorization'),'Bearer '+API_KEY);assert.equal(headers.get('accept'),'application/json');
});

test('Granola notes encode folder pagination and drop private upstream fields',async()=>{
 let call:{url:string;init:RequestInit}|undefined;
 const fake=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  call={url:String(input),init:init||{}};
  return Response.json({notes:[{id:NOTE_ID,object:'note',title:null,owner:{name:'Private',email:'private@example.test'},created_at:'2026-01-27T15:30:00Z',updated_at:'2026-01-27T16:45:00Z',summary:'SECRET SUMMARY',transcript:'SECRET TRANSCRIPT'}],hasMore:true,cursor:'next/cursor+='});
 }) as typeof fetch;
 await withFetch(fake,async()=>{
  const {response,env}=await granolaRequest('/api/granola/notes',{apiKey:API_KEY,folderId:FOLDER_ID,cursor:'old/cursor+='});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{notes:[{id:NOTE_ID,title:'Untitled meeting',createdAt:'2026-01-27T15:30:00Z',updatedAt:'2026-01-27T16:45:00Z'}],hasMore:true,cursor:'next/cursor+='});
  assert.equal(env.storageCalls(),0);
 });
 assert.ok(call);const upstream=new URL(call.url);
 assert.equal(upstream.origin,'https://public-api.granola.ai');assert.equal(upstream.pathname,'/v1/notes');
 assert.deepEqual([...upstream.searchParams],[['folder_id',FOLDER_ID],['page_size','30'],['cursor','old/cursor+=']]);
 assert.equal(call.init.redirect,'manual');
});

test('Granola routes reject method, origin, content type, query input, size and schema violations before fetch',async()=>{
 let calls=0;const fake=(async()=>{calls++;return Response.json({folders:[],hasMore:false,cursor:null});}) as typeof fetch;
 await withFetch(fake,async()=>{
  const method=await granolaRequest('/api/granola/folders',{apiKey:API_KEY},{method:'PUT'});assert.equal(method.response.status,405);
  const origin=await granolaRequest('/api/granola/folders',{apiKey:API_KEY},{headers:{origin:'https://evil.test','content-type':'application/json'}});assert.equal(origin.response.status,403);
  const content=await granolaRequest('/api/granola/folders',{apiKey:API_KEY},{headers:{'content-type':'text/plain'}});assert.equal(content.response.status,415);
  const query=await granolaRequest('/api/granola/folders?apiKey='+encodeURIComponent(API_KEY),{apiKey:API_KEY});assert.equal(query.response.status,400);
  const extra=await granolaRequest('/api/granola/folders',{apiKey:API_KEY,folderId:FOLDER_ID});assert.equal(extra.response.status,400);
  const whitespace=await granolaRequest('/api/granola/folders',{apiKey:API_KEY+' '});assert.equal(whitespace.response.status,400);
  const control=await granolaRequest('/api/granola/folders',{apiKey:'grn_fictional\nkey'});assert.equal(control.response.status,400);
  const badFolder=await granolaRequest('/api/granola/notes',{apiKey:API_KEY,folderId:'https://evil.test'});assert.equal(badFolder.response.status,400);
  const badCursor=await granolaRequest('/api/granola/folders',{apiKey:API_KEY,cursor:''});assert.equal(badCursor.response.status,400);
  const oversized=await granolaRequest('/api/granola/folders',{apiKey:'grn_'+('x'.repeat(8_200))});assert.equal(oversized.response.status,413);
  const env=fixtureEnv(),session=await makeSession('owner@example.test',env.TOKEN_SECRET);
  const invalidJSON=await worker.fetch(new Request('https://people.test/api/granola/folders',{method:'POST',headers:{origin:'https://people.test','content-type':'application/json',cookie:sessionCookie(session).split(';')[0]},body:'{'}),env);assert.equal(invalidJSON.status,400);
  const invalidUTF8=await worker.fetch(new Request('https://people.test/api/granola/folders',{method:'POST',headers:{origin:'https://people.test','content-type':'application/json',cookie:sessionCookie(session).split(';')[0]},body:new Uint8Array([0xff])}),env);assert.equal(invalidUTF8.status,400);
  const unknown=await granolaRequest('/api/granola/private-note',{apiKey:API_KEY});assert.equal(unknown.response.status,404);
  const bare=await granolaRequest('/api/granola',{apiKey:API_KEY});assert.deepEqual(await bare.response.json(),{error:'not_found',message:'Granola route not found.'});
  assert.equal(calls,0);
 });
});

test('Granola upstream failures map to fixed safe errors without echoing credentials or bodies',async()=>{
 const cases=[
  [401,422,'granola_unauthorized'],[403,422,'granola_forbidden'],[429,429,'granola_rate_limited'],[500,502,'granola_unavailable'],
 ] as const;
 for(const [upstreamStatus,status,error] of cases){
  await withFetch((async()=>new Response('SECRET upstream body '+API_KEY,{status:upstreamStatus})) as typeof fetch,async()=>{
   const {response}=await granolaRequest('/api/granola/folders',{apiKey:API_KEY});
   assert.equal(response.status,status);const text=await response.text();const body=JSON.parse(text);
   assert.equal(body.error,error);assert.equal(typeof body.message,'string');assert.equal(text.includes(API_KEY),false);assert.equal(text.includes('SECRET'),false);
  });
 }
});

test('Granola rejects malformed pagination, excessive entries, wrong ids, dates and oversized strings',async()=>{
 const validFolder={id:FOLDER_ID,name:'Pilot',parent_folder_id:null};
 const validNote={id:NOTE_ID,title:'Planning',created_at:'2026-01-27T15:30:00Z',updated_at:'2026-01-27T16:45:00Z'};
 const cases:[string,unknown][]=[
  ['/api/granola/folders',{folders:[],hasMore:true,cursor:null}],
  ['/api/granola/folders',{folders:[],hasMore:true,cursor:'same'}],
  ['/api/granola/folders',{folders:[validFolder],hasMore:false}],
  ['/api/granola/folders',{folders:Array.from({length:31},()=>validFolder),hasMore:false,cursor:null}],
  ['/api/granola/folders',{folders:[{...validFolder,id:123}],hasMore:false,cursor:null}],
  ['/api/granola/folders',{folders:[{...validFolder,name:'x'.repeat(1_001)}],hasMore:false,cursor:null}],
  ['/api/granola/notes',{notes:[{...validNote,id:123}],hasMore:false,cursor:null}],
  ['/api/granola/notes',{notes:[{...validNote,created_at:'not-a-date'}],hasMore:false,cursor:null}],
  ['/api/granola/notes',{notes:[{...validNote,created_at:'2026-02-30T15:30:00Z'}],hasMore:false,cursor:null}],
  ['/api/granola/notes',{notes:[{...validNote,title:'x'.repeat(2_001)}],hasMore:false,cursor:null}],
 ];
 for(const [path,payload] of cases){
  await withFetch((async()=>Response.json(payload)) as typeof fetch,async()=>{
   const requestBody=path.endsWith('/notes')?{apiKey:API_KEY,folderId:FOLDER_ID}:{apiKey:API_KEY,...((payload as any).cursor==='same'?{cursor:'same'}:{})};
   const {response}=await granolaRequest(path,requestBody);assert.equal(response.status,502,`${path} ${JSON.stringify(payload).slice(0,100)}`);
  });
 }
});

test('Granola timeout settles and cancels a body reader that ignores cancellation',async()=>{
 let cancelled=false;
 const fake=(async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>{cancelled=true;return new Promise(()=>{});}}))) as typeof fetch;
 const originalSetTimeout=globalThis.setTimeout;
 globalThis.setTimeout=((handler:TimerHandler,delay?:number,...args:any[])=>originalSetTimeout(handler,delay===15_000?0:delay,...args)) as typeof setTimeout;
 try{
  await withFetch(fake,async()=>{
   const result=await Promise.race([granolaRequest('/api/granola/folders',{apiKey:API_KEY}),new Promise<never>((_,reject)=>originalSetTimeout(()=>reject(Error('test deadline exceeded')),1_000))]);
   assert.equal(result.response.status,504);assert.equal((await result.response.json() as any).error,'granola_timeout');assert.equal(cancelled,true);
  });
 }finally{globalThis.setTimeout=originalSetTimeout;}
});

test('Granola diagnostics distinguish failure stages without exposing provider data or keys',async()=>{
 const valid={id:FOLDER_ID,name:'Private folder',parent_folder_id:null};
 const cases:[string,()=>Promise<Response>][]=[
  ['transport',async()=>{throw Error('SECRET '+API_KEY);}],
  ['http_4xx',async()=>new Response('SECRET '+API_KEY,{status:400})],
  ['http_5xx',async()=>new Response('SECRET '+API_KEY,{status:503})],
  ['response_json',async()=>new Response('SECRET '+API_KEY)],
  ['page_shape',async()=>Response.json({SECRET:API_KEY})],
  ['page_cursor',async()=>Response.json({folders:[valid],hasMore:true,cursor:null})],
  ['page_terminal_cursor',async()=>Response.json({folders:[valid],hasMore:false,cursor:'private-cursor'})],
  ['folder_id',async()=>Response.json({folders:[{...valid,id:'SECRET'}],hasMore:false,cursor:null})],
  ['folder_name',async()=>Response.json({folders:[{...valid,name:123}],hasMore:false,cursor:null})],
  ['folder_parent',async()=>Response.json({folders:[{id:FOLDER_ID,name:'SECRET'}],hasMore:false,cursor:null})],
 ];
 for(const [diagnostic,fake] of cases)await withFetch(fake as typeof fetch,async()=>{
  const {response,env}=await granolaRequest('/api/granola/folders',{apiKey:API_KEY});
  assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:'granola_unavailable',message:'Granola is temporarily unavailable.',diagnostic});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(env.storageCalls(),0);
 });
});

test('Granola client uses a redirect mode the Workers runtime supports and still rejects redirects',async()=>{
 // workerd only implements redirect: "follow" | "manual" and throws on "error" before sending anything.
 const workerdFetch=(handler:(init?:RequestInit)=>Response)=>(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.redirect==='error')throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  return handler(init);
 }) as typeof fetch;
 await withFetch(workerdFetch(()=>Response.json({folders:[{id:FOLDER_ID,name:'Pilot',parent_folder_id:null}],hasMore:false,cursor:null})),async()=>{
  const {response}=await granolaRequest('/api/granola/folders',{apiKey:API_KEY});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{folders:[{id:FOLDER_ID,name:'Pilot',parentFolderId:null}],hasMore:false,cursor:null});
 });
 await withFetch(workerdFetch(()=>new Response(null,{status:302,headers:{location:'https://elsewhere.test/'}})),async()=>{
  const {response}=await granolaRequest('/api/granola/folders',{apiKey:API_KEY});
  assert.equal(response.status,502);assert.equal((await response.json() as any).error,'granola_unavailable');
 });
});
