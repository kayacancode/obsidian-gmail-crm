import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mailRoute,mailCallback} from '../src/mail-routes';
import {makeSession,readSession,sessionCookie} from '../src/session';
import worker from '../src/index';
test('OAuth routes bind consent to owner, browser, PKCE and selected history',async()=>{let pending:any,attached:any;const env:any={GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',MAIL_TOKEN_KEY:'key',TOKEN_SECRET:'sign',APP_ORIGIN:'https://people.test',MAIL:{getByName(owner:string){assert.equal(owner,'owner@test.com');return {begin:async(n:string,p:any)=>{pending={n,...p};},consume:async(n:string,c:string)=>{if(pending?.n!==n||pending.cookie!==c)return null;const p=pending;pending=null;return p;},attachAccount:async(...args:any[])=>{attached=args;}};}}};
 const req=(origin:string)=>new Request('https://people.test/api/accounts/connect',{method:'POST',headers:{origin},body:JSON.stringify({range:'all'})});
 assert.equal((await mailRoute(req('https://evil.test'),env,'owner@test.com')).status,403);
 const response=await mailRoute(req('https://people.test'),env,'owner@test.com');const consent=new URL((await response.json() as any).url);assert.equal(consent.searchParams.get('code_challenge_method'),'S256');assert.equal(consent.searchParams.get('access_type'),'offline');assert.equal(pending.range,'all');const cookie=response.headers.get('set-cookie')!.split(';')[0];const callback='https://people.test/api/accounts/callback?code=test&state='+encodeURIComponent(consent.searchParams.get('state')!);
 assert.equal((await mailCallback(new Request(callback),env)).status,400);const old=globalThis.fetch;try{globalThis.fetch=async(input:any)=>String(input).includes('/token')?Response.json({access_token:'a',refresh_token:'r',scope:'https://www.googleapis.com/auth/gmail.readonly'}):Response.json({emailAddress:'inbox@test.com'});const result=await mailCallback(new Request(callback,{headers:{cookie}}),env);assert.equal(result.status,303);assert.deepEqual(attached,['inbox@test.com','r','all',false,false]);assert.equal((await mailCallback(new Request(callback,{headers:{cookie}}),env)).status,400);}finally{globalThis.fetch=old;}
});
test('application session rejects tampering and wrong signing keys',async()=>{const value=await makeSession('owner@test.com','secret');const request=new Request('https://people.test',{headers:{cookie:sessionCookie(value).split(';')[0]}});assert.equal(await readSession(request,'secret'),'owner@test.com');assert.equal(await readSession(request,'wrong'),null);assert.equal(await readSession(new Request('https://people.test',{headers:{cookie:'__Host-people-session='+value+'x'}}),'secret'),null);});

function workerFixture(){
 let saved:{json:string;updated_at:number}|null=null;const owners:string[]=[],augmented:any[]=[];
 const stub={bindOwner:async()=>{},relevance:async(lens:string)=>({version:1,lens,themes:[],connectors:[],discoveries:[]}),augmentPushedGraph:async(graph:any,lens:string)=>{augmented.push({graph,lens});return {...graph,relevance:{version:1,lens,themes:[],connectors:[],discoveries:[]},connectors:[]};}};
 const db={prepare(sql:string){let args:any[]=[];return {bind(...next:any[]){args=next;return this;},async run(){saved={json:args[1],updated_at:args[2]};return {};},async first(){return saved;}};}};
 const env:any={TOKEN_SECRET:'session-secret',GOOGLE_CLIENT_ID:'client',DB:db,MAIL:{getByName(owner:string){owners.push(owner);return stub;}},ASSETS:{fetch:async()=>new Response('asset')}};
 return {env,owners,augmented,getSaved:()=>saved};
}
async function signedRequest(path:string,env:any,init:RequestInit={}){const session=await makeSession('owner@example.test',env.TOKEN_SECRET);const headers=new Headers(init.headers);headers.set('cookie',sessionCookie(session).split(';')[0]);return worker.fetch(new Request('https://people.test'+path,{...init,headers}),env);}

test('Worker authenticates relevance routes before selecting the owner object and never leaks route errors',async()=>{
 const {env,owners}=workerFixture();
 assert.equal((await worker.fetch(new Request('https://people.test/api/relevance?lens=my'),env)).status,401);assert.deepEqual(owners,[]);
 const response=await signedRequest('/api/relevance?lens=public',env);assert.equal(response.status,200);assert.deepEqual(owners,['owner@example.test']);
 env.MAIL.getByName=()=>({relevance:async()=>{throw Error('SECRET raw body and token');}});
 const failed=await signedRequest('/api/relevance?lens=my',env);assert.equal(failed.status,500);assert.deepEqual(await failed.json(),{error:'server_error'});
});

test('pushed graph additions preserve local ids and layout, reject foreign references, and default old payloads',async()=>{
 const {env,augmented,getSaved}=workerFixture();
 const tokenResponse=await signedRequest('/api/token',env),token=(await tokenResponse.json() as any).token;
 const graph={pushedAt:'2026-09-14T12:00:00.000Z',nodes:[{id:'local-ada',name:'Ada',x:123,y:456},{id:'local-bo',name:'Bo'}],edges:[{source:'local-ada',target:'local-bo',weight:2,types:['wiki_link'],contexts:['Introduced locally']}],themes:[{id:'theme-local',canonicalName:'Agent memory',aliases:['Agent memory'],description:'Local theme: Agent memory',status:'active'}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note',visibility:'private',observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Working on agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};
 const push=await worker.fetch(new Request('https://people.test/api/push',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(graph)}),env);assert.equal(push.status,200);
 const response=await signedRequest('/api/graph?source=obsidian',env);const body=await response.json() as any;assert.equal(body.graph.nodes[0].x,123);assert.equal(body.graph.themeSignals[0].personId,'local-ada');assert.deepEqual(augmented[0],{graph,lens:'my'});
 const foreign={...graph,themeSignals:[{...graph.themeSignals[0],personId:'gmail-derived-or-foreign'}]};
 const rejected=await worker.fetch(new Request('https://people.test/api/push',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(foreign)}),env);assert.equal(rejected.status,400);assert.equal((getSaved() as any).json,JSON.stringify(graph));
 const legacy={pushedAt:graph.pushedAt,nodes:graph.nodes,edges:graph.edges};
 const oldPush=await worker.fetch(new Request('https://people.test/api/push',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(legacy)}),env);assert.equal(oldPush.status,200);
 await signedRequest('/api/graph?source=obsidian',env);assert.deepEqual(augmented[1].graph.themes,[]);assert.deepEqual(augmented[1].graph.themeSignals,[]);
});

