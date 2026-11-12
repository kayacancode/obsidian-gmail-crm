// Google credentials are exchanged only for the same-origin, HttpOnly People
// session. Consent and the authorization redirect remain server-controlled.
if(document.body.dataset.oauthState==='signin')void initializeSignin();

async function initializeSignin(){
 const target=document.querySelector('#google-signin'),message=document.querySelector('#oauth-message');
 if(!target||!message)return;
 let busy=false;
 try{
  const response=await fetch('/api/config',{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('config');
  const {googleClientId}=await response.json();
  if(typeof googleClientId!=='string'||!googleClientId.trim())throw Error('config');
  const started=Date.now();
  while(!window.google?.accounts?.id&&Date.now()-started<10000)await new Promise(resolve=>setTimeout(resolve,100));
  if(!window.google?.accounts?.id)throw Error('signin_unavailable');
  window.google.accounts.id.initialize({client_id:googleClientId,callback:async result=>{
   if(busy)return;
   if(typeof result?.credential!=='string'||!result.credential.trim()){message.textContent='Could not sign in. Please try again.';return;}
   busy=true;message.textContent='Signing in…';
   try{
    const session=await fetch('/api/session',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json',authorization:'Bearer '+result.credential},body:'{}'});
    if(!session.ok)throw Error('signin_failed');
    // Reload preserves state, redirect URI and PKCE exactly as supplied to the
    // original server-validated authorization request.
    window.location.reload();
   }catch{message.textContent='Could not sign in. Please try again.';}
   finally{busy=false;}
  }});
  window.google.accounts.id.renderButton(target,{theme:'outline',size:'large',text:'signin_with',width:Math.min(320,target.clientWidth||320)});
  message.textContent='Sign in to the People account you want to connect.';
 }catch{message.textContent='Google sign-in could not load. Reload this page to try again.';}
}
