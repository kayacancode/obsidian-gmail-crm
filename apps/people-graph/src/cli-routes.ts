import {boundedJSON} from './bounded-json';
import {authenticateDevice,allowDeviceRequest,deviceRoute} from './cli-auth';
import {queryPeople,type QueryInput} from './cli-query';
import type {PeopleEnv} from './people-service';
import {authenticatePeopleMemory,peopleMemoryOrigin} from './people-memory-auth';
export async function cliRoute(request:Request,env:PeopleEnv,owner:string|null){
 if(new URL(request.url).pathname!=='/api/cli/v1/query')return deviceRoute(request,env,owner);
 const error=(kind:string,status:number)=>Response.json({ok:false,command:'query',error:{kind,message:kind}},{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return error('method_not_allowed',405);
 let actor:{owner:string;credentialId:string};
 if(/^Bearer people_/i.test(request.headers.get('authorization')??'')){
  try{peopleMemoryOrigin(request);}catch{return error('invalid_origin',403);}
  let principal;try{principal=await authenticatePeopleMemory(request,env.DB);}catch{return error('unauthorized',401);}
  if(!principal.scopes.includes('people:read'))return error('insufficient_scope',403);
  actor=principal;
 }else{
  const device=await authenticateDevice(request,env);if(!device)return error('unauthorized',401);
  actor={owner:device.owner,credentialId:device.deviceId};
 }
 if(!await allowDeviceRequest(env,'query:'+actor.credentialId,60))return error('rate_limited',429);
 let input:QueryInput;try{input=await boundedJSON(new Response(request.body,{headers:request.headers}),4096) as QueryInput;}catch{return error('invalid_request',400);}
 return Response.json(await queryPeople(env,actor.owner,input),{headers:{'cache-control':'no-store'}});
}
