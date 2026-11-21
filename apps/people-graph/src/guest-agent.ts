import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {opaque} from './mail-model';
import {randomBookingToken} from './booking-verification';
import type {GuestView} from './guest-ask';

const TTL=7*86_400_000,MAX_LIVE=5;
export interface GuestIdentity {email:string;subject:string}
/** The owner's store as the guest's agent may use it. */
export interface GuestAskStub {
 submitGuestAsk(guest:{key:string;email:string},question:string):Promise<{ask:GuestView}>;
 guestAsksFor(guestKey:string):Promise<{questions:GuestView[]}>;
}
const KNOWN:Record<string,boolean>={guest_ask_disabled:true,guest_rate_limited:true,invalid_request:true};

/**
 * Bearer tokens a verified guest mints for their own agent: stored only as a keyed hash, bound to
 * one owner's ask page and one Google identity, seven days, at most five live per guest.
 */
export class GuestAgentTokens {
 constructor(private db:D1Database,private secret:string){}
 private init(){return this.db.prepare('CREATE TABLE IF NOT EXISTS guest_agent_tokens (token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,subject TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL)').run();}
 async mint(owner:string,slug:string,guest:GuestIdentity,now=Date.now()){
  await this.init();
  await this.db.prepare('DELETE FROM guest_agent_tokens WHERE expires<=?').bind(now).run();
  // Keep the newest four live tokens; the one minted now makes five.
  await this.db.prepare('DELETE FROM guest_agent_tokens WHERE token_hash IN (SELECT token_hash FROM guest_agent_tokens WHERE owner=? AND slug=? AND subject=? ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ?)').bind(owner,slug,guest.subject,MAX_LIVE-1).run();
  const token=randomBookingToken(),expires=now+TTL;
  await this.db.prepare('INSERT INTO guest_agent_tokens (token_hash,owner,slug,email,subject,created,expires) VALUES (?,?,?,?,?,?,?)').bind(await opaque('guest-agent',token,this.secret),owner,slug,guest.email,guest.subject,now,expires).run();
  return {token,expiresAt:new Date(expires).toISOString()};
 }
 async resolve(owner:string,slug:string,token:string,now=Date.now()):Promise<GuestIdentity|null>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  await this.init();
  return this.db.prepare('SELECT email,subject FROM guest_agent_tokens WHERE token_hash=? AND owner=? AND slug=? AND expires>?').bind(await opaque('guest-agent',token,this.secret),owner,slug,now).first<GuestIdentity>();
 }
}

/** The two tools a guest's agent gets: ask the owner's network, and read the owner's answers. */
export function guestMcpServer(stub:GuestAskStub,guest:GuestIdentity,enabled:boolean){
 const server=new McpServer({name:'people-guest-ask',version:'1.0.0'},{instructions:'Ask one person’s network a question for the signed-in guest. The owner reads and answers every question personally, usually within days; answers describe people without naming them. To meet someone, the guest asks for an introduction on the ask page, and the person agrees first.'});
 const result=async(run:()=>Promise<Record<string,unknown>>)=>{
  try{const data=await run();return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};}
  catch(error){const code=error instanceof Error&&KNOWN[error.message]?error.message:'guest_ask_unavailable';return {isError:true,content:[{type:'text' as const,text:code}]};}
 };
 server.registerTool('ask_network',{description:'Send one question (up to 500 characters) to the owner’s network on the guest’s behalf, such as "who knows how hospitals schedule nurses?". At most three a day per guest. Returns the pending question; the owner answers later. Never invent an answer while it is pending.',inputSchema:z.strictObject({question:z.string().trim().min(1).max(500)}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},input=>result(async()=>{
  if(!enabled)throw Error('guest_ask_disabled');
  return {question:(await stub.submitGuestAsk({key:guest.subject,email:guest.email},input.question)).ask};
 }));
 server.registerTool('my_questions',{description:'The guest’s own questions with their status and the owner’s answers. People are described, not named; a name appears only after that person agreed to an introduction.',inputSchema:z.strictObject({}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},()=>result(async()=>({...await stub.guestAsksFor(guest.subject)})));
 return server;
}
