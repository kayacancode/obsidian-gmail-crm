import {personSuggestions} from './person-suggestions.mjs';
import {element,action} from './contact-sheet.mjs';
import {supportsIntroduction} from './relationship-support.mjs';
const generic=new Set('ai agent agents technology business building working work project product platform startup company team meeting discussion discussed recorded topic context developing exploring planning the and with for from about that this'.split(' '));
const isDirect=person=>person.directRelationship===true||(person.directRelationship===undefined&&!person.via?.length);
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
 if(item.conversation)return `Hi ${name} and ${item.person.name},\n\nI thought you might have a useful conversation. ${item.reason}\n\nA starting point: ${item.conversation}\n\nWould you both be open to an introduction?\n\n[Review the context and check that both people are comfortable sharing it.]`;
 return `Hi ${name} and ${item.person.name},\n\nI thought a conversation between you might be useful.\n\n${item.brief?'Your description of '+name+': “'+item.brief+'”':name+"'s recorded context: “"+item.anchorEvidence.summary+'”'}\n${item.person.name}'s recorded context: “${item.evidence.summary}”\n\nThere may be a useful overlap here. Would you both be open to an introduction?\n\n[Add why you think this would help, and check that this context is appropriate to share.]`;
}
export function helperSection(doc,graph,personId,onFindHelpers,{onExplore}={}){
 const person=graph.nodes.find(n=>n.id===personId),section=element(doc,'details','rg-helper-section');
 section.append(element(doc,'summary','','Who could help this person?'));
 let loaded=false;
 section.addEventListener('toggle',()=>{
  if(!section.open||loaded)return;loaded=true;
  const items=helperSuggestions(graph,personId);
  section.append(element(doc,'p','rg-source','A reason to connect, grounded in recent conversations.'));
  const form=element(doc,'form','rg-helper-form'),label=element(doc,'label','','Refine what '+person.name+' needs (optional)'),input=element(doc,'textarea');
  input.rows=3;input.maxLength=1000;input.required=false;input.placeholder='e.g. Building a scheduling tool for clinics and needs feedback from people who have researched healthcare workflows.';label.append(input);
  const submit=element(doc,'button','rg-button','Find people who could help');submit.type='submit';form.append(label,submit,element(doc,'p','rg-source','Used for this search. Your description is not added to shared notes.'));section.append(form);
  const refine=element(doc,'details','rg-helper-refine');refine.append(element(doc,'summary','','Refine this search'),form);const output=element(doc,'div');output.setAttribute('aria-live','polite');section.append(output,refine);
  async function find(){const brief=input.value.trim();submit.disabled=true;input.disabled=true;output.replaceChildren(element(doc,'p','','Reading their context and checking possible connections…'));
   try{if(!onFindHelpers)throw Error('unavailable');const result=await onFindHelpers(personId,brief);if(!section.isConnected)return;if(!result.checked||result.status==='unavailable')throw Error('unavailable');
    const usedBrief=typeof result.brief==='string'?result.brief:brief;
    const matches=(result.results||[]).map(r=>({person:graph.nodes.find(n=>n.id===r.personId),reason:r.reason,conversation:r.conversation,pointPerson:r.pointPerson,evidence:r.evidence[0],allEvidence:r.evidence,allAnchorEvidence:r.anchorEvidence||result.anchorEvidence||[],brief:result.automatic?null:usedBrief,savedContext:result.contextSource==='saved_note'||result.contextSource==='saved_memory',automatic:result.automatic,anchorEvidence:(r.anchorEvidence||result.anchorEvidence)?.[0]})).filter(r=>r.person&&r.evidence);
    output.replaceChildren();render(matches);
    if(result.contextSource==='saved_note'||result.contextSource==='saved_memory'){const basis=element(doc,'details');basis.append(element(doc,'summary','','Using your saved context'),element(doc,'p','',usedBrief));output.prepend(basis);}
    if(result.automatic&&result.anchorEvidence?.length){const basis=element(doc,'details');basis.append(element(doc,'summary','','Using recent conversation context'));for(const e of result.anchorEvidence)basis.append(helperSource(doc,e));output.prepend(basis);}
    if(!matches.length)output.append(element(doc,'p','',result.status==='no_anchor_context'?'Not enough recent conversation context for this person yet. Add what they’re working on below, or check your connected sources.':result.status==='no_evidence'?'There is no recent conversation context available to match against yet. Check your connected sources, then try again.':result.automatic?'No strong connection to suggest from the context available yet. You can add a detail below about what they are working on.':'No concrete match for this brief yet. Try naming the kind of help or experience you need.'));
    output.append(element(doc,'p','rg-source','Checked '+result.considered+' people with recent context'+(result.available>result.considered?' out of '+result.available+'; most recent first':'')+'. Suggestions are possibilities, not known relationships.'));
   }catch{output.replaceChildren(element(doc,'p','',brief?'The search could not finish. Your brief is still here.':'The search could not finish. Please try again.'),action(doc,'Try again',()=>{void find();},'rg-text-button'));}
   finally{submit.disabled=false;input.disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void find();});
  if(onFindHelpers)void find();
  if(!onFindHelpers&&!items.length)output.append(element(doc,'p','rg-source','Add a short brief above to look for people with relevant experience.'));
  if(!onFindHelpers)render(items);
  function render(items){for(const item of items){
   const card=element(doc,'article','rg-helper-card');card.append(element(doc,'h3','',item.person.name),element(doc,'p','rg-helper-reason',item.reason));
   const actions=element(doc,'div','rg-helper-actions'),explore=element(doc,'a','rg-text-button','Explore '+item.person.name),url=new URL(doc.defaultView.location.href);url.searchParams.set('person',item.person.id);explore.href=url.pathname+url.search;if(onExplore)explore.onclick=event=>{event.preventDefault();onExplore(item.person.id);};actions.append(explore);
   if(item.conversation){const status=element(doc,'p','rg-helper-copy-status');status.setAttribute('role','status');actions.append(action(doc,'Copy introduction reason',async()=>{const reason=[item.reason,item.conversation].filter(Boolean).join(' ');try{await doc.defaultView.navigator.clipboard.writeText(reason);status.textContent='Copied. Review the private context before sharing.';}catch{const copy=element(doc,'textarea');copy.readOnly=true;copy.value=reason;copy.setAttribute('aria-label','Introduction reason to copy');status.replaceChildren(copy);copy.focus();copy.select();}},'rg-text-button'));card.append(actions,element(doc,'p','rg-source','Private reasoning · review before sharing.'),status);}else card.append(actions);
   if(item.conversation){const topic=element(doc,'div','rg-helper-conversation');topic.append(element(doc,'small','','A conversation to have'),element(doc,'p','',item.conversation));card.append(topic);}
   const evidence=element(doc,'details');evidence.append(element(doc,'summary','','Why this match?'));if(item.anchorEvidence){evidence.append(element(doc,'strong','rg-helper-person',person.name));for(const source of item.allAnchorEvidence||[item.anchorEvidence])evidence.append(helperSource(doc,source));}else evidence.append(element(doc,'p','',(item.savedContext?'Your saved context: ':'Your description: ')+item.brief));evidence.append(element(doc,'strong','rg-helper-person',item.person.name));for(const source of item.allEvidence||[item.evidence])evidence.append(helperSource(doc,source));card.append(evidence);
   const members=(graph.members||[]).filter(m=>item.person.relationships?.some(r=>r.memberId===m.id&&supportsIntroduction(r)));
   const you=graph.source!=='workspace'&&isDirect(item.person);
   card.append(element(doc,'p','rg-source',you?(isDirect(person)?'You know both people.':'In your contacts.'):members.length?'Connection through '+members.map(m=>m.isMe?'you':m.name.split('@')[0]).join(', ')+'. Ask before introducing.':'No supported introduction route is recorded yet.'));
   if(item.pointPerson?.name)card.append(element(doc,'p','rg-source','Check with '+item.pointPerson.name+' before reaching out to '+item.person.name+'.'));
   const draft=element(doc,'div','rg-helper-draft');draft.hidden=true;
   const label=element(doc,'label','','Introduction draft — review before sharing');const text=element(doc,'textarea');text.value=helperDraft(person.name,item);text.rows=10;text.setAttribute('aria-label','Introduction draft for '+person.name+' and '+item.person.name);label.append(text);draft.append(label,element(doc,'p','rg-source','Nothing is sent automatically. Check the wording, context permissions, and both people’s interest.'));
   card.append(action(doc,'Draft an introduction',()=>{draft.hidden=!draft.hidden;if(!draft.hidden)text.focus();},'rg-text-button'),draft);output.append(card);
  }}
 });
 return section;
}

function helperSource(doc,e){
 const item=element(doc,'article','rg-helper-source');
 const source=e.sourceLabel||({granola:'Meeting notes',gmail_body_derived:'Gmail',obsidian_note:'Notes'}[e.sourceType]||'Source');
 const date=new Date(e.date);const stamp=Number.isNaN(date.getTime())?String(e.date||'').slice(0,10):date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
 item.append(element(doc,'small','rg-source',source+' · '+stamp),element(doc,'blockquote','',e.summary));
 return item;
}
