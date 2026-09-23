import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {FakeAI} from './worker-stub';
import {opaque} from '../src/mail-model';
import {jevServer,noulA,scoreA} from './granola-jev-extractor.test';
import type {SharedSlice} from '../src/network-share';

async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const original=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=original;}}

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
 f.db.prepare('INSERT INTO mail_edges VALUES (?,?,?,?,?)').run('me@example.com','m1','ada@work.test','bo@design.test','SECRET SUBJECT LINE');
 const ids=Object.fromEntries(await Promise.all(['ada@work.test','bo@design.test','cia@meet.test','me@example.com']
  .map(async email=>[email,await opaque('owner',email,'identity-key')] as const)));
 const now=new Date('2026-09-15T00:00:00Z').toISOString();
 const theme=(id:string,name:string)=>({id,owner:'owner',canonicalName:name.toLowerCase(),aliases:[name],description:`Theme: ${name}`,status:'active' as const,createdAt:now,updatedAt:now});
 const signal=(id:string,personId:string|undefined,themeId:string,summary:string,sourceType:'granola'|'obsidian_note'|'calendar'|'gmail_subject'='granola')=>
  ({id,owner:'owner',account:'granola',personId,themeId,sourceType,visibility:'private' as const,observedAt:'2026-09-12T11:00:00.000Z',ingestedAt:now,confidence:.8,summary,
   evidenceRef:personId?`granola-note:not_1234567890abcd#summary@${id}`:'granola-note:not_1234567890abcd#topic@agent_memory',contentHash:id,extractorVersion:'granola-v2'});
 await (f.service as any).store().ingestWithThemes(
  [theme('theme-pilot','Pilot Rollout'),theme('theme-public','Public Feed'),theme('theme-subject','Acme Acquisition')],
  [signal('sig-topic',undefined,'theme-pilot','Meeting matched Agent Memory'),
   signal('sig-ada',ids['ada@work.test'],'theme-pilot','PLACEHOLDER'),
   signal('sig-obsidian',ids['ada@work.test'],'theme-pilot','OBSIDIAN FREE TEXT','obsidian_note'),
   // A Gmail subject fragment: the theme name is two canonical tokens of the owner's own
   // subject line, so neither it nor its summary may leave the object at any level.
   signal('sig-subject',ids['ada@work.test'],'theme-subject','Subject metadata matched Acme Acquisition','gmail_subject'),
   signal('sig-cal',ids['bo@design.test'],'theme-pilot','Quarterly review on the calendar','calendar')]);
 // Written after the ingest so the quote characters survive verbatim.
 f.db.prepare('UPDATE theme_signals SET summary=? WHERE id=?').run('Ask: “we need a pilot partner”','sig-ada');
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
  const meetingEdge=(slice:{edges:{a:string;b:string;types:string[];contexts:string[]}[]})=>slice.edges.find(e=>[e.a,e.b].sort().join()==='ada@work.test,cia@meet.test')!;
  assert.ok(meetingEdge(all).types.includes('shared_meeting'));
  assert.ok(all.signals.some(s=>s.summary.includes('we need a pilot partner')),'statements carry the quote');
  assert.ok(!all.signals.some(s=>s.sourceType==='public_url'),'public-source evidence is never shared');
  assert.ok(!all.signals.some(s=>s.summary==='OBSIDIAN FREE TEXT'),'obsidian note text is never shared, even at statements');
  assert.ok(all.themes.some(t=>t.id==='theme-pilot'&&t.name==='Pilot Rollout'));

  const names=await service.exportSlice({kind:'all'},'names');
  assert.deepEqual(names.signals,[]);assert.deepEqual(names.themes,[]);
  assert.equal(names.people.length,3,'names still carries people and edges');
  assert.ok(names.edges.length>0);
  assert.ok(names.edges.every(e=>e.contexts.length===0),'at names an edge carries types and weight only');

  const themes=await service.exportSlice({kind:'all'},'themes');
  assert.ok(themes.themes.some(t=>t.id==='theme-pilot'));
  assert.ok(themes.signals.some(s=>s.summary==='Meeting matched Agent Memory'),'theme-level topic signals survive');
  assert.ok(themes.signals.some(s=>s.summary==='Quarterly review on the calendar'),'calendar signals survive at themes');
  assert.ok(!themes.signals.some(s=>s.summary.includes('we need a pilot partner')),'person-attached statements are dropped below the statements level');
  assert.ok(!themes.signals.some(s=>s.summary==='OBSIDIAN FREE TEXT'),'obsidian note text is never shared at themes either');

  // Raw content in edge contexts: subject lines never, meeting titles only from `themes` up.
  for(const slice of [all,names,themes])assert.ok(!JSON.stringify(slice.edges).includes('SECRET SUBJECT LINE'),'Gmail subject lines never leave the object');
  // A subject fragment is mailbox content too: it travels at no level, in no field.
  for(const slice of [all,names,themes]){
   const text=JSON.stringify(slice);
   assert.ok(!text.includes('Acme Acquisition'),'a Gmail subject theme name never leaves the object');
   assert.ok(!text.includes('Subject metadata matched'),'nor a Gmail subject signal summary');
   assert.ok(!slice.signals.some(s=>s.sourceType==='gmail_subject'),'nor a gmail_subject signal at all');
  }
  assert.deepEqual(meetingEdge(all).contexts,['Pilot sync']);
  assert.deepEqual(meetingEdge(themes).contexts,['Pilot sync']);
  assert.deepEqual(meetingEdge(names).contexts,[]);

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
  assert.equal(stranger.directRelationship,false);
  assert.equal(stranger.directLastContact,null);
  assert.equal(typeof stranger.combined,'number');
  assert.equal(graph.nodes.filter((n:any)=>n.id===ids['known@work.test']).length,1,'a person the viewer already knows stays one node');
  const known=graph.nodes.find((n:any)=>n.id===ids['known@work.test']) as any;
  assert.deepEqual(known.via,['owner@share.test']);
  assert.equal(known.lastContact,'2026-09-14T00:00:00.000Z','the later last contact wins');
  assert.equal(known.directRelationship,true);
  assert.equal(known.directLastContact,'2026-08-01T00:00:00.000Z','shared recency never overwrites the direct conversation date');
  assert.ok(!graph.nodes.some((n:any)=>n.id===ids['me@example.com']),'the viewer is never a node in their own graph');
  const edge=graph.edges.find((e:any)=>[e.source,e.target].sort().join()===[ids['known@work.test'],ids['stranger@vc.test']].sort().join()) as any;
  assert.ok(edge&&edge.types.includes('shared_via'));
  // `via` and the `share:<owner>:` evidence-ref prefix are the only places the owner's address
  // may appear; nothing else in the payload may carry an address at all.
  const scrub=(value:unknown)=>JSON.stringify(value).split('owner@share.test').join('');
  assert.ok(!scrub(graph.nodes.map((n:any)=>({...n,via:undefined}))).includes('@'),'emails never reach the nodes');
  assert.ok(!scrub(graph.edges).includes('@'),'emails never reach the edges');
  assert.ok(!scrub(graph.themeSignals).includes('@'),'emails never reach the signals');

  const evidence=graph.themeSignals.find((s:any)=>s.personId===ids['stranger@vc.test']) as any;
  assert.ok(evidence,'the shared evidence rides along in the graph payload');
  assert.equal(evidence.provenance.title,'Pilot sync','the meeting title the owner sent survives the import');
  assert.equal(evidence.provenance.canonicalUrl,'https://granola.ai/','never a link to the owner’s note');
  assert.equal(evidence.provenance.publisherHost,'granola.ai');
  assert.equal(evidence.provenance.timeBasis,'observed');

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
  const mine=await (service as any).store().snapshot('my');
  assert.ok(!mine.themes.some((t:any)=>t.themeId===row.theme_id),'nor the viewer’s own My mind lens: shared evidence is Firm-only');

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

