import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {GranolaSync} from '../src/granola-sync';
import {RelevanceStore} from '../src/relevance-store';
import {unseal,opaque} from '../src/mail-model';
import {FakeAI} from './worker-stub';
import {defaultAnswer,noulA,choiceA} from './granola-jev-extractor.test';

export function granolaFixture(opts:{maxNotes?:number}={}){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>(),statements:string[]=[];
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){statements.push(sql);if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const env={MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_ID:'client-id',TOKEN_SECRET:'identity-key'} as any;
 kv.set('owner','owner@example.test');
 const store=new RelevanceStore(ctx as any,()=>ctx.storage.get('owner') as Promise<string|undefined>);
 let invalidations=0;
 const gmail:{email:string;name:string;subjects:string[]}[]=[];
 const sync=new GranolaSync(ctx as any,env,{owner:()=>ctx.storage.get('owner') as Promise<string|undefined>,store:()=>store,invalidateGraph:async()=>{invalidations++;},contacts:()=>gmail},opts.maxNotes);
 return {sync,db,kv,env,store,statements,gmail,invalidations:()=>invalidations};
}
export async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}
const KEY='grn_fictional_key_123456';
const foldersResponse=()=>Response.json({folders:[{id:'fol_1234567890abcd',name:'Pilot',parent_folder_id:null},{id:'fol_2234567890abcd',name:'Personal',parent_folder_id:null}],hasMore:false,cursor:null});

test('connect seals the key, stores range and folders, and reports syncing',async()=>{
 const f=granolaFixture();const urls:string[]=[];
 const status=await withFetch((async(input:any,init:any)=>{urls.push(String(input));assert.equal(init.headers.authorization,'Bearer '+KEY);return foldersResponse();}) as typeof fetch,()=>f.sync.connect(KEY,'recent'));
 assert.equal(status.connected,true);assert.equal(status.status,'syncing');assert.equal(status.range,'recent');
 assert.deepEqual(status.folders.map(x=>[x.name,x.excluded]),[['Personal',false],['Pilot',false]]);
 const row=f.db.prepare('SELECT grant FROM granola_connection').get() as any;
 assert.notEqual(row.grant,KEY);assert.equal(await unseal(row.grant,'encrypt-key'),KEY);
 assert.ok(!JSON.stringify(status).includes(KEY));
 assert.ok(urls[0].startsWith('https://public-api.granola.ai/v1/folders'));
 assert.equal(typeof f.kv.get('alarm'),'undefined');// alarm scheduling is MailSync's job (Task 6)
 assert.ok(f.sync.nextDue()!<=Date.now()+2000);
});

test('connect stores nothing when Granola rejects the key',async()=>{
 const f=granolaFixture();
 await withFetch((async()=>new Response('{"error":"nope"}',{status:401})) as typeof fetch,async()=>{
  await assert.rejects(f.sync.connect(KEY,'all'),/unauthorized/);
 });
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_connection').get()!.n,0);
 assert.equal(f.sync.status().connected,false);
});

test('connect requires MAIL_TOKEN_KEY and a valid key shape',async()=>{
 const f=granolaFixture();delete f.env.MAIL_TOKEN_KEY;
 await assert.rejects(f.sync.connect(KEY,'all'),/mail_not_configured/);
 f.env.MAIL_TOKEN_KEY='encrypt-key';
 await assert.rejects(f.sync.connect('not-a-key','all'),/invalid_key/);
});

