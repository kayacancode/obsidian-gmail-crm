const make=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
const messages={
  granola_unauthorized:'Granola rejected that API key. Check it and try again.',
  granola_forbidden:'Granola denied access for this API key.',
  granola_rate_limited:'Granola is receiving too many requests. Wait a moment and try again.',
  granola_timeout:'Granola took too long to respond. Try again.',
  granola_unavailable:'Granola is temporarily unavailable. Try again.',
  mail_not_configured:'Granola connections are not enabled on this server yet.',
  invalid_request:'That request was not accepted. Reload and try again.',
};
const diagnosticCodes=new Set(['transport','http_4xx','http_5xx','http_other','response_json','page_shape','page_cursor','page_terminal_cursor','folder_id','folder_name','folder_parent','note_shape','unexpected']);
const STATUS_LABEL={syncing:'Syncing meetings · scoring automatically',connected:'Up to date',reconnect_required:'Reconnect required',error:'Sync paused'};

export function createGranolaConnection(root,{onUnauthorized}={}){
  let account=null,busy=false,generation=0,pending=null,timer=null,status=null;

  const heading=make('h2','Connect Granola');
  const intro=make('p','Sync your Granola meetings. Attendees join your network and meeting context feeds the why-now panel.');
  const signIn=make('p','Sign in to People before connecting Granola.','granola-signin');
  const form=make('form',null,'granola-form');
  const keyLabel=make('label','Granola API key');keyLabel.htmlFor='granola-api-key';
  const input=make('input');input.id='granola-api-key';input.name='granola-api-key';input.type='password';input.autocomplete='off';input.spellcheck=false;
  const rangeLabel=make('label','Meeting history');rangeLabel.htmlFor='granola-range';
  const range=make('select');range.id='granola-range';
  for(const [value,text] of [['recent','Last 90 days'],['all','All meetings']]){const o=make('option',text);o.value=value;range.append(o);}
  const connectButton=make('button','Connect Granola','primary');connectButton.type='submit';
  form.append(keyLabel,input,rangeLabel,range,connectButton);
  const help=make('p',null,'granola-disclosure');
  help.append(document.createTextNode('Your key is stored encrypted on this app’s server so meetings can sync in the background. Summaries, your private notes and transcripts are imported and analysed for context. Disconnect removes the key and everything imported. '));
  const helpLink=make('a','Find your API key in Granola ↗');helpLink.href='https://docs.granola.ai/help-center/sharing/integrations/granola-api';helpLink.target='_blank';helpLink.rel='noreferrer';
  help.append(helpLink);
  const statusLine=make('p','Not connected.','granola-status');statusLine.setAttribute('role','status');statusLine.setAttribute('aria-live','polite');
  const card=make('section',null,'granola-card inbox');
  const cardTitle=make('h3','Granola');
  const cardStatus=make('span','','status');
  const progress=make('p','','granola-progress');
  const syncLine=make('p','');
  const errorLine=make('p','');
  const actions=make('div',null,'buttons');
  const syncButton=make('button','Sync now');syncButton.type='button';
  const disconnectButton=make('button','Disconnect');disconnectButton.type='button';
  actions.append(syncButton,disconnectButton);
  const foldersHeading=make('h4','Folders');
  const foldersHint=make('p','All folders sync. Uncheck a folder to hide its meetings from your graph and stop syncing it.','granola-disclosure');
  const folderList=make('ul',null,'granola-folders');
  card.append(cardTitle,cardStatus,progress,syncLine,errorLine,actions,foldersHeading,foldersHint,folderList);
  root.replaceChildren(heading,intro,signIn,form,help,statusLine,card);

  function abort(){pending?.abort();pending=null;}
  function stopPolling(){clearTimeout(timer);timer=null;}
  function clear(){generation++;abort();stopPolling();input.value='';busy=false;status=null;statusLine.textContent='Not connected.';render();}
  function setAccount(next){if(next===account)return;clear();account=next;render();if(account)void load();}
  function showError(code,diagnostic){
    statusLine.textContent=messages[code]||messages.granola_unavailable;
    if(code==='granola_unavailable'&&diagnosticCodes.has(diagnostic))statusLine.textContent=`Granola connection failed. Diagnostic: ${diagnostic}. Share this code for troubleshooting, not your API key.`;
  }
  function render(){
    const connected=Boolean(status?.connected);
    const reconnect=status?.status==='reconnect_required';
    signIn.hidden=Boolean(account);
    form.hidden=!account||(connected&&!reconnect);
    help.hidden=!account||(connected&&!reconnect);
    connectButton.textContent=reconnect?'Reconnect Granola':'Connect Granola';
    rangeLabel.hidden=range.hidden=reconnect;
    input.disabled=!account||busy;connectButton.disabled=!account||busy||!input.value.trim();
    card.hidden=!connected;
    if(!connected)return;
    cardStatus.textContent=STATUS_LABEL[status.status]||status.status;
    const c=status.counts;
    progress.textContent=status.status==='syncing'?`${c.extracted.toLocaleString()} of ${(c.notes+c.pending).toLocaleString()} meetings analysed`:`${c.notes.toLocaleString()} meetings · ${status.range==='all'?'All history':'Last 90 days'}${c.failed?` · ${c.failed} could not be analysed`:''}`;
    syncLine.textContent=status.lastSync?'Last completed sync: '+new Date(status.lastSync).toLocaleString()+(status.status==='connected'&&status.nextSync?' · next '+new Date(status.nextSync).toLocaleTimeString():''):'First sync has not completed yet.';
    errorLine.textContent=status.error?(status.status==='syncing'?'Temporary issue. Retrying automatically.':status.error==='reconnect_required'?'Granola rejected the stored key. Enter a new key to reconnect.':status.error==='note_cap_reached'?'Meeting limit reached; newest meetings are kept.':'Sync paused: '+(messages[status.error]||status.error)):'';
    syncButton.disabled=busy||status.status==='syncing'||reconnect;
    syncButton.textContent=status.status==='error'?'Retry sync':'Sync now';
    disconnectButton.disabled=busy;
    folderList.replaceChildren();
    const byParent=new Map();for(const f of status.folders){const list=byParent.get(f.parentId)??[];list.push(f);byParent.set(f.parentId,list);}
    const addLevel=(parentId,depth)=>{for(const f of byParent.get(parentId)??[]){const li=make('li');li.dataset.id=f.id;li.style.setProperty('--depth',String(depth));const label=make('label');const box=make('input');box.type='checkbox';box.value=f.id;box.checked=!f.excluded;box.disabled=busy;box.addEventListener('change',()=>void toggle());label.append(box,document.createTextNode(` ${f.name} `));const count=make('span',`${f.noteCount} meeting${f.noteCount===1?'':'s'}`,'hint');label.append(count);if(f.excluded){count.textContent='Hidden from your graph';}li.append(label);folderList.append(li);addLevel(f.id,depth+1);}};
    addLevel(null,0);
    if(!status.folders.length)folderList.append(make('li','No Granola folders are available yet.'));
  }
  async function request(path,body,method,run){
    const controller=new AbortController();pending=controller;
    try{
      const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
      let data={};try{data=await response.json();}catch{}
      if(run!==generation)throw Object.assign(Error('stale'),{stale:true});
      if(!response.ok)throw Object.assign(Error('request failed'),{status:response.status,code:data?.error,diagnostic:data?.diagnostic});
      return data;
    }finally{if(pending===controller)pending=null;}
  }
  function fail(error){
    if(error?.name==='AbortError'||error?.stale)return;
    if(error?.status===401){clear();account=null;render();onUnauthorized?.();return;}
    showError(error?.code,error?.diagnostic);render();
  }
  function schedule(){stopPolling();if(!account||!status?.connected)return;timer=setTimeout(()=>void load(),status.status==='syncing'?5000:60000);}
  async function load(){
    if(!account)return;const run=generation;
    try{status=await request('/api/granola/status',null,'GET',run);if(run!==generation)return;render();schedule();}
    catch(error){fail(error);}
  }
  async function connect(){
    if(busy||!account)return;busy=true;const run=generation;render();
    const key=input.value;
    try{status=await request('/api/granola/connect',{apiKey:key,range:range.value},'POST',run);input.value='';statusLine.textContent='';render();schedule();}
    catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }
  async function toggle(){
    if(busy||!status)return;busy=true;const run=generation;
    const excluded=[...folderList.querySelectorAll('input[type=checkbox]')].filter(b=>!b.checked).map(b=>b.value);
    try{status=await request('/api/granola/folders',{excluded},'PATCH',run);render();}
    catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }
  async function syncNow(){if(busy)return;busy=true;const run=generation;try{status=await request('/api/granola/sync',null,'POST',run);render();schedule();}catch(error){fail(error);}finally{if(run===generation){busy=false;render();}}}
  async function disconnect(){
    if(busy)return;if(!window.confirm('Disconnect Granola? The stored key and all imported meetings, attendees and context are removed from your graph.'))return;
    busy=true;const run=generation;
    try{await request('/api/granola/connection',null,'DELETE',run);status=null;statusLine.textContent='Granola disconnected.';stopPolling();render();}
    catch(error){fail(error);}
    finally{if(run===generation){busy=false;render();}}
  }

  input.addEventListener('input',render);
  form.addEventListener('submit',event=>{event.preventDefault();void connect();});
  syncButton.addEventListener('click',()=>void syncNow());
  disconnectButton.addEventListener('click',()=>void disconnect());
  window.addEventListener('pagehide',()=>{abort();stopPolling();input.value='';});
  render();
  return {setAccount,clear,refresh:()=>void load()};
}