test('a viewer never re-shares the evidence another owner shared with them',async()=>{
 const {service,db}=await viewerFixture();
 try{
  // The viewer has evidence of their own, so an empty export would prove nothing. A topic
  // signal carries no personId, so nothing but the account check keeps it from travelling on.
  const stamp=new Date().toISOString();
  await (service as any).store().ingestWithThemes(
   [{id:'theme-mine',owner:'viewer',canonicalName:'my own work',aliases:['My Own Work'],description:'Theme',status:'active',createdAt:stamp,updatedAt:stamp}],
   [{id:'sig-mine',owner:'viewer',account:'granola',themeId:'theme-mine',sourceType:'granola',visibility:'private',observedAt:'2026-09-01T00:00:00.000Z',ingestedAt:stamp,confidence:.8,
     summary:'MY OWN TOPIC',evidenceRef:'granola-note:not_1111111111aaaa#topic@agent_memory',contentHash:'h1',extractorVersion:'granola-v2'}]);
  await service.importShares([slice({signals:[...slice().signals,
   {email:null,themeId:'theme-pilot',summary:'THEIR TOPIC SIGNAL',observedAt:'2026-09-12T11:00:00.000Z',sourceType:'granola',confidence:.6}]})]);
  const onward=await service.exportSlice({kind:'all'},'statements');
  const text=JSON.stringify(onward);
  assert.ok(!text.includes('THEIR TOPIC SIGNAL'),'a shared topic signal is not re-exported');
  assert.ok(!text.includes('looking for a design partner'),'nor the other owner’s quote');
  assert.ok(!text.includes('Pilot Rollout'),'nor their theme name');
  assert.ok(!text.includes('owner@share.test'),'nor any trace of them');
  assert.deepEqual(onward.signals.map(s=>s.summary),['MY OWN TOPIC'],'the viewer’s own evidence still travels');
  assert.deepEqual(onward.themes.map(t=>t.name),['My Own Work']);
  assert.deepEqual(onward.people.map(p=>p.email),['known@work.test'],'only the viewer’s own contacts are theirs to share');
 }finally{db.close();}
});

