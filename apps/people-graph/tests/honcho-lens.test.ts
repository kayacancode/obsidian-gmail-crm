import test from 'node:test';
import assert from 'node:assert/strict';
import {syncHonchoLens,deleteHonchoLens,honchoConfigured} from '../src/honcho-lens';

const env={HONCHO_API_KEY:'test-key',TOKEN_SECRET:'test-secret'};
const sources=[{id:'note-1',text:'I am building agent memory tools.',observedAt:'2026-10-18T12:00:00.000Z'}];
type Call={url:URL;init:RequestInit;body:any};
function fakeHoncho(){
 const calls:Call[]=[],sessions=new Map<string,any[]>(),sessionMetadata=new Map<string,any>();let answer:((messages:any[])=>any)|undefined;
 const fetcher=async(input:any,init:RequestInit={})=>{
  const url=new URL(String(input)),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({url,init,body});
  assert.equal(url.origin,'https://api.honcho.dev');assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal);
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer test-key');
  const bits=url.pathname.split('/'),workspace=bits[3],session=bits[5];
  if(url.pathname==='/v3/workspaces')return Response.json({id:body.id,created_at:sources[0].observedAt,metadata:body.metadata??{},configuration:body.configuration??{}});
  if(bits[4]==='peers'&&bits[6]==='chat'){
   const messages=sessions.get(body.session_id)??[];
   const content=answer?answer(messages):{entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:[messages[0]?.metadata.source_ref]}]};
   return Response.json({content:JSON.stringify(content),evidence:{messages:messages.map(m=>({id:m.id,peer_id:m.peer_id,session_id:m.session_id,created_at:m.created_at})),conclusions:[],tool_calls:[]}});
  }
  if(bits[4]==='peers')return Response.json({id:body.id,uid:'peer-uid',workspace_id:workspace,created_at:sources[0].observedAt,metadata:body.metadata??{},configuration:{}});
  if(bits[4]==='sessions'&&bits.length===5){sessions.set(body.id,sessions.get(body.id)??[]);if(body.metadata)sessionMetadata.set(body.id,body.metadata);return Response.json({id:body.id,uid:'session-uid',workspace_id:workspace,is_active:true,created_at:sources[0].observedAt,metadata:sessionMetadata.get(body.id)??{},configuration:body.configuration??{}});}
  if(bits[4]==='sessions'&&init.method==='PUT'){sessionMetadata.set(session,body.metadata);return Response.json({id:session,uid:'session-uid',workspace_id:workspace,is_active:true,created_at:sources[0].observedAt,metadata:body.metadata,configuration:{}});}
  if(bits[6]==='messages'&&bits[7]==='list'){const messages=sessions.get(session)??[];return Response.json({items:messages,total:messages.length,page:1,size:40,pages:messages.length?1:0});}
  if(bits[6]==='messages'){
   const messages=body.messages.map((m:any,i:number)=>({...m,id:'message-'+session+'-'+i,session_id:session,workspace_id:workspace,token_count:10}));
   sessions.get(session)!.push(...messages);return Response.json(messages,{status:201});
  }
  throw Error('Unexpected request '+url);
 };
 return {calls,sessions,fetcher,setAnswer(fn:(messages:any[])=>any){answer=fn;}};
}
async function withFetch(fn:any,run:()=>Promise<void>){const original=globalThis.fetch;globalThis.fetch=fn;try{await run();}finally{globalThis.fetch=original;}}

test('unconfigured Honcho never sends private sources and reports its actual status',async()=>{
 await withFetch(()=>{assert.fail('No network without a configured key');},async()=>{
  assert.equal(honchoConfigured({}),false);assert.equal(honchoConfigured({HONCHO_API_KEY:'  '}),false);
  assert.deepEqual(await syncHonchoLens({TOKEN_SECRET:'secret'},'owner@example.com',sources),{status:'unconfigured',entries:[]});
  assert.deepEqual(await deleteHonchoLens({TOKEN_SECRET:'secret'},'owner@example.com'),{status:'unconfigured'});
 });
});

