import {askJev,batchQuestions,estimateTokens,noul,choice,score,type JevQuestion} from './jev';
import {KIND_LABEL,normalise,type GranolaExtraction,type GranolaExtractionInput,type GroundedStatement,type StatementKind} from './granola-extractor';
import {THEME_TOPICS,type TopicId} from './theme-extractor';

export interface JevStatement extends GroundedStatement {probability:number;urgency:number;openLoop:number;theirAsk:number}
export interface JevExtraction extends GranolaExtraction {engine:'jev';statements:JevStatement[];topics:{topicId:TopicId;confidence:number}[];themeChoice?:{kind:'folder'|'topic'|'none';id:string;probability:number}}
export type CandidateSpan={source:'summary'|'private_notes'|'transcript';offset:number;text:string};
export type JevExtractorInput=GranolaExtractionInput&{folders:{id:string;name:string}[];title:string};

const MIN_SPAN=20,MAX_SPAN=300,MAX_SPANS=400;
const GATE_MIN=0.5,MAX_JUDGED=60;
const MIN_ATTENDEE=0.4,MIN_TOPIC=0.35,URGENCY_MAX=3;
const MAX_ATTENDEES=200,MAX_FOLDERS=50,MAX_TITLE=300;
// The per-note topic and folder choices see the whole note in miniature: a summary excerpt
// plus a handful of representative spans, never just whichever spans a judge batch held.
const NOTE_SPANS=12,NOTE_SUMMARY_CHARS=2_000;
// 20k of the 64k request budget: five questions per span plus their criteria are repeated
// per span in the body, so the safe span count per request is well under the hard limit.
// SPAN_OVERHEAD covers the quoting, commas and question-id keys the estimate per item misses;
// MARGIN keeps the whole body under budget rather than just state plus question text.
const BUDGET_TOKENS=20_000,MIN_BUDGET=1_000,SPAN_OVERHEAD=8,MARGIN=512;

const GATE_QUESTION='Does this span express something a specific attendee asked for, promised, wants, needs to follow up on, or an introduction requested or offered?';
const GATE_CRITERIA={true:'The span states a request, a promise, a want, something to follow up on, or an introduction offered or requested.',false:'The span is small talk, agenda scaffolding, a greeting, or a general remark with no request, promise or follow-up in it.'};
const KIND_CRITERIA:Record<StatementKind,string>={ask:'They asked for something.',commitment:'They promised to do something.',intro:'An introduction was requested or offered.',follow_up:'Something to check on later.',interest:'Something they care about or want.'};
const URGENCY_LEVELS=['No time pressure','Sometime soon','This week or a stated date','Overdue or blocking'];
const OPEN_LOOP_CRITERIA={true:'The note owner still owes an action, an answer or a delivery here.',false:'Nothing is outstanding for the owner: it is done, dropped, or somebody else owns it.'};
const THEIR_ASK_CRITERIA={true:'The attendee is asking the note owner for something.',false:'The attendee is not asking the owner for anything here.'};
const TOPIC_LIST=Object.entries(THEME_TOPICS).map(([id,topic])=>({id,name:topic.name,summary:topic.summary}));
const TOPIC_CRITERIA:Record<string,string>={...Object.fromEntries(TOPIC_LIST.map(t=>[t.id,t.summary])),none:'No topic on the list describes this meeting.'};

const clamp=(v:number,lo:number,hi:number)=>v<lo?lo:v>hi?hi:v;
const path=(i:number)=>'`spans['+i+']`';

/** Sentence and line candidates, 20-300 characters, offsets into the whitespace-normalised source. */
export function candidateSpans(input:GranolaExtractionInput):CandidateSpan[] {
 const spans:CandidateSpan[]=[];
 for(const [source,raw,pattern] of [['summary',input.summary,/(?<=[.!?])\s+|\n+/],['private_notes',input.privateNotes,/(?<=[.!?])\s+|\n+/],['transcript',input.transcript,/\n+/]] as const){
  const normalised=normalise(raw);if(!normalised)continue;
  // The cursor keeps the scan in document order, so repeated text lands on its own offset
  // and every span round-trips: normalised.slice(offset,offset+text.length)===text.
  let cursor=0;
  for(const piece of raw.split(pattern)){
   const text=normalise(piece);if(!text)continue;
   const offset=normalised.indexOf(text,cursor);if(offset<0)continue;
   cursor=offset+text.length;
   if(text.length>=MIN_SPAN&&text.length<=MAX_SPAN)spans.push({source,offset,text});
  }
 }
 return spans.slice(0,MAX_SPANS);
}

export class GranolaJevExtractor {
 constructor(private readonly env:{TYPESAFE_API_KEY?:string;JEV_MODEL?:string}){}