test('a shared person with no display name is never labelled with their own address',async()=>{
 // Export: a contact whose stored "name" is only the local part of their address (routine for
 // a Cc line) must not travel as that local part — beside the domain it is the address.
 const f=fixture();f.kv.set('owner','owner');
 try{
  account(f.db,'me@example.com');
  contribution(f.db,'m1','dana@vc.test','dana','2026-09-10T00:00:00Z');
  contribution(f.db,'m2','eli@vc.test','eli@vc.test','2026-09-09T00:00:00Z');
  const exported=await f.service.exportSlice({kind:'all'},'names');
  assert.deepEqual(exported.people.map(p=>p.name),['Someone at vc.test','Someone at vc.test']);
 }finally{f.db.close();}

 // Import: the same rule at the door untrusted slices come through.
 const {service,db,ids}=await viewerFixture();
 try{
  await service.importShares([slice({people:[{email:'stranger@vc.test',name:'',lastContact:null,meetings:1}],edges:[],themes:[],signals:[]})]);
  const graph=(await service.graph())!;
  const node=graph.nodes.find((n:any)=>n.id===ids['stranger@vc.test']) as any;
  assert.equal(node.name,'Someone at vc.test');
  assert.equal(node.company,'vc.test');
  assert.notEqual(`${node.name}@${node.company}`,'stranger@vc.test','the address must not be reconstructable from name and company');
  assert.ok(!node.name.includes('stranger'),'the local part never reaches the browser');
 }finally{db.close();}
});

