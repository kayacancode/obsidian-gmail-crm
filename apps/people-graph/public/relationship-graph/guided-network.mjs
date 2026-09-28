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
 const mutual=[...nodes.values()].filter(n=>(n.relationships||[]).length>1&&!used.has(n.id)).sort((a,b)=>b.relationships.length-a.relationships.length||a.id.localeCompare(b.id));
 if(mutual.length)add({personId:mutual[0].id,title:'Explore a shared connection',reason:mutual[0].name+' appears in multiple members’ networks.',source:'Matched across contributors',caution:'Inspect each member’s evidence; sharing alone does not establish closeness.'});
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
