import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingBatch, meetingPreviewState, withMeetingPreview } from '../public/relationship-graph/meeting-preview.mjs';

const now = Date.parse('2026-09-15T16:00:00Z');
const graph = {nodes:[{id:'a',name:'Ada',company:'example.test',type:'person'}],edges:[],themes:[],themeSignals:[],relevance:{themes:[],connectors:[],discoveries:[]},connectors:[]};
function fixture() { return {version:1,id:'pilot',account:'owner@example.test',reviewedAt:'2026-09-15T12:00:00Z',notes:[{id:'11111111-1111-4111-8111-111111111111',title:'Product conversation',date:'2026-09-14T12:00:00Z'}],themes:[{id:'memory',name:'Agent memory',status:'active',whyNow:'An active question was recorded.',suggestion:'Review the open question.',evidence:[{noteId:'11111111-1111-4111-8111-111111111111',text:'Memory evaluation was discussed.',attribution:'Meeting summary'}],people:[{label:'Ada Rivera',matchName:'Ada',matchCompany:'example.test',context:'Named in the discussion; expertise is not established.'}]}]}; }

test('reviewed private batch retains dated evidence and does not alter graph identity',()=>{
  const batch=parseMeetingBatch(fixture(),'owner@example.test'); assert.ok(batch);
  const preview=meetingPreviewState(batch,graph,{},now); assert.ok(preview);
  assert.equal(preview.cards[0].people[0].nodeId,'a');
  assert.equal(Date.parse(preview.cards[0].evidence[0].date),Date.parse('2026-09-14T12:00:00Z'));
  assert.equal(preview.cards[0].evidence[0].url,'https://notes.granola.ai/d/11111111-1111-4111-8111-111111111111');
  const merged=withMeetingPreview(graph,preview,'my'); assert.ok(merged);
  assert.strictEqual(merged.nodes,graph.nodes);assert.strictEqual(merged.edges,graph.edges);
  assert.equal(merged.relevance.themes.length,1);assert.equal(graph.relevance.themes.length,0);
  assert.equal(merged.themeSignals[0].visibility,'private');
});
test('a private preview never appears in Firm Public or Off',()=>{
  const preview=meetingPreviewState(parseMeetingBatch(fixture(),'owner@example.test'),graph,{},now);assert.ok(preview);
  for(const lens of ['firm','public','off']) assert.strictEqual(withMeetingPreview(graph,preview,lens),graph);
});
test('ambiguous names and restricted identities cannot acquire meeting heat',()=>{
  const batch=parseMeetingBatch(fixture(),'owner@example.test');assert.ok(batch);
  for(const nodes of [[...graph.nodes,{...graph.nodes[0],id:'b'}],[{...graph.nodes[0],permission:'denied'}],[{...graph.nodes[0],identityResolved:false}],[]]){
    const preview=meetingPreviewState(batch,{...graph,nodes},{},now);assert.ok(preview);
    assert.equal(preview.cards[0].people[0].nodeId,null);assert.deepEqual(preview.themes[0].nodeIds,[]);
  }
});
test('a named person without known graph identity stays unmatched without fabricated company data',()=>{
  const raw=fixture();raw.themes[0].people[0].matchName=null;raw.themes[0].people[0].matchCompany=null;
  const batch=parseMeetingBatch(raw,'owner@example.test');
  assert.equal(meetingPreviewState(batch,graph,{},now)?.cards[0].people[0].nodeId,null);
});
test('resolved superseded and dismissed suggestions keep their evidence but have no heat',()=>{
  for(const state of ['resolved','superseded','dismissed']){
    const raw=fixture();if(state!=='dismissed')raw.themes[0].status=state;
    const batch=parseMeetingBatch(raw,'owner@example.test');assert.ok(batch);
    const preview=meetingPreviewState(batch,graph,state==='dismissed'?{memory:{action:'dismiss',at:new Date(now).toISOString()}}:{},now);assert.ok(preview);
    assert.equal(preview.cards[0].status,state);assert.equal(preview.cards[0].evidence.length,1);assert.equal(preview.themes.length,0);
  }
});
test('recency follows meeting date not import date and still-relevant confirmation expires',()=>{
  const raw=fixture();raw.notes[0].date='2026-06-01T12:00:00Z';
  const batch=parseMeetingBatch(raw,'owner@example.test');assert.ok(batch);
  assert.deepEqual(meetingPreviewState(batch,graph,{},now)?.themes,[]);
  assert.equal(meetingPreviewState(batch,graph,{memory:{action:'still-relevant',at:new Date(now).toISOString()}},now)?.themes.length,1);
  assert.equal(meetingPreviewState(batch,graph,{memory:{action:'still-relevant',at:'2026-09-01T12:00:00Z'}},now)?.themes.length,0);
});
test('foreign owners oversized batches unknown fields and unbound evidence are rejected',()=>{
  assert.throws(()=>parseMeetingBatch(fixture(),'someone@example.test'),/account/i);
  for(const mutate of [b=>b.notes.push(...Array(5).fill(b.notes[0])),b=>b.themes[0].evidence[0].noteId='unknown',b=>b.notes[0].body='private full transcript',b=>b.notes[0].date='not-a-date',b=>b.themes.push(b.themes[0]),b=>b.themes[0].people[0].matchName='',b=>b.notes[0].id='../../unsafe']){
    const raw=fixture();mutate(raw);assert.throws(()=>parseMeetingBatch(raw,'owner@example.test'));
  }
});
