import type {WorkspaceGraph} from './workspace-graph';
/** Viewer-owned identity decisions never change contributors' stored records. */
export function mergeWorkspacePeople(graph:WorkspaceGraph,merges:Record<string,string>):WorkspaceGraph{
 const nodes=new Map(graph.nodes.map(n=>[n.id,n])),applied=new Map<string,string>();
 for(const [source,target] of Object.entries(merges)){
  const from=nodes.get(source),to=nodes.get(target);
  if(!from||!to||source===target||merges[target]||from.identityMatchReady===false||to.identityMatchReady===false)continue;
  to.mergedProfiles=[...(to.mergedProfiles||[]),{id:from.id,name:from.name,company:from.company}];
  to.photoUrl ||= from.photoUrl;to.sources=[...new Set([...(to.sources||[]),...(from.sources||[])])];
  // Counts can describe overlapping mailboxes. Keep dated source measurements, never sum them.
  const relationships=new Map(to.relationships.map(r=>[r.memberId,r]));
  for(const r of from.relationships){const prior=relationships.get(r.memberId);if(!prior||Date.parse(r.lastContact||'')>Date.parse(prior.lastContact||'')||(!prior.lastContact&&r.lastContact))relationships.set(r.memberId,r);}
  to.relationships=[...relationships.values()];
  if(graph.viewerPrivateContext?.[source]){graph.viewerPrivateContext[target]=[...(graph.viewerPrivateContext[target]||[]),...graph.viewerPrivateContext[source]];delete graph.viewerPrivateContext[source];}
  applied.set(source,target);nodes.delete(source);
 }
 graph.nodes=[...nodes.values()];
 for(const signal of graph.themeSignals)signal.personId=applied.get(signal.personId)||signal.personId;
 const edges=new Map<string,WorkspaceGraph['edges'][number]>();
 for(const edge of graph.edges){edge.source=applied.get(edge.source)||edge.source;edge.target=applied.get(edge.target)||edge.target;if(edge.source===edge.target)continue;const key=[edge.source,edge.target].sort().join(':');const prior=edges.get(key);if(!prior){edges.set(key,edge);continue;}prior.weight=Math.max(prior.weight,edge.weight);for(const field of ['types','contexts','contributors'] as const)prior[field]=[...new Set([...prior[field],...edge[field]])];prior.evidence=[...prior.evidence,...edge.evidence];}
 graph.edges=[...edges.values()];return graph;
}
