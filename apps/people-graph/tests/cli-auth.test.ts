import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {deviceRoute,authenticateDevice} from '../src/cli-auth';
import {authenticatePeopleMemory,listPeopleMemoryCredentials} from '../src/people-memory-auth';
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync('migrations/20260922_cli_devices.sql','utf8'));sql.exec(readFileSync('migrations/20260922_cli_devices.sql','utf8'));sql.exec(readFileSync('migrations/20261030_cli_scopes.sql','utf8'));const db:any={prepare(q:string){let args:any[]=[];return {bind(...v:any[]){args=v;return this;},async first(){return sql.prepare(q).get(...args)??null;},async all(){return {results:sql.prepare(q).all(...args)};},async run(){return {meta:sql.prepare(q).run(...args)};}};},async batch(items:any[]){sql.exec('BEGIN');try{const r=[];for(const item of items)r.push(await item.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};return {env:{DB:db,TOKEN_SECRET:'secret'} as any,sql};}
const req=(path:string,body:any={},token?:string)=>new Request('https://people.test/api/cli/'+path,{method:'POST',headers:{origin:'https://people.test','content-type':'application/json','cf-connecting-ip':'127.0.0.1',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
test('device approval binds owner and token is one-use, hashed, revocable and scoped',async()=>{const {env,sql}=fixture();const start=await (await deviceRoute(req('device/start',{deviceName:'My Mac'}),env,null)).json() as any;assert.equal(start.interval,5);assert.ok(!start.verificationUri.includes(start.pollSecret));assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode}),env,null)).status,401);assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'owner@test'}),env,'owner@test')).status,200);assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'other@test'}),env,'other@test')).status,400);const result=await (await deviceRoute(req('device/poll',start),env,null)).json() as any;assert.ok(result.token.startsWith('pgd1_'));assert.equal(result.owner,'owner@test');assert.equal(sql.prepare('select token_hash from cli_devices').get()?.token_hash===result.token,false);const auth=await authenticateDevice(req('v1/query',{},result.token),env);assert.equal(auth?.owner,'owner@test');assert.equal((await deviceRoute(req('device/poll',start),env,null)).status,400);assert.equal((await deviceRoute(req('devices/revoke',{id:auth!.deviceId}),env,'other@test')).status,404);await deviceRoute(req('logout',{},result.token),env,null);assert.equal(await authenticateDevice(req('v1/query',{},result.token),env),null);});
test('device exchange rejects foreign origins, expired challenges, bad secrets, rapid polling and excess starts',async()=>{const {env,sql}=fixture();const start=await (await deviceRoute(req('device/start',{deviceName:'Mac'}),env,null)).json() as any;const foreign=req('device/approve',{userCode:start.userCode});foreign.headers.set('origin','https://evil.test');assert.equal((await deviceRoute(foreign,env,'owner@test')).status,403);assert.equal((await deviceRoute(req('device/poll',{...start,pollSecret:'wrong'}),env,null)).status,400);assert.equal((await deviceRoute(req('device/poll',start),env,null)).status,202);assert.equal((await deviceRoute(req('device/poll',start),env,null)).status,429);sql.prepare('UPDATE cli_challenges SET expires_at=0').run();assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'owner@test'}),env,'owner@test')).status,400);for(let i=0;i<9;i++)await deviceRoute(req('device/start',{deviceName:'Mac'}),env,null);assert.equal((await deviceRoute(req('device/start',{deviceName:'Mac'}),env,null)).status,429);});

test('approval refuses a browser account change and token never reaches Google verification',async()=>{
 const {env}=fixture();const start=await (await deviceRoute(req('device/start',{deviceName:'Mac'}),env,null)).json() as any;
 assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'old@test'}),env,'new@test')).status,409);
 const {requireGoogleUser}=await import('../src/index');const old=globalThis.fetch;let called=false;globalThis.fetch=async()=>{called=true;throw Error('must not call Google');};try{assert.ok('error' in await requireGoogleUser(req('x',{},'pgd1_'+'a'.repeat(64)),env));assert.equal(called,false);}finally{globalThis.fetch=old;}
});

test('concurrent approval and redemption produce exactly one credential',async()=>{
 const {env,sql}=fixture();const start=await (await deviceRoute(req('device/start',{deviceName:'Mac'}),env,null)).json() as any;
 const approvals=await Promise.all(['one@test','two@test'].map(owner=>deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:owner}),env,owner)));assert.deepEqual(approvals.map(r=>r.status).sort(),[200,400]);
 // Real D1 batches serialize; use a lock to model the same database transaction boundary.
 const batch=env.DB.batch.bind(env.DB);let tail=Promise.resolve();env.DB.batch=(items:any[])=>{const next=tail.then(()=>batch(items));tail=next.catch(()=>{});return next;};
 const redeemed=await Promise.all([deviceRoute(req('device/poll',start),env,null),deviceRoute(req('device/poll',start),env,null)]);assert.deepEqual(redeemed.map(r=>r.status).sort(),[200,400]);assert.equal(sql.prepare('SELECT count(*) AS n FROM cli_devices').get()?.n,1);
});
test('device credential cannot authorize any website-only API',async()=>{
 const {env}=fixture();const {default:worker}=await import('../src/index');
 for(const path of ['/api/token','/api/graph','/api/people/draft','/api/people/search','/api/accounts','/api/granola','/api/cli/devices']){
  const response=await worker.fetch(new Request('https://people.test'+path,{headers:{authorization:'Bearer pgd1_'+'a'.repeat(64)}}),env);assert.equal(response.status,401,path);
 }
 const push=await worker.fetch(new Request('https://people.test/api/push',{method:'POST',headers:{authorization:'Bearer pgd1_'+'a'.repeat(64)},body:'{}'}),env);assert.equal(push.status,401);
});

