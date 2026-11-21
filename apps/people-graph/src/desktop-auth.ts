import {boundedJSON} from './bounded-json';
import {makeSession} from './session';

type Env = {DB:D1Database; TOKEN_SECRET:string};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function desktopAuth(request:Request,env:Env,authenticate:(request:Request)=>Promise<{email:string}|{error:string}>):Promise<Response>{
 const url=new URL(request.url);
 const reply=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'cache-control':'no-store',...headers}});
 if(url.pathname==='/api/desktop-auth/account'&&request.method==='GET'){const user=await authenticate(request);return 'error' in user?reply({error:user.error},401):reply({account:user.email});}
 if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
 if(request.headers.get('origin')!==url.origin)return reply({error:'invalid_origin'},403);
 let body:any;try{body=await boundedJSON(new Response(request.body),2048);}catch{return reply({error:'invalid_request'},400);}
 const action=url.pathname.split('/').pop();
 if(!body||typeof body!=='object'||!valid(body.id))return reply({error:'invalid_request'},400);
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS desktop_signins (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, email TEXT, expires INTEGER NOT NULL)').run();
 if(action==='start'){
  if(!valid(body.challenge))return reply({error:'invalid_request'},400);
  await env.DB.prepare('DELETE FROM desktop_signins WHERE expires < ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO desktop_signins (id,challenge,expires) VALUES (?,?,?)').bind(body.id,body.challenge,Date.now()+300000).run();
  return reply({ok:true});
 }
 if(action==='approve'){
  const user=await authenticate(request);if('error' in user)return reply({error:user.error},401);
  const row=await env.DB.prepare('UPDATE desktop_signins SET email = ? WHERE id = ? AND email IS NULL AND expires > ? RETURNING id').bind(user.email,body.id,Date.now()).first();
  return row?reply({ok:true}):reply({error:'expired_request'},410);
 }
 if(action==='redeem'){
  if(!valid(body.verifier))return reply({error:'invalid_request'},400);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.verifier))),b=>b.toString(16).padStart(2,'0')).join('');
  const row=await env.DB.prepare('DELETE FROM desktop_signins WHERE id = ? AND challenge = ? AND email IS NOT NULL AND expires > ? RETURNING email').bind(body.id,hash,Date.now()).first<{email:string}>();
  if(!row)return reply({pending:true},202);
  const session=await makeSession(row.email,env.TOKEN_SECRET);
  return reply({ok:true},200,{'set-cookie':`__Host-people-desktop=${session}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=86400`});
 }
 return reply({error:'not_found'},404);
}
