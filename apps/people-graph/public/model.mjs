const text=(v,max=500)=>typeof v==='string'?v.slice(0,max):'';
export function safePhoto(value){try{const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))&&!u.username&&!u.password&&!u.href.includes('@')?u.href:null;}catch{return null;}}
export function normalize(input){
 if(!input||!Array.isArray(input.nodes)||!Array.isArray(input.edges))throw Error('This graph snapshot is invalid. Push a fresh graph from Obsidian.');
 if(input.nodes.length>1500||input.edges.length>100000)throw Error('This graph exceeds the supported snapshot size. Update the plugin and push again.');
 const ids=new Set();const nodes=input.nodes.map(n=>{if(!n||typeof n.id!=='string'||!n.id||ids.has(n.id))throw Error('Duplicate or missing person identity in graph.');ids.add(n.id);return {id:n.id,name:text(n.name,200)||'Unnamed person',company:text(n.company,200),role:text(n.role,200),photoUrl:safePhoto(n.photoUrl),strength:typeof n.strength==='number'&&Number.isFinite(n.strength)?Math.max(0,Math.min(100,n.strength)):null,lastContact:text(n.lastContact,40),quadrant:text(n.quadrant,30)};});
 const edges=input.edges.map(e=>{if(!e||!ids.has(e.source)||!ids.has(e.target))throw Error('A connection points to a missing person. Push a fresh graph.');return {source:e.source,target:e.target,weight:typeof e.weight==='number'&&Number.isFinite(e.weight)?Math.max(1,e.weight):1,types:Array.isArray(e.types)?e.types.map(v=>text(v,50)).filter(Boolean):[],contexts:Array.isArray(e.contexts)?e.contexts.map(v=>text(v,500)).filter(Boolean):[]};}).filter(e=>e.source!==e.target);
 const byId=new Map(nodes.map(n=>[n.id,n])),ties=new Map(nodes.map(n=>[n.id,[]]));edges.forEach(e=>{ties.get(e.source).push(e);ties.get(e.target).push(e);});
 return {nodes,edges,byId,ties,pushedAt:text(input.pushedAt,40)};
}
const stop=new Set('a an the who what where when why how could should would can might is are in at on of for to and or with my me we i our your you right now today works work working find people person join panel event throwing help looking about that be do does'.split(' '));
export function search(g,query){
 const words=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[])].filter(w=>!stop.has(w));
 if(query.trim()&&!words.length){const q=query.trim().toLowerCase();return g.nodes.flatMap(node=>{const hits=[['Name',node.name],['Company',node.company],['Role',node.role]].filter(([,v])=>v.toLowerCase()===q);return hits.length?[{node,score:5,coverage:1,reasons:hits.map(([k,v])=>k+': '+v),missing:[]}]:[];});}
 return g.nodes.map(node=>{
  const fields=[['Name',node.name],['Company',node.company],['Role',node.role],...g.ties.get(node.id).flatMap(e=>e.contexts.map(c=>['Connection context',c]))];
  const matched=new Set(),reasons=[];let score=0;
  for(const [label,value] of fields){const tokens=new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);const hits=words.filter(w=>tokens.has(w));if(hits.length){hits.forEach(w=>matched.add(w));score+=hits.length*(label==='Name'?5:label==='Role'?3:1);if(reasons.length<5)reasons.push(`${label}: ${value}`);}}
  return {node,score,coverage:words.length?matched.size/words.length:1,reasons,missing:words.filter(w=>!matched.has(w))};
 }).filter(r=>!words.length||r.score>0).sort((a,b)=>b.coverage-a.coverage||b.score-a.score||g.ties.get(b.node.id).length-g.ties.get(a.node.id).length||a.node.name.localeCompare(b.node.name));
}
export function sceneData(g,results,limit=12){const people=results.slice(0,limit).map(r=>r.node),names=[...new Set(people.map(p=>p.company).filter(Boolean))];return {people,companies:names.slice(0,8).map(name=>({id:'company:'+name,name,isCompany:true})),total:results.length};}
export function loadLocal(storage,account){try{const d=JSON.parse(storage.getItem('people-spatial:'+account)||'{}');return {shortlist:Array.isArray(d.shortlist)?d.shortlist.filter(s=>typeof s==='string').slice(0,1500):[],drafts:d.drafts&&typeof d.drafts==='object'&&!Array.isArray(d.drafts)?Object.fromEntries(Object.entries(d.drafts).filter(([k,v])=>typeof v==='string').slice(0,1500)): {}};}catch{return {shortlist:[],drafts:{}};}}
export function saveLocal(storage,account,state){storage.setItem('people-spatial:'+account,JSON.stringify(state));}
export function dateLabel(value){const d=new Date(value);return value&&Number.isFinite(d.getTime())?d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Not recorded';}
