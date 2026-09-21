import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeSession,sessionCookie} from '../src/session';
import {__setRefreshBudgetForTests,refreshShares} from '../src/share-routes';
import worker from '../src/index';

/**
 * A small fake D1 that understands only the statements `share-routes.ts` issues. It refuses
 * every statement until `CREATE TABLE` has run, so the lazy DDL is provably first, and it
 * records every statement text so the tests can count the DDL.
 */
function fakeDB(rows:any[]){
 const statements:string[]=[];let created=false;
 return {rows,statements,
  prepare(text:string){
   statements.push(text);const sql=text.replace(/\s+/g,' ').replace(/ ?= ?/g,'=').trim();let args:any[]=[];
   const table=()=>{if(!created)throw Error('no such table: shares');};
   const limit=()=>{const found=sql.match(/LIMIT (\d+)/);return found?Number(found[1]):Infinity;};
   const matches=(row:any)=>{
    if(sql.includes('owner_email=? AND viewer_email=?'))return row.owner_email===args[0]&&row.viewer_email===args[1];
    if(sql.includes('WHERE owner_email=?'))return row.owner_email===args[0];
    if(sql.includes('viewer_email=? AND hidden=0'))return row.viewer_email===args[0]&&!row.hidden;
    if(sql.includes('WHERE viewer_email=?'))return row.viewer_email===args[0];
    return false;
   };
   const self:any={
    bind(...next:any[]){args=next;return self;},
    async run(){
     if(sql.startsWith('CREATE TABLE')){created=true;return {success:true,meta:{changes:0}};}
     table();
     if(sql.startsWith('CREATE INDEX'))return {success:true,meta:{changes:0}};
     if(sql.startsWith('INSERT INTO shares')){
      const [owner,viewer,scope,level,createdAt,updatedAt]=args;
      const row=rows.find((r:any)=>r.owner_email===owner&&r.viewer_email===viewer);
      if(row){row.scope=scope;row.level=level;row.updated_at=updatedAt;}
      else rows.push({owner_email:owner,viewer_email:viewer,scope,level,created_at:createdAt,updated_at:updatedAt,hidden:0});
      return {meta:{changes:1}};
     }
     if(sql.startsWith('UPDATE shares')){const [hidden,updatedAt,owner,viewer]=args;const row=rows.find((r:any)=>r.owner_email===owner&&r.viewer_email===viewer);if(row){row.hidden=hidden;row.updated_at=updatedAt;}return {meta:{changes:row?1:0}};}
     if(sql.startsWith('DELETE FROM shares')){const [owner,viewer]=args;const at=rows.findIndex((r:any)=>r.owner_email===owner&&r.viewer_email===viewer);if(at>=0)rows.splice(at,1);return {meta:{changes:at>=0?1:0}};}
     throw Error('unexpected statement: '+sql);
    },
    async all(){
     if(sql.includes('FROM graphs'))return {results:[]};
     table();if(!sql.startsWith('SELECT'))throw Error('unexpected statement: '+sql);
     return {results:rows.filter(matches).sort((x:any,y:any)=>y.updated_at-x.updated_at).slice(0,limit()).map((row:any)=>({...row}))};
    },
    async first(){const {results}=await self.all();return results[0]??null;}
   };
   return self;
  }};
}

