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
const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config')};delete env.PEOPLEGRAPH_HOST;delete env.PEOPLEGRAPH_TOKEN;
function session(owner){const payload=Buffer.from(JSON.stringify({email:owner,expires:Date.now()+60000})).toString('base64url');return '__Host-people-session='+payload+'.'+createHmac('sha256','local-cli-test-secret').update('session\0'+payload).digest('base64url');}
async function api(path,body,owner='owner@test.com'){const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie:session(owner),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
function command(args){const p=spawn(binary,args,{env});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',code=>resolve({code,out,err}));});return {p,done,stderr:()=>err};}
try{
 const token=(await api('/api/token')).data.token;
 const graph={pushedAt:'2026-09-20T00:00:00Z',nodes:[{id:'ada-test',name:'Ada',company:'acme.test',combined:80},{id:'bo-test',name:'Bo',company:'acme.test'}],edges:[{source:'ada-test',target:'bo-test',weight:1,types:['note'],contexts:['Met at demo']}]};
 const pushed=await fetch(origin+'/api/push',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(graph)});assert.equal(pushed.status,200);
 const login=command(['login','--host',origin,'--no-browser']);let code;
 for(let i=0;i<100;i++){code=login.stderr().match(/Enter code: ([A-F0-9]{12})/)?.[1];if(code)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(code,login.stderr());assert.equal((await api('/api/cli/device/approve',{userCode:code,expectedOwner:'owner@test.com'})).status,200);
 const result=await login.done;assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).data.owner,'owner@test.com');
 const found=await command(['find-person','Ada']).done;assert.equal(found.code,0,found.out);const data=JSON.parse(found.out);assert.equal(data.data.people[0].id,'ada-test');assert.equal(data.stats.backend,'people-web');
 const web=await api('/api/graph');assert.deepEqual(data.data.people[0],web.data.graph.nodes.find(n=>n.id==='ada-test'));
 const neighbors=await command(['get-neighbors','ada-test']).done;assert.equal(JSON.parse(neighbors.out).data.people[0].id,'bo-test');
 const mutation=await command(['feedback','--email','ada@test','--action','boost']).done;assert.equal(JSON.parse(mutation.out).error.kind,'unsupported_operation');
 const local=await command(['--local','--cache',join(home,'missing.json'),'find-person','Ada']).done;assert.notEqual(JSON.parse(local.out).error.kind,'web_query_failed');
 const devices=(await api('/api/cli/devices')).data.devices;assert.ok(devices.length);const device=devices[0];
 assert.equal((await api('/api/cli/devices/revoke',{id:device.id},'other@test.com')).status,404);
 assert.equal((await api('/api/cli/devices/revoke',{id:device.id})).status,200);
 const revoked=await command(['find-person','Ada']).done;assert.equal(JSON.parse(revoked.out).error.kind,'login_required');
 const logout=await command(['logout']).done;assert.equal(logout.code,0,logout.err);
 console.log('PASS: compiled CLI login, shared graph parity, neighbors, local mode, read-only writes, tenant isolation, revocation, logout');
}finally{await rm(home,{recursive:true,force:true});}
