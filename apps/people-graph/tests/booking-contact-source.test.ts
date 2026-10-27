import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {opaque} from '../src/mail-model';

const NOW=Date.parse('2026-10-22T12:00:00Z'),DAY=86_400_000,OWNER='owner@example.com',CONTACT='ada@example.com';
function fixture(t:TestContext){
 t.mock.method(Date,'now',()=>NOW);
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>([['owner',OWNER]]);t.after(()=>db.close());
 const ctx={storage:{sql:{exec(sql:string,...args:any[]){if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}const stmt=db.prepare(sql),rows=sql.startsWith('SELECT')?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}},get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);},delete:async(k:string)=>kv.delete(k),setAlarm:async()=>{},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
 const env={GOOGLE_CLIENT_ID:'client',TOKEN_SECRET:'booking-source-test'};
 return {db,kv,service:new MailSync(ctx as any,env as any),secret:env.TOKEN_SECRET};
}
function account(db:DatabaseSync,email=OWNER,patch:Record<string,unknown>={}){
 db.prepare('INSERT OR REPLACE INTO accounts VALUES (?,?)').run(email,JSON.stringify({email,grant:'sealed',revision:'revision',status:'connected',job:null,lastSync:NOW-1000,nextSync:NOW+3600000,error:'',range:'all',...patch}));
}
function mail(db:DatabaseSync,source=OWNER,email=CONTACT,name='Ada Chen',prefix='message',pairs=10){
 for(let i=0;i<pairs*2;i++)db.prepare('INSERT OR REPLACE INTO contributions VALUES (?,?,?,?,?,?,?,?)').run(source,prefix+i,email,name,NOW-2000,'Private conversation subject',i%2,1-i%2);
}
function granola(db:DatabaseSync,patch:Record<string,unknown>={}){
 db.prepare("INSERT OR REPLACE INTO granola_connection (id,grant,data) VALUES (1,'sealed',?)").run(JSON.stringify({ownerEmail:OWNER,status:'connected',range:'all',watermark:'watermark',lastSync:NOW-3000,nextSync:NOW+3600000,lastReconcile:NOW-3000,error:'',job:null,...patch}));
}
function meeting(db:DatabaseSync,email=CONTACT,hidden=0){
 db.prepare("INSERT INTO granola_notes (id,title,web_url,meeting_at,date_basis,created_at,updated_at,folder_ids,summary,private_notes,transcript,content_hash,bytes,extraction_status,extraction,extractor_version,extraction_attempts,synced_at,hidden) VALUES (?,'Private meeting title',NULL,?,'scheduled',?,?,'[]','Private summary','Private notes','Private transcript','hash',0,'done',NULL,'granola-v2',0,?,?)").run(email,new Date(NOW-2000).toISOString(),new Date(NOW-2000).toISOString(),new Date(NOW-2000).toISOString(),NOW-3000,hidden);
 db.prepare('INSERT INTO granola_attendees VALUES (?,?,?)').run(email,email,'Ada Chen');
}

test('booking contact returns only the exact normalized direct contact and adjusted My Network score',async t=>{
 const {db,service,secret}=fixture(t);account(db);mail(db);
 const id=await opaque(OWNER,CONTACT,secret);
 const original=await service.bookingContact('  ADA@EXAMPLE.COM  ');
 assert.deepEqual(original,{owner:OWNER,email:CONTACT,name:'Ada Chen',score:87,checkedAt:NOW,sourceUpdatedAt:NOW-1000});
 assert.equal(original!.score,(await service.graph())!.nodes.find(node=>node.id===id)!.combined);
 await service.setPersonFeedback(id,'boost');assert.equal((await service.bookingContact(CONTACT))!.score,97);
 await service.setPersonFeedback(id,'snooze');assert.equal((await service.bookingContact(CONTACT))!.score,97);
 await service.setPersonFeedback(id,'suppress');assert.equal((await service.bookingContact(CONTACT))!.score,77);
 assert.equal((await service.bookingContact(CONTACT))!.score,(await service.graph())!.nodes.find(node=>node.id===id)!.combined);
 await service.setPersonFeedback(id,'clear');assert.equal((await service.bookingContact(CONTACT))!.score,87);
 for(const address of ['ada+tag@example.com','a.da@example.com','missing@example.com',OWNER,'',null])assert.equal(await service.bookingContact(address as string),null);
});

