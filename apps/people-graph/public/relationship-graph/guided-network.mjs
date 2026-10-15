import {supportsIntroduction,scoreBacked} from './relationship-support.mjs';
// These prompts use only the graph already authorized for this viewer.
const permitted=n=>n&&n.type!=='company'&&n.permission!=='denied'&&n.permission!=='conflicted'&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved';
export function networkStarts(graph,now=Date.now()){
 const nodes=new Map(graph.nodes.filter(permitted).map(n=>[n.id,n])),items=[],used=new Set();
 const add=item=>{if(nodes.has(item.personId)&&!used.has(item.personId)){items.push(item);used.add(item.personId);}};
 const signals=(graph.themeSignals||[]).filter(s=>nodes.has(s.personId)&&['granola','obsidian_note','gmail_body_derived'].includes(s.sourceType)&&Date.parse(s.observedAt)<=now&&Date.parse(s.observedAt)>=now-30*86400000).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
 for(const s of signals){
  if(/\b(resolved|completed|cancelled|already sent|no longer)\b/i.test(s.summary||''))continue;
  const follow=/\b(promised|committed to|will send|will share|follow[ -]?up|need to send)\b/i.test(s.summary||'');
  if(!follow&&!/\?|\b(awaiting|unanswered)\b/i.test(s.summary||''))continue;
  const member=graph.members?.find(m=>String(s.evidenceRef||'').startsWith('workspace:'+m.id+':'));
  add({personId:s.personId,title:follow?'Possible follow-up':'A question to explore',reason:s.summary,source:[s.sourceType==='granola'?'Meeting notes':s.sourceType==='obsidian_note'?'Note mention':'Email context',s.observedAt.slice(0,10),member?'Shared by '+member.name:'Shared context'].join(' · '),caution:'Check whether this is still open; it may belong to another member.'});
  if(items.length)break;
 }
 const me=graph.members?.find(m=>m.isMe)?.id;
 for(const pair of graph.introductionSuggestions||[]){
  if(!pair.evidence?.length||!pair.personIds?.every(id=>nodes.has(id)))continue;
  const id=pair.personIds.find(id=>!nodes.get(id).relationships?.some(r=>r.memberId===me)&&!used.has(id));
  if(id){add({personId:id,title:'Another perspective',reason:pair.reason,source:'Suggested from shared context',caution:'No direct relationship to you is recorded. Explore the evidence.'});break;}
 }
 return items.slice(0,3);
}
export function nearbyBranches(walk,index,paths,offset=0){
 const current=walk.nodes[index];if(!current)return [];
 const seen=new Set(walk.nodes.map(n=>n.id)),byId=new Map(paths.nodes.map(n=>[n.id,n])),unique=new Map();
 for(const edge of paths.edges){if(!['personal','cooccurrence'].includes(edge.kind))continue;
  const id=edge.source===current.id?edge.target:edge.target===current.id?edge.source:null,person=byId.get(id);
  if(!id||seen.has(id)||person?.memberId||!permitted(person))continue;
  if(!unique.has(id)||edge.kind==='personal')unique.set(id,{person,edge});
 }
 const items=[...unique.values()].sort((a,b)=>Number(b.edge.kind==='personal')-Number(a.edge.kind==='personal')||a.person.id.localeCompare(b.person.id));
 if(!items.length)return [];
 const start=offset%items.length;
 return [...items.slice(start),...items.slice(0,start)].slice(0,4);
}
export function extendWalk(walk,index,id,paths){
 const current=walk.nodes[index],person=paths.nodes.find(n=>n.id===id);
 if(!current||!permitted(person)||walk.nodes.some(n=>n.id===id))return null;
 const edge=paths.edges.find(e=>['personal','cooccurrence'].includes(e.kind)&&((e.source===current.id&&e.target===id)||(e.target===current.id&&e.source===id)));
 if(!edge)return null;
 const edges=[...walk.edges.slice(0,index),edge];
 return {...walk,nodes:[...walk.nodes.slice(0,index+1),person],edges,message:edges.some(e=>e.kind!=='personal')?'This trail includes shared context; those relationships are unverified.':'Following recorded contact. Inspect each edge for its source and date.'};
}

// Re-rank the compact map from shared evidence whenever its data changes.
export function overviewPeople(graph,now=Date.now(),preferredIds=[]){
 const nodes=graph.nodes.filter(permitted),byId=new Map(nodes.map(n=>[n.id,n]));
 const recent=new Map();
 const remember=(id,date)=>{const time=Date.parse(date);if(Number.isFinite(time)&&time<=now)recent.set(id,Math.max(recent.get(id)||0,time));};
 for(const signal of graph.themeSignals||[])remember(signal.personId,signal.observedAt);
 for(const node of nodes)for(const relationship of node.relationships||[])remember(node.id,relationship.lastContact);
 const ids=new Set();
 const add=id=>{if(ids.size<12&&byId.has(id))ids.add(id);};
 for(const id of preferredIds)add(id);
 const starts=networkStarts(graph,now).map(s=>s.personId);
 for(const id of starts)add(id);
 for(const id of starts)for(const edge of (graph.edges||[]).filter(e=>e.source===id||e.target===id).slice(0,3))add(edge.source===id?edge.target:edge.source);
 for(const node of nodes.slice().sort((a,b)=>(recent.get(b.id)||0)-(recent.get(a.id)||0)))add(node.id);
 return [...ids].map(id=>byId.get(id));
}

// Discovery is relative to the signed-in member; contact presence means already known.
export function discoveryOverview(graph,now=Date.now(),preferredIds=[]){
 const me=graph.members?.find(m=>m.isMe)?.id;
 if(!me)return [];
 const others=new Set(graph.members.filter(m=>m.id!==me).map(m=>m.id));
 const nodes=graph.nodes.filter(n=>permitted(n)&&!n.relationships?.some(r=>r.memberId===me)&&n.relationships?.some(r=>others.has(r.memberId)&&supportsIntroduction(r)));
 const strength=n=>Math.max(0,...(n.relationships||[]).filter(r=>others.has(r.memberId)&&scoreBacked(r)).map(r=>r.score));
 nodes.sort((a,b)=>strength(b)-strength(a));
 return overviewPeople({...graph,nodes},now,preferredIds);
}
