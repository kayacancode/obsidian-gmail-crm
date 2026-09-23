/**
 * Network sharing: the bounded slice of an owner's graph that crosses into another owner's
 * Durable Object. Everything here is pure data shaping — the owner's object decides what goes
 * in (`exportSlice`) and the viewer's object decides what it keeps (`importShares`). A slice
 * that arrives at a viewer is untrusted input from another object, so `normalizeSlice` is the
 * only door it comes through.
 */
export type ShareLevel='names'|'themes'|'statements';
/** `people` accepts either the owner's own contact addresses (server-side callers) or the
 *  opaque node ids the owner's browser holds; the owner's object resolves those to addresses. */
export type ShareScope={kind:'all'}|{kind:'folders';ids:string[]}|{kind:'people';emails:string[]}|{kind:'people';personIds:string[]};

export interface SharedPerson {email:string;name:string;lastContact:string|null;meetings:number}
export interface SharedEdge {a:string;b:string;weight:number;types:string[];contexts:string[]}
export interface SharedTheme {id:string;name:string}
export interface SharedSignal {email:string|null;themeId:string;summary:string;observedAt:string;sourceType:string;confidence:number;title?:string}
export interface SharedSlice {owner:string;exportedAt:number;people:SharedPerson[];edges:SharedEdge[];themes:SharedTheme[];signals:SharedSignal[]}

export const SHARE_LEVELS:readonly ShareLevel[]=Object.freeze(['names','themes','statements']);
export const SHARE_CAPS=Object.freeze({people:500,edges:2_000,signals:2_000,themes:200,owners:20});
/** Text caps, so one slice can never blow up the viewer's storage. */
const MAX_EMAIL=320,MAX_NAME=160,MAX_SUMMARY=240,MAX_THEME_NAME=120,MAX_TITLE=160,MAX_CONTEXTS=3,MAX_TYPES=4;
const EMAIL=/^[^\s@,<>"']+@[^\s@,<>"']+\.[^\s@,<>"']+$/;
/**
 * Source types a shared signal may claim. Four are deliberately absent: `public_url` and
 * `public_feed` belong to the owner's public-source pipeline, which forces visibility `public`
 * on persist while shared evidence must stay `firm`; `obsidian_note` summaries are free text
 * from the owner's own notes; and a `gmail_subject` theme name is two canonical tokens of the
 * owner's own subject line — raw mailbox content, never shared at any level. `gmail_body_derived`
 * stays because its summaries come from a fixed server vocabulary, not from the message.
 */
const SHARED_SOURCE_TYPES=new Set(['gmail_body_derived','calendar','granola','product_activity']);
/**
 * What a shared person is called in the viewer's graph. A stored contact name is often only the
 * local part of the address (a Cc line with no display name), and the viewer's node already
 * carries the domain as `company` — so a local-part name would hand the browser the address in
 * two halves. Anything that is not a real display name becomes the domain alone.
 */
export function sharedDisplayName(name:string|null|undefined,email:string):string {
 const [local,domain]=[email.slice(0,email.lastIndexOf('@')),email.slice(email.lastIndexOf('@')+1)];
 const display=(name??'').trim();
 if(!display||display.includes('@')||display.toLowerCase()===local.toLowerCase())return `Someone at ${domain}`;
 return display;
}
/**
 * A verbatim quote inside a signal summary. Granola statements are formatted
 * `Ask: “…”`, so the quote characters are the marker; the evidence-ref shape is a second net
 * for a statement whose quote was truncated away by the 240-character summary cap.
 */