test('booking contact deduplicates mail across inboxes and uses the oldest contributing completion',async t=>{
 const {db,service}=fixture(t);account(db);mail(db);account(db,'work@example.com',{lastSync:NOW-8000});mail(db,'work@example.com');
 assert.deepEqual(await service.bookingContact(CONTACT),{owner:OWNER,email:CONTACT,name:'Ada Chen',score:87,checkedAt:NOW,sourceUpdatedAt:NOW-8000});
 account(db,'work@example.com',{lastSync:NOW-DAY-1});assert.equal(await service.bookingContact(CONTACT),null);
});

test('booking contact accepts a completed Gmail job retained by the actual sync lifecycle',async t=>{
 const {db,service}=fixture(t);
 account(db,OWNER,{job:{generation:'completed',range:'all',query:'',pending:[],hasMore:false,processed:20,started:NOW-1000,retries:0,lastRun:NOW-500,nextAttempt:0,photosDone:true}});mail(db);
 assert.equal((await service.bookingContact(CONTACT))?.score,87);
});

test('booking contact rejects incomplete, stale, invalid and missing contributing mail sources',async t=>{
 const {db,service}=fixture(t);mail(db);
 for(const patch of [{status:'syncing',lastSync:NOW-1000},{status:'error'},{status:'reconnect'},{lastSync:0},{lastSync:NOW-DAY-1},{lastSync:NOW+1},{lastSync:'fresh'},{lastSync:null}]){
  account(db,OWNER,patch);assert.equal(await service.bookingContact(CONTACT),null,JSON.stringify(patch));
 }
 account(db,OWNER,{lastSync:NOW-DAY});assert.equal((await service.bookingContact(CONTACT))?.sourceUpdatedAt,NOW-DAY);
 db.prepare('UPDATE accounts SET data=?').run('{broken');assert.equal(await service.bookingContact(CONTACT),null);
 db.prepare('DELETE FROM accounts').run();assert.equal(await service.bookingContact(CONTACT),null);
});

test('booking contact ignores unrelated source and shared-network freshness',async t=>{
 const {db,kv,service}=fixture(t);account(db,OWNER,{lastSync:NOW-DAY-1});mail(db);
 account(db,'other@example.com');mail(db,'other@example.com','other-contact@example.com');
 granola(db,{lastSync:NOW});meeting(db,'unrelated@example.com');
 db.prepare('INSERT INTO shared_meta VALUES (?,?,?)').run('colleague@example.com',NOW,'themes');
 kv.set('graph',{pushedAt:new Date(NOW).toISOString()});
 assert.equal(await service.bookingContact(CONTACT),null);
 account(db);account(db,'other@example.com',{status:'syncing',lastSync:0});granola(db,{lastSync:NOW-DAY-1});
 assert.equal((await service.bookingContact(CONTACT))?.sourceUpdatedAt,NOW-1000);
});

test('booking contact does not recognize shared-only contacts or an unbound owner',async t=>{
 const {db,kv,service}=fixture(t);account(db);
 db.prepare('INSERT INTO shared_people VALUES (?,?,?,?,?)').run('colleague@example.com',CONTACT,'Ada Chen',new Date(NOW).toISOString(),100);
 assert.equal(await service.bookingContact(CONTACT),null);
 mail(db);kv.delete('owner');assert.equal(await service.bookingContact(CONTACT),null);
});

test('booking contact includes visible Granola score contributions and requires their completed freshness',async t=>{
 const {db,service,secret}=fixture(t);account(db);mail(db);granola(db);meeting(db);
 const found=await service.bookingContact(CONTACT),id=await opaque(OWNER,CONTACT,secret);
 assert.equal(found?.sourceUpdatedAt,NOW-3000);assert.equal(found?.score,87);
 assert.equal(found?.score,(await service.graph())!.nodes.find(node=>node.id===id)!.combined);
 for(const patch of [{status:'syncing'},{status:'error'},{status:'reconnect_required'},{lastSync:0},{lastSync:NOW-DAY-1},{lastSync:NOW+1},{lastSync:'fresh'},{lastSync:null}]){
  granola(db,patch);assert.equal(await service.bookingContact(CONTACT),null,JSON.stringify(patch));
 }
 db.prepare('UPDATE granola_connection SET data=?').run('{broken');assert.equal(await service.bookingContact(CONTACT),null);
 db.prepare('DELETE FROM granola_connection').run();assert.equal(await service.bookingContact(CONTACT),null);
});

