const FIELD_LABELS={focus:'Focused on',needs:'Looking for',offers:'Can help with'};
const KIND_FIELDS={focus:'focus',need:'needs',offer:'offers'};
const dateLabel=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Date unavailable';};
function granolaLink(value){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(url.hostname==='granola.ai'||url.hostname.endsWith('.granola.ai'))?url.href:null;}catch{return null;}
}

/** Private, in-memory editor. The host owns authentication and discards this on context changes. */
export function mountOwnerLens({button,load,update,findMatches,getGraph,onExplore}){
 const doc=button.ownerDocument;
 let dialog=null,view=null,disposed=false,run=0,busy=false,busyAction='',model=null;
 let draft={focus:'',needs:'',offers:''},note='',dirty=new Set();
 const el=(tag,cls,text)=>{const node=doc.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 const action=(text,handler,cls='')=>{const b=el('button',cls,text);b.type='button';b.onclick=handler;return b;};
 const alive=token=>!disposed&&dialog?.isConnected&&token===run;
 const message=text=>{if(view)view.status.textContent=text;};
 function close(){run++;dialog?.close();dialog?.remove();dialog=null;view=null;busy=false;busyAction='';button.setAttribute('aria-expanded','false');}
 function setBusy(value,operation=busyAction){
  busy=value;busyAction=value?operation:'';if(!view)return;
  for(const control of view.content.querySelectorAll('button,input,textarea'))control.disabled=value||!model;
  view.note.disabled=value||!model?.enabled;
  view.refresh.disabled=value||!model?.enabled;
  view.refresh.textContent=busyAction==='refresh'?'Reading context…':'Refresh suggestions';
  view.granola.disabled=value||!model?.enabled;
  view.save.disabled=value||!model;
  view.find.disabled=value||!model||dirty.size>0||!Object.values(model.fields||{}).some(v=>typeof v==='string'&&v.trim());
 }
 function sourceBlock(source){
  const block=el('div','owner-lens-source');
  block.append(el('small','',`${source.label||source.sourceLabel||'Source'} · ${dateLabel(source.observedAt||source.date)}`));
  const url=granolaLink(source.url);
  if(url){const link=el('a','owner-lens-source-title',source.title||'Open Granola meeting');link.href=url;link.target='_blank';link.rel='noopener noreferrer';block.append(link);}
  else if(source.title)block.append(el('strong','owner-lens-source-title',source.title));
  if(source.attribution==='meeting')block.append(el('p','owner-lens-muted','Inferred focus from meeting context, not a statement by you.'));
  block.append(el('p','',source.text||source.summary||''));
  return block;
 }
 function learningStatus(value){
  const saved=Object.values(model?.fields||{}).some(text=>typeof text==='string'&&text.trim());
  const count=(model?.suggestions||[]).filter(s=>KIND_FIELDS[s.kind]).length;
  if(model?.enabled===false&&value?.status==='unavailable')return 'Learning is off. Clearing learned context is still pending. Retry to finish clearing it.';
  if(model?.enabled===true&&value?.configured&&value.cleanupPending)return 'Updating stored context. Refresh again after cleanup finishes.';
  if(!value?.configured)return 'Honcho is not configured. You can still edit your lens and find people.';
  return ({disabled:saved?'Learning is off. Your saved lens still works.':'Learning is off. You can fill in your lens above.',pending:'No completed updates yet. Refresh again to check.',ready:count?`${count} proposed ${count===1?'update is':'updates are'} ready to review. Choose Use update to add each one to your lens.`:saved?'No new updates. Your saved lens is unchanged.':'No profile updates found yet. Add a note about your work or fill in your lens above.',unavailable:saved?'Learning is temporarily unavailable. Your saved lens still works.':'Learning is temporarily unavailable. You can still fill in your lens above.',invalid:saved?'No reliable update was returned. Your saved lens is unchanged.':'No reliable profile update was returned. Add a note about your work or fill in your lens above.'})[value.status]||'Ready to learn from your work context.';
 }
 function renderModel(value){
  model=value;if(!view)return;
  for(const field of Object.keys(FIELD_LABELS)){if(!dirty.has(field))draft[field]=String(value.fields?.[field]||'');view.inputs[field].value=draft[field];}
  view.updated.textContent=value.updatedAt?'Last saved '+dateLabel(value.updatedAt):'Add what matters to you right now.';
  view.learning.checked=value.enabled===true;
  view.granola.checked=value.granolaEnabled===true;
  const progress=value.granolaProgress;
  const showProgress=value.enabled===true&&value.granolaEnabled===true&&progress&&['available','checked','excerpts'].every(key=>Number.isInteger(progress[key])&&progress[key]>=0);
  view.granolaProgress.hidden=!showProgress;
  view.granolaProgress.textContent=showProgress?`Granola: ${progress.checked} of ${progress.available} recent meetings checked · ${progress.excerpts} useful excerpts`:'';
  view.learningHint.hidden=value.enabled===true;
  view.cleanup.hidden=value.enabled!==false||value.honcho?.status!=='unavailable';
  view.learningStatus.textContent=learningStatus(value.honcho)+(value.honcho?.lastSync?' Last checked '+dateLabel(value.honcho.lastSync)+'.':'');
  view.suggestions.replaceChildren();
  const suggestions=(value.suggestions||[]).filter(s=>KIND_FIELDS[s.kind]);
  if(suggestions.length){
   const heading=el('h3','',`Proposed updates (${suggestions.length})`);heading.tabIndex=-1;heading.style.scrollMarginTop='100px';
   view.suggestions.append(heading,el('p','owner-lens-muted','Review the sources, then choose Use update or Dismiss for each proposal. Only updates you use become part of your lens.'));
   for(const suggestion of suggestions){
    const card=el('article','owner-lens-suggestion');card.append(el('small','owner-lens-category',FIELD_LABELS[KIND_FIELDS[suggestion.kind]]),el('p','',suggestion.text));
    const evidence=(suggestion.sourceIds||[]).map(id=>(value.sources||[]).find(s=>s.id===id)).filter(Boolean);
    if(evidence.length){const details=el('details');details.append(el('summary','','Based on your work context'));for(const source of evidence)details.append(sourceBlock(source));card.append(details);}
    const actions=el('div','owner-lens-actions');actions.append(action('Use update',()=>mutate({action:'accept',id:suggestion.id},'Update added to your lens.')),action('Dismiss',()=>mutate({action:'dismiss',id:suggestion.id},'Suggestion dismissed.'),'owner-lens-quiet'));card.append(actions);view.suggestions.append(card);
   }
  }
  view.sources.replaceChildren();
  if(value.sources?.length){view.sources.append(el('summary','',`Your sources (${value.sources.length})`));for(const source of value.sources)view.sources.append(sourceBlock(source));}
  view.sources.hidden=!value.sources?.length;
  setBusy(busy);
 }
 async function mutate(body,success){
  if(busy||!model)return;
  const token=run;setBusy(true,body.action);
  const pending=body.action==='refresh'?'Reading your work context and preparing profile updates…':body.action==='accept'?'Adding this update to your lens…':body.action==='dismiss'?'Dismissing this update…':'Saving…';
  message(pending);if(body.action==='refresh')view.learningStatus.textContent=pending;
  try{
   const next=await update({...body,revision:model.revision});if(!alive(token))return;
   if(body.action==='save')dirty.clear();
   if(body.action==='accept'){const suggestion=model.suggestions?.find(s=>s.id===body.id);if(suggestion)dirty.delete(KIND_FIELDS[suggestion.kind]);}
   renderModel(next);view.matches.replaceChildren();
   if(body.action==='refresh'){
    message(learningStatus(next.honcho));
    if(next.honcho?.status==='ready'&&next.suggestions?.length){const heading=view.suggestions.querySelector('h3');heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start'});}
    if(next.honcho?.status==='ready'){note='';view.note.value='';}
   }else message(body.action==='learning'&&next.enabled===false&&next.honcho?.status==='unavailable'?learningStatus(next.honcho):success);
  }catch(error){
   if(!alive(token)||error.name==='AbortError')return;
   if(error.status===409){
    // Keep genuine local edits; untouched fields follow the latest saved revision.
    try{const latest=await load();if(!alive(token))return;renderModel(latest);message(dirty.size?'Your lens changed elsewhere. Your edits are still here; review them and save again.':'Your lens changed elsewhere. The latest saved lens is now shown; try again.');}
    catch(reloadError){if(alive(token))message(dirty.size?'Your lens changed elsewhere. Your edits are still here. Reopen the panel to retry.':'Your lens changed elsewhere. Reopen the panel to load the latest saved lens.');}
   }else{if(body.action==='learning')view.learning.checked=model.enabled===true;if(body.action==='granola')view.granola.checked=model.granolaEnabled===true;view.learningStatus.textContent=learningStatus(model.honcho);message(error.serverMessage||(body.action==='refresh'?'Could not refresh profile updates. Your edits are still here. Try again.':'Could not save your lens. Your edits are still here. Try again.'));}
  }finally{if(alive(token))setBusy(false);}
 }
 async function search(){
  if(busy||!model||dirty.size)return;
  const token=run;setBusy(true);message('Finding people for your saved lens…');view.matches.replaceChildren();
  try{
   const result=await findMatches();if(!alive(token))return;
   if(!result.checked){message('The search could not finish. Your lens is saved; try again.');return;}
   const nodes=new Map((getGraph()?.nodes||[]).map(n=>[n.id,n]));
   const matches=(result.results||[]).filter(m=>nodes.has(m.personId));
   message(matches.length?'Possible conversations based on your saved lens.':'No supported matches yet. Add more specific work or needs to your lens.');
   for(const match of matches){
    const person=nodes.get(match.personId),card=el('article','owner-lens-match');
    card.append(el('h3','',person.name),el('p','',match.reason),el('p','owner-lens-question',match.conversation));
    const details=el('details');details.append(el('summary','','Why this match?'));
    for(const source of match.anchorEvidence||[])details.append(sourceBlock({...source,sourceLabel:source.sourceLabel||'Your lens'}));
    for(const source of match.evidence||[])details.append(sourceBlock(source));
    card.append(details,action('Explore '+person.name,()=>{close();onExplore?.(person.id);}));view.matches.append(card);
   }
  }catch(error){if(alive(token)&&error.name!=='AbortError')message('The search could not finish. Your lens is saved; try again.');}
  finally{if(alive(token))setBusy(false);}
 }
 async function open(){
  if(disposed||dialog)return;
  const token=++run;
  dialog=el('dialog','owner-lens-dialog');dialog.id='owner-lens-panel';dialog.setAttribute('aria-label','Your lens');
  const heading=el('header','owner-lens-heading'),headingCopy=el('div');headingCopy.append(el('p','owner-lens-eyebrow','PRIVATE · JUST FOR YOU'),el('h2','','Your lens'));
  const dismiss=action('×',close,'owner-lens-close');dismiss.setAttribute('aria-label','Close your lens');heading.append(headingCopy,dismiss);
  const content=el('div','owner-lens-content'),updated=el('p','owner-lens-muted'),inputs={};
  content.append(el('p','owner-lens-intro','What makes someone relevant to you right now?'),updated);
  const form=el('form','owner-lens-form');
  for(const [field,label] of Object.entries(FIELD_LABELS)){
   const wrap=el('label','owner-lens-field',label),input=el('textarea');input.rows=2;input.maxLength=500;input.setAttribute('aria-label',label);input.value=draft[field];
   input.placeholder=({focus:'The work or questions on your mind',needs:'People, perspectives or help you need',offers:'Experience or help you can share'})[field];
   input.oninput=()=>{draft[field]=input.value;dirty.add(field);view.matches.replaceChildren();message('Unsaved edits. Save your lens before finding people.');setBusy(false);};wrap.append(input);form.append(wrap);inputs[field]=input;
  }
  const actions=el('div','owner-lens-actions'),save=action('Save lens',()=>mutate({action:'save',fields:{...draft}},'Saved your lens.'));
  save.type='submit';save.onclick=null;
  form.onsubmit=event=>{event.preventDefault();void mutate({action:'save',fields:{...draft}},'Saved your lens.');};
  const find=action('Find people for me',search,'owner-lens-primary');actions.append(save,find);form.append(actions,el('p','owner-lens-muted','Matches use your saved lens. Suggestions need your review first.'));content.append(form);
  const status=el('p','owner-lens-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');content.append(status);
  const matches=el('div','owner-lens-matches'),suggestions=el('section','owner-lens-suggestions');suggestions.setAttribute('aria-label','Proposed lens updates');content.append(matches,suggestions);
  const learningSection=el('section','owner-lens-learning'),learningLabel=el('label','owner-lens-learning-toggle'),learning=el('input');learning.type='checkbox';learning.setAttribute('aria-label','Learn from my work context');learning.onchange=()=>void mutate({action:'learning',enabled:learning.checked},learning.checked?'Learning enabled. Refresh to look for updates.':'Learning turned off.');
  learningLabel.append(learning,doc.createTextNode('Learn from my work context'));
  const granolaLabel=el('label','owner-lens-learning-toggle'),granola=el('input');granola.type='checkbox';granola.setAttribute('aria-label','Include my Granola notes');granola.onchange=()=>void mutate({action:'granola',enabled:granola.checked},granola.checked?'Granola notes included. Refresh to look for updates.':'Granola notes excluded.');granolaLabel.append(granola,doc.createTextNode('Include my Granola notes'));
  const learningState=el('p','owner-lens-muted'),learningHint=el('p','owner-lens-muted','Turn on learning to add a note or refresh suggestions.'),granolaProgress=el('p','owner-lens-muted owner-lens-granola-progress');granolaProgress.hidden=true;
  const cleanup=action('Retry clearing learned context',()=>mutate({action:'learning',enabled:false},'Learned context cleared. Learning is off.'),'owner-lens-cleanup');cleanup.hidden=true;
  learningSection.append(learningLabel,el('p','owner-lens-muted','When enabled, selected work excerpts from your sent emails and any notes you add go to Honcho to suggest updates. Your lens stays private, and you choose which updates to use.'),granolaLabel,el('p','owner-lens-muted','Granola excerpts go to Honcho only when included. Recurring meeting topics can suggest your focus; needs and offers use your own statements.'),granolaProgress,learningState,cleanup,learningHint);
  const noteLabel=el('label','owner-lens-field','Tell it what you’re working on'),noteInput=el('textarea');noteInput.rows=3;noteInput.maxLength=3000;noteInput.value=note;noteInput.setAttribute('aria-label','Tell it what you’re working on');noteInput.placeholder='An optional note about your current work, needs or experience';noteInput.oninput=()=>{note=noteInput.value;};noteLabel.append(noteInput);
  const refresh=action('Refresh suggestions',()=>mutate({action:'refresh',...(note.trim()?{note:note.trim()}:{})},''));learningSection.append(noteLabel,el('p','owner-lens-muted','Refresh sends this note to Honcho to propose updates.'),refresh);
  const sources=el('details','owner-lens-sources');sources.hidden=true;content.append(learningSection,sources);dialog.append(heading,content);
  view={content,inputs,updated,save,find,status,matches,suggestions,learning,granola,granolaProgress,learningHint,cleanup,learningStatus:learningState,note:noteInput,refresh,sources};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  doc.body.append(dialog);button.setAttribute('aria-expanded','true');dialog.showModal();setBusy(true);message('Loading your lens…');
  try{const value=await load();if(!alive(token))return;renderModel(value);message(dirty.size?'Your unsaved edits are still here.':'');}
  catch(error){if(alive(token)&&error.name!=='AbortError'){message('Your lens could not load. Close this panel and try again.');}}
  finally{if(alive(token))setBusy(false);}
 }
 button.hidden=false;button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','owner-lens-panel');button.onclick=open;
 return {destroy(){disposed=true;close();model=null;draft={focus:'',needs:'',offers:''};dirty.clear();note='';button.hidden=true;button.onclick=null;},close};
}
