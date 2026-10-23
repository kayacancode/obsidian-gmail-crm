import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelationshipController } from '../public/relationship-host.mjs';

const graph = {
  pushedAt: '2026-09-13T12:00:00Z',
  nodes: [{ id: 'person-a', name: 'Ada Rivera' }],
  edges: [],
};

async function workflowFixture(handler, options = {}) {
  const calls = [];
  const controller = createRelationshipController({ origin: 'https://people.test', ...options,
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/accounts') return json({ account: 'alice@example.test', accounts: options.accounts ?? [{email:'mail@example.test'}] });
      if (path === '/api/session') return json({ account: 'bob@example.test' });
      if (path.startsWith('/api/graph')) return json({ account: 'alice@example.test', graph: {...graph, nodes:options.nodes??graph.nodes, source:'email_accounts', connectors:[{nodeId:'person-a',score:1}], themes:[], themeSignals:[]} });
      calls.push({path,init}); return handler(path,init);
    }});
  await controller.resume(); return {controller,calls};
}

test('private person context reads and saves only the selected personal contact with account cancellation',async()=>{
 const value={personId:'person-a',text:'Building clinic tools',revision:'v1',updatedAt:1};
 const {controller,calls}=await workflowFixture(()=>json(value));
 assert.deepEqual(await controller.getPersonContext('person-a'),value);
 assert.equal(calls[0].path,'/api/people/context?personId=person-a');
 assert.deepEqual(await controller.savePersonContext({...value,revision:null}),value);
 assert.deepEqual(JSON.parse(calls[1].init.body),{personId:'person-a',text:value.text,revision:null});
 assert.equal(calls[1].init.headers.origin,'https://people.test');
 await assert.rejects(controller.getPersonContext('missing'),/Select a person/);
 await controller.signOut();assert.equal(calls[0].init.signal.aborted,true);
 await assert.rejects(controller.getPersonContext('person-a'),/My network/);
});

test('connection origin reads an untyped raw API person through a private POST',async()=>{
  const {controller,calls}=await workflowFixture(()=>json({status:'not_found'}));
  const abort=new AbortController();
  assert.deepEqual(await controller.connectionOrigin('person-a',abort.signal),{status:'not_found'});
  assert.equal(calls[0].path,'/api/people/connection-origin');
  assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{personId:'person-a'});
  assert.equal(calls[0].init.headers.origin,'https://people.test');
  abort.abort();assert.equal(calls[0].init.signal.aborted,true);
  await assert.rejects(controller.connectionOrigin('missing'),/Select a person/);
});

test('connection origin accepts typed people but rejects explicitly non-person nodes',async()=>{
  const {controller,calls}=await workflowFixture(()=>json({status:'not_found'}),{nodes:[
    {id:'person-a',name:'Ada Rivera',type:'person'},
    {id:'company-a',name:'Example company',type:'company'},
  ]});
  assert.deepEqual(await controller.connectionOrigin('person-a'),{status:'not_found'});
  await assert.rejects(controller.connectionOrigin('company-a'),/Select a person/);
  assert.equal(calls.length,1,'non-person nodes are rejected before fetching');
});

test('connection origin discards late results after source changes or sign-out',async()=>{
  for(const next of ['obsidian','workspace:team','sign-out']){
    let release;
    const {controller,calls}=await workflowFixture(path=>path==='/api/workspaces/team/graph'?json({account:'alice@example.test',graph:{source:'workspace',workspaceId:'team',nodes:[],edges:[]}}):new Promise(resolve=>{release=resolve;}));
    const request=controller.connectionOrigin('person-a',new AbortController().signal);
    if(next==='sign-out')await controller.signOut();else await controller.load(next);
    assert.equal(calls[0].init.signal.aborted,true);
    release(json({status:'found',origin:{introducerName:'Private name'}}));
    await assert.rejects(request,{name:'AbortError'});
    await assert.rejects(controller.connectionOrigin('person-a'),/My network/);
    assert.equal(calls.filter(call=>call.path==='/api/people/connection-origin').length,1);
  }
});

