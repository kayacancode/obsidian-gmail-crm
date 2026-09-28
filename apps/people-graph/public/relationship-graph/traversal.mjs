import {element,action,portrait,contextBlock} from './contact-sheet.mjs';
import {personWalk} from './person-walk.mjs';
import {sharedPathGraph} from './shared-paths.mjs';
export function mountTraversal(root,{graph,query,onOpen}){
 const doc=root.ownerDocument,events=[],paths=sharedPathGraph(graph),colors=['#2563b8','#a53e70','#25836c','#a66b16','#7254ad','#b24e32','#307d91','#68782e','#8b4b42','#5963a5','#a12840','#287355','#654295','#9c712a','#337091','#7a5b3e','#993b85','#53733a','#365e75','#73603d'],ownerIds=[...new Set(graph.nodes.flatMap(n=>(n.relationships||[]).map(r=>r.memberId)))].sort();
 let cursor=-1,paused=false,finished=false,timer=null,dead=false,answer=null;
 root.className='nc-traversal';root.setAttribute('aria-label','Shared network search traversal');
 const heading=element(doc,'div','nc-traversal-head');heading.append(element(doc,'h2','','Follow the answer'),element(doc,'p','',query));root.append(heading);
 const status=element(doc,'p','nc-muted');status.setAttribute('role','status');root.append(status);
 const controls=element(doc,'nav','nc-traversal-controls');controls.setAttribute('aria-label','Traversal playback');
 const toggle=action(doc,'Pause',()=>{paused=!paused;if(paused)stop();else schedule();render();});
 const step=action(doc,'Step',()=>{paused=true;stop();advance();});
 const replay=action(doc,'Replay',()=>{stop();cursor=-1;paused=false;schedule();render();});
 controls.append(toggle,step,replay,element(doc,'small','nc-muted','Pause controls the visualization; the search continues.'));root.append(controls);
 const lanes=element(doc,'div','nc-agent-lanes');
 for(const [i,m]of (graph.members||[]).entries()){const lane=element(doc,'span','nc-agent-lane',(m.isMe?'You':m.name)+' · shared-context search');lane.dataset.memberId=m.id;lane.style.setProperty('--lane-color',colors[Math.max(0,ownerIds.indexOf(m.id))%colors.length]);lanes.append(lane);}root.append(lanes);
 const stage=element(doc,'div','nc-traversal-stage'),trail=element(doc,'ol','nc-traversal-log'),results=element(doc,'div','nc-traversal-results');root.append(stage,trail,results);
 function stop(){if(timer!==null)clearTimeout(timer);timer=null;}
 function schedule(){if(dead||paused||timer!==null||cursor>=events.length-1)return;timer=setTimeout(()=>{timer=null;advance();schedule();},doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches?1500:1000);}
 function advance(){if(cursor<events.length-1)cursor++;render();}
 function route(personId){const walk=personWalk(graph,personId,paths);if(!walk)return;
  const area=element(doc,'div','nc-traversal-route');area.setAttribute('aria-label','Recorded graph route');
  walk.nodes.forEach((node,i)=>{if(i){const edge=walk.edges[i-1],link=element(doc,'span','nc-traversal-edge',edge.confirmedAt?'Confirmed':edge.kind==='personal'?(edge.scoreBacked?'Score-backed relationship':'Recorded contact'):'Inferred · verify');link.dataset.kind=edge.kind;area.append(link);}
   const b=action(doc,'',()=>{if(!node.memberId)onOpen?.(node.id);});b.className='nc-traversal-node';b.append(portrait(doc,node.memberId?{...node,name:node.name.split(' (')[0]}:node),element(doc,'strong','',node.memberId?node.name.split(' (')[0]:node.name));b.disabled=Boolean(node.memberId);b.dataset.current=String(i===walk.nodes.length-1);area.append(b);
  });stage.append(area,element(doc,'p','nc-muted',walk.message));
 }
 function render(){if(dead)return;toggle.textContent=paused?'Live / Play':'Pause';step.disabled=cursor>=events.length-1;replay.disabled=!events.length;
  status.textContent=(finished?'Search complete · '+(paused?'paused':'recorded playback'):paused?'Live search · visualization paused':'Live search')+' · '+Math.max(0,cursor+1)+' / '+events.length+' events';
  const event=events[cursor];stage.replaceChildren();for(const lane of lanes.children)lane.dataset.active=String(lane.dataset.memberId===event?.memberId);
  if(!event)stage.append(element(doc,'p','','Checking shared-network access…'));
  else{stage.append(element(doc,'h3','',event.type==='candidate'?'Candidate found':event.label||'Search update'));
   if(event.type==='scope')stage.append(element(doc,'p','',event.people+' shared profiles searched · '+event.matches+' keyword candidates'));
   if(event.reason)stage.append(element(doc,'p','',event.reason));
   if(event.type==='start')stage.append(element(doc,'p','',event.people+' people available · '+event.unavailable+' sources unavailable'));
   if(event.personId){route(event.personId);for(const e of event.evidence||[])stage.append(contextBlock(doc,{...e,date:e.observedAt,sourceLabel:'Shared context inspected',contributor:event.label,url:null}));stage.append(action(doc,'Open person, memory and introduction options →',()=>onOpen?.(event.personId),'nc-text'));}
  }
  trail.replaceChildren();events.slice(0,cursor+1).forEach((e,i)=>{const b=action(doc,(e.label||e.type)+(e.personId?' → '+(graph.nodes.find(n=>n.id===e.personId)?.name||'Person'):''),()=>{paused=true;stop();cursor=i;render();});b.setAttribute('aria-current',i===cursor?'step':'false');const li=element(doc,'li');li.append(b);trail.append(li);});
 }
 return {push(event){if(dead)return;if(event.type==='result'){answer=event.answer;finished=true;results.replaceChildren(element(doc,'h3','',answer.results.length?'People to explore':'No supported matches yet'));for(const result of answer.results){const person=graph.nodes.find(n=>n.id===result.personId);if(!person)continue;const b=action(doc,'',()=>onOpen?.(person.id),'nc-traversal-result');b.append(portrait(doc,person),element(doc,'strong','',person.name),element(doc,'small','nc-muted',result.reasons?.[0]?.summary||'Profile relevance · inspect context'));results.append(b);}results.append(element(doc,'p','nc-muted',answer.checked?'Relevance checked by Jev. Matching context does not confirm a relationship.':'Keyword ranking. Matching context does not confirm a relationship.'));render();return;}
   if(events.length>=100)return;events.push(event);if(cursor<0&&!paused)advance();schedule();if(paused)render();},fail(message){stop();finished=true;paused=true;events.length=0;cursor=-1;stage.replaceChildren(element(doc,'p','',message));trail.replaceChildren();results.replaceChildren();status.textContent='Search stopped · retry to check current access';},destroy(){dead=true;stop();root.remove();}};
}
