import test from 'node:test';
import assert from 'node:assert/strict';
import {syncHonchoLens,deleteHonchoLens,honchoConfigured,type HonchoLensSource} from '../src/honcho-lens';

const env={HONCHO_API_KEY:'test-key',TOKEN_SECRET:'test-secret'};
const sources=[{id:'note-1',text:'I am building agent memory tools.',observedAt:'2026-10-18T12:00:00.000Z'}];
type Call={url:URL;init:RequestInit;body:any};
const quotedSource=(message:any)=>({sourceId:message.metadata.source_ref,quote:JSON.parse(message.content).text});
const meetingSources:HonchoLensSource[]=[
 {id:'meeting-source-a',text:'Discussed retrieval evaluation methods for legal research tools.',observedAt:sources[0].observedAt,attribution:'meeting',meetingId:'private-meeting-alpha'},
 {id:'meeting-source-b',text:'Reviewed retrieval evaluation practices for document search teams.',observedAt:sources[0].observedAt,attribution:'meeting',meetingId:'private-meeting-beta'},
];
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
   const content=answer?answer(messages):{entries:[{kind:'focus',text:'Building agent memory tools',sources:[quotedSource(messages[0])]}]};
   // The deployed API currently returns content only, ignoring response_format/include_evidence.
   return Response.json({content:JSON.stringify(content)});
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
  assert.ok(chat.body.query.includes(JSON.stringify(chat.body.response_format)),'Schema must be in the query when the deployment ignores response_format');
  assert.match(chat.body.query,/complete exact.*text/i);
  assert.deepEqual(chat.body.filters,{session_id:chat.body.session_id});
  assert.ok(!JSON.stringify(fake.calls.map(c=>({url:c.url.href,body:c.body}))).includes('owner@example.com'));
  assert.equal(fake.calls.find(c=>c.url.pathname.endsWith('/sessions'))!.body.configuration.peer_card.use,false);
});
});

test('current evidence can yield a proposal before asynchronous recall has any messages',async()=>{
 const fake=fakeHoncho(),explicit=[{id:'private-owner-note',text:'I source early-stage startups and lead technical diligence, focusing on agents, context, and memory.',observedAt:sources[0].observedAt}];
 await withFetch(async(input:any,init:any)=>{
  if(!String(input).endsWith('/chat'))return fake.fetcher(input,init);
  const query=JSON.parse(init.body).query,marker='\nCURRENT_SOURCE_MESSAGES_JSON:\n',offset=query.indexOf(marker);
  const supplied=offset<0?[]:JSON.parse(query.slice(offset+marker.length));
  const original=supplied.find((message:any)=>message.attribution==='OWNER'&&message.text===explicit[0].text);
  // No recalled messages or conclusions are available: only the supplied query data.
  return Response.json({content:JSON.stringify({entries:original?[{kind:'focus',text:'Sourcing early-stage startups and leading technical diligence on agents, context, and memory',sources:[{sourceId:original.sourceId,quote:original.text}]}]:[]})});
 },async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',explicit),{status:'ready',entries:[{kind:'focus',text:'Sourcing early-stage startups and leading technical diligence on agents, context, and memory',sourceIds:['private-owner-note']}]});
 });
});

test('inline evidence stays within query limits and prioritizes recent owner statements and distinct meetings without clipping',async()=>{
 const fake=fakeHoncho();fake.setAnswer(()=>({entries:[]}));
 const bounded:HonchoLensSource[]=[
  {...sources[0],id:'old-owner',observedAt:'2026-10-01T12:00:00.000Z'},
  {...sources[0],id:'new-owner',text:'I need design partners for a retrieval evaluation tool.',observedAt:'2026-10-19T12:00:00.000Z'},
  ...Array.from({length:38},(_,index)=>({id:'meeting-'+String(index).padStart(2,'0'),text:'Discussed retrieval evaluation: '+String(index)+' '+('x'.repeat(800)),observedAt:'2026-10-18T12:00:00.000Z',attribution:'meeting' as const,meetingId:index<2?'same-private-meeting':'private-meeting-'+index})),
 ];
 await withFetch(fake.fetcher,async()=>{
  assert.equal((await syncHonchoLens(env,'owner',bounded)).status,'ready');
  const chat=fake.calls.find(call=>call.url.pathname.endsWith('/chat'))!,query=chat.body.query,marker='\nCURRENT_SOURCE_MESSAGES_JSON:\n';
  assert.ok(query.length<=10000);
  assert.ok(query.includes(marker));
  const inline=JSON.parse(query.slice(query.indexOf(marker)+marker.length));
  assert.ok(inline.length>3&&inline.length<bounded.length);
  assert.equal(inline[0].text,bounded[1].text);assert.equal(inline[1].text,bounded[0].text);
  const meetingGroups=inline.filter((message:any)=>message.attribution==='OWNER_MEETING_ACTIVITY').map((message:any)=>message.meetingGroup);
  assert.equal(new Set(meetingGroups).size,meetingGroups.length,'First passages from distinct meetings take priority over repeated passages');
  const written=fake.calls.find(call=>call.body?.messages)!.body.messages.map((message:any)=>JSON.parse(message.content));
  for(const message of inline)assert.deepEqual(message,written.find((original:any)=>original.sourceId===message.sourceId));
  for(const source of bounded){assert.ok(!query.includes(source.id));if(source.meetingId)assert.ok(!query.includes(source.meetingId));}
 });
});