test('changing lens aborts stale relevance and preserves connectors on score refresh', async () => {
  let release;
  const stale = new Promise(resolve => {release=resolve;});
  const snapshot = {lens:'public',themes:[],connectors:[]};
  const {controller,calls}=await workflowFixture(path=>path.includes('lens=my')?stale:json(snapshot));
  const pending=controller.loadRelevance('my');
  const envelope=await controller.loadRelevance('public');
  release(json({lens:'my',themes:[{themeId:'private'}]})); await pending;
  assert.equal(calls[0].init.signal.aborted,true);
  assert.equal(controller.getState().lens,'public');
  assert.deepEqual(controller.getState().relevance,snapshot);
  assert.equal(envelope.connectors[0].nodeId,'person-a');
});

test('retrieval preview is separate, confirms deduplicate and retries reuse logical key', async () => {
  let attempts=0;
  const preview={account:'mail@example.test',personId:'person-a',windowDays:30,fingerprint:'f',maxMessages:50,maxBytes:1000000};
  const {controller,calls}=await workflowFixture(path=>{
    if(path.endsWith('/preview'))return json(preview);
    if(++attempts===1)throw Error('offline');
    return json({id:'job-one',status:'queued'});
  });
  const result=await controller.previewRetrieval({account:'mail@example.test',personId:'person-a'});
  assert.deepEqual(calls.map(c=>c.path),['/api/retrieval/preview']);
  await assert.rejects(controller.confirmRetrieval(result,30),/offline/);
  await Promise.all([controller.confirmRetrieval(result,30),controller.confirmRetrieval(result,30)]);
  assert.equal(calls.length,3);
  assert.ok(calls[1].init.headers['Idempotency-Key'].length>=16);
  assert.equal(calls[1].init.headers['Idempotency-Key'],calls[2].init.headers['Idempotency-Key']);
  await controller.signOut();
  await assert.rejects(controller.confirmRetrieval(result,30),/context|Sign in/);
  assert.equal(controller.getState().retrievalJob,null);
});

test('feedback omits theme-wide null person and immediate expire has no lifetime',async()=>{
  const {controller,calls}=await workflowFixture(path=>json(path.includes('/feedback')?{id:'feedback'}:{lens:'my',themes:[]}));
  await controller.submitFeedback({themeId:'theme-a',personId:null,action:'expire'});
  assert.deepEqual(JSON.parse(calls[0].init.body),{action:'expire'});
});

test('poll uses bounded backoff and refreshes definitions once without replacing graph',async()=>{
  const waits=[];let count=0;
  const {controller}=await workflowFixture(()=>json({id:'job',status:++count===6?'complete':'running'}),{sleep:async(ms)=>{waits.push(ms);}});
  const original=controller.getState().graph;
  await controller.pollRetrieval('job');
  assert.deepEqual(waits,[1000,2000,4000,8000,15000,15000]);
  assert.equal(controller.getState().graph,original);
  assert.equal(controller.getState().retrievalJob.status,'complete');
});

test('session expiry clears relevance evidence previews and cancels pending callbacks',async()=>{
  let expire=false;
  const {controller}=await workflowFixture(()=>expire?json({},401):json({lens:'my',themes:[]}));
  await controller.loadRelevance('my');expire=true;
  await assert.rejects(controller.loadEvidence('theme-a'),/session expired/i);
  assert.equal(controller.getState().phase,'signed-out');
  for(const field of ['relevance','evidence','retrievalPreview','publicPreview','retrievalJob','publicJob'])assert.equal(controller.getState()[field],null);
});

test('failed relevance preserves graph and a sign-out fences an outstanding public preview',async()=>{
  let release;
  const late=new Promise(resolve=>{release=resolve;});
  const {controller,calls}=await workflowFixture(path=>path.includes('/public-sources/')?late:json({},503));
  const original=controller.getState().graph;
  await assert.rejects(controller.loadRelevance('my'),/503/);
  assert.equal(controller.getState().graph,original);
  const pending=controller.previewPublicSource({url:'https://example.com',personId:null});
  await controller.signOut();release(json({canonicalUrl:'https://example.com',visibility:'public'}));
  await assert.rejects(pending,/context/i);
  assert.equal(calls.at(-1).init.signal.aborted,true);
  assert.equal(controller.getState().publicPreview,null);
});

