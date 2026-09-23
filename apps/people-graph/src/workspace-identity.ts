import {opaque} from './mail-model';
import {ensureWorkspaces,type Workspace} from './workspace-store';
import type {ShareEnv} from './share-routes';
/** Workspace-specific matching; never export raw addresses or a global identifier. */
export const matchingKey=(env:Pick<ShareEnv,'TOKEN_SECRET'>,id:string)=>opaque('workspace-matching-v1',id,env.TOKEN_SECRET);
export async function identityToken(key:string,email:string){
 const encoder=new TextEncoder(),k=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,encoder.encode(email.trim().toLowerCase()))),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function matchingWorkspaces(env:ShareEnv,email:string){
 await ensureWorkspaces(env.DB);
 const rows=await env.DB.prepare("SELECT data FROM workspaces WHERE EXISTS (SELECT 1 FROM json_each(workspaces.data,'$.members') m WHERE json_extract(m.value,'$.email')=?)").bind(email).all<{data:string}>();
 const result=[];
 for(const row of rows.results){const w=JSON.parse(row.data) as Workspace,m=w.members.find(m=>m.email===email);
  if(m?.contribution.enabled&&m.contribution.includeObsidian&&m.contribution.scope.kind!=='folders')result.push({id:w.id,key:await matchingKey(env,w.id)});
 }
 return result.slice(0,8);
}
export const matchedPersonId=(env:Pick<ShareEnv,'TOKEN_SECRET'>,workspace:string,token:string)=>opaque('workspace:'+workspace,'matched-person:'+token,env.TOKEN_SECRET);