test('projection diagnostics distinguish provider output and accepted output using only counts',async()=>{
 const originalInfo=console.info,logs:string[]=[];console.info=(...args:unknown[])=>logs.push(args.join(' '));
 try{
  const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[
   {kind:'focus',text:'Building agent memory tools',sources:[quotedSource(messages[0])]},
   {kind:'need',text:'Private invalid proposal',sources:[{sourceId:'unknown-private-id',quote:'Private quote'}]},
  ]}));
  await withFetch(fake.fetcher,async()=>assert.equal((await syncHonchoLens(env,'private-owner@example.test',sources)).status,'ready'));
  fake.setAnswer(()=>({entries:[]}));
  await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'private-owner@example.test',sources),{status:'ready',entries:[]}));
  const parsed=logs.map(line=>JSON.parse(line));assert.equal(parsed.length,2);
  assert.equal(parsed[0].event,'honcho_lens_projection');assert.equal(parsed[0].sourceCount,1);assert.equal(parsed[0].statementSourceCount,1);assert.equal(parsed[0].meetingSourceCount,0);
  assert.equal(parsed[0].suppliedSourceCount,1);assert.equal(parsed[0].providerEntries,2);assert.equal(parsed[0].acceptedEntries,1);
  assert.equal(parsed[1].providerEntries,0);assert.equal(parsed[1].acceptedEntries,0);
  for(const log of parsed){assert.ok(log.queryChars>0&&log.queryChars<=10000);for(const [key,value] of Object.entries(log))if(key!=='event')assert.equal(typeof value,'number');}
  for(const privateValue of [env.HONCHO_API_KEY,env.TOKEN_SECRET,sources[0].id,sources[0].text,'private-owner@example.test','Private invalid proposal','unknown-private-id','Private quote','https://','snapshot_'])assert.ok(!logs.join('\n').includes(privateValue));
 }finally{console.info=originalInfo;}
});

test('invalid chat responses report fixed parser codes without response data',async()=>{
 const originalWarn=console.warn,warnings:string[]=[];console.warn=(...args:unknown[])=>warnings.push(args.join(' '));
 try{
  for(const [response,errorCode] of [
   [()=>Response.json({private:'private-response-value'}),'invalid_response_shape'],
   [()=>Response.json({content:{entries:[]}}),'invalid_response_shape'],
   [()=>Response.json({content:'Private model text {truncated'}),'invalid_projection'],
   [()=>Response.json({content:JSON.stringify({private:'private-response-value'})}),'invalid_projection_shape'],
   [()=>Response.json({content:JSON.stringify({entries:[null]})}),'invalid_entries'],
   [()=>new Response('Private non-JSON response'),'invalid_response_body'],
  ] as const){
   const fake=fakeHoncho();await withFetch(async(input:any,init:any)=>String(input).endsWith('/chat')?response():fake.fetcher(input,init),async()=>assert.equal((await syncHonchoLens(env,'owner',sources)).status,'invalid'));
   const log=JSON.parse(warnings.at(-1)!);assert.equal(log.stage,'chat');assert.equal(log.kind,'invalid');assert.equal(log.errorCode,errorCode);
  }
  assert.ok(!warnings.join('\n').includes('private-response-value'));assert.ok(!warnings.join('\n').includes('Private model text'));assert.ok(!warnings.join('\n').includes('Private non-JSON response'));
 }finally{console.warn=originalWarn;}
});

