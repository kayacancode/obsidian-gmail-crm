import {PERSONAL_DOMAINS} from './company-stints';

/**
 * Guest ask: an outsider asks the owner's network a question. The owner's agent drafts an answer
 * from work evidence only, the owner approves it, and people are described, never named. A name
 * is revealed only through an introduction the described person has opted into.
 */
export type GuestAskStatus='pending'|'answered'|'declined'|'expired';
export interface GuestPerson {ref:string;personId:string;description:string}
export interface GuestAnswer {text:string;people:{ref:string;description:string}[]}
export interface GuestAsk {
 id:string;
 /** Opaque guest key derived from the verified Google subject. */
 guest:string;guestEmail:string;question:string;status:GuestAskStatus;
 /** Owner-only: the draft keeps the people it describes. */
 draft:{text:string;people:GuestPerson[]};
 answer:GuestAnswer|null;
 /** Introduction id per person ref the guest asked to meet. */
 introductions:Record<string,string>;
 createdAt:string;updatedAt:string;
}
export interface GuestPersonView {ref:string;description:string;introduction?:string;name?:string}
export interface GuestView {id:string;question:string;status:GuestAskStatus;createdAt:string;answer:{text:string;people:GuestPersonView[]}|null}

const DAY=86_400_000;
export const MAX_QUESTION=500;
export const ASKS_PER_DAY=3;
/** Introduction steps after which the described person has agreed to be known. */
const REVEALED:Record<string,boolean>={target_opted_in:true,made:true,met:true,not_met:true};

export interface Forbidden {words:Set<string>;domains:Set<string>}
const words=(text:string)=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];

/** Every token that could identify someone: contact names, company names and work domains. */
export function forbiddenTokens(people:{name:string;company:string}[],domains:string[]):Forbidden{
 const forbidden:Forbidden={words:new Set(),domains:new Set()};
 const domain=(value:string)=>{
  const d=value.trim().toLowerCase();
  if(!d.includes('.')||Object.hasOwn(PERSONAL_DOMAINS,d))return;
  forbidden.domains.add(d);
  const label=d.split('.')[0];if(label.length>=2)forbidden.words.add(label);
 };
 for(const p of people){
  for(const w of words(p.name))if(w.length>=2)forbidden.words.add(w);
  if(p.company.includes('.'))domain(p.company);else for(const w of words(p.company))if(w.length>=3)forbidden.words.add(w);
 }
 for(const d of domains)domain(d);
 return forbidden;
}

/** The text if it identifies no one (no names, companies, domains, addresses or links), else null. */
export function anonymous(text:string,forbidden:Forbidden):string|null{
 const value=typeof text==='string'?text.trim().replace(/\s+/g,' '):'';
 if(!value||value.length>200||value.includes('@')||/https?:\/\/|www\./i.test(value))return null;
 const lower=value.toLowerCase();
 if([...forbidden.domains].some(d=>lower.includes(d)))return null;
 return words(value).some(w=>forbidden.words.has(w))?null:value;
}

/** What a guest may see: the approved answer, and a name only once that person opted in. */
export function guestView(ask:GuestAsk,introductions:Record<string,{status:string;name:string}>):GuestView{
 const answer=ask.status==='answered'&&ask.answer?{text:ask.answer.text,people:ask.answer.people.map(p=>{
  const intro=ask.introductions[p.ref]?introductions[ask.introductions[p.ref]]:undefined;
  return {ref:p.ref,description:p.description,...(intro?{introduction:intro.status}:{}),...(intro&&REVEALED[intro.status]?{name:intro.name}:{})};
 })}:null;
 return {id:ask.id,question:ask.question,status:ask.status,createdAt:ask.createdAt,answer};
}

export function expireAsk(ask:GuestAsk,now:number):GuestAsk{
 return ask.status==='pending'&&Date.parse(ask.createdAt)+7*DAY<now?{...ask,status:'expired'}:ask;
}

export function checkDailyLimit(asks:GuestAsk[],guest:string,now:number){
 if(asks.filter(a=>a.guest===guest&&Date.parse(a.createdAt)>now-DAY).length>=ASKS_PER_DAY)throw Error('guest_rate_limited');
}

/** The owner answers or declines a pending ask; nothing else changes its outcome. */
export function decideAsk(ask:GuestAsk,to:'answered'|'declined',answer:GuestAnswer|null,now:number):GuestAsk{
 if(ask.status!=='pending')throw Error('guest_ask_state_invalid');
 if(to==='answered'&&!answer)throw Error('invalid_request');
 return {...ask,status:to,answer:to==='answered'?answer:null,updatedAt:new Date(now).toISOString()};
}

/** Owner-private guest asks, expired on read. */
export class GuestAskStore {
 constructor(private storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS guest_asks (id TEXT PRIMARY KEY,guest TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL)');
 }
 save(ask:GuestAsk){this.storage.sql.exec('INSERT OR REPLACE INTO guest_asks VALUES (?,?,?,?)',ask.id,ask.guest,JSON.stringify(ask),Date.parse(ask.createdAt));return ask;}
 list(now:number):GuestAsk[]{
  return this.storage.sql.exec<{data:string}>('SELECT data FROM guest_asks ORDER BY created DESC,id').toArray().map(row=>{
   const stored=JSON.parse(row.data) as GuestAsk,current=expireAsk(stored,now);
   if(current.status!==stored.status)this.save(current);
   return current;
  });
 }
 get(id:string,now:number){return this.list(now).find(a=>a.id===id)??null;}
}
