import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {OWNER_LENS_WINDOW,type OwnerLensStore} from '../src/owner-lens';
import {FakeAI} from './worker-stub';

const OWNER='kaya@example.test',FOLDER='fol_1234567890abcd',NOTE='not_1234567890abcd';
const WORK='Kaya Jones is building research tools that help climate scientists compare experimental results.';
const selection={response:{passages:[{source:'summary',start:0,end:0,anchor:0,kind:'focus'}]}};
function fixture(){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>([['owner',OWNER]]);
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const statement=db.prepare(sql),rows=sql.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[]);return {toArray:()=>rows};}},get:async(key:string)=>kv.get(key),put:async(key:string,value:unknown)=>{kv.set(key,value);},delete:async(key:string)=>kv.delete(key),setAlarm:async(value:number)=>{kv.set('alarm',value);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}}};
 const ai=new FakeAI(selection),env={TOKEN_SECRET:'owner-test-key',MAIL_TOKEN_KEY:'mail-test-key',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',AI:ai};
 const service=new MailSync(ctx as any,env as any),lens=(service as any).ownerLens() as OwnerLensStore;
 const connection={ownerEmail:OWNER,status:'connected',range:'recent',watermark:null,lastSync:Date.now(),nextSync:Date.now()+3600000,lastReconcile:Date.now(),error:'',job:null};
 db.prepare('INSERT INTO granola_connection VALUES (1,?,?)').run('unused-cached-grant',JSON.stringify(connection));
 db.prepare('INSERT INTO granola_folders VALUES (?,?,NULL,0,?)').run(FOLDER,'Work meetings',Date.now());
 return {db,kv,ai,env,service,lens};
}
function cachedNote(f:ReturnType<typeof fixture>,id=NOTE,options:{hidden?:boolean;observed?:number;status?:string;hash?:string;summary?:string;ownerEmail?:string;ownerTranscript?:string}={}){
 const date=new Date(options.observed??Date.now()-1000).toISOString(),hash=options.hash??id,version='legacy:'+hash+':'+date,summary=options.summary??WORK;
 const detail={id,title:'Climate research meeting',webUrl:'https://notes.granola.ai/d/'+id,createdAt:date,updatedAt:date,meetingAt:date,dateBasis:'scheduled',ownerEmail:options.ownerEmail??OWNER,ownerName:'Kaya Jones',folderIds:[FOLDER],attendees:[{email:OWNER,name:'Kaya Jones'},{email:'friend@example.test',name:'Alex Friend'}],summary,privateNotes:''};
 f.db.prepare('INSERT OR REPLACE INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,detail.title,detail.webUrl,date,'scheduled',date,date,JSON.stringify([FOLDER]),summary,'','',hash,summary.length,options.status??'done',null,'granola-v2',0,Date.now(),options.hidden?1:0);
 f.db.prepare('INSERT OR REPLACE INTO granola_owner_context VALUES (?,?,?)').run(id,version,JSON.stringify({detail,ownerTranscript:options.ownerTranscript??''}));
 return version;
}
async function enabled(f:ReturnType<typeof fixture>,granola=true){
 let state=await f.service.setOwnerLensEnabled({revision:(await f.service.getOwnerLens()).revision,enabled:true});
 if(granola)state=await f.service.setOwnerLensGranolaEnabled({revision:state.revision,enabled:true});return state;
}
async function withoutNetwork(run:()=>Promise<void>){const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected network from cached collection');};try{await run();assert.equal(calls,0,'cached collection must not use the network');}finally{globalThis.fetch=original;}}

test('MailSync Granola collection requires separate opt-in and keeps note evidence with empty Gmail selection',async()=>withoutNetwork(async()=>{
 const f=fixture();try{
  const version=cachedNote(f);let state=await enabled(f,false);state=await f.service.refreshOwnerLens({revision:state.revision});assert.deepEqual(state.sources,[]);assert.equal(f.ai.calls.length,0);
  state=await f.service.setOwnerLensGranolaEnabled({revision:state.revision,enabled:true});state=await f.service.refreshOwnerLens({revision:state.revision});
  assert.equal(state.sources.length,1);assert.equal(state.sources[0].text,WORK);assert.equal(state.sources[0].label,'Your Granola meeting');assert.equal(state.sources[0].title,'Climate research meeting');assert.equal(state.sources[0].url,'https://notes.granola.ai/d/'+NOTE);assert.equal(f.ai.calls.length,1);assert.equal(f.lens.hasGranolaNote(NOTE,version),true);assert.equal(state.honcho.status,'unconfigured');
  const ids=state.sources.map(source=>source.id);state=await f.service.refreshOwnerLens({revision:state.revision});assert.deepEqual(state.sources.map(source=>source.id),ids);assert.equal(f.ai.calls.length,1);
  const exported=JSON.stringify([await f.service.graph(),await f.service.relevance(),await f.service.exportSlice({kind:'all'},'statements'),await f.service.exportWorkspaceSlice({kind:'all'},'statements')]);assert.ok(!exported.includes(WORK));assert.ok(!exported.includes('owner-granola:'));
 }finally{f.db.close();}
}));

test('MailSync Granola collection selects only visible recent imported notes with a three-note budget',async()=>withoutNetwork(async()=>{
 const f=fixture();try{
  for(let i=0;i<4;i++)cachedNote(f,'allowed-'+i,{observed:Date.now()-1000-i});
  cachedNote(f,'hidden',{hidden:true});cachedNote(f,'expired',{observed:Date.now()-OWNER_LENS_WINDOW-1000});cachedNote(f,'future',{observed:Date.now()+3600000});cachedNote(f,'refetch',{status:'refetch'});
  let state=await enabled(f);state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.sources.length,3);assert.equal(f.ai.calls.length,3);
  assert.deepEqual(f.db.prepare('SELECT id FROM owner_lens_granola ORDER BY id').all().map(row=>row.id),['allowed-0','allowed-1','allowed-2']);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.sources.length,4);assert.equal(f.ai.calls.length,4);assert.deepEqual(f.db.prepare('SELECT id FROM owner_lens_granola ORDER BY id').all().map(row=>row.id),['allowed-0','allowed-1','allowed-2','allowed-3']);
 }finally{f.db.close();}
}));

