import type {BookingEnv} from './booking-types';
import type {SchedulingRecommendation} from './scheduling-types';

/** Owner-only factual context. Unconfirmed suggestions never become advice or authority. */
export async function schedulingRecommendation(env:BookingEnv,owner:string,email:string,now=Date.now(),instructions=''):Promise<SchedulingRecommendation>{
 const result:SchedulingRecommendation={summary:'The owner authorized scheduling within their calendar rules.',reasons:[],uncertainties:[]};
 const instructionWarning=instructions.trim()?['Freeform instructions have not been validated as scheduling constraints; only the explicit time window and saved calendar rules are enforced.']:[];
 result.uncertainties.push(...instructionWarning);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const read=async()=>{
   const source=env.MAIL.getByName(owner);await source.bindOwner(owner);
   const [contact,lens]=await Promise.allSettled([source.bookingContact(email),source.getOwnerLens()]);
   if(contact.status==='fulfilled'&&contact.value){
    const value=contact.value;
    if(value.owner===owner&&value.email===email&&Number.isFinite(value.score)&&value.score>=0&&value.score<=100&&Number.isFinite(value.checkedAt)&&Math.abs(now-value.checkedAt)<=300000&&Number.isFinite(value.sourceUpdatedAt)&&value.sourceUpdatedAt<=now+300000&&value.sourceUpdatedAt>=now-86400000)result.reasons.push(`The exact address is a fresh My Network contact with relationship score ${value.score}/100.`);
    else result.uncertainties.push('Fresh exact My Network context could not be verified.');
   }else result.uncertainties.push('Fresh exact My Network context is unavailable.');
   if(lens.status==='fulfilled'){
    const before=lens.value,current=await source.getOwnerLens();
    if(before.revision!==current.revision)result.uncertainties.push('The confirmed owner profile changed during preparation.');
    else for(const key of ['focus','needs','offers'] as const){const value=current.fields?.[key];if(typeof value==='string'&&value.trim()&&value.length<=500)result.reasons.push(`Confirmed ${key}: ${value.trim()}`);}
    if(!result.reasons.some(reason=>reason.startsWith('Confirmed ')))result.uncertainties.push('No confirmed owner profile context is available.');
   }else result.uncertainties.push('Confirmed owner profile context is unavailable.');
   return result;
  };
  const fallback:SchedulingRecommendation={summary:result.summary,reasons:[],uncertainties:[...instructionWarning,'Private relationship and confirmed profile context are temporarily unavailable.']};
  return await Promise.race([read(),new Promise<SchedulingRecommendation>(resolve=>{timer=setTimeout(()=>resolve(fallback),3000);})]);
 }catch{return {summary:result.summary,reasons:[],uncertainties:[...instructionWarning,'Private relationship and confirmed profile context are temporarily unavailable.']};}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
