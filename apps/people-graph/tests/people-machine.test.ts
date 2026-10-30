import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {authenticatePeopleMemory,createPeopleMemoryCredential,type PeopleMemoryPrincipal} from '../src/people-memory-auth';
import {peopleMachineRequest,peopleMachineStatus} from '../src/people-machine';
import {OwnerLensStore} from '../src/owner-lens';
import {cliRoute} from '../src/cli-routes';

const owner='owner@example.test',origin='https://people.test';
function database(t:TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB:any={prepare(query:string){let values:any[]=[];return {bind(...args:any[]){values=args;return this;},async run(){return {success:true,meta:{changes:Number(sql.prepare(query).run(...values).changes)}};},async first(){return sql.prepare(query).get(...values)??null;},async all(){return {results:sql.prepare(query).all(...values)};}};},async batch(statements:any[]){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 return {sql,DB};
}
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
const request=(env:any,actor:PeopleMemoryPrincipal,input:any,headers:Record<string,string>={})=>peopleMachineRequest(new Request(origin+'/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)}),env,actor);

test('machine credentials preserve explicit administrative scopes and live expiry metadata',async t=>{
 const {DB}=database(t),key=await createPeopleMemoryCredential(DB,owner,{name:'Full CLI',scopes:['people:read','people:write','sources:manage','sharing:manage','booking:manage','integrations:manage']});
 const authenticated=await authenticatePeopleMemory(new Request(origin,{headers:{authorization:'Bearer '+key.token}}),DB);
 assert.equal(authenticated.owner,owner);assert.equal(authenticated.expiresAt,key.credential.expiresAt);
 assert.deepEqual(authenticated.scopes,['booking:manage','integrations:manage','people:read','people:write','sharing:manage','sources:manage']);
});
test('delegated machine credentials cannot escape owner or mint an ungranted scope',async t=>{
 const {DB,sql}=database(t),actor=principal(['people:read','integrations:manage']);
 await assert.rejects(createPeopleMemoryCredential(DB,owner,{name:'Escalation',scopes:['people:write']},actor),/insufficient_scope/);
 await assert.rejects(createPeopleMemoryCredential(DB,'other@example.test',{name:'Other owner',scopes:['people:read']},actor),/insufficient_scope/);
 await assert.rejects(createPeopleMemoryCredential(DB,owner,{name:'No admin',scopes:['people:read']},principal(['people:read'])),/insufficient_scope/);
 const key=await createPeopleMemoryCredential(DB,owner,{name:'Reader',scopes:['people:read']},actor);
 assert.deepEqual(key.credential.scopes,['people:read']);assert.equal(sql.prepare('SELECT count(*) AS n FROM people_memory_credentials').get()?.n,1);
 assert.equal(key.credential.expiresAt,actor.expiresAt,'a delegated key cannot extend the lifetime of its authority');
});

test('machine status describes grants, expiry and the full owner capability surface without secrets',()=>{
 const actor=principal(['people:read']),status=peopleMachineStatus(actor,origin);
 assert.equal(status.protocolVersion,1);assert.equal(status.owner,owner);assert.equal(status.credential.expiresAt,actor.expiresAt);
 assert.equal(status.capabilities.find(c=>c.method==='GET'&&c.path==='/api/lens')?.available,true);
 assert.equal(status.capabilities.find(c=>c.method==='POST'&&c.path==='/api/lens')?.available,false);
 for(const path of ['/api/people/context','/api/people/memory/entry','/api/people/person-merges','/api/granola/folders','/api/accounts/context','/api/retrieval/confirm','/api/public-sources/confirm','/api/shares','/api/workspaces/:workspaceId/transfer','/api/workspaces/:workspaceId/intro-requests/:requestId/reply','/api/booking/settings','/api/booking/scheduling/tokens','/api/people/integrations'])assert.ok(status.capabilities.some(c=>c.path===path),path);
 assert.ok(!JSON.stringify(status).includes('token_hash'));assert.ok(!JSON.stringify(status).includes('people_secret'));
});
test('machine allowlist rejects arbitrary routes, methods, origins and owner selectors before services run',async()=>{
 const actor=principal(['people:read','people:write','sources:manage','sharing:manage','booking:manage','integrations:manage']);
 for(const path of ['/api/session','/api/token','/api/push','/api/matching-workspaces','/api/cli/device/approve','/api/public/booking/example/requests','https://evil.test/api/lens','//evil.test/api/lens','/api/accounts/../lens','/api/%6cens','/api/lens#fragment','/api/lens?owner=someone@example.test']){
  const response=await request({},actor,{method:'GET',path});assert.ok([400,404].includes(response.status),path+' '+response.status);
 }
 assert.equal((await request({},actor,{method:'PATCH',path:'/api/lens',body:{}})).status,405);
 assert.equal((await request({},actor,{method:'GET',path:'/api/lens',body:{}})).status,400);
 assert.equal((await request({},actor,{method:'GET',path:'/api/lens',owner:'foreign@example.test'})).status,400);
 assert.equal((await request({},actor,{method:'GET',path:'/api/lens'},{origin:'https://evil.test'})).status,403);
});
test('machine generic mutations cannot disclose private state to write-only grants',async()=>{
 for(const [method,path] of [['POST','/api/lens'],['POST','/api/people/context'],['POST','/api/people/memory'],['DELETE','/api/people/memory/entry'],['POST','/api/people/person-merges'],['POST','/api/people/feedback']]){
  assert.equal((await request({},principal(['people:write']),{method,path,body:{}})).status,403,path);
  assert.equal((await request({},principal(['people:read']),{method,path,body:{}})).status,403,path);
 }
 for(const path of ['/api/accounts/sync','/api/shares','/api/booking/settings','/api/people/integrations'])assert.equal((await request({},principal(['people:read','people:write']),{method:'POST',path,body:{}})).status,403,path);
});
test('machine Lens uses the same saved fields, revision conflict and owner isolation as browser edits',async t=>{
 const {sql}=database(t),ctx:any={storage:{sql:{exec(query:string,...values:any[]){if(query.startsWith('CREATE TABLE')){sql.exec(query);return {toArray:()=>[]};}const statement=sql.prepare(query),rows=query.startsWith('SELECT')?statement.all(...values):(statement.run(...values),[]);return {toArray:()=>rows};}}}};
 const store=new OwnerLensStore(ctx,{},async()=>owner),actor=principal(['people:read','people:write']);
 const env:any={MAIL:{getByName(selected:string){assert.equal(selected,owner);return {bindOwner:async()=>{},getOwnerLens:async()=>store.get(),updateOwnerLens:async(input:any)=>store.update(input)};}}};
 const current=await (await request(env,actor,{method:'GET',path:'/api/lens'})).json() as any;
 const body={action:'save',revision:current.revision,fields:{focus:'Explicit owner focus',needs:'Keep my needs',offers:''}};
 assert.equal((await request(env,actor,{method:'POST',path:'/api/lens',body})).status,200);
 assert.equal(store.get().fields.focus,'Explicit owner focus');
 assert.equal((await request(env,actor,{method:'POST',path:'/api/lens',body:{...body,fields:{...body.fields,focus:'Stale'}}})).status,409);
 assert.equal(store.get().fields.focus,'Explicit owner focus');
 assert.equal((await request(env,actor,{method:'POST',path:'/api/lens',body:{...body,owner:'foreign@example.test'}})).status,400);
});
test('machine workspace administration preserves membership and admin checks',async t=>{
 const {DB}=database(t),env:any={DB},actor=principal(['sharing:manage']);
 const made=await request(env,actor,{method:'POST',path:'/api/workspaces',body:{name:'Owner workspace'}});assert.equal(made.status,200);
 const {workspace}=await made.json() as any;
 const outsider={...actor,owner:'outsider@example.test'};
 assert.equal((await request(env,outsider,{method:'DELETE',path:'/api/workspaces/'+workspace.id})).status,403);
 assert.equal((await request(env,actor,{method:'DELETE',path:'/api/workspaces/'+workspace.id})).status,200);
});
test('machine preserves required idempotency keys and makes OAuth a browser handoff',async()=>{
 const actor=principal(['people:read','people:write','sources:manage','booking:manage']);
 const missing=await request({},actor,{method:'POST',path:'/api/themes/theme-1/feedback',body:{}});assert.equal(missing.status,400);assert.equal((await missing.json() as any).error,'invalid_idempotency_key');
 let saved:any;
 const env:any={MAIL:{getByName:()=>({bindOwner:async()=>{},hasMailGraph:async()=>true,recordRelevanceFeedback:async(input:any)=>{saved=input;return {ok:true};}})}};
 const response=await request(env,actor,{method:'POST',path:'/api/themes/theme-1/feedback',body:{action:'mute'},idempotencyKey:'stable-machine-key-123'});
 assert.equal(response.status,200);assert.equal(saved.idempotencyKey,'stable-machine-key-123');
 for(const path of ['/api/accounts/connect','/api/booking/calendar/connect']){
  const response=await request({},actor,{method:'POST',path,body:{}});assert.equal(response.status,200);const value=await response.json() as any;
  assert.equal(value.requiresBrowser,true);assert.ok(value.browserHandoff.url.startsWith(origin+'/'));assert.equal(response.headers.get('set-cookie'),null);
 }
});
test('machine credential management enforces delegated subset through the request adapter',async t=>{
 const {DB,sql}=database(t),actor=principal(['people:read','integrations:manage']);
 assert.equal((await request({DB},actor,{method:'POST',path:'/api/people/integrations',body:{name:'Escalated',scopes:['sources:manage']}})).status,403);
 const made=await request({DB},actor,{method:'POST',path:'/api/people/integrations',body:{name:'Reader',scopes:['people:read']}});assert.equal(made.status,201);
 assert.equal(sql.prepare('SELECT count(*) AS n FROM people_memory_credentials').get()?.n,1);
});
test('machine scheduling credentials cannot outlive the authorizing People key',async t=>{
 const {DB,sql}=database(t),actor=principal(['booking:manage','integrations:manage']);actor.expiresAt=Date.now()+3600000;
 const env:any={DB,BOOKING_OWNER_EMAIL:owner},input={method:'POST',path:'/api/booking/scheduling/tokens',body:{name:'Delegated scheduling',scopes:['scheduling:read','scheduling:write']}};
 const made=await request(env,actor,input);assert.equal(made.status,201);const key=await made.json() as any;
 assert.equal(key.credential.expiresAt,actor.expiresAt);
 assert.equal(sql.prepare('SELECT expires_at FROM scheduling_credentials').get()?.expires_at,actor.expiresAt);
});
test('machine scheduling credential creation rejects expired or missing delegation expiry',async t=>{
 const {DB,sql}=database(t),env:any={DB,BOOKING_OWNER_EMAIL:owner};
 for(const expiresAt of [Date.now()-1,undefined,NaN,Infinity]){
  const actor={...principal(['booking:manage','integrations:manage']),expiresAt};
  const result=await request(env,actor,{method:'POST',path:'/api/booking/scheduling/tokens',body:{name:'Expired authority',scopes:['scheduling:read']}});
  assert.equal(result.status,403,String(expiresAt));assert.equal((await result.json() as any).error,'insufficient_scope');
 }
 const table=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_credentials'").get();
 if(table)assert.equal(sql.prepare('SELECT count(*) AS n FROM scheduling_credentials').get()?.n,0);
});
test('machine adapter sanitizes unexpected owner-service failures without leaking their text',async()=>{
 const response=await request({MAIL:{getByName:()=>({bindOwner:async()=>{throw Error('private provider secret');}})}},principal(['people:read']),{method:'GET',path:'/api/lens'});
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'people_request_failed'});
});
test('machine People read credentials query the web graph while write-only credentials cannot',async t=>{
 const {DB,sql}=database(t);sql.exec('CREATE TABLE cli_rate_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL)');
 const env:any={DB,MAIL:{getByName(selected:string){assert.equal(selected,owner);return {graph:async()=>({nodes:[{id:'ada',name:'Ada'}],edges:[]})};}}};
 const readKey=await createPeopleMemoryCredential(DB,owner,{name:'Reader',scopes:['people:read']}),writeKey=await createPeopleMemoryCredential(DB,owner,{name:'Writer',scopes:['people:write']});
 const query=(token:string)=>cliRoute(new Request(origin+'/api/cli/v1/query',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({command:'find-person',query:'Ada'})}),env,null);
 const response=await query(readKey.token);assert.equal(response.status,200);assert.equal((await response.json() as any).data.people[0].id,'ada');
 assert.equal((await query(writeKey.token)).status,403);
 sql.prepare('UPDATE people_memory_credentials SET revoked_at=?').run(Date.now());assert.equal((await query(readKey.token)).status,401);
});
