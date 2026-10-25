import {PersonContextStore,validContextPerson,type PersonContext} from './person-context';

export interface MemoryFields {
 company:string;building:string;needs:string;offers:string;interests:string[];
 pointPersonId:string|null;notBefore:string|null;relationship:'neutral'|'closer'|'weaker';
}
export interface MemoryEntry {id:string;text:string;sourceKind:'text'|'voice_transcript';createdAt:number}
export interface RelationshipMemory extends PersonContext,MemoryFields {entries:MemoryEntry[]}
export interface RecommendationMemory {revision:string;people:Record<string,RelationshipMemory>}
export interface SaveRelationshipMemory extends MemoryFields {personId:string;text:string;revision:string|null}
export interface CaptureRelationshipMemory {email:string;name:string;company?:string;text:string;sourceKind:'text'|'voice_transcript';sourceId:string}
export type ManualPerson = {email:string;person_id:string;name:string;company:string;created_at:number}
const defaults=():MemoryFields=>({company:'',building:'',needs:'',offers:'',interests:[],pointPersonId:null,notBefore:null,relationship:'neutral'});
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const revision=(v:unknown)=>v===null||typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const validMemoryEmail=(v:unknown):v is string=>typeof v==='string'&&v.length<=320&&/^[a-z0-9.!#$%&'*+/=_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(v);
const day=(v:unknown)=>v===null||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function validSaveRelationshipMemory(v:unknown):v is SaveRelationshipMemory {
 if(!record(v)||Object.keys(v).sort().join(',')!=='building,company,interests,needs,notBefore,offers,personId,pointPersonId,relationship,revision,text')return false;
 return validContextPerson(v.personId)&&text(v.text,1000)&&revision(v.revision)&&text(v.company,160)&&text(v.building,600)&&text(v.needs,600)&&text(v.offers,600)&&Array.isArray(v.interests)&&v.interests.length<=8&&v.interests.every(i=>text(i,80)&&Boolean((i as string).trim()))&&(v.pointPersonId===null||validContextPerson(v.pointPersonId))&&day(v.notBefore)&&['neutral','closer','weaker'].includes(v.relationship as string);
}
export function validCaptureRelationshipMemory(v:unknown):v is CaptureRelationshipMemory {
 return record(v)&&Object.keys(v).every(k=>['email','name','company','text','sourceKind','sourceId'].includes(k))&&validMemoryEmail(v.email)&&text(v.name,160)&&Boolean((v.name as string).trim())&&text(v.text,2000)&&Boolean((v.text as string).trim())&&text(v.sourceId,200)&&Boolean((v.sourceId as string).trim())&&['text','voice_transcript'].includes(v.sourceKind as string)&&(v.company===undefined||text(v.company,160));
}
export const relationshipDelta=(value:MemoryFields['relationship'])=>value==='closer'?10:value==='weaker'?-10:0;

/** All records are in one owner's MailSync. No memory rows enter shared signal storage. */
export class RelationshipMemoryStore {
 private context:PersonContextStore;
 constructor(private storage:DurableObjectStorage){
  this.context=new PersonContextStore(storage);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS person_memory (person_id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS person_memory_entries (id TEXT PRIMARY KEY,person_id TEXT NOT NULL,source_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,text TEXT NOT NULL,source_kind TEXT NOT NULL,created_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS person_memory_entries_person ON person_memory_entries(person_id,created_at);
   CREATE TABLE IF NOT EXISTS manual_people (email TEXT PRIMARY KEY,person_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,company TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 }
 fields(personId:string):MemoryFields {
  const row=this.storage.sql.exec<{data:string}>('SELECT data FROM person_memory WHERE person_id=?',personId).toArray()[0];
  return row?{...defaults(),...JSON.parse(row.data)}:defaults();
 }
 get(personId:string):RelationshipMemory {
  const entries=this.storage.sql.exec<{id:string;text:string;source_kind:'text'|'voice_transcript';created_at:number}>('SELECT id,text,source_kind,created_at FROM person_memory_entries WHERE person_id=? AND deleted=0 ORDER BY created_at DESC,id DESC LIMIT 10',personId).toArray().map(r=>({id:r.id,text:r.text,sourceKind:r.source_kind,createdAt:r.created_at}));
  return {...this.context.get(personId),...this.fields(personId),entries};
 }
 private touch(personId:string,value:string){
  this.storage.sql.exec('INSERT INTO person_context(person_id,text,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at',personId,value,crypto.randomUUID(),Date.now());
 }
 save(input:SaveRelationshipMemory):RelationshipMemory {
  if(!validSaveRelationshipMemory(input))throw Error('invalid_request');
  return this.storage.transactionSync(()=>{
   if(this.context.get(input.personId).revision!==input.revision)throw Error('person_context_conflict');
   const {personId,text:note,revision:_,...fields}=input;
   for(const key of ['company','building','needs','offers'] as const)fields[key]=fields[key].trim();
   fields.interests=[...new Set(fields.interests.map(s=>s.trim()))];
   this.storage.sql.exec('INSERT INTO person_memory(person_id,data) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET data=excluded.data',personId,JSON.stringify(fields));
   this.touch(personId,note.trim());return this.get(personId);
  });
 }
 manualPeople():ManualPerson[]{return this.storage.sql.exec<ManualPerson>('SELECT email,person_id,name,company,created_at FROM manual_people ORDER BY email LIMIT 500').toArray();}
 hasManual(email:string){return Boolean(this.storage.sql.exec('SELECT person_id FROM manual_people WHERE email=?',email).toArray().length);}
 async capture(personId:string,input:CaptureRelationshipMemory,manual:boolean){
  if(!validCaptureRelationshipMemory(input))throw Error('invalid_request');
  const normalized={email:input.email.trim().toLowerCase(),name:input.name.trim(),company:input.company?.trim()||'',text:input.text.trim(),sourceKind:input.sourceKind,sourceId:input.sourceId.trim()};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalized)));
  const fingerprint=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  return this.storage.transactionSync(()=>{
   const old=this.storage.sql.exec<{id:string;person_id:string;fingerprint:string}>('SELECT id,person_id,fingerprint FROM person_memory_entries WHERE source_id=?',normalized.sourceId).toArray()[0];
   if(old){if(old.person_id!==personId||old.fingerprint!==fingerprint)throw Error('capture_conflict');return {personId,entryId:old.id,duplicate:true,memory:this.get(personId)};}
   const count=this.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM person_memory_entries WHERE person_id=?',personId).toArray()[0]?.n||0;
   if(count>=100)throw Error('memory_capacity');
   if(manual&&!this.hasManual(normalized.email)){
    if(this.manualPeople().length>=500)throw Error('memory_capacity');
    this.storage.sql.exec('INSERT INTO manual_people(email,person_id,name,company,created_at) VALUES(?,?,?,?,?)',normalized.email,personId,normalized.name,normalized.company,Date.now());
    this.storage.sql.exec('INSERT INTO person_memory(person_id,data) VALUES(?,?) ON CONFLICT(person_id) DO NOTHING',personId,JSON.stringify({...defaults(),company:normalized.company}));
   }
   const entryId=crypto.randomUUID();
   this.storage.sql.exec('INSERT INTO person_memory_entries(id,person_id,source_id,fingerprint,text,source_kind,created_at) VALUES(?,?,?,?,?,?,?)',entryId,personId,normalized.sourceId,fingerprint,normalized.text,input.sourceKind,Date.now());
   this.touch(personId,this.context.get(personId).text);
   return {personId,entryId,duplicate:false,memory:this.get(personId)};
  });
 }
 remove(input:{personId:string;entryId:string;revision:string|null}){
  if(!validContextPerson(input.personId)||typeof input.entryId!=='string'||!revision(input.entryId)||!revision(input.revision))throw Error('invalid_request');
  return this.storage.transactionSync(()=>{
   const current=this.context.get(input.personId);if(current.revision!==input.revision)throw Error('person_context_conflict');
   if(!this.storage.sql.exec('SELECT id FROM person_memory_entries WHERE id=? AND person_id=?',input.entryId,input.personId).toArray().length)throw Error('not_found');
   // Keep the source ID/fingerprint tombstone so retries cannot restore removed text.
   this.storage.sql.exec('UPDATE person_memory_entries SET deleted=1,text=? WHERE id=? AND person_id=?','',input.entryId,input.personId);
   this.touch(input.personId,current.text);return this.get(input.personId);
  });
 }
 ids():string[]{return this.storage.sql.exec<{person_id:string}>('SELECT person_id FROM person_context ORDER BY person_id').toArray().map(r=>r.person_id);}
}
