import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OwnerLensStore,ownerMailPassages,OWNER_LENS_WINDOW,ownerLensDiagnostic} from '../src/owner-lens';
import {MailSync} from '../src/mail-sync';
import {seal} from '../src/mail-model';
import {rankOwnerLens} from '../src/helper-brief';

const OWN='me@example.com';
const WORK='I am building research tools that help climate scientists compare experimental results.';
const facts={response:{facts:[{start:0,end:0,anchor:0,kind:'building'}]}};
function fixture(configured=false){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>([['owner',OWN]]);
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql),rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const ai={calls:[] as any[],async run(_model:string,input:any){this.calls.push(input);return facts;}};
 const env={TOKEN_SECRET:'owner-test-key',MAIL_TOKEN_KEY:'mail-test-key',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',HONCHO_API_KEY:configured?'test-honcho-key':undefined,AI:ai};
 const service=new MailSync(ctx as any,env as any),store=new OwnerLensStore(ctx as any,env as any,async()=>OWN);
 return {db,kv,ctx,env,ai,service,store};
}
function message(id:string,from=OWN,text=WORK,observed=Date.now()-1000){return {id,internalDate:String(observed),payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:from===OWN?'friend@example.com':OWN},{name:'Message-ID',value:id},{name:'Subject',value:'Research tools'}],body:{data:Buffer.from(text).toString('base64url')}}};}
async function enabled(store:OwnerLensStore){return store.setEnabled({revision:store.get().revision,enabled:true});}
async function addMail(store:OwnerLensStore,id='sent',account=OWN,text=WORK,observed=Date.now()-1000){await store.recordMail(account,id,observed,message(id,account,text,observed),store.guard());}
async function account(f:ReturnType<typeof fixture>,email=OWN){f.db.prepare('INSERT INTO accounts VALUES (?,?)').run(email,JSON.stringify({email,grant:await seal('refresh-token',f.env.MAIL_TOKEN_KEY),revision:'account-revision',status:'connected',job:null,lastSync:Date.now(),nextSync:Date.now()+3600000}));}
function indexed(f:ReturnType<typeof fixture>,id:string,sent=1,observed=Date.now()-1000){f.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(OWN,id,id);f.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run(OWN,id,'friend@example.com','Friend',observed,'Research',sent,sent?0:1);}
function granolaNote(id='meeting',version='version-1',passages=[WORK]){return {id,version,observedAt:new Date(Date.now()-500).toISOString(),title:'Research meeting',url:'https://notes.granola.ai/d/meeting',passages};}
function honchoNetwork(options:{chat?:()=>Promise<void>;deleteFailure?:boolean}={}){
 const original=globalThis.fetch,calls:{path:string;body:any;method:string}[]=[],messages=new Map<string,any[]>(),metadata=new Map<string,any>();let workspacePresent=false;
 globalThis.fetch=async(input:any,init:any={})=>{
  const url=new URL(String(input)),body=init.body?JSON.parse(init.body):{},path=url.pathname,method=init.method||'GET';calls.push({path,body,method});
  const workspace=path.match(/\/workspaces\/([^/]+)/)?.[1],session=path.match(/\/sessions\/([^/]+)/)?.[1];
  if(path==='/v3/workspaces/list')return options.deleteFailure?new Response(null,{status:503}):Response.json({items:workspacePresent?[{id:body.filters.id,metadata:{purpose:'private-owner-lens-v1'}}]:[],total:workspacePresent?1:0});
  if(path.endsWith('/sessions/list')){const items=[...new Set([...messages.keys(),...metadata.keys()])].map(id=>({id,workspace_id:workspace}));return Response.json({items,total:items.length});}
  if(method==='DELETE'){if(session){messages.delete(session);metadata.delete(session);}else workspacePresent=false;return new Response(null,{status:202});}
  if(path==='/v3/workspaces'){workspacePresent=true;return Response.json({id:body.id});}
  if(path.endsWith('/peers'))return Response.json({id:body.id,workspace_id:workspace});
  if(path.endsWith('/sessions')){if(body.metadata)metadata.set(body.id,body.metadata);return Response.json({id:body.id,workspace_id:workspace,metadata:metadata.get(body.id)??{}});}
  if(path.endsWith('/messages/list')){const items=messages.get(session!)??[];return Response.json({items,total:items.length});}
  if(path.endsWith('/messages')){const items=body.messages.map((m:any,i:number)=>({...m,id:'m'+i,workspace_id:workspace,session_id:session}));messages.set(session!,items);return Response.json(items);}
  if(path.endsWith('/chat')){
   await options.chat?.();const stored=messages.get(body.session_id)??[],source=JSON.parse(stored[0].content);
   return Response.json({content:JSON.stringify({entries:[{kind:'focus',text:'Building research tools for climate scientists.',sources:[{sourceId:source.sourceId,quote:source.text}]}]})});
  }
  // Session metadata marker update/get used to avoid replaying uncertain writes.
  if(session){if(body.metadata)metadata.set(session,body.metadata);return Response.json({id:session,workspace_id:workspace,metadata:metadata.get(session)??{}});}
  throw Error('Unexpected test URL '+path);
 };
 return {calls,clear:()=>{messages.clear();metadata.clear();workspacePresent=false;},restore:()=>{globalThis.fetch=original;}};
}

test('owner lens manual fields require fresh revisions and never trigger learning',async()=>{
 const f=fixture();const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('unexpected network');};
 try{
  const initial=f.store.get();assert.equal(initial.enabled,false);
  const saved=f.store.update({revision:initial.revision,fields:{focus:' My current project ',needs:'Design partners',offers:'Research advice'}});
  assert.equal(saved.fields.focus,'My current project');assert.equal(saved.honcho.status,'disabled');assert.deepEqual(saved.sources,[]);
  assert.throws(()=>f.store.update({revision:initial.revision,fields:saved.fields}),/owner_lens_conflict/);
  assert.throws(()=>f.store.update({revision:saved.revision,fields:{...saved.fields,focus:'x'.repeat(501)}}),/invalid_owner_lens/);
  await assert.rejects(f.store.refresh({revision:saved.revision,note:WORK},async()=>{}),/owner_lens_disabled/);
  assert.equal(f.ai.calls.length,0);
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens enabling learning is idle until an explicit refresh and does not schedule provider work',async()=>{
 const f=fixture(true),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('unexpected network');};
 try{
  let state=await f.service.getOwnerLens();
  state=await f.service.updateOwnerLens({revision:state.revision,fields:{focus:WORK,needs:'Research peers',offers:''}});
  state=await f.service.setOwnerLensEnabled({revision:state.revision,enabled:true});
  assert.equal(state.honcho.status,'idle');assert.deepEqual(state.refresh,{state:'not_refreshed',lastRefresh:null,nextAction:'refresh'});
  assert.deepEqual(state.sources,[]);assert.equal(state.honcho.lastSync,null);assert.equal(f.kv.has('alarm'),false);
  await f.service.alarm();assert.deepEqual((await f.service.getOwnerLens()).refresh,state.refresh);
  const result=await rankOwnerLens(f.env,{nodes:[{id:'person',name:'A contact'}]},state.fields);
  assert.equal(result.status,'no_evidence');assert.equal(result.considered,0);assert.equal(requests,0);assert.equal(f.ai.calls.length,0);
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens empty refresh reports no sources without claiming a successful Honcho sync',async()=>{
 const f=fixture(true),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('unexpected network');};
 try{
  let state=await enabled(f.store);
  state=await f.service.refreshOwnerLens({revision:state.revision});
  assert.equal(state.honcho.status,'idle');assert.equal(state.refresh.state,'no_sources');assert.equal(state.refresh.nextAction,'add_note_or_connect_source');
  assert.match(state.refresh.lastRefresh!,/^\d{4}-/);assert.equal(state.honcho.lastSync,null);assert.deepEqual(state.sources,[]);assert.equal(requests,0);assert.equal(f.ai.calls.length,0);
  await addMail(f.store);state=f.store.get();
  assert.equal(state.honcho.status,'idle');assert.equal(state.refresh.state,'refresh_required');assert.equal(state.refresh.nextAction,'refresh');assert.equal(state.honcho.lastSync,null);
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens legacy pending and empty ready snapshots derive truthful idle states without changing saved data',async()=>{
 const f=fixture(true);try{
  await enabled(f.store);
  for(const [status,expected] of [['pending','not_refreshed'],['ready','no_sources']] as const){
   const stored=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);stored.status=status;delete stored.lastRefresh;delete stored.projectionRequested;delete stored.pendingSnapshot;
   const serialized=JSON.stringify(stored);f.db.prepare('UPDATE owner_lens_state SET data=?').run(serialized);
   const state=new OwnerLensStore(f.ctx as any,f.env as any,async()=>OWN).get();
   assert.equal(state.honcho.status,'idle');assert.equal(state.refresh.state,expected);assert.equal(state.refresh.lastRefresh,null);
   assert.equal(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data,serialized);
  }
 }finally{f.db.close();}
});

