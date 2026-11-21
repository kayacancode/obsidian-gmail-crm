import {loadPeopleNetwork,type PeopleEnv} from './people-service';
import {nameMatch,nearestNames,NAME_MATCH_FLOOR,type NameMatchKind} from './name-match';
export type QueryCommand='find-person'|'contact-card'|'who-knows'|'score'|'get-neighbors'|'get-edges'|'reconnect';
export type QueryInput={command:QueryCommand;query?:string;personId?:string;email?:string;company?:string;from?:string;to?:string;limit?:number;min_score?:number;include_former?:boolean;include_self?:boolean;strict_name_order?:boolean};
export type QueryEnvelope={ok:boolean;command:string;data?:Record<string,unknown>;stats?:{contractVersion:1;owner:string;source:string;scoreModel:string|null;updatedAt:number|null};error?:{kind:string;message:string}};
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
 if(input.include_former!==undefined&&(typeof input.include_former!=='boolean'||input.command!=='who-knows'))return fail('invalid_request','include_former applies to who-knows only.');
 for(const flag of [input.include_self,input.strict_name_order])if(flag!==undefined&&(typeof flag!=='boolean'||input.command!=='find-person'))return fail('invalid_request','include_self and strict_name_order apply to find-person only.');
 const loaded=await loadPeopleNetwork(env,owner);
 const graph=loaded.graph as unknown as {nodes:Person[];edges:Edge[];personAliases?:Record<string,string>;source?:string;scoreModel?:string;pushedAt?:string}|null;
 const nodes=graph?.nodes??[],ids=new Set(nodes.map(n=>n.id));
 const edges=(graph?.edges??[]).filter(e=>ids.has(e.source)&&ids.has(e.target));
 const stamp=graph?.pushedAt?Date.parse(graph.pushedAt):NaN;
 const stats={contractVersion:1 as const,owner,source:graph?.source??'obsidian',scoreModel:graph?.scoreModel??null,updatedAt:loaded.updatedAt??(Number.isFinite(stamp)?Math.floor(stamp/1000):null)};
 const ok=(data:Record<string,unknown>):QueryEnvelope=>({ok:true,command:input.command,data,stats});
 const rank=(a:Person,b:Person)=>(b.combined??-1)-(a.combined??-1)||a.id.localeCompare(b.id);
 const resolve=async(value:string|undefined)=>{
  if(!value)return [];
  const canonical=(id:string)=>graph?.personAliases?.[id]??id;
  const exact=nodes.filter(n=>n.id===canonical(value));if(exact.length)return exact;
  if(value.includes('@')){const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);const id=await stub.resolveOwnEmail(value.toLowerCase());return nodes.filter(n=>id&&n.id===canonical(id));}
  return nodes.filter(n=>n.name?.toLowerCase()===value.toLowerCase());
 };
 if(input.command==='find-person'){
  // Same contract as the local CLI: the owner is left out unless asked for, every person says
  // how it matched, and evidence-ranked people are labelled so they never pass as name matches.
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  const self=await stub.ownerIdentity(),canonical=(id:string)=>graph?.personAliases?.[id]??id;
  const selfIds=new Set(self.personIds.map(canonical)),selfNames=new Set(self.names.map(n=>n.trim().toLowerCase()).filter(Boolean));
  const isSelf=(n:Person)=>selfIds.has(n.id)||(typeof n.name==='string'&&selfNames.has(n.name.trim().toLowerCase()));
  const visible=input.include_self?nodes:nodes.filter(n=>!isSelf(n)),shown=new Set(visible.map(n=>n.id));
  const q=input.query!.trim();
  type Found=Person&{name_match:NameMatchKind|null;matched_by:'email'|'name'|'company'|'role'|'evidence'};
  let people:Found[];
  if(q.includes('@'))people=(await resolve(q.toLowerCase())).filter(n=>shown.has(n.id)).map(n=>({...n,name_match:'exact',matched_by:'email'}));
  else{
   const named=visible.flatMap(n=>{const m=typeof n.name==='string'?nameMatch(n.name,q,input.strict_name_order===true):null;return m&&m.confidence>=NAME_MATCH_FLOOR?[{n,m}]:[];})
    .sort((a,b)=>b.m.confidence-a.m.confidence||(b.n.combined??-1)-(a.n.combined??-1)||String(a.n.name).localeCompare(String(b.n.name)));
   const byName=new Set(named.map(x=>x.n.id)),lower=q.toLowerCase();
   const field=(n:Person)=>typeof n.company==='string'&&n.company.toLowerCase().includes(lower)?'company' as const:typeof n.role==='string'&&n.role.toLowerCase().includes(lower)?'role' as const:null;
   people=[...named.map(({n,m})=>({...n,name_match:m.kind,matched_by:'name' as const})),
    ...visible.filter(n=>!byName.has(n.id)&&field(n)).sort(rank).map(n=>({...n,name_match:null,matched_by:field(n)!}))];
  }
  const hints=people.length||q.includes('@')?[]:nearestNames(visible.flatMap(n=>typeof n.name==='string'?[n.name]:[]),q);
  // Same evidence service as website; its existing shared-evidence restrictions remain in force.
  if(!people.length&&!q.includes('@')&&graph?.source==='email_accounts'){
   const result=await stub.searchPeople(input.query!);
   const matched=new Set(result.results.map(r=>r.personId));
   people=visible.filter(n=>matched.has(n.id)).sort(rank).map(n=>({...n,name_match:null,matched_by:'evidence'}));
  }
  return ok({people:people.slice(0,limit),hints,excludedSelf:nodes.length-visible.length});
 }
 if(input.command==='who-knows'){
  const current=nodes.filter(n=>n.company?.toLowerCase().includes(input.company!.trim().toLowerCase())).sort(rank);
  if(!input.include_former)return ok({people:current.slice(0,limit)});
  // Former colleagues come from email-domain history; they never displace current people.
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  const former=await stub.formerAt(input.company!.trim()),shown=new Set(current.map(n=>n.id));
  const canonical=(id:string)=>graph?.personAliases?.[id]??id;
  const past=nodes.filter(n=>!shown.has(n.id)&&former.personIds.some(id=>canonical(id)===n.id)).sort(rank).map(n=>({...n,formerly:former.stints[former.personIds.find(id=>canonical(id)===n.id)!]}));
  return ok({people:[...current,...past].slice(0,limit)});
 }
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
