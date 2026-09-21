import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {FakeAI} from './worker-stub';
import {opaque} from '../src/mail-model';
import type {SharedSlice} from '../src/network-share';

const THEME_MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** The same in-memory Durable Object stand-in the sync tests use: node:sqlite plus a KV map. */
function fixture(){const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql);const rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async(n:number)=>{kv.set('alarm',n);},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};const env={MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_SECRET:'client-secret',GOOGLE_CLIENT_ID:'client-id',TOKEN_SECRET:'identity-key'};return {service:new MailSync(ctx as any,env as any),db,kv};}
const account=(db:DatabaseSync,email:string)=>db.prepare('INSERT INTO accounts VALUES (?,?)').run(email,JSON.stringify({email,grant:'unused',revision:'rev',status:'connected',job:null,lastSync:Date.parse('2026-09-01T00:00:00Z'),nextSync:9e15}));
const contribution=(db:DatabaseSync,canonical:string,email:string,name:string,at:string,subject='Pilot rollout plan',sent=1,received=1)=>db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)').run('me@example.com',canonical,email,name,Date.parse(at),subject,sent,received);
const granolaConnection=(db:DatabaseSync)=>db.prepare("INSERT INTO granola_connection (id,grant,data) VALUES (1,'sealed',?)").run(JSON.stringify({ownerEmail:'me@example.com',status:'connected',range:'all',watermark:'w',lastSync:1,nextSync:9e15,lastReconcile:1,error:'',job:null}));
const granolaNote=(db:DatabaseSync,id:string,folderIds:string[])=>db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,'Pilot sync',NULL,'2026-08-14T11:00:00Z','scheduled','2026-08-14T12:00:00Z','2026-08-15T12:00:00Z',?,'','','','h',0,'done',NULL,'granola-v2',0,0,0)").run(id,JSON.stringify(folderIds));
const attendee=(db:DatabaseSync,noteId:string,email:string,name:string)=>db.prepare('INSERT INTO granola_attendees VALUES (?,?,?)').run(noteId,email,name);

/** An owner with two mail contacts, one meeting-only contact, and topic/statement evidence. */
async function ownerFixture(){
 const f=fixture();f.kv.set('owner','owner');
 account(f.db,'me@example.com');
 contribution(f.db,'m1','ada@work.test','Ada Lovelace','2026-09-10T00:00:00Z');
 contribution(f.db,'m2','bo@design.test','Bo Chen','2026-09-09T00:00:00Z');
 contribution(f.db,'m3','me@example.com','Me','2026-09-08T00:00:00Z');
 granolaConnection(f.db);granolaNote(f.db,'not_1234567890abcd',['fld_one']);granolaNote(f.db,'not_abcdef01234567',['fld_two']);
 attendee(f.db,'not_1234567890abcd','me@example.com','Me');
 attendee(f.db,'not_1234567890abcd','ada@work.test','Ada Lovelace');
 attendee(f.db,'not_1234567890abcd','cia@meet.test','Cia Ford');
 attendee(f.db,'not_abcdef01234567','bo@design.test','Bo Chen');
 f.db.prepare("INSERT INTO granola_edges VALUES ('not_1234567890abcd','ada@work.test','cia@meet.test')").run();
 const ids=Object.fromEntries(await Promise.all(['ada@work.test','bo@design.test','cia@meet.test','me@example.com']
  .map(async email=>[email,await opaque('owner',email,'identity-key')] as const)));
 const now=new Date('2026-09-15T00:00:00Z').toISOString();
 const theme=(id:string,name:string)=>({id,owner:'owner',canonicalName:name.toLowerCase(),aliases:[name],description:`Theme: ${name}`,status:'active' as const,createdAt:now,updatedAt:now});
 const signal=(id:string,personId:string|undefined,themeId:string,summary:string,sourceType:'granola'|'public_url'='granola')=>
  ({id,owner:'owner',account:'granola',personId,themeId,sourceType,visibility:'private' as const,observedAt:'2026-09-12T11:00:00.000Z',ingestedAt:now,confidence:.8,summary,
   evidenceRef:personId?`granola-note:not_1234567890abcd#summary@${id}`:'granola-note:not_1234567890abcd#topic@agent_memory',contentHash:id,extractorVersion:'granola-v2'});
 await (f.service as any).store().ingestWithThemes(
  [theme('theme-pilot','Pilot Rollout'),theme('theme-public','Public Feed')],
  [signal('sig-topic',undefined,'theme-pilot','Meeting matched Agent Memory'),
   signal('sig-ada','ada@none','theme-pilot','QUOTE-CARRIER')]);
 // The statement signal must point at Ada's real opaque id; rewrite it now that we have one.
 f.db.prepare('UPDATE theme_signals SET person_id=?, summary=? WHERE id=?').run(ids['ada@work.test'],'Ask: “we need a pilot partner”','sig-ada');
 // A public-source signal cannot be ingested through the normal path (it would be forced to
 // visibility 'public'), so it is written straight in: the export must still leave it behind.
 f.db.prepare("INSERT INTO theme_signals (id,owner,account,person_id,theme_id,source_type,visibility,observed_at,ingested_at,confidence,summary,evidence_ref,content_hash,extractor_version,model_id) VALUES ('sig-public','owner','public',NULL,'theme-public','public_url','public','2026-09-12T11:00:00.000Z',?,0.7,'Published a paper','public-source:src-1','h','public-v1',NULL)").run(now);
 return {...f,ids};
}

