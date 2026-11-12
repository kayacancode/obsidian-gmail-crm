import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index';
import {makeSession} from '../src/session';
import {createPeopleMemoryCredential,listPeopleMemoryCredentials,revokePeopleMemoryCredential} from '../src/people-memory-auth';

export const origin='https://people.test',resource=origin+'/api/people-mcp',owner='owner@example.test',redirect='https://chatgpt.example.test/oauth/callback';
export const verifier='a'.repeat(64);
export async function fixture(t:TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const db:any={prepare(query:string){let args:any[]=[];return {bind(...values:any[]){args=values;return this;},async run(){const result=sql.prepare(query).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},async first(){return sql.prepare(query).get(...args)??null;},async all(){return {results:sql.prepare(query).all(...args)};}};},async batch(items:any[]){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const values=new Map<string,{value:string;expires:number}>();
 const kv:any={async get(key:string,options?:any){const item=values.get(key);if(!item||item.expires<=Date.now())return null;return (typeof options==='string'?options:options?.type)==='json'?JSON.parse(item.value):item.value;},async put(key:string,value:string,options?:any){values.set(key,{value,expires:options?.expiration?options.expiration*1000:options?.expirationTtl?Date.now()+options.expirationTtl*1000:Infinity});},async delete(key:string){values.delete(key);},async list(options?:any){return {keys:[...values.keys()].filter(key=>key.startsWith(options?.prefix??'')).map(name=>({name})),list_complete:true,cursor:''};}};
 const calls:string[]=[];
 const service:any={async bindOwner(actor:string){calls.push(actor);},async getOwnerLens(){return {revision:'lens-1',fields:{focus:'Founder tools',needs:'Design partners',offers:'Introductions'}};},async relationshipMemoryForEmail(email:string){return {email,personId:'person-1',entries:[]};}};
 const env:any={DB:db,OAUTH_KV:kv,TOKEN_SECRET:'synthetic-test-only-secret',APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'test-google-client',MAIL:{getByName(actor:string){calls.push(actor);return service;}},ASSETS:{async fetch(){return new Response('not found',{status:404});}}};
 const pending:Promise<any>[]=[];
 const ctx:any={waitUntil(promise:Promise<any>){pending.push(promise);},passThroughOnException(){},props:{}};
 t.after(async()=>{await Promise.allSettled(pending);});
 const send=(path:string,init:RequestInit={})=>worker.fetch(new Request(origin+path,init),env,ctx);
 const session=async(actor=owner)=>'__Host-people-session='+await makeSession(actor,env.TOKEN_SECRET);
 const register=async(extra:Record<string,unknown>={})=>{const response=await send('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'People test client',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],...extra})});assert.equal(response.status,201,await response.clone().text());return response.json() as Promise<any>;};
 const authUrl=async(client:any,scope='people:read people:write offline_access',extra:Record<string,string|null>={})=>{const query=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',state:'test-state',scope,resource,code_challenge:Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url'),code_challenge_method:'S256'});for(const [key,value]of Object.entries(extra)){if(value===null)query.delete(key);else query.set(key,value);}return '/oauth/authorize?'+query;};
 const begin=async(client:any,scope?:string)=>{const cookie=await session();const response=await send(await authUrl(client,scope),{headers:{cookie}});const html=await response.text();assert.equal(response.status,200,html);const hidden=(name:string)=>{const tag=html.match(new RegExp('<input[^>]*name=["\']'+name+'["\'][^>]*>'))?.[0];assert.ok(tag,'Missing '+name);const match=tag.match(/value=["']([^"']*)["']/);assert.ok(match);return match[1].replace(/&amp;/g,'&');};const binding=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {handle:hidden('handle'),owner:hidden('owner'),cookie:cookie+'; '+binding,html,response};};
 const approve=(consent:{handle:string;owner:string;cookie:string},extra:Record<string,string>={},headers:Record<string,string>={})=>send('/oauth/authorize',{method:'POST',headers:{origin,cookie:consent.cookie,'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({handle:consent.handle,owner:consent.owner,decision:'approve',...extra})});
 const exchange=(input:Record<string,string>)=>send('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(input)});
 const authorize=async(scope?:string)=>{const client=await register(),consent=await begin(client,scope),response=await approve(consent);assert.equal(response.status,302,await response.clone().text());const location=new URL(response.headers.get('location')!);assert.equal(location.origin,new URL(redirect).origin);assert.equal(location.searchParams.get('state'),'test-state');const code=location.searchParams.get('code')!;assert.ok(code);const input={grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,code_verifier:verifier,resource};const tokens=await exchange(input);assert.equal(tokens.status,200,await tokens.clone().text());return {client,consent,code,input,tokens:await tokens.json() as any};};
 const mcp=async(token:string,method='tools/list',params:unknown={})=>send('/api/people-mcp',{method:'POST',headers:{authorization:'Bearer '+token,host:'people.test',accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const result=async(response:Response)=>{const raw=await response.text();return JSON.parse(raw.includes('data: ')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);};
 return {sql,env,send,session,register,authUrl,begin,approve,exchange,authorize,mcp,result,calls,values};
}