test('owner lens explicit note refresh distinguishes provider pending from a completed real sync',async()=>{
 const f=fixture(true),net=honchoNetwork(),transport=globalThis.fetch;let pending=true;
 globalThis.fetch=async(input:any,init:any)=>String(input).endsWith('/chat')&&pending?Response.json({content:null}):transport(input,init);
 try{
  let state=await enabled(f.store);assert.equal(net.calls.length,0);
  state=await f.store.refresh({revision:state.revision,note:WORK},async()=>{});
  assert.equal(state.sources.length,1);assert.equal(state.honcho.status,'pending');assert.equal(state.refresh.state,'pending');assert.equal(state.refresh.nextAction,'refresh');assert.match(state.refresh.lastRefresh!,/^\d{4}-/);assert.equal(state.honcho.lastSync,null);
  pending=false;state=await f.store.refresh({revision:state.revision},async()=>{});
  assert.equal(state.honcho.status,'ready');assert.equal(state.refresh.state,'ready');assert.equal(state.refresh.nextAction,'review_suggestions');assert.match(state.honcho.lastSync!,/^\d{4}-/);assert.equal(state.fields.focus,'');
 }finally{net.restore();f.db.close();}
});

test('owner lens source extraction verifies actual From and strips replies before attribution',async()=>{
 const f=fixture();try{
  assert.deepEqual(await ownerMailPassages(message('inbound','friend@example.com'),'inbound',OWN,f.ai as any),[]);
  const spoof=message('spoof');spoof.payload.headers[0].value=OWN+', stranger@example.com';assert.deepEqual(await ownerMailPassages(spoof,'spoof',OWN,f.ai as any),[]);
  assert.deepEqual(await ownerMailPassages(message('old',OWN,WORK,Date.now()-OWNER_LENS_WINDOW-1),'old',OWN,f.ai as any),[]);
  assert.equal(f.ai.calls.length,0);
  const result=await ownerMailPassages(message('sent',OWN,WORK+'\nOn Tuesday a friend wrote:\nI need a buyer for my company.'),'sent',OWN,f.ai as any);
  assert.equal(result[0].quote,WORK);assert.ok(!JSON.stringify(f.ai.calls).includes('buyer'));
 }finally{f.db.close();}
});

test('owner lens uses a global four-message sent-only refresh budget and tombstones empty passages',async()=>{
 const f=fixture();const original=globalThis.fetch,calls:string[]=[];
 try{
  await account(f);await enabled(f.store);
  for(let i=0;i<6;i++)indexed(f,'sent'+i,1,Date.now()-1000-i);
  indexed(f,'inbound',0,Date.now());indexed(f,'too-old',1,Date.now()-OWNER_LENS_WINDOW-1000);
  f.ai.run=async(_m,input)=>{f.ai.calls.push(input);return {response:{facts:[]}};};
  globalThis.fetch=async(input:any)=>{const url=String(input);calls.push(url);if(url.includes('oauth2'))return Response.json({access_token:'access'});const id=new URL(url).pathname.split('/').at(-1)!;return Response.json(message(id));};
  let state=await f.service.refreshOwnerLens({revision:(await f.service.getOwnerLens()).revision});
  assert.equal(calls.filter(c=>c.includes('format=full')).length,4);assert.ok(!calls.some(c=>c.includes('/inbound')||c.includes('/too-old')));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_messages').get()!.n,4);assert.deepEqual(state.sources,[]);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(calls.filter(c=>c.includes('format=full')).length,6);assert.equal(state.honcho.status,'unconfigured');
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens suggestions require review, keep dated provenance, persist dismissals, and never enter exports',async()=>{
 const f=fixture(true),net=honchoNetwork();try{
  await account(f);indexed(f,'sent');await enabled(f.store);await addMail(f.store);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(state.honcho.status,'ready');assert.equal(state.suggestions.length,1);assert.equal(state.fields.focus,'');
  state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},true);assert.match(state.fields.focus,/climate scientists/);
  const internal=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);assert.match(internal.accepted.focus.acceptedAt,/^\d{4}-/);assert.equal(internal.accepted.focus.sourceIds[0],state.sources[0].id);
  const exported=JSON.stringify([await f.service.graph(),await f.service.relevance(),await f.service.exportSlice({kind:'all'},'statements'),await f.service.exportWorkspaceSlice({kind:'all'},'statements')]);
  assert.ok(!exported.includes(WORK));assert.ok(!exported.includes('climate scientists'));assert.ok(!exported.includes('owner-mail:'));
  await addMail(f.store,'sent2');state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(state.suggestions.length,0);
  await f.service.remove(OWN);assert.equal(f.store.get().fields.focus,'');assert.deepEqual(f.store.get().sources,[]);
 }finally{net.restore();f.db.close();}
});

test('owner lens disable clears learned evidence, preserves manual fields and exposes pending remote deletion',async()=>{
 const f=fixture(true),net=honchoNetwork({deleteFailure:true});try{
  let state=await enabled(f.store);state=f.store.update({revision:state.revision,fields:{focus:'My manual focus',needs:'My manual need',offers:''}});await addMail(f.store);
  state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(state.suggestions.length,1);
  state=await f.store.setEnabled({revision:state.revision,enabled:false});assert.equal(state.enabled,false);assert.equal(state.fields.focus,'My manual focus');assert.equal(state.fields.needs,'My manual need');assert.deepEqual(state.sources,[]);assert.deepEqual(state.suggestions,[]);assert.equal(state.honcho.status,'unavailable');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_messages').get()!.n,0);
  state=await f.store.setEnabled({revision:state.revision,enabled:true});const chats=net.calls.filter(c=>c.path.endsWith('/chat')).length;
  await f.store.refresh({revision:state.revision,note:WORK},async()=>{});assert.equal(net.calls.filter(c=>c.path.endsWith('/chat')).length,chats);
 }finally{net.restore();f.db.close();}
});

