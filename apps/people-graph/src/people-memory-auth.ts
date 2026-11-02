export type PeopleMemoryScope='people:read'|'people:write'|'sources:manage'|'sharing:manage'|'booking:manage'|'integrations:manage';
export interface PeopleMemoryCredential {id:string;name:string;scopes:PeopleMemoryScope[];createdAt:number;expiresAt:number;revokedAt:number|null;lastUsedAt:number|null}
export interface PeopleMemoryPrincipal {owner:string;credentialId:string;scopes:PeopleMemoryScope[];expiresAt?:number;name?:string}
interface CredentialRow {id:string;owner:string;name:string;scopes:string;created_at:number;expires_at:number;revoked_at:number|null;last_used_at:number|null}
export const peopleMemoryScopes:PeopleMemoryScope[]=['people:read','people:write','sources:manage','sharing:manage','booking:manage','integrations:manage'];
export const peopleMemoryScopeDescriptions:Record<PeopleMemoryScope,string>={
 'people:read':'Read your private People network, Lens and relationship context',
 'people:write':'Edit your private Lens, people and relationship context',
 'sources:manage':'Manage connected source settings, synchronization and retrieval',
 'sharing:manage':'Manage network sharing, workspaces and introduction requests',
 'booking:manage':'Manage booking settings, requests and scheduling approvals',
 'integrations:manage':'List and revoke integration keys, and create keys within this key’s scopes',
};

async function initialize(db:D1Database){
 await db.prepare('CREATE TABLE IF NOT EXISTS people_memory_credentials (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,last_used_at INTEGER)').run();
 await db.prepare('CREATE INDEX IF NOT EXISTS people_memory_credentials_owner ON people_memory_credentials(owner,created_at)').run();
}
function scopes(value:unknown):PeopleMemoryScope[]{
 if(!Array.isArray(value)||value.length<1||value.length>peopleMemoryScopes.length||value.some(scope=>!peopleMemoryScopes.includes(scope))||new Set(value).size!==value.length)throw Error('invalid_scopes');
 return [...value].sort() as PeopleMemoryScope[];
}
function credential(row:CredentialRow):PeopleMemoryCredential{return {id:row.id,name:row.name,scopes:scopes(JSON.parse(row.scopes)),createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,lastUsedAt:row.last_used_at};}
async function hash(token:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function peopleMemoryOrigin(request:Request,required=false){const origin=request.headers.get('origin');if((required||origin!==null)&&origin!==new URL(request.url).origin)throw Error('invalid_origin');}
export function requirePeopleMemoryScope(principal:PeopleMemoryPrincipal,scope:PeopleMemoryScope){if(!principal.scopes.includes(scope))throw Error('insufficient_scope');}
/** Prepare a credential for an atomic device redemption; the caller must persist only tokenHash. */
export async function preparePeopleMemoryCredential(db:D1Database,owner:string,input:Record<string,unknown>,delegator?:PeopleMemoryPrincipal){
 if(Object.keys(input).some(key=>!['name','scopes'].includes(key))||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\u0000-\u001f\u007f]/.test(input.name))throw Error('invalid_request');
 const allowed=scopes(input.scopes);
 if(delegator&&(delegator.owner!==owner||!delegator.scopes.includes('integrations:manage')||allowed.some(scope=>!delegator.scopes.includes(scope))))throw Error('insufficient_scope');
 const random=crypto.getRandomValues(new Uint8Array(32));
 const token='people_'+btoa(String.fromCharCode(...random)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const createdAt=Date.now(),expiresAt=Math.min(createdAt+90*86400000,delegator?.expiresAt??Infinity);
 if(expiresAt<=createdAt)throw Error('insufficient_scope');
 const result:PeopleMemoryCredential={id:crypto.randomUUID(),name:input.name.trim(),scopes:allowed,createdAt,expiresAt,revokedAt:null,lastUsedAt:null};
 await initialize(db);
 return {token,credential:result,tokenHash:await hash(token)};
}
export async function createPeopleMemoryCredential(db:D1Database,owner:string,input:Record<string,unknown>,delegator?:PeopleMemoryPrincipal){
 const {token,credential:result,tokenHash}=await preparePeopleMemoryCredential(db,owner,input,delegator);
 await db.prepare('INSERT INTO people_memory_credentials(id,owner,name,token_hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(result.id,owner,result.name,tokenHash,JSON.stringify(result.scopes),result.createdAt,result.expiresAt).run();
 return {token,credential:result};
}
export async function listPeopleMemoryCredentials(db:D1Database,owner:string){await initialize(db);const rows=await db.prepare('SELECT id,owner,name,scopes,created_at,expires_at,revoked_at,last_used_at FROM people_memory_credentials WHERE owner=? ORDER BY created_at DESC').bind(owner).all<CredentialRow>();return rows.results.map(credential);}
export async function revokePeopleMemoryCredential(db:D1Database,owner:string,id:string){await initialize(db);const row=await db.prepare('UPDATE people_memory_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner=? RETURNING id').bind(Date.now(),id,owner).first();if(!row)throw Error('not_found');}
/** This credential cannot authorize browser sessions or graph pushes. Explicit grants govern machine adapters. */
export async function authenticatePeopleMemory(request:Request,db:D1Database):Promise<PeopleMemoryPrincipal>{
 const token=request.headers.get('authorization')?.match(/^Bearer (people_[A-Za-z0-9_-]{43})$/i)?.[1];if(!token)throw Error('people_memory_unauthorized');
 await initialize(db);
 const row=await db.prepare('SELECT id,owner,name,scopes,created_at,expires_at,revoked_at,last_used_at FROM people_memory_credentials WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(await hash(token),Date.now()).first<CredentialRow>();
 if(!row)throw Error('people_memory_unauthorized');
 let allowed:PeopleMemoryScope[];try{allowed=scopes(JSON.parse(row.scopes));}catch{throw Error('people_memory_unauthorized');}
 const current=await db.prepare('UPDATE people_memory_credentials SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>? RETURNING id').bind(Date.now(),row.id,Date.now()).first();
 if(!current)throw Error('people_memory_unauthorized');
 return {owner:row.owner,credentialId:row.id,scopes:allowed,expiresAt:row.expires_at,name:row.name};
}
