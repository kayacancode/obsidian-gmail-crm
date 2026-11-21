import {test} from 'node:test';
import assert from 'node:assert/strict';
import {anonymous,identifies,checkAnswer,forbiddenTokens,guestView,expireAsk,checkDailyLimit,decideAsk,type GuestAsk} from '../src/guest-ask';

const NOW=Date.parse('2026-11-21T12:00:00.000Z'),DAY=86_400_000;
const forbidden=forbiddenTokens([{name:'Maya Rivera',company:'acme.test'},{name:'Bo',company:'gmail.com'}],['maya@acme.test','bo@gmail.com']);
const ask=(over:Partial<GuestAsk>={}):GuestAsk=>({id:'ga_1',guest:'g1',guestEmail:'founder@startup.test',question:'Who knows nurse scheduling?',status:'pending',
 draft:{text:'Two people in my network work on this.',people:[{ref:'p1',personId:'p-maya',description:'A design lead at a health startup working on nurse scheduling'}]},answer:null,introductions:{},createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString(),...over});

test('guest ask: descriptions never name people, companies, domains or addresses',()=>{
 assert.equal(anonymous('A design lead at a health startup',forbidden),'A design lead at a health startup');
 for(const leak of ['Maya leads design','Works at Acme','Writes from acme.test','ping founder@x.test','see https://x.test','Rivera is great','Talk to Bo'])
  assert.equal(anonymous(leak,forbidden),null,leak);
 // Whole words only: "Bo" must not knock out "board".
 assert.equal(anonymous('Sits on a nonprofit board',forbidden),'Sits on a nonprofit board');
 assert.equal(anonymous('x'.repeat(201),forbidden),null);
});

test('guest ask: employers, universities, short company names, accents and mailbox names are identifiers',()=>{
 const network=forbiddenTokens([{name:'José García',company:'HP'},{name:'Priya Shah',company:'Meta Platforms, Inc.'},{name:'Lee Park',company:'cs.stanford.edu'}],['jgarcia@hp.com','pshah@meta.com','lpark@cs.stanford.edu']);
 for(const leak of ['A product manager at Meta','A PhD student at Stanford','Jose Garcia, hardware at HP','Reach out to jgarcia','Works with García on chips','Shah leads payments'])
  assert.equal(anonymous(leak,network),null,leak);
 // "hp" only as the company's own spelling: an unrelated lowercase word is fine.
 assert.equal(anonymous('A hardware engineer who ships printers',network),'A hardware engineer who ships printers');
});

test('guest ask: common words in names and companies stay usable; the full name or company still does not',()=>{
 const network=forbiddenTokens([{name:'An Nguyen',company:''},{name:'Wei He',company:''},{name:'Will Grant',company:'Health Labs'}],['an@example.org','wei@example.org','will@healthlabs.io']);
 for(const ok of ['A design lead at an AI startup','He runs growth for a marketplace','Will know about this','Someone in my network who works on health'])
  assert.equal(anonymous(ok,network),ok,ok);
 for(const leak of ['Talk to Will Grant','Nguyen leads design','Works at Health Labs','Wei He knows this'])
  assert.equal(anonymous(leak,network),null,leak);
 // The owner learns which words to change (owner-only; never shown to a guest).
 assert.equal(identifies('Talk to Will Grant',network),'will grant');
 assert.throws(()=>checkAnswer({text:'Ask Nguyen.',people:[]},new Set(),network),/answer_not_anonymous:nguyen/);
});

test('guest ask: guests see the approved answer only, and a name only after the person opted in',()=>{
 const pending=guestView(ask(),{});
 assert.deepEqual(pending,{id:'ga_1',question:'Who knows nurse scheduling?',status:'pending',createdAt:new Date(NOW).toISOString(),answer:null});
 const answered=ask({status:'answered',answer:{text:'One person fits.',people:[{ref:'p1',description:'A design lead at a health startup'}]},introductions:{p1:'intro_1'}});
 const hidden=guestView(answered,{intro_1:{status:'introducer_accepted',name:'Maya Rivera'}});
 assert.deepEqual(hidden.answer,{text:'One person fits.',people:[{ref:'p1',description:'A design lead at a health startup',introduction:'introducer_accepted'}]});
 assert.ok(!JSON.stringify(hidden).includes('p-maya')&&!JSON.stringify(hidden).includes('Maya'));
 const revealed=guestView(answered,{intro_1:{status:'target_opted_in',name:'Maya Rivera'}});
 assert.equal(revealed.answer?.people[0].name,'Maya Rivera');
});

test('guest ask: unanswered asks expire after seven days, answered ones stay',()=>{
 assert.equal(expireAsk(ask(),NOW+6*DAY).status,'pending');
 assert.equal(expireAsk(ask(),NOW+7*DAY+1).status,'expired');
 assert.equal(expireAsk(ask({status:'answered'}),NOW+30*DAY).status,'answered');
});

test('guest ask: three questions per guest per day',()=>{
 const today=[ask({id:'a'}),ask({id:'b'}),ask({id:'c',guest:'other'})];
 assert.doesNotThrow(()=>checkDailyLimit(today,'g1',NOW));
 assert.throws(()=>checkDailyLimit([...today,ask({id:'d'})],'g1',NOW),/guest_rate_limited/);
 assert.doesNotThrow(()=>checkDailyLimit([ask({id:'old',createdAt:new Date(NOW-DAY-1).toISOString()}),ask({id:'b'}),ask({id:'c'})],'g1',NOW));
});

test('guest ask: only pending asks are answered or declined',()=>{
 assert.equal(decideAsk(ask(),'declined',null,NOW).status,'declined');
 assert.throws(()=>decideAsk(ask({status:'answered'}),'declined',null,NOW),/guest_ask_state_invalid/);
 assert.throws(()=>decideAsk(ask({status:'expired'}),'answered',null,NOW),/guest_ask_state_invalid/);
 assert.equal(decideAsk(ask(),'answered',{text:'One person fits.',people:[{ref:'p1',description:'A design lead'}]},NOW).answer?.text,'One person fits.');
});