test('setExcluded flags folders, hides fully-excluded notes and rejects unknown ids',async()=>{
 const f=granolaFixture();
 await withFetch((async()=>foldersResponse()) as typeof fetch,()=>f.sync.connect(KEY,'all'));
 f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES ('not_1234567890abcd','A',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[\"fol_1234567890abcd\"]','','','','h',0,'done',NULL,'granola-v1',0,0,0)").run();
 f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES ('not_2234567890abcd','B',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[\"fol_1234567890abcd\",\"fol_2234567890abcd\"]','','','','h',0,'done',NULL,'granola-v1',0,0,0)").run();
 const status=await f.sync.setExcluded(['fol_1234567890abcd']);
 assert.deepEqual(status.folders.map(x=>[x.id,x.excluded,x.noteCount]),[['fol_2234567890abcd',false,1],['fol_1234567890abcd',true,2]]);
 assert.equal(f.db.prepare("SELECT hidden FROM granola_notes WHERE id='not_1234567890abcd'").get()!.hidden,1);
 assert.equal(f.db.prepare("SELECT hidden FROM granola_notes WHERE id='not_2234567890abcd'").get()!.hidden,0);
 await assert.rejects(f.sync.setExcluded(['fol_9999999999zzzz']),/invalid_folder/);
 assert.ok(f.invalidations()>=1);
});

test('disconnect wipes key, folders, notes, attendees, edges and granola signals',async()=>{
 const f=granolaFixture();
 await withFetch((async()=>foldersResponse()) as typeof fetch,()=>f.sync.connect(KEY,'all'));
 f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES ('not_1234567890abcd','A',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','[]','','','','h',0,'done',NULL,'granola-v1',0,0,0)").run();
 f.db.prepare("INSERT INTO granola_attendees VALUES ('not_1234567890abcd','ada@example.test','Ada')").run();
 f.db.prepare("INSERT INTO granola_edges VALUES ('not_1234567890abcd','ada@example.test','bob@example.test')").run();
 await f.store.ingest([{id:'sig-1',owner:'owner@example.test',account:'granola',themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:'2026-08-14T11:00:00Z',ingestedAt:'2026-08-15T00:00:00Z',confidence:.8,summary:'Ask: “hi”',evidenceRef:'granola-note:not_1234567890abcd#summary@0',contentHash:'h',extractorVersion:'granola-v1'} as any]);
 await f.sync.disconnect();
 for(const table of ['granola_connection','granola_folders','granola_notes','granola_attendees','granola_edges'])assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0,table);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='granola'").get()!.n,0);
 assert.equal(f.sync.status().connected,false);
});

test('syncNow brings nextSync forward only when connected and idle',async()=>{
 const f=granolaFixture();
 assert.equal(f.sync.syncNow().connected,false);
 await withFetch((async()=>foldersResponse()) as typeof fetch,()=>f.sync.connect(KEY,'all'));
 f.db.prepare("UPDATE granola_connection SET data=json_set(json_set(data,'$.status','connected'),'$.nextSync',?)").run(Date.now()+3600000);
 const status=f.sync.syncNow();assert.ok(status.nextSync<=Date.now());assert.equal(status.status,'connected');
});

const NOTE_A='not_1234567890abcd',NOTE_B='not_2234567890abcd';
function noteRaw(id:string,title:string,folder='fol_1234567890abcd',updated='2026-08-15T12:00:00Z'){return {id,object:'note',title,owner:{name:'Me',email:'me@example.test'},created_at:'2026-08-14T12:00:00Z',updated_at:updated,web_url:'https://notes.granola.ai/d/'+id,calendar_event:{scheduled_start_time:'2026-08-14T11:00:00Z'},attendees:[{name:'Me',email:'me@example.test'},{name:'Ada',email:'ada@example.test'},{name:'Bob',email:'bob@example.test'}],folder_membership:folder?[{id:folder,name:'x',parent_folder_id:null}]:[],summary_text:'Ada asked for an intro to a fintech founder.',private_notes_text:'remember to send deck',transcript:null};}
function network(opts:{notes?:any[];transcript?:string;fail?:(url:string)=>Response|null}={}){
 const calls:string[]=[];const notes=opts.notes??[noteRaw(NOTE_A,'Alpha'),noteRaw(NOTE_B,'Beta','fol_2234567890abcd')];
 const fake=(async(input:any)=>{const url=String(input);calls.push(url);const hit=opts.fail?.(url);if(hit)return hit;
  if(url.includes('/v1/folders'))return foldersResponse();
  if(url.includes('/transcript'))return Response.json({transcript:[{speaker:{name:'Ada'},text:opts.transcript??'We should talk next week.',start_time:'2026-08-14T11:00:00Z',end_time:'2026-08-14T11:00:05Z'}],hasMore:false,cursor:null});
  if(/\/v1\/notes\/not_/.test(url)){const id=new URL(url).pathname.split('/')[3];const n=notes.find(x=>x.id===id);return n?Response.json(n):new Response('{}',{status:404});}
  if(url.includes('/v1/notes'))return Response.json({notes:notes.map(n=>({id:n.id,title:n.title,created_at:n.created_at,updated_at:n.updated_at})),hasMore:false,cursor:null});
  return new Response('{}',{status:500});}) as typeof fetch;
 return {fake,calls};
}
function bump(f:ReturnType<typeof granolaFixture>,patch:Record<string,unknown>){const row=f.db.prepare('SELECT data FROM granola_connection').get() as any;f.db.prepare('UPDATE granola_connection SET data=?').run(JSON.stringify({...JSON.parse(row.data),...patch}));}
async function runToIdle(f:ReturnType<typeof granolaFixture>,fake:typeof fetch,max=40){for(let i=0;i<max;i++){await withFetch(fake,()=>f.sync.tick(Date.now()));const s=f.sync.status();if(s.status!=='syncing')return;}throw Error('did not settle');}
function connection(f:ReturnType<typeof granolaFixture>){const row=f.db.prepare('SELECT grant,data FROM granola_connection').get() as any;return row?{grant:row.grant,...JSON.parse(row.data)}:null;}
/** Tick until the persisted job reaches `phase`, so the next tick runs exactly that phase. */
async function tickToPhase(f:ReturnType<typeof granolaFixture>,fake:typeof fetch,phase:string,max=20){
 for(let i=0;i<max;i++){if(connection(f)?.job?.phase===phase)return;await withFetch(fake,()=>f.sync.tick(Date.now()));}
 throw Error('phase '+phase+' not reached');
}
/** Holds the first note-detail fetch open and resolves it on demand, like the Gmail held-fetch test. */
function heldNoteFetch(net:{fake:typeof fetch}){
 let release:(r:Response)=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);
 const fake=(async(input:any,init:any)=>{const url=String(input);
  if(/\/v1\/notes\/not_/.test(url)&&!url.includes('/transcript')){entered();return new Promise<Response>(r=>{release=r;});}
  return net.fake(input,init);}) as typeof fetch;
 return {fake,ready,release:(r:Response)=>release(r)};
}

test('first sync lists all notes, fetches details and transcripts, and stores attendees and edges',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'recent'));
 await runToIdle(f,net.fake);
 const s=f.sync.status();assert.equal(s.status,'connected');assert.equal(s.counts.notes,2);assert.ok(s.nextSync>Date.now()+3_000_000);
 const listUrl=net.calls.find(u=>u.includes('/v1/notes?'))!;assert.ok(new URL(listUrl).searchParams.get('created_after'));
 const row=f.db.prepare('SELECT * FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'pending');assert.equal(row.transcript,'Ada: We should talk next week.');assert.equal(row.meeting_at,'2026-08-14T11:00:00Z');assert.equal(row.web_url,'https://notes.granola.ai/d/'+NOTE_A);
 assert.deepEqual(f.db.prepare('SELECT email FROM granola_attendees WHERE note_id=? ORDER BY email').all(NOTE_A).map((r:any)=>r.email),['ada@example.test','bob@example.test','me@example.test']);
 assert.deepEqual(f.db.prepare('SELECT a,b FROM granola_edges WHERE note_id=? ORDER BY a,b').all(NOTE_A).map((r:any)=>({a:r.a,b:r.b})),[{a:'ada@example.test',b:'bob@example.test'},{a:'ada@example.test',b:'me@example.test'},{a:'bob@example.test',b:'me@example.test'}]);
 const c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 assert.equal(c.watermark,'2026-08-15T12:00:00Z');assert.equal(c.ownerEmail,'me@example.test');
 assert.ok(f.invalidations()>0);
});

test('incremental sync uses updated_after and skips unchanged notes',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 net.calls.length=0;bump(f,{nextSync:0});
 await runToIdle(f,net.fake);
 const listUrl=net.calls.find(u=>u.includes('/v1/notes?'))!;assert.equal(new URL(listUrl).searchParams.get('updated_after'),'2026-08-15T12:00:00Z');assert.equal(new URL(listUrl).searchParams.get('created_after'),null);
 assert.equal(net.calls.filter(u=>/\/v1\/notes\/not_/.test(u)&&!u.includes('transcript')).length,0,'unchanged notes are not refetched');
});

test('notes whose folders are all excluded are stored as skipped without content',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await f.sync.setExcluded(['fol_2234567890abcd']);
 await runToIdle(f,net.fake);
 const b=f.db.prepare('SELECT extraction_status,summary,hidden FROM granola_notes WHERE id=?').get(NOTE_B) as any;
 assert.equal(b.extraction_status,'skipped');assert.equal(b.summary,'');assert.equal(b.hidden,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_attendees WHERE note_id=?').get(NOTE_B)!.n,0);
 assert.equal(net.calls.filter(u=>u.includes(NOTE_B+'/transcript')).length,0);
 await f.sync.setExcluded([]);
 assert.equal((f.db.prepare('SELECT extraction_status FROM granola_notes WHERE id=?').get(NOTE_B) as any).extraction_status,'refetch');
 bump(f,{nextSync:0});await runToIdle(f,net.fake);
 assert.equal((f.db.prepare('SELECT extraction_status FROM granola_notes WHERE id=?').get(NOTE_B) as any).extraction_status,'pending');
});

test('transport and 5xx failures back off, 401 sets reconnect_required, nothing is deleted',async()=>{
 const f=granolaFixture();let mode:'ok'|'boom'|'unauth'='ok';
 const net=network({fail:url=>mode==='boom'&&url.includes('/v1/notes')?new Response('x',{status:503}):mode==='unauth'?new Response('x',{status:401}):null});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 mode='boom';bump(f,{nextSync:0});
 await withFetch(net.fake,()=>f.sync.tick(Date.now()));await withFetch(net.fake,()=>f.sync.tick(Date.now()));
 let c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 assert.equal(c.status,'syncing');assert.ok(c.job.retries>=1);assert.ok(c.job.nextAttempt>Date.now());
 mode='unauth';bump(f,{job:{...c.job,nextAttempt:0}});
 await withFetch(net.fake,()=>f.sync.tick(Date.now()));
 c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 assert.equal(c.status,'reconnect_required');assert.equal(f.sync.nextDue(),undefined);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,2);
});

