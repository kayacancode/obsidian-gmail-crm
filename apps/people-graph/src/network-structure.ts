/**
 * The shape of the owner's network: deterministic clusters from shared threads and meetings,
 * the owner's usual circles, and how far anyone sits from them. Owner-only; never exported.
 */
export interface StructureNode {id:string;name:string;company:string;strength:number;combined:number;baseCombined?:number;lastContact:string|null;directRelationship:boolean;via?:string[]}
export interface StructureEdge {source:string|undefined;target:string|undefined;weight:number;types:string[]}
export interface StructureEvent {kind:string;at:string;personIds:string[];acceptedPersonIds?:string[];title?:string}
export interface StructureSignal {personId?:string;themeId:string;summary:string;observedAt:string;sourceType?:string}
export interface StructureInput {nodes:StructureNode[];edges:StructureEdge[];activity:StructureEvent[];themeSignals:StructureSignal[];themes:{id:string;name:string}[]}
export interface ClusterLabel {companies:string[];themes:string[]}
export interface Cluster {id:string;members:string[];label:ClusterLabel}
export interface Clusters {byNode:Record<string,string|null>;clusters:Cluster[]}
export interface Distance {value:0|0.5|1;cluster:ClusterLabel|null;reason:string}

const DAY=86_400_000;
const OWN_EDGE:Record<string,true>={shared_email:true,shared_meeting:true};

/** Edges from the owner's own threads and meetings between two of the owner's own contacts. */
function ownEdges(input:StructureInput):{a:string;b:string;weight:number}[]{
 const own=new Set(input.nodes.filter(n=>n.directRelationship).map(n=>n.id));
 return input.edges.flatMap(e=>e.source&&e.target&&e.source!==e.target&&own.has(e.source)&&own.has(e.target)&&e.types.some(t=>OWN_EDGE[t])?[{a:e.source,b:e.target,weight:e.weight}]:[]);
}

const top=(values:string[],n:number)=>{
 const counts=new Map<string,number>();for(const v of values)if(v)counts.set(v,(counts.get(v)??0)+1);
 return [...counts].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0])).slice(0,n).map(([v])=>v);
};

async function clusterId(members:string[]){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode([...members].sort().join('\n')));
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,12);
}

/** Weighted label propagation: sorted visiting order, ties to the smallest label, at most 20 passes. */
export async function clusterNetwork(input:StructureInput,now=Date.now()):Promise<Clusters>{
 const ids=input.nodes.filter(n=>n.directRelationship).map(n=>n.id).sort();
 const neighbours=new Map<string,Map<string,number>>(ids.map(id=>[id,new Map()]));
 for(const {a,b,weight} of ownEdges(input)){
  neighbours.get(a)!.set(b,(neighbours.get(a)!.get(b)??0)+weight);
  neighbours.get(b)!.set(a,(neighbours.get(b)!.get(a)??0)+weight);
 }
 const label=new Map(ids.map(id=>[id,id]));
 for(let pass=0;pass<20;pass++){
  let changed=false;
  for(const id of ids){
   const weights=new Map<string,number>();
   for(const [other,w] of neighbours.get(id)!)weights.set(label.get(other)!,(weights.get(label.get(other)!)??0)+w);
   if(!weights.size)continue;
   const best=[...weights].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0]))[0][0];
   if(best!==label.get(id)){label.set(id,best);changed=true;}
  }
  if(!changed)break;
 }
 const groups=new Map<string,string[]>();
 for(const id of ids)groups.set(label.get(id)!,[...(groups.get(label.get(id)!)??[]),id]);
 const nodes=new Map(input.nodes.map(n=>[n.id,n])),themeName=new Map(input.themes.map(t=>[t.id,t.name]));
 const byNode:Record<string,string|null>=Object.fromEntries(ids.map(id=>[id,null]));
 const clusters:Cluster[]=[];
 for(const members of groups.values()){
  if(members.length<3)continue;
  const id=await clusterId(members),inCluster=new Set(members);
  const themes=input.themeSignals.filter(s=>s.personId&&inCluster.has(s.personId)&&Date.parse(s.observedAt)>=now-180*DAY).map(s=>themeName.get(s.themeId)??'');
  clusters.push({id,members,label:{companies:top(members.map(m=>nodes.get(m)?.company??''),2),themes:top(themes,2)}});
  for(const m of members)byNode[m]=id;
 }
 clusters.sort((x,y)=>x.id.localeCompare(y.id));
 return {byNode,clusters};
}

