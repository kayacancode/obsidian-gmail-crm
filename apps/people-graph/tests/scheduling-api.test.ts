import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {schedulingMachineRoute,schedulingOwnerRoute} from '../src/scheduling-routes';
import type {SchedulingResult} from '../src/scheduling-types';
import worker from '../src/index';
import {makeSession,sessionCookie} from '../src/session';

export const owner='owner@example.test',origin='https://people.test';
export const input={email:'guest@example.test',context:'Discuss our project.',idempotencyKey:'test_scheduling_request'};
export function schedulingFixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const db:any={prepare(sql:string){let args:any[]=[];const statement:any={bind(...values:any[]){args=values;return statement;},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return statement;},async batch(statements:any[]){return Promise.all(statements.map(s=>s.run()));}};
 const result:SchedulingResult={requestId:'request-1',status:'pending_approval',timezone:'America/New_York',offer:{revision:'revision-1',expiresAt:Date.now()+60000,slots:[{id:'slot-1',start:'2026-11-02T15:00:00.000Z',end:'2026-11-02T15:30:00.000Z'}]},replyText:'Would this time work?',recommendation:{summary:'Private recommendation.',reasons:[],uncertainties:[]}};
 const calls:Array<{method:string,args:any[]}>=[];
 const service=Object.fromEntries(['prepareScheduling','refreshScheduling','confirmScheduling','getScheduling'].map(method=>[method,async(...args:any[])=>{calls.push({method,args});return {...result,status:method==='confirmScheduling'?'booked':result.status};}]));
 const env:any={DB:db,BOOKING_OWNER_EMAIL:owner,BOOKING:{getByName(key:string){assert.equal(key,owner);return service;}}};
 const ownerRequest=(path:string,value?:unknown,headers:Record<string,string>={},actor=owner)=>schedulingOwnerRoute(new Request(origin+'/api/booking/scheduling'+path,{method:value===undefined?'GET':'POST',headers:{...(value===undefined?{}:{origin,'content-type':'application/json'}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})}),env,actor);
 const machineRequest=(path:string,token?:string,value?:unknown,headers:Record<string,string>={})=>schedulingMachineRoute(new Request(origin+'/api/scheduling'+path,{method:value===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),...(value===undefined?{}:{'content-type':'application/json'}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})}),env);
 async function mint(scopes=['scheduling:read','scheduling:write']){const response=await ownerRequest('/tokens',{name:'Fixture client',scopes});assert.equal(response.status,201);return response.json() as Promise<any>;}
 return {sqlite,env,service,calls,result,ownerRequest,machineRequest,mint};
}

