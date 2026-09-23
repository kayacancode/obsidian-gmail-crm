import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {previewPublicSource,fetchPublicSource} from '../src/public-sources';
import {MailSync} from '../src/mail-sync';
import {RelevanceStore} from '../src/relevance-store';
import {FakeAI} from './worker-stub';
import {opaque} from '../src/mail-model';

const originalFetch=globalThis.fetch;
const url='https://example.com/feed.xml';
const article='RAW PUBLIC CANARY about agent memory';
function network(reply:(url:string,init:RequestInit)=>Response|Promise<Response>){
 return (async(input:any,init:RequestInit={})=>{
  const target=String(input);
  if(target.startsWith('https://cloudflare-dns.com/dns-query?'))return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
  return reply(target,init);
 }) as typeof fetch;
}
function fixture(owner='owner-a'){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>([['owner',owner]]),ai=new FakeAI();
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')||sql.includes('CREATE INDEX')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=/^SELECT/i.test(sql)?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},deleteAlarm:async()=>{kv.delete('alarm');},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const env={TOKEN_SECRET:'identity-key',GOOGLE_CLIENT_ID:'client',AI:ai,THEME_MODEL:'@cf/meta/llama-3.3-70b-instruct-fp8-fast'};
 return {db,kv,ctx,ai,env,service:new MailSync(ctx as any,env as any)};
}
function dump(db:DatabaseSync){return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r:any)=>db.prepare(`SELECT * FROM "${r.name}"`).all()));}
async function confirm(service:MailSync,key='confirm',target=url,extra={}){return service.confirmPublicSource({url:target,idempotencyKey:key,...extra});}

for(const graphSource of ['mail','obsidian'] as const)test(`final wave public provenance survives reload in ${graphSource} graph and evidence`,async()=>{
 const {service,db,ctx,env}=fixture();const graph={nodes:[{id:'local-person'}],edges:[],themes:[],themeSignals:[]};
 (env as any).DB={prepare(){return {bind(){return this;},async first(){return {json:JSON.stringify(graph)};}};}};
 globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+100000}));
  db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','canonical','ada@example.com','Ada',Date.now(),'Topic',1,1);
  const personId=graphSource==='obsidian'?'local-person':await opaque('owner-a','ada@example.com','identity-key');
  const source=await confirm(service,'provenance',url,{graphSource,personId});await service.alarm();
  const reloaded=new MailSync(ctx as any,env as any);
  const attached=(graphSource==='obsidian'?await reloaded.augmentPushedGraph(graph,'public'):await reloaded.graph())!;
  const signal=attached.themeSignals[0];
  assert.equal(signal.provenance?.canonicalUrl,url);assert.equal(signal.provenance?.publisherHost,'example.com');
  assert.equal(signal.provenance?.observedAt,signal.observedAt);assert.equal(signal.provenance?.retrievedAt,signal.ingestedAt);assert.equal(signal.provenance?.timeBasis,'observed');
  const evidence=graphSource==='obsidian'?await reloaded.evidenceFromPushedGraph(graph,signal.themeId,'public'):await reloaded.evidence(signal.themeId,'public');
  assert.deepEqual(evidence.signals[0].provenance,signal.provenance);
  const hidden=graphSource==='obsidian'?await reloaded.evidenceFromPushedGraph(graph,signal.themeId,'firm'):await reloaded.evidence(signal.themeId,'firm');assert.equal(hidden.signals.length,0);
  assert.equal(await reloaded.publicSourceStatus(source.id,graphSource==='mail'?'obsidian':'mail'),null);
  assert.doesNotMatch(JSON.stringify(attached)+JSON.stringify(evidence),/RAW PUBLIC CANARY|prompt_text/);
 }finally{globalThis.fetch=originalFetch;db.close();}
});

