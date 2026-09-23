import type {MailEnv} from './mail-sync';
import {SHARE_CAPS,normalizeShareLevel,normalizeShareScope} from './network-share';
import type {ShareScope,SharedSlice} from './network-share';

/**
 * Network sharing — the Worker half. The Durable Objects already know how to export and import
 * a slice (`src/network-share.ts`, `MailSync.exportSlice/importShares/dropShare`); this file
 * holds the global index of who shares what with whom, the routes the owner and the viewer
 * drive it with, and the refresh the viewer's graph load triggers.
 *
 * The index lives in D1 because it is the one fact neither object owns: the owner's object
 * cannot enumerate its viewers cheaply and the viewer's object must not be trusted about who
 * shares with it. Addresses in `shares` are lowercased Google sign-in emails, the same key the
 * `MAIL` namespace is addressed by, and they never reach a browser except the viewer's own
 * `via` list (see the Task 1 notes).
 */
export interface ShareEnv extends MailEnv {DB:D1Database}

// An opaque node id is base64url SHA-256 — 43 characters, ~46 bytes inside a JSON array — so a
// full 200-person selection from the picker costs about 9 KB. 16 KB carries it with room over.
const MAX_BODY=16*1024;
/** An owner may share with this many viewers; the plan's per-viewer cap is `SHARE_CAPS.owners`. */
const MAX_OUTGOING=50;
/** How often one (owner, viewer) pair may push immediately; the row write is never throttled. */
const PUSH_INTERVAL_MS=60_000;
/** A viewer's graph load refreshes at most this often, and one run may take at most this long. */
const REFRESH_INTERVAL_MS=10*60*1000,REFRESH_BUDGET_MS=20_000;
let refreshBudgetMs=REFRESH_BUDGET_MS;
/** Test-only hook: shrink the refresh budget. Pass null to restore the real one. */
export function __setRefreshBudgetForTests(ms:number|null):void{refreshBudgetMs=ms??REFRESH_BUDGET_MS;}
const EMAIL=/^[^\s@,<>"']+@[^\s@,<>"']+\.[^\s@,<>"']+$/;
const MAX_ID=200;

const TABLE=`CREATE TABLE IF NOT EXISTS shares (owner_email TEXT NOT NULL, viewer_email TEXT NOT NULL, scope TEXT NOT NULL, level TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_email, viewer_email))`;
const INDEX=`CREATE INDEX IF NOT EXISTS shares_viewer ON shares(viewer_email, hidden)`;
/** Per-isolate memo: the DDL runs once per isolate, not once per request. */
const ready=new WeakMap<object,Promise<void>>();
function ensureShares(db:D1Database):Promise<void>{
 let pending=ready.get(db);
 if(!pending){
  pending=(async()=>{await db.prepare(TABLE).run();await db.prepare(INDEX).run();})()
   .catch(cause=>{ready.delete(db);throw cause;});
  ready.set(db,pending);
 }
 return pending;
}
/**
 * Per-isolate record of the last refresh attempt per viewer. `shared_meta.refreshed_at` only
 * moves when an import succeeded, so without this a viewer whose only owner keeps failing would
 * spend the whole 20 s budget on every single graph load.
 */
const attempted=new Map<string,number>();
function markAttempt(viewer:string,at:number){if(attempted.size>1000)attempted.clear();attempted.set(viewer,at);}

interface ShareRow {owner_email:string;viewer_email:string;scope:string;level:string;created_at:number;updated_at:number;hidden:number}

export const isSharePath=(pathname:string)=>pathname==='/api/shares'||pathname==='/api/shares/hide';

/**
 * `/api/shares` (owner: list, create, revoke) and `/api/shares/hide` (viewer: decline or accept
 * again). `me` is the session's Google email; every row is scoped to it on one side or the other,
 * so a caller can only ever change a share they are party to.
 */
