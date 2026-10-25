import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGraph, searchGraph } from '../public/relationship-graph/model.mjs';
import { filterRelevance, themeFields } from '../public/relationship-graph/relevance.mjs';
import { findPaths } from '../public/relationship-graph/paths.mjs';
import { evidenceLines } from '../public/relationship-graph/graph.mjs';

const NOW = '2026-09-14T12:00:00.000Z';

test('private manual memory controls survive graph normalization with bounded preferences',()=>{
 const person={id:'manual-a',name:'Ada',manual:true,memoryEligible:true,directRelationship:false,sources:['manual'],relationshipDelta:10,notBefore:'2026-12-01',pointPersonId:'jordan'};
 const node=normalizeGraph({nodes:[person],edges:[]}).nodes[0];
 assert.equal(node.manual,true);assert.equal(node.memoryEligible,true);assert.deepEqual(node.sources,['manual']);assert.equal(node.relationshipDelta,10);assert.equal(node.notBefore,'2026-12-01');assert.equal(node.pointPersonId,'jordan');
 const bad=normalizeGraph({nodes:[{...person,relationshipDelta:99,notBefore:'soon',pointPersonId:'x'.repeat(201)}],edges:[]}).nodes[0];assert.equal(bad.relationshipDelta,0);assert.equal(bad.notBefore,null);assert.equal(bad.pointPersonId,null);
});

test('final wave browser retains safe public provenance and rejects unsafe navigation',()=>{
 const input=graphFixture(),s=input.themeSignals.find(s=>s.visibility==='public');
 const provenance={canonicalUrl:'https://example.com/research',publisherHost:'example.com',observedAt:NOW,retrievedAt:NOW,timeBasis:'observed'};
 s.provenance=provenance;
 assert.deepEqual(normalizeGraph(input).themeSignals.find(x=>x.id===s.id).provenance,provenance);
 for(const canonicalUrl of ['javascript:alert(1)','https://user:pass@example.com','https://example.com/#x']){
  s.provenance={...provenance,canonicalUrl};assert.equal(normalizeGraph(input).themeSignals.find(x=>x.id===s.id).provenance,null);
 }
});

test('meeting provenance survives normalisation and evidence lines read as sentences',()=>{
 const input=graphFixture();
 const meeting={id:'signal-meeting',personId:'local-ada',sourceType:'granola',visibility:'private',
  summary:'Ask: \u201cAda asked for an intro\u201d',evidenceRef:'granola-note:not_1234567890abcd#summary@12',
  provenance:{canonicalUrl:'https://notes.granola.ai/d/not_1234567890abcd',publisherHost:'granola.ai',
   observedAt:'2026-08-14T11:00:00.000Z',retrievedAt:NOW,timeBasis:'observed',title:'Pilot sync with Ada'}};
 input.themeSignals.push(signal(meeting));
 input.relevance.themes[0].components.push({signalId:'signal-meeting',sourceType:'granola',observedAt:meeting.provenance.observedAt,contribution:0.7});
 const graph=normalizeGraph(input);
 const normalized=graph.themeSignals.find(s=>s.id==='signal-meeting');
 assert.deepEqual(normalized.provenance,meeting.provenance);
 const lines=evidenceLines(normalized,{contribution:0.7});
 assert.equal(lines.summary,'Ask: \u201cAda asked for an intro\u201d');
 assert.equal(lines.source,'Meeting \u201cPilot sync with Ada\u201d \u00b7 2026-08-14');
 assert.deepEqual(lines.link,{label:'Open in Granola \u2197',href:'https://notes.granola.ai/d/not_1234567890abcd'});
 assert.ok(lines.details.some(line=>line.includes('granola-note:not_1234567890abcd')));

 // A note with no web url renders a title and date, never a link.
 const unlinked=evidenceLines({...normalized,provenance:{...normalized.provenance,canonicalUrl:'https://granola.ai/'}},{contribution:0.7});
 assert.equal(unlinked.link,null);
 assert.equal(unlinked.source,'Meeting \u201cPilot sync with Ada\u201d \u00b7 2026-08-14');

 const subject=evidenceLines({...normalized,sourceType:'gmail_subject',provenance:null,summary:'Subject metadata matched Beebot Beta'},{contribution:0.2});
 assert.equal(subject.summary,'Emails titled \u201cBeebot Beta\u201d');
 assert.equal(subject.source,'Email subject \u00b7 2026-09-13');// a non-meeting item keeps the signal's own date
 assert.equal(subject.link,null);
});

