import {b64,bytes,digest,opaque} from './mail-model';
import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';
export const configured=(env:MailEnv)=>Boolean(env.GOOGLE_CLIENT_SECRET&&env.MAIL_TOKEN_KEY&&env.APP_ORIGIN);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
function cookie(request:Request){return request.headers.get('cookie')?.split(';').map(c=>c.trim()).find(c=>c.startsWith('__Host-people-connect='))?.slice('__Host-people-connect='.length)||'';}
export async function mailCallback(request:Request,env:MailEnv){
 if(!configured(env))return json({error:'mail_not_configured'},503);
 const url=new URL(request.url),state=url.searchParams.get('state')||'',parts=state.split('.');
 if(parts.length!==2||state.length>2000||parts[1]!==await opaque('oauth',parts[0],env.TOKEN_SECRET))return json({error:'invalid_oauth_state'},400);
 let owner:string,nonce:string;try{const payload=JSON.parse(new TextDecoder().decode(bytes(parts[0])));owner=payload.owner;nonce=payload.nonce;if(typeof owner!=='string'||typeof nonce!=='string')throw Error();}catch{return json({error:'invalid_oauth_state'},400);}
 const stub=env.MAIL.getByName(owner),pending=await stub.consume(nonce,await digest(cookie(request)));if(!pending)return json({error:'expired_oauth_state',message:'Return to Accounts and connect again in the same browser.'},400);
 let result='connected';
 try{const code=url.searchParams.get('code');if(!code||url.searchParams.has('error'))throw Error('access_denied');const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET!,redirect_uri:pending.redirect,grant_type:'authorization_code',code_verifier:pending.verifier}),signal:AbortSignal.timeout(20000)});if(!response.ok){await response.body?.cancel();throw Error('token_exchange_failed');}const grant=await boundedJSON(response,32_768) as {access_token:string;refresh_token?:string;scope?:string};if(!grant.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.readonly'))throw Error('gmail_permission_missing');const profile=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{authorization:'Bearer '+grant.access_token},signal:AbortSignal.timeout(20000)});if(!profile.ok){await profile.body?.cancel();throw Error('gmail_profile_failed');}const data=await boundedJSON(profile,16_384) as {emailAddress?:string};if(!data.emailAddress)throw Error('gmail_profile_failed');await stub.attachAccount(data.emailAddress.toLowerCase(),grant.refresh_token||'',pending.range,Boolean(grant.scope?.split(' ').includes('https://www.googleapis.com/auth/contacts.readonly')),Boolean(grant.scope?.split(' ').includes('https://www.googleapis.com/auth/contacts.other.readonly')));}catch(e){const allowed=['access_denied','token_exchange_failed','gmail_permission_missing','gmail_profile_failed','offline_access_missing','account_limit'];result=e instanceof Error&&allowed.includes(e.message)?e.message:'connection_failed';}
 return new Response(null,{status:303,headers:{location:env.APP_ORIGIN+'/accounts.html?connection='+result,'set-cookie':'__Host-people-connect=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0','cache-control':'no-store','referrer-policy':'no-referrer'}});
}
export async function mailRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname,stub=env.MAIL.getByName(owner);
 if(request.method==='GET'&&path==='/api/accounts')return json({account:owner,configured:configured(env),accounts:await stub.list()});
 if(!configured(env))return json({error:'mail_not_configured',message:'Email connections are not enabled on this server yet.'},503);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
 const raw=await request.text();if(raw.length>2000)return json({error:'request_too_large'},413);let body:{email?:string;range?:string};try{body=JSON.parse(raw);}catch{return json({error:'invalid_json'},400);}
 const range=body.range==='all'?'all':'recent';
 if(path==='/api/accounts/connect'){
  const nonce=crypto.randomUUID(),verifier=b64(crypto.getRandomValues(new Uint8Array(32))),browser=b64(crypto.getRandomValues(new Uint8Array(32))),redirect=env.APP_ORIGIN+'/api/accounts/callback';
  await stub.begin(nonce,{verifier,cookie:await digest(browser),expires:Date.now()+600000,range,owner,redirect});
  const payload=b64(new TextEncoder().encode(JSON.stringify({owner,nonce}))),state=payload+'.'+await opaque('oauth',payload,env.TOKEN_SECRET);const google=new URL('https://accounts.google.com/o/oauth2/v2/auth');Object.entries({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly',access_type:'offline',prompt:'consent select_account',state,code_challenge:await digest(verifier),code_challenge_method:'S256'}).forEach(([k,v])=>google.searchParams.set(k,v));
  return Response.json({url:google.href},{headers:{'cache-control':'no-store','set-cookie':`__Host-people-connect=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`}});
 }
 if(typeof body.email!=='string'||body.email.length>320)return json({error:'invalid_account'},400);
 if(path==='/api/accounts/sync'){await stub.start(body.email,body.range==='all'||body.range==='recent'?body.range:undefined);return json({ok:true});}
 if(path==='/api/accounts/disconnect'){await stub.remove(body.email);return json({ok:true});}
 return json({error:'not_found'},404);
}
/**
 * POST /api/people/draft — an outreach draft from the person's own evidence. The app never
 * sends it. The response's `checked`/`warnings` come straight from MailSync.draftNote's Jev
 * check (or `checked:false, warnings:[]` when Jev is not configured or fails); the route only
 * forwards them.
 */
export async function draftRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
 const raw=await request.text();if(raw.length>2000)return json({error:'invalid_request'},400);
 let personId:unknown;try{personId=(JSON.parse(raw) as {personId?:unknown}|null)?.personId;}catch{return json({error:'invalid_request'},400);}
 if(typeof personId!=='string'||!personId||personId.length>200||personId.includes('@'))return json({error:'invalid_request'},400);
 const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
 try{return json(await stub.draftNote(personId));}
 catch(error){
  const code=error instanceof Error?error.message:'';
  if(code==='unknown_person')return json({error:'unknown_person'},404);
  if(code==='ai_unavailable')return json({error:'ai_unavailable',message:'The drafting model is unavailable. Try again shortly.'},503);
  if(code==='invalid_draft')return json({error:'invalid_draft',message:'The draft did not pass safety checks. Try again.'},502);
  throw error;
 }
}
/**
 * POST /api/people/search — "who in my network can help with…". The body is one bounded query;
 * the response is the owner's own people with a score and the evidence behind it, and never an
 * email address. `checked` says whether Jev ranked the results or the keyword pass stood alone;
 * a Jev failure is not an error here, it is an unchecked ranking (see MailSync.searchPeople).
 */
export async function searchRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
 const raw=await request.text();if(raw.length>2000)return json({error:'invalid_request'},400);
 let query:unknown;try{query=(JSON.parse(raw) as {query?:unknown}|null)?.query;}catch{return json({error:'invalid_request'},400);}
 if(typeof query!=='string'||!query.trim()||query.trim().length>200)return json({error:'invalid_request'},400);
 const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
 try{return json(await stub.searchPeople(query.trim()));}
 catch(error){
  if(error instanceof Error&&error.message==='invalid_request')return json({error:'invalid_request'},400);
  throw error;
 }
}
