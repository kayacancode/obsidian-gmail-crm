import {buildWorkspaceGraph,searchWorkspace,draftWorkspace} from './workspace-graph';
import type {ShareEnv} from './share-routes';
import {normalizeShareLevel,normalizeShareScope} from './network-share';
import {WorkspaceError,deny,ensureWorkspaces,readWorkspace,changeWorkspace,memberOf,adminOf,emptyContribution,publicWorkspace,hashToken} from './workspace-store';
import type {Workspace} from './workspace-store';
export const isWorkspacePath=(p:string)=>p==='/api/workspaces'||p.startsWith('/api/workspaces/')||p==='/api/workspace-invites/accept';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const email=(v:unknown)=>typeof v==='string'&&v.length<=320&&/^[^\s@,<>"']+@[^\s@,<>"']+\.[^\s@,<>"']+$/.test(v)?v.toLowerCase():deny(400,'invalid_email');
async function bodyOf(r:Request){
 const reader=r.body?.getReader();if(!reader)return {};let text='',bytes=0;const decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16384){await reader.cancel();deny(413,'request_too_large');}text+=decoder.decode(value,{stream:true});}const b=JSON.parse(text+decoder.decode());if(!b||typeof b!=='object'||Array.isArray(b))deny(400,'invalid_request');return b;}catch(e){if(e instanceof WorkspaceError)throw e;return deny(400,'invalid_request');}
}
export async function workspaceRoute(request:Request,env:ShareEnv,me:string):Promise<Response>{
 try{
  const url=new URL(request.url),method=request.method;
  if(method!=='GET'&&request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  const body=method==='GET'?{}:await bodyOf(request);await ensureWorkspaces(env.DB);
  if(url.pathname==='/api/workspaces'){
   if(method==='GET'){
    const rows=await env.DB.prepare("SELECT data,revision FROM workspaces WHERE EXISTS (SELECT 1 FROM json_each(data,'$.members') WHERE json_extract(value,'$.email')=?)").bind(me).all<{data:string;revision:number}>();
    return json({workspaces:rows.results.map(r=>publicWorkspace({...JSON.parse(r.data),revision:r.revision},me))});
   }
   if(method==='POST'){
    const name=typeof body.name==='string'?body.name.trim():'';if(!name||name.length>80)deny(400,'invalid_name');
    const w:Workspace={id:crypto.randomUUID(),name,revision:1,members:[{id:crypto.randomUUID(),email:me,role:'admin',contribution:emptyContribution()}],invites:[]};
    const r=await env.DB.prepare('INSERT INTO workspaces (id,creator,revision,data) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM workspaces WHERE creator=?)<20').bind(w.id,me,1,JSON.stringify(w),me).run();
    if(!r.meta.changes)deny(409,'workspace_limit');return json({workspace:publicWorkspace(w,me)});
   }return json({error:'method_not_allowed'},405);
  }
  if(url.pathname==='/api/workspace-invites/accept'){
   if(method!=='POST')return json({error:'method_not_allowed'},405);
   const token=typeof body.token==='string'?body.token:'';const [id,secret]=token.split('.');if(!id||!secret||token.length>200)deny(400,'invalid_invite');const hash=await hashToken(token);
   const w=await changeWorkspace(env.DB,id,w=>{
    const i=w.invites.find(i=>i.hash===hash);if(!i)deny(403,'invalid_invite');
    if(i.email!==me)deny(403,'sign_in_with_invited_email');if(i.used||i.revoked)deny(409,'invite_unavailable');if(i.expiresAt<=Date.now())deny(410,'invite_expired');
    if(w.members.some(m=>m.email===me))deny(409,'already_a_member');if(w.members.length>=20)deny(409,'member_limit');
    i.used=true;w.members.push({id:crypto.randomUUID(),email:me,role:'member',contribution:emptyContribution()});
   });return json({workspace:publicWorkspace(w,me)});
  }
  const graphPath=url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(graph|search|draft)$/);
  if(graphPath){const [,id,action]=graphPath;
   if(action==='graph'&&method==='GET')return json({account:me,graph:await buildWorkspaceGraph(env,id,me)});
   if(action==='search'&&method==='POST'){if(typeof body.query!=='string'||!body.query.trim()||body.query.length>200)deny(400,'invalid_query');return json(await searchWorkspace(env,id,me,body.query.trim()));}
   if(action==='draft'&&method==='POST'){if(typeof body.personId!=='string'||typeof body.memberId!=='string')deny(400,'invalid_request');return json(await draftWorkspace(env,id,me,body.personId,body.memberId));}
   return json({error:'method_not_allowed'},405);
  }
  const match=url.pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(members|invites|contribution|transfer)(?:\/([^/]+))?)?$/);
  if(!match)return json({error:'not_found'},404);const [,id,action,target]=match;
  if(method==='GET'&&action==='members'){
   const w=await readWorkspace(env.DB,id),self=memberOf(w,me);
   return json({workspace:publicWorkspace(w,me),members:w.members.map(m=>({id:m.id,email:m.email,role:m.role,isMe:m.email===me,sharing:m.contribution.enabled})),invites:self.role==='admin'?w.invites.filter(i=>!i.used&&!i.revoked&&i.expiresAt>Date.now()).map(i=>({id:i.id,email:i.email,expiresAt:i.expiresAt})):[]});
  }
  if(method==='POST'&&action==='invites'){
   const invited=email(body.email),token=id+'.'+Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join(''),hash=await hashToken(token),inviteId=crypto.randomUUID();
   await changeWorkspace(env.DB,id,w=>{adminOf(w,me);if(w.members.some(m=>m.email===invited))deny(409,'already_a_member');
    w.invites=w.invites.filter(i=>!i.used&&!i.revoked&&i.expiresAt>Date.now()&&i.email!==invited);if(w.invites.length>=20)deny(409,'invite_limit');
    w.invites.push({id:inviteId,email:invited,hash,expiresAt:Date.now()+7*86400000,used:false,revoked:false});});
   return json({token,url:url.origin+'/accounts#workspace-invite='+encodeURIComponent(token)});
  }
  if(method==='DELETE'&&!action){
   const w=await readWorkspace(env.DB,id);adminOf(w,me);const r=await env.DB.prepare('DELETE FROM workspaces WHERE id=? AND revision=?').bind(id,w.revision).run();if(!r.meta.changes)deny(409,'workspace_changed_retry');return json({ok:true});
  }
  const w=await changeWorkspace(env.DB,id,w=>{
   const self=memberOf(w,me);
   if(method==='PUT'&&action==='contribution'){
    if(typeof body.enabled!=='boolean')deny(400,'invalid_contribution');
    try{self.contribution={includeObsidian:body.includeObsidian===true,shareProfiles:body.shareProfiles===true,enabled:body.enabled,scope:normalizeShareScope(body.scope),level:normalizeShareLevel(body.level)};}catch{deny(400,'invalid_contribution');}return;
   }
   if(method==='DELETE'&&action==='invites'&&target){adminOf(w,me);const i=w.invites.find(i=>i.id===target);if(i)i.revoked=true;return;}
   if(method==='POST'&&action==='transfer'){
    adminOf(w,me);const next=w.members.find(m=>m.id===body.memberId);if(!next)deny(400,'invalid_member');self.role='member';next.role='admin';return;
   }
   if(method==='DELETE'&&action==='members'&&target){
    const victim=w.members.find(m=>m.id===target);if(!victim)deny(404,'member_not_found');if(victim.email!==me)adminOf(w,me);if(victim.role==='admin')deny(409,'transfer_admin_first');
    w.members=w.members.filter(m=>m.id!==target);w.invites.forEach(i=>{if(i.email===victim.email)i.revoked=true;});return;
   }deny(405,'method_not_allowed');
  });return json({ok:true,revision:w.revision});
 }catch(e){if(e instanceof WorkspaceError)return json({error:e.message},e.status);throw e;}
}
