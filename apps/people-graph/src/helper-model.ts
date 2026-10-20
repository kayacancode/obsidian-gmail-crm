/// <reference path="../worker-configuration.d.ts" />

export const HELPER_MODEL='@cf/openai/gpt-oss-120b' as const;
export const HELPER_MODEL_TIMEOUT_MS=60_000;

/** Helpers need reasoning over two people's context; extraction continues using its own model.
 * Use the existing Workers AI binding's native Responses interface. Only final output text is
 * parsed; reasoning items are neither exposed, logged, persisted nor used as the answer.
 */
export async function runHelperModel(ai:Env['AI']|undefined,input:{instructions:string;state:unknown;schema:Record<string,unknown>;name:string;maxOutputTokens:number},signal:AbortSignal):Promise<unknown>{
 if(!ai||signal.aborted)throw Error('ai_unavailable');
 const source=JSON.stringify(input.state);
 if(source.length>100_000)throw Error('helper_input_too_large');
 let output:unknown;
 try{
  output=await settle(ai.run(HELPER_MODEL,{
   input:[{role:'system' as const,content:input.instructions},{role:'user' as const,content:source}],
   reasoning:{effort:'medium'},text:{format:{type:'json_schema',name:input.name,schema:input.schema,strict:true}},
   temperature:0,max_output_tokens:input.maxOutputTokens,stream:false,truncation:'disabled',
  },{signal}),signal);
 }catch{throw Error('ai_unavailable');}
 if(!isRecord(output)||output.error||output.incomplete_details||(output.status!==undefined&&output.status!=='completed'))throw Error('invalid_helper_output');
 let finalText='';
 if(typeof output.output_text==='string')finalText=output.output_text;
 else if(Array.isArray(output.output))for(const item of output.output){
  if(!isRecord(item)||item.type!=='message'||item.role!=='assistant'||!Array.isArray(item.content))continue;
  if(item.status!==undefined&&item.status!=='completed')throw Error('invalid_helper_output');
  for(const content of item.content){
   if(!isRecord(content))continue;
   if(content.type==='refusal')throw Error('invalid_helper_output');
   if(content.type==='output_text'&&typeof content.text==='string')finalText+=content.text;
  }
 }
 if(!finalText.trim()||finalText.length>24_000)throw Error('invalid_helper_output');
 try{return JSON.parse(finalText);}catch{throw Error('invalid_helper_output');}
}
function isRecord(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function settle<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{const abort=()=>reject(Error('ai_unavailable'));signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},()=>{signal.removeEventListener('abort',abort);reject(Error('ai_unavailable'));});if(signal.aborted)abort();});}
