import type {BookingEnv} from './booking-types';

export type SchedulingScope='scheduling:read'|'scheduling:write';
export interface SchedulingCredential {id:string;name:string;scopes:SchedulingScope[];createdAt:number;expiresAt:number;revokedAt:number|null;lastUsedAt:number|null}
export interface SchedulingPrincipal {owner:string;credentialId:string;scopes:SchedulingScope[]}
interface CredentialRow {id:string;owner:string;name:string;scopes:string;created_at:number;expires_at:number;revoked_at:number|null;last_used_at:number|null}
const lifetime=90*86400000;
export const schedulingScopes:SchedulingScope[]=['scheduling:read','scheduling:write'];

export async function initSchedulingCredentials(db:D1Database){
 await db.prepare('CREATE TABLE IF NOT EXISTS scheduling_credentials (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER)').run();
 await db.prepare('CREATE INDEX IF NOT EXISTS scheduling_credentials_owner ON scheduling_credentials(owner,created_at)').run();
}
function scopes(value:unknown):SchedulingScope[]{
 if(!Array.isArray(value)||value.length<1||value.length>2||value.some(v=>!schedulingScopes.includes(v))||new Set(value).size!==value.length)throw Error('invalid_scopes');
 return [...value].sort() as SchedulingScope[];
}
function publicCredential(row:CredentialRow):SchedulingCredential{return {id:row.id,name:row.name,scopes:scopes(JSON.parse(row.scopes)),createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,lastUsedAt:row.last_used_at};}
async function hash(token:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function requireSchedulingOwner(env:Pick<BookingEnv,'BOOKING_OWNER_EMAIL'>,owner:string){if(!owner||env.BOOKING_OWNER_EMAIL?.toLowerCase()!==owner.toLowerCase())throw Error('scheduling_forbidden');}
export function requireSchedulingScope(principal:SchedulingPrincipal,scope:SchedulingScope){if(!principal.scopes.includes(scope))throw Error('insufficient_scope');}
export function schedulingOrigin(request:Request,required=false){const origin=request.headers.get('origin');if((required||origin!==null)&&origin!==new URL(request.url).origin)throw Error('invalid_origin');}

export async function createSchedulingCredential(db:D1Database,owner:string,input:Record<string,unknown>){
 if(Object.keys(input).some(key=>!['name','scopes'].includes(key))||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\u0000-\u001f\u007f]/.test(input.name))throw Error('invalid_request');
 const allowed=scopes(input.scopes),random=crypto.getRandomValues(new Uint8Array(32));
 const token='sched_'+btoa(String.fromCharCode(...random)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const credential:SchedulingCredential={id:crypto.randomUUID(),name:input.name.trim(),scopes:allowed,createdAt:Date.now(),expiresAt:0,revokedAt:null,lastUsedAt:null};credential.expiresAt=credential.createdAt+lifetime;
 await initSchedulingCredentials(db);
 await db.prepare('INSERT INTO scheduling_credentials(id,owner,name,token_hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(credential.id,owner,credential.name,await hash(token),JSON.stringify(allowed),credential.createdAt,credential.expiresAt).run();
 return {token,credential};
}
export async function listSchedulingCredentials(db:D1Database,owner:string){await initSchedulingCredentials(db);const rows=await db.prepare('SELECT id,owner,name,scopes,created_at,expires_at,revoked_at,last_used_at FROM scheduling_credentials WHERE owner=? ORDER BY created_at DESC').bind(owner).all<CredentialRow>();return rows.results.map(publicCredential);}
export async function revokeSchedulingCredential(db:D1Database,owner:string,id:string){
 await initSchedulingCredentials(db);
 const row=await db.prepare('UPDATE scheduling_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner=? RETURNING id').bind(Date.now(),id,owner).first<{id:string}>();
 if(!row)throw Error('not_found');
}
/** Bearer tokens authorize this adapter only. They are never People or visitor sessions. */
export async function authenticateScheduling(request:Request,env:Pick<BookingEnv,'DB'|'BOOKING_OWNER_EMAIL'>):Promise<SchedulingPrincipal>{
 const authorization=request.headers.get('authorization')||'';
 const match=authorization.match(/^Bearer (sched_[A-Za-z0-9_-]{43})$/i);if(!match)throw Error('scheduling_unauthorized');
 await initSchedulingCredentials(env.DB);
 // Hash lookup avoids returning or directly comparing the bearer secret.
 const row=await env.DB.prepare('SELECT id,owner,name,scopes,created_at,expires_at,revoked_at,last_used_at FROM scheduling_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(await hash(match[1]),Date.now()).first<CredentialRow>();
 if(!row||!env.BOOKING_OWNER_EMAIL||row.owner!==env.BOOKING_OWNER_EMAIL.toLowerCase())throw Error('scheduling_unauthorized');
 let allowed:SchedulingScope[];try{allowed=scopes(JSON.parse(row.scopes));}catch{throw Error('scheduling_unauthorized');}
 await env.DB.prepare('UPDATE scheduling_credentials SET last_used_at=? WHERE id=? AND revoked_at IS NULL').bind(Date.now(),row.id).run();
 return {owner:row.owner,credentialId:row.id,scopes:allowed};
}
