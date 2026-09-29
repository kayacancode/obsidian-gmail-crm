import {supportsIntroduction,scoreBacked} from './relationship-support.mjs';
import {contactCard,element,action,portrait} from './contact-sheet.mjs';
import {personWalk} from './person-walk.mjs';
import {sharedPathGraph} from './shared-paths.mjs';
const contact=supportsIntroduction;
const sources=new Set(['granola','granola_mention','obsidian_note','gmail_body_derived']);
export function sharedDiscoveries(graph,pairs=[],now=Date.now(),intent=''){
 const stop=new Set('who can could should help with the and for from about what doing working organizing event want need someone people talk meet find based your our this that'.split(' '));
 const tokens=t=>[...new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!stop.has(w)&&w.length>1))];
 const queryWords=tokens(intent);
 const goalMatch=s=>{const words=new Set(tokens(s.topicName+' '+s.summary));return queryWords.filter(w=>words.has(w)).length>=Math.min(2,queryWords.length)&&queryWords.length>0;};
 const self=graph.members?.find(m=>m.isMe);if(!self)return [];
 const known=new Set(graph.nodes.filter(p=>p.relationships?.some(r=>r.memberId===self.id&&contact(r))).map(p=>p.id));
 const themes=new Map((graph.themes||[]).map(t=>[t.id,t.name])),signals=new Map(),ownTopics=new Map();
 for(const s of graph.themeSignals||[]){if(!s.personId||!themes.has(s.themeId)||!sources.has(s.sourceType)||!s.summary||!Number.isFinite(Date.parse(s.observedAt))||Date.parse(s.observedAt)>now)continue;
  const key=themes.get(s.themeId).trim().toLowerCase();if(!signals.has(s.personId))signals.set(s.personId,[]);signals.get(s.personId).push({...s,topicKey:key,topicName:themes.get(s.themeId)});
  if(known.has(s.personId)&&String(s.evidenceRef).startsWith('workspace:'+self.id+':')){const prior=ownTopics.get(key);if(!prior||Date.parse(s.observedAt)>Date.parse(prior.observedAt))ownTopics.set(key,s);}
 }
 let paths;const results=[];
 for(const person of graph.nodes){if(person.type!=='person'||known.has(person.id))continue;
  // contactCard applies the same identity and relationship rules used by intro requests.
  const card=contactCard(graph,person.id);if(!card?.routes.length)continue;
  const relevantSignals=(signals.get(person.id)||[]).filter(s=>intent.trim()?goalMatch(s):ownTopics.has(s.topicKey)).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
  const topics=[...new Set(relevantSignals.map(s=>s.topicName))];
  const pair=!intent.trim()&&pairs.find(p=>p.personIds?.includes(person.id)&&p.personIds.some(id=>known.has(id))&&p.evidence?.some(e=>e.personId===person.id&&e.summary&&sources.has(e.source)&&Date.parse(e.date)<=now));
  const relevant=Boolean(topics.length||pair),evidence=relevantSignals.slice(0,2).flatMap(s=>intent.trim()?[s]:[ownTopics.get(s.topicKey),s]);
  results.push({person,card,routes:card.routes,topics,relevant,evidence,reason:intent.trim()&&topics.length?`Shared evidence matches your goal: ${intent.trim()}`:topics.length?`Shared context in ${topics.join(', ')} connects this person to conversations with people you know.`:pair?pair.reason:'A contributor has recorded relationship evidence with this person. There is not enough shared context yet to explain a personal match.',pair,rank:topics.length*100+(pair?50:0)+(card.routes[0].score||0)*.5});
 }
 return results.sort((a,b)=>b.rank-a.rank||a.person.name.localeCompare(b.person.name)).map(d=>({...d,get walk(){return personWalk(graph,d.person.id,paths??=sharedPathGraph(graph));}}));
}
export function discoveryCards(doc,graph,pairs,{onWalk,onIntro,intent=''}={}){
 const root=element(doc,'div','rg-discovery-people'),items=sharedDiscoveries(graph,pairs,Date.now(),intent);
 const relevant=items.filter(d=>d.relevant),available=items.filter(d=>!d.relevant);
 const evidenceLine=s=>`${graph.nodes.find(n=>n.id===s.personId)?.name||'Person'} · ${String(s.sourceType||s.source).replaceAll('_',' ')} · ${String(s.observedAt||s.date).slice(0,10)}${s.provenance?.title?' · '+s.provenance.title:''} — ${s.summary}`;
 const appendActions=(card,d)=>{
  if(onIntro)for(const r of d.routes)card.append(action(doc,'Ask '+r.memberName.split('@')[0]+' for an intro',()=>onIntro(d.card,r.memberId),'rg-discovery-intro'));
  card.append(action(doc,'Walk the path →',()=>onWalk?.(d.person.id),'rg-text-button'));
 };
 if(relevant.length)root.append(element(doc,'h3','',intent.trim()?'People for your goal':'Relevant to your shared context'));
 else root.append(element(doc,'p','rg-copy',(intent.trim()?'No supported matches for “'+intent.trim()+'” in the shared context. Try a more specific topic. ':'No context-backed matches yet. ')+'Shared relationship scores can help you find an introducer, but don’t explain why you should meet. Browse the connections below, or share meeting topics and context to find relevant matches.'));
 for(const d of relevant.slice(0,6)){
  const card=element(doc,'article','rg-discovery-person'),head=element(doc,'div','rg-discovery-person-head');head.append(portrait(doc,d.person),element(doc,'h3','',d.person.name));card.append(head);if(d.person.company)card.append(element(doc,'p','rg-source',d.person.company));
  card.append(element(doc,'h4','','A conversation to explore'),element(doc,'p','rg-copy',intent.trim()?`Ask about ${d.topics.join(' and ')} in relation to your goal: ${intent.trim()}`:d.topics.length?`Compare perspectives on ${d.topics.join(' and ')} — a topic present in both your shared context and theirs.`:d.pair.reason));
  card.append(element(doc,'h4','','Why this person?'));
  const evidence=d.evidence.length?d.evidence:d.pair.evidence;
  for(const s of [...new Map(evidence.map(s=>[s.id||s.personId+':'+s.date+':'+s.summary,s])).values()].slice(0,4))card.append(element(doc,'p','rg-source',evidenceLine(s)));
  card.append(element(doc,'p','rg-source',intent.trim()?'Topic keyword match in shared records. Suggested conversation; current interest is not confirmed.':'Suggested conversation based on shared records; current interest is not confirmed.'));
  appendActions(card,d);
  const details=element(doc,'details');details.append(element(doc,'summary','','Why this introducer?'));
  for(const r of d.routes)details.append(element(doc,'p','rg-source',`${r.memberName} · ${r.confirmedAt?'Confirmed relationship':scoreBacked(r)?'Published people score':'Recorded contact'}${Number.isFinite(r.score)?' · '+Math.round(r.score)+'/100':''}${r.lastContact?' · last contact '+r.lastContact.slice(0,10):''}`));
  card.append(details);root.append(card);
 }
 for(const member of graph.members||[]){
  const group=available.filter(d=>d.routes.some(r=>r.memberId===member.id));if(!group.length)continue;
  const name=member.name.split('@')[0],browse=element(doc,'details','rg-discovery-browse');browse.append(element(doc,'summary','',`Browse ${name}’s connections · ${group.length}`));
  browse.append(element(doc,'p','rg-source','People with a shared relationship record, without enough context for a personal recommendation.'));
  const label=element(doc,'label','',`Search ${name}’s connections`),input=element(doc,'input');input.type='search';input.placeholder='Name or company';label.append(input);browse.append(label);
  const status=element(doc,'p','rg-source'),list=element(doc,'div');status.setAttribute('role','status');browse.append(status,list);
  const render=()=>{const q=input.value.trim().toLowerCase(),matches=group.filter(d=>(d.person.name+' '+(d.person.company||'')).toLowerCase().includes(q));list.replaceChildren();status.textContent=`${matches.length} connections${matches.length>12?' · showing first 12; search to narrow':''}`;
   for(const d of matches.slice(0,12)){const row=element(doc,'article','rg-discovery-connection'),head=element(doc,'div','rg-discovery-person-head');head.append(portrait(doc,d.person),element(doc,'h4','',d.person.name));row.append(head);appendActions(row,{person:d.person,card:d.card,routes:d.routes.filter(r=>r.memberId===member.id)});list.append(row);}
  };
  input.addEventListener('input',e=>{e.stopPropagation();render();});browse.addEventListener('click',e=>e.stopPropagation());browse.addEventListener('toggle',()=>{if(browse.open&&!list.childElementCount)render();});root.append(browse);
 }
 return root;
}