test('local graph retrieval is honestly unavailable while public preview is source-bound',async()=>{
  const {controller,calls}=await workflowFixture(()=>json({canonicalUrl:'https://example.com',visibility:'public'}));
  await controller.load('obsidian');
  await assert.rejects(controller.previewRetrieval({personId:'person-a'}),/no verified Gmail person mapping/);
  const preview=await controller.previewPublicSource({url:'https://example.com',personId:null});
  await Promise.all([controller.confirmPublicSource(preview),controller.confirmPublicSource(preview)]);
  assert.deepEqual(calls.map(c=>c.path),['/api/public-sources/preview?source=obsidian','/api/public-sources/confirm?source=obsidian']);
  assert.deepEqual(JSON.parse(calls[1].init.body),{url:'https://example.com'});
});

test('polling stops at five minutes and sign-out cancels an outstanding poll without refresh',async()=>{
  const waits=[];
  const {controller,calls}=await workflowFixture(()=>json({status:'running'}),{sleep:async ms=>{waits.push(ms);}});
  await assert.rejects(controller.pollRetrieval('slow'),/five minutes/);
  assert.equal(waits.reduce((sum,ms)=>sum+ms,0),300000);
  assert.ok(calls.every(c=>c.path==='/api/retrieval/slow'));
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  const second=await workflowFixture(()=>json({status:'complete'}),{sleep:()=>held});
  const polling=second.controller.pollRetrieval('stale');
  await second.controller.signOut();release();await assert.rejects(polling,/context/i);
  assert.deepEqual(second.calls,[]);
});

test('polling counts elapsed network time toward its five minute limit',async(t)=>{
  let now=0; t.mock.method(Date,'now',()=>now);
  const {controller,calls}=await workflowFixture(()=>{now=300001;return json({status:'running'});},{sleep:async()=>{}});
  await assert.rejects(controller.pollRetrieval('slow-network'),/five minutes/);
  assert.equal(calls.length,1);
});

test('settled public polls release their cache for fresh confirmations and transient retries',async()=>{
  let fail=false,statusCalls=0;
  const {controller}=await workflowFixture(path=>{
    if(path.endsWith('/preview'))return json({canonicalUrl:'https://example.com',visibility:'public'});
    if(path.endsWith('/confirm'))return json({id:'same-source',status:'queued'});
    statusCalls++;if(fail){fail=false;return json({},503);}return json({id:'same-source',status:'complete'});
  },{sleep:async()=>{}});
  for(let i=0;i<2;i++){
    const preview=await controller.previewPublicSource({url:'https://example.com'});
    const job=await controller.confirmPublicSource(preview);
    await Promise.all([controller.pollPublicSource(job.id),controller.pollPublicSource(job.id)]);
    assert.equal(controller.getState().publicJob.status,'complete');
  }
  assert.equal(statusCalls,2);
  fail=true;await assert.rejects(controller.pollPublicSource('same-source'),/503/);
  await controller.pollPublicSource('same-source');assert.equal(statusCalls,4);
});

test('mailbox and window preview changes revoke old consent and reject late previews',async()=>{
  let release;
  const late=new Promise(resolve=>{release=resolve;});
  const {controller,calls}=await workflowFixture((path,init)=>{
    const input=JSON.parse(init.body);
    if(path.endsWith('/preview'))return input.account==='slow@example.test'?late:json({...input,fingerprint:input.account});
    return json({id:'job',status:'queued'});
  });
  const first=await controller.previewRetrieval({account:'first@example.test',personId:'person-a',windowDays:30});
  const pending=controller.previewRetrieval({account:'slow@example.test',personId:'person-a',windowDays:90});
  await assert.rejects(controller.confirmRetrieval(first,30),/preview|Preview|context/);
  const current=await controller.previewRetrieval({account:'second@example.test',personId:'person-a',windowDays:90});
  release(json({account:'slow@example.test',personId:'person-a',windowDays:90}));
  await assert.rejects(pending,/preview|Preview|context/);
  assert.equal(controller.getState().retrievalPreview.account,'second@example.test');
  await controller.confirmRetrieval(current,90);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{account:'second@example.test',personId:'person-a',windowDays:90,fingerprint:'second@example.test'});
});

