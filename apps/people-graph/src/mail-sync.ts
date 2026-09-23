import {DurableObject} from 'cloudflare:workers';
import {parseMessage,emailScore,seal,unseal,opaque, type Metadata} from './mail-model';
import {RelevanceStore, type RelevanceFeedbackInput} from './relevance-store';
import type {MetadataInput} from './relevance-store';
import type {RelevanceLens} from './relevance-model';
import {canonicalThemeName,type Theme,type ThemeSignal} from './relevance-model';
import {decodeGmailMessage} from './gmail-body';
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
export interface MailEnv {MAIL:Env['MAIL'];DB?:Env['DB'];AI?:Env['AI'];THEME_MODEL?:Env['THEME_MODEL'];GOOGLE_CLIENT_ID:string;GOOGLE_CLIENT_SECRET?:string;MAIL_TOKEN_KEY?:string;TOKEN_SECRET:string;APP_ORIGIN?:string;TYPESAFE_API_KEY?:string;JEV_MODEL?:string}
type Range='recent'|'all';
interface Job {photoSource?:'saved'|'other';photoPage?:string;photosDone?:boolean;generation:string;range:Range;query:string;pageToken?:string;pending:string[];hasMore:boolean;processed:number;started:number;retries:number;lastRun:number;nextAttempt:number}
interface Account {revision?:string;otherPhotosEnabled?:boolean;photosEnabled?:boolean;photoStatus?:string;email:string;grant:string;status:string;job:Job|null;lastSync:number;nextSync:number;error:string;range:Range}
interface Pending {verifier:string;cookie:string;expires:number;range:Range;owner:string;redirect:string}
interface SharedEdgeValue {a:string;b:string;weight:number;types:string[];contexts:string[];titles:string[]}
/** One person in `graph()`: `via` names the owners who shared them, and is the only address there. */
interface GraphPersonNode {id:string;photoUrl:string|null;name:string;company:string;companySource:string;lastContact:string|null;meetings:number;lastMeeting:string|null;strength:number;momentum:number;combined:number;quadrant:string;via?:string[]}
export class MailSync extends DurableObject<MailEnv>{
 constructor(ctx:DurableObjectState,env:MailEnv){super(ctx,env);ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS contact_photos (account TEXT NOT NULL,email TEXT NOT NULL,url TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(account,email)); CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (account TEXT NOT NULL,id TEXT NOT NULL,canonical TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS contributions (account TEXT NOT NULL,canonical TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,date INTEGER NOT NULL,subject TEXT NOT NULL,sent INTEGER NOT NULL,received INTEGER NOT NULL,PRIMARY KEY(account,canonical,email)); CREATE INDEX IF NOT EXISTS contributions_email ON contributions(email); CREATE INDEX IF NOT EXISTS contributions_account_date ON contributions(account,date DESC); CREATE TABLE IF NOT EXISTS mail_edges (account TEXT,canonical TEXT,a TEXT,b TEXT,subject TEXT,PRIMARY KEY(account,canonical,a,b)); CREATE TABLE IF NOT EXISTS shared_people (owner TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL,last_contact TEXT,meetings INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,email)); CREATE INDEX IF NOT EXISTS shared_people_email ON shared_people(email); CREATE TABLE IF NOT EXISTS shared_edges (owner TEXT NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,weight INTEGER NOT NULL,types TEXT NOT NULL,contexts TEXT NOT NULL,PRIMARY KEY(owner,a,b)); CREATE TABLE IF NOT EXISTS shared_signals (owner TEXT NOT NULL,signal_id TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(owner,signal_id)); CREATE TABLE IF NOT EXISTS shared_meta (owner TEXT PRIMARY KEY,refreshed_at INTEGER NOT NULL,level TEXT NOT NULL);`);if(!this.ctx.storage.sql.exec("SELECT name FROM pragma_table_info('contact_photos') WHERE name='source'").toArray().length)this.ctx.storage.sql.exec("ALTER TABLE contact_photos ADD COLUMN source TEXT NOT NULL DEFAULT 'saved'");this.store();this.granola();}
 private relevanceStore?:RelevanceStore;
 private store(){return this.relevanceStore??=new RelevanceStore(this.ctx,()=>this.ctx.storage.get<string>('owner'));}
 private granolaSync?:GranolaSync;
 private granola(){return this.granolaSync??=new GranolaSync(this.ctx,this.env,{owner:()=>this.ctx.storage.get<string>('owner'),store:()=>this.store(),invalidateGraph:()=>this.ctx.storage.delete('graph').then(()=>{}),contacts:()=>this.gmailContacts(),accounts:()=>this.rows().map(a=>a.email)});}
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
 async attachAccount(email:string,refresh:string,range:Range,photosEnabled=false,otherPhotosEnabled=false){if(!this.env.MAIL_TOKEN_KEY)throw Error('mail_not_configured');if(this.rows().length>=10&&!this.get(email))throw Error('account_limit');const old=this.get(email);const grant=refresh?await seal(refresh,this.env.MAIL_TOKEN_KEY):old?.grant;if(!grant)throw Error('offline_access_missing');const a:Account={email,grant,photosEnabled,otherPhotosEnabled,photoStatus:photosEnabled?'pending':'permission_required',status:'connected',job:null,lastSync:old?.lastSync||0,nextSync:0,error:'',range};await this.invalidateRetrieval(email);this.put(a);if(!photosEnabled)this.ctx.storage.sql.exec("DELETE FROM contact_photos WHERE account=? AND source='saved'",email);if(!otherPhotosEnabled)this.ctx.storage.sql.exec("DELETE FROM contact_photos WHERE account=? AND source='other'",email);await this.start(email,range);}
 list(){return this.rows().map(({email,status,job,lastSync,error,range,photosEnabled,otherPhotosEnabled,photoStatus})=>({email,status,photosEnabled,otherPhotosEnabled,photoStatus,photoCount:this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM contact_photos WHERE account=?',email).toArray()[0].n,matchedPhotoCount:this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM contact_photos p WHERE p.account=? AND EXISTS (SELECT 1 FROM contributions c WHERE c.email=p.email) AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.email=p.email)',email).toArray()[0].n,processed:job?.processed||0,lastSync,error,range}));}
 async start(email:string,range?:Range,schedule=true){const a=this.get(email);if(!a)throw Error('account_not_found');if(a.job&&a.status==='syncing')return;const selected=range||a.range,initial=!a.lastSync||Boolean(range);const query=initial?(selected==='recent'?'newer_than:90d':''):`after:${Math.floor(a.lastSync/1000)-172800}`;a.job={generation:crypto.randomUUID(),photoSource:a.photosEnabled?'saved':'other',photosDone:!a.photosEnabled&&!a.otherPhotosEnabled,range:selected,query,pageToken:undefined,pending:[],hasMore:true,processed:0,started:Date.now(),retries:0,lastRun:0,nextAttempt:0};a.range=selected;a.status='syncing';a.error='';this.put(a);if(schedule)await this.scheduleNextAlarm();}
 async remove(email:string){await this.invalidateRetrieval(email);this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM accounts WHERE email=?',email);this.ctx.storage.sql.exec('DELETE FROM messages WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM contributions WHERE account=?',email);this.ctx.storage.sql.exec('DELETE FROM mail_edges WHERE account=?',email);});await this.store().removeAccountData(email);await this.ctx.storage.delete('graph');const owner=await this.ctx.storage.get<string>('owner');if(owner){const graph=await this.graph();this.store().cancelPublicPersonWork(owner,new Set(graph?.nodes.map(node=>node.id)??[]));}await this.scheduleNextAlarm();}
 async granolaConnect(apiKey:string,range:GranolaRange):Promise<GranolaStatus>{const status=await this.granola().connect(apiKey,range);await this.scheduleNextAlarm();return status;}
 granolaStatus():GranolaStatus{return this.granola().status();}
 async granolaExcluded(ids:string[]):Promise<GranolaStatus>{const status=await this.granola().setExcluded(ids);await this.scheduleNextAlarm();return status;}
 async granolaSyncNow():Promise<GranolaStatus>{const status=this.granola().syncNow();await this.scheduleNextAlarm();return status;}
 async granolaDisconnect():Promise<void>{await this.granola().disconnect();await this.scheduleNextAlarm();}
 granolaIdentities():{suggestions:GranolaIdentitySuggestion[]}{return {suggestions:this.granola().identitySuggestions()};}
 async granolaIdentity(attendeeEmail:string,decision:'confirm'|'dismiss'):Promise<{suggestions:GranolaIdentitySuggestion[]}>{return {suggestions:await this.granola().resolveIdentity(attendeeEmail,decision)};}
 private active(a:Account){return this.get(a.email)?.job?.generation===a.job?.generation;}
 private async google(url:string,access:string){const r=await fetch(url,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});if(!r.ok){await r.body?.cancel();const e=new Error(r.status===401?'reconnect_required':r.status===403?'gmail_access_denied':`gmail_${r.status}`);throw e;}return readBoundedJSON(r,2_000_000);}
 async alarm(){
  const now=Date.now();for(const a of this.rows()){if(a.status==='connected'&&a.nextSync<=now)await this.start(a.email,undefined,false);}
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
 private async scheduleNextAlarm(){const now=Date.now(),pending=this.rows().filter(a=>a.status==='syncing'),idle=this.rows().filter(a=>a.status==='connected');const pendingDue=pending.length?Math.max(now+1500,Math.min(...pending.map(a=>a.job?.nextAttempt||0))):undefined;const idleDue=idle.length?Math.max(now+1000,Math.min(...idle.map(a=>a.nextSync))):undefined;const mailDue0=pendingDue===undefined?idleDue:idleDue===undefined?pendingDue:Math.min(pendingDue,idleDue);const granolaDue=this.granola().nextDue(now);const mailDue=mailDue0===undefined?granolaDue:granolaDue===undefined?mailDue0:Math.min(mailDue0,granolaDue);const due=await this.store().nextAlarmAt(mailDue,this.retrievalClaim?.deadline,this.publicClaim?.deadline);if(due!==undefined)await this.ctx.storage.setAlarm(due);else {const storage=this.ctx.storage as unknown as {deleteAlarm?:()=>Promise<void>};if(storage.deleteAlarm)await storage.deleteAlarm();}}
 private async photoBatch(a:Account,access:string){const job=a.job!;if((!a.photosEnabled&&!a.otherPhotosEnabled)||job.photosDone)return;try{const other=job.photoSource==='other';const url=new URL(other?'https://people.googleapis.com/v1/otherContacts':'https://people.googleapis.com/v1/people/me/connections');url.searchParams.set(other?'readMask':'personFields','emailAddresses,photos');if(other){url.searchParams.append('sources','READ_SOURCE_TYPE_CONTACT');url.searchParams.append('sources','READ_SOURCE_TYPE_PROFILE');}url.searchParams.set('pageSize','1000');if(job.photoPage)url.searchParams.set('pageToken',job.photoPage);const response=await fetch(url,{headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});if(!response.ok){await response.body?.cancel();if((response.status===401||response.status===403)&&this.active(a))this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=? AND source=?',a.email,other?'other':'saved');throw Error('photos_unavailable');}const data=await readBoundedJSON(response,4_000_000) as {connections?:{emailAddresses?:{value?:string}[];photos?:{url?:string;default?:boolean}[]}[];otherContacts?:{emailAddresses?:{value?:string}[];photos?:{url?:string;default?:boolean}[]}[];nextPageToken?:string};if(!this.active(a))return;this.ctx.storage.transactionSync(()=>{for(const person of (other?data.otherContacts:data.connections)||[]){const photo=person.photos?.find(p=>{try{const u=new URL(p.url||'');return !p.default&&u.protocol==='https:'&&(u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))&&!u.username&&!u.password;}catch{return false;}});if(!photo?.url)continue;for(const address of person.emailAddresses||[]){const email=address.value?.trim().toLowerCase();if(email&&email.length<=320)this.ctx.storage.sql.exec("INSERT INTO contact_photos (account,email,url,generation,source) VALUES (?,?,?,?,?) ON CONFLICT(account,email) DO UPDATE SET url=excluded.url,generation=excluded.generation,source=excluded.source WHERE excluded.source='saved' OR contact_photos.source='other' OR contact_photos.generation<>excluded.generation",a.email,email,photo.url,job.generation,other?'other':'saved');}}job.photoPage=data.nextPageToken;job.photosDone=!data.nextPageToken;if(job.photosDone&&!other&&a.otherPhotosEnabled){job.photoSource='other';job.photosDone=false;}if(job.photosDone)this.ctx.storage.sql.exec('DELETE FROM contact_photos WHERE account=? AND generation<>?',a.email,job.generation);a.photoStatus=job.photosDone?'ready':'syncing';this.put(a);});}catch{if(!this.active(a))return;job.photosDone=true;a.photoStatus='unavailable';this.put(a);}}
 private async batch(a:Account){const job=a.job!;if(!this.env.MAIL_TOKEN_KEY||!this.env.GOOGLE_CLIENT_SECRET)throw Error('mail_not_configured');const refresh=await unseal(a.grant,this.env.MAIL_TOKEN_KEY);const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000)});const tokenBody=await readBoundedJSON(tr,32_768) as {error?:string;access_token?:string};if(!tr.ok)throw Error(tokenBody.error==='invalid_grant'?'reconnect_required':`token_${tr.status}`);const tokens=tokenBody as {access_token:string};if(!this.active(a))return;
  await this.photoBatch(a,tokens.access_token);if(!this.active(a))return;
  if(!job.pending.length&&job.hasMore){const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('maxResults','25');url.searchParams.set('q',job.query);if(job.pageToken)url.searchParams.set('pageToken',job.pageToken);const listing=await this.google(url.href,tokens.access_token) as {messages?:{id:string}[];nextPageToken?:string};if(!this.active(a))return;job.pending=(listing.messages||[]).map(m=>m.id);job.pageToken=listing.nextPageToken;job.hasMore=Boolean(listing.nextPageToken);this.put(a);}
  const ids=job.pending.slice(0,10);for(const id of ids){const seen=this.ctx.storage.sql.exec('SELECT id FROM messages WHERE account=? AND id=?',a.email,id).toArray().length;if(!seen){const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','metadata');for(const header of ['From','To','Cc','Date','Subject','Message-ID'])url.searchParams.append('metadataHeaders',header);let raw:Metadata;try{raw=await this.google(url.href,tokens.access_token) as Metadata;}catch(e){if(e instanceof Error&&e.message==='gmail_404'){job.pending.shift();job.processed++;if(this.active(a))this.put(a);continue;}throw e;}if(!this.active(a))return;const parsed=parseMessage(raw,a.email);this.ctx.storage.transactionSync(()=>{if(parsed){for(const p of parsed.participants){if(p.email===a.email||/^(no-?reply|notifications?|newsletters?|mailer-daemon)@/i.test(p.email)||(!p.sent&&!p.received))continue;this.ctx.storage.sql.exec('INSERT OR REPLACE INTO contributions VALUES (?,?,?,?,?,?,?,?)',a.email,parsed.key,p.email,p.name,parsed.date,parsed.subject,p.sent,p.received);}const contacts=parsed.participants.filter(p=>p.email!==a.email&&(p.sent||p.received)).slice(0,8).sort((x,y)=>x.email.localeCompare(y.email));for(let i=0;i<contacts.length;i++)for(let j=i+1;j<contacts.length;j++)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO mail_edges VALUES (?,?,?,?,?)',a.email,parsed.key,contacts[i].email,contacts[j].email,parsed.subject);this.ctx.storage.sql.exec('INSERT OR IGNORE INTO messages VALUES (?,?,?)',a.email,id,parsed?.key||id);}else this.ctx.storage.sql.exec('INSERT OR IGNORE INTO messages VALUES (?,?,?)',a.email,id,id);});}
  if(!this.active(a))return;job.pending.shift();job.processed++;job.retries=0;job.nextAttempt=0;a.error='';this.put(a);
  }
  await this.ctx.storage.delete('graph');
  if(!job.pending.length&&!job.hasMore&&((!a.photosEnabled&&!a.otherPhotosEnabled)||job.photosDone)){a.status='connected';a.lastSync=job.started;a.nextSync=Date.now()+3600000;this.put(a);await this.rebuildMetadataRelevance(a);}
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

 async relevance(lens:RelevanceLens='my'){const owner=await this.ctx.storage.get<string>('owner');return owner?this.store().snapshot(lens):null;}
 async hasMailGraph(){return Boolean((await this.graph())?.nodes.length);}
 async evidence(themeId:string,lens:RelevanceLens='my'){const value=await this.store().evidence(themeId,lens);if(!value.theme)return value;const {owner:_,...theme}=value.theme;return {theme,signals:value.signals.map(({owner:__,...signal})=>signal)};}
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
 /** Resolves an opaque node id back to the contact email, the way retrievalScope does. */
 private async emailForPerson(personId:string){
  const owner=await this.ctx.storage.get<string>('owner');if(!owner)return null;
  for(const row of this.graphContacts())if(await opaque(owner,row.email,this.env.TOKEN_SECRET)===personId)return row.email;
  return null;
 }
 /**
  * Outreach draft for one person from their own visible evidence. The prompt carries the
  * display name, company, last contact and at most eight signal summaries — never note
  * bodies, transcripts, API keys or anybody else's evidence. Nothing is ever sent.
  */
 async draftNote(personId:string){
  if(typeof personId!=='string'||!personId||personId.includes('@')||personId.length>200)throw Error('unknown_person');
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
   // `themes` carries theme-level evidence only — topic and metadata signals, plus calendar.
   // A person-attached statement carries the owner's verbatim quote and needs `statements`,
   // and so does any other theme-level summary that turns out to quote the owner's notes.
   return shareLevel==='statements'||((!signal.personId||signal.sourceType==='calendar')&&!carriesQuote(signal));
  });
  const titled=this.granolaProvenance({themeSignals:visible.map(({owner:_,...signal})=>signal)}).themeSignals.slice(0,SHARE_CAPS.signals);
  // The theme cap is applied first and the signals are then trimmed to what survived it, so a
  // signal is never shipped pointing at a theme name the far side would have to drop.
  const ordered:string[]=[],seen=new Set<string>();
  for(const signal of titled)if(!seen.has(signal.themeId)){seen.add(signal.themeId);ordered.push(signal.themeId);}
  const kept=new Set(ordered.slice(0,SHARE_CAPS.themes));
  slice.themes=source.themes.filter(theme=>kept.has(theme.id));
  slice.signals=titled.filter(signal=>kept.has(signal.themeId))
   .map(signal=>({email:signal.personId?byPerson.get(signal.personId)??null:null,themeId:signal.themeId,summary:signal.summary,observedAt:signal.observedAt,sourceType:signal.sourceType,confidence:signal.confidence,...(signal.provenance?.title?{title:signal.provenance.title}:{})}));
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
  if(!accounts.length&&!this.granola().status().connected&&!shared.size)return null;
  const rows=this.graphContacts();
  const photos=new Map(this.ctx.storage.sql.exec<{email:string;url:string}>('SELECT email,MAX(url) AS url FROM contact_photos GROUP BY email').toArray().map(p=>[p.email,p.url]));
  const nodes:GraphPersonNode[]=await Promise.all(rows.map(async r=>({id:await opaque(owner,r.email,this.env.TOKEN_SECRET),photoUrl:photos.get(r.email)||null,name:r.name.includes('@')?r.email.split('@')[0]:r.name,company:r.email.split('@')[1],companySource:'email_domain',lastContact:new Date(r.last).toISOString(),meetings:r.meetings,lastMeeting:r.lastMeeting?new Date(r.lastMeeting).toISOString():null,...emailScore(r.sent,r.received,(Date.now()-r.last)/86400000)})));
  const idMap=new Map(rows.map((r,i)=>[r.email,nodes[i].id]));
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
   const node:GraphPersonNode={id:await opaque(owner,person.email,this.env.TOKEN_SECRET),photoUrl:null,name:sharedDisplayName(person.name,person.email),company:person.email.split('@')[1],companySource:'email_domain',lastContact:person.last?new Date(person.last).toISOString():null,meetings:person.meetings,lastMeeting:null,via:person.via,...emailScore(person.meetings,person.meetings,days)};
   nodes.push(node);idMap.set(person.email,node.id);nodeById.set(node.id,node);
  }
  const merged=this.mergedEdges();
  for(const e of this.sharedEdgeRows()){const key=e.a+'\u0000'+e.b;const cur=merged.get(key);if(cur){cur.weight+=e.weight;if(!cur.types.includes('shared_via'))cur.types.push('shared_via');cur.contexts.push(...e.contexts.slice(0,2));}else merged.set(key,{a:e.a,b:e.b,weight:e.weight,types:['shared_via'],contexts:e.contexts,titles:[]});}
  const edges=[...merged.values()].filter(e=>idMap.has(e.a)&&idMap.has(e.b)).sort((x,y)=>y.weight-x.weight).slice(0,5000).map(e=>({source:idMap.get(e.a),target:idMap.get(e.b),weight:e.weight,types:e.types,contexts:e.contexts.slice(0,3)}));
  const stamps=[...accounts.map(a=>Math.max(a.lastSync,a.job?.lastRun||0)),this.granola().status().lastSync,this.sharedMeta().refreshedAt];
  // A Granola-only first sync has no stamps yet; the epoch would read as a 1970 graph.
  const value={pushedAt:new Date(Math.max(...stamps)||Date.now()).toISOString(),nodes,edges,source:'email_accounts',scoreModel:'email-meeting-frequency-reciprocity-recency-v2',note:'Company labels are email domains. Message metadata and meeting attendee lists only; no message bodies. Mailbox deletions are not reconciled automatically; Granola deletions reconcile weekly.'};
  // Never cache after an await: a disconnect or another batch may have changed the data.
  return this.sharedProvenance(this.granolaProvenance(await this.store().attachToGraph(value,'my')));
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