test('booking contact recognizes direct Granola-only contacts and excludes hidden meetings',async t=>{
 const {db,service}=fixture(t);granola(db);meeting(db);
 assert.deepEqual(await service.bookingContact(CONTACT),{owner:OWNER,email:CONTACT,name:'Ada Chen',score:70,checkedAt:NOW,sourceUpdatedAt:NOW-3000});
 db.prepare('UPDATE granola_notes SET hidden=1').run();assert.equal(await service.bookingContact(CONTACT),null);
 account(db);mail(db);granola(db,{lastSync:NOW-DAY-1});assert.equal((await service.bookingContact(CONTACT))?.score,87);
});

test('booking contact waits for Granola completion when retrying an errored partial sync',async t=>{
 const {db,service}=fixture(t);
 granola(db,{status:'error',job:{phase:'fetch',pending:[{id:'unfinished',updatedAt:new Date(NOW).toISOString()}],maxUpdated:'',retries:12,nextAttempt:NOW,lastRun:NOW-500,started:NOW-2000,processed:1,initial:false}});meeting(db);
 assert.equal(await service.bookingContact(CONTACT),null);
 const status=await service.granolaSyncNow();assert.equal(status.status,'connected');
 assert.equal(await service.bookingContact(CONTACT),null);
 granola(db);assert.equal((await service.bookingContact(CONTACT))?.score,70);
});

test('booking contact requires an exact raw identity before confirmed aliases can contribute to its score',async t=>{
 const {db,service,secret}=fixture(t);granola(db);meeting(db,'alias@example.com');
 db.prepare('INSERT INTO granola_identity (attendee_email,contact_email,attendee_name,contact_name,probability,status,updated_at,decided_by) VALUES (?,?,?,?,?,?,?,?)').run('alias@example.com',CONTACT,'Alias Name','Ada Chen',1,'confirmed',NOW,'owner');
 const id=await opaque(OWNER,CONTACT,secret);
 assert.equal(await service.bookingContact(CONTACT),null);
 assert.equal(await service.bookingContact('alias@example.com'),null);
 account(db);mail(db,OWNER,CONTACT,'Ada Chen','exact',1);
 assert.equal((await service.bookingContact(CONTACT))?.score,75);
 assert.equal((await service.bookingContact(CONTACT))?.score,(await service.graph())!.nodes.find(node=>node.id===id)!.combined);
 db.prepare('DELETE FROM contributions').run();meeting(db,CONTACT,1);
 assert.equal(await service.bookingContact(CONTACT),null);
 db.prepare('UPDATE granola_notes SET hidden=0 WHERE id=?').run(CONTACT);
 assert.equal((await service.bookingContact(CONTACT))?.score,75);
 assert.equal((await service.bookingContact(CONTACT))?.score,(await service.graph())!.nodes.find(node=>node.id===id)!.combined);
});

test('booking contact fails closed on corrupt feedback instead of returning an unadjusted score',async t=>{
 const {db,service,secret}=fixture(t);account(db);mail(db);const id=await opaque(OWNER,CONTACT,secret);
 for(const data of ['{broken',JSON.stringify({action:'boost',delta:'10'}),JSON.stringify({action:'boost',delta:null})]){
  db.prepare('INSERT OR REPLACE INTO person_feedback VALUES (?,?)').run(id,data);assert.equal(await service.bookingContact(CONTACT),null);
 }
});

