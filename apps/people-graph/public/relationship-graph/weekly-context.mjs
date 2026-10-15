import {supportsIntroduction} from './relationship-support.mjs';
import {element,action} from './contact-sheet.mjs';
const DAY=86400000;
const sources=new Set(['granola','granola_mention','obsidian_note','gmail_body_derived']);
const generic=new Set(['ai','business','technology','networking','people','meetings']);
const eligible=n=>n.type==='person'&&n.permission!=='denied'&&n.permission!=='conflicted'&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved'&&(!n.sources?.includes('obsidian')||n.identityMatchReady===true);
const label=m=>m.isMe?'you':m.name.split('@')[0];

// All inputs are the already-authorized shared snapshot. A contributor's own
// recent evidence supplies their inferred week; contact ownership alone cannot.
export function weeklyContext(graph,{now=Date.now(),excludedTopics=new Set()}={}){
 const members=graph.members||[],self=members.find(m=>m.isMe);
 const nodes=new Map((graph.nodes||[]).filter(eligible).map(n=>[n.id,n]));
 const themes=new Map((graph.themes||[]).map(t=>[t.id,String(t.canonicalName||t.name).trim()]));
 const relationships=n=>(n.relationships||[]).filter(r=>members.some(m=>m.id===r.memberId)&&supportsIntroduction(r));
 const validDate=(date,days)=>Number.isFinite(Date.parse(date))&&Date.parse(date)<=now&&Date.parse(date)>=now-days*DAY;
 const evidence=[];
 for(const signal of graph.themeSignals||[]){
  const person=nodes.get(signal.personId),topic=themes.get(signal.themeId);
  if((signal.personId&&!person)||!topic||generic.has(topic.toLowerCase())||signal.visibility!=='firm'||!sources.has(signal.sourceType)||!signal.summary||!validDate(signal.observedAt,90))continue;
  const member=members.find(m=>String(signal.evidenceRef||'').startsWith('workspace:'+m.id+':'));
  if(!member)continue;
  evidence.push({...signal,member,topic,key:topic.toLowerCase()});
 }
 evidence.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||a.id.localeCompare(b.id));
 const byPerson=new Map();
 for(const signal of evidence){const person=nodes.get(signal.personId);if(!person||!relationships(person).some(r=>r.memberId===signal.member.id))continue;const items=byPerson.get(signal.personId)||[];items.push(signal);byPerson.set(signal.personId,items);}
 const focus=members.map(member=>{
  const topics=new Map();
  for(const signal of evidence)if(signal.member.id===member.id&&validDate(signal.observedAt,7)&&!topics.has(signal.key))topics.set(signal.key,{key:signal.key,name:signal.topic,evidence:signal,excluded:member.isMe&&excludedTopics.has(signal.key)});
  return {member,topics:[...topics.values()].slice(0,6)};
 });
 const groups={mutual:[],forYou:[],forOthers:[]};
 if(!self)return {focus,groups};
 for(const person of nodes.values()){
  const personEvidence=byPerson.get(person.id)||[];
  const ties=relationships(person),own=ties.some(r=>r.memberId===self.id),others=ties.filter(r=>r.memberId!==self.id);
  if(own&&others.length){
   const shared=personEvidence.find(s=>validDate(s.observedAt,7));
   const recent=ties.filter(r=>validDate(r.lastContact,7)).sort((a,b)=>Date.parse(b.lastContact)-Date.parse(a.lastContact))[0];
   if(shared||recent){const contributor=shared?.member||members.find(m=>m.id===recent.memberId);groups.mutual.push({person,contributor,recipient:self,date:shared?.observedAt||recent.lastContact,evidence:shared?[shared]:[],reason:`Recorded connections to you and ${others.map(r=>label(members.find(m=>m.id===r.memberId))).join(', ')}. ${shared?'Recent shared context: '+shared.topic+'.':'Contact recorded in the last seven days.'}`});}
  }
  for(const week of focus){
   const recipient=week.member;
   if(ties.some(r=>r.memberId===recipient.id))continue;
   // Only show opportunities involving the viewer, in either direction.
   if(!recipient.isMe&&!own)continue;
   for(const topic of week.topics.filter(t=>!t.excluded)){
    const match=personEvidence.find(s=>s.member.id!==recipient.id&&topic.key===s.key&&(recipient.isMe||s.member.isMe));
    if(!match)continue;
    const item={person,contributor:match.member,recipient,date:topic.evidence.observedAt,evidence:[topic.evidence,match],reason:`${recipient.isMe?'Your':label(recipient)+'’s'} shared context this week includes ${topic.name}. ${match.member.isMe?'You':label(match.member)} shared matching context about ${person.name}.`};
    groups[recipient.isMe?'forYou':'forOthers'].push(item);break;
   }
  }
 }
 // Round-robin contributors/recipients so one larger network cannot take every slot.
 for(const key of Object.keys(groups)){
  const buckets=new Map();
  for(const item of groups[key].sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)||a.person.id.localeCompare(b.person.id))){const id=key==='forOthers'?item.recipient.id:item.contributor.id;const bucket=buckets.get(id)||[];bucket.push(item);buckets.set(id,bucket);}
  const result=[],used=new Set();
  while(result.length<3){let added=false;for(const bucket of buckets.values()){const item=bucket.shift();if(!item)continue;added=true;if(!used.has(item.person.id)){result.push(item);used.add(item.person.id);}if(result.length===3)break;}if(!added)break;}
  groups[key]=result;
 }
 return {focus,groups};
}