test('MailSync Granola exclusion and disconnect withdraw learned passages and success markers',async()=>withoutNetwork(async()=>{
 for(const action of ['exclude','disconnect'] as const){
  const f=fixture();try{
   const version=cachedNote(f);let state=await enabled(f);state=await f.service.updateOwnerLens({revision:state.revision,fields:{focus:'My manual priority',needs:'',offers:''}});state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.sources.length,1);
   if(action==='exclude')await f.service.granolaExcluded([FOLDER]);else await f.service.granolaDisconnect();
   state=await f.service.getOwnerLens();assert.deepEqual(state.sources,[]);assert.equal(f.lens.hasGranolaNote(NOTE,version),false);assert.equal(state.fields.focus,'My manual priority');assert.equal(state.honcho.cleanupPending,true);
  }finally{f.db.close();}
 }
}));

test('MailSync rechecks Granola opt-in and current note version after asynchronous extraction',async()=>withoutNetwork(async()=>{
 for(const action of ['disable','disconnect','replace'] as const){
  const f=fixture();let enter!:()=>void,release!:(value:unknown)=>void;const entered=new Promise<void>(resolve=>enter=resolve);
  try{
   const version=cachedNote(f);let state=await enabled(f);f.ai.run=async(model,input)=>{f.ai.calls.push({model,input});enter();return new Promise(resolve=>release=resolve);};
   const running=f.service.refreshOwnerLens({revision:state.revision});await entered;let mutation:Promise<unknown>|undefined;
   if(action==='disable')mutation=f.service.setOwnerLensGranolaEnabled({revision:f.lens.get().revision,enabled:false});
   else if(action==='disconnect')await f.service.granolaDisconnect();
   else cachedNote(f,NOTE,{hash:'replacement',summary:'Kaya Jones needs climate laboratories to test research comparison tools.'});
   release(selection);await running;await mutation;state=await f.service.getOwnerLens();assert.deepEqual(state.sources,[]);assert.equal(f.lens.hasGranolaNote(NOTE,version),false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_granola').get()!.n,0);
   if(action==='replace'){f.ai.run=FakeAI.prototype.run;state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.sources.length,1);assert.match(state.sources[0].text,/needs climate laboratories/);}
  }finally{release?.(selection);f.db.close();}
 }
}));

test('MailSync empty Granola extraction advances its version without inventing owner context',async()=>withoutNetwork(async()=>{
 const f=fixture();try{
  const version=cachedNote(f,NOTE,{summary:'Alex Friend needs an introduction to a robotics recruiter.'});let state=await enabled(f);state=await f.service.refreshOwnerLens({revision:state.revision});assert.deepEqual(state.sources,[]);assert.equal(f.lens.hasGranolaNote(NOTE,version),true);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.deepEqual(state.sources,[]);assert.equal(f.ai.calls.length,1);
 }finally{f.db.close();}
}));

