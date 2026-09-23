import {conversationThemes} from './intelligence.mjs';
const key=value=>String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const stop=new Set('the and with for from into about your our this that meeting notes sync weekly monthly daily follow up catch call chat discussion intro introduction betaworks'.split(' '));
export function wanderTopics(graph) {
 const signals=(graph.themeSignals||[]).filter(s=>s.sourceType!=='gmail_subject');
 const allowed=new Set(graph.nodes.map(n=>n.id));
 const entries=conversationThemes(graph.relevance?.themes||[],signals).map(t=>({...t,id:`theme:${t.themeId}`,kind:'Supported theme',evidence:signals.filter(s=>t.components.some(c=>c.signalId===s.id)),reason:'People connected to this topic by recorded evidence.'}));
 const notes=new Map();
 for(const s of signals){if(!['granola','obsidian_note'].includes(s.sourceType)||!s.provenance?.title||!allowed.has(s.personId))continue;
  const ref=s.evidenceRef.split('#')[0];if(!notes.has(ref))notes.set(ref,{id:`note:${ref}`,name:s.provenance.title,kind:'Conversation',nodeIds:[],evidence:[],reason:'A recorded conversation title—not an inferred community.'});
  const note=notes.get(ref);if(!note.nodeIds.includes(s.personId))note.nodeIds.push(s.personId);if(!note.evidence.some(e=>e.personId===s.personId))note.evidence.push(s);
 }
 const phrases=new Map();
 for(const note of notes.values()){
  const words=key(note.name).split(' '),seen=new Set();
  for(let i=0;i<words.length-1;i++)for(const length of [2,3]){
   const part=words.slice(i,i+length);if(part.length!==length||part.some(w=>stop.has(w)||w.length<3||/^\d+$/.test(w)))continue;
   const phrase=part.join(' ');if(seen.has(phrase))continue;seen.add(phrase);
   if(!phrases.has(phrase))phrases.set(phrase,[]);phrases.get(phrase).push(note);
  }
 }
 const existing=new Set([...entries.map(t=>key(t.name)),...graph.nodes.map(n=>key(n.name))]);
 const recurring=[...phrases].filter(([name,docs])=>docs.length>=2&&!existing.has(name)).sort((a,b)=>b[1].length-a[1].length||b[0].length-a[0].length).filter(([name,docs],i,all)=>!all.slice(0,i).some(([other,otherDocs])=>other.includes(name)&&otherDocs.length===docs.length)).slice(0,20)
  .map(([name,docs])=>({id:`phrase:${name}`,name:name[0].toUpperCase()+name.slice(1),kind:'Recurring topic',nodeIds:[...new Set(docs.flatMap(n=>n.nodeIds))],evidence:docs.flatMap(n=>n.evidence),reason:`This exact phrase occurs in ${docs.length} separate conversation titles. It suggests shared subject matter, not a personal relationship.`}));
 return [...entries,...recurring,...notes.values()].sort((a,b)=>({ 'Recurring topic':0,'Supported theme':1,Conversation:2}[a.kind]-{'Recurring topic':0,'Supported theme':1,Conversation:2}[b.kind])||b.nodeIds.length-a.nodeIds.length||a.name.localeCompare(b.name));
}
export function walkBranches(personId,graph,topics) {
 const byId=new Map(graph.nodes.map(n=>[n.id,n]));
 return graph.edges.filter(e=>e.source===personId||e.target===personId).map(e=>({edge:e,person:byId.get(e.source===personId?e.target:e.source)}))
  .filter(x=>x.person&&x.person.permission!=='denied'&&x.person.identityResolved!==false&&x.edge.kind!=='interpretation')
  .map(x=>({...x,topics:topics.filter(t=>t.nodeIds.includes(x.person.id)&&!t.nodeIds.includes(personId))}))
  .sort((a,b)=>b.topics.length-a.topics.length||a.person.name.localeCompare(b.person.name)).slice(0,8);
}