test('share export honours scope and level and never carries the owner’s own addresses',async()=>{
 const {service,db,ids}=await ownerFixture();
 try{
  const all=await service.exportSlice({kind:'all'},'statements');
  assert.equal(all.owner,'owner');
  assert.ok(all.exportedAt>0);
  assert.deepEqual(all.people.map(p=>p.email).sort(),['ada@work.test','bo@design.test','cia@meet.test']);
  assert.ok(!JSON.stringify(all).includes('me@example.com'),'the owner’s own addresses never leave the object');
  const ada=all.people.find(p=>p.email==='ada@work.test')!;
  assert.equal(ada.name,'Ada Lovelace');assert.equal(ada.meetings,1);assert.equal(ada.lastContact,'2026-09-10T00:00:00.000Z');
  assert.ok(all.edges.some(e=>[e.a,e.b].sort().join()==='ada@work.test,cia@meet.test'&&e.types.includes('shared_meeting')));
  assert.ok(all.signals.some(s=>s.summary.includes('we need a pilot partner')),'statements carry the quote');
  assert.ok(!all.signals.some(s=>s.sourceType==='public_url'),'public-source evidence is never shared');
  assert.ok(all.themes.some(t=>t.id==='theme-pilot'&&t.name==='Pilot Rollout'));

  const names=await service.exportSlice({kind:'all'},'names');
  assert.deepEqual(names.signals,[]);assert.deepEqual(names.themes,[]);
  assert.equal(names.people.length,3,'names still carries people and edges');
  assert.ok(names.edges.length>0);

  const themes=await service.exportSlice({kind:'all'},'themes');
  assert.ok(themes.themes.some(t=>t.id==='theme-pilot'));
  assert.ok(themes.signals.some(s=>s.summary==='Meeting matched Agent Memory'),'topic signals survive');
  assert.ok(!themes.signals.some(s=>s.summary.includes('we need a pilot partner')),'statement quotes are dropped below the statements level');

  const folders=await service.exportSlice({kind:'folders',ids:['fld_one']},'names');
  assert.deepEqual(folders.people.map(p=>p.email).sort(),['ada@work.test','cia@meet.test']);
  const emails=await service.exportSlice({kind:'people',emails:['bo@design.test','me@example.com','nobody@nowhere.test']},'names');
  assert.deepEqual(emails.people.map(p=>p.email),['bo@design.test']);
  const people=await service.exportSlice({kind:'people',personIds:[ids['ada@work.test'],ids['me@example.com'],'not-a-real-id']},'names');
  assert.deepEqual(people.people.map(p=>p.email),['ada@work.test'],'opaque ids resolve inside the owner’s object; unknown ids are ignored');
  await assert.rejects(service.exportSlice({kind:'all'},'everything' as any),/invalid_share/);
  await assert.rejects(service.exportSlice({kind:'nonsense'} as any,'names'),/invalid_share/);
 }finally{db.close();}
});