test('final wave browser keeps person pin scores and field membership from scored evidence',()=>{
 const input=graphFixture(),t=input.relevance.themes[0];
 t.nodeIds=['local-ada'];t.nodeScores={'local-ada':65};t.components=t.components.filter(c=>c.signalId==='signal-private');
 const graph=normalizeGraph(input);
 assert.equal(graph.relevance.themes[0].nodeScores['local-ada'],65);
 const fields=themeFields(graph,[{id:'local-ada',x:10,y:10},{id:'local-bo',x:500,y:500}],'my');
 assert.deepEqual(fields.find(f=>f.themeId===t.themeId).nodeIds,['local-ada']);
});

test('final wave corrected theme remains inspectable in shared browser lenses',()=>{
 const input=graphFixture();
 input.themes.push({...input.themes[0],id:'replacement',canonicalName:'Replacement'});
 input.relevance.themes=[{...input.relevance.themes[0],themeId:'replacement',nodeIds:['local-cy'],components:input.relevance.themes[0].components.filter(c=>c.signalId==='signal-public')}];
 const filtered=filterRelevance(normalizeGraph(input),'public');
 assert.ok(filtered.themes.some(t=>t.id==='replacement'));
 assert.equal(filtered.relevance.themes[0]?.themeId,'replacement');
 assert.deepEqual(filtered.relevance.themes[0]?.nodeIds,['local-cy']);
});

function signal(overrides = {}) {
  return {
    id: 'signal-private',
    personId: 'local-ada',
    themeId: 'theme-memory',
    sourceType: 'obsidian_note',
    visibility: 'private',
    observedAt: '2026-09-13T12:00:00.000Z',
    ingestedAt: NOW,
    confidence: 0.9,
    summary: 'Agent memory systems',
    evidenceRef: 'obsidian:People/Ada.md',
    contentHash: 'a'.repeat(64),
    extractorVersion: 'local-theme-v1',
    ...overrides,
  };
}

function graphFixture() {
  const themeSignals = [
    signal(),
    signal({
      id: 'signal-firm',
      personId: 'local-bo',
      visibility: 'firm',
      summary: 'Firm operating model',
    }),
    signal({
      id: 'signal-public',
      personId: 'local-cy',
      sourceType: 'public_url',
      visibility: 'public',
      summary: 'Public agent memory momentum',
      evidenceRef: 'public-source:source-1',
      extractorVersion: 'public-source-v1',
      modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    }),
  ];
  const components = themeSignals.map((item, index) => ({
    signalId: item.id,
    sourceType: item.sourceType,
    observedAt: item.observedAt,
    contribution: 1 - index * 0.1,
  }));
  const connectors = [{
    nodeId: 'local-bo',
    score: 38,
    evidenceClass: 'documented',
    documentedDegree: 1,
    inferredDegree: 1,
    sampledPathCount: 0,
  }];
  return {
    pushedAt: NOW,
    nodes: [
      { id: 'local-ada', name: 'Ada', type: 'person' },
      { id: 'local-bo', name: 'Bo', type: 'person' },
      { id: 'local-cy', name: 'Cy', type: 'person' },
    ],
    edges: [{
      id: 'documented-edge',
      source: 'local-ada',
      target: 'local-bo',
      weight: 2,
      types: ['shared_meeting', 'unsupported_type'],
      contexts: ['Introduced at a workshop'],
    }],
    themes: [{
      id: 'theme-memory',
      canonicalName: 'Agent memory',
      aliases: ['Memory agents'],
      description: 'Durable context for agents',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    }],
    themeSignals,
    relevance: {
      version: 1,
      lens: 'my',
      calculatedAt: NOW,
      scoreVersion: 'relevance-v1',
      themes: [{
        themeId: 'theme-memory',
        name: 'Agent memory',
        score: 91,
        reason: 'Recent evidence',
        nodeIds: ['local-ada', 'local-bo', 'local-cy'],
        components,
      }],
      connectors,
      discoveries: [{
        nodeId: 'local-cy',
        score: 84,
        reason: 'Agent memory via documented bridge',
        themeIds: ['theme-memory'],
        pathNodeIds: ['local-ada', 'local-bo', 'local-cy'],
        freshness: 'recent',
        relationshipUncertainty: 'documented',
      }],
    },
    connectors,
  };
}