test('owner lens late provider response cannot restore disabled evidence or overwrite manual edits',async()=>{
 for(const disable of [false,true]){
  const f=fixture(true);let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r),net=honchoNetwork({chat:async()=>{entered();await held;}});
  try{
   await enabled(f.store);await addMail(f.store);const pending=f.store.refresh({revision:f.store.get().revision},async()=>{});await ready;
   let changed:Promise<any>|undefined;
   if(disable)changed=f.store.setEnabled({revision:f.store.get().revision,enabled:false});else f.store.update({revision:f.store.get().revision,fields:{focus:'The new manual priority',needs:'',offers:''}});
   if(disable){assert.equal(f.store.get().enabled,false);assert.deepEqual(f.store.get().sources,[]);}
   release();await pending;await changed;
   const result=f.store.get();assert.deepEqual(result.suggestions,[]);assert.equal(result.enabled,!disable);if(!disable)assert.equal(result.fields.focus,'The new manual priority');
  }finally{release?.();net.restore();f.db.close();}
 }
});

test('owner lens retention bounds private passages and expires accepted inferred fields',async()=>{
 const f=fixture(true),net=honchoNetwork();const now=Date.now;try{
  await enabled(f.store);for(let i=0;i<35;i++)await addMail(f.store,'sent'+i,OWN,WORK,now()-1000-i);
  assert.equal(f.store.get().sources.length,30);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},true);
  Date.now=()=>now()+OWNER_LENS_WINDOW+10000;state=f.store.get();assert.deepEqual(state.sources,[]);assert.equal(state.fields.focus,'');assert.deepEqual(state.suggestions,[]);
 }finally{Date.now=now;net.restore();f.db.close();}
});

test('owner lens authored notes store exact selected passages and leave manually entered fields authoritative',async()=>{
 const f=fixture();try{
  let state=await enabled(f.store);state=f.store.update({revision:state.revision,fields:{focus:'Manual focus',needs:'',offers:''}});
  const note=WORK+' This sentence is not selected for storage.';
  state=await f.store.refresh({revision:state.revision,note},async()=>{});
  assert.equal(state.sources.length,1);assert.equal(state.sources[0].label,'Your note');assert.equal(state.sources[0].text,WORK);assert.equal(state.fields.focus,'Manual focus');
  const stored=f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string;assert.ok(!stored.includes('not selected for storage'));
  await assert.rejects(f.store.refresh({revision:state.revision,note:'x'.repeat(3001)},async()=>{}),/invalid_owner_lens/);
  state=await f.store.setEnabled({revision:state.revision,enabled:false});assert.equal(state.fields.focus,'Manual focus');assert.deepEqual(state.sources,[]);
 }finally{f.db.close();}
});

test('owner lens normal mail batches collect only owner sent work without calling Honcho',async()=>{
 const f=fixture(true),original=globalThis.fetch,calls:string[]=[];
 try{
  await f.service.setOwnerLensEnabled({revision:(await f.service.getOwnerLens()).revision,enabled:true});
  globalThis.fetch=async(input:any)=>{
   const url=String(input);calls.push(url);assert.ok(!url.includes('honcho.dev'));
   if(url.includes('oauth2'))return Response.json({access_token:'access'});
   if(url.includes('/messages?'))return Response.json({messages:[{id:'sent'},{id:'incoming'}]});
   const id=new URL(url).pathname.split('/').at(-1)!;return Response.json(message(id,id==='sent'?OWN:'friend@example.com'));
  };
  await f.service.attachAccount(OWN,'refresh-token','recent');await f.service.alarm();
  const state=await f.service.getOwnerLens();assert.equal(state.sources.length,1);assert.equal(state.sources[0].label,'Your sent email');assert.equal(state.suggestions.length,0);
  assert.ok(calls.some(c=>c.includes('/sent?format=full')));assert.ok(!calls.some(c=>c.includes('/incoming?format=full')));
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens extraction finishing after account withdrawal cannot restore removed sources',async()=>{
 const f=fixture();let entered!:()=>void,release!:(v:any)=>void;
 const ready=new Promise<void>(r=>entered=r);
 try{
  await enabled(f.store);f.ai.run=async()=>{entered();return new Promise(r=>release=r);};
  const running=addMail(f.store);await ready;await f.store.removeAccount(OWN);release(facts);await running;
  assert.deepEqual(f.store.get().sources,[]);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_messages').get()!.n,0);
 }finally{release?.(facts);f.db.close();}
});

test('owner lens unchanged source snapshots reuse suggestions and dismissals persist across refreshes',async()=>{
 const f=fixture(true),net=honchoNetwork();try{
  await enabled(f.store);await addMail(f.store);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});const chats=net.calls.filter(c=>c.path.endsWith('/chat')).length;
  state=await f.store.refresh({revision:state.revision},async()=>{});assert.equal(net.calls.filter(c=>c.path.endsWith('/chat')).length,chats);
  const before={...state.fields};state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},false);assert.deepEqual(state.fields,before);
  await addMail(f.store,'new-sent');state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.deepEqual(state.suggestions,[]);
 }finally{net.restore();f.db.close();}
});

test('owner lens explicit refresh retries an empty result without duplicating its evidence upload',async()=>{
 const f=fixture(true),net=honchoNetwork(),originalInfo=console.info,projectionLogs:string[]=[];let chats=0;
 try{
  console.info=(value:unknown)=>{projectionLogs.push(String(value));};
  const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{
   const response=await network(input,init);
   if(new URL(String(input)).pathname.endsWith('/chat')&&++chats===1)return Response.json({content:JSON.stringify({entries:[]})});
   return response;
  };
  await enabled(f.store);await addMail(f.store);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});
  assert.equal(state.honcho.status,'ready');assert.deepEqual(state.suggestions,[]);const sources=state.sources;
  state=await f.store.refresh({revision:state.revision},async()=>{});
  assert.equal(state.suggestions.length,1);assert.equal(chats,2);assert.deepEqual(state.sources,sources);
  assert.equal(net.calls.filter(call=>call.path.endsWith('/messages')).length,1);assert.equal(state.fields.focus,'');
  state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},false);
  state=await f.store.refresh({revision:state.revision},async()=>{});assert.deepEqual(state.suggestions,[]);
  assert.deepEqual(projectionLogs.map(line=>JSON.parse(line)).filter(event=>event.event==='owner_lens_projection'),[
   {event:'owner_lens_projection',sourceCount:1,providerEntries:0,reviewableEntries:0,filteredEntries:0},
   {event:'owner_lens_projection',sourceCount:1,providerEntries:1,reviewableEntries:1,filteredEntries:0},
   {event:'owner_lens_projection',sourceCount:1,providerEntries:1,reviewableEntries:0,filteredEntries:1},
  ]);
 }finally{console.info=originalInfo;net.restore();f.db.close();}
});