test('scheduling credentials are owner-bound, hashed at rest, listed without secrets and expire after 90 days',async t=>{
 const f=schedulingFixture(t),minted=await f.mint();
 assert.match(minted.token,/^sched_[A-Za-z0-9_-]{43}$/);
 assert.equal(minted.credential.expiresAt-minted.credential.createdAt,90*86400000);
 const row:any=f.sqlite.prepare('SELECT * FROM scheduling_credentials').get();
 assert.equal(row.owner,owner);assert.equal(row.token_hash.length,64);assert.ok(!JSON.stringify(row).includes(minted.token));
 const listed=await f.ownerRequest('/tokens');assert.equal(listed.status,200);const text=await listed.text();assert.ok(!text.includes(minted.token));assert.ok(!text.includes(row.token_hash));assert.equal(JSON.parse(text).tokens[0].id,minted.credential.id);
 assert.equal((await f.machineRequest('/requests/request-1',minted.token)).status,200);
 f.sqlite.prepare('UPDATE scheduling_credentials SET expires_at=?').run(Date.now()-1);
 assert.equal((await f.machineRequest('/requests/request-1',minted.token)).status,401);
});
test('scheduling token management requires the configured owner and same-origin writes',async t=>{
 const f=schedulingFixture(t);
 assert.equal((await f.ownerRequest('/tokens',{name:'X',scopes:['scheduling:write']},{origin:'https://evil.test'})).status,403);
 assert.equal((await f.ownerRequest('/tokens',{name:'X',scopes:['scheduling:write']},{origin:''})).status,403);
 assert.equal((await f.ownerRequest('/tokens',undefined,{},'other@example.test')).status,403);
 for(const bad of [{name:'X',scopes:[]},{name:'X',scopes:['people:read']},{name:'X',scopes:['scheduling:read'],owner:'other@example.test'},{name:'X'.repeat(81),scopes:['scheduling:read']}])assert.equal((await f.ownerRequest('/tokens',bad)).status,400);
 const minted=await f.mint();
 assert.equal((await f.ownerRequest('/tokens/'+minted.credential.id+'/revoke',{})).status,200);
 assert.equal((await f.machineRequest('/requests/request-1',minted.token)).status,401);
 assert.equal((await f.ownerRequest('/tokens/'+minted.credential.id+'/revoke',{})).status,200);
 assert.equal((await f.ownerRequest('/tokens/nonexistent/revoke',{})).status,404);
});
test('machine scheduling derives owner and evidence from its credential and refuses forged authority',async t=>{
 const f=schedulingFixture(t),minted=await f.mint();
 assert.equal((await f.machineRequest('/prepare',minted.token,input)).status,200);
 assert.deepEqual(f.calls[0],{method:'prepareScheduling',args:[owner,input,{channel:'owner_api',evidenceId:minted.credential.id}]});
 for(const extra of [{owner:'attacker@example.test'},{authority:{channel:'owner_email',evidenceId:'forged'}},{evidenceId:'forged'},{visitorSubject:'forged'}])assert.equal((await f.machineRequest('/prepare',minted.token,{...input,...extra})).status,400);
 assert.equal(f.calls.length,1);
 assert.equal((await f.machineRequest('/requests/request-1/confirm',minted.token,{revision:'revision-1',slotId:'slot-1'})).status,200);
 assert.deepEqual(f.calls[1],{method:'confirmScheduling',args:[owner,'request-1',{revision:'revision-1',slotId:'slot-1',evidenceId:minted.credential.id}]});
 assert.equal((await f.machineRequest('/requests/request-1/confirm',minted.token,{revision:'revision-1',slotId:'slot-1',evidenceId:'forged'})).status,400);
});
test('read-only credentials cannot persist offers or confirm and cookies never authorize the machine API',async t=>{
 const f=schedulingFixture(t),read=await f.mint(['scheduling:read']),write=await f.mint(['scheduling:write']);
 assert.equal((await f.machineRequest('/requests/request-1',read.token)).status,200);
 for(const [path,data] of [['/prepare',input],['/requests/request-1/refresh',{}],['/requests/request-1/confirm',{revision:'revision-1',slotId:'slot-1'}]] as const)assert.equal((await f.machineRequest(path,read.token,data)).status,403);
 assert.equal((await f.machineRequest('/requests/request-1',write.token)).status,403);
 assert.equal((await f.machineRequest('/requests/request-1',undefined,undefined,{cookie:'__Host-people-session=forged'})).status,401);
 assert.equal((await f.machineRequest('/requests/request-1','wrong-token')).status,401);
 assert.equal(f.calls.length,1);
});
test('machine scheduling rejects cross-origin access, oversized JSON and leaking provider errors',async t=>{
 const f=schedulingFixture(t),minted=await f.mint();
 assert.equal((await f.machineRequest('/prepare',minted.token,input,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.machineRequest('/prepare',minted.token,{...input,context:'x'.repeat(17000)})).status,400);
 assert.equal((await f.machineRequest('/prepare',minted.token,input,{'content-type':'text/plain'})).status,400);
 assert.equal(f.calls.length,0);
 f.service.getScheduling=async()=>{throw Error('provider token=secret private body');};
 const failed=await f.machineRequest('/requests/request-1',minted.token);assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{error:'scheduling_failed'});
 f.env.BOOKING_OWNER_EMAIL='different@example.test';assert.equal((await f.machineRequest('/requests/request-1',minted.token)).status,401);
});
test('owner scheduling readiness exposes configured endpoints without claiming email is delivered',async t=>{
 const f=schedulingFixture(t),response=await f.ownerRequest('/status'),body:any=await response.json();
 assert.equal(body.readiness.emailConfigured,false);assert.equal(body.readiness.emailAddress,null);assert.equal(body.readiness.apiUrl,origin+'/api/scheduling');assert.equal(body.readiness.mcpUrl,origin+'/api/scheduling/mcp');
 f.env.SCHEDULING_EMAIL_ADDRESS='scheduler@reply.example.test';f.env.SCHEDULING_EMAIL_REPLY_DOMAIN='reply.example.test';f.env.SCHEDULING_EMAIL_SEND={send:async()=>{}};f.env.SCHEDULING_EMAIL={getByName:(key:string)=>{assert.equal(key,owner);return {diagnostics:async(actor:string)=>{assert.equal(actor,owner);return {pending:2,deliveryUnknown:1,needsAttention:0};}};}};
 const configured:any=await (await f.ownerRequest('/status')).json();assert.equal(configured.readiness.emailConfigured,true);assert.equal(configured.readiness.emailAddress,'scheduler@reply.example.test');assert.equal(configured.readiness.delivered,undefined);assert.deepEqual(configured.readiness.emailActivity,{pending:2,deliveryUnknown:1,needsAttention:0});
 f.env.SCHEDULING_EMAIL.getByName=()=>({diagnostics:async()=>{throw Error('private diagnostics');}});const unavailable:any=await (await f.ownerRequest('/status')).json();assert.equal(unavailable.readiness.emailConfigured,true);assert.equal(unavailable.readiness.emailActivity,null);assert.equal(JSON.stringify(unavailable).includes('private diagnostics'),false);
 f.env.SCHEDULING_EMAIL_ADDRESS=owner;assert.equal((await (await f.ownerRequest('/status')).json() as any).readiness.emailConfigured,false);
});
test('owner scheduling failures stay inside the adapter and preserve safe conflict/rate-limit status',async t=>{
 const f=schedulingFixture(t);
 const invalid=await f.ownerRequest('/prepare',{...input,owner:'forged@example.test'});assert.equal(invalid.status,400);
 for(const [message,status] of [['idempotency_conflict',409],['rate_limited',429],['secret provider body',503]] as const){
  f.service.prepareScheduling=async()=>{throw Error(message);};
  const response=await f.ownerRequest('/prepare',input);assert.equal(response.status,status);assert.equal((await response.json() as any).error,message==='secret provider body'?'scheduling_failed':message);
 }
});
test('API scheduling fails closed on free-text constraints and accepts explicit UTC windows',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();
 const blocked=await f.machineRequest('/prepare',credential.token,{...input,instructions:'Only offer afternoons next week.'});assert.equal(blocked.status,400);
 const problem:any=await blocked.json();assert.equal(problem.error,'invalid_instructions');assert.match(problem.message,/windowStart.*windowEnd/);assert.equal(f.calls.length,0);
 const bounded=await f.machineRequest('/prepare',credential.token,{...input,windowStart:'2026-11-02T18:00:00.000Z',windowEnd:'2026-11-02T22:00:00.000Z'});assert.equal(bounded.status,200);assert.equal(f.calls.length,1);
});
test('integrated routes isolate scheduling bearers from ordinary owner/People sessions without disclosing them to Google',async t=>{
 const f=schedulingFixture(t),credential=await f.mint();f.env.TOKEN_SECRET='fixture-session-secret';
 let external=0;t.mock.method(globalThis,'fetch',async()=>{external++;throw Error('No external provider calls are allowed.');});
 for(const path of ['/api/booking','/api/booking/scheduling/tokens','/api/people/helpers']){
  const response=await worker.fetch(new Request(origin+path,{headers:{authorization:'Bearer '+credential.token}}),f.env);assert.equal(response.status,401);
 }
 assert.equal(external,0);
 const machine=await worker.fetch(new Request(origin+'/api/scheduling/requests/request-1',{headers:{authorization:'Bearer '+credential.token}}),f.env);assert.equal(machine.status,200);
 const cookie=sessionCookie(await makeSession(owner,f.env.TOKEN_SECRET)).split(';')[0];
 const ownerList=await worker.fetch(new Request(origin+'/api/booking/scheduling/tokens',{headers:{cookie}}),f.env);assert.equal(ownerList.status,200);
 assert.equal((await worker.fetch(new Request(origin+'/api/scheduling/requests/request-1',{headers:{cookie}}),f.env)).status,401);
});
