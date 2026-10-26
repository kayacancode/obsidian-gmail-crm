import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {peopleMemoryAgentRoute,peopleMemoryOwnerRoute} from '../src/people-memory-agent';
import {fixture as mailFixture} from './person-context.test';
import worker from '../src/index';

const owner='owner@example.test',origin='https://people.test';
const capture={email:'person@example.test',name:'Person',text:'We discussed clinic design partners.',sourceKind:'voice_transcript',sourceId:'meeting-123'};
function fixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const db:any={prepare(sql:string){let args:any[]=[];const statement:any={bind(...values:any[]){args=values;return statement;},async run(){return {success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return statement;}};
 const calls:any[]=[];const service:any={bindOwner:async(actor:string)=>{assert.equal(actor,owner);},relationshipMemoryForEmail:async(email:string)=>{calls.push({action:'lookup',email});return {personId:'person-1',entries:[],revision:null};},captureRelationshipMemory:async(input:any)=>{calls.push({action:'capture',input});return {personId:'person-1',entryId:'entry-1',duplicate:false,memory:{entries:[]}};},saveRelationshipMemory:async()=>{throw Error('not_used');}};
 const env:any={DB:db,MAIL:{getByName(key:string){assert.equal(key,owner);return service;}}};
 const management=(path='',input?:unknown,actor=owner,custom:Record<string,string>={})=>peopleMemoryOwnerRoute(new Request(origin+'/api/people/integrations'+path,{method:input===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...custom},...(input===undefined?{}:{body:JSON.stringify(input)})}),env,actor);
 const request=(path:string,token?:string,input?:unknown,custom:Record<string,string>={})=>peopleMemoryAgentRoute(new Request(origin+path,{method:input===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...custom},...(input===undefined?{}:{body:JSON.stringify(input)})}),env);
 const mint=async(scopes=['people:read','people:write'])=>{const response=await management('',{name:'Test agent',scopes});assert.equal(response.status,201);return response.json() as Promise<any>;};
 return {sqlite,service,env,calls,management,request,mint};
}

