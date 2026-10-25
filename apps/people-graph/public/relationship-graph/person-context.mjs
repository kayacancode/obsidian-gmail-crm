import {element,action} from './contact-sheet.mjs';

const empty={text:'',company:'',building:'',needs:'',offers:'',interests:[],pointPersonId:null,notBefore:null,relationship:'neutral',entries:[],revision:null,updatedAt:null};
const fields=[['company','Company',160],['building','Building',600],['needs','Needs',600],['offers','Can help with',600]];
const date=value=>new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
/** Owner-authored memory stays separate from imported and shared conversation evidence. */
export function personContextEditor(doc,{person,people=[],onLoad,onSave,onSaved,onStructure,onRemoveEntry}){
 const section=element(doc,'section','rg-profile-section rg-person-context');section.setAttribute('aria-label','Your private context about '+person.name);
 const el=(tag,cls,text)=>element(doc,tag,cls,text),button=(label,fn)=>action(doc,label,fn,'rg-text-button');
 let saved={...empty,personId:person.id},editing=false,busy=false,recognition=null;
 const peers=people.filter(p=>p.id!==person.id&&p.type!=='company'&&(p.memoryEligible===true||p.directRelationship!==false&&(!p.via?.length||p.directRelationship===true))).sort((a,b)=>a.name.localeCompare(b.name));
 function stopVoice(){const current=recognition;recognition=null;current?.abort();}
 function heading(){section.append(el('h3','','Your context'),el('p','rg-source','Private · Used in your recommendations and introduction suggestions.'));}
 function normalize(value){return {...empty,...value,interests:value.interests||[],entries:value.entries||[]};}
 function payload(values){return {personId:person.id,text:values.text.trim(),revision:saved.revision,company:values.company.trim(),building:values.building.trim(),needs:values.needs.trim(),offers:values.offers.trim(),interests:values.interests,pointPersonId:values.pointPersonId||null,notBefore:values.notBefore||null,relationship:values.relationship};}
 function savedNotice(status,error){status.textContent=error.status===409?'This context changed elsewhere. Reload it before changing it.':'Could not update this context. Please try again.';if(error.status===409)status.append(button('Load latest context',()=>void load()));}
 function render(){
  stopVoice();section.replaceChildren();heading();
  if(editing){renderEditor();return;}
  const hasContext=Boolean(saved.text||fields.some(([key])=>saved[key])||saved.interests.length||saved.pointPersonId||saved.notBefore||saved.relationship!=='neutral');
  if(saved.text)section.append(el('p','rg-context-text',saved.text));
  const facts=el('dl','rg-memory-facts');for(const [key,label]of fields)if(saved[key])facts.append(el('dt','',label),el('dd','',saved[key]));if(saved.interests.length)facts.append(el('dt','','Interests'),el('dd','',saved.interests.join(' · ')));if(facts.childElementCount)section.append(facts);
  const point=peers.find(p=>p.id===saved.pointPersonId);if(point)section.append(el('p','rg-source','Check with '+point.name+' before reaching out.'));
  if(saved.relationship!=='neutral')section.append(el('p','rg-source',saved.relationship==='closer'?'Your judgment: closer relationship · +10 to your People score.':'Your judgment: weaker relationship · −10 to your People score.'));
  if(saved.notBefore)section.append(el('p','rg-source','Pause suggestions until '+date(saved.notBefore+'T12:00:00')+'.'));
  if(saved.updatedAt&&hasContext)section.append(el('p','rg-source','Updated '+date(saved.updatedAt)));
  if(!hasContext)section.append(el('p','rg-source','Add what you know, even if there are no meeting notes.'));
  const controls=el('div','rg-context-actions');controls.append(button(hasContext?'Edit context':'Add context',()=>{editing=true;render();section.querySelector('textarea').focus();}));
  if(hasContext)controls.append(button('Remove context',async()=>{
   if(busy)return;busy=true;for(const b of controls.querySelectorAll('button'))b.disabled=true;
   try{const next=await onSave(payload({...empty}));if(!section.isConnected)return;saved=normalize(next);render();onSaved?.(saved);}
   catch(error){if(section.isConnected){const status=el('p','rg-context-status');status.setAttribute('role','status');savedNotice(status,error);section.append(status);}}
   finally{busy=false;for(const b of controls.querySelectorAll('button'))b.disabled=false;}
  }));section.append(controls);
  if(saved.entries.length){const updates=el('details','rg-memory-updates');updates.append(el('summary','','Saved updates'));
   for(const entry of saved.entries){const row=el('article');row.append(el('p','rg-context-text',entry.text),el('small','rg-source',(entry.sourceKind==='voice_transcript'?'Voice transcript':'Saved note')+' · '+date(entry.createdAt)));
    if(onRemoveEntry)row.append(button('Remove saved update',async()=>{if(busy)return;busy=true;const control=row.querySelector('button');control.disabled=true;try{const next=await onRemoveEntry({personId:person.id,entryId:entry.id,revision:saved.revision});if(!section.isConnected)return;saved=normalize(next);render();onSaved?.(saved);}catch(error){if(section.isConnected){const status=el('p','rg-context-status');status.setAttribute('role','status');savedNotice(status,error);row.append(status);}}finally{busy=false;control.disabled=false;}}));updates.append(row);
   }section.append(updates);
  }
 }
 function renderEditor(){
  const form=el('form'),label=el('label','','What should People know about '+person.name+'?'),input=el('textarea');input.setAttribute('aria-label','Your context about '+person.name);input.maxLength=1000;input.rows=4;input.value=saved.text;input.placeholder='What they’re building, what they need, or how you know them…';label.append(input);form.append(label);
  const count=el('small','rg-source'),updateCount=()=>{count.textContent=input.value.length+' / 1,000';};updateCount();input.addEventListener('input',updateCount);form.append(count);
  const status=el('p','rg-context-status');status.setAttribute('role','status');const utilities=el('div','rg-context-actions');
  const Recognition=doc.defaultView?.SpeechRecognition||doc.defaultView?.webkitSpeechRecognition;
  let listening=false,voiceBase='';
  if(Recognition){const voice=button('Dictate note',()=>{
   if(listening){recognition?.stop();return;}try{stopVoice();const current=new Recognition();recognition=current;current.lang=doc.documentElement.lang||'en-US';current.continuous=true;current.interimResults=false;voiceBase=input.value.trim();let heard='';
    current.onresult=event=>{if(recognition!==current||!section.isConnected)return;for(let i=event.resultIndex;i<event.results.length;i++)if(event.results[i].isFinal)heard+=(heard?' ':'')+event.results[i][0].transcript;const result=[voiceBase,heard.trim()].filter(Boolean).join(' ');input.value=result.slice(0,1000);updateCount();status.textContent=result.length>1000?'The note reached 1,000 characters. Review and shorten it before saving.':'Review the transcript, then save when it looks right.';};
    current.onerror=event=>{if(recognition!==current)return;status.textContent=event.error==='not-allowed'?'Microphone access was not allowed. You can type or paste your note instead.':'Dictation stopped. Your text is still here; you can keep typing.';listening=false;voice.textContent='Dictate note';save.disabled=false;};
    current.onend=()=>{if(recognition!==current)return;recognition=null;listening=false;voice.textContent='Dictate note';save.disabled=false;};current.start();listening=true;voice.textContent='Stop dictation';save.disabled=true;status.textContent='Listening… Review the transcript before saving.';
   }catch{listening=false;voice.textContent='Dictate note';status.textContent='Dictation is unavailable. You can type or paste your note instead.';}
  });utilities.append(voice,el('small','rg-source','Dictation uses your browser’s speech service.'));}
  const facts=el('details','rg-memory-fields');facts.append(el('summary','','Useful details'));const inputs={};
  for(const [key,title,max]of fields){const field=el('label','',title),control=el(key==='company'?'input':'textarea');control.setAttribute('aria-label',title);control.maxLength=max;if(key!=='company')control.rows=2;control.value=saved[key];field.append(control);facts.append(field);inputs[key]=control;}
  const interestLabel=el('label','','Interests (one per line)'),interests=el('textarea');interests.rows=3;interests.maxLength=647;interests.setAttribute('aria-label','Interests (one per line)');interests.value=saved.interests.join('\n');interestLabel.append(interests);facts.append(interestLabel);
  if(onStructure){const organize=button('Organize this note',async()=>{if(busy||!input.value.trim())return;busy=true;const before=input.value;organize.disabled=true;status.textContent='Finding useful details…';try{const result=await onStructure(input.value);if(!section.isConnected)return;if(input.value!==before){status.textContent='Your note changed. Organize it again when you’re ready.';return;}for(const [key]of fields)if(typeof result[key]==='string')inputs[key].value=result[key];interests.value=Array.isArray(result.interests)?result.interests.join('\n'):'';facts.open=true;status.textContent='Review these details and correct anything before saving. Nothing has been saved yet.';}catch{if(section.isConnected)status.textContent='Could not organize this note. You can fill in the details and save it yourself.';}finally{busy=false;organize.disabled=false;}});utilities.append(organize);}
  form.append(utilities,facts);
  const prefs=el('details','rg-memory-fields');prefs.append(el('summary','','Relationship preferences'));
  const select=(title,choices,value)=>{const field=el('label','',title),control=el('select');control.setAttribute('aria-label',title);for(const [v,t]of choices){const option=el('option','',t);option.value=v;control.append(option);}control.value=value;field.append(control);prefs.append(field);return control;};
  const point=select('Point person',[['','I can reach out directly'],...peers.map(p=>[p.id,p.name])],saved.pointPersonId||'');
  const relation=select('Your relationship judgment',[['neutral','Use measured activity'],['closer','Closer · +10 to my People score'],['weaker','Weaker · −10 to my People score']],saved.relationship);
  const notBeforeLabel=el('label','','Suggest again after'),notBefore=el('input');notBefore.type='date';notBefore.setAttribute('aria-label','Suggest again after');notBefore.value=saved.notBefore||'';notBeforeLabel.append(notBefore);prefs.append(notBeforeLabel,el('p','rg-source','These choices stay private. A pause affects recommendations; it does not cancel meetings.'));form.append(prefs);
  const controls=el('div','rg-context-actions'),save=el('button','rg-context-save','Save context');save.type='submit';const cancel=button('Cancel',()=>{editing=false;render();});controls.append(save,cancel);form.append(controls,status);section.append(form);
  form.onsubmit=async event=>{event.preventDefault();if(busy||listening)return;const topics=interests.value.split('\n').map(v=>v.trim()).filter(Boolean);if(topics.length>8||topics.some(v=>v.length>80)){facts.open=true;status.textContent='Use up to eight interests, each under 80 characters.';return;}
   const values={text:input.value,...Object.fromEntries(fields.map(([key])=>[key,inputs[key].value])),interests:topics,pointPersonId:point.value,notBefore:notBefore.value,relationship:relation.value};busy=true;for(const control of form.querySelectorAll('input,textarea,select,button'))control.disabled=true;status.textContent='Saving…';
   try{const next=await onSave(payload(values));if(!section.isConnected)return;saved=normalize(next);editing=false;render();onSaved?.(saved);}
   catch(error){if(!section.isConnected)return;status.replaceChildren(el('span','',error.status===409?'This context changed elsewhere. Your edit is still here. Load the latest version before saving.':'Could not save. Your text is still here.'));if(error.status===409){save.dataset.conflict='true';status.append(button('Load latest context',async()=>{try{const next=await onLoad(person.id);if(!section.isConnected)return;saved=normalize(next);render();}catch{status.firstChild.textContent='Could not load the latest context. Your edit is still here.';}}));}}
   finally{busy=false;for(const control of form.querySelectorAll('input,textarea,select,button'))control.disabled=false;if(save.dataset.conflict)save.disabled=true;}
  };
 }
 async function load(){stopVoice();section.replaceChildren();heading();section.append(el('p','rg-source','Loading your context…'));try{const next=await onLoad(person.id);if(!section.isConnected)return;saved=normalize(next);render();}catch(error){if(!section.isConnected)return;if(error.status===404){section.remove();return;}section.replaceChildren();heading();section.append(el('p','rg-context-status','Could not load your context.'),button('Try again',()=>void load()));}}
 // Stop the microphone if the profile closes or a different person is selected.
 const Observer=doc.defaultView?.MutationObserver;if(Observer){const observer=new Observer(()=>{if(!section.isConnected){stopVoice();observer.disconnect();}});Promise.resolve().then(()=>{if(section.isConnected)observer.observe(doc.body,{childList:true,subtree:true});});}
 void Promise.resolve().then(load);return section;
}
