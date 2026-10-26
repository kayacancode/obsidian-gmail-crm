/** Owner-authored context stays separate from imported evidence and shared graph storage. */
export interface PersonContext {personId:string;text:string;revision:string|null;updatedAt:number|null}
export interface SavePersonContext {personId:string;text:string;revision:string|null}
export const validContextPerson=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value);
const validRevision=(value:unknown)=>value===null||typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validPersonContextInput(value:unknown):value is SavePersonContext{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const input=value as Record<string,unknown>;
 return Object.keys(input).sort().join(',')==='personId,revision,text'&&validContextPerson(input.personId)&&typeof input.text==='string'&&input.text.length<=1000&&validRevision(input.revision);
}

/** Identity must be checked in MailSync before using this per-owner storage. */
export class PersonContextStore {
 constructor(private storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS person_context (person_id TEXT PRIMARY KEY,text TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL)');
 }
 get(personId:string):PersonContext{
  const row=this.storage.sql.exec<{text:string;revision:string;updated_at:number}>('SELECT text,revision,updated_at FROM person_context WHERE person_id=?',personId).toArray()[0];
  return {personId,text:row?.text??'',revision:row?.revision??null,updatedAt:row?.updated_at??null};
 }
 save(input:SavePersonContext):PersonContext{
  if(!validPersonContextInput(input))throw Error('invalid_request');
  return this.storage.transactionSync(()=>{
   if(this.get(input.personId).revision!==input.revision)throw Error('person_context_conflict');
   const text=input.text.trim(),revision=crypto.randomUUID(),updatedAt=Date.now();
   // A cleared note keeps a revision so an older editor cannot resurrect its contents.
   this.storage.sql.exec('INSERT INTO person_context (person_id,text,revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at',input.personId,text,revision,updatedAt);
   return {personId:input.personId,text,revision,updatedAt};
  });
 }
}
