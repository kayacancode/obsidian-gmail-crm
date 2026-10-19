import {extractMailContext,type MailFact} from './gmail-context';
import {decodeGmailMessage} from './gmail-body';
import {digest,parseMessage,type GmailMessage} from './mail-model';
import {deleteHonchoLens,honchoConfigured,syncHonchoLens,type HonchoLensEnv,type HonchoLensEntry} from './honcho-lens';

export type OwnerLensKind='focus'|'need'|'offer';
export interface OwnerLensFields {focus:string;needs:string;offers:string}
export interface OwnerLensCollectionResult {failed:number;deferred:number}
export interface OwnerLensSuggestion {id:string;kind:OwnerLensKind;text:string;sourceIds:string[]}
export interface OwnerLensSource {id:string;text:string;observedAt:string;label:'Your sent email'|'Your note'}
export interface OwnerLens {
 revision:string;enabled:boolean;fields:OwnerLensFields;updatedAt:string|null;
 suggestions:OwnerLensSuggestion[];sources:OwnerLensSource[];
 honcho:{configured:boolean;status:'disabled'|'unconfigured'|'pending'|'ready'|'unavailable'|'invalid';lastSync:string|null;cleanupPending:boolean;retryAt:string|null};
}
interface StoredSource extends OwnerLensSource {account:string|null;message:string}
interface Accepted {text:string;sourceIds:string[];acceptedAt:string}
interface State extends Omit<OwnerLens,'sources'|'honcho'> {
 generation:string;sources:StoredSource[];dismissed:string[];
 accepted:Partial<Record<keyof OwnerLensFields,Accepted>>;
 status:OwnerLens['honcho']['status'];lastSync:string|null;pendingDelete:string|null;remotePossible?:boolean;syncedSources?:string;cleanupAttempts?:number;nextCleanup?:number;pendingSnapshot?:{fingerprint:string;attempts:number;since:number};
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
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owner_lens_state (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owner_lens_messages (account TEXT NOT NULL,message TEXT NOT NULL,observed INTEGER NOT NULL,PRIMARY KEY(account,message)); CREATE TABLE IF NOT EXISTS owner_lens_retries (account TEXT NOT NULL,message TEXT NOT NULL,observed INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,PRIMARY KEY(account,message));');
 }
 private read():State{
  const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM owner_lens_state WHERE id=1').toArray()[0];
  if(row)return JSON.parse(row.data) as State;
  const state:State={revision:crypto.randomUUID(),generation:crypto.randomUUID(),enabled:false,fields:{focus:'',needs:'',offers:''},updatedAt:null,suggestions:[],sources:[],dismissed:[],accepted:{},status:'disabled',lastSync:null,pendingDelete:null};this.write(state);return state;
 }
 private write(state:State){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO owner_lens_state VALUES (1,?)',JSON.stringify(state));}
 private touch(state:State,invalidate=true){state.revision=crypto.randomUUID();state.updatedAt=stamp();if(invalidate){state.generation=crypto.randomUUID();this.controller?.abort();}}
 private check(state:State,revision:string){if(typeof revision!=='string'||revision!==state.revision)throw Error('owner_lens_conflict');}
 private result(state:State):OwnerLens{
  return {revision:state.revision,enabled:state.enabled,fields:{...state.fields},updatedAt:state.updatedAt,suggestions:state.suggestions.map(s=>({...s,sourceIds:[...s.sourceIds]})),sources:state.sources.map(({id,text,observedAt,label})=>({id,text,observedAt,label})),honcho:{configured:honchoConfigured(this.env),status:state.pendingDelete?'unavailable':!state.enabled?'disabled':!honchoConfigured(this.env)?'unconfigured':state.status,lastSync:state.lastSync,cleanupPending:!!state.pendingDelete,retryAt:state.pendingDelete&&state.nextCleanup?new Date(state.nextCleanup).toISOString():null}};
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
   const size=new TextEncoder().encode(JSON.stringify({id:source.id,text:source.text,observedAt:source.observedAt})).byteLength;
   if(keep.length>=30||bytes+size>44000)continue;keep.push(source);bytes+=size;
  }
  return keep;
 }
 private current():State{
  const state=this.read(),keep=this.retained(state.sources);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_messages WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
  this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries WHERE observed<?',Date.now()-OWNER_LENS_WINDOW);
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
  const owner=await this.owner();if(!owner)return false;
  let status:string;try{status=(await deleteHonchoLens(this.env,owner)).status;}catch{status='unavailable';}
  const latest=this.read();if(latest.pendingDelete!==token)return false;
  if(status==='deleted'){latest.pendingDelete=null;latest.nextCleanup=undefined;latest.cleanupAttempts=0;latest.remotePossible=false;latest.status=latest.enabled?'pending':'disabled';this.touch(latest,false);this.write(latest);return true;}
  // With no configured key there is no remote state to erase if we have never synced it.
  if(status==='unconfigured'&&!state.remotePossible){latest.pendingDelete=null;latest.nextCleanup=undefined;latest.cleanupAttempts=0;latest.status=latest.enabled?'unconfigured':'disabled';this.touch(latest,false);this.write(latest);return true;}
  latest.status='unavailable';this.touch(latest,false);this.write(latest);return false;
 }
 async setEnabled(input:{revision:string;enabled:boolean}){
  if(!input||typeof input.enabled!=='boolean')throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);
  if(state.enabled===input.enabled){if(!state.enabled&&state.pendingDelete)await this.serial(()=>this.cleanup());return this.get();}
  state.enabled=input.enabled;this.touch(state);state.status=input.enabled?'pending':'disabled';
  if(!input.enabled){this.withdraw(state,[]);state.suggestions=[];this.ctx.storage.sql.exec('DELETE FROM owner_lens_messages');this.ctx.storage.sql.exec('DELETE FROM owner_lens_retries');}
  this.write(state);
  if(!input.enabled)await this.serial(()=>this.cleanup());
  return this.get();
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
  if(state.sources.some(old=>!keep.some(s=>s.id===old.id)))this.withdraw(state,keep,false);else {state.sources=keep;this.touch(state,false);}
  state.status='pending';state.suggestions=[];this.write(state);
 }
 async refresh(input:{revision:string;note?:string},collect:(valid:()=>boolean)=>Promise<OwnerLensCollectionResult|void>){
  if(!input||input.note!==undefined&&(typeof input.note!=='string'||input.note.length>3000))throw Error('invalid_owner_lens');
  const state=this.current();this.check(state,input.revision);if(!state.enabled)throw Error('owner_lens_disabled');
  this.touch(state);state.status='pending';this.write(state);const generation=state.generation;
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
    stage='collection';const collection=await collect(valid),collectionFailed=!!collection&&(collection.failed>0||collection.deferred>0);if(!valid())return this.get();
    // Retention eviction or account withdrawal requires removal before another remote snapshot.
    stage='cleanup';if(!await this.cleanup()||!valid())return this.get();
    const snapshot=this.read(),owner=await this.owner();if(!owner||!valid()||this.read().revision!==snapshot.revision)return this.get();
    if(!snapshot.sources.length){snapshot.status=collectionFailed?'unavailable':honchoConfigured(this.env)?'ready':'unconfigured';this.touch(snapshot,false);this.write(snapshot);return this.get();}
    const fingerprint=await digest(JSON.stringify(snapshot.sources.map(({id,text,observedAt})=>({id,text,observedAt}))));
    if(!valid()||this.read().revision!==snapshot.revision)return this.get();
    if(snapshot.lastSync&&snapshot.syncedSources===fingerprint){snapshot.status='ready';this.touch(snapshot,false);this.write(snapshot);return this.get();}
    const controller=new AbortController();this.controller=controller;
    if(honchoConfigured(this.env)){
     snapshot.remotePossible=true;const previous=snapshot.pendingSnapshot;
     snapshot.pendingSnapshot=previous?.fingerprint===fingerprint?{...previous,attempts:previous.attempts+1}:{fingerprint,attempts:1,since:Date.now()};this.write(snapshot);
    }
    stage='honcho';const response=await syncHonchoLens(this.env,owner,snapshot.sources.map(({id,text,observedAt})=>({id,text,observedAt})),{signal:controller.signal});
    if(this.controller===controller)this.controller=undefined;
    const latest=this.read();if(!valid()||latest.revision!==snapshot.revision)return this.get();
    latest.status=response.status;if(response.status==='unavailable')ownerLensDiagnostic('honcho',Error('owner_lens_unavailable'),{elapsedMs:Date.now()-started,sources:snapshot.sources.length});stage='suggestion-store';
    if(response.status==='ready'){
     const ids=new Set(latest.sources.map(s=>s.id));latest.suggestions=[];
     for(const entry of response.entries){if(!['focus','need','offer'].includes(entry.kind)||typeof entry.text!=='string'||!entry.text.trim()||entry.text.length>500||!entry.sourceIds.length||entry.sourceIds.some(id=>!ids.has(id))||latest.dismissed.includes(signature(entry)))continue;
      const id='owner-suggestion:'+await digest(signature(entry));if(!valid())return this.get();latest.suggestions.push({id,kind:entry.kind,text:entry.text,sourceIds:[...new Set(entry.sourceIds)]});
     }
     latest.lastSync=stamp();latest.syncedSources=fingerprint;latest.pendingSnapshot=undefined;
    }
    if(!valid()||this.read().revision!==snapshot.revision)return this.get();
    if(response.status==='pending'&&latest.pendingSnapshot&&latest.pendingSnapshot.attempts>=2&&Date.now()-latest.pendingSnapshot.since>=60000){
     // A durable attempt marker may precede a failed message POST. Reset only through
     // confirmed remote deletion; never replay an uncertain source batch in place.
     this.requestCleanup(latest);latest.suggestions=[];latest.status='pending';
    }
    this.touch(latest,false);this.write(latest);
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
  if(keep.length===state.sources.length){this.touch(state);this.write(state);return;}
  this.withdraw(state,keep);this.write(state);await this.serial(()=>this.cleanup());
 }
}