test('legacy graph payloads preserve dotted and duplicate node ids through push and load',async()=>{
 const {env}=workerFixture();const token=(await (await signedRequest('/api/token',env)).json() as any).token;
 const legacy={pushedAt:'2026-09-14T12:00:00.000Z',nodes:[{id:'legacy.id',name:'First',x:1},{id:'legacy.id',name:'Duplicate',x:2}],edges:[{source:'legacy.id',target:'legacy.id',weight:1,types:['legacy.type'],contexts:['Legacy shape']}]};
 const pushed=await worker.fetch(new Request('https://people.test/api/push',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(legacy)}),env);assert.equal(pushed.status,200);
 const loaded=await signedRequest('/api/graph?source=obsidian',env);assert.equal(loaded.status,200);const graph=(await loaded.json() as any).graph;
 assert.deepEqual(graph.nodes,legacy.nodes);assert.deepEqual(graph.edges,legacy.edges);assert.deepEqual(graph.themes,[]);assert.deepEqual(graph.themeSignals,[]);
});

test('draft route is session-gated, same-origin, body-checked and maps durable object failures',async()=>{
 const {env}=workerFixture();const calls:string[]=[];
 let result:any={to:'ada@example.test',name:'Ada',subject:'Following up',body:'Hi Ada, good to see you.',checked:true,warnings:['This draft may read as too blunt or off-tone.'],basedOn:[{summary:'Ask: “hi”',observedAt:'2026-09-14T11:00:00.000Z',title:'Pilot sync'}]};
 env.MAIL.getByName=(owner:string)=>({bindOwner:async()=>{calls.push('bind:'+owner);},draftNote:async(personId:string)=>{calls.push('draft:'+personId);if(result instanceof Error)throw result;return result;}});
 const post=(body:string,origin='https://people.test')=>({method:'POST',headers:{origin,'content-type':'application/json'},body});
 assert.equal((await worker.fetch(new Request('https://people.test/api/people/draft',post('{"personId":"ada"}')),env)).status,401);
 assert.deepEqual(calls,[]);
 assert.equal((await signedRequest('/api/people/draft',env,post('{"personId":"ada"}','https://evil.test'))).status,403);
 for(const body of ['{}','not json','{"personId":""}','{"personId":"a@b.test"}',JSON.stringify({personId:'x'.repeat(2100)})]){
  const bad=await signedRequest('/api/people/draft',env,post(body));
  assert.equal(bad.status,400,body.slice(0,40));assert.equal((await bad.json() as any).error,'invalid_request');
 }
 assert.deepEqual(calls,[]);
 const ok=await signedRequest('/api/people/draft',env,post('{"personId":"ada"}'));
 assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');
 assert.deepEqual(await ok.json(),result);
 assert.deepEqual(calls,['bind:owner@example.test','draft:ada']);
 for(const [message,status] of [['unknown_person',404],['ai_unavailable',503],['invalid_draft',502],['boom',500]] as const){
  result=Error(message);
  const failed=await signedRequest('/api/people/draft',env,post('{"personId":"ada"}'));
  assert.equal(failed.status,status,message);
  assert.equal((await failed.json() as any).error,status===500?'server_error':message);
 }
 assert.equal((await signedRequest('/api/people/draft',env,{method:'GET'})).status,405);
});
