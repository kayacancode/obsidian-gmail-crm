import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clusterNetwork,interactions,usualCircles,structureContext,distanceOf,type StructureInput,type StructureNode} from '../src/network-structure';

export const NOW=Date.parse('2026-11-21T12:00:00.000Z');
const DAY=86_400_000;
export const at=(daysAgo:number)=>new Date(NOW-daysAgo*DAY).toISOString();

export const node=(id:string,company:string,extra:Partial<StructureNode>={}):StructureNode=>({id,name:id.toUpperCase(),company,strength:60,combined:60,lastContact:at(5),directRelationship:true,...extra});
const clique=(ids:string[],weight:number)=>ids.flatMap((a,i)=>ids.slice(i+1).map(b=>({source:a,target:b,weight,types:['shared_email']})));

/** Two planted communities (acme, beta), a connector touching both, a pair, a loner and a shared-only person. */
export function fixture():StructureInput{
 const a=['a1','a2','a3','a4'],b=['b1','b2','b3','b4'];
 return {
  nodes:[...a.map(id=>node(id,'acme.test')),...b.map(id=>node(id,'beta.test')),node('c','gamma.test'),node('d1','delta.test'),node('d2','delta.test'),node('l','loner.test'),
   node('s','shared.test',{directRelationship:false,via:['maya@example.test']})],
  edges:[...clique(a,3),...clique(b,3),{source:'c',target:'a1',weight:1,types:['shared_meeting']},{source:'c',target:'b1',weight:1,types:['shared_email']},
   {source:'d1',target:'d2',weight:2,types:['shared_email']},{source:'s',target:'b2',weight:5,types:['shared_via']}],
  // Most of the last 90 days with acme, the rest with beta.
  activity:[...a.flatMap(id=>[1,2,3,4].map(d=>({kind:'email',at:at(d*5),personIds:[id]}))),...b.map(id=>({kind:'meeting',at:at(10),personIds:[id]})),
   {kind:'calendar',at:at(3),personIds:['l','d1'],acceptedPersonIds:['d1']},{kind:'email',at:at(200),personIds:['b3']},{kind:'calendar',at:new Date(NOW+DAY).toISOString(),personIds:['b4'],acceptedPersonIds:['b4']}],
  themeSignals:[{personId:'a1',themeId:'t-pay',summary:'payments rails',observedAt:at(10)},{personId:'a2',themeId:'t-pay',summary:'card issuing',observedAt:at(20)},{personId:'b1',themeId:'t-bio',summary:'protein design',observedAt:at(5)}],
  themes:[{id:'t-pay',name:'Payments'},{id:'t-bio',name:'Biotech'}],
 };
}

test('structure: two planted communities become two stable clusters, pairs dissolve',async()=>{
 const first=await clusterNetwork(fixture(),NOW),second=await clusterNetwork(fixture(),NOW);
 const acme=first.clusters.find(c=>c.members.includes('a1'))!,beta=first.clusters.find(c=>c.members.includes('b1'))!;
 assert.ok(['a1','a2','a3','a4'].every(id=>acme.members.includes(id)));
 assert.ok(['b1','b2','b3','b4'].every(id=>beta.members.includes(id)));
 assert.notEqual(acme.id,beta.id);
 assert.match(acme.id,/^[0-9a-f]{12}$/);
 assert.deepEqual(second.clusters.map(c=>c.id),first.clusters.map(c=>c.id));
 assert.equal(first.byNode.d1,null);
 assert.equal(first.byNode.l,null);
 // Shared-only people and shared_via edges never shape the owner's clusters.
 assert.equal(first.byNode.s,undefined);
 // The connector joins one side; the label lists the top companies and themes.
 assert.equal(acme.label.companies[0],'acme.test');
 assert.deepEqual(acme.label.themes,['Payments']);
});

test('structure: interactions count mail and meetings, accepted calendar events only, inside the window',()=>{
 const counts=interactions(fixture().activity,NOW,90);
 assert.equal(counts.a1,4);
 assert.equal(counts.b1,1);
 assert.equal(counts.d1,1);
 assert.equal(counts.l,undefined);
 // b3's 200-day-old email and b4's future event are outside the window; their meetings count.
 assert.equal(counts.b3,1);
 assert.equal(counts.b4,1);
});

test('structure: usual circles are the fewest clusters covering 60% of recent interactions',async()=>{
 const input=fixture(),clusters=await clusterNetwork(input,NOW);
 const usual=usualCircles(clusters,interactions(input.activity,NOW,90));
 assert.ok(usual.has(clusters.byNode.a1!));
 assert.ok(!usual.has(clusters.byNode.b1!));
});

test('structure: distance is 0 near your core, 0.5 at its edge, 1 outside or shared-only',async()=>{
 const input=fixture(),ctx=structureContext(input,await clusterNetwork(input,NOW),NOW);
 assert.equal(distanceOf('a2',ctx).value,0);
 assert.equal(distanceOf('b2',ctx).value,1);
 assert.match(distanceOf('b2',ctx).reason,/Outside your usual circles/);
 assert.equal(distanceOf('l',ctx).value,1);
 assert.equal(distanceOf('s',ctx).value,1);
 assert.match(distanceOf('s',ctx).reason,/shared network/);
 // Unclustered (a dissolved pair) but tied into a usual circle sits at its edge.
 const tied=fixture();
 tied.nodes.push(node('m','mu.test'));
 tied.edges.push({source:'l',target:'m',weight:5,types:['shared_email']},{source:'l',target:'a3',weight:1,types:['shared_email']});
 const tiedCtx=structureContext(tied,await clusterNetwork(tied,NOW),NOW);
 assert.equal(tiedCtx.clusters.byNode.l,null);
 assert.equal(distanceOf('l',tiedCtx).value,0.5);
});

test('structure: one shared thread between two groups does not merge them, whatever the ids',async()=>{
 for(const [left,right] of [[['a1','a2','a3','a4','a5'],['b1','b2','b3','b4','b5']],[['a1','a2','a3'],['b1','b2','b3']],[['z1','z2','z3','z4','z5'],['b1','b2','b3','b4','b5']]]){
  const input:StructureInput={nodes:[...left,...right].map(id=>node(id,id[0]+'.test')),edges:[...clique(left,1),...clique(right,1),{source:left[0],target:right[0],weight:1,types:['shared_email']}],activity:[],themeSignals:[],themes:[]};
  const clusters=await clusterNetwork(input,NOW);
  assert.equal(clusters.clusters.length,2,`${left[0]}..${right[0]}: ${JSON.stringify(clusters.clusters.map(c=>c.members))}`);
  assert.notEqual(clusters.byNode[left[1]],clusters.byNode[right[1]]);
 }
});
