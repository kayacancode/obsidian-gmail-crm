import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {opaque} from '../src/mail-model';
import {makeSession,sessionCookie} from '../src/session';
import {GMAIL_CONTEXT_VERSION} from '../src/gmail-context';
import worker from '../src/index';
import {jevServer,scoreA} from './granola-jev-extractor.test';

const OWNER='owner@example.test',INBOX='inbox@example.test',CONTACT='ada@example.test';
export async function fixture(owner=OWNER){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();
 const ctx:any={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async()=>{},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
 const env:any={TOKEN_SECRET:'person-context-test-key',GOOGLE_CLIENT_ID:'client',ASSETS:{fetch:async()=>new Response('asset')}};
 const service=new MailSync(ctx,env);env.MAIL={getByName(requested:string){assert.equal(requested,owner);return service;}};
 await service.bindOwner(owner);
 db.prepare('INSERT INTO accounts VALUES (?,?)').run(INBOX,JSON.stringify({email:INBOX,grant:'unused',status:'connected',job:null,lastSync:Date.now(),nextSync:9e15,contextEnabled:true,contextVersion:GMAIL_CONTEXT_VERSION}));
 const add=(email:string,name:string)=>db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run(INBOX,email,email,name,Date.now(),'Contact',1,1);
 add(CONTACT,'Ada');const personId=await opaque(owner,CONTACT,env.TOKEN_SECRET);
 const cookie=sessionCookie(await makeSession(owner,env.TOKEN_SECRET)).split(';')[0];
 const request=async(path:string,body?:unknown,options:{origin?:string;method?:string;signed?:boolean}={})=>worker.fetch(new Request('https://people.test'+path,{method:options.method??(body===undefined?'GET':'POST'),headers:{...(options.signed===false?{}:{cookie}),...(body===undefined?{}:{origin:options.origin??'https://people.test','content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 return {db,kv,ctx,env,service,personId,add,request};
}

test('private person context persists exact owner notes across instances and never enters graph or exports',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.service.getPersonContext(f.personId),{personId:f.personId,text:'',revision:null,updatedAt:null});
  const saved=await f.service.savePersonContext({personId:f.personId,text:'  Ada is validating nurse handoffs. Needs clinic design partners.  ',revision:null});
  assert.equal(saved.text,'Ada is validating nurse handoffs. Needs clinic design partners.');assert.match(saved.revision!,/^[0-9a-f-]{36}$/);assert.ok(saved.updatedAt!>0);
  const restarted=new MailSync(f.ctx,f.env);assert.deepEqual(await restarted.getPersonContext(f.personId),saved);
  for(const result of [await restarted.graph(),await restarted.exportSlice({kind:'all'},'statements'),await restarted.helperContext()])assert.ok(!JSON.stringify(result).includes('Needs clinic design partners'));
 }finally{f.db.close();}
});

test('private person context revisions reject stale overwrite and stale resurrection after removal',async()=>{
 const f=await fixture();try{
  const first=await f.service.savePersonContext({personId:f.personId,text:'First context',revision:null});
  await assert.rejects(f.service.savePersonContext({personId:f.personId,text:'Stale creation',revision:null}),/person_context_conflict/);
  const second=await f.service.savePersonContext({personId:f.personId,text:'Updated context',revision:first.revision});assert.notEqual(second.revision,first.revision);
  await assert.rejects(f.service.savePersonContext({personId:f.personId,text:'Stale overwrite',revision:first.revision}),/person_context_conflict/);
  const removed=await f.service.savePersonContext({personId:f.personId,text:'   ',revision:second.revision});assert.equal(removed.text,'');assert.notEqual(removed.revision,second.revision);
  await assert.rejects(f.service.savePersonContext({personId:f.personId,text:'Resurrected',revision:second.revision}),/person_context_conflict/);
  assert.deepEqual(await f.service.getPersonContext(f.personId),removed);
  const created=await f.service.savePersonContext({personId:f.personId,text:'New context',revision:removed.revision});assert.equal(created.text,'New context');
 }finally{f.db.close();}
});

test('private person context concurrent editors cannot overwrite each other',async()=>{
 const f=await fixture();try{
  const results=await Promise.allSettled(['First editor','Second editor'].map(text=>f.service.savePersonContext({personId:f.personId,text,revision:null})));
  const saved=results.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<MailSync['savePersonContext']>>>=>r.status==='fulfilled');
  assert.equal(saved.length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='person_context_conflict').length,1);
  assert.deepEqual(await f.service.getPersonContext(f.personId),saved[0].value);
 }finally{f.db.close();}
});

test('private person context rejects foreign, shared-only and pushed IDs and no longer reads removed contacts',async()=>{
 const f=await fixture();try{
  const foreign=await opaque('other@example.test',CONTACT,f.env.TOKEN_SECRET),shared=await opaque(OWNER,'shared@example.test',f.env.TOKEN_SECRET);
  f.db.prepare('INSERT INTO shared_people VALUES (?,?,?,?,?)').run('other@example.test','shared@example.test','Shared',new Date().toISOString(),1);
  for(const id of [foreign,shared,'obsidian-local-person']){
   await assert.rejects(f.service.getPersonContext(id),/unknown_person/);
   await assert.rejects(f.service.savePersonContext({personId:id,text:'Wrong person',revision:null}),/unknown_person/);
  }
  await f.service.savePersonContext({personId:f.personId,text:'Private',revision:null});
  f.db.prepare('DELETE FROM contributions WHERE email=?').run(CONTACT);
  await assert.rejects(f.service.getPersonContext(f.personId),/unknown_person/);
  await assert.rejects(f.service.savePersonContext({personId:f.personId,text:'Private',revision:null}),/unknown_person/);
  await assert.rejects(f.service.bindOwner('other@example.test'),/missing_owner/);
 }finally{f.db.close();}
});

test('private person context route authenticates before access and enforces bounded exact input',async()=>{
 const f=await fixture(),path='/api/people/context';try{
  assert.equal((await f.request(path+'?personId='+f.personId,undefined,{signed:false})).status,401);
  assert.equal((await f.request(path,{personId:f.personId,text:'Private',revision:null},{origin:'https://evil.test'})).status,403);
  for(const body of [{personId:f.personId,text:'x'.repeat(1001),revision:null},{personId:f.personId,text:'valid'}, {personId:f.personId,text:'valid',revision:'not-a-revision'}, {personId:f.personId,text:'valid',revision:null,owner:'other@example.test'},null,[]])assert.equal((await f.request(path,body)).status,400);
  assert.equal((await f.request(path,{personId:f.personId,text:'x'.repeat(30000),revision:null})).status,400);
  for(const query of ['', '?personId=a@b.test','?personId='+f.personId+'&personId='+f.personId,'?personId='+f.personId+'&source=obsidian'])assert.equal((await f.request(path+query)).status,400);
  assert.equal((await f.request(path,undefined,{method:'DELETE'})).status,405);
  const response=await f.request(path,{personId:f.personId,text:'Saved via route',revision:null});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const saved=await response.json();
  const read=await f.request(path+'?personId='+f.personId);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.deepEqual(await read.json(),saved);
  assert.equal((await f.request(path,{personId:f.personId,text:'Stale',revision:null})).status,409);
  assert.equal((await f.request(path+'?personId=missing')).status,404);
 }finally{f.db.close();}
});

test('private person context helper uses saved context, explicit refinement wins, and empty removal restores automatic context',async()=>{
 const f=await fixture();try{
  const saved=await f.service.savePersonContext({personId:f.personId,text:'Needs clinic design partners.',revision:null});
  const ask=async(brief:string)=>f.request('/api/people/helpers',{personId:f.personId,brief});
  const automatic=await (await ask('')).json() as any;assert.equal(automatic.contextSource,'saved_note');assert.equal(automatic.brief,'Needs clinic design partners.');assert.equal(automatic.automatic,true);assert.equal(automatic.anchorEvidence[0].sourceType,'owner_context');
  const refined=await (await ask('Specific help with nurse handoffs')).json() as any;assert.equal(refined.contextSource,'brief');assert.equal(refined.brief,'Specific help with nurse handoffs');
  await f.service.savePersonContext({personId:f.personId,text:'',revision:saved.revision});
  const removed=await (await ask('')).json() as any;assert.equal(removed.contextSource,'automatic');assert.equal(removed.brief,'');assert.equal(removed.status,'no_anchor_context');
 }finally{f.db.close();}
});

test('private person context helpers reject stale saved-note results after model work and preserve the new note',async()=>{
 const oldFetch=globalThis.fetch;
 for(const change of ['edit','remove','identity'] as const){const f=await fixture();try{
  const saved=await f.service.savePersonContext({personId:f.personId,text:'Needs clinic design partners.',revision:null});
  f.add('bo@example.test','Bo');const candidate=await opaque(OWNER,'bo@example.test',f.env.TOKEN_SECRET);
  f.db.prepare('INSERT INTO gmail_context (account,message,person,observed,facts,version) VALUES (?,?,?,?,?,?)').run(INBOX,'candidate-message',candidate,Date.now(),JSON.stringify([{quote:'I interview nurses about clinic handoffs.',kind:'experience'}]),GMAIL_CONTEXT_VERSION);
  f.env.AI={};f.env.TYPESAFE_API_KEY='test';let calls=0;
  const provider=jevServer((id:string,_q:any,state:any)=>{assert.equal(state.selectedContext.userBrief,undefined);assert.equal(state.selectedContext.evidence[0].summary,'Needs clinic design partners.');assert.equal(state.selectedContext.evidence[0].authoredBy,'OWNER');assert.equal(state.selectedContext.evidence[0].subject,'PERSON_A');return scoreA(0);}).fake;
  globalThis.fetch=async(...args)=>{calls++;if(change==='identity')f.db.prepare('DELETE FROM contributions WHERE email=?').run(CONTACT);else await f.service.savePersonContext({personId:f.personId,text:change==='edit'?'Updated direction.':'',revision:saved.revision});return provider(...args);};
  const response=await f.request('/api/people/helpers',{personId:f.personId,brief:''});assert.equal(calls,1);assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'person_context_conflict'});
  if(change!=='identity')assert.equal((await f.service.getPersonContext(f.personId)).text,change==='edit'?'Updated direction.':'');
 }finally{globalThis.fetch=oldFetch;f.db.close();}}
});
