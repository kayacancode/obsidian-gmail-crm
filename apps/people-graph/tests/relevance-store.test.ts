import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {RelevanceStore} from '../src/relevance-store';
import type {ThemeSignal} from '../src/relevance-model';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function fixture(owner='owner-a') {
	const db = new DatabaseSync(':memory:');
	const alarms:number[] = [];
	const ctx = {storage:{sql:{exec(sql:string,...args:any[]) {
		if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) { db.exec(sql); return {toArray:()=>[]}; }
		const statement = db.prepare(sql);
		const rows = /^\s*SELECT/i.test(sql) ? statement.all(...args) : (statement.run(...args),[]);
		return {toArray:()=>rows};
	}}, transactionSync(fn:()=>void) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }, setAlarm:async(value:number)=>{alarms.push(value);}}};
	return {db,alarms,ctx,store:new RelevanceStore(ctx as any,async()=>owner)};
}

function signal(overrides:Partial<ThemeSignal>={}) : ThemeSignal {
	return {id:'signal-agent-memory-ada',owner:'owner-a',personId:'person-ada',themeId:'theme-agent-memory',sourceType:'gmail_subject',visibility:'private',observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:1,summary:'Subject metadata matched Agent memory',evidenceRef:'metadata:subject-hash',contentHash:'subject-hash',extractorVersion:'metadata-v1',...overrides};
}

for(const source of ['mail','obsidian'] as const)test(`final wave corrected ${source} evidence follows scoped components after reload`,async()=>{
	const {store,db,ctx}=fixture();
	try {
		const signals=[signal(),signal({id:'bo',personId:'person-bo',contentHash:'bo'}),signal({id:'target',themeId:'replacement',contentHash:'target'})];
		await store.ingest(signals);
		await store.recordFeedback({themeId:'theme-agent-memory',personId:'person-ada',action:'correct',replacementThemeId:'replacement',idempotencyKey:'correct'});
		const fresh=new RelevanceStore(ctx as any,async()=>'owner-a');
		const graph={nodes:[{id:'person-ada'},{id:'person-bo'}],edges:[],themes:['theme-agent-memory','replacement'].map(id=>({id,canonicalName:id,aliases:[],description:'',status:'active' as const})),themeSignals:signals.map(({owner,...s})=>s)};
		const evidence=source==='mail'?await fresh.evidence('replacement','my'):await fresh.pushedEvidence(graph,'replacement','my',NOW);
		assert.deepEqual(evidence.signals.map(s=>s.id).sort(),['signal-agent-memory-ada','target']);
		const original=source==='mail'?await fresh.evidence('theme-agent-memory','my'):await fresh.pushedEvidence(graph,'theme-agent-memory','my',NOW);
		assert.deepEqual(original.signals.map(s=>s.id),['bo']);
	}finally{db.close();}
});

test('owner-scoped stores do not expose another owner\'s themes or feedback',async()=>{
	const {db,ctx,store:ownerA} = fixture('owner-a');
	const ownerB = new RelevanceStore(ctx as any,async()=> 'owner-b');
	await ownerA.ingest([signal()]);
	await ownerA.recordFeedback({idempotencyKey:'owner-a-mute',themeId:'theme-agent-memory',action:'mute',createdAt:new Date(NOW).toISOString()});
	assert.deepEqual((await ownerA.snapshot('my',NOW)).themes,[]);
	assert.deepEqual((await ownerB.snapshot('my',NOW)).themes,[]);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM themes WHERE owner='owner-a'").get().n,1);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM themes WHERE owner='owner-b'").get().n,0);
	db.close();
});

test('metadata baseline stores only repeated subject-derived compact assertions',async()=>{
	const {db,store} = fixture();
	await store.ingestMetadata('me@example.com',[
		{personId:'person-ada',subject:'Agent memory review',observedAt:'2026-09-13T12:00:00.000Z',contentHash:'subject-one'},
		{personId:'person-ada',subject:'Agent memory roadmap',observedAt:'2026-09-12T12:00:00.000Z',contentHash:'subject-two'},
	],NOW);
	const snapshot = await store.snapshot('my',NOW);
	assert.equal(snapshot.themes[0]?.name,'Agent Memory');
	const row = db.prepare('SELECT source_type, summary, evidence_ref, content_hash FROM theme_signals').get() as any;
	assert.equal(row.source_type,'gmail_subject');
	assert.ok(!JSON.stringify(row).includes('@'));
	assert.ok(!JSON.stringify(row).includes('review'));
	db.close();
});