test('weekly reconcile deletes notes missing upstream and their attendees, edges and signals',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 await f.store.ingest([{id:'sig-b',owner:'owner@example.test',account:'granola',themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:'2026-08-14T11:00:00Z',ingestedAt:'2026-08-15T00:00:00Z',confidence:.8,summary:'Ask: “x”',evidenceRef:`granola-note:${NOTE_B}#summary@0`,contentHash:'h',extractorVersion:'granola-v1'} as any]);
 const only=network({notes:[noteRaw(NOTE_A,'Alpha')]});
 bump(f,{nextSync:0,lastReconcile:0});
 await runToIdle(f,only.fake);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_edges WHERE note_id=?').get(NOTE_B)!.n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE evidence_ref LIKE ?').get(`granola-note:${NOTE_B}%`)!.n,0);
});

test('transcript pages stop at the byte cap and mark the note truncated',async()=>{
 // getGranolaTranscript caps each utterance to 4000 chars, so a page needs many
 // utterances (not one giant one) to approach the 400KB cap within a few pages.
 const f=granolaFixture();const big='x'.repeat(4_000);const net=network();
 let page=0;const perNote:Record<string,number>={};
 const fake=(async(input:any,init:any)=>{const url=String(input);
  if(url.includes('/transcript')){
   page++;const id=new URL(url).pathname.split('/')[3];const n=(perNote[id]=(perNote[id]??0)+1);
   const items=Array.from({length:35},()=>({speaker:{name:'Ada'},text:big,start_time:'2026-08-14T11:00:00Z',end_time:'2026-08-14T11:00:05Z'}));
   return Response.json({transcript:items,hasMore:n<5,cursor:n<5?'c'+n:null});
  }
  return net.fake(input,init);
 }) as typeof fetch;
 await withFetch(fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,fake);
 const row=f.db.prepare('SELECT bytes,summary,private_notes,transcript FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.ok(row.bytes<=400*1024);assert.ok(page<=8);assert.ok(row.transcript.endsWith('[transcript truncated]'));
 // The self-reported "bytes" column may be clamped to the cap; verify the actual stored
 // content (which also carries the truncation marker) stays under the cap too.
 assert.ok(row.summary.length+row.private_notes.length+row.transcript.length<=400*1024);
});

test('note cap counts only new notes, never drops updates or refetches, and never advances the watermark past a dropped note',async()=>{
 const f=granolaFixture({maxNotes:2});
 const OLD='not_9999999990abcd',NOTE_C='not_3234567890abcd';
 f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,0,?,NULL,?,0,0,0)").run(OLD,'Old','2026-08-01T11:00:00Z','scheduled','2026-08-01T12:00:00Z','2026-08-01T12:00:00Z','["fol_1234567890abcd"]','s','p','t','h','done','granola-v1');
 const net=network({notes:[
  noteRaw(OLD,'Old updated','fol_1234567890abcd','2026-08-16T12:00:00Z'),// update to an already-stored note
  noteRaw(NOTE_A,'Alpha','fol_1234567890abcd','2026-08-14T12:00:00Z'),// new note, earlier updated_at — kept (fills the last cap slot)
  noteRaw(NOTE_C,'Gamma','fol_1234567890abcd','2026-08-20T12:00:00Z'),// new note, latest updated_at — dropped by the cap
 ]});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await runToIdle(f,net.fake);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,2);
 assert.equal(f.db.prepare('SELECT title FROM granola_notes WHERE id=?').get(OLD)!.title,'Old updated','update to an existing note is still fetched at the cap');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes WHERE id=?').get(NOTE_C)!.n,0,'new note beyond the cap is dropped');
 const c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 // A cap drop anywhere in the run must block the watermark from advancing at all this
 // run — even from other notes' later updated_at — or a dropped note could end up
 // below the new watermark and never be listed again.
 assert.equal(c.watermark,null);assert.equal(c.error,'note_cap_reached');
});

test('note cap: an always-kept update to an existing note with a newer updated_at must not drag the watermark past a note the cap dropped',async()=>{
 const f=granolaFixture({maxNotes:2});
 const OLD='not_9999999990abcd',NOTE_C='not_3234567890abcd';
 f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,0,?,NULL,?,0,0,0)").run(OLD,'Old','2026-08-01T11:00:00Z','scheduled','2026-08-01T12:00:00Z','2026-08-01T12:00:00Z','["fol_1234567890abcd"]','s','p','t','h','done','granola-v1');
 const net=network({notes:[
  noteRaw(OLD,'Old updated','fol_1234567890abcd','2026-08-25T12:00:00Z'),// update, always kept, and newest of the batch
  noteRaw(NOTE_A,'Alpha','fol_1234567890abcd','2026-08-14T12:00:00Z'),// new note — kept (fills the last cap slot)
  noteRaw(NOTE_C,'Gamma','fol_1234567890abcd','2026-08-20T12:00:00Z'),// new note — dropped by the cap
 ]});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await runToIdle(f,net.fake);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes WHERE id=?').get(NOTE_C)!.n,0,'note beyond the cap is dropped');
 const c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 // Without the fix, OLD's later updated_at (kept, since updates are never dropped)
 // would advance the watermark past NOTE_C, hiding it from every future incremental list.
 assert.equal(c.watermark,null);assert.equal(c.error,'note_cap_reached');
});

test('reconcile deletes nothing when the upstream list returns 401',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 bump(f,{nextSync:0,lastReconcile:0});// forces the next due sync to start with reconcile
 const unauth=network({fail:url=>url.includes('/v1/notes?')?new Response('x',{status:401}):null});
 await runToIdle(f,unauth.fake);
 const c=JSON.parse((f.db.prepare('SELECT data FROM granola_connection').get() as any).data);
 assert.equal(c.status,'reconnect_required');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,2);
});

const MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
function withAI(f:ReturnType<typeof granolaFixture>,response:unknown){const ai=new FakeAI(response);Object.assign(f.env,{AI:ai,THEME_MODEL:MODEL});return ai;}
const goodAI={response:{topics:[{topicId:'business_strategy',confidence:0.7}],statements:[{email:'ada@example.test',kind:'intro',quote:'Ada asked for an intro to a fintech founder.'}]}};

test('extraction ingests topic and statement signals bound to attendee ids and meeting dates',async()=>{
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 assert.equal((f.db.prepare('SELECT extraction_status FROM granola_notes WHERE id=?').get(NOTE_A) as any).extraction_status,'done');
 const signals=f.db.prepare("SELECT * FROM theme_signals WHERE account='granola' ORDER BY evidence_ref").all() as any[];
 const ada=await opaque('owner@example.test','ada@example.test','identity-key');
 const statement=signals.find(s=>s.person_id===ada&&s.evidence_ref===`granola-note:${NOTE_A}#summary@0`)!;
 assert.equal(statement.summary,'Intro: “Ada asked for an intro to a fintech founder.”');assert.equal(statement.source_type,'granola');assert.equal(statement.visibility,'private');assert.equal(statement.observed_at,'2026-08-14T11:00:00Z');assert.equal(statement.confidence,0.8);
 const topic=signals.find(s=>s.evidence_ref===`granola-note:${NOTE_A}#topic@business_strategy`)!;
 assert.equal(topic.person_id,null);assert.equal(topic.summary,'Meeting matched Business strategy');
 // NOTE_A is in the "Pilot" folder, so the statement lands under the folder theme, not the topic theme.
 assert.equal(statement.theme_id,'theme-'+await opaque('owner@example.test','granola-folder:fol_1234567890abcd','identity-key'));
 assert.equal(topic.theme_id,'theme-'+await opaque('owner@example.test','body-topic:business_strategy','identity-key'));
 assert.ok(!JSON.stringify(ai.calls).includes(KEY));
 assert.ok(JSON.stringify(ai.calls[0].input).includes('remember to send deck'));
});

