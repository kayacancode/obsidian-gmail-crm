import {keywords} from './network-structure';

/**
 * A curiosity note: the owner's current thinking in four fixed sections. It is the "intent now"
 * behind moments and fringe searches, and it is private: never shared, exported or answered.
 */
export interface CuriosityItem {text:string;names:string[]}
export interface CuriosityNote {title:string;newInMyHead:CuriosityItem[];why:string;fringes:string[];wantToTalkTo:string[]}

type Section='newInMyHead'|'why'|'fringes'|'wantToTalkTo';
const HEADINGS:Record<string,{section:Section;order:number}>={
 "what's new in my head":{section:'newInMyHead',order:0},
 'why it spikes my interest':{section:'why',order:1},
 'the fringes':{section:'fringes',order:2},
 'who i want to talk to about it':{section:'wantToTalkTo',order:3},
};
export const MAX_NOTE_LENGTH=4000;

/** "(Ada + example)" names people or groups to resolve; each part is kept as written. */
function namesIn(text:string):string[]{
 return [...text.matchAll(/\(([^()]{1,200})\)/g)].flatMap(m=>m[1].split('+').map(p=>p.trim()).filter(p=>p&&p.length<=60));
}

/** Parse exactly the four headings, in order, each at most once; anything else is `note_invalid:<heading>`. */
export function parseCuriosityNote(markdown:string):CuriosityNote{
 if(typeof markdown!=='string'||!markdown.trim())throw Error('invalid_request');
 if(markdown.length>MAX_NOTE_LENGTH)throw Error('note_too_long');
 const lines:Record<Section,string[]>={newInMyHead:[],why:[],fringes:[],wantToTalkTo:[]},preamble:string[]=[];
 let current:Section|null=null,last=-1;
 for(const line of markdown.split(/\r?\n/)){
  const heading=/^##\s+(.+?)\s*$/.exec(line);
  if(heading){
   const name=heading[1],known=HEADINGS[name.replace(/[’‘]/g,"'").toLowerCase()];
   if(!known||known.order<=last)throw Error('note_invalid:'+name);
   current=known.section;last=known.order;continue;
  }
  (current?lines[current]:preamble).push(line);
 }
 const bullets=(section:Section)=>lines[section].map(l=>/^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1]).filter((t):t is string=>!!t);
 return {
  title:preamble.join(' ').replace(/^#\s*/,'').replace(/\s+/g,' ').trim().slice(0,120),
  newInMyHead:bullets('newInMyHead').map(text=>({text,names:namesIn(text)})),
  why:lines.why.map(l=>l.trim()).filter(Boolean).join('\n'),
  fringes:bullets('fringes'),
  wantToTalkTo:bullets('wantToTalkTo'),
 };
}

/** What the note is about: what is new, why, and the fringes. Who to talk to is not a topic. */
export function noteKeywords(note:CuriosityNote):Set<string>{
 return keywords([...note.newInMyHead.map(i=>i.text),note.why,...note.fringes].join(' '));
}

export interface StoredNote extends CuriosityNote {id:string;status:'active'|'archived';text:string;createdAt:string;updatedAt:string}
type NoteRow={id:string;text:string;parsed:string;status:'active'|'archived';created:number;updated:number};
export const MAX_ACTIVE_NOTES=3;

/** Owner-private curiosity notes. At most three are active; archived notes stay until deleted. */
export class CuriosityNoteStore {
 constructor(private storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS curiosity_notes (id TEXT PRIMARY KEY,text TEXT NOT NULL,parsed TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL)');
 }
 private read(row:NoteRow):StoredNote{
  return {...(JSON.parse(row.parsed) as CuriosityNote),id:row.id,status:row.status,text:row.text,createdAt:new Date(row.created).toISOString(),updatedAt:new Date(row.updated).toISOString()};
 }
 list(includeArchived=false):StoredNote[]{
  return this.storage.sql.exec<NoteRow>(`SELECT * FROM curiosity_notes${includeArchived?'':" WHERE status='active'"} ORDER BY updated DESC,id`).toArray().map(row=>this.read(row));
 }
 /** Create a note, or replace an active one in place; a fourth active note is `note_limit`. */
 set(text:string,id:string|undefined,now:number):StoredNote{
  const parsed=parseCuriosityNote(text);
  if(id!==undefined){
   const row=this.storage.sql.exec<NoteRow>("SELECT * FROM curiosity_notes WHERE id=? AND status='active'",id).toArray()[0];
   if(!row)throw Error('not_found');
   this.storage.sql.exec('UPDATE curiosity_notes SET text=?,parsed=?,updated=? WHERE id=?',text,JSON.stringify(parsed),now,id);
   return this.read({...row,text,parsed:JSON.stringify(parsed),updated:now});
  }
  const active=this.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM curiosity_notes WHERE status='active'").toArray()[0].n;
  if(active>=MAX_ACTIVE_NOTES)throw Error('note_limit');
  const row:NoteRow={id:'note_'+crypto.randomUUID().replace(/-/g,''),text,parsed:JSON.stringify(parsed),status:'active',created:now,updated:now};
  this.storage.sql.exec('INSERT INTO curiosity_notes VALUES (?,?,?,?,?,?)',row.id,row.text,row.parsed,row.status,row.created,row.updated);
  return this.read(row);
 }
 archive(id:string,now:number):boolean{
  if(!this.storage.sql.exec("SELECT id FROM curiosity_notes WHERE id=? AND status='active'",id).toArray().length)return false;
  this.storage.sql.exec("UPDATE curiosity_notes SET status='archived',updated=? WHERE id=?",now,id);
  return true;
 }
}
