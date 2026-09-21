import {askJev,batchQuestions,estimateTokens,noul,score,type JevQuestion} from './jev';

/** One already-safe evidence line: a displayed signal summary, its date, and the meeting it came from. */
export interface SearchEvidence {summary:string;observedAt:string;title?:string}
/** One person of the owner's own graph, with the text the search may read. Never an email address. */
export interface SearchCandidate {personId:string;name:string;company:string|null;lastContact:string|null;evidence:SearchEvidence[];contexts:string[];themes:string[]}
export interface Ranked extends SearchCandidate {hits:number}
export interface SearchResult {personId:string;name:string;company:string|null;lastContact:string|null;score:number;reasons:SearchEvidence[]}

export const MAX_QUERY_LENGTH=200;
const CANDIDATES=40,MIN_HITS=10,RESULTS=10,EVIDENCE_PER_PERSON=5,REASONS=3,FALLBACK_REASONS=2;
const NAME_WEIGHT=3,JEV_TOKEN_BUDGET=20_000,QUESTION_TOKENS=80;
const LEVELS=['Unrelated','Loosely related','Relevant','Exactly who they are looking for'];
const STOPWORDS=new Set(['a','an','and','any','anyone','are','as','at','be','best','but','by','can','could','do','does','for','from','get','has','have','help','how','i','in','into','is','it','its','know','knows','looking','me','my','need','needs','of','on','or','our','out','should','so','some','someone','that','the','their','them','there','they','this','to','up','us','was','we','what','when','where','which','who','whom','whose','will','with','would','you','your']);

/** Lowercased, punctuation-free, stopword-free query terms; short noise words are dropped. */
export function queryTerms(query:string):string[]{
 const terms=query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term=>term.length>1&&!STOPWORDS.has(term));
 return [...new Set(terms)];
}

/**
 * Fast pass in code: every person the query could plausibly mean, best first. Name and company
 * hits weigh three; evidence summaries, meeting titles, edge contexts and theme names weigh one.
 * Fewer than ten hits fills the tail with the most recently contacted people, so the model still
 * has candidates to judge — a hit is never displaced by a filler.
 */
export function keywordRank(query:string,people:SearchCandidate[]):Ranked[]{
 const terms=queryTerms(query);
 const ranked=people.map(person=>({...person,hits:countHits(person,terms)}));
 const byRecency=(a:Ranked,b:Ranked)=>recency(b.lastContact)-recency(a.lastContact);
 const hits=ranked.filter(person=>person.hits>0).sort((a,b)=>b.hits-a.hits||byRecency(a,b));
 if(hits.length>=MIN_HITS)return hits.slice(0,CANDIDATES);
 const fillers=ranked.filter(person=>person.hits===0).sort(byRecency);
 return [...hits,...fillers].slice(0,CANDIDATES);
}

function countHits(person:SearchCandidate,terms:string[]):number{
 const weighted=[person.name,person.company].map(text=>(text??'').toLowerCase());
 const plain=[...person.evidence.flatMap(item=>[item.summary,item.title??'']),...person.contexts,...person.themes].map(text=>text.toLowerCase());
 let hits=0;
 for(const term of terms){
  for(const text of weighted)if(text.includes(term))hits+=NAME_WEIGHT;
  for(const text of plain)if(text.includes(term))hits+=1;
 }
 return hits;
}

/** Keyword hits as [0,1], relative to the best candidate. Used whenever Jev is unavailable. */
export function keywordScores(ranked:Ranked[]):number[]{
 const best=Math.max(0,...ranked.map(person=>person.hits));
 return ranked.map(person=>best?person.hits/best:0);
}

/**
 * Jev pass: one Score and one Noul per candidate, batched under the token budget. The state
 * carries the query plus each person's name, company, last contact and five newest evidence
 * lines — never an email address, an opaque person id, a note body or anybody else's evidence.
 * Throws JevError; the caller falls back to `keywordScores`.
 */
export async function jevScores(env:{TYPESAFE_API_KEY?:string;JEV_MODEL?:string},query:string,ranked:Ranked[],signal?:AbortSignal):Promise<number[]>{
 const entries=ranked.map((person,index)=>({index,state:{name:person.name,company:person.company,lastContact:person.lastContact,evidence:newest(person.evidence).slice(0,EVIDENCE_PER_PERSON)}}));
 const scores=new Array<number>(ranked.length).fill(0);
 for(const batch of batchQuestions(entries,entry=>estimateTokens(entry.state)+QUESTION_TOKENS,JEV_TOKEN_BUDGET)){
  const state={query,people:batch.map((entry,i)=>({i,...entry.state}))};
  const questions:Record<string,JevQuestion>={};
  batch.forEach((_entry,i)=>{
   questions[`r${i}`]=score(`How well does \`people[${i}]\` match what the query is looking for, judged only from their listed evidence?`,LEVELS);
   questions[`h${i}`]=noul(`Could \`people[${i}]\` plausibly help with the query, judging from the evidence?`);
  });
  const result=await askJev(env,state,questions,signal);
  batch.forEach((entry,i)=>{
   const rated=result.answers[`r${i}`],helpful=result.answers[`h${i}`];
   const level=rated.type==='score'?Math.min(LEVELS.length-1,Math.max(0,rated.score)):0;
   scores[entry.index]=0.7*(level/(LEVELS.length-1))+0.3*(helpful.type==='noul'?helpful.noul:0);
  });
 }
 return scores;
}

/** The ten best people, each with the evidence that explains why they are here. */
export function topResults(query:string,ranked:Ranked[],scores:number[],limit=RESULTS):SearchResult[]{
 const terms=queryTerms(query);
 return ranked.map((person,index)=>({person,score:scores[index]??0}))
  .sort((a,b)=>b.score-a.score||recency(b.person.lastContact)-recency(a.person.lastContact))
  .slice(0,limit)
  .map(({person,score:value})=>({personId:person.personId,name:person.name,company:person.company,lastContact:person.lastContact,
   score:value,reasons:reasonsFor(person,terms)}));
}

/** Up to three evidence items sharing a query term, else the two newest: never a bare assertion. */
function reasonsFor(person:SearchCandidate,terms:string[]):SearchEvidence[]{
 const ordered=newest(person.evidence);
 const shared=ordered.filter(item=>terms.some(term=>item.summary.toLowerCase().includes(term)||(item.title??'').toLowerCase().includes(term)));
 return (shared.length?shared.slice(0,REASONS):ordered.slice(0,FALLBACK_REASONS))
  .map(item=>({summary:item.summary,observedAt:item.observedAt,...(item.title?{title:item.title}:{})}));
}

function newest(evidence:SearchEvidence[]):SearchEvidence[]{return [...evidence].sort((a,b)=>recency(b.observedAt)-recency(a.observedAt));}
function recency(value:string|null):number{const at=value?Date.parse(value):Number.NaN;return Number.isFinite(at)?at:-Infinity;}
