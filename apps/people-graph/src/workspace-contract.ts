import type {SharedSlice} from './network-share';
export interface WorkspaceRelationship {score:number|null;scoreVersion:string;lastContact:string|null;observedAt:string;evidenceCategory:'email'|'meeting'|'unknown'}
export interface WorkspaceProfile {name:string;photoUrl:string|null}
export function workspacePhoto(value:unknown):string|null {
 try { const u=new URL(typeof value==='string'?value:'');return u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))?u.href:null;}catch{return null;}
}
export interface WorkspaceSlice {profiles?:Record<string,WorkspaceProfile>;slice:SharedSlice;relationships:Record<string,WorkspaceRelationship>;truncated:boolean}