test('ai failures leave the note pending with attempts, and it fails after five',async()=>{
 const f=granolaFixture();withAI(f,new Error('boom'));const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 let row=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'pending');assert.equal(row.extraction_attempts,1);
 for(let i=0;i<4;i++){bump(f,{nextSync:0});await runToIdle(f,net.fake);}
 row=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'failed');assert.equal(row.extraction_attempts,5);
 assert.equal(f.sync.status().counts.failed,2);
});

test('hiding a folder removes its signals and re-including restores them without AI',async()=>{
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const before=ai.calls.length;
 await f.sync.setExcluded(['fol_1234567890abcd']);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE evidence_ref LIKE ?').get(`granola-note:${NOTE_A}%`)!.n,0);
 assert.equal((f.db.prepare('SELECT extraction FROM granola_notes WHERE id=?').get(NOTE_A) as any).extraction!==null,true);
 await f.sync.setExcluded([]);
 assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE evidence_ref LIKE ?').get(`granola-note:${NOTE_A}%`)!.n>=2);
 assert.equal(ai.calls.length,before);
});

test('statements with no topic land in the Meetings theme',async()=>{
 const f=granolaFixture();withAI(f,{response:{topics:[],statements:[{email:'bob@example.test',kind:'commitment',quote:'remember to send deck'}]}});const net=network({notes:[noteRaw(NOTE_A,'Alpha','')]});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const theme=f.db.prepare("SELECT t.canonical_name FROM theme_signals s JOIN themes t ON t.id=s.theme_id WHERE s.account='granola'").get() as any;
 assert.equal(theme.canonical_name,'meetings');
 const sig=f.db.prepare("SELECT summary,confidence FROM theme_signals WHERE account='granola'").get() as any;
 assert.equal(sig.summary,'Commitment: “remember to send deck”');assert.equal(sig.confidence,0.7);
});

test('statements land under a theme named after the note folder, topics keep topic themes',async()=>{
 const f=granolaFixture();withAI(f,{response:{topics:[{topicId:'research',confidence:0.6}],statements:[{email:'ada@example.test',kind:'intro',quote:'Ada asked for an intro to a fintech founder.'}]}});const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const pilot='theme-'+await opaque('owner@example.test','granola-folder:fol_1234567890abcd','identity-key');
 const theme=f.db.prepare('SELECT canonical_name,aliases,description FROM themes WHERE id=?').get(pilot) as any;
 assert.equal(theme.canonical_name,'pilot');assert.deepEqual(JSON.parse(theme.aliases),['Pilot']);
 const statement=f.db.prepare("SELECT theme_id FROM theme_signals WHERE account='granola' AND person_id IS NOT NULL AND evidence_ref LIKE ?").get(`granola-note:${NOTE_A}#%`) as any;
 assert.equal(statement.theme_id,pilot);
 const topic=f.db.prepare("SELECT theme_id FROM theme_signals WHERE evidence_ref=?").get(`granola-note:${NOTE_A}#topic@research`) as any;
 assert.equal(topic.theme_id,'theme-'+await opaque('owner@example.test','body-topic:research','identity-key'));
 assert.equal((f.db.prepare('SELECT extractor_version FROM granola_notes WHERE id=?').get(NOTE_A) as any).extractor_version,'granola-v2');
 const stored=JSON.parse((f.db.prepare('SELECT extraction FROM granola_notes WHERE id=?').get(NOTE_A) as any).extraction);
 assert.deepEqual(stored.returned,{topics:1*stored.calls,statements:1*stored.calls});
});

test('an extractor version bump forces exactly one re-extraction per stale note, then settles',async()=>{
 // Single-note fixture so the "one re-extraction" delta is exactly the per-note call
 // count (GranolaExtractor may issue more than one AI call per note, one per segment),
 // rather than a hardcoded constant.
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 let row=f.db.prepare('SELECT extraction_status,extractor_version,extraction FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'done');assert.equal(row.extractor_version,'granola-v2');assert.ok(row.extraction);
 const perNoteCalls=ai.calls.length;assert.ok(perNoteCalls>0);
 f.db.prepare("UPDATE granola_notes SET extractor_version='granola-v0' WHERE id=?").run(NOTE_A);
 bump(f,{nextSync:0});await runToIdle(f,net.fake);
 row=f.db.prepare('SELECT extraction_status,extractor_version FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'done');assert.equal(row.extractor_version,'granola-v2');
 assert.equal(ai.calls.length,perNoteCalls*2,'exactly one re-extraction cycle for the stale note');
 const afterBump=ai.calls.length;
 bump(f,{nextSync:0});await runToIdle(f,net.fake);
 assert.equal(ai.calls.length,afterBump,'no further AI calls once the note is back on the current version');
});

test('contacts, edges and ownEmails expose meeting-derived graph inputs excluding hidden notes',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 assert.deepEqual(f.sync.ownEmails(),['me@example.test']);
 const contacts=f.sync.contacts();
 assert.deepEqual(contacts.map(c=>[c.email,c.name,c.meetings]).sort(),[['ada@example.test','Ada',2],['bob@example.test','Bob',2],['me@example.test','Me',2]]);
 assert.equal(contacts[0].last,Date.parse('2026-08-14T11:00:00Z'));
 const edges=f.sync.edges();
 assert.deepEqual(edges.find(e=>e.a==='ada@example.test'&&e.b==='bob@example.test'),{a:'ada@example.test',b:'bob@example.test',weight:2,titles:['Alpha','Beta']});
 await f.sync.setExcluded(['fol_2234567890abcd']);
 assert.equal(f.sync.contacts().find(c=>c.email==='ada@example.test')!.meetings,1);
 assert.equal(f.sync.edges().find(e=>e.a==='ada@example.test'&&e.b==='bob@example.test')!.weight,1);
});

test('disconnect during an in-flight note fetch cannot resurrect the key or store the note',async()=>{
 const f=granolaFixture();withAI(f,goodAI);const net=network();const held=heldNoteFetch(net);
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await tickToPhase(f,net.fake,'fetch');
 const running=withFetch(held.fake,()=>f.sync.tick(Date.now()));
 await held.ready;
 await f.sync.disconnect();
 held.release(Response.json(noteRaw(NOTE_A,'Alpha')));
 await running;
 for(const table of ['granola_connection','granola_notes','granola_attendees','granola_edges','granola_folders'])assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0,table);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='granola'").get()!.n,0);
 assert.equal(f.sync.nextDue(),undefined);
 assert.equal(f.sync.status().connected,false);
});

test('a new connect during an in-flight note fetch keeps the new key and range',async()=>{
 const NEW_KEY='grn_fictional_key_654321';
 const f=granolaFixture();withAI(f,goodAI);const net=network();const held=heldNoteFetch(net);
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await tickToPhase(f,net.fake,'fetch');
 const running=withFetch(held.fake,()=>f.sync.tick(Date.now()));
 await held.ready;
 await withFetch(net.fake,()=>f.sync.connect(NEW_KEY,'recent'));
 held.release(Response.json(noteRaw(NOTE_A,'Alpha')));
 await running;
 const c=connection(f)!;
 assert.equal(await unseal(c.grant,'encrypt-key'),NEW_KEY);
 assert.equal(c.range,'recent');assert.equal(c.status,'syncing');assert.equal(c.job.phase,'folders');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,0,'the replaced run stores nothing');
});

