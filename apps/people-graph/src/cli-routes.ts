import {boundedJSON} from './bounded-json';
import {authenticateDevice,allowDeviceRequest,deviceRoute} from './cli-auth';
import {queryPeople,type QueryInput} from './cli-query';
import type {PeopleEnv} from './people-service';
export async function cliRoute(request:Request,env:PeopleEnv,owner:string|null){
 if(new URL(request.url).pathname!=='/api/cli/v1/query')return deviceRoute(request,env,owner);
 const error=(kind:string,status:number)=>Response.json({ok:false,command:'query',error:{kind,message:kind}},{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return error('method_not_allowed',405);
 const device=await authenticateDevice(request,env);if(!device)return error('unauthorized',401);
 if(!await allowDeviceRequest(env,'query:'+device.deviceId,60))return error('rate_limited',429);
 let input:QueryInput;try{input=await boundedJSON(new Response(request.body,{headers:request.headers}),4096) as QueryInput;}catch{return error('invalid_request',400);}
 return Response.json(await queryPeople(env,device.owner,input),{headers:{'cache-control':'no-store'}});
}