function fixture(rows:any[]=[]){
 const calls:string[]=[],failures=new Set<string>(),meta:Record<string,{refreshedAt:number;owners:string[]}>={},objects:Record<string,any>={};
 let people=3;
 const object=(name:string)=>objects[name]??=({
  bindOwner:async(who:string)=>{calls.push('bind:'+who);},
  exportSlice:async(scope:any,level:string)=>{calls.push(`export:${name}:${level}:${JSON.stringify(scope)}`);if(failures.has(name))throw Error('boom');return {owner:name,exportedAt:1,people:[],edges:[],themes:[],signals:[]};},
  importShares:async(slices:any[])=>{calls.push('import:'+name+':'+slices.map(slice=>slice.owner).join(','));return {owners:slices.map(slice=>slice.owner),people};},
  dropShare:async(who:string)=>{calls.push(`drop:${name}:${who}`);},
  sharedMeta:async()=>meta[name]??{refreshedAt:0,owners:[]},
  graph:async()=>({nodes:[{id:'n1',name:'Ada'}],edges:[]}),
 });
 const db=fakeDB(rows);
 const env:any={TOKEN_SECRET:'session-secret',GOOGLE_CLIENT_ID:'client',DB:db,MAIL:{getByName:(name:string)=>object(name)},ASSETS:{fetch:async()=>new Response('asset')}};
 return {env,db,rows,calls,failures,meta,objects,setPeople:(n:number)=>{people=n;}};
}
const OWNER='owner@example.test';
async function signed(path:string,env:any,init:RequestInit={},email=OWNER){
 const headers=new Headers(init.headers);headers.set('cookie',sessionCookie(await makeSession(email,env.TOKEN_SECRET)).split(';')[0]);
 return worker.fetch(new Request('https://people.test'+path,{...init,headers}),env);
}
const post=(body:string,origin='https://people.test')=>({method:'POST',headers:{origin,'content-type':'application/json'},body});
const del=(body:string,origin='https://people.test')=>({method:'DELETE',headers:{origin,'content-type':'application/json'},body});
const ddl=(db:any)=>db.statements.filter((sql:string)=>sql.includes('CREATE TABLE')||sql.includes('CREATE INDEX'));

test('share listing creates the D1 table once and separates outgoing from incoming',async()=>{
 const {env,db,calls}=fixture([
  {owner_email:OWNER,viewer_email:'ada@vc.test',scope:JSON.stringify({kind:'all'}),level:'themes',created_at:100,updated_at:200,hidden:0},
  {owner_email:OWNER,viewer_email:'bo@vc.test',scope:'{not json',level:'names',created_at:100,updated_at:150,hidden:0},
  {owner_email:'cara@vc.test',viewer_email:OWNER,scope:JSON.stringify({kind:'folders',ids:['fol_1']}),level:'statements',created_at:10,updated_at:20,hidden:1},
  {owner_email:'dee@vc.test',viewer_email:'someone@else.test',scope:JSON.stringify({kind:'all'}),level:'names',created_at:1,updated_at:2,hidden:0},
 ]);
 assert.equal((await worker.fetch(new Request('https://people.test/api/shares'),env)).status,401);
 assert.deepEqual(db.statements,[]);
 const response=await signed('/api/shares',env);
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{
  outgoing:[{viewerEmail:'ada@vc.test',scope:{kind:'all'},level:'themes',updatedAt:200}],
  incoming:[{ownerEmail:'cara@vc.test',level:'statements',updatedAt:20,hidden:true}],
 });
 assert.equal(ddl(db).length,2,'the table and its index are created lazily on first use');
 await signed('/api/shares',env);
 assert.equal(ddl(db).length,2,'the DDL is memoized per isolate');
 assert.deepEqual(calls,[],'listing never touches a durable object');
 assert.equal((await signed('/api/shares',env,{method:'PUT',headers:{origin:'https://people.test'}})).status,405);
});

