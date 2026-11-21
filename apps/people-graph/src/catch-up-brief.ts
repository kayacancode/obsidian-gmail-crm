import type {LifeCategory,LifeSignal} from './life-signals';
import type {CompanyStint} from './company-stints';
import type {TimelineEntry} from './owner-timeline';

/** Everything a brief may say about one person, all of it owner-private and first-hand. */
export interface BriefInput {
 person:{id:string;name:string;company:string;lastContact:string|null;combined:number|null};
 signalsEnabled:boolean;
 signals:LifeSignal[];
 work:{summary:string;observedAt:string;source:string}[];
 memory:{text:string;createdAt:number}[];
 feedback:{action:string}|null;
 relationship:'neutral'|'closer'|'weaker';
 stints:CompanyStint[];
 timeline:TimelineEntry[];
 now:number;
}
export type BriefUse='rank'|'tone_only';
export interface BriefWhy {kind:'life'|'work'|'note';category?:LifeCategory;summary:string;source:string;observedAt:string;attribution:'first_hand';use:BriefUse}
export interface BriefAnswer {
 personId:string;name:string;
 when:{lastContact:string|null;daysSince:number|null;label:'active'|'warm'|'cooling'|'stale'|'dormant'|null};
 why:BriefWhy[];
 whether:{feedback:string|null;relationship:BriefInput['relationship'];notes:number};
 use:'rank';
}
export interface CatchUpBrief {
 interpretation:null;
 answers:BriefAnswer[];
 gaps:string[];
 sinceLastContact:{theirs:Array<{kind:'signal'|'stint';category?:LifeCategory;summary:string;date:string;use:BriefUse}>;yours:TimelineEntry[]};
}

const DAY=86_400_000;
const label=(days:number):BriefAnswer['when']['label']=>days<30?'active':days<90?'warm':days<180?'cooling':days<365?'stale':'dormant';

/** Assemble the when/why/whether envelope plus both sides of "since you last spoke". */
export function assembleBrief(input:BriefInput):CatchUpBrief{
 const last=input.person.lastContact?Date.parse(input.person.lastContact):NaN;
 const known=Number.isFinite(last);
 const daysSince=known?Math.max(0,Math.floor((input.now-last)/DAY)):null;
 const why:BriefWhy[]=[
  ...input.signals.map(s=>({kind:'life' as const,category:s.category,summary:s.summary,source:s.source,observedAt:s.observedAt,attribution:'first_hand' as const,use:s.tier==='sensitive'?'tone_only' as const:'rank' as const})),
  ...input.work.map(w=>({kind:'work' as const,summary:w.summary,source:w.source,observedAt:w.observedAt,attribution:'first_hand' as const,use:'rank' as const})),
  ...input.memory.map(m=>({kind:'note' as const,summary:m.text.slice(0,160),source:'memory',observedAt:new Date(m.createdAt).toISOString(),attribution:'first_hand' as const,use:'rank' as const})),
 ];
 const after=(date:string)=>!known||Date.parse(date)>last;
 const theirs=[
  ...input.signals.filter(s=>after(s.observedAt)).map(s=>({kind:'signal' as const,category:s.category,summary:s.summary,date:s.observedAt,use:s.tier==='sensitive'?'tone_only' as const:'rank' as const})),
  ...input.stints.filter(s=>after(s.from+'-28')).map(s=>({kind:'stint' as const,summary:`Started at ${s.company}`,date:s.from+'-01',use:'rank' as const})),
 ].sort((a,b)=>a.date.localeCompare(b.date));
 const yours=input.timeline.filter(t=>after(t.date+'T23:59:59Z')).sort((a,b)=>a.date.localeCompare(b.date));
 const gaps:string[]=[];
 if(!input.signalsEnabled)gaps.push('No life signals: signals are off');
 if(!input.memory.length)gaps.push('No first-hand notes');
 if(!known)gaps.push('No contact date recorded');
 return {
  interpretation:null,
  answers:[{personId:input.person.id,name:input.person.name,when:{lastContact:input.person.lastContact,daysSince,label:daysSince===null?null:label(daysSince)},why,whether:{feedback:input.feedback?.action??null,relationship:input.relationship,notes:input.memory.length},use:'rank'}],
  gaps,
  sinceLastContact:{theirs,yours},
 };
}
