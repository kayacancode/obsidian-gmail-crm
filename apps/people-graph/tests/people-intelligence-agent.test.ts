import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {peopleMemoryAgentRoute,peopleMemoryOwnerRoute} from '../src/people-memory-agent';
import {fixture as mailFixture} from './person-context.test';
import {opaque} from '../src/mail-model';
import {jevServer,scoreA} from './granola-jev-extractor.test';

const owner='owner@example.test',origin='https://people.test';
const fields={focus:'Building a clinic scheduling tool.',needs:'Validate nurse handoffs.',offers:''};
const empty={focus:'',needs:'',offers:''};
function fixture(t:TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const DB:any={prepare(sql:string){let args:any[]=[];return {bind(...values:any[]){args=values;return this;},async run(){return {success:true,meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};}};}};
 let lens:any={revision:'lens-1',fields:{...fields},updatedAt:null,suggestions:[{id:'draft',text:'UNCONFIRMED DRAFT'}],sources:[{text:'PRIVATE SOURCE'}]},memory:any={revision:'memory-1',people:{}};
 let graph:any={source:'email_accounts',nodes:[{id:'ada',name:'Ada',company:'Clinic',combined:80},{id:'bo',name:'Bo',combined:60},{id:'duplicate-name',name:'Ada'}],edges:[{source:'ada',target:'bo',weight:1,types:['shared_email'],contexts:['Workshop']}],themeSignals:[],personAliases:{alias:'ada'}};
 const calls:string[]=[];
 const stub:any={bindOwner:async(actor:string)=>{assert.equal(actor,owner);calls.push('bind');},getOwnerLens:async()=>lens,recommendationMemory:async()=>memory,graph:async()=>graph,helperContext:async()=>[],refreshHelperContext:async()=>{calls.push('refresh');},resolveOwnEmail:async(value:string)=>value==='ada@example.test'?'ada':value==='alias@example.test'?'alias':null,searchPeople:async()=>({results:[]}),sharedMeta:async()=>({owners:[],refreshedAt:Date.now()})};
 const env:any={DB,MAIL:{getByName(actor:string){assert.equal(actor,owner);return stub;}}};
 const request=(path:string,token?:string,input?:unknown,headers:Record<string,string>={})=>peopleMemoryAgentRoute(new Request(origin+path,{method:input===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})}),env);
 const management=(path:string,input:unknown,actor=owner)=>peopleMemoryOwnerRoute(new Request(origin+'/api/people/integrations'+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)}),env,actor);
 const mint=async(scopes=['people:read'])=>{const response=await management('',{name:'Intelligence client',scopes});assert.equal(response.status,201);return response.json() as Promise<any>;};
 const mcp=async(token:string,name:string,input:unknown)=>{const response=await request('/api/people-mcp',token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}},{host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'});assert.equal(response.status,200);const raw=await response.text();return JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);};
 return {db,env,stub,calls,request,management,mint,mcp,setLens:(value:any)=>lens=value,setFields:(value:any)=>lens={...lens,fields:value},setMemory:(value:any)=>memory=value,getGraph:()=>graph,setGraph:(value:any)=>graph=value};
}

