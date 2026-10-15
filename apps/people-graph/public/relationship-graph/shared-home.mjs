import {weeklyContext} from './weekly-context.mjs';
import {supportsIntroduction} from './relationship-support.mjs';
import {element,action,portrait,contactCard,personContext} from './contact-sheet.mjs';
const allowed=n=>n.type==='person'&&!['denied','conflicted'].includes(n.permission)&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved'&&(!n.sources?.includes('obsidian')||n.identityMatchReady===true);
const name=m=>{const value=(m?.name||'Someone').split('@')[0].split(/[ .]/)[0];return value.charAt(0).toUpperCase()+value.slice(1);};
export function sharedHomeTitle(graph){const others=(graph.members||[]).filter(m=>!m.isMe).map(name);return others.length<=2?'You'+(others.length?' + '+others.join(' + '):''):graph.workspaceName||'Your shared network';}
export function sharedHomeRows(graph,answer=null){
 const nodes=(graph.nodes||[]).filter(allowed),byId=new Map(nodes.map(n=>[n.id,n]));
 if(answer){const used=new Set();return {message:answer.results?.length?'Results for “'+answer.query+'”':'No matches. Try a name, company, or topic.',rows:(answer.results||[]).flatMap(r=>{const person=byId.get(r.personId);if(!person||used.has(person.id))return [];used.add(person.id);return [{person,reason:r.reasons?.[0]?.summary||person.company||'In your shared network'}];}).slice(0,20)};}
 const week=weeklyContext(graph),rows=[],used=new Set();
 const add=(person,reason)=>{if(!person||used.has(person.id)||rows.length>=6)return;used.add(person.id);rows.push({person,reason});};
 // Alternate useful matches in each direction with active mutual contacts.
 for(let i=0;i<3;i++)for(const key of ['forYou','forOthers','mutual']){const item=week.groups[key][i];if(!item)continue;
  const topic=item.evidence[0]?.topic;
  const mutualNames=(item.person.relationships||[]).filter(r=>supportsIntroduction(r)&&graph.members.some(m=>m.id===r.memberId&&!m.isMe)).map(r=>name(graph.members.find(m=>m.id===r.memberId)));
  const reason=key==='mutual'?`A contact you and ${mutualNames.join(', ')} share.`:key==='forYou'?`${name(item.contributor)} shared context about ${topic}, a topic in your week.`:`Your shared context about ${topic} could be useful to ${name(item.recipient)}.`;
  add(item.person,reason);
 }
 const hasWeekly=rows.length>0,self=graph.members?.find(m=>m.isMe)?.id;
 const ties=n=>(n.relationships||[]).filter(r=>supportsIntroduction(r)&&graph.members?.some(m=>m.id===r.memberId));
 const sorted=nodes.slice().sort((a,b)=>Number(ties(b).some(r=>r.memberId===self)&&ties(b).some(r=>r.memberId!==self))-Number(ties(a).some(r=>r.memberId===self)&&ties(a).some(r=>r.memberId!==self))||a.name.localeCompare(b.name));
 for(const person of sorted){const relationships=ties(person),others=relationships.filter(r=>r.memberId!==self).map(r=>name(graph.members.find(m=>m.id===r.memberId)));if(!others.length)continue;add(person,relationships.some(r=>r.memberId===self)?`A contact you and ${others.join(', ')} share.`:`Shared by ${others.join(', ')}.`);}
 return {rows,message:hasWeekly?'A few people worth a look.':rows.length?'No suggestions for this week yet. Here are people in your shared contacts.':'No shared contacts to show yet.'};
}
export function sharedHome(doc,graph,{answer=null,selectedId=null,query='',status='',onQueryChange,onSearch,onClear,onPerson,onBack,onIntro}={}){
 const root=element(doc,'section','shared-home');root.setAttribute('aria-label','Shared people');
 const selected=graph.nodes.find(n=>n.id===selectedId&&allowed(n));
 if(selected){
  root.append(action(doc,'← Back to people',onBack,'sh-back'));
  const head=element(doc,'div','sh-person-heading');head.append(portrait(doc,selected),element(doc,'h1','',selected.name));root.append(head);
  if(selected.company)root.append(element(doc,'p','sh-subtitle',selected.company));
  const card=contactCard(graph,selected.id,answer),ties=(selected.relationships||[]).filter(supportsIntroduction);
  root.append(element(doc,'p','sh-connection',ties.length?'In '+ties.map(r=>{const m=graph.members.find(m=>m.id===r.memberId);return m?.isMe?'your contacts':name(m)+'’s contacts';}).join(' and ')+'.':'Shared in this network.'));
  const evidence=personContext(graph,selected.id);
  if(evidence.length){root.append(element(doc,'h2','','Shared context'));for(const e of evidence.slice(0,3)){const block=element(doc,'article','sh-note');block.append(element(doc,'p','',e.summary),element(doc,'small','',`${e.contributor} · ${e.date.slice(0,10)}`));root.append(block);}if(evidence.length>3){const more=element(doc,'details','sh-more');more.append(element(doc,'summary','','More shared context'));for(const e of evidence.slice(3,20))more.append(element(doc,'p','',`${e.summary} — ${e.date.slice(0,10)}`));root.append(more);}}
  else root.append(element(doc,'p','sh-subtitle','No meeting notes or other context have been shared for this person.'));
  if(onIntro&&card?.routes?.length){const route=card.routes[0];root.append(action(doc,'Ask '+name(graph.members.find(m=>m.id===route.memberId))+' for an introduction',()=>onIntro(card,route.memberId),'sh-intro'));}
  return root;
 }
 root.append(element(doc,'h1','',sharedHomeTitle(graph)));
 const form=element(doc,'form','sh-search'),label=element(doc,'label','sh-search-field'),input=element(doc,'input');input.type='search';input.setAttribute('aria-label','Find a person or ask a question');input.placeholder='Find someone, or ask a question';input.value=query;input.maxLength=200;label.append(input);form.append(label,action(doc,'Search',()=>form.requestSubmit(),'sh-search-button'));form.onsubmit=e=>{e.preventDefault();e.stopPropagation();onSearch?.(input.value.trim());};form.onclick=e=>e.stopPropagation();form.oninput=e=>{e.stopPropagation();onQueryChange?.(input.value);};root.append(form);
 if(status){const message=element(doc,'p','sh-subtitle',status);message.setAttribute('role','status');root.append(message);}
 const data=sharedHomeRows(graph,answer);root.append(element(doc,'p','sh-subtitle',data.message));
 if(answer)root.append(action(doc,'Clear search',onClear,'sh-back'));
 const list=element(doc,'ul','sh-people');
 for(const row of data.rows){const li=element(doc,'li'),button=action(doc,'',()=>onPerson(row.person.id),'sh-person');const copy=element(doc,'span','sh-person-copy');copy.append(element(doc,'strong','',row.person.name),element(doc,'span','',row.reason));button.append(portrait(doc,row.person),copy,element(doc,'span','sh-arrow','→'));li.append(button);list.append(li);}
 root.append(list);return root;
}