test('normalizes themes without allowing them to become relationship edges', () => {
  const raw = graphFixture();
  raw.edges = [{ id: 'interpretation', source: 'local-ada', target: 'local-cy', types: ['association'] }];
  const graph = normalizeGraph(raw);

  assert.equal(graph.themes[0].name, 'Agent memory');
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].types, ['association']);
  assert.equal(findPaths(graph, 'local-ada', 'local-bo').paths.length, 0);
});

test('search finds people through visible themes and signals only', () => {
  const graph = normalizeGraph(graphFixture());

  assert.deepEqual(searchGraph(filterRelevance(graph, 'public'), 'Firm operating model'), []);
  assert.equal(searchGraph(filterRelevance(graph, 'public'), 'Public agent memory momentum')[0]?.id, 'local-cy');
  assert.equal(searchGraph(filterRelevance(graph, 'my'), 'Durable context for agents')[0]?.id, 'local-ada');
});

test('shared lenses remove hidden evidence text from derived theme and discovery reasons', () => {
  const raw = graphFixture();
  raw.relevance.themes[0].reason = 'Private thesis from excluded evidence';
  raw.relevance.discoveries[0].reason = 'Private strategy via documented bridge';
  const publicGraph = filterRelevance(normalizeGraph(raw), 'public');

  assert.deepEqual(searchGraph(publicGraph, 'Private thesis'), []);
  assert.doesNotMatch(publicGraph.relevance.themes[0].reason, /private thesis/i);
  assert.doesNotMatch(publicGraph.relevance.discoveries[0].reason, /private strategy/i);
});

test('firm and public lenses retain only their exact visibility while my retains all authorized evidence', () => {
  const graph = normalizeGraph(graphFixture());

  assert.deepEqual(filterRelevance(graph, 'my').themeSignals.map((item) => item.id), [
    'signal-private', 'signal-firm', 'signal-public',
  ]);
  assert.deepEqual(filterRelevance(graph, 'firm').themeSignals.map((item) => item.id), ['signal-firm']);
  assert.deepEqual(filterRelevance(graph, 'public').themeSignals.map((item) => item.id), ['signal-public']);
  assert.deepEqual(filterRelevance(graph, 'firm').relevance.themes[0].nodeIds, ['local-bo']);
  assert.deepEqual(filterRelevance(graph, 'public').relevance.themes[0].nodeIds, ['local-cy']);
});

test('a twenty-first sharing owner is trimmed off a node rather than breaking the graph', () => {
  const via = Array.from({ length: 21 }, (_, index) => `owner${index}@vc.test`);
  const graph = normalizeGraph({
    nodes: [{ id: 'local-ada', name: 'Ada', type: 'person', via }, { id: 'local-bo', name: 'Bo', type: 'person' }],
    edges: [],
  });
  assert.equal(graph.nodes[0].via.length, 20, '`via` is server-produced data a viewer cannot correct');
  assert.deepEqual(graph.nodes[0].via, via.slice(0, 20));
  assert.deepEqual(graph.nodes[1].via, []);
});

test('evidence another owner shared stays in the firm lens and never joins my mind', () => {
  const input = graphFixture();
  input.themeSignals.push(signal({
    id: 'signal-shared',
    personId: 'local-cy',
    sourceType: 'granola',
    visibility: 'firm',
    summary: 'Ask: “shared quote from another owner”',
    evidenceRef: 'share:owner@share.test:abc123',
    extractorVersion: 'network-share-v1',
  }));
  input.relevance.themes[0].components.push({
    signalId: 'signal-shared', sourceType: 'granola', observedAt: '2026-09-13T12:00:00.000Z', contribution: 0.5,
  });
  const graph = normalizeGraph(input);
  const mine = filterRelevance(graph, 'my');
  assert.ok(!mine.themeSignals.some((item) => item.id === 'signal-shared'), 'shared evidence is not the viewer’s own');
  assert.ok(!JSON.stringify(mine.themeSignals).includes('shared quote from another owner'));
  assert.ok(filterRelevance(graph, 'firm').themeSignals.some((item) => item.id === 'signal-shared'), 'the Firm lens is where it belongs');
  assert.ok(!filterRelevance(graph, 'public').themeSignals.some((item) => item.id === 'signal-shared'));
});