test('projection rejection counts separate entry shape, source identity, exact quotes and meeting attribution',async()=>{
 const originalInfo=console.info,logs:string[]=[];console.info=(...args:unknown[])=>logs.push(args.join(' '));
 try{
  const fake=fakeHoncho();fake.setAnswer(messages=>{
   const own=messages.find((message:any)=>JSON.parse(message.content).attribution==='OWNER'),meeting=messages.find((message:any)=>JSON.parse(message.content).attribution==='OWNER_MEETING_ACTIVITY');
   return {entries:[
    {kind:'focus',text:'Building agent memory tools',sources:[quotedSource(own)]},
    null,
    {kind:'focus',text:'Private unknown source',sources:[{sourceId:'private-unknown-source',quote:sources[0].text}]},
    {kind:'focus',text:'Private mismatched quote',sources:[{...quotedSource(own),quote:'private-mismatched-quote'}]},
    {kind:'need',text:'Private misattributed need',sources:[quotedSource(meeting)]},
   ]};
  });
  await withFetch(fake.fetcher,async()=>assert.equal((await syncHonchoLens(env,'owner',[...sources,...meetingSources])).status,'ready'));
  const log=JSON.parse(logs.at(-1)!);assert.equal(log.providerEntries,5);assert.equal(log.acceptedEntries,1);
  assert.equal(log.rejectedShape,1);assert.equal(log.rejectedSource,1);assert.equal(log.rejectedQuote,1);assert.equal(log.rejectedMeeting,1);
  for(const privateValue of ['private-unknown-source','private-mismatched-quote','Private misattributed need',sources[0].text])assert.ok(!logs.join('\n').includes(privateValue));
 }finally{console.info=originalInfo;}
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

test('mixed and overlong entries are excluded while a separately valid entry can be reviewed',async()=>{
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[
  {kind:'offer',text:'Mixed',sources:[quotedSource(messages[0]),{sourceId:'invented-source',quote:sources[0].text}]},
  {kind:'focus',text:'x'.repeat(241),sources:[quotedSource(messages[0])]},
  {kind:'focus',text:'Building agent memory tools',sources:[quotedSource(messages[0])]},
 ]}));
 await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]}));
});

test('content-only deployed response accepts complete exact current quotes including whitespace and escapes',async()=>{
 const fake=fakeHoncho(),exact=[{...sources[0],text:'I am building "agent memory" tools.\nI need a café design partner.  '}];
 await withFetch(fake.fetcher,async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',exact),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]});
 });
});

test('one complete JSON object is accepted with fences or evaluation commentary without misreading quoted braces',async()=>{
 const exact=[{...sources[0],text:'I build parsers for {"objects":["quoted \\\"braces } {\\\""]} and need testing help.'}];
 for(const wrap of [
  (json:string)=>json,
  (json:string)=>'```json\n'+json+'\n```',
  (json:string)=>'EVALUATION:\nThe source states explicit current work.\n\n'+json,
  (json:string)=>'EVALUATION:\nThe source states explicit current work.\n\n```json\n'+json+'\n```',
 ]){
  const fake=fakeHoncho();await withFetch(async(input:any,init:any)=>{
   const response=await fake.fetcher(input,init);if(!String(input).endsWith('/chat'))return response;
   const value=await response.json();value.content=wrap(value.content);return Response.json(value);
  },async()=>assert.deepEqual(await syncHonchoLens(env,'owner',exact),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]}));
 }
});

test('multiple, truncated, malformed, or array-enclosed JSON candidates are rejected without guessing',async()=>{
 for(const wrap of [
  (json:string)=>json+'\n'+json,
  (json:string)=>'EVALUATION:\n{"entries":[]}\nActual result:\n'+json,
  (json:string)=>'{not json}\n'+json,
  (json:string)=>json.slice(0,-1),
  (json:string)=>json+'\n{',
  (json:string)=>'{\n'+json,
  (json:string)=>json.replace('"text":','"text" '),
  (json:string)=>'['+json+']',
 ]){
  const fake=fakeHoncho();await withFetch(async(input:any,init:any)=>{
   const response=await fake.fetcher(input,init);if(!String(input).endsWith('/chat'))return response;
   const value=await response.json();value.content=wrap(value.content);return Response.json(value);
  },async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'invalid',entries:[]}));
 }
});

