import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {MailSync} from '../src/mail-sync';
import {opaque,seal,type GmailMessage} from '../src/mail-model';

const INBOX='inbox@example.test',OWNER='owner@example.test',FIRST='ada@example.test',SECOND='bo@example.test';
const SOURCE_QUOTE='Connecting you both, PRIVATE INTRO DETAIL.';
async function edgeFixture(){
 const f=await fixture();
 Object.assign(f.env,{MAIL_TOKEN_KEY:'test-mail-key',GOOGLE_CLIENT_SECRET:'test-client-secret'});
 const account=JSON.parse(f.db.prepare('SELECT data FROM accounts WHERE email=?').get(INBOX)!.data as string);
 Object.assign(account,{grant:await seal('test-refresh',f.env.MAIL_TOKEN_KEY),revision:'pair-origin-revision'});
 f.db.prepare('UPDATE accounts SET data=? WHERE email=?').run(JSON.stringify(account),INBOX);
 f.add(SECOND,'Bo');
 const secondId=await opaque(OWNER,SECOND,f.env.TOKEN_SECRET);
 // The introduction refines existing shared-thread evidence instead of replacing it.
 f.db.prepare('INSERT INTO mail_edges VALUES (?,?,?,?,?)').run(INBOX,'thread:intro',FIRST,SECOND,'Workshop discussion');
 const message:GmailMessage={id:'pair1',threadId:'pairthread',internalDate:'1700000000000',payload:{mimeType:'text/plain',headers:[
  {name:'From',value:`Morgan Vale <${INBOX}>`},{name:'To',value:`Ada <${FIRST}>`},{name:'Cc',value:`Bo <${SECOND}>`},{name:'Subject',value:'Workshop discussion'}
 ],body:{data:Buffer.from(SOURCE_QUOTE).toString('base64url')}}};
 return {...f,secondId,message};
}
async function withMessages<T>(messages:GmailMessage[],run:()=>Promise<T>,beforeRead?:()=>Promise<void>){
 const original=globalThis.fetch;
 globalThis.fetch=async(input:any)=>{
  const url=new URL(String(input));
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'test-access'});
  if(url.pathname.endsWith('/messages')){
   // Reproduce Gmail's owner-from exclusion so the actual result catches a wrong query.
   const q=url.searchParams.get('q')||'';
   return Response.json({messages:messages.filter(m=>!q.includes(`-from:"${INBOX}"`)||!m.payload?.headers?.some(h=>h.name==='From'&&h.value.includes(INBOX))).map(m=>({id:m.id}))});
  }
  await beforeRead?.();
  const found=messages.find(m=>url.pathname.endsWith('/'+m.id));
  return found?Response.json(found):new Response('missing',{status:404});
 };
 try{return await run();}finally{globalThis.fetch=original;}
}
const introduced=(graph:any)=>graph.edges.filter((edge:any)=>edge.types.includes('introduced'));

test('connection edges persist owner-sent introductions as private typed metadata without mailbox excerpts',async()=>{
 const f=await edgeFixture();try{
  await withMessages([f.message],()=>f.service.connectionOrigin(f.personId));
  const graph=await new MailSync(f.ctx,f.env).graph(),edges=introduced(graph);
  assert.equal(edges.length,1);
  assert.deepEqual(new Set([edges[0].source,edges[0].target]),new Set([f.personId,f.secondId]));
  assert.equal(edges[0].kind,'cooccurrence');
  assert.ok(edges[0].types.includes('shared_email'));
  const evidence=edges[0].evidence.find((item:any)=>item.type==='introduced');
  assert.ok(evidence);assert.match(evidence.title,/Introduced by/);assert.equal(evidence.date,'2023-11-14T22:13:20.000Z');
  const source=new URL(evidence.url);assert.equal(source.hostname,'mail.google.com');assert.equal(source.searchParams.get('authuser'),INBOX);assert.equal(source.hash,'#all/pairthread');
  for(const privateValue of [SOURCE_QUOTE,FIRST,SECOND])assert.ok(!JSON.stringify(graph).includes(privateValue),privateValue);
  const shared=await f.service.exportSlice({kind:'all'},'statements');
  assert.ok(shared.edges.every(e=>!e.types.includes('introduced')));
  assert.ok(!JSON.stringify(shared).includes('pairthread'));
  await f.service.setAutomaticContext(INBOX,false);
  const withdrawn=await f.service.graph();assert.equal(introduced(withdrawn).length,0);
  assert.ok(withdrawn!.edges.some(e=>e.types.includes('shared_email')));
 }finally{f.db.close();}
});

test('connection edges still record a pair introduction after finding the viewers own origin',async()=>{
 const f=await edgeFixture();try{
  const ownOrigin:GmailMessage={...f.message,id:'origin1',threadId:'originthread',payload:{...f.message.payload,headers:[
   {name:'From',value:'Riley Vale <riley@example.test>'},{name:'To',value:`Owner <${INBOX}>`},{name:'Cc',value:`Ada <${FIRST}>`},{name:'Subject',value:'Original introduction'}
  ]}};
  const result=await withMessages([ownOrigin,f.message],()=>f.service.connectionOrigin(f.personId));
  assert.equal(result.status,'found');assert.equal(result.origin?.introducerName,'Riley Vale');
  const edges=introduced(await f.service.graph());assert.equal(edges.length,1);
  assert.ok(edges[0].evidence.some((e:any)=>e.type==='introduced'&&e.url.endsWith('#all/pairthread')));
 }finally{f.db.close();}
});

test('connection edges cannot be restored after consent is withdrawn during source retrieval',async()=>{
 const f=await edgeFixture();try{
  const result=await withMessages([f.message],()=>f.service.connectionOrigin(f.personId),()=>f.service.setAutomaticContext(INBOX,false).then(()=>{}));
  assert.equal(result.status,'disabled');
  assert.equal(introduced(await new MailSync(f.ctx,f.env).graph()).length,0);
 }finally{f.db.close();}
});

test('connection edges withdraw private introduction metadata if consent changes while the graph is assembled',async()=>{
 const f=await edgeFixture();try{
  await withMessages([f.message],()=>f.service.connectionOrigin(f.personId));
  assert.equal(introduced(await f.service.graph()).length,1);
  // The real graph attachment yields. Revocation at that boundary must also remove
  // introduction metadata already read earlier in the same graph request.
  const store=(f.service as any).store(),attach=store.attachToGraph.bind(store);
  store.attachToGraph=async(...args:any[])=>{
   await f.service.setAutomaticContext(INBOX,false);
   return attach(...args);
  };
  const graph=await f.service.graph();
  assert.equal(introduced(graph).length,0);
  assert.ok(!JSON.stringify(graph).includes('pairthread'));
  assert.equal(graph!.connectionsRevision,undefined);
  assert.ok(graph!.edges.some(e=>e.types.includes('shared_email')));
 }finally{f.db.close();}
});

test('connection edges do not upgrade a shared thread without an explicit introduction',async()=>{
 const f=await edgeFixture();try{
  const message={...f.message,payload:{...f.message.payload,body:{data:Buffer.from('Thanks for sending the workshop agenda.').toString('base64url')}}};
  await withMessages([message],()=>f.service.connectionOrigin(f.personId));
  const graph=await f.service.graph();assert.equal(introduced(graph).length,0);assert.ok(graph!.edges.some(e=>e.types.includes('shared_email')));
 }finally{f.db.close();}
});
