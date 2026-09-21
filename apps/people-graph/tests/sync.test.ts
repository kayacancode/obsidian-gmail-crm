import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {FakeAI} from './worker-stub';
import {opaque} from '../src/mail-model';
import {jevServer,noulA} from './granola-jev-extractor.test';

const JEV_KEY='ts_fictional_key_123456';
const THEME_MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}
/** A minimal single-contact draftNote fixture, ready for the Jev-configured tests below. */
async function draftFixture(){
 const {service,db,kv}=fixture();kv.set('owner','owner');
 const ai=new FakeAI({response:{subject:'Following up',body:'Hi Ada, good to see you.'}});
 Object.assign((service as any).env,{AI:ai,THEME_MODEL});
 db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
 db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','ada@example.com','Ada',Date.parse('2026-09-01T00:00:00Z'),'Hello',1,1);
 const ada=await opaque('owner','ada@example.com','identity-key');
 return {service,db,kv,ai,ada};
}

test('final wave retrieval resolves ranked visible contacts across selected accounts',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  for(const email of ['one@example.com','two@example.com'])db.prepare('INSERT INTO accounts VALUES (?,?)').run(email,JSON.stringify({email,grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  const insert=db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)');
  for(let i=0;i<1500;i++)insert.run('one@example.com',`low-${i}`,`a${i}@example.com`,'Low',Date.now(),'Topic',1,0);
  for(const account of ['one@example.com','two@example.com'])for(let i=0;i<5;i++)insert.run(account,`${account}-${i}`,'zulu@example.com','Zulu',Date.now(),'Topic',1,1);
  insert.run('two@example.com','exclusive','zzz@example.com','Exclusive',Date.now(),'Topic',100,100);
  const graph=await service.graph();assert.ok(graph!.nodes.some(n=>n.name==='Zulu'));assert.equal(graph!.nodes.length,1500);
  const personId=graph!.nodes.find(n=>n.name==='Zulu')!.id;
  for(const account of ['one@example.com','two@example.com'])assert.equal((await service.previewRetrieval({account,personId})).personId,personId);
  const exclusive=await opaque('owner','zzz@example.com','identity-key');
  await assert.rejects(service.previewRetrieval({account:'one@example.com',personId:exclusive}),/retrieval_failed/);
  await assert.rejects(service.previewRetrieval({account:'two@example.com',personId:await opaque('other-owner','zulu@example.com','identity-key')}),/retrieval_failed/);
 }finally{db.close();}
});
function fixture(){const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};const env={MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_SECRET:'client-secret',GOOGLE_CLIENT_ID:'client-id',TOKEN_SECRET:'identity-key'};return {service:new MailSync(ctx as any,env as any),db,kv};}
const originalFetch=globalThis.fetch;
function storageText(db:DatabaseSync,kv:Map<string,unknown>){return JSON.stringify([Array.from(kv),db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r:any)=>db.prepare(`SELECT * FROM "${r.name}"`).all())]);}
async function retrievalFixture(){
 const f=fixture();network();f.kv.set('owner','owner');
 const ai=new FakeAI();Object.assign((f.service as any).env,{AI:ai,THEME_MODEL:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'});
 await f.service.attachAccount('me@example.com','refresh','all');await f.service.alarm();
 const graph=await f.service.graph();const personId=graph!.nodes.find((n:any)=>n.name==='Ada')!.id;
 return {...f,ai,scope:{account:'me@example.com',personId,windowDays:30 as const}};
}
function bodyNetwork(count=1,text='SECRET BODY SENTENCE about research systems.',failure?:number){
 const calls:string[]=[];let active=0,maxActive=0;
 globalThis.fetch=async(input:any)=>{
  const url=String(input);calls.push(url);
  if(url.includes('oauth2.googleapis'))return Response.json({access_token:'SECRET ACCESS TOKEN'});
  if(url.includes('/messages?'))return Response.json({messages:Array.from({length:Math.min(count,50)},(_,i)=>({id:`body${i}`})),nextPageToken:count>50?'next':undefined});
  active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,1));active--;
  if(failure)return new Response('SECRET ERROR BODY',{status:failure});
  const id=new URL(url).pathname.split('/').at(-1)!;
  return Response.json({...msg(id),payload:{...msg(id).payload,mimeType:'text/plain',body:{data:Buffer.from(text).toString('base64url')}}});
 };
 return {calls,get maxActive(){return maxActive;}};
}
test('round1 consent fingerprint can create exactly one job across different keys and concurrent confirms',async()=>{
 for(const concurrent of [false,true]){
  const {service,db,scope}=await retrievalFixture();try{
   const preview=await service.previewRetrieval(scope);
   let first:any;
   if(concurrent){const results=await Promise.allSettled(['consent-one','consent-two'].map(idempotencyKey=>service.confirmRetrieval({...preview,idempotencyKey})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);first=(results.find(r=>r.status==='fulfilled') as any).value;}
   else{first=await service.confirmRetrieval({...preview,idempotencyKey:'consent-one'});await assert.rejects(service.confirmRetrieval({...preview,idempotencyKey:'consent-two'}),{message:'retrieval_failed'});}
   assert.equal(db.prepare('SELECT COUNT(*) n FROM retrieval_jobs').get()!.n,1);
   if(!concurrent)assert.deepEqual(await service.confirmRetrieval({...preview,idempotencyKey:'consent-one'}),first);
  }finally{globalThis.fetch=originalFetch;db.close();}
 }
});
test('round1 concurrent same-key consent replay returns one identical job',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const preview=await service.previewRetrieval(scope);const [one,two]=await Promise.all([1,2].map(()=>service.confirmRetrieval({...preview,idempotencyKey:'same-key'})));
  assert.deepEqual(one,two);assert.equal(db.prepare('SELECT COUNT(*) n FROM retrieval_jobs').get()!.n,1);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('round1 rollback leaves persisted assertions and committed counters unchanged',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'assertion-counter'});bodyNetwork();
  db.exec("CREATE TRIGGER fail_assertion BEFORE INSERT ON theme_signals WHEN NEW.source_type='gmail_body_derived' BEGIN SELECT RAISE(ABORT, 'SAFE_TEST_FAILURE'); END");
  await service.alarm();const status=await service.retrievalStatus(job.id);
  assert.equal(status!.status,'failed');assert.equal(status!.error,'retrieval_failed');assert.equal(status!.assertions,0);assert.equal(status!.processed,0);assert.equal(status!.decodedBytes,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM theme_signals WHERE source_type='gmail_body_derived'").get()!.n,0);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('round1 a live extraction remains exclusively claimed beyond the persisted lease',async()=>{
 const {service,db,scope,ai}=await retrievalFixture();const originalNow=Date.now;let release!:(v:any)=>void,running:Promise<void>|undefined;
 try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'long-live-claim'});const net=bodyNetwork();
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let calls=0;
  ai.run=async()=>{calls++;if(calls>1)return {response:{themes:[]}};entered();return new Promise(r=>release=r);};
  running=service.alarm();await ready;const now=originalNow();Date.now=()=>now+60_001;
  await service.alarm();assert.equal(calls,1);assert.equal(net.calls.filter(u=>u.includes('format=full')).length,1);
  release({response:{themes:[]}});await running;assert.equal((await service.retrievalStatus(job.id))!.processed,1);
 }finally{Date.now=originalNow;release?.({response:{themes:[]}});await running;globalThis.fetch=originalFetch;db.close();}
});
test('round1 a new instance recovers an abandoned persisted claim after its lease',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'abandoned-claim'});
  const row=db.prepare('SELECT data FROM retrieval_jobs WHERE id=?').get(job.id) as any;const value=JSON.parse(row.data);value.status='running';value.dueAt=Date.now()-1;value.generation='abandoned';
  db.prepare('UPDATE retrieval_jobs SET status=?,due_at=?,data=? WHERE id=?').run(value.status,value.dueAt,JSON.stringify(value),job.id);
  const resumed=new MailSync((service as any).ctx,(service as any).env);const net=bodyNetwork();await resumed.alarm();
  assert.equal((await resumed.retrievalStatus(job.id))!.status,'complete');assert.equal((await resumed.retrievalStatus(job.id))!.processed,1);assert.equal(net.calls.filter(u=>u.includes('format=full')).length,1);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('round1 an over-deadline AI call fails safely and releases the active claim',async(t)=>{
 const {service,db,scope,ai}=await retrievalFixture();let running:Promise<void>|undefined,release!:(v:any)=>void;
 try{
  t.mock.timers.enable({apis:['setTimeout']});
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'deadline-claim'});
  bodyNetwork();const net=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>String(input).includes('format=full')?Response.json({...msg('body0'),payload:{...msg('body0').payload,mimeType:'text/plain',body:{data:Buffer.from('PRIVATE SOURCE').toString('base64url')}}}):net(input,init);
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);ai.run=async()=>{entered();return new Promise(r=>release=r);};
  running=service.alarm();await ready;t.mock.timers.tick(180_001);
  // The provider deliberately ignores cancellation; the application must still settle.
  await new Promise<void>(resolve=>process.nextTick(resolve));
  const status=await service.retrievalStatus(job.id);assert.equal(status!.status,'failed');assert.equal(status!.error,'ai_unavailable');
  await running;t.mock.timers.reset();ai.run=async()=>({response:{themes:[]}});
  const next=await service.confirmRetrieval({...await service.previewRetrieval({...scope,windowDays:90}),idempotencyKey:'after-deadline'});await service.alarm();assert.equal((await service.retrievalStatus(next.id))!.status,'complete');
 }finally{release?.({response:{themes:[]}});await running;t.mock.timers.reset();globalThis.fetch=originalFetch;db.close();}
});
test('round1 decoded bytes remain cumulative across multiple alarms and stop at one MB',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'cross-alarm-cap'});const net=bodyNetwork(50,'x'.repeat(60_000));
  await service.alarm();assert.equal((await service.retrievalStatus(job.id))!.decodedBytes,600_000);assert.equal((await service.retrievalStatus(job.id))!.status,'queued');
  db.prepare('UPDATE retrieval_jobs SET due_at=0').run();await service.alarm();const status=await service.retrievalStatus(job.id);assert.equal(status!.decodedBytes,1_000_000);assert.equal(status!.status,'complete');assert.equal(status!.processed,17);
  const count=net.calls.filter(u=>u.includes('format=full')).length;assert.equal(count,18);await service.alarm();assert.equal(net.calls.filter(u=>u.includes('format=full')).length,count);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('round1 model names and secrets never reach storage or graph; valid choices use server text',async()=>{
 for(const bad of ['Ada Jones','fixture-secret-do-not-use','"private fragment"','We should explore','unlisted_topic']){
  const {service,db,kv,scope,ai}=await retrievalFixture();try{
   const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'unsafe-choice'});bodyNetwork();
   ai.response={response:{themes:[{topicId:'agent_memory',confidence:.8},{topicId:bad,confidence:.9}]}};
   await service.alarm();const status=await service.retrievalStatus(job.id);assert.equal(status!.error,'invalid_extraction');assert.equal(status!.assertions,0);
   assert.equal(db.prepare("SELECT COUNT(*) n FROM theme_signals WHERE source_type='gmail_body_derived'").get()!.n,0);
   assert.equal((storageText(db,kv)+JSON.stringify(await service.graph())+JSON.stringify(status)).includes(bad),false);
  }finally{globalThis.fetch=originalFetch;db.close();}
 }
 const {service,db,scope}=await retrievalFixture();try{
  await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'trusted-choice'});bodyNetwork();await service.alarm();
  const row=db.prepare("SELECT summary,theme_id FROM theme_signals WHERE source_type='gmail_body_derived'").get() as any;
  assert.equal(row.summary,'Activity involving agent memory systems');const theme=db.prepare('SELECT canonical_name,aliases FROM themes WHERE id=?').get(row.theme_id) as any;
  assert.equal(theme.canonical_name,'agent memory');assert.deepEqual(JSON.parse(theme.aliases),['Agent memory']);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('round1 account removal removes consumed consent references with its jobs',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'consent-remove'});assert.equal(db.prepare('SELECT COUNT(*) n FROM retrieval_previews').get()!.n,1);
  await service.remove(scope.account);assert.equal(db.prepare('SELECT COUNT(*) n FROM retrieval_previews').get()!.n,0);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval preview performs zero network or storage writes and validates owner/contact scope',async()=>{
 const {service,db,kv,scope}=await retrievalFixture();try{
  const before=storageText(db,kv);globalThis.fetch=async()=>{throw Error('preview must not fetch');};
  const preview=await service.previewRetrieval(scope);
  assert.equal(preview.windowDays,30);assert.equal(preview.maxMessages,50);assert.equal(preview.maxBytes,1_000_000);assert.equal(storageText(db,kv),before);
  for(const change of [{account:'other@example.com'},{personId:'ada@example.com'},{personId:'not-mapped'},{windowDays:31},{themeId:'unknown-theme'}])await assert.rejects(service.previewRetrieval({...scope,...change} as any),{message:'retrieval_failed'});
  assert.equal(storageText(db,kv),before);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval confirm requires matching scope fingerprint and owner idempotency without fetching bodies',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const preview=await service.previewRetrieval(scope);globalThis.fetch=async()=>{throw Error('confirm must not fetch');};
  for(const change of [{fingerprint:'wrong'}, {windowDays:90}, {windowDays:undefined}, {expiresAt:0}, {idempotencyKey:''}])await assert.rejects(service.confirmRetrieval({...preview,idempotencyKey:'valid-key-123',...change} as any),{message:'retrieval_failed'});
  assert.equal(db.prepare('SELECT count(*) n FROM retrieval_jobs').get()!.n,0);
  const one=await service.confirmRetrieval({...preview,idempotencyKey:'valid-key-123'});
  assert.equal(one.status,'queued');assert.deepEqual(await service.confirmRetrieval({...preview,idempotencyKey:'valid-key-123'}),one);
  const second=await service.previewRetrieval({...scope,windowDays:90});
  await assert.rejects(service.confirmRetrieval({...second,idempotencyKey:'valid-key-123'}),{message:'retrieval_failed'});
  assert.equal(db.prepare('SELECT count(*) n FROM retrieval_jobs').get()!.n,1);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval alarm caps each batch at ten and whole job at fifty with bounded concurrency and scoped query',async()=>{
 const {service,db,kv,scope,ai}=await retrievalFixture();try{
  const preview=await service.previewRetrieval(scope);const job=await service.confirmRetrieval({...preview,idempotencyKey:'batch-key'});const net=bodyNetwork(75);
  for(let i=0;i<5;i++){db.prepare('UPDATE retrieval_jobs SET due_at=0').run();await service.alarm();assert.equal((await service.retrievalStatus(job.id))!.processed,(i+1)*10);}
  const status=await service.retrievalStatus(job.id);assert.equal(status!.status,'complete');assert.equal(ai.calls.length,5);assert.ok(net.maxActive<=2);
  assert.equal(net.calls.filter(u=>u.includes('format=full')).length,50);
  assert.equal(net.calls.filter(u=>u.includes('/messages?')).length,1);
  const q=new URL(net.calls.find(u=>u.includes('/messages?'))!).searchParams.get('q')!;
  assert.match(q,/from:ada@example.com/);assert.match(q,/to:ada@example.com/);assert.match(q,/after:\d+/);assert.match(q,/before:\d+/);
  const all=storageText(db,kv)+JSON.stringify(status)+JSON.stringify(await service.graph());assert.doesNotMatch(all,/SECRET BODY SENTENCE|SECRET ACCESS TOKEN|Collaboration on memory tooling/);
  assert.match(all,/Agent memory/);assert.ok(db.prepare("SELECT count(*) n FROM theme_signals WHERE source_type='gmail_body_derived'").get()!.n);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM retrieval_jobs').all()),/@/);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval byte budget is cumulative and stops before another body fetch',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'byte-cap'});
  const net=bodyNetwork(50,'x'.repeat(600_000));await service.alarm();const status=await service.retrievalStatus(job.id);
  assert.equal(status!.decodedBytes,1_000_000);assert.equal(status!.status,'complete');assert.ok(net.calls.filter(u=>u.includes('format=full')).length<=2);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval safe provider failures retain no text and preserve metadata relevance',async()=>{
 for(const failure of [401,403,500,'ai','invalid'] as const){
  const {service,db,kv,scope,ai}=await retrievalFixture();try{
   const before=await service.relevance('my');const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'failure-key'});
   bodyNetwork(1,undefined,typeof failure==='number'?failure:undefined);
   if(failure==='ai')ai.response=new Error('SECRET MODEL ERROR');if(failure==='invalid')ai.response={response:{themes:[{name:'SECRET BODY SENTENCE',confidence:3}]}};
   await service.alarm();const status=await service.retrievalStatus(job.id);
   assert.equal(status!.error,failure===401?'reconnect_required':failure===403?'gmail_access_denied':failure==='ai'?'ai_unavailable':failure==='invalid'?'invalid_extraction':'retrieval_failed');
   assert.equal(status!.status,'failed');assert.deepEqual((await service.relevance('my'))!.themes.map(t=>[t.themeId,t.name,t.score,t.nodeIds]),before!.themes.map(t=>[t.themeId,t.name,t.score,t.nodeIds]));assert.doesNotMatch(storageText(db,kv)+JSON.stringify(status),/SECRET (BODY|ERROR|MODEL|ACCESS)/);
  }finally{globalThis.fetch=originalFetch;db.close();}
 }
});
test('retrieval disconnect during extraction fences assertions, jobs and alarms',async()=>{
 const {service,db,kv,scope,ai}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'disconnect'});bodyNetwork();
  let release!:(v:any)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  ai.run=async()=>{entered();return new Promise(r=>release=r);};
  const running=service.alarm();await ready;await service.remove(scope.account);release({response:{themes:[{topicId:'agent_memory',confidence:.8}]}});await running;
  assert.equal(await service.retrievalStatus(job.id),null);assert.equal(db.prepare('SELECT count(*) n FROM theme_signals').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM retrieval_jobs').get()!.n,0);
  assert.doesNotMatch(storageText(db,kv),/SECRET BODY/);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval preview expires on reconnect and jobs do not cross owner objects',async()=>{
 const {service,db,scope}=await retrievalFixture();const other=fixture();try{
  const preview=await service.previewRetrieval(scope);const job=await service.confirmRetrieval({...preview,idempotencyKey:'stale-account'});
  other.kv.set('owner','someone-else');assert.equal(await other.service.retrievalStatus(job.id),null);
  await service.attachAccount(scope.account,'new-refresh','all');await assert.rejects(service.confirmRetrieval({...preview,idempotencyKey:'stale-confirm'}),{message:'retrieval_failed'});
  assert.equal(await service.retrievalStatus(job.id),null);
 }finally{globalThis.fetch=originalFetch;db.close();other.db.close();}
});
test('retrieval rejects explicit null windows and malformed scope without storage writes',async()=>{
 const {service,db,kv,scope}=await retrievalFixture();try{
  const before=storageText(db,kv);for(const change of [{windowDays:null},{windowDays:'30'},{personId:null},{account:null}])await assert.rejects(service.previewRetrieval({...scope,...change} as any),{message:'retrieval_failed'});
  assert.equal(storageText(db,kv),before);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval revalidates person and date on Gmail responses before AI',async()=>{
 const {service,db,scope,ai}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'scope-check'});bodyNetwork(2);const net=globalThis.fetch;
  globalThis.fetch=async(input:any,init:any)=>{
   const response=await net(input,init);if(!String(input).includes('format=full'))return response;
   const value=await response.json() as any;if(value.id==='body0')value.internalDate=String(Date.now()-31*86400_000);else value.payload.headers=[{name:'From',value:'stranger@example.com'},{name:'To',value:'outsider@example.com'}];return Response.json(value);
  };
  await service.alarm();const status=await service.retrievalStatus(job.id);assert.equal(status!.status,'complete');assert.equal(status!.decodedBytes,0);assert.equal(status!.assertions,0);assert.equal(ai.calls.length,0);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval targets the selected account token and confirmed theme, retaining that theme identity',async()=>{
 const {service,db,scope,ai}=await retrievalFixture();try{
  const graph=await service.graph();const themeId=graph!.themes[0].id;
  ai.response={response:{themes:[{topicId:'design_review',confidence:.7}]}};
  const job=await service.confirmRetrieval({...await service.previewRetrieval({...scope,themeId}),idempotencyKey:'theme-scope'});bodyNetwork();
  const net=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{if(String(input).includes('oauth2.googleapis'))assert.equal(init.body.get('refresh_token'),'refresh');return net(input,init);};
  await service.alarm();assert.equal((await service.retrievalStatus(job.id))!.status,'complete');
  const signal=db.prepare("SELECT theme_id FROM theme_signals WHERE source_type='gmail_body_derived'").get();assert.equal(signal!.theme_id,themeId);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval commits assertions atomically and reports rollback with a safe error',async()=>{
 const {service,db,kv,scope}=await retrievalFixture();try{
  const before=db.prepare('SELECT * FROM themes').all();const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'rollback'});bodyNetwork();
  db.exec("CREATE TRIGGER fail_body BEFORE INSERT ON theme_signals WHEN NEW.source_type='gmail_body_derived' BEGIN SELECT RAISE(ABORT, 'SECRET DATABASE OUTPUT'); END");
  await service.alarm();assert.deepEqual(db.prepare('SELECT * FROM themes').all(),before);assert.equal((await service.retrievalStatus(job.id))!.error,'retrieval_failed');assert.doesNotMatch(storageText(db,kv),/SECRET DATABASE OUTPUT|SECRET BODY SENTENCE/);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval checks a streamed response byte cap and hides malformed provider data',async()=>{
 for(const bad of ['x'.repeat(2_000_001),'NOT JSON SECRET','{"id":"wrong","internalDate":"SECRET DATE"}']){
  const {service,db,kv,scope}=await retrievalFixture();try{
   const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'bad-response'});bodyNetwork();const net=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>String(input).includes('format=full')?new Response(bad):net(input,init);
   await service.alarm();assert.equal((await service.retrievalStatus(job.id))!.error,'retrieval_failed');assert.doesNotMatch(storageText(db,kv),/NOT JSON SECRET|SECRET DATE/);
  }finally{globalThis.fetch=originalFetch;db.close();}
 }
});
test('retrieval reconnect during a body fetch cannot resurrect queued work',async()=>{
 const {service,db,scope}=await retrievalFixture();try{
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'fetch-fence'});bodyNetwork();const net=globalThis.fetch;
  let release!:(v:Response)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  globalThis.fetch=async(input:any,init:any)=>{if(String(input).includes('format=full')){entered();return new Promise(r=>release=r);}return net(input,init);};
  const running=service.alarm();await ready;await service.attachAccount(scope.account,'new-refresh','all');release(Response.json({...msg('body0'),payload:{...msg('body0').payload,mimeType:'text/plain',body:{data:Buffer.from('SECRET BODY SENTENCE').toString('base64url')}}}));await running;
  assert.equal(await service.retrievalStatus(job.id),null);assert.equal(db.prepare("SELECT count(*) n FROM theme_signals WHERE source_type='gmail_body_derived'").get()!.n,0);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval maintains one shared alarm, does not claim an in-flight batch twice, and deletes idle alarms',async()=>{
 const {service,db,kv,scope,ai}=await retrievalFixture();try{
  (service as any).ctx.storage.deleteAlarm=async()=>{kv.delete('alarm');};
  const later=Number(kv.get('alarm'));const preview=await service.previewRetrieval(scope);const job=await service.confirmRetrieval({...preview,idempotencyKey:'one-alarm'});
  assert.ok(Number(kv.get('alarm'))<later);bodyNetwork();
  let release!:(v:any)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let calls=0;
  ai.run=async()=>{calls++;entered();return new Promise(r=>release=r);};
  const running=service.alarm();await ready;await service.alarm();assert.equal(calls,1);
  release({response:{themes:[]}});await running;assert.equal((await service.retrievalStatus(job.id))!.status,'complete');
  assert.ok(Number(kv.get('alarm'))>Date.now()+3000);await service.remove(scope.account);assert.equal(kv.has('alarm'),false);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('retrieval recursively retains neither encoded content nor extracted free text and emits no logs',async()=>{
 const {service,db,kv,scope}=await retrievalFixture();const original={log:console.log,warn:console.warn,error:console.error};const logs:unknown[]=[];
 try{
  for(const key of ['log','warn','error'] as const)console[key]=(...args:unknown[])=>{logs.push(args);};
  const body='PRIVATE CURRENT SENTENCE about workflows.\n-- \nSIGNATURE SECRET\nOn Monday wrote:\n> PRIVATE QUOTE';
  const job=await service.confirmRetrieval({...await service.previewRetrieval(scope),idempotencyKey:'no-retention'});bodyNetwork(1,body);await service.alarm();
  const stored=storageText(db,kv)+JSON.stringify(await service.retrievalStatus(job.id))+JSON.stringify(await service.graph())+JSON.stringify(logs);
  for(const sentinel of [body,Buffer.from(body).toString('base64url'),'PRIVATE CURRENT SENTENCE','SIGNATURE SECRET','PRIVATE QUOTE','Collaboration on memory tooling','SECRET ACCESS TOKEN'])assert.equal(stored.includes(sentinel),false);
  assert.equal(logs.length,0);
 }finally{Object.assign(console,original);globalThis.fetch=originalFetch;db.close();}
});
const msg=(id:string)=>({id,internalDate:String(Date.now()-100000),payload:{headers:[{name:'From',value:'Me <me@example.com>'},{name:'To',value:'Ada <ada@example.com>, Bo <bo@example.com>'},{name:'Subject',value:'Design review'},{name:'Message-ID',value:'<same-message>'}]}});
function network(){globalThis.fetch=async(input:any)=>{const url=String(input);if(url.includes('oauth2.googleapis'))return Response.json({access_token:'access'});if(url.includes('/messages?'))return Response.json({messages:[{id:'m1'}]});return Response.json(msg('m1'));};}
test('background import scores automatically, is idempotent, and disconnect removes contributions',async()=>{const {service,db,kv}=fixture();network();try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all');assert.ok(!db.prepare('SELECT data FROM accounts').get().data.includes('refresh'));await service.alarm();assert.equal(service.list()[0].status,'connected');const g=await service.graph() as any;assert.equal(g.nodes.length,2);assert.equal(g.edges.length,1);assert.equal(g.edges[0].types[0],'shared_email');assert.ok(g.nodes.every((n:any)=>!n.id.includes('@')));assert.ok(Number(kv.get('alarm'))>Date.now());await service.start('me@example.com');await service.alarm();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);await service.remove('me@example.com');assert.equal(await service.graph(),null);}finally{globalThis.fetch=originalFetch;db.close();}});
test('completed metadata sync attaches opaque relevance without changing legacy graph fields',async()=>{const {service,db}=fixture();try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all');globalThis.fetch=async(input:any)=>{const url=String(input);if(url.includes('oauth2.googleapis'))return Response.json({access_token:'access'});if(url.includes('/messages?'))return Response.json({messages:[{id:'one'},{id:'two'}]});const two=url.endsWith('/two');return Response.json({id:two?'two':'one',internalDate:String(Date.now()-100000),payload:{headers:[{name:'From',value:'Me <me@example.com>'},{name:'To',value:'Ada <ada@example.com>, Bo <bo@example.com>'},{name:'Subject',value:two?'Agent memory roadmap':'Agent memory review'},{name:'Message-ID',value:two?'<two>':'<one>'}]}});};await service.alarm();const graph=await service.graph() as any;assert.equal(graph.nodes.length,2);assert.equal(graph.edges[0].types[0],'shared_email');assert.equal(graph.relevance.themes[0].name,'Agent Memory');assert.ok(graph.themeSignals.every((signal:any)=>!JSON.stringify(signal).includes('@')));await service.recordRelevanceFeedback({idempotencyKey:'mute-agent',themeId:graph.relevance.themes[0].themeId,action:'mute'});assert.deepEqual((await service.relevance('my'))?.themes,[]);await service.remove('me@example.com');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='me@example.com'").get().n,0);}finally{globalThis.fetch=originalFetch;db.close();}});
test('feedback accepts current opaque graph ids, rejects emails and unknown ids, and allows theme-only actions',async()=>{const {service,db}=fixture();network();try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all');await service.alarm();const graph=await service.graph() as any;await service.recordRelevanceFeedback({idempotencyKey:'opaque-person',themeId:'theme-agent-memory',personId:graph.nodes[0].id,action:'pin'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get().n,1);await assert.rejects(service.recordRelevanceFeedback({idempotencyKey:'raw-email',themeId:'theme-agent-memory',personId:'ada@example.com',action:'mute'}),/invalid_relevance_person/);await assert.rejects(service.recordRelevanceFeedback({idempotencyKey:'unknown-person',themeId:'theme-agent-memory',personId:'opaque-but-not-a-node',action:'mute'}),/invalid_relevance_person/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get().n,1);await service.recordRelevanceFeedback({idempotencyKey:'theme-only',themeId:'theme-agent-memory',action:'mute'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get().n,2);}finally{globalThis.fetch=originalFetch;db.close();}});
test('explicit empty or non-string feedback person ids are rejected without persistence',async()=>{const {service,db}=fixture();network();try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all');await service.alarm();for(const personId of ['', '   ', null, 0, false])await assert.rejects(service.recordRelevanceFeedback({idempotencyKey:`invalid-${String(personId)}`,themeId:'theme-agent-memory',personId,action:'mute'} as any),/invalid_relevance_person/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get().n,0);}finally{globalThis.fetch=originalFetch;db.close();}});
test('pushed feedback validates local graph theme and person ids without accepting Gmail substitutions',async()=>{const {service,db}=fixture();const graph:any={nodes:[{id:'local-ada'}],edges:[],themes:[{id:'theme-local',canonicalName:'agent memory',aliases:['Agent Memory'],description:'Local theme',status:'active'}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note',visibility:'private',observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};try{await service.bindOwner('owner@example.test');await service.recordPushedRelevanceFeedback({idempotencyKey:'local-person-valid',themeId:'theme-local',personId:'local-ada',action:'mute'},graph);assert.deepEqual((await service.relevanceFromPushedGraph(graph,'my')).themes,[]);await assert.rejects(service.recordPushedRelevanceFeedback({idempotencyKey:'foreign-person-no',themeId:'theme-local',personId:'gmail-derived-id',action:'pin'},graph),/invalid_relevance_person/);await assert.rejects(service.recordPushedRelevanceFeedback({idempotencyKey:'foreign-theme-no',themeId:'theme-foreign',action:'pin'},graph),/invalid_relevance_feedback/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get()!.n,1);}finally{db.close();}});
test('OAuth connect state is browser-bound, expiring and single use',async()=>{const {service,db}=fixture();await service.begin('n',{owner:'owner',verifier:'v',cookie:'correct',range:'recent',expires:Date.now()+10000,redirect:'x'});assert.equal(await service.consume('n','wrong'),null);assert.ok(await service.consume('n','correct'));assert.equal(await service.consume('n','correct'),null);db.close();});
test('revoked grants stop retries and request reconnection',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','refresh','all');globalThis.fetch=async()=>Response.json({error:'invalid_grant'},{status:400});await service.alarm();assert.equal(service.list()[0].status,'reconnect');}finally{globalThis.fetch=originalFetch;db.close();}});
test('disconnect during network fetch cannot resurrect imported data',async()=>{const {service,db}=fixture();let release:(r:Response)=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);try{await service.attachAccount('me@example.com','refresh','all');globalThis.fetch=async(input:any)=>{if(String(input).includes('oauth2.googleapis'))return Response.json({access_token:'access'});if(String(input).includes('/messages?'))return Response.json({messages:[{id:'m1'}]});entered();return new Promise<Response>(r=>release=r);};const running=service.alarm();await ready;await service.remove('me@example.com');release(Response.json(msg('m1')));await running;assert.equal(service.list().length,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contributions').get().n,0);}finally{globalThis.fetch=originalFetch;db.close();}});
test('a Granola-only graph before the first sync completes is stamped now, not the epoch',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner@example.test');
 try{
  globalThis.fetch=async(input:any)=>String(input).includes('/v1/folders')?Response.json({folders:[],hasMore:false,cursor:null}):Response.json({notes:[],hasMore:false,cursor:null});
  await service.granolaConnect('grn_fictional_key_123456','all');
  const graph=await service.graph() as any;
  assert.ok(graph,'a Granola connection alone makes a graph');
  assert.ok(Date.parse(graph.pushedAt)>Date.now()-5000,`pushedAt was ${graph.pushedAt}`);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('one alarm runs the Gmail batch and the next one runs the Granola tick',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner@example.test');const granolaCalls:string[]=[];
 try{
  globalThis.fetch=async(input:any)=>{const url=String(input);
   if(url.includes('public-api.granola.ai')){granolaCalls.push(url);
    if(url.includes('/v1/folders'))return Response.json({folders:[{id:'fol_1234567890abcd',name:'Pilot',parent_folder_id:null}],hasMore:false,cursor:null});
    return Response.json({notes:[],hasMore:false,cursor:null});}
   if(url.includes('oauth2.googleapis'))return Response.json({access_token:'access'});
   if(url.includes('/messages?'))return Response.json({messages:[{id:'m1'}]});
   return Response.json(msg('m1'));};
  await service.granolaConnect('grn_fictional_key_123456','all');
  await service.attachAccount('me@example.com','refresh','all');
  granolaCalls.length=0;
  await service.alarm();
  assert.equal(service.list()[0].processed,1,'the Gmail batch ran');
  assert.deepEqual(granolaCalls,[],'Granola does not share the alarm with a Gmail batch');
  await service.alarm();
  assert.ok(granolaCalls.length>0,'the next alarm runs the Granola tick');
  assert.ok(Number(kv.get('alarm'))<=Date.now()+2000,'and that alarm was scheduled straight away');
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('large imports share batches fairly with other inboxes',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','first','all');await service.attachAccount('other@example.com','second','all');globalThis.fetch=async(input:any)=>String(input).includes('oauth2.googleapis')?Response.json({access_token:'access'}):String(input).includes('/messages?')?Response.json({messages:Array.from({length:25},(_,i)=>({id:'m'+i}))}):Response.json(msg('m'));await service.alarm();await service.alarm();assert.deepEqual(service.list().map(a=>a.processed),[10,10]);}finally{globalThis.fetch=originalFetch;db.close();}});
test('canonical messages across inboxes count once and survive one disconnect',async()=>{const {service,db}=fixture();network();try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','first','all');await service.attachAccount('other@example.com','second','all');await service.alarm();await service.alarm();assert.equal(db.prepare("SELECT COUNT(DISTINCT canonical) AS n FROM contributions WHERE email='ada@example.com'").get().n,1);await service.remove('other@example.com');assert.equal((await service.graph() as any).nodes.length,2);}finally{globalThis.fetch=originalFetch;db.close();}});
test('Google contact photos attach by email, page fully, and disappear on disconnect',async()=>{const {service,db}=fixture();let calls=0;try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all',true);globalThis.fetch=async(input:any)=>{const u=String(input);if(u.includes('oauth2.googleapis'))return Response.json({access_token:'access'});if(u.includes('people.googleapis')){calls++;return Response.json({connections:[{emailAddresses:[{value:calls===1?'ADA@example.com':'bo@example.com'}],photos:[{url:'https://lh3.googleusercontent.com/person',default:false}]}],...(calls===1?{nextPageToken:'page2'}:{})});}if(u.includes('/messages?'))return Response.json({messages:[{id:'m1'}]});return Response.json(msg('m1'));};await service.alarm();assert.equal(service.list()[0].status,'syncing');await service.alarm();assert.equal(service.list()[0].status,'connected');assert.equal((await service.graph() as any).nodes.filter((n:any)=>n.photoUrl).length,2);await service.remove('me@example.com');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_photos').get().n,0);}finally{globalThis.fetch=originalFetch;db.close();}});
test('unavailable Contacts API does not block Gmail sync',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','refresh','all',true);network();const mail=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>String(input).includes('people.googleapis')?Response.json({error:{}},{status:403}):mail(input,init);db.prepare('INSERT INTO contact_photos (account,email,url,generation) VALUES (?,?,?,?)').run('me@example.com','ada@example.com','https://lh3.googleusercontent.com/old','old');await service.alarm();assert.equal(service.list()[0].status,'connected');assert.equal(service.list()[0].photoStatus,'unavailable');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_photos').get().n,0);}finally{globalThis.fetch=originalFetch;db.close();}});

test('photo completion reports actual available and matching counts, including zero',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','refresh','all',true);network();const mail=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>String(input).includes('people.googleapis')?Response.json({connections:[]}):mail(input,init);await service.alarm();assert.equal(service.list()[0].photoCount,0);assert.equal(service.list()[0].matchedPhotoCount,0);db.prepare('INSERT INTO contact_photos (account,email,url,generation) VALUES (?,?,?,?)').run('me@example.com','ada@example.com','https://lh3.googleusercontent.com/a','x');db.prepare('INSERT INTO contact_photos (account,email,url,generation) VALUES (?,?,?,?)').run('me@example.com','stranger@example.com','https://lh3.googleusercontent.com/b','x');assert.equal(service.list()[0].photoCount,2);assert.equal(service.list()[0].matchedPhotoCount,1);}finally{globalThis.fetch=originalFetch;db.close();}});

test('other contacts are queried with profile sources after saved contacts finish',async()=>{const {service,db}=fixture();const urls:string[]=[];try{await service.begin('n',{owner:'owner',verifier:'v',cookie:'c',range:'all',expires:Date.now()+10000,redirect:'x'});await service.attachAccount('me@example.com','refresh','all',true,true);network();const mail=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{const u=String(input);if(u.includes('people.googleapis')){urls.push(u);return Response.json(u.includes('/otherContacts')?{otherContacts:[{emailAddresses:[{value:'ada@example.com'}],photos:[{url:'https://lh3.googleusercontent.com/ada',default:false}]}]}:{connections:[]});}return mail(input,init);};await service.alarm();assert.equal(service.list()[0].status,'syncing');await service.alarm();assert.equal(urls.length,2);const u=new URL(urls[1]);assert.ok(u.pathname.endsWith('/otherContacts'));assert.equal(u.searchParams.get('readMask'),'emailAddresses,photos');assert.deepEqual(u.searchParams.getAll('sources'),['READ_SOURCE_TYPE_CONTACT','READ_SOURCE_TYPE_PROFILE']);assert.equal(service.list()[0].photoCount,1);assert.equal((await service.graph() as any).nodes.filter((n:any)=>n.photoUrl).length,1);}finally{globalThis.fetch=originalFetch;db.close();}});

test('Other-only permission imports photos independently',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','refresh','all',false,true);network();const mail=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{if(String(input).includes('people.googleapis')){assert.ok(String(input).includes('otherContacts'));return Response.json({otherContacts:[{emailAddresses:[{value:'ada@example.com'}],photos:[{url:'https://lh3.googleusercontent.com/ada'}]}]});}return mail(input,init);};await service.alarm();assert.equal(service.list()[0].photoCount,1);}finally{globalThis.fetch=originalFetch;db.close();}});
test('Other contacts permission failure preserves successful saved photos',async()=>{const {service,db}=fixture();try{await service.attachAccount('me@example.com','refresh','all',true,true);network();const mail=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>String(input).includes('otherContacts')?Response.json({}, {status:403}):String(input).includes('people.googleapis')?Response.json({connections:[{emailAddresses:[{value:'ada@example.com'}],photos:[{url:'https://lh3.googleusercontent.com/ada'}]}]}):mail(input,init);await service.alarm();await service.alarm();assert.equal(service.list()[0].photoCount,1);assert.equal(service.list()[0].status,'connected');}finally{globalThis.fetch=originalFetch;db.close();}});

test('graph merges Gmail contributions with Granola meetings on one node and one edge set',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','ada@example.com','Ada',Date.parse('2026-07-01T00:00:00Z'),'Hello',1,1);
  db.prepare('INSERT INTO mail_edges VALUES (?,?,?,?,?)').run('me@example.com','m1','ada@example.com','bob@example.com','Hello');
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','bob@example.com','Bob',Date.parse('2026-07-01T00:00:00Z'),'Hello',0,1);
  // Granola rows written directly (tables are created by MailSync's GranolaSync)
  db.prepare("INSERT INTO granola_connection (id,grant,data) VALUES (1,'sealed',?)").run(JSON.stringify({ownerEmail:'me@example.com',status:'connected',range:'all',watermark:'w',lastSync:1,nextSync:9e15,lastReconcile:1,error:'',job:null}));
  db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES ('not_1234567890abcd','Standup',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[]','','','','h',0,'done',NULL,'granola-v1',0,0,0)").run();
  for(const [e,n] of [['me@example.com','Me'],['ada@example.com','Ada L'],['carol@example.com','Carol']])db.prepare('INSERT INTO granola_attendees VALUES (?,?,?)').run('not_1234567890abcd',e,n);
  db.prepare("INSERT INTO granola_edges VALUES ('not_1234567890abcd','ada@example.com','bob@example.com')").run();
  db.prepare("INSERT INTO granola_edges VALUES ('not_1234567890abcd','ada@example.com','carol@example.com')").run();
  const graph=(await service.graph())!;
  assert.equal(graph.scoreModel,'email-meeting-frequency-reciprocity-recency-v2');
  const names=graph.nodes.map((n:any)=>n.name).sort();assert.deepEqual(names,['Ada','Bob','Carol']);// me@ excluded via both Gmail account and Granola owner
  const ada=graph.nodes.find((n:any)=>n.name==='Ada') as any;
  assert.equal(ada.id,await opaque('owner','ada@example.com','identity-key'));assert.equal(ada.meetings,1);assert.equal(ada.lastContact,'2026-08-14T11:00:00.000Z');assert.equal(ada.lastMeeting,'2026-08-14T11:00:00.000Z');
  const carol=graph.nodes.find((n:any)=>n.name==='Carol') as any;assert.equal(carol.meetings,1);assert.ok(carol.strength>0);
  const ab=graph.edges.find((e:any)=>e.source===ada.id&&e.target===graph.nodes.find((n:any)=>n.name==='Bob')!.id) as any;
  assert.deepEqual(ab.types.sort(),['shared_email','shared_meeting']);assert.equal(ab.weight,2);assert.deepEqual(ab.contexts,['Hello','Standup']);
 }finally{db.close();}
});

test('graph enriches Granola theme signals with meeting title, date and note link',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','ada@example.com','Ada',Date.now(),'Hello',1,1);
  const ada=await opaque('owner','ada@example.com','identity-key');
  const note=(id:string,title:string,webUrl:string|null,hidden:number)=>db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,?,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[]','','','','h',0,'done',NULL,'granola-v2',0,?,?)").run(id,title,webUrl,Date.parse('2026-08-16T09:00:00Z'),hidden);
  note('not_1234567890abcd','Pilot sync with Ada','https://notes.granola.ai/d/not_1234567890abcd',0);
  note('not_2234567890abcd','Unlinked meeting',null,0);
  note('not_3234567890abcd','',null,1);
  const now=new Date().toISOString();
  const signal=(id:string,ref:string)=>({id,owner:'owner',account:'granola',personId:ada,themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:now,ingestedAt:now,confidence:.8,summary:'Ask: \u201chi\u201d',evidenceRef:ref,contentHash:'h',extractorVersion:'granola-v2'});
  await (service as any).store().ingest([
   signal('sig-linked','granola-note:not_1234567890abcd#summary@12'),
   signal('sig-plain','granola-note:not_2234567890abcd#private_notes@3'),
   signal('sig-hidden','granola-note:not_3234567890abcd#topic@research'),
   signal('sig-unknown','granola-note:not_9999999999abcd#summary@1'),
  ]);
  const graph=(await service.graph())!;
  const by=new Map(graph.themeSignals.map((s:any)=>[s.id,s]));
  assert.deepEqual((by.get('sig-linked') as any).provenance,{canonicalUrl:'https://notes.granola.ai/d/not_1234567890abcd',publisherHost:'granola.ai',observedAt:'2026-08-14T11:00:00Z',retrievedAt:'2026-08-16T09:00:00.000Z',timeBasis:'observed',title:'Pilot sync with Ada'});
  assert.equal((by.get('sig-plain') as any).provenance.canonicalUrl,'https://granola.ai/');
  assert.equal((by.get('sig-plain') as any).provenance.title,'Unlinked meeting');
  // Hidden notes carry no title or url, and an unknown note id stays an opaque reference.
  assert.equal((by.get('sig-hidden') as any).provenance,undefined);
  assert.equal((by.get('sig-unknown') as any).provenance,undefined);
 }finally{db.close();}
});

test('graph exists with Granola alone, and alarm runs a Granola tick and schedules it',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  globalThis.fetch=(async(input:any)=>{const url=String(input);if(url.includes('/v1/folders'))return Response.json({folders:[],hasMore:false,cursor:null});if(url.includes('/v1/notes'))return Response.json({notes:[],hasMore:false,cursor:null});return new Response('{}',{status:500});}) as typeof fetch;
  const status=await service.granolaConnect('grn_fictional_key_123456','all');
  assert.equal(status.status,'syncing');assert.ok(typeof kv.get('alarm')==='number');
  for(let i=0;i<6&&service.granolaStatus().status==='syncing';i++)await service.alarm();
  assert.equal(service.granolaStatus().status,'connected');
  assert.ok((await service.graph())!==null);
  assert.ok((kv.get('alarm') as number)>Date.now()+3_000_000);
  await service.granolaDisconnect();
  assert.equal(service.granolaStatus().connected,false);
 }finally{globalThis.fetch=originalFetch;db.close();}
});

test('graph drops theme signals and relevance members whose person is not a node',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','ada@example.com','Ada',Date.now(),'Hello',1,1);
  const ada=await opaque('owner','ada@example.com','identity-key'),me=await opaque('owner','me@example.com','identity-key');
  const now=new Date().toISOString();
  const signal=(id:string,personId:string)=>({id,owner:'owner',account:'granola',personId,themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:now,ingestedAt:now,confidence:.8,summary:'Ask: “hi”',evidenceRef:`granola-note:not_1234567890abcd#summary@${id.length}`,contentHash:'h',extractorVersion:'granola-v1'});
  await (service as any).store().ingest([signal('sig-ada',ada),signal('sig-me',me)]);
  const graph=(await service.graph())!;
  const nodeIds=new Set(graph.nodes.map((n:any)=>n.id));
  assert.ok(nodeIds.has(ada));assert.ok(!nodeIds.has(me));
  assert.deepEqual(graph.themeSignals.map((s:any)=>s.id),['sig-ada']);
  for(const theme of graph.relevance.themes){for(const id of theme.nodeIds)assert.ok(nodeIds.has(id),'relevance theme nodeIds must be graph nodes');for(const c of theme.components)assert.notEqual(c.signalId,'sig-me');}
 }finally{db.close();}
});

test('draftNote resolves the person, sends the eight newest signals and never another person’s evidence',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 const ai=new FakeAI({response:{subject:'Following up on the fintech intro',body:'Hi Ada, you mentioned wanting an intro to a fintech founder. Happy to make it this week.'}});
 Object.assign((service as any).env,{AI:ai,THEME_MODEL:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'});
 try{
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1','ada@example.com','Ada',Date.parse('2026-09-01T00:00:00Z'),'Hello',1,1);
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m2','bob@example.com','Bob',Date.parse('2026-09-01T00:00:00Z'),'Hello',1,1);
  const ada=await opaque('owner','ada@example.com','identity-key'),bob=await opaque('owner','bob@example.com','identity-key');
  db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES ('not_1234567890abcd','Pilot sync with Ada',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[]','SECRET SUMMARY','SECRET NOTES','SECRET TRANSCRIPT','h',0,'done',NULL,'granola-v2',0,0,0)").run();
  const now=new Date().toISOString();
  const signal=(id:string,personId:string,day:number,ref:string)=>({id,owner:'owner',account:'granola',personId,themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:`2026-09-${String(day).padStart(2,'0')}T11:00:00.000Z`,ingestedAt:now,confidence:.8,summary:`Ask: “quote ${day}”`,evidenceRef:ref,contentHash:id,extractorVersion:'granola-v2'});
  await (service as any).store().ingest([
   ...Array.from({length:10},(_,i)=>signal(`sig-ada-${i}`,ada,i+1,`granola-note:not_1234567890abcd#summary@${i}`)),
   signal('sig-bob',bob,20,'granola-note:not_1234567890abcd#summary@99'),
  ]);
  const value=await service.draftNote(ada);
  assert.equal(value.to,'ada@example.com');
  assert.equal(value.name,'Ada');
  assert.equal(value.subject,'Following up on the fintech intro');
  assert.match(value.body,/^Hi Ada/);
  assert.deepEqual(value.basedOn.map((item:any)=>item.summary),[10,9,8,7,6,5,4,3].map(day=>`Ask: “quote ${day}”`));
  assert.equal(value.basedOn.length,8);
  assert.equal(value.basedOn[0].title,'Pilot sync with Ada');
  assert.equal(value.checked,false,'no TYPESAFE_API_KEY means the draft is never checked');
  assert.deepEqual(value.warnings,[]);
  const sent=JSON.stringify(ai.calls[0].input);
  assert.ok(!sent.includes('SECRET'),'note bodies, notes and transcripts never reach the model');
  assert.ok(!sent.includes('quote 20'),'another person’s evidence never reaches the model');
  assert.ok(!sent.includes('ada@example.com'),'the contact email never reaches the model');
  await assert.rejects(service.draftNote(await opaque('owner','nobody@example.com','identity-key')),/unknown_person/);
  await assert.rejects(service.draftNote(''),/unknown_person/);
 }finally{db.close();}
});

test('draftNote never hands back a contact email that could inject mailto: headers',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 const ai=new FakeAI({response:{subject:'Following up',body:'Hi, following up.'}});
 Object.assign((service as any).env,{AI:ai,THEME_MODEL:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'});
 try{
  const victim='victim?bcc=attacker@evil.test';
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','m1',victim,'Victim',Date.now(),'Hello',1,1);
  const personId=await opaque('owner',victim,'identity-key');
  const value=await service.draftNote(personId);
  assert.equal(value.to,null,'a mailto-unsafe stored email is withheld, not passed through');
 }finally{db.close();}
});

test('draftNote checks a clean draft with Jev and reports checked:true with no warnings',async()=>{
 const {service,db,ai,ada}=await draftFixture();
 Object.assign((service as any).env,{TYPESAFE_API_KEY:JEV_KEY});
 try{
  const jev=jevServer((id)=>{
   if(id==='unsupported')return noulA(0.1);
   if(id==='toneOk')return noulA(0.9);
   if(id==='asksForMoneyOrSecrets')return noulA(0.05);
   throw Error('unexpected question id '+id);
  });
  const value=await withFetch(jev.fake,()=>service.draftNote(ada));
  assert.equal(value.checked,true);
  assert.deepEqual(value.warnings,[]);
  assert.equal(ai.calls.length,1,'a clean draft is never regenerated');
  assert.equal(jev.requests.length,1);
 }finally{db.close();}
});

test('draftNote reports a tone warning without regenerating, since only unsupported or money triggers a rewrite',async()=>{
 const {service,db,ai,ada}=await draftFixture();
 Object.assign((service as any).env,{TYPESAFE_API_KEY:JEV_KEY});
 try{
  const jev=jevServer((id)=>{
   if(id==='unsupported')return noulA(0.1);
   if(id==='toneOk')return noulA(0.2);
   if(id==='asksForMoneyOrSecrets')return noulA(0.1);
   throw Error('unexpected question id '+id);
  });
  const value=await withFetch(jev.fake,()=>service.draftNote(ada));
  assert.equal(value.checked,true);
  assert.deepEqual(value.warnings,['This draft may read as too blunt or off-tone.']);
  assert.equal(ai.calls.length,1);
 }finally{db.close();}
});

test('draftNote regenerates once when unsupported or money-asking, then re-checks the rewrite',async()=>{
 const {service,db,ai,ada}=await draftFixture();
 Object.assign((service as any).env,{TYPESAFE_API_KEY:JEV_KEY});
 try{
  let firstCheckDone=false;
  const jev=jevServer((id)=>{
   if(id==='unsupported')return noulA(firstCheckDone?0.1:0.9);
   if(id==='toneOk')return noulA(0.9);
   if(id==='asksForMoneyOrSecrets'){const answer=noulA(0.1);firstCheckDone=true;return answer;}
   throw Error('unexpected question id '+id);
  });
  const value=await withFetch(jev.fake,()=>service.draftNote(ada));
  assert.equal(value.checked,true);
  assert.deepEqual(value.warnings,[]);
  assert.equal(ai.calls.length,2,'composeDraft is called once more to regenerate');
  const regenerateSystem=ai.calls[1].input.messages[0].content as string;
  assert.ok(regenerateSystem.includes('Only mention items present in the evidence. Do not ask for money or credentials.'));
  assert.equal(jev.requests.length,2);
 }finally{db.close();}
});

test('draftNote falls back to the unchecked draft when Jev fails, with no user-facing error',async()=>{
 const {service,db,ai,ada}=await draftFixture();
 Object.assign((service as any).env,{TYPESAFE_API_KEY:JEV_KEY});
 try{
  const unauthorized=(async()=>new Response('{"error":"no"}',{status:401})) as typeof fetch;
  const value=await withFetch(unauthorized,()=>service.draftNote(ada));
  assert.equal(value.checked,false);
  assert.deepEqual(value.warnings,[]);
  assert.equal(value.subject,'Following up');
  assert.equal(value.body,'Hi Ada, good to see you.');
  assert.equal(ai.calls.length,1,'the draft is never regenerated when the check itself fails');
 }finally{db.close();}
});
