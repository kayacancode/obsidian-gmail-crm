const sourceNames={granola:'Meeting context',granola_mention:'Mention in meeting notes',obsidian_note:'Note mention',gmail_body_derived:'Email context',gmail_subject:'Email subject',calendar:'Calendar event'};
export function contactCard(graph,personId,answer){
 const person=graph.nodes.find(n=>n.id===personId);if(!person)return null;
 const self=graph.members?.find(m=>m.isMe)?.id;
 const ready=!person.sources?.includes('obsidian')||person.identityMatchReady===true;
 const evidence=(graph.themeSignals||[]).filter(s=>s.personId===personId&&s.id&&s.summary&&Number.isFinite(Date.parse(s.observedAt))).slice(0,20).map(s=>({ref:s.id,summary:s.summary,date:s.observedAt,sourceType:s.sourceType,title:s.provenance?.title||''}));
 const relationships=(person.relationships||[]).map(r=>({...r,isMe:r.memberId===self,memberName:graph.members?.find(m=>m.id===r.memberId)?.name||r.memberName||'Contributor'})).sort((a,b)=>Number(b.isMe)-Number(a.isMe)||(b.score??-1)-(a.score??-1));
 return {person,relationships,identityPending:!ready,contributors:(graph.members||[]).filter(m=>person.relationships?.some(r=>r.memberId===m.id)),relationshipUnverified:!(person.relationships||[]).some(r=>['email','meeting'].includes(r.evidenceCategory)),query:answer?.query||'',reasons:answer?.results?.find(p=>p.personId===personId)?.reasons||[],evidence,novelty:person.relationships?.some(r=>(r.evidenceCategory==='email'||r.evidenceCategory==='meeting')&&r.memberId===self)?'recorded_contact':'no_recorded_direct_contact',routes:ready?(person.relationships||[]).filter(r=>(r.evidenceCategory==='email'||r.evidenceCategory==='meeting')&&r.memberId!==self&&graph.members?.some(m=>m.id===r.memberId)).map(r=>({...r,memberName:graph.members.find(m=>m.id===r.memberId).name})).sort((a,b)=>(b.score??-1)-(a.score??-1)):[]};
}
export function element(doc,tag,className='',text){const el=doc.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;}
export function action(doc,label,fn,className=''){const el=element(doc,'button',className,label);el.type='button';el.addEventListener('click',fn);return el;}
export function portrait(doc,person,className=''){const wrap=element(doc,'span','nc-portrait '+className,(person.name||'?').split(/\s+/).slice(0,2).map(x=>x[0]).join(''));if(person.photoUrl){const image=element(doc,'img');image.src=person.photoUrl;image.alt='';image.referrerPolicy='no-referrer';image.onerror=()=>image.remove();wrap.append(image);}return wrap;}
export function mountContactSheet(container,{onClose,onSelectStep,onRequestIntro,companion}={}){
 const doc=container.ownerDocument,previous=doc.activeElement;let card,step='person';
 const panel=element(doc,'section','nc-sheet');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Person and introduction route');container.append(panel);
 function render(){if(!card)return;panel.replaceChildren();const top=element(doc,'div','nc-top');top.append(element(doc,'span','nc-muted',card.query?'Your network’s answer':'A connection in context'),action(doc,'×',close,'nc-close'));top.lastElementChild.setAttribute('aria-label','Close person sheet');panel.append(top);
 const tabs=element(doc,'nav','nc-steps');tabs.setAttribute('aria-label','Connection walk');for(const [id,label]of [['person','Person'],['route','Route'],['evidence','Memory']]){const b=action(doc,label,()=>api.setStep(id));b.setAttribute('aria-pressed',String(step===id));tabs.append(b);}panel.append(tabs);
 const identity=element(doc,'div','nc-identity');identity.append(portrait(doc,card.person,'nc-hero'));const title=element(doc,'div');title.append(element(doc,'h2','',card.person.name),element(doc,'p','nc-muted',[card.person.role,card.person.company].filter(Boolean).join(' · ')));identity.append(title);panel.append(identity);
 if(step==='person'){
  panel.append(element(doc,'p','nc-status',card.novelty==='recorded_contact'?'You have recorded contact':card.relationshipUnverified?'Relationship not yet verified':'No direct contact found in shared data'));
  if(card.query)panel.append(element(doc,'p','nc-query','For: '+card.query));
  const reasons=card.reasons.length?card.reasons:card.evidence.slice(0,1);
  panel.append(element(doc,'p','nc-reason',reasons[0]?.summary||'Explore the recorded relationships and shared context behind this person.'));
  if(reasons[0])panel.append(element(doc,'p','nc-muted','Recorded context · '+(reasons[0].date||reasons[0].observedAt||'').slice(0,10)));
 }
 if(step==='evidence'){
  panel.append(element(doc,'h3','','Supporting memory'));
  if(!card.evidence.length)panel.append(element(doc,'p','nc-muted','No shared meeting or note context is available for this person.'));
  for(const e of card.evidence){const item=element(doc,'article','nc-memory');item.append(element(doc,'small','nc-muted',`${sourceNames[e.sourceType]||e.sourceType} · ${e.date.slice(0,10)}`),element(doc,'p','',e.summary));if(e.title)item.append(element(doc,'small','nc-muted',e.title));panel.append(item);}
 }
 if(step==='route'||step==='person'){
  panel.append(element(doc,'h3','','Relationship strength by contributor'));
  for(const r of card.relationships||[]){
   const row=element(doc,'article','nc-relationship');row.append(element(doc,'strong','',r.isMe?'You':r.memberName));
   const measured=['email','meeting'].includes(r.evidenceCategory)&&Number.isFinite(r.score);
   row.append(element(doc,'p','',measured?Math.round(r.score)+' / 100 · measured activity':'Not measured in shared data'));
   if(measured){const meter=element(doc,'meter');meter.min=0;meter.max=100;meter.value=r.score;meter.setAttribute('aria-label',(r.isMe?'Your':r.memberName+'’s')+' relationship activity');row.append(meter);}
   row.append(element(doc,'small','nc-muted',(r.evidenceCategory==='email'?'Email contact':r.evidenceCategory==='meeting'?'Meeting activity':'Vault record · contact evidence unavailable')+(r.lastContact?' · Last contact '+r.lastContact.slice(0,10):'')));
   if(r.activity)row.append(element(doc,'small','nc-muted',r.activity.sent+' sent · '+r.activity.received+' received · '+r.activity.meetings+' accepted calendar events'));
   if(r.observedAt)row.append(element(doc,'small','nc-muted','Updated '+r.observedAt.slice(0,10)));
   panel.append(row);
  }

  for(const route of card.routes){const row=element(doc,'div','nc-via');row.append(element(doc,'strong','','Through '+route.memberName),element(doc,'small','nc-muted',`${Number.isFinite(route.score)?Math.round(route.score)+' / 100 measured activity':'Activity not measured'}${route.lastContact?' · '+route.lastContact.slice(0,10):''}`));const ask=action(doc,'Ask '+route.memberName+' for an intro',()=>onRequestIntro?.(card,route.memberId),step==='person'?'nc-primary':'');ask.disabled=!onRequestIntro;row.append(ask);panel.append(row);if(step==='person')break;}
  if(!card.routes.length){const known=element(doc,'section','nc-memory');known.append(element(doc,'h3','','Connection details'));
   if(card.contributors?.length)known.append(element(doc,'p','','Shared by '+card.contributors.map(m=>m.name).join(', ')));
   if(card.identityPending)known.append(element(doc,'p','','This older vault record cannot yet be matched with the same person in other members’ networks. The contributor needs to publish a fresh vault snapshot with plugin 0.9.4 or later.'));
   known.append(element(doc,'p','',card.relationshipUnverified?'This shared record does not include verified contact evidence. Being in someone’s vault does not establish that they know this person.':'No supported introduction route through another member is available in the current shared data.'));
   if(card.identityPending)known.append(element(doc,'small','nc-muted','A fresh snapshot enables identity matching; a route also needs recorded relationship evidence.'));
   panel.append(known);
  }
  panel.append(element(doc,'small','nc-muted','Recorded contact is not a measure of closeness or willingness to introduce.'));
 }
 if(step==='person'){panel.append(action(doc,'See route and relationship evidence →',()=>api.setStep('route'),'nc-text'),action(doc,'Why this person? →',()=>api.setStep('evidence'),'nc-text'));}
 }
 function close(){api.destroy();onClose?.();if(previous?.isConnected)previous.focus();}
 const key=e=>{if(e.key==='Escape'){e.stopPropagation();close();}if(e.key==='Tab'&&doc.defaultView.matchMedia('(max-width: 700px)').matches){const controls=[...panel.querySelectorAll('button:not(:disabled),textarea,input,select,a[href]'),...(companion?[...companion.querySelectorAll('button:not(:disabled),a[href]')]:[])];if(e.shiftKey&&doc.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus();}else if(!e.shiftKey&&doc.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus();}}};const keyScope=companion?container.parentElement:panel;keyScope.addEventListener('keydown',key);
 const api={setCard(value,{focus=true}={}){card=value;step='person';render();if(focus)panel.querySelector('button')?.focus();},setStep(value){if(!['person','route','evidence'].includes(value))return;step=value;render();panel.querySelector(`.nc-steps button[aria-pressed="true"]`)?.focus();onSelectStep?.(value,card);},destroy(){keyScope.removeEventListener('keydown',key);panel.remove();},panel};return api;
}