test('owner lens collecting evidence outside its retained window preserves current suggestions',async()=>{
 const f=fixture(true),net=honchoNetwork();try{
  await enabled(f.store);const now=Date.now();
  for(let i=0;i<30;i++)await addMail(f.store,'recent'+i,OWN,WORK,now-1000-i);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});
  const suggestions=state.suggestions,sources=state.sources,chats=net.calls.filter(call=>call.path.endsWith('/chat')).length;
  assert.equal(suggestions.length,1);
  state=await f.store.refresh({revision:state.revision},async()=>{await addMail(f.store,'older',OWN,WORK,now-100000);});
  assert.deepEqual(state.sources,sources);assert.deepEqual(state.suggestions,suggestions);
  assert.equal(state.honcho.status,'ready');assert.equal(net.calls.filter(call=>call.path.endsWith('/chat')).length,chats);
  assert.equal(f.store.hasMessage(OWN,'older'),true);
 }finally{net.restore();f.db.close();}
});

test('owner lens resumes an unfinished projection after cleanup without collecting another batch',async()=>{
 const f=fixture(true),net=honchoNetwork();let collected=0;
 try{
  await enabled(f.store);const now=Date.now();
  for(let i=0;i<30;i++)await addMail(f.store,'baseline'+i,OWN,WORK,now-10000-i);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});
  const collect=async()=>{collected++;await addMail(f.store,'replacement'+collected,OWN,WORK,now-1000+collected);};
  state=await f.store.refresh({revision:state.revision},collect);
  assert.equal(collected,1);assert.equal(state.honcho.cleanupPending,true);const batch=state.sources;
  await f.store.retryCleanup(Date.now()+10000);state=f.store.get();assert.equal(state.honcho.cleanupPending,false);
  const reloaded=(f.service as any).ownerLens() as OwnerLensStore;
  state=await reloaded.refresh({revision:state.revision},collect);
  assert.equal(collected,1);assert.equal(state.honcho.status,'ready');assert.equal(state.suggestions.length,1);assert.deepEqual(state.sources,batch);
  state=await reloaded.refresh({revision:state.revision},collect);assert.equal(collected,2);
  assert.ok(!('projectionRequested' in state));
 }finally{net.restore();f.db.close();}
});

test('owner lens retries a legacy invalid projection before collecting and resumes collection after success',async()=>{
 const f=fixture(true),net=honchoNetwork();let chats=0,collected=0;
 try{
  const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{
   const response=await network(input,init);
   if(new URL(String(input)).pathname.endsWith('/chat')&&++chats===1)return Response.json({content:'Not valid projection JSON'});
   return response;
  };
  await enabled(f.store);
  const collect=async()=>{collected++;await addMail(f.store,'batch'+collected);};
  let state=await f.store.refresh({revision:f.store.get().revision},collect);
  assert.equal(state.honcho.status,'invalid');assert.equal(collected,1);const batch=state.sources;
  const stored=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);
  assert.ok(stored.pendingSnapshot);delete stored.projectionRequested;
  f.db.prepare('UPDATE owner_lens_state SET data=? WHERE id=1').run(JSON.stringify(stored));
  state=await f.store.refresh({revision:state.revision},collect);
  assert.equal(state.honcho.status,'ready');assert.equal(collected,1);assert.deepEqual(state.sources,batch);
  state=await f.store.refresh({revision:state.revision},collect);assert.equal(collected,2);assert.equal(state.sources.length,2);
  assert.equal(state.fields.focus,'');assert.ok(!('projectionRequested' in state));
 }finally{net.restore();f.db.close();}
});

test('owner lens unfinished projection still accepts an explicit note and clears on master disable',async()=>{
 const f=fixture(true),net=honchoNetwork();let collected=0;
 try{
  const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{const response=await network(input,init);return new URL(String(input)).pathname.endsWith('/chat')?Response.json({content:'Not valid projection JSON'}):response;};
  await enabled(f.store);const collect=async()=>{collected++;await addMail(f.store,'batch'+collected);};
  let state=await f.store.refresh({revision:f.store.get().revision},collect);
  state=await f.store.refresh({revision:state.revision,note:WORK},collect);
  assert.equal(collected,1);assert.equal(state.sources.length,2);assert.ok(state.sources.some(source=>source.label==='Your note'));assert.equal(state.fields.focus,'');
  state=await f.store.setEnabled({revision:state.revision,enabled:false});
  assert.equal(JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string).projectionRequested,false);
  assert.deepEqual(state.sources,[]);assert.ok(!('projectionRequested' in state));
 }finally{net.restore();f.db.close();}
});

test('owner lens keeps collecting without Honcho credentials and projects that batch when configured',async()=>{
 const f=fixture(),net=honchoNetwork();let collected=0;
 try{
  await enabled(f.store);const collect=async()=>{collected++;await addMail(f.store,'batch'+collected);};
  let state=await f.store.refresh({revision:f.store.get().revision},collect);
  state=await f.store.refresh({revision:state.revision},collect);
  assert.equal(state.honcho.status,'unconfigured');assert.equal(collected,2);assert.equal(state.sources.length,2);assert.equal(net.calls.length,0);
  f.env.HONCHO_API_KEY='test-honcho-key';state=await f.store.refresh({revision:state.revision},collect);
  assert.equal(state.honcho.status,'ready');assert.equal(collected,2);assert.equal(state.sources.length,2);
  state=await f.store.refresh({revision:state.revision},collect);assert.equal(collected,3);
 }finally{net.restore();f.db.close();}
});

test('owner lens upgrades successful projections using the same evidence and preserves saved fields',async()=>{
 for(const accept of [false,true]){
  const f=fixture(true),net=honchoNetwork();let collected=0,chats=0;
  try{
   const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{
    const response=await network(input,init);
    if(!new URL(String(input)).pathname.endsWith('/chat')||++chats===1)return response;
    const body=await response.json() as any,projection=JSON.parse(body.content);projection.entries[0].text='I build research tools for climate scientists.';
    return Response.json({...body,content:JSON.stringify(projection)});
   };
   let state=await enabled(f.store);state=f.store.update({revision:state.revision,fields:{focus:'My manually saved focus',needs:'',offers:''}});
   const collect=async()=>{collected++;await addMail(f.store,'batch'+collected);};
   state=await f.store.refresh({revision:state.revision},collect);
   if(accept)state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},true);
   const stored=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string),fields={...state.fields},accepted=stored.accepted,batch=state.sources;
   if(accept)stored.projectionVersion=1;else delete stored.projectionVersion;
   f.db.prepare('UPDATE owner_lens_state SET data=? WHERE id=1').run(JSON.stringify(stored));
   state=await f.store.refresh({revision:state.revision},collect);
   assert.equal(collected,1);assert.equal(chats,2);assert.deepEqual(state.sources,batch);assert.deepEqual(state.fields,fields);
   assert.equal(state.suggestions[0].text,'I build research tools for climate scientists.');
   assert.equal(net.calls.filter(call=>call.path.endsWith('/messages')).length,1);
   const upgraded=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);assert.deepEqual(upgraded.accepted,accepted);assert.ok(upgraded.projectionVersion>1);assert.ok(!('projectionVersion' in state));
   state=await f.store.refresh({revision:state.revision},collect);assert.equal(collected,2);
  }finally{net.restore();f.db.close();}
 }
});