test('a disconnect during extraction leaves no orphaned Granola signals',async()=>{
 const f=granolaFixture();const net=network();
 let release:(v:unknown)=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);
 const first=new Promise<unknown>(r=>{release=r;});let aiCalls=0;
 Object.assign(f.env,{THEME_MODEL:MODEL,AI:{async run(){aiCalls++;if(aiCalls===1){entered();return first;}return goodAI;}}});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await tickToPhase(f,net.fake,'extract');
 const running=withFetch(net.fake,()=>f.sync.tick(Date.now()));
 await ready;
 await f.sync.disconnect();
 release(goodAI);
 await running;
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='granola'").get()!.n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM granola_notes').get()!.n,0);
 assert.equal(f.sync.status().connected,false);
});

test('a failed note older than seven days becomes pending again and is re-extracted',async()=>{
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const before=ai.calls.length;
 const stale=f.db.prepare("UPDATE granola_notes SET extraction_status='failed',extraction_attempts=5,extraction=NULL,extraction_attempted_at=? WHERE id=?");
 stale.run(Date.now()-8*86_400_000,NOTE_A);stale.run(Date.now(),NOTE_B);
 bump(f,{nextSync:0});await runToIdle(f,net.fake);
 const a=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(a.extraction_status,'done');assert.equal(a.extraction_attempts,1);
 assert.equal((f.db.prepare('SELECT extraction_status FROM granola_notes WHERE id=?').get(NOTE_B) as any).extraction_status,'failed','a note attempted today waits its week');
 assert.ok(ai.calls.length>before);
});

test('one note the model rejects is one attempt, not an outage, and the tick keeps going',async()=>{
 const f=granolaFixture();
 // The rejected note is the newest, so ORDER BY meeting_at DESC attempts it first.
 const net=network({notes:[
  {...noteRaw(NOTE_A,'Alpha'),summary_text:'Ada asked for an intro to a fintech founder.',calendar_event:{scheduled_start_time:'2026-08-15T11:00:00Z'}},
  {...noteRaw(NOTE_B,'Beta'),summary_text:'Bob committed to send the deck.',calendar_event:{scheduled_start_time:'2026-08-13T11:00:00Z'}},
 ]});
 Object.assign(f.env,{THEME_MODEL:MODEL,AI:{async run(_model:string,input:any){
  if(JSON.stringify(input).includes('Ada asked for an intro'))throw Error('model rejected this input');
  return {response:{topics:[],statements:[{email:'bob@example.test',kind:'commitment',quote:'Bob committed to send the deck.'}]}};
 }}});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 await tickToPhase(f,net.fake,'extract');
 await withFetch(net.fake,()=>f.sync.tick(Date.now()));
 const a=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 const b=f.db.prepare('SELECT extraction_status FROM granola_notes WHERE id=?').get(NOTE_B) as any;
 assert.equal(b.extraction_status,'done','the good note is extracted in the same run');
 assert.equal(a.extraction_status,'pending');assert.equal(a.extraction_attempts,1);
 assert.equal(connection(f)!.status,'syncing','one rejected note does not end the run');
});

test('a folder toggle costs a bounded number of statements whatever the visible note count',async()=>{
 const f=granolaFixture();const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));
 const N=40;const insert=f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,0,'done',?,'granola-v1',0,0,0)");
 const signals:unknown[]=[];
 for(let i=0;i<N;i++){
  const id=`not_${String(i).padStart(4,'0')}567890ab`;
  insert.run(id,'Note '+i,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','["fol_1234567890abcd"]','s','p','t','h'+i,'{"topics":[],"statements":[],"calls":1}');
  signals.push({id:'sig-'+i,owner:'owner@example.test',account:'granola',themeId:'theme-x',sourceType:'granola',visibility:'private',observedAt:'2026-08-14T11:00:00Z',ingestedAt:'2026-08-15T00:00:00Z',confidence:.8,summary:'Ask: “hi”',evidenceRef:`granola-note:${id}#summary@0`,contentHash:'h'+i,extractorVersion:'granola-v1'});
 }
 await f.store.ingest(signals as any);
 f.statements.length=0;
 await f.sync.setExcluded(['fol_2234567890abcd']);// hides none of the notes above
 const total=f.statements.length,signalQueries=f.statements.filter(s=>s.includes('theme_signals')).length;
 assert.ok(total<N+20,`a toggle over ${N} visible notes issued ${total} statements`);
 assert.ok(signalQueries<=8,`a toggle issued ${signalQueries} signal queries`);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='granola'").get()!.n,N,'signals are left in place');
});

test('Granola statement signals reach the my lens only, never firm or public',async()=>{
 const f=granolaFixture();withAI(f,goodAI);const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const granolaIds=new Set((f.db.prepare("SELECT id FROM theme_signals WHERE account='granola'").all() as any[]).map(r=>r.id));
 assert.ok(granolaIds.size>0);
 const seen=async(lens:'my'|'firm'|'public')=>new Set((await f.store.snapshot(lens)).themes.flatMap(t=>t.components.map(c=>c.signalId)));
 const mine=await seen('my');
 assert.ok([...granolaIds].some(id=>mine.has(id)),'my mind sees meeting statements');
 for(const lens of ['firm','public'] as const){
  const visible=await seen(lens);
  assert.ok([...granolaIds].every(id=>!visible.has(id)),`${lens} excludes meeting statements`);
 }
});

test('noteMeta chunks IN (...) lookups to at most 100 bound ids per statement, whatever the input size',async()=>{
 const f=granolaFixture();
 const insert=f.db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,NULL,?,?,?,?,'[]',?,?,?,?,0,'done',NULL,'granola-v1',0,0,0)");
 const N=250;const ids:string[]=[];
 for(let i=0;i<N;i++){
  const id=`not_${String(i).padStart(4,'0')}567890ab`;ids.push(id);
  insert.run(id,'Note '+i,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z','s','p','t','h'+i);
 }
 f.statements.length=0;
 const meta=f.sync.noteMeta(ids);
 const inStatements=f.statements.filter(s=>s.includes('granola_notes')&&s.includes(' IN ('));
 assert.ok(inStatements.length>=3,`expected the 250 ids split across multiple statements, got ${inStatements.length}`);
 for(const s of inStatements){
  const placeholders=(s.match(/\?/g)??[]).length;
  assert.ok(placeholders<=100,`a noteMeta statement bound ${placeholders} params (> 100): ${s.slice(0,120)}`);
 }
 assert.equal(meta.size,N,'results from every chunk, including the last (partial) one, are merged');
 assert.equal(meta.get(ids[0])?.title,'Note 0','a result from the first chunk is present');
 assert.equal(meta.get(ids[149])?.title,'Note 149','a result from the second chunk is present');
 assert.equal(meta.get(ids[249])?.title,'Note 249','a result from the last, partial chunk is present');
});