test('share export stays inside the slice caps',async()=>{
 const {service,db,kv}=fixture();kv.set('owner','owner');
 try{
  account(db,'me@example.com');
  for(let i=0;i<620;i++)contribution(db,'m'+i,`p${String(i).padStart(3,'0')}@work.test`,'P'+i,'2026-09-10T00:00:00Z','Pilot',620-i,620-i);
  const slice=await service.exportSlice({kind:'all'},'names');
  assert.equal(slice.people.length,500,'at most 500 people');
  assert.ok(slice.edges.length<=2000);
  assert.ok(slice.people.every(p=>!p.email.startsWith('p6')&&!p.email.startsWith('p5')),'the strongest contacts are the ones shared');
 }finally{db.close();}
});

/** A viewer object with one mail contact of its own, ready to import somebody else's slice. */
async function viewerFixture(){
 const f=fixture();f.kv.set('owner','viewer');
 account(f.db,'me@example.com');
 contribution(f.db,'v1','known@work.test','Known Person','2026-08-01T00:00:00Z');
 const ids=Object.fromEntries(await Promise.all(['known@work.test','stranger@vc.test','me@example.com']
  .map(async email=>[email,await opaque('viewer',email,'identity-key')] as const)));
 return {...f,ids};
}
const slice=(over:Partial<SharedSlice>={}):SharedSlice=>({owner:'owner@share.test',exportedAt:Date.parse('2026-09-15T00:00:00Z'),
 people:[{email:'stranger@vc.test',name:'Stranger Vc',lastContact:'2026-09-12T00:00:00.000Z',meetings:3},
  {email:'known@work.test',name:'Known Person',lastContact:'2026-09-14T00:00:00.000Z',meetings:1},
  {email:'me@example.com',name:'Me',lastContact:null,meetings:1}],
 edges:[{a:'known@work.test',b:'stranger@vc.test',weight:2,types:['shared_meeting'],contexts:['Pilot sync']}],
 themes:[{id:'theme-pilot',name:'Pilot Rollout'}],
 signals:[{email:'stranger@vc.test',themeId:'theme-pilot',summary:'Ask: “looking for a design partner”',observedAt:'2026-09-12T11:00:00.000Z',sourceType:'granola',confidence:.8,title:'Pilot sync'}],
 ...over});

