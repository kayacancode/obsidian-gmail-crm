import {seal,unseal,opaque} from './mail-model';
import {listGranolaFolders,listGranolaNotes,getGranolaNote,getGranolaTranscript,GranolaClientError,type NoteDetail} from './granola-client';
import type {RelevanceStore} from './relevance-store';
import type {MailEnv} from './mail-sync';
import {canonicalThemeName,type Theme,type ThemeSignal} from './relevance-model';
import {GranolaExtractor,KIND_LABEL,type GranolaExtraction} from './granola-extractor';
import {GranolaJevExtractor,type JevExtraction,type JevStatement} from './granola-jev-extractor';
import {askJev,noul,jevConfigured,JevError} from './jev';
import {THEME_TOPICS,THEME_MODEL} from './theme-extractor';

export type GranolaRange='recent'|'all';
export type GranolaConnectionStatus='syncing'|'connected'|'reconnect_required'|'error';
/** One attendee address Jev thinks is a Gmail contact, waiting for the owner's decision. */
export interface GranolaIdentitySuggestion {attendeeEmail:string;attendeeName:string;contactEmail:string;contactName:string;probability:number}
export interface GranolaStatus {connected:boolean;status:GranolaConnectionStatus|null;range:GranolaRange|null;lastSync:number;nextSync:number;error:string;counts:{folders:number;notes:number;pending:number;extracted:number;failed:number;skipped:number};folders:{id:string;name:string;parentId:string|null;excluded:boolean;noteCount:number}[];identities:GranolaIdentitySuggestion[]}
/** One Gmail contact, with the name and the canonical subject themes Jev may see. Never raw subjects. */
export interface GranolaGmailContact {email:string;name:string;subjects:string[]}
export interface GranolaHooks {owner:()=>Promise<string|undefined>;store:()=>RelevanceStore;invalidateGraph:()=>Promise<void>;contacts:()=>GranolaGmailContact[]}
/** One attendee/contact pair queued for a single Jev judgment, carried in the job across ticks. */
interface IdentityPair {attendeeEmail:string;attendeeName:string;contactEmail:string;contactName:string;meetings:string[];recentSubjects:string[]}
export interface GranolaJob {phase:'folders'|'list'|'fetch'|'extract'|'identity'|'reconcile';cursor?:string;pending:{id:string;updatedAt:string}[];seenIds?:string[];identityPairs?:IdentityPair[];maxUpdated:string;retries:number;nextAttempt:number;lastRun:number;started:number;processed:number;initial:boolean;capDropped?:boolean}
interface Connection {grant:string;ownerEmail:string|null;status:GranolaConnectionStatus;range:GranolaRange;watermark:string|null;lastSync:number;nextSync:number;lastReconcile:number;error:string;job:GranolaJob|null;/** When TypeSafe first rejected the key; holds the paused state until a Jev call succeeds. */jevUnauthorizedAt?:number}

export const GRANOLA_ACCOUNT='granola';
export const LLAMA_EXTRACTOR_VERSION='granola-v2',JEV_EXTRACTOR_VERSION='granola-v3-jev';
/** Which extractor this deployment runs, and so which stored notes are stale. */
export function extractorVersion(env:{TYPESAFE_API_KEY?:string}):string{return jevConfigured(env)?JEV_EXTRACTOR_VERSION:LLAMA_EXTRACTOR_VERSION;}
const API_KEY=/^grn_[\x21-\x7e]{4,508}$/;
const FOLDER_ID=/^fol_[a-zA-Z0-9]{14}$/;
const HOUR=3_600_000,DAY=86_400_000;

export class GranolaSync {
 private static readonly FETCH_PER_TICK=5;
 private static readonly FETCH_BUDGET_MS=60_000;
 // Per-note cap on summary+privateNotes+transcript, measured in UTF-16 code units
 // (JS string .length / "characters"), not UTF-8 bytes. Do not switch to byte counting.
 private static readonly MAX_NOTE_CHARS=400*1024;
 private static readonly MAX_NOTES=20_000;
 private static readonly RECONCILE_EVERY=7*DAY;
 private static readonly NOTE_META_LIMIT=2_000;

