import {scoreConnectors,type ConnectorScore} from './relevance-model';
/** Owner-only identity decisions. Source records remain intact so deleting a decision restores them. */
export class PersonMergeStore {
 constructor(private storage:DurableObjectStorage){storage.sql.exec('CREATE TABLE IF NOT EXISTS person_merges (source_id TEXT PRIMARY KEY,target_id TEXT NOT NULL)');}
 get():Record<string,string>{return Object.fromEntries(this.storage.sql.exec<{source_id:string;target_id:string}>('SELECT source_id,target_id FROM person_merges ORDER BY source_id').toArray().map(r=>[r.source_id,r.target_id]));}
 set(source:string,target:string){
  const merges=this.get();
  // Keep a flat alias set. Refusing chains also prevents cycles and ambiguous undo behavior.
  if(merges[target]||Object.values(merges).includes(source)||merges[source]&&merges[source]!==target)throw Error('merge_conflict');
  if(!merges[source]&&Object.keys(merges).length>=500)throw Error('merge_limit');
  this.storage.sql.exec('INSERT INTO person_merges(source_id,target_id) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET target_id=excluded.target_id',source,target);
  return this.get();
 }
 delete(source:string){this.storage.sql.exec('DELETE FROM person_merges WHERE source_id=?',source);return this.get();}
}