test('a theme’s canonical_name follows a folder rename on re-ingest',async()=>{
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const pilot='theme-'+await opaque('owner@example.test','granola-folder:fol_1234567890abcd','identity-key');
 assert.equal((f.db.prepare('SELECT canonical_name FROM themes WHERE id=?').get(pilot) as any).canonical_name,'pilot');
 f.db.prepare('UPDATE granola_folders SET name=? WHERE id=?').run('Onboarding','fol_1234567890abcd');
 // Hiding then re-including the folder re-ingests the already-extracted note's statements
 // (see 'hiding a folder removes its signals and re-including restores them without AI'
 // above) without another AI call, which is enough to re-derive the folder theme's name.
 const callsBefore=ai.calls.length;
 await f.sync.setExcluded(['fol_1234567890abcd']);
 await f.sync.setExcluded([]);
 assert.equal(ai.calls.length,callsBefore,'re-deriving the theme name costs no AI call');
 assert.equal((f.db.prepare('SELECT canonical_name,aliases FROM themes WHERE id=?').get(pilot) as any).canonical_name,'onboarding');
 assert.deepEqual(JSON.parse((f.db.prepare('SELECT aliases FROM themes WHERE id=?').get(pilot) as any).aliases),['Onboarding']);
});

// ---- Jev extraction path (TYPESAFE_API_KEY present) ----
const TS_KEY='ts_fictional_key_123456';
/** Routes api.typesafe.ai to a fake Jev and everything else to the Granola fake. */
function withJev(f:ReturnType<typeof granolaFixture>,net:{fake:typeof fetch},opts:{answer?:(id:string,q:any,state:any)=>unknown;status?:number}={}){
 f.env.TYPESAFE_API_KEY=TS_KEY;
 const answer=opts.answer??defaultAnswer;const requests:{state:any;questions:Record<string,any>}[]=[];
 const fake=(async(input:any,init:any)=>{
  const url=String(input);
  if(!url.startsWith('https://api.typesafe.ai/'))return net.fake(input,init);
  const body=JSON.parse(init.body);requests.push(body);
  assert.ok(!JSON.stringify(body).includes(KEY),'the Granola key never reaches Jev');
  if(opts.status&&opts.status!==200)return new Response('{"error":"no"}',{status:opts.status});
  const answers:Record<string,unknown>={};
  for(const [id,question] of Object.entries<any>(body.questions))answers[id]=answer(id,question,body.state);
  return Response.json({model:'jev-2026-09-01',answers,usage:{input_tokens:1,output_tokens:0}});
 }) as typeof fetch;
 return {fake,requests};
}
const JEV_CONFIDENCE=0.35*(0.9*0.8)+0.35*(2/3)+0.15*0.5+0.15*1;
const twoFolderNote=()=>({...noteRaw(NOTE_A,'Alpha'),folder_membership:[{id:'fol_1234567890abcd',name:'x',parent_folder_id:null},{id:'fol_2234567890abcd',name:'y',parent_folder_id:null}]});

test('Jev extraction stamps granola-v3-jev and ingests composite statement confidences',async()=>{
 const f=granolaFixture();const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});const jev=withJev(f,net);
 assert.equal(f.env.AI,undefined,'the Jev path needs no Workers AI binding');
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const row=f.db.prepare('SELECT extraction_status,extractor_version,extraction FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'done');assert.equal(row.extractor_version,'granola-v3-jev');
 const stored=JSON.parse(row.extraction);
 assert.equal(stored.engine,'jev');
 assert.deepEqual(Object.keys(stored.statements[0]).sort(),['email','kind','offset','openLoop','probability','quote','source','theirAsk','urgency']);
 const ada=await opaque('owner@example.test','ada@example.test','identity-key');
 const statement=f.db.prepare("SELECT * FROM theme_signals WHERE account='granola' AND person_id=? AND evidence_ref=?").get(ada,`granola-note:${NOTE_A}#summary@0`) as any;
 assert.ok(Math.abs(statement.confidence-JEV_CONFIDENCE)<1e-9,`confidence ${statement.confidence}`);
 assert.equal(statement.summary,'Intro: “Ada asked for an intro to a fintech founder.”');
 assert.equal(statement.extractor_version,'granola-v3-jev');
 assert.equal(statement.model_id,'jev-latest');
 assert.equal(statement.theme_id,'theme-'+await opaque('owner@example.test','granola-folder:fol_1234567890abcd','identity-key'));
 const topic=f.db.prepare('SELECT theme_id,confidence FROM theme_signals WHERE evidence_ref=?').get(`granola-note:${NOTE_A}#topic@business_strategy`) as any;
 assert.equal(topic.confidence,0.7);
 assert.ok(jev.requests.length>0);
 assert.ok(jev.requests.every(r=>!('transcript' in r.state)&&r.state.title==='Alpha'));
});

test('a confident Jev folder choice beats the note’s first folder, a weak one does not',async()=>{
 const personal='theme-'+await opaque('owner@example.test','granola-folder:fol_2234567890abcd','identity-key');
 const pilot='theme-'+await opaque('owner@example.test','granola-folder:fol_1234567890abcd','identity-key');
 for(const [probability,expected] of [[0.8,personal],[0.3,pilot]] as const){
  const f=granolaFixture();const net=network({notes:[twoFolderNote()]});
  const jev=withJev(f,net,{answer:(id,q,state)=>id==='note_theme'?{type:'choice',choice:'fol_2234567890abcd',probabilities:{fol_2234567890abcd:probability,none:0.1},confidence:probability}:defaultAnswer(id,q)});
  await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
  const statement=f.db.prepare("SELECT theme_id FROM theme_signals WHERE account='granola' AND person_id IS NOT NULL LIMIT 1").get() as any;
  assert.equal(statement.theme_id,expected,`probability ${probability}`);
 }
});

test('a TypeSafe 401 fails the note and pauses the connection with jev_unauthorized',async()=>{
 const f=granolaFixture();const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});const jev=withJev(f,net,{status:401});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const row=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'failed');assert.equal(row.extraction_attempts,1);
 assert.equal(f.sync.status().error,'jev_unauthorized');
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE account='granola'").get()!.n,0);
});

test('the jev_unauthorized pause latches across a later run with nothing to do',async()=>{
 const f=granolaFixture();const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});const jev=withJev(f,net,{status:401});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 assert.equal(f.sync.status().error,'jev_unauthorized');
 assert.ok(connection(f).jevUnauthorizedAt>0,'the rejection time is remembered');
 const before=jev.requests.length;
 bump(f,{nextSync:0});await runToIdle(f,jev.fake);
 assert.equal(jev.requests.length,before,'the failed note is not retried this run');
 assert.equal(f.sync.status().error,'jev_unauthorized','the pause survives a clean run');
});

test('a working TypeSafe key lifts the pause and re-extracts what it failed',async()=>{
 const f=granolaFixture();const net=network();const rejecting=withJev(f,net,{status:401});
 await withFetch(rejecting.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,rejecting.fake);
 const failed=f.db.prepare("SELECT id FROM granola_notes WHERE extraction_status='failed'").all() as any[];
 assert.equal(failed.length,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='pending'").get()!.n,1);
 assert.equal(f.sync.status().error,'jev_unauthorized');
 const working=withJev(f,net);
 bump(f,{nextSync:0});await runToIdle(f,working.fake);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='done'").get()!.n,2,'both notes are extracted');
 const revived=f.db.prepare('SELECT extraction_status,extraction_attempts,extractor_version FROM granola_notes WHERE id=?').get(failed[0].id) as any;
 assert.equal(revived.extraction_status,'done');assert.equal(revived.extractor_version,'granola-v3-jev');
 assert.equal(f.sync.status().error,'','the pause is lifted');
 assert.equal(connection(f).jevUnauthorizedAt,undefined);
});

test('a TypeSafe outage leaves the note pending like an unavailable model',async()=>{
 const f=granolaFixture();const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});const jev=withJev(f,net,{status:503});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const row=f.db.prepare('SELECT extraction_status,extraction_attempts FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'pending');assert.equal(row.extraction_attempts,1);
 assert.equal(f.sync.status().error,'');
});

