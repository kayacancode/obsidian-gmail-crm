import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Production MailSync, routing/session and SQLite RPC; all people are synthetic.
const fixture=`
import worker from './src/index';
import {MailSync as ProductionMailSync} from './src/mail-sync';
import {opaque} from './src/mail-model';
import {makeSession,sessionCookie} from './src/session';
const owner='owner@example.test',inbox='inbox@example.test';
export class MailSync extends ProductionMailSync {
 async seed(count=1){
  await this.bindOwner(owner);
  this.ctx.storage.sql.exec('INSERT OR REPLACE INTO accounts VALUES (?,?)',inbox,JSON.stringify({email:inbox,status:'connected',job:null,lastSync:Date.now(),contextEnabled:false}));
  for(let i=0;i<count;i++)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO contributions VALUES (?,?,?,?,?,?,?,?)',inbox,'m'+i,'p'+String(i).padStart(4,'0')+'@example.test','Synthetic '+i,Date.now(),'Synthetic contact',1,1);
  return {personId:await opaque(owner,'p'+String(count-1).padStart(4,'0')+'@example.test',this.env.TOKEN_SECRET)};
 }
 async inspect(personId){try{return {value:await this.getPersonContext(personId)};}catch(error){return {error:error.message,stack:error.stack};}}
}
export default {async fetch(request,env){
 const url=new URL(request.url),stub=env.MAIL.getByName(owner);
 if(url.pathname==='/fixture')return Response.json({...await stub.seed(Number(url.searchParams.get('count')||1)),cookie:sessionCookie(await makeSession(owner,env.TOKEN_SECRET)).split(';')[0]});
 if(url.pathname==='/fixture/inspect'){try{return Response.json(await stub.inspect(url.searchParams.get('personId')));}catch(error){return Response.json({rpcError:error.message,stack:error.stack});}}
 return worker.fetch(request,env);
}};
`;
const productionFixture=`
import worker from './src/index';
export {MailSync} from './src/mail-sync';
export default worker;
`;

await test('private person context uses production SQLite Durable Object RPC and authenticated routes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'people-person-context-runtime-'));let mf;
 try{
  await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','cloudflare:email','node:*'],outfile:join(dir,'worker.mjs')});
  const options={modules:true,modulesRoot:dir,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2025-05-01',compatibilityFlags:['nodejs_compat'],durableObjects:{MAIL:{className:'MailSync',useSQLite:true}},bindings:{TOKEN_SECRET:'synthetic-context-key',GOOGLE_CLIENT_ID:'synthetic-client'},outboundService:async request=>{throw Error('Unexpected external request '+new URL(request.url).hostname);}};
  mf=new Miniflare(options);
  const setup=await (await mf.dispatchFetch('https://people.test/fixture')).json();
  const api=async(path,body)=>{const response=await mf.dispatchFetch('https://people.test'+path,{method:body===undefined?'GET':'POST',headers:{cookie:setup.cookie,origin:'https://people.test',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};};
  await t.test('fresh read, write, read and tombstone survive real RPC serialization',async()=>{
   const read=await api('/api/people/context?personId='+setup.personId);
   const diagnostic=read.status===200?'':JSON.stringify(await (await mf.dispatchFetch('https://people.test/fixture/inspect?personId='+setup.personId)).json());
   assert.equal(read.status,200,diagnostic);assert.deepEqual(read.value,{personId:setup.personId,text:'',revision:null,updatedAt:null});
   const save=await api('/api/people/context',{personId:setup.personId,text:'Synthetic person is building a clinic scheduling tool.',revision:null});assert.equal(save.status,200,JSON.stringify(save));
   assert.deepEqual((await api('/api/people/context?personId='+setup.personId)).value,save.value);
   const removed=await api('/api/people/context',{personId:setup.personId,text:'',revision:save.value.revision});assert.equal(removed.status,200);assert.equal(removed.value.text,'');assert.notEqual(removed.value.revision,save.value.revision);
   assert.equal((await api('/api/people/context',{personId:setup.personId,text:'Stale',revision:save.value.revision})).status,409);
  });
  await t.test('last own identity at the 1500-person graph cap can load context',async()=>{
   const many=await (await mf.dispatchFetch('https://people.test/fixture?count=1500')).json();
   const read=await api('/api/people/context?personId='+many.personId);
   const diagnostic=read.status===200?'':JSON.stringify(await (await mf.dispatchFetch('https://people.test/fixture/inspect?personId='+many.personId)).json());
   assert.equal(read.status,200,diagnostic);assert.equal(read.value.personId,many.personId);
  });
  await t.test('unchanged production MailSync export reads and saves existing SQLite state after code reload',async()=>{
   await build({stdin:{contents:productionFixture,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','cloudflare:email','node:*'],outfile:join(dir,'production.mjs')});
   await mf.setOptions({...options,scriptPath:join(dir,'production.mjs')});
   const read=await api('/api/people/context?personId='+setup.personId);assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.value.text,'');assert.ok(read.value.revision);
   const saved=await api('/api/people/context',{personId:setup.personId,text:'Saved through unchanged production export.',revision:read.value.revision});assert.equal(saved.status,200,JSON.stringify(saved));
   assert.deepEqual((await api('/api/people/context?personId='+setup.personId)).value,saved.value);
  });
  await t.test('structured memory survives real RPC and legacy edits without erasing fields',async()=>{
   const read=await api('/api/people/memory?personId='+setup.personId);assert.equal(read.status,200,JSON.stringify(read));
   const {updatedAt,entries,...input}=read.value;
   const saved=await api('/api/people/memory',{...input,building:'Clinic handoff tool',needs:'Nurse design partners',relationship:'closer'});assert.equal(saved.status,200,JSON.stringify(saved));
   const legacy=await api('/api/people/context',{personId:setup.personId,text:'Met in person.',revision:saved.value.revision});assert.equal(legacy.status,200);
   await mf.setOptions({...options,scriptPath:join(dir,'production.mjs')});
   const reloaded=await api('/api/people/memory?personId='+setup.personId);assert.equal(reloaded.value.building,'Clinic handoff tool');assert.equal(reloaded.value.text,'Met in person.');assert.equal(reloaded.value.revision,legacy.value.revision);
   assert.equal((await api('/api/people/memory',{...input,building:'Stale'})).status,409);
  });
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
