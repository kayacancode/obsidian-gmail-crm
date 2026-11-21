import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {LifeSignalStore} from '../src/life-signals';
import {peopleMachineRequest} from '../src/people-machine';
import type {PeopleMemoryPrincipal} from '../src/people-memory-auth';
import {opaque} from '../src/mail-model';
import {THEME_MODEL} from '../src/theme-extractor';

const OWNER='owner@example.test';
const GUEST={key:'guest-1',email:'founder@startup.test'};
const principal=(scopes:PeopleMemoryPrincipal['scopes']):PeopleMemoryPrincipal=>({owner:OWNER,credentialId:'credential-1',scopes,expiresAt:Date.now()+86400000});
type MachineEnv=Parameters<typeof peopleMachineRequest>[1];
const machine=(env:unknown,scopes:PeopleMemoryPrincipal['scopes'],method:string,path:string,body?:unknown)=>peopleMachineRequest(new Request('https://people.test/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})}),env as MachineEnv,principal(scopes));
/** Workers AI stand-in returning one fixed structured response. */
const useModel=(f:{env:{AI?:unknown;THEME_MODEL?:string}},response:unknown)=>{f.env.AI={run:async()=>({response})};f.env.THEME_MODEL=THEME_MODEL;};

/** An owner whose network has Maya Rivera at acme.test, with guest ask turned on. */
async function owner(){
 const f=await fixture();
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 f.add('maya@acme.test','Maya Rivera');
 const maya=await opaque(OWNER,'maya@acme.test',f.env.TOKEN_SECRET);
 await f.service.setGuestAsk(true);
 return {f,maya};
}

test('guest owner: nothing is accepted while guest ask is off',async()=>{
 const f=await fixture();
 await assert.rejects(()=>f.service.submitGuestAsk(GUEST,'Who knows acme?'),/guest_ask_disabled/);
});

test('guest owner: the draft describes people without naming them',async()=>{
 const {f,maya}=await owner();
 useModel(f,{people:[{i:0,description:'A product lead at a health startup'}]});
 const {ask}=await f.service.submitGuestAsk(GUEST,'Who knows acme?');
 assert.equal(ask.status,'pending');
 const listed=await f.service.listGuestAsks();
 const drafted=listed.asks.find(a=>a.id===ask.id)!;
 assert.deepEqual(drafted.draft.people.map(p=>[p.personId,p.description]),[[maya,'A product lead at a health startup']]);
 // A model that names the person falls back to a plain description.
 useModel(f,{people:[{i:0,description:'Maya Rivera at Acme'}]});
 const second=(await f.service.submitGuestAsk(GUEST,'Anyone at acme?')).ask;
 const fallback=(await f.service.listGuestAsks()).asks.find(a=>a.id===second.id)!.draft.people[0].description;
 assert.ok(!/maya|rivera|acme/i.test(fallback),fallback);
});

test('guest owner: life signals and curiosity notes never reach a draft',async()=>{
 const {f,maya}=await owner();
 await f.service.setLifeSignals(true);
 new LifeSignalStore(f.ctx.storage).add(maya,{category:'health',tier:'sensitive',summary:'Recovering from knee surgery',quote:'I am recovering from knee surgery.'},'gmail','a:m1',Date.now(),0);
 await f.service.setCuriosityNote({text:'Private thinking\n\n## The fringes\n- knee surgery recovery apps\n'});
 const sent:string[]=[];
 f.env.AI={run:async(_model:string,input:{messages:{content:string}[]})=>{sent.push(input.messages[1].content);return {response:{people:[{i:0,description:'A product lead at a health startup'}]}};}};
 f.env.THEME_MODEL=THEME_MODEL;
 const {ask}=await f.service.submitGuestAsk(GUEST,'Who at acme knows about knee surgery recovery?');
 const drafted=(await f.service.listGuestAsks()).asks.find(a=>a.id===ask.id)!;
 assert.deepEqual(drafted.draft.people.map(p=>p.personId),[maya]);
 assert.ok(!/surgery|knee|private thinking/i.test(JSON.stringify(drafted.draft)),JSON.stringify(drafted.draft));
 // The model sees the question, but nothing private about the people it describes.
 const people=sent.map(s=>JSON.stringify((JSON.parse(s) as {people:unknown}).people)).join('');
 assert.ok(sent.length===1&&!/surgery|knee|private thinking/i.test(people),people);
});

test('guest owner: approve the draft or an anonymous edit; a naming edit is refused; decline',async()=>{
 const {f}=await owner();
 const first=(await f.service.submitGuestAsk(GUEST,'Who knows acme?')).ask;
 const second=(await f.service.submitGuestAsk(GUEST,'Anyone at acme?')).ask;
 const third=(await f.service.submitGuestAsk(GUEST,'Who builds with acme?')).ask;
 const ref=(await f.service.listGuestAsks()).asks.find(a=>a.id===first.id)!.draft.people[0].ref;
 await assert.rejects(()=>f.service.answerGuestAsk(first.id,{text:'Talk to Maya.',people:[{ref,description:'Someone'}]}),/answer_not_anonymous/);
 await assert.rejects(()=>f.service.answerGuestAsk(first.id,{text:'One person.',people:[{ref:'p9',description:'Someone'}]}),/invalid_request/);
 assert.equal((await f.service.answerGuestAsk(first.id,{text:'One person fits.',people:[{ref,description:'A product lead at a health startup'}]})).ask.status,'answered');
 assert.equal((await f.service.answerGuestAsk(second.id)).ask.status,'answered');
 assert.equal((await f.service.declineGuestAsk(third.id)).ask.status,'declined');
 await assert.rejects(()=>f.service.declineGuestAsk(first.id),/guest_ask_state_invalid/);
 await assert.rejects(()=>f.service.submitGuestAsk(GUEST,'A fourth question today?'),/guest_rate_limited/);
});

test('guest owner: routes and machine scopes',async()=>{
 const {f}=await owner();
 const {ask}=await f.service.submitGuestAsk(GUEST,'Who knows acme?');
 const listed=await f.request('/api/people/guest-asks');
 assert.equal(listed.status,200);
 assert.equal(((await listed.json()) as {asks:{id:string}[]}).asks[0].id,ask.id);
 assert.equal((await machine(f.env,['people:read'],'GET','/api/people/guest-asks')).status,200);
 assert.equal((await machine(f.env,['people:read'],'POST','/api/people/guest-asks/decline',{id:ask.id})).status,403);
 assert.equal((await machine(f.env,['people:read','people:write'],'POST','/api/people/guest-asks/answer',{id:ask.id})).status,200);
 assert.equal((await f.request('/api/people/guest-asks/settings',{enabled:false})).status,200);
 await assert.rejects(()=>f.service.submitGuestAsk(GUEST,'More?'),/guest_ask_disabled/);
});
