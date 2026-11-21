import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {defaultBookingSettings} from '../src/booking-policy';
import {guestAskPublicRoute,type GuestAskDeps} from '../src/guest-ask-routes';
import {proposeIntroduction,type Introduction} from '../src/introductions';
import type {GuestView} from '../src/guest-ask';

const OWNER='owner@example.test';
const SETTINGS={...defaultBookingSettings(OWNER),slug:'test-host',displayName:'The Owner'};

/** The owner's network (Maya Rivera at acme.test), with the booking sign-in replaced by a switchable visitor. */
async function guestPage(){
 const f=await fixture();
 f.env.DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]}),first:async()=>null,run:async()=>({})})};
 f.add('maya@acme.test','Maya Rivera');
 let visitor:{email:string;subject:string}|null=null;
 const deps:GuestAskDeps={
  settings:async slug=>slug==='test-host'?SETTINGS:null,
  visitor:async()=>{if(!visitor)throw Error('verification_required');return {...visitor,emailAuthoritative:true};},
  ready:async()=>true,
  signIn:async()=>({url:'https://accounts.google.test/o/oauth2/auth',cookie:'browser=1; Path=/'}),
 };
 const call=(path:string,init:{method?:string;body?:unknown;origin?:string}={})=>guestAskPublicRoute(new Request('https://people.test/api/public/ask/test-host'+path,{method:init.method??(init.body===undefined?'GET':'POST'),headers:{origin:init.origin??'https://people.test','content-type':'application/json'},...(init.body===undefined?{}:{body:JSON.stringify(init.body)})}),f.env,deps);
 const signIn=(subject:string)=>{visitor={email:subject+'@startup.test',subject};};
 return {f,call,signIn};
}

test('guest public: the page says whether guest ask is on; nothing is accepted while it is off',async()=>{
 const {f,call,signIn}=await guestPage();
 assert.deepEqual(await (await call('')).json(),{page:{displayName:'The Owner'},enabled:false,visitor:null});
 signIn('founder');
 const refused=await call('/questions',{body:{question:'Who knows acme?'}});
 assert.equal(refused.status,403);assert.deepEqual(await refused.json(),{error:'guest_ask_disabled'});
 await f.service.setGuestAsk(true);
 const page=await call('');
 assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 assert.deepEqual(await page.json(),{page:{displayName:'The Owner'},enabled:true,visitor:{email:'founder@startup.test'}});
 assert.equal((await call('/sign-in',{body:{}})).status,200);
 assert.equal((await guestAskPublicRoute(new Request('https://people.test/api/public/ask/nobody'),f.env,{settings:async()=>null,visitor:async()=>{throw Error('verification_required');},ready:async()=>true,signIn:async()=>({url:'',cookie:''})})).status,404);
});

test('guest public: verified guests ask up to three questions a day and see only their own, without drafts',async()=>{
 const {f,call,signIn}=await guestPage();
 await f.service.setGuestAsk(true);
 assert.equal((await call('/questions',{body:{question:'Who knows acme?'}})).status,401);
 signIn('founder');
 assert.equal((await call('/questions',{body:{question:'Who knows acme?'},origin:'https://evil.test'})).status,403);
 assert.equal((await call('/questions',{body:{question:'x'.repeat(501)}})).status,400);
 for(const question of ['Who knows acme?','Anyone at acme?','Who builds with acme?'])assert.equal((await call('/questions',{body:{question}})).status,200);
 const limited=await call('/questions',{body:{question:'A fourth?'}});
 assert.equal(limited.status,429);assert.deepEqual(await limited.json(),{error:'guest_rate_limited'});
 const mine=await (await call('/questions')).json() as {questions:GuestView[]};
 assert.equal(mine.questions.length,3);
 assert.ok(mine.questions.every(q=>q.status==='pending'&&q.answer===null));
 assert.ok(!/maya|rivera|acme\.test|p-|draft/i.test(JSON.stringify(mine)),JSON.stringify(mine));
 signIn('someone-else');
 assert.deepEqual(await (await call('/questions')).json(),{questions:[]});
});

test('guest public: a name is revealed only after the described person opts in',async()=>{
 const {f,call,signIn}=await guestPage();
 await f.service.setGuestAsk(true);signIn('founder');
 const {question}=await (await call('/questions',{body:{question:'Who knows acme?'}})).json() as {question:GuestView};
 // Not answered yet: nothing to ask for.
 assert.equal((await call(`/questions/${question.id}/introductions`,{body:{ref:'p1'}})).status,409);
 await f.service.answerGuestAsk(question.id);
 assert.equal((await call(`/questions/${question.id}/introductions`,{body:{ref:'p9'}})).status,400);
 signIn('intruder');
 assert.equal((await call(`/questions/${question.id}/introductions`,{body:{ref:'p1'}})).status,404);
 signIn('founder');
 const asked=await (await call(`/questions/${question.id}/introductions`,{body:{ref:'p1'}})).json() as {question:GuestView};
 assert.deepEqual(asked.question.answer?.people.map(p=>[p.introduction,p.name]),[['proposed',undefined]]);
 assert.equal((await call(`/questions/${question.id}/introductions`,{body:{ref:'p1'}})).status,409);
 const intro=(await f.service.listIntroductions()).introductions[0];
 assert.equal(intro.startedBy,'guest');assert.equal(intro.introducer,'owner');assert.equal(intro.parties[0],'guest:founder');
 await f.service.advanceIntroduction(intro.id,'introducer_accepted');
 const accepted=await (await call('/questions')).json() as {questions:GuestView[]};
 assert.ok(!JSON.stringify(accepted).includes('Maya'));
 await f.service.advanceIntroduction(intro.id,'target_opted_in');
 const revealed=await (await call('/questions')).json() as {questions:GuestView[]};
 assert.equal(revealed.questions[0].answer?.people[0].name,'Maya Rivera');
});

test('guest public: guest-started introductions count against the owner\'s open budget',()=>{
 const now=Date.now();let existing:Introduction[]=[];
 for(let i=0;i<5;i++)existing=[...existing,proposeIntroduction({introducer:'owner',parties:[`guest:g${i}`,`p-${i}`],reason:'A guest asked',evidence:[]},existing,now,'guest')];
 assert.ok(existing.every(i=>i.startedBy==='guest'));
 assert.throws(()=>proposeIntroduction({introducer:'owner',parties:['guest:g9','p-9'],reason:'A guest asked',evidence:[]},existing,now,'guest'),/introduction_budget/);
 // The owner's own proposals are not blocked by guest requests.
 assert.doesNotThrow(()=>proposeIntroduction({introducer:'owner',parties:['p-a','p-b'],reason:'Both build agents',evidence:[]},existing,now));
});