test('mailbox choices expose every connected account and require an explicit choice for multiple accounts',async()=>{
  const {controller,calls}=await workflowFixture((path,init)=>json(JSON.parse(init.body)),{accounts:[{email:'first@example.test'},{email:'second@example.test'}]});
  assert.deepEqual(await controller.loadRetrievalAccounts(),['first@example.test','second@example.test']);
  await assert.rejects(controller.previewRetrieval({personId:'person-a'}),/mailbox/i);
  assert.equal(calls.length,0);
  const preview=await controller.previewRetrieval({personId:'person-a',account:'second@example.test'});
  assert.equal(preview.account,'second@example.test');
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('resume loads only the authenticated owner graph and publishes ready state', async () => {
  const calls = [];
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/accounts') return json({ account: 'alice@example.test', accounts: [] });
      if (path === '/api/graph') return json({ account: 'alice@example.test', graph });
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.resume();

  assert.equal(controller.getState().phase, 'ready');
  assert.deepEqual(controller.getState().graph, graph);
  assert.deepEqual(calls.map((call) => call.path), ['/api/accounts', '/api/graph']);
  assert.equal(calls[1].init.signal instanceof AbortSignal, true);
});

test('resume refuses a graph whose owner differs from the authenticated session owner', async () => {
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path) => {
      if (path === '/api/accounts') return json({ account: 'alice@example.test', accounts: [] });
      if (path === '/api/graph') return json({ account: 'bob@example.test', graph });
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.resume();

  const state = controller.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.account, 'alice@example.test');
  assert.equal(state.graph, null);
  assert.match(state.message, /different account/i);
});

test('an expired graph session clears private state and returns to signed out', async () => {
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path) => path === '/api/accounts' ? json({ account: 'alice@example.test', accounts: [] }) : json({ error: 'missing_token' }, 401),
  });

  await controller.resume();

  const state = controller.getState();
  assert.equal(state.phase, 'signed-out');
  assert.equal(state.account, null);
  assert.equal(state.graph, null);
  assert.match(state.message, /session expired/i);
});

test('a failed server sign-out clears the graph but does not claim the session ended', async () => {
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/session' && init.method === 'POST') return json({ account: 'alice@example.test' });
      if (path === '/api/session' && init.method === 'DELETE') return json({ error: 'failed' }, 500);
      if (path === '/api/graph') return json({ account: 'alice@example.test', graph });
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.signIn('alice-id-token');
  await controller.signOut();

  const state = controller.getState();
  assert.equal(state.phase, 'sign-out-failed');
  assert.equal(state.account, null);
  assert.equal(state.graph, null);
  assert.match(state.message, /not confirm/i);
});

test('signing into another account invalidates an older in-flight graph response', async () => {
  let releaseAlice;
  const aliceResponse = new Promise((resolve) => { releaseAlice = resolve; });
  const calls = [];
  let deferAlice = false;
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path, init = {}) => {
      calls.push({ path, init });
      if (path === '/api/session' && init.method === 'DELETE') return json({ ok: true });
      if (path === '/api/session' && init.method === 'POST') return json({ account: init.headers.authorization.includes('alice') ? 'alice@example.test' : 'bob@example.test' });
      if (path === '/api/graph' && deferAlice) { deferAlice = false; return aliceResponse; }
      if (path === '/api/graph') {
        const bob = calls.filter((call) => call.path === '/api/session' && call.init.method === 'POST').at(-1)?.init.headers.authorization.includes('bob');
        return json({ account: bob ? 'bob@example.test' : 'alice@example.test', graph: bob ? { ...graph, nodes: [{ id: 'person-b', name: 'Bo Chen', type: 'person' }] } : graph });
      }
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.signIn('alice-id-token');
  deferAlice = true;
  const staleLoad = controller.load('best');
  await controller.signOut();
  await controller.signIn('bob-id-token');
  releaseAlice(json({ account: 'alice@example.test', graph }));
  await staleLoad;

  assert.equal(controller.getState().account, 'bob@example.test');
  assert.equal(controller.getState().graph.nodes[0].name, 'Bo Chen');
  const post = calls.filter((call) => call.path === '/api/session' && call.init.method === 'POST').at(-1);
  assert.equal(post.init.headers.authorization, 'Bearer bob-id-token');
  const deletion = calls.find((call) => call.path === '/api/session' && call.init.method === 'DELETE');
  assert.equal(deletion.init.headers.origin, 'https://people.test');
});

