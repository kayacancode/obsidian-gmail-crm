import {personSuggestions} from './person-suggestions.mjs';
import {element,action,contextBlock} from './contact-sheet.mjs';
import {supportsIntroduction} from './relationship-support.mjs';
const generic=new Set('ai agent agents technology business building working work project product platform startup company team meeting discussion discussed recorded topic context developing exploring planning the and with for from about that this'.split(' '));
const specific=text=>new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>2&&!generic.has(w)));
export function helperSuggestions(graph,personId,now=Date.now()){
 const themeSignals=(graph.themeSignals||[]).filter(s=>{
  const at=Date.parse(s.observedAt);
  return at<=now&&at>=now-180*86400000&&!/^Recorded topic:/i.test(s.summary||'')&&(graph.source!=='workspace'||s.visibility==='firm');
 });
 const nodes=graph.nodes.filter(n=>!n.sources?.includes('obsidian')||n.identityMatchReady===true);
 return personSuggestions({...graph,nodes,themeSignals},personId,'','',nodes.length).filter(item=>{
  const a=specific(item.anchorEvidence?.summary),b=specific(item.evidence.summary);
  return [...a].filter(w=>b.has(w)).length>=2;
 }).slice(0,3);
}
export function helperDraft(name,item){
 return `Hi ${name} and ${item.person.name},\n\nI thought a conversation between you might be useful.\n\n${name}'s recorded context: “${item.anchorEvidence.summary}”\n${item.person.name}'s recorded context: “${item.evidence.summary}”\n\nThere may be a useful overlap here. Would you both be open to an introduction?\n\n[Add why you think this would help, and check that this context is appropriate to share.]`;
}
export function helperSection(doc,graph,personId){
 const person=graph.nodes.find(n=>n.id===personId),section=element(doc,'details','rg-helper-section');
 section.append(element(doc,'summary','','Who could help this person?'));
 let loaded=false;
 section.addEventListener('toggle',()=>{
  if(!section.open||loaded)return;loaded=true;
  const items=helperSuggestions(graph,personId);
  section.append(element(doc,'p','rg-source','What-if suggestions from recent context. These are possible conversations, not recorded relationships.'));
  if(!items.length){section.append(element(doc,'p','','Not enough specific, recent context on both sides to suggest a useful introduction yet. Meeting discussion notes or a description of what they need can help; contact dates and broad topics alone cannot.'));return;}
  for(const item of items){
   const card=element(doc,'article','rg-helper-card');card.append(element(doc,'h3','',item.person.name),element(doc,'p','',item.reason),element(doc,'small','rg-source','Specific wording overlap · review whether they could help each other'));
   const evidence=element(doc,'details');evidence.append(element(doc,'summary','','Why this match?'),element(doc,'strong','',person.name),contextBlock(doc,item.anchorEvidence),element(doc,'strong','',item.person.name),contextBlock(doc,item.evidence));card.append(evidence);
   const members=(graph.members||[]).filter(m=>item.person.relationships?.some(r=>r.memberId===m.id&&supportsIntroduction(r)));
   const you=graph.source!=='workspace'&&item.person.directRelationship!==false&&!item.person.via?.length;
   card.append(element(doc,'p','rg-source',you?'In your network — you could ask whether they are open to connecting.':members.length?'Connection through '+members.map(m=>m.isMe?'you':m.name.split('@')[0]).join(', ')+'. Ask before introducing.':'No supported introduction route is recorded yet.'));
   const draft=element(doc,'div','rg-helper-draft');draft.hidden=true;
   const label=element(doc,'label','','Introduction draft — review before sharing');const text=element(doc,'textarea');text.value=helperDraft(person.name,item);text.rows=10;text.setAttribute('aria-label','Introduction draft for '+person.name+' and '+item.person.name);label.append(text);draft.append(label,element(doc,'p','rg-source','Nothing is sent automatically. Check the wording, context permissions, and both people’s interest.'));
   card.append(action(doc,'Draft an introduction',()=>{draft.hidden=!draft.hidden;if(!draft.hidden)text.focus();},'rg-text-button'),draft);section.append(card);
  }
 });
 return section;
}