test('normalization preserves legacy defaults and inspectable relationship strength and types', () => {
  const legacy = normalizeGraph({
    nodes: [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bo' }],
    edges: [{ source: 'a', target: 'b', weight: 3, types: ['shared_email', 'made_up'] }],
  });

  assert.deepEqual(legacy.themes, []);
  assert.deepEqual(legacy.themeSignals, []);
  assert.deepEqual(legacy.connectors, []);
  assert.deepEqual(legacy.relevance.themes, []);
  assert.equal(legacy.edges[0].weight, 3);
  assert.deepEqual(legacy.edges[0].types, ['shared_email']);
});

test('strict relevance normalization rejects invalid visibility, ranges, timestamps, and opaque identity substitution', () => {
  const invalidVisibility = graphFixture();
  invalidVisibility.themeSignals[0].visibility = 'everyone';
  assert.throws(() => normalizeGraph(invalidVisibility), /visibility/i);

  const invalidConfidence = graphFixture();
  invalidConfidence.themeSignals[0].confidence = 1.01;
  assert.throws(() => normalizeGraph(invalidConfidence), /confidence/i);

  const invalidTimestamp = graphFixture();
  invalidTimestamp.themeSignals[0].observedAt = 'yesterday';
  assert.throws(() => normalizeGraph(invalidTimestamp), /observedAt/i);

  const foreignIdentity = graphFixture();
  foreignIdentity.themeSignals[0].personId = 'gmail-derived-id';
  assert.throws(() => normalizeGraph(foreignIdentity), /personId/i);

  const unsafeSource = graphFixture();
  unsafeSource.edges[0].evidence = [{ sourceUrl: 'https://user:secret@example.test/private' }];
  assert.equal(normalizeGraph(unsafeSource).edges[0].evidence[0].url, null);
});

test('normalization accepts additive discovery scores emitted by the producer above 100', () => {
  const raw = graphFixture();
  raw.relevance.discoveries[0].score = 128;

  assert.equal(normalizeGraph(raw).relevance.discoveries[0].score, 128);
});

test('theme fields are stable, use member positions, and never move visible nodes', () => {
  const graph = normalizeGraph(graphFixture());
  const visibleNodes = [
    { id: 'local-ada', x: 100, y: 180 },
    { id: 'local-bo', x: 300, y: 220 },
    { id: 'local-cy', x: 500, y: 260 },
  ];
  const before = structuredClone(visibleNodes);

  const first = themeFields(graph, visibleNodes, 'my');
  const second = themeFields(graph, visibleNodes, 'my');

  assert.deepEqual(first, second);
  assert.deepEqual(visibleNodes, before);
  assert.equal(first[0].themeId, 'theme-memory');
  assert.deepEqual(first[0].nodeIds, ['local-ada', 'local-bo', 'local-cy']);
  assert.ok(first[0].x > 100 && first[0].x < 500);
  assert.ok(first[0].y > 180 && first[0].y < 260);
});

test('shared people keep the owners who shared them, bounded, and shared_via edges keep a readable label', () => {
  const shared = normalizeGraph({
    nodes: [
      { id: 'a', name: 'Ada', via: ['owner@example.test', ' second@example.test '] },
      { id: 'b', name: 'Bo', lastContact: null },
    ],
    edges: [{ source: 'a', target: 'b', types: ['shared_via'] }],
  });

  assert.deepEqual(shared.nodes[0].via, ['owner@example.test', 'second@example.test']);
  assert.deepEqual(shared.nodes[1].via, []);
  assert.equal(shared.nodes[1].lastContact, null);
  assert.deepEqual(shared.edges[0].types, ['shared_via']);
  assert.equal(shared.edges[0].label, 'shared via');

  // A non-array or an over-long owner is a producer bug, not something to render. Too many
  // owners is not: see the twenty-first-owner case below, which trims instead of throwing.
  assert.throws(() => normalizeGraph({ nodes: [{ id: 'a', name: 'Ada', via: 'owner@example.test' }], edges: [] }), /via/i);
  assert.throws(() => normalizeGraph({ nodes: [{ id: 'a', name: 'Ada', via: ['x'.repeat(321)] }], edges: [] }), /via/i);
});

test('typed connections preserve source evidence without inventing a personal relationship',()=>{
 const provenance={sourceType:'gmail',sourceId:'thread-123',title:'An introduction',url:'https://mail.google.com/mail/u/0/#all/thread-123'};
 const input={nodes:[{id:'julian',name:'Julian'},{id:'nicole',name:'Nicole'}],edges:[{id:'intro',source:'julian',target:'nicole',type:'intro',kind:'cooccurrence',confidence:.95,direction:'source_to_target',provenance,observedAt:'2026-10-20',evidence:[{id:'mail',type:'intro',title:'Introduction',text:'Julian introduced Nicole.',date:'2026-10-20',confidence:.9,direction:'source_to_target',provenance}]},{id:'mixed',source:'nicole',target:'julian',types:['shared_email','shared_meeting']}]};
 const g=normalizeGraph({...input,edges:normalizeGraph(input).edges}),intro=g.edges[0];
 assert.deepEqual(intro.types,['introduced']);assert.equal(intro.label,'Intro');
 assert.equal(intro.kind,'cooccurrence','an extracted introduction does not confirm a personal relationship');
 assert.equal(intro.confidence,.95);assert.equal(intro.direction,'source_to_target');assert.equal(intro.provenance.sourceId,'thread-123');
 assert.equal(intro.evidence[0].type,'introduced');assert.equal(intro.evidence[0].confidence,.9);assert.equal(intro.evidence[0].provenance.sourceType,'gmail');
 assert.equal(g.edges[1].label,'Shared email · Meeting');assert.equal(g.edges[1].kind,'cooccurrence');
});

test('connection metadata drops malformed values and unsafe source links',()=>{
 const g=normalizeGraph({nodes:[{id:'a',name:'A'},{id:'b',name:'B'}],edges:[{source:'a',target:'b',types:['shared_email'],confidence:2,direction:'guess',provenance:{sourceType:4,sourceId:{secret:true},url:'javascript:alert(1)',unexpected:'discard'},evidence:[{type:'made_up',confidence:-1,direction:'guess',provenance:{url:'data:text/html,unsafe'}}]}]});
 const e=g.edges[0];assert.equal(e.kind,'cooccurrence');assert.equal(e.label,'Shared email');assert.equal(e.direction,null);assert.equal(e.confidence,null);assert.equal(e.provenance,null);assert.equal(e.evidence[0].type,null);assert.equal(e.evidence[0].provenance,null);
});

test('merged identity aliases keep only canonical targets in the visible graph',()=>{
 const g=normalizeGraph({nodes:[{id:'canonical',name:'Julian',mergedProfiles:[{id:'old',name:'Julian Ruune',company:'Studio'}]}],edges:[],personAliases:{old:'canonical',missing:'hidden',canonical:'canonical'}});
 assert.deepEqual(g.personAliases,{old:'canonical'});assert.deepEqual(g.nodes[0].mergedProfiles,[{id:'old',name:'Julian Ruune',company:'Studio'}]);
});

test('connection lists never infer direction or expose excluded neighbor identities',async()=>{
 const {incidentConnections}=await import('../public/relationship-graph/connections.mjs');
 const graph={nodes:[{id:'a',name:'A'},{id:'b',name:'B'},{id:'hidden',name:'Hidden',permission:'denied'}],edges:[{id:'email',source:'a',target:'b',types:['shared_email']},{id:'private',source:'a',target:'hidden'}]};
 const connections=incidentConnections(graph,'a');assert.equal(connections.length,1);assert.equal(connections[0].person.id,'b');assert.equal(connections[0].direction,null);
});