test('message or conclusion evidence cannot substitute for exact quoted source text',async()=>{
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:[messages[0].metadata.source_ref]}]}));
 await withFetch(async(input:any,init:any)=>{
  const response=await fake.fetcher(input,init);
  if(!String(input).endsWith('/chat'))return response;
  const value=await response.json(),message=[...fake.sessions.values()][0][0];
  value.evidence={messages:[{id:message.id,peer_id:message.peer_id,session_id:message.session_id}],conclusions:[{id:'conclusion-1',session_id:message.session_id,observer_id:message.peer_id,observed_id:message.peer_id,source_ids:[message.id]}]};
  return Response.json(value);
 },async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'invalid',entries:[]}));
});

test('unknown IDs, mismatched, partial, normalized, missing, and empty quotes fail explicitly',async()=>{
 for(const alter of [
  (source:any)=>({...source,sourceId:'unknown-source'}),
  (source:any)=>({...source,quote:'I am building something else.'}),
  (source:any)=>({...source,quote:source.quote.slice(0,-1)}),
  (source:any)=>({...source,quote:source.quote+' '}),
  (source:any)=>({sourceId:source.sourceId}),
  (source:any)=>({...source,quote:''}),
 ]){
  const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Building agent memory tools',sources:[alter(quotedSource(messages[0]))]}]}));
  await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'invalid',entries:[]}));
 }
});

test('quotes from another owner or superseded snapshot cannot be used for current references',async()=>{
 const fake=fakeHoncho();let previous:any;
 fake.setAnswer(messages=>{previous=quotedSource(messages[0]);return {entries:[]};});
 await withFetch(fake.fetcher,async()=>{
  await syncHonchoLens(env,'owner',sources);
  fake.setAnswer(()=>({entries:[{kind:'focus',text:'Building agent memory tools',sources:[previous]}]}));
  assert.deepEqual(await syncHonchoLens(env,'owner',[{...sources[0],text:'I now need a design partner.'}]),{status:'invalid',entries:[]});
  assert.deepEqual(await syncHonchoLens(env,'other-owner',sources),{status:'invalid',entries:[]});
 });
});

test('empty model projections remain distinct from nonempty malformed projections',async()=>{
 const fake=fakeHoncho();await withFetch(fake.fetcher,async()=>{
  fake.setAnswer(()=>({entries:[]}));assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'ready',entries:[]});
  for(const entry of [null,{}, {entry:'focus',label:'Building tools',supporting_ids:['note-1']},{kind:'focus',text:'Building tools',sources:[]}]){
   fake.setAnswer(()=>({entries:[entry]}));assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'invalid',entries:[]});
  }
 });
});

test('invalid or excessive input fails before any private data leaves the service',async()=>{
 await withFetch(()=>assert.fail('Invalid input must not send data'),async()=>{
  for(const input of [[{...sources[0],observedAt:'yesterday'}],[{...sources[0],text:'x'.repeat(4001)}],Array.from({length:41},(_,i)=>({...sources[0],id:String(i)})),[sources[0],sources[0]]])
   assert.equal((await syncHonchoLens(env,'owner',input)).status,'invalid');
  assert.equal((await syncHonchoLens(env,'',sources)).status,'invalid');
 });
});

test('meeting activity supports only recurring conversation focus with two distinct opaque meeting groups',async()=>{
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Exploring conversations about retrieval evaluation',sources:messages.map(quotedSource)}]}));
 await withFetch(fake.fetcher,async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',meetingSources),{status:'ready',entries:[{kind:'focus',text:'Exploring conversations about retrieval evaluation',sourceIds:meetingSources.map(source=>source.id)}]});
  const sent=fake.calls.find(call=>call.body?.messages)!.body.messages,content=sent.map((message:any)=>JSON.parse(message.content));
  assert.ok(content.every((message:any)=>message.attribution==='OWNER_MEETING_ACTIVITY'));assert.ok(sent.every((message:any)=>message.metadata.attribution==='OWNER_MEETING_ACTIVITY'));assert.equal(new Set(content.map((message:any)=>message.meetingGroup)).size,2);
  for(const source of meetingSources)assert.ok(!JSON.stringify(fake.calls).includes(source.meetingId!));
  const query=fake.calls.find(call=>call.url.pathname.endsWith('/chat'))!.body.query;assert.match(query,/attendance does not establish project ownership/);assert.match(query,/at least two distinct meetingGroup/);
 });
});

