import {opaque} from './mail-model';
import {normalizePushedGraph} from './relevance-routes';
import {workspacePhoto} from './workspace-contract';
import type {ShareEnv} from './share-routes';
import type {Workspace} from './workspace-store';
import type {WorkspaceGraph} from './workspace-graph';
export interface WorkspaceSourceCoverage {memberId:string;memberName:string;source:'web'|'obsidian';available:number|null;included:number;status:'ready'|'not_shared'|'not_uploaded'|'unavailable'|'scope_excluded';limited:boolean;vaultTotal?:number|null;updatedAt?:string|null}
/** Legacy vault IDs are salted locally. Namespace them; never guess identity from a name. */
export async function appendWorkspaceObsidian(env:ShareEnv,w:Workspace,me:string,graph:WorkspaceGraph){
 for(const member of w.members){
  const coverage:WorkspaceSourceCoverage={memberId:member.id,memberName:member.email,source:'obsidian',available:null,included:0,status:'not_shared',limited:false};graph.coverage.sources.push(coverage);
  if(!member.contribution.enabled||!member.contribution.includeObsidian)continue;
  if(member.contribution.scope.kind==='folders'){coverage.status='scope_excluded';continue;}
  try{
   const row=await env.DB.prepare('SELECT json, updated_at FROM graphs WHERE email = ?').bind(member.email).first<{json:string;updated_at:number}>();
   if(!row){coverage.status='not_uploaded';continue;}
   const snapshot=normalizePushedGraph(JSON.parse(row.json));if(!snapshot)throw Error('invalid_graph');
   const people=(snapshot.nodes as Array<Record<string,any>>).filter(n=>n.type!=='company'&&n.directRelationship!==false&&!n.via?.length);
   coverage.available=people.length;coverage.status='ready';coverage.updatedAt=new Date(row.updated_at*1000).toISOString();
   const pushedCoverage=snapshot.coverage as {totalContacts?:number}|undefined;
   coverage.vaultTotal=Number.isSafeInteger(pushedCoverage?.totalContacts)?pushedCoverage!.totalContacts!:null;
   const scope=member.contribution.scope;
   const selected=scope.kind==='people'?new Set('personIds' in scope?scope.personIds:[]):null;
   const chosen=people.filter(n=>!selected||selected.has('obsidian:'+n.id)).slice(0,Math.max(0,10000-graph.nodes.length));
   coverage.limited=chosen.length<people.filter(n=>!selected||selected.has('obsidian:'+n.id)).length||(coverage.vaultTotal!==null&&coverage.vaultTotal>people.length);
   graph.coverage.truncated ||= coverage.limited;
   const ids=new Map<string,string>();
   for(const n of chosen){
    if(ids.has(n.id))continue;
    const id=await opaque('workspace:'+w.id,'obsidian:'+member.id+':'+n.id,env.TOKEN_SECRET);ids.set(n.id,id);
    const name=typeof n.name==='string'?n.name.trim().slice(0,120):'';
    graph.nodes.push({id,name:name?(name.includes('@')?(member.email===me||member.contribution.shareProfiles?name.split('@')[0]:'Name unavailable'):name):'Name unavailable',company:typeof n.company==='string'?n.company.slice(0,120):'',type:'person',photoUrl:member.email===me||member.contribution.shareProfiles?workspacePhoto(n.photoUrl):null,directRelationship:false,combined:null,lastContact:null,sources:['obsidian'],relationships:[{memberId:member.id,memberName:member.email,score:null,scoreVersion:'obsidian-unmeasured',lastContact:typeof n.lastContact==='string'&&Number.isFinite(Date.parse(n.lastContact))?n.lastContact:null,observedAt:coverage.updatedAt,evidenceCategory:'unknown'}]});
   }
   coverage.included=ids.size;
   if(member.contribution.level!=='names'){
    const themeIds=new Map<string,string>();
    const permitted=snapshot.themeSignals.filter(s=>ids.has(s.personId!)&&['obsidian_note','granola'].includes(s.sourceType));
    for(const theme of snapshot.themes){
     if(!permitted.some(s=>s.themeId===theme.id))continue;
     if(graph.themes.length>=200){graph.coverage.truncated=true;break;}
     const id=await opaque('workspace:'+w.id,'obsidian-theme:'+member.id+':'+theme.id,env.TOKEN_SECRET);themeIds.set(theme.id,id);
     graph.themes.push({id,name:theme.canonicalName,canonicalName:theme.canonicalName,status:'active',aliases:[]});
    }
    for(const signal of permitted){
     const themeId=themeIds.get(signal.themeId);if(!themeId)continue;
     if(graph.themeSignals.length>=5000){graph.coverage.truncated=true;break;}
     const id=await opaque('workspace:'+w.id,'obsidian-signal:'+member.id+':'+signal.id,env.TOKEN_SECRET);
     const theme=graph.themes.find(t=>t.id===themeId);
     graph.themeSignals.push({id,personId:ids.get(signal.personId!),themeId,sourceType:signal.sourceType,visibility:'firm',observedAt:signal.observedAt,ingestedAt:signal.ingestedAt,confidence:signal.confidence,summary:member.contribution.level==='statements'?signal.summary:'Recorded topic: '+theme.name,evidenceRef:'workspace:'+member.id+':'+id,contentHash:id,extractorVersion:'workspace-v1',modelId:null});
    }
   }
   // Snapshot scores can contain private feedback, and contexts can contain email subjects.
   // Only the explicitly selected people and their recorded ties leave the owner's snapshot.
   for(const e of snapshot.edges as Array<Record<string,any>>){
    const source=ids.get(e.source),target=ids.get(e.target);if(!source||!target||source===target)continue;
    if(graph.edges.length>=30000){coverage.limited=true;graph.coverage.truncated=true;break;}
    graph.edges.push({source,target,weight:1,types:['obsidian'],contexts:[],contributors:[member.id],evidence:[{owner:member.email,title:'Obsidian connection',text:'Recorded in the shared vault snapshot; relationship strength is not measured here.'}]});
   }
  }catch{coverage.status='unavailable';}
 }
}
