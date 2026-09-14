import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relevanceRoute} from '../src/relevance-routes';

const ORIGIN='https://people.test';
const OWNER='owner@example.test';
const KEY='route-key-123456';
const preview={account:'mail@example.test',personId:'person-ada',themeId:'theme-agent-memory',windowDays:30,maxMessages:50,maxBytes:1_000_000,before:1_800_000_000,after:1_797_408_000,expiresAt:1_800_600_000,fingerprint:'f'.repeat(43)};

function request(path:string,method='GET',body?:unknown,origin=ORIGIN,key?:string){
 const headers=new Headers();
 if(body!==undefined)headers.set('content-type','application/json');
 if(origin)headers.set('origin',origin);
 if(key)headers.set('idempotency-key',key);
 return new Request(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}

function fixture(){
 const names:string[]=[];
 const calls:Record<string,unknown[][]>={relevance:[],evidence:[],previewRetrieval:[],confirmRetrieval:[],retrievalStatus:[],recordRelevanceFeedback:[],previewPublicSource:[],confirmPublicSource:[],relevanceFromPushedGraph:[],evidenceFromPushedGraph:[],recordPushedRelevanceFeedback:[]};
 const stub={
  relevance:async(...args:unknown[])=>{calls.relevance.push(args);return {version:1,lens:args[0],themes:[]};},
  evidence:async(...args:unknown[])=>{calls.evidence.push(args);return {theme:null,signals:[]};},
  previewRetrieval:async(...args:unknown[])=>{calls.previewRetrieval.push(args);return preview;},
  confirmRetrieval:async(...args:unknown[])=>{calls.confirmRetrieval.push(args);return {id:'job-one',status:'queued'};},
  retrievalStatus:async(...args:unknown[])=>{calls.retrievalStatus.push(args);return args[0]==='missing'?null:{id:args[0],status:'complete'};},
  recordRelevanceFeedback:async(...args:unknown[])=>{calls.recordRelevanceFeedback.push(args);return {id:'feedback-one',...args[0] as object};},
  previewPublicSource:async(...args:unknown[])=>{calls.previewPublicSource.push(args);return {canonicalUrl:'https://example.com/',publisherHost:'example.com',visibility:'public'};},
  confirmPublicSource:async(...args:unknown[])=>{calls.confirmPublicSource.push(args);return {id:'source-one',status:'queued'};},
  relevanceFromPushedGraph:async(...args:unknown[])=>{calls.relevanceFromPushedGraph.push(args);return {version:1,lens:args[1],themes:[]};},
  evidenceFromPushedGraph:async(...args:unknown[])=>{calls.evidenceFromPushedGraph.push(args);return {theme:(args[0] as any).themes[0],signals:(args[0] as any).themeSignals};},
  recordPushedRelevanceFeedback:async(...args:unknown[])=>{calls.recordPushedRelevanceFeedback.push(args);const input=args[0] as any,graph=args[1] as any;if(input.personId&&!graph.nodes.some((node:any)=>node.id===input.personId))throw Error('invalid_relevance_person');return {id:'feedback-pushed'};},
 };
 const graphs=new Map<string,any>();
 const env={MAIL:{getByName(name:string){names.push(name);return stub;}},DB:{prepare(){let owner='';return {bind(value:string){owner=value;return this;},async first(){const graph=graphs.get(owner);return graph?{json:JSON.stringify(graph),updated_at:1}:null;}};}}};
 return {env:env as any,stub,calls,names,graphs};
}

test('preview is read-only and confirm requires same origin plus idempotency',async()=>{
 const {env,calls,names}=fixture();
 assert.equal((await relevanceRoute(request('/api/retrieval/preview','POST',{account:preview.account,personId:preview.personId,windowDays:30}),env,OWNER)).status,200);
 assert.equal(calls.confirmRetrieval.length,0);
 assert.equal((await relevanceRoute(request('/api/retrieval/confirm','POST',preview,'https://evil.test',KEY),env,OWNER)).status,403);
 assert.equal((await relevanceRoute(request('/api/retrieval/confirm','POST',preview),env,OWNER)).status,400);
 assert.equal(calls.confirmRetrieval.length,0);
 assert.deepEqual(names,[OWNER]);
});

test('public routes resolve pushed source on server and expose bounded source-scoped status',async()=>{
 const {env,stub,calls,graphs}=fixture();
 graphs.set(OWNER,{nodes:[{id:'local-ada'}],edges:[],themes:[],themeSignals:[]});
 (stub as any).publicSourceStatus=async(id:string,graphSource:string)=>({id,status:'complete',graphSource});
 const input={url:'https://example.com/',personId:'local-ada'};
 assert.equal((await relevanceRoute(request('/api/public-sources/preview?source=obsidian','POST',input),env,OWNER)).status,200);
 assert.deepEqual(calls.previewPublicSource[0],[{...input,graphSource:'obsidian'}]);
 assert.equal((await relevanceRoute(request('/api/public-sources/confirm?source=obsidian','POST',input,ORIGIN,KEY),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/public-sources/source-one?source=obsidian'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/public-sources/source-one?source=foreign'),env,OWNER)).status,400);
 assert.equal((await relevanceRoute(request('/api/public-sources/ada%40example.com'),env,OWNER)).status,400);
 assert.equal((await relevanceRoute(request('/api/public-sources/preview?source=obsidian','POST',{...input,graph:{nodes:[{id:'forged'}]}}),env,OWNER)).status,400);
});

