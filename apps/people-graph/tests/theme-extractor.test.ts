import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ThemeExtractor, THEME_MODEL} from '../src/theme-extractor';
import {FakeAI} from './worker-stub';

const input={text:'PRIVATE BODY SENTENCE: We should explore retrieval systems together next week.',themeName:undefined};
const valid={themes:[{topicId:'agent_memory',confidence:0.8}]};
test('round1 vocabulary rejects names, secrets, body fragments and unknown topic choices',async()=>{
 for(const value of ['Ada Jones','fixture-secret-do-not-use','"tiny quote"','We should explore','unlisted_topic','__proto__']){
  for(const theme of [{name:value,summary:'Topic collaboration',confidence:.8},{topicId:value,confidence:.8}])
   await assert.rejects(new ThemeExtractor(new FakeAI({response:{themes:[theme]}}) as any,THEME_MODEL).extract(input),{message:'invalid_extraction'});
 }
});
test('round1 vocabulary accepts only identifiers and confidence from the finite schema',async()=>{
 const ai=new FakeAI({response:{themes:[{topicId:'agent_memory',confidence:.8}]}});
 assert.deepEqual(await new ThemeExtractor(ai as any,THEME_MODEL).extract(input),[{topicId:'agent_memory',confidence:.8}]);
 const schema=ai.calls[0].input.response_format.json_schema.properties.themes.items;
 assert.deepEqual(schema.required,['topicId','confidence']);assert.ok(schema.properties.topicId.enum.includes('agent_memory'));
 await assert.rejects(new ThemeExtractor(new FakeAI({response:{themes:[{topicId:'agent_memory',confidence:.8,name:'fixture-secret-do-not-use'}]}}) as any,THEME_MODEL).extract(input),{message:'invalid_extraction'});
});
test('extractor pins model and schema, accepts object and string response envelopes',async()=>{
 for(const response of [valid,JSON.stringify(valid)]){
  const ai=new FakeAI({response});
  assert.deepEqual(await new ThemeExtractor(ai as any,THEME_MODEL).extract(input),valid.themes);
  assert.equal(ai.calls[0].model,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(ai.calls[0].input.response_format.type,'json_schema');
  assert.equal(ai.calls[0].input.response_format.json_schema.additionalProperties,false);
  assert.match(ai.calls[0].input.messages[0].content,/identity|employment/);
 }
});
test('extractor accepts the Workers AI transport envelope and returns none of its metadata',async()=>{
 const response={
  choices:[{message:'PRIVATE BODY ECHO'}],created:1,ec_transfer_params:{},id:'request-one',kv_transfer_params:{},
  metrics:{},model:THEME_MODEL,object:'text_completion',prompt_logprobs:null,prompt_text:'PRIVATE BODY SENTENCE',
  prompt_token_ids:[1,2],response:valid,service_tier:'default',tool_calls:[],usage:{prompt_tokens:8},
 };
 const extracted=await new ThemeExtractor(new FakeAI(response) as any,THEME_MODEL).extract(input);
 assert.deepEqual(extracted,valid.themes);
 assert.doesNotMatch(JSON.stringify(extracted),/PRIVATE BODY|request-one|prompt_tokens/);
});
test('extractor fails closed for malformed, extra, identity, copied, or unsafe output',async()=>{
 for(const response of ['not json',null,[],{themes:[],personId:'attacker'},
  {themes:[{...valid.themes[0],confidence:4}]}, {themes:[{...valid.themes[0],name:''}]},
  {themes:[{...valid.themes[0],company:'Acme'}]},
  {themes:[{...valid.themes[0],summary:'Ada is employed at Acme'}]},
  {themes:[{...valid.themes[0],summary:'PRIVATE BODY SENTENCE: We should explore retrieval systems together next week.'}]},
  {themes:[{...valid.themes[0],summary:'Contact ada@example.com'}]},
  {themes:[{...valid.themes[0],summary:'"confidential quote"'}]},
  {themes:Array(13).fill(valid.themes[0])}]){
  await assert.rejects(new ThemeExtractor(new FakeAI({response}) as any,THEME_MODEL).extract(input),{message:'invalid_extraction'});
 }
});
test('extractor hides provider failures and rejects absent or unpinned bindings',async()=>{
 for(const [ai,model] of [[undefined,THEME_MODEL],[new FakeAI(valid),'other-model'],[new FakeAI(new Error('SECRET PROVIDER OUTPUT')),THEME_MODEL]])
  await assert.rejects(new ThemeExtractor(ai as any,model as string).extract(input),{message:'ai_unavailable'});
});
test('extractor rejects verbatim labels, encoded identity fields and identity-bearing envelopes',async()=>{
 for(const response of [{themes:[{name:'We should explore retrieval systems',summary:'Collaboration on memory tooling',confidence:.8}]}, {themes:[{name:'Ada Jones',summary:'She leads Acme engineering',confidence:.8}]}, {themes:[{...valid.themes[0],summary:'Contact ada&#64;example.com'}]}])
  await assert.rejects(new ThemeExtractor(new FakeAI({response}) as any,THEME_MODEL).extract(input),{message:'invalid_extraction'});
 await assert.rejects(new ThemeExtractor(new FakeAI({response:valid,personId:'new-identity'}) as any,THEME_MODEL).extract(input),{message:'invalid_extraction'});
});
