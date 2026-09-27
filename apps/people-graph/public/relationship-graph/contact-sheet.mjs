const sourceNames={granola:'Granola note context',granola_mention:'Mention in meeting notes',obsidian_note:'Note mention',gmail_body_derived:'Email context',gmail_subject:'Email subject',calendar:'Calendar event'};
export function personContext(graph,personId) {
 const seen=new Set();
 return (graph.themeSignals||[]).filter(s=>s.personId===personId&&s.id&&s.summary&&Number.isFinite(Date.parse(s.observedAt)))
 .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)).flatMap(s=>{
  const member=(graph.members||[]).find(m=>String(s.evidenceRef||'').startsWith('workspace:'+m.id+':'));
  const key=[member?.id||'',s.sourceType,s.observedAt,s.summary].join('|');if(seen.has(key))return [];seen.add(key);
  let url=null;try{const u=new URL(s.provenance?.canonicalUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='granola.ai'||u.hostname.endsWith('.granola.ai'))&&u.pathname!=='/')url=u.href;}catch{}
  return [{ref:s.id,summary:s.summary,date:s.observedAt,sourceType:s.sourceType,sourceLabel:sourceNames[s.sourceType]||s.sourceType,title:s.provenance?.title||'',contributor:member?(member.isMe?'You':member.name):graph.source==='workspace'?'Shared source':'You',url}];
 }).slice(0,20);
}
export function contextBlock(doc,e) {
 const item=element(doc,'article','nc-memory');
 item.append(element(doc,'small','nc-muted',`${e.sourceLabel} · ${e.date.slice(0,10)} · ${e.contributor==='You'?'You':e.contributor==='Shared source'?'Shared source':'Shared by '+e.contributor}`));
 if(e.title)item.append(element(doc,'strong','',e.title));
 item.append(element(doc,'p','',e.summary));
 if(e.url){const link=element(doc,'a','nc-text','Open in Granola ↗');link.href=e.url;link.target='_blank';link.rel='noopener noreferrer';item.append(link);}
 return item;
}
export function contactCard(graph,personId,answer){
 const person=graph.nodes.find(n=>n.id===personId);if(!person)return null;
 const self=graph.members?.find(m=>m.isMe)?.id;
 const ready=!person.sources?.includes('obsidian')||person.identityMatchReady===true;
 const evidence=personContext(graph,personId);
 const relationships=(person.relationships||[]).map(r=>({...r,isMe:r.memberId===self,memberName:graph.members?.find(m=>m.id===r.memberId)?.name||r.memberName||'Contributor'})).sort((a,b)=>Number(b.isMe)-Number(a.isMe)||(b.score??-1)-(a.score??-1));
 return {person,relationships,identityPending:!ready,contributors:(graph.members||[]).filter(m=>person.relationships?.some(r=>r.memberId===m.id)),relationshipUnverified:!(person.relationships||[]).some(r=>['email','meeting'].includes(r.evidenceCategory)),query:answer?.query||'',reasons:answer?.results?.find(p=>p.personId===personId)?.reasons||[],evidence,novelty:person.relationships?.some(r=>(r.evidenceCategory==='email'||r.evidenceCategory==='meeting')&&r.memberId===self)?'recorded_contact':'no_recorded_direct_contact',routes:ready?(person.relationships||[]).filter(r=>(r.evidenceCategory==='email'||r.evidenceCategory==='meeting')&&!(r.activity&&(!r.activity.sent||!r.activity.received)&&!r.activity.meetings)&&r.memberId!==self&&graph.members?.some(m=>m.id===r.memberId)).map(r=>({...r,memberName:graph.members.find(m=>m.id===r.memberId).name})).sort((a,b)=>(b.score??-1)-(a.score??-1)):[]};
}
export function element(doc,tag,className='',text){const el=doc.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;}
export function action(doc,label,fn,className=''){const el=element(doc,'button',className,label);el.type='button';el.addEventListener('click',fn);return el;}
export function portrait(doc,person,className=''){const wrap=element(doc,'span','nc-portrait '+className,(person.name||'?').split(/\s+/).slice(0,2).map(x=>x[0]).join(''));if(person.photoUrl){const image=element(doc,'img');image.src=person.photoUrl;image.alt='';image.referrerPolicy='no-referrer';image.onerror=()=>image.remove();wrap.append(image);}return wrap;}
export function mountContactSheet(container,{onClose,onSelectStep,onRequestIntro,onExcludeContribution,companion}={}){
 const doc=container.ownerDocument,previous=doc.activeElement;let card,step='person';
 const panel=element(doc,'section','nc-sheet');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Person and introduction route');container.append(panel);
 function render(){if(!card)return;const own=card.novelty==='recorded_contact';const self=card.relationships?.find(r=>r.isMe),incoming=self?.activity?.sent===0&&self.activity.received>0&&!self.activity.meetings;panel.replaceChildren();const top=element(doc,'div','nc-top');top.append(element(doc,'span','nc-muted',card.query?'Your network’s answer':'A connection in context'),action(doc,'×',close,'nc-close'));top.lastElementChild.setAttribute('aria-label','Close person sheet');panel.append(top);
 const tabs=element(doc,'nav','nc-steps');tabs.setAttribute('aria-label','Connection walk');for(const [id,label]of [['person','Person'],...(own&&!card.routes.length?[]:[['route','Route']]),['evidence','Memory']]){const b=action(doc,label,()=>api.setStep(id));b.setAttribute('aria-pressed',String(step===id));tabs.append(b);}panel.append(tabs);
 const identity=element(doc,'div','nc-identity');identity.append(portrait(doc,card.person,'nc-hero'));const title=element(doc,'div');title.append(element(doc,'h2','',card.person.name),element(doc,'p','nc-muted',[card.person.role,card.person.company].filter(Boolean).join(' · ')));identity.append(title);panel.append(identity);
 if(step==='person'){
  panel.append(element(doc,'p','nc-status',incoming?'Incoming email only':card.novelty==='recorded_contact'?'Contact activity in your data':card.relationshipUnverified?'Relationship not yet verified':'No direct contact found in shared data'));
  if(card.query)panel.append(element(doc,'p','nc-query','For: '+card.query));
  const reasons=card.reasons;
  if(reasons[0])panel.append(element(doc,'p','nc-reason',reasons[0].summary));
  if(reasons[0])panel.append(element(doc,'p','nc-muted','Recorded context · '+(reasons[0].date||reasons[0].observedAt||'').slice(0,10)));
 }
 if(step==='person'&&card.evidence.length){
  const context=element(doc,'section','nc-profile-context');context.append(element(doc,'h3','','Recent context'));
  for(const e of card.evidence.slice(0,2))context.append(contextBlock(doc,e));
  if(card.evidence.some(e=>['granola','granola_mention','obsidian_note'].includes(e.sourceType)))context.append(element(doc,'small','nc-muted','Note context is separate from contact activity; a mention does not confirm attendance.'));
  panel.append(context);
 }
 if(step==='evidence'){
  panel.append(element(doc,'h3','','Supporting memory'));
  if(!card.evidence.length)panel.append(element(doc,'p','nc-muted','No shared meeting or note context is available for this person.'));
  for(const e of card.evidence)panel.append(contextBlock(doc,e));
 }
 if(step==='route'||step==='person'){
  panel.append(element(doc,'h3','',incoming?'Why this person is here':own?'Your connection':'Connections in this network'));
  if(card.relationships?.some(r=>Number.isFinite(r.score)))panel.append(element(doc,'p','nc-muted','Activity scores reflect recorded contact volume, reciprocity, and recency—not personal closeness.'));
  for(const r of card.relationships||[]){
   const row=element(doc,'article','nc-relationship');row.append(element(doc,'strong','',r.isMe?'You':r.memberName));
   const measured=['email','meeting'].includes(r.evidenceCategory)&&Number.isFinite(r.score);
   row.append(element(doc,'p','',measured?'Activity score: '+Math.round(r.score)+' / 100':'Not measured in shared data'));
   if(measured){const meter=element(doc,'meter');meter.min=0;meter.max=100;meter.value=r.score;meter.setAttribute('aria-label',(r.isMe?'Your':r.memberName+'’s')+' relationship activity');row.append(meter);}
   row.append(element(doc,'small','nc-muted',(r.evidenceCategory==='email'?'Email contact':r.evidenceCategory==='meeting'?'Meeting activity':'Vault record · contact evidence unavailable')+(r.lastContact?' · Last contact '+r.lastContact.slice(0,10):'')));
   if(r.isMe&&r.inboxes?.length)row.append(element(doc,'small','nc-muted','Imported from '+r.inboxes.join(', ')));
   if(r.activity?.sent===0&&r.activity.received>0&&!r.activity.meetings)row.append(element(doc,'p','','Received email; no sent messages found in the imported history. This does not establish that you know them.'));
   if(r.activity)row.append(element(doc,'small','nc-muted',r.activity.sent+' sent · '+r.activity.received+' received · '+r.activity.meetings+' recorded meeting entries'));
   if(r.isMe)row.append(element(doc,'small','nc-muted','Included through your sharing settings'));
   if(r.observedAt)row.append(element(doc,'small','nc-muted','Updated '+r.observedAt.slice(0,10)));
   panel.append(row);
  }

  for(const route of card.routes){const row=element(doc,'div','nc-via');row.append(element(doc,'strong','','Through '+route.memberName),element(doc,'small','nc-muted',`${Number.isFinite(route.score)?Math.round(route.score)+' / 100 measured activity':'Activity not measured'}${route.lastContact?' · '+route.lastContact.slice(0,10):''}`));const ask=action(doc,'Ask '+route.memberName+' for an intro',()=>onRequestIntro?.(card,route.memberId),step==='person'?'nc-primary':'');ask.disabled=!onRequestIntro;row.append(ask);panel.append(row);if(step==='person')break;}
  if(!card.routes.length&&!own){const known=element(doc,'section','nc-memory');known.append(element(doc,'h3','','Connection details'));
   if(card.contributors?.length)known.append(element(doc,'p','','Shared by '+card.contributors.map(m=>m.name).join(', ')));
   if(card.identityPending)known.append(element(doc,'p','','This older vault record cannot yet be matched with the same person in other members’ networks. The contributor needs to publish a fresh vault snapshot with plugin 0.9.4 or later.'));
   known.append(element(doc,'p','',card.relationshipUnverified?'This shared record does not include verified contact evidence. Being in someone’s vault does not establish that they know this person.':'No supported introduction route through another member is available in the current shared data.'));
   if(card.identityPending)known.append(element(doc,'small','nc-muted','A fresh snapshot enables identity matching; a route also needs recorded relationship evidence.'));
   panel.append(known);
  }
  if(card.routes.length)panel.append(element(doc,'small','nc-muted','An introduction depends on the contributor’s willingness to help.'));
 }
 if(step==='person'&&self&&onExcludeContribution){const exclude=action(doc,'I don’t know this person — exclude my contribution',async()=>{exclude.disabled=true;try{await onExcludeContribution(card.person.id);}catch{exclude.disabled=false;exclude.textContent='Could not exclude. Try again';}},'nc-text');panel.append(exclude);}
 if(step==='person'){if(!own||card.routes.length)panel.append(action(doc,'See route and relationship evidence →',()=>api.setStep('route'),'nc-text'));panel.append(action(doc,own?'View shared context →':'Why this person? →',()=>api.setStep('evidence'),'nc-text'));}
 }
 function close(){api.destroy();onClose?.();if(previous?.isConnected)previous.focus();}
 const key=e=>{if(e.key==='Escape'){e.stopPropagation();close();}if(e.key==='Tab'&&doc.defaultView.matchMedia('(max-width: 700px)').matches){const controls=[...panel.querySelectorAll('button:not(:disabled),textarea,input,select,a[href]'),...(companion?[...companion.querySelectorAll('button:not(:disabled),a[href]')]:[])];if(e.shiftKey&&doc.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus();}else if(!e.shiftKey&&doc.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus();}}};const keyScope=companion?container.parentElement:panel;keyScope.addEventListener('keydown',key);
 const api={setCard(value,{focus=true}={}){card=value;step='person';render();if(focus)panel.querySelector('button')?.focus();},setStep(value){if(!['person','route','evidence'].includes(value))return;step=value;render();panel.querySelector(`.nc-steps button[aria-pressed="true"]`)?.focus();onSelectStep?.(value,card);},destroy(){keyScope.removeEventListener('keydown',key);panel.remove();},panel};return api;
}