export function weeklyPanel(doc,graph,model,{onPerson,onToggleTopic,onReset}={}){
 const section=element(doc,'section','rg-weekly');section.setAttribute('aria-label','Your shared week');
 section.append(element(doc,'p','rg-source','The last 7 days · Inferred from shared context, not a confirmed plan.'));
 const focus=element(doc,'details','rg-weekly-focus');focus.append(element(doc,'summary','','What this week is based on'));
 focus.append(element(doc,'p','rg-source','Topics come from each person’s shared notes and meeting context. Uncheck a topic to exclude it from your recommendations for this session. These adjustments are not shared or saved.'));
 for(const entry of model.focus){
  const row=element(doc,'div','rg-weekly-topics');row.append(element(doc,'strong','',entry.member.isMe?'Your inferred topics':label(entry.member)+'’s inferred topics'));
  if(!entry.topics.length)row.append(element(doc,'span','rg-source','Not enough shared topic context in the last seven days.'));
  for(const topic of entry.topics){
   if(entry.member.isMe){const choice=element(doc,'label','rg-weekly-topic'),input=element(doc,'input');input.type='checkbox';input.checked=!topic.excluded;input.setAttribute('aria-label','Include '+topic.name+' in my week');input.onchange=()=>onToggleTopic?.(topic.key,!input.checked);choice.append(input,doc.createTextNode(topic.name));row.append(choice);}
   else row.append(element(doc,'span','rg-weekly-topic',topic.name));
  }
  focus.append(row);
 }
 focus.append(action(doc,'Reset my topic adjustments',()=>onReset?.(),'rg-text-button'));section.append(focus);
 const columns=element(doc,'div','rg-weekly-columns');
 for(const [key,title,empty] of [['mutual','People you share','No shared contacts with recent activity in the available records.'],['forYou','Relevant to your week','No supported matches from another member’s network for your inferred week yet.'],['forOthers','People you could help with','No supported matches from your network for another member’s inferred week yet.']]){
  const column=element(doc,'section','rg-weekly-group');column.setAttribute('aria-label',title);column.append(element(doc,'h3','',title));
  if(!model.groups[key].length)column.append(element(doc,'p','rg-source',empty));
  for(const item of model.groups[key]){
   const card=element(doc,'article','rg-weekly-card');card.append(action(doc,item.person.name,()=>onPerson?.(item.person.id),'rg-weekly-person'),element(doc,'p','',item.reason));
   if(key==='forOthers')card.append(element(doc,'small','rg-source','For '+label(item.recipient)));
   const details=element(doc,'details');details.append(element(doc,'summary','','Why this person?'));
   for(const evidence of item.evidence){const person=graph.nodes.find(n=>n.id===evidence.personId);details.append(element(doc,'p','rg-source',`${label(evidence.member)} · ${person?.name||'Shared context'} · ${evidence.observedAt.slice(0,10)} · ${evidence.sourceType.replaceAll('_',' ')} — ${evidence.summary}`));}
   if(!item.evidence.length)details.append(element(doc,'p','rg-source',`${label(item.contributor)} · Last recorded contact ${item.date.slice(0,10)}`));
   if(key!=='mutual')details.append(element(doc,'p','rg-source','A topic match in shared records. Current interest and willingness to connect are not confirmed.'));
   card.append(details);column.append(card);
  }
  columns.append(column);
 }
 section.append(columns);return section;
}
