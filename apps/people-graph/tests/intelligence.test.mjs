import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attentionDigest, activityTimeline, inWindow, dailyDigest, connectionSummary, introductionCandidates, directContact} from '../public/relationship-graph/intelligence.mjs';

const now = new Date('2026-09-23T12:00:00Z');
test('time windows reject missing, future and prior-week activity',()=>{
  assert.equal(inWindow(null,'week',now),false);
  assert.equal(inWindow('2026-09-24','week',now),false);
  assert.equal(inWindow('2026-09-22T12:00:00Z','week',now),true);
  assert.equal(inWindow('2026-09-19T12:00:00Z','week',now),false);
});
test('shared timestamps never become your direct-contact activity',()=>{
  assert.equal(directContact({via:['other'],lastContact:'2026-09-22'}),null);
  assert.equal(directContact({via:['other'],lastContact:'2026-09-22',directLastContact:'2026-09-01'}),'2026-09-01');
  assert.equal(directContact({directLastContact:null,lastContact:'2026-09-22'}),null);
});
test('digest separates direct contact from a note mention and ignores public/shared signals',()=>{
  const nodes=[{id:'a',name:'Ada',lastContact:'2026-09-22'},{id:'b',name:'Bo',via:['other'],lastContact:'2026-09-22'}];
  const signals=[{personId:'b',sourceType:'granola',visibility:'private',summary:'Discussed UI',observedAt:'2026-09-22',evidenceRef:'n1'},
    {personId:'b',sourceType:'public_url',summary:'Public post',observedAt:'2026-09-23'},
    {personId:'b',sourceType:'granola',summary:'Shared',observedAt:'2026-09-23',evidenceRef:'share:x'}];
  const digest=dailyDigest(nodes,signals,now);
  assert.equal(digest.length,2);
  const bo=digest.find(x=>x.id==='b');
  assert.equal(bo.reasons.length,1);
  assert.match(bo.reasons[0],/Discussed UI/);
  assert.ok(!bo.reasons.some(r=>r.includes('contact')));
});
test('scores use only measured direct relationships, excluding ties from stronger-than count',()=>{
  const a={id:'a',strength:60};
  assert.deepEqual(connectionSummary(a,[a,{id:'b',strength:60},{id:'c',strength:20}]),{score:60,lower:1,total:2});
  assert.equal(connectionSummary({id:'s',strength:99,via:['other']},[]),null);
  assert.equal(connectionSummary({id:'n',strength:null},[]),null);
});
test('intro candidates require a known direct connector and a recorded edge',()=>{
  const nodes=[{id:'target'},{id:'a',strength:80},{id:'b',strength:99,via:['other']}];
  const edges=[{id:'e1',source:'target',target:'a',kind:'cooccurrence',label:'Shared meeting'},{id:'e2',source:'target',target:'b'}];
  const result=introductionCandidates('target',nodes,edges);
  assert.deepEqual(result.map(x=>x.person.id),['a']);
  assert.equal(result[0].edge.id,'e1');
});

test('conversation themes require substantive evidence, not subject fragments', async()=>{
  const {conversationThemes}=await import('../public/relationship-graph/intelligence.mjs');
  const signals=[{id:'note',personId:'a',sourceType:'granola',summary:'Discussed agent memory',observedAt:'2026-09-22'}, {id:'subject',personId:'b',sourceType:'gmail_subject',observedAt:'2026-09-23'}];
  const themes=[{themeId:'noise',name:'Confirm Your',components:[{signalId:'subject',sourceType:'gmail_subject'}]}, {themeId:'real',name:'Agent Memory',nodeIds:['a','b'],components:[{signalId:'note',sourceType:'granola'},{signalId:'subject',sourceType:'gmail_subject'}]}];
  const result=conversationThemes(themes,signals);
  assert.equal(result.length,1);
  assert.deepEqual(result[0].nodeIds,['a']);
  assert.equal(result[0].latestAt,'2026-09-22');
  assert.equal(result[0].summary,'Discussed agent memory');
});

test('timeline uses individual events and separates mentions from contact',async()=>{
 const {activityTimeline}=await import('../public/relationship-graph/intelligence.mjs');
 const graph={nodes:[{id:'a',lastContact:'2026-09-23'}],activity:[{id:'mail1',kind:'email',at:'2026-09-21T12:00:00Z',personIds:['a'],title:'Design review'}],themeSignals:[{id:'s',personId:'a',sourceType:'granola',visibility:'private',observedAt:'2026-09-22T12:00:00Z',evidenceRef:'note1',summary:'Mentioned hiring'}]};
 const events=activityTimeline(graph,'week',now);
 assert.deepEqual(events.map(e=>e.kind),['mention','email']);
 assert.equal(activityTimeline(graph,'today',now).length,0);
});

test('spatial layout is stable, non-grid, and separates portraits',async()=>{
 const {spatialLayout}=await import('../public/relationship-graph/layout.mjs');
 const nodes=Array.from({length:30},(_,i)=>({id:String(i)}));
 const edges=nodes.slice(1).map(n=>({source:'0',target:n.id}));
 const a=spatialLayout(nodes,edges,[]),b=spatialLayout(nodes,edges,[]);
 assert.deepEqual(a,b);
 assert.equal(a.positions.size,30);
 assert.ok(new Set([...a.positions.values()].map(p=>Math.round(p.y))).size>15);
 const points=[...a.positions.values()];
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y)>105);
});

