const make=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};

// Plain-language levels. The option text is the promise itself, the hint says what it means in
// the viewer's graph. Keep both in one place so they can never drift apart.
const LEVELS=[
  ['names','Names and companies only','They see who you know and where those people work. No themes, no quotes.'],
  ['themes','Plus themes','They also see what those people are working on, as theme names.'],
  ['statements','Plus quoted statements','They also see short quotes from your notes about those people.'],
];
const LEVEL_LABEL=new Map(LEVELS.map(([value,label])=>[value,label]));

const messages={
  invalid_request:'That was not accepted. Check the email address and what you chose to share.',
  share_limit:'You can share with up to 50 people. Stop sharing with someone first.',
  request_too_large:'That is too much to send at once. Choose fewer people or folders.',
  unknown_share:'That share is no longer there. Reload this page.',
  server_error:'Sharing is temporarily unavailable. Try again.',
};
// A viewer may hold at most 20 incoming shares, and the route accepts an 8 KB body; keep the
// people picker well inside both so a large selection fails in the form, not at the server.
const MAX_PEOPLE=200;
const MAX_VISIBLE_PEOPLE=60;

export function createSharePanel(root,{onUnauthorized}={}){
  let account=null,busy=false,generation=0,pending=null;
  let shares={outgoing:[],incoming:[]};
  let folders=null,folderError=false;
  let people=null,peopleError=false;
  const chosenFolders=new Set();
  const chosenPeople=new Set();

  const heading=make('h2','Share your network');
  const intro=make('p','Share a slice of your network with someone else who uses People. They see the people you choose, labelled “via you”. You choose how much shows, and you can stop at any time.');
  const signIn=make('p','Sign in to People before sharing your network.','share-signin');

  const form=make('form',null,'share-form');
  const viewerLabel=make('label','Their email address');viewerLabel.htmlFor='share-viewer';
  const viewer=make('input');viewer.id='share-viewer';viewer.name='share-viewer';viewer.type='email';viewer.autocomplete='off';viewer.spellcheck=false;viewer.placeholder='name@example.com';

  const scope=make('fieldset',null,'share-scope');
  scope.append(make('legend','Who to share'));
  const scopeInputs=new Map();
  for(const [value,label] of [['all','All meetings'],['folders','Choose folders'],['people','Choose people']]){
    const row=make('label',null,'share-choice');
    const radio=make('input');radio.type='radio';radio.name='share-scope';radio.value=value;radio.checked=value==='all';
    radio.addEventListener('change',()=>{if(radio.checked)void chooseScope(value);});
    row.append(radio,document.createTextNode(` ${label}`));
    scope.append(row);
    scopeInputs.set(value,radio);
  }
  const folderList=make('ul',null,'share-folders');
  const folderNote=make('p','','share-note');
  const peopleSearchLabel=make('label','Find a person');peopleSearchLabel.htmlFor='share-person-search';
  const peopleSearch=make('input');peopleSearch.id='share-person-search';peopleSearch.type='search';peopleSearch.placeholder='Search your network';
  const peopleList=make('ul',null,'share-people');
  const peopleNote=make('p','','share-note');
  scope.append(folderList,folderNote,peopleSearchLabel,peopleSearch,peopleList,peopleNote);

  const levelLabel=make('label','How much to show');levelLabel.htmlFor='share-level';
  const level=make('select');level.id='share-level';
  for(const [value,label] of LEVELS){const option=make('option',label);option.value=value;level.append(option);}
  const levelHint=make('p',LEVELS[0][2],'share-note');
  const shareButton=make('button','Share','primary');shareButton.type='submit';
  form.append(viewerLabel,viewer,scope,levelLabel,level,levelHint,shareButton);

  const status=make('p','','share-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');

  const outgoingHeading=make('h3','Shared by me');
  const outgoingEmpty=make('p','You have not shared your network with anyone yet.','share-note');
  const outgoingList=make('ul',null,'share-list');
  outgoingList.setAttribute('aria-label','People you share your network with');
  const incomingHeading=make('h3','Shared with me');
  const incomingEmpty=make('p','Nobody has shared their network with you yet.','share-note');
  const incomingList=make('ul',null,'share-list');
  incomingList.setAttribute('aria-label','People who share their network with you');

  root.replaceChildren(heading,intro,signIn,form,status,outgoingHeading,outgoingEmpty,outgoingList,incomingHeading,incomingEmpty,incomingList);

  function currentScope(){for(const [value,radio] of scopeInputs)if(radio.checked)return value;return 'all';}
  function abort(){pending?.abort();pending=null;}
  function reset(){
    abort();busy=false;
    shares={outgoing:[],incoming:[]};
    folders=null;folderError=false;people=null;peopleError=false;
    chosenFolders.clear();chosenPeople.clear();
    viewer.value='';peopleSearch.value='';
    scopeInputs.get('all').checked=true;
    level.value='names';
    status.textContent='';
  }
  function clear(){generation++;reset();render();}
  function suspend(){generation++;abort();busy=false;}
  function setAccount(next){if(next===account)return;clear();account=next;render();if(account)void load();}

  function scopeSummary(value){
    if(value?.kind==='folders'){
      const count=value.ids?.length??0;
      const named=(value.ids??[]).map(id=>folders?.find(folder=>folder.id===id)?.name).filter(Boolean);
      return named.length===count&&count?named.join(', '):`${count} folder${count===1?'':'s'}`;
    }
    if(value?.kind==='people'){const count=value.personIds?.length??0;return `${count} chosen ${count===1?'person':'people'}`;}
    return 'All meetings';
  }

  function render(){
    signIn.hidden=Boolean(account);
    form.hidden=!account;
    outgoingHeading.hidden=incomingHeading.hidden=!account;
    const choice=currentScope();
    folderList.hidden=folderNote.hidden=choice!=='folders';
    peopleSearchLabel.hidden=peopleSearch.hidden=peopleList.hidden=peopleNote.hidden=choice!=='people';
    levelHint.textContent=LEVELS.find(([value])=>value===level.value)?.[2]??'';
    viewer.disabled=!account||busy;
    level.disabled=!account||busy;
    for(const radio of scopeInputs.values())radio.disabled=!account||busy;
    shareButton.disabled=!account||busy||!viewer.value.trim()
      ||(choice==='folders'&&!chosenFolders.size)||(choice==='people'&&!chosenPeople.size);
    renderFolders();
    renderPeople();
    renderShares();
  }

  function renderFolders(){
    if(currentScope()!=='folders')return;
    folderList.replaceChildren();
    if(folderError){folderNote.textContent='Your folders could not be loaded. Try again.';return;}
    if(folders===null){folderNote.textContent='Loading your folders…';return;}
    if(!folders.length){folderNote.textContent='No Granola folders are available. Connect Granola to share by folder.';return;}
    folderNote.textContent='People who attended a meeting in the folders you tick are shared.';
    for(const folder of folders){
      const item=make('li');item.dataset.id=folder.id;
      const label=make('label');
      const box=make('input');box.type='checkbox';box.value=folder.id;box.checked=chosenFolders.has(folder.id);box.disabled=busy;
      box.addEventListener('change',()=>{if(box.checked)chosenFolders.add(folder.id);else chosenFolders.delete(folder.id);render();});
      label.append(box,document.createTextNode(` ${folder.name} `),make('span',`${folder.noteCount} meeting${folder.noteCount===1?'':'s'}`,'share-hint'));
      item.append(label);folderList.append(item);
    }
  }

  function renderPeople(){
    if(currentScope()!=='people')return;
    peopleList.replaceChildren();
    if(peopleError){peopleNote.textContent='Your network could not be loaded. Try again.';return;}
    if(people===null){peopleNote.textContent='Loading your network…';return;}
    if(!people.length){peopleNote.textContent='Your network has nobody in it yet.';return;}
    const needle=peopleSearch.value.trim().toLocaleLowerCase();
    const matches=people.filter(person=>!needle
      ||person.name.toLocaleLowerCase().includes(needle)
      ||(person.company??'').toLocaleLowerCase().includes(needle));
    const shown=matches.slice(0,MAX_VISIBLE_PEOPLE);
    peopleNote.textContent=chosenPeople.size>=MAX_PEOPLE
      ? `You can share up to ${MAX_PEOPLE} people at once.`
      : `${chosenPeople.size} chosen · showing ${shown.length} of ${matches.length}`;
    for(const person of shown){
      const item=make('li');item.dataset.personId=person.id;
      const label=make('label');
      const box=make('input');box.type='checkbox';box.value=person.id;box.checked=chosenPeople.has(person.id);
      box.disabled=busy||(!chosenPeople.has(person.id)&&chosenPeople.size>=MAX_PEOPLE);
      box.addEventListener('change',()=>{if(box.checked)chosenPeople.add(person.id);else chosenPeople.delete(person.id);render();});
      label.append(box,document.createTextNode(` ${person.name} `));
      if(person.company)label.append(make('span',person.company,'share-hint'));
      item.append(label);peopleList.append(item);
    }
    if(matches.length>shown.length)peopleList.append(make('li','Search to narrow this list.','share-note'));
  }

  function renderShares(){
    outgoingList.replaceChildren();
    outgoingEmpty.hidden=Boolean(!account||shares.outgoing.length);
    for(const share of shares.outgoing){
      const item=make('li');item.dataset.viewer=share.viewerEmail;
      const line=make('span',null,'share-row');
      line.append(make('b',share.viewerEmail),
        make('span',`${scopeSummary(share.scope)} · ${LEVEL_LABEL.get(share.level)??share.level}`,'share-hint'));
      const buttons=make('div',null,'buttons');
      const revoke=make('button','Revoke','disconnect');revoke.type='button';revoke.disabled=busy;
      revoke.addEventListener('click',()=>void revokeShare(share.viewerEmail));
      buttons.append(revoke);
      item.append(line,buttons);outgoingList.append(item);
    }
    incomingList.replaceChildren();
    incomingEmpty.hidden=Boolean(!account||shares.incoming.length);
    for(const share of shares.incoming){
      const item=make('li');item.dataset.owner=share.ownerEmail;
      const line=make('span',null,'share-row');
      line.append(make('b',share.ownerEmail),
        make('span',`${LEVEL_LABEL.get(share.level)??share.level}${share.hidden?' · Hidden from your graph':''}`,'share-hint'));
      const buttons=make('div',null,'buttons');
      const toggle=make('button',share.hidden?'Show':'Hide');toggle.type='button';toggle.disabled=busy;
      toggle.addEventListener('click',()=>void hideShare(share.ownerEmail,!share.hidden));
      buttons.append(toggle);
      item.append(line,buttons);incomingList.append(item);
    }
  }

  async function request(path,body,method,run){
    const controller=new AbortController();pending=controller;
    try{
      const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',
        headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
      let data={};try{data=await response.json();}catch{}
      if(run!==generation)throw Object.assign(Error('stale'),{stale:true});
      if(!response.ok)throw Object.assign(Error('request failed'),{status:response.status,code:data?.error});
      return data;
    }finally{if(pending===controller)pending=null;}
  }
  function fail(error){
    if(error?.name==='AbortError'||error?.stale)return;
    if(error?.status===401){clear();account=null;render();onUnauthorized?.();return;}
    status.textContent=messages[error?.code]??messages.server_error;
    render();
  }

  async function load(){
    if(!account)return;const run=generation;
    try{const data=await request('/api/shares',null,'GET',run);if(run!==generation)return;
      shares={outgoing:data.outgoing??[],incoming:data.incoming??[]};render();}
    catch(error){fail(error);}
  }
  async function loadFolders(){
    const run=generation;
    try{const data=await request('/api/granola/status',null,'GET',run);if(run!==generation)return;
      folders=data.folders??[];folderError=false;}
    catch(error){if(error?.stale||error?.name==='AbortError')return;if(error?.status===401)return fail(error);folderError=true;}
    render();
  }
  async function loadPeople(){
    const run=generation;
    try{const data=await request('/api/graph',null,'GET',run);if(run!==generation)return;
      people=(data.graph?.nodes??[]).filter(node=>(node.type??'person')==='person')
        .map(node=>({id:node.id,name:node.name,company:node.company??''}))
        .sort((a,b)=>a.name.localeCompare(b.name));
      peopleError=false;}
    catch(error){if(error?.stale||error?.name==='AbortError')return;if(error?.status===401)return fail(error);peopleError=true;}
    render();
  }
  async function chooseScope(value){
    status.textContent='';
    render();
    if(value==='folders'&&folders===null&&!busy)await loadFolders();
    if(value==='people'&&people===null&&!busy)await loadPeople();
  }

  function scopeBody(){
    const choice=currentScope();
    if(choice==='folders')return {kind:'folders',ids:[...chosenFolders]};
    if(choice==='people')return {kind:'people',personIds:[...chosenPeople]};
    return {kind:'all'};
  }
  async function share(){
    if(busy||!account)return;
    const viewerEmail=viewer.value.trim();
    if(!viewerEmail)return;
    busy=true;const run=generation;status.textContent='';render();
    try{
      const data=await request('/api/shares',{viewerEmail,scope:scopeBody(),level:level.value},'POST',run);
      if(run!==generation)return;
      status.textContent=data.people
        ? `Shared with ${viewerEmail}. ${data.people.toLocaleString()} ${data.people===1?'person is':'people are'} now in their network.`
        : `Shared with ${viewerEmail}. Nothing is in their network yet; they may have hidden this share.`;
      viewer.value='';
      await load();
    }catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }
  async function revokeShare(viewerEmail){
    if(busy)return;
    if(!window.confirm(`Stop sharing your network with ${viewerEmail}? Everything you shared is removed from their graph.`))return;
    busy=true;const run=generation;status.textContent='';render();
    try{await request('/api/shares',{viewerEmail},'DELETE',run);if(run!==generation)return;
      status.textContent=`You no longer share your network with ${viewerEmail}.`;await load();}
    catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }
  async function hideShare(ownerEmail,hidden){
    if(busy)return;
    busy=true;const run=generation;status.textContent='';render();
    try{await request('/api/shares/hide',{ownerEmail,hidden},'POST',run);if(run!==generation)return;
      status.textContent=hidden
        ? `${ownerEmail}’s people are hidden from your graph.`
        : `${ownerEmail}’s people are back in your graph.`;
      await load();}
    catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }

  viewer.addEventListener('input',render);
  level.addEventListener('change',render);
  peopleSearch.addEventListener('input',render);
  form.addEventListener('submit',event=>{event.preventDefault();void share();});
  window.addEventListener('pagehide',()=>{abort();});
  render();
  return {setAccount,clear,suspend,refresh:()=>void load()};
}
