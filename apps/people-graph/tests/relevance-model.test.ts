import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	canonicalThemeName,
	metadataThemeSignals,
	rankSerendipity,
	scoreConnectors,
	scoreRelevance,
	type ThemeSignal,
} from '../src/relevance-model';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const iso = (daysAgo = 1) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const signal = (overrides: Partial<ThemeSignal> = {}): ThemeSignal => ({
	id: 'signal-agents', owner: 'owner', themeId: 'theme-agents', sourceType: 'product_activity',
	visibility: 'private', observedAt: iso(), ingestedAt: iso(), confidence: 1,
	summary: 'Agent memory activity', evidenceRef: 'activity:1', contentHash: 'hash', extractorVersion: 'v1',
	...overrides,
});
const feedback = (action: 'pin'|'mute'|'correct'|'expire') => ({
	id: `feedback-${action}`, owner: 'owner', themeId: 'theme-agents', action, createdAt: iso(),
});

for (const action of ['mute','expire','correct','pin'] as const) test(`final wave person ${action} affects only their shared-theme association`, () => {
	const signals=[signal({id:'a',personId:'person-a',confidence:.01}),signal({id:'b',personId:'person-b',confidence:.01}),signal({id:'strong',themeId:'other',confidence:1})];
	const baseline=scoreRelevance(signals,[],'my',NOW).themes.find(t=>t.themeId==='theme-agents')!;
	const result=scoreRelevance(signals,[{...feedback(action),personId:'person-a',replacementThemeId:action==='correct'?'replacement':undefined}],'my',NOW);
	const shared=result.themes.find(t=>t.themeId==='theme-agents')!;
	assert.ok(shared);
	if(action==='pin'){
		assert.equal(shared.score,baseline.score);
		assert.equal(shared.nodeScores?.['person-b']??shared.score,baseline.score);
		assert.equal(shared.nodeScores?.['person-a'],65);
	}else {
		assert.deepEqual(shared.nodeIds,['person-b']);
		assert.deepEqual(shared.components.map(c=>c.signalId),['b']);
		if(action==='correct')assert.deepEqual(result.themes.find(t=>t.themeId==='replacement')!.nodeIds,['person-a']);
	}
	assert.deepEqual(scoreRelevance(signals,[{...feedback(action),personId:'person-a',replacementThemeId:'replacement',expiresAt:iso(1)}],'my',NOW),scoreRelevance(signals,[],'my',NOW));
});

test('normalizes Unicode names and emits a subject theme only after two observations', () => {
	assert.equal(canonicalThemeName('  AGEŃT—Memory!!! '), 'agent memory');
	const one = metadataThemeSignals([{personId:'ada', subject:'Agent Memory', observedAt:iso()}], 'owner', NOW);
	assert.deepEqual(one.themes, []);
	const two = metadataThemeSignals([
		{personId:'ada', subject:'Agent Memory', observedAt:iso()},
		{personId:'bo', subject:'Re: Agent Memory', observedAt:iso(2)},
	], 'owner', NOW);
	assert.equal(two.themes.length, 1);
	assert.equal(two.themes[0].canonicalName, 'agent memory');
	assert.equal(two.signals.length, 2);
});

test('scores recent explicit activity above an old subject hint and keeps lenses separate', () => {
	const snapshot = scoreRelevance([
		signal({id:'private', themeId:'theme-agents', sourceType:'product_activity', visibility:'private', observedAt:iso(1)}),
		signal({id:'public', themeId:'theme-subject', sourceType:'gmail_subject', visibility:'public', observedAt:iso(40)}),
	], [], 'my', NOW, [
		{id:'theme-agents', owner:'owner', canonicalName:'agent memory', aliases:[], description:'', status:'active', createdAt:iso(), updatedAt:iso()},
		{id:'theme-subject', owner:'owner', canonicalName:'old subject', aliases:[], description:'', status:'active', createdAt:iso(), updatedAt:iso()},
	]);
	assert.equal(snapshot.themes[0].themeId, 'theme-agents');
	assert.ok(snapshot.themes[0].score > snapshot.themes[1].score);
	assert.equal(snapshot.themes[0].name, 'Agent Memory');
	assert.ok(snapshot.themes[0].score > 50);
	assert.deepEqual(scoreRelevance([signal({id:'private', visibility:'private'})], [], 'public', NOW).themes, []);
});

test('mutes remove heat, pins add a visible floor, and corrections are append-only inputs', () => {
	assert.deepEqual(scoreRelevance([signal()], [feedback('mute')], 'my', NOW).themes, []);
	assert.ok(scoreRelevance([signal({confidence:.1})], [feedback('pin')], 'my', NOW).themes[0].score >= 65);
	const corrected = scoreRelevance([signal()], [{...feedback('correct'), replacementThemeId:'theme-memory'}], 'my', NOW);
	assert.equal(corrected.themes[0].themeId, 'theme-memory');
});

const nodes = [
	{id:'obvious', name:'Obvious'}, {id:'bridge', name:'Bridge'}, {id:'adjacent', name:'Adjacent'}, {id:'inferred', name:'Inferred'},
];
const edges = [
	{id:'obvious-bridge', source:'obvious', target:'bridge', kind:'personal' as const, observedAt:iso()},
	{id:'bridge-adjacent', source:'bridge', target:'adjacent', kind:'personal' as const, observedAt:iso()},
	{id:'bridge-inferred', source:'bridge', target:'inferred', kind:'cooccurrence' as const, observedAt:iso()},
];

test('connector scoring never calls co-occurrence an introduction', () => {
	const scores = scoreConnectors(nodes, edges);
	assert.equal(scores.get('bridge')?.evidenceClass, 'documented');
	assert.equal(scores.get('inferred')?.evidenceClass, 'inferred');
});