test('Honcho attributes sources to only the opaque owner and returns verified local source references',async()=>{
 const fake=fakeHoncho();await withFetch(fake.fetcher,async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner@example.com',sources),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]});
  const create=fake.calls.find(c=>c.body?.messages)!,peer=fake.calls.find(c=>c.url.pathname.endsWith('/peers'))!,chat=fake.calls.find(c=>c.url.pathname.endsWith('/chat'))!;
  assert.match(create.body.messages[0].peer_id,/^[A-Za-z0-9_-]+$/);assert.equal(create.body.messages[0].peer_id,peer.body.id);
  assert.match(create.body.messages[0].content,/OWNER/);assert.match(create.body.messages[0].content,/I am building agent memory tools/);
  assert.equal(create.body.messages[0].created_at,sources[0].observedAt);assert.equal(chat.body.include_evidence,true);
  assert.equal(chat.body.session_id,create.url.pathname.split('/')[5]);assert.equal(chat.body.response_format.type,'object');
  assert.deepEqual(chat.body.filters,{session_id:chat.body.session_id});
  assert.ok(!JSON.stringify(fake.calls.map(c=>({url:c.url.href,body:c.body}))).includes('owner@example.com'));
  assert.equal(fake.calls.find(c=>c.url.pathname.endsWith('/sessions'))!.body.configuration.peer_card.use,false);
 });
});

test('repeated snapshots and uncertain completed message writes never duplicate owner messages',async()=>{
 const fake=fakeHoncho();let loseResponse=true;
 await withFetch(async(input:any,init:any)=>{const response=await fake.fetcher(input,init);if(String(input).endsWith('/messages')&&loseResponse){loseResponse=false;throw Error('connection lost after write');}return response;},async()=>{
  assert.equal((await syncHonchoLens(env,'owner',sources)).status,'unavailable');
  assert.equal((await syncHonchoLens(env,'owner',sources)).status,'ready');
  assert.equal((await syncHonchoLens(env,'owner',sources)).status,'ready');
  assert.equal(fake.calls.filter(c=>c.body?.messages).length,1);
 });
});

test('changed or removed sources use a different scoped snapshot; other owners never share IDs',async()=>{
 const fake=fakeHoncho();await withFetch(fake.fetcher,async()=>{
  await syncHonchoLens(env,'owner',sources);
  await syncHonchoLens(env,'owner',[{...sources[0],text:'I am looking for design partners.'}]);
  await syncHonchoLens(env,'other-owner',sources);
  const chats=fake.calls.filter(c=>c.url.pathname.endsWith('/chat'));
  assert.equal(chats.length,3);assert.notEqual(chats[0].body.session_id,chats[1].body.session_id);assert.notEqual(chats[0].url.pathname,chats[2].url.pathname);
  const count=fake.calls.length;assert.deepEqual(await syncHonchoLens(env,'owner',[]),{status:'ready',entries:[]});assert.equal(fake.calls.length,count);
 });
});

test('a stale message list after an uncertain write cannot trigger a duplicate source batch',async()=>{
 const fake=fakeHoncho();let attempted=false;
 await withFetch(async(input:any,init:any)=>{
  if(String(input).includes('/messages/list')&&attempted)return Response.json({items:[],total:0,page:1,size:40,pages:0});
  const response=await fake.fetcher(input,init);
  if(String(input).endsWith('/messages')){attempted=true;throw Error('lost response');}
  return response;
 },async()=>{
  assert.equal((await syncHonchoLens(env,'owner',sources)).status,'unavailable');
  assert.equal((await syncHonchoLens(env,'owner',sources)).status,'pending');
  assert.equal(fake.calls.filter(c=>c.body?.messages).length,1);
 });
});