test('importing a slice merges shared people into the graph and keeps the evidence in the firm lens',async()=>{
 const {service,db,ids}=await viewerFixture();
 try{
  assert.deepEqual(service.sharedMeta(),{refreshedAt:0,owners:[]});
  assert.deepEqual(await service.importShares([slice()]),{owners:['owner@share.test'],people:2});
  const graph=(await service.graph())!;
  const stranger=graph.nodes.find((n:any)=>n.id===ids['stranger@vc.test']) as any;
  assert.ok(stranger,'a shared-only person becomes a node');
  assert.deepEqual(stranger.via,['owner@share.test']);
  assert.equal(stranger.name,'Stranger Vc');
  assert.equal(stranger.company,'vc.test');
  assert.equal(stranger.lastContact,'2026-09-12T00:00:00.000Z');
  assert.equal(typeof stranger.combined,'number');
  assert.equal(graph.nodes.filter((n:any)=>n.id===ids['known@work.test']).length,1,'a person the viewer already knows stays one node');
  const known=graph.nodes.find((n:any)=>n.id===ids['known@work.test']) as any;
  assert.deepEqual(known.via,['owner@share.test']);
  assert.equal(known.lastContact,'2026-09-14T00:00:00.000Z','the later last contact wins');
  assert.ok(!graph.nodes.some((n:any)=>n.id===ids['me@example.com']),'the viewer is never a node in their own graph');
  const edge=graph.edges.find((e:any)=>[e.source,e.target].sort().join()===[ids['known@work.test'],ids['stranger@vc.test']].sort().join()) as any;
  assert.ok(edge&&edge.types.includes('shared_via'));
  assert.ok(!JSON.stringify(graph.nodes.map((n:any)=>({...n,via:undefined}))).includes('@'),'emails never reach the graph payload');

  const row=db.prepare('SELECT * FROM theme_signals').get() as any;
  assert.equal(row.visibility,'firm');
  assert.equal(row.account,'share:owner@share.test');
  assert.equal(row.person_id,ids['stranger@vc.test']);
  assert.ok(String(row.evidence_ref).startsWith('share:owner@share.test:'));
  assert.equal(row.theme_id,'theme-'+await opaque('viewer','share-theme:owner@share.test:theme-pilot','identity-key'));
  const theme=db.prepare('SELECT * FROM themes WHERE id=?').get(row.theme_id) as any;
  assert.deepEqual(JSON.parse(theme.aliases),['Pilot Rollout'],'the owner’s theme name is the canonical name');

  const firm=await (service as any).store().snapshot('firm');
  assert.ok(firm.themes.some((t:any)=>t.themeId===row.theme_id),'the Firm lens sees the shared evidence');
  const pub=await (service as any).store().snapshot('public');
  assert.ok(!pub.themes.some((t:any)=>t.themeId===row.theme_id),'the Public lens never does');

  const meta=service.sharedMeta();
  assert.deepEqual(meta.owners,['owner@share.test']);
  assert.ok(meta.refreshedAt>0);
 }finally{db.close();}
});

test('re-importing replaces an owner’s cache and dropShare removes every trace of it',async()=>{
 const {service,db,ids}=await viewerFixture();
 try{
  await service.importShares([slice()]);
  await service.importShares([slice({people:[{email:'other@vc.test',name:'Other',lastContact:null,meetings:0}],edges:[],signals:[]})]);
  const graph=(await service.graph())!;
  assert.ok(!graph.nodes.some((n:any)=>n.id===ids['stranger@vc.test']),'the previous slice is gone');
  const other=await opaque('viewer','other@vc.test','identity-key');
  assert.ok(graph.nodes.some((n:any)=>n.id===other));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0,'replaced signals do not linger');

  await service.importShares([slice()]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shared_people').get()!.n,2);
  await service.dropShare('owner@share.test');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shared_people').get()!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shared_edges').get()!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM theme_signals').get()!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM themes').get()!.n,0);
  assert.deepEqual(service.sharedMeta(),{refreshedAt:0,owners:[]});
  const after=(await service.graph())!;
  assert.ok(!after.nodes.some((n:any)=>n.id===ids['stranger@vc.test']));
  assert.ok(!after.nodes.some((n:any)=>(n as any).via));
 }finally{db.close();}
});

test('drafting a note about a shared-only person writes to the sharing owner instead',async()=>{
 const {service,db,ids}=await viewerFixture();
 const ai=new FakeAI({response:{subject:'Intro to Stranger?',body:'Could you introduce me to Stranger Vc?'}});
 Object.assign((service as any).env,{AI:ai,THEME_MODEL});
 try{
  await service.importShares([slice()]);
  const draft=await service.draftNote(ids['stranger@vc.test']);
  assert.equal(draft.to,'owner@share.test','the note is addressed to the sharing owner');
  assert.equal(draft.introVia,'owner@share.test');
  assert.equal(draft.name,'Stranger Vc');
  assert.ok(draft.basedOn.length>0,'the shared evidence is what the draft is based on');
  const system=String(ai.calls[0].input.messages[0].content);
  assert.ok(system.includes('owner@share.test')&&system.includes('Stranger Vc')&&system.includes('do not write to'),'the prompt says this is an introduction request');
  const own=await service.draftNote(ids['known@work.test']);
  assert.equal(own.to,'known@work.test','a person the viewer knows is still addressed directly');
  assert.equal(own.introVia,null);
 }finally{db.close();}
});