test('another authenticated owner is routed to a different Durable Object',async()=>{
 const {env,names}=fixture();
 await relevanceRoute(request('/api/relevance?lens=my'),env,'alice@example.test');
 await relevanceRoute(request('/api/relevance?lens=my'),env,'bob@example.test');
 assert.deepEqual(names,['alice@example.test','bob@example.test']);
});

test('all relevance endpoints forward only validated bounded values',async()=>{
 const {env,calls}=fixture();
 assert.equal((await relevanceRoute(request('/api/relevance?lens=firm'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-agent-memory/evidence?lens=public'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/retrieval/confirm','POST',preview,ORIGIN,KEY),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/retrieval/job-one'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/retrieval/missing'),env,OWNER)).status,404);
 assert.equal((await relevanceRoute(request('/api/themes/theme-agent-memory/feedback','POST',{action:'mute',personId:'person-ada'},ORIGIN,KEY),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/public-sources/preview','POST',{url:'https://example.com/',personId:'person-ada'}),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/public-sources/confirm','POST',{url:'https://example.com/',personId:'person-ada'},ORIGIN,KEY),env,OWNER)).status,200);
 assert.deepEqual(calls.relevance,[['firm']]);
 assert.deepEqual(calls.evidence,[['theme-agent-memory','public']]);
 assert.deepEqual(calls.confirmRetrieval,[[{...preview,idempotencyKey:KEY}]]);
 assert.deepEqual(calls.recordRelevanceFeedback,[[{themeId:'theme-agent-memory',action:'mute',personId:'person-ada',idempotencyKey:KEY}]]);
 assert.deepEqual(calls.confirmPublicSource,[[{url:'https://example.com/',personId:'person-ada',idempotencyKey:KEY}]]);
});

test('route validation rejects invalid methods, lenses, ids, fields, windows and keys before RPC',async()=>{
 const {env,calls}=fixture();
 const cases=[
  request('/api/relevance?lens=private'),
  request('/api/relevance?lens=my&extra=1'),
  request('/api/themes/ada%40example.com/evidence?lens=my'),
  request('/api/retrieval/preview','GET'),
  request('/api/retrieval/preview','POST',{account:'mail@example.test',personId:'person-ada',windowDays:60}),
  request('/api/retrieval/preview','POST',{account:'mail@example.test',personId:'person-ada',unknown:true}),
  request('/api/themes/theme-agent-memory/feedback','POST',{action:'rename'},ORIGIN,KEY),
  request('/api/themes/theme-agent-memory/feedback','POST',{action:'mute',summary:'x'.repeat(241)},ORIGIN,KEY),
  request('/api/public-sources/confirm','POST',{url:'https://example.com/'},ORIGIN,'short'),
  request('/api/public-sources/confirm','POST',{url:'https://example.com/'},ORIGIN,'x'.repeat(129)),
  request('/api/public-sources/confirm','POST',{url:'https://example.com/'},ORIGIN,'visible key 12345'),
 ];
 for(const input of cases)assert.ok((await relevanceRoute(input,env,OWNER)).status>=400);
 assert.equal(Object.values(calls).reduce((sum,items)=>sum+items.length,0),0);
});

test('JSON input is capped by encoded bytes and route errors expose safe finite codes only',async()=>{
 const {env,stub}=fixture();
 const oversized=request('/api/public-sources/preview','POST',{url:`https://example.com/${'é'.repeat(9_000)}`});
 assert.equal((await relevanceRoute(oversized,env,OWNER)).status,413);
 stub.relevance=async()=>{throw Error('SECRET token and raw body');};
 const response=await relevanceRoute(request('/api/relevance?lens=my'),env,OWNER);
 assert.equal(response.status,500);
 assert.deepEqual(await response.json(),{error:'server_error'});
 assert.equal(response.headers.get('cache-control'),'no-store');
});

test('obsidian source routes use only the authenticated owner stored graph for relevance, evidence and person feedback',async()=>{
 const {env,graphs,calls}=fixture();
 const graph={nodes:[{id:'local-ada'}],edges:[],themes:[{id:'theme-local',canonicalName:'agent memory',aliases:['Agent Memory'],description:'Local theme',status:'active'}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note',visibility:'private',observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};
 graphs.set('alice@example.test',graph);graphs.set('bob@example.test',{...graph,nodes:[{id:'local-bob'}],themeSignals:[{...graph.themeSignals[0],personId:'local-bob'}]});
 assert.equal((await relevanceRoute(request('/api/relevance?lens=my&source=obsidian'),env,'alice@example.test')).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/evidence?lens=my&source=obsidian'),env,'alice@example.test')).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/feedback?source=obsidian','POST',{action:'pin',personId:'local-ada'},ORIGIN,KEY),env,'alice@example.test')).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/feedback?source=obsidian','POST',{action:'pin',personId:'local-bob'},ORIGIN,KEY),env,'alice@example.test')).status,400);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/feedback?source=obsidian','POST',{action:'pin',personId:'raw@example.test'},ORIGIN,KEY),env,'alice@example.test')).status,400);
 assert.equal(calls.relevanceFromPushedGraph.length,1);assert.equal((calls.relevanceFromPushedGraph[0][0] as any).nodes[0].id,'local-ada');
 assert.deepEqual(calls.evidenceFromPushedGraph[0].slice(1),['theme-local','my']);
 assert.equal(calls.recordPushedRelevanceFeedback.length,2);assert.equal((calls.recordPushedRelevanceFeedback[0][1] as any).nodes[0].id,'local-ada');
});

test('default relevance routes select the owner Obsidian graph when the Gmail graph is empty',async()=>{
 const {env,graphs,calls,stub}=fixture();
 const graph={nodes:[{id:'local-ada'}],edges:[],themes:[{id:'theme-local',canonicalName:'agent memory',aliases:[],description:'Local theme',status:'active'}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note',visibility:'private',observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};
 graphs.set(OWNER,graph);(stub as any).hasMailGraph=async()=>false;
 assert.equal((await relevanceRoute(request('/api/relevance?lens=my'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/evidence?lens=my'),env,OWNER)).status,200);
 assert.equal((await relevanceRoute(request('/api/themes/theme-local/feedback','POST',{action:'pin',personId:'local-ada'},ORIGIN,KEY),env,OWNER)).status,200);
 assert.equal(calls.relevanceFromPushedGraph.length,1);assert.equal(calls.evidenceFromPushedGraph.length,1);assert.equal(calls.recordPushedRelevanceFeedback.length,1);
 assert.equal(calls.relevance.length,0);assert.equal(calls.evidence.length,0);assert.equal(calls.recordRelevanceFeedback.length,0);
});
