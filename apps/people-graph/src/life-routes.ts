import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';
import {validContextPerson} from './person-context';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const ERROR_STATUS:Record<string,number>={invalid_request:400,unknown_person:404,not_found:404,ambiguous_person:409};

/** Read one exact query parameter set; anything else is rejected. */
function only(url:URL,allowed:string[]):Record<string,string>|null{
 const entries=[...url.searchParams];
 if(entries.some(([key])=>!allowed.includes(key))||new Set(entries.map(([key])=>key)).size!==entries.length)return null;
 return Object.fromEntries(entries);
}

/**
 * Owner-private life signals, catch-up briefs, owner timeline and company stints.
 * Reads are GET; writes need same-origin JSON. Nothing here shares or sends anything.
 */
export async function lifeRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 try{
  const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
  if(method==='GET'){
   if(path==='/api/people/signals'){const q=only(url,['personId']);if(!q||q.personId!==undefined&&!validContextPerson(q.personId))return json({error:'invalid_request'},400);return json(await stub.listLifeSignals(q.personId));}
   if(path==='/api/people/brief'){
    const q=only(url,['personId','email','query']);if(!q||Object.keys(q).length!==1)return json({error:'invalid_request'},400);
    const result=await stub.catchUpBrief(q);
    return result.ok?json(result.brief):json({error:result.error,candidates:result.candidates},ERROR_STATUS[result.error]);
   }
   if(path==='/api/people/timeline'){if(url.search)return json({error:'invalid_request'},400);return json(await stub.listTimeline());}
   if(path==='/api/people/stints'){const q=only(url,['personId']);if(!q?.personId||!validContextPerson(q.personId))return json({error:'invalid_request'},400);return json(await stub.companyStints(q.personId));}
   if(path==='/api/people/teammates'){const q=only(url,['personId']);if(!q?.personId||!validContextPerson(q.personId))return json({error:'invalid_request'},400);return json(await stub.teammates(q.personId));}
   if(path==='/api/people/job-moves'){if(url.search)return json({error:'invalid_request'},400);return json(await stub.jobMoveCandidates());}
   return json({error:'method_not_allowed'},405);
  }
  if(!['POST','DELETE'].includes(method))return json({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(url.search)return json({error:'invalid_request'},400);
  let body:unknown;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),8_000);}catch{return json({error:'invalid_request'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_request'},400);
  const input=body as Record<string,unknown>;
  if(path==='/api/people/signals/settings'&&method==='POST'){if(Object.keys(input).join(',')!=='enabled'||typeof input.enabled!=='boolean')return json({error:'invalid_request'},400);return json(await stub.setLifeSignals(input.enabled));}
  if(path==='/api/people/signals'&&method==='DELETE')return json(await stub.forgetLifeSignals(input));
  if(path==='/api/people/timeline'&&method==='POST'){if(Object.keys(input).some(k=>!['text','category','date'].includes(k)))return json({error:'invalid_request'},400);return json(await stub.addTimelineEntry(input));}
  if(path==='/api/people/timeline'&&method==='DELETE'){if(Object.keys(input).join(',')!=='id'||typeof input.id!=='string')return json({error:'invalid_request'},400);return json(await stub.forgetTimelineEntry(input.id));}
  if(path==='/api/people/stints'&&method==='POST'){if(Object.keys(input).some(k=>!['personId','company','from','to'].includes(k)))return json({error:'invalid_request'},400);return json(await stub.setCompanyStint(input));}
  if(path==='/api/people/stints'&&method==='DELETE'){if(Object.keys(input).join(',')!=='id'||typeof input.id!=='string')return json({error:'invalid_request'},400);return json(await stub.forgetCompanyStint(input.id));}
  return json({error:'method_not_allowed'},405);
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(ERROR_STATUS[code])return json({error:code},ERROR_STATUS[code]);
  console.error('life_route_unavailable');return json({error:'people_unavailable'},503);
 }
}