test('source switching is explicit and a missing source graph produces an empty state', async () => {
  const paths = [];
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path) => {
      paths.push(path);
      if (path === '/api/accounts') return json({ account: 'alice@example.test', accounts: [] });
      if (path === '/api/graph?source=obsidian') return json({ account: 'alice@example.test', graph: null });
      if (path === '/api/graph') return json({ account: 'alice@example.test', graph });
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.resume('obsidian');
  assert.equal(controller.getState().phase, 'empty');
  assert.equal(controller.getState().graph, null);
  await controller.load('best');
  assert.equal(controller.getState().phase, 'ready');
  assert.deepEqual(paths, ['/api/accounts', '/api/graph?source=obsidian', '/api/graph']);
});

test('a push token for a changed account is discarded and the controller refreshes ownership', async () => {
  let sessionAccount = 'alice@example.test';
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/session' && init.method === 'POST') return json({ account: 'alice@example.test' });
      if (path === '/api/accounts') return json({ account: sessionAccount, accounts: [] });
      if (path === '/api/graph') return json({ account: sessionAccount, graph: { ...graph, nodes: [{ id: sessionAccount, name: sessionAccount, type: 'person' }] } });
      if (path === '/api/token') {
        sessionAccount = 'bob@example.test';
        return json({ email: 'bob@example.test', token: 'bob-private-token' });
      }
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.signIn('alice-id-token');
  const result = await controller.requestPushToken();

  assert.equal(result.token, null);
  assert.match(result.message, /account changed/i);
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(controller.getState().account, 'bob@example.test');
  assert.equal(controller.getState().graph.nodes[0].name, 'bob@example.test');
});

test('push token request failures return a safe error without exposing or replacing graph data', async () => {
  const controller = createRelationshipController({
    origin: 'https://people.test',
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/session' && init.method === 'POST') return json({ account: 'alice@example.test' });
      if (path === '/api/graph') return json({ account: 'alice@example.test', graph });
      if (path === '/api/token') return new Response('{broken', { status: 200 });
      throw new Error(`Unexpected ${path}`);
    },
  });

  await controller.signIn('alice-id-token');
  const result = await controller.requestPushToken();

  assert.equal(result.token, null);
  assert.match(result.message, /could not be generated/i);
  assert.equal(controller.getState().phase, 'ready');
  assert.deepEqual(controller.getState().graph, graph);
});

test('workspace loads without own inbox or nodes and never calls personal evidence/search APIs',async()=>{
 const calls=[];const controller=createRelationshipController({origin:'https://people.test',fetchImpl:async(path)=>{calls.push(path);if(path==='/api/accounts')return json({account:'new@example.com',accounts:[]});if(path.endsWith('/graph'))return json({account:'new@example.com',graph:{source:'workspace',workspaceId:'team',workspaceName:'Team',nodes:[],edges:[],themes:[],themeSignals:[]}});if(path.endsWith('/search'))return json({results:[]});return json({});}});
 await controller.resume('workspace:team');assert.equal(controller.getState().phase,'ready');
 await controller.searchNetwork('designer');await controller.loadRelevance('my');await controller.loadEvidence('theme');
 assert.ok(calls.includes('/api/workspaces/team/search'));assert.ok(!calls.some(p=>p.startsWith('/api/people/')||p.startsWith('/api/relevance')||p.startsWith('/api/themes')));
});

test('workspace switch discards pending personal search and removal clears graph',async()=>{
 let release,removed=false;const stale=new Promise(resolve=>release=resolve);
 const controller=createRelationshipController({origin:'https://people.test',fetchImpl:async(path)=>{
 if(path==='/api/accounts')return json({account:'new@example.com',accounts:[]});
 if(path==='/api/people/search')return stale;
 if(path.endsWith('/members'))return new Response(JSON.stringify({error:'workspace_unavailable'}),{status:removed?403:200});
 return json({account:'new@example.com',graph:{source:path.includes('/workspaces/')?'workspace':'email_accounts',nodes:[{id:'a',name:'Ada'}],edges:[],revision:1}});
 }});
 await controller.resume();const pending=controller.searchNetwork('private');
 await controller.load('workspace:team');release(json({results:[{personId:'private'}]}));await assert.rejects(pending,/context changed/i);
 removed=true;await controller.refreshWorkspace();assert.equal(controller.getState().graph,null);assert.equal(controller.getState().phase,'error');
});

