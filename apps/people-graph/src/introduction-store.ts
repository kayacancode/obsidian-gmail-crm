import {deny} from './workspace-store';
export type IntroductionState='requested'|'checking_interest'|'agreed'|'alternative_suggested'|'declined'|'completed'|'cancelled';
export interface IntroductionRequest {id:string;workspaceId:string;requesterId:string;recipientId:string;clientRequestId:string;personId:string;message:string;evidenceRefs:string[];state:IntroductionState;revision:number;reply:string|null;alternativePersonId:string|null;createdAt:string;updatedAt:string}
const schema=`CREATE TABLE IF NOT EXISTS introduction_requests (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,requester_id TEXT NOT NULL,recipient_id TEXT NOT NULL,client_request_id TEXT NOT NULL,created_at TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(workspace_id,requester_id,client_request_id))`;
const ready=new WeakMap<object,Promise<unknown>>();
export async function ensureIntroductionRequests(db:D1Database){let p=ready.get(db);if(!p){p=(async()=>{await db.prepare(schema).run();await db.prepare('CREATE INDEX IF NOT EXISTS intro_requester ON introduction_requests(workspace_id,requester_id,created_at,id)').run();await db.prepare('CREATE INDEX IF NOT EXISTS intro_recipient ON introduction_requests(workspace_id,recipient_id,created_at,id)').run();})().catch(e=>{ready.delete(db);throw e;});ready.set(db,p);}await p;}
export async function readIntroductionRequest(db:D1Database,workspaceId:string,requestId:string):Promise<IntroductionRequest>{await ensureIntroductionRequests(db);const row=await db.prepare('SELECT data FROM introduction_requests WHERE workspace_id=? AND id=?').bind(workspaceId,requestId).first<{data:string}>();if(!row)deny(404,'request_unavailable');return JSON.parse(row.data);}
type CreateInput=Pick<IntroductionRequest,'workspaceId'|'requesterId'|'recipientId'|'clientRequestId'|'personId'|'message'|'evidenceRefs'>&{workspaceRevision:number};
export async function createIntroductionRequest(db:D1Database,input:CreateInput):Promise<IntroductionRequest>{
 await ensureIntroductionRequests(db);const now=new Date().toISOString();const {workspaceRevision,...fields}=input;
 const item:IntroductionRequest={...fields,id:crypto.randomUUID(),state:'requested',revision:1,reply:null,alternativePersonId:null,createdAt:now,updatedAt:now};
 await db.prepare('INSERT OR IGNORE INTO introduction_requests (id,workspace_id,requester_id,recipient_id,client_request_id,created_at,revision,data) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id=? AND revision=?)').bind(item.id,item.workspaceId,item.requesterId,item.recipientId,item.clientRequestId,now,1,JSON.stringify(item),item.workspaceId,workspaceRevision).run();
 const row=await db.prepare('SELECT data FROM introduction_requests WHERE workspace_id=? AND requester_id=? AND client_request_id=?').bind(item.workspaceId,item.requesterId,item.clientRequestId).first<{data:string}>();if(!row)deny(409,'workspace_changed_retry');const saved:IntroductionRequest=JSON.parse(row.data);
 if(saved.recipientId!==item.recipientId||saved.personId!==item.personId||saved.message!==item.message||JSON.stringify(saved.evidenceRefs)!==JSON.stringify(item.evidenceRefs))deny(409,'idempotency_conflict');return saved;
}
export async function listIntroductionRequests(db:D1Database,workspaceId:string,memberId:string,cursor?:string){
 await ensureIntroductionRequests(db);let time='',id='';if(cursor){try{[time,id]=JSON.parse(atob(cursor));if(typeof time!=='string'||typeof id!=='string'||!time||!id)throw Error();}catch{deny(400,'invalid_cursor');}}
 const rows=await db.prepare('SELECT data FROM introduction_requests WHERE workspace_id=? AND (requester_id=? OR recipient_id=?) AND (?=\'\' OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 31').bind(workspaceId,memberId,memberId,time,time,time,id).all<{data:string}>();const all=rows.results.map(r=>JSON.parse(r.data) as IntroductionRequest),requests=all.slice(0,30),last=requests.at(-1);return {requests,nextCursor:all.length>30&&last?btoa(JSON.stringify([last.createdAt,last.id])):null};
}
export async function replyToIntroductionRequest(db:D1Database,input:{workspaceId:string;workspaceRevision:number;requestId:string;expectedRevision:number;state:IntroductionState;reply:string;alternativePersonId:string|null}){
 const current=await readIntroductionRequest(db,input.workspaceId,input.requestId);if(current.revision!==input.expectedRevision)deny(409,'request_changed');const next={...current,state:input.state,reply:input.reply,alternativePersonId:input.alternativePersonId,updatedAt:new Date().toISOString(),revision:current.revision+1};
 const result=await db.prepare('UPDATE introduction_requests SET data=?,revision=? WHERE workspace_id=? AND id=? AND revision=? AND EXISTS (SELECT 1 FROM workspaces WHERE id=? AND revision=?)').bind(JSON.stringify(next),next.revision,current.workspaceId,current.id,current.revision,current.workspaceId,input.workspaceRevision).run();if(result.meta.changes!==1)deny(409,'request_changed');return next;
}

/** Aggregate completed introductions only; never expose request messages or recipients. */
export async function completedIntroductionCounts(db:D1Database,workspaceId:string){
 await ensureIntroductionRequests(db);
 const rows=await db.prepare("SELECT recipient_id AS memberId,json_extract(data,'$.personId') AS personId,COUNT(*) AS count FROM introduction_requests WHERE workspace_id=? AND json_extract(data,'$.state')='completed' GROUP BY recipient_id,json_extract(data,'$.personId')").bind(workspaceId).all<{memberId:string;personId:string;count:number}>();
 return rows.results.map(r=>({memberId:r.memberId,personId:r.personId,count:r.count}));
}