test('multiple passages and repeated citations from one meeting do not establish recurring focus',async()=>{
 for(const sameMeeting of [[meetingSources[0]],[meetingSources[0],{...meetingSources[1],meetingId:meetingSources[0].meetingId}]]){
  const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Exploring conversations about retrieval evaluation',sources:[...messages.map(quotedSource),quotedSource(messages[0])]}]}));
  await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',sameMeeting),{status:'invalid',entries:[]}));
 }
});

test('meeting references cannot establish needs, offers, ownership claims, or mixed-source capabilities',async()=>{
 for(const [kind,text] of [
  ['need','Needs design partners for retrieval evaluation'],['offer','Can help with retrieval evaluation'],['focus','Building retrieval evaluation tools'],
  ['focus','Exploring conversations about my retrieval product'],['focus','Exploring conversations about retrieval. I build tools'],
 ]){
  const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind,text,sources:messages.map(quotedSource)}]}));
  await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',[...meetingSources,...sources]),{status:'invalid',entries:[]}));
 }
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[
  {kind:'need',text:'Needs evaluation partners',sources:messages.map(quotedSource)},
  {kind:'focus',text:'Building agent memory tools',sources:messages.filter((message:any)=>JSON.parse(message.content).attribution==='OWNER').map(quotedSource)},
 ]}));
 await withFetch(fake.fetcher,async()=>assert.deepEqual(await syncHonchoLens(env,'owner',[...meetingSources,...sources]),{status:'ready',entries:[{kind:'focus',text:'Building agent memory tools',sourceIds:['note-1']}]}));
});

test('meeting activity still requires complete exact quotes and accepts the alternate constrained focus wording',async()=>{
 const fake=fakeHoncho();fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Spending time on conversations about document search',sources:messages.map(quotedSource)}]}));
 await withFetch(fake.fetcher,async()=>{
  assert.equal((await syncHonchoLens(env,'owner',meetingSources)).status,'ready');
  fake.setAnswer(messages=>({entries:[{kind:'focus',text:'Exploring conversations about document search',sources:messages.map((message:any)=>({...quotedSource(message),quote:quotedSource(message).quote.slice(1)}))}]}));
  assert.deepEqual(await syncHonchoLens(env,'owner',meetingSources),{status:'invalid',entries:[]});
 });
});

test('meeting attribution and owner identity isolate source snapshots and meeting group identifiers',async()=>{
 const fake=fakeHoncho();fake.setAnswer(()=>({entries:[]}));
 await withFetch(fake.fetcher,async()=>{
  await syncHonchoLens(env,'owner',[sources[0]]);await syncHonchoLens(env,'owner',[{...sources[0],attribution:'meeting',meetingId:'private-meeting-alpha'}]);
  await syncHonchoLens(env,'other-owner',[{...sources[0],attribution:'meeting',meetingId:'private-meeting-alpha'}]);
  const chats=fake.calls.filter(call=>call.url.pathname.endsWith('/chat'));assert.notEqual(chats[0].body.session_id,chats[1].body.session_id);
  const created=fake.calls.filter(call=>call.body?.messages).map(call=>JSON.parse(call.body.messages[0].content));assert.equal(created[0].attribution,'OWNER');assert.ok(!('meetingGroup' in created[0]));assert.notEqual(created[1].meetingGroup,created[2].meetingGroup);
 });
});

test('invalid meeting attribution fails before sending private context',async()=>{
 await withFetch(()=>assert.fail('Invalid attribution must not send data'),async()=>{
  for(const source of [{...sources[0],attribution:'meeting'},{...meetingSources[0],meetingId:''},{...sources[0],attribution:'statement',meetingId:'not-a-statement'},{...sources[0],attribution:'guest'}])assert.equal((await syncHonchoLens(env,'owner',[source as any])).status,'invalid');
 });
});

test('HTTP failures and redirects are explicit and never retried',async()=>{
 for(const status of [302,401,429,500]){let calls=0;await withFetch(async()=>{calls++;return new Response('upstream error',{status});},async()=>{
  assert.deepEqual(await syncHonchoLens(env,'owner',sources),{status:'unavailable',entries:[]});assert.equal(calls,1);
 });}
});