test('People intelligence reads only the confirmed lens and empty confirmed fields give honest empty matches',async t=>{
 const f=fixture(t),key=await f.mint();
 const response=await f.request('/api/people-agent/lens',key.token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{revision:'lens-1',fields,updatedAt:null});
 f.setFields(empty);f.stub.graph=async()=>{throw Error('Empty lens must not load graph');};
 const matched=await f.request('/api/people-agent/matches',key.token,{});assert.equal(matched.status,200);const result:any=await matched.json();assert.equal(result.status,'no_owner_context');assert.deepEqual(result.results,[]);
});
test('People intelligence requires people read authority and strictly bounded owner-free inputs',async t=>{
 const f=fixture(t),read=await f.mint(),write=await f.mint(['people:write']);
 const requests:[string,unknown?][]=[['/lens'],['/matches',{}],['/search',{query:'Ada'}],['/connection',{from:'ada',to:'bo'}],['/helpers',{personId:'ada'}]];
 for(const [path,input] of requests){assert.equal((await f.request('/api/people-agent'+path,undefined,input)).status,401);assert.equal((await f.request('/api/people-agent'+path,'pg_cli_'+'a'.repeat(43),input)).status,401);assert.equal((await f.request('/api/people-agent'+path,write.token,input)).status,403);}
 for(const [path,input] of [['/lens?owner=foreign'],['/matches',{fields}],['/matches',{owner:'foreign'}],['/search',{query:''}],['/search',{query:'a'.repeat(201)}],['/search',{query:'Ada',limit:51}],['/search',{query:'Ada',limit:0}],['/search',{query:'Ada',limit:1.5}],['/search',{query:'Ada',owner:'foreign'}],['/connection',{from:'ada',to:'bo',owner:'foreign'}],['/connection',{from:'ada',to:'x'.repeat(321)}],['/helpers',{personId:'ada',brief:'Override'}]] as [string,unknown?][])assert.equal((await f.request('/api/people-agent'+path,read.token,input)).status,400,path);
 assert.equal(f.calls.length,0);
 assert.equal((await f.request('/api/people-agent/matches',read.token,{}, {origin:'https://foreign.test'})).status,403);
 await f.management('/'+read.credential.id+'/revoke',{});assert.equal((await f.request('/api/people-agent/lens',read.token)).status,401);
});
test('People intelligence search preserves website ranking and canonical identities without guessing names',async t=>{
 const f=fixture(t),key=await f.mint();
 const search=await f.request('/api/people-agent/search',key.token,{query:'Ada',limit:1});assert.equal(search.status,200);const result:any=await search.json();assert.deepEqual(result.people.map((p:any)=>p.id),['ada']);assert.equal(result.stats.source,'email_accounts');
 for(const from of ['alias','alias@example.test','ADA@EXAMPLE.TEST']){const response=await f.request('/api/people-agent/connection',key.token,{from,to:'bo'});assert.equal(response.status,200);assert.equal((await response.json() as any).from.personId,'ada');}
 assert.equal((await f.request('/api/people-agent/connection',key.token,{from:'Ada',to:'bo'})).status,404);
 f.setGraph({...f.getGraph(),nodes:[...f.getGraph().nodes,{id:'ada',name:'Ambiguous identity'}]});assert.equal((await f.request('/api/people-agent/connection',key.token,{from:'ada',to:'bo'})).status,409);
});
test('People connection explanations preserve typed source evidence without upgrading a shared thread to an introduction',async t=>{
 const f=fixture(t),key=await f.mint(),input={from:'ada',to:'bo'};
 const first:any=await (await f.request('/api/people-agent/connection',key.token,input)).json();assert.equal(first.status,'found');assert.deepEqual(first.connections[0].types,['shared_email']);assert.equal(first.connections[0].kind,'cooccurrence');assert.ok(!JSON.stringify(first).includes('introduced'));
 const source={id:'intro-1',type:'introduced',title:'Introduced by you',url:'https://mail.google.com/mail/u/?authuser=owner%40example.test#all/thread',date:'2026-10-01',provenance:{source:'gmail'}};
 f.setGraph({...f.getGraph(),connectionsRevision:'intro-1',edges:[{...f.getGraph().edges[0],types:['shared_email','introduced'],evidence:[source]}]});
 const second:any=await (await f.request('/api/people-agent/connection',key.token,input)).json();assert.equal(second.connections[0].kind,'cooccurrence');assert.deepEqual(second.connections[0].evidence,[source]);
 const none:any=await (await f.request('/api/people-agent/connection',key.token,{from:'ada',to:'duplicate-name'})).json();assert.equal(none.status,'not_found');assert.deepEqual(none.connections,[]);
});
test('People intelligence rejects in-flight lens, source, and private profile changes',async t=>{
 const f=fixture(t),key=await f.mint();
 const graph=f.getGraph();f.stub.graph=async()=>{f.setFields({...fields,focus:'Updated'});return graph;};assert.equal((await f.request('/api/people-agent/matches',key.token,{})).status,409);
 f.setFields(fields);f.stub.graph=async()=>graph;f.stub.helperContext=async()=>{f.setMemory({revision:'memory-2',people:{}});return [];};
 assert.equal((await f.request('/api/people-agent/matches',key.token,{})).status,409);
 f.setMemory({revision:'memory-1',people:{}});assert.equal((await f.request('/api/people-agent/helpers',key.token,{personId:'ada'})).status,409);
 f.setMemory({revision:'memory-1',people:{}});f.stub.graph=async()=>{f.setMemory({revision:'withdrawn',people:{}});return graph;};assert.equal((await f.request('/api/people-agent/search',key.token,{query:'Ada'})).status,409);
 f.setMemory({revision:'memory-1',people:{}});assert.equal((await f.request('/api/people-agent/connection',key.token,{from:'ada',to:'bo'})).status,409);
});
test('People intelligence MCP tools match REST results, are read-only, and cannot override confirmed lens',async t=>{
 const f=fixture(t),key=await f.mint();f.setFields(empty);
 for(const [name,path,input] of [['get_people_lens','lens',undefined],['recommend_people','matches',{}],['find_people','search',{query:'Ada'}],['explain_connection','connection',{from:'ada',to:'bo'}],['suggest_connections','helpers',{personId:'ada'}]] as [string,string,any][]){const rest=await f.request('/api/people-agent/'+path,key.token,input);assert.equal(rest.status,200);const call=await f.mcp(key.token,name,input??{});assert.deepEqual(call.result.structuredContent,await rest.json());assert.deepEqual(JSON.parse(call.result.content[0].text),call.result.structuredContent);}
 const rejected=await f.mcp(key.token,'recommend_people',{fields});assert.ok(rejected.error||rejected.result?.isError);
 const list=await f.request('/api/people-mcp',key.token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'});const raw=await list.text(),result=JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);
 assert.equal(result.result.tools.length,6);for(const tool of result.result.tools){assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.openWorldHint,false);assert.equal(tool.inputSchema.additionalProperties,false);}
});

