import {THEME_MODEL} from './theme-extractor';
import {sentenceParts} from './gmail-context';

/** Things people say in passing but rarely post. The tier is fixed per category; the model never chooses it. */
export const LIFE_CATEGORIES=['travel','hobby','role_change','moved','milestone','health','family','loss','money','legal'] as const;
export type LifeCategory=typeof LIFE_CATEGORIES[number];
export type LifeTier='open'|'personal'|'sensitive';
export const LIFE_TIER:Record<LifeCategory,LifeTier>={travel:'open',hobby:'open',role_change:'open',moved:'open',milestone:'personal',health:'sensitive',family:'sensitive',loss:'sensitive',money:'sensitive',legal:'sensitive'};
export const LIFE_TTL_DAYS:Record<LifeCategory,number>={travel:60,hobby:365,role_change:365,moved:365,milestone:180,health:120,family:180,loss:365,money:120,legal:120};
/** `sender`: an email's author about themselves. `attendee`: a meeting note naming one attendee. `note`: the owner's own note about the person. */
export type LifeMode='sender'|'attendee'|'note';
export interface LifeCandidate {category:LifeCategory;tier:LifeTier;summary:string;quote:string;personHint?:string}

const isCategory=(value:unknown):value is LifeCategory=>typeof value==='string'&&(LIFE_CATEGORIES as readonly string[]).includes(value);
const firstPerson=/^(?:I\b|I['’]m\b|I['’]ve\b|I['’]ll\b|I['’]d\b|We\b|We['’]re\b|We['’]ve\b|My\b|Our\b)/i;
// "My best friend broke her leg" or "Maya said her cousin is ill" is about someone else:
// never a signal about the speaker. Up to two words may sit between the possessive and the relation.
const RELATIONS='friends?|bff|wife|husband|partner|spouse|son|daughter|kids?|child|children|baby|mom|mum|mother|dad|father|parents?|brother|sister|siblings?|cousin|aunt|uncle|grand\\w*|niece|nephew|girlfriend|boyfriend|fianc[eé]e?|\\w+-in-law|in-laws?|roommate|flatmate|client|colleague|coworker|co-worker|boss|cofounder|co-founder|team|neighbou?r|dog|cat';
const relationOf=(possessive:string)=>new RegExp(`\\b(?:${possessive})(?:\\s+[\\w'’-]+){0,2}\\s+(?:${RELATIONS})s?\\b`,'i');
const senderThirdParty=relationOf('my|our');
const attendeeThirdParty=relationOf('my|our|his|her|their');
// "I am visiting Sam after his surgery": the first-person sentence is about another person.
const aboutSomeoneElse=/\b(?:his|her|their|him|them)\b/i;
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const word=(value:string)=>new RegExp(`(?:^|[^\\p{L}])${escape(value)}(?:$|[^\\p{L}])`,'iu');

/** The single non-owner attendee an anchor sentence names, or undefined when none or several are named. */
function namedAttendee(anchor:string,attendees:{email:string;name:string}[]):string|undefined{
 const named=attendees.filter(a=>{const name=a.name.trim();if(!name)return false;const first=name.split(/\s+/)[0];return word(name).test(anchor)||first.length>=2&&word(first).test(anchor);});
 return named.length===1?named[0].email:undefined;
}

/** Select exact personal-life passages. The model picks sentence ranges and a category; code checks attribution and fixes the tier. */
export async function extractLifeSignals(ai:Ai|undefined,text:string,mode:LifeMode,attendees:{email:string;name:string}[]=[],signal?:AbortSignal):Promise<LifeCandidate[]>{
 if(!ai)throw Error('ai_unavailable');
 const sentences=sentenceParts(text.slice(0,16000)).slice(0,80);
 if(!sentences.length)return [];
 const index={type:'integer',minimum:0,maximum:sentences.length-1};
 const schema={type:'object',additionalProperties:false,required:['signals'],properties:{signals:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['start','end','anchor','category','summary'],properties:{start:index,end:index,anchor:index,category:{type:'string',enum:[...LIFE_CATEGORIES]},summary:{type:'string',maxLength:80}}}}}};
 const subject=mode==='sender'?'the sender, speaking about themselves':mode==='attendee'?'one named meeting attendee':'the person this note is about';
 const prompt=`Select up to three short passages about ${subject}'s personal life that they would mention on a catch-up call but rarely post: travel, hobbies, a role change, a move, a milestone, health, family, loss, money or legal matters. Ignore work products, sales, scheduling and anything about other people. Each passage is a contiguous range of at most four supplied sentences; the anchor index points at the sentence that states the fact. Summary: a neutral paraphrase of at most 80 characters with no names, addresses or links.`;
 const timeout=AbortSignal.timeout(20000),abort=signal?AbortSignal.any([signal,timeout]):timeout;
 let output:unknown=await ai.run(THEME_MODEL,{messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(sentences.map((sentence,i)=>({i,sentence})))}],response_format:{type:'json_schema',json_schema:schema},max_tokens:512,temperature:0},{signal:abort});
 if(output&&typeof output==='object'&&'response' in output)output=output.response;
 if(typeof output==='string'){try{output=JSON.parse(output.slice(0,4000));}catch{throw Error('invalid_extraction');}}
 if(!output||typeof output!=='object'||!('signals' in output)||!Array.isArray(output.signals))throw Error('invalid_extraction');
 const result:LifeCandidate[]=[],seen=new Set<number>();
 for(const item of output.signals.slice(0,3) as unknown[]){
  if(!item||typeof item!=='object')continue;
  const {start,end,anchor,category,summary}=item as Record<string,unknown>;
  if(![start,end,anchor].every(Number.isInteger))continue;
  const s=start as number,e=end as number,a=anchor as number;
  if(s<0||e>=sentences.length||e<s||e-s>3||a<s||a>e||seen.has(a)||!isCategory(category))continue;
  if(typeof summary!=='string'||summary.trim().length<3||summary.length>80||/@|https?:\/\/|www\./i.test(summary))continue;
  const quote=sentences.slice(s,e+1).join(' '),anchorText=sentences[a];
  if(quote.length<20||quote.length>600)continue;
  let personHint:string|undefined;
  if(mode==='sender'&&(!firstPerson.test(anchorText)||senderThirdParty.test(anchorText)||aboutSomeoneElse.test(anchorText)))continue;
  if(mode==='attendee'){if(attendeeThirdParty.test(anchorText))continue;personHint=namedAttendee(anchorText,attendees);if(!personHint)continue;}
  seen.add(a);
  result.push({category,tier:LIFE_TIER[category],summary:summary.trim(),quote,...(personHint?{personHint}:{})});
 }
 return result;
}

