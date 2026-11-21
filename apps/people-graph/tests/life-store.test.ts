import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {opaque} from '../src/mail-model';
import {LifeSignalStore,type LifeCandidate} from '../src/life-signals';

const DAY=86400000;
const travel:LifeCandidate={category:'travel',tier:'open',summary:'Back from Japan',quote:'I just got back from two weeks in Japan.'};

test('life store: signals are off until the owner turns them on',async()=>{
 const f=await fixture();
 assert.deepEqual(await f.service.getLifeSettings(),{enabled:false});
 await f.service.setLifeSignals(true);
 assert.deepEqual(await f.service.getLifeSettings(),{enabled:true});
});

test('life store: a stored signal carries its category expiry',async()=>{
 const f=await fixture(),now=Date.UTC(2026,10,1),store=new LifeSignalStore(f.ctx.storage,()=>now);
 store.add(f.personId,travel,'gmail','m1',now-DAY,0);
 const [signal]=store.list([f.personId]);
 assert.equal(signal.category,'travel');
 assert.equal(signal.expiresAt,new Date(now-DAY+60*DAY).toISOString());
 assert.equal(signal.id,'gmail:m1:0');
});

test('life store: expired signals are hidden and purged',async()=>{
 const f=await fixture(),observed=Date.UTC(2026,0,1);
 new LifeSignalStore(f.ctx.storage,()=>observed).add(f.personId,travel,'gmail','m1',observed,0);
 const later=new LifeSignalStore(f.ctx.storage,()=>observed+61*DAY);
 assert.deepEqual(later.list([f.personId]),[]);
 later.purgeExpired();
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM life_signals').get()!.n,0);
});

test('life store: forgetting everything never resurrects processed sources',async()=>{
 const f=await fixture(),store=new LifeSignalStore(f.ctx.storage);
 store.add(f.personId,travel,'gmail','m1',Date.now(),0);store.markProcessed('gmail:m1');
 assert.equal(store.forget({all:true}),1);
 assert.equal(store.processed('gmail:m1'),true);
 assert.deepEqual(store.list(),[]);
});

test('life store: a merged person sees the signals of every merged address',async()=>{
 const f=await fixture();
 f.add('ada.home@example.test','Ada');
 const other=await opaque('owner@example.test','ada.home@example.test',f.env.TOKEN_SECRET);
 await f.service.setPersonMerge(other,f.personId);
 const store=new LifeSignalStore(f.ctx.storage);
 store.add(f.personId,travel,'gmail','m1',Date.now(),0);
 store.add(other,{...travel,category:'hobby',summary:'Took up film photography'},'gmail','m2',Date.now(),0);
 const listed=await f.service.listLifeSignals(other);
 assert.deepEqual(listed.signals.map(s=>s.category).sort(),['hobby','travel']);
 assert.equal((await f.service.forgetLifeSignals({personId:f.personId})).removed,2);
});

test('life store: owner timeline entries are bounded and dated',async()=>{
 const f=await fixture();
 await assert.rejects(f.service.addTimelineEntry({text:'x'.repeat(281)}),/invalid_request/);
 await assert.rejects(f.service.addTimelineEntry({text:'Moved to Lisbon',date:'2026-13-40'}),/invalid_request/);
 const entry=await f.service.addTimelineEntry({text:'Moved to Lisbon',category:'moved',date:'2026-03-01'});
 assert.equal(entry.date,'2026-03-01');
 assert.deepEqual((await f.service.listTimeline()).entries.map(e=>e.text),['Moved to Lisbon']);
 assert.equal((await f.service.forgetTimelineEntry(entry.id)).removed,true);
 assert.deepEqual((await f.service.listTimeline()).entries,[]);
});
