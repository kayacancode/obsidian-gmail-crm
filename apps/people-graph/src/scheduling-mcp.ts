import {McpServer} from '@modelcontextprotocol/server';
import {createMcpHandler} from 'agents/mcp/server';
import {z} from 'zod';
import type {BookingEnv} from './booking-types';
import type {SchedulingPrincipal} from './scheduling-auth';
import {runSchedulingAction,schedulingBody,schedulingErrorCode,schedulingInstructionsMessage,type SchedulingAction} from './scheduling-routes';

const requestId=z.string().regex(/^[\w-]{1,100}$/),selection=z.string().min(1).max(100);
const preparation=z.strictObject({email:z.string().max(254),name:z.string().max(120).optional(),context:z.string().max(8000).describe('Actual meeting purpose and project evidence for assessment against the saved thesis; not scheduling constraints or override instructions.'),instructions:z.string().max(2000).optional().describe('Unsupported: omit this field. Nonempty free-text instructions are rejected; use UTC windowStart/windowEnd and saved owner rules.'),timezone:z.string().max(100).optional(),windowStart:z.string().max(40).optional(),windowEnd:z.string().max(40).optional(),idempotencyKey:z.string().min(16).max(100)});
function createSchedulingServer(env:BookingEnv,principal:SchedulingPrincipal){
 const server=new McpServer({name:'people-scheduling',version:'1.0.0'});
 async function call(action:SchedulingAction,input:Record<string,unknown>,id?:string){
  try{const result=await runSchedulingAction(env,principal,action,input,id);return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{...result}};}
  catch(error){const code=schedulingErrorCode(error);return {isError:true,content:[{type:'text' as const,text:code+(code==='invalid_instructions'?': '+schedulingInstructionsMessage:'')}]};}
 }
 if(principal.scopes.includes('scheduling:write')){
  server.registerTool('prepare_scheduling_reply',{description:'Assess one counterpart’s meeting request using the same saved thesis, relationship and VIP policy as Booking, then persist up to three eligible scheduling options. Convert any requested date range into explicit UTC ISO windowStart/windowEnd fields. Nonempty free-text instructions are rejected; context is meeting background only. Ask for clarification before preparing when a hard constraint, such as afternoon-only, cannot be represented by the saved rules and one UTC window; never offer contrary slots. Returns owner-private decision, recommendation and requiresReview. When requiresReview is true there is no offer: the owner must review in Booking. Only replyText is suitable for the counterpart; never forward the entire result. This tool does not send email or override an assessment.',inputSchema:preparation,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},input=>call('prepare',input));
  server.registerTool('refresh_scheduling_options',{description:'Reassess a scheduling request against current meeting rules and replace eligible offered times with a new revision. Review results have no offer. This writes the assessment/offer and invalidates previous choices; it does not send email.',inputSchema:z.strictObject({requestId}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},({requestId})=>call('refresh',{},requestId));
  server.registerTool('confirm_scheduling_time',{description:'Book exactly one current offered time and create a calendar invitation for the owner and the fixed counterpart. This is a write action. Supply the exact request ID, offer revision and slot ID returned by prepare or refresh. Repeating the same selection recovers its existing booking.',inputSchema:z.strictObject({requestId,revision:selection,slotId:selection}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},({requestId,...input})=>call('confirm',input,requestId));
 }
 if(principal.scopes.includes('scheduling:read'))server.registerTool('get_scheduling_request',{description:'Read the authenticated owner’s scheduling request, current offer, booking status and owner-private recommendation.',inputSchema:z.strictObject({requestId}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},({requestId})=>call('get',{},requestId));
 return server;
}
/** Authentication and exact Origin checks run before this request-local factory. */
export async function schedulingMcpRoute(request:Request,env:BookingEnv,principal:SchedulingPrincipal):Promise<Response>{
 const handler=createMcpHandler(()=>createSchedulingServer(env,principal),{route:'/api/scheduling/mcp',corsOptions:false,allowedHostnames:[new URL(request.url).hostname],allowedOriginHostnames:[new URL(request.url).hostname]});
 const response=await handler.fetch(request,request.method==='POST'?{parsedBody:await schedulingBody(request)}:undefined);
 response.headers.set('cache-control','no-store');response.headers.set('referrer-policy','no-referrer');return response;
}