export async function shareRoute(request:Request,env:ShareEnv,me:string):Promise<Response>{
 const url=new URL(request.url),method=request.method;
 if(url.pathname==='/api/shares'&&method==='GET')return await listShares(env,me);
 if(method!=='POST'&&!(url.pathname==='/api/shares'&&method==='DELETE'))return json({error:'method_not_allowed'},405);
 if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
 let body:Record<string,unknown>|null;
 try{body=await readBody(request);}catch{return json({error:'request_too_large'},413);}
 if(!body)return invalid();
 try{
  if(url.pathname==='/api/shares/hide')return await hideShare(env,me,body);
  if(method==='DELETE')return await revokeShare(env,me,body);
  return await createShare(env,me,body);
 }catch(cause){
  if(cause instanceof Error&&cause.message==='invalid_share')return invalid();
  throw cause;
 }
}

/** GET /api/shares — what this person shares out, and what is shared with them. */
async function listShares(env:ShareEnv,me:string):Promise<Response>{
 await ensureShares(env.DB);
 const [outgoing,incoming]=await Promise.all([outgoingRows(env.DB,me),incomingRows(env.DB,me,true)]);
 return json({
  outgoing:outgoing.slice(0,MAX_OUTGOING).flatMap(row=>{
   const scope=readScope(row.scope);
   return scope?[{viewerEmail:row.viewer_email,scope,level:row.level,updatedAt:Number(row.updated_at)||0}]:[];
  }),
  incoming:incoming.map(row=>({ownerEmail:row.owner_email,level:row.level,updatedAt:Number(row.updated_at)||0,hidden:Boolean(row.hidden)})),
 });
}

/**
 * POST /api/shares — create or change one outgoing share, then push it: the owner's object
 * exports the slice and the viewer's object imports it, so the viewer sees the people on their
 * next graph load instead of waiting up to ten minutes for a refresh. A viewer who declined this
 * owner keeps their decision — the row is updated, but nothing is pushed at them.
 */
async function createShare(env:ShareEnv,owner:string,body:Record<string,unknown>):Promise<Response>{
 const viewer=readEmail(body.viewerEmail);
 if(!viewer||viewer===owner)return invalid();
 const level=normalizeShareLevel(body.level),scope=readShareScope(body.scope);
 await ensureShares(env.DB);
 const rows=await outgoingRows(env.DB,owner);
 const existing=rows.find(row=>row.viewer_email===viewer);
 if(!existing&&rows.length>=MAX_OUTGOING)return json({error:'share_limit',message:`You can share with at most ${MAX_OUTGOING} people.`},409);
 // The viewer's own cap, enforced here as well as on their refresh: a twenty-first owner would
 // otherwise be pushed straight into their object and go missing at their next refresh anyway.
 // Hidden rows count — a share a viewer declined is still a share they hold.
 if(!existing){
  const incoming=await incomingRows(env.DB,viewer,true);
  if(incoming.length>=SHARE_CAPS.owners)return json({error:'viewer_limit',message:'That person already receives the maximum number of shared networks.'},409);
 }
 const now=Date.now();
 await env.DB.prepare(`INSERT INTO shares (owner_email, viewer_email, scope, level, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(owner_email, viewer_email) DO UPDATE SET scope = excluded.scope, level = excluded.level, updated_at = excluded.updated_at`)
  .bind(owner,viewer,JSON.stringify(scope),level,now,now).run();
 // The viewer declined this owner earlier; changing the share does not undo that.
 if(existing?.hidden)return json({ok:true,people:0});
 // An import rewrites the viewer's whole cached copy of this owner and drops their graph blob,
 // so one owner must not be able to loop this route. Inside the cooldown the row still changes;
 // only the immediate push waits for the viewer's own refresh.
 if(existing&&now-(Number(existing.updated_at)||0)<PUSH_INTERVAL_MS)return json({ok:true,people:null});
 // The row is the share; the push below is only how the viewer sees it without waiting for
 // their next refresh. A failure here surfaces as a 500 and the share still stands — the
 // viewer's refresh picks it up, and the owner retrying is an idempotent upsert.
 const ownerStub=env.MAIL.getByName(owner);
 await ownerStub.bindOwner(owner);
 const slice=await ownerStub.exportSlice(scope,level);
 const viewerStub=env.MAIL.getByName(viewer);
 await viewerStub.bindOwner(viewer);
 const {people}=await viewerStub.importShares([slice]);
 return json({ok:true,people});
}

