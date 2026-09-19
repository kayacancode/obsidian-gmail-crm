import {seal,unseal} from './mail-model';
import {listGranolaFolders,listGranolaNotes,getGranolaNote,getGranolaTranscript,GranolaClientError,type NoteDetail} from './granola-client';
import type {RelevanceStore} from './relevance-store';
import type {MailEnv} from './mail-sync';

export type GranolaRange='recent'|'all';
export type GranolaConnectionStatus='syncing'|'connected'|'reconnect_required'|'error';
export interface GranolaStatus {connected:boolean;status:GranolaConnectionStatus|null;range:GranolaRange|null;lastSync:number;nextSync:number;error:string;counts:{folders:number;notes:number;pending:number;extracted:number;failed:number;skipped:number};folders:{id:string;name:string;parentId:string|null;excluded:boolean;noteCount:number}[]}
export interface GranolaHooks {owner:()=>Promise<string|undefined>;store:()=>RelevanceStore;invalidateGraph:()=>Promise<void>}
export interface GranolaJob {phase:'folders'|'list'|'fetch'|'extract'|'reconcile';cursor?:string;pending:{id:string;updatedAt:string}[];seenIds?:string[];maxUpdated:string;retries:number;nextAttempt:number;lastRun:number;started:number;processed:number;initial:boolean}
interface Connection {grant:string;ownerEmail:string|null;status:GranolaConnectionStatus;range:GranolaRange;watermark:string|null;lastSync:number;nextSync:number;lastReconcile:number;error:string;job:GranolaJob|null}

export const GRANOLA_ACCOUNT='granola';
export const GRANOLA_EXTRACTOR_VERSION='granola-v1';
const API_KEY=/^grn_[\x21-\x7e]{4,508}$/;
const FOLDER_ID=/^fol_[a-zA-Z0-9]{14}$/;
const HOUR=3_600_000,DAY=86_400_000;

