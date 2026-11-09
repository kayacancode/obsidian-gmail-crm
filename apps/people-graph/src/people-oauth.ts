import {OAuthProvider,OAuthError,AuthorizationError,insufficientScope,type AuthRequest,type OAuthHelpers,type OAuthResourceContext} from '@cloudflare/workers-oauth-provider';
import {readSession} from './session';
import {authenticatePeopleMemoryGrant,createPeopleMemoryOAuthGrant,revokePeopleMemoryCredential,type PeopleMemoryScope} from './people-memory-auth';
import {peopleMcpRoute,type PeopleMemoryEnv} from './people-memory-agent';

export interface PeopleOAuthEnv extends PeopleMemoryEnv {TOKEN_SECRET:string;OAUTH_KV?:KVNamespace;OAUTH_PROVIDER?:OAuthHelpers}
interface OAuthProps {kind:'people-oauth';owner:string;credentialId:string}
const supportedScopes=['people:read','people:write','offline_access'];
const consentLifetime=15*60*1000;
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const safeHeaders=(input?:HeadersInit)=>{const headers=new Headers(input);headers.set('cache-control','no-store');headers.set('pragma','no-cache');headers.set('referrer-policy','no-referrer');headers.set('x-content-type-options','nosniff');return headers;};
function json(data:unknown,status:number,headers?:HeadersInit){return Response.json(data,{status,headers:safeHeaders(headers)});}
function page(content:string,state:'signin'|'consent'|'error',status=200,input?:HeadersInit,callback?:string){
 const headers=safeHeaders(input);headers.set('content-type','text/html; charset=utf-8');headers.set('x-frame-options','DENY');
 // Native same-origin form posts need an Origin. Never send a referrer to the callback host.
 headers.set('referrer-policy','same-origin');
 const callbackOrigin=callback?new URL(callback).origin:'';
 headers.set('content-security-policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' "+callbackOrigin+"; script-src 'self' https://accounts.google.com/gsi/; style-src 'self' https://accounts.google.com/gsi/style; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; img-src 'self' data:; object-src 'none'");
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect People</title><link rel="stylesheet" href="/oauth-consent.css"><script type="module" src="/oauth-consent.mjs"></script>${state==='signin'?'<script src="https://accounts.google.com/gsi/client" async defer></script>':''}</head><body data-oauth-state="${state}"><main class="oauth-card"><p class="oauth-eyebrow">People</p>${content}<p id="oauth-message" role="status" aria-live="polite"></p></main></body></html>`,{status,headers});
}
function redirect(location:string,headers?:HeadersInit){const result=safeHeaders(headers);result.set('location',location);return new Response(null,{status:302,headers:result});}
function authorizationFailure(request:AuthRequest,code:'invalid_scope'|'invalid_request',description:string):never{throw new AuthorizationError(code,{description,redirectUri:request.redirectUri,state:request.state,issuer:request.issuer});}
function validateAuthorization(request:AuthRequest){
 if(!request.codeChallenge||request.codeChallengeMethod!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge))authorizationFailure(request,'invalid_request','People requires PKCE with an S256 code challenge.');
 if(!request.scope.length||request.scope.length>supportedScopes.length||new Set(request.scope).size!==request.scope.length||request.scope.some(scope=>!supportedScopes.includes(scope))||!request.scope.includes('people:read'))authorizationFailure(request,'invalid_scope','Request people:read, optionally people:write and offline_access.');
}
function validProps(value:unknown):value is OAuthProps{if(!value||typeof value!=='object')return false;const p=value as Partial<OAuthProps>;return p.kind==='people-oauth'&&typeof p.owner==='string'&&p.owner.length>0&&typeof p.credentialId==='string'&&/^[\w-]{1,100}$/.test(p.credentialId);}
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
async function initializeConsents(db:D1Database){
 await db.prepare('CREATE TABLE IF NOT EXISTS people_oauth_consents (handle_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL,claimed_at INTEGER)').run();
 await db.prepare('CREATE INDEX IF NOT EXISTS people_oauth_consents_expiry ON people_oauth_consents(expires_at)').run();
 // Bounded cleanup; consent bindings are short-lived and never contain codes or bearer tokens.
 await db.prepare('DELETE FROM people_oauth_consents WHERE handle_hash IN (SELECT handle_hash FROM people_oauth_consents WHERE expires_at<? LIMIT 50)').bind(Date.now()).run();
}
async function recordConsent(db:D1Database,owner:string,handle:string){await initializeConsents(db);await db.prepare('INSERT INTO people_oauth_consents(handle_hash,owner,expires_at) VALUES(?,?,?)').bind(await digest(handle),owner,Date.now()+consentLifetime).run();}
async function consentOwner(db:D1Database,owner:string,handle:string){await initializeConsents(db);return !!await db.prepare('SELECT handle_hash FROM people_oauth_consents WHERE handle_hash=? AND owner=? AND claimed_at IS NULL AND expires_at>?').bind(await digest(handle),owner,Date.now()).first();}
async function claimConsent(db:D1Database,owner:string,handle:string){const now=Date.now();return !!await db.prepare('UPDATE people_oauth_consents SET claimed_at=? WHERE handle_hash=? AND owner=? AND claimed_at IS NULL AND expires_at>? RETURNING handle_hash').bind(now,await digest(handle),owner,now).first();}
async function initializeGrants(db:D1Database){
 await db.prepare('CREATE TABLE IF NOT EXISTS people_oauth_code_redemptions (grant_key TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE INDEX IF NOT EXISTS people_oauth_code_redemptions_expiry ON people_oauth_code_redemptions(expires_at)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS people_oauth_grants (grant_key TEXT PRIMARY KEY,owner TEXT NOT NULL,credential_id TEXT NOT NULL,expires_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE INDEX IF NOT EXISTS people_oauth_grants_expiry ON people_oauth_grants(expires_at)').run();
 const now=Date.now();
 await db.prepare('DELETE FROM people_oauth_code_redemptions WHERE grant_key IN (SELECT grant_key FROM people_oauth_code_redemptions WHERE expires_at<? LIMIT 50)').bind(now).run();
 await db.prepare('DELETE FROM people_oauth_grants WHERE grant_key IN (SELECT grant_key FROM people_oauth_grants WHERE expires_at<? LIMIT 50)').bind(now).run();
}
/** Called only after the provider has validated code, client, PKCE and resource. */
async function redeemCode(db:D1Database,owner:string,grantId:string,credentialId:string,expiresAt:number){
 await initializeGrants(db);const key=`grant:${owner}:${grantId}`;
 const claimed=await db.prepare('INSERT INTO people_oauth_code_redemptions(grant_key,expires_at) VALUES(?,?) ON CONFLICT(grant_key) DO NOTHING RETURNING grant_key').bind(key,Date.now()+3600000).first();
 // invalid_grant would make the provider revoke the successful concurrent redemption too.
 if(!claimed)throw new OAuthError('invalid_request',{description:'This authorization code has already been redeemed. Restart the connection if necessary.'});
 await db.prepare('INSERT INTO people_oauth_grants(grant_key,owner,credential_id,expires_at) VALUES(?,?,?,?)').bind(key,owner,credentialId,expiresAt).run();
}
/** Follow actual provider grant deletion, never an unverified token prefix or a revocation HTTP 200. */
function revocationAwareKV(kv:KVNamespace,db:D1Database):KVNamespace{
 return new Proxy(kv,{get(target,property){
  if(property==='delete')return async(key:string)=>{
   if(key.startsWith('grant:')){
    await initializeGrants(db);
    const grant=await db.prepare('SELECT owner,credential_id FROM people_oauth_grants WHERE grant_key=?').bind(key).first<{owner:string;credential_id:string}>();
    if(grant)await revokePeopleMemoryCredential(db,grant.owner,grant.credential_id);
   }
   return target.delete(key);
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
}
async function boundedText(request:Request,max:number){
 const declared=Number(request.headers.get('content-length'));if(Number.isFinite(declared)&&declared>max)throw Error('invalid_request');
 const reader=request.body?.getReader();if(!reader)return '';const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let bytes=0,text='';
 try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>max)throw Error('invalid_request');text+=decoder.decode(item.value,{stream:true});}return text+decoder.decode();}
 catch{throw Error('invalid_request');}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function consentRoute(request:Request,env:PeopleOAuthEnv):Promise<Response>{
 const url=new URL(request.url);if(url.pathname!=='/oauth/authorize')return json({error:'not_found'},404);
 const helper=env.OAUTH_PROVIDER!;
 try{
  if(request.method==='GET'){
   // Only an omitted scope gets the read-only default. An explicitly empty or unknown scope is invalid.
   const parsedUrl=new URL(request.url);
   if([...parsedUrl.searchParams.keys()].some(key=>parsedUrl.searchParams.getAll(key).length!==1))return page('<h1>Connection could not be approved</h1><p>Authorization parameters must not be repeated. Restart the connection from your app.</p>','error',400);
   if(!parsedUrl.searchParams.has('scope'))parsedUrl.searchParams.set('scope','people:read');
   const auth=await helper.parseAuthRequest(new Request(parsedUrl,request));validateAuthorization(auth);
   const description=await helper.describeConsent(auth),owner=await readSession(request,env.TOKEN_SECRET);
   if(!owner)return page('<h1>Connect People</h1><p>Sign in to choose which app can use your private People Lens and network.</p><div id="google-signin"></div><p class="oauth-note">After signing in, review the app and its requested permissions before connecting.</p>','signin');
   const transaction=await helper.beginConsent(auth);await recordConsent(env.DB,owner,transaction.handle);
   const permissions=auth.scope.map(scope=>scope==='people:read'?'<li><strong>Read your People Lens and network</strong><span>Access your private relationship context, find people and explain connections.</span></li>':scope==='people:write'?'<li><strong>Save context when you ask</strong><span>Edit your private Lens and relationship profiles, and save context about people.</span></li>':'<li><strong>Stay connected</strong><span>Refresh this connection for up to 30 days without signing in again.</span></li>').join('');
   return page(`<h1>Connect People</h1><p class="oauth-client"><strong>${escape(description.clientName)}</strong> wants to use People.</p><p class="oauth-account">Signed in as <strong>${escape(owner)}</strong></p><p class="oauth-note">The app name is supplied by the app. Approval returns you to <strong>${escape(description.redirectHost)}</strong>.</p>${description.redirectIsLoopback?'<p class="oauth-note">This callback opens a local app. Only approve if you started connecting that app on this computer.</p>':''}<ul class="oauth-permissions">${permissions}</ul><p class="oauth-note">This connection cannot send messages, book meetings, manage sources, or change network sharing. You can revoke it in People → Accounts → Integrations.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><input type="hidden" name="owner" value="${escape(owner)}"><div class="oauth-actions"><button type="submit" name="decision" value="approve">Connect People</button><button type="submit" name="decision" value="deny">Cancel</button></div></form>`,'consent',200,transaction.headers,auth.redirectUri);
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405,{'allow':'GET, POST'});
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return json({error:'invalid_request'},400);
  const fields=new URLSearchParams(await boundedText(request,8192));
  if([...fields.keys()].some(key=>!['handle','owner','decision'].includes(key))||['handle','owner','decision'].some(key=>fields.getAll(key).length!==1))return json({error:'invalid_request'},400);
  const handle=fields.get('handle')!,expectedOwner=fields.get('owner')!,decision=fields.get('decision');
  if(handle.length>256||!handle||!['approve','deny'].includes(decision!))return json({error:'invalid_request'},400);
  const owner=await readSession(request,env.TOKEN_SECRET);
  if(!owner)return page('<h1>Sign-in expired</h1><p>Restart the connection from your app and sign in again.</p>','error',401);
  if(owner!==expectedOwner||!await consentOwner(env.DB,owner,handle))return page('<h1>Connection could not be approved</h1><p>The account changed, or this approval has expired or was already used. Restart the connection from your app.</p>','error',409);
  if(decision==='deny'){
   const denied=await helper.denyConsent(request,handle);
   if(!await claimConsent(env.DB,owner,handle))return json({error:'consent_already_used'},409);
   return redirect(denied.redirectTo,denied.headers);
  }
  const approved=await helper.approveConsent(request,handle);validateAuthorization(approved.request);
  if(!await claimConsent(env.DB,owner,handle))return json({error:'consent_already_used'},409);
  const description=await helper.describeConsent(approved.request);
  const name='OAuth · '+description.clientName.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,70);
  // The random integration secret is discarded. OAuth tokens use this row only as an owner-revocable fence.
  const credential=await createPeopleMemoryOAuthGrant(env.DB,owner,name,approved.request.scope.filter(scope=>scope!=='offline_access') as PeopleMemoryScope[],approved.request.scope.includes('offline_access')?2592000:3600);
  try{
   const completed=await helper.completeAuthorization({request:approved.request,userId:owner,metadata:{name,credentialId:credential.id},scope:approved.request.scope,props:{kind:'people-oauth',owner,credentialId:credential.id} satisfies OAuthProps,revokeExistingGrants:false});
   return redirect(completed.redirectTo,approved.headers);
  }catch(error){await revokePeopleMemoryCredential(env.DB,owner,credential.id);throw error;}
 }catch(error){
  if(error instanceof AuthorizationError){if(error.redirectTo)return redirect(error.redirectTo);return page(`<h1>Connection could not be approved</h1><p>${escape(error.description)}</p>`,'error',400);}
  return page('<h1>Connection could not be completed</h1><p>Restart the connection from your app and try again.</p>','error',error instanceof Error&&error.message==='invalid_request'?400:503);
 }
}
export function isPeopleOAuthRequest(request:Request){const path=new URL(request.url).pathname;return path.startsWith('/oauth/')||path.startsWith('/.well-known/oauth-')||(path==='/api/people-mcp'&&!/^Bearer people_/i.test(request.headers.get('authorization')||''));}
export async function peopleOAuthRoute(request:Request,env:PeopleOAuthEnv,context?:ExecutionContext):Promise<Response>{
 let origin:string;
 try{if(!env.APP_ORIGIN)throw Error();const configured=new URL(env.APP_ORIGIN);if(configured.protocol!=='https:'||configured.username||configured.password||configured.pathname!=='/'||configured.search||configured.hash)throw Error();origin=configured.origin;}catch{return json({error:'oauth_unavailable'},503);}
 const url=new URL(request.url),resource=origin+'/api/people-mcp';
 if(url.origin!==origin)return json({error:'invalid_origin'},400);
 if(!env.OAUTH_KV)return json({error:'oauth_unavailable'},503);
 if(request.url.length>16384)return json({error:'invalid_request'},400);
 try{
  let explicitlyRequestedScopes:string[]|undefined;
  // Bound protocol-owned request bodies before the provider parses them, including chunked input.
  if(request.method==='POST'&&['/oauth/token','/oauth/register'].includes(url.pathname)){
   const text=await boundedText(request,32768);
   if(url.pathname==='/oauth/token'&&/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type')||'')){
    const fields=new URLSearchParams(text);
    if([...fields.keys()].some(key=>fields.getAll(key).length!==1))return json({error:'invalid_request',error_description:'Token request parameters must not be repeated.'},400);
    if(fields.has('scope')){
     explicitlyRequestedScopes=fields.get('scope')!.split(' ').filter(Boolean);
     if(explicitlyRequestedScopes.length>supportedScopes.length||new Set(explicitlyRequestedScopes).size!==explicitlyRequestedScopes.length||explicitlyRequestedScopes.some(scope=>!supportedScopes.includes(scope))||!explicitlyRequestedScopes.includes('people:read'))return json({error:'invalid_scope',error_description:'Request people:read, optionally people:write and offline_access.'},400);
    }
   }
   request=new Request(request,{body:text});
  }
  const provider=new OAuthProvider<PeopleOAuthEnv>({
   apiRoute:'/api/people-mcp',authorizeEndpoint:'/oauth/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
   accessTokenTTL:3600,refreshTokenTTL:30*86400,scopesSupported:supportedScopes,requiredScopes:['people:read'],clientIdMetadataDocumentEnabled:false,
   resourceMetadata:{resource,authorization_servers:[origin],bearer_methods_supported:['header'],resource_name:'People'},
   defaultHandler:{fetch:consentRoute},
   apiHandler:{async fetch(req,bindings,ctx){
    const current=ctx as OAuthResourceContext<OAuthProps>;
    if(!validProps(current.props)||current.auth.userId!==current.props.owner||current.auth.audience!==resource)return unauthorized(resource);
    let principal;
    try{principal=await authenticatePeopleMemoryGrant(bindings.DB,current.props.owner,current.props.credentialId);}catch(error){if(error instanceof Error&&error.message==='people_memory_unauthorized')return unauthorized(resource);return json({error:'oauth_unavailable'},503);}
    principal.scopes=principal.scopes.filter(scope=>current.auth.scope.includes(scope)&&['people:read','people:write'].includes(scope));
    if(!principal.scopes.includes('people:read'))return insufficientScope(current.auth,['people:read']);
    return peopleMcpRoute(req,bindings,principal);
   }},
   clientRegistrationCallback({clientMetadata}){
    const name=clientMetadata.client_name,redirects=clientMetadata.redirect_uris;
    if(name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>200||/[\u0000-\u001f\u007f]/.test(name)))return {description:'Provide an app name of 1–200 printable characters.'};
    if(Array.isArray(redirects)&&(redirects.length>10||redirects.some(uri=>typeof uri!=='string'||uri.length>2048)))return {description:'Provide at most ten redirect URLs of at most 2048 characters.'};
   },
   async tokenExchangeCallback(options){
    if(!validProps(options.props)||options.userId!==options.props.owner||options.resource!==resource)throw new OAuthError('invalid_grant',{description:'This People connection is invalid. Reconnect People.'});
    let principal;
    try{principal=await authenticatePeopleMemoryGrant(options.env.DB,options.props.owner,options.props.credentialId);}catch(error){if(error instanceof Error&&error.message==='people_memory_unauthorized')throw new OAuthError('invalid_grant',{description:'This People connection was revoked or expired. Reconnect People.'});throw new OAuthError('temporarily_unavailable',{description:'People could not check this connection. Try again.',statusCode:503});}
    // The provider narrows unknown scopes before its callback. Validate the original request too,
    // so clients never mistake a silently reduced grant for successful permission escalation.
    const scope=explicitlyRequestedScopes??options.requestedScope;
    if(scope.some(value=>!supportedScopes.includes(value)||!options.scope.includes(value)||(value!=='offline_access'&&!principal.scopes.includes(value as PeopleMemoryScope))))throw new OAuthError('invalid_scope',{description:'Requested scopes exceed this People connection. Reconnect People to approve additional permissions.'});
    if(!scope.includes('people:read'))throw new OAuthError('invalid_scope',{description:'People requires people:read.'});
    const remaining=Math.floor(((principal.expiresAt??Date.now())-Date.now())/1000);if(remaining<60)throw new OAuthError('invalid_grant',{description:'This People connection has expired. Reconnect People.'});
    if(options.grantType==='authorization_code')await redeemCode(options.env.DB,principal.owner,options.grantId,principal.credentialId,principal.expiresAt!);
    return {accessTokenScope:scope,accessTokenTTL:Math.min(3600,remaining),refreshTokenTTL:options.scope.includes('offline_access')?Math.min(30*86400,remaining):0};
   },
   onError(){/* Provider responses already contain safe protocol errors; never log tokens or metadata. */},
  });
  const ctx=context??({props:{},waitUntil(promise:Promise<unknown>){void promise.catch(()=>{});},passThroughOnException(){}} as ExecutionContext);
  // The provider caches helpers on its environment. A fresh environment prevents a helper from
  // another request retaining an unwrapped KV binding and bypassing revocation synchronization.
  const bindings:PeopleOAuthEnv={...env,OAUTH_KV:revocationAwareKV(env.OAUTH_KV,env.DB),OAUTH_PROVIDER:undefined};
  const response=await provider.fetch(request,bindings,ctx);
  const headers=safeHeaders(response.headers);
  if(response.headers.get('content-type')?.startsWith('text/html'))headers.set('referrer-policy','same-origin');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }catch(error){return json({error:error instanceof Error&&error.message==='invalid_request'?'invalid_request':'oauth_unavailable'},error instanceof Error&&error.message==='invalid_request'?400:503);}
}
function unauthorized(resource:string){const metadata=new URL(resource);metadata.pathname='/.well-known/oauth-protected-resource'+metadata.pathname;return json({error:'invalid_token'},401,{'www-authenticate':`Bearer error="invalid_token", resource_metadata="${metadata.href}", scope="people:read"`});}
