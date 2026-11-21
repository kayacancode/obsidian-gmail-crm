import {validContextPerson} from './person-context';

/** Consumer mail providers say nothing about an employer. */
export const PERSONAL_DOMAINS:Readonly<Record<string,true>>={'gmail.com':true,'googlemail.com':true,'yahoo.com':true,'hotmail.com':true,'outlook.com':true,'live.com':true,'icloud.com':true,'me.com':true,'mac.com':true,'aol.com':true,'proton.me':true,'protonmail.com':true,'hey.com':true,'fastmail.com':true,'msn.com':true,'gmx.com':true};
export interface CompanyStint {id:string;personId:string;company:string;domain:string;from:string;to:string|null;source:'email_domain'|'owner'}
export interface AddressSpan {email:string;first:number;last:number}

const month=(ms:number)=>new Date(ms).toISOString().slice(0,7);
const validMonth=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const companyKey=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');

/** One stint per work domain an address used; only the domain with the latest mail is still open. */
export function deriveStints(personId:string,addresses:AddressSpan[],now:number):CompanyStint[]{
 const byDomain=new Map<string,{first:number;last:number}>();
 for(const address of addresses){
  const domain=address.email.split('@')[1]?.toLowerCase();
  if(!domain||Object.hasOwn(PERSONAL_DOMAINS,domain)||address.first>now)continue;
  const span=byDomain.get(domain);
  byDomain.set(domain,span?{first:Math.min(span.first,address.first),last:Math.max(span.last,address.last)}:{first:address.first,last:address.last});
 }
 const latest=[...byDomain.entries()].sort((a,b)=>b[1].last-a[1].last||a[0].localeCompare(b[0]))[0]?.[0];
 return [...byDomain.entries()].map(([domain,span]):CompanyStint=>({id:`${personId}:${domain}`,personId,company:domain.split('.')[0],domain,from:month(span.first),to:domain===latest?null:month(span.last),source:'email_domain'})).sort((a,b)=>a.from.localeCompare(b.from)||a.domain.localeCompare(b.domain));
}

/** Owner corrections replace derived stints for the same company. */
export function mergeStints(derived:CompanyStint[],owner:CompanyStint[]):CompanyStint[]{
 const corrected=new Set(owner.map(s=>companyKey(s.company)));
 return [...derived.filter(s=>!corrected.has(companyKey(s.company))),...owner].sort((a,b)=>a.from.localeCompare(b.from)||a.company.localeCompare(b.company));
}

/** The shared period of two stints, `YYYY-MM..YYYY-MM|present`, or null. */
export function overlaps(a:CompanyStint,b:CompanyStint):string|null{
 const open='9999-12',start=a.from>b.from?a.from:b.from,end=(a.to??open)<(b.to??open)?(a.to??open):(b.to??open);
 return start>end?null:`${start}..${end===open?'present':end}`;
}

/** Whether a stint belongs to the company the owner asked about. */
export function stintMatches(stint:CompanyStint,company:string):boolean{
 const wanted=companyKey(company);
 return !!wanted&&(companyKey(stint.company)===wanted||companyKey(stint.domain.split('.')[0]??'')===wanted);
}

/** Owner-entered corrections. Owner edits always win over email-derived history. */
export class CompanyStintStore {
 constructor(private readonly storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS company_stints (id TEXT PRIMARY KEY,person TEXT NOT NULL,company TEXT NOT NULL,from_month TEXT NOT NULL,to_month TEXT,created INTEGER NOT NULL)');
 }
 set(input:{personId?:unknown;company?:unknown;from?:unknown;to?:unknown}):CompanyStint{
  const company=typeof input.company==='string'?input.company.trim():'';
  const to=input.to===undefined?null:input.to;
  if(typeof input.personId!=='string'||!validContextPerson(input.personId)||!company||company.length>120||!validMonth(input.from)||to!==null&&(!validMonth(to)||to<input.from))throw Error('invalid_request');
  const stint:CompanyStint={id:crypto.randomUUID(),personId:input.personId,company,domain:'',from:input.from,to,source:'owner'};
  this.storage.sql.exec('INSERT INTO company_stints (id,person,company,from_month,to_month,created) VALUES (?,?,?,?,?,?)',stint.id,stint.personId,stint.company,stint.from,stint.to,Date.now());
  return stint;
 }
 forPerson(personIds:string[]):CompanyStint[]{
  const wanted=new Set(personIds);
  return wanted.size?this.all().filter(s=>wanted.has(s.personId)):[];
 }
 /** Every owner correction; one query, so callers never bind more than the SQLite parameter limit. */
 all():CompanyStint[]{
  return this.storage.sql.exec<{id:string;person:string;company:string;from_month:string;to_month:string|null}>('SELECT id,person,company,from_month,to_month FROM company_stints').toArray().map(r=>({id:r.id,personId:r.person,company:r.company,domain:'',from:r.from_month,to:r.to_month,source:'owner' as const}));
 }
 forget(id:string):boolean{
  const found=this.storage.sql.exec('SELECT id FROM company_stints WHERE id=?',id).toArray().length>0;
  if(found)this.storage.sql.exec('DELETE FROM company_stints WHERE id=?',id);
  return found;
 }
}
