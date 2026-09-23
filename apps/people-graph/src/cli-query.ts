import {loadPeopleNetwork,type PeopleEnv} from './people-service';
export type QueryCommand='find-person'|'contact-card'|'who-knows'|'score'|'get-neighbors'|'get-edges'|'reconnect';
export type QueryInput={command:QueryCommand;query?:string;personId?:string;email?:string;company?:string;from?:string;to?:string;limit?:number;min_score?:number};
export type QueryEnvelope={ok:boolean;command:string;data?:Record<string,unknown>;stats?:{contractVersion:1;source:string;scoreModel:string|null;updatedAt:number|null};error?:{kind:string;message:string}};
type Person={id:string;name?:string;company?:string;role?:string;combined?:number;strength?:number;momentum?:number;lastContact?:string|null;[key:string]:unknown};
type Edge={source:string;target:string;[key:string]:unknown};
const commands=new Set(['find-person','contact-card','who-knows','score','get-neighbors','get-edges','reconnect']);
export async function queryPeople(env:PeopleEnv,owner:string,input:QueryInput):Promise<QueryEnvelope>{
 const fail=(kind:string,message:string,data?:Record<string,unknown>):QueryEnvelope=>({ok:false,command:input?.command??'unknown',error:{kind,message},...(data?{data}:{})});
 if(!input||!commands.has(input.command))return fail('unsupported_operation','This web interface supports read-only people queries.');
 const limit=input.limit??20;
 if(!Number.isInteger(limit)||limit<1||limit>200||input.min_score!==undefined&&(!Number.isFinite(input.min_score)||input.min_score<0||input.min_score>100))return fail('invalid_request','Limit must be 1–200 and minimum score 0–100.');
 for(const value of [input.query,input.personId,input.email,input.company,input.from,input.to])if(value!==undefined&&(typeof value!=='string'||!value.trim()||value.length>200))return fail('invalid_request','Identifiers and queries must contain 1–200 characters.');
 if(input.command==='find-person'&&!input.query||input.command==='who-knows'&&!input.company)return fail('invalid_request','A search value is required.');
 const loaded=await loadPeopleNetwork(env,owner);
 const graph=loaded.graph as unknown as {nodes:Person[];edges:Edge[];source?:string;scoreModel?:string;pushedAt?:string}|null;
 const nodes=graph?.nodes??[],ids=new Set(nodes.map(n=>n.id));
 const edges=(graph?.edges??[]).filter(e=>ids.has(e.source)&&ids.has(e.target));
 const stamp=graph?.pushedAt?Date.parse(graph.pushedAt):NaN;
 const stats={contractVersion:1 as const,source:graph?.source??'obsidian',scoreModel:graph?.scoreModel??null,updatedAt:loaded.updatedAt??(Number.isFinite(stamp)?Math.floor(stamp/1000):null)};
 const ok=(data:Record<string,unknown>):QueryEnvelope=>({ok:true,command:input.command,data,stats});
 const rank=(a:Person,b:Person)=>(b.combined??-1)-(a.combined??-1)||a.id.localeCompare(b.id);
 const resolve=async(value:string|undefined)=>{
  if(!value)return [];
  const exact=nodes.filter(n=>n.id===value);if(exact.length)return exact;
  if(value.includes('@')){const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);const id=await stub.resolveOwnEmail(value.toLowerCase());return nodes.filter(n=>n.id===id);}
  return nodes.filter(n=>n.name?.toLowerCase()===value.toLowerCase());
 };
 if(input.command==='find-person'){
  const q=input.query!.trim().toLowerCase();
  let people=q.includes('@')?await resolve(q):nodes.filter(n=>[n.name,n.company,n.role].some(v=>typeof v==='string'&&v.toLowerCase().includes(q)));
  // Same evidence service as website; its existing shared-evidence restrictions remain in force.
  if(!people.length&&!q.includes('@')&&graph?.source==='email_accounts'){
   const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
   const result=await stub.searchPeople(input.query!);
   const matched=new Set(result.results.map(r=>r.personId));people=nodes.filter(n=>matched.has(n.id));
  }
  return ok({people:people.sort(rank).slice(0,limit)});
 }
 if(input.command==='who-knows')return ok({people:nodes.filter(n=>n.company?.toLowerCase().includes(input.company!.trim().toLowerCase())).sort(rank).slice(0,limit)});
 if(input.command==='reconnect')return ok({people:nodes.filter(n=>n.lastContact&&Number.isFinite(Date.parse(n.lastContact))&&(n.combined??-1)>=(input.min_score??0)).sort((a,b)=>Date.parse(a.lastContact!)-Date.parse(b.lastContact!)||rank(a,b)).slice(0,limit),ranking:'oldest-known-contact-then-combined-score'});
 const matches=await resolve(input.personId??input.email??input.query??input.from);
 if(!matches.length)return fail('not_found','No visible person matches this identifier.');
 if(matches.length>1)return fail('ambiguous_person','Choose a person ID from the candidates.',{people:matches});
 const person=matches[0];
 if(input.command==='contact-card')return ok({person});
 if(input.command==='score')return ok({personId:person.id,score:typeof person.combined==='number'?{combined:person.combined,strength:person.strength??null,momentum:person.momentum??null}:null});
 if(input.command==='get-neighbors'){
  const links=edges.filter(e=>e.source===person.id||e.target===person.id);
  const neighbors=new Set(links.flatMap(e=>[e.source,e.target]).filter(id=>id!==person.id));
  const people=nodes.filter(n=>neighbors.has(n.id)).sort(rank).slice(0,limit),shown=new Set([person.id,...people.map(n=>n.id)]);
  return ok({people,edges:links.filter(e=>shown.has(e.source)&&shown.has(e.target))});
 }
 const targets=await resolve(input.to);
 if(!targets.length)return fail('not_found','No visible target matches this identifier.');
 if(targets.length>1)return fail('ambiguous_person','Choose a target person ID.',{people:targets});
 return ok({edges:edges.filter(e=>e.source===person.id&&e.target===targets[0].id||e.target===person.id&&e.source===targets[0].id)});
}