test('owner lens missing credentials cannot claim deletion of previously uploaded evidence',async()=>{
 const f=fixture(true),net=honchoNetwork();try{
  await enabled(f.store);await addMail(f.store);let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(state.honcho.status,'ready');
  f.env.HONCHO_API_KEY=undefined;state=await f.store.setEnabled({revision:state.revision,enabled:false});
  assert.deepEqual(state.sources,[]);assert.equal(state.honcho.configured,false);assert.equal(state.honcho.status,'unavailable');
  const internal=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);assert.ok(internal.pendingDelete);assert.equal(internal.remotePossible,true);
 }finally{net.restore();f.db.close();}
});

test('owner lens retries asynchronous remote cleanup through the DO alarm while learning remains off',async()=>{
 const f=fixture(true),net=honchoNetwork(),originalNow=Date.now,originalInfo=console.info,logs:string[]=[];let clock=originalNow(),confirm=false,cleanupCalls=0;
 try{
  Date.now=()=>clock;await enabled(f.store);await addMail(f.store);await f.store.refresh({revision:f.store.get().revision},async()=>{});
  console.info=(value:unknown)=>{logs.push(String(value));};
  const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{
   const url=new URL(String(input));if(url.pathname==='/v3/workspaces/list'){cleanupCalls++;const request=JSON.parse(init.body);return Response.json({items:confirm?[]:[{id:request.filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:confirm?0:1});}
   if(url.pathname.endsWith('/sessions/list'))return Response.json({items:[],total:0});
   if(init?.method==='DELETE')return new Response(null,{status:202});return network(input,init);
  };
  let state=await f.service.setOwnerLensEnabled({revision:(await f.service.getOwnerLens()).revision,enabled:false});
  assert.equal(state.honcho.cleanupPending,true);assert.equal(state.honcho.retryAt,new Date(clock+5000).toISOString());assert.equal(f.kv.get('alarm'),clock+5000);
  await f.service.alarm();assert.equal(cleanupCalls,1);confirm=true;clock+=5001;const chats=net.calls.filter(c=>c.path.endsWith('/chat')).length;
  await f.service.alarm();state=await f.service.getOwnerLens();assert.equal(cleanupCalls,2);assert.equal(state.enabled,false);assert.equal(state.honcho.cleanupPending,false);assert.equal(state.honcho.status,'disabled');assert.equal(net.calls.filter(c=>c.path.endsWith('/chat')).length,chats);
  assert.deepEqual(logs.map(line=>JSON.parse(line)).filter(event=>event.event==='owner_lens_cleanup'),[
   {event:'owner_lens_cleanup',status:'deleting',attempt:1,nextDelayMs:5000,complete:false},
   {event:'owner_lens_cleanup',status:'deleted',attempt:2,nextDelayMs:0,complete:true},
  ]);
 }finally{console.info=originalInfo;Date.now=originalNow;net.restore();f.db.close();}
});

test('owner lens cleanup failures use durable exponential backoff capped at one hour',async()=>{
 const f=fixture(true),net=honchoNetwork({deleteFailure:true}),originalNow=Date.now;let clock=originalNow();
 try{
  Date.now=()=>clock;await enabled(f.store);await addMail(f.store);await f.store.refresh({revision:f.store.get().revision},async()=>{});
  let state=await f.service.setOwnerLensEnabled({revision:(await f.service.getOwnerLens()).revision,enabled:false});let previous=0;
  for(let i=0;i<13;i++){
   const delay=Date.parse(state.honcho.retryAt!)-clock;assert.ok(delay>=previous);assert.ok(delay<=3600000);assert.ok(delay>=5000);previous=delay;
   clock+=delay;await f.service.alarm();state=await f.service.getOwnerLens();assert.equal(state.enabled,false);assert.equal(state.honcho.cleanupPending,true);
  }
  assert.equal(previous,3600000);
 }finally{Date.now=originalNow;net.restore();f.db.close();}
});

test('owner lens recovers an interrupted marked upload only after confirmed deletion and preserves manual edits',async()=>{
 const f=fixture(true),net=honchoNetwork(),originalNow=Date.now;let clock=originalNow(),interrupted=false,confirmed=false,batches=0,deletions=0;
 try{
  Date.now=()=>clock;await enabled(f.store);await addMail(f.store);
  const network=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{
   const path=new URL(String(input)).pathname;
   if(path.endsWith('/messages'))batches++;
   if(path==='/v3/workspaces/list'){const request=JSON.parse(init.body);if(confirmed)net.clear();return Response.json({items:confirmed?[]:[{id:request.filters.id,metadata:{purpose:'private-owner-lens-v1'}}],total:confirmed?0:1});}
   if(path.endsWith('/sessions/list')){deletions++;if(confirmed){net.clear();return new Response(null,{status:404});}return Response.json({items:[],total:0});}
   if(init?.method==='DELETE')return new Response(null,{status:202});
   const response=await network(input,init);
   if(init?.method==='PUT'&&!interrupted){interrupted=true;f.store.update({revision:f.store.get().revision,fields:{focus:'A manual priority',needs:'',offers:''}});}
   return response;
  };
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(batches,0);assert.equal(state.fields.focus,'A manual priority');
  state=await f.store.refresh({revision:state.revision},async()=>{});assert.equal(state.honcho.status,'pending');assert.equal(state.honcho.cleanupPending,false);assert.equal(batches,0);
  clock+=60001;state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.cleanupPending,true);assert.equal(batches,0);
  await f.service.alarm();assert.equal(deletions,1);assert.equal(batches,0);state=await f.service.getOwnerLens();assert.equal(state.honcho.cleanupPending,true);
  confirmed=true;clock=Date.parse(state.honcho.retryAt!)+1;await f.service.alarm();state=await f.service.getOwnerLens();assert.equal(state.honcho.cleanupPending,false);assert.equal(batches,0);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'ready');assert.equal(batches,1);assert.equal(state.fields.focus,'A manual priority');assert.equal(state.suggestions.length,1);
 }finally{Date.now=originalNow;net.restore();f.db.close();}
});

test('owner lens background budget counts eligible sent attempts after incoming mail, including empty and failed attempts',async()=>{
 const f=fixture(true),original=globalThis.fetch,fullIds:string[]=[];
 try{
  await f.service.setOwnerLensEnabled({revision:(await f.service.getOwnerLens()).revision,enabled:true});
  const ids=[...Array.from({length:4},(_,i)=>'incoming'+i),...Array.from({length:6},(_,i)=>'sent'+i)];
  f.ai.run=async(_model,input)=>{f.ai.calls.push(input);return JSON.stringify(input).includes('no selected work')?{response:{facts:[]}}:facts;};
  globalThis.fetch=async(input:any)=>{
   const url=new URL(String(input));assert.ok(!url.hostname.includes('honcho'));
   if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access'});
   if(url.pathname.endsWith('/messages'))return Response.json({messages:ids.map(id=>({id}))});
   const id=url.pathname.split('/').at(-1)!;
   if(url.searchParams.get('format')==='full'){
    fullIds.push(id);if(id==='sent0')return new Response(null,{status:404});if(id==='sent2')return new Response(null,{status:503});
   }
   return Response.json(message(id,id.startsWith('sent')?OWN:'friend@example.com',id==='sent1'?'I have no selected work to share in this message.':WORK));
  };
  await f.service.attachAccount(OWN,'refresh-token','recent');await f.service.alarm();
  assert.deepEqual(fullIds,['sent0','sent1','sent2','sent3']);
  const state=await f.service.getOwnerLens();assert.equal(state.sources.length,1);assert.equal(state.sources[0].text,WORK);
  const processed=f.db.prepare('SELECT message FROM owner_lens_messages ORDER BY message').all().map(r=>r.message);
  assert.deepEqual(processed,['sent0','sent1','sent3']);assert.equal(f.service.list()[0].status,'connected');
 }finally{globalThis.fetch=original;f.db.close();}
});

