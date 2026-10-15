import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyContext} from '../public/relationship-graph/weekly-context.mjs';
const now=Date.parse('2026-10-15T12:00:00Z');
const relationship=memberId=>({memberId,evidenceCategory:'email',activity:{sent:2,received:2,meetings:0}});
const person=(id,owners)=>({id,name:id,type:'person',relationships:owners.map(relationship)});
const signal=(id,member,personId,topic,days=1)=>({id,personId,themeId:topic,sourceType:'granola',visibility:'firm',observedAt:new Date(now-days*86400000).toISOString(),summary:`Discussed ${topic}`,evidenceRef:`workspace:${member}:${id}`});
function fixture(){return {source:'workspace',workspaceId:'team',members:[{id:'me',name:'Kaya',isMe:true},{id:'them',name:'Sophie'}],nodes:[person('my-context',['me']),person('their-expert',['them']),person('their-context',['them']),person('my-expert',['me']),person('mutual',['me','them'])],themes:[{id:'tools',name:'Developer tools'},{id:'design',name:'Product design'}],themeSignals:[signal('a','me','my-context','tools'),signal('b','them','their-expert','tools',20),signal('c','them','their-context','design'),signal('d','me','my-expert','design',20),signal('e','them','mutual','tools')],edges:[]};}
test('weekly matches explain both directions with fresh owner context and candidate evidence',()=>{
 const result=weeklyContext(fixture(),{now});
 const forMe=result.groups.forYou.find(c=>c.person.id==='their-expert');
 const forThem=result.groups.forOthers.find(c=>c.person.id==='my-expert');
 assert.equal(forMe.recipient.id,'me');assert.deepEqual(forMe.evidence.map(s=>s.id),['a','b']);
 assert.equal(forThem.recipient.id,'them');assert.deepEqual(forThem.evidence.map(s=>s.id),['c','d']);
 assert.equal(result.groups.mutual[0].person.id,'mutual');
});
test('one-sided, stale, future, private and subject-only context cannot invent weekly relevance',()=>{
 for(const patch of [{observedAt:new Date(now-8*86400000).toISOString()},{observedAt:new Date(now+86400000).toISOString()},{visibility:'private'},{sourceType:'gmail_subject'},{evidenceRef:'workspace:unknown:a'}]){
  const g=fixture();g.themeSignals=g.themeSignals.filter(s=>s.id!=='e').map(s=>s.id==='a'?{...s,...patch}:s);
  assert.ok(!weeklyContext(g,{now}).groups.forYou.some(c=>c.person.id==='their-expert'));
 }
});
test('mutual activity is recent and requires supported relationships on both sides',()=>{
 const g=fixture();g.themeSignals=[];g.nodes.find(n=>n.id==='mutual').relationships[0].lastContact=new Date(now-86400000).toISOString();
 assert.equal(weeklyContext(g,{now}).groups.mutual.length,1);
 g.nodes.find(n=>n.id==='mutual').relationships[1].activity={sent:1,received:0,meetings:0};
 assert.equal(weeklyContext(g,{now}).groups.mutual.length,0);
});
test('viewer corrections remove inferred topics and their recommendations without altering another member',()=>{
 const result=weeklyContext(fixture(),{now,excludedTopics:new Set(['developer tools'])});
 assert.ok(!result.groups.forYou.some(c=>c.person.id==='their-expert'));
 assert.ok(result.groups.forOthers.some(c=>c.person.id==='my-expert'));
 assert.equal(result.focus.find(f=>f.member.isMe).topics[0].excluded,true);
});
test('names-only, unresolved identities, old evidence and generic topics do not become recommendations',()=>{
 const g=fixture();g.themeSignals=[];assert.equal(weeklyContext(g,{now}).groups.forYou.length,0);
 const unknown=fixture();unknown.nodes.find(n=>n.id==='their-expert').identityResolved=false;
 assert.ok(!weeklyContext(unknown,{now}).groups.forYou.some(c=>c.person.id==='their-expert'));
 const old=fixture();old.themeSignals.find(s=>s.id==='b').observedAt='2020-01-01';
 assert.ok(!weeklyContext(old,{now}).groups.forYou.some(c=>c.person.id==='their-expert'));
 const generic=fixture();generic.themes[0].name='AI';
 assert.ok(!weeklyContext(generic,{now}).groups.forYou.some(c=>c.person.id==='their-expert'));
});

test('matches rebalance for the other viewer and do not let a larger contributor take all slots',()=>{
 const g=fixture();g.members.push({id:'third',name:'Taylor'});g.nodes.push(person('third-expert',['third']));g.themeSignals.push(signal('third','third','third-expert','tools',10));
 for(let i=0;i<10;i++){g.nodes.push(person('extra'+i,['them']));g.themeSignals.push(signal('extra'+i,'them','extra'+i,'tools',10));}
 assert.ok(weeklyContext(g,{now}).groups.forYou.some(c=>c.contributor.id==='third'));
 const swapped=fixture();swapped.members=swapped.members.map(m=>({...m,isMe:m.id==='them'}));
 assert.ok(weeklyContext(swapped,{now}).groups.forYou.some(c=>c.person.id==='my-expert'));
 assert.ok(weeklyContext(swapped,{now}).groups.forOthers.some(c=>c.person.id==='their-expert'));
});

test('a mutual contact can still help a third member who does not know them',()=>{
 const g=fixture();g.members.push({id:'third',name:'Taylor'});g.nodes.push(person('third-context',['third']));
 g.nodes.find(n=>n.id==='my-expert').relationships.push(relationship('them'));
 g.themeSignals.push(signal('third-context','third','third-context','design'));
 assert.ok(weeklyContext(g,{now}).groups.forOthers.some(c=>c.person.id==='my-expert'&&c.recipient.id==='third'));
});
test('authorized meeting-wide context infers the owner week without inventing contact relationships',()=>{
 const g=fixture();g.themeSignals=g.themeSignals.filter(s=>s.id!=='e');g.themeSignals.find(s=>s.id==='a').personId=null;
 const result=weeklyContext(g,{now});assert.ok(result.groups.forYou.some(c=>c.person.id==='their-expert'));
 assert.equal(result.focus.find(f=>f.member.isMe).topics[0].evidence.personId,null);
 g.themeSignals.find(s=>s.id==='b').personId=null;
 assert.ok(!weeklyContext(g,{now}).groups.forYou.some(c=>c.person.id==='their-expert'));
});