test('creating a share validates the request, caps outgoing shares and pushes the slice at once',async()=>{
 const {env,db,rows,calls}=fixture();
 const good=JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',personIds:['abc123']},level:'statements'});
 assert.equal((await worker.fetch(new Request('https://people.test/api/shares',post(good)),env)).status,401);
 assert.equal((await signed('/api/shares',env,post(good,'https://evil.test'))).status,403);
 for(const body of ['not json','[]','{}',
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'all'}}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'all'},level:'everything'}),
  JSON.stringify({viewerEmail:'not-an-email',scope:{kind:'all'},level:'names'}),
  JSON.stringify({viewerEmail:OWNER,scope:{kind:'all'},level:'names'}),
  JSON.stringify({viewerEmail:'Ada@VC.test '.repeat(40),scope:{kind:'all'},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'nope'},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',personIds:[]},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',personIds:['ada@vc.test']},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',personIds:['x'.repeat(201)]},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',emails:['nope']},level:'names'}),
  JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'folders',ids:[]},level:'names'}),
 ]){
  const bad=await signed('/api/shares',env,post(body));
  assert.equal(bad.status,400,body.slice(0,60));
  assert.equal((await bad.json() as any).error,'invalid_request',body.slice(0,60));
 }
 const huge=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',emails:['x@y.test']},level:'names',pad:'p'.repeat(20_000)})));
 assert.equal(huge.status,413);
 assert.deepEqual(rows,[],'a rejected share is never written');
 assert.deepEqual(calls,[],'a rejected share never reaches a durable object');

 const created=await signed('/api/shares',env,post(good));
 assert.equal(created.status,200);assert.equal(created.headers.get('cache-control'),'no-store');
 assert.deepEqual(await created.json(),{ok:true,people:3});
 assert.deepEqual(calls,['bind:'+OWNER,'export:'+OWNER+':statements:{"kind":"people","personIds":["abc123"]}','bind:ada@vc.test','import:ada@vc.test:'+OWNER],
  'the owner exports and the viewer imports, in that order');
 assert.equal(rows.length,1);
 assert.equal(rows[0].owner_email,OWNER);assert.equal(rows[0].viewer_email,'ada@vc.test');
 assert.equal(rows[0].level,'statements');assert.equal(rows[0].hidden,0);
 assert.deepEqual(JSON.parse(rows[0].scope),{kind:'people',personIds:['abc123']});
 assert.ok(rows[0].created_at>0&&rows[0].updated_at>0);

 // A second change to the same pair within the cooldown writes the row but does not push: an
 // owner must not be able to loop this route and keep the viewer's object busy.
 calls.length=0;
 const again=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'ADA@vc.test',scope:{kind:'all'},level:'names'})));
 assert.equal(again.status,200);
 assert.deepEqual(await again.json(),{ok:true,people:null},'a rapid second push is left to the viewer’s own refresh');
 assert.equal(rows.length,1,'the same viewer is upserted, not duplicated');
 assert.equal(rows[0].level,'names');assert.deepEqual(JSON.parse(rows[0].scope),{kind:'all'});
 assert.deepEqual(calls,[],'nothing reaches either durable object while the cooldown holds');

 rows[0].updated_at=Date.now()-120_000;calls.length=0;
 const later=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'all'},level:'names'})));
 assert.equal(later.status,200);
 assert.ok(calls.includes('export:'+OWNER+':names:{"kind":"all"}'),'past the cooldown the change is pushed straight away again');

 // A viewer who declined keeps their decision: the row is updated, nothing is pushed at them.
 rows[0].hidden=1;calls.length=0;
 const declined=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'all'},level:'themes'})));
 assert.equal(declined.status,200);assert.deepEqual(await declined.json(),{ok:true,people:0});
 assert.deepEqual(calls,[]);assert.equal(rows[0].hidden,1);assert.equal(rows[0].level,'themes');

 for(let i=0;i<50;i++)rows.push({owner_email:OWNER,viewer_email:`v${i}@vc.test`,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:1,hidden:0});
 calls.length=0;
 const capped=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'one-too-many@vc.test',scope:{kind:'all'},level:'names'})));
 assert.equal(capped.status,409);assert.equal((await capped.json() as any).error,'share_limit');
 assert.deepEqual(calls,[]);
 assert.ok(!rows.some((row:any)=>row.viewer_email==='one-too-many@vc.test'));
 const existing=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'v3@vc.test',scope:{kind:'all'},level:'themes'})));
 assert.equal(existing.status,200,'an existing viewer can still be updated at the cap');
 assert.ok(ddl(db).length===2);
});

