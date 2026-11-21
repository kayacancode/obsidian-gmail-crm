import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCuriosityNote,noteKeywords} from '../src/curiosity';

/** Synthetic, in the shape of a real working note; no real names. */
export const NOTE=`Agentic networks

## What's new in my head
- Agents could ask each other about people instead of us uploading graphs (Ada + example)
- Catch-up calls carry the life signals nobody posts

## Why it spikes my interest
Recency tells us when, context tells us why, judgment tells us whether.

## The fringes
- Would nurses trust an agent to schedule them?
- What does privacy look like when the graph is shared?

## Who I want to talk to about it
- Ada
- maya@acme.test
- Zed Nobody
`;

test('curiosity: the four headings parse into the note fields',()=>{
 const note=parseCuriosityNote(NOTE);
 assert.equal(note.title,'Agentic networks');
 assert.deepEqual(note.newInMyHead.map(i=>i.text),['Agents could ask each other about people instead of us uploading graphs (Ada + example)','Catch-up calls carry the life signals nobody posts']);
 assert.deepEqual(note.newInMyHead[0].names,['Ada','example']);
 assert.deepEqual(note.newInMyHead[1].names,[]);
 assert.equal(note.why,'Recency tells us when, context tells us why, judgment tells us whether.');
 assert.deepEqual(note.fringes,['Would nurses trust an agent to schedule them?','What does privacy look like when the graph is shared?']);
 assert.deepEqual(note.wantToTalkTo,['Ada','maya@acme.test','Zed Nobody']);
});

test('curiosity: unknown, repeated or out-of-order headings are refused by name',()=>{
 assert.throws(()=>parseCuriosityNote(NOTE+'\n## Random thoughts\n- x\n'),(e:Error)=>e.message==='note_invalid:Random thoughts');
 assert.throws(()=>parseCuriosityNote('## The fringes\n- a\n## The fringes\n- b\n'),(e:Error)=>e.message==='note_invalid:The fringes');
 assert.throws(()=>parseCuriosityNote('## The fringes\n- a\n## What\'s new in my head\n- b\n'),(e:Error)=>e.message==="note_invalid:What's new in my head");
 assert.throws(()=>parseCuriosityNote('x'.repeat(4001)),(e:Error)=>e.message==='note_too_long');
 assert.throws(()=>parseCuriosityNote('   '),(e:Error)=>e.message==='invalid_request');
});

test('curiosity: missing sections are empty, and keywords come from what is new, why and the fringes',()=>{
 const note=parseCuriosityNote('## The fringes\n- warehouse robotics hiring\n');
 assert.deepEqual(note.newInMyHead,[]);
 assert.deepEqual(note.wantToTalkTo,[]);
 assert.equal(note.title,'');
 const words=noteKeywords(parseCuriosityNote(NOTE));
 assert.ok(words.has('nurses')&&words.has('privacy')&&words.has('signals'));
 assert.ok(!words.has('maya'),'who to talk to is not a topic');
});