test('without the TypeSafe key the Llama extractor and granola-v2 stay in use',async()=>{
 const f=granolaFixture();const ai=withAI(f,goodAI);const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});
 const seen:string[]=[];
 const fake=(async(input:any,init:any)=>{seen.push(String(input));return net.fake(input,init);}) as typeof fetch;
 await withFetch(fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,fake);
 assert.ok(!seen.some(u=>u.includes('typesafe')),'no Jev request without the key');
 assert.ok(ai.calls.length>0);
 const row=f.db.prepare('SELECT extractor_version,extraction FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extractor_version,'granola-v2');
 assert.equal(JSON.parse(row.extraction).engine,undefined);
 assert.equal((f.db.prepare("SELECT confidence FROM theme_signals WHERE evidence_ref=?").get(`granola-note:${NOTE_A}#summary@0`) as any).confidence,0.8);
});

test('adding the TypeSafe key re-extracts the notes the Llama path stored',async()=>{
 const f=granolaFixture();withAI(f,goodAI);const net=network({notes:[noteRaw(NOTE_A,'Alpha')]});
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 assert.equal((f.db.prepare('SELECT extractor_version FROM granola_notes WHERE id=?').get(NOTE_A) as any).extractor_version,'granola-v2');
 const jev=withJev(f,net);
 bump(f,{nextSync:0});await runToIdle(f,jev.fake);
 const row=f.db.prepare('SELECT extraction_status,extractor_version FROM granola_notes WHERE id=?').get(NOTE_A) as any;
 assert.equal(row.extraction_status,'done');assert.equal(row.extractor_version,'granola-v3-jev');
 const statement=f.db.prepare("SELECT confidence,extractor_version FROM theme_signals WHERE account='granola' AND person_id IS NOT NULL LIMIT 1").get() as any;
 assert.ok(Math.abs(statement.confidence-JEV_CONFIDENCE)<1e-9);
 assert.equal(statement.extractor_version,'granola-v3-jev');
});

// ---- Identity suggestions (feature 5) ----
/** Answers the identity question with `p` and keeps the extractor happy on any note's attendees. */
const identityAnswers=(p:number)=>(id:string,q:any)=>{
 if(id==='same_person')return noulA(p);
 if(id.startsWith('a'))return choiceA(Object.keys(q?.criteria??{}).find(k=>k!=='none')??'none',0.9,{none:0.05});
 return defaultAnswer(id,q);
};
const withAttendees=(title:string,attendees:{name:string;email:string}[])=>({...noteRaw(NOTE_A,title),attendees});
const identityRows=(f:ReturnType<typeof granolaFixture>)=>f.db.prepare('SELECT * FROM granola_identity ORDER BY attendee_email').all() as any[];
const samePerson=(jev:{requests:{state:any;questions:Record<string,any>}[]})=>jev.requests.filter(r=>'same_person' in r.questions);

test('identity candidates pair name-matched attendees with Gmail contacts, at most three each',async()=>{
 const f=granolaFixture();
 f.gmail.push(
  {email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:['pilot rollout','pricing deck','board update','hiring plan','q4 budget','extra theme']},
  {email:'ada.l@other.test',name:'Ada Lovelace',subjects:[]},
  {email:'a.lovelace@third.test',name:'Ada Lovelace',subjects:[]},
  {email:'ada.fourth@fourth.test',name:'Ada Lovelace',subjects:[]},
  {email:'grace.hopper@work.test',name:'Grace Hopper',subjects:[]},
  {email:'jose@work.test',name:'Jose Nito',subjects:[]},
  {email:'bob@example.test',name:'Bob Stone',subjects:[]},
 );
 const net=network({notes:[withAttendees('Alpha',[
  {name:'Me',email:'me@example.test'},
  {name:'Ada Lovelace',email:'ada@granola.test'},
  {name:'Grace H.',email:'grace@granola.test'},
  {name:'Grace Kelly',email:'gracek@granola.test'},
  {name:'José Ñito',email:'jose@granola.test'},
  {name:'Bob Stone',email:'bob@example.test'},
 ])]});
 const jev=withJev(f,net,{answer:identityAnswers(0.9)});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const asked=samePerson(jev);
 assert.deepEqual(asked.map(r=>[r.state.attendee.email,r.state.contact.email]).sort(),[
  ['ada@granola.test','ada.lovelace@work.test'],['ada@granola.test','ada.l@other.test'],['ada@granola.test','a.lovelace@third.test'],
  ['grace@granola.test','grace.hopper@work.test'],
  ['jose@granola.test','jose@work.test'],
 ].sort(),'owner, existing Gmail contacts and mismatched last initials are never paired');
 const state=asked.find(r=>r.state.attendee.email==='ada@granola.test'&&r.state.contact.email==='ada.lovelace@work.test')!.state;
 assert.deepEqual(Object.keys(state).sort(),['attendee','contact']);
 assert.deepEqual(Object.keys(state.attendee).sort(),['domain','email','meetings','name']);
 assert.deepEqual(Object.keys(state.contact).sort(),['domain','email','name','recentSubjects']);
 assert.equal(state.attendee.domain,'granola.test');assert.equal(state.contact.domain,'work.test');
 assert.deepEqual(state.attendee.meetings,['Alpha']);
 assert.equal(state.contact.recentSubjects.length,5,'at most five subject theme names');
 const rows=identityRows(f);
 assert.deepEqual(rows.map(r=>[r.attendee_email,r.contact_email,r.status]),[
  ['ada@granola.test','ada.lovelace@work.test','pending'],
  ['grace@granola.test','grace.hopper@work.test','pending'],
  ['jose@granola.test','jose@work.test','pending'],
 ]);
 const suggestions=f.sync.identitySuggestions();
 assert.equal(suggestions.length,3);
 assert.deepEqual(suggestions.map(s=>s.attendeeEmail).sort(),['ada@granola.test','grace@granola.test','jose@granola.test']);

 assert.deepEqual(suggestions.find(s=>s.attendeeEmail==='ada@granola.test'),{attendeeEmail:'ada@granola.test',attendeeName:'Ada Lovelace',contactEmail:'ada.lovelace@work.test',contactName:'Ada Lovelace',probability:0.9});
});

test('a weak judgment is stored as dismissed and the pair is never asked again',async()=>{
 const f=granolaFixture();
 f.gmail.push({email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:[]});
 const net=network({notes:[withAttendees('Alpha',[{name:'Me',email:'me@example.test'},{name:'Ada Lovelace',email:'ada@granola.test'}])]});
 const jev=withJev(f,net,{answer:identityAnswers(0.4)});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 assert.deepEqual(identityRows(f).map(r=>[r.attendee_email,r.status,r.probability]),[['ada@granola.test','dismissed',0.4]]);
 assert.deepEqual(f.sync.identitySuggestions(),[]);
 const before=samePerson(jev).length;assert.equal(before,1);
 bump(f,{nextSync:0});await runToIdle(f,jev.fake);
 assert.equal(samePerson(jev).length,before,'a decided pair is not judged again');
});