test('public Obsidian source uses current owner graph, joins pushed evidence and stays outside Gmail',async()=>{
 const {service,db,env}=fixture();
 let graph={nodes:[{id:'local-ada',type:'person'}],edges:[],themes:[],themeSignals:[]};
 const reads:string[]=[];
 (env as any).DB={prepare(){return {bind(owner:string){reads.push(owner);return this;},async first(){return {json:JSON.stringify(graph)};}};}};
 globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{
  const preview=await service.previewPublicSource({url,personId:'local-ada',graphSource:'obsidian'} as any);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM public_sources').get()!.n,0);
  const source=await confirm(service,'local',preview.canonicalUrl,{personId:'local-ada',graphSource:'obsidian'});
  assert.equal(JSON.parse(String(db.prepare('SELECT data FROM public_sources').get()!.data)).graphSource,'obsidian');
  await service.alarm();
  assert.equal((await service.publicSourceStatus(source.id,'obsidian'))!.status,'complete');
  assert.equal(await service.publicSourceStatus(source.id,'mail'),null);
  const attached=await service.augmentPushedGraph(graph,'public');
  assert.equal(attached.themeSignals.length,1);
  assert.equal((attached.themeSignals[0] as any).modelId,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(attached.relevance.themes[0].nodeIds[0],'local-ada');
  const themeId=attached.themes[0].id;
  assert.equal((await service.evidenceFromPushedGraph(graph,themeId,'public')).signals.length,1);
  await service.recordPushedRelevanceFeedback({themeId,action:'pin',idempotencyKey:'pin-public'},graph);
  assert.equal((await service.relevance('public')).themes.length,0);
  graph={...graph,nodes:[]};
  assert.equal((await service.augmentPushedGraph(graph,'public')).themeSignals.length,0);
  assert.equal(await service.publicSourceStatus(source.id,'obsidian'),null);
  assert.ok(reads.length>=4);assert.ok(reads.every(owner=>owner==='owner-a'));
 }finally{globalThis.fetch=originalFetch;db.close();}
});

test('public Obsidian membership removed during extraction cannot commit',async()=>{
 const {service,db,env,ai}=fixture();let nodes=[{id:'local-ada'}];
 (env as any).DB={prepare(){return {bind(){return this;},async first(){return {json:JSON.stringify({nodes,edges:[],themes:[],themeSignals:[]})};}};}};
 globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 ai.run=async()=>{nodes=[];return {response:{themes:[{topicId:'agent_memory',confidence:1}]}};};
 try{await confirm(service,'local',url,{personId:'local-ada',graphSource:'obsidian'});await service.alarm();assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);assert.equal(db.prepare('SELECT status FROM public_sources').get()!.status,'failed');}
 finally{globalThis.fetch=originalFetch;db.close();}
});