test('signed-out workspace deep link survives Google sign-in',async()=>{
 const calls=[];const controller=createRelationshipController({origin:'https://people.test',fetchImpl:async(path)=>{calls.push(path);if(path==='/api/accounts')return new Response('{}',{status:401});if(path==='/api/session')return json({account:'new@example.com'});return json({account:'new@example.com',graph:{source:'workspace',nodes:[],edges:[]}});}});
 await controller.resume('workspace:team');await controller.signIn('google-token');assert.ok(calls.includes('/api/workspaces/team/graph'));assert.ok(!calls.includes('/api/graph'));
});
test('shared traversal reads fragmented stream events and returns the real answer',async()=>{
 const events=[{type:'scope',label:'José'},{type:'result',answer:{results:[{personId:'person-a'}]}}],bytes=new TextEncoder().encode(events.map(e=>JSON.stringify(e)+'\n').join(''));
 const {controller}=await workflowFixture(path=>{
  if(path.endsWith('/graph'))return json({graph:{...graph,source:'workspace',workspaceId:'test'}});
  if(path.endsWith('/search-stream'))return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}));
  return json({});
 });
 await controller.load('workspace:test');const seen=[];const answer=await controller.searchNetwork('design',e=>seen.push(e));assert.equal(seen[0].label,'José');assert.equal(answer.results[0].personId,'person-a');
});

test('workspace refresh loads new synced content at the same membership revision without a loading reset',async()=>{
 let name='Before',stamp='one',reads=0;
 const phases=[];
 const controller=createRelationshipController({origin:'https://people.test',onState:s=>phases.push(s.phase),fetchImpl:async path=>{
  if(path==='/api/accounts')return json({account:'new@example.com'});
  if(path.endsWith('/members'))return json({workspace:{revision:1}});
  reads++;
  return json({account:'new@example.com',graph:{source:'workspace',workspaceId:'team',revision:1,pushedAt:stamp,nodes:[{id:'a',name}],edges:[]}});
 }});
 await controller.resume('workspace:team');phases.length=0;
 name='After';await controller.refreshWorkspace();
 assert.equal(controller.getState().graph.nodes[0].name,'After');
 assert.ok(phases.every(p=>p==='ready'));
 const unchanged=controller.getState().graph;stamp='two';
 await controller.refreshWorkspace();assert.equal(controller.getState().graph,unchanged,'timestamps alone must not reset the view');
 assert.equal(reads,3);
});

test('workspace refresh rejects mismatched graph owners',async()=>{
 let wrong=false;
 const controller=createRelationshipController({origin:'https://people.test',fetchImpl:async path=>{
  if(path==='/api/accounts')return json({account:'new@example.com'});
  if(path.endsWith('/members'))return json({workspace:{revision:1}});
  return json({account:wrong?'other@example.com':'new@example.com',graph:{source:'workspace',workspaceId:'team',revision:1,nodes:[{id:wrong?'private':'a'}],edges:[]}});
 }});
 await controller.resume('workspace:team');wrong=true;await controller.refreshWorkspace();
 assert.equal(controller.getState().graph.nodes[0].id,'a');
 assert.match(controller.getState().workflowMessage,/stale/i);
});

test('overlapping workspace refreshes share a request and late content cannot cross a workspace switch',async()=>{
 let release,refreshing=false,reads=0;
 const pending=new Promise(resolve=>release=resolve);
 const controller=createRelationshipController({origin:'https://people.test',fetchImpl:async path=>{
  if(path==='/api/accounts')return json({account:'new@example.com'});
  if(path.endsWith('/members'))return json({workspace:{revision:1}});
  if(refreshing&&path==='/api/workspaces/team/graph'){reads++;return pending;}
  return json({account:'new@example.com',graph:{source:'workspace',workspaceId:path.includes('/other/')?'other':'team',revision:1,nodes:[],edges:[]}});
 }});
 await controller.resume('workspace:team');refreshing=true;
 const a=controller.refreshWorkspace(),b=controller.refreshWorkspace();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
 await controller.load('workspace:other');
 release(json({account:'new@example.com',graph:{source:'workspace',workspaceId:'team',revision:1,nodes:[{id:'old'}],edges:[]}}));
 await Promise.all([a,b]);assert.equal(controller.getState().graph.workspaceId,'other');
});
