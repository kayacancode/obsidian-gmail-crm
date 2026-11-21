import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {desktopAuth} from '../src/desktop-auth';
import {readSession} from '../src/session';
function fixture(){
 const db=new DatabaseSync(':memory:');
 const env:any={TOKEN_SECRET:'test-secret',DB:{prepare(sql:string){let args:any[]=[];return {bind(...values:any[]){args=values;return this;},async run(){return db.prepare(sql).run(...args);},async first(){return db.prepare(sql).get(...args)??null;}};}}};
 const id='a'.repeat(64),verifier='b'.repeat(64);
 const call=(action:string,body:any,origin='https://people.test',authenticated=true)=>desktopAuth(new Request('https://people.test/api/desktop-auth/'+action,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),env,async()=>authenticated?{email:'owner@example.com'}:{error:'missing_token'});
 const start=async()=>{const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('hex');return call('start',{id,challenge});};
 return {db,id,verifier,call,start};
}
test('browser approval binds a single-use embedded session to the requesting verifier',async()=>{
 const f=fixture();assert.equal((await f.start()).status,200);
 assert.equal((await f.call('redeem',{id:f.id,verifier:f.verifier})).status,202);
 assert.equal((await f.call('approve',{id:f.id},undefined,false)).status,401);
 assert.equal((await f.call('approve',{id:f.id})).status,200);
 assert.equal((await f.call('redeem',{id:f.id,verifier:'c'.repeat(64)})).status,202);
 const result=await f.call('redeem',{id:f.id,verifier:f.verifier});assert.equal(result.status,200);
 const cookie=result.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly; Secure; SameSite=None; Partitioned/);
 assert.equal(await readSession(new Request('https://people.test/api/graph',{headers:{cookie}}),'test-secret'),'owner@example.com');
 assert.equal(await readSession(new Request('https://people.test/api/accounts',{method:'POST',headers:{cookie,origin:'https://attacker.test'}}),'test-secret'),null);
 assert.equal((await f.call('redeem',{id:f.id,verifier:f.verifier})).status,202);
});
test('handoff rejects cross-origin, malformed, expired and repeated approval requests',async()=>{
 const f=fixture();assert.equal((await f.call('start',{id:f.id,challenge:f.verifier},'https://attacker.test')).status,403);
 assert.equal((await f.call('start',{id:'bad',challenge:f.verifier})).status,400);
 await f.start();f.db.prepare('UPDATE desktop_signins SET expires = 0').run();
 assert.equal((await f.call('approve',{id:f.id})).status,410);
 assert.equal((await f.call('redeem',{id:f.id,verifier:f.verifier})).status,202);
 await f.start();assert.equal((await f.call('approve',{id:f.id})).status,200);
 assert.equal((await f.call('approve',{id:f.id})).status,410);
});
