import test from 'node:test';
import assert from 'node:assert/strict';
import {topicContext} from '../public/relationship-graph/topic-context.mjs';
const signal=(id,themeId,personId,date,summary)=>({id,themeId,personId,observedAt:date,summary,sourceType:'granola',evidenceRef:'workspace:k:'+id,provenance:{title:'Memory discussion'}});
test('topic context merges contributors, counts unique people, and excludes unrelated or future evidence',()=>{
 const graph={source:'workspace',members:[{id:'k',name:'Kaya',isMe:true}],nodes:[{id:'a',name:'Alex'},{id:'b',name:'Becca'}],themeSignals:[signal('a','t','a','2026-09-01','Interest: agent memory'),signal('b','t2','b','2026-09-03','Commitment: send a prototype'),signal('c','other','a','2026-09-05','Unrelated private project'),signal('d','t','a','2030-09-01','Future'),signal('e','t',null,'2026-09-02','Unassigned')]};
 const result=topicContext(graph,{themeId:'t',themeIds:['t','t2'],nodeIds:['a','b']},Date.parse('2026-09-28'));
 assert.equal(result.people.length,2);assert.equal(result.recaps.length,2);assert.equal(result.latestDate,'2026-09-03');assert.equal(result.recaps[0].sections.followups[0].text,'send a prototype');assert.equal(result.evidence.length,2);assert.equal(result.people[0].id,'b');assert.ok(!JSON.stringify(result).includes('Unrelated'));
});
test('topic-only evidence never becomes a discussion summary',()=>{
 const graph={nodes:[{id:'a',name:'Alex'}],themeSignals:[signal('a','t','a','2026-09-01','Recorded topic: Agent memory')]};
 assert.equal(topicContext(graph,{themeId:'t',nodeIds:['a']},Date.parse('2026-09-28')).recaps[0].topicsOnly,true);
});