test('owner lens diagnostics whitelist codes and never emit arbitrary exception messages',()=>{
 const original=console.warn,lines:string[]=[];console.warn=(value:unknown)=>{lines.push(String(value));};
 try{
  ownerLensDiagnostic('token-unseal',Error('Secret grant or email me@example.com must never be logged'),{elapsedMs:12,selected:4,attempted:1});
  ownerLensDiagnostic('mail-extraction',Error('invalid_extraction'),{elapsedMs:20,httpStatus:200});
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[
   {event:'owner_lens_failure',stage:'token-unseal',code:'unknown',elapsedMs:12,selected:4,attempted:1},
   {event:'owner_lens_failure',stage:'mail-extraction',code:'invalid_extraction',elapsedMs:20,httpStatus:200},
  ]);
  assert.ok(!lines.join('').includes('me@example.com'));assert.ok(!lines.join('').includes('Secret'));
 }finally{console.warn=original;}
});

test('owner lens collection diagnostics distinguish read, decode, extraction, and storage without private content',async()=>{
 const originalFetch=globalThis.fetch,originalWarn=console.warn;
 for(const failure of ['read','decode','extraction','store'] as const){
  const f=fixture(true),lines:string[]=[];console.warn=(value:unknown)=>{lines.push(String(value));};
  try{
   await account(f);indexed(f,'private-message-id');await enabled(f.store);
   if(failure==='extraction')f.ai.run=async()=>({response:{facts:'private-invalid-model-output'}} as any);
   if(failure==='store')f.db.exec("CREATE TRIGGER fail_owner_lens_store BEFORE INSERT ON owner_lens_messages BEGIN SELECT RAISE(ABORT, 'private-storage-details'); END");
   globalThis.fetch=async(input:any)=>{
    if(String(input).includes('oauth2'))return Response.json({access_token:'private-access-token'});
    if(failure==='read')return new Response('private-provider-error-body',{status:503});
    const raw=message('private-message-id');if(failure==='decode')raw.payload.body.data='not valid base64!';return Response.json(raw);
   };
   const state=await f.service.refreshOwnerLens({revision:(await f.service.getOwnerLens()).revision});assert.equal(state.honcho.status,'unavailable');
   const events=lines.map(line=>JSON.parse(line)),stage=failure==='read'?'gmail-read':failure==='store'?'source-store':'mail-extraction';
   assert.ok(events.some(event=>event.event==='owner_lens_failure'&&event.stage===stage));
   if(failure==='extraction')assert.ok(events.some(event=>event.code==='invalid_extraction'));
   if(failure==='decode')assert.ok(events.some(event=>event.code==='retrieval_failed'));
   assert.ok(events.some(event=>event.stage==='collection'&&event.selected===1&&event.attempted===1));
   for(const forbidden of ['private-message-id','private-access-token','private-provider-error-body','private-invalid-model-output','private-storage-details',OWN,WORK])assert.ok(!lines.join('').includes(forbidden));
   for(const event of events.filter(event=>event.event==='owner_lens_failure'))assert.ok(Object.keys(event).every(key=>['event','stage','code','elapsedMs','selected','attempted','sources','httpStatus'].includes(key)));
  }finally{globalThis.fetch=originalFetch;console.warn=originalWarn;f.db.close();}
 }
});

test('owner lens isolates invalid extraction, respects the four-message budget, and advances past deferred mail',async()=>{
 const f=fixture(true),net=honchoNetwork(),provider=globalThis.fetch,readIds:string[]=[];
 try{
  await account(f);await enabled(f.store);indexed(f,'bad',1,Date.now()-1000);
  for(let i=0;i<4;i++)indexed(f,'good'+i,1,Date.now()-2000-i);
  f.ai.run=async(_model,input)=>JSON.stringify(input).includes('bad extraction marker')?{response:{facts:'invalid'}} as any:facts;
  globalThis.fetch=async(input:any,init:any)=>{
   const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access'});
   if(url.hostname==='gmail.googleapis.com'){const id=url.pathname.split('/').at(-1)!;readIds.push(id);return Response.json(message(id,OWN,id==='bad'?'I am building a bad extraction marker that the test model cannot process.':WORK));}
   return provider(input,init);
  };
  let state=await f.service.refreshOwnerLens({revision:(await f.service.getOwnerLens()).revision});
  assert.deepEqual(readIds,['bad','good0','good1','good2']);assert.equal(state.honcho.status,'ready');assert.equal(state.sources.length,3);assert.equal(state.suggestions.length,1);
  assert.equal(f.store.hasMessage(OWN,'bad'),false);assert.equal(f.db.prepare('SELECT attempts FROM owner_lens_retries WHERE message=?').get('bad')!.attempts,1);
  state=await f.service.refreshOwnerLens({revision:state.revision});
  assert.deepEqual(readIds,['bad','good0','good1','good2','good3']);assert.equal(state.honcho.status,'ready');assert.equal(state.sources.length,4);
 }finally{net.restore();f.db.close();}
});

test('owner lens empty failed collections stay unavailable while extraction retries back off and later recover',async()=>{
 const f=fixture(true),net=honchoNetwork(),provider=globalThis.fetch,originalNow=Date.now;let clock=originalNow(),reads=0,repaired=false;
 try{
  Date.now=()=>clock;await account(f);await enabled(f.store);indexed(f,'bad');
  f.ai.run=async()=>repaired?facts:{response:{facts:'invalid'}} as any;
  globalThis.fetch=async(input:any,init:any)=>{
   const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access'});
   if(url.hostname==='gmail.googleapis.com'){reads++;return Response.json(message('bad'));}return provider(input,init);
  };
  let state=await f.service.refreshOwnerLens({revision:(await f.service.getOwnerLens()).revision});
  assert.equal(state.honcho.status,'unavailable');assert.equal(reads,1);assert.deepEqual(state.sources,[]);assert.equal(f.store.hasMessage(OWN,'bad'),false);
  let retry=f.db.prepare('SELECT attempts,next_attempt FROM owner_lens_retries').get()!;assert.equal(retry.attempts,1);assert.equal(retry.next_attempt,clock+60000);
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'unavailable');assert.equal(reads,1);
  clock=Number(retry.next_attempt);state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'unavailable');assert.equal(reads,2);
  retry=f.db.prepare('SELECT attempts,next_attempt FROM owner_lens_retries').get()!;assert.equal(retry.attempts,2);assert.equal(retry.next_attempt,clock+120000);
  repaired=true;clock=Number(retry.next_attempt);state=await f.service.refreshOwnerLens({revision:state.revision});
  assert.equal(reads,3);assert.equal(state.honcho.status,'ready');assert.equal(state.sources.length,1);assert.equal(f.store.hasMessage(OWN,'bad'),true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_retries').get()!.n,0);
 }finally{Date.now=originalNow;net.restore();f.db.close();}
});

