import {extractMailContext,type MailFact} from './gmail-context';
import {decodeGmailMessage} from './gmail-body';
import {digest,parseMessage,type GmailMessage} from './mail-model';
import {deleteHonchoLens,honchoConfigured,syncHonchoLens,HONCHO_LENS_PROJECTION_VERSION,type HonchoLensEnv,type HonchoLensEntry} from './honcho-lens';

export type OwnerLensKind='focus'|'need'|'offer';
export interface OwnerLensFields {focus:string;needs:string;offers:string}
export interface OwnerLensCollectionResult {failed:number;deferred:number}
export interface OwnerLensSuggestion {id:string;kind:OwnerLensKind;text:string;sourceIds:string[]}
export interface OwnerLensSource {id:string;text:string;observedAt:string;label:'Your sent email'|'Your note'|'Your Granola meeting'|'Meeting you attended';title?:string;url?:string|null;attribution?:'statement'|'meeting'}
export interface OwnerGranolaInput {id:string;version:string;observedAt:string;title:string;url:string|null;passages:string[];meetingPassages?:string[]}
export interface OwnerLens {
 revision:string;enabled:boolean;granolaEnabled:boolean;fields:OwnerLensFields;updatedAt:string|null;
 granolaProgress?:{available:number;checked:number;excerpts:number};
 suggestions:OwnerLensSuggestion[];sources:OwnerLensSource[];
 honcho:{configured:boolean;status:'disabled'|'unconfigured'|'pending'|'ready'|'unavailable'|'invalid';lastSync:string|null;cleanupPending:boolean;retryAt:string|null};
}
interface StoredSource extends OwnerLensSource {account:string|null;message:string;version?:string;meetingId?:string}
interface Accepted {text:string;sourceIds:string[];acceptedAt:string}
interface State extends Omit<OwnerLens,'sources'|'honcho'|'granolaProgress'> {
 generation:string;sources:StoredSource[];dismissed:string[];
 accepted:Partial<Record<keyof OwnerLensFields,Accepted>>;
 status:OwnerLens['honcho']['status'];lastSync:string|null;pendingDelete:string|null;remotePossible?:boolean;syncedSources?:string;cleanupAttempts?:number;nextCleanup?:number;projectionRequested?:boolean;projectionVersion?:number;pendingSnapshot?:{fingerprint:string;attempts:number;since:number};
}
type OwnerLensEnv=HonchoLensEnv&{AI?:Env['AI']};
export const OWNER_LENS_WINDOW=90*86400000;
const fieldsByKind={focus:'focus',need:'needs',offer:'offers'} as const;
const stamp=()=>new Date().toISOString();
const signature=(entry:Pick<HonchoLensEntry,'kind'|'text'>)=>entry.kind+':'+entry.text.trim().replace(/\s+/g,' ').toLocaleLowerCase();

export type OwnerLensDiagnosticStage='selection'|'collection'|'token-unseal'|'token-refresh'|'gmail-read'|'mail-processing'|'mail-extraction'|'source-store'|'note-extraction'|'cleanup'|'honcho'|'suggestion-store';
const diagnosticCodes=new Set(['invalid_extraction','ai_unavailable','invalid_response','retrieval_failed','mail_not_configured','owner_lens_unavailable','owner_lens_conflict','invalid_owner_lens','reconnect_required','invalid_grant','invalid_client','invalid_request','unauthorized_client','unsupported_grant_type']);
/** Fixed stages/codes and numeric counters only. Never emit provider errors or source data. */
export function ownerLensDiagnostic(stage:OwnerLensDiagnosticStage,error:unknown,counts:{elapsedMs?:number;selected?:number;attempted?:number;sources?:number;httpStatus?:number}={}){
 const code=error instanceof Error&&diagnosticCodes.has(error.message)?error.message:error instanceof Error&&error.name==='TimeoutError'?'timeout':error instanceof Error&&error.name==='AbortError'?'aborted':'unknown';
 const data:Record<string,string|number>={event:'owner_lens_failure',stage,code};
 for(const key of ['elapsedMs','selected','attempted','sources','httpStatus'] as const){const value=counts[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)data[key]=Math.floor(value);}
 console.warn(JSON.stringify(data));
}