test('failure diagnostics distinguish HTTP, timeout, and invalid output without logging private values',async()=>{
 const warnings:unknown[][]=[],originalWarn=console.warn,originalTimeout=AbortSignal.timeout;
 console.warn=(...args:unknown[])=>{warnings.push(args);};
 try{
  await withFetch(async()=>new Response('test-key '+sources[0].text,{status:503}),async()=>{
   assert.equal((await syncHonchoLens(env,'owner@example.com',sources)).status,'unavailable');
  });
  AbortSignal.timeout=(milliseconds:number)=>milliseconds===15000?AbortSignal.abort(new DOMException('test-key '+sources[0].text,'TimeoutError')):originalTimeout(milliseconds);
  await withFetch(async(_input:any,init:any)=>{throw init.signal.reason;},async()=>{
   assert.equal((await syncHonchoLens(env,'owner@example.com',sources)).status,'unavailable');
  });
  AbortSignal.timeout=originalTimeout;
  const fake=fakeHoncho();fake.setAnswer(()=>({entries:[{kind:'focus',text:sources[0].text,sources:[]}]}));
  await withFetch(fake.fetcher,async()=>assert.equal((await syncHonchoLens(env,'owner@example.com',sources)).status,'invalid'));
 }finally{console.warn=originalWarn;AbortSignal.timeout=originalTimeout;}
 assert.equal(warnings.length,3);
 const diagnostics=warnings.map(args=>{assert.equal(args.length,1);assert.equal(typeof args[0],'string');return JSON.parse(args[0] as string) as Record<string,unknown>;});
 assert.deepEqual(diagnostics.map(({stage,kind,httpStatus})=>({stage,kind,httpStatus})),[
  {stage:'workspace',kind:'http',httpStatus:503},{stage:'workspace',kind:'timeout',httpStatus:undefined},{stage:'chat',kind:'invalid',httpStatus:undefined},
 ]);
 for(const diagnostic of diagnostics){
  assert.equal(diagnostic.event,'honcho_lens_failure');assert.equal(diagnostic.sourceCount,1);
  assert.ok(typeof diagnostic.elapsedMs==='number'&&diagnostic.elapsedMs>=0);
  assert.ok(Object.keys(diagnostic).every(key=>['event','stage','elapsedMs','sourceCount','kind','httpStatus','errorCode'].includes(key)));
 }
 const serialized=JSON.stringify(warnings);
 for(const privateValue of [env.HONCHO_API_KEY,env.TOKEN_SECRET,sources[0].text,sources[0].id,'owner@example.com','https://','snapshot_'])assert.ok(!serialized.includes(privateValue));
 assert.doesNotMatch(serialized,/lens_[A-Za-z0-9_-]{20,}/);
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
  if(url.pathname==='/v3/workspaces/list')return Response.json({items:[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:1});
  if(url.pathname.endsWith('/sessions/list'))return Response.json({items:[{id:'snapshot-a',workspace_id:url.pathname.split('/')[3],is_active:true}],total:1,page:1,size:10,pages:1});
  return new Response(null,{status:202});
 },async()=>{
  assert.deepEqual(await deleteHonchoLens(env,'owner@example.com'),{status:'deleting'});
  assert.equal(calls.length,4);assert.equal(calls[0].url.pathname,'/v3/workspaces/list');assert.equal(calls[0].url.search,'?page=1&size=1');
  assert.deepEqual(calls[0].body,{filters:{id:calls[1].url.pathname.split('/')[3]}});
  assert.equal(calls[2].init.method,'DELETE');assert.ok(calls[2].url.pathname.endsWith('/sessions/snapshot-a'));
  assert.equal(calls[3].init.method,'DELETE');assert.ok(!calls[3].url.pathname.includes('/sessions'));assert.ok(!JSON.stringify(calls).includes('owner@example.com'));
});
});

