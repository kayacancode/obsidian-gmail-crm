import {completedIntroductionCounts} from './introduction-store';
import {buildAnswerCards} from './network-answer';
import {suggestIntroductions,type Introduction} from './workspace-introductions';
import {matchingKey,identityToken,matchedPersonId} from './workspace-identity';
import {appendWorkspaceObsidian,type WorkspaceSourceCoverage} from './workspace-obsidian';
import {scoreRelevance} from './relevance-model';
import type {ShareEnv} from './share-routes';
import {normalizeSlice} from './network-share';
import {opaque} from './mail-model';
import {readWorkspace,memberOf,deny} from './workspace-store';
import {supportsIntroduction,workspacePhoto,type WorkspaceSlice,type WorkspaceRelationship} from './workspace-contract';
import {keywordRank,keywordScores,jevScores,topResults} from './network-search';
export interface WorkspaceNode {identityMatchReady?:boolean;sources?:string[];id:string;name:string;company:string;type:'person';photoUrl:string|null;directRelationship:false;combined:null;lastContact:null;viewerScore?:{base:number;delta:number;score:number};relationships:Array<WorkspaceRelationship&{memberId:string;memberName:string}>}
export interface WorkspaceGraph {viewerPrivateContext?:Record<string,import('./workspace-contract').ViewerPrivateContext[]>;introductionSuggestions?:Introduction[];source:'workspace';workspaceId:string;workspaceName:string;revision:number;pushedAt:string;nodes:WorkspaceNode[];edges:Array<{source:string;target:string;weight:number;types:string[];contexts:string[];contributors:string[];evidence:Array<{owner:string;title:string;text:string}>}>;relevance:ReturnType<typeof scoreRelevance>;themes:any[];themeSignals:any[];activity:never[];members:Array<{id:string;name:string;isMe:boolean}>;coverage:{sources:WorkspaceSourceCoverage[];unavailable:string[];truncated:boolean;contributors:number}}
function nameQuality(name:string,email:string){
 const value=name.trim().toLowerCase();
 if(!value||value==='name unavailable'||value.startsWith('someone at '))return 0;
 return value===email.split('@')[0]||value.includes('@')?1:2;
}
function preferName(current:string,candidate:string|undefined,email:string,preferTie=false){
 if(!candidate?.trim())return current;
 const name=candidate.trim().slice(0,120),quality=nameQuality(name,email),existing=nameQuality(current,email);
 return quality>existing||(preferTie&&quality===existing)?name:current;
}
export async function assertWorkspaceRevision(env:ShareEnv,id:string,me:string,revision:number){const current=await readWorkspace(env.DB,id);memberOf(current,me);if(current.revision!==revision)deny(409,'workspace_changed_retry');}
export async function buildWorkspaceGraph(env:ShareEnv,id:string,me:string,attempt=0):Promise<WorkspaceGraph>{
 const w=await readWorkspace(env.DB,id);memberOf(w,me);
 const enabled=w.members.filter(m=>m.contribution.enabled),exports:Array<{member:typeof enabled[number];value:WorkspaceSlice}>=[],unavailable:string[]=[];
 let cursor=0,finished=false;let timer:ReturnType<typeof setTimeout>|undefined;
 const jobs=Promise.all(Array.from({length:Math.min(4,enabled.length)},async()=>{
  while(cursor<enabled.length&&!finished){const member=enabled[cursor++];try{
   const stub=env.MAIL.getByName(member.email);await stub.bindOwner(member.email);const value=await stub.exportWorkspaceSlice(member.contribution.scope,member.contribution.level,member.contribution.shareProfiles===true);
   if(!finished)exports.push({member,value});
  }catch{if(!finished)unavailable.push(member.id);}}
 }));
 await Promise.race([jobs,new Promise<void>(resolve=>{timer=setTimeout(resolve,20000);})]);finished=true;if(timer!==undefined)clearTimeout(timer);
 for(const m of enabled)if(!exports.some(e=>e.member.id===m.id)&&!unavailable.includes(m.id))unavailable.push(m.id);
 exports.sort((a,b)=>a.member.id.localeCompare(b.member.id));
 const personEmails=new Map<string,string>();
 const nodes=new Map<string,WorkspaceNode>(),edges=new Map<string,WorkspaceGraph['edges'][number]>();
 const graph:WorkspaceGraph={source:'workspace',workspaceId:id,workspaceName:w.name,revision:w.revision,pushedAt:new Date().toISOString(),nodes:[],edges:[],relevance:scoreRelevance([],[],'firm',Date.now()),themes:[],themeSignals:[],activity:[],members:w.members.map(m=>({id:m.id,name:m.email,isMe:m.email===me})),coverage:{sources:[],unavailable,truncated:false,contributors:exports.length}};
 const key=await matchingKey(env,id);
 const personId=async(email:string)=>matchedPersonId(env,id,await identityToken(key,email));
 for(const {member,value} of exports){
  const slice=normalizeSlice(value.slice);if(!slice||slice.owner!==member.email){graph.coverage.unavailable.push(member.id);graph.coverage.contributors--;continue;}
  graph.coverage.truncated ||= value.truncated;
  graph.coverage.sources.push({memberId:member.id,memberName:member.email,source:'web',available:value.truncated?null:slice.people.length,included:slice.people.length,status:'ready',limited:value.truncated});
  const ids=new Map<string,string>();
  const ownScores=member.email===me?await env.MAIL.getByName(me).workspacePersonalScores(slice.people.map(p=>p.email)):{};
  for(const person of slice.people){
   const pid=await personId(person.email);if(member.excludedPersonIds?.includes(pid))continue;ids.set(person.email,pid);personEmails.set(person.email,pid);
   let node=nodes.get(pid);if(!node){node={identityMatchReady:true,id:pid,name:person.name,company:person.email.split('@')[1],type:'person',sources:['web'],photoUrl:null,directRelationship:false,combined:null,lastContact:null,relationships:[]};nodes.set(pid,node);}
   node.name=preferName(node.name,person.name,person.email);
   const profile=member.contribution.shareProfiles===true?value.profiles?.[person.email]:undefined;
   if(profile){node.name=preferName(node.name,profile.name,person.email);node.photoUrl ||= workspacePhoto(profile.photoUrl);}
   if(ownScores[person.email])node.viewerScore=ownScores[person.email];
   const r=value.relationships[person.email];const score=r?.score;
   node.relationships.push({memberId:member.id,memberName:member.email,...(r?.activity?{activity:r.activity}:{}),...(r?.calendarActivity?{calendarActivity:r.calendarActivity}:{}),...(member.email===me&&r?.inboxes?{inboxes:r.inboxes}:{}),score:typeof score==='number'&&Number.isFinite(score)?Math.max(0,Math.min(100,score)):null,scoreVersion:r?.scoreVersion||'unknown',lastContact:r?.lastContact||null,observedAt:r?.observedAt||new Date(slice.exportedAt).toISOString(),evidenceCategory:r?.evidenceCategory||'unknown'});
  }
  for(const edge of slice.edges){const a=ids.get(edge.a),b=ids.get(edge.b);if(!a||!b)continue;const key=[a,b].sort().join(':');let existing=edges.get(key);if(!existing){existing={source:a,target:b,weight:0,types:[],contexts:[],contributors:[],evidence:[]};edges.set(key,existing);}existing.weight+=edge.weight;existing.types=[...new Set([...existing.types,...edge.types])];existing.contexts=[...new Set([...existing.contexts,...edge.contexts])].slice(0,3);existing.contributors.push(member.id);existing.evidence.push({owner:member.email,title:edge.types.map(t=>t.replaceAll('_',' ')).join(' · ')||'Recorded connection',text:edge.contexts.join(' · ')||'Co-occurrence recorded; personal relationship unverified.'});}
  const themeIds=new Map<string,string>();
  for(const theme of slice.themes){if(graph.themes.length>=200){graph.coverage.truncated=true;break;}const tid=await opaque('workspace:'+id,'theme:'+member.id+':'+theme.id,env.TOKEN_SECRET);themeIds.set(theme.id,tid);graph.themes.push({id:tid,name:theme.name.slice(0,80),canonicalName:theme.name.slice(0,80),status:'active',aliases:[]});}
  for(const signal of slice.signals){if(signal.email&&!ids.has(signal.email))continue;if(graph.themeSignals.length>=5000){graph.coverage.truncated=true;break;}const tid=themeIds.get(signal.themeId);if(!tid)continue;const sid=await opaque('workspace:'+id,member.id+':signal:'+JSON.stringify([signal.email,signal.themeId,signal.sourceType,signal.observedAt,signal.summary,signal.title||'']),env.TOKEN_SECRET);
   graph.themeSignals.push({id:sid,personId:signal.email?ids.get(signal.email):null,themeId:tid,sourceType:signal.sourceType,visibility:'firm',observedAt:signal.observedAt,ingestedAt:new Date(slice.exportedAt).toISOString(),confidence:signal.confidence,summary:signal.summary,evidenceRef:'workspace:'+member.id+':'+sid,contentHash:sid,extractorVersion:'workspace-v1',modelId:null,...(signal.title?{provenance:{title:signal.title,canonicalUrl:'https://granola.ai/',publisherHost:'granola.ai',observedAt:signal.observedAt,retrievedAt:new Date(slice.exportedAt).toISOString(),timeBasis:'observed'}}:{})});
  }
 }
 // Apply only this viewer's known identities, even if they are not contributing.
 // This response is private/no-store; another member never receives this overlay.
 try {
  const own=env.MAIL.getByName(me);await own.bindOwner(me);
  const profiles=await own.workspaceProfiles([...personEmails.keys()]);
  for(const [email,pid] of personEmails){const profile=profiles[email],node=nodes.get(pid)!;
   if(profile){node.name=preferName(node.name,profile.name,email,true);node.photoUrl=workspacePhoto(profile.photoUrl)||node.photoUrl;}
  }
 }catch{ /* Known shared identities remain available when the private source is offline. */ }
 // Keep viewer evidence outside themeSignals: shared ranking, intros and drafts
 // must never consume it. Only the authenticated viewer's object is queried.
 try {
  const own=env.MAIL.getByName(me);await own.bindOwner(me);
  const context=await own.workspacePrivateContext([...personEmails.keys()]);
  graph.viewerPrivateContext=Object.fromEntries([...personEmails].filter(([email])=>context[email]?.length).map(([email,pid])=>[pid,context[email]]));
 }catch{ /* Shared graph remains usable if the viewer's private source is offline. */ }
 for(const node of nodes.values())if(node.name.startsWith('Someone at '))node.name='Name unavailable';
 graph.nodes=[...nodes.values()];graph.edges=[...edges.values()];
 for(const member of w.members)if(!graph.coverage.sources.some(s=>s.memberId===member.id&&s.source==='web'))graph.coverage.sources.push({memberId:member.id,memberName:member.email,source:'web',available:null,included:0,status:member.contribution.enabled?'unavailable':'not_shared',limited:false});
 await appendWorkspaceObsidian(env,w,me,graph);
 for(const person of graph.nodes)for(const relationship of person.relationships){
  const confirmedAt=w.members.find(m=>m.id===relationship.memberId)?.relationshipConfirmations?.[person.id];
  if(confirmedAt&&Number.isFinite(Date.parse(confirmedAt)))relationship.confirmedAt=confirmedAt;
 }
 // A relationship can arrive from both vault and inbox snapshots. Retain its
 // provenance while drawing one undirected connection between canonical people.
 const joinedEdges=new Map<string,WorkspaceGraph['edges'][number]>();
 for(const edge of graph.edges){if(edge.source===edge.target)continue;const key=[edge.source,edge.target].sort().join(':');const prior=joinedEdges.get(key);
  if(!prior){joinedEdges.set(key,edge);continue;}
  prior.weight=Math.max(prior.weight,edge.weight);prior.types=[...new Set([...prior.types,...edge.types])];prior.contributors=[...new Set([...prior.contributors,...edge.contributors])];prior.contexts=[...new Set([...prior.contexts,...edge.contexts])].slice(0,3);
  prior.evidence=[...new Map([...prior.evidence,...edge.evidence].map(e=>[JSON.stringify(e),e])).values()];
 }
 graph.edges=[...joinedEdges.values()];
 const completed=new Map((await completedIntroductionCounts(env.DB,id)).map(r=>[r.memberId+':'+r.personId,r.count]));
 for(const person of graph.nodes)for(const relationship of person.relationships)relationship.completedIntroductions=completed.get(relationship.memberId+':'+person.id)||0;
 graph.introductionSuggestions=suggestIntroductions(graph);
 graph.relevance=scoreRelevance(graph.themeSignals.map(s=>({...s,owner:id})),[],'firm',Date.now(),graph.themes);
 try{await assertWorkspaceRevision(env,id,me,w.revision);}catch(e){if((e as Error).message==='workspace_changed_retry'&&attempt===0)return buildWorkspaceGraph(env,id,me,1);throw e;}
 return graph;
}
export async function searchWorkspace(env:ShareEnv,id:string,me:string,query:string,onEvent?:(event:Record<string,unknown>)=>Promise<void>){
 const graph=await buildWorkspaceGraph(env,id,me);
 const signalsByPerson=new Map<string,typeof graph.themeSignals>(),contextsByPerson=new Map<string,string[]>();
 for(const signal of graph.themeSignals){if(!signal.personId)continue;const list=signalsByPerson.get(signal.personId)||[];list.push(signal);signalsByPerson.set(signal.personId,list);}
 for(const edge of graph.edges)for(const id of [edge.source,edge.target]){const list=contextsByPerson.get(id)||[];list.push(...edge.contexts);contextsByPerson.set(id,list);}
 const people=graph.nodes.map(n=>{const signals=signalsByPerson.get(n.id)||[],themeIds=new Set(signals.map(s=>s.themeId));return {personId:n.id,name:n.name,company:n.company,lastContact:null,evidence:signals.map(s=>({summary:s.summary,sourceType:s.sourceType,observedAt:s.observedAt,title:s.provenance?.title})),themes:graph.themes.filter(t=>themeIds.has(t.id)).map(t=>t.name),contexts:contextsByPerson.get(n.id)||[]};});
 const emit=async(event:Record<string,unknown>)=>{if(onEvent){await assertWorkspaceRevision(env,id,me,graph.revision);await onEvent({...event,revision:graph.revision});}};
 await emit({type:'start',label:'Shared network loaded',people:graph.nodes.length,unavailable:graph.coverage.unavailable.length});
 if(onEvent)for(const member of graph.members){
  const memberPeople=new Set(graph.nodes.filter(n=>n.relationships.some(r=>r.memberId===member.id)).map(n=>n.id)),memberContexts=new Map<string,string[]>();
  for(const edge of graph.edges)if(edge.contributors.includes(member.id))for(const personId of [edge.source,edge.target]){const values=memberContexts.get(personId)||[];values.push(...edge.evidence.filter(v=>v.owner===member.name).map(v=>v.text));memberContexts.set(personId,values);}
  const scoped=people.filter(p=>memberPeople.has(p.personId)).map(p=>{
   const signals=(signalsByPerson.get(p.personId)||[]).filter(s=>String(s.evidenceRef).startsWith('workspace:'+member.id+':')),themeIds=new Set(signals.map(s=>s.themeId));
   const contexts=memberContexts.get(p.personId)||[];
   return {...p,evidence:signals.map(s=>({summary:s.summary,sourceType:s.sourceType,observedAt:s.observedAt,title:s.provenance?.title})),themes:graph.themes.filter(t=>themeIds.has(t.id)).map(t=>t.name),contexts};
  });
  const matches=keywordRank(query,scoped).filter(p=>p.hits>0);
  await emit({type:'scope',memberId:member.id,label:member.name,people:scoped.length,matches:matches.length});
  for(const candidate of matches.slice(0,3))await emit({type:'candidate',memberId:member.id,personId:candidate.personId,label:member.name,reason:candidate.evidence.length?'Found a keyword match in the shared profile or context.':'Found a profile or recorded-edge keyword match; no person-linked notes shared.',evidence:candidate.evidence.slice(0,2)});
 }
 const ranked=keywordRank(query,people);let scores=keywordScores(ranked),checked=false;
 await emit({type:'ranking',label:env.TYPESAFE_API_KEY?'Checking candidate relevance with Jev':'Ranking keyword matches',candidates:ranked.length});
 if(env.TYPESAFE_API_KEY&&ranked.length){try{scores=await jevScores(env,query,ranked,AbortSignal.timeout(20000));checked=true;}catch{}}
 await assertWorkspaceRevision(env,id,me,graph.revision);const results=topResults(query,ranked,scores,{checked});
 for(const card of buildAnswerCards(graph,results).slice(0,5))await emit({type:'relationship',personId:card.personId,label:'Relationship check',reason:card.routes.length?'Found '+card.routes.length+' contributor route(s); inspect the evidence before requesting an introduction.':'No other contributor introduction route is supported in the shared data.',routes:card.routes});
 return {query,results,cards:buildAnswerCards(graph,results),workspaceId:id,revision:graph.revision,checked,coverage:graph.coverage};
}
export async function draftWorkspace(env:ShareEnv,id:string,me:string,personId:string,memberId:string){
 const graph=await buildWorkspaceGraph(env,id,me),person=graph.nodes.find(n=>n.id===personId),member=graph.members.find(m=>m.id===memberId);
 if(!person||!member||!person.relationships.some(r=>r.memberId===memberId&&supportsIntroduction(r)))return deny(404,'introduction_unavailable');
 await assertWorkspaceRevision(env,id,me,graph.revision);
 return {to:member.name,subject:'Introduction to '+person.name,body:`Hi ${member.name.split('@')[0]},\n\nI saw your shared connection to ${person.name} in ${graph.workspaceName}. Would you feel comfortable introducing us? I'd be happy to share a short note about why I'd like to connect.\n\nThank you!`,introVia:member.name,basedOn:[]};
}
