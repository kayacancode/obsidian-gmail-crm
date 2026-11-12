const $=s=>document.querySelector(s);let approval=null,busy=false,generation=0;
async function request(path,body,credential){const response=await fetch('/api/'+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){const error=Error(data.error||'Request failed');error.status=response.status;throw error;}return data;}
const code=()=>$('#user-code').value.trim().toUpperCase();
async function signin(){const {googleClientId}=await fetch('/api/config').then(r=>r.json());const start=Date.now();while(!window.google?.accounts?.id&&Date.now()-start<10000)await new Promise(r=>setTimeout(r,100));if(!window.google?.accounts?.id)throw Error('Google sign-in could not load. Reload to try again.');google.accounts.id.initialize({client_id:googleClientId,callback:async r=>{try{await request('session',{},r.credential);$('#signin').replaceChildren();await preview();}catch(e){$('#status').textContent=e.message;}}});google.accounts.id.renderButton($('#signin'),{theme:'outline',size:'large'});}
function consent(data){
 if(data.scopes===undefined)return null;
 if(!Array.isArray(data.scopes)||!data.scopes.length||new Set(data.scopes).size!==data.scopes.length||!Array.isArray(data.scopeDescriptions)||data.scopeDescriptions.length!==data.scopes.length||data.scopeDescriptions.some((item,index)=>!item||item.scope!==data.scopes[index]||typeof item.description!=='string'||!item.description.trim())||data.credentialExpiresInDays!==90)throw Error('Invalid permission preview');
 return {scopes:[...data.scopes],descriptions:data.scopeDescriptions.map(item=>({scope:item.scope,description:item.description}))};
}
async function preview(){
 const run=++generation,requestedCode=code();approval=null;$('#approval').hidden=true;
 try{
  const data=await request('cli/device/preview',{userCode:requestedCode});if(run!==generation)return;
  const permissions=consent(data);
  $('#device').textContent='Device: '+data.deviceName;$('#owner').textContent='People account: '+data.owner;
  $('#permission-summary').textContent=permissions?'This terminal requests these permissions:':'Allows searching people, relationship scores, and recorded connections. Cannot edit your network or manage inboxes.';
  $('#scopes').replaceChildren(...(permissions?.descriptions||[]).map(item=>{const row=document.createElement('li');row.textContent=item.scope+' — '+item.description;return row;}));
  $('#expiry').textContent=permissions?'Access expires after 90 days. Revoke it any time in Accounts → Integrations.':'Access expires after 30 days. Revoke it any time in Accounts → Connected CLI devices.';
  $('#approve').textContent=permissions?'Approve these permissions':'Approve read-only access';
  approval={owner:data.owner,code:requestedCode,permissions};$('#approval').hidden=false;$('#status').textContent='';
 }catch(e){if(run!==generation)return;$('#status').textContent=e.status===401?'Sign in to the People account you want to connect.':'This code is unavailable or expired. Start peoplegraph login again.';if(e.status===401)await signin();}
}
$('#code-form').onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;try{await preview();}finally{busy=false;}};
$('#user-code').oninput=()=>{generation++;approval=null;$('#approval').hidden=true;};
$('#approve').onclick=async()=>{
 if(busy||!approval)return;const selected=approval,run=generation;busy=true;$('#approve').disabled=true;$('#user-code').disabled=true;
 try{
  const current=await request('cli/device/preview',{userCode:selected.code});if(run!==generation)return;
  if(current.owner!==selected.owner){await preview();$('#status').textContent='Your account changed. Review the account above and approve again.';return;}
  if(JSON.stringify(consent(current))!==JSON.stringify(selected.permissions)){await preview();$('#status').textContent='The requested permissions changed. Review them above and approve again.';return;}
  await request('cli/device/approve',{userCode:selected.code,expectedOwner:selected.owner,...(selected.permissions?{expectedScopes:selected.permissions.scopes}:{})});
  approval=null;$('#approval').hidden=true;$('#code-form').hidden=true;$('#status').textContent='Connected. Return to your terminal.';
 }catch(e){$('#status').textContent='Approval failed. Check the code and try again.';}finally{busy=false;$('#approve').disabled=false;$('#user-code').disabled=false;}
};