type MergeNode={id:string;name:string;company:string;photoUrl:string|null;lastContact:string|null;directRelationship:boolean;pointPersonId?:string|null;notBefore?:string|null;mergedProfiles?:Array<{id:string;name:string;company:string}>};
type MergeEvidence={id?:string;sourcePersonId?:string;targetPersonId?:string;introducerPersonId?:string;provenance?:{introducerPersonId?:string}};
type MergeEdge={source:string|undefined;target:string|undefined;weight:number;types:string[];contexts:string[];kind?:string;evidence?:MergeEvidence[]};
type MergeFeedback={action:'boost'|'suppress'|'snooze';at:number;until:number;delta:number};
/** Standalone relevance reads must use the same canonical identities as the graph. */
export function projectRelevancePeople<T extends {themes:Array<{nodeIds:string[];nodeScores?:Record<string,number>}>;connectors:ConnectorScore[];discoveries:unknown[]}>(snapshot:T,aliases:Record<string,string>,validIds:Set<string>):T{
 const canonical=(id:string)=>aliases[id]||id;
 for(const theme of snapshot.themes){
  theme.nodeIds=[...new Set(theme.nodeIds.map(canonical).filter(id=>validIds.has(id)))];
  if(theme.nodeScores){const scores:Record<string,number>={};for(const [id,score] of Object.entries(theme.nodeScores)){const target=canonical(id);if(validIds.has(target))scores[target]=Math.max(scores[target]??0,score);}theme.nodeScores=scores;}
 }
 // A snapshot has no topology with which to recalculate contracted paths or degree.
 // Mail snapshots have no documented discoveries; never retain stale derived claims.
 if(Object.keys(aliases).length){snapshot.connectors=[];snapshot.discoveries=[];}
 else snapshot.connectors=snapshot.connectors.filter(c=>validIds.has(c.nodeId));
 return snapshot;
}
/** Project only the private graph. This helper must never be used for contributor exports. */
export function projectPersonMerges<T extends {nodes:MergeNode[];edges:MergeEdge[];themeSignals:Array<{personId?:string|null}>;activity:Array<{personIds:string[];acceptedPersonIds?:string[]}>;relevance?:{themes:Array<{nodeIds:string[];nodeScores?:Record<string,number>}>;connectors?:ConnectorScore[];discoveries?:unknown[]};connectors?:ConnectorScore[];personFeedback?:Record<string,MergeFeedback>}>(graph:T,decisions:Record<string,string>):T&{personAliases:Record<string,string>}{
 const nodes=new Map(graph.nodes.map(n=>[n.id,n])),personAliases:Record<string,string>={};
 for(const [source,target] of Object.entries(decisions)){
  const from=nodes.get(source),to=nodes.get(target);if(!from||!to||source===target||decisions[target])continue;
  to.mergedProfiles=[...(to.mergedProfiles||[]),{id:from.id,name:from.name,company:from.company}];
  to.photoUrl ||= from.photoUrl;to.directRelationship ||= from.directRelationship;
  if(from.lastContact&&(!to.lastContact||Date.parse(from.lastContact)>Date.parse(to.lastContact)))to.lastContact=from.lastContact;
  if(from.notBefore&&(!to.notBefore||from.notBefore>to.notBefore))to.notBefore=from.notBefore;
  // Scores/activity can overlap across addresses. Retain the chosen target's measurements.
  personAliases[source]=target;nodes.delete(source);
 }
 const canonical=(id:string)=>personAliases[id]||id;
 if(graph.personFeedback){
  const feedback:Record<string,MergeFeedback>={},now=Date.now();
  const rank=(value:MergeFeedback)=>value.action==='suppress'?2:value.action==='snooze'&&value.until>now?1:0;
  // An identity decision cannot undo a do-not-contact decision. Preserve the strongest
  // source exclusion until that source preference is cleared or the merge is undone.
  for(const [id,value] of Object.entries(graph.personFeedback)){
   const target=canonical(id),prior=feedback[target];
   if(!prior||rank(value)>rank(prior)||rank(value)===rank(prior)&&(rank(value)===1?value.until>prior.until||value.until===prior.until&&value.at>prior.at:value.at>prior.at))feedback[target]={...value};
  }
  graph.personFeedback=feedback;
 }
 graph.nodes=[...nodes.values()];
 const edges=new Map<string,T['edges'][number]>();
 for(const edge of graph.edges){
  if(!edge.source||!edge.target)continue;
  edge.source=canonical(edge.source);edge.target=canonical(edge.target);if(edge.source===edge.target)continue;
  // Types can describe an introduction while still establishing only co-occurrence.
  // A coincident pair is personal only when every source explicitly says so.
  edge.kind=edge.kind==='personal'?'personal':'cooccurrence';
  for(const evidence of edge.evidence||[]){
   for(const key of ['sourcePersonId','targetPersonId','introducerPersonId'] as const)if(evidence[key])evidence[key]=canonical(evidence[key]);
   if(evidence.provenance?.introducerPersonId)evidence.provenance.introducerPersonId=canonical(evidence.provenance.introducerPersonId);
  }
  const key=[edge.source,edge.target].sort().join('\0'),prior=edges.get(key);
  if(!prior){edges.set(key,edge);continue;}
  prior.weight=Math.max(prior.weight,edge.weight);prior.types=[...new Set([...prior.types,...edge.types])];prior.contexts=[...new Set([...prior.contexts,...edge.contexts])].slice(0,3);
  if(prior.kind!=='personal'||edge.kind!=='personal')prior.kind='cooccurrence';
  if(prior.evidence||edge.evidence)prior.evidence=[...new Map([...(prior.evidence||[]),...(edge.evidence||[])].map(e=>[e.id||JSON.stringify(e),e])).values()];
 }
 graph.edges=[...edges.values()];
 for(const signal of graph.themeSignals)if(signal.personId)signal.personId=canonical(signal.personId);
 for(const node of graph.nodes)if(node.pointPersonId)node.pointPersonId=canonical(node.pointPersonId);
 for(const theme of graph.relevance?.themes||[]){
  theme.nodeIds=[...new Set(theme.nodeIds.map(canonical))];
  if(theme.nodeScores){const scores:Record<string,number>={};for(const [id,score] of Object.entries(theme.nodeScores)){const target=canonical(id);if(nodes.has(target))scores[target]=Math.max(scores[target]??0,score);}theme.nodeScores=scores;}
 }
 if(Object.keys(personAliases).length&&(graph.connectors||graph.relevance?.connectors)){
  // These scores describe the previous topology. Recompute after contracting aliases;
  // private mail/meeting edges are inferred and cannot become documented bridges.
  const edges=graph.edges.map((edge,index)=>({id:'merged-'+index,source:edge.source!,target:edge.target!,kind:'cooccurrence'}));
  const connectors=[...scoreConnectors(graph.nodes,edges).values()].sort((a,b)=>b.score-a.score||a.nodeId.localeCompare(b.nodeId));
  graph.connectors=connectors;
  if(graph.relevance){graph.relevance.connectors=connectors;if(graph.relevance.discoveries)graph.relevance.discoveries=[];}
 }
 for(const event of graph.activity){event.personIds=[...new Set(event.personIds.map(canonical))];if(event.acceptedPersonIds)event.acceptedPersonIds=[...new Set(event.acceptedPersonIds.map(canonical))];}
 return Object.assign(graph,{personAliases});
}
