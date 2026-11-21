// Live accuracy check for `ask` classification against a running People deployment.
// Usage: PEOPLE_URL=https://… PEOPLE_TOKEN=people_… node scripts/eval-ask.mjs
// Read-only: every request is the ask route, which never changes anything. The token is never printed.
import {readFile} from 'node:fs/promises';

const url=process.env.PEOPLE_URL,token=process.env.PEOPLE_TOKEN;
if(!url||!token){console.error('Set PEOPLE_URL and PEOPLE_TOKEN (a People integration key with people:read).');process.exit(2);}
const origin=new URL(url).origin;
const cases=JSON.parse(await readFile(new URL('../tests/fixtures/ask-eval.json',import.meta.url),'utf8'));
const tally=new Map(),misses=[];
for(const c of cases){
 const response=await fetch(origin+'/api/people-agent/request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method:'POST',path:'/api/people/ask',body:{question:c.question}})});
 const body=await response.json().catch(()=>({}));
 const got=body?.interpretation?.intent??`http_${response.status}`;
 const entry=tally.get(c.intent)??{right:0,total:0};entry.total++;
 if(got===c.intent)entry.right++;else misses.push({question:c.question,expected:c.intent,got});
 tally.set(c.intent,entry);
}
const right=[...tally.values()].reduce((sum,e)=>sum+e.right,0);
for(const [intent,{right:r,total}] of tally)console.log(`${intent.padEnd(13)} ${r}/${total}`);
for(const miss of misses)console.log(`MISS ${miss.expected} → ${miss.got}: ${miss.question}`);
const accuracy=right/cases.length;
console.log(`accuracy ${(accuracy*100).toFixed(1)}% (${right}/${cases.length})`);
process.exit(accuracy>=0.85?0:1);