test('statement proposals keep the individual as actor when an employer appears in the same source',async()=>{
 const fake=fakeHoncho(),individual=[{id:'individual-owner-note',text:'I am on the investment team at Example Ventures. I am also building tools for sourcing startups and technical diligence.',observedAt:sources[0].observedAt}];
 fake.setAnswer(messages=>({entries:[{kind:'focus',text:'I am building tools for startup sourcing and technical diligence',sources:[quotedSource(messages[0])]}]}));
 await withFetch(fake.fetcher,async()=>{
  const result=await syncHonchoLens(env,'owner',individual);
  assert.deepEqual(result,{status:'ready',entries:[{kind:'focus',text:'I am building tools for startup sourcing and technical diligence',sourceIds:['individual-owner-note']}]});
  const query=fake.calls.find(call=>call.url.pathname.endsWith('/chat'))!.body.query;
  assert.match(query,/OWNER is one individual, not their employer/);
  assert.match(query,/OWNER-statement entries in first person singular/);
  assert.match(query,/Never make the employer or another organization the actor/);
  assert.match(query,/Do not use we or our/);
  assert.match(query,/Meeting-derived focus keeps the required conversation wording/);
 });
});

test('cleanup diagnostics expose stage, counts and HTTP status without logging private identifiers or contents',async()=>{
 const originalInfo=console.info,logs:string[]=[];console.info=(...args:unknown[])=>logs.push(args.join(' '));
 let present=true;
 try{
  await withFetch(async(input:any,init:any)=>{
   const url=new URL(String(input)),body=init.body?JSON.parse(init.body):undefined;
   if(url.pathname==='/v3/workspaces/list')return Response.json({items:present?[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}]:[],total:present?1:0});
   if(url.pathname.endsWith('/sessions/list'))return Response.json({items:[{id:'private-snapshot-id',workspace_id:url.pathname.split('/')[3],is_active:true}],total:1});
   return new Response('Private deletion payload '+env.HONCHO_API_KEY,{status:202});
  },async()=>{
   assert.deepEqual(await deleteHonchoLens(env,'private-owner@example.test'),{status:'deleting'});
   const accepted=logs.map(line=>JSON.parse(line));
   assert.deepEqual(accepted.map(log=>log.stage),['input','delete/list','delete/session_list','delete/session','delete/workspace']);
   assert.equal(accepted[1].workspaceExists,1);assert.equal(accepted[2].sessionTotal,1);assert.equal(accepted[2].activeSessionCount,1);assert.equal(accepted[2].inactiveSessionCount,0);
   assert.equal(accepted.at(-1).status,'deleting');assert.equal(accepted.at(-1).acceptedDeleteCount,2);assert.equal(accepted.at(-1).deletedCount,0);assert.equal(accepted.at(-1).httpStatus,202);
   present=false;
   assert.deepEqual(await deleteHonchoLens(env,'private-owner@example.test'),{status:'deleted'});
  });
  const parsed=logs.map(line=>JSON.parse(line)),last=parsed.at(-1);
  assert.equal(last.event,'honcho_lens_cleanup');assert.equal(last.status,'deleted');assert.equal(last.workspaceExists,0);assert.equal(last.httpStatus,200);
  for(const log of parsed)for(const [key,value] of Object.entries(log))if(!['event','stage','status'].includes(key))assert.equal(typeof value,'number');
  for(const privateValue of [env.HONCHO_API_KEY,env.TOKEN_SECRET,'private-owner@example.test','private-snapshot-id','Private deletion payload','https://','snapshot_'])assert.ok(!logs.join('\n').includes(privateValue));
 }finally{console.info=originalInfo;}
});

