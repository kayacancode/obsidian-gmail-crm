import {keywords,type WhyNowAnswer,type ContrastAnswer,type BridgePair,type WidenResult} from './network-structure';

/**
 * Moments: a few timely, evidenced reasons a day to act toward one to three people. Interest
 * depends on the owner's notes, so without a note only meetings surface. Surprise is rationed
 * and the daily budget is small on purpose: success is connection, not engagement.
 */
export type MomentKind='pre_meeting'|'want_to_talk'|'fresh_signal'|'fringe_match'|'bridge'|'cold_and_relevant'|'widen';
export type MomentStatus='new'|'acted'|'snoozed'|'dismissed';
export interface MomentWhy {kind:string;summary:string;source:string;observedAt:string;attribution:'first_hand'}
export interface Moment {id:string;kind:MomentKind;personIds:string[];trigger:string;answer:{why:MomentWhy[];gaps:string[]};createdAt:string;expiresAt:string;status:MomentStatus;day:string;snoozedUntil?:string}
export interface MomentNote {id:string;title:string;keywords:Set<string>;people:{name:string;personId:string|null}[];fringes:string[]}
export interface MomentInput {
 now:number;day:string;budget:number;notes:MomentNote[];whyNow:WhyNowAnswer[];
 /** Recent evidence summaries per person, for relevance to the notes. */
 evidence:Record<string,string[]>;lastContact:Record<string,string|null>;names:Record<string,string>;
 fringe:{fringe:string;answers:ContrastAnswer[]}[];bridges:BridgePair[];widen:WidenResult|null;
 existing:Moment[];suppressed:{personId:string;kind:MomentKind;until:number}[];
}

const DAY=86_400_000;
export const PRIORITY:Record<MomentKind,number>={pre_meeting:0,want_to_talk:1,fresh_signal:2,fringe_match:3,bridge:4,cold_and_relevant:5,widen:6};
const EXPIRY_DAYS:Record<MomentKind,number>={pre_meeting:2,want_to_talk:14,fresh_signal:7,fringe_match:14,bridge:14,cold_and_relevant:14,widen:14};
const SURPRISE:Record<MomentKind,boolean>={pre_meeting:false,want_to_talk:false,fresh_signal:false,fringe_match:true,bridge:false,cold_and_relevant:false,widen:true};

interface Candidate {kind:MomentKind;personIds:string[];why:MomentWhy[];at:number;expiresAt?:string}

export function generateMoments(input:MomentInput):Moment[]{
 const {now,notes}=input,noteWords=new Set(notes.flatMap(n=>[...n.keywords]));
 const relevant=(personId:string,...texts:string[])=>[...keywords([...texts,...(input.evidence[personId]??[])].join(' '))].some(w=>noteWords.has(w));
 const candidates:Candidate[]=[];
 const entry=(kind:string,summary:string,source:string,observedAt:string):MomentWhy=>({kind,summary,source,observedAt,attribution:'first_hand'});
 for(const answer of input.whyNow)for(const w of answer.why){
  const at=Date.parse(w.observedAt),evidence=[entry(w.trigger,w.summary,w.source,w.observedAt)];
  if(w.trigger==='meeting_soon')candidates.push({kind:'pre_meeting',personIds:[answer.personId],why:evidence,at,expiresAt:w.observedAt});
  else if(!notes.length)continue;
  else if(w.trigger==='fresh_signal'&&relevant(answer.personId,w.summary))candidates.push({kind:'fresh_signal',personIds:[answer.personId],why:evidence,at});
  else if(w.trigger==='going_cold'&&relevant(answer.personId,w.summary))candidates.push({kind:'cold_and_relevant',personIds:[answer.personId],why:evidence,at});
 }
 for(const note of notes)for(const person of note.people){
  if(!person.personId)continue;
  const last=input.lastContact[person.personId],days=last?Math.floor((now-Date.parse(last))/DAY):null;
  if(days!==null&&days<30)continue;
  candidates.push({kind:'want_to_talk',personIds:[person.personId],at:last?Date.parse(last):0,
   why:[entry('note',`On your list for "${note.title||'your note'}"; ${days===null?'no recorded contact':`no contact in ${days} days`}`,'curiosity_note',new Date(now).toISOString())]});
 }
 if(notes.length){
  for(const {fringe,answers} of input.fringe)for(const a of answers.filter(a=>a.distance.value===1))
   candidates.push({kind:'fringe_match',personIds:[a.personId],at:now,why:[entry('fringe',`Speaks to your fringe question: ${fringe.slice(0,160)}`,'curiosity_note',new Date(now).toISOString()),entry('distance',a.distance.reason,'network',new Date(now).toISOString()),...a.why]});
  for(const pair of input.bridges){
   const shared=[...pair.sharedEvidence.keywords,...pair.sharedEvidence.themes];
   if(![...keywords(shared.join(' '))].some(w=>noteWords.has(w)))continue;
   candidates.push({kind:'bridge',personIds:pair.people.map(p=>p.personId),at:now,why:[entry('shared',`Both: ${shared.slice(0,5).join(', ')}`,'network',new Date(now).toISOString()),...pair.why]});
  }
  const pick=input.widen?.answers[0],pattern=input.widen?.result?.pattern;
  if(pick&&pattern)candidates.push({kind:'widen',personIds:[pick.personId],at:now,why:[entry('pattern',`${Math.round(pattern.share*100)}% of your last 30 days were in one circle`,'activity',new Date(now).toISOString()),...pick.why]});
 }
 // Judgment and pacing: dismissals, a week between moments per person, rationed surprise, the budget.
 const today=input.existing.filter(m=>m.day===input.day);
 const recent=new Set(input.existing.filter(m=>Date.parse(m.createdAt)>now-7*DAY).flatMap(m=>m.personIds));
 const suppressed=(kind:MomentKind,ids:string[])=>input.suppressed.some(s=>s.kind===kind&&s.until>now&&ids.includes(s.personId));
 let surprise=today.some(m=>SURPRISE[m.kind]),room=Math.max(0,input.budget-today.length);
 const chosen:Moment[]=[],used=new Set<string>();
 for(const c of candidates.sort((a,b)=>PRIORITY[a.kind]-PRIORITY[b.kind]||a.at-b.at||a.personIds.join().localeCompare(b.personIds.join()))){
  if(!room)break;
  if(c.personIds.some(id=>recent.has(id)||used.has(id))||suppressed(c.kind,c.personIds))continue;
  if(SURPRISE[c.kind]){if(surprise)continue;surprise=true;}
  c.personIds.forEach(id=>used.add(id));room--;
  chosen.push({id:`${input.day}:${c.kind}:${c.personIds.join('+')}`,kind:c.kind,personIds:c.personIds,trigger:c.why[0].summary,answer:{why:c.why,gaps:[]},
   createdAt:new Date(now).toISOString(),expiresAt:c.expiresAt??new Date(now+EXPIRY_DAYS[c.kind]*DAY).toISOString(),status:'new',day:input.day});
 }
 return chosen;
}