test('owner lens uses an existing valid snapshot despite a new invalid extraction',async()=>{
 const f=fixture(true),net=honchoNetwork(),provider=globalThis.fetch;
 try{
  await account(f);await enabled(f.store);await addMail(f.store);
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});const sources=state.sources,chats=net.calls.filter(call=>call.path.endsWith('/chat')).length;
  indexed(f,'bad');f.ai.run=async()=>({response:{facts:'invalid'}} as any);
  globalThis.fetch=async(input:any,init:any)=>{
   const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access'});
   if(url.hostname==='gmail.googleapis.com')return Response.json(message('bad'));return provider(input,init);
  };
  state=await f.service.refreshOwnerLens({revision:state.revision});assert.equal(state.honcho.status,'ready');assert.deepEqual(state.sources,sources);assert.equal(state.suggestions.length,1);
  assert.equal(net.calls.filter(call=>call.path.endsWith('/chat')).length,chats);assert.equal(f.store.hasMessage(OWN,'bad'),false);
 }finally{net.restore();f.db.close();}
});

test('owner lens retry metadata expires and clears with account withdrawal or disabling learning',async()=>{
 const f=fixture();try{
  await enabled(f.store);const valid=f.store.guard();
  f.store.deferExtraction(OWN,'one',Date.now()-1000,valid);f.store.deferExtraction('second@example.com','two',Date.now()-1000,valid);
  await f.store.removeAccount(OWN);assert.deepEqual(f.db.prepare('SELECT message FROM owner_lens_retries').all().map(row=>row.message),['two']);
  await f.store.setEnabled({revision:f.store.get().revision,enabled:false});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_retries').get()!.n,0);
  await enabled(f.store);f.store.deferExtraction(OWN,'expired',Date.now()-OWNER_LENS_WINDOW-1,f.store.guard());f.store.get();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM owner_lens_retries').get()!.n,0);
 }finally{f.db.close();}
});

test('owner lens due retries cannot starve older mail that has not yet been attempted',async()=>{
 const f=fixture(true),net=honchoNetwork(),provider=globalThis.fetch,originalNow=Date.now,readIds:string[]=[];let clock=originalNow();
 try{
  Date.now=()=>clock;await account(f);await enabled(f.store);
  for(let i=0;i<4;i++){indexed(f,'bad'+i,1,clock-1000-i);indexed(f,'good'+i,1,clock-2000-i);}
  f.ai.run=async(_model,input)=>JSON.stringify(input).includes('bad extraction marker')?{response:{facts:'invalid'}} as any:facts;
  globalThis.fetch=async(input:any,init:any)=>{
   const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access'});
   if(url.hostname==='gmail.googleapis.com'){const id=url.pathname.split('/').at(-1)!;readIds.push(id);return Response.json(message(id,OWN,id.startsWith('bad')?'I am building a bad extraction marker that the test model cannot process.':WORK));}return provider(input,init);
  };
  let state=await f.service.refreshOwnerLens({revision:(await f.service.getOwnerLens()).revision});assert.equal(state.honcho.status,'unavailable');assert.deepEqual(readIds,['bad0','bad1','bad2','bad3']);
  clock+=86400000;state=await f.service.refreshOwnerLens({revision:state.revision});
  assert.deepEqual(readIds.slice(4),['good0','good1','good2','good3']);assert.equal(state.honcho.status,'ready');assert.equal(state.sources.length,4);
 }finally{Date.now=originalNow;net.restore();f.db.close();}
});

test('owner lens Granola opt-in defaults off for new and legacy state and stores only private selected passages',async()=>{
 const f=fixture();try{
  assert.equal(f.store.get().granolaEnabled,false);
  const legacy=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);delete legacy.granolaEnabled;f.db.prepare('UPDATE owner_lens_state SET data=?').run(JSON.stringify(legacy));assert.equal(f.store.get().granolaEnabled,false);
  await assert.rejects(f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true}),/owner_lens_disabled/);
  await enabled(f.store);await f.store.recordGranola(granolaNote(),f.store.guard());assert.deepEqual(f.store.get().sources,[]);assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);
  const prior=f.store.get();let state=await f.store.setGranolaEnabled({revision:prior.revision,enabled:true});await assert.rejects(f.store.setGranolaEnabled({revision:prior.revision,enabled:false}),/owner_lens_conflict/);
  await f.store.recordGranola(granolaNote(),f.store.guard());state=f.store.get();assert.equal(state.sources.length,1);assert.equal(state.sources[0].label,'Your Granola meeting');assert.equal(state.sources[0].title,'Research meeting');assert.equal(state.sources[0].url,'https://notes.granola.ai/d/meeting');assert.equal(state.sources[0].text,WORK);
  assert.ok(!('account' in state.sources[0]));assert.ok(!('message' in state.sources[0]));assert.ok(!('version' in state.sources[0]));assert.equal(f.store.hasGranolaNote('meeting','version-1'),true);
  await f.store.recordGranola(granolaNote(),f.store.guard());assert.equal(f.store.get().sources.length,1);
  await f.store.recordGranola(granolaNote('empty','empty-v1',[]),f.store.guard());assert.equal(f.store.hasGranolaNote('empty','empty-v1'),true);assert.equal(f.store.get().sources.length,1);
  assert.equal(f.ai.calls.length,0);
 }finally{f.db.close();}
});

test('owner lens disabling Granola withdraws its accepted evidence while preserving mail and manual fields',async()=>{
 const f=fixture(true),net=honchoNetwork();try{
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});await addMail(f.store);await f.store.recordGranola(granolaNote(),f.store.guard());
  let state=f.store.update({revision:f.store.get().revision,fields:{focus:'',needs:'My manual need',offers:''}});
  state=await f.store.refresh({revision:state.revision},async()=>{});assert.equal(state.suggestions[0].sourceIds[0],state.sources.find(source=>source.label==='Your Granola meeting')!.id);
  state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},true);assert.ok(state.fields.focus);
  state=await f.store.setGranolaEnabled({revision:state.revision,enabled:false});assert.equal(state.granolaEnabled,false);assert.equal(state.enabled,true);assert.equal(state.fields.focus,'');assert.equal(state.fields.needs,'My manual need');assert.equal(state.sources.length,1);assert.equal(state.sources[0].label,'Your sent email');assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);assert.ok(net.calls.some(call=>call.method==='DELETE'));
 }finally{net.restore();f.db.close();}
});

