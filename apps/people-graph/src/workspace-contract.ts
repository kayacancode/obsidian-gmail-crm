import type {SharedSlice} from './network-share';
export interface WorkspaceRelationship {score:number|null;scoreVersion:string;lastContact:string|null;observedAt:string;evidenceCategory:'email'|'meeting'|'unknown'}
export interface WorkspaceSlice {slice:SharedSlice;relationships:Record<string,WorkspaceRelationship>;truncated:boolean}