for(const target of ['file:///tmp/x','ftp://example.com','https://user:pass@example.com','https://@example.com','https://example.com/#x','https://example.com/#','https://localhost','http://host.local/x','http://localhost.example','http://intranet','http://example.com:0','http://example.com:65536','http://example.com:8080','http://127.0.0.1','http://10.2.3.4','http://172.16.1.2','http://192.168.1.1','http://169.254.169.254','http://100.64.0.1','http://192.0.2.1','http://198.51.100.1','http://203.0.113.1','http://198.18.1.1','http://224.0.0.1','http://240.0.0.1','http://0.0.0.0','http://2130706433','http://0177.0.0.1','http://0x7f000001','http://127.1','http://[::1]','http://[::ffff:127.0.0.1]','http://[2001:db8::1]','http://[2606:4700::1111]','http://93.184.216.34','https://example.com\\@127.0.0.1','https://%65xample.com','https://example.com\n']){
 test(`public rejects unsafe source ${target}`,async()=>assert.rejects(previewPublicSource(target),{message:'unsafe_public_source'}));
}
test('public preview canonicalizes without fetching or persisting',async()=>{
 const {service,db,kv}=fixture();globalThis.fetch=async()=>{throw Error('unexpected_fetch');};
 try{const before=dump(db);const result=await service.previewPublicSource({url:'HTTPS://EXAMPLE.COM:443/a/../feed.xml'});assert.equal(result.canonicalUrl,url);assert.equal(result.publisherHost,'example.com');assert.equal(result.visibility,'public');assert.equal(dump(db),before);assert.equal(kv.has('alarm'),false);assert.ok(!JSON.stringify(result).includes(article));}finally{globalThis.fetch=originalFetch;db.close();}
});
test('public retrieval allows three validated manual redirects and sends no sensitive headers',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const result=await fetchPublicSource(url,network((u,init)=>{calls.push({url:u,init});return calls.length<4?new Response(null,{status:302,headers:{location:`https://publisher.example/hop${calls.length}`}}):new Response('<html><body><p>Agent memory research</p><script>TRACKER</script><style>CSS</style><div hidden>HIDDEN</div></body></html>',{headers:{'content-type':'text/html'}});}));
 assert.equal(calls.length,4);assert.equal(result.visibility,'public');assert.equal(result.canonicalUrl,url);assert.equal(result.publisherHost,'publisher.example');assert.match(result.text,/Agent memory research/);assert.doesNotMatch(result.text,/TRACKER|CSS|HIDDEN|<|>/);
 for(const call of calls){assert.equal(call.init.redirect,'manual');assert.equal(call.init.credentials,'omit');const h=new Headers(call.init.headers);for(const key of ['authorization','cookie','referer','proxy-authorization'])assert.equal(h.has(key),false);}
});
test('public unsafe redirects and a fourth redirect fail before the target is fetched',async()=>{
 for(const location of ['http://169.254.169.254/','https://user:pass@example.com','file:///x']){let n=0;await assert.rejects(fetchPublicSource(url,network(()=>{n++;return new Response(null,{status:302,headers:{location}});})),{message:'unsafe_public_source'});assert.equal(n,1);}
 let n=0;await assert.rejects(fetchPublicSource(url,network(()=>{n++;return new Response(null,{status:302,headers:{location:'/again'}});})),{message:'public_redirect_limit'});assert.equal(n,4);
});
test('public DNS checks reject private answers, unsafe aliases, unavailable and mixed answers before source fetch',async()=>{
 for(const dns of [{Status:0,Answer:[{type:1,data:'127.0.0.1'}]},{Status:0,Answer:[{type:1,data:'93.184.216.34'},{type:28,data:'::ffff:127.0.0.1'}]},{Status:0,Answer:[{type:5,data:'internal.local.'},{type:1,data:'93.184.216.34'}]},{Status:2},{Status:0,Answer:[]}]){let sourceCalls=0;await assert.rejects(fetchPublicSource(url,(async(input:any)=>{if(!String(input).startsWith('https://cloudflare-dns.com/'))sourceCalls++;return Response.json(dns);}) as typeof fetch),/unsafe_public_source|public_dns_failed/);assert.equal(sourceCalls,0);}
});
test('public accepts only HTML text RSS Atom and rejects unsupported or malformed bodies',async()=>{
 for(const type of ['application/json','application/pdf','image/svg+xml','application/xml',''])await assert.rejects(fetchPublicSource(url,network(()=>new Response('SECRET ERROR',{headers:{'content-type':type}}))),{message:'public_content_type'});
 for(const body of ['<html><script>UNCLOSED','<html><body><div hidden>SECRET</body>VISIBLE','<rss><channel><item><title>bad</item></channel></rss>','<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///x">]><rss/>'])await assert.rejects(fetchPublicSource(url,network(()=>new Response(body,{headers:{'content-type':body.includes('rss')?'application/rss+xml':'text/html'}}))),{message:'public_parse_failed'});
});
test('public streaming counts actual bytes, cancels before decoding overflow, and rejects invalid UTF-8',async()=>{
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(999_999).fill(65));c.enqueue(new Uint8Array(2).fill(66));},cancel(){cancelled=true;}});
 await assert.rejects(fetchPublicSource(url,network(()=>new Response(stream,{headers:{'content-type':'text/plain','content-length':'1'}}))),{message:'public_too_large'});assert.equal(cancelled,true);
 const exact=await fetchPublicSource(url,network(()=>new Response('a'.repeat(1_000_000),{headers:{'content-type':'text/plain'}})));assert.equal(exact.textBytes,1_000_000);
 await assert.rejects(fetchPublicSource(url,network(()=>new Response(new Uint8Array([255]),{headers:{'content-type':'text/plain'}}))),{message:'public_parse_failed'});
});
test('public RSS and Atom use bounded item fields and observed time for untrusted publisher dates',async()=>{
 for(const [type,body] of [['application/rss+xml','<rss><channel><title>Publisher</title><item><title>Agent memory</title><description>&lt;b&gt;Research summary&lt;/b&gt;</description><pubDate>Mon, 14 Sep 2026 12:00:00 GMT</pubDate><link>https://example.com/item</link><author>HIDDEN AUTHOR</author></item></channel></rss>'],['application/atom+xml','<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Agent memory</title><summary>Research summary</summary><published>2999-01-01T00:00:00Z</published><link href="https://example.com/item"/><content>HIDDEN CONTENT</content></entry></feed>']]){
  const result=await fetchPublicSource(url,network(()=>new Response(body,{headers:{'content-type':type}})));assert.equal(result.sourceType,'public_feed');assert.match(result.text,/Agent memory/);assert.match(result.text,/Research summary/);assert.doesNotMatch(result.text,/HIDDEN|<b>/);assert.equal(result.timeBasis,'observed');assert.ok(Date.parse(result.observedAt)<=Date.now());
 }
});
test('public timeout covers stalled redirects and stalled body read even when transport ignores abort',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const body of [false,true]){let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const run=fetchPublicSource(url,network(()=>{entered();return body?new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/plain'}}):new Promise(()=>{});}));const check=assert.rejects(run,{message:'public_timeout'});await ready;await new Promise<void>(r=>process.nextTick(r));t.mock.timers.tick(20_001);await check;}
});
test('public confirm validates optional owner graph person IDs, rejects falsy values and queues only explicit consent',async()=>{
 const {service,db,kv}=fixture();globalThis.fetch=async()=>{throw Error('unexpected_fetch');};
 try{for(const personId of ['',null,false,0,{},'ada@example.com','unknown'])await assert.rejects(confirm(service,'bad',url,{personId}),{message:'invalid_relevance_person'});
 const id=await opaque('owner-a','ada@example.com','identity-key');db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',status:'error',lastSync:Date.now()}));db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','msg','ada@example.com','Ada',Date.now(),'Subject',1,1);
 const first=await confirm(service,'valid',url,{personId:id,visibility:'private'});assert.equal(first.personId,id);assert.equal(first.visibility,'public');assert.equal(first.status,'queued');assert.equal(db.prepare('SELECT COUNT(*) n FROM public_sources').get()!.n,1);assert.ok(kv.get('alarm'));assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);
 const again=await confirm(service,'valid',url,{personId:id});assert.equal(again.id,first.id);await assert.rejects(confirm(service,'valid','https://other.example/feed',{personId:id}),{message:'public_source_conflict'});
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('public assertions are vocabulary-owned, public only, owner/source/hash/version idempotent and never store content',async()=>{
 const {service,db,ai,kv}=fixture();globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain',etag:'"one"','last-modified':'Mon, 14 Sep 2026 12:00:00 GMT'}}));
 try{const source=await confirm(service);await service.alarm();const rows=db.prepare('SELECT * FROM theme_signals').all() as any[];assert.equal(rows.length,1);assert.equal(rows[0].visibility,'public');assert.equal(rows[0].summary,'Activity involving agent memory systems');assert.ok(!dump(db).includes(article));assert.ok(!JSON.stringify(await service.publicSourceStatus(source.id)).includes(article));assert.equal(kv.has('alarm'),false);
 await confirm(service,'refresh');await service.alarm();assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,1);assert.equal(ai.calls.length,1);
 await confirm(service,'different','https://other.example/feed');await service.alarm();assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM theme_signals WHERE visibility<>'public'").get()!.n,0);
 assert.equal((await service.relevance('public'))!.themes.length,1);
 assert.equal((await service.relevance('public'))!.themes[0].components.length,2);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('public conditional 304 and failed refresh preserve last successful signal timestamps and checkpoints',async()=>{
 const {service,db}=fixture();globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain',etag:'"one"','last-modified':'Mon, 14 Sep 2026 12:00:00 GMT'}}));
 try{const source=await confirm(service);await service.alarm();const before=db.prepare('SELECT * FROM theme_signals').all();const initial=await service.publicSourceStatus(source.id);
 globalThis.fetch=network((_url,init)=>{const h=new Headers(init.headers);assert.equal(h.get('if-none-match'),'"one"');assert.equal(h.get('if-modified-since'),'Mon, 14 Sep 2026 12:00:00 GMT');return new Response(null,{status:304});});await confirm(service,'refresh304');await service.alarm();assert.deepEqual(db.prepare('SELECT * FROM theme_signals').all(),before);
 globalThis.fetch=network(()=>{throw Error('RAW ERROR URL TOKEN');});await confirm(service,'refreshfail');await service.alarm();assert.deepEqual(db.prepare('SELECT * FROM theme_signals').all(),before);const failed=await service.publicSourceStatus(source.id);assert.equal(failed!.status,'failed');assert.equal(failed!.contentHash,initial!.contentHash);assert.equal(failed!.observedAt,initial!.observedAt);assert.equal(failed!.error,'public_fetch_failed');assert.ok(!dump(db).includes('RAW ERROR'));
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('public invalid extraction never persists model-selected display text',async()=>{
 const {service,db,ai}=fixture();ai.response={response:{themes:[{topicId:'raw_public_secret',confidence:1,summary:article}]}};globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{const source=await confirm(service);await service.alarm();assert.equal((await service.publicSourceStatus(source.id))!.status,'failed');assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);assert.ok(!dump(db).includes(article));}finally{globalThis.fetch=originalFetch;db.close();}
});
test('public extraction deadline releases the active claim and rejects late output',async(t)=>{
 const {service,db,ai,kv}=fixture();let entered!:()=>void,release!:(value:any)=>void;const ready=new Promise<void>(r=>entered=r);ai.run=async()=>{entered();return new Promise(r=>release=r);};globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));t.mock.timers.enable({apis:['setTimeout']});
 try{const source=await confirm(service);const run=service.alarm();await ready;await service.alarm();t.mock.timers.tick(20_001);await run;assert.equal((await service.publicSourceStatus(source.id))!.error,'public_timeout');release({response:{themes:[{topicId:'agent_memory',confidence:1}]}});await new Promise<void>(r=>process.nextTick(r));assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);assert.equal(kv.has('alarm'),false);}finally{globalThis.fetch=originalFetch;db.close();}
});
test('public removal fences in-flight output, cleans only its source, and does not wake idle objects',async()=>{
 const {service,db,ai,kv,ctx}=fixture();globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{const keep=await confirm(service,'keep','https://other.example/feed');await service.alarm();let entered!:()=>void,release!:(value:any)=>void;const ready=new Promise<void>(r=>entered=r);ai.run=async()=>{entered();return new Promise(r=>release=r);};const source=await confirm(service,'remove');const run=service.alarm();await ready;await service.removePublicSource(source.id);release({response:{themes:[{topicId:'agent_memory',confidence:1}]}});await run;assert.equal(await service.publicSourceStatus(source.id),null);assert.equal((await service.publicSourceStatus(keep.id))!.status,'complete');assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,1);assert.equal(kv.has('alarm'),false);
 const other=new RelevanceStore(ctx as any,async()=> 'owner-b');assert.equal(await other.nextAlarmAt(),undefined);await other.removePublicSource(keep.id);assert.equal((await service.publicSourceStatus(keep.id))!.status,'complete');
 }finally{globalThis.fetch=originalFetch;db.close();}
});
test('public source and Gmail retrieval jobs share the earliest alarm without replacing earlier work',async()=>{
 const {service,db,kv,ctx}=fixture();
 try{const due=Date.now()-1;db.prepare('INSERT INTO retrieval_jobs (id,owner,due_at,status,idempotency_key) VALUES (?,?,?,?,?)').run('gmail-job','owner-a',due,'queued','gmail-key');await confirm(service);assert.equal(kv.get('alarm'),due);const store=new RelevanceStore(ctx as any,async()=> 'owner-a');assert.equal(await store.nextAlarmAt(due-100),due-100);}finally{db.close();}
});
test('public HTML cannot reveal content hidden by encoded inline style attributes',async()=>{
 const result=await fetchPublicSource(url,network(()=>new Response('<html><body><div style="display&#58;none">HIDDEN CANARY</div><p>Visible agent memory</p></body></html>',{headers:{'content-type':'text/html'}})));
 assert.doesNotMatch(result.text,/HIDDEN/);assert.match(result.text,/Visible agent memory/);
});
test('public malformed XML attributes and undeclared entities fail closed',async()=>{
 for(const body of ['<rss><channel><item><title broken=>HIDDEN</title></item></channel></rss>','<rss><channel><item><title>&secret;</title></item></channel></rss>'])await assert.rejects(fetchPublicSource(url,network(()=>new Response(body,{headers:{'content-type':'application/rss+xml'}}))),{message:'public_parse_failed'});
});
test('public response errors are cancelled and unsupported charset is rejected',async()=>{
 let cancelled=false;await assert.rejects(fetchPublicSource(url,network(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403}))),{message:'public_fetch_failed'});assert.equal(cancelled,true);
 await assert.rejects(fetchPublicSource(url,network(()=>new Response('text',{headers:{'content-type':'text/plain; charset=iso-8859-1'}}))),{message:'public_content_type'});
});
test('public restored abandoned claims complete once and concurrent confirmations share one source',async()=>{
 const {service,db,ctx,env}=fixture();globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{const [a,b]=await Promise.all([confirm(service,'concurrent'),confirm(service,'concurrent')]);assert.equal(a.id,b.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM public_sources').get()!.n,1);const row=db.prepare('SELECT data FROM public_sources WHERE id=?').get(a.id) as any;const state=JSON.parse(row.data);state.status='running';state.generation='abandoned';state.dueAt=Date.now()-1;db.prepare('UPDATE public_sources SET status=?,due_at=?,data=? WHERE id=?').run(state.status,state.dueAt,JSON.stringify(state),a.id);const resumed=new MailSync(ctx as any,env as any);await resumed.alarm();await resumed.alarm();assert.equal((await resumed.publicSourceStatus(a.id))!.status,'complete');assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,1);}finally{globalThis.fetch=originalFetch;db.close();}
});
test('public transaction failure preserves durable successful checkpoints and previously committed assertions',async()=>{
 const {service,db}=fixture();globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{const source=await confirm(service);await service.alarm();const initial=await service.publicSourceStatus(source.id);const before=db.prepare('SELECT * FROM theme_signals').all();db.exec("CREATE TRIGGER fail_public BEFORE INSERT ON theme_signals WHEN NEW.source_type='public_url' BEGIN SELECT RAISE(ABORT, 'RAW_ERROR'); END");globalThis.fetch=network(()=>new Response(article+' new revision',{headers:{'content-type':'text/plain'}}));await confirm(service,'rollback');await service.alarm();const failed=await service.publicSourceStatus(source.id);assert.equal(failed!.status,'failed');assert.equal(failed!.contentHash,initial!.contentHash);assert.equal(failed!.assertions,initial!.assertions);assert.equal(failed!.textBytes,initial!.textBytes);assert.deepEqual(db.prepare('SELECT * FROM theme_signals').all(),before);assert.ok(!dump(db).includes('RAW_ERROR'));}finally{globalThis.fetch=originalFetch;db.close();}
});
test('public DNS safety is rechecked after each redirect and validators never cross publishers',async()=>{
 let sources=0;
 await assert.rejects(fetchPublicSource(url,(async(input:any)=>{const u=new URL(String(input));if(u.hostname==='cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:u.searchParams.get('name')==='example.com'?'93.184.216.34':'10.0.0.1'}]});sources++;return new Response(null,{status:302,headers:{location:'https://other.example'}});}) as typeof fetch),{message:'unsafe_public_source'});assert.equal(sources,1);
 await fetchPublicSource(url,network((target,init)=>{const h=new Headers(init.headers);if(target===url){assert.equal(h.get('if-none-match'),'"one"');return new Response(null,{status:302,headers:{location:'https://other.example'}});}assert.equal(h.has('if-none-match'),false);assert.equal(h.has('if-modified-since'),false);return new Response('text',{headers:{'content-type':'text/plain'}});}),{publisherHost:'example.com',etag:'"one"',lastModified:'Mon, 14 Sep 2026 12:00:00 GMT',contentHash:'hash'});
});
test('public storage boundary forces public visibility and rejects foreign owner state',async()=>{
 const {service,ctx,db}=fixture();
 try{const source=await confirm(service);const store=new RelevanceStore(ctx as any,async()=> 'owner-a');const state=store.publicSource('owner-a',source.id)!;store.savePublicSource({...state,visibility:'private' as any});assert.equal(store.publicSource('owner-a',source.id)!.visibility,'public');await assert.rejects(store.queuePublicSource({...state,owner:'owner-b'},'foreign'),{message:'public_source_conflict'});}finally{db.close();}
});
test('public elapsed deadline cannot commit while the event-loop timeout callback is delayed',async()=>{
 const {service,db,ai}=fixture(),originalNow=Date.now;globalThis.fetch=network(()=>new Response(article,{headers:{'content-type':'text/plain'}}));
 try{const source=await confirm(service);const started=originalNow();ai.run=async()=>{Date.now=()=>started+20_001;return {response:{themes:[{topicId:'agent_memory',confidence:1}]}};};await service.alarm();assert.equal((await service.publicSourceStatus(source.id))!.error,'public_timeout');assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);}finally{Date.now=originalNow;globalThis.fetch=originalFetch;db.close();}
});
for(const [name,body] of [['hidden div','<html><body><div hidden/>HIDDEN_CANARY</body></html>'],['template','<html><body><template/>TEMPLATE_CANARY</body></html>']]){
 test(`public round1 rejects self-closing non-void ${name} before extraction`,async()=>{
  const {service,db,ai}=fixture();globalThis.fetch=network(()=>new Response(body,{headers:{'content-type':'text/html'}}));
  try{const source=await confirm(service);await service.alarm();assert.equal((await service.publicSourceStatus(source.id))!.error,'public_parse_failed');assert.equal(ai.calls.length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);assert.doesNotMatch(dump(db),/HIDDEN_CANARY|TEMPLATE_CANARY/);}finally{globalThis.fetch=originalFetch;db.close();}
 });
}
test('public round1 standard void elements remain valid with self-closing syntax',async()=>{
 const result=await fetchPublicSource(url,network(()=>new Response('<html><body><p>Agent<br/>memory<img src="tracking.gif"/> research</p></body></html>',{headers:{'content-type':'text/html'}})));assert.equal(result.text,'Agent memory research');
});
for(const fail of [false,true])test(`public round1 fresh confirmations during ${fail?'failed':'successful'} execution coalesce into one later conditional refresh`,async()=>{
 const {service,db,ai,kv,ctx,env}=fixture();let entered!:()=>void,release!:(value:any)=>void,running:Promise<void>|undefined;const ready=new Promise<void>(r=>entered=r);let extracting=false,calls=0;
 const alarmDecisions:number[]=[];const setAlarm=ctx.storage.setAlarm;ctx.storage.setAlarm=async(n:number)=>{alarmDecisions.push(n);await setAlarm(n);};
 globalThis.fetch=network((_u,init)=>{assert.equal(extracting,false,'refresh cannot overlap extraction');calls++;if(calls===1)return new Response(article,{headers:{'content-type':'text/plain',etag:'"one"','last-modified':'Mon, 14 Sep 2026 12:00:00 GMT'}});const h=new Headers(init.headers);assert.equal(h.get('if-none-match'),fail?null:'"one"');assert.equal(h.get('if-modified-since'),fail?null:'Mon, 14 Sep 2026 12:00:00 GMT');return fail?new Response(article,{headers:{'content-type':'text/plain',etag:'"one"'}}):new Response(null,{status:304});});
 try{
  const source=await confirm(service,'initial');ai.run=async()=>{extracting=true;entered();return new Promise(r=>release=r);};running=service.alarm();await ready;
  await confirm(service,'initial');await service.alarm();assert.equal(calls,1);
  await Promise.all(['refresh-one','refresh-two','refresh-one'].map(key=>confirm(service,key)));await service.alarm();assert.equal(calls,1);assert.equal((await service.publicSourceStatus(source.id))!.status,'running');
  const before=alarmDecisions.length;extracting=false;release(fail?{response:{themes:[{topicId:'unknown',confidence:1}]}}:{response:{themes:[{topicId:'agent_memory',confidence:1}]}});await running;
  assert.equal((await service.publicSourceStatus(source.id))!.status,'queued');assert.equal(alarmDecisions.length,before+1);assert.equal(kv.get('alarm'),alarmDecisions.at(-1));
  ai.response={response:{themes:[{topicId:'agent_memory',confidence:1}]}};ai.run=FakeAI.prototype.run;
  const resumed=new MailSync(ctx as any,env as any);await resumed.alarm();assert.equal(calls,2);const finished=await resumed.publicSourceStatus(source.id);assert.equal(finished!.status,'complete');assert.equal(finished!.attempts,2);assert.equal(finished!.assertions,1);assert.equal(finished!.textBytes,new TextEncoder().encode(article).length);assert.equal(kv.has('alarm'),false);
  await Promise.all(['initial','refresh-one','refresh-two'].map(key=>confirm(resumed,key)));await resumed.alarm();assert.equal(calls,2);assert.equal(kv.has('alarm'),false);assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,1);
 }finally{extracting=false;release?.({response:{themes:[]}});await running;globalThis.fetch=originalFetch;db.close();}
});
for(const removeWhen of ['running','queued'])test(`public round1 account removal cancels a ${removeWhen} confirmed refresh and fences old output`,async()=>{
 const {service,db,ai,kv}=fixture();let entered!:()=>void,release!:(value:any)=>void,running:Promise<void>|undefined;const ready=new Promise<void>(r=>entered=r);let calls=0;globalThis.fetch=network(()=>{calls++;return new Response(article,{headers:{'content-type':'text/plain',etag:'"one"'}});});
 try{
  const personId=await opaque('owner-a','ada@example.com','identity-key');db.prepare('INSERT INTO accounts VALUES (?,?)').run('me@example.com',JSON.stringify({email:'me@example.com',status:'error',lastSync:Date.now()}));db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com','msg','ada@example.com','Ada',Date.now(),'Subject',1,1);
  const source=await confirm(service,'initial',url,{personId});ai.run=async()=>{entered();return new Promise(r=>release=r);};running=service.alarm();await ready;await confirm(service,'refresh',url,{personId});
  if(removeWhen==='queued'){release({response:{themes:[{topicId:'agent_memory',confidence:1}]}});await running;assert.equal((await service.publicSourceStatus(source.id))!.status,'queued');}
  await service.remove('me@example.com');assert.equal((await service.publicSourceStatus(source.id))!.status,'failed');assert.equal(kv.has('alarm'),false);release({response:{themes:[{topicId:'agent_memory',confidence:1}]}});await running;await service.alarm();assert.equal(calls,1);assert.equal(kv.has('alarm'),false);assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,removeWhen==='running'?0:1);
 }finally{release?.({response:{themes:[]}});await running;globalThis.fetch=originalFetch;db.close();}
});
test('public round1 source removal clears pending refresh intent and stale generation cannot resurrect it',async()=>{
 const {service,db,ai,kv}=fixture();let entered!:()=>void,release!:(value:any)=>void,running:Promise<void>|undefined;const ready=new Promise<void>(r=>entered=r);let calls=0;globalThis.fetch=network(()=>{calls++;return new Response(article,{headers:{'content-type':'text/plain'}});});
 try{const source=await confirm(service);ai.run=async()=>{entered();return new Promise(r=>release=r);};running=service.alarm();await ready;await confirm(service,'pending');await service.removePublicSource(source.id);release({response:{themes:[{topicId:'agent_memory',confidence:1}]}});await running;await service.alarm();assert.equal(await service.publicSourceStatus(source.id),null);assert.equal(kv.has('alarm'),false);assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM public_confirmations').get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);}finally{release?.({response:{themes:[]}});await running;globalThis.fetch=originalFetch;db.close();}
});
