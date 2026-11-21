import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractLifeSignals,LIFE_TIER} from '../src/life-signals';

// Test double: only `run` is exercised by the extractor.
const model=(signals:unknown[])=>({run:async()=>({response:{signals}})}) as unknown as Ai;
const attendees=[{email:'maya@x.test',name:'Maya Rivera'},{email:'sam@y.test',name:'Sam Lee'}];

test('life: a first-person sender statement becomes an open travel signal',async()=>{
 const text='Hi Kaya. I just got back from two weeks in Japan. Let us catch up soon.';
 const got=await extractLifeSignals(model([{start:1,end:1,anchor:1,category:'travel',summary:'Back from two weeks in Japan'}]),text,'sender');
 assert.deepEqual(got,[{category:'travel',tier:'open',summary:'Back from two weeks in Japan',quote:'I just got back from two weeks in Japan.'}]);
});

test('life: a sender talking about a third party is not a signal about the sender',async()=>{
 const got=await extractLifeSignals(model([{start:0,end:0,anchor:0,category:'health',summary:'Broke a leg skiing'}]),'My friend broke her leg skiing last weekend.','sender');
 assert.deepEqual(got,[]);
});

test('life: the tier always comes from the category, never from the model',async()=>{
 const got=await extractLifeSignals(model([{start:0,end:0,anchor:0,category:'health',tier:'open',summary:'Recovering from surgery'}]),'I am recovering from knee surgery this month.','sender');
 assert.equal(got[0].tier,'sensitive');
 assert.equal(LIFE_TIER.health,'sensitive');
});

test('life: invalid categories, long summaries and summaries with addresses are dropped',async()=>{
 const text='I just moved to Lisbon with my family. I started learning to surf this spring. I took up film photography again.';
 const got=await extractLifeSignals(model([
  {start:0,end:0,anchor:0,category:'gossip',summary:'Moved'},
  {start:1,end:1,anchor:1,category:'hobby',summary:'x'.repeat(81)},
  {start:2,end:2,anchor:2,category:'hobby',summary:'Mail me at a@b.test'},
 ]),text,'sender');
 assert.deepEqual(got,[]);
});

test('life: an attendee named in the anchor sentence is the subject',async()=>{
 const got=await extractLifeSignals(model([{start:0,end:0,anchor:0,category:'moved',summary:'Moved to Lisbon'}]),'Maya mentioned she moved to Lisbon in March.','attendee',attendees);
 assert.equal(got.length,1);
 assert.equal(got[0].personHint,'maya@x.test');
 assert.equal(got[0].category,'moved');
});

test('life: an anchor naming two attendees is dropped rather than guessed',async()=>{
 const got=await extractLifeSignals(model([{start:0,end:0,anchor:0,category:'moved',summary:'Moved to Lisbon'}]),'Maya and Sam both moved to Lisbon this year.','attendee',attendees);
 assert.deepEqual(got,[]);
});

test('life: owner notes about the person need no first-person anchor',async()=>{
 const got=await extractLifeSignals(model([{start:0,end:0,anchor:0,category:'health',summary:'Father has been ill'}]),'His dad has been ill since spring.','note');
 assert.equal(got.length,1);
 assert.equal(got[0].tier,'sensitive');
});

test('life: no AI binding is reported, not silently empty',async()=>{
 await assert.rejects(extractLifeSignals(undefined,'I moved to Lisbon.','sender'),/ai_unavailable/);
});
