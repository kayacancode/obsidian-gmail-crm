import type {MailEnv} from './mail-sync';
import type {PeopleEnv} from './people-service';
import {loadPeopleNetwork} from './people-service';
import {queryPeople} from './cli-query';
import {memoryBrief,rankHelperBrief,rankOwnerLens} from './helper-brief';
import {validMemoryEmail} from './relationship-memory';

type Store=ReturnType<MailEnv['MAIL']['getByName']>;
type Person={id:string;name?:string;type?:string;permission?:string;permissionConflict?:boolean;identityResolved?:boolean;identityStatus?:string};
type Connection={source?:string;target?:string;kind?:string;types?:string[];contexts?:string[];evidence?:unknown[]};
type Graph={nodes:Person[];edges:Connection[];source?:string;personAliases?:Record<string,string>};
const fields=['focus','needs','offers'] as const;
const canonical=(graph:Pick<Graph,'personAliases'>,id:string)=>graph.personAliases?.[id]||id;

/** Only owner-confirmed values are machine instructions. Inferred suggestions remain in the review UI. */
export async function confirmedPeopleLens(stub:Store){
 const lens=await stub.getOwnerLens();
 return {fields:lens.fields,revision:lens.revision,updatedAt:lens.updatedAt};
}

/** Shared by the browser and machine adapters; pending suggestions never define a request. */
export async function savedPeopleMatches(env:MailEnv,stub:Store){
 const lens=await stub.getOwnerLens();
 if(!Object.values(lens.fields).some(value=>value.trim()))return rankOwnerLens(env,{nodes:[]},lens.fields);
 const recommendationMemory=await stub.recommendationMemory(),graph=await stub.graph(),helperContext=await stub.helperContext();
 const result=await rankOwnerLens(env,{...(graph??{nodes:[]}),helperContext,recommendationMemory},lens.fields);
 const current=await stub.getOwnerLens();
 if(fields.some(key=>current.fields[key]!==lens.fields[key]))throw Error('owner_lens_conflict');
 if((await stub.recommendationMemory()).revision!==recommendationMemory.revision)throw Error('person_context_conflict');
 return result;
}

/** Preserve the website's saved-report, source refresh, ranking and explanation path. */
export async function selectedPeopleHelpers(env:MailEnv,stub:Store,requestedId:string,explicitBrief=''){
 let recommendationMemory=await stub.recommendationMemory(),graph=await stub.graph();
 if(!graph)throw Error('invalid_request');
 const personId=canonical(graph,requestedId);
 if(!graph.nodes.some(node=>node.id===personId))throw Error('invalid_request');
 const explicit=explicitBrief.trim();
 if(!explicit&&!memoryBrief(recommendationMemory.people[personId])){
  await stub.refreshHelperContext(personId);
  recommendationMemory=await stub.recommendationMemory();
  graph=await stub.graph();
  if(!graph||canonical(graph,requestedId)!==personId||!graph.nodes.some(node=>node.id===personId))throw Error('person_context_conflict');
 }
 const brief=explicit||memoryBrief(recommendationMemory.people[personId]),contextSource=explicit?'brief':brief?'saved_note':'automatic';
 const helperContext=await stub.helperContext();
 const result=await rankHelperBrief(env,{...graph,helperContext,recommendationMemory},personId,explicit);
 if((await stub.recommendationMemory()).revision!==recommendationMemory.revision)throw Error('person_context_conflict');
 return {...result,contextSource,brief};
}

export async function findPeople(env:PeopleEnv,owner:string,stub:Store,query:string,limit:number){
 const before=await stub.recommendationMemory();
 const result=await queryPeople(env,owner,{command:'find-person',query,limit});
 if(!result.ok)throw Error(result.error?.kind||'invalid_request');
 // Re-read visible nodes, not the model-backed search, and keep the original ranking.
 // This also catches replaced pushed graphs outside the MailSync source fingerprint.
 const current=await loadPeopleNetwork(env,owner),people=result.data?.people;
 if(!Array.isArray(people))throw Error('invalid_request');
 for(const person of people){
  const matches=current.graph?.nodes.filter(node=>node.id===person.id)??[];
  if(matches.length!==1||JSON.stringify(matches[0])!==JSON.stringify(person))throw Error('person_context_conflict');
 }
 // graph() itself yields while assembling nodes; fence both private and shared
 // source withdrawal after that final read, including names-only incoming shares.
 if((await stub.recommendationMemory()).revision!==before.revision)throw Error('person_context_conflict');
 return {...result.data,stats:result.stats};
}

function exactPerson(graph:Graph,id:string):Person{
 const matches=graph.nodes.filter(person=>person.id===canonical(graph,id));
 if(!matches.length)throw Error('unknown_person');
 if(matches.length!==1||matches[0].permission==='conflicted'||matches[0].permissionConflict||matches[0].identityResolved===false||matches[0].identityStatus==='unresolved')throw Error('ambiguous_person');
 if(matches[0].permission==='denied'||matches[0].type==='company')throw Error('unknown_person');
 return matches[0];
}
function connectionResult(graph:Graph,fromId:string,toId:string){
 const from=exactPerson(graph,fromId),to=exactPerson(graph,toId);
 const connections=graph.edges.filter(edge=>edge.source===from.id&&edge.target===to.id||edge.source===to.id&&edge.target===from.id).map(edge=>({...edge,kind:edge.kind||'cooccurrence',types:edge.types||[],contexts:edge.contexts||[],evidence:edge.evidence||[]}));
 return {from:{personId:from.id,name:from.name||''},to:{personId:to.id,name:to.name||''},status:connections.length?'found':'not_found',connections};
}

/** Recorded graph edges are the whole claim: co-occurrence cannot invent an introduction. */
export async function explainPeopleConnection(env:PeopleEnv,owner:string,stub:Store,from:string,to:string){
 const before=await stub.recommendationMemory();
 const loaded=await loadPeopleNetwork(env,owner),graph:Graph|null=loaded.graph;
 if(!graph)throw Error('unknown_person');
 const resolve=async(value:string)=>{
  if(!value.includes('@'))return exactPerson(graph,value).id;
  if(!validMemoryEmail(value))throw Error('invalid_request');
  const id=await stub.resolveOwnEmail(value.toLowerCase());
  if(!id)throw Error('unknown_person');
  return exactPerson(graph,id).id;
 };
 const fromId=await resolve(from),toId=await resolve(to),result=connectionResult(graph,fromId,toId);
 // The final graph also fences introduction withdrawals, which can leave other source
 // revisions unchanged. Never return an edge that was removed during identity resolution.
 const current=await loadPeopleNetwork(env,owner);
 if(!current.graph)throw Error('person_context_conflict');
 let latest;try{latest=connectionResult(current.graph,fromId,toId);}catch{throw Error('person_context_conflict');}
 if(JSON.stringify(latest)!==JSON.stringify(result)||(await stub.recommendationMemory()).revision!==before.revision)throw Error('person_context_conflict');
 return result;
}