test('cleanup diagnostics distinguish conflicts from provider failure and record partial batch progress',async()=>{
 const originalInfo=console.info,logs:string[]=[];console.info=(...args:unknown[])=>logs.push(args.join(' '));
 try{
  for(const httpStatus of [409,503]){
   await withFetch(async(input:any,init:any)=>{
    const url=new URL(String(input)),body=init.body?JSON.parse(init.body):undefined;
    if(url.pathname==='/v3/workspaces/list')return Response.json({items:[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:1});
    if(url.pathname.endsWith('/sessions/list'))return Response.json({items:[],total:0});
    return new Response('Do not log this response',{status:httpStatus});
   },async()=>assert.equal((await deleteHonchoLens(env,'owner')).status,httpStatus===409?'deleting':'unavailable'));
   const log=JSON.parse(logs.at(-1)!);assert.equal(log.stage,'delete/workspace');assert.equal(log.httpStatus,httpStatus);assert.equal(log.status,httpStatus===409?'deleting':'unavailable');assert.equal(log.sessionTotal,0);
  }
  await withFetch(async(input:any,init:any)=>{
   const url=new URL(String(input)),body=init.body?JSON.parse(init.body):undefined;
   if(url.pathname==='/v3/workspaces/list')return Response.json({items:[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:1});
   if(url.pathname.endsWith('/sessions/list'))return Response.json({items:Array.from({length:10},(_,index)=>({id:'session-'+index,workspace_id:url.pathname.split('/')[3],is_active:index!==0})),total:11});
   assert.ok(url.pathname.includes('/sessions/'),'More sessions must be handled before workspace deletion');
   return new Response(null,{status:202});
  },async()=>assert.equal((await deleteHonchoLens(env,'owner')).status,'deleting'));
  const last=JSON.parse(logs.at(-1)!);assert.equal(last.sessionTotal,11);assert.equal(last.acceptedDeleteCount,10);assert.equal(last.deletedCount,0);assert.equal(last.activeSessionCount,9);assert.equal(last.inactiveSessionCount,1);
 }finally{console.info=originalInfo;}
});

test('deletion reports success only after confirmed absence and keeps failed cleanup retryable',async()=>{
 for(const [http,status] of [[404,'deleted'],[401,'unavailable'],[409,'deleting']] as const){await withFetch(async(input:any,init:any)=>{
  if(String(input).includes('/workspaces/list'))return Response.json({items:[{id:JSON.parse(init.body).filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:1});
  if(String(input).includes('/sessions/list'))return Response.json({items:[],total:0});
  return new Response(null,{status:http});
 },async()=>assert.deepEqual(await deleteHonchoLens(env,'owner'),{status}));}
});

test('a missing workspace is confirmed by filtered read without repeating DELETE against an empty session list',async()=>{
 let present=true,deletes=0,sessionLists=0;const calls:Call[]=[];
 await withFetch(async(input:any,init:any)=>{
  const url=new URL(String(input)),body=init.body?JSON.parse(init.body):undefined;calls.push({url,init,body});
  if(url.pathname==='/v3/workspaces/list')return Response.json({items:present?[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}]:[],total:present?1:0});
  if(url.pathname.endsWith('/sessions/list')){sessionLists++;return Response.json({items:[],total:0});}
  if(init.method==='DELETE'){deletes++;const status=present?202:500;present=false;return new Response(null,{status});}
  throw Error('Unexpected request');
 },async()=>{
  assert.deepEqual(await deleteHonchoLens(env,'owner'),{status:'deleting'});
  assert.deepEqual(await deleteHonchoLens(env,'owner'),{status:'deleted'});
  assert.equal(deletes,1);assert.equal(sessionLists,1);assert.equal(calls.length,4);
  assert.ok(!calls.some(call=>call.url.pathname==='/v3/workspaces'),'Cleanup must not get-or-create a workspace');
 });
});

test('cleanup rejects mismatched or malformed workspace identity and purpose before deleting',async()=>{
 for(const corrupt of [
  (workspace:any)=>({...workspace,id:'another-owner-workspace'}),
  (workspace:any)=>({...workspace,metadata:{purpose:'another-purpose'}}),
  (workspace:any)=>({...workspace,metadata:undefined}),
 ]){
  const calls:Call[]=[];await withFetch(async(input:any,init:any)=>{
   const url=new URL(String(input)),body=init.body?JSON.parse(init.body):undefined;calls.push({url,init,body});
   return Response.json({items:[corrupt({id:body?.filters?.id,metadata:{purpose:'private-owner-lens-v1'}})],total:1});
  },async()=>{
   assert.deepEqual(await deleteHonchoLens(env,'owner'),{status:'unavailable'});
   assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/v3/workspaces/list');assert.equal(calls[0].init.method,'POST');
  });
 }
 for(const page of [{items:[],total:1},{items:[],total:-1},{items:[],total:'0'},{items:[]},{}]){
  let calls=0;await withFetch(async()=>{calls++;return Response.json(page);},async()=>{
   assert.deepEqual(await deleteHonchoLens(env,'owner'),{status:'unavailable'});assert.equal(calls,1);
  });
 }
});

test('a 404 from either list endpoint does not itself confirm workspace deletion',async()=>{
 for(const missingEndpoint of ['workspaces','sessions']){
  await withFetch(async(input:any,init:any)=>{
   if(missingEndpoint==='sessions'&&String(input).includes('/workspaces/list'))return Response.json({items:[{id:JSON.parse(init.body).filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:1});
   return new Response(null,{status:404});
  },async()=>assert.deepEqual(await deleteHonchoLens(env,'owner'),{status:'unavailable'}));
 }
});
