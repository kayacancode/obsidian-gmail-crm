import {boundedJSON} from './bounded-json';
/** Read-only, origin-bound device authorization. Raw credentials are never persisted. */
export interface DeviceEnv {DB:D1Database;TOKEN_SECRET:string}
const seconds=()=>Math.floor(Date.now()/1000);
const response=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store',...(status===429?{'retry-after':'5'}:{})}});
const bad=(kind:string,status=400)=>response({error:kind},status);
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');}
export async function allowDeviceRequest(env:DeviceEnv,key:string,max:number,period=60){
 const now=seconds(),window=Math.floor(now/period)*period;
 const row=await env.DB.prepare('INSERT INTO cli_rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count').bind(key,window).first<{count:number}>();
 return !!row&&row.count<=max;
}
export async function authenticateDevice(request:Request,env:DeviceEnv){
 const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
 if(!token||!/^pgd1_[a-f0-9]{64}$/.test(token))return null;
 const row=await env.DB.prepare('SELECT id,owner FROM cli_devices WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(await hash(token),seconds()).first<{id:string;owner:string}>();
 return row?{owner:row.owner,deviceId:row.id}:null;
}
type Challenge={id:string;poll_hash:string;user_code:string;name:string;status:string;owner:string|null;expires_at:number;last_poll:number};
export async function deviceRoute(request:Request,env:DeviceEnv,owner:string|null):Promise<Response>{
 const path=new URL(request.url).pathname.replace('/api/cli/',''),now=seconds();
 if(path==='devices'&&request.method==='GET'){
  if(!owner)return bad('unauthorized',401);
  const rows=await env.DB.prepare('SELECT id,name,created_at AS createdAt,expires_at AS expiresAt FROM cli_devices WHERE owner=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC').bind(owner,now).all();
  return response({devices:rows.results});
 }
 if(request.method!=='POST')return bad('method_not_allowed',405);
 let body:Record<string,unknown>;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),4096) as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))return bad('invalid_request');}catch{return bad('invalid_request');}
 if(['device/approve','device/preview','devices/revoke'].includes(path)){
  if(!owner)return bad('unauthorized',401);
  if(request.headers.get('origin')!==new URL(request.url).origin)return bad('invalid_origin',403);
  if(!await allowDeviceRequest(env,'approve:'+owner,20,600))return bad('rate_limited',429);
 }
 if(path==='device/start'){
  if(typeof body.deviceName!=='string'||!body.deviceName.trim()||body.deviceName.length>80)return bad('invalid_request');
  const key=await hash(env.TOKEN_SECRET+'\0'+(request.headers.get('cf-connecting-ip')??'local'));
  if(!await allowDeviceRequest(env,'start:'+key,10,600))return bad('rate_limited',429);
  // Bounded cleanup keeps expired pending credentials from accumulating.
  await env.DB.prepare('DELETE FROM cli_challenges WHERE id IN (SELECT id FROM cli_challenges WHERE expires_at<? LIMIT 100)').bind(now).run();
  await env.DB.prepare('DELETE FROM cli_rate_limits WHERE key IN (SELECT key FROM cli_rate_limits WHERE window<? LIMIT 100)').bind(now-1200).run();
  const id=random(),secret=random(),userCode=random().slice(0,12).toUpperCase();
  await env.DB.prepare('INSERT INTO cli_challenges(id,poll_hash,user_code,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,await hash(secret),userCode,body.deviceName.trim(),now,now+600).run();
  return response({challengeId:id,pollSecret:secret,userCode,verificationUri:new URL('/cli',request.url).href,expiresAt:now+600,interval:5});
 }
 if(path==='device/preview'||path==='device/approve'){
  if(typeof body.userCode!=='string'||!/^[A-Fa-f0-9]{12}$/.test(body.userCode))return bad('invalid_code');
  if(path==='device/approve'&&body.expectedOwner!==owner)return bad('account_changed',409);
  const code=body.userCode.toUpperCase();
  if(path==='device/preview'){
   const row=await env.DB.prepare("SELECT name,expires_at FROM cli_challenges WHERE user_code=? AND status='pending' AND expires_at>?").bind(code,now).first<{name:string;expires_at:number}>();
   return row?response({deviceName:row.name,owner,expiresAt:row.expires_at,scope:'Read-only People queries'}):bad('invalid_code');
  }
  const approved=await env.DB.prepare("UPDATE cli_challenges SET owner=?,status='approved' WHERE user_code=? AND status='pending' AND expires_at>? RETURNING id").bind(owner,code,now).first();
  return approved?response({approved:true}):bad('invalid_code');
 }
 if(path==='device/poll'){
  if(typeof body.challengeId!=='string'||typeof body.pollSecret!=='string'||body.challengeId.length!==64||body.pollSecret.length!==64)return bad('invalid_challenge');
  const secretHash=await hash(body.pollSecret);
  const row=await env.DB.prepare('SELECT * FROM cli_challenges WHERE id=? AND poll_hash=? AND expires_at>?').bind(body.challengeId,secretHash,now).first<Challenge>();
  if(!row||row.status==='consumed')return bad('invalid_challenge');
  if(row.last_poll>now-5)return bad('slow_down',429);
  if(row.status==='pending'){
   const changed=await env.DB.prepare("UPDATE cli_challenges SET last_poll=? WHERE id=? AND last_poll<=? AND status='pending' RETURNING id").bind(now,row.id,now-5).first();
   return changed?response({status:'pending'},202):bad('slow_down',429);
  }
  const token='pgd1_'+random(),id=random(),expiresAt=now+30*86400;
  // Atomic INSERT...SELECT + consumption: a racing redemption sees consumed and inserts nothing.
  const result=await env.DB.batch([
   env.DB.prepare("INSERT INTO cli_devices(id,token_hash,owner,name,created_at,expires_at) SELECT ?,?,owner,name,?,? FROM cli_challenges WHERE id=? AND poll_hash=? AND status='approved' AND expires_at>?").bind(id,await hash(token),now,expiresAt,row.id,secretHash,now),
   env.DB.prepare("UPDATE cli_challenges SET status='consumed' WHERE id=? AND status='approved'").bind(row.id)
  ]);
  return result[0].meta.changes===1?response({token,owner:row.owner,expiresAt}):bad('invalid_challenge');
 }
 if(path==='devices/revoke'){
  if(typeof body.id!=='string'||body.id.length!==64)return bad('invalid_request');
  const row=await env.DB.prepare('UPDATE cli_devices SET revoked_at=? WHERE id=? AND owner=? RETURNING id').bind(now,body.id,owner).first();
  return row?response({revoked:true}):bad('not_found',404);
 }
 if(path==='logout'){
  const auth=await authenticateDevice(request,env);if(!auth)return bad('unauthorized',401);
  await env.DB.prepare('UPDATE cli_devices SET revoked_at=? WHERE id=?').bind(now,auth.deviceId).run();return response({revoked:true});
 }
 return bad('not_found',404);
}
