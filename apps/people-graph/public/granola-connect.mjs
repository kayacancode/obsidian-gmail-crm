const make=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
const messages={
  granola_unauthorized:'Granola rejected that API key. Check it and try again.',
  granola_forbidden:'Granola denied access for this API key.',
  granola_rate_limited:'Granola is receiving too many requests. Wait a moment and try again.',
  granola_timeout:'Granola took too long to respond. Try again.',
  granola_unavailable:'Granola browsing is temporarily unavailable. Try again.',
};

export function createGranolaConnection(root,{onUnauthorized}={}){
  let account=null,apiKey='',connected=false,busy=false,generation=0,pending=null;
  let folders=[],notes=[],folderCursor=null,noteCursor=null,foldersMore=false,notesMore=false,selectedFolder='';
  const usedFolderCursors=new Set(),usedNoteCursors=new Set();

  const heading=make('h2','Connect Granola');
  const intro=make('p','Browse your Granola folders and note titles before any future import.');
  const signIn=make('p','Sign in to People before connecting Granola.','granola-signin');
  const form=make('form',null,'granola-form');
  const label=make('label','Granola API key');
  label.htmlFor='granola-api-key';
  const input=make('input');
  input.id='granola-api-key';input.name='granola-api-key';input.type='password';input.autocomplete='off';input.spellcheck=false;
  const connectButton=make('button','Connect Granola','primary');connectButton.type='submit';
  form.append(label,input,connectButton);
  const help=make('p',null,'granola-disclosure');
  help.append(document.createTextNode('Your key goes through this app’s backend to Granola and stays in memory only. Re-enter it after leaving this tab or refreshing. This connection only browses folders and note metadata; AI analysis and graph import are not available yet. '));
  const helpLink=make('a','Find your API key in Granola ↗');
  helpLink.href='https://docs.granola.ai/help-center/sharing/integrations/enterprise-api';helpLink.target='_blank';helpLink.rel='noreferrer';
  help.append(helpLink);
  const status=make('p','Not connected.','granola-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const connectedBar=make('div',null,'granola-connected');
  const connectedLabel=make('strong','Connected for this session');
  const disconnectButton=make('button','Disconnect Granola');disconnectButton.type='button';
  connectedBar.append(connectedLabel,disconnectButton);
  const browser=make('section',null,'granola-browser');
  const folderLabel=make('label','Granola folder');folderLabel.htmlFor='granola-folder';
  const folderSelect=make('select');folderSelect.id='granola-folder';
  const folderActions=make('div',null,'granola-actions');
  const moreFolders=make('button','More folders');moreFolders.type='button';
  const browseNotes=make('button','Browse notes','primary');browseNotes.type='button';
  folderActions.append(moreFolders,browseNotes);
  const folderMessage=make('p',null,'granola-message');
  const notesHeading=make('h3','Notes');
  const noteList=make('ul',null,'granola-notes');
  const moreNotes=make('button','More notes');moreNotes.type='button';
  const noteMessage=make('p',null,'granola-message');
  browser.append(folderLabel,folderSelect,folderActions,folderMessage,notesHeading,noteList,moreNotes,noteMessage);
  root.replaceChildren(heading,intro,signIn,form,help,status,connectedBar,browser);

  function abort(){pending?.abort();pending=null;}
  function resetNotes(){
    generation++;abort();busy=false;notes=[];noteCursor=null;notesMore=false;usedNoteCursors.clear();
  }
  function clear(){
    generation++;abort();apiKey='';input.value='';connected=false;busy=false;folders=[];notes=[];folderCursor=null;noteCursor=null;foldersMore=false;notesMore=false;selectedFolder='';usedFolderCursors.clear();usedNoteCursors.clear();status.textContent='Not connected.';folderMessage.textContent='';noteMessage.textContent='';render();
  }
  function setAccount(next){
    if(next===account)return;
    clear();account=next;render();
  }
  function showError(code){
    status.textContent=messages[code]||'Granola browsing is temporarily unavailable. Try again.';
  }
  function render(){
    signIn.hidden=Boolean(account);
    input.disabled=!account||busy||connected;
    connectButton.disabled=!account||busy||connected||!input.value.trim();
    connectedBar.hidden=!connected;
    browser.hidden=!connected;
    folderSelect.disabled=busy||folders.length===0;
    folderSelect.replaceChildren();
    const choice=make('option','Choose a folder');choice.value='';folderSelect.append(choice);
    for(const folder of folders){const option=make('option',folder.name);option.value=folder.id;folderSelect.append(option);}
    folderSelect.value=selectedFolder;
    moreFolders.hidden=!foldersMore;
    moreFolders.disabled=busy;
    browseNotes.disabled=busy||!selectedFolder;
    noteList.replaceChildren();
    for(const item of notes){
      const row=make('li');
      row.append(make('strong',item.title));
      const date=make('time','Created '+new Date(item.createdAt).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}));
      date.dateTime=item.createdAt;row.append(date);noteList.append(row);
    }
    notesHeading.hidden=!selectedFolder;
    noteList.hidden=!selectedFolder;
    moreNotes.hidden=!notesMore;
    moreNotes.disabled=busy;
    if(connected&&!folders.length&&!folderMessage.textContent)folderMessage.textContent='No Granola folders are available.';
  }
  async function request(path,body,run){
    const controller=new AbortController();pending=controller;
    try{
      const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      let data={};try{data=await response.json();}catch{}
      if(run!==generation)throw Object.assign(Error('stale'),{stale:true});
      if(!response.ok)throw Object.assign(Error('request failed'),{status:response.status,code:data?.error});
      return data;
    }finally{if(pending===controller)pending=null;}
  }
  function fail(error,wasConnected){
    if(error?.name==='AbortError'||error?.stale)return;
    if(error?.status===401){clear();account=null;showError('app_unauthorized');render();onUnauthorized?.();return;}
    if(!wasConnected||error?.code==='granola_unauthorized'||error?.code==='granola_forbidden')clear();
    showError(error?.code);render();
  }
  async function loadFolders(cursor=null,key=apiKey){
    if(busy)return;
    if(cursor&&usedFolderCursors.has(cursor)){foldersMore=false;folderMessage.textContent='Folder browsing stopped because Granola repeated a page cursor.';render();return;}
    if(cursor)usedFolderCursors.add(cursor);
    busy=true;const run=generation,wasConnected=connected;render();
    try{
      const data=await request('/api/granola/folders',{apiKey:key,...(cursor?{cursor}:{})},run);
      if(run!==generation)return;
      const next=[...folders,...data.folders].slice(0,300);
      folders=next;connected=true;apiKey=key;input.value='';status.textContent='';
      folderCursor=data.cursor;foldersMore=Boolean(data.hasMore&&data.cursor);
      folderMessage.textContent='';
      if(folders.length>=300&&foldersMore){foldersMore=false;folderCursor=null;folderMessage.textContent='Folder limit reached. Showing the first 300 folders.';}
    }catch(error){fail(error,wasConnected);}finally{if(run===generation){busy=false;render();}}
  }
  async function loadNotes(cursor=null){
    if(busy||!selectedFolder||!apiKey)return;
    if(cursor&&usedNoteCursors.has(cursor)){notesMore=false;noteMessage.textContent='Note browsing stopped because Granola repeated a page cursor.';render();return;}
    if(cursor)usedNoteCursors.add(cursor);
    busy=true;const run=generation,folderId=selectedFolder;render();
    try{
      const data=await request('/api/granola/notes',{apiKey,folderId,...(cursor?{cursor}:{})},run);
      if(run!==generation||folderId!==selectedFolder)return;
      notes=[...notes,...data.notes].slice(0,300);noteCursor=data.cursor;notesMore=Boolean(data.hasMore&&data.cursor);noteMessage.textContent=notes.length?'':'No notes are available in this folder.';
      if(notes.length>=300&&notesMore){notesMore=false;noteCursor=null;noteMessage.textContent='Note limit reached. Showing the first 300 notes.';}
    }catch(error){fail(error,true);}finally{if(run===generation){busy=false;render();}}
  }

  input.addEventListener('input',render);
  form.addEventListener('submit',event=>{event.preventDefault();const key=input.value;void loadFolders(null,key);});
  disconnectButton.addEventListener('click',clear);
  moreFolders.addEventListener('click',()=>void loadFolders(folderCursor));
  folderSelect.addEventListener('change',()=>{selectedFolder=folderSelect.value;resetNotes();folderMessage.textContent='';noteMessage.textContent='';render();});
  browseNotes.addEventListener('click',()=>void loadNotes());
  moreNotes.addEventListener('click',()=>void loadNotes(noteCursor));
  render();
  return {setAccount,clear};
}