test('Granola owner retries use versioned bounded backoff without success markers and clear after success',async()=>withoutNetwork(async()=>{
 const f=fixture(),originalNow=Date.now;let clock=originalNow();try{
  Date.now=()=>clock;const version=cachedNote(f);await enabled(f);const valid=f.lens.guard();let previous=0;
  for(let i=0;i<10;i++){
   f.lens.deferGranola(NOTE,version,valid);const next=f.lens.granolaRetryAfter(NOTE,version),delay=next-clock;assert.equal(f.lens.hasGranolaNote(NOTE,version),false);assert.ok(delay>=previous&&delay<=3600000);if(!i)assert.equal(delay,60000);previous=delay;clock=next;
  }
  assert.equal(previous,3600000);assert.equal(f.lens.granolaRetryAfter(NOTE,'different-version'),0);
  await f.lens.recordGranola({id:NOTE,version,observedAt:new Date(clock-1000).toISOString(),title:'Recovered note',url:null,passages:[]},valid);assert.equal(f.lens.hasGranolaNote(NOTE,version),true);assert.equal(f.lens.granolaRetryAfter(NOTE,version),0);
 }finally{Date.now=originalNow;f.db.close();}
}));

test('Granola owner retry metadata is removed on changed eligibility, withdrawal, and either opt-out',async()=>withoutNetwork(async()=>{
 for(const action of ['changed','removed','granola-off','master-off'] as const){
  const f=fixture();try{
   const version=cachedNote(f);await enabled(f);const valid=f.lens.guard();f.lens.deferGranola(NOTE,version,valid);assert.ok(f.lens.granolaRetryAfter(NOTE,version)>0);
   if(action==='changed'||action==='removed')await f.lens.reconcileGranola(new Map(action==='changed'?[[NOTE,'different-version']]:[]));
   else if(action==='granola-off')await f.service.setOwnerLensGranolaEnabled({revision:f.lens.get().revision,enabled:false});
   else await f.service.setOwnerLensEnabled({revision:f.lens.get().revision,enabled:false});
   assert.equal(f.lens.granolaRetryAfter(NOTE,version),0);f.lens.deferGranola(NOTE,version,valid);assert.equal(f.lens.granolaRetryAfter(NOTE,version),0);
  }finally{f.db.close();}
 }
}));

test('MailSync invalid Granola extractions back off and cannot starve older unattempted meetings',async()=>withoutNetwork(async()=>{
 const f=fixture();try{
  for(let i=0;i<3;i++){cachedNote(f,'bad-'+i,{observed:Date.now()-1000-i,summary:'Kaya Jones is building a bad extraction marker for climate research.'});cachedNote(f,'good-'+i,{observed:Date.now()-2000-i});}
  f.ai.run=async(model,input)=>{f.ai.calls.push({model,input});return JSON.stringify(input).includes('bad extraction marker')?{response:{passages:'invalid'}}:selection;};
  let state=await enabled(f);state=await f.service.refreshOwnerLens({revision:state.revision});assert.deepEqual(state.sources,[]);assert.equal(f.ai.calls.length,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_granola').get()!.n,0);
  // Even when every retry is due again, fresh older notes take the next bounded batch.
  f.db.prepare('UPDATE owner_lens_granola_retries SET next_attempt=?').run(Date.now()-1);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.sources.length,3);assert.equal(f.ai.calls.length,6);assert.deepEqual(f.db.prepare('SELECT id FROM owner_lens_granola ORDER BY id').all().map(row=>row.id),['good-0','good-1','good-2']);
 }finally{f.db.close();}
}));

test('MailSync all-deferred Granola failures stay unavailable without retrying extraction early',async()=>withoutNetwork(async()=>{
 const f=fixture();try{
  (f.env as any).HONCHO_API_KEY='unused-key';cachedNote(f);f.ai.response={response:{passages:'invalid'}};
  let state=await enabled(f);state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'unavailable');assert.deepEqual(state.sources,[]);assert.equal(f.ai.calls.length,1);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'unavailable');assert.deepEqual(state.sources,[]);assert.equal(f.ai.calls.length,1);assert.equal(f.db.prepare('SELECT attempts FROM owner_lens_granola_retries').get()!.attempts,1);
 }finally{f.db.close();}
}));
