/** Only observed activity, never personal feedback or inferred note mentions. */
export interface MeasuredContact {version:1;sent:number;received:number;lastEmail:string|null;meetings:number;lastMeeting:string|null}
export function measuredContact(value:unknown,now=Date.now()):MeasuredContact|null {
 if(!value||typeof value!=='object')return null;
 const v=value as Record<string,unknown>;
 if(v.version!==1)return null;
 const count=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=10000000;
 if(!count(v.sent)||!count(v.received)||!count(v.meetings))return null;
 const date=(d:unknown):d is string=>typeof d==='string'&&Number.isFinite(Date.parse(d))&&Date.parse(d)>0&&Date.parse(d)<=now;
 if(v.sent+v.received>0&&!date(v.lastEmail)||v.meetings>0&&!date(v.lastMeeting))return null;
 if(!v.sent&&!v.received&&!v.meetings)return null;
 return {version:1,sent:v.sent,received:v.received,lastEmail:v.sent+v.received?new Date(v.lastEmail as string).toISOString():null,meetings:v.meetings,lastMeeting:v.meetings?new Date(v.lastMeeting as string).toISOString():null};
}
