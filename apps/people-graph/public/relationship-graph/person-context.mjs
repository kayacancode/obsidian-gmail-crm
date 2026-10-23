import {element,action} from './contact-sheet.mjs';

/** An owner's description, kept separate from extracted conversation evidence. */
export function personContextEditor(doc,{person,onLoad,onSave,onSaved}){
 const section=element(doc,'section','rg-profile-section rg-person-context');
 section.setAttribute('aria-label','Your private context about '+person.name);
 let saved=null,editing=false,busy=false;
 const el=(tag,cls,text)=>element(doc,tag,cls,text);
 function heading(){section.append(el('h3','','Your context'),el('p','rg-source','Private · Used to find people who could help '+person.name+'.'));}
 function render(){
  section.replaceChildren();heading();
  if(editing){
   const form=el('form'),label=el('label','','What should People know about '+person.name+'?'),input=el('textarea');
   input.setAttribute('aria-label','Your context about '+person.name);input.maxLength=1000;input.rows=4;input.value=saved?.text||'';
   input.placeholder='What they’re building, what they need, or how you know them…';label.append(input);form.append(label);
   const count=el('small','rg-source'),updateCount=()=>count.textContent=input.value.length+' / 1,000';updateCount();input.addEventListener('input',updateCount);form.append(count);
   const status=el('p','rg-context-status');status.setAttribute('role','status');
   const controls=el('div','rg-context-actions'),save=el('button','rg-context-save','Save context');save.type='submit';
   const cancel=action(doc,'Cancel',()=>{editing=false;render();},'rg-text-button');controls.append(save,cancel);form.append(controls,status);section.append(form);
   const disable=value=>{busy=value;input.disabled=save.disabled=cancel.disabled=value;};
   form.onsubmit=async event=>{
    event.preventDefault();if(busy)return;disable(true);status.textContent='Saving…';
    try{const next=await onSave({personId:person.id,text:input.value.trim(),revision:saved?.revision??null});if(!section.isConnected)return;saved=next;editing=false;render();onSaved?.();}
    catch(error){if(!section.isConnected)return;status.replaceChildren(el('span','',error.status===409?'This context changed elsewhere. Your edit is still here. Load the latest version before saving.':'Could not save. Your text is still here.'));
     if(error.status===409){save.disabled=true;const reload=action(doc,'Load latest context',async()=>{reload.disabled=true;try{const next=await onLoad(person.id);if(!section.isConnected)return;saved=next;render();}catch{reload.disabled=false;status.firstChild.textContent='Could not load the latest context. Your edit is still here.';}},'rg-text-button');status.append(reload);}
    }finally{busy=false;if(section.isConnected){input.disabled=cancel.disabled=false;if(!status.querySelector('button'))save.disabled=false;}}
   };
   return;
  }
  if(saved?.text){
   section.append(el('p','rg-context-text',saved.text));
   if(saved.updatedAt)section.append(el('p','rg-source','Updated '+new Date(saved.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})));
   const controls=el('div','rg-context-actions');controls.append(action(doc,'Edit context',()=>{editing=true;render();section.querySelector('textarea').focus();},'rg-text-button'));
   controls.append(action(doc,'Remove context',async()=>{
    if(busy)return;busy=true;for(const b of controls.querySelectorAll('button'))b.disabled=true;
    try{const next=await onSave({personId:person.id,text:'',revision:saved.revision});if(!section.isConnected)return;saved=next;render();onSaved?.();}
    catch(error){if(!section.isConnected)return;const status=el('p','rg-context-status',error.status===409?'This context changed elsewhere. Reload it before removing.':'Could not remove this context. Please try again.');status.setAttribute('role','status');if(error.status===409)status.append(action(doc,'Load latest context',()=>void load(),'rg-text-button'));section.append(status);}
    finally{busy=false;for(const b of controls.querySelectorAll('button'))b.disabled=false;}
   },'rg-text-button'));section.append(controls);
  }else section.append(el('p','rg-source','Add what you know, even if there are no meeting notes.'),action(doc,'Add context',()=>{editing=true;render();section.querySelector('textarea').focus();},'rg-text-button'));
 }
 async function load(){
  section.replaceChildren();heading();section.append(el('p','rg-source','Loading your context…'));
  try{const next=await onLoad(person.id);if(!section.isConnected)return;saved=next;render();}
  catch(error){if(!section.isConnected)return;if(error.status===404){section.remove();return;}section.replaceChildren();heading();section.append(el('p','rg-context-status','Could not load your context.'),action(doc,'Try again',()=>void load(),'rg-text-button'));}
 }
 // Let the profile attach before checking that this async read still belongs to it.
 void Promise.resolve().then(load);return section;
}