test('booking person distinguishes a fresh complete source miss from missing or partial sources',async t=>{
 const {db,service}=fixture(t);assert.equal(typeof (service as any).bookingPerson,'function');
 assert.equal((await (service as any).bookingPerson(CONTACT)).status,'unavailable');
 account(db);assert.equal((await (service as any).bookingPerson(CONTACT)).status,'not_found');
 for(const patch of [{status:'syncing'},{lastSync:NOW-DAY-1},{lastSync:0},{job:{pending:['unfinished'],hasMore:true}}]){account(db,OWNER,patch);assert.notEqual((await (service as any).bookingPerson(CONTACT)).status,'not_found');}
 account(db);granola(db,{job:{pending:['unfinished']}});assert.notEqual((await (service as any).bookingPerson(CONTACT)).status,'not_found');
 granola(db);assert.equal((await (service as any).bookingPerson(CONTACT)).status,'not_found');
});
test('booking person does not misreport stale exact evidence or confirmed aliases as missing',async t=>{
 const {db,service}=fixture(t);assert.equal(typeof (service as any).bookingPerson,'function');account(db);mail(db);
 assert.equal((await (service as any).bookingPerson(CONTACT)).status,'matched');
 account(db,OWNER,{status:'syncing'});assert.notEqual((await (service as any).bookingPerson(CONTACT)).status,'not_found');
 account(db);db.prepare('DELETE FROM contributions').run();
 db.prepare('INSERT INTO granola_identity (attendee_email,contact_email,attendee_name,contact_name,probability,status,updated_at,decided_by) VALUES (?,?,?,?,?,?,?,?)').run(CONTACT,'alias@example.com','Ada','Ada',1,'confirmed',NOW,'owner');
 assert.equal((await (service as any).bookingPerson(CONTACT)).status,'ambiguous');
});

test('booking source readiness requires every configured snapshot to be fresh and complete',async t=>{
 const {db,service}=fixture(t);assert.equal(typeof (service as any).bookingSourceStatus,'function');
 assert.equal((await (service as any).bookingSourceStatus()).ready,false);account(db);assert.equal((await (service as any).bookingSourceStatus()).ready,true);
 account(db,'other@example.com',{status:'syncing'});assert.equal((await (service as any).bookingSourceStatus()).ready,false);
 account(db,'other@example.com',{lastSync:NOW-DAY-1});assert.equal((await (service as any).bookingSourceStatus()).ready,false);
 account(db,'other@example.com');granola(db,{job:{pending:['unfinished']}});assert.equal((await (service as any).bookingSourceStatus()).ready,false);
 granola(db);assert.equal((await (service as any).bookingSourceStatus()).ready,true);
});

test('booking exact lookup is independent of the visualization contact cap',async t=>{
 const {db,service}=fixture(t);account(db);mail(db,OWNER,CONTACT,'Ada Chen','exact',5);
 const expected=await service.bookingContact(CONTACT);assert.ok(expected);
 const insert=db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?)');
 // Each decoy outranks Ada; even the mail aggregation has a separate 6,000 row cap.
 db.exec('BEGIN');for(let i=0;i<6001;i++)insert.run(OWNER,'decoy'+i,`decoy${i}@example.com`,'Other contact',NOW-2000,'',20,20);db.exec('COMMIT');
 assert.deepEqual(await service.bookingContact(CONTACT),expected);
 assert.equal((await service.bookingPerson(CONTACT)).status,'matched');
});

test('booking lookup diagnoses incomplete contributing snapshots without accepting their partial score',async t=>{
 const {db,service}=fixture(t);account(db);mail(db);granola(db);meeting(db);
 granola(db,{status:'syncing',job:{phase:'fetch',pending:[{id:'unfinished'}]}});
 let result=await service.bookingPerson(CONTACT) as any;
 assert.equal(result.status,'unavailable');assert.equal(result.reason,'granola_syncing');assert.equal(result.retryable,true);assert.equal(result.source,'granola');assert.equal(result.score,undefined);
 granola(db,{job:{phase:'fetch',pending:[{id:'unfinished'}]}});
 result=await service.bookingPerson(CONTACT) as any;assert.equal(result.reason,'granola_incomplete');assert.equal(result.retryable,true);
 granola(db);account(db,OWNER,{job:{pending:['unfinished'],hasMore:true}});
 assert.equal(await service.bookingContact(CONTACT),null);
 result=await service.bookingPerson(CONTACT) as any;assert.equal(result.reason,'gmail_incomplete');assert.equal(result.retryable,true);
 account(db,OWNER,{status:'syncing'});result=await service.bookingPerson(CONTACT) as any;assert.equal(result.reason,'gmail_syncing');
 account(db);assert.equal((await service.bookingPerson(CONTACT)).status,'matched');
});