test('owner lens reconciles changed and removed Granola versions without invalidating unchanged reads',async()=>{
 const f=fixture();try{
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});await addMail(f.store);await f.store.recordGranola(granolaNote(),f.store.guard());await f.store.recordGranola(granolaNote('empty','empty-v1',[]),f.store.guard());
  const oldRevision=f.store.get().revision,valid=f.store.guard();await f.store.reconcileGranola(new Map([['meeting','version-1'],['empty','empty-v1']]));assert.equal(f.store.get().revision,oldRevision);assert.equal(valid(),true);
  await f.store.reconcileGranola(new Map([['meeting','version-2']]));assert.equal(valid(),false);assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);assert.equal(f.store.hasGranolaNote('empty','empty-v1'),false);assert.equal(f.store.get().sources.length,1);assert.equal(f.store.get().sources[0].label,'Your sent email');assert.equal(f.store.get().honcho.cleanupPending,true);
  await f.store.recordGranola(granolaNote('meeting','version-2'),f.store.guard());assert.equal(f.store.hasGranolaNote('meeting','version-2'),true);assert.equal(f.store.get().sources.length,2);
  await f.store.reconcileGranola(new Map());assert.equal(f.store.get().sources.length,1);assert.equal(f.store.hasGranolaNote('meeting','version-2'),false);
 }finally{f.db.close();}
});

test('owner lens late Granola writes cannot restore disabled or revoked meeting evidence',async()=>{
 for(const action of ['granola-off','master-off','revoke'] as const){
  const f=fixture();try{
   await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});
   const write=f.store.recordGranola(granolaNote(),f.store.guard());
   if(action==='granola-off')await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:false});
   else if(action==='master-off')await f.store.setEnabled({revision:f.store.get().revision,enabled:false});
   else await f.store.reconcileGranola(new Map(),true);
   await write;assert.deepEqual(f.store.get().sources,[]);assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);
   if(action==='master-off'){assert.equal(f.store.get().enabled,false);assert.equal(f.store.get().granolaEnabled,false);}
  }finally{f.db.close();}
 }
});

test('owner lens Granola expiry clears private success markers and source evidence',async()=>{
 const f=fixture(),originalNow=Date.now;let clock=originalNow();try{
  Date.now=()=>clock;await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});await f.store.recordGranola(granolaNote(),f.store.guard());
  clock+=OWNER_LENS_WINDOW+1000;assert.deepEqual(f.store.get().sources,[]);assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);
 }finally{Date.now=originalNow;f.db.close();}
});

test('owner lens Granola passage bounds preserve exact text and sanitize citation links',async()=>{
 const f=fixture();try{
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});
  await assert.rejects(f.store.recordGranola(granolaNote('too-many','v1',Array(9).fill(WORK)),f.store.guard()),/invalid_owner_lens/);
  await assert.rejects(f.store.recordGranola(granolaNote('too-long','v1',['x'.repeat(2001)]),f.store.guard()),/invalid_owner_lens/);
  const input={...granolaNote('bounded','v1',Array(8).fill(' '+WORK+' ')),url:'javascript:alert(1)',title:'x'.repeat(350)};
  await f.store.recordGranola(input,f.store.guard());const first=f.store.get().sources;assert.equal(first.length,8);assert.ok(first.every(source=>source.text===' '+WORK+' '&&source.url===null&&source.title?.length===300));
  await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:false});await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});await f.store.recordGranola(input,f.store.guard());assert.deepEqual(f.store.get().sources.map(source=>source.id),first.map(source=>source.id));
 }finally{f.db.close();}
});

test('owner lens late provider response cannot restore Granola evidence after its opt-in is withdrawn',async()=>{
 const f=fixture(true);let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve),net=honchoNetwork({chat:async()=>{entered();await held;}});
 try{
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});await addMail(f.store);await f.store.recordGranola(granolaNote(),f.store.guard());
  const running=f.store.refresh({revision:f.store.get().revision},async()=>{});await ready;
  const disabled=f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:false});assert.equal(f.store.get().granolaEnabled,false);release();await running;await disabled;
  assert.deepEqual(f.store.get().suggestions,[]);assert.equal(f.store.get().sources.length,1);assert.equal(f.store.get().sources[0].label,'Your sent email');assert.equal(f.store.hasGranolaNote('meeting','version-1'),false);
 }finally{release?.();net.restore();f.db.close();}
});

test('owner lens separates attributed Granola statements from attended-meeting evidence without exposing meeting IDs',async()=>{
 const f=fixture();try{
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});
  await f.store.recordGranola({...granolaNote(),meetingPassages:[WORK]},f.store.guard());const state=f.store.get();assert.equal(state.sources.length,2);assert.notEqual(state.sources[0].id,state.sources[1].id);
  assert.deepEqual(state.sources.map(source=>source.attribution).sort(),['meeting','statement']);assert.equal(state.sources.find(source=>source.attribution==='meeting')!.label,'Meeting you attended');assert.ok(state.sources.every(source=>!('meetingId' in source)));
  const internal=JSON.parse(f.db.prepare('SELECT data FROM owner_lens_state').get()!.data as string);assert.equal(internal.sources.find((source:any)=>source.attribution==='meeting').meetingId,'meeting');
  await assert.rejects(f.store.recordGranola({...granolaNote('too-many'),meetingPassages:Array(4).fill(WORK)},f.store.guard()),/invalid_owner_lens/);
  await assert.rejects(f.store.recordGranola({...granolaNote('too-long'),meetingPassages:['x'.repeat(1201)]},f.store.guard()),/invalid_owner_lens/);
 }finally{f.db.close();}
});

test('owner lens sends attended-meeting attribution to Honcho and withdraws accepted conversation focus when a meeting disappears',async()=>{
 const f=fixture(true),net=honchoNetwork(),network=globalThis.fetch;try{
  globalThis.fetch=async(input:any,init:any)=>{const response=await network(input,init);if(!String(input).endsWith('/chat'))return response;
   const messages=net.calls.filter(call=>call.path.endsWith('/messages')).at(-1)!.body.messages;
   return Response.json({content:JSON.stringify({entries:[{kind:'focus',text:'Exploring conversations about climate research tools',sources:messages.map((message:any)=>{const content=JSON.parse(message.content);return {sourceId:content.sourceId,quote:content.text};})}]})});
  };
  await enabled(f.store);await f.store.setGranolaEnabled({revision:f.store.get().revision,enabled:true});
  for(const id of ['private-meeting-alpha','private-meeting-beta'])await f.store.recordGranola({...granolaNote(id,'v2',[]),meetingPassages:['The meeting discussed climate research tools and experimental comparisons.']},f.store.guard());
  let state=await f.store.refresh({revision:f.store.get().revision},async()=>{});assert.equal(state.honcho.status,'ready');assert.equal(state.suggestions.length,1);assert.equal(state.fields.focus,'');
  const messages=net.calls.find(call=>call.path.endsWith('/messages'))!.body.messages;assert.ok(messages.every((message:any)=>JSON.parse(message.content).attribution==='OWNER_MEETING_ACTIVITY'));assert.ok(!JSON.stringify(net.calls).includes('private-meeting-alpha'));
  state=f.store.decide({revision:state.revision,id:state.suggestions[0].id},true);assert.match(state.fields.focus,/^Exploring conversations/);
  await f.store.reconcileGranola(new Map([['private-meeting-beta','v2']]));state=f.store.get();assert.equal(state.fields.focus,'');assert.equal(state.sources.length,1);assert.deepEqual(state.suggestions,[]);assert.equal(state.honcho.cleanupPending,true);
 }finally{net.restore();f.db.close();}
});