 constructor(private readonly ctx:DurableObjectState,private readonly env:MailEnv,private readonly hooks:GranolaHooks,private readonly maxNotes:number=GranolaSync.MAX_NOTES){
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS granola_connection (id INTEGER PRIMARY KEY CHECK (id=1),grant TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS granola_folders (id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,excluded INTEGER NOT NULL DEFAULT 0,seen_at INTEGER NOT NULL);
   -- "bytes" holds a character count (summary+private_notes+transcript .length, UTF-16 code
   -- units), not a UTF-8 byte count; the column keeps its original name to avoid a migration.
   CREATE TABLE IF NOT EXISTS granola_notes (id TEXT PRIMARY KEY,title TEXT NOT NULL,web_url TEXT,meeting_at TEXT NOT NULL,date_basis TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,folder_ids TEXT NOT NULL,summary TEXT NOT NULL,private_notes TEXT NOT NULL,transcript TEXT NOT NULL,content_hash TEXT NOT NULL,bytes INTEGER NOT NULL,extraction_status TEXT NOT NULL,extraction TEXT,extractor_version TEXT NOT NULL,extraction_attempts INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS granola_notes_status ON granola_notes(extraction_status,meeting_at DESC);
   CREATE TABLE IF NOT EXISTS granola_attendees (note_id TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(note_id,email));
   CREATE INDEX IF NOT EXISTS granola_attendees_email ON granola_attendees(email);
   CREATE TABLE IF NOT EXISTS granola_edges (note_id TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(note_id,a,b));
   -- One row per attendee address ever judged: 'pending' waits for the owner, 'confirmed' folds
   -- the address into contact_email everywhere, 'dismissed' is kept so the pair is never re-asked.
   CREATE TABLE IF NOT EXISTS granola_identity (attendee_email TEXT PRIMARY KEY,contact_email TEXT NOT NULL,attendee_name TEXT NOT NULL,contact_name TEXT NOT NULL,probability REAL NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  // Added after the first release: when extraction was last attempted, so a 'failed' note
  // can be retried a week later without re-fetching it.
  if(!ctx.storage.sql.exec("SELECT name FROM pragma_table_info('granola_notes') WHERE name='extraction_attempted_at'").toArray().length)ctx.storage.sql.exec('ALTER TABLE granola_notes ADD COLUMN extraction_attempted_at INTEGER');
 }
 private read():Connection|null{const row=this.ctx.storage.sql.exec<{grant:string;data:string}>('SELECT grant,data FROM granola_connection WHERE id=1').toArray()[0];if(!row)return null;return {...JSON.parse(row.data),grant:row.grant} as Connection;}
 private write(c:Connection){const {grant,...data}=c;this.ctx.storage.sql.exec('INSERT INTO granola_connection (id,grant,data) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET grant=excluded.grant,data=excluded.data',grant,JSON.stringify(data));}
 // Every write after an await goes through commit(): a disconnect() or a fresh connect()
 // inside that window would otherwise be undone by re-inserting the row this tick started with.
 private checkRun(started:number):Connection{const row=this.read();if(!row||!row.job||row.job.started!==started)throw new StaleRun();return row;}
 private commit(c:Connection,started:number){this.checkRun(started);this.write(c);}

 async connect(apiKey:string,range:GranolaRange):Promise<GranolaStatus>{
  if(!this.env.MAIL_TOKEN_KEY)throw Error('mail_not_configured');
  if(typeof apiKey!=='string'||!API_KEY.test(apiKey))throw Error('invalid_key');
  let first:Awaited<ReturnType<typeof listGranolaFolders>>;
  try{first=await listGranolaFolders(apiKey);}// throws GranolaClientError on bad key
  catch(e){if(e instanceof GranolaClientError)throw Error('granola:'+e.failure+':'+e.diagnostic);throw e;}
  const grant=await seal(apiKey,this.env.MAIL_TOKEN_KEY);
  const old=this.read();
  const c:Connection={grant,ownerEmail:old?.ownerEmail??null,status:'syncing',range,watermark:null,lastSync:old?.lastSync??0,nextSync:0,lastReconcile:old?.lastReconcile??0,error:'',job:{phase:'folders',pending:[],maxUpdated:'',retries:0,nextAttempt:0,lastRun:0,started:Math.max(Date.now(),(old?.job?.started??0)+1),processed:0,initial:true,capDropped:false}};
  this.ctx.storage.transactionSync(()=>{this.write(c);this.upsertFolders(first.folders,Date.now());});
  return this.status();
 }
 private upsertFolders(folders:{id:string;name:string;parentFolderId:string|null}[],now:number){for(const f of folders)this.ctx.storage.sql.exec('INSERT INTO granola_folders (id,name,parent_id,excluded,seen_at) VALUES (?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,seen_at=excluded.seen_at',f.id,f.name.slice(0,200),f.parentFolderId,now);}

 status():GranolaStatus{
  const c=this.read();
  const count=(sql:string)=>this.ctx.storage.sql.exec<{n:number}>(sql).toArray()[0]?.n??0;
  const folders=this.ctx.storage.sql.exec<{id:string;name:string;parent_id:string|null;excluded:number}>('SELECT id,name,parent_id,excluded FROM granola_folders ORDER BY name ASC, id ASC').toArray();
  const noteFolders=this.ctx.storage.sql.exec<{folder_ids:string}>('SELECT folder_ids FROM granola_notes').toArray();
  const noteCount=new Map<string,number>();for(const row of noteFolders)for(const id of JSON.parse(row.folder_ids) as string[])noteCount.set(id,(noteCount.get(id)??0)+1);
  return {connected:Boolean(c),status:c?.status??null,range:c?.range??null,lastSync:c?.lastSync??0,nextSync:c?.nextSync??0,error:c?.error??'',
   counts:{folders:folders.length,notes:count('SELECT COUNT(*) AS n FROM granola_notes'),pending:count("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='pending'")+(c?.job?.pending.length??0),extracted:count("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='done'"),failed:count("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='failed'"),skipped:count("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='skipped'")},
   folders:folders.map(f=>({id:f.id,name:f.name,parentId:f.parent_id,excluded:f.excluded===1,noteCount:noteCount.get(f.id)??0})).sort((a,b)=>Number(a.excluded)-Number(b.excluded)||a.name.localeCompare(b.name)),
   identities:this.identitySuggestions()};
 }

 async setExcluded(ids:string[]):Promise<GranolaStatus>{
  if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!FOLDER_ID.test(id)))throw Error('invalid_folder');
  const known=new Set(this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM granola_folders').toArray().map(r=>r.id));
  if(ids.some(id=>!known.has(id)))throw Error('invalid_folder');
  const excluded=new Set(ids);
  let refetched=false;
  this.ctx.storage.transactionSync(()=>{
   this.ctx.storage.sql.exec('UPDATE granola_folders SET excluded=0');
   for(const id of excluded)this.ctx.storage.sql.exec('UPDATE granola_folders SET excluded=1 WHERE id=?',id);
   this.recomputeHidden(excluded);
   for(const row of this.ctx.storage.sql.exec<{id:string;folder_ids:string}>("SELECT id,folder_ids FROM granola_notes WHERE extraction_status='skipped'").toArray())if(!GranolaSync.hiddenFor(JSON.parse(row.folder_ids),excluded)){this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_status='refetch' WHERE id=?",row.id);refetched=true;}
  });
  if(refetched){const c=this.read();if(c&&c.status==='connected'){c.nextSync=Date.now();this.write(c);}}
  await this.applyHiddenSignals();
  await this.hooks.invalidateGraph();
  return this.status();
 }
 private excludedIds(){return new Set(this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM granola_folders WHERE excluded=1').toArray().map(r=>r.id));}
 static hiddenFor(folderIds:string[],excluded:Set<string>){return folderIds.length>0&&folderIds.every(id=>excluded.has(id))?1:0;}
 private recomputeHidden(excluded:Set<string>){for(const row of this.ctx.storage.sql.exec<{id:string;folder_ids:string}>('SELECT id,folder_ids FROM granola_notes').toArray())this.ctx.storage.sql.exec('UPDATE granola_notes SET hidden=? WHERE id=?',GranolaSync.hiddenFor(JSON.parse(row.folder_ids),excluded),row.id);}

 syncNow():GranolaStatus{const c=this.read();if(c&&c.status!=='syncing'&&c.status!=='reconnect_required'){c.status='connected';c.error='';c.nextSync=Date.now();this.write(c);}return this.status();}

 async disconnect():Promise<void>{
  this.ctx.storage.transactionSync(()=>{for(const t of ['granola_identity','granola_edges','granola_attendees','granola_notes','granola_folders','granola_connection'])this.ctx.storage.sql.exec(`DELETE FROM ${t}`);});
  await this.hooks.store().removeAccountData(GRANOLA_ACCOUNT);
  await this.hooks.invalidateGraph();
 }

 nextDue(now=Date.now()):number|undefined{const c=this.read();if(!c)return undefined;if(c.status==='syncing')return Math.max(now+1500,c.job?.nextAttempt??0);if(c.status==='connected')return Math.max(now+1000,c.nextSync);return undefined;}

 async tick(now=Date.now()):Promise<void>{
  let c=this.read();if(!c)return;
  if(c.status==='connected'&&c.nextSync<=now){c.status='syncing';c.error='';c.job={phase:now-c.lastReconcile>=GranolaSync.RECONCILE_EVERY&&c.watermark?'reconcile':'folders',pending:[],seenIds:[],maxUpdated:c.watermark??'',retries:0,nextAttempt:0,lastRun:0,started:now,processed:0,initial:!c.watermark,capDropped:false};this.write(c);}
  if(c.status!=='syncing'||!c.job||c.job.nextAttempt>now)return;
  const started=c.job.started;
  c.job.lastRun=now;this.write(c);
  try{
   const apiKey=await unseal(c.grant,this.env.MAIL_TOKEN_KEY!);
   if(c.job.phase==='reconcile')await this.reconcilePhase(c,apiKey,now,started);
   else if(c.job.phase==='folders')await this.foldersPhase(c,apiKey,now,started);
   else if(c.job.phase==='list')await this.listPhase(c,apiKey,now,started);
   else if(c.job.phase==='fetch')await this.fetchPhase(c,apiKey,now,started);
   else if(c.job.phase==='extract')await this.extractPhase(c,now,started);
   else if(c.job.phase==='identity')await this.identityPhase(c,now,started);
   const after=this.read();if(after?.job&&after.job.started===started){after.job.retries=0;after.job.nextAttempt=0;after.error=after.jevUnauthorizedAt?'jev_unauthorized':'';this.write(after);}
  }catch(e){
   // A disconnect or a new connect during this tick ends the run silently: retries and the
   // error belong to a job that no longer exists.
   if(e instanceof StaleRun)return;
   const current=this.read();if(!current||!current.job||current.job.started!==started)return;
   const failure=e instanceof GranolaClientError?e.failure:'unavailable';
   if(failure==='unauthorized'||failure==='forbidden'){current.status='reconnect_required';current.error='reconnect_required';current.job=null;this.write(current);return;}
   current.job.retries++;current.job.nextAttempt=now+Math.min(30*60_000,30_000*2**(current.job.retries-1));current.error=failure==='rate_limited'?'granola_rate_limited':failure==='timeout'?'granola_timeout':'granola_unavailable';
   if(current.job.retries>=12)current.status='error';
   this.write(current);
  }
 }

 private async foldersPhase(c:Connection,apiKey:string,now:number,started:number){
  let cursor:string|undefined;
  for(let i=0;i<20;i++){const page=await listGranolaFolders(apiKey,cursor);this.checkRun(started);this.ctx.storage.transactionSync(()=>this.upsertFolders(page.folders,now));if(!page.hasMore||!page.cursor)break;cursor=page.cursor;}
  this.ctx.storage.sql.exec('DELETE FROM granola_folders WHERE seen_at<?',now-7*DAY);
  this.recomputeHidden(this.excludedIds());
  this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_status='pending',extraction=NULL WHERE extraction_status='done' AND extractor_version<>?",extractorVersion(this.env));
  // A failed note is retried a week after its last attempt (its sync time for rows written
  // before that column existed): one bad model day must not drop a meeting for good.
  this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_status='pending',extraction_attempts=0 WHERE extraction_status='failed' AND COALESCE(extraction_attempted_at,synced_at)<?",now-7*DAY);
  const fresh=this.checkRun(started);fresh.job!.phase='list';fresh.job!.cursor=undefined;this.write(fresh);
 }

 private async listPhase(c:Connection,apiKey:string,now:number,started:number){
  const job=c.job!;
  const options=job.initial?(c.range==='recent'?{createdAfter:new Date(now-90*DAY).toISOString()}:{}):{updatedAfter:c.watermark??undefined};
  const page=await listGranolaNotes(apiKey,{...options,cursor:job.cursor});
  const existing=new Map(this.ctx.storage.sql.exec<{id:string;updated_at:string;extraction_status:string}>('SELECT id,updated_at,extraction_status FROM granola_notes').toArray().map(r=>[r.id,r]));
  for(const n of page.notes){
   const row=existing.get(n.id);
   if(row&&row.updated_at===n.updatedAt&&row.extraction_status!=='refetch'){
    // Unchanged notes are never queued, so it's always safe to fold their updated_at
    // into the watermark now.
    if(n.updatedAt>job.maxUpdated)job.maxUpdated=n.updatedAt;
    continue;
   }
   if(!job.pending.some(p=>p.id===n.id))job.pending.push({id:n.id,updatedAt:n.updatedAt});
  }
  job.cursor=page.hasMore&&page.cursor?page.cursor:undefined;
  if(!job.cursor){
   for(const r of this.ctx.storage.sql.exec<{id:string;updated_at:string}>("SELECT id,updated_at FROM granola_notes WHERE extraction_status='refetch'").toArray())if(!job.pending.some(p=>p.id===r.id))job.pending.push({id:r.id,updatedAt:r.updated_at});
   // The row-count cap only ever applies to brand-new notes: updates to notes already
   // stored (including refetch rows) never grow the table, so they must never be dropped.
   // `existing` (built above from the full table) already has every stored id.
   const existingIds=new Set(existing.keys());
   const total=existingIds.size;
   const newCount=job.pending.filter(p=>!existingIds.has(p.id)).length;
   if(total+newCount>this.maxNotes){
    const room=Math.max(0,this.maxNotes-total);
    let kept=0;
    job.pending=job.pending.filter(p=>{
     if(existingIds.has(p.id))return true;
     if(kept<room){kept++;return true;}
     // Dropped: this note must be listed again by a future run, so nothing this run —
     // not even another note's later updated_at — may advance the watermark. See the
     // capDropped check in finishRun.
     job.capDropped=true;
     return false;
    });
   }
   // Only fold in updated_at values for notes that actually survive to be fetched —
   // notes dropped by the cap above must stay eligible for a future incremental list.
   // (finishRun ignores maxUpdated entirely for this run when capDropped is set.)
   for(const p of job.pending)if(p.updatedAt>job.maxUpdated)job.maxUpdated=p.updatedAt;
   job.phase='fetch';
  }
  this.commit(c,started);
 }

 private async fetchPhase(c:Connection,apiKey:string,now:number,started:number){
  const job=c.job!;const excluded=this.excludedIds();const budgetStart=Date.now();let overBudget=false;
  for(let i=0;i<GranolaSync.FETCH_PER_TICK&&job.pending.length;i++){
   // Stop on the wall-clock budget: each fetched note is persisted with the shortened
   // pending list, so the next alarm resumes exactly here.
   if(Date.now()-budgetStart>GranolaSync.FETCH_BUDGET_MS){overBudget=true;break;}
   const item=job.pending[0];
   let detail:NoteDetail;
   try{detail=await getGranolaNote(apiKey,item.id);}
   catch(e){if(e instanceof GranolaClientError&&e.diagnostic==='http_4xx'){job.pending.shift();job.processed++;this.commit(c,started);continue;}throw e;}
   const hidden=GranolaSync.hiddenFor(detail.folderIds,excluded);
   // Skipped/hidden notes are stored with id, folder ids and dates only: no title, url,
   // summary, private notes or transcript, and a 0 character count.
   let summary=detail.summary,privateNotes=detail.privateNotes,transcript='',bytes=0,truncated=false;
   if(!hidden){
    // Combined summary+privateNotes must fit under the per-note cap (characters, i.e.
    // UTF-16 code units / .length — not UTF-8 bytes) before the transcript loop runs.
    if(summary.length+privateNotes.length>GranolaSync.MAX_NOTE_CHARS){
     privateNotes=privateNotes.slice(0,Math.max(0,GranolaSync.MAX_NOTE_CHARS-summary.length));
     if(summary.length>GranolaSync.MAX_NOTE_CHARS)summary=summary.slice(0,GranolaSync.MAX_NOTE_CHARS);
    }
    bytes=summary.length+privateNotes.length;
    let cursor:string|undefined;
    for(let p=0;p<64;p++){
     const page=await getGranolaTranscript(apiKey,item.id,cursor);
     const sep=transcript?1:0;// count the '\n' page separator we're about to add
     if(bytes+sep+page.text.length>GranolaSync.MAX_NOTE_CHARS){transcript+=(transcript?'\n':'')+page.text.slice(0,Math.max(0,GranolaSync.MAX_NOTE_CHARS-bytes-sep-64));bytes=Math.min(bytes+sep+page.text.length,GranolaSync.MAX_NOTE_CHARS);truncated=true;break;}
     transcript+=(transcript?'\n':'')+page.text;bytes+=sep+page.text.length;
     if(!page.hasMore||!page.cursor)break;cursor=page.cursor;
    }
    if(truncated)transcript+='\n[transcript truncated]';
   }
   const contentHash=await digestText(`${summary}\u0000${privateNotes}\u0000${transcript}`);
   // Nothing awaits between this check and the insert below, so a note fetched by a run
   // that has since been disconnected or replaced never lands in the table.
   this.checkRun(started);
   const previous=this.ctx.storage.sql.exec<{content_hash:string;extractor_version:string;extraction_status:string}>('SELECT content_hash,extractor_version,extraction_status FROM granola_notes WHERE id=?',item.id).toArray()[0];
   const unchanged=Boolean(previous&&previous.content_hash===contentHash&&previous.extractor_version===extractorVersion(this.env)&&previous.extraction_status==='done');
   const status=hidden?'skipped':unchanged?'done':'pending';
   this.ctx.storage.transactionSync(()=>{
    this.ctx.storage.sql.exec("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,web_url=excluded.web_url,meeting_at=excluded.meeting_at,date_basis=excluded.date_basis,updated_at=excluded.updated_at,folder_ids=excluded.folder_ids,summary=excluded.summary,private_notes=excluded.private_notes,transcript=excluded.transcript,content_hash=excluded.content_hash,bytes=excluded.bytes,extraction_status=excluded.extraction_status,extraction=CASE WHEN excluded.extraction_status='done' THEN granola_notes.extraction ELSE NULL END,extractor_version=excluded.extractor_version,extraction_attempts=0,synced_at=excluded.synced_at,hidden=excluded.hidden",
     item.id,hidden?'':detail.title.slice(0,300),hidden?null:detail.webUrl,detail.meetingAt,detail.dateBasis,detail.createdAt,detail.updatedAt,JSON.stringify(detail.folderIds),hidden?'':summary,hidden?'':privateNotes,transcript,contentHash,bytes,status,extractorVersion(this.env),now,hidden);
    this.ctx.storage.sql.exec('DELETE FROM granola_attendees WHERE note_id=?',item.id);this.ctx.storage.sql.exec('DELETE FROM granola_edges WHERE note_id=?',item.id);
    if(!hidden){
     for(const a of detail.attendees)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO granola_attendees VALUES (?,?,?)',item.id,a.email,a.name);
     const emails=detail.attendees.map(a=>a.email).sort();
     for(let x=0;x<emails.length;x++)for(let y=x+1;y<emails.length;y++)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO granola_edges VALUES (?,?,?)',item.id,emails[x],emails[y]);
    }
   });
   if(status!=='done')await this.removeNoteSignals(item.id);
   if(detail.ownerEmail&&!c.ownerEmail)c.ownerEmail=detail.ownerEmail;
   job.pending.shift();job.processed++;this.commit(c,started);
  }
  await this.hooks.invalidateGraph();
  if(!job.pending.length){job.phase='extract';this.commit(c,started);}
  else if(overBudget){job.nextAttempt=Date.now()+1_500;this.commit(c,started);}
 }

 private static readonly EXTRACT_PER_TICK=3;
 private static readonly EXTRACT_BUDGET_MS=120_000;
 private static readonly MAX_ATTEMPTS=5;

 protected async extractPhase(c:Connection,now:number,started:number):Promise<void>{
  const owner=await this.hooks.owner();if(!owner){await this.finishRun(now,started);return;}
  const budgetStart=Date.now();
  const jev=jevConfigured(this.env);
  const rows=this.ctx.storage.sql.exec<{id:string;title:string;folder_ids:string;summary:string;private_notes:string;transcript:string;meeting_at:string;content_hash:string;extraction_attempts:number}>("SELECT id,title,folder_ids,summary,private_notes,transcript,meeting_at,content_hash,extraction_attempts FROM granola_notes WHERE extraction_status='pending' AND hidden=0 ORDER BY meeting_at DESC LIMIT ?",GranolaSync.EXTRACT_PER_TICK).toArray();
  if(!rows.length){await this.endExtract(now,started);return;}
  let unavailable=0,extracted=0,unauthorizedAt=0;
  for(const row of rows){
   if(Date.now()-budgetStart>GranolaSync.EXTRACT_BUDGET_MS)break;
   const attendees=this.ctx.storage.sql.exec<{email:string;name:string}>('SELECT email,name FROM granola_attendees WHERE note_id=?',row.id).toArray();
   let extraction:GranolaExtraction|JevExtraction;
   const remainingMs=GranolaSync.EXTRACT_BUDGET_MS-(Date.now()-budgetStart);
   const signal=AbortSignal.timeout(Math.max(1_000,Math.min(remainingMs,180_000)));
   const text={summary:row.summary,privateNotes:row.private_notes,transcript:row.transcript,attendees};
   const attemptedAt=Date.now();
   this.ctx.storage.sql.exec('UPDATE granola_notes SET extraction_attempted_at=? WHERE id=?',attemptedAt,row.id);
   try{extraction=jev
    ?await new GranolaJevExtractor(this.env).extract({...text,title:row.title,folders:this.jevFolders(row.folder_ids)},signal)
    :await new GranolaExtractor(this.env.AI,this.env.THEME_MODEL).extract(text,signal);}
   catch(e){
    const attempts=row.extraction_attempts+1;
    // A rejected TypeSafe key is not a model wobble: stop this note now and say so on the card.
    if(e instanceof JevError&&e.code==='jev_unauthorized'){this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_attempts=?,extraction_status='failed' WHERE id=?",attempts,row.id);unauthorizedAt=attemptedAt;break;}
    const invalid=e instanceof JevError?e.code==='jev_invalid':e instanceof Error&&e.message==='invalid_extraction';
    const failed=attempts>=GranolaSync.MAX_ATTEMPTS||(invalid&&attempts>=2);
    this.ctx.storage.sql.exec('UPDATE granola_notes SET extraction_attempts=?,extraction_status=? WHERE id=?',attempts,failed?'failed':'pending',row.id);
    if(e instanceof JevError?e.code==='jev_unavailable'||e.code==='jev_rate_limited':e instanceof Error&&e.message==='ai_unavailable')unavailable++;
    continue;
   }
   this.checkRun(started);
   await this.ingestExtraction(owner,row.id,row.meeting_at,row.content_hash,extraction,attendees);
   this.checkRun(started);
   this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_status='done',extraction=?,extraction_attempts=?,extractor_version=? WHERE id=? AND content_hash=?",JSON.stringify(extraction),row.extraction_attempts+1,extractorVersion(this.env),row.id,row.content_hash);
   extracted++;
   // A Jev call that works ends the paused state and re-queues everything the rejected key
   // failed, so fixing the secret does not leave those meetings waiting for the 7-day sweep.
   if(jev){
    const paused=this.read();
    if(paused?.jevUnauthorizedAt){
     this.ctx.storage.sql.exec("UPDATE granola_notes SET extraction_status='pending',extraction_attempts=0 WHERE extraction_status='failed' AND extraction_attempted_at>=?",paused.jevUnauthorizedAt);
     paused.jevUnauthorizedAt=undefined;paused.error='';this.commit(paused,started);
    }
   }
  }
  // One rejected note is one attempt, not an outage: only a missing or mismatched binding,
  // or a tick where every attempt failed with ai_unavailable, ends the run early.
  const aiDown=Boolean(unauthorizedAt)||(jev?unavailable>0&&!extracted:!this.env.AI||this.env.THEME_MODEL!==THEME_MODEL||(unavailable>0&&!extracted));
  const remaining=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM granola_notes WHERE extraction_status='pending' AND hidden=0").toArray()[0].n;
  // The latch is written before any early return, and holds the earliest rejection time.
  if(unauthorizedAt){const paused=this.read();if(paused){paused.jevUnauthorizedAt??=unauthorizedAt;paused.error='jev_unauthorized';this.commit(paused,started);}}
  const c2=this.read();if(!c2||!c2.job)return;
  // When the model is unavailable, end this run; pending notes retry on the next hourly run (one attempt per run, five runs to 'failed').
  if(!remaining||aiDown)await this.endExtract(now,started,aiDown);
  else {c2.job.nextAttempt=Date.now()+1_500;this.commit(c2,started);}
 }

 /** The note's folders that still have a row, as {id,name} for the Jev theme choice. */
 private jevFolders(folderIds:string):{id:string;name:string}[]{
  let ids:unknown;try{ids=JSON.parse(folderIds);}catch{return [];}
  if(!Array.isArray(ids))return [];
  const folders:{id:string;name:string}[]=[];
  for(const id of ids.slice(0,50)){const row=this.ctx.storage.sql.exec<{id:string;name:string}>('SELECT id,name FROM granola_folders WHERE id=?',id).toArray()[0];if(row)folders.push({id:row.id,name:row.name});}
  return folders;
 }

 private async ingestExtraction(owner:string,noteId:string,meetingAt:string,contentHash:string,extraction:GranolaExtraction|JevExtraction,attendees:{email:string;name:string}[]){
  await this.removeNoteSignals(noteId);
  // The stored extraction, not the current env, decides how its numbers are read: a note
  // extracted by Llama keeps its fixed confidences until it is re-extracted by Jev.
  const jev=(extraction as JevExtraction).engine==='jev';
  const version=jev?JEV_EXTRACTOR_VERSION:LLAMA_EXTRACTOR_VERSION;
  const modelId=jev?this.env.JEV_MODEL??'jev-latest':THEME_MODEL;
  const now=new Date().toISOString();const themes=new Map<string,Theme>();const signals:(ThemeSignal&{account:string})[]=[];
  const topicTheme=async(topicId:keyof typeof THEME_TOPICS)=>{const topic=THEME_TOPICS[topicId];const id='theme-'+await opaque(owner,`body-topic:${topicId}`,this.env.TOKEN_SECRET);themes.set(id,{id,owner,canonicalName:canonicalThemeName(topic.name),aliases:[topic.name],description:topic.summary,status:'active',createdAt:now,updatedAt:now});return id;};
  let best:{id:string;confidence:number}|null=null;
  for(const t of extraction.topics){
   const themeId=await topicTheme(t.topicId);
   if(!best||t.confidence>best.confidence)best={id:themeId,confidence:t.confidence};
   signals.push({id:await opaque(owner,`granola-topic:${noteId}:${t.topicId}:${contentHash}`,this.env.TOKEN_SECRET),owner,account:GRANOLA_ACCOUNT,themeId,sourceType:'granola',visibility:'private',observedAt:meetingAt,ingestedAt:now,confidence:t.confidence,summary:`Meeting matched ${THEME_TOPICS[t.topicId].name}`,evidenceRef:`granola-note:${noteId}#topic@${t.topicId}`,contentHash,extractorVersion:version,modelId});
  }
  // The first folder id of the note that still has a row in granola_folders (folders drop off
  // after 7 days unseen) names the theme for its statements, ahead of the best topic match.
  let folderThemeId:string|null=null;
  const noteRow=this.ctx.storage.sql.exec<{folder_ids:string}>('SELECT folder_ids FROM granola_notes WHERE id=?',noteId).toArray()[0];
  if(noteRow){
   // A confident Jev folder choice is tried first; everything else keeps the first-folder rule.
   const folderIds=JSON.parse(noteRow.folder_ids) as string[];
   const chosen=jev?(extraction as JevExtraction).themeChoice:undefined;
   const ordered=chosen&&chosen.kind==='folder'&&chosen.probability>=0.5&&folderIds.includes(chosen.id)?[chosen.id,...folderIds]:folderIds;
   for(const folderId of ordered){
    const folder=this.ctx.storage.sql.exec<{id:string;name:string}>('SELECT id,name FROM granola_folders WHERE id=?',folderId).toArray()[0];
    if(!folder)continue;
    const id='theme-'+await opaque(owner,`granola-folder:${folderId}`,this.env.TOKEN_SECRET);
    themes.set(id,{id,owner,canonicalName:canonicalThemeName(folder.name)||'meetings',aliases:[folder.name],description:`Meetings in your Granola folder ${folder.name}`,status:'active',createdAt:now,updatedAt:now});
    folderThemeId=id;break;
   }
  }
  let fallback:string|null=null;
  const alias=this.aliases();
  const own=this.read()?.ownerEmail;const emails=new Set(attendees.map(a=>a.email).filter(email=>email!==own));
  for(const s of extraction.statements){
   if(!emails.has(s.email))continue;
   let themeId=folderThemeId??best?.id;
   if(!themeId){fallback??='theme-'+await opaque(owner,'granola-meetings',this.env.TOKEN_SECRET);themeId=fallback;themes.set(themeId,{id:themeId,owner,canonicalName:'meetings',aliases:['Meetings'],description:'Statements from meeting notes without a matched topic',status:'active',createdAt:now,updatedAt:now});}
   const personId=await opaque(owner,alias.get(s.email)??s.email,this.env.TOKEN_SECRET);
   signals.push({id:await opaque(owner,`granola-statement:${noteId}:${s.email}:${s.kind}:${s.source}:${s.offset}:${contentHash}`,this.env.TOKEN_SECRET),owner,account:GRANOLA_ACCOUNT,personId,themeId,sourceType:'granola',visibility:'private',observedAt:meetingAt,ingestedAt:now,confidence:jev?heat(s as JevStatement):s.source==='summary'?0.8:s.source==='private_notes'?0.7:0.6,summary:`${KIND_LABEL[s.kind]}: “${s.quote}”`.slice(0,240),evidenceRef:`granola-note:${noteId}#${s.source}@${s.offset}`,contentHash,extractorVersion:version,modelId});
  }
  await this.hooks.store().ingestWithThemes([...themes.values()],signals);
 }

 protected async applyHiddenSignals():Promise<void>{
  const owner=await this.hooks.owner();if(!owner)return;
  for(const row of this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM granola_notes WHERE hidden=1").toArray())await this.removeNoteSignals(row.id);
  // One query for every note that still has signals, not one LIKE scan per visible note:
  // a folder toggle is a UI action and must not cost O(notes x signals).
  const present=this.hooks.store().granolaNoteIdsWithSignals(GRANOLA_ACCOUNT,owner);
  for(const row of this.ctx.storage.sql.exec<{id:string;meeting_at:string;content_hash:string;extraction:string}>("SELECT id,meeting_at,content_hash,extraction FROM granola_notes WHERE hidden=0 AND extraction_status='done' AND extraction IS NOT NULL").toArray()){
   if(present.has(row.id))continue;
   const attendees=this.ctx.storage.sql.exec<{email:string;name:string}>('SELECT email,name FROM granola_attendees WHERE note_id=?',row.id).toArray();
   let extraction:GranolaExtraction;try{extraction=JSON.parse(row.extraction);}catch{continue;}
   await this.ingestExtraction(owner,row.id,row.meeting_at,row.content_hash,extraction,attendees);
  }
 }

 private static readonly IDENTITY_BUDGET_MS=20_000;
 private static readonly IDENTITY_MAX_PAIRS=50;
 private static readonly IDENTITY_MAX_CONTACTS=3;
 private static readonly IDENTITY_THRESHOLD=0.6;
 private static readonly IDENTITY_ATTENDEE_LIMIT=5_000;

 /** Extraction is done: judge identity candidates when Jev can answer, otherwise end the run. */
 private async endExtract(now:number,started:number,skip=false){
  if(skip||!jevConfigured(this.env)){await this.finishRun(now,started);return;}
  const c=this.read();if(!c||!c.job||c.job.started!==started)return;
  c.job.phase='identity';c.job.identityPairs=undefined;c.job.nextAttempt=0;this.write(c);
 }

 /**
  * One Jev request per candidate pair, under a wall-clock budget per tick; whatever is left
  * resumes on the next alarm. A Jev failure ends the judging, never the sync.
  */
 private async identityPhase(c:Connection,now:number,started:number){
  const job=c.job!;
  if(!job.identityPairs){job.identityPairs=this.identityCandidates();this.commit(c,started);}
  const budgetStart=Date.now();
  while(job.identityPairs.length){
   if(Date.now()-budgetStart>GranolaSync.IDENTITY_BUDGET_MS)break;
   const pair=job.identityPairs[0];
   let probability:number;
   try{probability=await this.judgeIdentity(pair);}
   catch(e){if(!(e instanceof JevError))throw e;job.identityPairs=[];break;}
   // Nothing awaits between this check and the write below.
   this.checkRun(started);
   this.storeIdentity(pair,probability,Date.now());
   job.identityPairs.shift();this.commit(c,started);
  }
  if(job.identityPairs.length){job.nextAttempt=Date.now()+1_500;this.commit(c,started);return;}
  await this.finishRun(now,started);
 }

 /**
  * Attendee addresses with no Gmail contact of their own, paired with same-name contacts.
  * Code only: name normalisation and equality decide who is even worth asking about.
  */
 private identityCandidates():IdentityPair[]{
  const contacts=this.hooks.contacts();
  if(!contacts.length)return [];
  const own=new Set(this.ownEmails()),known=new Set(contacts.map(x=>x.email));
  const decided=new Set(this.ctx.storage.sql.exec<{attendee_email:string}>('SELECT attendee_email FROM granola_identity').toArray().map(r=>r.attendee_email));
  const byFull=new Map<string,GranolaGmailContact[]>(),byInitial=new Map<string,GranolaGmailContact[]>();
  const add=(index:Map<string,GranolaGmailContact[]>,key:string,contact:GranolaGmailContact)=>{const list=index.get(key);if(list)list.push(contact);else index.set(key,[contact]);};
  for(const contact of contacts){
   const tokens=nameTokens(contact.name);if(!tokens.length)continue;
   add(byFull,tokens.join(' '),contact);
   if(tokens.length>1)add(byInitial,firstAndInitial(tokens),contact);
  }
  const attendees=this.ctx.storage.sql.exec<{email:string;name:string}>('SELECT a.email AS email,MAX(a.name) AS name FROM granola_attendees a JOIN granola_notes n ON n.id=a.note_id WHERE n.hidden=0 GROUP BY a.email ORDER BY a.email ASC LIMIT ?',GranolaSync.IDENTITY_ATTENDEE_LIMIT).toArray();
  const pairs:IdentityPair[]=[];
  for(const attendee of attendees){
   if(pairs.length>=GranolaSync.IDENTITY_MAX_PAIRS)break;
   if(own.has(attendee.email)||known.has(attendee.email)||decided.has(attendee.email))continue;
   const tokens=nameTokens(attendee.name);if(!tokens.length)continue;
   const matches:GranolaGmailContact[]=[],seen=new Set<string>();
   for(const contact of [...(byFull.get(tokens.join(' '))??[]),...(tokens.length>1?byInitial.get(firstAndInitial(tokens))??[]:[])]){
    if(contact.email===attendee.email||seen.has(contact.email))continue;
    seen.add(contact.email);matches.push(contact);
    if(matches.length>=GranolaSync.IDENTITY_MAX_CONTACTS)break;
   }
   if(!matches.length)continue;
   const meetings=this.ctx.storage.sql.exec<{title:string}>('SELECT n.title AS title FROM granola_attendees a JOIN granola_notes n ON n.id=a.note_id WHERE a.email=? AND n.hidden=0 ORDER BY n.meeting_at DESC LIMIT 5',attendee.email).toArray().map(r=>r.title);
   for(const contact of matches){
    if(pairs.length>=GranolaSync.IDENTITY_MAX_PAIRS)break;
    pairs.push({attendeeEmail:attendee.email,attendeeName:attendee.name,contactEmail:contact.email,contactName:contact.name,meetings,recentSubjects:contact.subjects.slice(0,5)});
   }
  }
  return pairs;
 }

 /** One Noul per pair. The state holds names, addresses, domains, meeting titles and theme names only. */
 private async judgeIdentity(pair:IdentityPair,signal?:AbortSignal):Promise<number>{
  const state={
   attendee:{name:pair.attendeeName,email:pair.attendeeEmail,domain:domainOf(pair.attendeeEmail),meetings:pair.meetings.slice(0,5)},
   contact:{name:pair.contactName,email:pair.contactEmail,domain:domainOf(pair.contactEmail),recentSubjects:pair.recentSubjects.slice(0,5)},
  };
  const result=await askJev(this.env,state,{same_person:noul('Are `attendee` and `contact` the same person?',{
   true:'One human being reachable at both addresses: the names match allowing for nicknames, initials, middle names or a changed surname, and the meeting titles and subject themes fit one person’s work.',
   false:'Two different people, including two people who merely share a common name, or a personal and a shared or role address that belong to different humans.',
  })},signal);
  const answer=result.answers.same_person;
  return answer.type==='noul'?answer.noul:0;
 }

 /** Keeps the strongest judgment for an attendee; a decision the owner already made is never overwritten. */
 private storeIdentity(pair:IdentityPair,probability:number,now:number){
  this.ctx.storage.sql.exec("INSERT INTO granola_identity (attendee_email,contact_email,attendee_name,contact_name,probability,status,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(attendee_email) DO UPDATE SET contact_email=excluded.contact_email,attendee_name=excluded.attendee_name,contact_name=excluded.contact_name,probability=excluded.probability,status=excluded.status,updated_at=excluded.updated_at WHERE granola_identity.status<>'confirmed' AND excluded.probability>granola_identity.probability",
   pair.attendeeEmail,pair.contactEmail,pair.attendeeName.slice(0,200),pair.contactName.slice(0,200),probability,probability>=GranolaSync.IDENTITY_THRESHOLD?'pending':'dismissed',now);
 }

 /** Matches waiting for the owner, newest first. */
 identitySuggestions():GranolaIdentitySuggestion[]{
  return this.ctx.storage.sql.exec<{attendee_email:string;attendee_name:string;contact_email:string;contact_name:string;probability:number}>("SELECT attendee_email,attendee_name,contact_email,contact_name,probability FROM granola_identity WHERE status='pending' ORDER BY updated_at DESC, attendee_email ASC LIMIT 50").toArray()
   .map(r=>({attendeeEmail:r.attendee_email,attendeeName:r.attendee_name,contactEmail:r.contact_email,contactName:r.contact_name,probability:r.probability}));
 }

 /** The owner's decision: confirming moves the attendee's meetings and signals onto the contact. */
 async resolveIdentity(attendeeEmail:string,decision:'confirm'|'dismiss'):Promise<GranolaIdentitySuggestion[]>{
  if(typeof attendeeEmail!=='string'||!attendeeEmail||attendeeEmail.length>320||(decision!=='confirm'&&decision!=='dismiss'))throw Error('invalid_identity');
  if(!this.ctx.storage.sql.exec<{attendee_email:string}>("SELECT attendee_email FROM granola_identity WHERE attendee_email=? AND status='pending'",attendeeEmail).toArray().length)throw Error('invalid_identity');
  this.ctx.storage.sql.exec('UPDATE granola_identity SET status=?,updated_at=? WHERE attendee_email=?',decision==='confirm'?'confirmed':'dismissed',Date.now(),attendeeEmail);
  if(decision==='confirm')await this.reingestAttendee(attendeeEmail);
  await this.hooks.invalidateGraph();
  return this.identitySuggestions();
 }

 /** Re-ingests this attendee's notes from their stored extraction, so signals land on the contact's node. */
 private async reingestAttendee(attendeeEmail:string){
  const owner=await this.hooks.owner();if(!owner)return;
  for(const row of this.ctx.storage.sql.exec<{id:string;meeting_at:string;content_hash:string;extraction:string}>("SELECT n.id AS id,n.meeting_at AS meeting_at,n.content_hash AS content_hash,n.extraction AS extraction FROM granola_notes n JOIN granola_attendees a ON a.note_id=n.id WHERE a.email=? AND n.hidden=0 AND n.extraction_status='done' AND n.extraction IS NOT NULL",attendeeEmail).toArray()){
   const attendees=this.ctx.storage.sql.exec<{email:string;name:string}>('SELECT email,name FROM granola_attendees WHERE note_id=?',row.id).toArray();
   let extraction:GranolaExtraction;try{extraction=JSON.parse(row.extraction);}catch{continue;}
   await this.ingestExtraction(owner,row.id,row.meeting_at,row.content_hash,extraction,attendees);
  }
 }

 /** Confirmed matches, as attendee address to contact address. */
 aliases():Map<string,string>{
  return new Map(this.ctx.storage.sql.exec<{attendee_email:string;contact_email:string}>("SELECT attendee_email,contact_email FROM granola_identity WHERE status='confirmed'").toArray().map(r=>[r.attendee_email,r.contact_email]));
 }

 protected async finishRun(now:number,started:number){
  const c=this.read();if(!c||!c.job||c.job.started!==started)return;
  // If the note cap dropped anything this run, do not advance the watermark at all —
  // even a note that survived and looks safe to fold in could let a dropped note's
  // updated_at slip below the new watermark and never be listed again. The next run
  // simply re-lists from the old watermark; already-stored, unchanged notes are cheap
  // to skip by their stored updated_at, so this only costs a bit of re-listing.
  if(c.job.capDropped)c.error='note_cap_reached';
  else{if(c.job.maxUpdated)c.watermark=c.job.maxUpdated;c.error='';}
  // The rejected-key latch outranks a cleared error: only a working Jev call lifts it.
  if(c.jevUnauthorizedAt)c.error='jev_unauthorized';
  // The first full sync never goes through reconcilePhase (which is what normally
  // stamps lastReconcile), so without this the very next due sync would see a
  // 7-day-old lastReconcile of 0 and reconcile immediately instead of listing.
  if(c.job.initial)c.lastReconcile=now;
  c.status='connected';c.lastSync=now;c.nextSync=now+HOUR;c.job=null;this.commit(c,started);
  await this.hooks.invalidateGraph();
 }

 private async reconcilePhase(c:Connection,apiKey:string,now:number,started:number){
  const job=c.job!;
  const page=await listGranolaNotes(apiKey,{cursor:job.cursor});
  job.seenIds=[...(job.seenIds??[]),...page.notes.map(n=>n.id)];
  job.cursor=page.hasMore&&page.cursor?page.cursor:undefined;
  if(job.cursor){this.commit(c,started);return;}
  this.checkRun(started);
  const seen=new Set(job.seenIds);
  const gone=this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM granola_notes').toArray().map(r=>r.id).filter(id=>!seen.has(id));
  for(const id of gone){this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM granola_edges WHERE note_id=?',id);this.ctx.storage.sql.exec('DELETE FROM granola_attendees WHERE note_id=?',id);this.ctx.storage.sql.exec('DELETE FROM granola_notes WHERE id=?',id);});await this.removeNoteSignals(id);}
  const fresh=this.checkRun(started);fresh.lastReconcile=now;fresh.job!.seenIds=[];fresh.job!.phase='folders';fresh.job!.cursor=undefined;this.write(fresh);
  if(gone.length)await this.hooks.invalidateGraph();
 }

 protected async removeNoteSignals(noteId:string){await this.hooks.store().removeSignalsByEvidencePrefix(GRANOLA_ACCOUNT,`granola-note:${noteId}#`);}

 // Durable Object SQLite allows at most 100 bound parameters per query, so an IN (...) list
 // built from caller-supplied ids must be chunked rather than bound in one statement.
 private static readonly SQL_IN_CHUNK=100;

 /** Read-time meta for evidence panels: visible notes only, so hidden notes stay title-less. */
 noteMeta(noteIds:string[]){
  const out=new Map<string,{title:string;meetingAt:string;webUrl:string|null;syncedAt:number}>();
  const ids=[...new Set(noteIds)].slice(0,GranolaSync.NOTE_META_LIMIT);
  if(!ids.length)return out;
  for(let i=0;i<ids.length;i+=GranolaSync.SQL_IN_CHUNK){
   const chunk=ids.slice(i,i+GranolaSync.SQL_IN_CHUNK);
   for(const row of this.ctx.storage.sql.exec<{id:string;title:string;web_url:string|null;meeting_at:string;synced_at:number}>(`SELECT id,title,web_url,meeting_at,synced_at FROM granola_notes WHERE hidden=0 AND id IN (${chunk.map(()=>'?').join(',')})`,...chunk).toArray())out.set(row.id,{title:row.title,meetingAt:row.meeting_at,webUrl:row.web_url,syncedAt:row.synced_at});
  }
  return out;
 }

 ownEmails():string[]{const c=this.read();return c?.ownerEmail?[c.ownerEmail]:[];}
 contacts(){
  const rows=this.ctx.storage.sql.exec<{email:string;name:string;meetings:number;last:string}>('SELECT a.email AS email,MAX(a.name) AS name,COUNT(*) AS meetings,MAX(n.meeting_at) AS last FROM granola_attendees a JOIN granola_notes n ON n.id=a.note_id WHERE n.hidden=0 GROUP BY a.email ORDER BY meetings DESC, a.email ASC LIMIT 5000').toArray().map(r=>({email:r.email,name:r.name,meetings:r.meetings,last:Date.parse(r.last)}));
  const alias=this.aliases();if(!alias.size)return rows;
  const merged=new Map<string,{email:string;name:string;meetings:number;last:number}>();
  for(const row of rows){
   const email=alias.get(row.email)??row.email;
   const current=merged.get(email);
   if(!current){merged.set(email,{...row,email});continue;}
   current.meetings+=row.meetings;current.last=Math.max(current.last,row.last);
   // The contact's own row names the merged node; an attendee name only fills a gap.
   if(row.email===email||(current.name.includes('@')&&!row.name.includes('@')))current.name=row.name;
  }
  return [...merged.values()].sort((x,y)=>y.meetings-x.meetings||x.email.localeCompare(y.email));
 }
 edges(){
  const rows=this.ctx.storage.sql.exec<{a:string;b:string;title:string}>('SELECT e.a AS a,e.b AS b,n.title AS title FROM granola_edges e JOIN granola_notes n ON n.id=e.note_id WHERE n.hidden=0 ORDER BY n.meeting_at DESC, n.title ASC').toArray();
  const alias=this.aliases();const map=new Map<string,{a:string;b:string;weight:number;titles:string[]}>();
  for(const r of rows){
   let a=alias.get(r.a)??r.a,b=alias.get(r.b)??r.b;
   // A confirmed match can put both ends of a meeting edge on the same node.
   if(a===b)continue;
   if(a>b)[a,b]=[b,a];
   const key=a+'\u0000'+b;const e=map.get(key)??{a,b,weight:0,titles:[]};
   e.weight++;if(e.titles.length<3&&!e.titles.includes(r.title))e.titles.push(r.title);map.set(key,e);
  }
  return [...map.values()].sort((x,y)=>y.weight-x.weight).slice(0,5000);
 }
}

const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:0;
/** Why-now heat for a Jev statement: attendee/kind probability, time pressure and who owes whom. */
function heat(s:JevStatement):number{
 const value=0.35*num(s.probability)+0.35*num(s.urgency)+0.15*num(s.openLoop)+0.15*num(s.theirAsk);
 return Math.max(0.05,Math.min(1,value));
}

const domainOf=(email:string)=>email.slice(email.lastIndexOf('@')+1);
/** Lowercased, diacritic-free, punctuation-free name tokens: the only identity rule code decides. */
function nameTokens(name:string):string[]{
 if(typeof name!=='string'||name.includes('@'))return [];
 return name.normalize('NFKD').replace(/\p{Mark}/gu,'').toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu,' ').trim().split(/\s+/).filter(Boolean).slice(0,8);
}
const firstAndInitial=(tokens:string[])=>tokens[0]+' '+tokens[tokens.length-1][0];

/** Thrown when the connection row no longer belongs to the run that started this tick. */
class StaleRun extends Error{constructor(){super('granola_stale_run');}}
async function digestText(value:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
