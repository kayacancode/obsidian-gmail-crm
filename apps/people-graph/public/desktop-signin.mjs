const id=location.hash.slice(1),status=document.querySelector('#status'),approve=document.querySelector('#approve');
async function account(){const r=await fetch('/api/desktop-auth/account');if(!r.ok)return false;const data=await r.json();status.textContent='Connect '+data.account+' to the waiting Obsidian tab?';document.querySelector('#signin').replaceChildren();approve.hidden=false;return true;}
async function start(){
 if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid connection request. Start again from Obsidian.');
 if(await account())return;
 const config=await fetch('/api/config').then(r=>r.json());
 const deadline=Date.now()+10000;while(!window.google?.accounts?.id&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 if(!window.google?.accounts?.id)throw Error('Google sign-in failed to load. Refresh to retry.');
 google.accounts.id.initialize({client_id:config.googleClientId,callback:async result=>{try{const r=await fetch('/api/session',{method:'POST',headers:{authorization:'Bearer '+result.credential}});if(!r.ok)throw Error('Sign-in failed. Refresh to retry.');await account();}catch(e){status.textContent=e.message;}}});
 google.accounts.id.renderButton(document.querySelector('#signin'),{theme:'outline',size:'large'});status.textContent='Sign in, then approve the connection.';
}
approve.onclick=async()=>{approve.disabled=true;try{const r=await fetch('/api/desktop-auth/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});if(!r.ok)throw Error('This request expired or was already used. Start again from Obsidian.');status.textContent='Connected. Return to your Obsidian People graph. You can close this page.';approve.hidden=true;}catch(e){status.textContent=e.message;approve.disabled=false;}};
start().catch(e=>{status.textContent=e.message;});
