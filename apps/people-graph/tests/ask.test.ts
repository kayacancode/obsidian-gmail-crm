import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {classifyQuestion,answerQuestion,validateInterpretation,toAnswers,type AskIntent,type AskParams} from '../src/ask';
import evalSet from './fixtures/ask-eval.json';

type Case={question:string;intent:AskIntent;params:AskParams};
// Test double: replays one recorded classification for whatever question is asked.
const recorded=(output:unknown)=>({run:async()=>({response:output})}) as unknown as Ai;

test('ask: every recorded evaluation answer validates to its intent and params',async()=>{
 for(const c of evalSet as Case[]){
  const got=await classifyQuestion(recorded({intent:c.intent,params:c.params,confidence:0.9,alternatives:[]}),c.question);
  assert.equal(got.intent,c.intent,c.question);
  if(c.intent!=='clarify')assert.deepEqual(got.params,c.params,c.question);
  assert.equal(got.classifier,'model');
 }
});

test('ask: low, missing or NaN confidence asks for clarification',()=>{
 for(const confidence of [0.4,undefined,Number.NaN,'high'])assert.equal(validateInterpretation({intent:'company',params:{company:'Acme'},confidence}).intent,'clarify');
});

test('ask: an intent without its required params is a clarification, never an empty call',()=>{
 assert.equal(validateInterpretation({intent:'company',params:{},confidence:0.95}).intent,'clarify');
 assert.equal(validateInterpretation({intent:'connection',params:{from:'Maya'},confidence:0.95}).intent,'clarify');
 assert.equal(validateInterpretation({intent:'lookup',params:{person:'x'.repeat(201)},confidence:0.95}).intent,'clarify');
});

test('ask: unknown or write-like intents are never executed',()=>{
 const got=validateInterpretation({intent:'delete_signals',params:{},confidence:0.99,alternatives:[{intent:'reconnect',params:{}},{intent:'nuke',params:{}}]});
 assert.equal(got.intent,'clarify');
 assert.deepEqual(got.alternatives,[{intent:'reconnect',params:{}}]);
});

test('ask: questions are bounded',async()=>{
 await assert.rejects(classifyQuestion(recorded({}),'x'.repeat(501)),/invalid_request/);
 await assert.rejects(classifyQuestion(recorded({}),'  '),/invalid_request/);
 await assert.rejects(classifyQuestion(undefined,'who is Ada'),/ai_unavailable/);
});

test('ask: catch-up answers come from the brief; peer questions execute nothing',async()=>{
 const f=await fixture();
 f.env.AI=recorded({intent:'catch_up',params:{person:'Ada'},confidence:0.92});
 const brief=await answerQuestion(f.env,'owner@example.test',f.service,'catch me up on Ada');
 assert.equal(brief.interpretation.intent,'catch_up');
 assert.equal(brief.answers[0].name,'Ada');
 f.env.AI=recorded({intent:'network_ask',params:{person:'Ada'},confidence:0.9});
 const peer=await answerQuestion(f.env,'owner@example.test',f.service,'does anyone know Ada');
 assert.deepEqual(peer.answers,[]);
 assert.ok(peer.gaps.includes('Peer questions run from the CLI: peoplegraph peer ask'));
});

test('ask: company questions return the network people as answers',async()=>{
 const f=await fixture();
 // Shared-network refresh reads D1; this owner has no shares.
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 f.env.AI=recorded({intent:'company',params:{company:'example.test'},confidence:0.9});
 const got=await answerQuestion(f.env,'owner@example.test',f.service,'who do I know at example.test');
 assert.ok(got.answers.some(a=>a.name==='Ada'));
});

/** A fixture with D1 stubbed (no shares), a second contact (Maya Rivera), and a one-call `ask`. */
async function network(){
 const f=await fixture();
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 f.add('maya@acme.test','Maya Rivera');
 const ask=async(intent:AskIntent,params:AskParams)=>{
  f.env.AI=recorded({intent,params,confidence:0.9});
  return answerQuestion(f.env,'owner@example.test',f.service,'question');
 };
 return {ask};
}

test('ask: lookup by name and by email returns people',async()=>{
 const {ask}=await network();
 assert.ok((await ask('lookup',{person:'Ada'})).answers.some(a=>a.name==='Ada'));
 assert.ok((await ask('lookup',{person:'ada@example.test'})).answers.some(a=>a.name==='Ada'));
});

test('ask: reconnect and topical who-can-help return people',async()=>{
 const {ask}=await network();
 assert.ok((await ask('reconnect',{})).answers.length>0);
 assert.ok((await ask('who_can_help',{topic:'acme.test'})).answers.some(a=>a.name==='Maya Rivera'));
});

test('ask: ranked recommendations under results become answers',()=>{
 assert.deepEqual(toAnswers({results:[{personId:'p1',name:'Ada'}]}).map(a=>[a.personId,a.name]),[['p1','Ada']]);
});

test('ask: connections resolve names, and "me" means the owner relationship',async()=>{
 const {ask}=await network();
 const between=await ask('connection',{from:'Ada',to:'Maya Rivera'});
 assert.ok(!between.gaps.some(g=>/unknown_person/.test(g)),between.gaps.join());
 assert.deepEqual(between.answers.map(a=>a.name).sort(),['Ada','Maya Rivera']);
 const mine=await ask('connection',{from:'me',to:'Ada'});
 assert.equal(mine.answers[0].name,'Ada');
 assert.ok(mine.result&&typeof mine.result==='object'&&'sinceLastContact' in mine.result);
});

test('ask: catching up on a first name finds the one matching person',async()=>{
 const {ask}=await network();
 assert.equal((await ask('catch_up',{person:'Maya'})).answers[0]?.name,'Maya Rivera');
});
