import {LIFE_CATEGORIES,type LifeCategory} from './life-signals';

export interface TimelineEntry {id:string;text:string;category:LifeCategory|null;date:string;createdAt:number}
const MAX_ENTRIES=500;
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;

/** The owner's own story, added only on explicit request. Never extracted and never answered to anyone else. */
export class OwnerTimelineStore {
 constructor(private readonly storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS owner_timeline (id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT,date TEXT NOT NULL,created INTEGER NOT NULL)');
 }
 add(input:{text?:unknown;category?:unknown;date?:unknown}):TimelineEntry{
  const text=typeof input.text==='string'?input.text.trim():'';
  const category=input.category===undefined||input.category===null?null:input.category;
  const date=input.date===undefined?new Date().toISOString().slice(0,10):input.date;
  if(!text||text.length>280||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error('invalid_request');
  if(category!==null&&!(typeof category==='string'&&(LIFE_CATEGORIES as readonly string[]).includes(category)))throw Error('invalid_request');
  if(typeof date!=='string'||!validDate(date))throw Error('invalid_request');
  if((this.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM owner_timeline').toArray()[0]?.n??0)>=MAX_ENTRIES)throw Error('invalid_request');
  const entry:TimelineEntry={id:crypto.randomUUID(),text,category:category as LifeCategory|null,date,createdAt:Date.now()};
  this.storage.sql.exec('INSERT INTO owner_timeline (id,text,category,date,created) VALUES (?,?,?,?,?)',entry.id,entry.text,entry.category,entry.date,entry.createdAt);
  return entry;
 }
 list():TimelineEntry[]{
  return this.storage.sql.exec<{id:string;text:string;category:LifeCategory|null;date:string;created:number}>('SELECT id,text,category,date,created FROM owner_timeline ORDER BY date DESC,created DESC').toArray().map(r=>({id:r.id,text:r.text,category:r.category,date:r.date,createdAt:r.created}));
 }
 forget(id:string):boolean{
  const found=this.storage.sql.exec('SELECT id FROM owner_timeline WHERE id=?',id).toArray().length>0;
  if(found)this.storage.sql.exec('DELETE FROM owner_timeline WHERE id=?',id);
  return found;
 }
}
