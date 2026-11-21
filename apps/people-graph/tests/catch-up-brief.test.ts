import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {assembleBrief,type BriefInput} from '../src/catch-up-brief';
import {LifeSignalStore,type LifeSignal} from '../src/life-signals';

const DAY=86400000,now=Date.UTC(2026,10,21);
const iso=(ms:number)=>new Date(ms).toISOString();
const signal=(category:LifeSignal['category'],tier:LifeSignal['tier'],observed:number,summary:string):LifeSignal=>({id:category,personId:'p',category,tier,summary,quote:'q',source:'gmail',sourceRef:'m',observedAt:iso(observed),expiresAt:iso(observed+60*DAY)});
const base=(over:Partial<BriefInput>={}):BriefInput=>({person:{id:'p',name:'Maya',company:'acme',lastContact:iso(now-100*DAY),combined:60},signalsEnabled:true,signals:[],work:[],memory:[],feedback:null,relationship:'neutral',stints:[],timeline:[],now,...over});

test('brief: sensitive signals are tone-only, open ones may rank',()=>{
 const brief=assembleBrief(base({signals:[signal('health','sensitive',now-5*DAY,'Recovering from surgery'),signal('travel','open',now-10*DAY,'Back from Japan')]}));
 const why=brief.answers[0].why;
 assert.deepEqual(why.filter(w=>w.kind==='life').map(w=>[w.category,w.use]),[['health','tone_only'],['travel','rank']]);
 assert.ok(why.every(w=>w.attribution==='first_hand'&&w.source&&w.observedAt));
});

test('brief: since-you-last-spoke tells both sides, after the last contact only',()=>{
 const brief=assembleBrief(base({
  signals:[signal('travel','open',now-10*DAY,'Back from Japan'),signal('hobby','open',now-200*DAY,'Took up surfing')],
  stints:[{id:'s',personId:'p',company:'zeta',domain:'zeta.io',from:iso(now-40*DAY).slice(0,7),to:null,source:'email_domain'}],
  timeline:[{id:'t1',text:'Moved to Lisbon',category:'moved',date:iso(now-30*DAY).slice(0,10),createdAt:now},{id:'t0',text:'Old news',category:null,date:iso(now-300*DAY).slice(0,10),createdAt:now}],
 }));
 assert.deepEqual(brief.sinceLastContact.theirs.map(t=>[t.kind,t.summary]),[['stint','Started at zeta'],['signal','Back from Japan']]);
 assert.deepEqual(brief.sinceLastContact.yours.map(t=>t.text),['Moved to Lisbon']);
 assert.equal(brief.answers[0].when.label,'cooling');
 assert.equal(brief.answers[0].when.daysSince,100);
});

test('brief: honest gaps when signals are off and no contact date exists',()=>{
 const brief=assembleBrief(base({signalsEnabled:false,person:{id:'p',name:'Maya',company:'',lastContact:null,combined:null}}));
 assert.ok(brief.gaps.includes('No life signals: signals are off'));
 assert.ok(brief.gaps.includes('No contact date recorded'));
 assert.ok(brief.gaps.includes('No first-hand notes'));
 assert.equal(brief.answers[0].when.daysSince,null);
});

test('brief: the owner network answers by name with live signals and no expired ones',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 const store=new LifeSignalStore(f.ctx.storage);
 store.add(f.personId,{category:'travel',tier:'open',summary:'Back from Japan',quote:'I just got back from Japan last week.'},'gmail','m1',Date.now()-DAY,0);
 store.add(f.personId,{category:'travel',tier:'open',summary:'Was in Peru',quote:'I was in Peru for the whole month.'},'gmail','m0',Date.now()-90*DAY,0);
 const result=await f.service.catchUpBrief({query:'Ada'});
 assert.ok(result.ok);
 const life=result.brief.answers[0].why.filter(w=>w.kind==='life').map(w=>w.summary);
 assert.deepEqual(life,['Back from Japan']);
 assert.equal(result.brief.answers[0].name,'Ada');
});

test('brief: a name shared by two people asks which one',async()=>{
 const f=await fixture();
 f.add('ada.k@other.test','Ada');
 const result=await f.service.catchUpBrief({query:'Ada'});
 assert.equal(result.ok,false);
 assert.ok(!result.ok&&result.error==='ambiguous_person'&&result.candidates.length===2);
});
