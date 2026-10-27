import {OwnerLensStore,OWNER_LENS_WINDOW,ownerLensDiagnostic,type OwnerLensDiagnosticStage,type OwnerLens,type OwnerLensFields,type OwnerLensCollectionResult} from './owner-lens';
import {extractConnectionOrigin,extractDirectConnectionContext} from './connection-origin';
import {EmailIntroductionStore} from './email-introduction-store';
import {collectGranolaOwnerPassages,collectGranolaMeetingTopics} from './granola-owner-context';
import {extractMailContext,GMAIL_CONTEXT_VERSION,isOnlyMailLogistics,type MailFact} from './gmail-context';
import {rankHelperBrief} from './helper-brief';
import {PersonContextStore,validContextPerson,validPersonContextInput,type SavePersonContext} from './person-context';
import {PersonMergeStore,projectPersonMerges,projectRelevancePeople} from './person-merge';
import {RelationshipMemoryStore,validSaveRelationshipMemory,validCaptureRelationshipMemory,validMemoryEmail,relationshipDelta,type SaveRelationshipMemory,type CaptureRelationshipMemory,type RecommendationMemory,type RelationshipMemory} from './relationship-memory';
import {workspacePhoto,type WorkspaceProfile} from './workspace-contract';
import {calendarActivity,normalizeCalendarEvent,type CalendarRecord,type PersonFeedback} from './calendar';
import {DurableObject} from 'cloudflare:workers';
import {parseMessage,emailScore,seal,unseal,opaque, type Metadata} from './mail-model';
import {RelevanceStore, type RelevanceFeedbackInput} from './relevance-store';
import type {MetadataInput} from './relevance-store';
import type {RelevanceLens} from './relevance-model';
import {canonicalThemeName,type Theme,type ThemeSignal} from './relevance-model';
import {decodeGmailMessage} from './gmail-body';
import {verifySentBookingApproval,verifySentSchedulingKickoff} from './scheduling-gmail';
import {schedulingMessageId} from './scheduling-email-policy';
import {ThemeExtractor,THEME_MODEL,EXTRACTOR_VERSION,THEME_TOPICS} from './theme-extractor';
import type {GmailMessage} from './mail-model';
import type {RetrievalJob,RetrievalError} from './relevance-store';
import {previewPublicSource,fetchPublicSource,withPublicDeadline,publicAwait,safePublicError,PUBLIC_EXTRACTOR_VERSION,type PublicSourceInput,type PublicSourceState,type PublicFetchResult} from './public-sources';
import {normalizePushedGraph,type PushedGraphPayload} from './relevance-routes';
import {boundedJSON as readBoundedJSON} from './bounded-json';
import {GranolaSync,type GranolaRange,type GranolaStatus,type GranolaGmailContact,type GranolaIdentitySuggestion} from './granola-sync';
import {composeDraft,checkDraft} from './draft-note';
import {jevConfigured,JevError} from './jev';
import {keywordRank,keywordScores,jevScores,topResults,MAX_QUERY_LENGTH,type SearchEvidence,type SearchResult} from './network-search';
import {SHARE_CAPS,carriesQuote,levelOfSlice,normalizeShareLevel,normalizeShareScope,normalizeSlice,shareableSourceType,sharedDisplayName,type SharedSlice,type ShareLevel,type ShareScope} from './network-share';
export interface RetrievalScope {account:string;personId:string;themeId?:string;windowDays?:30|90}
export interface RetrievalPreview extends RetrievalScope {windowDays:30|90;maxMessages:50;maxBytes:1000000;expiresAt:number;before:number;after:number;fingerprint:string}
export interface MailEnv {MAIL:Env['MAIL'];DB?:Env['DB'];AI?:Env['AI'];THEME_MODEL?:Env['THEME_MODEL'];GOOGLE_CLIENT_ID:string;GOOGLE_CLIENT_SECRET?:string;MAIL_TOKEN_KEY?:string;TOKEN_SECRET:string;APP_ORIGIN?:string;TYPESAFE_API_KEY?:string;JEV_MODEL?:string;HONCHO_API_KEY?:string}
type Range='recent'|'all';
interface Job {contextVersion?:number;calendarDone?:boolean;calendarPage?:string;calendarPages?:number;photoSource?:'saved'|'other';photoPage?:string;photosDone?:boolean;generation:string;range:Range;query:string;pageToken?:string;pending:string[];hasMore:boolean;processed:number;started:number;retries:number;lastRun:number;nextAttempt:number}
interface Account {contextEnabled?:boolean;contextVersion?:number;contextError?:string;emailEdgeVersion?:number;calendarEnabled?:boolean;calendarStatus?:string;calendarLastSync?:number;revision?:string;otherPhotosEnabled?:boolean;photosEnabled?:boolean;photoStatus?:string;email:string;grant:string;status:string;job:Job|null;lastSync:number;nextSync:number;error:string;range:Range}
interface Pending {verifier:string;cookie:string;expires:number;range:Range;owner:string;redirect:string}
interface SharedEdgeValue {a:string;b:string;weight:number;types:string[];contexts:string[];titles:string[]}
interface ConnectionOriginResult {status:'found'|'not_found'|'disabled'|'unavailable';connectionsRevision?:string;reason?:string;origin?:{introducerName:string;observedAt:string;subject:string;quote:string;url:string};connection?:{direction:'sent'|'received';observedAt:string;subject:string;quote:string;url:string}}
/** One person in `graph()`: `via` names the owners who shared them, and is the only address there. */
interface GraphPersonNode {mergedProfiles?:Array<{id:string;name:string;company:string}>;manual?:boolean;memoryEligible?:boolean;sources?:string[];directRelationship:boolean;directLastContact:string|null;id:string;photoUrl:string|null;name:string;company:string;companySource:string;lastContact:string|null;meetings:number;lastMeeting:string|null;contactActivity?:{sent:number;received:number;meetings:number};strength:number;momentum:number;combined:number;quadrant:string;via?:string[]}
export class MailSync extends DurableObject<MailEnv>{
 constructor(ctx:DurableObjectState,env:MailEnv){super(ctx,env);ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS contact_photos (account TEXT NOT NULL,email TEXT NOT NULL,url TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(account,email)); CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (account TEXT NOT NULL,id TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS contributions (account TEXT NOT NULL,canonical TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,date INTEGER NOT NULL,subject TEXT NOT NULL,sent INTEGER NOT NULL,received INTEGER NOT NULL,PRIMARY KEY(account,canonical,email)); CREATE INDEX IF NOT EXISTS contributions_email ON contributions(email); CREATE INDEX IF NOT EXISTS contributions_account_date ON contributions(account,date DESC); CREATE TABLE IF NOT EXISTS mail_edge_messages (account TEXT,id TEXT,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS mail_thread_people (account TEXT,thread TEXT,email TEXT,subject TEXT,PRIMARY KEY(account,thread,email)); CREATE TABLE IF NOT EXISTS mail_edges (account TEXT,canonical TEXT,a TEXT,b TEXT,subject TEXT,PRIMARY KEY(account,canonical,a,b)); CREATE TABLE IF NOT EXISTS shared_people (owner TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,last_contact TEXT,meetings INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,email)); CREATE INDEX IF NOT EXISTS shared_people_email ON shared_people(email); CREATE TABLE IF NOT EXISTS shared_edges (owner TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,weight INTEGER NOT NULL,types TEXT NOT NULL,contexts TEXT NOT NULL,PRIMARY KEY(owner,a,b)); CREATE TABLE IF NOT EXISTS shared_signals (owner TEXT NOT NULL,signal_id TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(owner,signal_id)); CREATE TABLE IF NOT EXISTS shared_meta (owner TEXT PRIMARY KEY,refreshed_at INTEGER NOT NULL,level TEXT NOT NULL);`);if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('contact_photos') WHERE name='source'").toArray().length)this.ctx.storage.sql.exec("ALTER TABLE contact_photos ADD COLUMN source TEXT NOT NULL DEFAULT 'saved'");this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS person_feedback (person_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS calendar_events (account TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(account,id))');this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS gmail_context (account TEXT NOT NULL,message TEXT NOT NULL,person TEXT NOT NULL,observed INTEGER NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(account,message)); CREATE INDEX IF NOT EXISTS gmail_context_person ON gmail_context(person,observed)');if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('gmail_context') WHERE name='version'").toArray().length)this.ctx.storage.sql.exec('ALTER TABLE gmail_context ADD COLUMN version INTEGER NOT NULL DEFAULT 1');this.store();this.granola();}
 private ownerLensStore?:OwnerLensStore;
 private personContextStore?:PersonContextStore;
 private relationshipStore?:RelationshipMemoryStore;
 private memoryStore(){return this.relationshipStore??=new RelationshipMemoryStore(this.ctx.storage);}
 private mergeStore?:PersonMergeStore;
 private personMergeStore(){return this.mergeStore??=new PersonMergeStore(this.ctx.storage);}
 async getPersonMerges(){return {merges:this.personMergeStore().get()};}
 private async mergeIdentities(){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('unknown_person');
  const emails=[...new Set([...this.graphContacts().map(p=>p.email),...this.memoryStore().manualPeople().map(p=>p.email)])];
  const identities=await Promise.all(emails.map(async email=>[await opaque(owner,email,this.env.TOKEN_SECRET),email] as const));
  // Hashing yielded. Source removal must immediately withdraw an alias as well as its node.
  const current=new Set([...this.graphContacts().map(p=>p.email),...this.memoryStore().manualPeople().map(p=>p.email)]),own=new Set([owner,...this.rows().map(a=>a.email),...this.granola().ownEmails()]);
  return new Map(identities.filter(([,email])=>current.has(email)&&!own.has(email)));
 }
 async setPersonMerge(sourceId:string,targetId:string){
  if(!validContextPerson(sourceId)||!validContextPerson(targetId)||sourceId===targetId)throw Error('invalid_person_merge');
  const ids=await this.mergeIdentities();if(!ids.has(sourceId)||!ids.has(targetId))throw Error('unknown_person');
  const merges=this.personMergeStore().set(sourceId,targetId);this.clearConnectionOrigins();return {merges};
 }
 async deletePersonMerge(sourceId:string){if(!validContextPerson(sourceId))throw Error('invalid_person_merge');return {merges:this.personMergeStore().delete(sourceId)};}
 private async canonicalPersonId(personId:string){
  const target=this.personMergeStore().get()[personId];if(!target)return personId;
  const ids=await this.mergeIdentities();return ids.has(personId)&&ids.has(target)?target:personId;
 }
 private async emailsForMergedPerson(personId:string):Promise<string[]>{
  const canonical=await this.canonicalPersonId(personId),ids=await this.mergeIdentities(),merges=this.personMergeStore().get();
  return [...ids].filter(([id])=>id===canonical||merges[id]===canonical&&ids.has(canonical)).map(([,email])=>email);
 }
 private async memoryForPerson(personId:string):Promise<RelationshipMemory&{aliasMemories?:RelationshipMemory[]}>{
  const canonical=await this.canonicalPersonId(personId),merges=this.personMergeStore().get(),memory=this.memoryStore().get(canonical);
  if(memory.pointPersonId)memory.pointPersonId=await this.canonicalPersonId(memory.pointPersonId);
  if(!Object.values(merges).includes(canonical))return memory;
  const ids=await this.mergeIdentities();
  const aliases=Object.keys(merges).filter(id=>merges[id]===canonical&&ids.has(id)&&ids.has(canonical));
  if(!aliases.length)return memory;
  const aliasMemories=aliases.map(id=>this.memoryStore().get(id));
  // Conflicting source fields/notes remain available as separate private profiles. New edits
  // always belong to the chosen target, and undo never erases or rewrites an alias profile.
  const profile=this.ctx.storage.sql.exec('SELECT person_id FROM person_memory WHERE person_id=?',canonical).toArray().length?memory:aliasMemories.find(m=>this.ctx.storage.sql.exec('SELECT person_id FROM person_memory WHERE person_id=?',m.personId).toArray().length);
  const entries=[...memory.entries,...aliasMemories.flatMap(m=>m.entries)].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)).slice(0,10);
  const notBefore=[memory.notBefore,...aliasMemories.map(m=>m.notBefore)].filter((date):date is string=>!!date).sort().at(-1)??null;
  const pointPersonId=profile?.pointPersonId?await this.canonicalPersonId(profile.pointPersonId):memory.pointPersonId;
  return {...(profile||memory),...memory,...(profile&&profile!==memory?{company:profile.company,building:profile.building,needs:profile.needs,offers:profile.offers,interests:profile.interests,relationship:profile.relationship}:{}),pointPersonId,notBefore,entries,aliasMemories};
 }
 async verifySchedulingKickoff(messageId:string,agentAddress:string){
  return this.verifyOwnerSentEmail(messageId,agentAddress,verifySentSchedulingKickoff);
 }
 async verifyBookingApproval(messageId:string,replyAddress:string){
  return this.verifyOwnerSentEmail(messageId,replyAddress,verifySentBookingApproval);
 }
 private async verifyOwnerSentEmail<T>(messageId:string,agentAddress:string,verify:(options:Parameters<typeof verifySentSchedulingKickoff>[0])=>Promise<T>):Promise<T>{
  schedulingMessageId(messageId);
  const owner=await this.ctx.storage.get<string>('owner'),key=this.env.MAIL_TOKEN_KEY,secret=this.env.GOOGLE_CLIENT_SECRET;
  if(!owner||!key||!secret)throw Error('scheduling_gmail_unavailable');
  const account=this.get(owner);
  if(!account||!['connected','syncing'].includes(account.status))throw Error('scheduling_gmail_unavailable');
  const current=()=>{const latest=this.get(owner);return !!latest&&latest.grant===account.grant&&latest.revision===account.revision&&['connected','syncing'].includes(latest.status);};
  const refresh=await unseal(account.grant,key);if(!current())throw Error('scheduling_grant_revoked');
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:secret,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(10000)});
  if(!current()){await response.body?.cancel();throw Error('scheduling_grant_revoked');}
  if(!response.ok){await response.body?.cancel();throw Error('scheduling_gmail_unavailable');}
  const token=await readBoundedJSON(response,32768) as {access_token?:string};
  if(!token.access_token||!current())throw Error('scheduling_grant_revoked');
  const verified=await verify({owner,agentAddress,messageId,accessToken:token.access_token,current});
  if(!current()||await this.ctx.storage.get<string>('owner')!==owner)throw Error('scheduling_grant_revoked');
  return verified;
 }
 private originRequests=new Map<string,Promise<ConnectionOriginResult>>();
 private originTable(){this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS connection_origins (person_id TEXT PRIMARY KEY,scope TEXT NOT NULL,checked_at INTEGER NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS messages_account_canonical ON messages(account,canonical)');}
 private introductionStore(){return new EmailIntroductionStore(this.ctx.storage);}
 private introductionScope(a:Account){return JSON.stringify([a.revision,a.grant]);}
 private introductionRecords(){return this.introductionStore().records(new Map(this.rows().filter(a=>a.contextEnabled&&['connected','syncing'].includes(a.status)).map(a=>[a.email,this.introductionScope(a)])));}
 private async connectionsRevision(){const rows=this.introductionRecords();return rows.length?opaque((await this.ctx.storage.get<string>('owner'))||'',JSON.stringify(rows),this.env.TOKEN_SECRET):undefined;}
 private clearConnectionOrigins(){this.originTable();this.ctx.storage.sql.exec('DELETE FROM connection_origins');this.introductionStore().clear();}
 async connectionOrigin(personId:string):Promise<ConnectionOriginResult>{
  if(typeof personId!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(personId))throw Error('invalid_request');
  const pending=this.originRequests.get(personId);if(pending)return pending;
  let stage='owner';const task=this.findConnectionOrigin(personId,value=>{stage=value;});this.originRequests.set(personId,task);
  try{return await task;}catch(error){console.warn('connection_origin_failed',{stage,kind:error instanceof Error?error.name:'unknown'});throw error;}finally{if(this.originRequests.get(personId)===task)this.originRequests.delete(personId);}
 }
 private async findConnectionOrigin(personId:string,stage:(value:string)=>void=()=>{}):Promise<ConnectionOriginResult>{
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('unknown_person');
  stage('resolve-person');const targetEmails=await this.emailsForMergedPerson(personId),contactRows=this.graphContacts();
  const target=contactRows.find(row=>row.email===targetEmails[0]);
  if(!target)throw Error('unknown_person');
  stage('consent');const usable=(a:Account)=>a.contextEnabled&&['connected','syncing'].includes(a.status);
  const accounts=this.rows().filter(usable);if(!accounts.length)return {status:'disabled'};
  const snapshot=()=>JSON.stringify([this.personMergeStore().get(),this.rows().map(a=>[a.email,a.revision,a.grant,!!a.contextEnabled,['connected','syncing'].includes(a.status)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
  const initial=snapshot(),current=()=>snapshot()===initial;
  const stopped=():ConnectionOriginResult=>({status:this.rows().some(usable)?'unavailable':'disabled',reason:'account_changed'});
  stage('scope');const scope=await opaque(owner,'connection-origin-v6:'+initial+':'+targetEmails.join(','),this.env.TOKEN_SECRET);if(!current())return stopped();
  stage('cache');this.originTable();this.ctx.storage.sql.exec('DELETE FROM connection_origins WHERE checked_at<?',Date.now()-7*86400000);
  const cached=this.ctx.storage.sql.exec<{scope:string;checked_at:number;data:string}>('SELECT scope,checked_at,data FROM connection_origins WHERE person_id=?',personId).toArray()[0];
  if(cached?.scope===scope){const result=JSON.parse(cached.data) as ConnectionOriginResult;if(['found','not_found'].includes(result.status)&&cached.checked_at>Date.now()-(result.status==='found'?3600000:300000)){const revision=await this.connectionsRevision();if(!current())return stopped();delete result.connectionsRevision;if(revision)result.connectionsRevision=revision;return result;}}
  const save=async(result:ConnectionOriginResult)=>{const revision=await this.connectionsRevision();if(!current())return stopped();if(revision)result.connectionsRevision=revision;this.ctx.storage.sql.exec('INSERT OR REPLACE INTO connection_origins VALUES (?,?,?,?)',personId,scope,Date.now(),JSON.stringify(result));return result;};
  // Start with this person's contributions; the account/canonical index avoids scanning an entire inbox.
  const candidates=accounts.flatMap(account=>targetEmails.flatMap(email=>this.ctx.storage.sql.exec<{id:string;date:number}>('SELECT m.id,c.date FROM contributions c INDEXED BY contributions_email CROSS JOIN messages m INDEXED BY messages_account_canonical WHERE c.account=? AND c.email=? AND m.account=c.account AND m.canonical=c.canonical AND (c.sent>0 OR c.received>0) ORDER BY c.date ASC,m.id ASC LIMIT 3',account.email,email).toArray().map(row=>({...row,account:account.email})))).sort((a,b)=>a.date-b.date||a.account.localeCompare(b.account)||a.id.localeCompare(b.id)).slice(0,6);
  const introLimit=24-candidates.length,tokens=new Map<string,string>();
  const mailUrl=(account:string,evidence:{messageId:string;threadId?:string})=>{const url=new URL('https://mail.google.com/mail/u/');url.searchParams.set('authuser',account);url.hash='all/'+(evidence.threadId||evidence.messageId);return url.href;};
  stage('gmail');const viewerEmails=[...new Set(this.rows().map(a=>a.email).concat(owner))],signal=AbortSignal.timeout(45000);
  let scanned=0,failed=false,failureReason='unknown';let found:ConnectionOriginResult['origin'];
  const json=async(url:string,init:RequestInit={},limit=32768)=>{
   // Workers supports manual redirects; reject non-2xx below before credentials can follow a redirect.
   const response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
   if(!response.ok){failureReason=(url.includes('oauth2.googleapis.com')?'token':new URL(url).pathname.endsWith('/messages')?'list':'message')+'_http_'+response.status;console.warn('connection_origin_http',{operation:url.includes('oauth2.googleapis.com')?'token':new URL(url).pathname.endsWith('/messages')?'list':'message',status:response.status});await response.body?.cancel();throw Error('origin_read_failed');}
   return readBoundedJSON(response,limit);
  };
  for(const [accountIndex,account] of accounts.entries()){
   if(!current())return stopped();if(scanned>=introLimit){failed=true;failureReason='message_budget';break;}
   const accountLimit=scanned+Math.ceil((introLimit-scanned)/(accounts.length-accountIndex));
   let operation='decrypt';try{
    if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('origin_read_failed');
    const refresh=await unseal(account.grant,this.env.MAIL_TOKEN_KEY);if(!current())return stopped();
    operation='token';const token=await json('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'})}) as {access_token?:string};
    if(!token||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192)throw Error('origin_read_failed');
    if(!current())return stopped();
    tokens.set(account.email,token.access_token);
    const headers={authorization:'Bearer '+token.access_token};let pageToken:string|undefined;
    for(let page=0;page<2&&scanned<accountLimit;page++){
     const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
     url.searchParams.set('maxResults',String(Math.min(12,accountLimit-scanned)));
     url.searchParams.set('q',`{${targetEmails.map(email=>'to:"'+email+'" cc:"'+email+'"').join(' ')}} {introduce introducing introduction intro connect connecting meet}`);
     if(pageToken)url.searchParams.set('pageToken',pageToken);
     operation='list';const listing=await json(url.href,{headers}) as {messages?:Array<{id:string}>;nextPageToken?:string};if(!current())return stopped();
     if(!listing||listing.messages!==undefined&&!Array.isArray(listing.messages))throw Error('origin_read_failed');
     const ids=[...new Set((listing.messages||[]).map(m=>m?.id))].slice(0,accountLimit-scanned);
     if(ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw Error('origin_read_failed');
     for(let i=0;i<ids.length;i+=2){
      const batch=ids.slice(i,i+2);scanned+=batch.length;
      operation='message';const results=await Promise.allSettled(batch.map(id=>json('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id)+'?format=full&fields=id,threadId,internalDate,payload',{headers},1000000)));
      if(!current())return stopped();
      for(let j=0;j<results.length;j++){
       const response=results[j];if(response.status==='rejected'){if(failureReason==='unknown')failureReason='message_'+(response.reason instanceof Error?response.reason.name:'unknown');console.warn('connection_origin_read_failed',{operation:'message',kind:response.reason instanceof Error?response.reason.name:'unknown'});failed=true;continue;}
       const raw=response.value as GmailMessage;if(raw?.id!==batch[j]){failureReason='message_id_'+(raw?.id===undefined?'missing':typeof raw.id)+'_expected_'+typeof batch[j];failed=true;continue;}
       this.introductionStore().record(raw,account.email,this.introductionScope(account),targetEmails);
       const evidence=targetEmails.map(email=>extractConnectionOrigin(raw,viewerEmails,{email,name:contactRows.find(row=>row.email===email)?.name||target.name})).find(Boolean);if(!evidence)continue;
       if(!found||evidence.observedAt<found.observedAt)found={introducerName:evidence.introducerName,observedAt:evidence.observedAt,subject:evidence.subject,quote:evidence.quote,url:mailUrl(account.email,evidence)};
      }
     }
     if(typeof listing.nextPageToken!=='string'||!listing.nextPageToken||listing.nextPageToken.length>1024)break;pageToken=listing.nextPageToken;
    }
   }catch(error){if(failureReason==='unknown')failureReason=operation+'_'+(error instanceof Error?error.name:'unknown');console.warn('connection_origin_read_failed',{operation,kind:error instanceof Error?error.name:'unknown'});failed=true;if(signal.aborted)break;}
  }
  if(!current())return stopped();
  if(found)return save({status:'found',origin:found});
  if(failed)return {status:'unavailable',reason:failureReason};
  for(const candidate of candidates){
   if(!current())return stopped();if(scanned>=24)break;
   const token=tokens.get(candidate.account);if(!token)return {status:'unavailable',reason:'account_unsearched'};
   try{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id))throw Error('origin_read_failed');
    scanned++;
    const raw=await json('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(candidate.id)+'?format=full&fields=id,threadId,internalDate,payload',{headers:{authorization:'Bearer '+token}},1000000) as GmailMessage;
    if(!current())return stopped();if(raw?.id!==candidate.id)throw Error('origin_read_failed');
    const account=this.get(candidate.account);if(account)this.introductionStore().record(raw,candidate.account,this.introductionScope(account),targetEmails);
    const evidence=targetEmails.map(email=>extractDirectConnectionContext(raw,viewerEmails,{email,name:contactRows.find(row=>row.email===email)?.name||target.name})).find(Boolean);if(!evidence)continue;
    return save({status:'not_found',connection:{direction:evidence.direction,observedAt:evidence.observedAt,subject:evidence.subject,quote:evidence.quote,url:mailUrl(candidate.account,evidence)}});
   }catch(error){console.warn('connection_origin_read_failed',{operation:'direct-message',kind:error instanceof Error?error.name:'unknown'});if(!current())return stopped();return {status:'unavailable',reason:failureReason==='unknown'?'direct_message_'+(error instanceof Error?error.name:'unknown'):failureReason};}
  }
  return save({status:'not_found'});
 }
 private ownerLens(){return this.ownerLensStore??=new OwnerLensStore(this.ctx,this.env,()=>this.ctx.storage.get<string>('owner'));}
 private ownerLensResult(value:OwnerLens){
  if(!value.enabled||!value.granolaEnabled)return value;
  const versions=this.granola().ownerLensVersions(),checked=this.ctx.storage.sql.exec<{id:string;version:string}>('SELECT id,version FROM owner_lens_granola').toArray().filter(row=>versions.get(row.id)===row.version).length;
  return {...value,granolaProgress:{available:versions.size,checked,excerpts:value.sources.filter(source=>source.id.startsWith('owner-granola:')).length}};
 }
 async getOwnerLens(){await this.ownerLens().reconcileGranola(this.granola().ownerLensVersions());const value=this.ownerLens().get();await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async updateOwnerLens(input:{revision:string;fields:OwnerLensFields}){const value=this.ownerLens().update(input);await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async setOwnerLensEnabled(input:{revision:string;enabled:boolean}){const value=await this.ownerLens().setEnabled(input);await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async setOwnerLensGranolaEnabled(input:{revision:string;enabled:boolean}){const value=await this.ownerLens().setGranolaEnabled(input);await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async refreshOwnerLens(input:{revision:string;note?:string}){await this.ownerLens().reconcileGranola(this.granola().ownerLensVersions());const value=await this.ownerLens().refresh(input,valid=>this.collectOwnerLens(valid));await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async acceptOwnerLensSuggestion(input:{revision:string;id:string}){await this.ownerLens().reconcileGranola(this.granola().ownerLensVersions());const value=this.ownerLens().decide(input,true);await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 async dismissOwnerLensSuggestion(input:{revision:string;id:string}){const value=this.ownerLens().decide(input,false);await this.scheduleNextAlarm();return this.ownerLensResult(value);}
 private relevanceStore?:RelevanceStore;
 private store(){return this.relevanceStore??=new RelevanceStore(this.ctx,()=>this.ctx.storage.get<string>('owner'));}
 private granolaSync?:GranolaSync;
 private granola():GranolaSync{return this.granolaSync??=new GranolaSync(this.ctx,this.env,{owner:()=>this.ctx.storage.get<string>('owner'),store:()=>this.store(),invalidateGraph:()=>this.ctx.storage.delete('graph').then(()=>{}),ownerContextChanged:(force=false)=>this.ownerLens().reconcileGranola(this.granola().ownerLensVersions(),force),contacts:()=>this.gmailContacts(),accounts:()=>this.rows().map(a=>a.email)});}
 /**
  * Gmail contacts for identity matching: one row per address with its most common display name
  * and up to five canonical subject theme names. Raw subject lines never leave this object.
  */
 private gmailContacts():GranolaGmailContact[]{
  const own=new Set(this.rows().map(a=>a.email));
  const rows=this.ctx.storage.sql.exec<{email:string;name:string;subject:string}>('SELECT email,name,subject FROM contributions ORDER BY date DESC LIMIT 20000').toArray();
  const grouped=new Map<string,{names:Map<string,number>;subjects:Set<string>}>();
  for(const row of rows){
   if(own.has(row.email))continue;
   const entry=grouped.get(row.email)??{names:new Map<string,number>(),subjects:new Set<string>()};
   entry.names.set(row.name,(entry.names.get(row.name)??0)+1);
   if(entry.subjects.size<5){const tokens=canonicalThemeName(row.subject).split(' ').filter(Boolean).slice(0,4);if(tokens.length>=2)entry.subjects.add(tokens.join(' '));}
   grouped.set(row.email,entry);
  }
  return [...grouped].slice(0,6000).map(([email,entry])=>({email,name:[...entry.names].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0]))[0][0],subjects:[...entry.subjects]}));
 }
 private rows(){return this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM accounts').toArray().map(r=>JSON.parse(r.data) as Account);}
 private get(email:string){const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM accounts WHERE email=?',email).toArray()[0];return row?JSON.parse(row.data) as Account:null;}
 private put(a:Account){a.revision??=crypto.randomUUID();this.ctx.storage.sql.exec('INSERT INTO accounts VALUES (?,?) ON CONFLICT(email) DO UPDATE SET data=excluded.data',a.email,JSON.stringify(a));}
 async begin(nonce:string,pending:Pending){await this.ctx.storage.put('pending:'+nonce,pending);await this.ctx.storage.put('owner',pending.owner);}
 async bindOwner(owner:string){if(typeof owner!=='string'||owner!==owner.trim().toLowerCase()||owner.length>320||!owner.includes('@'))throw Error('missing_owner');const current=await this.ctx.storage.get<string>('owner');if(current&&current!==owner)throw Error('missing_owner');if(!current)await this.ctx.storage.put('owner',owner);}
 async consume(nonce:string,cookie:string){const p=await this.ctx.storage.get<Pending>('pending:'+nonce);if(!p||p.cookie!==cookie||p.expires<Date.now())return null;await this.ctx.storage.delete('pending:'+nonce);return p;}
 async attachAccount(email:string,refresh:string,range:Range,photosEnabled=false,otherPhotosEnabled=false,calendarEnabled=false){if(!this.env.MAIL_TOKEN_KEY)throw Error('mail_not_configured');if(this.rows().length>=10&&!this.get(email))throw Error('account_limit');const old=this.get(email);const grant=refresh?await seal(refresh,this.env.MAIL_TOKEN_KEY):old?.grant;if(!grant)throw Error('offline_access_missing');const a:Account={contextEnabled:old?.contextEnabled,contextVersion:old?.contextVersion,email,grant,photosEnabled,otherPhotosEnabled,calendarEnabled,calendarStatus:calendarEnabled?'pending':'permission_required',photoStatus:photosEnabled?'pending':'permission_required',status:'connected',job:null,lastSync:old?.lastSync||0,nextSync:0,error:'',range};await this.invalidateRetrieval(email);this.put(a);if(!old){this.ctx.storage.sql.exec('DELETE FROM granola_owner_context');await this.ownerLens().reconcileGranola(new Map(),true);}if(!photosEnabled)this.ctx.storage.sql.exec("DELETE FROM contact_photos WHERE account=? AND source='saved'",email);if(!otherPhotosEnabled)this.ctx.storage.sql.exec("DELETE FROM contact_photos WHERE account=? AND source='other'",email);if(!calendarEnabled)this.ctx.storage.sql.exec('DELETE FROM calendar_events WHERE account=?',email);await this.start(email,range);}
 list(){return this.rows().map(({contextEnabled,contextError,email,status,job,lastSync,error,range,photosEnabled,otherPhotosEnabled,photoStatus,calendarEnabled,calendarStatus,calendarLastSync})=>({contextEnabled:!!contextEnabled,contextError,contextCount:this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM gmail_context WHERE account=? AND facts<>?",email,'[]').toArray()[0].n,email,status,calendarEnabled:!!calendarEnabled,calendarStatus,calendarLastSync,calendarCount:this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM calendar_events WHERE account=?',email).toArray()[0].n,photosEnabled,otherPhotosEnabled,photoStatus,photoCount:this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM contact_photos WHERE account=?',email).toArray()[0].n,matchedPhotoCount:this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM contact_photos p WHERE p.account=? AND EXISTS (SELECT 1 FROM contributions c WHERE c.email=p.email) AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.email=p.email)',email).toArray()[0].n,processed:job?.processed||0,lastSync,error,range}));}
 async start(email:string,range?:Range,schedule=true){
  const a=this.get(email);if(!a)throw Error('account_not_found');
  // An old incremental scan cannot certify that the new extractor revisited the 90-day window.
  if(a.job&&a.status==='syncing'&&(!a.contextEnabled||a.job.contextVersion===GMAIL_CONTEXT_VERSION))return;
  if(a.emailEdgeVersion!==2){this.ctx.storage.sql.exec('DELETE FROM mail_edges WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_edge_messages WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_thread_people WHERE account=?',email);}
  const selected=range||a.range,initial=!a.lastSync||Boolean(range)||a.emailEdgeVersion!==2;
  const upgrading=a.contextEnabled&&a.contextVersion!==GMAIL_CONTEXT_VERSION;
  const query=a.emailEdgeVersion===2&&upgrading?'newer_than:90d':initial?(selected==='recent'?'newer_than:90d':''):`after:${Math.floor(a.lastSync/1000)-172800}`;
  // Known useful messages come first; the paginated scan then upgrades all other recent messages.
  const pending=upgrading?this.ctx.storage.sql.exec<{message:string}>('SELECT message FROM gmail_context WHERE account=? AND version<? AND facts<>? AND observed>=? ORDER BY observed DESC LIMIT 300',email,GMAIL_CONTEXT_VERSION,'[]',Date.now()-90*86400000).toArray().map(r=>r.message):[];
  a.job={contextVersion:a.contextEnabled?GMAIL_CONTEXT_VERSION:undefined,calendarDone:!a.calendarEnabled,generation:crypto.randomUUID(),photoSource:a.photosEnabled?'saved':'other',photosDone:!a.photosEnabled&&!a.otherPhotosEnabled,range:selected,query,pageToken:undefined,pending,hasMore:true,processed:0,started:Date.now(),retries:0,lastRun:0,nextAttempt:0};
  a.range=selected;a.status='syncing';a.error='';a.contextError='';this.put(a);if(schedule)await this.scheduleNextAlarm();
 }
 async remove(email:string){const revoking=this.get(email);if(revoking){revoking.contextEnabled=false;revoking.revision=crypto.randomUUID();this.put(revoking);}this.clearConnectionOrigins();this.ctx.storage.sql.exec('DELETE FROM gmail_context WHERE account=?',email);await this.invalidateRetrieval(email);this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM calendar_events WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM accounts WHERE email=?',email);this.ctx.storage.sql.exec('DELETE FROM messages WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM contributions WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_edges WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_edge_messages WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_thread_people WHERE account=?',email);});await this.ownerLens().removeAccount(email);await this.ownerLens().reconcileGranola(new Map(),true);await this.store().removeAccountData(email);await this.ctx.storage.delete('graph');const owner=await this.ctx.storage.get<string>('owner');if(owner){const graph=await this.graph();this.store().cancelPublicPersonWork(owner,new Set(graph?.nodes.map(node=>node.id)??[]));}await this.scheduleNextAlarm();}
 async granolaConnect(apiKey:string,range:GranolaRange):Promise<GranolaStatus>{const status=await this.granola().connect(apiKey,range);await this.scheduleNextAlarm();return status;}
 granolaStatus():GranolaStatus{return this.granola().status();}
 async granolaExcluded(ids:string[]):Promise<GranolaStatus>{const status=await this.granola().setExcluded(ids);await this.scheduleNextAlarm();return status;}
 async granolaSyncNow():Promise<GranolaStatus>{const status=this.granola().syncNow();await this.scheduleNextAlarm();return status;}
 async granolaDisconnect():Promise<void>{await this.granola().disconnect();await this.scheduleNextAlarm();}
 granolaIdentities():{suggestions:GranolaIdentitySuggestion[]}{return {suggestions:this.granola().identitySuggestions()};}
 async granolaIdentity(attendeeEmail:string,decision:'confirm'|'dismiss'):Promise<{suggestions:GranolaIdentitySuggestion[]}>{return {suggestions:await this.granola().resolveIdentity(attendeeEmail,decision)};}
 private active(a:Account){return this.get(a.email)?.job?.generation===a.job?.generation;}
 async resolveOwnEmail(email:string):Promise<string|null>{const owner=await this.ctx.storage.get<string>('owner');if(!owner||!this.graphContacts().some(r=>r.email===email))return null;return opaque(owner,email,this.env.TOKEN_SECRET);}
 private async google(url:string,access:string){const r=await fetch(url,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});if(!r.ok){await r.body?.cancel();const e=new Error(r.status===401?'reconnect_required':r.status===403?'gmail_access_denied':`gmail_${r.status}`);throw e;}return readBoundedJSON(r,2_000_000);}
 async alarm(){
  const now=Date.now();if(await this.ownerLens().retryCleanup(now)){await this.scheduleNextAlarm();return;}for(const a of this.rows()){if(a.status==='connected'&&a.nextSync<=now)await this.start(a.email,undefined,false);}
  const a=this.rows().filter(a=>a.status==='syncing'&&(a.job?.nextAttempt||0)<=now).sort((a,b)=>(a.job?.lastRun||0)-(b.job?.lastRun||0))[0];
  if(a?.job){a.job.lastRun=now;this.put(a);try{await this.batch(a);}catch(e){if(this.active(a)){const current=this.get(a.email)!;current.job!.retries++;current.job!.nextAttempt=Date.now()+Math.min(300000,5000*2**current.job!.retries);const message=e instanceof Error?e.message:'sync_failed';current.error=message;current.status=message==='reconnect_required'?'reconnect':current.job!.retries>=6?'error':'syncing';this.put(current);}}}
  // One source per alarm: a Gmail batch and a Granola tick share no state, and running both
  // would stack their deadlines. scheduleNextAlarm() folds in Granola's next due time, so the
  // Granola tick runs on the next alarm, moments later.
  if(!a?.job)await this.granola().tick(now);
  await this.retrievalBatch();
  await this.publicSourceBatch();
  await this.scheduleNextAlarm();
 }
 private async scheduleNextAlarm(){const now=Date.now(),pending=this.rows().filter(a=>a.status==='syncing'),idle=this.rows().filter(a=>a.status==='connected');const pendingDue=pending.length?Math.max(now+1500,Math.min(...pending.map(a=>a.job?.nextAttempt||0))):undefined;const idleDue=idle.length?Math.max(now+1000,Math.min(...idle.map(a=>a.nextSync))):undefined;const mailDue0=pendingDue===undefined?idleDue:idleDue===undefined?pendingDue:Math.min(pendingDue,idleDue);const granolaDue=this.granola().nextDue(now);const mailDue=mailDue0===undefined?granolaDue:granolaDue===undefined?mailDue0:Math.min(mailDue0,granolaDue);const ownerDue=this.ownerLens().nextDue(now),sourceDue=ownerDue===undefined?mailDue:mailDue===undefined?ownerDue:Math.min(mailDue,ownerDue);const due=await this.store().nextAlarmAt(sourceDue,this.retrievalClaim?.deadline,this.publicClaim?.deadline);if(due!==undefined)await this.ctx.storage.setAlarm(due);else {const storage=this.ctx.storage as unknown as {deleteAlarm?:()=>Promise<void>};if(storage.deleteAlarm)await storage.deleteAlarm();}}
 private async calendarBatch(a:Account,access:string){
  const job=a.job!;if(!a.calendarEnabled||job.calendarDone)return;
  try {
   const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
   url.searchParams.set('timeMin',new Date(job.started-365*86400000).toISOString());url.searchParams.set('timeMax',new Date(job.started+30*86400000).toISOString());
   url.searchParams.set('singleEvents','true');url.searchParams.set('maxResults','250');
   url.searchParams.set('fields','items(id,iCalUID,summary,start,end,attendees,organizer,status,htmlLink),nextPageToken');
   if(job.calendarPage)url.searchParams.set('pageToken',job.calendarPage);
   const response=await fetch(url,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});
   if(!response.ok){await response.body?.cancel();throw Error(response.status===403||response.status===401?'permission_required':'unavailable');}
   const data=await readBoundedJSON(response,4_000_000) as {items?:unknown[];nextPageToken?:string};
   if(!this.active(a))return;
   if(!Array.isArray(data.items)&&data.items!==undefined)throw Error('unavailable');
   this.ctx.storage.transactionSync(()=>{
    for(const raw of data.items||[]){const value=normalizeCalendarEvent(raw,a.email);if(value)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO calendar_events VALUES (?,?,?,?)',a.email,value.key,JSON.stringify(value),job.generation);}
    job.calendarPage=data.nextPageToken;job.calendarPages=(job.calendarPages||0)+1;
    job.calendarDone=!data.nextPageToken||job.calendarPages>=40;
    if(job.calendarDone){this.ctx.storage.sql.exec('DELETE FROM calendar_events WHERE account=? AND generation<>?',a.email,job.generation);a.calendarLastSync=Date.now();}
    a.calendarStatus=data.nextPageToken?(job.calendarDone?'limited':'syncing'):'ready';this.put(a);
   });
   await this.ctx.storage.delete('graph');
  } catch(error){if(!this.active(a))return;job.calendarDone=true;a.calendarStatus=error instanceof Error&&error.message==='permission_required'?'permission_required':'unavailable';
   // Inaccessible data must not continue driving reminders.
   this.ctx.storage.sql.exec('DELETE FROM calendar_events WHERE account=?',a.email);this.put(a);
  }
 }
 async setPersonFeedback(personId:string,action:string){
  if(!['boost','suppress','snooze','clear'].includes(action))throw Error('invalid_feedback');
  personId=await this.canonicalPersonId(personId);
  if(!await this.emailForPerson(personId))throw Error('unknown_person');
  const previous=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM person_feedback WHERE person_id=?',personId).toArray()[0];
  const oldDelta=previous?(JSON.parse(previous.data) as PersonFeedback).delta:0;
  if(action==='clear')this.ctx.storage.sql.exec('DELETE FROM person_feedback WHERE person_id=?',personId);
  else this.ctx.storage.sql.exec('INSERT OR REPLACE INTO person_feedback VALUES (?,?)',personId,JSON.stringify({action,at:Date.now(),until:action==='snooze'?Date.now()+7*86400000:0,delta:action==='boost'?10:action==='suppress'?-10:oldDelta}));
  await this.ctx.storage.delete('graph');return {ok:true};
 }
 private calendarRecords(){
  const records=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM calendar_events LIMIT 100000').toArray();
  const merged=new Map<string,CalendarRecord>();
  for(const r of records){const e=JSON.parse(r.data) as CalendarRecord;const old=merged.get(e.key);if(old){old.people=[...new Set([...old.people,...e.people])];old.acceptedPeople=[...new Set([...old.acceptedPeople,...e.acceptedPeople])];if(e.status==='accepted')old.status='accepted';}else merged.set(e.key,e);}
  return [...merged.values()];
 }
 private async photoBatch(a:Account,access:string){const job=a.job!;if((!a.photosEnabled&&!a.otherPhotosEnabled)||job.photosDone)return;try{const other=job.photoSource==='other';const url=new URL(other?'https://people.googleapis.com/v1/otherContacts':'https://people.googleapis.com/v1/people/me/connections');url.searchParams.set(other?'readMask':'personFields','emailAddresses,photos');if(other){url.searchParams.append('sources','READ_SOURCE_TYPE_CONTACT');url.searchParams.append('sources','READ_SOURCE_TYPE_PROFILE');}url.searchParams.set('pageSize','1000');if(job.photoPage)url.searchParams.set('pageToken',job.photoPage);const response=await fetch(url,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});if(!response.ok){await response.body?.cancel();if((response.status===401||response.status===403)&&this.active(a))this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=? AND source=?',a.email,other?'other':'saved');throw Error('photos_unavailable');}const data=await readBoundedJSON(response,4_000_000) as {connections?:{emailAddresses?:{value?:string}[];photos?:{url?:string;default?:boolean}[]}[];otherContacts?:{emailAddresses?:{value?:string}[];photos?:{url?:string;default?:boolean}[]}[];nextPageToken?:string};if(!this.active(a))return;this.ctx.storage.transactionSync(()=>{for(const person of (other?data.otherContacts:data.connections)||[]){const photo=person.photos?.find(p=>{try{const u=new URL(p.url||'');return !p.default&&u.protocol==='https:'&&(u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))&&!u.username&&!u.password;}catch{return false;}});if(!photo?.url)continue;for(const address of person.emailAddresses||[]){const email=address.value?.trim().toLowerCase();if(email&&email.length<=320)this.ctx.storage.sql.exec("INSERT INTO contact_photos (account,email,url,generation,source) VALUES (?,?,?,?,?) ON CONFLICT(account,email) DO UPDATE SET url=excluded.url,generation=excluded.generation,source=excluded.source WHERE excluded.source='saved' OR contact_photos.source='other' OR contact_photos.generation<>excluded.generation",a.email,email,photo.url,job.generation,other?'other':'saved');}}job.photoPage=data.nextPageToken;job.photosDone=!data.nextPageToken;if(job.photosDone&&!other&&a.otherPhotosEnabled){job.photoSource='other';job.photosDone=false;}if(job.photosDone)this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=? AND generation<>?',a.email,job.generation);a.photoStatus=job.photosDone?'ready':'syncing';this.put(a);});}catch{if(!this.active(a))return;job.photosDone=true;a.photoStatus='unavailable';this.put(a);}}
 private async batch(a:Account){const job=a.job!;if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('mail_not_configured');const refresh=await unseal(a.grant,this.env.MAIL_TOKEN_KEY);const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000)});const tokenBody=await readBoundedJSON(tr,32_768) as {error?:string;access_token?:string};if(!tr.ok)throw Error(tokenBody.error==='invalid_grant'?'reconnect_required':`token_${tr.status}`);const tokens=tokenBody as {access_token:string};if(!this.active(a))return;
  if(a.calendarEnabled&&!job.calendarDone){await this.calendarBatch(a,tokens.access_token);return;}
  await this.photoBatch(a,tokens.access_token);if(!this.active(a))return;
  if(!job.pending.length&&job.hasMore){const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('maxResults','25');url.searchParams.set('q',job.query);if(job.pageToken)url.searchParams.set('pageToken',job.pageToken);const listing=await this.google(url.href,tokens.access_token) as {messages?:{id:string}[];nextPageToken?:string};if(!this.active(a))return;job.pending=(listing.messages||[]).map(m=>m.id);job.pageToken=listing.nextPageToken;job.hasMore=Boolean(listing.nextPageToken);this.put(a);}
  const ownerLearning=this.ownerLens().enabled(),ownerValid=this.ownerLens().guard();let ownerBudget=4;
  const ids=job.pending.slice(0,a.contextEnabled?2:10);for(const id of ids){const seen=this.ctx.storage.sql.exec('SELECT id FROM mail_edge_messages WHERE account=? AND id=?',a.email,id).toArray().length;if(!seen){const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','metadata');for(const header of ['From','To','Cc','Date','Subject','Message-ID'])url.searchParams.append('metadataHeaders',header);let raw:Metadata;try{raw=await this.google(url.href,tokens.access_token) as Metadata;}catch(e){if(e instanceof Error&&e.message==='gmail_404'){job.pending.shift();job.processed++;if(this.active(a))this.put(a);continue;}throw e;}if(!this.active(a))return;const parsed=parseMessage(raw,a.email);this.ctx.storage.transactionSync(()=>{if(parsed){for(const p of parsed.participants){if(p.email===a.email||/^(no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(p.email)||(!p.sent&&!p.received))continue;this.ctx.storage.sql.exec('INSERT OR REPLACE INTO contributions VALUES (?,?,?,?,?,?,?,?)',a.email,parsed.key,p.email,p.name,parsed.date,parsed.subject,p.sent,p.received);}const contacts=parsed.participants.filter(p=>p.email!==a.email&&!/^(no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(p.email)).slice(0,50);
const thread=raw.threadId||parsed.key;
for(const p of contacts)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO mail_thread_people VALUES (?,?,?,?)',a.email,thread,p.email,parsed.subject);
const participants=this.ctx.storage.sql.exec<{email:string}>('SELECT email FROM mail_thread_people WHERE account=? AND thread=? ORDER BY email LIMIT 50',a.email,thread).toArray();
// Large distribution lists are not useful evidence of a personal connection.
if(participants.length<=20)for(let i=0;i<participants.length;i++)for(let j=i+1;j<participants.length;j++)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO mail_edges VALUES (?,?,?,?,?)',a.email,'thread:'+thread,participants[i].email,participants[j].email,parsed.subject);
this.ctx.storage.sql.exec('INSERT OR IGNORE INTO mail_edge_messages VALUES (?,?)',a.email,id);
this.ctx.storage.sql.exec('INSERT OR IGNORE INTO messages VALUES (?,?,?)',a.email,id,parsed?.key||id);}else this.ctx.storage.sql.exec('INSERT OR IGNORE INTO messages VALUES (?,?,?)',a.email,id,id);});}
  if(a.contextEnabled)await this.automaticMessageContext(a,id,tokens.access_token);
  if(ownerLearning&&ownerBudget>0&&this.active(a)&&ownerValid()){const attempted=await this.collectOwnerMessage(a,id,tokens.access_token,()=>ownerValid()&&this.active(a));if(attempted!==undefined)ownerBudget--;}
  if(!this.active(a))return;job.pending.shift();job.processed++;job.retries=0;job.nextAttempt=0;a.error='';this.put(a);
  }
  await this.ctx.storage.delete('graph');
  if(!job.pending.length&&!job.hasMore&&((!a.photosEnabled&&!a.otherPhotosEnabled)||job.photosDone)){a.status='connected';a.emailEdgeVersion=2;if(a.contextEnabled&&!a.contextError&&job.contextVersion===GMAIL_CONTEXT_VERSION)a.contextVersion=GMAIL_CONTEXT_VERSION;a.lastSync=job.started;a.nextSync=Date.now()+3600000;this.put(a);await this.rebuildMetadataRelevance(a);}
 }

 /** Bounded owner learning uses only recent messages already attributed as sent. */
 private async collectOwnerLens(valid:()=>boolean):Promise<OwnerLensCollectionResult|void>{
  let granolaFailed=0,granolaDeferred=0;
  if(this.ownerLens().get().granolaEnabled){
   const owner=await this.ctx.storage.get<string>('owner'),ownerEmails=[...new Set([...(owner?[owner]:[]),...this.rows().map(a=>a.email)])];
   const eligible=[...this.granola().ownerLensVersions()].filter(([id,version])=>!this.ownerLens().hasGranolaNote(id,version));
   const attended=new Set(ownerEmails.length&&eligible.length?this.ctx.storage.sql.exec<{id:string}>(`SELECT j.value AS id FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM granola_attendees a WHERE a.note_id=j.value AND a.email IN (${ownerEmails.map(()=>'?').join(',')})) LIMIT 1000`,JSON.stringify(eligible.map(([id])=>id)),...ownerEmails).toArray().map(row=>row.id):[]);
   granolaDeferred=eligible.filter(([id,version])=>this.ownerLens().granolaRetryAfter(id,version)>Date.now()).length;
   const selected=eligible.filter(([id,version])=>this.ownerLens().granolaRetryAfter(id,version)<=Date.now()).sort((a,b)=>Number(this.ownerLens().granolaRetryAfter(...a)>0)-Number(this.ownerLens().granolaRetryAfter(...b)>0)||Number(attended.has(b[0]))-Number(attended.has(a[0]))).slice(0,3);
   if(!this.granola().status().connected)granolaFailed++;
   for(const [id,version] of selected){
    const current=()=>valid()&&this.ownerLens().get().granolaEnabled&&this.granola().ownerLensVersions().get(id)===version;
    if(!current())break;
    try{
     const note=await this.granola().ownerLensNote(id,version,ownerEmails,current);if(!current())break;if(!note){granolaFailed++;continue;}
     const passages=await collectGranolaOwnerPassages(this.env,note);if(!current())break;
     const meetingPassages=!passages.length&&note.attended?await collectGranolaMeetingTopics(this.env,{summary:note.summary}):[];if(!current())break;
     console.info(JSON.stringify({event:'owner_lens_granola_selection',attended:note.attended,summaryChars:note.summary.length,ownerNameCount:note.ownerNames.length,ownerTranscriptChars:note.ownerTranscript.length,statements:passages.length,meetingPassages:meetingPassages.length}));
     await this.ownerLens().recordGranola({...note,passages,meetingPassages},current);
    }catch(error){granolaFailed++;this.ownerLens().deferGranola(id,version,current);ownerLensDiagnostic('note-extraction',error);}
   }
  }
  if(!valid())return;
  try{const result=await this.collectOwnerMail(valid);return {failed:granolaFailed+(result?.failed??0),deferred:granolaDeferred+(result?.deferred??0)};}
  catch(error){if(this.ownerLens().get().granolaEnabled)return {failed:granolaFailed+1,deferred:granolaDeferred};throw error;}
 }
 private async collectOwnerMail(valid:()=>boolean):Promise<OwnerLensCollectionResult|void>{
  const started=Date.now();let stage:OwnerLensDiagnosticStage='selection',selectedCount=0,attempted=0,failed=0,httpStatus:number|undefined;
  try{
   const accounts=new Map(this.rows().filter(a=>['connected','syncing'].includes(a.status)).map(a=>[a.email,a]));
   const selected=this.ctx.storage.sql.exec<{account:string;id:string}>(`SELECT m.account,m.id,MAX(c.date) AS observed FROM messages m JOIN contributions c ON c.account=m.account AND c.canonical=m.canonical LEFT JOIN owner_lens_messages o ON o.account=m.account AND o.message=m.id LEFT JOIN owner_lens_retries r ON r.account=m.account AND r.message=m.id WHERE (r.next_attempt IS NULL OR r.next_attempt<=?) AND c.sent>0 AND c.received=0 AND c.date>=? AND c.date<=? AND o.message IS NULL GROUP BY m.account,m.id ORDER BY CASE WHEN r.message IS NULL THEN 0 ELSE 1 END,observed DESC LIMIT 40`,Date.now(),Date.now()-OWNER_LENS_WINDOW,Date.now()).toArray().filter(r=>accounts.has(r.account)).slice(0,4);selectedCount=selected.length;
   const accessByAccount=new Map<string,string>();
   for(const item of selected){
    if(!valid())return;const account=accounts.get(item.account)!;
    if(this.get(account.email)?.revision!==account.revision)continue;
    let access=accessByAccount.get(account.email);
    if(!access){
     stage='token-unseal';httpStatus=undefined;
     if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('mail_not_configured');
     const refresh=await unseal(account.grant,this.env.MAIL_TOKEN_KEY);if(!valid())return;
     stage='token-refresh';const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(10000)});httpStatus=response.status;
     const token=await readBoundedJSON(response,32_768) as {access_token?:string};if(!response.ok||!token.access_token)throw Error('owner_lens_unavailable');access=token.access_token;accessByAccount.set(account.email,access);
    }
    stage='collection';httpStatus=undefined;
    const result=await this.collectOwnerMessage(account,item.id,access,valid);if(result!==undefined)attempted++;
    if(result===false)throw Error('owner_lens_unavailable');if(result==='invalid_extraction')failed++;
   }
   if(failed)ownerLensDiagnostic('collection',Error('invalid_extraction'),{elapsedMs:Date.now()-started,selected:selectedCount,attempted});
   return {failed,deferred:this.ownerLens().deferredCount(new Set(accounts.keys()))};
  }catch(error){ownerLensDiagnostic(stage,error,{elapsedMs:Date.now()-started,selected:selectedCount,attempted,httpStatus});throw error;}
 }
 private async collectOwnerMessage(account:Account,id:string,access:string,valid:()=>boolean):Promise<boolean|'invalid_extraction'|undefined>{
  const lens=this.ownerLens(),current=()=>valid()&&this.get(account.email)?.revision===account.revision;
  if(!current()||lens.hasMessage(account.email,id)||lens.retryAfter(account.email,id)>Date.now())return;
  const row=this.ctx.storage.sql.exec<{date:number}>('SELECT c.date FROM contributions c JOIN messages m ON m.account=c.account AND m.canonical=c.canonical WHERE m.account=? AND m.id=? AND c.sent>0 AND c.received=0 AND c.date>=? AND c.date<=? LIMIT 1',account.email,id,Date.now()-OWNER_LENS_WINDOW,Date.now()).toArray()[0];
  if(!row)return;
  const started=Date.now();let stage:OwnerLensDiagnosticStage='gmail-read',httpStatus:number|undefined;
  try{
   const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','full');url.searchParams.set('fields','id,internalDate,payload');
   const response=await fetch(url.href,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});httpStatus=response.status;
   if(!current()) {await response.body?.cancel();return true;}
   if(response.status===404){await response.body?.cancel();stage='source-store';await lens.recordMail(account.email,id,row.date,null,current);return true;}
   if(!response.ok){await response.body?.cancel();throw Error('owner_lens_unavailable');}
   const raw=await readBoundedJSON(response,2_000_000) as GmailMessage;
   stage='mail-processing';if(current())await lens.recordMail(account.email,id,row.date,raw,current);return true;
  }catch(error){ownerLensDiagnostic(stage,error,{elapsedMs:Date.now()-started,httpStatus});
   if(error instanceof Error&&error.message==='invalid_extraction'&&current()){lens.deferExtraction(account.email,id,row.date,current);return 'invalid_extraction';}
   return false;} // Foreground refresh reports failure; background contact sync continues.
 }
 async setAutomaticContext(email:string,enabled:boolean){
  const a=this.get(email);if(!a||typeof enabled!=='boolean')throw Error('invalid_account');
  if(a.contextEnabled===enabled)return {ok:true};
  this.clearConnectionOrigins();a.contextEnabled=enabled;a.contextVersion=0;a.contextError='';a.revision=crypto.randomUUID();
  // Stop the previous generation; a late body/AI response cannot restore disabled context.
  a.job=null;a.status='connected';this.put(a);
  this.ctx.storage.sql.exec('DELETE FROM gmail_context WHERE account=?',email);
  await this.ctx.storage.delete('graph');
  if(enabled)await this.start(email);else await this.scheduleNextAlarm();
  return {ok:true};
 }
 private async automaticMessageContext(a:Account,id:string,access:string){
  if(!this.active(a)||!this.get(a.email)?.contextEnabled||this.get(a.email)?.revision!==a.revision)return;
  const cutoff=Date.now()-90*86400000;
  this.ctx.storage.sql.exec('DELETE FROM gmail_context WHERE observed<?',cutoff);
  if(this.ctx.storage.sql.exec('SELECT message FROM gmail_context WHERE account=? AND message=? AND version>=?',a.email,id,GMAIL_CONTEXT_VERSION).toArray().length)return;
  // Existing metadata restricts body retrieval to recent inbound messages from a contact.
  const row=this.ctx.storage.sql.exec<{email:string;date:number}>('SELECT c.email,c.date FROM contributions c JOIN messages m ON m.account=c.account AND m.canonical=c.canonical WHERE m.account=? AND m.id=? AND c.received>0 AND c.date>=? LIMIT 1',a.email,id,cutoff).toArray()[0];
  if(!row)return;
  try{
   const owner=await this.ctx.storage.get<string>('owner');if(!owner)return;
   const person=await opaque(owner,row.email,this.env.TOKEN_SECRET);
   const storeFacts=(facts:MailFact[],observed=row.date)=>{
    if(!this.active(a)||!this.get(a.email)?.contextEnabled||this.get(a.email)?.revision!==a.revision)return;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO gmail_context (account,message,person,observed,facts,version) VALUES (?,?,?,?,?,?)',a.email,id,person,observed,JSON.stringify(facts),GMAIL_CONTEXT_VERSION);
   };
   const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','full');url.searchParams.set('fields','id,internalDate,payload');
   const response=await fetch(url.href,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});
   if(response.status===404){await response.body?.cancel();storeFacts([]);return;}
   if(!response.ok){await response.body?.cancel();throw Error('gmail_context_unavailable');}
   const raw=await readBoundedJSON(response,2_000_000) as GmailMessage;
   if(!this.active(a)||!this.get(a.email)?.contextEnabled||this.get(a.email)?.revision!==a.revision)return;
   const parsed=parseMessage(raw,a.email),senders=parsed?.participants.filter(p=>p.received&&p.email!==a.email)||[];
   if(raw.id!==id||!parsed||parsed.date<cutoff||parsed.date>Date.now()||senders.length!==1||senders[0].email!==row.email){storeFacts([]);return;}
   const headers=raw.payload?.headers||[];
   if(headers.some(h=>['list-id','list-unsubscribe'].includes(h.name.toLowerCase()))||/^(no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(row.email)){storeFacts([]);return;}
   const body=decodeGmailMessage(raw,24000);
   const facts=await extractMailContext(this.env.AI,body.text);body.text='';
   storeFacts(facts,parsed.date);
  }catch{if(this.active(a)){a.contextVersion=0;a.contextError='Some email context could not be analysed. It will retry on the next sync.';}}
 }
 /** Full private passages for recommendations; never part of workspace exports or graph summaries. */
 async helperContext(){
  const merges=this.personMergeStore().get();
  if(!Object.keys(merges).length)return this.automaticContextSignals(true);
  const ids=await this.mergeIdentities();
  const signals=this.automaticContextSignals(true);
  for(const signal of signals)if(merges[signal.personId!]&&ids.has(signal.personId!)&&ids.has(merges[signal.personId!]))signal.personId=merges[signal.personId!];
  return signals;
 }
 /** Refresh only this known contact, with existing opt-in, before a foreground recommendation. */
 async refreshHelperContext(personId:string){
  const email=await this.emailForPerson(personId);if(!email)return {refreshed:0,pending:false};
  let refreshed=0,budget=4,pending=false;
  for(const original of this.rows().filter(a=>a.contextEnabled&&['connected','syncing'].includes(a.status))){
   if(original.contextVersion!==GMAIL_CONTEXT_VERSION)await this.start(original.email);
   const a=this.get(original.email)!;
   const ids=this.ctx.storage.sql.exec<{id:string}>(`SELECT m.id FROM contributions c JOIN messages m ON m.account=c.account AND m.canonical=c.canonical LEFT JOIN gmail_context g ON g.account=m.account AND g.message=m.id WHERE c.account=? AND c.email=? AND c.received>0 AND c.date>=? AND (g.version IS NULL OR g.version<?) GROUP BY m.id ORDER BY CASE WHEN g.facts IS NOT NULL AND g.facts<>'[]' THEN 0 ELSE 1 END,c.date DESC LIMIT 5`,a.email,email,Date.now()-90*86400000,GMAIL_CONTEXT_VERSION).toArray().map(r=>r.id);
   if(ids.length>budget)pending=true;
   if(!ids.length||!budget)continue;
   const selected=ids.slice(0,budget);budget-=selected.length;
   try{
    if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('mail_not_configured');
    const refresh=await unseal(a.grant,this.env.MAIL_TOKEN_KEY);
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(10000)});
    const token=await readBoundedJSON(response,32_768) as {access_token?:string};
    if(!response.ok||!token.access_token)throw Error('gmail_context_unavailable');
    for(let i=0;i<selected.length;i+=2){
     await Promise.all(selected.slice(i,i+2).map(id=>this.automaticMessageContext(a,id,token.access_token!)));
     if(!this.active(a)||!this.get(a.email)?.contextEnabled||this.get(a.email)?.revision!==a.revision)break;
    }
    for(const id of selected)if(this.ctx.storage.sql.exec('SELECT message FROM gmail_context WHERE account=? AND message=? AND version>=?',a.email,id,GMAIL_CONTEXT_VERSION).toArray().length)refreshed++;
    if(a.contextError)pending=true;
   }catch{pending=true;}
  }
  if(refreshed)await this.ctx.storage.delete('graph');
  return {refreshed,pending};
 }
 private automaticContextSignals(full=false):Array<Omit<ThemeSignal,'owner'>>{
  const active=new Set(this.rows().filter(a=>a.contextEnabled&&['connected','syncing'].includes(a.status)).map(a=>a.email));
  const rows=this.ctx.storage.sql.exec<{account:string;person:string;observed:number;facts:string;version:number}>("SELECT account,person,observed,facts,version FROM gmail_context WHERE observed>=? AND facts<>'[]' ORDER BY observed DESC LIMIT 3000",Date.now()-90*86400000).toArray();
  const counts=new Map<string,number>(),emitted=new Map<string,number>(),signals:Array<Omit<ThemeSignal,'owner'>>=[];
  for(const row of rows){if(!active.has(row.account)||(emitted.get(row.person)||0)>=6)continue;
   let facts:MailFact[];try{facts=JSON.parse(row.facts);if(!Array.isArray(facts))continue;}catch{continue;}
   for(const fact of facts){const count=counts.get(row.person)||0;if((emitted.get(row.person)||0)>=6)break;
    if(!fact||typeof fact.quote!=='string'||!['building','need','experience'].includes(fact.kind))continue;
    counts.set(row.person,count+1);
    // Use the same IDs as the graph preview even while different extraction versions coexist.
    if((full&&row.version<GMAIL_CONTEXT_VERSION)||isOnlyMailLogistics(fact.quote))continue;
    emitted.set(row.person,(emitted.get(row.person)||0)+1);
    const id='gmail-context:'+row.person+':'+row.observed+':'+count;
    signals.push({id,personId:row.person,themeId:'gmail-conversation-context',sourceType:'gmail_body_derived',visibility:'private',observedAt:new Date(row.observed).toISOString(),ingestedAt:new Date(row.observed).toISOString(),confidence:1,summary:fact.quote.slice(0,full?1200:240),evidenceRef:id,contentHash:id,extractorVersion:'gmail-context-v'+row.version,provenance:{title:'Email sender’s own words · '+fact.kind,canonicalUrl:'https://mail.google.com/',publisherHost:'mail.google.com',observedAt:new Date(row.observed).toISOString(),retrievedAt:new Date(row.observed).toISOString(),timeBasis:'observed'}});
   }
  }
  return signals;
 }
 private attachAutomaticContext<T extends {themes:Array<Omit<Theme,'owner'>>;themeSignals:Array<Omit<ThemeSignal,'owner'>>}>(graph:T):T{
  graph.themeSignals.push(...this.automaticContextSignals());
  if(graph.themeSignals.length){const stamp=new Date().toISOString();graph.themes.push({id:'gmail-conversation-context',canonicalName:'Gmail conversation context',aliases:[],description:'Private work context from recent incoming emails',status:'active',createdAt:stamp,updatedAt:stamp});}
  return graph;
 }
 private async rebuildMetadataRelevance(a:Account){const owner=await this.ctx.storage.get<string>('owner');if(!owner||!this.active(a))return;const cutoff=Date.now()-90*86400000;const rows=this.ctx.storage.sql.exec<{email:string;canonical:string;date:number;subject:string}>('SELECT email,canonical,date,subject FROM contributions WHERE account=? AND date>=? ORDER BY date DESC LIMIT 5000',a.email,cutoff).toArray();const inputs:MetadataInput[]=[];for(const row of rows){const personId=await opaque(owner,row.email,this.env.TOKEN_SECRET);const contentHash=await opaque(owner,`${a.email}\u0000${row.canonical}\u0000${row.email}\u0000${row.date}\u0000${row.subject}`,this.env.TOKEN_SECRET);if(!this.active(a))return;inputs.push({personId,subject:row.subject,observedAt:new Date(row.date).toISOString(),contentHash});}if(!this.active(a))return;await this.store().ingestMetadata(a.email,inputs,Date.now(),()=>this.active(a));}
 private async invalidateRetrieval(account:string){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return;
  this.store().removeRetrievalAccount(owner,await opaque(owner,`retrieval-account:${account}`,this.env.TOKEN_SECRET));
 }

 private async retrievalScope(input:RetrievalScope){
  if(!input||typeof input!=='object'||typeof input.account!=='string'||typeof input.personId!=='string'||!input.personId||input.personId.includes('@')||input.personId.length>200||(input.windowDays!==undefined&&![30,90].includes(input.windowDays)))throw Error('retrieval_failed');
  const owner=await this.ctx.storage.get<string>('owner'),account=this.get(input.account);
  if(!owner||!account||!['connected','syncing'].includes(account.status))throw Error('retrieval_failed');
  const rows=this.graphContacts();
  let contact:string|undefined;
  for(const row of rows){if(await opaque(owner,row.email,this.env.TOKEN_SECRET)===input.personId){contact=row.email;break;}}
  if(!contact||this.get(contact)||!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(contact))throw Error('retrieval_failed');
  if(!this.ctx.storage.sql.exec('SELECT 1 FROM contributions WHERE account=? AND email=? LIMIT 1',account.email,contact).toArray().length)throw Error('retrieval_failed');
  let themeName:string|undefined;
  if(input.themeId!==undefined){
   if(typeof input.themeId!=='string'||!input.themeId||input.themeId.length>200)throw Error('retrieval_failed');
   themeName=this.ctx.storage.sql.exec<{canonical_name:string}>('SELECT canonical_name FROM themes WHERE owner=? AND id=?',owner,input.themeId).toArray()[0]?.canonical_name;
   if(!themeName)throw Error('retrieval_failed');
  }
  const accountId=await opaque(owner,`retrieval-account:${account.email}`,this.env.TOKEN_SECRET);
  const revision=account.revision??await opaque(owner,`retrieval-revision:${account.grant}`,this.env.TOKEN_SECRET);
  if(this.get(account.email)?.grant!==account.grant||this.get(account.email)?.revision!==account.revision)throw Error('retrieval_failed');
  return {owner,account,contact,accountId,revision,themeName};
 }

 private async retrievalFingerprint(scope:RetrievalScope,accountId:string,revision:string,owner:string,before:number,expiresAt:number){
  return opaque(owner,JSON.stringify(['gmail-retrieval',accountId,revision,scope.personId,scope.themeId??null,scope.windowDays??30,before,expiresAt,50,1_000_000,EXTRACTOR_VERSION,THEME_MODEL]),this.env.TOKEN_SECRET);
 }

 /** Read-only consent preview: no Gmail calls, queued work, or storage writes. */
 async previewRetrieval(input:RetrievalScope):Promise<RetrievalPreview>{
  const scope=await this.retrievalScope(input),before=Math.floor(Date.now()/1000)+1,expiresAt=Date.now()+600_000,windowDays=input.windowDays??30;
  const fingerprint=await this.retrievalFingerprint(input,scope.accountId,scope.revision,scope.owner,before,expiresAt);
  return {account:input.account,personId:input.personId,...(input.themeId?{themeId:input.themeId}:{}),windowDays,maxMessages:50,maxBytes:1_000_000,before,after:before-windowDays*86400,expiresAt,fingerprint};
 }

 async confirmRetrieval(input:RetrievalPreview & {idempotencyKey:string}){
  if(!input||![30,90].includes(input.windowDays))throw Error('retrieval_failed');
  if(!input||typeof input.idempotencyKey!=='string'||!/^[!-~]{1,200}$/.test(input.idempotencyKey)||typeof input.fingerprint!=='string'||!Number.isSafeInteger(input.before)||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<Date.now()||input.expiresAt>Date.now()+600_000||input.before>Math.floor(Date.now()/1000)+1||input.before<Math.floor(Date.now()/1000)-600||input.maxBytes!==1_000_000||input.maxMessages!==50||input.after!==input.before-(input.windowDays??30)*86400)throw Error('retrieval_failed');
  const scope=await this.retrievalScope(input);
  const fingerprint=await this.retrievalFingerprint(input,scope.accountId,scope.revision,scope.owner,input.before,input.expiresAt);
  if(fingerprint!==input.fingerprint||this.get(scope.account.email)?.revision!==scope.account.revision)throw Error('retrieval_failed');
  const key=await opaque(scope.owner,`retrieval-idempotency:${input.idempotencyKey}`,this.env.TOKEN_SECRET);
  if(this.get(scope.account.email)?.revision!==scope.account.revision)throw Error('retrieval_failed');
  const job=this.store().queueRetrieval({id:crypto.randomUUID(),owner:scope.owner,accountId:scope.accountId,revision:scope.revision,personId:input.personId,themeId:input.themeId,windowDays:input.windowDays,after:input.after,before:input.before,fingerprint,idempotencyKey:key,status:'queued',dueAt:Date.now(),processed:0,decodedBytes:0,assertions:0,pending:[],hasMore:true,seen:[],generation:crypto.randomUUID()});
  await this.scheduleNextAlarm();return retrievalView(job);
 }

 async retrievalStatus(id:string){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner||typeof id!=='string'||id.length>200)return null;
  const job=this.store().retrievalJob(owner,id);return job?retrievalView(job):null;
 }

 private retrievalClaim?:{controller:AbortController;deadline:number};
 private async retrievalBatch(){
  if(this.retrievalClaim)return;
  const controller=new AbortController();
  this.retrievalClaim={controller,deadline:Date.now()+180_000};
  const timer=setTimeout(()=>controller.abort(),180_000);
  try{await this.runRetrievalBatch(controller.signal);}
  finally{clearTimeout(timer);this.retrievalClaim=undefined;}
 }

 private async runRetrievalBatch(signal:AbortSignal){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return;
  const store=this.store(),job=store.nextRetrieval(owner,Date.now());if(!job)return;
  job.generation=crypto.randomUUID();job.status='running';job.dueAt=Date.now()+60_000;store.saveRetrieval(job);
  const current=()=>store.retrievalJob(owner,job.id)?.generation===job.generation;
  const decoded:string[]=[];
  try {
   let account:Account|undefined;
   for(const row of this.rows())if(await opaque(owner,`retrieval-account:${row.email}`,this.env.TOKEN_SECRET)===job.accountId){account=row;break;}
   if(!current())return;if(!account)throw Error('reconnect_required');
   const scope=await this.retrievalScope({account:account.email,personId:job.personId,themeId:job.themeId,windowDays:job.windowDays});
   if(!current())return;if(scope.revision!==job.revision)throw Error('reconnect_required');
   if(!this.env.AI||this.env.THEME_MODEL!==THEME_MODEL)throw Error('ai_unavailable');
   if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('reconnect_required');
   const refresh=await unseal(account.grant,this.env.MAIL_TOKEN_KEY);
   if(!current())return;
   signal.throwIfAborted();
   const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
   if(!current())return;
   if(!tokenResponse.ok){await tokenResponse.body?.cancel();throw Error(tokenResponse.status===400||tokenResponse.status===401?'reconnect_required':'retrieval_failed');}
   const token=await boundedJSON(tokenResponse,16_384);
   if(!isRecord(token)||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192)throw Error('reconnect_required');
   if(!current())return;
   const get=async(url:URL,limit:number)=>{
    signal.throwIfAborted();
    const response=await fetch(url.href,{headers:{authorization:'Bearer '+token.access_token},signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
    if(!response.ok){await response.body?.cancel();throw Error(response.status===401?'reconnect_required':response.status===403?'gmail_access_denied':'retrieval_failed');}
    return boundedJSON(response,limit);
   };
   if(!job.pending.length&&job.hasMore){
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('maxResults',String(50-job.processed));url.searchParams.set('q',`{from:${scope.contact} to:${scope.contact}} after:${job.after} before:${job.before}`);
    if(job.pageToken)url.searchParams.set('pageToken',job.pageToken);
    const listing=await get(url,32_768);if(!current())return;
    if(!isRecord(listing)||(listing.messages!==undefined&&!Array.isArray(listing.messages)))throw Error('retrieval_failed');
    const ids:string[]=[];
    for(const message of ((listing.messages??[]) as unknown[]).slice(0,50-job.processed)){
     if(!isRecord(message)||typeof message.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(message.id))throw Error('retrieval_failed');
     const hash=await opaque(owner,`retrieval-message:${job.accountId}:${message.id}`,this.env.TOKEN_SECRET);
     if(!job.seen.includes(hash)&&!ids.includes(message.id))ids.push(message.id);
    }
    if(listing.nextPageToken!==undefined&&(typeof listing.nextPageToken!=='string'||!/^[a-zA-Z0-9_-]{1,1024}$/.test(listing.nextPageToken)))throw Error('retrieval_failed');
    job.pending=ids;job.pageToken=listing.nextPageToken as string|undefined;job.hasMore=Boolean(job.pageToken)&&ids.length>0;
   }
   let count=0,observedAt=0;
   while(job.pending.length&&count<10&&job.processed<50&&job.decodedBytes<1_000_000){
    if(!current())return;
    const ids=job.pending.slice(0,Math.min(2,10-count,50-job.processed));
    // Fetch at most two concurrently; decode sequentially against the shared byte budget.
    const results=await Promise.allSettled(ids.map(async id=>{const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','full');url.searchParams.set('fields','id,internalDate,payload');return get(url,2_000_000);}));
    if(!current())return;
    for(let i=0;i<ids.length&&job.decodedBytes<1_000_000;i++){
     const result=results[i];if(result.status==='rejected')throw result.reason;
     const raw=result.value;if(!isRecord(raw)||raw.id!==ids[i])throw Error('retrieval_failed');
     const parsed=parseMessage(raw as GmailMessage,account.email);
     if(!parsed)throw Error('retrieval_failed');
     if(parsed.date>=job.after*1000&&parsed.date<job.before*1000&&parsed.participants.some(p=>p.email===scope.contact&&(p.sent||p.received))){
      const body=decodeGmailMessage(raw as GmailMessage,1_000_000-job.decodedBytes);job.decodedBytes+=body.bytes;
      if(body.text){decoded.push(body.text);observedAt=Math.max(observedAt,body.internalDate);}
      body.text='';
     }
     job.seen.push(await opaque(owner,`retrieval-message:${job.accountId}:${ids[i]}`,this.env.TOKEN_SECRET));
     job.pending.shift();job.processed++;count++;
     result.value=undefined;
    }
   }
   if(!current())return;
   const themes:Theme[]=[],signals:(ThemeSignal&{account:string})[]=[];
   if(decoded.length){
    const text=decoded.join('\n');const output=await new ThemeExtractor(this.env.AI,this.env.THEME_MODEL).extract({text,themeName:scope.themeName},signal);
    if(!current())return;
    const contentHash=await opaque(owner,`retrieval-content:${job.accountId}:${job.personId}:${text}`,this.env.TOKEN_SECRET),now=new Date().toISOString();
    for(const item of output){
     const topic=THEME_TOPICS[item.topicId],name=canonicalThemeName(topic.name);
     if(scope.themeName&&name!==canonicalThemeName(scope.themeName))continue;
     const themeId=job.themeId??'theme-'+await opaque(owner,`body-topic:${item.topicId}`,this.env.TOKEN_SECRET);
     const id=await opaque(owner,`body-signal:${job.accountId}:${job.personId}:${themeId}:${contentHash}`,this.env.TOKEN_SECRET);
     // Display text is entirely server-owned; the model can only choose a vocabulary ID.
     const summary=topic.summary;
     themes.push({id:themeId,owner,canonicalName:name,aliases:[topic.name],description:summary,status:'active',createdAt:now,updatedAt:now});
     signals.push({id,owner,account:account.email,personId:job.personId,themeId,sourceType:'gmail_body_derived',visibility:'private',observedAt:new Date(observedAt).toISOString(),ingestedAt:now,confidence:item.confidence,summary,evidenceRef:`gmail-derived:${id}`,contentHash,extractorVersion:EXTRACTOR_VERSION,modelId:THEME_MODEL});
    }
   }
   if(!current())return;
   signal.throwIfAborted();
   job.assertions+=signals.length;
   job.status=job.processed>=50||job.decodedBytes>=1_000_000||(!job.pending.length&&!job.hasMore)?'complete':'queued';
   job.dueAt=Date.now()+1500;
   if(job.status==='complete'){job.pending=[];job.pageToken=undefined;job.hasMore=false;}
   store.commitRetrieval(job,themes,signals);
  }catch(error){
   if(current()){
    // Read the durable checkpoint after rollback; attempted counters were never committed.
    const failed=store.retrievalJob(owner,job.id)!;
    failed.status='failed';failed.error=safeRetrievalError(error);failed.pending=[];failed.pageToken=undefined;failed.hasMore=false;store.saveRetrieval(failed);
   }
  }finally{decoded.fill('');decoded.length=0;}
 }

 /** A public-source preview validates only; consent is the confirm RPC below. */
 async previewPublicSource(input:Omit<PublicSourceInput,'idempotencyKey'>){
  if(!input||typeof input!=='object')throw Error('unsafe_public_source');
  const preview=await previewPublicSource(input.url);await this.publicPerson(input);
  return {...preview,...(Object.hasOwn(input,'personId')?{personId:input.personId}:{})};
 }
 private async publicPerson(input:{personId?:string;graphSource?:'mail'|'obsidian'}){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('missing_owner');
  if(input.graphSource!==undefined&&!['mail','obsidian'].includes(input.graphSource))throw Error('invalid_relevance_person');
  let localGraph:PushedGraphPayload|null=null;
  if(input.graphSource==='obsidian'){
   const row=await this.env.DB?.prepare('SELECT json FROM graphs WHERE email = ?').bind(owner).first<{json:string}>();
   try{localGraph=row?normalizePushedGraph(JSON.parse(row.json)):null;}catch{throw Error('invalid_relevance_person');}
   if(!localGraph)throw Error('invalid_relevance_person');
  }
  if(Object.hasOwn(input,'personId')){
   if(typeof input.personId!=='string'||!input.personId.trim()||input.personId.includes('@')||input.personId.length>200)throw Error('invalid_relevance_person');
   const graph=localGraph??await this.graph();if(!graph?.nodes.some(node=>!!node&&typeof node==='object'&&(node as {id?:unknown}).id===input.personId))throw Error('invalid_relevance_person');
  }
  return owner;
 }
 async confirmPublicSource(input:PublicSourceInput){
  if(!input||typeof input!=='object'||typeof input.idempotencyKey!=='string'||!/^[!-~]{1,200}$/.test(input.idempotencyKey))throw Error('public_source_conflict');
  const preview=await previewPublicSource(input.url),owner=await this.publicPerson(input);
  const id=await opaque(owner,JSON.stringify(['public-source',preview.canonicalUrl,input.personId??null,...(input.graphSource==='obsidian'?['obsidian']:[])]),this.env.TOKEN_SECRET);
  const key=await opaque(owner,`public-confirm:${input.idempotencyKey}`,this.env.TOKEN_SECRET);
  // Recheck after hashing yields: account removal must not leave an invalid association.
  if(await this.publicPerson(input)!==owner)throw Error('invalid_relevance_person');
  const now=Date.now();
  const source=await this.store().queuePublicSource({id,owner,graphSource:input.graphSource??'mail',canonicalUrl:preview.canonicalUrl,publisherHost:preview.publisherHost,...(input.personId?{personId:input.personId}:{}),visibility:'public',status:'queued',generation:crypto.randomUUID(),dueAt:now,updatedAt:new Date(now).toISOString(),extractorVersion:PUBLIC_EXTRACTOR_VERSION,attempts:0,textBytes:0,assertions:0},key);
  await this.scheduleNextAlarm();return publicSourceView(source);
 }
 async publicSourceStatus(id:string,graphSource:'mail'|'obsidian'='mail'){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner||typeof id!=='string'||id.length>200)return null;
  const source=this.store().publicSource(owner,id);if(!source||(source.graphSource??'mail')!==graphSource)return null;
  if(graphSource==='obsidian')try{await this.publicPerson({graphSource,...(source.personId?{personId:source.personId}:{})});}catch{return null;}
  return publicSourceView(source);
 }
 async removePublicSource(id:string){
  if(typeof id!=='string'||!id||id.length>200)throw Error('public_source_conflict');
  await this.store().removePublicSource(id);await this.scheduleNextAlarm();
 }
 private publicClaim?:{deadline:number};
 private async publicSourceBatch(){
  if(this.publicClaim)return;
  const deadline=Date.now()+20_000;this.publicClaim={deadline};
  let source:PublicSourceState|undefined,result:PublicFetchResult|undefined;
  const store=this.store();
  const current=()=>source&&store.publicSource(source.owner,source.id)?.generation===source.generation;
  try {
   await withPublicDeadline(async signal=>{
    const owner=await this.ctx.storage.get<string>('owner');if(!owner)return;
    if(signal.aborted||Date.now()>=deadline)throw Error('public_timeout');
    source=store.nextPublicSource(owner,Date.now())??undefined;if(!source)return;
    source.generation=crypto.randomUUID();source.status='running';source.dueAt=Date.now()+20_000;source.attempts++;store.savePublicSource(source);
    await this.publicPerson({graphSource:source.graphSource,...(source.personId?{personId:source.personId}:{})});
    if(!current())return;
    if(!this.env.AI||this.env.THEME_MODEL!==THEME_MODEL)throw Error('ai_unavailable');
    result=await fetchPublicSource(source.canonicalUrl,fetch,source,signal,deadline);
    if(!current())return;
    const seen=!!result.contentHash&&store.hasPublicRevision(source,result.contentHash);
    const topics=!result.notModified&&!seen&&result.text?await publicAwait(new ThemeExtractor(this.env.AI,this.env.THEME_MODEL).extract({text:result.text},signal),signal):[];
    if(!current())return;
    const topicNamespace=await opaque(owner,source.graphSource==='obsidian'?'public-topic-namespace:obsidian':'public-topic-namespace',this.env.TOKEN_SECRET);
    await this.publicPerson({graphSource:source.graphSource,...(source.personId?{personId:source.personId}:{})});
    if(!current())return;
    if(signal.aborted||Date.now()>=deadline)throw Error('public_timeout');
    const changed=source.contentHash!==result.contentHash;
    source={...source,status:'complete',error:undefined,publisherHost:result.publisherHost,observedAt:changed?result.observedAt:source.observedAt??result.observedAt,retrievedAt:result.retrievedAt,timeBasis:'observed',etag:result.etag,lastModified:result.lastModified,contentHash:result.contentHash,sourceType:result.sourceType,textBytes:result.notModified?source.textBytes:result.textBytes,updatedAt:new Date().toISOString(),extractorVersion:PUBLIC_EXTRACTOR_VERSION};
    store.commitPublicSource(source,topics,topicNamespace);
   });
  }catch(error){
   if(source&&current()){
    // Failed extraction/transaction preserves the prior successful revision and counters.
    const failed=store.publicSource(source.owner,source.id)!;failed.status='failed';failed.error=safePublicError(error);failed.updatedAt=new Date().toISOString();store.finishPublicSource(failed);
   }
  }finally{if(result)result.text='';this.publicClaim=undefined;}
 }

 async relevance(lens:RelevanceLens='my'){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return null;
  const [snapshot,graph]=await Promise.all([this.store().snapshot(lens),this.graph()]);
  return projectRelevancePeople(snapshot,graph?.personAliases||{},new Set(graph?.nodes.map(node=>node.id)||[]));
 }
 async hasMailGraph(){return Boolean((await this.graph())?.nodes.length);}
 async evidence(themeId:string,lens:RelevanceLens='my'){
  const [value,graph]=await Promise.all([this.store().evidence(themeId,lens),this.graph()]);if(!value.theme)return value;
  const aliases=graph?.personAliases||{},ids=new Set(graph?.nodes.map(node=>node.id)||[]),{owner:_,...theme}=value.theme;
  const signals=value.signals.map(({owner:__,...signal})=>({...signal,...(signal.personId?{personId:aliases[signal.personId]||signal.personId}:{})})).filter(signal=>!signal.personId||ids.has(signal.personId));
  return {theme,signals};
 }
 async recordRelevanceFeedback(input:RelevanceFeedbackInput){if(Object.prototype.hasOwnProperty.call(input,'personId')){if(typeof input.personId!=='string'||!input.personId.trim()||input.personId.includes('@'))throw Error('invalid_relevance_person');const graph=await this.graph();if(!graph||!graph.nodes.some(node=>node.id===input.personId))throw Error('invalid_relevance_person');}const value=await this.store().recordFeedback(input);await this.scheduleNextAlarm();return value;}
 async augmentPushedGraph(graph:PushedGraphPayload,lens:RelevanceLens='my'){return this.store().attachPushedGraph(graph,lens);}
 async relevanceFromPushedGraph(graph:PushedGraphPayload,lens:RelevanceLens='my'){return (await this.store().attachPushedGraph(graph,lens)).relevance;}
 async evidenceFromPushedGraph(graph:PushedGraphPayload,themeId:string,lens:RelevanceLens='my'){return this.store().pushedEvidence(graph,themeId,lens);}
 async recordPushedRelevanceFeedback(input:RelevanceFeedbackInput,graph:PushedGraphPayload){
  const combined=await this.store().attachPushedGraph(graph,'my');
  if(!combined.themes.some(theme=>theme.id===input.themeId))throw Error('invalid_relevance_feedback');
  if(input.personId!==undefined&&!graph.nodes.some(node=>!!node&&typeof node==='object'&&(node as {id?:unknown}).id===input.personId))throw Error('invalid_relevance_person');
  if(input.action==='correct'&&!combined.themes.some(theme=>theme.id===input.replacementThemeId))throw Error('invalid_relevance_feedback');
  const value=await this.store().recordFeedback(input);await this.scheduleNextAlarm();return value;
 }
 private graphContacts(){
  const own=new Set([...this.rows().map(a=>a.email),...this.granola().ownEmails()]);
  const mail=this.ctx.storage.sql.exec<{email:string;name:string;sent:number;received:number;last:number}>(`SELECT email, MAX(name) AS name, SUM(sent) AS sent, SUM(received) AS received, MAX(date) AS last FROM (SELECT canonical,email,MAX(name) AS name,MAX(sent) AS sent,MAX(received) AS received,MAX(date) AS date FROM contributions GROUP BY canonical,email) GROUP BY email ORDER BY SUM(sent)+SUM(received) DESC, email ASC LIMIT 6000`).toArray();
  const merged=new Map<string,{email:string;name:string;sent:number;received:number;last:number;meetings:number;lastMeeting:number}>();
  for(const r of mail)merged.set(r.email,{...r,meetings:0,lastMeeting:0});
  for(const m of this.granola().contacts()){const r=merged.get(m.email);if(r){r.meetings=m.meetings;r.lastMeeting=m.last;r.sent+=m.meetings;r.received+=m.meetings;r.last=Math.max(r.last,m.last);if(r.name.includes('@')&&!m.name.includes('@'))r.name=m.name;}else merged.set(m.email,{email:m.email,name:m.name,sent:m.meetings,received:m.meetings,last:m.last,meetings:m.meetings,lastMeeting:m.last});}
  return [...merged.values()].filter(r=>!own.has(r.email)).sort((x,y)=>(y.sent+y.received)-(x.sent+x.received)||x.email.localeCompare(y.email)).slice(0,1500);
 }
 /** Owner-only booking lookup: exact direct identity, adjusted My Network score, no evidence. */
 async bookingContact(email:string):Promise<{owner:string;email:string;name:string;score:number;checkedAt:number;sourceUpdatedAt:number}|null>{
  if(typeof email!=='string')return null;
  email=email.trim().toLowerCase();if(email.length>320||!/^[^\s@]+@[^\s@]+$/.test(email))return null;
  try{
   const owner=await this.ctx.storage.get<string>('owner');if(!owner||owner===email)return null;
   const id=await opaque(owner,email,this.env.TOKEN_SECRET);
   const mailSources=this.ctx.storage.sql.exec<{account:string}>('SELECT DISTINCT account FROM contributions WHERE email=?',email).toArray();
   // Confirmed aliases may affect the existing graph score, but recognition requires
   // this authenticated address itself in direct mail or a visible attendee record.
   if(!mailSources.length&&!this.ctx.storage.sql.exec('SELECT a.email FROM granola_attendees a JOIN granola_notes n ON n.id=a.note_id WHERE a.email=? AND n.hidden=0 LIMIT 1',email).toArray().length)return null;
   // Do not await after reading the contact: disconnects and incremental sync writes must
   // not replace its contributing sources between score and freshness checks.
   const checkedAt=Date.now(),row=this.graphContacts().find(contact=>contact.email===email);if(!row)return null;
   const completions:number[]=[];
   const fresh=(lastSync:unknown):lastSync is number=>typeof lastSync==='number'&&Number.isFinite(lastSync)&&lastSync>0&&lastSync<=checkedAt&&lastSync>=checkedAt-86_400_000;
   for(const source of mailSources){
    const account=this.get(source.account);
    // Gmail retains its completed job. Its connected status and lastSync (set only at
    // completion) are authoritative; a syncing account may already contain partial rows.
    if(!account||account.status!=='connected'||!fresh(account.lastSync))return null;
    completions.push(account.lastSync);
   }
   if(row.meetings){
    const source=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM granola_connection WHERE id=1').toArray()[0];
    const connection=source?JSON.parse(source.data) as {status?:unknown;lastSync?:unknown;job?:unknown}:null;
    // A manual retry can restore connected while retaining an unfinished Granola job.
    if(!connection||connection.status!=='connected'||connection.job!==null||!fresh(connection.lastSync))return null;
    completions.push(connection.lastSync);
   }
   if(!completions.length)return null;
   const feedback=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM person_feedback WHERE person_id=?',id).toArray()[0];
   const delta=feedback?(JSON.parse(feedback.data) as PersonFeedback).delta:0;
   if(typeof delta!=='number'||!Number.isFinite(delta))return null;
   const base=emailScore(row.sent,row.received,(checkedAt-row.last)/86_400_000).combined;
   if(!Number.isFinite(base))return null;
   const score=Math.max(0,Math.min(100,base+delta+relationshipDelta(this.memoryStore().fields(id).relationship)));
   const name=(row.name.includes('@')?email.split('@')[0]:row.name).replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,100)||email.split('@')[0];
   return {owner,email,name,score,checkedAt,sourceUpdatedAt:Math.min(...completions)};
  }catch{return null;} // Corrupt or unavailable contact evidence always falls back to intake.
 }
 /** Exact owner-local relationship lookup, with a verified miss only after all sources finish. */
 async bookingPerson(email:string):Promise<{owner:string;email:string;status:'matched'|'not_found'|'ambiguous'|'unavailable';checkedAt:number;sourceUpdatedAt?:number;name?:string;score?:number}>{
  const owner=await this.ctx.storage.get<string>('owner')||'',checkedAt=Date.now();
  email=typeof email==='string'?email.trim().toLowerCase():'';
  const unknown={owner,email,status:'unavailable' as const,checkedAt};
  if(!owner||owner===email||email.length>320||!/^[^\s@]+@[^\s@]+$/.test(email))return unknown;
  try{
   const contact=await this.bookingContact(email);if(contact)return {...contact,status:'matched'};
   // Never turn a failed exact lookup (stale, corrupt, capped, or partially synced) into a miss.
   if(this.memoryStore().hasManual(email)||this.ctx.storage.sql.exec('SELECT 1 FROM contributions WHERE email=? LIMIT 1',email).toArray().length||this.ctx.storage.sql.exec('SELECT 1 FROM granola_attendees a JOIN granola_notes n ON n.id=a.note_id WHERE a.email=? AND n.hidden=0 LIMIT 1',email).toArray().length)return unknown;
   if(this.ctx.storage.sql.exec("SELECT 1 FROM granola_identity WHERE (attendee_email=? OR contact_email=?) AND status='confirmed' LIMIT 1",email,email).toArray().length)return {...unknown,status:'ambiguous'};
   const source=this.bookingSourceSnapshot(owner);
   return source.ready?{owner,email,status:'not_found',checkedAt:source.checkedAt,sourceUpdatedAt:source.sourceUpdatedAt}:unknown;
  }catch{return unknown;}
 }
 /** Readiness reports actual completion, not merely the presence of a binding. */
 async bookingSourceStatus(){return this.bookingSourceSnapshot(await this.ctx.storage.get<string>('owner')||'');}
 private bookingSourceSnapshot(owner:string):{owner:string;ready:boolean;checkedAt:number;sourceUpdatedAt?:number}{
  const now=Date.now(),unknown={owner,ready:false,checkedAt:now};if(!owner)return unknown;
  try{
   const completions:number[]=[],fresh=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=now&&now-value<=86_400_000;
   for(const account of this.rows()){
    if(account.status!=='connected'||!fresh(account.lastSync)||account.job&&(account.job.pending.length>0||account.job.hasMore))return unknown;
    completions.push(account.lastSync);
   }
   const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM granola_connection WHERE id=1').toArray()[0];
   if(row){const connection=JSON.parse(row.data) as {status?:unknown;lastSync?:unknown;job?:unknown};if(connection.status!=='connected'||connection.job!==null||!fresh(connection.lastSync))return unknown;completions.push(connection.lastSync);}
   return completions.length?{owner,ready:true,checkedAt:now,sourceUpdatedAt:Math.min(...completions)}:unknown;
  }catch{return unknown;}
 }
 /** Resolves an opaque node id back to the contact email, the way retrievalScope does. */
 private async emailForPerson(personId:string){
  personId=await this.canonicalPersonId(personId);
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return null;
  for(const row of [...this.graphContacts(),...this.memoryStore().manualPeople()])if(await opaque(owner,row.email,this.env.TOKEN_SECRET)===personId)return row.email;
  return null;
 }
 private personContextFor(email:string|null){
  // Hashing yields; a disconnect may have removed this exact identity in the meantime.
  if(!email||!this.graphContacts().some(row=>row.email===email)&&!this.memoryStore().hasManual(email))throw Error('unknown_person');
  return this.personContextStore??=new PersonContextStore(this.ctx.storage);
 }
 async getPersonContext(personId:string){
  if(!validContextPerson(personId))throw Error('invalid_request');
  personId=await this.canonicalPersonId(personId);
  const email=await this.emailForPerson(personId);
  return this.personContextFor(email).get(personId);
 }
 async savePersonContext(input:SavePersonContext){
  if(!validPersonContextInput(input))throw Error('invalid_request');
  input={...input,personId:await this.canonicalPersonId(input.personId)};
  const email=await this.emailForPerson(input.personId);
  return this.personContextFor(email).save(input);
 }
 async getRelationshipMemory(personId:string){
  if(!validContextPerson(personId))throw Error('invalid_request');
  this.personContextFor(await this.emailForPerson(personId));return this.memoryForPerson(personId);
 }
 async saveRelationshipMemory(input:SaveRelationshipMemory){
  if(!validSaveRelationshipMemory(input)||input.pointPersonId===input.personId)throw Error('invalid_request');
  input={...input,personId:await this.canonicalPersonId(input.personId),pointPersonId:input.pointPersonId?await this.canonicalPersonId(input.pointPersonId):null};
  if(input.pointPersonId===input.personId)throw Error('invalid_request');
  const personEmail=await this.emailForPerson(input.personId);
  if(input.pointPersonId)this.personContextFor(await this.emailForPerson(input.pointPersonId));
  this.personContextFor(personEmail);
  this.memoryStore().save(input);return this.memoryForPerson(input.personId);
 }
 async relationshipMemoryForEmail(email:string){
  if(!validMemoryEmail(email))throw Error('invalid_request');
  email=email.toLowerCase();const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('missing_owner');
  const id=await opaque(owner,email,this.env.TOKEN_SECRET);
  if(!this.graphContacts().some(r=>r.email===email)&&!this.memoryStore().hasManual(email))return null;
  return this.memoryForPerson(id);
 }
 async captureRelationshipMemory(input:CaptureRelationshipMemory){
  if(!validCaptureRelationshipMemory(input))throw Error('invalid_request');
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('missing_owner');
  const email=input.email.toLowerCase();
  if(new Set([owner,...this.rows().map(a=>a.email),...this.granola().ownEmails()]).has(email))throw Error('invalid_request');
  const rawId=await opaque(owner,email,this.env.TOKEN_SECRET),personId=await this.canonicalPersonId(rawId);
  const store=this.memoryStore();
  // A retry keeps its original owner and fingerprint even after a reversible merge.
  const existing=this.ctx.storage.sql.exec<{person_id:string}>('SELECT person_id FROM person_memory_entries WHERE source_id=?',input.sourceId.trim()).toArray()[0];
  const captureId=existing&&await this.canonicalPersonId(existing.person_id)===personId?existing.person_id:personId;
  const result=await store.capture(captureId,{...input,email},captureId===rawId&&!this.graphContacts().some(p=>p.email===email));
  return {...result,personId,memory:await this.memoryForPerson(personId)};
 }
 async deleteRelationshipEntry(input:{personId:string;entryId:string;revision:string|null}){
  if(!input||Object.keys(input).sort().join(',')!=='entryId,personId,revision'||!validContextPerson(input.personId))throw Error('invalid_request');
  const canonical=await this.canonicalPersonId(input.personId);
  this.personContextFor(await this.emailForPerson(canonical));
  const current=this.memoryStore().get(canonical);if(current.revision!==input.revision)throw Error('person_context_conflict');
  const entry=this.ctx.storage.sql.exec<{person_id:string}>('SELECT person_id FROM person_memory_entries WHERE id=?',input.entryId).toArray()[0];
  if(!entry||await this.canonicalPersonId(entry.person_id)!==canonical)throw Error('not_found');
  this.memoryStore().remove({...input,personId:entry.person_id,revision:this.memoryStore().get(entry.person_id).revision});
  if(entry.person_id!==canonical)this.personContextFor(await this.emailForPerson(canonical)).save({personId:canonical,text:current.text,revision:current.revision});
  return this.memoryForPerson(canonical);
 }
 async recommendationMemory():Promise<RecommendationMemory>{
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('missing_owner');
  const store=this.memoryStore(),wanted=new Set(store.ids()),people:RecommendationMemory['people']={};
  const identities=[...new Set([...this.graphContacts().map(p=>p.email),...store.manualPeople().map(p=>p.email)])].sort();
  const resolved=await Promise.all(identities.map(async email=>({email,id:await opaque(owner,email,this.env.TOKEN_SECRET)})));
  // Hashing yielded: discard identities withdrawn by a concurrent disconnect.
  const current=new Set([...this.graphContacts().map(p=>p.email),...store.manualPeople().map(p=>p.email)]);
  for(const {email,id} of resolved)if(current.has(email)&&wanted.has(id)){
   const memory=await this.memoryForPerson(id);
   // Linked profile notes/facts are private owner reports too. Feed them through the
   // existing evidence interface without copying their text into imported/shared signals.
   const profiles=(memory.aliasMemories||[]).flatMap(alias=>{
    const text=[alias.text,alias.company&&'Company: '+alias.company,alias.building&&'Building: '+alias.building,alias.needs&&'Needs: '+alias.needs,alias.offers&&'Can help with: '+alias.offers,alias.interests.length&&'Interests: '+alias.interests.join(', ')].filter(Boolean).join('\n');
    return text?[{id:'linked-profile:'+alias.personId+':'+alias.revision,text,sourceKind:'text' as const,createdAt:alias.updatedAt??0}]:[];
   });
   // Display keeps ten entries; matching uses the five latest, with full passages intact.
   const entries=[...memory.entries,...profiles].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)).slice(0,5);
   people[memory.personId]={...memory,entries};
  }
  const feedback=this.ctx.storage.sql.exec<{person_id:string;data:string}>('SELECT person_id,data FROM person_feedback ORDER BY person_id').toArray();
  // Source consent and evidence also invalidate in-flight searches even when the contact
  // remains. Use persisted values, never generated graph timestamps, to keep reads stable.
  const sources={
   accounts:this.rows().map(a=>({email:a.email,revision:a.revision,contextEnabled:a.contextEnabled,status:a.status})).sort((a,b)=>a.email.localeCompare(b.email)),
   gmail:this.ctx.storage.sql.exec('SELECT account,message,person,observed,facts,version FROM gmail_context ORDER BY account,message').toArray(),
   signals:this.ctx.storage.sql.exec('SELECT id,account,person_id,visibility,content_hash,summary FROM theme_signals ORDER BY id').toArray(),
   granola:[...this.granola().ownerLensVersions()].sort(([a],[b])=>a.localeCompare(b)),
   // Names-only shares have no theme signals. Fingerprint the same bounded metadata
   // projection used by graph(), including consent level, so withdrawal invalidates
   // an in-flight read even when no private context changed. Refresh time is not evidence.
   shared:{
    people:[...this.sharedPeople().values()].sort((a,b)=>a.email.localeCompare(b.email)),
    edges:this.sharedEdgeRows().sort((a,b)=>a.a.localeCompare(b.a)||a.b.localeCompare(b.b)),
    scopes:this.ctx.storage.sql.exec('SELECT owner,level FROM shared_meta ORDER BY owner LIMIT 20').toArray(),
   },
  };
  const fingerprint=JSON.stringify({people,feedback,sources,personMerges:this.personMergeStore().get(),identities:resolved.filter(r=>current.has(r.email)).map(r=>r.id)});
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint));
  return {revision:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),people};
 }
 /**
  * Outreach draft for one person from their own visible evidence. The prompt carries the
  * display name, company, last contact and at most eight signal summaries — never note
  * bodies, transcripts, API keys or anybody else's evidence. Nothing is ever sent.
  */
 async draftNote(personId:string){
  if(typeof personId!=='string'||!personId||personId.includes('@')||personId.length>200)throw Error('unknown_person');
  personId=await this.canonicalPersonId(personId);
  const graph=await this.graph();const node=graph?.nodes.find(n=>n.id===personId);
  if(!graph||!node)throw Error('unknown_person');
  // A person this owner knows only through somebody else's share has no address here, and the
  // draft must never be written to them: it becomes an introduction request to the sharer.
  const ownEmail=await this.emailForPerson(personId);
  const introVia=ownEmail?null:(await this.sharedPersonFor(personId))?.via[0]??null;
  // A draft addressed to the person themselves may only rest on this owner's own evidence: a
  // person they know independently can also have been shared with them, and another owner's
  // private quote about Bob must never be pasted into an email to Bob.
  const basedOn=graph.themeSignals.filter(s=>s.personId===personId&&(introVia!==null||!s.evidenceRef.startsWith(SHARE_ACCOUNT)))
   .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)).slice(0,8)
   .map(s=>({summary:s.summary,observedAt:s.observedAt,...(s.provenance?.title?{title:s.provenance.title}:{})}));
  const rawTo=ownEmail??introVia;
  // A stored contact email can carry mailto-header-injection characters from a loosely
  // parsed Gmail "From" line (e.g. "victim?bcc=attacker@evil.test"); never hand those to
  // a mailto: link.
  const to=rawTo&&MAILTO_SAFE.test(rawTo)?rawTo:null;
  const intro=introVia?`This is a note to ${introVia} asking for an introduction to ${node.name}; do not write to ${node.name} directly.`:'';
  const draftInput={name:node.name,company:node.company,lastContact:node.lastContact,evidence:basedOn};
  let {subject,body}=await composeDraft(this.env.AI,this.env.THEME_MODEL,draftInput,undefined,intro||undefined);
  let checked=false,warnings:string[]=[];
  // A Jev failure (unauthorized, rate-limited, unavailable, invalid response) never blocks a
  // draft: the owner still gets the unchecked text, just without the "checked" label.
  if(jevConfigured(this.env)){
   try{
    let result=await checkDraft(this.env,{evidence:basedOn,subject,body});
    if(result.unsupported>=0.5||result.asksForMoneyOrSecrets>=0.5){
     ({subject,body}=await composeDraft(this.env.AI,this.env.THEME_MODEL,draftInput,undefined,`${intro?intro+' ':''}${DRAFT_REWRITE_INSTRUCTION}`));
     result=await checkDraft(this.env,{evidence:basedOn,subject,body});
    }
    checked=true;
    if(result.unsupported>=0.5)warnings.push('This draft may mention something not in your notes.');
    if(result.toneOk<0.5)warnings.push('This draft may read as too blunt or off-tone.');
    if(result.asksForMoneyOrSecrets>=0.5)warnings.push('This draft asks for money or credentials; do not send it as is.');
   }catch(e){if(!(e instanceof JevError))throw e;}
  }
  return {to,name:node.name,subject,body,checked,warnings,basedOn,introVia};
 }
 /**
  * "Who can help with…" over the owner's own graph. One `graph()` read feeds a keyword pass in
  * code; when Jev is configured it reranks the candidates from their own evidence. The query and
  * the owner's own names, companies and signal summaries are the only things that leave: never an
  * email address, an opaque id, a note body or anybody else's evidence. A Jev failure is silent —
  * the owner still gets the keyword ranking, labelled `checked:false`.
  */
 async helperPeople(personId:string,brief:string){return rankHelperBrief(this.env,await this.graph(),await this.canonicalPersonId(personId),brief);}
 async searchPeople(query:string){
  if(typeof query!=='string')throw Error('invalid_request');
  const text=query.trim();
  if(!text||text.length>MAX_QUERY_LENGTH)throw Error('invalid_request');
  const graph=await this.graph();
  if(!graph)return {query:text,results:[] as SearchResult[],checked:false};
  // Two views of the same evidence: the keyword pass ranks over everything the owner can see,
  // but only their own evidence may leave to a third party — `own*` drops what another owner
  // shared (`share:` refs) and the edge contexts that came with a share.
  const evidence=new Map<string,SearchEvidence[]>(),ownEvidence=new Map<string,SearchEvidence[]>();
  for(const signal of graph.themeSignals){
   const personId=signal.personId;if(!personId)continue;
   const item={summary:signal.summary,observedAt:signal.observedAt,...(signal.provenance?.title?{title:signal.provenance.title}:{})};
   evidence.set(personId,[...(evidence.get(personId)??[]),item]);
   if(!signal.evidenceRef.startsWith(SHARE_ACCOUNT))ownEvidence.set(personId,[...(ownEvidence.get(personId)??[]),item]);
  }
  const contexts=new Map<string,string[]>(),ownContexts=new Map<string,string[]>();
  for(const edge of graph.edges)for(const id of [edge.source,edge.target]){
   if(!id)continue;
   contexts.set(id,[...(contexts.get(id)??[]),...edge.contexts]);
   if(!edge.types.includes('shared_via'))ownContexts.set(id,[...(ownContexts.get(id)??[]),...edge.contexts]);
  }
  const themes=new Map<string,string[]>();
  for(const theme of graph.relevance?.themes??[])for(const id of theme.nodeIds)themes.set(id,[...(themes.get(id)??[]),theme.name]);
  const candidates=graph.nodes.map(node=>({personId:node.id,name:node.name,company:node.company??null,lastContact:node.lastContact??null,
   evidence:evidence.get(node.id)??[],contexts:contexts.get(node.id)??[],themes:themes.get(node.id)??[]}));
  const ranked=keywordRank(text,candidates);
  let scores=keywordScores(ranked),checked=false;
  if(ranked.length&&jevConfigured(this.env)){
   // One deadline for the whole rerank, not per request: the batches run one after another,
   // each with its own 20s fetch timeout and a possible 429 back-off. Past the deadline the
   // abort surfaces as jev_unavailable and the owner gets the keyword ranking instead.
   const outbound=ranked.map(person=>({...person,evidence:ownEvidence.get(person.personId)??[],contexts:ownContexts.get(person.personId)??[]}));
   try{scores=await jevScores(this.env,text,outbound,AbortSignal.timeout(searchDeadlineMs));checked=true;}
   catch(e){if(!(e instanceof JevError))throw e;scores=keywordScores(ranked);checked=false;}
  }
  return {query:text,results:topResults(text,ranked,scores,{checked}),checked};
 }
 /**
  * A bounded slice of this owner's network for another owner's Durable Object. The scope picks
  * the people, the level decides how much evidence rides along, and the caps bound the whole
  * thing. The owner's own addresses are never in it, no note text beyond a signal summary the
  * owner already sees is, and nothing here is ever served to a browser.
  */
 async workspacePersonalScores(emails:string[]):Promise<Record<string,{base:number;delta:number;score:number}>>{
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return {};
  const wanted=new Set(emails.slice(0,500)),out:Record<string,{base:number;delta:number;score:number}>={};
  for(const row of this.graphContacts())if(wanted.has(row.email)){
   const id=await opaque(owner,row.email,this.env.TOKEN_SECRET);
   const feedback=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM person_feedback WHERE person_id=?',id).toArray()[0];
   const delta=feedback?(JSON.parse(feedback.data) as PersonFeedback).delta:0;
   const base=emailScore(row.sent,row.received,(Date.now()-row.last)/86400000).combined;
   out[row.email]={base,delta,score:Math.max(0,Math.min(100,base+delta))};
  }return out;
 }
 // Viewer-only lookup, or an explicitly consented export. Never reads imported people.
 // Viewer-only RPC: never include these records in an exported share slice.
 async workspacePrivateContext(emails:string[]):Promise<Record<string,import('./workspace-contract').ViewerPrivateContext[]>>{
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return {};
  const wanted=new Set(emails.slice(0,10000)),ids=new Map<string,string>();
  for(const row of this.graphContacts())if(wanted.has(row.email))ids.set(await opaque(owner,row.email,this.env.TOKEN_SECRET),row.email);
  const source=await this.store().shareSource(),out:Record<string,import('./workspace-contract').ViewerPrivateContext[]>={};
  let total=0;
  for(const signal of source.signals.slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))){
   const email=signal.personId?ids.get(signal.personId):undefined;
   if(!email||!signal.summary||!Number.isFinite(Date.parse(signal.observedAt))||signal.evidenceRef.startsWith(SHARE_ACCOUNT))continue;
   const records=out[email]||=[];if(records.length>=10)continue;if(total>=2000)break;
   records.push({summary:signal.summary.slice(0,1000),observedAt:signal.observedAt,sourceType:signal.sourceType,title:signal.provenance?.title?.slice(0,160)||''});total++;
  }
  return out;
 }
 async workspaceProfiles(emails:string[]):Promise<Record<string,WorkspaceProfile>>{
  const wanted=new Set(emails.slice(0,10000)),out:Record<string,WorkspaceProfile>={};
  const photos=new Map(this.ctx.storage.sql.exec<{email:string;url:string}>('SELECT email,MAX(url) AS url FROM contact_photos GROUP BY email').toArray().map(p=>[p.email,p.url]));
  for(const row of this.graphContacts())if(wanted.has(row.email)){
   const name=(row.name.includes('@')?row.email.split('@')[0]:row.name).trim().slice(0,120);
   out[row.email]={name:name||'Name unavailable',photoUrl:workspacePhoto(photos.get(row.email))};
  }return out;
 }
 async exportWorkspaceSlice(scope:ShareScope,level:ShareLevel,shareProfiles=false):Promise<import('./workspace-contract').WorkspaceSlice>{
  const slice=await this.exportSlice(scope,level);
  const rows=new Map(this.graphContacts().map(row=>[row.email,row]));
  const sources=new Map(this.ctx.storage.sql.exec<{email:string;last:number;accounts:string}>('SELECT email,MAX(date) AS last,GROUP_CONCAT(DISTINCT account) AS accounts FROM contributions GROUP BY email').toArray().map(r=>[r.email,r]));
  const calendar=calendarActivity(this.calendarRecords());
  const relationships:import('./workspace-contract').WorkspaceSlice['relationships']={};
  for(const person of slice.people){
   const row=rows.get(person.email),source=sources.get(person.email);
   const activity=row?{version:1 as const,sent:Math.max(0,row.sent-row.meetings),received:Math.max(0,row.received-row.meetings),lastEmail:source?new Date(source.last).toISOString():null,meetings:row.meetings,lastMeeting:row.lastMeeting?new Date(row.lastMeeting).toISOString():null}:undefined;
   relationships[person.email]={...(calendar.has(person.email)?{calendarActivity:calendar.get(person.email)}:{}),activity,inboxes:source?.accounts.split(',')||[],score:row&&row.sent+row.received>0?emailScore(row.sent,row.received,(Date.now()-row.last)/86400000).combined:null,scoreVersion:'email-v1',lastContact:person.lastContact,observedAt:new Date(slice.exportedAt).toISOString(),evidenceCategory:row?(row.meetings&&row.sent+row.received===2*row.meetings?'meeting':'email'):'unknown'};
  }
  // Calendar titles are not part of workspace consent, even when legacy slices contain them.
  slice.signals=slice.signals.filter(signal=>signal.sourceType!=='calendar');
  slice.themes=slice.themes.filter(theme=>slice.signals.some(signal=>signal.themeId===theme.id));
  return {slice,relationships,...(shareProfiles?{profiles:await this.workspaceProfiles(slice.people.map(p=>p.email))}:{}),truncated:slice.people.length>=SHARE_CAPS.people||slice.edges.length>=SHARE_CAPS.edges||slice.signals.length>=SHARE_CAPS.signals||slice.themes.length>=SHARE_CAPS.themes};
 }
 async exportSlice(scope:ShareScope,level:ShareLevel):Promise<SharedSlice>{
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)throw Error('missing_owner');
  const shareLevel=normalizeShareLevel(level),shareScope=normalizeShareScope(scope);
  const own=new Set([...this.rows().map(a=>a.email),...this.granola().ownEmails(),owner]);
  const contacts=this.graphContacts().filter(row=>!own.has(row.email));
  let allowed:Set<string>|null=null;
  if(shareScope.kind==='folders')allowed=this.granola().peopleInFolders(shareScope.ids);
  else if(shareScope.kind==='people'&&'emails' in shareScope)allowed=new Set(shareScope.emails);
  else if(shareScope.kind==='people'){
   // The browser only ever holds opaque node ids, so they are resolved back to addresses here,
   // inside the owner's own object. An id that matches no contact of theirs is simply ignored.
   const wanted=new Set(shareScope.personIds),resolved=new Set<string>();
   for(const row of contacts)if(wanted.has(await opaque(owner,row.email,this.env.TOKEN_SECRET)))resolved.add(row.email);
   allowed=resolved;
  }
  const chosen=contacts.filter(row=>!allowed||allowed.has(row.email)).slice(0,SHARE_CAPS.people);
  const people=chosen.map(row=>({email:row.email,name:sharedDisplayName(row.name,row.email),lastContact:row.last?new Date(row.last).toISOString():null,meetings:row.meetings}));
  const emails=new Set(people.map(person=>person.email));
  const edges=[...this.mergedEdges().values()].filter(edge=>emails.has(edge.a)&&emails.has(edge.b))
   .sort((x,y)=>y.weight-x.weight).slice(0,SHARE_CAPS.edges)
   // A Gmail subject line is raw mailbox content and is never shared at any level. A Granola
   // meeting title is content too, so it rides along only once the level is `themes` or above;
   // at `names` an edge says that two people are connected and how strongly, nothing more.
   .map(edge=>({a:edge.a,b:edge.b,weight:edge.weight,types:edge.types,contexts:shareLevel==='names'?[]:edge.titles.slice(0,3)}));
  const slice:SharedSlice={owner,exportedAt:Date.now(),people,edges,themes:[],signals:[]};
  if(shareLevel==='names')return slice;
  const byPerson=new Map<string,string>();
  for(const person of people)byPerson.set(await opaque(owner,person.email,this.env.TOKEN_SECRET),person.email);
  const source=await this.store().shareSource();
  const names=new Map(source.themes.map(theme=>[theme.id,theme.name]));
  const visible=source.signals.filter(signal=>{
   // Evidence another owner shared with this one is theirs; it is never re-shared onward.
   // `shareSource()` already drops it by account — this is the second net, on the ref shape.
   if(signal.evidenceRef.startsWith(SHARE_ACCOUNT)||!shareableSourceType(signal.sourceType))return false;
   if(!names.has(signal.themeId))return false;
   if(signal.personId&&!byPerson.has(signal.personId))return false;
   // Topic/title sharing keeps the person association without exporting their quote.
   return shareLevel==='statements'||signal.sourceType==='granola'||((!signal.personId||signal.sourceType==='calendar')&&!carriesQuote(signal));
  });
  const titled=this.granolaProvenance({themeSignals:visible.map(({owner:_,...signal})=>signal)}).themeSignals.slice(0,SHARE_CAPS.signals);
  // The theme cap is applied first and the signals are then trimmed to what survived it, so a
  // signal is never shipped pointing at a theme name the far side would have to drop.
  const ordered:string[]=[],seen=new Set<string>();
  for(const signal of titled)if(!seen.has(signal.themeId)){seen.add(signal.themeId);ordered.push(signal.themeId);}
  const kept=new Set(ordered.slice(0,SHARE_CAPS.themes));
  slice.themes=source.themes.filter(theme=>kept.has(theme.id));
  slice.signals=titled.filter(signal=>kept.has(signal.themeId))
   .map(signal=>({email:signal.personId?byPerson.get(signal.personId)??null:null,themeId:signal.themeId,summary:shareLevel==='themes'&&signal.sourceType==='granola'&&(signal.personId||carriesQuote(signal))?'Recorded topic: '+names.get(signal.themeId):signal.summary,observedAt:signal.observedAt,sourceType:signal.sourceType,confidence:signal.confidence,...(signal.provenance?.title?{title:signal.provenance.title}:{})}));
  // Legacy topic signals have no personId. Project them onto recorded attendees at read time,
  // so existing meetings become discoverable without re-extraction or sharing raw note text.
  const meetingTopics=titled.filter(s=>!s.personId&&s.sourceType==='granola'&&s.evidenceRef.startsWith(GRANOLA_NOTE_REF)&&s.evidenceRef.includes('#topic@')&&kept.has(s.themeId));
  const participants=this.granola().noteParticipants(meetingTopics.map(s=>noteIdOf(s.evidenceRef)),shareScope.kind==='folders'?shareScope.ids:undefined);
  for(const signal of meetingTopics)for(const email of participants.get(noteIdOf(signal.evidenceRef))||[]){
   if(!emails.has(email)||slice.signals.length>=SHARE_CAPS.signals)continue;
   // Existing person-specific context for this topic already supports discovery.
   if(slice.signals.some(s=>s.email===email&&s.themeId===signal.themeId&&s.observedAt===signal.observedAt&&s.title===signal.provenance?.title))continue;
   slice.signals.push({email,themeId:signal.themeId,summary:'Meeting topic: '+names.get(signal.themeId)+' (recorded attendee; not an attributed statement)',observedAt:signal.observedAt,sourceType:'granola',confidence:signal.confidence,...(signal.provenance?.title?{title:signal.provenance.title}:{})});
  }
  slice.signals=[...new Map(slice.signals.map(signal=>[JSON.stringify([signal.email,signal.themeId,signal.sourceType,signal.observedAt,signal.summary,signal.title||'']),signal])).values()];
  return slice;
 }
 /**
  * Replace this viewer's cached copy of these owners' slices. A slice arrives from another
  * Durable Object, so `normalizeSlice` bounds and validates it first. People are keyed by this
  * viewer's own opaque ids, so a person both sides know stays one node, and the evidence lands
  * as `firm` signals under `account='share:<owner>'` — visible in the Firm lens, never in Public.
  */
 async importShares(slices:SharedSlice[]):Promise<{owners:string[];people:number}>{
  const viewer=await this.ctx.storage.get<string>('owner');if(!viewer)throw Error('missing_owner');
  const own=new Set([...this.rows().map(a=>a.email),...this.granola().ownEmails(),viewer]);
  const owners:string[]=[];let people=0;
  for(const raw of (Array.isArray(slices)?slices:[]).slice(0,SHARE_CAPS.owners)){
   const slice=normalizeSlice(raw);
   // A share from one of this viewer's own addresses is a share with themselves: skip it.
   if(!slice||own.has(slice.owner)||owners.includes(slice.owner))continue;
   const kept=slice.people.filter(person=>!own.has(person.email)&&person.email!==slice.owner);
   const emails=new Set(kept.map(person=>person.email));
   const stamp=new Date().toISOString(),themes=new Map<string,Theme>(),signals:Array<ThemeSignal&{account:string}>=[];
   const titles:Array<{id:string;title:string}>=[];
   const names=new Map(slice.themes.map(theme=>[theme.id,theme.name]));
   for(const signal of slice.signals){
    const name=names.get(signal.themeId);
    if(!name||(signal.email&&!emails.has(signal.email)))continue;
    const themeId='theme-'+await opaque(viewer,`share-theme:${slice.owner}:${signal.themeId}`,this.env.TOKEN_SECRET);
    themes.set(themeId,{id:themeId,owner:viewer,canonicalName:canonicalThemeName(name)||'shared',aliases:[name],description:`Shared with you by ${slice.owner}`,status:'active',createdAt:stamp,updatedAt:stamp});
    // A slice deliberately carries neither the owner's signal ids nor their evidence refs (both
    // would leak the owner's note ids), so the reference is derived from the shared content.
    const hash=await opaque(viewer,`share-signal:${slice.owner}:${signal.themeId}:${signal.email??''}:${signal.observedAt}:${signal.summary}`,this.env.TOKEN_SECRET);
    const id='signal-'+hash;
    signals.push({id,owner:viewer,account:SHARE_ACCOUNT+slice.owner,...(signal.email?{personId:await opaque(viewer,signal.email,this.env.TOKEN_SECRET)}:{}),
     themeId,sourceType:signal.sourceType as ThemeSignal['sourceType'],visibility:'firm',observedAt:signal.observedAt,ingestedAt:stamp,confidence:signal.confidence,
     summary:signal.summary,evidenceRef:`${SHARE_ACCOUNT}${slice.owner}:${hash}`,contentHash:hash,extractorVersion:SHARE_EXTRACTOR_VERSION});
    // The meeting title the owner sent along. `theme_signals` has no provenance column, so it
    // is kept beside the cache and turned back into provenance at read time.
    if(signal.title)titles.push({id,title:signal.title});
   }
   await this.store().removeAccountData(SHARE_ACCOUNT+slice.owner);
   this.ctx.storage.transactionSync(()=>{
    this.forgetShare(slice.owner);
    for(const person of kept)this.ctx.storage.sql.exec('INSERT INTO shared_people (owner,email,name,last_contact,meetings) VALUES (?,?,?,?,?)',slice.owner,person.email,person.name,person.lastContact,person.meetings);
    for(const edge of slice.edges)if(emails.has(edge.a)&&emails.has(edge.b))this.ctx.storage.sql.exec('INSERT INTO shared_edges (owner,a,b,weight,types,contexts) VALUES (?,?,?,?,?,?)',slice.owner,edge.a,edge.b,edge.weight,JSON.stringify(edge.types),JSON.stringify(edge.contexts));
    for(const title of titles)this.ctx.storage.sql.exec('INSERT INTO shared_signals (owner,signal_id,title) VALUES (?,?,?) ON CONFLICT(owner,signal_id) DO UPDATE SET title=excluded.title',slice.owner,title.id,title.title);
    this.ctx.storage.sql.exec('INSERT INTO shared_meta (owner,refreshed_at,level) VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET refreshed_at=excluded.refreshed_at,level=excluded.level',slice.owner,Date.now(),levelOfSlice(slice));
   });
   // The cache rows are in but the evidence is not yet. If the ingest fails, drop the cache
   // rows again rather than leave a share whose people have no why-now behind them.
   try{if(signals.length)await this.store().ingestWithThemes([...themes.values()],signals);}
   catch(e){this.ctx.storage.transactionSync(()=>this.forgetShare(slice.owner));await this.ctx.storage.delete('graph');throw e;}
   owners.push(slice.owner);people+=kept.length;
  }
  await this.ctx.storage.delete('graph');
  return {owners,people};
 }
 /** Revocation, from either side: the cached people, edges and evidence of one owner, gone. */
 async dropShare(owner:string):Promise<void>{
  if(typeof owner!=='string'||!owner.trim())return;
  const key=owner.trim().toLowerCase();
  this.ctx.storage.transactionSync(()=>this.forgetShare(key));
  await this.store().removeAccountData(SHARE_ACCOUNT+key);
  await this.ctx.storage.delete('graph');
 }
 /** Every cache row of one owner. Call inside a transaction; the evidence goes separately. */
 private forgetShare(owner:string){
  this.ctx.storage.sql.exec('DELETE FROM shared_people WHERE owner=?',owner);
  this.ctx.storage.sql.exec('DELETE FROM shared_edges WHERE owner=?',owner);
  this.ctx.storage.sql.exec('DELETE FROM shared_signals WHERE owner=?',owner);
  this.ctx.storage.sql.exec('DELETE FROM shared_meta WHERE owner=?',owner);
 }
 /** How fresh the imported cache is, and whose it is; the Worker refreshes on a stale stamp. */
 sharedMeta():{refreshedAt:number;owners:string[]}{
  const rows=this.ctx.storage.sql.exec<{owner:string;refreshed_at:number}>('SELECT owner,refreshed_at FROM shared_meta ORDER BY owner ASC').toArray();
  return {refreshedAt:rows.reduce((newest,row)=>Math.max(newest,Number(row.refreshed_at)||0),0),owners:rows.map(row=>row.owner)};
 }
 /** The sharing owner behind a node this viewer knows only through a share, if there is one. */
 private async sharedPersonFor(personId:string){
  const viewer=await this.ctx.storage.get<string>('owner');if(!viewer)return null;
  for(const [email,person] of this.sharedPeople())if(await opaque(viewer,email,this.env.TOKEN_SECRET)===personId)return person;
  return null;
 }
 /** Own co-occurrence edges, by contact address: Gmail threads merged with Granola meetings. */
 private mergedEdges(){
  const mailEdges=this.ctx.storage.sql.exec<{a:string;b:string;weight:number;subject:string}>('SELECT a,b,COUNT(DISTINCT canonical) AS weight,MAX(subject) AS subject FROM mail_edges GROUP BY a,b ORDER BY weight DESC LIMIT 5000').toArray();
  const merged=new Map<string,SharedEdgeValue>();
  // `contexts` mixes Gmail subject lines with Granola meeting titles for the owner's own graph;
  // `titles` keeps the meeting titles apart, because a subject line is never shared and a
  // meeting title only travels at level `themes` or above.
  for(const e of mailEdges){const [a,b]=[e.a,e.b].sort();merged.set(a+'\u0000'+b,{a,b,weight:e.weight,types:['shared_email'],contexts:[e.subject],titles:[]});}
  for(const e of this.granola().edges()){const key=e.a+'\u0000'+e.b;const cur=merged.get(key);if(cur){cur.weight+=e.weight;cur.types.push('shared_meeting');cur.contexts.push(...e.titles.slice(0,2));cur.titles.push(...e.titles);}else merged.set(key,{a:e.a,b:e.b,weight:e.weight,types:['shared_meeting'],contexts:e.titles,titles:[...e.titles]});}
  return merged;
 }
 /** Cached people other owners have shared with this one, one row per address with its owners. */
 private sharedPeople(){
  const out=new Map<string,{email:string;name:string;last:number;meetings:number;via:string[]}>();
  for(const row of this.ctx.storage.sql.exec<{owner:string;email:string;name:string;last_contact:string|null;meetings:number}>('SELECT owner,email,name,last_contact,meetings FROM shared_people ORDER BY owner ASC,email ASC LIMIT 20000').toArray()){
   const last=row.last_contact?Date.parse(row.last_contact):0;
   const at=Number.isFinite(last)?last:0,current=out.get(row.email);
   if(!current){out.set(row.email,{email:row.email,name:row.name,last:at,meetings:row.meetings,via:[row.owner]});continue;}
   if(!current.via.includes(row.owner))current.via.push(row.owner);
   current.meetings+=row.meetings;current.last=Math.max(current.last,at);
   if(current.name.includes('@')&&!row.name.includes('@'))current.name=row.name;
  }
  return out;
 }
 private sharedEdgeRows(){
  return this.ctx.storage.sql.exec<{a:string;b:string;weight:number;contexts:string}>('SELECT a,b,SUM(weight) AS weight,MIN(contexts) AS contexts FROM shared_edges GROUP BY a,b ORDER BY weight DESC LIMIT 5000').toArray()
   .map(row=>({a:row.a,b:row.b,weight:row.weight,contexts:parseList(row.contexts)}));
 }
 async graph(){const owner=await this.ctx.storage.get<string>('owner');if(!owner)return null;const accounts=this.rows();
  const shared=this.sharedPeople();
  if(!accounts.length&&!this.granola().status().connected&&!shared.size&&!this.memoryStore().manualPeople().length)return null;
  const rows=this.graphContacts();
  const photos=new Map(this.ctx.storage.sql.exec<{email:string;url:string}>('SELECT email,MAX(url) AS url FROM contact_photos GROUP BY email').toArray().map(p=>[p.email,p.url]));
  const nodes:GraphPersonNode[]=await Promise.all(rows.map(async r=>({memoryEligible:true,directRelationship:true,directLastContact:new Date(r.last).toISOString(),id:await opaque(owner,r.email,this.env.TOKEN_SECRET),photoUrl:photos.get(r.email)||null,name:r.name.includes('@')?r.email.split('@')[0]:r.name,company:r.email.split('@')[1],companySource:'email_domain',lastContact:new Date(r.last).toISOString(),meetings:r.meetings,lastMeeting:r.lastMeeting?new Date(r.lastMeeting).toISOString():null,contactActivity:{sent:Math.max(0,r.sent-r.meetings),received:Math.max(0,r.received-r.meetings),meetings:r.meetings},...emailScore(r.sent,r.received,(Date.now()-r.last)/86400000)})));
  const idMap=new Map(rows.map((r,i)=>[r.email,nodes[i].id]));
  for(const person of this.memoryStore().manualPeople())if(!idMap.has(person.email)&&nodes.length<MAX_GRAPH_NODES){
   nodes.push({id:person.person_id,name:person.name,company:'',companySource:'owner',manual:true,memoryEligible:true,sources:['manual'],directRelationship:false,directLastContact:null,lastContact:null,lastMeeting:null,photoUrl:null,meetings:0,contactActivity:{sent:0,received:0,meetings:0},...emailScore(0,0,3650)});
   idMap.set(person.email,person.person_id);
  }
  const memoryEligible=new Set(idMap.values());

  // Shared people are looked up by id below; at the caps that is 1500 × 1500 with `find`.
  const nodeById=new Map(nodes.map(node=>[node.id,node]));
  // Shared people join the owner's own graph: a person both sides know keeps one node and
  // gains `via`, an unknown one becomes a node labelled with the owners who shared them. The
  // addresses themselves never leave this object; only the sharing owners' own addresses do.
  const own=new Set([...accounts.map(a=>a.email),...this.granola().ownEmails(),owner]);
  for(const person of shared.values()){
   if(own.has(person.email))continue;
   const id=idMap.get(person.email);
   // A node keeps its own last contact unless the shared one is genuinely later; a share with
   // no date at all leaves it alone, and an unknown date stays null rather than becoming 1970.
   if(id){const node=nodeById.get(id)!;node.via=person.via;if(person.last&&(!node.lastContact||person.last>Date.parse(node.lastContact)))node.lastContact=new Date(person.last).toISOString();continue;}
   if(nodes.length>=MAX_GRAPH_NODES)continue;
   const days=person.last?(Date.now()-person.last)/86400000:3650;
   const node:GraphPersonNode={directRelationship:false,directLastContact:null,id:await opaque(owner,person.email,this.env.TOKEN_SECRET),photoUrl:null,name:sharedDisplayName(person.name,person.email),company:person.email.split('@')[1],companySource:'email_domain',lastContact:person.last?new Date(person.last).toISOString():null,meetings:person.meetings,lastMeeting:null,via:person.via,...emailScore(person.meetings,person.meetings,days)};
   nodes.push(node);idMap.set(person.email,node.id);nodeById.set(node.id,node);
  }
  const merged=this.mergedEdges();
  for(const e of this.sharedEdgeRows()){const key=e.a+'\u0000'+e.b;const cur=merged.get(key);if(cur){cur.weight+=e.weight;if(!cur.types.includes('shared_via'))cur.types.push('shared_via');cur.contexts.push(...e.contexts.slice(0,2));}else merged.set(key,{a:e.a,b:e.b,weight:e.weight,types:['shared_via'],contexts:e.contexts,titles:[]});}
  type ConnectionEvidence={id:string;type:string;title:string;date:string;url:string;owner:string;provenance:{source:string;introducerPersonId?:string}};
  const edges:Array<{source:string|undefined;target:string|undefined;weight:number;types:string[];contexts:string[];kind?:'cooccurrence';evidence?:ConnectionEvidence[]}>= [...merged.values()].filter(e=>idMap.has(e.a)&&idMap.has(e.b)).sort((x,y)=>y.weight-x.weight).slice(0,5000).map(e=>({source:idMap.get(e.a),target:idMap.get(e.b),weight:e.weight,types:e.types,contexts:e.contexts.slice(0,3)}));
  // Bounded individual events for the owner's timeline; shared inbox activity is never exported.
  const activityMap=new Map<string,{id:string;kind:string;at:string;title:string;source:string;personIds:string[]}>();
  const mailActivity=this.ctx.storage.sql.exec<{canonical:string;email:string;at:number;title:string}>("SELECT canonical,email,MAX(date) AS at,MAX(subject) AS title FROM contributions WHERE canonical IN (SELECT canonical FROM contributions GROUP BY canonical ORDER BY MAX(date) DESC LIMIT 1000) GROUP BY canonical,email ORDER BY at DESC LIMIT 20000").toArray();
  for(const row of mailActivity){const personId=idMap.get(row.email);if(!personId||own.has(row.email))continue;const key='mail:'+row.canonical;
   let event=activityMap.get(key);if(!event){event={id:'email-'+activityMap.size,kind:'email',at:new Date(row.at).toISOString(),title:row.title||'Email exchange',source:'Gmail metadata',personIds:[]};activityMap.set(key,event);}if(!event.personIds.includes(personId))event.personIds.push(personId);
  }
  for(const row of this.granola().timelineMeetings()){const personId=idMap.get(row.email);if(!personId||own.has(row.email))continue;const key='meeting:'+row.id;
   let event=activityMap.get(key);if(!event){event={id:'meeting-'+activityMap.size,kind:'meeting',at:row.at,title:row.title||'Meeting',source:row.dateBasis==='created'?'Granola attendee record · date is note creation time':'Granola attendee record · scheduled time',personIds:[]};activityMap.set(key,event);}if(!event.personIds.includes(personId))event.personIds.push(personId);
  }
  const calendar=this.calendarRecords().map((e,i)=>({id:'calendar-'+i,kind:'calendar',at:e.at,end:e.end,allDay:e.allDay,title:e.title,source:'Google Calendar · RSVP, attendance unverified',status:e.status,url:e.url,personIds:e.people.map(email=>idMap.get(email)).filter((id):id is string=>!!id),acceptedPersonIds:e.acceptedPeople.map(email=>idMap.get(email)).filter((id):id is string=>!!id)})).filter(e=>e.personIds.length);
  const personFeedback:Record<string,PersonFeedback>={};
  const feedbackRows=new Map(this.ctx.storage.sql.exec<{person_id:string;data:string}>('SELECT person_id,data FROM person_feedback').toArray().map(r=>[r.person_id,JSON.parse(r.data) as PersonFeedback]));
  for(const node of nodes){const feedback=feedbackRows.get(node.id);if(feedback){personFeedback[node.id]=feedback;Object.assign(node,{baseCombined:node.combined,feedbackDelta:feedback.delta});node.combined=Math.max(0,Math.min(100,node.combined+feedback.delta));}}
  for(const node of nodes)if(memoryEligible.has(node.id)){
   const memory=this.memoryStore().fields(node.id),delta=relationshipDelta(memory.relationship);
   Object.assign(node,{notBefore:memory.notBefore,pointPersonId:memory.pointPersonId});
   if(memory.company){node.company=memory.company;node.companySource='owner';}
   if(delta){const base=(node as GraphPersonNode & {baseCombined?:number}).baseCombined??node.combined;Object.assign(node,{baseCombined:base,relationshipDelta:delta});node.combined=Math.max(0,Math.min(100,base+(feedbackRows.get(node.id)?.delta||0)+delta));}
  }
  const activity=[...activityMap.values(),...calendar].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const stamps=[...accounts.map(a=>Math.max(a.lastSync,a.job?.lastRun||0)),this.granola().status().lastSync,this.sharedMeta().refreshedAt];
  // A Granola-only first sync has no stamps yet; the epoch would read as a 1970 graph.
  const value={personFeedback,activity,activityCoverage:'Up to 1,000 email messages, 500 Granola meetings, and primary-calendar events from the past year through the next 30 days (up to 10,000 per inbox). Calendar events link existing contacts; RSVPs do not establish attendance.',pushedAt:new Date(Math.max(...stamps)||Date.now()).toISOString(),nodes,edges,source:'email_accounts',scoreModel:'email-meeting-frequency-reciprocity-recency-v2',note:'Company labels are email domains. Relationship scores use metadata and meeting attendees. Optional Gmail conversation context keeps selected private work-related excerpts from the last 90 days. Mailbox deletions are not reconciled automatically; Granola deletions reconcile weekly.'};
  // Never cache after an await: a disconnect or another batch may have changed the data.
  const context=this.attachAutomaticContext({themes:[] as Array<Omit<Theme,'owner'>>,themeSignals:[] as Array<Omit<ThemeSignal,'owner'>>});
  const assembled=this.sharedProvenance(this.granolaProvenance(await this.store().attachToGraph(value,'my',Date.now(),context)));
  // Apply private source metadata only after the final async read, with a fresh consent fence.
  let introductionRows=this.introductionRecords();const introductionSnapshot=JSON.stringify(introductionRows);
  let connectionsRevision=introductionRows.length?await opaque(owner,introductionSnapshot,this.env.TOKEN_SECRET):undefined;
  if(JSON.stringify(this.introductionRecords())!==introductionSnapshot){introductionRows=[];connectionsRevision=undefined;}
  const edgeByPair=new Map(edges.map(edge=>[[edge.source,edge.target].sort().join('\0'),edge]));
  for(const [introIndex,intro] of introductionRows.entries()){
   const [source,target]=intro.participants.map(person=>idMap.get(person.email));if(!source||!target||source===target)continue;
   const key=[source,target].sort().join('\0');let edge=edgeByPair.get(key);
   if(!edge){if(edges.length>=5000)continue;edge={source,target,weight:1,types:['shared_email'],contexts:[]};edges.push(edge);edgeByPair.set(key,edge);}
   if(!edge.types.includes('introduced'))edge.types.push('introduced');edge.kind='cooccurrence';
   const introducer=own.has(intro.introducer.email)?'you':intro.introducer.name||intro.introducer.email.split('@')[0];
   const url=new URL('https://mail.google.com/mail/u/');url.searchParams.set('authuser',intro.account);url.hash='all/'+intro.threadId;
   const introducerId=idMap.get(intro.introducer.email);
   (edge.evidence??=[]).push({id:'intro:'+introIndex+':'+intro.messageId,type:'introduced',title:'Introduced by '+introducer,date:intro.observedAt,url:url.href,owner:own.has(intro.introducer.email)?'You':introducer,provenance:{source:'gmail',...(introducerId?{introducerPersonId:introducerId}:{})}});
  }
  return projectPersonMerges({...assembled,connectionsRevision},this.personMergeStore().get());
 }
 /**
  * The meeting title that rode along with a shared signal, turned back into provenance. The
  * canonical URL is the Granola home page, never the owner's note: the viewer sees
  * "Meeting <title>" with no link, and the note itself stays with its owner.
  */
 private sharedProvenance<T extends {themeSignals:Array<Omit<ThemeSignal,'owner'>>}>(graph:T){
  const shared=graph.themeSignals.filter(s=>s.evidenceRef.startsWith(SHARE_ACCOUNT));
  if(!shared.length)return graph;
  const titles=new Map(this.ctx.storage.sql.exec<{signal_id:string;title:string}>('SELECT signal_id,MAX(title) AS title FROM shared_signals GROUP BY signal_id LIMIT 20000').toArray().map(row=>[row.signal_id,row.title]));
  if(!titles.size)return graph;
  for(const signal of shared){
   const title=titles.get(signal.id);if(!title)continue;
   signal.provenance={canonicalUrl:'https://granola.ai/',publisherHost:'granola.ai',observedAt:signal.observedAt,retrievedAt:signal.ingestedAt,timeBasis:'observed',title};
  }
  return graph;
 }
 /** Evidence panels need the meeting behind a Granola signal; the note stays server-side. */
 private granolaProvenance<T extends {themeSignals:Array<Omit<ThemeSignal,'owner'>>}>(graph:T){
  const refs=graph.themeSignals.filter(s=>s.evidenceRef.startsWith(GRANOLA_NOTE_REF)).map(s=>noteIdOf(s.evidenceRef));
  if(!refs.length)return graph;
  const meta=this.granola().noteMeta(refs);
  for(const signal of graph.themeSignals){
   if(!signal.evidenceRef.startsWith(GRANOLA_NOTE_REF))continue;
   const note=meta.get(noteIdOf(signal.evidenceRef));if(!note)continue;
   signal.provenance={canonicalUrl:note.webUrl??'https://granola.ai/',publisherHost:'granola.ai',observedAt:note.meetingAt,retrievedAt:new Date(note.syncedAt).toISOString(),timeBasis:'observed',title:note.title};
  }
  return graph;
 }
}
const GRANOLA_NOTE_REF='granola-note:';
const SHARE_ACCOUNT='share:';
const SHARE_EXTRACTOR_VERSION='network-share-v1';
// Own contacts are already capped at 1500 by graphContacts(); shared people are added on top
// of them up to the same ceiling, so twenty incoming shares can never unbound the payload.
const MAX_GRAPH_NODES=3000;
function parseList(value:unknown):string[]{try{const items=JSON.parse(String(value));return Array.isArray(items)?items.filter((item):item is string=>typeof item==='string').slice(0,8):[];}catch{return [];}}
function noteIdOf(evidenceRef:string){return evidenceRef.slice(GRANOLA_NOTE_REF.length).split('#')[0];}
// An address safe to place inside a mailto: link without opening header injection
// (?/&/# start mailto query/fragment syntax, %<>/"' can break out of an href attribute).
const MAILTO_SAFE=/^[^\s?&#%/<>"']+@[^\s?&#%/<>"']+$/;
const DRAFT_REWRITE_INSTRUCTION='Only mention items present in the evidence. Do not ask for money or credentials.';
const SEARCH_DEADLINE_MS=15_000;
let searchDeadlineMs=SEARCH_DEADLINE_MS;
/** Test-only hook: shrink the network-search deadline. Pass null to restore the real one. */
export function __setSearchDeadlineForTests(ms:number|null):void{searchDeadlineMs=ms??SEARCH_DEADLINE_MS;}

function retrievalView(job:RetrievalJob){return {id:job.id,status:job.status,error:job.error,personId:job.personId,themeId:job.themeId,windowDays:job.windowDays,processed:job.processed,decodedBytes:job.decodedBytes,assertions:job.assertions,maxMessages:50,maxBytes:1_000_000};}
function publicSourceView(source:PublicSourceState){const {owner:_,generation:__,dueAt:___,pendingRefresh:____,...view}=source;return {...view,visibility:'public' as const};}
function safeRetrievalError(error:unknown):RetrievalError {const code=error instanceof Error?error.message:'';return code==='reconnect_required'||code==='gmail_access_denied'||code==='ai_unavailable'||code==='invalid_extraction'?code:'retrieval_failed';}
function isRecord(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
async function boundedJSON(response:Response,maxBytes:number):Promise<unknown>{
 try{return await readBoundedJSON(response,maxBytes);}catch{throw Error('retrieval_failed');}
}