/** Interactions per person in the last `days`: mail and meetings always, calendar only when they accepted. */
export function interactions(events:StructureEvent[],now:number,days:number):Record<string,number>{
 const counts:Record<string,number>={};
 for(const e of events){
  const t=Date.parse(e.at);if(!(t<=now&&t>=now-days*DAY))continue;
  for(const id of e.kind==='calendar'?e.acceptedPersonIds??[]:e.personIds)counts[id]=(counts[id]??0)+1;
 }
 return counts;
}

/** The fewest clusters, largest share first, that together hold at least 60% of the interactions. */
export function usualCircles(clusters:Clusters,counts:Record<string,number>):Set<string>{
 const total=Object.values(counts).reduce((s,n)=>s+n,0),usual=new Set<string>();
 if(!total)return usual;
 const shares=clusters.clusters.map(c=>({id:c.id,n:c.members.reduce((s,m)=>s+(counts[m]??0),0)})).sort((x,y)=>y.n-x.n||x.id.localeCompare(y.id));
 let covered=0;
 for(const share of shares){if(covered/total>=0.6||!share.n)break;usual.add(share.id);covered+=share.n;}
 return usual;
}

export interface StructureContext {clusters:Clusters;usual:Set<string>;adjacency:Map<string,Set<string>>;closest:Set<string>;sharedOnly:Set<string>;labels:Map<string,ClusterLabel>;counts90:Record<string,number>}

export function structureContext(input:StructureInput,clusters:Clusters,now:number):StructureContext{
 const counts90=interactions(input.activity,now,90),adjacency=new Map<string,Set<string>>();
 for(const {a,b} of ownEdges(input)){adjacency.set(a,(adjacency.get(a)??new Set()).add(b));adjacency.set(b,(adjacency.get(b)??new Set()).add(a));}
 const closest=new Set(Object.entries(counts90).sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0])).slice(0,10).map(([id])=>id));
 return {clusters,usual:usualCircles(clusters,counts90),adjacency,closest,counts90,
  sharedOnly:new Set(input.nodes.filter(n=>!n.directRelationship&&n.via?.length).map(n=>n.id)),
  labels:new Map(clusters.clusters.map(c=>[c.id,c.label]))};
}

const describe=(label:ClusterLabel)=>[...label.companies,...label.themes].join(', ')||'an unnamed group';

/** How far a person sits from the owner's usual circles, with a reason the owner can read. */
export function distanceOf(id:string,ctx:StructureContext):Distance{
 if(ctx.sharedOnly.has(id))return {value:1,cluster:null,reason:'Reachable only through a shared network'};
 const cluster=ctx.clusters.byNode[id]??null,label=cluster?ctx.labels.get(cluster)??null:null;
 const ties=[...(ctx.adjacency.get(id)??[])];
 if(cluster&&label){
  if(!ctx.usual.has(cluster))return {value:1,cluster:label,reason:`Outside your usual circles: part of ${describe(label)}`};
  return ties.some(other=>other!==id&&ctx.closest.has(other))
   ?{value:0,cluster:label,reason:`In your usual circles (${describe(label)})`}
   :{value:0.5,cluster:label,reason:`In a usual circle (${describe(label)}), but not close to the people you talk to most`};
 }
 const intoUsual=ties.filter(other=>{const c=ctx.clusters.byNode[other];return c?ctx.usual.has(c):false;});
 return intoUsual.length
  ?{value:0.5,cluster:null,reason:'Not part of a group, with ties into your usual circles'}
  :{value:1,cluster:null,reason:'Outside your usual circles: no shared threads or meetings with them'};
}

export type TriggerKind='meeting_soon'|'owes_reply'|'fresh_signal'|'job_move'|'going_cold'|'topic_overlap';
export interface WhyNowSignal {personId:string;category:string;tier:string;summary:string;observedAt:string;source:string}
export interface WhyNowStint {id:string;personId:string;company:string;domain:string;from:string;to:string|null;source:'email_domain'|'owner'}
export interface WhyNowContext {
 now:number;lens:{focus:string;needs:string};signals:WhyNowSignal[];stints:WhyNowStint[];
 jobMoves:{name:string;people:{personId:string;domain:string;lastContact:string}[]}[];
 /** Latest message from them (`lastIn`) and from the owner to them (`lastOut`), epoch ms. */
 mail:Record<string,{lastIn:number|null;lastOut:number|null}>;
 /** Suppressed, snoozed or not-yet people: judgment only removes. */
 excluded:Set<string>;
}
export interface WhyEntry {kind:'trigger';trigger:TriggerKind;summary:string;source:string;observedAt:string;attribution:'first_hand'}
export interface WhyNowAnswer {personId:string;name:string;score:number;when:{lastContact:string|null};why:WhyEntry[]}

