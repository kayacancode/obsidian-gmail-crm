import {authoredSchedulingText} from './scheduling-email-policy';

export type BookingApprovalChoice={kind:'approve';index:number}|{kind:'decline'}|{kind:'clarify'};

export function parseBookingApproval(text:string,slotCount:number):BookingApprovalChoice {
 if(!Number.isInteger(slotCount)||slotCount<1||slotCount>3||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))return {kind:'clarify'};
 let authored:string;
 try{authored=authoredSchedulingText(text).toLowerCase();}catch{return {kind:'clarify'};}
 // Match the whole authored reply. Do not infer consent from a fragment,
 // conditional instruction, bare number, or choice quoted from the request.
 const match=authored.match(/^(?:(?:thanks|thank you)[,.!]*\s+)?(?:please\s+)?(approve|decline)(?:\s+([1-3]))?(?:\s+please)?[,.!]*(?:\s+(?:thanks|thank you)[.!]*)?$/);
 if(!match)return {kind:'clarify'};
 if(match[1]==='decline')return match[2]?{kind:'clarify'}:{kind:'decline'};
 const index=match[2]?Number(match[2])-1:slotCount===1?0:-1;
 return index>=0&&index<slotCount?{kind:'approve',index}:{kind:'clarify'};
}
