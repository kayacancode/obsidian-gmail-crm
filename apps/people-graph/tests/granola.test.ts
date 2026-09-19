import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {makeSession,sessionCookie} from '../src/session';

const API_KEY='grn_fictional_key_123456';
const FOLDER_ID='fol_1234567890abcd';

const calls:{name:string;args:unknown[]}[]=[];let stubOwner='';
const statusValue={connected:true,status:'syncing',range:'all',lastSync:0,nextSync:0,error:'',counts:{folders:1,notes:0,pending:0,extracted:0,failed:0,skipped:0},folders:[{id:FOLDER_ID,name:'Pilot',parentId:null,excluded:false,noteCount:0}]};
let stubError:Error|null=null;
const stub={
 async granolaConnect(...args:unknown[]){calls.push({name:'granolaConnect',args});if(stubError)throw stubError;return statusValue;},
 granolaStatus(){calls.push({name:'granolaStatus',args:[]});return statusValue;},
 async granolaExcluded(...args:unknown[]){calls.push({name:'granolaExcluded',args});if(stubError)throw stubError;return statusValue;},
 async granolaSyncNow(){calls.push({name:'granolaSyncNow',args:[]});return statusValue;},
 async granolaDisconnect(){calls.push({name:'granolaDisconnect',args:[]});},
};

function fixtureEnv(){
 let storageCalls=0;
 const forbidden=()=>{storageCalls++;throw Error('Granola metadata must not touch app storage');};
 return {
  TOKEN_SECRET:'fictional-session-secret',GOOGLE_CLIENT_ID:'fictional-client',
  MAIL_TOKEN_KEY:'encrypt-key',GOOGLE_CLIENT_SECRET:'s',APP_ORIGIN:'https://people.test',
  DB:{prepare:forbidden},MAIL:{getByName:(owner:string)=>{stubOwner=owner;return stub;}},AI:{run:forbidden},
  ASSETS:{fetch:async()=>new Response('asset')},
  storageCalls:()=>storageCalls,
 } as any;
}

async function granolaRequest(path:string,body:unknown,init:RequestInit={}){
 const env=fixtureEnv();
 const session=await makeSession('owner@example.test',env.TOKEN_SECRET);
 const headers=new Headers(init.headers);
 headers.set('cookie',sessionCookie(session).split(';')[0]);
 if(!headers.has('origin'))headers.set('origin','https://people.test');
 if(!headers.has('content-type'))headers.set('content-type','application/json');
 const request=new Request('https://people.test'+path,{method:init.method??'POST',...(body===null?{}:{body:JSON.stringify(body)}),...init,headers});
 return {env,response:await worker.fetch(request,env)};
}

async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{
 const original=globalThis.fetch;globalThis.fetch=fake;
 try{return await run();}finally{globalThis.fetch=original;}
}

test('Granola routes require an authenticated app session before external access',async()=>{
 let calls=0;const env=fixtureEnv();
 await withFetch((async()=>{calls++;return Response.json({});}) as typeof fetch,async()=>{
  const response=await worker.fetch(new Request('https://people.test/api/granola/connect',{method:'POST',headers:{origin:'https://people.test','content-type':'application/json'},body:JSON.stringify({apiKey:API_KEY,range:'all'})}),env);
  assert.equal(response.status,401);assert.equal(calls,0);assert.equal(env.storageCalls(),0);assert.equal(response.headers.get('cache-control'),'no-store');
 });
});

test('connect validates body, forwards key and range to the owner object, and never echoes the key',async()=>{
 calls.length=0;stubError=null;
 const {response}=await granolaRequest('/api/granola/connect',{apiKey:API_KEY,range:'recent'});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(calls[0],{name:'granolaConnect',args:[API_KEY,'recent']});assert.equal(stubOwner,'owner@example.test');
 assert.ok(!(await response.text()).includes(API_KEY));
 for(const bad of [{apiKey:'nope',range:'all'},{apiKey:API_KEY,range:'weekly'},{apiKey:API_KEY,range:'all',extra:1},'[]']){
  const r=await granolaRequest('/api/granola/connect',bad);assert.equal(r.response.status,400);
 }
});

test('connect maps Granola failures to safe codes',async()=>{
 calls.length=0;
 const cases:[string,number,string][]=[['unauthorized',422,'granola_unauthorized'],['forbidden',422,'granola_forbidden'],['rate_limited',429,'granola_rate_limited'],['timeout',504,'granola_timeout'],['unavailable',502,'granola_unavailable'],['mail_not_configured',503,'mail_not_configured'],['invalid_key',400,'invalid_request']];
 for(const [failure,status,code] of cases){
  stubError=failure==='mail_not_configured'||failure==='invalid_key'?Error(failure):Error(`granola:${failure}:${failure==='unavailable'?'transport':'unexpected'}`);
  const {response}=await granolaRequest('/api/granola/connect',{apiKey:API_KEY,range:'all'});
  assert.equal(response.status,status);const body=await response.json() as any;assert.equal(body.error,code);
  if(failure==='unavailable')assert.equal(body.diagnostic,'transport');
  stubError=null;
 }
});

test('status is GET without origin, other verbs enforce origin, method and content type',async()=>{
 calls.length=0;stubError=null;
 const s=await granolaRequest('/api/granola/status',null,{method:'GET',headers:{origin:'https://elsewhere.test'}});
 assert.equal(s.response.status,200);assert.deepEqual(await s.response.json(),statusValue);
 const cross=await granolaRequest('/api/granola/sync',null,{headers:{origin:'https://elsewhere.test'}});assert.equal(cross.response.status,403);
 const wrongVerb=await granolaRequest('/api/granola/folders',{excluded:[]},{method:'POST'});assert.equal(wrongVerb.response.status,405);
 const wrongType=await granolaRequest('/api/granola/folders',{excluded:[]},{method:'PATCH',headers:{'content-type':'text/plain'}});assert.equal(wrongType.response.status,415);
 const big=await granolaRequest('/api/granola/folders',{excluded:Array.from({length:600},()=>FOLDER_ID)},{method:'PATCH'});assert.equal(big.response.status,413);
});

test('folders PATCH, sync POST and connection DELETE call the owner object',async()=>{
 calls.length=0;stubError=null;
 assert.equal((await granolaRequest('/api/granola/folders',{excluded:[FOLDER_ID]},{method:'PATCH'})).response.status,200);
 assert.equal((await granolaRequest('/api/granola/sync',null)).response.status,200);
 const del=await granolaRequest('/api/granola/connection',null,{method:'DELETE'});assert.equal(del.response.status,200);assert.deepEqual(await del.response.json(),{ok:true});
 assert.deepEqual(calls.map(c=>c.name),['granolaExcluded','granolaSyncNow','granolaDisconnect']);
 assert.deepEqual(calls[0].args,[[FOLDER_ID]]);
 stubError=Error('invalid_folder');
 assert.equal((await granolaRequest('/api/granola/folders',{excluded:['fol_zzzzzzzzzzzzzz']},{method:'PATCH'})).response.status,400);
 stubError=null;
 assert.equal((await granolaRequest('/api/granola/notes',{})).response.status,404);
});
