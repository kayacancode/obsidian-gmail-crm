import type {MailEnv} from './mail-sync';
import {boundedJSON} from './bounded-json';
import {validContextPerson,validPersonContextInput,type SavePersonContext} from './person-context';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
/** The verified session supplies owner; no body/query field can choose another account. */
export async function personContextRoute(request:Request,env:MailEnv,owner:string){
 const url=new URL(request.url);let personId:string,input:SavePersonContext|undefined;
 if(request.method==='GET'){
  const values=[...url.searchParams.entries()];
  if(values.length!==1||values[0][0]!=='personId'||!validContextPerson(values[0][1]))return json({error:'invalid_request'},400);
  personId=values[0][1];
 }else if(request.method==='POST'){
  if(request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);
  if(url.search)return json({error:'invalid_request'},400);
  let body:unknown;try{body=await boundedJSON(new Response(request.body,{headers:request.headers}),8000);}catch{return json({error:'invalid_request'},400);}
  if(!validPersonContextInput(body))return json({error:'invalid_request'},400);
  input=body;personId=body.personId;
 }else return json({error:'method_not_allowed'},405);
 let stage='bind_owner';
 try{const stub=env.MAIL.getByName(owner);await stub.bindOwner(owner);stage=input?'save':'read';return json(input?await stub.savePersonContext(input):await stub.getPersonContext(personId));}
 catch(error){
  const code=error instanceof Error?error.message:'';
  if(code==='unknown_person')return json({error:code},404);
  if(code==='person_context_conflict')return json({error:code},409);
  if(code==='invalid_request')return json({error:code},400);
  // Diagnose production runtime failures without logging the note, identity or error text.
  console.error('person_context_failed',{stage,name:error instanceof Error?error.name:'unknown',category:/not a function|does not implement|not implemented|not found.*method/i.test(code)?'rpc_method':/sqlite|sql|table|column/i.test(code)?'storage':'other',method:code.match(/([\w.$()]+) is not a function/)?.[1]?.slice(0,80)||(['getPersonContext','personContextFor','toArray'].find(name=>code.includes(name))??null),frames:error instanceof Error?error.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4):[]});
  throw error;
 }
}
