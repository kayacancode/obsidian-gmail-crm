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
 return `Hi ${name} and ${item.person.name},\n\nI thought a conversation between you might be useful.\n\n${item.brief?'Your description of '+name+': “'+item.brief+'”':name+"'s recorded context: “"+item.anchorEvidence.summary+'”'}\n${item.person.name}'s recorded context: “${item.evidence.summary}”\n\nThere may be a useful overlap here. Would you both be open to an introduction?\n\n[Add why you think this would help, and check that this context is appropriate to share.]`;
}
export function helperSection(doc,graph,personId,onFindHelpers){
 const person=graph.nodes.find(n=>n.id===personId),section=element(doc,'details','rg-helper-section');
 section.append(element(doc,'summary','','Who could help this person?'));
 let loaded=false;
 section.addEventListener('toggle',()=>{
  if(!section.open||loaded)return;loaded=true;
  const items=helperSuggestions(graph,personId);
  section.append(element(doc,'p','rg-source','What-if suggestions from recent context. These are possible conversations, not recorded relationships.'));
  const form=element(doc,'form','rg-helper-form'),label=element(doc,'label','','What is '+person.name+' building or looking for help with?'),input=element(doc,'textarea');
  input.rows=3;input.maxLength=1000;input.required=true;input.placeholder='e.g. Building a scheduling tool for clinics and needs feedback from people who have researched healthcare workflows.';label.append(input);
  const submit=element(doc,'button','rg-button','Find people who could help');submit.type='submit';form.append(label,submit,element(doc,'p','rg-source','Used for this search. Your description is not added to shared notes.'));section.append(form);
  const output=element(doc,'div');output.setAttribute('aria-live','polite');section.append(output);
  form.addEventListener('submit',async event=>{event.preventDefault();const brief=input.value.trim();if(!brief)return;submit.disabled=true;input.disabled=true;output.replaceChildren(element(doc,'p','','Looking for complementary experience…'));
   try{if(!onFindHelpers)throw Error('unavailable');const result=await onFindHelpers(personId,brief);if(!section.isConnected)return;if(!result.checked||result.status==='unavailable')throw Error('unavailable');
    const matches=(result.results||[]).map(r=>({person:graph.nodes.find(n=>n.id===r.personId),reason:r.reason,evidence:r.evidence[0],allEvidence:r.evidence,brief})).filter(r=>r.person&&r.evidence);
    output.replaceChildren();render(matches);
    if(!matches.length)output.append(element(doc,'p','',result.status==='no_evidence'?'There are no recent conversation notes available to match against yet. Add or sync meeting notes, then try this brief again.':'No concrete match for this brief yet. Try naming the kind of help or experience you need.'));
    output.append(element(doc,'p','rg-source','Checked '+result.considered+' people with recent context'+(result.available>result.considered?' out of '+result.available+'; most recent first':'')+'. Interest and availability are unknown.'));
   }catch{output.replaceChildren(element(doc,'p','','The search could not finish. Your brief is still here—please try again.'));}
   finally{submit.disabled=false;input.disabled=false;}
  });
  if(!items.length)output.append(element(doc,'p','rg-source','Add a short brief above to look for people with relevant experience.'));
  render(items);
  function render(items){for(const item of items){
   const card=element(doc,'article','rg-helper-card');card.append(element(doc,'h3','',item.person.name),element(doc,'p','',item.reason),element(doc,'small','rg-source',item.brief?'Possible fit for your brief · interest and availability unknown':'Specific wording overlap · review whether they could help each other'));
   const evidence=element(doc,'details');evidence.append(element(doc,'summary','','Why this match?'));if(item.anchorEvidence)evidence.append(element(doc,'strong','',person.name),contextBlock(doc,item.anchorEvidence));else evidence.append(element(doc,'p','','Your brief: '+item.brief));evidence.append(element(doc,'strong','',item.person.name));for(const source of item.allEvidence||[item.evidence])evidence.append(contextBlock(doc,{...source,sourceLabel:source.sourceLabel||({granola:'Meeting notes',obsidian_note:'Notes',gmail_body_derived:'Email context'}[source.sourceType]||'Source'),contributor:source.contributor||(graph.source==='workspace'?'Shared source':'You')}));card.append(evidence);
   const members=(graph.members||[]).filter(m=>item.person.relationships?.some(r=>r.memberId===m.id&&supportsIntroduction(r)));
   const you=graph.source!=='workspace'&&item.person.directRelationship!==false&&!item.person.via?.length;
   card.append(element(doc,'p','rg-source',you?'In your network — you could ask whether they are open to connecting.':members.length?'Connection through '+members.map(m=>m.isMe?'you':m.name.split('@')[0]).join(', ')+'. Ask before introducing.':'No supported introduction route is recorded yet.'));
   const draft=element(doc,'div','rg-helper-draft');draft.hidden=true;
   const label=element(doc,'label','','Introduction draft — review before sharing');const text=element(doc,'textarea');text.value=helperDraft(person.name,item);text.rows=10;text.setAttribute('aria-label','Introduction draft for '+person.name+' and '+item.person.name);label.append(text);draft.append(label,element(doc,'p','rg-source','Nothing is sent automatically. Check the wording, context permissions, and both people’s interest.'));
   card.append(action(doc,'Draft an introduction',()=>{draft.hidden=!draft.hidden;if(!draft.hidden)text.focus();},'rg-text-button'),draft);output.append(card);
  }}
 });
 return section;
}
