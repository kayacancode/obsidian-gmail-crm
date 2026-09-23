import type {ShareLevel,ShareScope} from './network-share';
export interface Contribution {includeObsidian?:boolean;shareProfiles?:boolean;enabled:boolean;scope:ShareScope;level:ShareLevel}
export interface Member {id:string;email:string;role:'admin'|'member';contribution:Contribution}
export interface Invite {id:string;email:string;hash:string;expiresAt:number;used:boolean;revoked:boolean}
export interface Workspace {id:string;name:string;revision:number;members:Member[];invites:Invite[]}
export class WorkspaceError extends Error {constructor(public status:number,message:string){super(message);}}
export function deny(status:number,message:string):never {throw new WorkspaceError(status,message);}
const ready=new WeakMap<object,Promise<unknown>>();
export async function ensureWorkspaces(db:D1Database){
 let p=ready.get(db);if(!p){p=db.prepare('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, creator TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL)').run().catch(e=>{ready.delete(db);throw e;});ready.set(db,p);}await p;
}
export async function readWorkspace(db:D1Database,id:string):Promise<Workspace>{
 await ensureWorkspaces(db);const row=await db.prepare('SELECT data,revision FROM workspaces WHERE id=?').bind(id).first<{data:string;revision:number}>();
 if(!row)return deny(403,'workspace_unavailable');return {...JSON.parse(row.data),revision:row.revision};
}
export function memberOf(w:Workspace,email:string):Member{return w.members.find(m=>m.email===email)??deny(403,'workspace_unavailable');}
export function adminOf(w:Workspace,email:string):Member{const m=memberOf(w,email);if(m.role!=='admin')deny(403,'admin_required');return m;}
/** Optimistic compare-and-swap serializes all membership/consent changes in one bounded row. */
export async function changeWorkspace(db:D1Database,id:string,change:(w:Workspace)=>void):Promise<Workspace>{
 for(let attempt=0;attempt<32;attempt++){
  const w=await readWorkspace(db,id);change(w);const revision=w.revision;w.revision++;
  const result=await db.prepare('UPDATE workspaces SET data=?,revision=? WHERE id=? AND revision=?').bind(JSON.stringify(w),w.revision,id,revision).run();
  if(result.meta.changes===1)return w;
 }return deny(409,'workspace_changed_retry');
}
export async function hashToken(token:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');}
export const emptyContribution=():Contribution=>({enabled:false,scope:{kind:'all'},level:'names'});
export function publicWorkspace(w:Workspace,me:string){const m=memberOf(w,me);return {id:w.id,name:w.name,revision:w.revision,role:m.role,memberId:m.id,memberCount:w.members.length,contribution:m.contribution};}
