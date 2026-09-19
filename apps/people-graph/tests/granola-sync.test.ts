import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {GranolaSync} from '../src/granola-sync';
import {RelevanceStore} from '../src/relevance-store';
import {unseal} from '../src/mail-model';

export function granolaFixture(){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const env={MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_ID:'client-id',TOKEN_SECRET:'identity-key'} as any;
 kv.set('owner','owner@example.test');
 const store=new RelevanceStore(ctx as any,()=>ctx.storage.get('owner') as Promise<string|undefined>);
 let invalidations=0;
 const sync=new GranolaSync(ctx as any,env,{owner:()=>ctx.storage.get('owner') as Promise<string|undefined>,store:()=>store,invalidateGraph:async()=>{invalidations++;}});
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
