import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateMoments,type MomentInput,type Moment} from '../src/moments';
import type {WhyNowAnswer,TriggerKind,ContrastAnswer,BridgePair,WidenResult} from '../src/network-structure';

const NOW=Date.parse('2026-11-21T12:00:00.000Z'),DAY=86_400_000,TODAY='2026-11-21';
const at=(days:number)=>new Date(NOW-days*DAY).toISOString();
const why=(personId:string,trigger:TriggerKind,summary:string,observedAt=at(1)):WhyNowAnswer=>({personId,name:personId.toUpperCase(),score:1,when:{lastContact:at(10)},why:[{kind:'trigger',trigger,summary,source:'gmail',observedAt,attribution:'first_hand'}]});
const distant=(personId:string,value:0|0.5|1):ContrastAnswer=>({personId,name:personId.toUpperCase(),relevance:0.8,distance:{value,cluster:null,reason:'Outside your usual circles'},stance:null,score:1,why:[{kind:'evidence',summary:'nurse scheduling pilots',source:'gmail',observedAt:at(3),attribution:'first_hand'}]});
const pair=(a:string,b:string,keywords:string[]):BridgePair=>({people:[{personId:a,name:a},{personId:b,name:b}],sharedEvidence:{themes:[],keywords},distanceBetween:1,why:[]});

function input(extra:Partial<MomentInput>={}):MomentInput{
 return {now:NOW,day:TODAY,budget:3,
  notes:[{id:'note_1',title:'Agentic networks',keywords:new Set(['nurses','scheduling','privacy','agents']),people:[{name:'Wen',personId:'w',wantToTalk:true}],fringes:['Would nurses trust an agent to schedule them?']}],
  whyNow:[],evidence:{},lastContact:{w:at(45)},names:{w:'Wen'},fringe:[],bridges:[],widen:null,existing:[],suppressed:[],excluded:new Set(),...extra};
}
const kinds=(moments:Moment[])=>moments.map(m=>`${m.kind}:${m.personIds.join('+')}`);

test('moments: each kind comes from its trigger, with note relevance where required',()=>{
 const widen:WidenResult={answers:[{personId:'z',name:'Z',distance:{value:1,cluster:null,reason:'x'},why:[]}],result:{pattern:{cluster:{companies:['acme.test'],themes:[]},share:0.8,interactions:20,days:30}},gaps:[]};
 const all=generateMoments(input({budget:10,
  whyNow:[why('m','meeting_soon','Meeting "Roadmap" on 2026-11-22',new Date(NOW+DAY).toISOString()),why('f','fresh_signal','Back from a nurse scheduling conference'),why('g','fresh_signal','Back from Japan'),why('c','going_cold','100 days since you last spoke')],
  evidence:{c:['privacy for shared graphs']},
  fringe:[{fringe:'Would nurses trust an agent to schedule them?',answers:[distant('n0',0.5),distant('n1',1)]}],
  bridges:[pair('b1','b2',['scheduling','nurses']),pair('b3','b4',['golf','tennis'])],widen}));
 const got=kinds(all);
 for(const expected of ['pre_meeting:m','want_to_talk:w','fresh_signal:f','fringe_match:n1','bridge:b1+b2','cold_and_relevant:c'])assert.ok(got.includes(expected),`${expected} in ${got}`);
 assert.ok(!got.includes('fresh_signal:g'),'not relevant to any note');
 assert.ok(!got.includes('fringe_match:n0'),'fringe needs distance 1');
 assert.ok(!got.includes('bridge:b3+b4'),'bridge needs note relevance');
 // Surprise is rationed: the fringe match already used today's one surprise.
 assert.ok(!got.some(k=>k.startsWith('widen:')));
 const meeting=all.find(m=>m.kind==='pre_meeting')!;
 assert.equal(meeting.expiresAt,new Date(NOW+DAY).toISOString());
 assert.equal(all.find(m=>m.kind==='bridge')!.expiresAt,new Date(NOW+14*DAY).toISOString());
 assert.ok(all.every(m=>m.status==='new'&&m.day===TODAY&&m.answer.why.length>0));
});

test('moments: without a note only meetings surface',()=>{
 const got=kinds(generateMoments(input({notes:[],whyNow:[why('m','meeting_soon','Meeting soon',new Date(NOW+3600_000).toISOString()),why('f','fresh_signal','nurse scheduling news')]})));
 assert.deepEqual(got,['pre_meeting:m']);
});

test('moments: budget keeps the highest priorities, one per person, rationed surprise',()=>{
 const got=kinds(generateMoments(input({
  whyNow:[why('c','going_cold','privacy is going quiet'),why('f','fresh_signal','nurses news'),why('m','meeting_soon','Meeting',new Date(NOW+3600_000).toISOString()),why('m','fresh_signal','nurses again')],
  evidence:{c:['privacy']},
  fringe:[{fringe:'f',answers:[distant('n1',1),distant('n2',1)]}]})));
 assert.deepEqual(got,['pre_meeting:m','want_to_talk:w','fresh_signal:f']);
});

test('moments: no one twice within 7 days, and dismissals hold for 30 days',()=>{
 const earlier:Moment={id:'old',kind:'fresh_signal',personIds:['f'],trigger:'x',answer:{why:[],gaps:[]},createdAt:at(5),expiresAt:at(-2),status:'acted',day:'2026-11-16'};
 const got=kinds(generateMoments(input({existing:[earlier],
  whyNow:[why('f','fresh_signal','nurses news'),why('m','meeting_soon','Meeting',new Date(NOW+3600_000).toISOString())],
  suppressed:[{personId:'w',kind:'want_to_talk',until:NOW+20*DAY},{personId:'m',kind:'pre_meeting',until:NOW-DAY}]})));
 assert.deepEqual(got,['pre_meeting:m']);
});

test('moments: today\'s budget and surprise ration count moments already made today',()=>{
 const made=(kind:Moment['kind'],person:string):Moment=>({id:person,kind,personIds:[person],trigger:'x',answer:{why:[],gaps:[]},createdAt:at(0),expiresAt:at(-14),status:'new',day:TODAY});
 const widen:WidenResult={answers:[{personId:'z',name:'Z',distance:{value:1,cluster:null,reason:'x'},why:[]}],result:{pattern:{cluster:{companies:[],themes:[]},share:0.8,interactions:20,days:30}},gaps:[]};
 assert.deepEqual(kinds(generateMoments(input({existing:[made('fringe_match','q')],widen,lastContact:{w:at(1)}}))),[]);
 assert.deepEqual(kinds(generateMoments(input({existing:[made('bridge','p1'),made('bridge','p2'),made('bridge','p3')]}))),[]);
});

test('moments: only people under "Who I want to talk to" become want_to_talk, and judged-out people never appear',()=>{
 const notes=[{id:'note_1',title:'Agentic networks',keywords:new Set(['nurses']),fringes:[],
  people:[{name:'Wen',personId:'w',wantToTalk:true},{name:'Idea source',personId:'s',wantToTalk:false},{name:'Set aside',personId:'x',wantToTalk:true}]}];
 const got=kinds(generateMoments(input({notes,lastContact:{w:at(45),s:at(90),x:at(90)},excluded:new Set(['x','m']),
  whyNow:[why('m','meeting_soon','Meeting',new Date(NOW+3600_000).toISOString())]})));
 assert.deepEqual(got,['want_to_talk:w']);
});