test('booking lookup diagnostics distinguish stale, revoked, corrupt and alias evidence',async t=>{
 const {db,service,secret}=fixture(t);account(db);mail(db);
 for(const [patch,reason,retryable] of [
  [{lastSync:NOW-DAY-1},'gmail_stale',true],
  [{status:'reconnect'},'gmail_reconnect',false],
  [{status:'error'},'gmail_error',true],
  [{lastSync:0},'gmail_never_synced',true],
  [{lastSync:NOW+1},'gmail_corrupt',false],
 ] as const){account(db,OWNER,patch);const result=await service.bookingPerson(CONTACT) as any;assert.equal(result.status,'unavailable');assert.equal(result.reason,reason);assert.equal(result.retryable,retryable);}
 db.prepare('UPDATE accounts SET data=?').run('{broken');assert.equal((await service.bookingPerson(CONTACT) as any).reason,'gmail_corrupt');
 db.prepare('DELETE FROM accounts').run();assert.equal((await service.bookingPerson(CONTACT) as any).reason,'gmail_missing');
 account(db);const id=await opaque(OWNER,CONTACT,secret);db.prepare('INSERT INTO person_feedback VALUES (?,?)').run(id,'{broken');
 assert.equal((await service.bookingPerson(CONTACT) as any).reason,'corrupt_feedback');
 db.prepare('DELETE FROM contributions').run();
 db.prepare('INSERT INTO granola_identity (attendee_email,contact_email,attendee_name,contact_name,probability,status,updated_at,decided_by) VALUES (?,?,?,?,?,?,?,?)').run(CONTACT,'alias@example.com','Ada','Ada',1,'confirmed',NOW,'owner');
 const alias=await service.bookingPerson(CONTACT) as any;assert.equal(alias.status,'ambiguous');assert.equal(alias.reason,'confirmed_alias');assert.equal(alias.retryable,false);
});

test('booking source misses expose the incomplete source and avoid misleading not-found results',async t=>{
 const {db,service}=fixture(t);account(db);granola(db,{status:'syncing'});
 let result=await service.bookingPerson(CONTACT) as any;assert.equal(result.status,'unavailable');assert.equal(result.reason,'granola_syncing');assert.equal(result.retryable,true);
 const status=await service.bookingSourceStatus() as any;assert.equal(status.ready,false);assert.equal(status.reason,'granola_syncing');assert.equal(status.retryable,true);
 granola(db);result=await service.bookingPerson(CONTACT) as any;assert.equal(result.status,'not_found');assert.equal(result.reason,undefined);
});

test('booking exact Granola lookup is not capped with graph attendee aggregation',async t=>{
 const {db,service}=fixture(t);granola(db);const target='z-last@example.com';meeting(db,target);
 const expected=await service.bookingContact(target);assert.ok(expected);
 db.exec('BEGIN');for(let i=0;i<5001;i++)meeting(db,`a-decoy${i}@example.com`);db.exec('COMMIT');
 assert.deepEqual(await service.bookingContact(target),expected);
});

test('booking exact identity ignores unrelated corrupt sources but a verified miss does not',async t=>{
 const {db,service}=fixture(t);account(db);mail(db);account(db,'other@example.com');granola(db);
 db.prepare('UPDATE accounts SET data=? WHERE email=?').run('{broken','other@example.com');
 db.prepare('UPDATE granola_connection SET data=?').run('{broken');
 assert.equal((await service.bookingPerson(CONTACT)).status,'matched');
 assert.equal((await service.bookingPerson('missing@example.com') as any).reason,'gmail_corrupt');
 meeting(db);assert.equal((await service.bookingPerson(CONTACT) as any).reason,'granola_corrupt');
});

test('booking source never treats a capped Granola sync as a complete fresh snapshot',async t=>{
 const {db,service}=fixture(t);granola(db,{error:'note_cap_reached'});meeting(db);
 const present=await service.bookingPerson(CONTACT) as any;
 assert.equal(present.status,'unavailable');assert.equal(present.reason,'granola_incomplete');assert.equal(present.retryable,true);assert.equal(present.score,undefined);
 const absent=await service.bookingPerson('missing@example.com') as any;
 assert.equal(absent.status,'unavailable');assert.equal(absent.reason,'granola_incomplete');
 assert.equal((await service.bookingSourceStatus()).ready,false);
});
