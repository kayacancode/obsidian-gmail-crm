import {personContext,contextBlock,portrait,element} from './contact-sheet.mjs';
const stop=new Set('recorded topic context the and for with from that this about their they have has was were will would could should someone people person working work meeting notes discussed discussion follow send share need want into your our you who help find talk conversation building exploring planning'.split(' '));
const words=text=>new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>2&&!stop.has(w)||['ui','ux','ai'].includes(w)));
const permitted=n=>n&&n.type!=='company'&&!n.memberId&&n.permission!=='denied'&&n.permission!=='conflicted'&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved';
const contexts=(g,id)=>personContext({...g,themeSignals:(g.themeSignals||[]).filter(e=>['granola','granola_mention','obsidian_note','gmail_body_derived'].includes(e.sourceType)&&Date.parse(e.observedAt)<=Date.now())},id);
export function personSuggestions(graph,anchorId,intent='',sourceRef=''){
 if(!permitted(graph.nodes.find(n=>n.id===anchorId)))return [];
 const signalsByPerson=new Map();for(const signal of graph.themeSignals||[]){const list=signalsByPerson.get(signal.personId)||[];list.push(signal);signalsByPerson.set(signal.personId,list);}
 const contextFor=id=>contexts({...graph,themeSignals:signalsByPerson.get(id)||[]},id);
 const anchors=contextFor(anchorId).filter(e=>!sourceRef||e.ref===sourceRef);
 if(sourceRef&&!anchors.length)return [];
 const seeds=intent.trim()?[{summary:intent,manual:true}]:anchors;
 if(!seeds.length)return [];
 const connected=new Set((graph.edges||[]).filter(e=>e.kind==='personal'&&(e.source===anchorId||e.target===anchorId)).map(e=>e.source===anchorId?e.target:e.source));
 const results=[];
 for(const person of graph.nodes){if(person.id===anchorId||connected.has(person.id)||!permitted(person))continue;
  let best=null;
  for(const evidence of contextFor(person.id))for(const seed of seeds){
   const a=words(seed.summary),b=words(evidence.summary),common=[...a].filter(w=>b.has(w));
   if(common.length<(seed.manual?1:2))continue;
   const score=common.length/Math.sqrt(Math.max(1,a.size*b.size));
   if(!best||score>best.score)best={person,evidence,anchorEvidence:seed.manual?null:seed,score,reason:seed.manual?'Shared evidence matches your topic: '+common.slice(0,4).join(', '):'Both have recorded context about '+common.slice(0,4).join(', ')};
  }
  if(best)results.push(best);
 }
 return results.sort((a,b)=>b.score-a.score||Date.parse(b.evidence.date)-Date.parse(a.evidence.date)||a.person.id.localeCompare(b.person.id)).slice(0,4);
}
export function mountPersonSuggestions(container,{graph,personId,onExplore,intent:initialIntent=''}){
 const doc=container.ownerDocument,person=graph.nodes.find(n=>n.id===personId);if(!person)return;
 const el=(tag,cls,text)=>element(doc,tag,cls,text),section=el('section','nc-person-suggestions');section.setAttribute('aria-label','People for '+person.name+' to talk to');
 section.append(el('h3','','Who could '+person.name+' talk to?'),el('p','nc-muted','Possible conversation matches. Shared context does not establish a relationship.'));
 const form=el('form','nc-suggestion-form'),label=el('label','','Topic or question for '+person.name),input=el('input');input.type='search';input.placeholder='e.g. agent memory or UI design';input.value=initialIntent;label.append(input);form.append(label);
 const sources=contexts(graph,personId);let select=null;
 if(sources.length){const sourceLabel=el('label','','Conversation context');select=el('select');select.append(new Option('All available context',''));for(const e of sources)select.append(new Option(e.date.slice(0,10)+' · '+(e.title||e.summary).slice(0,90),e.ref));sourceLabel.append(select);form.append(sourceLabel);}
 const submit=el('button','','Find people');submit.type='submit';form.append(submit);section.append(form);
 const result=el('div','nc-suggestion-results');result.setAttribute('aria-live','polite');section.append(result);container.append(section);
 function render(){const intent=input.value.trim(),items=personSuggestions(graph,personId,intent,select?.value||'');result.replaceChildren();
  if(!items.length){result.append(el('p','nc-suggestion-empty',sources.length||intent?'No supported matches for this context. Try another conversation or a more specific topic.':'No shared conversation context for '+person.name+' yet. Enter a topic to look for people with matching evidence.'));return;}
  for(const item of items){const card=el('article','nc-suggestion-card');const heading=el('div','nc-suggestion-person');heading.append(portrait(doc,item.person),el('h4','',item.person.name));card.append(heading,el('p','',item.reason),el('small','nc-muted','Keyword evidence match · relevance needs your judgment'));
   if(item.anchorEvidence){const origin=el('details');origin.append(el('summary','','Context for '+person.name),contextBlock(doc,item.anchorEvidence));card.append(origin);}else card.append(el('p','nc-muted','Your topic: '+intent));
   card.append(contextBlock(doc,item.evidence));
   const members=(item.person.relationships||[]).filter(r=>['email','meeting'].includes(r.evidenceCategory)&&!(r.activity&&(!r.activity.sent||!r.activity.received)&&!r.activity.meetings)).map(r=>graph.members?.find(m=>m.id===r.memberId)?.name||r.memberName).filter(Boolean);
   card.append(el('p','nc-muted',members.length?'Recorded contact via '+[...new Set(members)].join(', ')+'. Inspect the route before asking for an introduction.':'No supported introducer recorded in the shared data.'));
   const open=el('button','','Explore '+item.person.name);open.type='button';open.onclick=()=>onExplore(item.person.id,{anchorId:person.id,anchorName:person.name,reason:item.reason});card.append(open);result.append(card);
  }
 }
 form.onsubmit=e=>{e.preventDefault();render();};if(select)select.onchange=render;render();
}

export function mountPersonSuggestionPopup(container,options){
 const doc=container.ownerDocument,person=options.graph.nodes.find(n=>n.id===options.personId);if(!person)return;
 const launch=element(doc,'button','nc-suggestions-launch','Find people for '+person.name);launch.type='button';launch.setAttribute('aria-haspopup','dialog');container.append(launch);
 const dialog=element(doc,'dialog','nc-suggestions-dialog');dialog.setAttribute('aria-label','Who could '+person.name+' talk to?');
 const pane=element(doc,'div','nc-suggestions-popup'),close=element(doc,'button','nc-suggestions-close','×');close.type='button';close.setAttribute('aria-label','Close conversation matches');pane.append(close);dialog.append(pane);doc.body.append(dialog);
 let previousOverflow=null;
 const unlock=()=>{if(previousOverflow!==null){doc.body.style.overflow=previousOverflow;previousOverflow=null;}};
 const dismiss=()=>{if(dialog.open)dialog.close();unlock();};
 close.onclick=dismiss;dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dismiss();}},true);dialog.addEventListener('close',unlock);dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});dialog.addEventListener('click',e=>{if(e.target===dialog)dismiss();});
 mountPersonSuggestions(pane,{...options,onExplore:(...args)=>{dismiss();options.onExplore?.(...args);}});
 launch.onclick=()=>{previousOverflow=doc.body.style.overflow;doc.body.style.overflow='hidden';dialog.showModal();pane.querySelector('input')?.focus();};
 return {destroy(){dismiss();dialog.remove();launch.remove();}};
}