export function relationshipReadiness(graph){
 const self=graph.members?.find(m=>m.isMe),known=new Set(graph.nodes.filter(p=>p.relationships?.some(r=>r.memberId===self?.id&&contact(r))).map(p=>p.id));
 return (graph.members||[]).map(member=>{
  const people=graph.nodes.filter(p=>p.relationships?.some(r=>r.memberId===member.id));let supported=0,newPeople=0,needsIdentity=0,needsReview=0;
  for(const p of people){if(p.sources?.includes('obsidian')&&!p.identityMatchReady){needsIdentity++;continue;}if(p.relationships.some(r=>r.memberId===member.id&&contact(r))){supported++;if(!known.has(p.id))newPeople++;}else needsReview++;}
  return {member,people,shared:people.length,supported,newPeople,needsIdentity,needsReview};
 });
}
export function readinessPanel(doc,graph,onPerson){
 const section=element(doc,'section','rg-intro-readiness');section.setAttribute('aria-label','Shared relationship readiness');section.append(element(doc,'h3','','Make more introductions possible'));
 for(const item of relationshipReadiness(graph)){
  const row=element(doc,'article','rg-readiness-member'),name=item.member.isMe?'You':item.member.name;
  row.append(element(doc,'strong','',name),element(doc,'p','rg-source',`${item.shared} people shared · ${item.supported} supported relationships${item.member.isMe?'':' · '+item.newPeople+' new to your recorded network'}`));
  if(item.needsIdentity)row.append(element(doc,'p','rg-source',`${item.needsIdentity} records need a fresh vault snapshot to match identities.`));
  if(item.needsReview)row.append(element(doc,'p','rg-source',`${item.needsReview} records lack a published relationship score, confirmation, two-way contact, or meeting evidence.`));
  const web=graph.sourceCoverage?.find(c=>c.memberId===item.member.id&&c.source==='web');if(web?.included===0)row.append(element(doc,'p','rg-source','No Gmail / Granola contacts are included from this contributor.'));
  if(item.member.isMe){
   const review=element(doc,'details','rg-review-connections');review.append(element(doc,'summary','','Review my connections'));
   review.append(element(doc,'p','rg-source','Open a person to confirm that you know them, or exclude your contribution if you don’t. Each choice is yours; imported names are never confirmed automatically.'));
   const label=element(doc,'label','','Find one of my shared contacts'),input=element(doc,'input');input.type='search';input.placeholder='Name or company';label.append(input);review.append(label);
   const list=element(doc,'div'),status=element(doc,'p','rg-source');status.setAttribute('role','status');review.append(status,list);
   const people=[...item.people].sort((a,b)=>Number(contact(a.relationships.find(r=>r.memberId===item.member.id)))-Number(contact(b.relationships.find(r=>r.memberId===item.member.id)))||a.name.localeCompare(b.name));
   const render=()=>{const q=input.value.trim().toLowerCase(),matches=people.filter(p=>(p.name+' '+p.company).toLowerCase().includes(q));list.replaceChildren();status.textContent=`${matches.length} contacts${matches.length>20?' · showing first 20; search to narrow':''}`;for(const p of matches.slice(0,20)){const b=action(doc,p.name,()=>onPerson(p.id),'rg-review-person');list.append(b);}};
   input.addEventListener('input',e=>{e.stopPropagation();render();});review.addEventListener('click',e=>e.stopPropagation());render();row.append(review);
   const settings=element(doc,'a','rg-text-button','Manage my sources and sharing →');settings.href='/accounts?tab=workspace&workspace='+encodeURIComponent(graph.workspaceId);row.append(settings);
  }else if(!item.supported)row.append(element(doc,'p','rg-source','This contributor can publish a current vault snapshot containing their people scores, connect and share their own Gmail / Granola source, or confirm people they know from “Review my connections” in their Discover view.'));
  section.append(row);
 }
 return section;
}
