import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {GranolaSync} from '../src/granola-sync';
import {RelevanceStore} from '../src/relevance-store';
import {unseal} from '../src/mail-model';

export function granolaFixture(opts:{maxNotes?:number}={}){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const env={MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_ID:'client-id',TOKEN_SECRET:'identity-key'} as any;
 kv.set('owner','owner@example.test');
 const store=new RelevanceStore(ctx as any,()=>ctx.storage.get('owner') as Promise<string|undefined>);
 let invalidations=0;
 const sync=new GranolaSync(ctx as any,env,{owner:()=>ctx.storage.get('owner') as Promise<string|undefined>,store:()=>store,invalidateGraph:async()=>{invalidations++;}},opts.maxNotes);
 return {sync,db,kv,env,store,invalidations:()=>invalidations};
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
function noteRaw(id:string,title:string,folder='fol_1234567890abcd',updated='2026-08-15T12:00:00Z'){return {id,object:'note',title,owner:{name:'Me',email:'me@example.test'},created_at:'2026-08-14T12:00:00Z',updated_at:updated,web_url:'https://notes.granola.ai/d/'+id,calendar_event:{scheduled_start_time:'2026-08-14T11:00:00Z'},attendees:[{name:'Me',email:'me@example.test'},{name:'Ada',email:'ada@example.test'},{name:'Bob',email:'bob@example.test'}],folder_membership:[{id:folder,name:'x',parent_folder_id:null}],summary_text:'Ada asked for an intro to a fintech founder.',private_notes_text:'remember to send deck',transcript:null};}
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

import {FakeAI} from './worker-stub';
import {opaque} from '../src/mail-model';
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
 assert.equal(statement.theme_id,topic.theme_id);
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
 const f=granolaFixture();withAI(f,{response:{topics:[],statements:[{email:'bob@example.test',kind:'commitment',quote:'remember to send deck'}]}});const net=network();
 await withFetch(net.fake,()=>f.sync.connect(KEY,'all'));await runToIdle(f,net.fake);
 const theme=f.db.prepare("SELECT t.canonical_name FROM theme_signals s JOIN themes t ON t.id=s.theme_id WHERE s.account='granola'").get() as any;
 assert.equal(theme.canonical_name,'meetings');
 const sig=f.db.prepare("SELECT summary,confidence FROM theme_signals WHERE account='granola'").get() as any;
 assert.equal(sig.summary,'Commitment: “remember to send deck”');assert.equal(sig.confidence,0.7);
});
