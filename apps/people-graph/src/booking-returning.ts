import type {BookingEnv,BookingSettings,BookingVisitorIdentity} from './booking-types';
import {normalizeBookingEmail} from './booking-policy';

export interface ReturningBookingContact {name:string;email:string;score:number;lastSync:string}

/** This shortcut uses the visible My Network score, independently of Rust's
 * thesis/priority lookup. Only the server receives this score and source date. */
export async function getReturningBookingContact(env:BookingEnv,settings:BookingSettings,identity:BookingVisitorIdentity,now=Date.now()):Promise<ReturningBookingContact|null>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!settings.returningContactsEnabled||!Number.isInteger(settings.returningScoreThreshold)||settings.returningScoreThreshold<1||settings.returningScoreThreshold>100)return null;
  if(!identity?.emailAuthoritative||typeof identity.subject!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(identity.subject)||!Number.isFinite(now))return null;
  const email=normalizeBookingEmail(identity.email),owner=normalizeBookingEmail(settings.owner);
  if(owner!==settings.owner)return null;
  const lookup=async()=>{
   const source=env.MAIL.getByName(owner);await source.bindOwner(owner);
   return source.bookingContact(email);
  };
  const value=await Promise.race([lookup(),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);
  if(!value||value.owner!==owner||value.email!==email)return null;
  if(!Number.isInteger(value.score)||value.score<settings.returningScoreThreshold||value.score>100)return null;
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100||/[\u0000-\u001f\u007f]/.test(value.name))return null;
  if(typeof value.checkedAt!=='number'||!Number.isFinite(value.checkedAt)||Math.abs(now-value.checkedAt)>300000)return null;
  if(typeof value.sourceUpdatedAt!=='number'||!Number.isFinite(value.sourceUpdatedAt)||now-value.sourceUpdatedAt>86400000||value.sourceUpdatedAt-now>300000)return null;
  return {name:value.name.trim(),email,score:value.score,lastSync:new Date(value.sourceUpdatedAt).toISOString()};
 }catch{return null;}finally{if(timer!==undefined)clearTimeout(timer);}
}