test('at most fifty pairs are judged per run and the rest wait for the next run',async()=>{
 // 20 attendees x 3 same-name contacts = 60 candidate pairs (a note carries at most 50 attendees).
 const f=granolaFixture();
 const attendees=[{name:'Me',email:'me@example.test'}];
 for(let i=0;i<20;i++){
  for(const host of ['work','other','third'])f.gmail.push({email:`person${i}@${host}.test`,name:`Person${i} Match`,subjects:[]});
  attendees.push({name:`Person${i} Match`,email:`person${i}@granola.test`});
 }
 const net=network({notes:[withAttendees('Alpha',attendees)]});
 const jev=withJev(f,net,{answer:identityAnswers(0.9)});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 assert.equal(samePerson(jev).length,50,'the run stops at fifty pairs');
 const judged=identityRows(f).length;
 assert.ok(judged>0&&judged<20,`some attendees are still undecided (${judged})`);
 bump(f,{nextSync:0});await runToIdle(f,jev.fake);
 assert.equal(identityRows(f).length,20,'the remaining attendees are judged on the next run');
});

test('a long identity tick reschedules and resumes where it stopped',async()=>{
 const f=granolaFixture();
 f.gmail.push({email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:[]},{email:'bob.stone@work.test',name:'Bob Stone',subjects:[]});
 const net=network({notes:[withAttendees('Alpha',[{name:'Ada Lovelace',email:'ada@granola.test'},{name:'Bob Stone',email:'bob@granola.test'}])]});
 const real=Date.now;let offset=0;
 const jev=withJev(f,net,{answer:(id,q)=>{if(id==='same_person'){offset+=21_000;return noulA(0.9);}return identityAnswers(0.9)(id,q);}});
 try{
  await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));
  await tickToPhase(f,jev.fake,'identity');
  Date.now=()=>real.call(Date)+offset;
  await withFetch(jev.fake,()=>f.sync.tick(Date.now()));
  assert.equal(connection(f).job.phase,'identity','the run stays in the identity phase');
  assert.equal(connection(f).job.identityPairs.length,1,'one pair is left for the next tick');
  assert.equal(identityRows(f).length,1);
  assert.ok(f.sync.nextDue()!<=Date.now()+1_500,'the next tick is scheduled soon');
  await withFetch(jev.fake,()=>f.sync.tick(Date.now()+2000));
 }finally{Date.now=real;}
 assert.equal(f.sync.status().status,'connected');
 assert.equal(identityRows(f).length,2);
});

test('confirming a match folds the attendee into the contact and re-points its signals',async()=>{
 const f=granolaFixture();
 f.gmail.push({email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:['pilot rollout']});
 const net=network({notes:[withAttendees('Alpha',[{name:'Me',email:'me@example.test'},{name:'Ada Lovelace',email:'ada@example.test'},{name:'Bob',email:'bob@example.test'}])]});
 const jev=withJev(f,net,{answer:identityAnswers(0.82)});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const attendee=await opaque('owner@example.test','ada@example.test','identity-key');
 const contact=await opaque('owner@example.test','ada.lovelace@work.test','identity-key');
 assert.ok((f.db.prepare("SELECT COUNT(*) AS n FROM theme_signals WHERE person_id=?").get(attendee) as any).n>0);
 assert.deepEqual(f.sync.identitySuggestions().map(s=>s.attendeeEmail),['ada@example.test']);
 const before=f.invalidations();
 const left=await f.sync.resolveIdentity('ada@example.test','confirm');
 assert.deepEqual(left,[]);
 assert.ok(f.invalidations()>before,'the graph is invalidated');
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE person_id=?').get(attendee) as any).n,0);
 assert.ok((f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE person_id=?').get(contact) as any).n>0,'signals move to the contact');
 assert.deepEqual(f.sync.contacts().map(c=>c.email).sort(),['ada.lovelace@work.test','bob@example.test','me@example.test']);
 assert.equal(f.sync.contacts().find(c=>c.email==='ada.lovelace@work.test')!.meetings,1);
 const edges=f.sync.edges().map(e=>[e.a,e.b]);
 assert.ok(edges.some(([a,b])=>a==='ada.lovelace@work.test'&&b==='bob@example.test'),'edges follow the alias');
 assert.ok(!edges.some(([a,b])=>a.includes('ada@example.test')||b.includes('ada@example.test')));
 assert.ok(!edges.some(([a,b])=>a===b),'no self edges');
 await assert.rejects(f.sync.resolveIdentity('ada@example.test','confirm'),/invalid_identity/);
 await assert.rejects(f.sync.resolveIdentity('nobody@example.test','dismiss'),/invalid_identity/);
});

test('dismissing a match leaves the graph alone and hides the suggestion',async()=>{
 const f=granolaFixture();
 f.gmail.push({email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:[]});
 const net=network({notes:[withAttendees('Alpha',[{name:'Me',email:'me@example.test'},{name:'Ada Lovelace',email:'ada@example.test'}])]});
 const jev=withJev(f,net,{answer:identityAnswers(0.7)});
 await withFetch(jev.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,jev.fake);
 const attendee=await opaque('owner@example.test','ada@example.test','identity-key');
 assert.deepEqual(await f.sync.resolveIdentity('ada@example.test','dismiss'),[]);
 assert.equal(identityRows(f)[0].status,'dismissed');
 assert.ok((f.db.prepare('SELECT COUNT(*) AS n FROM theme_signals WHERE person_id=?').get(attendee) as any).n>0,'signals stay on the attendee');
 assert.ok(f.sync.contacts().some(c=>c.email==='ada@example.test'));
 const before=samePerson(jev).length;
 bump(f,{nextSync:0});await runToIdle(f,jev.fake);
 assert.equal(samePerson(jev).length,before,'a dismissed pair is not judged again');
});

test('without the TypeSafe key no identity request is made and no pair is stored',async()=>{
 const f=granolaFixture();withAI(f,goodAI);
 f.gmail.push({email:'ada.lovelace@work.test',name:'Ada Lovelace',subjects:[]});
 const net=network({notes:[withAttendees('Alpha',[{name:'Me',email:'me@example.test'},{name:'Ada Lovelace',email:'ada@granola.test'}])]});
 const seen:string[]=[];
 const fake=(async(input:any,init:any)=>{seen.push(String(input));return net.fake(input,init);}) as typeof fetch;
 await withFetch(fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,fake);
 assert.ok(!seen.some(u=>u.includes('typesafe')));
 assert.equal(identityRows(f).length,0);
 assert.deepEqual(f.sync.identitySuggestions(),[]);
});

test('suggestions list newest first and skip decided rows',async()=>{
 const f=granolaFixture();
 const insert=f.db.prepare('INSERT INTO granola_identity VALUES (?,?,?,?,?,?,?)');
 insert.run('old@granola.test','old@work.test','Old Name','Old Name',0.7,'pending',10);
 insert.run('new@granola.test','new@work.test','New Name','New Name',0.9,'pending',20);
 insert.run('gone@granola.test','gone@work.test','Gone','Gone',0.4,'dismissed',30);
 insert.run('done@granola.test','done@work.test','Done','Done',0.95,'confirmed',40);
 assert.deepEqual(f.sync.identitySuggestions().map(s=>s.attendeeEmail),['new@granola.test','old@granola.test']);
});

test('disconnect removes stored identity decisions',async()=>{
 const f=granolaFixture();
 await withFetch((async()=>foldersResponse()) as typeof fetch,()=>f.sync.connect(KEY,'all'));
 f.db.prepare("INSERT INTO granola_identity VALUES ('ada@granola.test','ada@work.test','Ada','Ada',0.9,'confirmed',1)").run();
 await f.sync.disconnect();
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM granola_identity').get() as any).n,0);
});
