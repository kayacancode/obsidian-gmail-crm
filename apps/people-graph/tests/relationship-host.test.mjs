import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelationshipController } from '../public/relationship-host.mjs';

const graph = {
  pushedAt: '2026-09-13T12:00:00Z',
  nodes: [{ id: 'person-a', name: 'Ada Rivera', type: 'person' }],
  edges: [],
};

async function workflowFixture(handler, options = {}) {
  const calls = [];
  const controller = createRelationshipController({ origin: 'https://people.test', ...options,
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/accounts') return json({ account: 'alice@example.test', accounts: options.accounts ?? [{email:'mail@example.test'}] });
      if (path === '/api/session') return json({ account: 'bob@example.test' });
      if (path.startsWith('/api/graph')) return json({ account: 'alice@example.test', graph: {...graph, source:'email_accounts', connectors:[{nodeId:'person-a',score:1}], themes:[], themeSignals:[]} });
      calls.push({path,init}); return handler(path,init);
    }});
  await controller.resume(); return {controller,calls};
}

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
