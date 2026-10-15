import type {SharedSlice} from './network-share';
import type {MeasuredContact} from '../../../shared/measured-contact';
export interface WorkspaceRelationship {calendarActivity?:import('./calendar').CalendarActivity;completedIntroductions?:number;confirmedAt?:string;activity?:MeasuredContact;inboxes?:string[];score:number|null;scoreVersion:string;lastContact:string|null;observedAt:string;publishedScore?:{strength:number;momentum:number;combined:number};evidenceCategory:'email'|'meeting'|'score'|'unknown'}
export interface WorkspaceProfile {name:string;photoUrl:string|null}
export function workspacePhoto(value:unknown):string|null {
 try { const u=new URL(typeof value==='string'?value:'');return u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))?u.href:null;}catch{return null;}
}
export interface WorkspaceSlice {profiles?:Record<string,WorkspaceProfile>;slice:SharedSlice;relationships:Record<string,WorkspaceRelationship>;truncated:boolean}

export function supportsIntroduction(r:WorkspaceRelationship){return Boolean(r.confirmedAt||(r.evidenceCategory==='score'&&Number.isFinite(r.score)&&r.score!>0)||(['email','meeting'].includes(r.evidenceCategory)&&!(r.activity&&(!r.activity.sent||!r.activity.received)&&!r.activity.meetings)));}

export interface ViewerPrivateContext {summary:string;observedAt:string;sourceType:string;title:string}
