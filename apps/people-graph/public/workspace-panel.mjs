const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
const errors={sign_in_with_invited_email:'Sign out, then sign in with the email address that received this invitation.',invite_expired:'This invitation expired. Ask the workspace administrator for a new link.',invite_unavailable:'This invitation was already used or revoked.',workspace_unavailable:'This workspace is no longer available to your account.',transfer_admin_first:'Transfer administration to another member before leaving.',member_limit:'This workspace has reached its 20-member limit.',already_a_member:'That account is already a member.',workspace_changed_retry:'The workspace changed. Refresh and try again.'};
export function createWorkspacePanel(root,{request,onUnauthorized}={}){
 let account=null,generation=0,active=false,busy=false,loaded=false;
 const inviteKey='people-workspace-invite';
 const hash=new URLSearchParams(location.hash.slice(1)).get('workspace-invite');
 if(hash){sessionStorage.setItem(inviteKey,hash);history.replaceState(null,'',location.pathname+'?tab=workspace');}
 const hasInvite=()=>Boolean(sessionStorage.getItem(inviteKey));
 async function run(fn){if(busy)return;busy=true;const g=generation;try{await fn();}catch(e){if(g===generation){if(e.status===401)onUnauthorized?.();else status.textContent=errors[e.message]||e.message;}}finally{busy=false;}}
 const call=async(...args)=>{const g=generation;const value=await request(...args);if(g!==generation)throw new DOMException('Account changed','AbortError');return value;};
 const status=el('p');status.setAttribute('role','status');
 function button(parent,label,fn){const b=el('button',label);b.type='button';b.onclick=()=>void run(fn);parent.append(b);return b;}
 function link(parent,label,href){const a=el('a',label);a.href=href;parent.append(a);}
 function input(parent,label,type='text'){const l=el('label',label),i=el('input');i.type=type;l.append(i);parent.append(l);return i;}
 function select(parent,label,items,value){const l=el('label',label),s=el('select');for(const [v,t] of items){const o=el('option',t);o.value=v;s.append(o);}s.value=value;l.append(s);parent.append(l);return s;}
 async function refresh(){if(!active||!account)return;const g=generation;try{const data=await call('/api/workspaces',null,'GET');if(g!==generation||!active)return;loaded=true;render(data.workspaces||[]);}catch(e){if(g===generation)status.textContent=errors[e.message]||e.message;}}
 function render(workspaces){
  root.replaceChildren(el('h2','One shared network'),el('p','Invite a teammate to explore together. They can join in their browser — no Obsidian or connected inbox required.'),status);status.textContent='';
  if(hasInvite()){
   const box=el('section');box.className='workspace-card';box.append(el('h3','You have a workspace invitation'),el('p',`Signed in as ${account}. Accepting does not share your contacts, emails, or notes.`));
   button(box,'Accept invitation',async()=>{const result=await call('/api/workspace-invites/accept',{token:sessionStorage.getItem(inviteKey)});sessionStorage.removeItem(inviteKey);await refresh();status.textContent=`You joined ${result.workspace.name}. You can explore now and choose what to share later.`;});
   button(box,'Dismiss invitation',async()=>{sessionStorage.removeItem(inviteKey);await refresh();});root.append(box);
  }
  const create=el('section');create.className='workspace-card';create.append(el('h3','Create a shared network'));const name=input(create,'Workspace name');name.maxLength=80;name.placeholder='e.g. Betaworks';
  button(create,'Create workspace',async()=>{if(!name.value.trim()){status.textContent='Enter a workspace name.';return;}await call('/api/workspaces',{name:name.value.trim()});await refresh();});root.append(create);
  for(const w of workspaces){
   const card=el('section');card.className='workspace-card';card.append(el('h3',w.name),el('p',`${w.memberCount} members · ${w.role==='admin'?'You manage this workspace':'Member'}`));link(card,'Open shared network','/?workspace='+encodeURIComponent(w.id));
   card.append(el('p',w.contribution.enabled?'Your selected contribution is shared.':'Nothing shared yet.'));
   const manage=el('details');manage.append(el('summary','Members, invitations & what I share'));card.append(manage);let expanded=false;
   manage.addEventListener('toggle',()=>{if(manage.open&&!expanded){void run(async()=>{expanded=true;try{await details(manage,w);}catch(e){expanded=false;throw e;}});}});root.append(card);
  }
 }
 async function details(root,w){
  const g=generation;const data=await call('/api/workspaces/'+w.id+'/members',null,'GET');if(g!==generation||!root.isConnected)return;
  const base='/api/workspaces/'+w.id;
  if(w.role==='admin'){
   const section=el('section');section.append(el('h3','Invite teammate'));const email=input(section,'Teammate’s Google sign-in email','email');
   const result=el('div');button(section,'Create invitation link',async()=>{if(!email.reportValidity()||!email.value)return;const invite=await call(base+'/invites',{email:email.value.trim()});if(g!==generation||!root.isConnected)return;result.replaceChildren(el('p','Send this link to your teammate. Only that email address can accept; the link expires in 7 days.'));const field=input(result,'Invitation link');field.value=invite.url;field.readOnly=true;button(result,'Copy invitation',async()=>{await navigator.clipboard.writeText(invite.url);status.textContent='Invitation copied. Send it to your teammate.';});});section.append(result);root.append(section);
   for(const invite of data.invites){const row=el('p',invite.email+' · invitation pending');button(row,'Revoke invitation',async()=>{await call(base+'/invites/'+invite.id,null,'DELETE');await refresh();});root.append(row);}
  }
  const memberSection=el('section');memberSection.append(el('h3','Members'));
  for(const m of data.members){const row=el('p',`${m.email}${m.isMe?' (you)':''} · ${m.role} · ${m.sharing?'contributing':'not sharing'}`);
   if(w.role==='admin'&&!m.isMe){button(row,'Make administrator',async()=>{if(confirm(`Transfer administration to ${m.email}?`)){await call(base+'/transfer',{memberId:m.id});await refresh();}});button(row,'Remove member',async()=>{if(confirm(`Remove ${m.email} from this workspace?`)){await call(base+'/members/'+m.id,null,'DELETE');await refresh();}});}
   if(m.isMe)button(row,'Leave workspace',async()=>{if(confirm('Leave this workspace and remove your shared contribution?')){await call(base+'/members/'+m.id,null,'DELETE');await refresh();}});memberSection.append(row);
  }root.append(memberSection);
  const sharing=el('section');sharing.append(el('h3','What I share'),el('p','Names, companies, recorded connections, measured relationship scores and contact dates are visible to every workspace member. Your private feedback stays private.'));
  const mode=select(sharing,'People to share',[['none','Share nothing'],['all','All my contacts'],['people','Choose people'],...(w.contribution.scope.kind==='folders'?[['folders','Keep selected folders']]:[])],w.contribution.enabled?w.contribution.scope.kind==='people'?'people':w.contribution.scope.kind==='folders'?'folders':'all':'none');
  const level=select(sharing,'Context to share',[['names','Names, connections and measured scores'],['themes','Also themes and meeting titles'],['statements','Also short quoted statements']],w.contribution.level);
  const choices=el('div');choices.className='workspace-choices';sharing.append(choices);const selected=new Set(w.contribution.scope.personIds||[]);let people=null;
  async function showPeople(){choices.replaceChildren();if(mode.value!=='people')return;
   if(!people){const result=await call('/api/graph',null,'GET');if(g!==generation||!root.isConnected)return;people=(result.graph?.nodes||[]).filter(p=>p.directRelationship!==false);}
   const search=input(choices,'Find people to share','search'),list=el('div');choices.append(list);
   const render=()=>{list.replaceChildren();for(const p of people.filter(p=>p.name.toLowerCase().includes(search.value.toLowerCase())).slice(0,200)){const l=el('label'),check=el('input');check.type='checkbox';check.checked=selected.has(p.id);check.onchange=()=>{if(check.checked)selected.add(p.id);else selected.delete(p.id);};l.append(check,document.createTextNode(p.name));list.append(l);}if(!people.length)list.append(el('p','Connect Gmail or Granola to contribute contacts. You can still explore the shared network now.'));};search.oninput=render;render();
  }
  mode.onchange=()=>void run(showPeople);await showPeople();
  sharing.append(el('p','Saving shares exactly the selection and context level above. Imported contacts from other members are never shared onward.'));
  button(sharing,'Save sharing choices',async()=>{if(selected.size>200){status.textContent='Choose up to 200 people, or use All my contacts.';return;}await call(base+'/contribution',{enabled:mode.value!=='none',scope:mode.value==='people'?{kind:'people',personIds:[...selected]}:mode.value==='folders'?w.contribution.scope:{kind:'all'},level:level.value},'PUT');await refresh();status.textContent='Sharing choices saved.';});root.append(sharing);
  if(w.role==='admin')button(root,'Delete workspace',async()=>{if(confirm(`Delete ${w.name}? Members will lose access to this shared network. Private accounts remain intact.`)){await call(base,null,'DELETE');await refresh();}});
 }
 return {hasInvite,setAccount(value){if(value===account)return;account=value;generation++;loaded=false;root.replaceChildren(status);if(!account)status.textContent='Sign in with your invited Google account to join. No Obsidian required.';else if(active)void refresh();},refresh(){active=true;if(!loaded)void refresh();},suspend(){active=false;},clear(){generation++;loaded=false;root.replaceChildren();},load:refresh};
}