/** Owner-only evidence. A sent label or recipient match alone never establishes authorship. */
export async function ownerMailPassages(raw:GmailMessage,id:string,account:string,ai:Env['AI']|undefined,now=Date.now()):Promise<MailFact[]>{
 const parsed=parseMessage(raw,account),headers=raw.payload?.headers??[];
 const sender=parseMessage({...raw,payload:{headers:headers.filter(h=>h.name.toLowerCase()==='from')}},account);
 if(raw.id!==id||!parsed||parsed.date<now-OWNER_LENS_WINDOW||parsed.date>now||!sender||sender.participants.length!==1||sender.participants[0].email!==account||!parsed.participants.some(p=>p.sent>0))return [];
 if(headers.some(h=>['list-id','list-unsubscribe'].includes(h.name.toLowerCase())))return [];
 const body=decodeGmailMessage(raw,24000);
 try{return await extractMailContext(ai,body.text);}finally{body.text='';}
}

/** Private SQLite state; it is deliberately never connected to graph or workspace exports. */
export class OwnerLensStore {
 private operation:Promise<void>=Promise.resolve();
 private controller?:AbortController;
 constructor(private ctx:DurableObjectState,private env:OwnerLensEnv,private owner:()=>Promise<string|undefined>){
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owner_lens_state (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owner_lens_messages (account TEXT NOT NULL,message TEXT NOT NULL,observed INTEGER NOT NULL,PRIMARY KEY(account,message)); CREATE TABLE IF NOT EXISTS owner_lens_retries (account TEXT NOT NULL,message TEXT NOT NULL,observed INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,PRIMARY KEY(account,message)); CREATE TABLE IF NOT EXISTS owner_lens_granola (id TEXT PRIMARY KEY,version TEXT NOT NULL,observed INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS owner_lens_granola_retries (id TEXT PRIMARY KEY,version TEXT NOT NULL,observed INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL);');
 }
 private read():State{
  const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM owner_lens_state WHERE id=1').toArray()[0];
  if(row){const state=JSON.parse(row.data) as State;state.granolaEnabled=state.enabled&&state.granolaEnabled===true;return state;}
  const state:State={revision:crypto.randomUUID(),generation:crypto.randomUUID(),enabled:false,granolaEnabled:false,fields:{focus:'',needs:'',offers:''},updatedAt:null,suggestions:[],sources:[],dismissed:[],accepted:{},status:'disabled',lastSync:null,pendingDelete:null};this.write(state);return state;
 }
 private write(state:State){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_state VALUES (1,?)',JSON.stringify(state));}
 private touch(state:State,invalidate=true){state.revision=crypto.randomUUID();state.updatedAt=stamp();if(invalidate){state.generation=crypto.randomUUID();this.controller?.abort();}}
 private check(state:State,revision:string){if(typeof revision!=='string'||revision!==state.revision)throw Error('owner_lens_conflict');}
 private result(state:State):OwnerLens{
  return {revision:state.revision,enabled:state.enabled,granolaEnabled:state.granolaEnabled,fields:{...state.fields},updatedAt:state.updatedAt,suggestions:state.suggestions.map(s=>({...s,sourceIds:[...s.sourceIds]})),sources:state.sources.map(({id,text,observedAt,label,title,url,attribution})=>({id,text,observedAt,label,...(title!==undefined?{title}:{}),...(url!==undefined?{url}:{}),...(attribution?{attribution}:{})})),honcho:{configured:honchoConfigured(this.env),status:state.pendingDelete?'unavailable':!state.enabled?'disabled':!honchoConfigured(this.env)?'unconfigured':state.status,lastSync:state.lastSync,cleanupPending:!!state.pendingDelete,retryAt:state.pendingDelete&&state.nextCleanup?new Date(state.nextCleanup).toISOString():null}};
 }
 private requestCleanup(state:State){state.pendingDelete=crypto.randomUUID();state.cleanupAttempts=0;state.nextCleanup=Date.now();state.lastSync=null;state.syncedSources=undefined;state.pendingSnapshot=undefined;}
 private withdraw(state:State,keep:StoredSource[],invalidate=true){
  const ids=new Set(keep.map(s=>s.id));
  for(const field of Object.keys(state.accepted) as Array<keyof OwnerLensFields>){const accepted=state.accepted[field]!;if(accepted.sourceIds.some(id=>!ids.has(id))){if(state.fields[field]===accepted.text)state.fields[field]='';delete state.accepted[field];}}
  state.sources=keep;state.suggestions=state.suggestions.filter(s=>s.sourceIds.every(id=>ids.has(id)));this.requestCleanup(state);state.status='pending';this.controller?.abort();this.touch(state,invalidate);
 }
 private retained(sources:StoredSource[]){
  const keep:StoredSource[]=[];let bytes=0;
  for(const source of sources.filter(s=>Date.parse(s.observedAt)>=Date.now()-OWNER_LENS_WINDOW).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))){
   const size=new TextEncoder().encode(JSON.stringify(this.providerSources([source])[0])).byteLength;
   if(keep.length>=30||bytes+size>44000)continue;keep.push(source);bytes+=size;
  }
  return keep;
 }
 private providerSources(sources:StoredSource[]){return sources.map(({id,text,observedAt,attribution,meetingId})=>({id,text,observedAt,...(attribution?{attribution}:{}),...(meetingId?{meetingId}:{})}));}
 private current():State{
  const state=this.read(),keep=this.retained(state.sources);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_messages WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
  if(keep.length!==state.sources.length){this.withdraw(state,keep);this.write(state);}
  return state;
 }
 get(){return this.result(this.current());}
 enabled(){return this.current().enabled;}
 guard(){const generation=this.current().generation;return ()=>{const state=this.read();return state.enabled&&state.generation===generation;};}
 hasMessage(account:string,message:string){return this.ctx.storage.sql.exec('SELECT message FROM owner_lens_messages WHERE account=? AND message=?',account,message).toArray().length>0;}
 retryAfter(account:string,message:string){return this.ctx.storage.sql.exec<{next_attempt:number}>('SELECT next_attempt FROM owner_lens_retries WHERE account=? AND message=?',account,message).toArray()[0]?.next_attempt??0;}
 deferredCount(accounts:Set<string>){return this.ctx.storage.sql.exec<{account:string}>('SELECT account FROM owner_lens_retries WHERE next_attempt>?',Date.now()).toArray().filter(row=>accounts.has(row.account)).length;}
 deferExtraction(account:string,message:string,observed:number,valid:()=>boolean){
  if(!valid()||!this.read().enabled)return;
  const previous=this.ctx.storage.sql.exec<{attempts:number}>('SELECT attempts FROM owner_lens_retries WHERE account=? AND message=?',account,message).toArray()[0];
  const attempts=(previous?.attempts??0)+1,next=Date.now()+Math.min(3600000,60000*2**Math.min(attempts-1,6));
  this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_retries VALUES (?,?,?,?,?)',account,message,observed,attempts,next);
 }

 update(input:{revision:string;fields:OwnerLensFields}){
  if(!input||!input.fields||Object.keys(input.fields).some(k=>!['focus','needs','offers'].includes(k))||!['focus','needs','offers'].every(k=>typeof input.fields[k as keyof OwnerLensFields]==='string'&&input.fields[k as keyof OwnerLensFields].length<=500))throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);
  for(const field of ['focus','needs','offers'] as const){const text=input.fields[field].trim();if(text!==state.fields[field])delete state.accepted[field];state.fields[field]=text;}
  this.touch(state);this.write(state);return this.result(state);
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const result=this.operation.then(fn,fn);this.operation=result.then(()=>{},()=>{});return result;}
 nextDue(now=Date.now()){const state=this.read();return state.pendingDelete?Math.max(now+1000,state.nextCleanup??now):undefined;}
 async retryCleanup(now=Date.now()){
  const state=this.read();if(!state.pendingDelete||(state.nextCleanup??0)>now)return false;
  return this.serial(async()=>{const latest=this.read();if(!latest.pendingDelete||(latest.nextCleanup??0)>now)return false;await this.cleanup();return true;});
 }
 private async cleanup():Promise<boolean>{
  const state=this.read();if(!state.pendingDelete)return true;
  const token=state.pendingDelete;state.cleanupAttempts=(state.cleanupAttempts??0)+1;
  state.nextCleanup=Date.now()+Math.min(3600000,5000*2**Math.min(state.cleanupAttempts-1,10));this.touch(state,false);this.write(state);
  const finish=(status:string,complete:boolean)=>{console.info(JSON.stringify({event:'owner_lens_cleanup',status:['deleted','deleting','unconfigured','unavailable'].includes(status)?status:'unavailable',attempt:state.cleanupAttempts,nextDelayMs:complete?0:Math.max(0,state.nextCleanup!-Date.now()),complete}));return complete;};
  const owner=await this.owner();if(!owner)return finish('unavailable',false);
  let status:string;try{status=(await deleteHonchoLens(this.env,owner)).status;}catch{status='unavailable';}
  const latest=this.read();if(latest.pendingDelete!==token)return finish(status,false);
  if(status==='deleted'){latest.pendingDelete=null;latest.nextCleanup=undefined;latest.cleanupAttempts=0;latest.remotePossible=false;latest.status=latest.enabled?'pending':'disabled';this.touch(latest,false);this.write(latest);return finish(status,true);}
  // With no configured key there is no remote state to erase if we have never synced it.
  if(status==='unconfigured'&&!state.remotePossible){latest.pendingDelete=null;latest.nextCleanup=undefined;latest.cleanupAttempts=0;latest.status=latest.enabled?'unconfigured':'disabled';this.touch(latest,false);this.write(latest);return finish(status,true);}
  latest.status='unavailable';this.touch(latest,false);this.write(latest);return finish(status,false);
 }
 async setEnabled(input:{revision:string;enabled:boolean}){
  if(!input||typeof input.enabled!=='boolean')throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);
  if(state.enabled===input.enabled){if(!state.enabled&&state.pendingDelete)await this.serial(()=>this.cleanup());return this.get();}
  state.enabled=input.enabled;this.touch(state);state.status=input.enabled?'pending':'disabled';
  if(!input.enabled){state.projectionRequested=false;state.granolaEnabled=false;this.withdraw(state,[]);state.suggestions=[];this.ctx.storage.sql.exec('DELETE FROM owner_lens_messages');this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries');this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola');this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries');}
  this.write(state);
  if(!input.enabled)await this.serial(()=>this.cleanup());
  return this.get();
 }
 async setGranolaEnabled(input:{revision:string;enabled:boolean}){
  if(!input||typeof input.enabled!=='boolean')throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);if(input.enabled&&!state.enabled)throw Error('owner_lens_disabled');
  if(state.granolaEnabled===input.enabled){if(!input.enabled&&state.pendingDelete)await this.serial(()=>this.cleanup());return this.get();}
  state.granolaEnabled=input.enabled;
  const keep=state.sources.filter(source=>source.account!=='granola');
  if(!input.enabled){this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola');this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries');if(keep.length!==state.sources.length)this.withdraw(state,keep);else this.touch(state);}
  else {state.status='pending';this.touch(state);}
  this.write(state);if(!input.enabled)await this.serial(()=>this.cleanup());return this.get();
 }
 hasGranolaNote(id:string,version:string){return this.ctx.storage.sql.exec('SELECT id FROM owner_lens_granola WHERE id=? AND version=? AND observed>=?',id,version,Date.now()-OWNER_LENS_WINDOW).toArray().length>0;}
 granolaRetryAfter(id:string,version:string){return this.ctx.storage.sql.exec<{next_attempt:number}>('SELECT next_attempt FROM owner_lens_granola_retries WHERE id=? AND version=?',id,version).toArray()[0]?.next_attempt??0;}
 deferGranola(id:string,version:string,valid:()=>boolean){
  const state=this.read();if(!valid()||!state.enabled||!state.granolaEnabled||this.hasGranolaNote(id,version))return;
  const previous=this.ctx.storage.sql.exec<{attempts:number}>('SELECT attempts FROM owner_lens_granola_retries WHERE id=? AND version=?',id,version).toArray()[0];
  const attempts=(previous?.attempts??0)+1,now=Date.now(),next=now+Math.min(3600000,60000*2**Math.min(attempts-1,6));
  this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_granola_retries VALUES (?,?,?,?,?)',id,version,now,attempts,next);
 }
 /** Passages have already been attributed and selected by the Granola collector. */
 async recordGranola(input:OwnerGranolaInput,valid:()=>boolean):Promise<void>{
  if(!valid()||!this.read().granolaEnabled)return;
  if(!input||typeof input.id!=='string'||!input.id||input.id.length>512||typeof input.version!=='string'||!input.version||input.version.length>512||typeof input.observedAt!=='string'||typeof input.title!=='string'||input.url!==null&&typeof input.url!=='string'||!Array.isArray(input.passages)||input.passages.length>8||input.passages.some(text=>typeof text!=='string'||!text.trim()||text.length>2000)||input.meetingPassages!==undefined&&(!Array.isArray(input.meetingPassages)||input.meetingPassages.length>3||input.meetingPassages.some(text=>typeof text!=='string'||!text.trim()||text.length>1200)))throw Error('invalid_owner_lens');
  const observed=Date.parse(input.observedAt);if(!Number.isFinite(observed))throw Error('invalid_owner_lens');if(observed<Date.now()-OWNER_LENS_WINDOW||observed>Date.now()||this.hasGranolaNote(input.id,input.version))return;
  let url:string|null=null;try{const parsed=input.url&&input.url.length<=2048?new URL(input.url):null;if(parsed?.protocol==='https:'&&!parsed.username&&!parsed.password)url=parsed.href;}catch{}
  const passages=[...input.passages.map((text,index)=>({text,index,attribution:'statement' as const})),...(input.meetingPassages??[]).map((text,index)=>({text,index,attribution:'meeting' as const}))];
  const sources=await Promise.all(passages.map(async({text,index,attribution}):Promise<StoredSource>=>({id:'owner-granola:'+await digest(JSON.stringify([input.id,input.version,attribution,index,text])),text,observedAt:new Date(observed).toISOString(),label:attribution==='meeting'?'Meeting you attended':'Your Granola meeting',attribution,...(attribution==='meeting'?{meetingId:input.id}:{}),account:'granola',message:input.id,version:input.version,title:input.title.trim().slice(0,300),url})));
  if(!valid())return;
  this.ctx.storage.transactionSync(()=>{
   const state=this.read();if(!state.enabled||!state.granolaEnabled||!valid()||this.hasGranolaNote(input.id,input.version))return;
   const keep=state.sources.filter(source=>source.account!=='granola'||source.message!==input.id||source.version===input.version);
   if(keep.length!==state.sources.length){this.withdraw(state,keep,false);this.write(state);}
   this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_granola VALUES (?,?,?)',input.id,input.version,observed);
   this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries WHERE id=?',input.id);
   if(sources.length)this.addSources(state,sources);
  });
 }
 /** No network here: refresh/alarm performs queued remote cleanup without nested locks. */
 async reconcileGranola(eligible:Map<string,string>,force=false):Promise<void>{
  const state=this.current(),keep=state.sources.filter(source=>source.account!=='granola'||!!source.version&&eligible.get(source.message)===source.version);
  const stale=this.ctx.storage.sql.exec<{id:string;version:string}>('SELECT id,version FROM owner_lens_granola').toArray().filter(row=>eligible.get(row.id)!==row.version);
  const staleRetries=this.ctx.storage.sql.exec<{id:string;version:string}>('SELECT id,version FROM owner_lens_granola_retries').toArray().filter(row=>eligible.get(row.id)!==row.version);
  if(!force&&!stale.length&&!staleRetries.length&&keep.length===state.sources.length)return;
  this.ctx.storage.transactionSync(()=>{
   for(const row of stale)this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola WHERE id=?',row.id);
   for(const row of staleRetries)this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries WHERE id=?',row.id);
   if(keep.length!==state.sources.length)this.withdraw(state,keep);else this.touch(state);
   this.write(state);
  });
 }
 async recordMail(account:string,message:string,observed:number,raw:GmailMessage|null,valid:()=>boolean){
  if(!valid()||this.hasMessage(account,message))return;
  const started=Date.now();let stage:OwnerLensDiagnosticStage='mail-extraction',sourceCount=0;
  try{
   const facts=raw?await ownerMailPassages(raw,message,account,this.env.AI):[];sourceCount=facts.length;
   const sourceDate=facts.length&&raw?Number(raw.internalDate):observed;
   if(!valid())return;
   const sources=await Promise.all(facts.map(async(fact,index)=>({id:'owner-mail:'+await digest(account+'\0'+message+'\0'+index+'\0'+fact.quote),text:fact.quote,observedAt:new Date(sourceDate).toISOString(),label:'Your sent email' as const,account,message})));
   if(!valid())return;stage='source-store';
   this.ctx.storage.transactionSync(()=>{
    const state=this.read();if(!state.enabled||!valid())return;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_messages VALUES (?,?,?)',account,message,observed);
    this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries WHERE account=? AND message=?',account,message);
    if(sources.length)this.addSources(state,sources);
   });
  }catch(error){ownerLensDiagnostic(stage,error,{elapsedMs:Date.now()-started,sources:sourceCount});throw error;}
 }
 private addSources(state:State,sources:StoredSource[]){
  const merged=[...sources,...state.sources.filter(old=>!sources.some(s=>s.id===old.id))].sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
  const keep=this.retained(merged);
  // Older collected passages can be discarded without changing the evidence already reviewed.
  if(JSON.stringify(keep)===JSON.stringify(state.sources))return;
  if(state.sources.some(old=>!keep.some(s=>s.id===old.id)))this.withdraw(state,keep,false);else {state.sources=keep;this.touch(state,false);}
  state.status='pending';state.suggestions=[];this.write(state);
 }
 async refresh(input:{revision:string;note?:string},collect:(valid:()=>boolean)=>Promise<OwnerLensCollectionResult|void>){
  if(!input||input.note!==undefined&&(typeof input.note!=='string'||input.note.length>3000))throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);if(!state.enabled)throw Error('owner_lens_disabled');
  // Finish projecting the collected batch before a retry can evict more evidence.
  // pendingSnapshot also recognizes unfinished work from records predating this flag.
  const outdatedProjection=!!state.lastSync&&state.projectionVersion!==HONCHO_LENS_PROJECTION_VERSION;
  const resumeProjection=honchoConfigured(this.env)&&!!(state.projectionRequested||state.pendingSnapshot||outdatedProjection)&&state.sources.length>0;
  state.projectionRequested=true;this.touch(state);state.status='pending';this.write(state);const generation=state.generation;
  const valid=()=>{const latest=this.read();return latest.enabled&&latest.generation===generation;};
  return this.serial(async()=>{
   if(!valid())return this.get();
   if(!await this.cleanup()||!valid())return this.get();
   const started=Date.now();let stage:OwnerLensDiagnosticStage='note-extraction';
   try{
    if(input.note?.trim()){
     const facts=await extractMailContext(this.env.AI,input.note),observedAt=stamp();
     const sources=await Promise.all(facts.map(async(fact,index)=>({id:'owner-note:'+await digest(input.note+'\0'+index+'\0'+fact.quote),text:fact.quote,observedAt,label:'Your note' as const,account:null,message:''})));
     if(!valid())return this.get();if(sources.length)this.addSources(this.read(),sources);
    }
    stage='collection';const collection=resumeProjection?undefined:await collect(valid),collectionFailed=!!collection&&(collection.failed>0||collection.deferred>0);if(!valid())return this.get();
    // Retention eviction or account withdrawal requires removal before another remote snapshot.
    stage='cleanup';if(!await this.cleanup()||!valid())return this.get();
    const snapshot=this.read(),owner=await this.owner();if(!owner||!valid()||this.read().revision!==snapshot.revision)return this.get();
    if(!snapshot.sources.length){snapshot.status=collectionFailed?'unavailable':honchoConfigured(this.env)?'ready':'unconfigured';if(snapshot.status==='ready')snapshot.projectionRequested=false;this.touch(snapshot,false);this.write(snapshot);return this.get();}
    const providerSources=this.providerSources(snapshot.sources),fingerprint=await digest(JSON.stringify(providerSources));
    if(!valid()||this.read().revision!==snapshot.revision)return this.get();
    // An explicit refresh may retry an empty result against the same uploaded evidence.
    if(snapshot.lastSync&&snapshot.projectionVersion===HONCHO_LENS_PROJECTION_VERSION&&snapshot.syncedSources===fingerprint&&snapshot.suggestions.length){snapshot.status='ready';snapshot.projectionRequested=false;this.touch(snapshot,false);this.write(snapshot);return this.get();}
    const controller=new AbortController();this.controller=controller;
    if(honchoConfigured(this.env)){
     snapshot.remotePossible=true;const previous=snapshot.pendingSnapshot;
     snapshot.pendingSnapshot=previous?.fingerprint===fingerprint?{...previous,attempts:previous.attempts+1}:{fingerprint,attempts:1,since:Date.now()};this.write(snapshot);
    }
    stage='honcho';const response=await syncHonchoLens(this.env,owner,providerSources,{signal:controller.signal});
    if(this.controller===controller)this.controller=undefined;
    const latest=this.read();if(!valid()||latest.revision!==snapshot.revision)return this.get();
    latest.status=response.status;if(response.status==='unavailable')ownerLensDiagnostic('honcho',Error('owner_lens_unavailable'),{elapsedMs:Date.now()-started,sources:snapshot.sources.length});stage='suggestion-store';
    if(response.status==='ready'){
     const ids=new Set(latest.sources.map(s=>s.id));latest.suggestions=[];
     for(const entry of response.entries){if(!['focus','need','offer'].includes(entry.kind)||typeof entry.text!=='string'||!entry.text.trim()||entry.text.length>500||!entry.sourceIds.length||entry.sourceIds.some(id=>!ids.has(id))||latest.dismissed.includes(signature(entry)))continue;
      const id='owner-suggestion:'+await digest(signature(entry));if(!valid())return this.get();latest.suggestions.push({id,kind:entry.kind,text:entry.text,sourceIds:[...new Set(entry.sourceIds)]});
     }
     latest.lastSync=stamp();latest.syncedSources=fingerprint;latest.pendingSnapshot=undefined;latest.projectionRequested=false;latest.projectionVersion=HONCHO_LENS_PROJECTION_VERSION;
    }
    if(!valid()||this.read().revision!==snapshot.revision)return this.get();
    if(response.status==='pending'&&latest.pendingSnapshot&&latest.pendingSnapshot.attempts>=2&&Date.now()-latest.pendingSnapshot.since>=60000){
     // A durable attempt marker may precede a failed message POST. Reset only through
     // confirmed remote deletion; never replay an uncertain source batch in place.
     this.requestCleanup(latest);latest.suggestions=[];latest.status='pending';
    }
    this.touch(latest,false);this.write(latest);
    if(response.status==='ready')console.info(JSON.stringify({event:'owner_lens_projection',sourceCount:latest.sources.length,providerEntries:response.entries.length,reviewableEntries:latest.suggestions.length,filteredEntries:response.entries.length-latest.suggestions.length}));
   }catch(error){ownerLensDiagnostic(stage,error,{elapsedMs:Date.now()-started});if(valid()){const latest=this.read();latest.status='unavailable';this.touch(latest,false);this.write(latest);}}
   return this.get();
  });
 }
 decide(input:{revision:string;id:string},accept:boolean){
  if(!input||typeof input.id!=='string')throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);const suggestion=state.suggestions.find(s=>s.id===input.id);if(!suggestion)throw Error('owner_lens_suggestion_missing');
  if(accept){const field=fieldsByKind[suggestion.kind];state.fields[field]=suggestion.text;state.accepted[field]={text:suggestion.text,sourceIds:[...suggestion.sourceIds],acceptedAt:stamp()};}
  state.dismissed=[...new Set([...state.dismissed,signature(suggestion)])].slice(-100);state.suggestions=state.suggestions.filter(s=>s.id!==input.id);this.touch(state);this.write(state);return this.result(state);
 }
 async removeAccount(account:string){
  const state=this.current(),keep=state.sources.filter(s=>s.account!==account);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_messages WHERE account=?',account);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries WHERE account=?',account);
  if(account==='granola'){this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola');this.ctx.storage.sql.exec('DELETE FROM owner_lens_granola_retries');}
  if(keep.length===state.sources.length){this.touch(state);this.write(state);return;}
  this.withdraw(state,keep);this.write(state);await this.serial(()=>this.cleanup());
 }
}
