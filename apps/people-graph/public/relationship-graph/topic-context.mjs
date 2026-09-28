import {personContext,conversationRecaps,recapBlock,contextBlock,element,action,portrait} from './contact-sheet.mjs';

// Read only the already-authorized graph, and only signals belonging to this topic.
export function topicContext(graph,topic,now=Date.now()) {
 const ids=new Set(topic.themeIds||[topic.themeId]),peopleIds=new Set(topic.nodeIds);
 const scoped={...graph,themeSignals:(graph.themeSignals||[]).filter(s=>ids.has(s.themeId)&&peopleIds.has(s.personId)&&Date.parse(s.observedAt)<=now)};
 const people=graph.nodes.filter(n=>peopleIds.has(n.id)).map(person=>({...person,evidence:personContext(scoped,person.id)}))
  .sort((a,b)=>Date.parse(b.evidence[0]?.date||0)-Date.parse(a.evidence[0]?.date||0)||a.name.localeCompare(b.name));
 const seen=new Set(),evidence=[];
 for(const person of people)for(const item of person.evidence){const key=JSON.stringify([item.contributor,item.sourceType,item.date,item.title,item.summary]);if(!seen.has(key)){seen.add(key);evidence.push(item);}}
 evidence.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
 return {people,evidence,recaps:conversationRecaps(evidence,now),latestDate:evidence[0]?.date||null};
}

export function topicPanel(doc,graph,topic,{onClose,onPerson}={}) {
 const data=topicContext(graph,topic),panel=element(doc,'aside','rg-topic-detail');
 panel.setAttribute('aria-label',topic.name+' topic context');panel.tabIndex=-1;
 const close=action(doc,'×',onClose,'rg-topic-close');close.setAttribute('aria-label','Close topic context');
 panel.append(close,element(doc,'small','rg-source','SHARED TOPIC'),element(doc,'h2','',topic.name));
 panel.append(element(doc,'p','rg-source',`${data.people.length} ${data.people.length===1?'person':'people'} with shared topic evidence · ${data.recaps.length} recorded ${data.recaps.length===1?'conversation':'conversations'}`));
 panel.append(element(doc,'p','rg-source',data.latestDate?'Latest shared record · '+data.latestDate.slice(0,10):'No dated shared context available.'));
 panel.append(element(doc,'h3','','Where the conversation left off'));
 if(data.recaps.length){panel.append(recapBlock(doc,data.recaps[0],graph.workspaceId));
  if(data.recaps.length>1){const earlier=element(doc,'details','rg-topic-earlier');earlier.append(element(doc,'summary','',`Earlier conversations · ${data.recaps.length-1}`));for(const recap of data.recaps.slice(1))earlier.append(recapBlock(doc,recap,graph.workspaceId));panel.append(earlier);}
 }else panel.append(element(doc,'p','rg-source','No shared meeting recap for this topic yet. Other shared records appear below.'));
 panel.append(element(doc,'p','rg-source','This is the latest context shared with this network, not a live transcript. Later private conversations and completed follow-ups may not be reflected.'));
 panel.append(element(doc,'h3','','People in this topic'));
 for(const person of data.people){const button=action(doc,'',()=>onPerson?.(person.id),'rg-topic-person');button.append(portrait(doc,person),element(doc,'span','',person.name),element(doc,'small','rg-source',person.evidence[0]?'Last topic record · '+person.evidence[0].date.slice(0,10):'No dated record'));panel.append(button);}
 const other=data.evidence.filter(e=>e.sourceType!=='granola');if(other.length){const sources=element(doc,'details');sources.append(element(doc,'summary','','Other topic sources · '+other.length));for(const e of other)sources.append(contextBlock(doc,e));panel.append(sources);}
 return panel;
}

// FLIP the surviving photographs from their actual previous screen positions.
// New nodes emerge nearby; the edges drawn remain recorded graph edges only.
export function animateTopicCluster(root,previous,reducedMotion=false){
 const nodes=[...root.querySelectorAll('.rg-canvas .rg-node')];
 if(reducedMotion)return;
 const scale=Number(root.querySelector('.rg-canvas')?.style.getPropertyValue('--map-scale'))||1;
 nodes.forEach((node,index)=>{const next=node.getBoundingClientRect(),old=previous.get(node.dataset.nodeId);
  const dx=old?(old.x+old.width/2-next.x-next.width/2)/scale:Math.cos(index*2.4)*110;
  const dy=old?(old.y+old.height/2-next.y-next.height/2)/scale:Math.sin(index*2.4)*110;
  node.animate([{transform:`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`,opacity:old?1:0},{transform:'translate(-50%,-50%)',opacity:1}],{duration:650,delay:Math.min(index*30,150),easing:'cubic-bezier(.22,.7,.2,1)'});
 });
 root.querySelectorAll('.rg-canvas svg,.rg-community-label').forEach(el=>el.animate([{opacity:0},{opacity:1}],{duration:500,delay:200}));
}