/** DELETE /api/shares — the owner revokes. The viewer's cached copy goes now, not on a refresh. */
async function revokeShare(env:ShareEnv,owner:string,body:Record<string,unknown>):Promise<Response>{
 const viewer=readEmail(body.viewerEmail);
 if(!viewer||viewer===owner)return invalid();
 await ensureShares(env.DB);
 const deleted=await env.DB.prepare('DELETE FROM shares WHERE owner_email = ? AND viewer_email = ?').bind(owner,viewer).run();
 // Nothing was deleted: this owner never shared with that address, and asking the namespace for
 // it would create a Durable Object for any string the owner cares to type.
 if(!Number(deleted.meta?.changes))return json({ok:true});
 await env.MAIL.getByName(viewer).dropShare(owner);
 return json({ok:true});
}

/**
 * POST /api/shares/hide — the viewer declines a share, or takes it back. Hiding drops the cached
 * copy at once; unhiding refreshes straight away rather than leaving an empty share on screen.
 */
async function hideShare(env:ShareEnv,viewer:string,body:Record<string,unknown>):Promise<Response>{
 const owner=readEmail(body.ownerEmail);
 if(!owner||owner===viewer||typeof body.hidden!=='boolean')return invalid();
 await ensureShares(env.DB);
 const existing=await env.DB.prepare('SELECT hidden FROM shares WHERE owner_email = ? AND viewer_email = ?').bind(owner,viewer).first<{hidden:number}>();
 if(!existing)return json({error:'unknown_share',message:'That share is no longer available.'},404);
 await env.DB.prepare('UPDATE shares SET hidden = ?, updated_at = ? WHERE owner_email = ? AND viewer_email = ?').bind(body.hidden?1:0,Date.now(),owner,viewer).run();
 if(body.hidden)await env.MAIL.getByName(viewer).dropShare(owner);
 else await refreshShares(env,viewer,true);
 return json({ok:true});
}

/**
 * The viewer's cached copy of every incoming share, brought up to date. Called on the viewer's
 * graph load and when they un-hide a share. Nothing here may fail the graph: one owner's object
 * being unavailable means their people are a few minutes stale, not that the viewer's own graph
 * is gone, so every failure is swallowed and nothing about it is logged.
 */
export function refreshShares(env:ShareEnv,viewer:string,force=false):Promise<void>{
 // Two graph loads must not run two refreshes at the same viewer's object: the second joins the
 // first rather than re-exporting every owner. A forced refresh (an un-hide) joins only while the
 // running pass has not yet read the share rows, since that read will then see the un-hide; once
 // the rows are read the pass is stale for it, so it waits its turn and runs its own.
 const running=inflight.get(viewer);
 if(running&&(!force||!running.readRows))return running.run;
 const entry:Inflight={run:Promise.resolve(),readRows:false};
 entry.run=(running?.run??Promise.resolve()).then(()=>runRefresh(env,viewer,force,entry)).finally(()=>{if(inflight.get(viewer)===entry)inflight.delete(viewer);});
 inflight.set(viewer,entry);
 return entry.run;
}
interface Inflight{run:Promise<void>;readRows:boolean}
const inflight=new Map<string,Inflight>();
async function runRefresh(env:ShareEnv,viewer:string,force:boolean,entry:Inflight):Promise<void>{
 try{
  const stub=env.MAIL.getByName(viewer);
  const meta=await stub.sharedMeta();
  const now=Date.now();
  if(!force&&now-Math.max(Number(meta.refreshedAt)||0,attempted.get(viewer)??0)<REFRESH_INTERVAL_MS)return;
  markAttempt(viewer,now);
  await ensureShares(env.DB);
  entry.readRows=true;
  const rows=await incomingRows(env.DB,viewer,false);
  const live=new Set(rows.map(row=>row.owner_email));
  // Anyone whose cached copy is here but who no longer shares — revoked, or hidden by the
  // viewer — goes. This runs before the import so that a failing ingest cannot leave a revoked
  // owner's people on screen; an owner whose export fails is still sharing, so their copy stays.
  for(const cached of meta.owners)if(!live.has(cached))await stub.dropShare(cached);
  const deadline=now+refreshBudgetMs;
  const slices:SharedSlice[]=[];
  for(const row of rows){
   if(Date.now()>deadline)break;
   const owner=row.owner_email;
   if(owner===viewer)continue;
   try{
    const scope=readScope(row.scope),level=normalizeShareLevel(row.level);
    if(!scope)continue;
    const ownerStub=env.MAIL.getByName(owner);
    // One owner whose object never answers must cost this refresh its remaining budget, not
    // the whole request: past the deadline they are skipped exactly as a thrown export is.
    slices.push(await withDeadline((async()=>{await ownerStub.bindOwner(owner);return await ownerStub.exportSlice(scope,level);})(),deadline-Date.now()));
   }catch{/* this owner stays as it was; the others still refresh */}
  }
  if(slices.length){await stub.bindOwner(viewer);await stub.importShares(slices);}
 }catch{/* a refresh never fails the graph */}
}
/** `promise`, or a rejection once `ms` have passed. The timer is cleared whichever way it ends. */
function withDeadline<T>(promise:Promise<T>,ms:number):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('timeout')),Math.max(0,ms));
  promise.then(value=>{clearTimeout(timer);resolve(value);},cause=>{clearTimeout(timer);reject(cause);});
 });
}

