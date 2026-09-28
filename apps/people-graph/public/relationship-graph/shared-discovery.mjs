import {supportsIntroduction,scoreBacked} from './relationship-support.mjs';
import {contactCard,element,action,portrait} from './contact-sheet.mjs';
import {personWalk} from './person-walk.mjs';
import {sharedPathGraph} from './shared-paths.mjs';
const contact=supportsIntroduction;
const sources=new Set(['granola','granola_mention','obsidian_note','gmail_body_derived']);
export function sharedDiscoveries(graph,pairs=[],now=Date.now()){
 const self=graph.members?.find(m=>m.isMe);if(!self)return [];
 const known=new Set(graph.nodes.filter(p=>p.relationships?.some(r=>r.memberId===self.id&&contact(r))).map(p=>p.id));
 const themes=new Map((graph.themes||[]).map(t=>[t.id,t.name])),signals=new Map(),ownTopics=new Map();
 for(const s of graph.themeSignals||[]){if(!s.personId||!themes.has(s.themeId)||!sources.has(s.sourceType)||!s.summary||!Number.isFinite(Date.parse(s.observedAt))||Date.parse(s.observedAt)>now)continue;
  const key=themes.get(s.themeId).trim().toLowerCase();if(!signals.has(s.personId))signals.set(s.personId,[]);signals.get(s.personId).push({...s,topicKey:key,topicName:themes.get(s.themeId)});
  if(known.has(s.personId)&&String(s.evidenceRef).startsWith('workspace:'+self.id+':')){const prior=ownTopics.get(key);if(!prior||Date.parse(s.observedAt)>Date.parse(prior.observedAt))ownTopics.set(key,s);}
 }
 const paths=sharedPathGraph(graph),results=[];
 for(const person of graph.nodes){if(person.type!=='person'||known.has(person.id))continue;
  // contactCard applies the same identity and relationship rules used by intro requests.
  const card=contactCard(graph,person.id);if(!card?.routes.length)continue;
  const relevantSignals=(signals.get(person.id)||[]).filter(s=>ownTopics.has(s.topicKey)).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
  const topics=[...new Set(relevantSignals.map(s=>s.topicName))];
  const pair=pairs.find(p=>p.personIds?.includes(person.id)&&p.personIds.some(id=>known.has(id)));
  const relevant=Boolean(topics.length||pair),evidence=relevantSignals.slice(0,2).flatMap(s=>[ownTopics.get(s.topicKey),s]);
  results.push({person,card,routes:card.routes,topics,relevant,evidence,reason:topics.length?`Shared context in ${topics.join(', ')} connects this person to conversations with people you know.`:pair?pair.reason:'A contributor has recorded relationship evidence with this person. There is not enough shared context yet to explain a personal match.',pair,rank:topics.length*100+(pair?50:0)+(card.routes[0].score||0)*.5});
 }
 return results.sort((a,b)=>b.rank-a.rank||a.person.name.localeCompare(b.person.name)).slice(0,12).map(d=>({...d,walk:personWalk(graph,d.person.id,paths)}));
}
export function discoveryCards(doc,graph,pairs,{onWalk,onIntro}={}){
 const root=element(doc,'div','rg-discovery-people'),items=sharedDiscoveries(graph,pairs);
 if(!items.length){root.append(element(doc,'p','rg-copy','No supported introductions to new people yet. Contributors need to share a published relationship score, confirmation, two-way contact, or meeting evidence before we can offer an introduction.'));return root;}
 const relevant=items.filter(d=>d.relevant),available=items.filter(d=>!d.relevant);
 for(const [label,group]of [['Relevant to your shared context',relevant],['Other people you could ask to meet',available]]){
  if(!group.length)continue;root.append(element(doc,'h3','',label));
  for(const d of group.slice(0,4)){
   const card=element(doc,'article','rg-discovery-person'),head=element(doc,'div','rg-discovery-person-head');head.append(portrait(doc,d.person),element(doc,'h3','',d.person.name));card.append(head,element(doc,'p','rg-copy',d.reason));
   const route=d.routes[0],name=route.memberName.split('@')[0],hasWalk=d.walk.edges.length>0;
   const chain=element(doc,'div','rg-discovery-route');chain.setAttribute('aria-label',hasWalk?'Recorded path':'Introduction request route');
   if(hasWalk){d.walk.nodes.forEach((n,i)=>{if(i)chain.append(element(doc,'span','rg-discovery-hop',d.walk.edges[i-1].kind==='personal'?'→':'⇢'));chain.append(element(doc,'span','',n.memberId===graph.members.find(m=>m.isMe)?.id?'You':n.name));});}
   else{chain.append(element(doc,'span','','You'),element(doc,'span','rg-discovery-hop','ask →'),element(doc,'span','',name),element(doc,'span','rg-discovery-hop','→'),element(doc,'span','',d.person.name));}
   card.append(chain,element(doc,'p','rg-source',hasWalk?d.walk.message:'The first step is an intro request to your workspace teammate, not a claimed personal relationship.'));
   for(const r of d.routes)card.append(element(doc,'p','rg-source',`${r.memberName} · ${r.confirmedAt?'Confirmed relationship':scoreBacked(r)?'Published people score · '+r.observedAt?.slice(0,10):r.evidenceCategory==='meeting'?'Recorded meeting':r.activity?.sent&&r.activity?.received?'Two-way contact':'Recorded email contact'}${Number.isFinite(r.score)?(scoreBacked(r)?' · score ':' · activity ')+Math.round(r.score)+'/100':''}${r.lastContact?' · last contact '+r.lastContact.slice(0,10):''}`));
   if(d.evidence.length){const details=element(doc,'details');details.append(element(doc,'summary','','Why this match?'));const seen=new Set();for(const s of d.evidence){if(seen.has(s.id))continue;seen.add(s.id);const m=graph.members.find(m=>String(s.evidenceRef).startsWith('workspace:'+m.id+':'));details.append(element(doc,'p','rg-source',`${graph.nodes.find(n=>n.id===s.personId)?.name||'Person'} · ${m?.isMe?'Your context':m?.name||'Shared context'} · ${s.sourceType.replaceAll('_',' ')} · ${s.observedAt.slice(0,10)} — ${s.summary}`));}card.append(details);}
   card.append(action(doc,hasWalk?'Walk the path →':'Explore connection →',()=>onWalk(d.person.id),'rg-text-button'));
   if(onIntro)for(const r of d.routes)card.append(action(doc,'Ask '+r.memberName.split('@')[0]+' for an intro',()=>onIntro(d.card,r.memberId),'rg-discovery-intro'));
   root.append(card);
  }
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
