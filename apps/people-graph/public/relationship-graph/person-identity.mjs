/** Explicit owner corrections; suggestions based on a name are never applied automatically. */
export function renderPersonIdentity({graph,person,onMergePeople,onUnmergePeople}) {
  if(graph.source!=='email_accounts'||typeof onMergePeople!=='function'||person.memoryEligible!==true)return null;
  const el=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
  const details=el('details');details.className='person-identity';
  details.style.cssText='border-top:1px solid var(--line,#ddd);padding-top:12px;margin-top:16px';
  details.append(el('summary','Duplicate profiles'));
  const status=el('p');status.setAttribute('role','status');
  details.append(el('p','Combine another record for this same person. Their connections and saved context stay together. You can undo this.'));
  const label=el('label','Find their other profile');const search=el('input');search.type='search';search.placeholder='Name or company';search.setAttribute('aria-label','Find duplicate profile');label.append(search);details.append(label);
  const results=el('div');details.append(results,status);
  const people=graph.nodes.filter(node=>node.id!==person.id&&node.type==='person'&&node.memoryEligible===true);
  const normalized=value=>String(value||'').trim().toLowerCase();
  function render(){
    results.replaceChildren();const query=normalized(search.value);
    const candidates=people.filter(node=>query?normalized(node.name+' '+node.company).includes(query):normalized(node.name)===normalized(person.name)).slice(0,8);
    if(!candidates.length){results.append(el('p',query?'No matching profiles.':'Search for another profile to combine.'));return;}
    for(const node of candidates){
      const row=el('div');row.style.cssText='padding:10px 0';row.append(el('p',node.name+(node.company?' · '+node.company:'')));
      const button=el('button','Combine with this profile');button.type='button';button.setAttribute('aria-label','Combine '+node.name+(node.company?' at '+node.company:''));
      button.onclick=async()=>{button.disabled=true;status.textContent='Combining profiles…';try{await onMergePeople(node.id,person.id);status.textContent='Profiles combined.';}catch{button.disabled=false;status.textContent='Could not combine these profiles. Reload and try again.';}};
      row.append(button);results.append(row);
    }
  }
  search.addEventListener('input',render);render();
  for(const profile of person.mergedProfiles||[]){
    const row=el('div');row.append(el('p','Combined: '+profile.name+(profile.company?' · '+profile.company:'')));
    const undo=el('button','Separate this profile');undo.type='button';undo.onclick=async()=>{undo.disabled=true;try{await (onUnmergePeople||onMergePeople)(profile.id);status.textContent='Profiles separated.';}catch{undo.disabled=false;status.textContent='Could not separate this profile. Try again.';}};row.append(undo);details.append(row);
  }
  return details;
}
