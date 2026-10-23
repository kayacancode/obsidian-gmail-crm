import {boundedJSON} from './bounded-json';
import {normalizeBookingEmail} from './booking-policy';
import type {BookingEnv,BookingPeopleContext} from './booking-types';

const MAX_SOURCE_AGE=86_400_000;

/** Reads only a server-configured source; it never discovers identities through fuzzy queries. */
export async function lookupBookingPerson(env:BookingEnv,owner:string,email:string,now=Date.now()):Promise<BookingPeopleContext>{
 const unavailable=(reason:string):BookingPeopleContext=>({status:'unavailable',reason});
 // A configured Rust endpoint remains authoritative even during an outage.
 if(!env.PEOPLEGRAPH_HOST&&!env.PEOPLEGRAPH_TOKEN&&!env.PEOPLEGRAPH_OWNER_EMAIL)return lookupLocalBookingPerson(env,owner,email,now);
 let url:URL,expected:string,verified:string;
 try{
  expected=normalizeBookingEmail(env.PEOPLEGRAPH_OWNER_EMAIL);
  if(expected!==normalizeBookingEmail(owner)||!env.PEOPLEGRAPH_TOKEN)return unavailable('The relationship source is not configured for this owner.');
  verified=normalizeBookingEmail(email);url=new URL(env.PEOPLEGRAPH_HOST||'');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.username||url.password||url.search||url.hash)return unavailable('The relationship source endpoint is invalid.');
  url.pathname=url.pathname.replace(/\/$/,'')+'/score';url.searchParams.set('email',verified);
 }catch{return unavailable('The relationship source is not configured.');}
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const operation=(async()=>{
   const response=await fetch(url.toString(),{headers:{authorization:'Bearer '+env.PEOPLEGRAPH_TOKEN,accept:'application/json'},redirect:'manual',signal:controller.signal});
   if(response.status!==200&&response.status!==400){await response.body?.cancel().catch(()=>{});return unavailable('The relationship source is unavailable.');}
   const body=await boundedJSON(response,64*1024);
   if(!record(body)||body.command!=='score'||typeof body.ok!=='boolean')return unavailable('The relationship source returned an invalid response.');
   const missing=body.ok===false&&record(body.error)&&body.error.kind==='not_found';
   if((!body.ok&&!missing)||(body.ok&&response.status!==200))return unavailable('The relationship lookup could not be completed.');
   const stats=record(body.stats)?body.stats:null;
   if(!stats||typeof stats.user_email!=='string')return missing?{status:'stale' as const,reason:'The lookup missed, but source ownership and freshness could not be verified.'}:unavailable('The relationship source owner could not be verified.');
   let sourceOwner:string;try{sourceOwner=normalizeBookingEmail(stats.user_email);}catch{return unavailable('The relationship source owner could not be verified.');}
   if(sourceOwner!==expected)return unavailable('The relationship source belongs to a different owner.');
   const sync=typeof stats.last_sync==='string'?Date.parse(stats.last_sync):NaN;
   if(!Number.isFinite(sync)||sync>now||now-sync>MAX_SOURCE_AGE)return {status:'stale' as const,reason:'The relationship source freshness could not be verified.',...(Number.isFinite(sync)?{lastSync:new Date(sync).toISOString()}:{})};
   const lastSync=new Date(sync).toISOString();
   if(missing)return {status:'not_found' as const,lastSync,reason:'No contact matched in the verified fresh relationship source.'};
   if(!record(body.data)||typeof body.data.email!=='string')return unavailable('The relationship source returned no primary identity.');
   let primary:string;try{primary=normalizeBookingEmail(body.data.email);}catch{return unavailable('The relationship source returned an invalid primary identity.');}
   if(primary!==verified||typeof stats.matched==='number'&&stats.matched!==1)return {status:'ambiguous' as const,lastSync,reason:'The email resolved through an unconfirmed alias or ambiguous identity.'};
   const score=record(body.data.score)?body.data.score.combined:undefined;
   const signals=record(body.data.signals)?body.data.signals:null;
   return {status:'matched' as const,email:primary,lastSync,reason:'The verified email exactly matches the source primary email.',...(typeof body.data.name==='string'&&body.data.name.length<=200?{name:body.data.name}:{}),...(typeof score==='number'&&Number.isFinite(score)&&score>=0&&score<=100?{score}:{}),...(signals&&typeof signals.last_contact==='string'&&Number.isFinite(Date.parse(signals.last_contact))?{lastContact:signals.last_contact}:{})};
  })();
  const timeout=new Promise<BookingPeopleContext>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(unavailable('The relationship source timed out.'));},3000);});
  return await Promise.race([operation,timeout]);
 }catch{return unavailable('The relationship source could not be read.');}
 finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}