test('People intelligence real stores isolate saved lenses and canonical private helper memory by credential owner',async t=>{
 const f=fixture(t),own=await mailFixture(),other=await mailFixture('other@example.test');t.after(()=>{own.db.close();other.db.close();});
 f.env.MAIL={getByName(actor:string){assert.ok([owner,'other@example.test'].includes(actor));return actor===owner?own.service:other.service;}};
 const initial=await own.service.getOwnerLens();await own.service.updateOwnerLens({revision:initial.revision,fields});
 const key=await f.mint(),foreign:any=await (await f.management('',{name:'Other owner',scopes:['people:read']},'other@example.test')).json();
 assert.deepEqual((await (await f.request('/api/people-agent/lens',key.token)).json() as any).fields,fields);
 assert.deepEqual((await (await f.request('/api/people-agent/lens',foreign.token)).json() as any).fields,empty);
 await own.service.savePersonContext({personId:own.personId,revision:null,text:'Private own clinic needs'});
 own.add('alias@example.test','Ada at another inbox');const aliasId=await opaque(owner,'alias@example.test',own.env.TOKEN_SECRET);await own.service.setPersonMerge(aliasId,own.personId);
 const helper=await f.request('/api/people-agent/helpers',key.token,{personId:aliasId});assert.equal(helper.status,200);const value:any=await helper.json();assert.equal(value.contextSource,'saved_note');assert.equal(value.brief,'Private own clinic needs');
 const browser=await own.request('/api/people/helpers',{personId:own.personId,brief:''});assert.deepEqual(await browser.json(),value);
 assert.equal((await f.request('/api/people-agent/helpers',foreign.token,{personId:own.personId})).status,400);
 const foreignHelper:any=await (await f.request('/api/people-agent/helpers',foreign.token,{personId:other.personId})).json();assert.equal(foreignHelper.status,'no_anchor_context');assert.ok(!JSON.stringify(foreignHelper).includes('Private own clinic needs'));
 const match=await f.request('/api/people-agent/matches',key.token,{}),browserMatch=await own.request('/api/lens/matches',{});assert.equal(match.status,200);assert.deepEqual(await match.json(),await browserMatch.json());
 const search=await f.request('/api/people-agent/search',key.token,{query:'alias@example.test'});assert.equal(search.status,200);assert.deepEqual((await search.json() as any).people.map((p:any)=>p.id),[own.personId]);
});
test('People connection results are discarded if typed evidence disappears while source revisions stay stable',async t=>{
 const f=fixture(t),key=await f.mint(),before=f.getGraph();let reads=0;
 const introduced={...before,edges:[{...before.edges[0],types:['shared_email','introduced'],evidence:[{type:'introduced',title:'Introduced by you'}]}]};
 f.stub.graph=async()=>++reads===1?introduced:before;
 const response=await f.request('/api/people-agent/connection',key.token,{from:'ada',to:'bo'});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'person_context_conflict'});
});
test('People intelligence hides provider details and rejects unresolved exact identities',async t=>{
 const f=fixture(t),key=await f.mint();f.stub.getOwnerLens=async()=>{throw Error('Private provider failure token=secret');};
 const failed=await f.request('/api/people-agent/matches',key.token,{});assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{error:'people_memory_failed'});
 for(const extra of [{identityResolved:false},{identityStatus:'unresolved'},{permission:'conflicted'},{permissionConflict:true}]){
  f.setGraph({...f.getGraph(),nodes:[{id:'ada',name:'Ada',...extra},{id:'bo',name:'Bo'}]});
  const response=await f.request('/api/people-agent/connection',key.token,{from:'ada',to:'bo'});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'ambiguous_person'});
 }
});