test('scoped CLI approval shows and confirms exactly the requested grants',async()=>{
 const {env,sql}=fixture(),scopes=['people:read','people:write','sources:manage','sharing:manage','booking:manage','integrations:manage'];
 const started=await deviceRoute(req('device/start',{deviceName:'My agent',scopes}),env,null);assert.equal(started.status,200);
 const start=await started.json() as any;
 const preview=await (await deviceRoute(req('device/preview',{userCode:start.userCode}),env,'owner@test')).json() as any;
 assert.deepEqual(preview.scopes,[...scopes].sort());
 assert.deepEqual(preview.scopeDescriptions,[
  {scope:'booking:manage',description:'Manage booking settings, requests and scheduling approvals'},
  {scope:'integrations:manage',description:'List and revoke integration keys, and create keys within this key’s scopes'},
  {scope:'people:read',description:'Read your private People network, Lens and relationship context'},
  {scope:'people:write',description:'Edit your private Lens, people and relationship context'},
  {scope:'sharing:manage',description:'Manage network sharing, workspaces and introduction requests'},
  {scope:'sources:manage',description:'Manage connected source settings, synchronization and retrieval'}
 ]);
 assert.equal(preview.credentialExpiresInDays,90);
 for(const expectedScopes of [undefined,['people:read'],[...scopes,'admin']]){
  const approval=await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'owner@test',expectedScopes}),env,'owner@test');assert.equal(approval.status,409);
 }
 assert.equal(sql.prepare('SELECT status FROM cli_challenges').get()?.status,'pending');
 assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'owner@test',expectedScopes:scopes}),env,'owner@test')).status,200);
});

test('scoped CLI exchange mints one hashed People credential visible in integrations and self-revocable without management',async()=>{
 const {env,sql}=fixture(),scopes=['people:read','people:write'];
 const start=await (await deviceRoute(req('device/start',{deviceName:'Scoped laptop',scopes}),env,null)).json() as any;
 assert.equal((await deviceRoute(req('device/approve',{userCode:start.userCode,expectedOwner:'owner@test',expectedScopes:scopes}),env,'owner@test')).status,200);
 // D1 batches serialize all statements within one transaction.
 const batch=env.DB.batch.bind(env.DB);let tail=Promise.resolve();env.DB.batch=(items:any[])=>{const next=tail.then(()=>batch(items));tail=next.catch(()=>{});return next;};
 const responses=await Promise.all([deviceRoute(req('device/poll',start),env,null),deviceRoute(req('device/poll',start),env,null)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
 const result=await responses.find(r=>r.status===200)!.json() as any;
 assert.match(result.token,/^people_[A-Za-z0-9_-]{43}$/);assert.deepEqual(result.scopes,scopes);assert.equal(result.owner,'owner@test');
 assert.ok(result.expiresAt>Math.floor(Date.now()/1000)+89*86400&&result.expiresAt<1e11,'poll expiry remains Unix seconds');
 assert.equal(sql.prepare('SELECT count(*) AS n FROM cli_devices').get()?.n,0);
 const stored=sql.prepare('SELECT * FROM people_memory_credentials').all();assert.equal(stored.length,1);assert.notEqual(stored[0].token_hash,result.token);assert.ok(!JSON.stringify(stored).includes(result.token));
 const principal=await authenticatePeopleMemory(req('x',{},result.token),env.DB);assert.equal(principal.owner,'owner@test');assert.deepEqual(principal.scopes,scopes);
 const listed=await listPeopleMemoryCredentials(env.DB,'owner@test');assert.equal(listed.length,1);assert.equal(listed[0].name,'Scoped laptop');assert.deepEqual(listed[0].scopes,scopes);
 assert.deepEqual(await listPeopleMemoryCredentials(env.DB,'other@test'),[]);
 assert.equal((await deviceRoute(req('logout',{},result.token),env,null)).status,200);
 await assert.rejects(()=>authenticatePeopleMemory(req('x',{},result.token),env.DB),/people_memory_unauthorized/);
 assert.equal((await deviceRoute(req('logout',{},result.token),env,null)).status,401);
});

test('CLI scope requests reject malformed and unknown grants before persisting a challenge',async()=>{
 for(const scopes of [[],null,'people:read',['admin'],['people:read','people:read'],['people:read',3]]){
  const {env,sql}=fixture();const result=await deviceRoute(req('device/start',{deviceName:'Agent',scopes}),env,null);
  assert.equal(result.status,400,JSON.stringify(scopes));assert.equal((await result.json() as any).error,'invalid_scopes');assert.equal(sql.prepare('SELECT count(*) AS n FROM cli_challenges').get()?.n,0);
 }
});