test('unknown, stale, mixed, and overlong citations cannot become accepted source references',async()=>{
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[
  {kind:'need',text:'Unknown',sourceIds:['invented-source']},
  {kind:'offer',text:'Mixed',sourceIds:[messages[0].metadata.source_ref,'invented-source']},
  {kind:'focus',text:'x'.repeat(241),sourceIds:[messages[0].metadata.source_ref]},
  {kind:'focus',text:'Building agent memory tools',sourceIds:[messages[0].metadata.source_ref]},
 ]}));
 await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]}));
});

test('citations require Honcho evidence from the same session and owner peer',async()=>{
 const fake=fakeHoncho();await withFetch(async(input:any,init:any)=>{const response=await fake.fetcher(input,init);if(String(input).endsWith('/chat')){const value=await response.json();value.evidence.messages[0].peer_id='another-peer';return Response.json(value);}return response;},async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'ready',entries:[]});
 });
});

test('invalid or excessive input fails before any private data leaves the service',async()=>{
 await withFetch(()=>assert.fail('Invalid input must not send data'),async()=>{
  for(const input of [[{...sources[0],observedAt:'yesterday'}],[{...sources[0],text:'x'.repeat(4001)}],Array.from({length:41},(_,i)=>({...sources[0],id:String(i)})),[sources[0],sources[0]]])
   assert.equal((await syncHonchoLens(env,'owner',input)).status,'invalid');
  assert.equal((await syncHonchoLens(env,'',sources)).status,'invalid');
 });
});

test('HTTP failures and redirects are explicit and never retried',async()=>{
 for(const status of [302,401,429,500]){let calls=0;await withFetch(async()=>{calls++;return new Response('upstream error',{status});},async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'unavailable',entries:[]});assert.equal(calls,1);
 });}
});

test('oversized and malformed responses fail closed while a pending model remains pending',async()=>{
 const fake=fakeHoncho();for(const response of [()=>new Response('x'.repeat(256*1024)),()=>Response.json({content:'not json'}),()=>Response.json({content:null})]){
  await withFetch(async(input:any,init:any)=>String(input).endsWith('/chat')?response():fake.fetcher(input,init),async()=>{
   const result=await syncHonchoLens(env,'owner',sources);assert.equal(result.status,response().headers.get('content-type')==='application/json'&&(await response().json()).content===null?'pending':'invalid');assert.deepEqual(result.entries,[]);
  });
 }
});

test('abort stops subsequent writes and queries',async()=>{
 const controller=new AbortController(),fake=fakeHoncho();await withFetch(async(input:any,init:any)=>{const response=await fake.fetcher(input,init);controller.abort();return response;},async()=>{
  assert.equal((await syncHonchoLens(env,'owner',sources,{signal:controller.signal})).status,'unavailable');assert.equal(fake.calls.length,1);
 });
});

test('delete removes only this owner dedicated sessions before requesting asynchronous workspace deletion',async()=>{
 const calls:Call[]=[];await withFetch(async(input:any,init:RequestInit={})=>{
  const url=new URL(String(input)),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({url,init,body});
  if(url.pathname.endsWith('/sessions/list'))return Response.json({items:[{id:'snapshot-a',workspace_id:url.pathname.split('/')[3],is_active:true}],total:1,page:1,size:10,pages:1});
  return new Response(null,{status:202});
 },async()=>{
  assert.deepEqual(await deleteHonchoLens(env,'owner@example.com'),{status:'deleting'});
  assert.equal(calls.length,3);assert.equal(calls[1].init.method,'DELETE');assert.ok(calls[1].url.pathname.endsWith('/sessions/snapshot-a'));
  assert.equal(calls[2].init.method,'DELETE');assert.ok(!calls[2].url.pathname.includes('/sessions'));assert.ok(!JSON.stringify(calls).includes('owner@example.com'));
 });
});

test('deletion reports success only after confirmed absence and keeps failed cleanup retryable',async()=>{
 for(const [http,status] of [[404,'deleted'],[401,'unavailable'],[409,'deleting']] as const){await withFetch(async()=>new Response(null,{status:http}),async()=>assert.deepEqual(await deleteHonchoLens(env,'owner'),{status}));}
});
