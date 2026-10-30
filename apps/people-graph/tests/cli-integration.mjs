// Isolated local Wrangler: TOKEN_SECRET=local-cli-test-secret, schema.sql applied.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const origin=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:8789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('Local test server required');
const binary=resolve('../../crates/peoplegraph/target/debug/peoplegraph'),home=await mkdtemp(join(tmpdir(),'pg-cli-e2e-'));
const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config')};delete env.PEOPLEGRAPH_HOST;delete env.PEOPLEGRAPH_TOKEN;delete env.PEOPLEGRAPH_WEB_URL;delete env.PEOPLEGRAPH_WEB_TOKEN;
function session(owner){const payload=Buffer.from(JSON.stringify({email:owner,expires:Date.now()+60000})).toString('base64url');return '__Host-people-session='+payload+'.'+createHmac('sha256','local-cli-test-secret').update('session\0'+payload).digest('base64url');}
async function api(path,body,owner='owner@test.com'){const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie:session(owner),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
function command(args,extraEnv={}){const p=spawn(binary,args,{env:{...env,...extraEnv}});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',code=>resolve({code,out,err}));});return {p,done,stderr:()=>err};}
try{
 const token=(await api('/api/token')).data.token;
 const graph={pushedAt:'2026-09-20T00:00:00Z',nodes:[{id:'ada-test',name:'Ada',company:'acme.test',combined:80},{id:'bo-test',name:'Bo',company:'acme.test'}],edges:[{source:'ada-test',target:'bo-test',weight:1,types:['note'],contexts:['Met at demo']}]};
 const pushed=await fetch(origin+'/api/push',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(graph)});assert.equal(pushed.status,200);
 const login=command(['login','--url',origin,'--no-browser','--write','--scope','sources:manage']);let code;
 for(let i=0;i<100;i++){code=login.stderr().match(/Enter code: ([A-F0-9]{12})/)?.[1];if(code)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(code,login.stderr());assert.equal((await api('/api/cli/device/approve',{userCode:code,expectedOwner:'owner@test.com',expectedScopes:['people:read','people:write','sources:manage']})).status,200);
 const result=await login.done;assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).data.owner,'owner@test.com');
 const status=JSON.parse((await command(['status']).done).out);assert.equal(status.data.authenticated,true);assert.deepEqual(status.data.credential.scopes,['people:read','people:write','sources:manage']);
 const sources=await command(['sources','status']).done;assert.equal(sources.code,0,sources.out);assert.deepEqual(JSON.parse(sources.out).data.gmail.accounts,[]);assert.equal(JSON.parse(sources.out).data.granola.connected,false);
 const handoff=await command(['sources','connect','gmail']).done;assert.equal(handoff.code,0,handoff.out);assert.equal(JSON.parse(handoff.out).data.status,'requires_browser_consent');
 const learning=await command(['lens','learning','on']).done;assert.equal(learning.code,0,learning.out);const inspected=JSON.parse((await command(['lens','inspect']).done).out);assert.equal(inspected.data.honcho.lastSync,null);assert.notEqual(inspected.data.refresh.state,'pending');
 const lensBefore=JSON.parse((await command(['lens']).done).out).data;
 const saved=await command(['lens','set','--focus','Agent interfaces','--needs','Design partners','--offers','Research']).done;assert.equal(saved.code,0,saved.out);
 const webLens=await api('/api/lens');assert.deepEqual(webLens.data.fields,{focus:'Agent interfaces',needs:'Design partners',offers:'Research'});
 const partial=await command(['lens','set','--needs','Pilot customers']).done;assert.equal(partial.code,0,partial.out);assert.equal(JSON.parse(partial.out).data.fields.focus,'Agent interfaces');
 const stale=await command(['lens','set','--revision',lensBefore.revision,'--focus','stale','--needs','','--offers','']).done;assert.equal(JSON.parse(stale.out).error.kind,'owner_lens_conflict');
 const restored=await command(['lens','set','--focus','','--needs','','--offers','']).done;assert.equal(restored.code,0,restored.out);
 const generic=await command(['api','GET','/api/lens']).done;assert.equal(generic.code,0,generic.out);assert.deepEqual(JSON.parse(generic.out).data.fields,{focus:'',needs:'',offers:''});
 const blocked=await command(['api','GET','/api/booking']).done;assert.equal(JSON.parse(blocked.out).error.kind,'insufficient_scope');
 const found=await command(['find-person','Ada']).done;assert.equal(found.code,0,found.out);const data=JSON.parse(found.out);assert.equal(data.data.people[0].id,'ada-test');assert.equal(data.stats.backend,'people-web');
 const web=await api('/api/graph');assert.deepEqual(data.data.people[0],web.data.graph.nodes.find(n=>n.id==='ada-test'));
 const neighbors=await command(['get-neighbors','ada-test']).done;assert.equal(JSON.parse(neighbors.out).data.people[0].id,'bo-test');
 const mutation=await command(['feedback','--email','ada@test','--action','boost']).done;assert.equal(JSON.parse(mutation.out).error.kind,'unsupported_operation');
 const local=await command(['--local','--cache',join(home,'missing.json'),'find-person','Ada']).done;assert.notEqual(JSON.parse(local.out).error.kind,'web_query_failed');
 const second=(await api('/api/cli/device/start',{deviceName:'Second owner CLI'},'other@test.com')).data;
 assert.equal((await api('/api/cli/device/approve',{userCode:second.userCode,expectedOwner:'other@test.com'},'other@test.com')).status,200);
 const secondToken=(await api('/api/cli/device/poll',second,'other@test.com')).data.token;
 const otherQuery=await fetch(origin+'/api/cli/v1/query',{method:'POST',headers:{authorization:'Bearer '+secondToken,'content-type':'application/json'},body:JSON.stringify({command:'find-person',query:'Ada',owner:'owner@test.com'})});
 assert.deepEqual((await otherQuery.json()).data,{people:[]});
 const privateDenied=await fetch(origin+'/api/people-agent/lens',{headers:{authorization:'Bearer '+secondToken}});assert.equal(privateDenied.status,401,'graph device cannot read private lens');
 const keyResult=await api('/api/people/integrations',{name:'Local release verification',scopes:['people:read']});assert.equal(keyResult.status,201);
 const privateEnv={PEOPLEGRAPH_WEB_URL:origin,PEOPLEGRAPH_WEB_TOKEN:keyResult.data.token};
 const deniedSource=await command(['sources','status'],privateEnv).done;assert.equal(JSON.parse(deniedSource.out).error.kind,'insufficient_scope');assert.match(JSON.parse(deniedSource.out).error.message,/sources:manage/);
 const lens=await command(['lens'],privateEnv).done;assert.equal(lens.code,0,lens.out);assert.deepEqual(JSON.parse(lens.out).data.fields,{focus:'',needs:'',offers:''});
 const matches=await command(['matches'],privateEnv).done;assert.equal(matches.code,0,matches.out);assert.deepEqual(JSON.parse(matches.out).data.results,[]);
 const privateSearch=await command(['search','Ada'],privateEnv).done;assert.equal(privateSearch.code,0,privateSearch.out);assert.equal(JSON.parse(privateSearch.out).data.people[0].id,'ada-test');
 const connection=await command(['connection','--from','ada-test','--to','bo-test'],privateEnv).done;assert.equal(connection.code,0,connection.out);assert.equal(JSON.parse(connection.out).data.status,'found');
 const initialized=await fetch(origin+'/api/people-mcp',{method:'POST',headers:{authorization:'Bearer '+keyResult.data.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'release-test',version:'1'}}})});assert.equal(initialized.status,200);
 const tools=await fetch(origin+'/api/people-mcp',{method:'POST',headers:{authorization:'Bearer '+keyResult.data.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});const toolBody=await tools.text();assert.match(toolBody,/get_people_lens/);assert.match(toolBody,/explain_connection/);assert.ok(!toolBody.includes('capture_relationship_context'),'read-only tools exclude writes');
 const edit=await api('/api/lens',{action:'save',revision:JSON.parse(lens.out).data.revision,fields:{focus:'Clinical workflow tools',needs:'Design partners',offers:''}});assert.equal(edit.status,200);
 assert.equal(JSON.parse((await command(['lens'],privateEnv).done).out).data.fields.focus,'Clinical workflow tools');
 assert.equal((await api('/api/people/integrations/'+keyResult.data.credential.id+'/revoke',{})).status,200);
 assert.equal(JSON.parse((await command(['lens'],privateEnv).done).out).error.kind,'people_memory_unauthorized');
 const devices=(await api('/api/cli/devices',undefined,'other@test.com')).data.devices;assert.ok(devices.length);const device=devices[0];
 assert.equal((await api('/api/cli/devices/revoke',{id:device.id})).status,404);
 assert.equal((await api('/api/cli/devices/revoke',{id:device.id},'other@test.com')).status,200);
 assert.equal((await api('/api/people/integrations/'+status.data.credential.id+'/revoke',{})).status,200);
 const revoked=await command(['find-person','Ada']).done;assert.equal(JSON.parse(revoked.out).error.kind,'login_required');
 const logout=await command(['logout']).done;assert.equal(logout.code,0,logout.err);
 console.log('PASS: compiled CLI scoped login, auto-config, source status/consent/scope denial, Lens idle state/writes/CAS, generic API, graph parity, local mode, private intelligence, scoped MCP, tenant isolation, revocation, logout');
}finally{await rm(home,{recursive:true,force:true});}
