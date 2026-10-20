import {helperSection} from './helper-suggestions.mjs';
import {howYouKnow} from './intelligence.mjs';
import {weeklyContext} from './weekly-context.mjs';
import {supportsIntroduction} from './relationship-support.mjs';
import {element,action,portrait,contactCard,personContext} from './contact-sheet.mjs';
export const sharedHomePersonAllowed=n=>n.type==='person'&&!['denied','conflicted'].includes(n.permission)&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved'&&(!n.sources?.includes('obsidian')||n.identityMatchReady===true);
const name=m=>{const value=(m?.name||'Someone').split('@')[0].split(/[ .]/)[0];return value.charAt(0).toUpperCase()+value.slice(1);};
export function sharedHomeTitle(graph){const others=(graph.members||[]).filter(m=>!m.isMe).map(name);return others.length<=2?'You'+(others.length?' + '+others.join(' + '):''):graph.workspaceName||'Your shared network';}
export function sharedHomeRows(graph,answer=null){
 const nodes=(graph.nodes||[]).filter(sharedHomePersonAllowed),byId=new Map(nodes.map(n=>[n.id,n]));
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
// Attribute shared evidence by its workspace provenance, never by a matching display name.
export function connectionContext(graph,personId,memberId,now=Date.now()){
 if(!graph.members?.some(m=>m.id===memberId))return [];
 const themeSignals=(graph.themeSignals||[]).filter(s=>String(s.evidenceRef||'').startsWith('workspace:'+memberId+':')&&Date.parse(s.observedAt)<=now);
 const evidence=personContext({...graph,themeSignals},personId),latest=evidence[0];
 return latest?evidence.filter(e=>e.date===latest.date&&e.sourceType===latest.sourceType&&e.title===latest.title).slice(0,3):[];
}
export function sharedHome(doc,graph,{answer=null,selectedId=null,query='',status='',headerOnly=false,compact=false,onQueryChange,onSearch,onClear,onPerson,onBack,onIntro,onMerge,onFindHelpers}={}){
 const root=element(doc,'section','shared-home');root.setAttribute('aria-label',compact?'Person details':'Shared people');if(compact)root.classList.add('sh-detail');
 const selected=graph.nodes.find(n=>n.id===selectedId&&sharedHomePersonAllowed(n));
 if(selected){
  root.append(action(doc,compact?'Close details':'← Back to people',onBack,'sh-back'));
  const head=element(doc,'div','sh-person-heading');head.append(portrait(doc,selected),element(doc,compact?'h2':'h1','',selected.name));root.append(head);
  const connection=howYouKnow(graph,selected);root.append(element(doc,'p','sh-connection',connection.text));
  if(selected.company)root.append(element(doc,'p','sh-subtitle',selected.company));
  const card=contactCard(graph,selected.id,answer);
  const why=sharedHomeRows(graph,answer).rows.find(row=>row.person.id===selected.id);
  if(why)root.append(element(doc,'p','sh-why',why.reason));
  for(const relationship of card.relationships){
   const facts=[];
   if(relationship.lastContact&&Number.isFinite(Date.parse(relationship.lastContact)))facts.push('Last contact · '+new Date(relationship.lastContact).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}));
   const activity=relationship.activity;
   if(activity){if(activity.sent>0||activity.received>0)facts.push('Email · '+activity.sent+' sent · '+activity.received+' received');if(activity.meetings>0)facts.push(activity.meetings+' recorded meeting '+(activity.meetings===1?'entry':'entries'));}
   const latest=connectionContext(graph,selected.id,relationship.memberId);
   if(!facts.length&&!latest.length)facts.push('Last contact not shared.');
   const block=element(doc,'article','sh-note');block.append(element(doc,'strong','',relationship.isMe?'Your connection':name(graph.members.find(m=>m.id===relationship.memberId))+'’s connection'));
   block.setAttribute('aria-label',relationship.isMe?'Your connection':name(graph.members.find(m=>m.id===relationship.memberId))+'’s connection');
   if(latest.length){
    block.append(element(doc,'small','sh-subtitle','Latest shared context · '+latest[0].date.slice(0,10)+' · '+latest[0].sourceLabel));
    if(latest[0].title)block.append(element(doc,'p','',latest[0].title));
    for(const item of latest)block.append(element(doc,'p','',item.summary));
   }else block.append(element(doc,'p','sh-subtitle','No conversation context shared for this connection yet.'));
   for(const fact of facts)block.append(element(doc,'p','',fact));root.append(block);
  }
  const privateContext=graph.viewerPrivateContext?.[selected.id]||[];
  if(privateContext.length){
   const section=element(doc,'section','sh-private-context');section.setAttribute('aria-label','Your private context');
   section.append(element(doc,'h2','','Your private context'),element(doc,'small','sh-subtitle','Only you can see this. Not shared with this network.'));
   for(const item of privateContext.slice(0,3)){const block=element(doc,'article','sh-note');if(item.title)block.append(element(doc,'strong','',item.title));block.append(element(doc,'p','',item.summary),element(doc,'small','',((item.sourceType||'').startsWith('gmail')?'Email':item.sourceType==='granola'?'Meeting notes':'Your source')+' · '+item.observedAt.slice(0,10)));section.append(block);}root.append(section);
  }
  const shown=new Set(card.relationships.flatMap(r=>connectionContext(graph,selected.id,r.memberId)).map(e=>e.ref));
  const allEvidence=personContext(graph,selected.id),evidence=allEvidence.filter(e=>!shown.has(e.ref));
  if(evidence.length){
   const more=element(doc,'details','sh-more');more.append(element(doc,'summary','','More shared context'));
   for(const e of evidence.slice(0,20)){const block=element(doc,'article','sh-note');block.append(element(doc,'p','',e.summary),element(doc,'small','',`${e.contributor} · ${e.date.slice(0,10)} · ${e.sourceLabel}`));more.append(block);}root.append(more);
  }
  if(!allEvidence.length&&card.relationships.some(r=>r.isMe)&&graph.workspaceId){const link=element(doc,'a','sh-back','Check my shared sources');link.href='/accounts?tab=workspace&workspace='+encodeURIComponent(graph.workspaceId);root.append(link);}
  if(onMerge){
   const duplicates=graph.nodes.filter(n=>n.id!==selected.id&&sharedHomePersonAllowed(n)&&n.name.trim().toLowerCase()===selected.name.trim().toLowerCase());
   const saved=selected.mergedProfiles||[];
   if(duplicates.length||saved.length){const section=element(doc,'details','sh-more');section.append(element(doc,'summary','','Duplicate profiles'));
    section.append(element(doc,'p','sh-subtitle','Combines profiles only in your view. Original records and sharing choices stay intact.'));
    const save=(source,target,control)=>{control.disabled=true;Promise.resolve(onMerge(source,target)).catch(()=>{control.disabled=false;message.textContent='Could not save this change. Please try again.';});};
    const message=element(doc,'p','sh-subtitle');message.setAttribute('role','status');
    for(const n of duplicates){const control=action(doc,'Combine with '+n.name+' · '+(n.company||'other profile'),()=>save(n.id,selected.id,control),'sh-back');section.append(control);}
    for(const n of saved){section.append(element(doc,'p','','Combined: '+n.name+' · '+n.company));const control=action(doc,'Undo merge · '+n.company,()=>save(n.id,null,control),'sh-back');section.append(control);}
    section.append(message);root.append(section);
   }
  }
  root.append(helperSection(doc,graph,selected.id,onFindHelpers));
  const viewerId=graph.members.find(m=>m.isMe)?.id;
  const alreadyInContacts=viewerId&&(selected.relationships||[]).some(r=>r.memberId===viewerId);
  if(onIntro&&!alreadyInContacts&&card?.routes?.length){const route=card.routes[0];root.append(action(doc,'Ask '+name(graph.members.find(m=>m.id===route.memberId))+' for an introduction',()=>onIntro(card,route.memberId),'sh-intro'));}
  return root;
 }
 root.append(element(doc,'h1','',sharedHomeTitle(graph)));
 const form=element(doc,'form','sh-search'),label=element(doc,'label','sh-search-field'),input=element(doc,'input');input.type='search';input.setAttribute('aria-label','Find a person or ask a question');input.placeholder='Find someone, or ask a question';input.value=query;input.maxLength=200;label.append(input);form.append(label,action(doc,'Search',()=>form.requestSubmit(),'sh-search-button'));form.onsubmit=e=>{e.preventDefault();e.stopPropagation();onSearch?.(input.value.trim());};form.onclick=e=>e.stopPropagation();form.oninput=e=>{e.stopPropagation();onQueryChange?.(input.value);};root.append(form);
 if(status){const message=element(doc,'p','sh-subtitle',status);message.setAttribute('role','status');root.append(message);}
 if(headerOnly){if(answer){root.append(action(doc,'Clear search',onClear,'sh-back'));if(!answer.results?.length)root.append(element(doc,'p','sh-subtitle','No matches. Try a name, company, or topic.'));}return root;}
 const data=sharedHomeRows(graph,answer);root.append(element(doc,'p','sh-subtitle',data.message));
 if(answer)root.append(action(doc,'Clear search',onClear,'sh-back'));
 const list=element(doc,'ul','sh-people');
 for(const row of data.rows){const li=element(doc,'li'),button=action(doc,'',()=>onPerson(row.person.id),'sh-person');const copy=element(doc,'span','sh-person-copy');copy.append(element(doc,'strong','',row.person.name),element(doc,'span','',row.reason));button.append(portrait(doc,row.person),copy,element(doc,'span','sh-arrow','→'));li.append(button);list.append(li);}
 root.append(list);return root;
}