function outgoingRows(db:D1Database,owner:string){
 return db.prepare(`SELECT owner_email, viewer_email, scope, level, created_at, updated_at, hidden FROM shares WHERE owner_email = ? ORDER BY updated_at DESC LIMIT ${MAX_OUTGOING+1}`)
  .bind(owner).all<ShareRow>().then(result=>result.results??[]);
}
function incomingRows(db:D1Database,viewer:string,includeHidden:boolean){
 const where=includeHidden?'WHERE viewer_email = ?':'WHERE viewer_email = ? AND hidden = 0';
 return db.prepare(`SELECT owner_email, viewer_email, scope, level, created_at, updated_at, hidden FROM shares ${where} ORDER BY updated_at DESC LIMIT ${SHARE_CAPS.owners}`)
  .bind(viewer).all<ShareRow>().then(result=>result.results??[]);
}

async function readBody(request:Request):Promise<Record<string,unknown>|null>{
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>MAX_BODY)throw new TooLarge();
 const raw=await request.text();
 if(raw.length>MAX_BODY)throw new TooLarge();
 try{const parsed=JSON.parse(raw);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:null;}catch{return null;}
}
/** A sign-in address, lowercased the way the `MAIL` namespace and D1 key it. */
function readEmail(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const email=value.trim().toLowerCase();
 return email.length<=320&&EMAIL.test(email)?email:null;
}
/**
 * The scope the owner asked for. `normalizeShareScope` bounds and de-duplicates it; this adds
 * the rules the route owes the caller — an empty selection is a mistake, not "share nothing",
 * a `personIds` entry is one of the owner's own opaque node ids (never an address), and an
 * `emails` entry is a real address.
 */
function readShareScope(value:unknown):ShareScope{
 const scope=normalizeShareScope(value);
 if(scope.kind==='folders'&&!scope.ids.length)throw Error('invalid_share');
 if(scope.kind==='people'){
  if('personIds' in scope){
   if(!scope.personIds.length||scope.personIds.some(id=>id.includes('@')||id.length>MAX_ID))throw Error('invalid_share');
  }else if(!scope.emails.length||scope.emails.some(email=>!readEmail(email)))throw Error('invalid_share');
 }
 return scope;
}
function readScope(value:string):ShareScope|null{
 try{return normalizeShareScope(JSON.parse(value));}catch{return null;}
}
class TooLarge extends Error{}
const invalid=()=>json({error:'invalid_request',message:'Share request is invalid.'},400);
function json(body:unknown,status=200):Response{
 return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}