test('serendipity favors a relevant non-obvious person with a documented bridge', () => {
	const ranked = rankSerendipity({
		nodes, edges,
		relevance: {themes:[{themeId:'theme-agents', name:'Agent memory', score:90, reason:'recent', nodeIds:['adjacent'], components:[]}], connectors:[...scoreConnectors(nodes, edges).values()]},
		selectedNodeIds:['obvious'], mutedNodeIds:[], now:NOW,
	});
	assert.equal(ranked[0].nodeId, 'adjacent');
	assert.match(ranked[0].reason, /Agent memory|documented bridge/);
	assert.equal(ranked[0].freshness, 'recent');
	assert.ok(ranked.length <= 5);
});

test('serendipity never traverses a muted, restricted, or unresolved bridge', () => {
	const relevance = {themes:[{themeId:'theme-agents', name:'Agent memory', score:90, reason:'recent', nodeIds:['candidate'], components:[]}], connectors:[]};
	for (const blockedBridge of [
		{id:'bridge', permissionConflict:true},
		{id:'bridge', permission:'denied'},
		{id:'bridge', identityStatus:'unresolved'},
	]) {
		const ranked = rankSerendipity({
			nodes:[{id:'selected'}, blockedBridge, {id:'candidate'}],
			edges:[{id:'selected-bridge', source:'selected', target:'bridge', kind:'personal'}, {id:'bridge-candidate', source:'bridge', target:'candidate', kind:'personal'}],
			relevance, selectedNodeIds:['selected'], mutedNodeIds:[], now:NOW,
		});
		assert.deepEqual(ranked, []);
	}
	const muted = rankSerendipity({
		nodes:[{id:'selected'}, {id:'bridge'}, {id:'candidate'}],
		edges:[{id:'selected-bridge', source:'selected', target:'bridge', kind:'personal'}, {id:'bridge-candidate', source:'bridge', target:'candidate', kind:'personal'}],
		relevance, selectedNodeIds:['selected'], mutedNodeIds:['bridge'], now:NOW,
	});
	assert.deepEqual(muted, []);
	const hiddenInPublic = rankSerendipity({
		nodes:[{id:'selected', visibility:'public'}, {id:'bridge', visibility:'private'}, {id:'candidate', visibility:'public'}],
		edges:[{id:'selected-bridge', source:'selected', target:'bridge', kind:'personal'}, {id:'bridge-candidate', source:'bridge', target:'candidate', kind:'personal'}],
		relevance, selectedNodeIds:['selected'], mutedNodeIds:[], lens:'public', now:NOW,
	});
	assert.deepEqual(hiddenInPublic, []);
});

test('serendipity prefers a farther relevant candidate to reduce overlap with viewed people', () => {
	const ranked = rankSerendipity({
		nodes:[{id:'viewed'}, {id:'near-bridge'}, {id:'near'}, {id:'far-one'}, {id:'far-two'}, {id:'far'}],
		edges:[
			{id:'viewed-near', source:'viewed', target:'near-bridge', kind:'personal'}, {id:'near-candidate', source:'near-bridge', target:'near', kind:'personal'},
			{id:'viewed-far-one', source:'viewed', target:'far-one', kind:'personal'}, {id:'far-middle', source:'far-one', target:'far-two', kind:'personal'}, {id:'far-candidate', source:'far-two', target:'far', kind:'personal'},
		],
		relevance:{themes:[
			{themeId:'theme-agents', name:'Agent memory', score:80, reason:'recent', nodeIds:['near'], components:[]},
			{themeId:'theme-agents', name:'Agent memory', score:80, reason:'recent', nodeIds:['far'], components:[]},
		], connectors:[]},
		selectedNodeIds:['viewed'], mutedNodeIds:[], now:NOW,
	});
	assert.deepEqual(ranked.map(item => item.nodeId), ['far','near']);
});

test('serendipity freshness uses the supplied calculation time', () => {
	const ranked = rankSerendipity({
		nodes:[{id:'selected'}, {id:'bridge'}, {id:'candidate', observedAt:'2000-01-02T00:00:00.000Z'}],
		edges:[{id:'selected-bridge', source:'selected', target:'bridge', kind:'personal'}, {id:'bridge-candidate', source:'bridge', target:'candidate', kind:'personal'}],
		relevance:{themes:[{themeId:'theme-agents', name:'Agent memory', score:80, reason:'recent', nodeIds:['candidate'], components:[]}], connectors:[]},
		selectedNodeIds:['selected'], mutedNodeIds:[], now:Date.parse('2000-01-03T00:00:00.000Z'),
	});
	assert.equal(ranked[0].freshness, 'recent');
});

test('serendipity does not read the wall clock when no calculation time is supplied', () => {
	const input = {
		nodes:[{id:'selected'}, {id:'bridge'}, {id:'candidate', observedAt:'2000-01-02T00:00:00.000Z'}],
		edges:[{id:'selected-bridge', source:'selected', target:'bridge', kind:'personal'}, {id:'bridge-candidate', source:'bridge', target:'candidate', kind:'personal'}],
		relevance:{themes:[{themeId:'theme-agents', name:'Agent memory', score:80, reason:'recent', nodeIds:['candidate'], components:[]}], connectors:[]},
		selectedNodeIds:['selected'], mutedNodeIds:[],
	};
	const originalNow = Date.now;
	try {
		Date.now = () => Date.parse('2000-01-03T00:00:00.000Z');
		const first = rankSerendipity(input);
		Date.now = () => Date.parse('2026-09-14T00:00:00.000Z');
		assert.deepEqual(rankSerendipity(input), first);
	} finally { Date.now = originalNow; }
});
