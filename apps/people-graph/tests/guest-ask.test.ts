import {test} from 'node:test';
import assert from 'node:assert/strict';
import {anonymous,forbiddenTokens,guestView,expireAsk,checkDailyLimit,decideAsk,type GuestAsk} from '../src/guest-ask';

const NOW=Date.parse('2026-11-21T12:00:00.000Z'),DAY=86_400_000;
const forbidden=forbiddenTokens([{name:'Maya Rivera',company:'acme.test'},{name:'Bo',company:'gmail.com'}],['acme.test']);
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
