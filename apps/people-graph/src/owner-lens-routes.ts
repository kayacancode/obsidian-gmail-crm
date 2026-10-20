import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';
import {rankOwnerLens} from './helper-brief';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const updating=()=>json({error:'owner_lens_updating',message:'The Granola update is still reaching your account. Please try again in a moment.'},503);
const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
function validAction(body:any){
 if(!record(body)||typeof body.revision!=='string'||!body.revision||body.revision.length>100)return false;
 const keys:Record<string,string[]>={save:['fields'],learning:['enabled'],granola:['enabled'],refresh:['note'],accept:['id'],dismiss:['id']};
 if(!Object.hasOwn(keys,body.action)||Object.keys(body).some(k=>!['action','revision',...keys[body.action]].includes(k)))return false;
 switch(body.action){
  case 'save':return record(body.fields)&&Object.keys(body.fields).length===3&&['focus','needs','offers'].every(k=>typeof body.fields[k]==='string'&&body.fields[k].length<=500);
  case 'learning':case 'granola':return typeof body.enabled==='boolean';
  case 'refresh':return body.note===undefined||typeof body.note==='string'&&body.note.length<=3000;
  case 'accept':case 'dismiss':return typeof body.id==='string'&&body.id.length>0&&body.id.length<=200;
  default:return false;
 }
}

/** Called only after Google session verification; the owner never comes from the request body. */
export async function ownerLensRoute(request:Request,env:MailEnv,owner:string){
 const matches=new URL(request.url).pathname==='/api/lens/matches';
 if(request.method!=='POST'&&(request.method!=='GET'||matches))return json({error:'method_not_allowed'},405);
 let body:any;
 if(request.method==='POST'){
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'invalid_origin'},403);
  try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),20000);}catch{return json({error:'invalid_request'},400);}
  if(matches?!record(body)||Object.keys(body).length>0:!validAction(body))return json({error:'invalid_request'},400);
 }
 const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);
 try{
  if(matches){
   const lens=await stub.getOwnerLens();
   // Pending inferred updates are never used as a search request.
   if(!Object.values(lens.fields).some(value=>value.trim()))return json(await rankOwnerLens(env,{nodes:[]},lens.fields));
   const graph=await stub.graph(),helperContext=await stub.helperContext();
   const result=await rankOwnerLens(env,{...(graph??{nodes:[]}),helperContext},lens.fields);
   // A profile edit or source withdrawal in another tab supersedes an in-flight search.
   const current=await stub.getOwnerLens();
   if(['focus','needs','offers'].some(key=>current.fields[key as keyof typeof current.fields]!==lens.fields[key as keyof typeof lens.fields]))return json({error:'owner_lens_conflict'},409);
   return json(result);
  }
  if(request.method==='GET')return json(await stub.getOwnerLens());
  switch(body.action){
   case 'save':return json(await stub.updateOwnerLens({revision:body.revision,fields:body.fields}));
   case 'learning':return json(await stub.setOwnerLensEnabled({revision:body.revision,enabled:body.enabled}));
   case 'granola':{
    // New edge Workers can temporarily reach an older Durable Object during rollout.
    if(typeof (await stub.getOwnerLens()).granolaEnabled!=='boolean')return updating();
    return json(await stub.setOwnerLensGranolaEnabled({revision:body.revision,enabled:body.enabled}));
   }
   case 'refresh':return json(await stub.refreshOwnerLens({revision:body.revision,note:body.note}));
   case 'accept':return json(await stub.acceptOwnerLensSuggestion({revision:body.revision,id:body.id}));
   case 'dismiss':return json(await stub.dismissOwnerLensSuggestion({revision:body.revision,id:body.id}));
  }
 }catch(error){
  const code=error instanceof Error?error.message:'';
  if(body?.action==='granola'&&error instanceof TypeError&&code.includes('setOwnerLensGranolaEnabled')&&/not a function|does not implement|not implemented|does not exist/.test(code))return updating();
  const kind=error instanceof Error?error.name:'unknown';
  console.warn(JSON.stringify({event:'owner_lens_route_failure',action:body?.action??'read',kind,method:['setOwnerLensGranolaEnabled','setGranolaEnabled','reconcileGranola','scheduleNextAlarm'].find(name=>code.includes(name))??'unknown',category:/not a function|does not implement|not implemented|does not exist/.test(code)?'method_unavailable':/SQLITE|SQL|table|column/.test(code)?'storage':/serializ|clone/.test(code)?'serialization':code==='owner_lens_conflict'?'conflict':'other'}));
  if(code==='owner_lens_conflict')return json({error:code},409);
  if(['invalid_owner_lens','invalid_request'].includes(code))return json({error:code},400);
  if(code==='owner_lens_disabled')return json({error:code},409);
  if(code==='owner_lens_suggestion_missing')return json({error:code},404);
  throw error;
 }
 return json({error:'invalid_request'},400);
}