test('People credentials bind the owner, hide stored secrets, and expire or revoke independently',async t=>{
 const f=fixture(t),key=await f.mint();assert.match(key.token,/^people_[A-Za-z0-9_-]{43}$/);
 const row:any=f.sqlite.prepare('SELECT * FROM people_memory_credentials').get();assert.equal(row.owner,owner);assert.equal(row.token_hash.length,64);assert.ok(!JSON.stringify(row).includes(key.token));
 const listed=await f.management(),body=await listed.text();assert.ok(!body.includes(key.token));assert.ok(!body.includes(row.token_hash));assert.equal(JSON.parse(body).tokens[0].id,key.credential.id);
 assert.equal((await f.request('/api/people-agent/lookup?email=person%40example.test',key.token)).status,200);
 assert.equal((await f.management('/'+key.credential.id+'/revoke',{},'someone@example.test')).status,404);
 assert.equal((await f.management('/'+key.credential.id+'/revoke',{})).status,200);
 assert.equal((await f.request('/api/people-agent/lookup?email=person%40example.test',key.token)).status,401);
 const expired=await f.mint();f.sqlite.prepare('UPDATE people_memory_credentials SET expires_at=? WHERE id=?').run(Date.now()-1,expired.credential.id);
 assert.equal((await f.request('/api/people-agent/lookup?email=person%40example.test',expired.token)).status,401);
});
test('People token creation requires a session owner, same origin and exact supported scopes',async t=>{
 const f=fixture(t);
 for(const scopes of [[],['scheduling:write'],['people:read','people:read']])assert.equal((await f.management('',{name:'Agent',scopes})).status,400);
 assert.equal((await f.management('',{name:'Agent',scopes:['people:write'],owner:'foreign@example.test'})).status,400);
 assert.equal((await f.management('',{name:'Agent',scopes:['people:read']},owner,{origin:'https://other.test'})).status,403);
 assert.equal((await f.management('',{name:'Agent',scopes:['people:read']},owner,{origin:''})).status,403);
 assert.equal((await f.management('',undefined,'')).status,401);
});
test('People API scopes and credentials prevent cookie, scheduling-token and forged-owner writes',async t=>{
 const f=fixture(t),read=await f.mint(['people:read']),write=await f.mint(['people:write']);
 assert.equal((await f.request('/api/people-agent/capture',read.token,capture)).status,403);
 assert.equal((await f.request('/api/people-agent/lookup?email=person%40example.test',write.token)).status,403);
 assert.equal((await f.request('/api/people-agent/capture',undefined,capture,{cookie:'__Host-people-session=forged'})).status,401);
 assert.equal((await f.request('/api/people-agent/capture','sched_'+'a'.repeat(43),capture)).status,401);
 for(const fields of [{owner:'other@example.test'},{visibility:'shared'},{sourceKind:'gmail'},{sourceId:''},{sourceId:'x'.repeat(201)},{email:'not-an-email'},{text:''},{text:'x'.repeat(2001)}])assert.equal((await f.request('/api/people-agent/capture',write.token,{...capture,...fields})).status,400);
 assert.equal(f.calls.length,0);
 assert.equal((await f.request('/api/people-agent/capture',write.token,capture)).status,200);
 assert.deepEqual(f.calls,[{action:'capture',input:capture}]);
});
test('People lookup is exact and rejects ambiguous body/query authority',async t=>{
 const f=fixture(t),key=await f.mint();
 for(const path of ['/lookup?email=person%40example.test&owner=other','/lookup?email=a%40b.test&email=c%40d.test','/lookup?name=Person'])assert.equal((await f.request('/api/people-agent'+path,key.token)).status,400);
 const response=await f.request('/api/people-agent/lookup?email=Person%40Example.Test',key.token);assert.equal(response.status,200);assert.equal(f.calls[0].email,'person@example.test');
});
test('People ingestion preserves retry identity, safe conflicts and private provider errors',async t=>{
 const f=fixture(t),key=await f.mint();
 f.service.captureRelationshipMemory=async(input:any)=>{assert.equal(input.sourceId,'meeting-123');return {personId:'person-1',entryId:'entry-1',duplicate:true,memory:{entries:[]}};};
 const retry=await f.request('/api/people-agent/capture',key.token,capture);assert.equal(retry.status,200);assert.equal((await retry.json() as any).duplicate,true);
 for(const [message,status,error] of [['idempotency_conflict',409,'idempotency_conflict'],['relationship_memory_conflict',409,'relationship_memory_conflict'],['private provider body token=secret',503,'people_memory_failed']] as const){f.service.captureRelationshipMemory=async()=>{throw Error(message);};const response=await f.request('/api/people-agent/capture',key.token,capture);assert.equal(response.status,status);assert.deepEqual(await response.json(),{error});}
 assert.equal((await f.request('/api/people-agent/capture',key.token,capture,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.request('/api/people-agent/capture',key.token,capture,{'content-type':'text/plain'})).status,400);
});
test('People saves validate the complete profile, preserve its revision and expose store conflicts safely',async t=>{
 const f=fixture(t),key=await f.mint(),input={personId:'person-1',text:'Current context',revision:null,company:'Clinic',building:'A clinic tool',needs:'Design partners',offers:'Clinical expertise',interests:['clinics'],pointPersonId:null,notBefore:null,relationship:'neutral'};
 const saved:any[]=[];f.service.saveRelationshipMemory=async(value:any)=>{saved.push(value);return {...value,entries:[],updatedAt:123};};
 for(const extra of [{owner:'foreign@example.test'},{entries:[]},{updatedAt:1},{notBefore:'2026-02-30'},{interests:['']},{needs:'secret\u0001text'}])assert.equal((await f.request('/api/people-agent/save',key.token,{...input,...extra})).status,400);
 assert.equal(saved.length,0);
 const success=await f.request('/api/people-agent/save',key.token,input);assert.equal(success.status,200);assert.deepEqual(saved,[input]);
 for(const [message,status] of [['person_context_conflict',409],['capture_conflict',409],['memory_capacity',409]] as const){f.service.saveRelationshipMemory=async()=>{throw Error(message);};const response=await f.request('/api/people-agent/save',key.token,input);assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:message});}
});
test('People MCP advertises only authorized tools and rechecks revocation per request',async t=>{
 const f=fixture(t),key=await f.mint(['people:read']);
 const headers={host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
 const list={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
 const response=await f.request('/api/people-mcp',key.token,list,headers);assert.equal(response.status,200);
 const raw=await response.text(),data=JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);
 assert.deepEqual(data.result.tools.map((tool:any)=>tool.name),['lookup_relationship_memory','get_people_lens','recommend_people','find_people','explain_connection','suggest_connections']);
 await f.management('/'+key.credential.id+'/revoke',{});
 assert.equal((await f.request('/api/people-mcp',key.token,list,headers)).status,401);
});
test('People API persists one entry across retries and isolates identical emails in separate owner stores',async t=>{
 const f=fixture(t),own=await mailFixture(),other=await mailFixture('other@example.test');t.after(()=>{own.db.close();other.db.close();});
 f.env.MAIL={getByName(actor:string){assert.ok([owner,'other@example.test'].includes(actor));return actor===owner?own.service:other.service;}};
 const key=await f.mint(),first=await f.request('/api/people-agent/capture',key.token,capture),stored:any=await first.json();assert.equal(first.status,200);assert.equal(stored.duplicate,false);
 const retry:any=await (await f.request('/api/people-agent/capture',key.token,capture)).json();assert.equal(retry.duplicate,true);assert.equal(retry.entryId,stored.entryId);assert.equal(retry.memory.entries.length,1);
 const changed=await f.request('/api/people-agent/capture',key.token,{...capture,text:'Changed original entry.'});assert.equal(changed.status,409);assert.deepEqual(await changed.json(),{error:'capture_conflict'});
 const read:any=await (await f.request('/api/people-agent/lookup?email=person%40example.test',key.token)).json();assert.equal(read.memory.entries[0].text,capture.text);
 const foreign:any=await (await f.management('',{name:'Other client',scopes:['people:read','people:write']},'other@example.test')).json();
 assert.deepEqual(await (await f.request('/api/people-agent/lookup?email=person%40example.test',foreign.token)).json(),{memory:null});
 const {entries,updatedAt,...edit}=stored.memory;
 assert.equal((await f.request('/api/people-agent/save',foreign.token,{...edit,needs:'Foreign edit'})).status,404);
 const saved=await f.request('/api/people-agent/save',key.token,{...edit,needs:'Clinical design partners'});assert.equal(saved.status,200);
 const stale=await f.request('/api/people-agent/save',key.token,{...edit,needs:'Stale overwrite'});assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'person_context_conflict'});
 const independent:any=await (await f.request('/api/people-agent/capture',foreign.token,{...capture,text:'Other owner observation'})).json();assert.notEqual(independent.personId,stored.personId);
 const unchanged:any=await (await f.request('/api/people-agent/lookup?email=person%40example.test',key.token)).json();assert.equal(unchanged.memory.needs,'Clinical design partners');assert.equal(unchanged.memory.entries[0].text,capture.text);
});
test('People MCP captures through the real store and rejects forged fields or revoked credentials',async t=>{
 const f=fixture(t),own=await mailFixture();t.after(()=>own.db.close());f.env.MAIL=own.env.MAIL;
 const key=await f.mint(),headers={host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
 const call=async(input:unknown)=>{const response=await f.request('/api/people-mcp',key.token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'capture_relationship_context',arguments:input}},headers);assert.equal(response.status,200);const raw=await response.text();return JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);};
 const first=await call(capture);assert.equal(first.result.structuredContent.duplicate,false);
 const retry=await call(capture);assert.equal(retry.result.structuredContent.duplicate,true);assert.equal(retry.result.structuredContent.entryId,first.result.structuredContent.entryId);
 const forged=await call({...capture,owner:'other@example.test'});assert.ok(forged.error||forged.result?.isError);
 assert.equal((await own.service.relationshipMemoryForEmail(capture.email))!.entries.length,1);
});
test('People machine credentials cannot mint browser tokens and never leave for Google verification',async t=>{
 const f=fixture(t),key=await f.mint();f.env.TOKEN_SECRET='test-session-key';
 let external=0;t.mock.method(globalThis,'fetch',async()=>{external++;throw Error('No external requests permitted');});
 for(const path of ['/api/people/integrations','/api/people/context?personId=person-1','/api/graph']){
  const response=await worker.fetch(new Request(origin+path,{headers:{authorization:'Bearer '+key.token}}),f.env);assert.equal(response.status,401);
 }
 assert.equal(external,0);
 const valid=await worker.fetch(new Request(origin+'/api/people-agent/lookup?email=person%40example.test',{headers:{authorization:'Bearer '+key.token}}),f.env);assert.equal(valid.status,200);
});
test('People write-only REST mutations return confirmation metadata without revealing existing private memory',async t=>{
 const f=fixture(t),own=await mailFixture();t.after(()=>own.db.close());f.env.MAIL=own.env.MAIL;
 const seeded=await own.service.captureRelationshipMemory({...capture,sourceKind:'text',text:'Private existing conversation',sourceId:'seed'});
 const {entries,updatedAt,...initial}=seeded.memory;
 await own.service.saveRelationshipMemory({...initial,text:'Private steering note',needs:'Private business need'});
 const write=await f.mint(['people:write']),both=await f.mint();
 const captured=await f.request('/api/people-agent/capture',write.token,capture);assert.equal(captured.status,200);const receipt:any=await captured.json();
 assert.deepEqual(Object.keys(receipt).sort(),['duplicate','entryId','personId','revision','updatedAt']);
 assert.equal(receipt.personId,seeded.personId);assert.equal(receipt.duplicate,false);assert.equal(typeof receipt.revision,'string');assert.equal(typeof receipt.updatedAt,'number');
 assert.ok(!JSON.stringify(receipt).includes('Private'));
 const current=await own.service.getRelationshipMemory(seeded.personId),{entries:currentEntries,updatedAt:currentTime,...edit}=current;
 const saved=await f.request('/api/people-agent/save',write.token,{...edit,offers:'New explicit owner edit'});assert.equal(saved.status,200);const savedReceipt:any=await saved.json();
 assert.deepEqual(Object.keys(savedReceipt).sort(),['personId','revision','updatedAt']);assert.notEqual(savedReceipt.revision,receipt.revision);assert.ok(!JSON.stringify(savedReceipt).includes('Private'));
 const readable:any=await (await f.request('/api/people-agent/capture',both.token,capture)).json();assert.equal(readable.memory.text,'Private steering note');assert.equal(readable.memory.needs,'Private business need');assert.equal(readable.memory.entries.length,2);
 const {entries:laterEntries,updatedAt:laterTime,...laterEdit}=readable.memory;
 const readableSave:any=await (await f.request('/api/people-agent/save',both.token,{...laterEdit,offers:'Another owner edit'})).json();assert.equal(readableSave.text,'Private steering note');assert.equal(readableSave.entries.length,2);
});
test('People write-only MCP capture and save expose only the same confirmation metadata',async t=>{
 const f=fixture(t),own=await mailFixture();t.after(()=>own.db.close());f.env.MAIL=own.env.MAIL;
 const seeded=await own.service.captureRelationshipMemory({...capture,sourceKind:'text',text:'Private prior transcript',sourceId:'seed'}),write=await f.mint(['people:write']);
 const headers={host:'people.test',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
 const call=async(name:string,input:unknown)=>{const response=await f.request('/api/people-mcp',write.token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}},headers);assert.equal(response.status,200);const raw=await response.text();return JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw).result;};
 const captured=await call('capture_relationship_context',capture);assert.deepEqual(Object.keys(captured.structuredContent).sort(),['duplicate','entryId','personId','revision','updatedAt']);assert.deepEqual(JSON.parse(captured.content[0].text),captured.structuredContent);assert.ok(!JSON.stringify(captured).includes('Private prior transcript'));
 const {entries,updatedAt,...edit}=await own.service.getRelationshipMemory(seeded.personId);
 const saved=await call('save_relationship_memory',{...edit,needs:'Explicit edit'});assert.deepEqual(Object.keys(saved.structuredContent).sort(),['personId','revision','updatedAt']);assert.deepEqual(JSON.parse(saved.content[0].text),saved.structuredContent);assert.ok(!JSON.stringify(saved).includes('Private prior transcript'));
});
