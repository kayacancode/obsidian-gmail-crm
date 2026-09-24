import type {WorkspaceGraph} from './workspace-graph';
import type {SearchResult} from './network-search';
export interface AnswerEvidence {ref:string;summary:string;date:string;sourceType:string;title:string}
export interface AnswerCard {personId:string;novelty:'recorded_contact'|'no_recorded_direct_contact';evidence:AnswerEvidence[];routes:Array<{memberId:string;memberName:string;basis:'recorded_contact';score:number|null}>}
export function personEvidence(graph:WorkspaceGraph,personId:string):AnswerEvidence[]{
 return graph.themeSignals.filter(s=>s.personId===personId&&s.id&&typeof s.summary==='string'&&s.summary.trim()&&Number.isFinite(Date.parse(s.observedAt))).map(s=>({ref:String(s.id),summary:s.summary,date:s.observedAt,sourceType:String(s.sourceType||'shared_context'),title:String(s.provenance?.title||'')})).slice(0,20);
}
export function buildAnswerCards(graph:WorkspaceGraph,results:Pick<SearchResult,'personId'>[]):AnswerCard[]{
 const people=new Map(graph.nodes.map(n=>[n.id,n])),members=new Map(graph.members.map(m=>[m.id,m]));
 const self=graph.members.find(m=>m.isMe)?.id;
 return results.flatMap(result=>{const p=people.get(result.personId);if(!p)return [];
  const ready=!p.sources?.includes('obsidian')||p.identityMatchReady===true;
  return [{personId:p.id,novelty:p.relationships.some(r=>r.memberId===self)?'recorded_contact' as const:'no_recorded_direct_contact' as const,
   evidence:personEvidence(graph,p.id),routes:ready?p.relationships.filter(r=>r.memberId!==self&&members.has(r.memberId)).map(r=>({memberId:r.memberId,memberName:members.get(r.memberId)!.name,basis:'recorded_contact' as const,score:Number.isFinite(r.score)?r.score:null})):[]}];
 });
}