test('revoking a share deletes the row and drops the viewer’s cached copy',async()=>{
 const {env,rows,calls}=fixture([
  {owner_email:OWNER,viewer_email:'ada@vc.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:2,hidden:0},
  {owner_email:'cara@vc.test',viewer_email:'ada@vc.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:2,hidden:0},
 ]);
 assert.equal((await worker.fetch(new Request('https://people.test/api/shares',del('{"viewerEmail":"ada@vc.test"}')),env)).status,401);
 assert.equal((await signed('/api/shares',env,del('{"viewerEmail":"ada@vc.test"}','https://evil.test'))).status,403);
 for(const body of ['not json','{}','{"viewerEmail":"nope"}','{"viewerEmail":""}']){
  assert.equal((await signed('/api/shares',env,del(body))).status,400,body);
 }
 assert.equal(rows.length,2);assert.deepEqual(calls,[]);
 const revoked=await signed('/api/shares',env,del('{"viewerEmail":"Ada@vc.test"}'));
 assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{ok:true});
 assert.deepEqual(rows.map((row:any)=>row.owner_email),['cara@vc.test'],'only this owner’s row goes');
 assert.deepEqual(calls,['drop:ada@vc.test:'+OWNER],'the viewer’s object forgets this owner immediately');
 calls.length=0;
 const twice=await signed('/api/shares',env,del('{"viewerEmail":"ada@vc.test"}'));
 assert.equal(twice.status,200,'revoking twice is not an error');
 assert.deepEqual(calls,[],'a revoke that deleted nothing never creates a durable object for the address');
 const stranger=await signed('/api/shares',env,del('{"viewerEmail":"never-heard-of@vc.test"}'));
 assert.equal(stranger.status,200);
 assert.deepEqual(calls,[],'nor for an address this owner never shared with');
});

test('a viewer already holding twenty shares is refused, and a hidden share still counts',async()=>{
 const viewer='full@vc.test';
 const rows=Array.from({length:20},(_,i)=>({owner_email:`o${i}@vc.test`,viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:100-i,hidden:i===0?1:0}));
 const {env,calls}=fixture(rows);
 const capped=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:viewer,scope:{kind:'all'},level:'names'})));
 assert.equal(capped.status,409);
 const body=await capped.json() as any;
 assert.equal(body.error,'viewer_limit');
 assert.match(body.message,/maximum number of shared networks/);
 assert.ok(!rows.some((row:any)=>row.owner_email===OWNER),'a refused share is never written');
 assert.deepEqual(calls,[],'and never reaches the viewer’s object');

 // One of the twenty changing their own share is not a twenty-first owner.
 const existing=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:viewer,scope:{kind:'all'},level:'themes'})),'o5@vc.test');
 assert.equal(existing.status,200);
 assert.equal(rows.find((row:any)=>row.owner_email==='o5@vc.test').level,'themes');
});

test('the picker’s two-hundred-person selection fits the route’s body cap',async()=>{
 const {env,rows}=fixture();
 // An opaque node id is base64url SHA-256: 43 characters, ~46 bytes inside a JSON array.
 const personIds=Array.from({length:200},(_,index)=>`p${String(index).padStart(3,'0')}`.padEnd(43,'x'));
 assert.equal(personIds[0].length,43);
 const response=await signed('/api/shares',env,post(JSON.stringify({viewerEmail:'ada@vc.test',scope:{kind:'people',personIds},level:'names'})));
 assert.equal(response.status,200,'the number the picker promises is a number the route accepts');
 assert.equal(JSON.parse(rows[0].scope).personIds.length,200);
});