export function carriesQuote(signal:{summary:string;evidenceRef?:string;sourceType?:string}):boolean {
 if(/[“”"]/.test(signal.summary))return true;
 const ref=signal.evidenceRef??'';
 return signal.sourceType==='granola'&&ref.includes('#')&&!ref.includes('#topic@');
}
/** Whether a signal of this source type may be shared at all; see SHARED_SOURCE_TYPES. */
export function shareableSourceType(sourceType:string):boolean {return SHARED_SOURCE_TYPES.has(sourceType);}
export function shareLevelAtLeast(level:ShareLevel,minimum:ShareLevel):boolean {return SHARE_LEVELS.indexOf(level)>=SHARE_LEVELS.indexOf(minimum);}
/** The level a slice actually carries, for the viewer's `shared_meta` row. */
export function levelOfSlice(slice:SharedSlice):ShareLevel {
 if(!slice.signals.length&&!slice.themes.length)return 'names';
 return slice.signals.some(signal=>carriesQuote(signal))?'statements':'themes';
}

export function normalizeShareLevel(value:unknown):ShareLevel {
 if(typeof value!=='string'||!SHARE_LEVELS.includes(value as ShareLevel))throw Error('invalid_share');
 return value as ShareLevel;
}
export function normalizeShareScope(value:unknown):ShareScope {
 if(!value||typeof value!=='object')throw Error('invalid_share');
 const scope=value as {kind?:unknown;ids?:unknown;emails?:unknown;personIds?:unknown};
 if(scope.kind==='all')return {kind:'all'};
 if(scope.kind==='folders')return {kind:'folders',ids:strings(scope.ids,200,200)};
 if(scope.kind==='people'){
  if(Array.isArray(scope.emails))return {kind:'people',emails:strings(scope.emails,SHARE_CAPS.people,MAX_EMAIL).map(email=>email.toLowerCase())};
  if(Array.isArray(scope.personIds))return {kind:'people',personIds:strings(scope.personIds,SHARE_CAPS.people,200)};
 }
 throw Error('invalid_share');
}
function strings(value:unknown,count:number,length:number):string[] {
 if(!Array.isArray(value))throw Error('invalid_share');
 return [...new Set(value.filter((item):item is string=>typeof item==='string'&&!!item.trim()&&item.length<=length).map(item=>item.trim()))].slice(0,count);
}

/**
 * The one entry point for a slice arriving from another Durable Object: caps every list,
 * drops anything malformed, and keeps only edges and signals that point at exported people
 * and exported themes. Returns null when the slice is not usable at all.
 */
export function normalizeSlice(value:unknown):SharedSlice|null {
 if(!value||typeof value!=='object')return null;
 const raw=value as Partial<SharedSlice>;
 const owner=typeof raw.owner==='string'?raw.owner.trim().toLowerCase():'';
 if(!owner||owner.length>MAX_EMAIL||!EMAIL.test(owner))return null;
 const exportedAt=Number.isSafeInteger(raw.exportedAt)&&(raw.exportedAt as number)>0?raw.exportedAt as number:0;
 const people:SharedPerson[]=[],seen=new Set<string>();
 for(const item of list(raw.people)){
  if(people.length>=SHARE_CAPS.people)break;
  const person=item as Partial<SharedPerson>;
  const email=typeof person.email==='string'?person.email.trim().toLowerCase():'';
  if(!email||email.length>MAX_EMAIL||!EMAIL.test(email)||seen.has(email))continue;
  seen.add(email);
  people.push({email,name:sharedDisplayName(text(person.name,MAX_NAME),email),lastContact:stamp(person.lastContact),meetings:count(person.meetings)});
 }
 const edges:SharedEdge[]=[],pairs=new Set<string>();
 for(const item of list(raw.edges)){
  if(edges.length>=SHARE_CAPS.edges)break;
  const edge=item as Partial<SharedEdge>;
  const a=typeof edge.a==='string'?edge.a.trim().toLowerCase():'',b=typeof edge.b==='string'?edge.b.trim().toLowerCase():'';
  if(a===b||!seen.has(a)||!seen.has(b))continue;
  const [x,y]=[a,b].sort(),key=x+'\u0000'+y;
  if(pairs.has(key))continue;
  pairs.add(key);
  edges.push({a:x,b:y,weight:Math.max(1,count(edge.weight)),types:strings(list(edge.types),MAX_TYPES,60),contexts:strings(list(edge.contexts),MAX_CONTEXTS,MAX_SUMMARY)});
 }
 const themes:SharedTheme[]=[],themeIds=new Set<string>();
 for(const item of list(raw.themes)){
  if(themes.length>=SHARE_CAPS.themes)break;
  const theme=item as Partial<SharedTheme>;
  const id=text(theme.id,200),name=text(theme.name,MAX_THEME_NAME);
  if(!id||!name||themeIds.has(id))continue;
  themeIds.add(id);themes.push({id,name});
 }
 const signals:SharedSignal[]=[];
 for(const item of list(raw.signals)){
  if(signals.length>=SHARE_CAPS.signals)break;
  const signal=item as Partial<SharedSignal>;
  const summary=text(signal.summary,MAX_SUMMARY),themeId=text(signal.themeId,200);
  const observedAt=stamp(signal.observedAt);
  const sourceType=text(signal.sourceType,60);
  if(!summary||!themeIds.has(themeId)||!observedAt||!SHARED_SOURCE_TYPES.has(sourceType))continue;
  const email=typeof signal.email==='string'?signal.email.trim().toLowerCase():null;
  if(email&&!seen.has(email))continue;
  const title=text(signal.title,MAX_TITLE);
  signals.push({email,themeId,summary,observedAt,sourceType,confidence:Math.max(0,Math.min(1,Number(signal.confidence)||0)),...(title?{title}:{})});
 }
 return {owner,exportedAt,people,edges,themes:themes.filter(theme=>signals.some(signal=>signal.themeId===theme.id)),signals};
}
function list(value:unknown):unknown[] {return Array.isArray(value)?value.slice(0,20_000):[];}
function text(value:unknown,length:number):string {return typeof value==='string'?value.trim().slice(0,length):'';}
function count(value:unknown):number {return Number.isFinite(value)&&(value as number)>0?Math.min(1_000_000,Math.floor(value as number)):0;}
/** An ISO timestamp the viewer can parse, or null; never a bare number or a bad string. */
function stamp(value:unknown):string|null {
 if(typeof value!=='string'||value.length>40)return null;
 const parsed=Date.parse(value);
 return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