export class GranolaSync {
 constructor(private readonly ctx:DurableObjectState,private readonly env:MailEnv,private readonly hooks:GranolaHooks){
  ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS granola_connection (id INTEGER PRIMARY KEY CHECK (id=1),grant TEXT NOT NULL,status TEXT NOT NULL,range TEXT NOT NULL,next_sync INTEGER NOT NULL DEFAULT 0,last_sync INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS granola_folders (id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,excluded INTEGER NOT NULL DEFAULT 0,seen_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS granola_notes (id TEXT PRIMARY KEY,title TEXT NOT NULL,web_url TEXT,meeting_at TEXT NOT NULL,date_basis TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,folder_ids TEXT NOT NULL,summary TEXT NOT NULL,private_notes TEXT NOT NULL,transcript TEXT NOT NULL,content_hash TEXT NOT NULL,bytes INTEGER NOT NULL,extraction_status TEXT NOT NULL,extraction TEXT,extractor_version TEXT NOT NULL,extraction_attempts INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS granola_notes_status ON granola_notes(extraction_status,meeting_at DESC);
   CREATE TABLE IF NOT EXISTS granola_attendees (note_id TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(note_id,email));
   CREATE INDEX IF NOT EXISTS granola_attendees_email ON granola_attendees(email);
   CREATE TABLE IF NOT EXISTS granola_edges (note_id TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(note_id,a,b));`);
 }
 // status/range/next_sync/last_sync/error live in real columns (setExcluded/syncNow/tick reach
 // for them via SQL directly in later tasks); the rest of Connection is a JSON blob.
 private read():Connection|null{const row=this.ctx.storage.sql.exec<{grant:string;status:GranolaConnectionStatus;range:GranolaRange;next_sync:number;last_sync:number;error:string;data:string}>('SELECT grant,status,range,next_sync,last_sync,error,data FROM granola_connection WHERE id=1').toArray()[0];if(!row)return null;const rest=JSON.parse(row.data) as Omit<Connection,'grant'|'status'|'range'|'nextSync'|'lastSync'|'error'>;return {...rest,grant:row.grant,status:row.status,range:row.range,nextSync:row.next_sync,lastSync:row.last_sync,error:row.error};}
 private write(c:Connection){const {grant,status,range,nextSync,lastSync,error,...rest}=c;this.ctx.storage.sql.exec('INSERT INTO granola_connection (id,grant,status,range,next_sync,last_sync,error,data) VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET grant=excluded.grant,status=excluded.status,range=excluded.range,next_sync=excluded.next_sync,last_sync=excluded.last_sync,error=excluded.error,data=excluded.data',grant,status,range,nextSync,lastSync,error,JSON.stringify(rest));}

 async connect(apiKey:string,range:GranolaRange):Promise<GranolaStatus>{
  if(!this.env.MAIL_TOKEN_KEY)throw Error('mail_not_configured');
  if(typeof apiKey!=='string'||!API_KEY.test(apiKey))throw Error('invalid_key');
  let first:Awaited<ReturnType<typeof listGranolaFolders>>;
  try{first=await listGranolaFolders(apiKey);}// throws GranolaClientError on bad key
  catch(e){if(e instanceof GranolaClientError)throw Error('granola:'+e.failure+':'+e.diagnostic);throw e;}
  const grant=await seal(apiKey,this.env.MAIL_TOKEN_KEY);
  const old=this.read();
  const c:Connection={grant,ownerEmail:old?.ownerEmail??null,status:'syncing',range,watermark:null,lastSync:old?.lastSync??0,nextSync:0,lastReconcile:old?.lastReconcile??0,error:'',job:{phase:'folders',pending:[],maxUpdated:'',retries:0,nextAttempt:0,lastRun:0,started:Date.now(),processed:0,initial:true}};
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
   folders:folders.map(f=>({id:f.id,name:f.name,parentId:f.parent_id,excluded:f.excluded===1,noteCount:noteCount.get(f.id)??0})).sort((a,b)=>Number(a.excluded)-Number(b.excluded)||a.name.localeCompare(b.name))};
 }

 async setExcluded(ids:string[]):Promise<GranolaStatus>{
  if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!FOLDER_ID.test(id)))throw Error('invalid_folder');
  const known=new Set(this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM granola_folders').toArray().map(r=>r.id));
  if(ids.some(id=>!known.has(id)))throw Error('invalid_folder');
  const excluded=new Set(ids);
  this.ctx.storage.transactionSync(()=>{
   this.ctx.storage.sql.exec('UPDATE granola_folders SET excluded=0');
   for(const id of excluded)this.ctx.storage.sql.exec('UPDATE granola_folders SET excluded=1 WHERE id=?',id);
   this.recomputeHidden(excluded);
  });
  await this.applyHiddenSignals();// Task 5 fills this in; stub as no-op here
  await this.hooks.invalidateGraph();
  return this.status();
 }
 private excludedIds(){return new Set(this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM granola_folders WHERE excluded=1').toArray().map(r=>r.id));}
 static hiddenFor(folderIds:string[],excluded:Set<string>){return folderIds.length>0&&folderIds.every(id=>excluded.has(id))?1:0;}
 private recomputeHidden(excluded:Set<string>){for(const row of this.ctx.storage.sql.exec<{id:string;folder_ids:string}>('SELECT id,folder_ids FROM granola_notes').toArray())this.ctx.storage.sql.exec('UPDATE granola_notes SET hidden=? WHERE id=?',GranolaSync.hiddenFor(JSON.parse(row.folder_ids),excluded),row.id);}
 protected async applyHiddenSignals():Promise<void>{}

 syncNow():GranolaStatus{const c=this.read();if(c&&c.status!=='syncing'&&c.status!=='reconnect_required'){c.status='connected';c.error='';c.nextSync=Date.now();this.write(c);}return this.status();}

 async disconnect():Promise<void>{
  this.ctx.storage.transactionSync(()=>{for(const t of ['granola_edges','granola_attendees','granola_notes','granola_folders','granola_connection'])this.ctx.storage.sql.exec(`DELETE FROM ${t}`);});
  await this.hooks.store().removeAccountData(GRANOLA_ACCOUNT);
  await this.hooks.invalidateGraph();
 }

 nextDue(now=Date.now()):number|undefined{const c=this.read();if(!c)return undefined;if(c.status==='syncing')return Math.max(now+1500,c.job?.nextAttempt??0);if(c.status==='connected')return Math.max(now+1000,c.nextSync);return undefined;}

 async tick(now=Date.now()):Promise<void>{}// Task 3
 contacts(){return [] as {email:string;name:string;meetings:number;last:number}[];}// Task 6
 edges(){return [] as {a:string;b:string;weight:number;titles:string[]}[];}// Task 6
 ownEmails(){return [] as string[];}// Task 6
}
