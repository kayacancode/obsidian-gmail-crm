import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {workspaceRoute} from '../src/workspace-routes';
export function workspaceFixture(){
 const sqlite=new DatabaseSync(':memory:');
 const db:any={prepare(sql:string){let args:any[]=[];const stmt:any={bind(...a:any[]){args=a;return stmt;},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return stmt;}};
 const env:any={DB:db,TOKEN_SECRET:'test-workspace-secret'};
 const call=async(path='',method='GET',body?:any,me='owner@example.com',origin='https://people.test')=>workspaceRoute(new Request('https://people.test/api/'+(path.startsWith('workspace-invites')?path:'workspaces'+path),{method,headers:{origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,me);
 const create=async()=>{const r=await call('','POST',{name:'Betaworks'});assert.equal(r.status,200);return (await r.json() as any).workspace.id;};
 const invite=async(id:string,email:string)=>{const r=await call('/'+id+'/invites','POST',{email});assert.equal(r.status,200);return (await r.json() as any).token;};
 return {sqlite,db,env,call,create,invite};
}
test('workspace: invite target accepts once, starts private, no inbox required',async()=>{
 const f=workspaceFixture(),id=await f.create(),token=await f.invite(id,'member@example.com');
 assert.equal((await f.call('workspace-invites/accept','POST',{token},'wrong@example.com')).status,403);
 assert.equal((await f.call('workspace-invites/accept','POST',{token},'member@example.com')).status,200);
 assert.equal((await f.call('workspace-invites/accept','POST',{token},'member@example.com')).status,409);
 const listing:any=await (await f.call('','GET',undefined,'member@example.com')).json();
 assert.equal(listing.workspaces[0].id,id);assert.equal(listing.workspaces[0].contribution.enabled,false);
 assert.equal((await f.call('/'+id+'/members','GET',undefined,'stranger@example.com')).status,403);
 assert.equal((await f.call('/'+id+'/invites','POST',{email:'next@example.com'},'member@example.com')).status,403);
 assert.equal((await f.call('','POST',{name:'bad'},undefined,'https://bad.test')).status,403);
});
test('workspace: revocation, contribution ownership, leave and admin transfer',async()=>{
 const f=workspaceFixture(),id=await f.create(),token=await f.invite(id,'member@example.com');
 await f.call('workspace-invites/accept','POST',{token},'member@example.com');
 const data:any=await (await f.call('/'+id+'/members')).json();
 const owner=data.members.find((m:any)=>m.isMe),member=data.members.find((m:any)=>!m.isMe);
 assert.equal((await f.call('/'+id+'/members/'+owner.id,'DELETE')).status,409);
 assert.equal((await f.call('/'+id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names'})).status,200);
 assert.equal((await f.call('/'+id+'/transfer','POST',{memberId:member.id})).status,200);
 assert.equal((await f.call('/'+id+'/members/'+owner.id,'DELETE')).status,200);
 assert.equal((await f.call('/'+id+'/members')).status,403);
 assert.equal((await f.call('/'+id,'DELETE',undefined,'member@example.com')).status,200);
 assert.equal((await f.call('/'+id+'/members','GET',undefined,'member@example.com')).status,403);
});
test('workspace: concurrent accepts respect 20 members and removed users cannot replay',async()=>{
 const f=workspaceFixture(),id=await f.create();
 const tokens=[];for(let n=0;n<20;n++)tokens.push(await f.invite(id,`m${n}@example.com`));
 const results=await Promise.all(tokens.map((token,n)=>f.call('workspace-invites/accept','POST',{token},`m${n}@example.com`)));
 assert.equal(results.filter(r=>r.status===200).length,19);
 const data:any=await (await f.call('/'+id+'/members')).json();assert.equal(data.members.length,20);
 const member=data.members.find((m:any)=>m.email==='m0@example.com');
 await f.call('/'+id+'/members/'+member.id,'DELETE');
 assert.equal((await f.call('workspace-invites/accept','POST',{token:tokens[0]},'m0@example.com')).status,409);
});
test('workspace: expired and revoked invitations cannot be accepted',async()=>{
 const f=workspaceFixture(),id=await f.create(),token=await f.invite(id,'member@example.com');
 const data:any=await (await f.call('/'+id+'/members')).json();
 await f.call('/'+id+'/invites/'+data.invites[0].id,'DELETE');
 assert.equal((await f.call('workspace-invites/accept','POST',{token},'member@example.com')).status,409);
 const next=await f.invite(id,'next@example.com');
 const row:any=f.sqlite.prepare('SELECT data FROM workspaces WHERE id=?').get(id),state=JSON.parse(row.data);
 state.invites.forEach((i:any)=>i.expiresAt=1);f.sqlite.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify(state),id);
 assert.equal((await f.call('workspace-invites/accept','POST',{token:next},'next@example.com')).status,410);
});