test('an unknown shared last contact stays null and never overwrites a later own one',async()=>{
 const {service,db,ids}=await viewerFixture();
 try{
  await service.importShares([slice({people:[
   {email:'other@vc.test',name:'Other',lastContact:null,meetings:0},
   {email:'known@work.test',name:'Known Person',lastContact:'2026-01-01T00:00:00.000Z',meetings:1}],edges:[],themes:[],signals:[]})]);
  const graph=(await service.graph())!;
  const other=await opaque('viewer','other@vc.test','identity-key');
  assert.equal((graph.nodes.find((n:any)=>n.id===other) as any).lastContact,null,'an unknown date stays null, never 1970');
  assert.equal((graph.nodes.find((n:any)=>n.id===ids['known@work.test']) as any).lastContact,'2026-08-01T00:00:00.000Z','an earlier shared date never overwrites the viewer’s own');
 }finally{db.close();}
});

test('drafting a note about a shared-only person writes to the sharing owner instead',async()=>{
 const {service,db,ids}=await viewerFixture();
 const ai=new FakeAI({response:{subject:'Intro to Stranger?',body:'Could you introduce me to Stranger Vc?'}});
 Object.assign((service as any).env,{AI:ai,THEME_MODEL});
 try{
  await service.importShares([slice({signals:[...slice().signals,
   {email:'known@work.test',themeId:'theme-pilot',summary:'Ask: “SHARED QUOTE ABOUT KNOWN”',observedAt:'2026-09-12T11:00:00.000Z',sourceType:'granola',confidence:.8,title:'Pilot sync'}]})]);
  const draft=await service.draftNote(ids['stranger@vc.test']);
  assert.equal(draft.to,'owner@share.test','the note is addressed to the sharing owner');
  assert.equal(draft.introVia,'owner@share.test');
  assert.equal(draft.name,'Stranger Vc');
  assert.ok(draft.basedOn.length>0,'the shared evidence is what the draft is based on');
  assert.equal(draft.basedOn[0].title,'Pilot sync','the shared meeting title reaches the draft');
  const system=String(ai.calls[0].input.messages[0].content);
  assert.ok(system.includes('owner@share.test')&&system.includes('Stranger Vc')&&system.includes('do not write to'),'the prompt says this is an introduction request');
  const own=await service.draftNote(ids['known@work.test']);
  assert.equal(own.to,'known@work.test','a person the viewer knows is still addressed directly');
  assert.equal(own.introVia,null);
  // A draft addressed to the person must never quote another owner's notes about them.
  assert.ok(!JSON.stringify(own.basedOn).includes('SHARED QUOTE'),'another owner’s quote never backs a draft written to its subject');
  assert.ok(!JSON.stringify(ai.calls.at(-1)).includes('SHARED QUOTE'),'nor reaches the model that writes it');
 }finally{db.close();}
});