test('metadata rebuild replaces one account subject signals, preserves other accounts, and honors its generation fence',async()=>{
	const {db,store} = fixture();
	await store.ingestMetadata('first@example.com',[
		{personId:'person-ada',subject:'Agent memory review',observedAt:'2026-09-13T12:00:00.000Z',contentHash:'first-old-one'},
		{personId:'person-ada',subject:'Agent memory roadmap',observedAt:'2026-09-12T12:00:00.000Z',contentHash:'first-old-two'},
	],NOW);
	await store.ingestMetadata('second@example.com',[
		{personId:'person-bo',subject:'People strategy review',observedAt:'2026-09-13T12:00:00.000Z',contentHash:'second-one'},
		{personId:'person-bo',subject:'People strategy roadmap',observedAt:'2026-09-12T12:00:00.000Z',contentHash:'second-two'},
	],NOW);
	await store.ingestMetadata('first@example.com',[
		{personId:'person-ada',subject:'Developer tools review',observedAt:'2026-09-14T11:00:00.000Z',contentHash:'first-new-one'},
		{personId:'person-ada',subject:'Developer tools roadmap',observedAt:'2026-09-14T10:00:00.000Z',contentHash:'first-new-two'},
	],NOW);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='first@example.com' AND theme_id LIKE '%agent%'").get().n,0);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='first@example.com'").get().n,2);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='second@example.com'").get().n,2);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM themes WHERE canonical_name='agent memory'").get().n,0);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM themes WHERE canonical_name IN ('developer tools','people strategy')").get().n,2);
	await store.ingestMetadata('first@example.com',[
		{personId:'person-ada',subject:'Stale replacement',observedAt:'2026-09-14T12:00:00.000Z',contentHash:'stale-one'},
		{personId:'person-ada',subject:'Stale replacement',observedAt:'2026-09-14T11:00:00.000Z',contentHash:'stale-two'},
	],NOW,()=>false);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='first@example.com'").get().n,2);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM themes WHERE canonical_name='developer tools'").get().n,1);
	db.close();
});

test('feedback is append-only, idempotent, and honors expired feedback',async()=>{
	const {db,store} = fixture();
	await store.ingest([signal()]);
	const created = await store.recordFeedback({idempotencyKey:'mute-1',themeId:'theme-agent-memory',action:'mute',createdAt:new Date(NOW).toISOString()});
	assert.equal((await store.recordFeedback({idempotencyKey:'mute-1',themeId:'theme-agent-memory',action:'mute',createdAt:new Date(NOW).toISOString()})).id,created.id);
	assert.deepEqual((await store.snapshot('my',NOW)).themes,[]);
	await store.ingest([signal({id:'signal-second',themeId:'theme-second',contentHash:'second'})]);
	await store.recordFeedback({idempotencyKey:'expired-mute',themeId:'theme-second',action:'mute',createdAt:new Date(NOW-10_000).toISOString(),expiresAt:new Date(NOW-1).toISOString()});
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get().n,2);
	assert.equal((await store.snapshot('my',NOW)).themes[0]?.themeId,'theme-second');
	db.close();
});

test('feedback idempotency keys are bound to the validated mutation body',async()=>{
	const {db,store}=fixture();await store.ingest([signal()]);
	await store.recordFeedback({idempotencyKey:'body-bound-key',themeId:'theme-agent-memory',personId:'person-ada',action:'pin'});
	await assert.rejects(store.recordFeedback({idempotencyKey:'body-bound-key',themeId:'theme-agent-memory',personId:'person-ada',action:'mute'}),/invalid_relevance_feedback/);
	await assert.rejects(store.recordFeedback({idempotencyKey:'body-bound-key',themeId:'theme-agent-memory',personId:'person-other',action:'pin'}),/invalid_relevance_feedback/);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relevance_feedback').get()!.n,1);db.close();
});

