import type {BookingSettings,BookingCalendarRecord,BookingRequestRecord} from './booking-types';

export const BOOKING_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS booking_settings(owner TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,data TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,email TEXT NOT NULL,client_key TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner,email,client_key))`,
 `CREATE INDEX IF NOT EXISTS booking_owner_requests ON booking_requests(owner,created_at)`,
 `CREATE TABLE IF NOT EXISTS booking_calendars(owner TEXT PRIMARY KEY,data TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_challenges(id TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,browser TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0)`,
 `CREATE TABLE IF NOT EXISTS booking_sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,browser TEXT NOT NULL,expires INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_google_sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,subject TEXT NOT NULL,email_authoritative INTEGER NOT NULL,browser TEXT NOT NULL,expires INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_visitor_oauth(id TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,browser TEXT NOT NULL,verifier TEXT NOT NULL,request_id TEXT NOT NULL,expires INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS booking_oauth(id TEXT PRIMARY KEY,owner TEXT NOT NULL,cookie_hash TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL)`,
];
export class BookingStore {
 constructor(readonly db:D1Database){}
 async init(){await this.db.batch(BOOKING_SCHEMA.map(s=>this.db.prepare(s)));}
 async settings(owner:string){return this.read<BookingSettings>('SELECT data FROM booking_settings WHERE owner=?',owner);}
 async slug(slug:string){return this.read<BookingSettings>('SELECT data FROM booking_settings WHERE slug=?',slug);}
 async saveSettings(s:BookingSettings,previousRevision:number){
  try{
   const result=await this.db.prepare(`INSERT INTO booking_settings(owner,slug,revision,data) SELECT ?,?,?,? WHERE ?=0
    ON CONFLICT(owner) DO UPDATE SET slug=excluded.slug,revision=excluded.revision,data=excluded.data WHERE booking_settings.revision=?`)
    .bind(s.owner,s.slug,s.revision,JSON.stringify(s),previousRevision,previousRevision).run();
   // An existing row needs UPDATE, since INSERT SELECT WHERE false does not invoke ON CONFLICT.
   if(!result.meta.changes&&previousRevision>0){
    const updated=await this.db.prepare('UPDATE booking_settings SET slug=?,revision=?,data=? WHERE owner=? AND revision=?').bind(s.slug,s.revision,JSON.stringify(s),s.owner,previousRevision).run();
    if(!updated.meta.changes)throw Error('settings_changed');
   }else if(!result.meta.changes)throw Error('settings_changed');
  }catch(e){if(String(e).includes('UNIQUE'))throw Error('slug_taken');throw e;}
 }
 async calendar(owner:string){return this.read<BookingCalendarRecord>('SELECT data FROM booking_calendars WHERE owner=?',owner);}
 async saveCalendar(r:BookingCalendarRecord){await this.db.prepare('INSERT INTO booking_calendars(owner,data) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').bind(r.owner,JSON.stringify(r)).run();}
 async deleteCalendar(owner:string){await this.db.prepare('DELETE FROM booking_calendars WHERE owner=?').bind(owner).run();}
 async requests(owner:string){const rows=await this.db.prepare('SELECT data FROM booking_requests WHERE owner=? ORDER BY created_at DESC LIMIT 1000').bind(owner).all<{data:string}>();return rows.results.map(r=>JSON.parse(r.data) as BookingRequestRecord);}
 async visitorRequests(owner:string,email:string,subject:string){const rows=await this.db.prepare("SELECT data FROM booking_requests WHERE owner=? AND email=? AND json_extract(data,'$.visitorSubject')=? ORDER BY created_at DESC LIMIT 10").bind(owner,email,subject).all<{data:string}>();return rows.results.map(r=>JSON.parse(r.data) as BookingRequestRecord);}
 async reservations(owner:string){const rows=await this.db.prepare("SELECT data FROM booking_requests WHERE owner=? AND json_extract(data,'$.status') IN ('booking','booked','cancelling')").bind(owner).all<{data:string}>();return rows.results.map(r=>JSON.parse(r.data) as BookingRequestRecord);}
 async request(owner:string,id:string){return this.read<BookingRequestRecord>('SELECT data FROM booking_requests WHERE owner=? AND id=?',owner,id);}
 async prior(owner:string,email:string,key:string){return this.read<BookingRequestRecord>('SELECT data FROM booking_requests WHERE owner=? AND email=? AND client_key=?',owner,email,key);}
 async add(r:BookingRequestRecord){await this.db.prepare('INSERT INTO booking_requests(id,owner,email,client_key,created_at,data) VALUES(?,?,?,?,?,?)').bind(r.id,r.owner,r.email,r.idempotencyKey,r.createdAt,JSON.stringify(r)).run();}
 async update(r:BookingRequestRecord){await this.db.prepare('UPDATE booking_requests SET data=? WHERE owner=? AND id=?').bind(JSON.stringify(r),r.owner,r.id).run();return r;}
 private async read<T>(sql:string,...args:string[]):Promise<T|null>{const row=await this.db.prepare(sql).bind(...args).first<{data:string}>();return row?JSON.parse(row.data) as T:null;}
 async limit(key:string,max:number,windowMs:number,now=Date.now()){
  const row=await this.db.prepare(`INSERT INTO booking_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END WHERE expires<=? OR count<? RETURNING count`).bind(key,now+windowMs,now,now,now,max).first();
  if(!row)throw Error('rate_limited');
 }
 async cleanup(now=Date.now()){await this.db.batch(['booking_challenges','booking_sessions','booking_limits','booking_oauth','booking_google_sessions','booking_visitor_oauth'].map(t=>this.db.prepare(`DELETE FROM ${t} WHERE expires<?`).bind(now)));}
}