async function lookupLocalBookingPerson(env:BookingEnv,owner:string,email:string,now:number):Promise<BookingPeopleContext>{
 const unavailable=(reason:string):BookingPeopleContext=>({status:'unavailable',reason});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  owner=normalizeBookingEmail(owner);email=normalizeBookingEmail(email);
  const read=async()=>{const source=env.MAIL.getByName(owner);await source.bindOwner(owner);return source.bookingPerson(email);};
  const value=await Promise.race([read(),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);
  if(!value||value.owner!==owner||value.email!==email||!Number.isFinite(value.checkedAt)||Math.abs(now-value.checkedAt)>300000)return unavailable('Exact My Network ownership and identity could not be verified.');
  if(value.status!=='matched'&&value.status!=='not_found')return {status:value.status==='ambiguous'?'ambiguous':'unavailable',reason:'The My Network source could not establish an exact, complete relationship lookup.'};
  if(!Number.isFinite(value.sourceUpdatedAt)||value.sourceUpdatedAt!>now||now-value.sourceUpdatedAt!>MAX_SOURCE_AGE)return {status:'stale',reason:'My Network source freshness could not be verified.'};
  const lastSync=new Date(value.sourceUpdatedAt!).toISOString();
  if(value.status==='not_found')return {status:'not_found',lastSync,reason:'No exact contact matched the complete fresh My Network source snapshot.'};
  if(typeof value.score!=='number'||!Number.isFinite(value.score)||value.score<0||value.score>100)return unavailable('The My Network contact score could not be verified.');
  return {status:'matched',email,lastSync,score:value.score,...(typeof value.name==='string'&&value.name.length<=100?{name:value.name}:{}),reason:'The email exactly matches a fresh direct My Network contact.'};
 }catch{return unavailable('The My Network relationship source is unavailable.');}
 finally{if(timer!==undefined)clearTimeout(timer);}
}

/** Configured Rust source or a fully completed fresh local snapshot. */
export async function bookingPeopleReady(env:BookingEnv,owner:string,now=Date.now()):Promise<boolean>{
 if(env.PEOPLEGRAPH_HOST||env.PEOPLEGRAPH_TOKEN||env.PEOPLEGRAPH_OWNER_EMAIL)return !!(env.PEOPLEGRAPH_HOST&&env.PEOPLEGRAPH_TOKEN&&env.PEOPLEGRAPH_OWNER_EMAIL?.toLowerCase()===owner);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const read=async()=>{const source=env.MAIL.getByName(owner);await source.bindOwner(owner);return source.bookingSourceStatus();};
  const value=await Promise.race([read(),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);
  return !!value&&value.owner===owner&&value.ready===true&&Number.isFinite(value.checkedAt)&&Math.abs(now-value.checkedAt)<=300000&&typeof value.sourceUpdatedAt==='number'&&Number.isFinite(value.sourceUpdatedAt)&&value.sourceUpdatedAt<=now&&now-value.sourceUpdatedAt<=MAX_SOURCE_AGE;
 }catch{return false;}finally{if(timer!==undefined)clearTimeout(timer);}
}