const WEIGHT:Record<TriggerKind,number>={meeting_soon:3,owes_reply:2,fresh_signal:2,job_move:2,going_cold:1.5,topic_overlap:1.5};
const SHAREABLE_TIER:Record<string,true>={open:true,personal:true};
const day=(ms:number)=>new Date(ms).toISOString().slice(0,10);

/** Lowercase words of four or more letters: enough to match a focus without a model. */
export function keywords(text:string):Set<string>{
 return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)??[]);
}

/** People with a reason to be contacted now, each reason dated and sourced. */
export function whyNow(input:StructureInput,ctx:WhyNowContext,limit=10):{answers:WhyNowAnswer[];gaps:string[]}{
 const {now}=ctx,why=new Map<string,WhyEntry[]>();
 const add=(id:string,trigger:TriggerKind,summary:string,source:string,observedAt:string)=>why.set(id,[...(why.get(id)??[]),{kind:'trigger',trigger,summary,source,observedAt,attribution:'first_hand'}]);
 const people=new Map(input.nodes.filter(n=>n.directRelationship&&!ctx.excluded.has(n.id)).map(n=>[n.id,n]));
 for(const e of input.activity){
  const t=Date.parse(e.at);
  if(e.kind!=='calendar'||!(t>now&&t<=now+2*DAY))continue;
  for(const id of e.personIds)if(people.has(id))add(id,'meeting_soon',`Meeting${e.title?` "${e.title}"`:''} on ${day(t)}`,'calendar',e.at);
 }
 for(const [id,mail] of Object.entries(ctx.mail)){
  if(!people.has(id)||mail.lastIn===null||mail.lastIn<now-21*DAY||mail.lastIn<=(mail.lastOut??0))continue;
  add(id,'owes_reply',`They wrote last, on ${day(mail.lastIn)}; no reply from you since`,'gmail',new Date(mail.lastIn).toISOString());
 }
 for(const s of ctx.signals){
  // Sensitive signals never rank anyone.
  if(!people.has(s.personId)||!SHAREABLE_TIER[s.tier]||Date.parse(s.observedAt)<now-14*DAY)continue;
  add(s.personId,'fresh_signal',s.summary,s.source,s.observedAt);
 }
 const recentMonth=new Date(now-60*DAY).toISOString().slice(0,7),stintsBy=new Map<string,WhyNowStint[]>();
 for(const s of ctx.stints)stintsBy.set(s.personId,[...(stintsBy.get(s.personId)??[]),s]);
 for(const [id,stints] of stintsBy){
  const latest=[...stints].sort((a,b)=>b.from.localeCompare(a.from))[0];
  if(people.has(id)&&stints.length>1&&latest.from>=recentMonth)add(id,'job_move',`Now at ${latest.company} since ${latest.from}`,latest.source,latest.from+'-01T00:00:00.000Z');
 }
 for(const move of ctx.jobMoves){
  const newest=move.people[0];
  if(newest&&people.has(newest.personId)&&Date.parse(newest.lastContact)>=now-60*DAY&&!why.get(newest.personId)?.some(w=>w.trigger==='job_move'))
   add(newest.personId,'job_move',`Same name now writing from ${newest.domain}`,'gmail',newest.lastContact);
 }
 for(const n of people.values()){
  if(!n.lastContact||n.strength<50)continue;
  const days=Math.floor((now-Date.parse(n.lastContact))/DAY);
  if(days>=75&&days<=130)add(n.id,'going_cold',`${days} days since you last spoke; a strong relationship going quiet`,'gmail',n.lastContact);
 }
 const focus=keywords(`${ctx.lens.focus} ${ctx.lens.needs}`);
 if(focus.size)for(const s of input.themeSignals){
  if(!s.personId||!people.has(s.personId)||Date.parse(s.observedAt)<now-30*DAY||why.get(s.personId)?.some(w=>w.trigger==='topic_overlap'))continue;
  if([...keywords(s.summary)].some(word=>focus.has(word)))add(s.personId,'topic_overlap',`Recently on something you are focused on: ${s.summary.slice(0,160)}`,s.sourceType??'gmail',s.observedAt);
 }
 const answers=[...why].map(([id,entries])=>{
  const n=people.get(id)!;
  const score=Math.round(entries.reduce((sum,w)=>sum+WEIGHT[w.trigger],0)*(0.5+n.strength/200)*100)/100;
  return {personId:id,name:n.name,score,when:{lastContact:n.lastContact},why:entries};
 }).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,limit);
 return {answers,gaps:answers.length?[]:['Nothing time-sensitive right now; `reconnect` lists people going quiet']};
}
