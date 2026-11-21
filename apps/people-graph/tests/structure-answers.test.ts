import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clusterNetwork,structureContext,contrast,widen,bridges,connectors,stanceLabels,type Candidate,type StructureEvent} from '../src/network-structure';
import {fixture,NOW,at,node} from './network-structure.test';

const candidate=(personId:string,relevance:number):Candidate=>({personId,name:personId.toUpperCase(),relevance,evidence:[{summary:`${personId} on robotics hiring`,observedAt:at(5),source:'gmail'}]});
const context=async(input=fixture())=>structureContext(input,await clusterNetwork(input,NOW),NOW);

test('contrast: keeps relevant people outside your usual circles, and disagreement counts',async()=>{
 const ctx=await context();
 const plain=contrast([candidate('a2',0.9),candidate('b2',0.8),candidate('l',0.7),candidate('d1',0.5),candidate('b3',0.2)],ctx);
 assert.deepEqual(plain.answers.map(a=>a.personId),['b2','l','d1']);
 assert.ok(plain.answers.every(a=>a.distance.value>=0.5));
 assert.deepEqual(plain.gaps,[]);
 const argued=contrast([candidate('a2',0.9),candidate('b2',0.8),candidate('l',0.7),candidate('d1',0.5)],ctx,{b2:'supports',l:'challenges'});
 assert.deepEqual(argued.answers.map(a=>a.personId),['l','b2','d1']);
 assert.equal(argued.answers[0].stance,'challenges');
});

test('contrast: too few distant people says so and shows the nearest, marked',async()=>{
 const ctx=await context();
 const result=contrast([candidate('a2',0.9),candidate('b2',0.8)],ctx);
 assert.match(result.gaps.join(),/Only 1 relevant person outside your usual circles/);
 assert.deepEqual(result.answers.map(a=>[a.personId,a.distance.value]),[['b2',1],['a2',0]]);
});

test('contrast: stance labels come from one model call and are validated',async()=>{
 const ai=(response:unknown)=>({run:async()=>({response})}) as unknown as Ai;
 const people=[candidate('b2',0.8),candidate('l',0.7)];
 assert.deepEqual(await stanceLabels(ai({labels:[{i:0,stance:'supports'},{i:1,stance:'challenges'}]}),'nurses will not adopt apps',people),{b2:'supports',l:'challenges'});
 assert.deepEqual(await stanceLabels(ai({labels:[{i:0,stance:'loves it'},{i:7,stance:'supports'}]}),'claim',people),{});
 assert.deepEqual(await stanceLabels(ai('not json'),'claim',people),{});
 assert.deepEqual(await stanceLabels(undefined,'claim',people),{});
});

const events=(acme:number,beta:number):StructureEvent[]=>[
 ...Array.from({length:acme},(_,i)=>({kind:'email',at:at(1+i%25),personIds:[`a${1+i%4}`]})),
 ...Array.from({length:beta},(_,i)=>({kind:'email',at:at(1+i%25),personIds:[`b${1+i%4}`]})),
];

test('widen: names a narrowing pattern at 70% and offers one person from outside it',async()=>{
 const input=fixture();input.activity=events(14,6);
 input.nodes.find(n=>n.id==='l')!.lastContact=at(60);input.nodes.find(n=>n.id==='l')!.strength=40;
 const result=widen(input,await context(input),NOW,{focus:'',excluded:new Set()});
 assert.equal(result.result?.pattern.share,0.7);
 assert.equal(result.result?.pattern.interactions,20);
 assert.equal(result.answers.length,1);
 assert.equal(result.answers[0].personId,'l');
 assert.equal(result.answers[0].distance.value,1);
});

test('widen: 69% or fewer than 12 interactions is not a pattern',async()=>{
 const spread=fixture();spread.activity=events(9,4);
 const below=widen(spread,await context(spread),NOW,{focus:'',excluded:new Set()});
 assert.deepEqual(below.answers,[]);
 assert.match(below.gaps.join(),/spread out \(top circle 69%\)/);
 const few=fixture();few.activity=events(11,0);
 const quiet=widen(few,await context(few),NOW,{focus:'',excluded:new Set()});
 assert.deepEqual(quiet.answers,[]);
 assert.match(quiet.gaps.join(),/11 interactions/);
});

test('bridges: unconnected people in different circles with shared evidence, never existing ties',async()=>{
 const input=fixture();
 input.themeSignals.push(
  {personId:'a2',themeId:'t-x',summary:'climate risk models',observedAt:at(20)},{personId:'b2',themeId:'t-x',summary:'carbon accounting',observedAt:at(30)},
  {personId:'a3',themeId:'t-y',summary:'warehouse robotics pilot',observedAt:at(10)},{personId:'b3',themeId:'t-z',summary:'robotics warehouse automation',observedAt:at(12)},
  {personId:'a4',themeId:'t-w',summary:'nurse scheduling',observedAt:at(10)},{personId:'b4',themeId:'t-w',summary:'nurse rostering',observedAt:at(10)},
  {personId:'a1',themeId:'t-x',summary:'climate',observedAt:at(10)});
 // Already introduced: never proposed again.
 input.edges.push({source:'a4',target:'b4',weight:1,types:['introduced']});
 input.themes.push({id:'t-x',name:'Climate'});
 const result=bridges(input,await context(input),{excluded:new Set()});
 const pairs=result.answers.map(p=>p.people.map(x=>x.personId).sort().join('+'));
 assert.ok(pairs.includes('a2+b2'),pairs.join());
 assert.ok(pairs.includes('a3+b3'),pairs.join());
 assert.ok(!pairs.includes('a4+b4'));
 assert.ok(!pairs.some(p=>p==='a1+a2'),'same circle and already connected');
 assert.deepEqual(result.answers.find(p=>p.people.some(x=>x.personId==='a2'))!.sharedEvidence.themes,['Climate']);
 const topical=bridges(input,await context(input),{topic:'warehouse robotics',excluded:new Set()});
 assert.deepEqual(topical.answers.map(p=>p.people.map(x=>x.personId).sort().join('+')),['a3+b3']);
 assert.match(result.gaps.join(),/proposals/);
});

test('connectors: people whose ties reach two or more circles',async()=>{
 const input=fixture(),clusters=await clusterNetwork(input,NOW);
 assert.deepEqual(connectors(input,clusters).map(c=>c.personId),['c']);
 input.nodes.push(node('z','zeta.test'));
 assert.deepEqual(connectors(input,clusters).map(c=>c.personId),['c']);
});