test('People recommendations return audited website evidence and discard a successful model result after source withdrawal',async t=>{
 const f=fixture(t),key=await f.mint(),passage='I led moderated usability interviews with hospital nurses about shift handoffs.';
 f.stub.helperContext=async()=>[{personId:'bo',evidenceRef:'gmail-context:bo',sourceType:'gmail_body_derived',summary:passage,visibility:'private',observedAt:new Date().toISOString()}];
 let withdraw=false,generated=0,audited=0;
 f.env.TYPESAFE_API_KEY='test';f.env.AI={run:async(_model:any,input:any)=>{
  const state=JSON.parse(input.input[1].content);
  if(input.text.format.schema.properties.matches){generated++;assert.match(state.selected.brief,/clinic scheduling/);assert.equal(state.candidates[0].evidence[0].summary,passage);return {status:'completed',output_text:JSON.stringify({matches:[{candidate:'c0',reason:'You are building a clinic scheduling tool. PERSON_B has interviewed nurses about shift handoffs.',conversation:'Which nurse handoff assumptions should your scheduling tool test first?',anchorRefs:[],candidateRefs:['c0e0']}]})};}
  audited++;if(withdraw)f.setMemory({revision:'source-withdrawn',people:{}});
  return {status:'completed',output_text:JSON.stringify({sourceReadings:state.candidate.evidence.map((source:any)=>({sourceRef:source.ref,workSubject:'person_or_team',polarity:'affirmed',sentenceIds:[source.sentences[0].id],ownWork:source.sentences[0].text})),grounded:true,attributed:true,specific:true,reason:'The source supports a workflow discussion.'})};
 }};
 t.mock.method(globalThis,'fetch',jevServer(()=>scoreA(3)).fake);
 const response=await f.request('/api/people-agent/matches',key.token,{});assert.equal(response.status,200);const value:any=await response.json();assert.equal(value.status,'ready');assert.equal(value.checked,true);assert.equal(value.results.length,1);assert.equal(value.results[0].personId,'bo');assert.equal(value.results[0].evidence[0].summary,passage);assert.equal(generated,1);assert.equal(audited,1);
 withdraw=true;const stale=await f.request('/api/people-agent/matches',key.token,{});assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'person_context_conflict'});assert.equal(generated,2);assert.equal(audited,2);
});

test('People search discards a names-only shared person revoked after the final graph snapshot',async t=>{
 const f=fixture(t),own=await mailFixture();t.after(()=>own.db.close());f.env.MAIL=own.env.MAIL;
 await own.service.importShares([{owner:'sharing@example.test',exportedAt:Date.now(),people:[{email:'shared@example.test',name:'Revocable Contact',lastContact:null,meetings:0}],edges:[],themes:[],signals:[]}]);
 const revision=(await own.service.recommendationMemory()).revision,key=await f.mint();
 const visible=await f.request('/api/people-agent/search',key.token,{query:'Revocable'});assert.equal(visible.status,200);assert.equal((await visible.json() as any).people.length,1);
 const readGraph=own.service.graph.bind(own.service);let reads=0;
 t.mock.method(own.service,'graph',async()=>{const graph=await readGraph();if(++reads===2)await own.service.dropShare('sharing@example.test');return graph;});
 const revoked=await f.request('/api/people-agent/search',key.token,{query:'Revocable'});assert.equal(revoked.status,409);assert.deepEqual(await revoked.json(),{error:'person_context_conflict'});assert.notEqual((await own.service.recommendationMemory()).revision,revision);
});

test('People recommendation revisions track names-only shared data and ignore identical cache refreshes',async t=>{
 const own=await mailFixture();t.after(()=>own.db.close());
 const slice={owner:'sharing@example.test',exportedAt:Date.now(),people:[{email:'shared@example.test',name:'Revocable Contact',lastContact:null,meetings:0}],edges:[],themes:[],signals:[]};
 const absent=(await own.service.recommendationMemory()).revision;
 await own.service.importShares([slice]);const visible=(await own.service.recommendationMemory()).revision;assert.notEqual(visible,absent);
 own.db.prepare('UPDATE shared_meta SET refreshed_at=?').run(Date.now()+1000);assert.equal((await own.service.recommendationMemory()).revision,visible);
 await own.service.importShares([slice]);assert.equal((await own.service.recommendationMemory()).revision,visible);
 await own.service.dropShare('sharing@example.test');assert.equal((await own.service.recommendationMemory()).revision,absent);
});
