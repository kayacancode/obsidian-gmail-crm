import {b64,bytes,opaque} from './mail-model';
export async function makeSession(email:string,secret:string){const value=b64(new TextEncoder().encode(JSON.stringify({email,expires:Date.now()+86400000})));return value+'.'+await opaque('session',value,secret);}
export async function readSession(request:Request,secret:string){
 const cookies=request.headers.get('cookie')?.split(';').map(s=>s.trim())??[];
 for(const name of ['__Host-people-desktop=','__Host-people-session=']){
  const value=cookies.find(s=>s.startsWith(name))?.slice(name.length);
  if(!value||value.length>2000)continue;
  // The partitioned embedded session also accompanies cross-site requests: require
  // a same-origin initiator for mutations before accepting cookie authentication.
  if(name==='__Host-people-desktop='&&!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==new URL(request.url).origin)continue;
  const [payload,mac]=value.split('.');if(mac!==await opaque('session',payload,secret))continue;
  try{const data=JSON.parse(new TextDecoder().decode(bytes(payload)));if(typeof data.email==='string'&&data.expires>Date.now())return data.email as string;}catch{}
 }
 return null;
}
export const sessionCookie=(value:string)=>`__Host-people-session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value?86400:0}`;
