const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
async function post(action,body){return fetch('/api/desktop-auth/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
export function installDesktopSignIn(container){
 const button=document.createElement('button');button.textContent='Sign in using your browser';
 const status=document.createElement('span');status.setAttribute('role','status');container.replaceChildren(button,status);
 let generation=0;
 button.onclick=async()=>{
  const current=++generation;button.disabled=true;
  try{
   const id=hex(crypto.getRandomValues(new Uint8Array(32))),verifier=hex(crypto.getRandomValues(new Uint8Array(32)));
   const challenge=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
   const response=await post('start',{id,challenge});if(!response.ok)throw Error('Could not start sign-in. Please retry.');
   const url=new URL('/desktop-signin.html',location.origin);url.hash=id;
   window.parent.postMessage({type:'people:browser-signin',url:url.href},'*');
   status.textContent='Complete sign-in and approve the connection in your browser. Waiting…';
   const deadline=Date.now()+300000;
   while(current===generation&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const result=await post('redeem',{id,verifier});
    if(result.status===200){location.reload();return;}
    if(result.status!==202)throw Error('Could not finish sign-in. Please retry.');
   }
   throw Error('Sign-in timed out. Please retry.');
  }catch(error){status.textContent=error.message;button.disabled=false;}
 };
}