test('attention separates content from metadata and deduplicates note mentions',async()=>{
 const {attentionDigest}=await import('../public/relationship-graph/intelligence.mjs');
 const signal=(id,ref,summary,sourceType='granola')=>({id,evidenceRef:ref,personId:'a',summary,sourceType,visibility:'private',observedAt:'2026-09-22T12:00:00Z'});
 const graph={nodes:[{id:'a',name:'Ada'}],activity:[],themeSignals:[signal('1','note:1#one','Follow up with Ada about the prototype'),signal('2','note:1#two','Ada discussed design'),signal('3','mail:1','Can you send it?','gmail_subject')]};
 const result=attentionDigest(graph,{},now);
 assert.equal(result.length,1);assert.equal(result[0].kind,'follow-up');
 assert.equal(attentionDigest(graph,{[result[0].id]:{action:'done'}},now).length,0);
 graph.themeSignals.push(signal('4','note:2#one','Ada discussed design'));
 assert.ok(attentionDigest(graph,{},now).some(x=>x.kind==='recurring'));
 assert.equal(attentionDigest({...graph,themeSignals:[signal('label','note:x','Follow-up: We went to Europe this summer.')]},{},now).length,0);
 assert.equal(attentionDigest({...graph,themeSignals:[signal('5','note:3','No follow-up needed; already sent the prototype')]},{},now).length,0);
});

test('attention snoozes expire and recency alone does not create suggestions',async()=>{
 const {attentionDigest}=await import('../public/relationship-graph/intelligence.mjs');
 const graph={nodes:[{id:'a',name:'Ada',directLastContact:'2026-09-22'}],activity:[],themeSignals:[]};
 assert.deepEqual(attentionDigest(graph,{},now),[]);
 graph.themeSignals=[{id:'q',personId:'a',sourceType:'granola',visibility:'private',observedAt:'2026-09-22',evidenceRef:'n1',summary:'Can you introduce Ada?'}];
 const item=attentionDigest(graph,{},now)[0];
 assert.equal(item.kind,'question');
 assert.equal(attentionDigest(graph,{[item.id]:{action:'snooze',until:+now+1000}},now).length,0);
 assert.equal(attentionDigest(graph,{[item.id]:{action:'snooze',until:+now-1000}},now).length,1);
});

test('wander topics use distinct substantive sources, never email subjects',async()=>{
 const {wanderTopics}=await import('../public/relationship-graph/wander.mjs');
 const make=(id,title,personId)=>({id,personId,sourceType:'granola',visibility:'private',evidenceRef:`note:${id}#a`,summary:'Discussed architecture',observedAt:'2026-09-22',provenance:{title}});
 const entries=wanderTopics({nodes:[{id:'a'},{id:'b'}],themeSignals:[make('1','Agent memory architecture','a'),make('2','Agent memory design','b'),{...make('3','Confirm your account','a'),sourceType:'gmail_subject'}],relevance:{themes:[]}});
 const topic=entries.find(x=>x.kind==='Recurring topic'&&x.name.toLowerCase()==='agent memory');
 assert.ok(topic);assert.deepEqual(topic.nodeIds.sort(),['a','b']);
 assert.equal(entries.filter(x=>x.kind==='Conversation').length,2);
 assert.ok(!entries.some(x=>x.name.includes('Confirm')));
});

test('person suppression and snooze hide every suggestion; boost only clears older evidence',()=>{
 const now=new Date('2026-09-23T12:00:00Z');
 const graph={nodes:[{id:'p',name:'Ada'}],themeSignals:[{id:'s',personId:'p',sourceType:'granola',visibility:'private',observedAt:'2026-09-22T12:00:00Z',evidenceRef:'n1',summary:'I will send the design'}],activity:[]};
 assert.equal(attentionDigest(graph,{},now).length,1);
 for(const action of ['suppress','snooze','boost']){
  graph.personFeedback={p:{action,at:+now,until:+now+86400000}};
  assert.equal(attentionDigest(graph,{},now).length,0);
 }
 graph.personFeedback.p.at=Date.parse('2026-09-20');
 assert.equal(attentionDigest(graph,{},now).length,1);
});
test('calendar prepares upcoming accepted meetings without counting invitations as contact',()=>{
 const now=new Date('2026-09-23T12:00:00Z');
 const graph={nodes:[{id:'p',name:'Ada'}],themeSignals:[],activity:[{id:'cal',kind:'calendar',at:'2026-09-24T12:00:00Z',title:'Design review',source:'Google Calendar',status:'accepted',acceptedPersonIds:['p'],personIds:['p']}]};
 const items=attentionDigest(graph,{},now);
 assert.equal(items[0].kind,'upcoming');assert.equal(items[0].personId,'p');
 assert.equal(activityTimeline(graph,'upcoming',now).length,1);
 assert.equal(activityTimeline(graph,'week',now).length,0);
 graph.activity[0].status='invited';graph.activity[0].acceptedPersonIds=[];
 assert.equal(attentionDigest(graph,{},now).length,0);
});

test('workspace Wander shows evidence-backed shared topics without inventing attendees',async()=>{
 const {wanderTopics}=await import('../public/relationship-graph/wander.mjs');
 const topics=wanderTopics({source:'workspace',nodes:[{id:'a'}],themes:[{id:'t',name:'Interface design'}],themeSignals:[{id:'s',personId:'a',themeId:'t',sourceType:'granola',summary:'Working on interfaces',observedAt:'2026-09-23',evidenceRef:'workspace:x:s'}],relevance:{themes:[]}});
 assert.equal(topics.length,1);assert.deepEqual(topics[0].nodeIds,['a']);
});

test('large shared clusters maintain readable separation without dropping people',async()=>{
 const {spatialLayout}=await import('../public/relationship-graph/layout.mjs');
 const nodes=Array.from({length:5134},(_,i)=>({id:String(i),company:'Company '+(i%45)}));
 const layout=spatialLayout(nodes,[],[],270),points=[...layout.positions.values()];
 assert.equal(points.length,5134);
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y)>=216-1e-6);
});
