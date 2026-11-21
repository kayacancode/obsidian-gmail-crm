import {test} from 'node:test';
import assert from 'node:assert/strict';
import {whyNow,type WhyNowContext} from '../src/network-structure';
import {fixture,NOW,at,node} from './network-structure.test';

const DAY=86_400_000;
const quiet=():WhyNowContext=>({now:NOW,lens:{focus:'',needs:''},signals:[],stints:[],jobMoves:[],mail:{},excluded:new Set()});
/** A fixture where nobody has a reason to be contacted now. */
function calm(){
 const input=fixture();
 input.activity=[];input.themeSignals=[];
 for(const n of input.nodes){n.lastContact=at(20);n.strength=40;}
 return input;
}
const kinds=(result:ReturnType<typeof whyNow>,id:string)=>result.answers.find(a=>a.personId===id)?.why.map(w=>w.trigger)??[];

test('why-now: nothing time-sensitive is an honest empty answer',()=>{
 const result=whyNow(calm(),quiet());
 assert.deepEqual(result.answers,[]);
 assert.match(result.gaps.join(),/Nothing time-sensitive/);
});

test('why-now: each trigger fires alone with dated first-hand evidence',()=>{
 const input=calm();
 input.activity.push({kind:'calendar',at:new Date(NOW+20*3600_000).toISOString(),personIds:['a1'],title:'Roadmap review'});
 input.nodes.find(n=>n.id==='b1')!.strength=70;input.nodes.find(n=>n.id==='b1')!.lastContact=at(100);
 input.themeSignals.push({personId:'c',themeId:'t',summary:'Hiring robotics engineers for the warehouse pilot',observedAt:at(4)});
 const ctx={...quiet(),
  lens:{focus:'robotics hiring',needs:''},
  mail:{a2:{lastIn:NOW-3*DAY,lastOut:NOW-10*DAY},a3:{lastIn:NOW-40*DAY,lastOut:NOW-50*DAY}},
  signals:[{personId:'a4',category:'travel',tier:'open',summary:'Back from Japan',observedAt:at(2),source:'gmail'},
   {personId:'b2',category:'health',tier:'sensitive',summary:'Recovering from surgery',observedAt:at(1),source:'gmail'}],
  stints:[{id:'s1',personId:'b3',company:'Old Co',domain:'old.test',from:'2024-01',to:'2026-09',source:'email_domain' as const},{id:'s2',personId:'b3',company:'New Co',domain:'new.test',from:'2026-10',to:null,source:'email_domain' as const}],
  jobMoves:[{name:'B Four',people:[{personId:'b4',domain:'next.test',lastContact:at(10)}]}]};
 const result=whyNow(input,ctx);
 assert.deepEqual(kinds(result,'a1'),['meeting_soon']);
 assert.deepEqual(kinds(result,'a2'),['owes_reply']);
 assert.deepEqual(kinds(result,'a3'),[]);
 assert.deepEqual(kinds(result,'a4'),['fresh_signal']);
 assert.deepEqual(kinds(result,'b1'),['going_cold']);
 assert.deepEqual(kinds(result,'b2'),[],'a sensitive signal never triggers');
 assert.deepEqual(kinds(result,'b3'),['job_move']);
 assert.deepEqual(kinds(result,'b4'),['job_move']);
 assert.deepEqual(kinds(result,'c'),['topic_overlap']);
 for(const answer of result.answers)for(const why of answer.why){
  assert.equal(why.attribution,'first_hand');
  assert.ok(why.source&&why.observedAt&&why.summary,JSON.stringify(why));
 }
 assert.ok(!JSON.stringify(result).includes('surgery'));
 // The meeting outranks the rest (weight 3).
 assert.equal(result.answers[0].personId,'a1');
});

test('why-now: judgments only exclude, and strength breaks ties',()=>{
 const input=calm();
 input.nodes.find(n=>n.id==='a1')!.strength=90;
 const ctx={...quiet(),mail:{a1:{lastIn:NOW-DAY,lastOut:null},a2:{lastIn:NOW-DAY,lastOut:null},a3:{lastIn:NOW-DAY,lastOut:null}},excluded:new Set(['a3'])};
 const result=whyNow(input,ctx);
 assert.deepEqual(result.answers.map(a=>a.personId),['a1','a2']);
 assert.ok(result.answers[0].score>result.answers[1].score);
});

test('why-now: shared-only people are not candidates',()=>{
 const input=calm();
 input.nodes.push(node('x','x.test',{directRelationship:false,via:['maya@example.test']}));
 const result=whyNow(input,{...quiet(),mail:{x:{lastIn:NOW-DAY,lastOut:null}}});
 assert.deepEqual(result.answers,[]);
});