test('a search never sends another owner’s shared evidence to Jev',async()=>{
 const {service,db}=await viewerFixture();
 Object.assign((service as any).env,{TYPESAFE_API_KEY:'jev-key'});
 try{
  const stamp=new Date().toISOString();
  const known=await opaque('viewer','known@work.test','identity-key');
  await (service as any).store().ingestWithThemes(
   [{id:'theme-mine',owner:'viewer',canonicalName:'pilot rollout',aliases:['Pilot Rollout'],description:'Theme',status:'active',createdAt:stamp,updatedAt:stamp}],
   [{id:'sig-mine',owner:'viewer',account:'granola',personId:known,themeId:'theme-mine',sourceType:'granola',visibility:'private',observedAt:'2026-09-01T00:00:00.000Z',ingestedAt:stamp,confidence:.8,
     summary:'MY OWN PILOT NOTE',evidenceRef:'granola-note:not_1111111111aaaa#summary@1',contentHash:'h1',extractorVersion:'granola-v2'}]);
  await service.importShares([slice({signals:[...slice().signals,
   {email:'known@work.test',themeId:'theme-pilot',summary:'Ask: “SHARED QUOTE ABOUT KNOWN”',observedAt:'2026-09-12T11:00:00.000Z',sourceType:'granola',confidence:.8,title:'SHARED MEETING TITLE'}],
   edges:[{a:'known@work.test',b:'stranger@vc.test',weight:2,types:['shared_meeting'],contexts:['SHARED EDGE CONTEXT']}]})]);
  const jev=jevServer(id=>id.startsWith('r')?scoreA(1):noulA(0.5));
  const value=await withFetch(jev.fake,()=>service.searchPeople('pilot'));
  assert.equal(value.checked,true);
  const sent=JSON.stringify(jev.requests);
  assert.ok(sent.includes('MY OWN PILOT NOTE'),'the viewer’s own evidence still goes with them');
  assert.ok(!sent.includes('SHARED QUOTE ABOUT KNOWN'),'another owner’s quote never leaves to a third party');
  assert.ok(!sent.includes('SHARED MEETING TITLE'),'nor their meeting title');
  assert.ok(!sent.includes('SHARED EDGE CONTEXT'),'nor a shared edge context');
 }finally{db.close();}
});

test('a shared person cached under a bare local-part name before the placeholder rule still renders safely',async()=>{
 // Rows imported by an earlier build carry the local part as the name; the display door must
 // not rely on the import door having been fixed first.
 const {service,db,ids}=await viewerFixture();
 try{
  db.prepare('INSERT INTO shared_people (owner,email,name,last_contact,meetings) VALUES (?,?,?,?,?)').run('owner@share.test','stranger@vc.test','stranger',null,1);
  const graph=(await service.graph())!;
  const node=graph.nodes.find((n:any)=>n.id===ids['stranger@vc.test']) as any;
  assert.equal(node.name,'Someone at vc.test');
  assert.ok(!node.name.includes('stranger'),'the local part never reaches the browser');
 }finally{db.close();}
});

test('own graph timeline includes dated email and visible meetings without private addresses',async()=>{
 const f=await ownerFixture();
 const graph=await f.service.graph();
 const events=(graph as any).activity;
 assert.ok(events.some((e:any)=>e.kind==='email'&&e.title==='Pilot rollout plan'));
 assert.ok(events.some((e:any)=>e.kind==='meeting'&&e.title==='Pilot sync'));
 assert.ok(events.every((e:any)=>e.personIds.every((id:string)=>graph!.nodes.some(n=>n.id===id))));
 assert.ok(!JSON.stringify(events).includes('ada@work.test'));
 f.db.prepare('UPDATE granola_notes SET hidden=1').run();
 assert.ok(!(await f.service.graph() as any).activity.some((e:any)=>e.kind==='meeting'));
});

test('person feedback persists, applies once, reverses, and rejects unknown people',async()=>{
 const {service,db,ids}=await ownerFixture();
 try {
  const id=ids['ada@work.test'];
  const before=(await service.graph())!.nodes.find(n=>n.id===id)!.combined;
  await service.setPersonFeedback(id,'suppress');
  await service.setPersonFeedback(id,'suppress');
  let graph=await service.graph();
  assert.equal(graph!.nodes.find(n=>n.id===id)!.combined,Math.max(0,before-10));
  assert.equal(graph!.personFeedback[id].action,'suppress');
  await service.setPersonFeedback(id,'clear');
  assert.equal((await service.graph())!.nodes.find(n=>n.id===id)!.combined,before);
  await service.setPersonFeedback(id,'boost');
  await service.setPersonFeedback(id,'snooze');
  assert.equal((await service.graph())!.nodes.find(n=>n.id===id)!.combined,Math.min(100,before+10),'snooze keeps the existing score adjustment');
  await assert.rejects(service.setPersonFeedback('unknown','boost'),/unknown_person/);
 } finally {db.close();}
});
