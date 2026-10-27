import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {schedulingFixture,input,owner,origin} from './scheduling-api.test';
import {schedulingMachineRoute} from '../src/scheduling-routes';

const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'scheduling-smoke',version:'1.0.0'}}};
const headers={host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
async function rpcResult(response:Response):Promise<any>{
 const text=await response.text();
 if(response.headers.get('content-type')?.includes('text/event-stream')){const messages=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));return messages.find(message=>message.result||message.error);}
 return JSON.parse(text);
}
test('MCP initializes and lists scoped tools with confirmation described as a calendar write',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();
 const init=await f.machineRequest('/mcp',credential.token,initialize,headers);
 assert.equal(init.status,200);assert.equal(init.headers.get('mcp-session-id'),null);assert.equal(init.headers.get('cache-control'),'no-store');
 const welcome=await rpcResult(init);assert.equal(welcome.result.serverInfo.name,'people-scheduling');assert.ok(welcome.result.capabilities.tools);
 const list=await f.machineRequest('/mcp',credential.token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},headers);
 assert.equal(list.status,200);const data=await rpcResult(list);
 assert.deepEqual(data.result.tools.map((v:any)=>v.name).sort(),['add_scheduling_context','confirm_scheduling_time','get_scheduling_request','prepare_scheduling_reply','refresh_scheduling_options']);
 const confirm=data.result.tools.find((v:any)=>v.name==='confirm_scheduling_time');assert.equal(confirm.annotations.readOnlyHint,false);assert.match(confirm.description,/calendar invitation/i);assert.equal(confirm.inputSchema.properties.owner,undefined);assert.equal(confirm.inputSchema.properties.evidenceId,undefined);
 const reader=await f.mint(['scheduling:read']);const filtered=await rpcResult(await f.machineRequest('/mcp',reader.token,{jsonrpc:'2.0',id:3,method:'tools/list',params:{}},headers));
 assert.deepEqual(filtered.result.tools.map((v:any)=>v.name),['get_scheduling_request']);
});
test('MCP accepts actual counterpart context as bounded evidence without granting overrides or new scheduling authority',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();
 const call=async(args:unknown,id=1)=>rpcResult(await f.machineRequest('/mcp',credential.token,{jsonrpc:'2.0',id,method:'tools/call',params:{name:'add_scheduling_context',arguments:args}},headers));
 f.service.addSchedulingContext=async(...args:any[])=>{f.calls.push({method:'addSchedulingContext',args});return {...f.result,needsContext:true,contextQuestion:'What would you like to discuss?',requiresReview:true,offer:null,replyText:'What would you like to discuss?'};};
 const context={requestId:'request-1',context:'We are building a prototype for agent interfaces.',evidenceId:'counterpart-reply-1'};
 const accepted=await call(context);assert.ok(accepted.result,JSON.stringify(accepted));assert.equal(accepted.result.isError,undefined);assert.equal(accepted.result.structuredContent.needsContext,true);assert.equal(accepted.result.structuredContent.offer,null);assert.equal(accepted.result.structuredContent.contextQuestion,'What would you like to discuss?');
 assert.deepEqual(f.calls,[{method:'addSchedulingContext',args:[owner,'request-1',{context:context.context,evidenceId:context.evidenceId}]}]);
 for(const extra of [{owner:'intruder@example.test'},{email:'other@example.test'},{approve:true},{windowStart:'2026-11-01T00:00:00Z'}]){const rejected=await call({...context,...extra});assert.ok(rejected.error||rejected.result?.isError);}
 for(const patch of [{context:' '},{context:'x'.repeat(1501)},{evidenceId:''},{evidenceId:'x'.repeat(501)}]){const rejected=await call({...context,...patch});assert.ok(rejected.error||rejected.result?.isError);}
 assert.equal(f.calls.length,1);
});
test('real MCP tools call the shared scheduling operations with server-derived authority and return structured results',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();
 const call=async(name:string,args:unknown,id=2)=>{const response=await f.machineRequest('/mcp',credential.token,{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}},headers);assert.equal(response.status,200);return rpcResult(response);};
 await f.machineRequest('/mcp',credential.token,initialize,headers);
 const prepared=await call('prepare_scheduling_reply',input);assert.equal(prepared.result.isError,undefined);assert.equal(prepared.result.structuredContent.requestId,'request-1');
 assert.deepEqual(f.calls[0],{method:'prepareScheduling',args:[owner,input,{channel:'owner_api',evidenceId:credential.credential.id}]});
 const read=await call('get_scheduling_request',{requestId:'request-1'},3);assert.equal(read.result.structuredContent.recommendation.summary,'Private recommendation.');
 const refresh=await call('refresh_scheduling_options',{requestId:'request-1'},4);assert.equal(refresh.result.structuredContent.offer.revision,'revision-1');
 const confirmed=await call('confirm_scheduling_time',{requestId:'request-1',revision:'revision-1',slotId:'slot-1'},5);assert.equal(confirmed.result.structuredContent.status,'booked');
 assert.deepEqual(f.calls[3],{method:'confirmScheduling',args:[owner,'request-1',{revision:'revision-1',slotId:'slot-1',evidenceId:credential.credential.id}]});
 const forged=await call('prepare_scheduling_reply',{...input,owner:'intruder@example.test'},6);assert.ok(forged.error||forged.result?.isError);assert.equal(f.calls.length,4);
 const unsupported=await call('prepare_scheduling_reply',{...input,instructions:'Only afternoons.'},8);assert.equal(unsupported.result.isError,true);assert.match(unsupported.result.content[0].text,/invalid_instructions/);assert.equal(f.calls.length,4);
 f.service.getScheduling=async()=>{throw Error('sensitive provider failure');};const failed=await call('get_scheduling_request',{requestId:'request-1'},7);assert.equal(failed.result.isError,true);assert.equal(failed.result.content[0].text,'scheduling_failed');
});
test('MCP transport rechecks authentication on every request, rejects browser origins and does not grant write tools to readers',async t=>{
 const f=schedulingFixture(t),read=await f.mint(['scheduling:read']);
 assert.equal((await f.machineRequest('/mcp',undefined,initialize,headers)).status,401);
 assert.equal((await f.machineRequest('/mcp',read.token,initialize,{...headers,origin:'https://evil.test'})).status,403);
 const deniedResponse=await f.machineRequest('/mcp',read.token,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'confirm_scheduling_time',arguments:{requestId:'request-1',revision:'revision-1',slotId:'slot-1'}}},headers);assert.equal(deniedResponse.status,200);const denied=await rpcResult(deniedResponse);assert.ok(denied.error||denied.result?.isError);assert.equal(f.calls.length,0);
 await f.ownerRequest('/tokens/'+read.credential.id+'/revoke',{});
 assert.equal((await f.machineRequest('/mcp',read.token,{jsonrpc:'2.0',id:3,method:'tools/list',params:{}},headers)).status,401);
 assert.equal((await f.machineRequest('/mcp',read.token,initialize,{...headers,origin})).status,401);
});
test('official MCP client negotiates legacy and modern transport and calls scheduling with a bearer token',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();
 for(const mode of ['legacy',{pin:'2026-07-28'}] as const){
  const client=new Client({name:'scheduling-smoke',version:'1.0.0'},{versionNegotiation:{mode}});
  const transport=new StreamableHTTPClientTransport(new URL(origin+'/api/scheduling/mcp'),{authProvider:{token:async()=>credential.token},requestInit:{headers:{host:'people.test'}},fetch:async(url,init)=>schedulingMachineRoute(new Request(url,init),f.env)});
  await client.connect(transport);try{
   const list=await client.listTools();assert.equal(list.tools.length,5);
   const result=await client.callTool({name:'prepare_scheduling_reply',arguments:input});assert.equal(result.isError,undefined);assert.equal(result.structuredContent?.requestId,'request-1');
  }finally{await client.close();}
 }
 assert.equal(f.calls.length,2);
});