test('two refreshes at once for one viewer run as one',async()=>{
 // The per-isolate attempt stamp already collapses two ordinary graph loads; what it cannot
 // collapse is the forced refresh an un-hide runs, which skips the interval check entirely.
 const viewer='viewer-concurrent@example.test';
 const {env,calls}=fixture([
  {owner_email:'bo@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:30,hidden:1},
  {owner_email:'cara@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'themes',created_at:1,updated_at:20,hidden:0},
 ]);
 // A real object round trip is not instant; without that the two requests never overlap at all.
 env.MAIL.getByName=((inner:(name:string)=>any)=>(name:string)=>{
  const object=inner(name);
  return {...object,sharedMeta:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return object.sharedMeta();}};
 })(env.MAIL.getByName);
 const headers={cookie:sessionCookie(await makeSession(viewer,env.TOKEN_SECRET)).split(';')[0],origin:'https://people.test','content-type':'application/json'};
 const unhide=()=>worker.fetch(new Request('https://people.test/api/shares/hide',
  {method:'POST',headers,body:'{"ownerEmail":"bo@vc.test","hidden":false}'}),env);
 const [first,second]=await Promise.all([unhide(),unhide()]);
 assert.equal(first.status,200);assert.equal(second.status,200);
 assert.deepEqual(calls.filter(call=>call.startsWith('export:')).sort(),
  ['export:bo@vc.test:names:{"kind":"all"}','export:cara@vc.test:themes:{"kind":"all"}'],
  'one export per owner, not one per concurrent refresh');
 assert.equal(calls.filter(call=>call.startsWith('import:')).length,1);
});

test('an owner whose export never answers cannot consume the whole refresh',async()=>{
 const viewer='viewer-hang@example.test';
 const {env,calls}=fixture([
  {owner_email:'fast@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:30,hidden:0},
  {owner_email:'hang@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:20,hidden:0},
 ]);
 env.MAIL.getByName=((inner:(name:string)=>any)=>(name:string)=>{
  const object=inner(name);
  return name==='hang@vc.test'?{...object,exportSlice:()=>new Promise(()=>{})}:object;
 })(env.MAIL.getByName);
 __setRefreshBudgetForTests(100);
 try{
  const outcome=await Promise.race([
   signed('/api/graph',env,{},viewer).then(response=>response.status),
   new Promise(resolve=>setTimeout(()=>resolve('hung'),5_000)),
  ]);
  assert.equal(outcome,200,'the refresh gives up on the hanging owner instead of hanging with it');
 }finally{__setRefreshBudgetForTests(null);}
 assert.deepEqual(calls.filter(call=>call.startsWith('import:')),[`import:${viewer}:fast@vc.test`],
  'the owner who did answer is still imported');
});

test('hiding an incoming share drops its cache and unhiding refreshes it',async()=>{
 const viewer='viewer-hide@example.test';
 const {env,rows,calls}=fixture([
  {owner_email:'cara@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'themes',created_at:1,updated_at:2,hidden:0},
 ]);
 assert.equal((await worker.fetch(new Request('https://people.test/api/shares/hide',post('{"ownerEmail":"cara@vc.test","hidden":true}')),env)).status,401);
 assert.equal((await signed('/api/shares/hide',env,post('{"ownerEmail":"cara@vc.test","hidden":true}','https://evil.test'),viewer)).status,403);
 for(const body of ['not json','{}','{"ownerEmail":"cara@vc.test"}','{"ownerEmail":"nope","hidden":true}','{"ownerEmail":"cara@vc.test","hidden":"yes"}']){
  assert.equal((await signed('/api/shares/hide',env,post(body),viewer)).status,400,body);
 }
 const unknown=await signed('/api/shares/hide',env,post('{"ownerEmail":"nobody@vc.test","hidden":true}'),viewer);
 assert.equal(unknown.status,404);assert.equal((await unknown.json() as any).error,'unknown_share');
 assert.deepEqual(calls,[]);

 const hidden=await signed('/api/shares/hide',env,post('{"ownerEmail":"Cara@vc.test","hidden":true}'),viewer);
 assert.equal(hidden.status,200);assert.deepEqual(await hidden.json(),{ok:true});
 assert.equal(rows[0].hidden,1);
 assert.deepEqual(calls,[`drop:${viewer}:cara@vc.test`],'hiding forgets the cached copy at once');

 calls.length=0;
 const shown=await signed('/api/shares/hide',env,post('{"ownerEmail":"cara@vc.test","hidden":false}'),viewer);
 assert.equal(shown.status,200);assert.equal(rows[0].hidden,0);
 assert.deepEqual(calls,['bind:cara@vc.test','export:cara@vc.test:themes:{"kind":"all"}','bind:'+viewer,`import:${viewer}:cara@vc.test`],
  'unhiding refreshes straight away rather than waiting for the next graph load');
 assert.equal((await signed('/api/shares/hide',env,{method:'GET'},viewer)).status,405);
});

test('the graph refresh imports stale shares, drops removed owners and survives a failing owner',async()=>{
 const viewer='viewer-graph@example.test';
 const {env,calls,failures,meta}=fixture([
  {owner_email:'bo@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:30,hidden:0},
  {owner_email:'cara@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'themes',created_at:1,updated_at:20,hidden:0},
  {owner_email:'dee@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:10,hidden:1},
  {owner_email:'bo@vc.test',viewer_email:'someone@else.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:5,hidden:0},
 ]);
 failures.add('cara@vc.test');
 meta[viewer]={refreshedAt:Date.now()-11*60*1000,owners:['bo@vc.test','gone@vc.test']};
 const response=await signed('/api/graph',env,{},viewer);
 assert.equal(response.status,200);
 assert.deepEqual((await response.json() as any).graph,{nodes:[{id:'n1',name:'Ada'}],edges:[]},'a refresh never changes the graph reply');
 assert.ok(calls.includes('export:bo@vc.test:names:{"kind":"all"}'));
 assert.ok(calls.includes('export:cara@vc.test:themes:{"kind":"all"}'),'a failing owner is still attempted');
 assert.ok(!calls.some(call=>call.startsWith('export:dee@vc.test')),'a hidden share is never refreshed');
 assert.deepEqual(calls.filter(call=>call.startsWith('import:')),[`import:${viewer}:bo@vc.test`],'only the slices that came back are imported');
 assert.deepEqual(calls.filter(call=>call.startsWith('drop:')),[`drop:${viewer}:gone@vc.test`],'an owner who stopped sharing is dropped, a failing one is kept');

 calls.length=0;
 meta[viewer]={refreshedAt:Date.now(),owners:['bo@vc.test']};
 assert.equal((await signed('/api/graph',env,{},viewer)).status,200);
 assert.deepEqual(calls,[],'a fresh cache is left alone');
});

test('the graph refresh stops at its time budget, its incoming cap, and a broken durable object',async()=>{
 const rows=Array.from({length:22},(_,i)=>({owner_email:`o${i}@vc.test`,viewer_email:'viewer-many@example.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:100-i,hidden:0}));
 const many=fixture(rows);
 assert.equal((await signed('/api/graph',many.env,{},'viewer-many@example.test')).status,200);
 assert.equal(many.calls.filter(call=>call.startsWith('export:')).length,20,'at most twenty incoming shares per refresh');

 const slow=fixture([
  {owner_email:'bo@vc.test',viewer_email:'viewer-slow@example.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:30,hidden:0},
  {owner_email:'cara@vc.test',viewer_email:'viewer-slow@example.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:20,hidden:0},
 ]);
 const realNow=Date.now;let offset=0;
 try{
  Date.now=()=>realNow()+offset;
  slow.env.MAIL.getByName=((inner)=>(name:string)=>{const object=inner(name);return {...object,exportSlice:async(scope:any,level:string)=>{offset+=21_000;return object.exportSlice(scope,level);}};})(slow.env.MAIL.getByName);
  const response=await worker.fetch(new Request('https://people.test/api/graph',{headers:{cookie:sessionCookie(await makeSession('viewer-slow@example.test',slow.env.TOKEN_SECRET)).split(';')[0]}}),slow.env);
  assert.equal(response.status,200);
 }finally{Date.now=realNow;}
 assert.equal(slow.calls.filter(call=>call.startsWith('export:')).length,1,'the budget stops the second export');
 assert.deepEqual(slow.calls.filter(call=>call.startsWith('import:')),['import:viewer-slow@example.test:bo@vc.test'],'what did come back is still imported');

 const broken=fixture([{owner_email:'bo@vc.test',viewer_email:'viewer-broken@example.test',scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:1,hidden:0}]);
 broken.env.MAIL.getByName=(name:string)=>({sharedMeta:async()=>{throw Error('SECRET durable object detail');},graph:async()=>({nodes:[],edges:[]}),bindOwner:async()=>{}});
 const survived=await signed('/api/graph',broken.env,{},'viewer-broken@example.test');
 assert.equal(survived.status,200,'a refresh failure never fails the graph');
 assert.deepEqual((await survived.json() as any).graph,null,'an empty mail graph still falls back to the pushed graph');
});

test('a forced refresh arriving mid-refresh runs its own pass instead of joining the stale one',async()=>{
 // An ordinary graph load has already read the share rows when the viewer un-hides an owner.
 // Joining that run would return without ever importing the un-hidden owner, and the attempt
 // stamp would then hold the next chance off for ten minutes.
 const viewer='viewer-unhide-race@example.test';
 const {env,rows,calls}=fixture([
  {owner_email:'bo@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'names',created_at:1,updated_at:30,hidden:1},
  {owner_email:'cara@vc.test',viewer_email:viewer,scope:'{"kind":"all"}',level:'themes',created_at:1,updated_at:20,hidden:0},
 ]);
 env.MAIL.getByName=((inner:(name:string)=>any)=>(name:string)=>{
  const object=inner(name);
  return {...object,exportSlice:async(scope:any,level:string)=>{await new Promise(resolve=>setTimeout(resolve,20));return object.exportSlice(scope,level);}};
 })(env.MAIL.getByName);
 const ordinary=refreshShares(env,viewer,false);
 await new Promise(resolve=>setTimeout(resolve,5));
 rows.find((row:any)=>row.owner_email==='bo@vc.test').hidden=0;
 const forced=refreshShares(env,viewer,true);
 await Promise.all([ordinary,forced]);
 assert.ok(calls.includes('export:bo@vc.test:names:{"kind":"all"}'),'the un-hidden owner is exported by the forced pass');
 assert.equal(calls.filter(call=>call.startsWith('import:')).length,2,'the forced pass imports on its own after the ordinary one');
});