 async extract(input:JevExtractorInput,signal?:AbortSignal):Promise<JevExtraction> {
  const title=input.title.slice(0,MAX_TITLE);
  const seen=new Set<string>();
  const attendees=input.attendees.map(a=>({email:a.email.trim().toLowerCase(),name:a.name})).filter(a=>a.email&&!seen.has(a.email)&&seen.add(a.email)).slice(0,MAX_ATTENDEES);
  const folders=input.folders.slice(0,MAX_FOLDERS).map(f=>({id:f.id,name:f.name}));
  const spans=candidateSpans(input);
  let calls=0;

  // Stage 1: one cheap yes/no per candidate, keeping the strongest MAX_JUDGED spans.
  const gateState={title,attendees};
  const gateBudget=Math.max(MIN_BUDGET,BUDGET_TOKENS-MARGIN-estimateTokens(gateState));
  const gateCost=estimateTokens(noul({span:path(999),question:GATE_QUESTION},GATE_CRITERIA));
  const scored:{span:CandidateSpan;probability:number}[]=[];
  if(attendees.length&&spans.length)for(const batch of batchQuestions(spans,s=>estimateTokens(s.text)+gateCost+SPAN_OVERHEAD,gateBudget)){
   const questions:Record<string,JevQuestion>={};
   batch.forEach((_s,i)=>{questions['g'+i]=noul({span:path(i),question:GATE_QUESTION},GATE_CRITERIA);});
   const result=await askJev(this.env,{...gateState,spans:batch.map(s=>s.text)},questions,signal);calls++;
   batch.forEach((span,i)=>{const answer=result.answers['g'+i];if(answer.type==='noul'&&answer.noul>=GATE_MIN)scored.push({span,probability:answer.noul});});
  }
  const kept=scored.sort((a,b)=>b.probability-a.probability).slice(0,MAX_JUDGED).map(x=>x.span);

  const attendeeCriteria:Record<string,string>={...Object.fromEntries(attendees.map(a=>[a.email,a.name?`${a.name} <${a.email}>: the span is about them, or they said it.`:`${a.email}: the span is about them, or they said it.`])),none:'No attendee in particular, or only the note owner.'};
  const folderCriteria:Record<string,string>={...Object.fromEntries(folders.map(f=>[f.id,`The folder named ${f.name}.`])),none:'None of these folders describes this meeting.'};
  const judgeState={title,attendees,topics:TOPIC_LIST,folders};
  const judgeBudget=Math.max(MIN_BUDGET,BUDGET_TOKENS-MARGIN-estimateTokens(judgeState));
  const judgeCost=estimateTokens(this.spanQuestions(999,attendeeCriteria));
  const statements:JevStatement[]=[];
  let topics:{topicId:TopicId;confidence:number}[]=[];
  let themeChoice:JevExtraction['themeChoice'];

  // Stage 2a: one small request for the two per-note choices, always made — a note with no
  // attendees still belongs to a topic and a folder.
  const noteSpans=(kept.length?kept:spans).slice(0,NOTE_SPANS).map(s=>s.text);
  const noteQuestions:Record<string,JevQuestion>={note_topic:choice({question:'Which topic best describes this meeting?',title,summary:'`summary`',spans:'`spans`'},TOPIC_CRITERIA)};
  if(folders.length)noteQuestions.note_theme=choice({question:'Which folder best describes this meeting?',title,summary:'`summary`',spans:'`spans`'},folderCriteria);
  const noteResult=await askJev(this.env,{title,folders,topics:TOPIC_LIST,summary:normalise(input.summary).slice(0,NOTE_SUMMARY_CHARS),spans:noteSpans},noteQuestions,signal);calls++;
  const topic=noteResult.answers.note_topic;
  if(topic?.type==='choice'&&topic.choice!=='none'&&Object.hasOwn(THEME_TOPICS,topic.choice)){
   const confidence=topic.probabilities[topic.choice]??0;
   if(confidence>=MIN_TOPIC)topics=[{topicId:topic.choice as TopicId,confidence}];
  }
  const theme=noteResult.answers.note_theme;
  if(theme?.type==='choice')themeChoice=theme.choice==='none'
   ?{kind:'none',id:'',probability:theme.probabilities.none??0}
   :{kind:'folder',id:theme.choice,probability:theme.probabilities[theme.choice]??0};

  // Stage 2b: the per-span judgments.
  for(const batch of kept.length?batchQuestions(kept,s=>estimateTokens(s.text)+judgeCost+SPAN_OVERHEAD,judgeBudget):[]){
   const questions:Record<string,JevQuestion>={};
   batch.forEach((_s,i)=>Object.assign(questions,this.spanQuestions(i,attendeeCriteria)));
   const result=await askJev(this.env,{...judgeState,spans:batch.map(s=>s.text)},questions,signal);calls++;
   batch.forEach((span,i)=>{
    const who=result.answers['a'+i],kind=result.answers['k'+i],urgency=result.answers['u'+i],openLoop=result.answers['o'+i],theirAsk=result.answers['r'+i];
    if(who?.type!=='choice'||kind?.type!=='choice'||urgency?.type!=='score'||openLoop?.type!=='noul'||theirAsk?.type!=='noul')return;
    if(who.choice==='none')return;
    const attendeeProbability=who.probabilities[who.choice]??0;
    if(attendeeProbability<MIN_ATTENDEE||!Object.hasOwn(KIND_LABEL,kind.choice))return;
    statements.push({email:who.choice,kind:kind.choice as StatementKind,quote:span.text,source:span.source,offset:span.offset,
     probability:clamp(attendeeProbability*(kind.probabilities[kind.choice]??0),0,1),urgency:clamp(urgency.score/URGENCY_MAX,0,1),openLoop:openLoop.noul,theirAsk:theirAsk.noul});
   });
  }
  return {engine:'jev',topics,statements,themeChoice,calls,returned:{topics:1,statements:kept.length}};
 }

 private spanQuestions(i:number,attendeeCriteria:Record<string,string>):Record<string,JevQuestion>{
  const span=path(i);
  return {
   ['a'+i]:choice({span,question:'Which attendee is this span about, or who said it?'},attendeeCriteria),
   ['k'+i]:choice({span,question:'What kind of statement is this span?'},KIND_CRITERIA),
   ['u'+i]:score({span,question:'How much time pressure does this span carry?'},URGENCY_LEVELS),
   ['o'+i]:noul({span,question:'Does the owner still owe something here?'},OPEN_LOOP_CRITERIA),
   ['r'+i]:noul({span,question:'Is the attendee asking the owner for something?'},THEIR_ASK_CRITERIA),
  };
 }
}
