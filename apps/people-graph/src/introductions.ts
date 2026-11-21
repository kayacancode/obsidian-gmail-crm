import type {IntroductionRequest,IntroductionState} from './introduction-store';

/**
 * Introductions involve three people: an introducer and two parties. People records each step
 * the owner reports and never sends anything itself; the owner's agent drafts the messages.
 */
export type IntroductionStatus='proposed'|'asked_introducer'|'introducer_accepted'|'target_opted_in'|'made'|'met'|'not_met'|'declined'|'expired';
export interface IntroductionEvidence {personId:string;source:string;date:string;summary:string}
export interface Introduction {
 id:string;source:'owner'|'workspace';readOnly?:boolean;
 /** `'owner'` or the introducer's person (or workspace member) id; `parties` always holds exactly two. */
 introducer:string;parties:string[];reason:string;evidence:IntroductionEvidence[];
 status:IntroductionStatus;
 /** Written by the owner as introducer; seen only by the owner, never exported or shared. */
 vouch:string|null;
 outcome:{result:'met'|'not_met';note:string|null}|null;
 startedBy:'owner'|'introducer';alternativePersonId?:string|null;createdAt:string;updatedAt:string;
}
export interface ProposalInput {introducer:string;parties:[string,string];reason:string;evidence:IntroductionEvidence[]}
export const isIntroductionStatus=(value:unknown):value is IntroductionStatus=>typeof value==='string'&&Object.hasOwn(NEXT,value);

const DAY=86_400_000;
const NEXT:Record<IntroductionStatus,IntroductionStatus[]>={
 proposed:['asked_introducer','declined'],asked_introducer:['introducer_accepted','declined'],introducer_accepted:['target_opted_in','declined'],
 target_opted_in:['made','declined'],made:[],met:[],not_met:[],declined:[],expired:[],
};
const OPEN:Record<IntroductionStatus,boolean>={proposed:true,asked_introducer:true,introducer_accepted:true,target_opted_in:true,made:false,met:false,not_met:false,declined:false,expired:false};
const VOUCHABLE:Record<IntroductionStatus,boolean>={proposed:false,asked_introducer:false,introducer_accepted:true,target_opted_in:true,made:true,met:false,not_met:false,declined:false,expired:false};
export const isOpen=(intro:Introduction)=>OPEN[intro.status];

const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():null;
const invalid=()=>Error('invalid_request');
const stateInvalid=()=>Error('introduction_state_invalid');

/** One proposal at a time: five open asks per introducer, five proposals a day. */
export function proposeIntroduction(input:ProposalInput,existing:Introduction[],now:number):Introduction{
 const introducer=text(input.introducer,200),reason=text(input.reason,500);
 const parties=Array.isArray(input.parties)&&input.parties.length===2?input.parties.map(p=>text(p,200)):[];
 if(!introducer||!reason||parties.length!==2||parties.some(p=>!p)||parties[0]===parties[1]||parties.includes(introducer))throw invalid();
 // The owner's store holds the owner's introductions: the owner introduces or is one of the parties.
 if(introducer!=='owner'&&!parties.includes('owner'))throw invalid();
 if(!Array.isArray(input.evidence)||input.evidence.length>5)throw invalid();
 if(existing.filter(i=>i.source==='owner'&&i.startedBy==='owner'&&Date.parse(i.createdAt)>now-DAY).length>=5)throw Error('introduction_rate_limited');
 if(introducer!=='owner'&&existing.filter(i=>i.introducer===introducer&&isOpen(i)).length>=5)throw Error('introduction_budget');
 const at=new Date(now).toISOString();
 return {id:'intro_'+crypto.randomUUID().replace(/-/g,''),source:'owner',introducer,parties:[parties[0]!,parties[1]!],reason,
  evidence:input.evidence.map(e=>({personId:String(e.personId).slice(0,200),source:String(e.source).slice(0,40),date:String(e.date).slice(0,40),summary:String(e.summary).slice(0,300)})),
  status:'proposed',vouch:null,outcome:null,startedBy:'owner',createdAt:at,updatedAt:at};
}

/** One step forward, never back. The owner as introducer goes straight to accepting. */
export function advance(intro:Introduction,step:{to:IntroductionStatus;vouch?:string},now:number):Introduction{
 if(intro.readOnly)throw stateInvalid();
 const ownerIntroduces=intro.introducer==='owner';
 const allowed=ownerIntroduces&&intro.status==='proposed'?['introducer_accepted','declined']:NEXT[intro.status];
 if(!allowed.includes(step.to))throw stateInvalid();
 let vouch=intro.vouch;
 if(step.vouch!==undefined){
  if(!ownerIntroduces||!VOUCHABLE[step.to])throw invalid();
  vouch=text(step.vouch,500);if(!vouch)throw invalid();
 }
 return {...intro,status:step.to,vouch,updatedAt:new Date(now).toISOString()};
}

export function recordOutcome(intro:Introduction,outcome:{result:'met'|'not_met';note:string|null},now:number):Introduction{
 if(intro.readOnly||intro.status!=='made')throw stateInvalid();
 if(outcome.result!=='met'&&outcome.result!=='not_met')throw invalid();
 const note=outcome.note===null?null:text(outcome.note,500);
 if(outcome.note!==null&&!note)throw invalid();
 return {...intro,status:outcome.result,outcome:{result:outcome.result,note},updatedAt:new Date(now).toISOString()};
}

/** Thirty days without progress closes an open introduction. */
export function expire(intro:Introduction,now:number):Introduction{
 return isOpen(intro)&&Date.parse(intro.updatedAt)<now-30*DAY?{...intro,status:'expired'}:intro;
}

const WORKSPACE_STATUS:Record<IntroductionState,IntroductionStatus>={requested:'asked_introducer',checking_interest:'introducer_accepted',agreed:'target_opted_in',completed:'made',declined:'declined',cancelled:'declined',alternative_suggested:'declined'};

/** A shared-workspace request seen as a three-party introduction; it stays owned by the workspace flow. */
export function fromWorkspaceRequest(request:IntroductionRequest):Introduction{
 return {id:'workspace:'+request.workspaceId+':'+request.id,source:'workspace',readOnly:true,introducer:request.recipientId,parties:[request.requesterId,request.personId],
  reason:request.message,evidence:[],status:WORKSPACE_STATUS[request.state],vouch:null,outcome:null,startedBy:'introducer',
  alternativePersonId:request.alternativePersonId,createdAt:request.createdAt,updatedAt:request.updatedAt};
}

/** Owner-private introductions. Expiry is applied, and saved, when they are read. */
export class IntroductionStore {
 constructor(private storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS introductions (id TEXT PRIMARY KEY,data TEXT NOT NULL,created INTEGER NOT NULL)');
 }
 save(intro:Introduction){this.storage.sql.exec('INSERT OR REPLACE INTO introductions VALUES (?,?,?)',intro.id,JSON.stringify(intro),Date.parse(intro.createdAt));return intro;}
 list(now:number):Introduction[]{
  return this.storage.sql.exec<{data:string}>('SELECT data FROM introductions ORDER BY created DESC,id').toArray().map(row=>{
   const stored=JSON.parse(row.data) as Introduction,current=expire(stored,now);
   if(current.status!==stored.status)this.save(current);
   return current;
  });
 }
 get(id:string,now:number){return this.list(now).find(i=>i.id===id)??null;}
}
