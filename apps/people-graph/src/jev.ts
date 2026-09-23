import {boundedJSON} from './bounded-json';

export type JevQuestion=
 |{type:'noul';instructions:unknown;criteria?:{true?:unknown;false?:unknown}}
 |{type:'choice';instructions:unknown;criteria:Record<string,unknown>}
 |{type:'score';instructions:unknown;criteria:unknown[]};
export type JevAnswer=
 |{type:'noul';noul:number}
 |{type:'choice';choice:string;probabilities:Record<string,number>;confidence:number}
 |{type:'score';score:number;legend:Record<string,string>;probabilities:Record<string,number>;confidence:number};
export interface JevResult {model:string;answers:Record<string,JevAnswer>;usage:{input_tokens:number;output_tokens:number}}

export class JevError extends Error{
 constructor(readonly code:'jev_unconfigured'|'jev_unauthorized'|'jev_rate_limited'|'jev_unavailable'|'jev_invalid',message?:string){super(message??code);this.name='JevError';}
}

const BASE_URL='https://api.typesafe.ai/v1/systemone';
const MAX_RESPONSE_BYTES=1024*1024;
const TIMEOUT_MS=20_000;
const DEFAULT_RETRY_MS=2_000;
const MAX_RETRY_MS=10_000;

let sleepImpl:(ms:number)=>Promise<void>=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Test-only hook: swap the retry delay for a fast fake. Pass null to restore the real timer. */
export function __setJevSleepForTests(fn:((ms:number)=>Promise<void>)|null):void{sleepImpl=fn??((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));}

export function jevConfigured(env:{TYPESAFE_API_KEY?:string}):boolean{return typeof env.TYPESAFE_API_KEY==='string'&&env.TYPESAFE_API_KEY.length>0;}

export async function askJev(env:{TYPESAFE_API_KEY?:string;JEV_MODEL?:string},state:unknown,questions:Record<string,JevQuestion>,signal?:AbortSignal):Promise<JevResult>{
 if(!jevConfigured(env))throw new JevError('jev_unconfigured');
 const key=env.TYPESAFE_API_KEY!;
 const body=JSON.stringify({state,model:env.JEV_MODEL??'jev-latest',questions});
 let response=await send(key,body,signal);
 if(response.status===429){
  const delayMs=retryDelayMs(response.headers.get('retry-after'));
  await response.body?.cancel().catch(()=>{});
  await sleepImpl(delayMs);
  response=await send(key,body,signal);
 }
 if(response.status===401){await response.body?.cancel().catch(()=>{});throw new JevError('jev_unauthorized');}
 if(response.status===429){await response.body?.cancel().catch(()=>{});throw new JevError('jev_rate_limited');}
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw new JevError('jev_unavailable');}
 let parsed:unknown;
 try{parsed=await boundedJSON(response,MAX_RESPONSE_BYTES);}
 catch{throw new JevError('jev_invalid');}
 return validateResult(parsed,questions);
}

async function send(key:string,body:string,signal?:AbortSignal):Promise<Response>{
 // A caller's deadline that ran out during an earlier batch or a 429 back-off: do not start
 // another request just to have it aborted.
 if(signal?.aborted)throw new JevError('jev_unavailable');
 const timeout=AbortSignal.timeout(TIMEOUT_MS);
 const merged=signal?AbortSignal.any([signal,timeout]):timeout;
 try{return await fetch(BASE_URL,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body,redirect:'manual',signal:merged});}
 catch{throw new JevError('jev_unavailable');}
}

function retryDelayMs(header:string|null):number{
 // A blank or whitespace-only header is no header at all: Number('') is 0, which would retry
 // into the same rate limit immediately.
 if(header!==null&&header.trim()!==''){
  const seconds=Number(header.trim());
  if(Number.isFinite(seconds))return Math.max(0,Math.min(seconds,MAX_RETRY_MS/1000))*1000;
 }
 return DEFAULT_RETRY_MS;
}

function validateResult(value:unknown,questions:Record<string,JevQuestion>):JevResult{
 if(!isRecord(value)||typeof value.model!=='string')throw new JevError('jev_invalid');
 const usage=value.usage;
 if(!isRecord(usage)||typeof usage.input_tokens!=='number'||!Number.isFinite(usage.input_tokens)||typeof usage.output_tokens!=='number'||!Number.isFinite(usage.output_tokens))throw new JevError('jev_invalid');
 if(!isRecord(value.answers))throw new JevError('jev_invalid');
 const answers:Record<string,JevAnswer>={};
 for(const id of Object.keys(questions))answers[id]=validateAnswer(questions[id],value.answers[id]);
 return {model:value.model,answers,usage:{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}};
}

function validateAnswer(question:JevQuestion,answer:unknown):JevAnswer{
 if(!isRecord(answer)||answer.type!==question.type)throw new JevError('jev_invalid');
 if(question.type==='noul'){
  const noulValue=answer.noul;
  if(typeof noulValue!=='number'||!Number.isFinite(noulValue)||noulValue<0||noulValue>1)throw new JevError('jev_invalid');
  return {type:'noul',noul:noulValue};
 }
 const probabilities=validateProbabilities(answer.probabilities);
 const confidence=answer.confidence;
 if(typeof confidence!=='number'||!Number.isFinite(confidence))throw new JevError('jev_invalid');
 if(question.type==='choice'){
  const choiceValue=answer.choice;
  if(typeof choiceValue!=='string'||!Object.hasOwn(question.criteria,choiceValue))throw new JevError('jev_invalid');
  return {type:'choice',choice:choiceValue,probabilities,confidence};
 }
 const scoreValue=answer.score;
 if(typeof scoreValue!=='number'||!Number.isFinite(scoreValue))throw new JevError('jev_invalid');
 const legend=answer.legend;
 if(!isRecord(legend)||Object.values(legend).some(v=>typeof v!=='string'))throw new JevError('jev_invalid');
 return {type:'score',score:scoreValue,legend:legend as Record<string,string>,probabilities,confidence};
}

function validateProbabilities(value:unknown):Record<string,number>{
 if(!isRecord(value)||Object.values(value).some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new JevError('jev_invalid');
 return value as Record<string,number>;
}

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}

export function estimateTokens(value:unknown):number{return Math.ceil((JSON.stringify(value)??'').length/4);}

export function batchQuestions<T>(items:T[],cost:(item:T)=>number,budget:number):T[][]{
 const batches:T[][]=[];let current:T[]=[];let currentCost=0;
 for(const item of items){
  const itemCost=cost(item);
  if(current.length&&currentCost+itemCost>budget){batches.push(current);current=[];currentCost=0;}
  current.push(item);currentCost+=itemCost;
 }
 if(current.length)batches.push(current);
 return batches;
}

export const noul=(instructions:unknown,criteria?:{true?:unknown;false?:unknown}):JevQuestion=>criteria?{type:'noul',instructions,criteria}:{type:'noul',instructions};
export const choice=(instructions:unknown,criteria:Record<string,unknown>):JevQuestion=>({type:'choice',instructions,criteria});
export const score=(instructions:unknown,levels:unknown[]):JevQuestion=>({type:'score',instructions,criteria:levels});