test('removing an account deletes only that account\'s derived assertions',async()=>{
	const {db,store} = fixture();
	await store.ingest([
		signal({id:'from-first',contentHash:'first',evidenceRef:'metadata:first',account:'first@example.com'} as ThemeSignal),
		signal({id:'from-second',contentHash:'second',evidenceRef:'metadata:second',account:'second@example.com'} as ThemeSignal),
	]);
	await store.removeAccountData('first@example.com');
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='first@example.com'").get().n,0);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='second@example.com'").get().n,1);
	db.close();
});

test('graph additions retain the legacy node and edge fields and expose opaque relevance data',async()=>{
	const {db,store} = fixture();
	await store.ingest([signal()]);
	const graph = await store.attachToGraph({nodes:[{id:'person-ada',name:'Ada'}],edges:[{source:'person-ada',target:'person-bo',weight:2,types:['shared_email']}],source:'email_accounts'},'my',NOW);
	assert.equal(graph.nodes[0].name,'Ada');
	assert.equal(graph.edges[0].weight,2);
	assert.equal(graph.relevance.themes[0]?.themeId,'theme-agent-memory');
	assert.ok(!JSON.stringify(graph.themeSignals).includes('@'));
	db.close();
});

test('pushed graph relevance keeps local identities, applies owner feedback, and excludes server graph identities',async()=>{
	const {db,store}=fixture();
	await store.ingest([signal({personId:'gmail-derived-id'})]);
	const graph={nodes:[{id:'local-ada',name:'Ada',x:123}],edges:[],themes:[{id:'theme-local',canonicalName:'agent memory',aliases:['Agent Memory'],description:'Local theme: agent memory',status:'active' as const}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note' as const,visibility:'private' as const,observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Working on agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};
	const mine=await store.attachPushedGraph(graph,'my',NOW);
	assert.equal(mine.nodes[0].x,123);assert.equal(mine.relevance.themes[0].nodeIds[0],'local-ada');assert.ok(!JSON.stringify(mine).includes('gmail-derived-id'));
	await store.recordFeedback({idempotencyKey:'mute-local-theme',themeId:'theme-local',action:'mute',createdAt:new Date(NOW).toISOString()});
	assert.deepEqual((await store.attachPushedGraph(graph,'my',NOW)).relevance.themes,[]);
	assert.deepEqual((await store.attachPushedGraph(graph,'firm',NOW)).relevance.themes,[]);
	db.close();
});

test('evidence APIs hide themes and signals outside the selected lens for stored and pushed sources',async()=>{
	const {db,store}=fixture();await store.ingest([signal()]);
	assert.deepEqual(await store.evidence('theme-agent-memory','public'),{theme:null,signals:[]});
	const graph={nodes:[{id:'local-ada'}],edges:[],themes:[{id:'theme-local',canonicalName:'agent memory',aliases:['Agent Memory'],description:'Local theme',status:'active' as const}],themeSignals:[{id:'signal-local',personId:'local-ada',themeId:'theme-local',sourceType:'obsidian_note' as const,visibility:'private' as const,observedAt:'2026-09-13T12:00:00.000Z',ingestedAt:'2026-09-14T12:00:00.000Z',confidence:.9,summary:'Agent memory',evidenceRef:'obsidian:People/Ada.md',contentHash:'a'.repeat(64),extractorVersion:'local-theme-v1'}]};
	assert.deepEqual(await store.pushedEvidence(graph,'theme-local','public',NOW),{theme:null,signals:[]});
	assert.equal((await store.pushedEvidence(graph,'theme-local','my',NOW)).signals[0].personId,'local-ada');db.close();
});

test('the next relevance job is the only alarm candidate when it is earlier than mail sync',async()=>{
	const {db,store} = fixture();
	db.prepare("INSERT INTO retrieval_jobs (id, owner, due_at, status, idempotency_key) VALUES (?, ?, ?, ?, ?)").run('job-1','owner-a',NOW+1_000,'queued','job-key');
	assert.equal(await store.nextAlarmAt(NOW+10_000),NOW+1_000);
	assert.equal(await store.nextAlarmAt(NOW+500),NOW+500);
	db.close();
});