export type LifeSource='gmail'|'granola'|'memory';
export interface LifeSignal {id:string;personId:string;category:LifeCategory;tier:LifeTier;summary:string;quote:string;source:LifeSource;sourceRef:string;observedAt:string;expiresAt:string}
type LifeRow={id:string;person:string;category:LifeCategory;tier:LifeTier;summary:string;quote:string;source:LifeSource;source_ref:string;observed:number;expires:number};
const DAY=86_400_000;

/** Owner-private life signals. Rows never leave this owner's storage; expired rows are invisible and purged. */
export class LifeSignalStore {
 constructor(private readonly storage:DurableObjectStorage,private readonly now:()=>number=Date.now){
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS life_signals (id TEXT PRIMARY KEY,person TEXT NOT NULL,category TEXT NOT NULL,tier TEXT NOT NULL,summary TEXT NOT NULL,quote TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,observed INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS life_signals_person ON life_signals(person,expires);
   CREATE TABLE IF NOT EXISTS life_processed (source_ref TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS life_settings (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);`);
 }
 enabled():boolean{return this.storage.sql.exec<{enabled:number}>('SELECT enabled FROM life_settings WHERE id=1').toArray()[0]?.enabled===1;}
 setEnabled(on:boolean):void{this.storage.sql.exec('INSERT OR REPLACE INTO life_settings (id,enabled) VALUES (1,?)',on?1:0);}
 processed(sourceRef:string):boolean{return this.storage.sql.exec('SELECT source_ref FROM life_processed WHERE source_ref=?',sourceRef).toArray().length>0;}
 markProcessed(sourceRef:string):void{this.storage.sql.exec('INSERT OR IGNORE INTO life_processed (source_ref) VALUES (?)',sourceRef);}
 add(personId:string,candidate:LifeCandidate,source:LifeSource,sourceRef:string,observed:number,index:number):void{
  const expires=observed+LIFE_TTL_DAYS[candidate.category]*DAY;
  this.storage.sql.exec('INSERT OR REPLACE INTO life_signals (id,person,category,tier,summary,quote,source,source_ref,observed,expires) VALUES (?,?,?,?,?,?,?,?,?,?)',`${source}:${sourceRef}:${index}`,personId,candidate.category,LIFE_TIER[candidate.category],candidate.summary,candidate.quote,source,sourceRef,observed,expires);
 }
 list(personIds?:string[]):LifeSignal[]{
  if(personIds&&!personIds.length)return [];
  const where=personIds?` AND person IN (${personIds.map(()=>'?').join(',')})`:'';
  return this.storage.sql.exec<LifeRow>(`SELECT * FROM life_signals WHERE expires>?${where} ORDER BY observed DESC,id`,this.now(),...(personIds??[])).toArray().map(row=>({id:row.id,personId:row.person,category:row.category,tier:row.tier,summary:row.summary,quote:row.quote,source:row.source,sourceRef:row.source_ref,observedAt:new Date(row.observed).toISOString(),expiresAt:new Date(row.expires).toISOString()}));
 }
 /** Deletes signals; processed markers stay so a forgotten source is never re-extracted. */
 forget(target:{id:string}|{personIds:string[]}|{all:true}):number{
  const [where,args]:[string,unknown[]]='id' in target?['id=?',[target.id]]:'personIds' in target?[`person IN (${target.personIds.map(()=>'?').join(',')||"''"})`,target.personIds]:['1=1',[]];
  const count=this.storage.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM life_signals WHERE ${where}`,...args).toArray()[0]?.n??0;
  this.storage.sql.exec(`DELETE FROM life_signals WHERE ${where}`,...args);
  return count;
 }
 /** Delete every signal from one source (`exact`) or one family of sources (`prefix`), e.g. a revoked inbox. */
 forgetSources(target:{exact:string}|{prefix:string}):void{
  if('exact' in target)this.storage.sql.exec('DELETE FROM life_signals WHERE source_ref=?',target.exact);
  else this.storage.sql.exec('DELETE FROM life_signals WHERE substr(source_ref,1,?)=?',target.prefix.length,target.prefix);
 }
 purgeExpired():void{this.storage.sql.exec('DELETE FROM life_signals WHERE expires<=?',this.now());}
}
