import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFixture} from './workspace-routes.test';
import {buildWorkspaceGraph,searchWorkspace} from '../src/workspace-graph';
async function setup(){
 const f=workspaceFixture(),id=await f.create(),token=await f.invite(id,'member@example.com');
 await f.call('workspace-invites/accept','POST',{token},'member@example.com');
 for(const me of ['owner@example.com','member@example.com'])await f.call('/'+id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'themes'},me);
 f.env.MAIL={getByName:(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>({slice:{owner,exportedAt:Date.now(),people:[{email:'contact@example.test',name:'Contact Name',lastContact:null,meetings:1}],edges:[],themes:[],signals:[]},relationships:{'contact@example.test':{score:owner==='owner@example.com'?80:30,scoreVersion:'email-v1',lastContact:null,observedAt:new Date().toISOString(),evidenceCategory:'email'}},truncated:false})})};return {...f,id};
}
test('workspace graph merges identities but keeps separate measured member relationships',async()=>{
 const f=await setup(),g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(g.nodes.length,1);assert.equal(g.nodes[0].relationships.length,2);
 assert.deepEqual(g.nodes[0].relationships.map(r=>r.score).sort(),[30,80]);
 assert.equal(g.nodes[0].directRelationship,false);assert.equal(g.nodes[0].combined,null);
 assert.equal(JSON.stringify(g).includes('contact@example.test'),false);
 await assert.rejects(buildWorkspaceGraph(f.env,f.id,'outsider@example.com'),/workspace_unavailable/);
});
test('workspace graph handles unavailable members and membership removal during export',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>owner==='member@example.com'?{bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{throw Error('offline');}}:original(owner);
 const partial=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(partial.coverage.unavailable.length,1);assert.equal(partial.nodes.length,1);
 const members:any=await (await f.call('/'+f.id+'/members')).json(),member=members.members.find((m:any)=>!m.isMe);
 f.env.MAIL.getByName=(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{await f.call('/'+f.id+'/members/'+member.id,'DELETE');return original(owner).exportWorkspaceSlice();}});
 await assert.rejects(buildWorkspaceGraph(f.env,f.id,'member@example.com'),/workspace_unavailable/);
});

test('workspace search and drafts use only permitted member graph, and disabled contributions disappear',async()=>{
 const f=await setup();
 const graph=await buildWorkspaceGraph(f.env,f.id,'owner@example.com'),person=graph.nodes[0],memberId=person.relationships[0].memberId;
 const search:any=await (await f.call('/'+f.id+'/search','POST',{query:'Contact'})).json();assert.equal(search.results[0].personId,person.id);
 const noMatch:any=await (await f.call('/'+f.id+'/search','POST',{query:'private-inbox-secret'})).json();assert.equal(noMatch.results.length,0);
 assert.equal((await f.call('/'+f.id+'/draft','POST',{personId:'private-person-id',memberId})).status,404);
 const draft:any=await (await f.call('/'+f.id+'/draft','POST',{personId:person.id,memberId})).json();assert.match(draft.body,/Contact Name/);assert.equal(draft.introVia,person.relationships[0].memberName);
 for(const me of ['owner@example.com','member@example.com'])await f.call('/'+f.id+'/contribution','PUT',{enabled:false,scope:{kind:'all'},level:'names'},me);
 const empty=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(empty.nodes.length,0);
});

test('workspace keeps contributor edge observations and shared topic relevance',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({bindOwner:async()=>{},workspacePersonalScores:async()=>({}),exportWorkspaceSlice:async()=>{
 const v=await original(owner).exportWorkspaceSlice();v.slice.people.push({email:'second@example.test',name:'Second Person',lastContact:null,meetings:0});
 v.slice.edges=[{a:'contact@example.test',b:'second@example.test',weight:1,types:[owner.startsWith('owner')?'shared_email':'shared_meeting'],contexts:[]}];
 v.slice.themes=[{id:'t',name:'UI design'}];v.slice.signals=[{email:'contact@example.test',themeId:'t',summary:'Working on UI design',observedAt:new Date().toISOString(),sourceType:'gmail_body_derived',confidence:1}];return v;}});
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(g.edges[0].evidence.length,2);assert.ok(g.edges[0].evidence.every(e=>e.owner&&e.title));
 assert.equal(g.relevance.themes.length,2);assert.equal(g.relevance.themes[0].nodeIds.length,1);
 const {normalizeGraph}=await import('../public/relationship-graph/model.mjs');const normalized=normalizeGraph(g);assert.equal(normalized.edges[0].evidence.length,2);assert.ok(normalized.edges[0].evidence.every((e:any)=>e.owner));assert.equal(normalized.relevance.themes[0].name,'UI Design');
});

test('private feedback overlay is never returned to a teammate',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspacePersonalScores:async()=>owner==='owner@example.com'?{'contact@example.test':{base:80,delta:-10,score:70}}:{}});
 const own=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(own.nodes[0].viewerScore?.score,70);
 const teammate=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(teammate.nodes[0].viewerScore,undefined);
 assert.equal(teammate.nodes[0].relationships.find(r=>r.memberName==='owner@example.com')?.score,80);
});

test('workspace identity uses private viewer photos without exposing them to teammates',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspaceProfiles:async()=>owner==='owner@example.com'?{'contact@example.test':{name:'My Known Contact',photoUrl:'https://lh3.googleusercontent.com/own'}}:{}});
 const own=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(own.nodes[0].photoUrl,'https://lh3.googleusercontent.com/own');assert.equal(own.nodes[0].name,'My Known Contact');
 const other=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(other.nodes[0].photoUrl,null);assert.equal(other.nodes[0].name,'Contact Name');
});
test('workspace prefers identified names and allows shared photos only with explicit consent',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),exportWorkspaceSlice:async()=>{const v=await original(owner).exportWorkspaceSlice();v.slice.people[0].name=owner==='owner@example.com'?'Someone at example.test':'Contact Name';return {...v,profiles:{'contact@example.test':{name:'Contact Profile',photoUrl:'https://lh3.googleusercontent.com/shared'}}};}});
 const before=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(before.nodes[0].name,'Contact Name');assert.equal(before.nodes[0].photoUrl,null);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',shareProfiles:true},'member@example.com');
 const after=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(after.nodes[0].name,'Contact Name');assert.equal(after.nodes[0].photoUrl,'https://lh3.googleusercontent.com/shared');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',shareProfiles:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].photoUrl,null);
});

test('workspace retains human display names over viewer email-handle fallbacks',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),workspaceProfiles:async()=>({'contact@example.test':{name:'contact',photoUrl:null}})});
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].name,'Contact Name');
});

test('workspace Obsidian source requires consent, retains photos, excludes private context and scores',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 const snapshot={coverage:{totalContacts:4900},nodes:[{id:'vault-a',name:'Ada Vault',company:'Design',photoUrl:'https://lh3.googleusercontent.com/ada',combined:99},{id:'vault-b',name:'Bo Vault'}],edges:[{source:'vault-a',target:'vault-b',contexts:['PRIVATE EMAIL SUBJECT'],weight:88}]};
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify(snapshot),1700000000);
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.length,1);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true,shareProfiles:true},'member@example.com');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(g.nodes.length,3);
 const ada=g.nodes.find(n=>n.name==='Ada Vault')!;assert.equal(ada.photoUrl,'https://lh3.googleusercontent.com/ada');assert.equal(ada.relationships[0].score,null);
 assert.ok(!JSON.stringify(g).includes('PRIVATE EMAIL SUBJECT'));
 const coverage=g.coverage.sources.find(s=>s.source==='obsidian'&&s.included>0)!;assert.equal(coverage.available,2);assert.equal(coverage.vaultTotal,4900);assert.equal(coverage.limited,true);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'people',personIds:['obsidian:vault-a']},level:'names',includeObsidian:true,shareProfiles:false},'member@example.com');
 const scoped=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(scoped.nodes.some(n=>n.name==='Bo Vault'),false);assert.equal(scoped.nodes.find(n=>n.name==='Ada Vault')!.photoUrl,null);
 const own=await buildWorkspaceGraph(f.env,f.id,'member@example.com');assert.equal(own.nodes.find(n=>n.name==='Ada Vault')!.photoUrl,'https://lh3.googleusercontent.com/ada');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.some(n=>n.name==='Ada Vault'),false);
});
test('workspace includes a 4900-person uploaded vault without the web sharing cap',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:Array.from({length:4900},(_,i)=>({id:'vault-'+i,name:'Person '+i})),edges:[]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'member@example.com');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(g.nodes.length,4901);assert.equal(g.coverage.sources.find(s=>s.source==='obsidian'&&s.included>0)!.included,4900);
});

test('workspace vault address-shaped names require profile consent except for the owner',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:[{id:'vault-a',name:'privatehandle@example.test'}],edges:[]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true,shareProfiles:false},'member@example.com');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes.find(n=>n.sources?.includes('obsidian'))!.name,'Name unavailable');
 assert.equal((await buildWorkspaceGraph(f.env,f.id,'member@example.com')).nodes.find(n=>n.sources?.includes('obsidian'))!.name,'privatehandle');
});

test('shared Obsidian theme associations honor level and do not expose note text at themes level',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');const time=new Date().toISOString();
 const snapshot={nodes:[{id:'vault-a',name:'Ada'}],edges:[],themes:[{id:'ui',canonicalName:'UI design',aliases:[],description:'',status:'active'}],themeSignals:[{id:'sig',personId:'vault-a',themeId:'ui',sourceType:'obsidian_note',visibility:'private',observedAt:time,ingestedAt:time,confidence:.9,summary:'PRIVATE NOTE WORDS',evidenceRef:'obsidian:test',contentHash:'hash',extractorVersion:'local-theme-v1'}]};
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify(snapshot),1700000000);
 for(const level of ['names','themes','statements']){
  await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level,includeObsidian:true},'member@example.com');
  const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
  assert.equal(g.themeSignals.length,level==='names'?0:1);
  assert.equal(JSON.stringify(g).includes('PRIVATE NOTE WORDS'),level==='statements');
  if(level!=='names'){assert.equal(g.themes[0].name,'UI design');assert.equal(g.themeSignals[0].personId,g.nodes.find(n=>n.name==='Ada')!.id);}
 }
});

test('workspace identities join two vaults and Gmail without exposing addresses or matching tokens',async()=>{
 const {matchingKey,identityToken,matchingWorkspaces}=await import('../src/workspace-identity');
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 const key=await matchingKey(f.env,f.id),shared=await identityToken(key,'CONTACT@example.test');
 assert.notEqual(shared,await identityToken(await matchingKey(f.env,'other-workspace'),'contact@example.test'));
 assert.deepEqual(await matchingWorkspaces(f.env,'outsider@example.com'),[]);
 for(const [i,owner] of ['owner@example.com','member@example.com'].entries()){
  await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},owner);
  const snapshot={nodes:[{id:'salted-'+i,name:'Contact Name',workspaceIdentities:{[f.id]:shared}},{id:'other-'+i,name:'Same display name'}],edges:[{source:'salted-'+i,target:'other-'+i,weight:1}]};
  f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run(owner,JSON.stringify(snapshot),1700000000);
 }
 assert.equal((await matchingWorkspaces(f.env,'owner@example.com')).length,1);
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(g.nodes.length,3); // Mutual person once; same-name strangers remain separate.
 const mutual=g.nodes.find(n=>n.name==='Contact Name')!;
 assert.equal(mutual.relationships.length,2);assert.deepEqual(mutual.relationships.map(r=>r.score).sort(),[30,80]);
 assert.equal(g.edges.filter(e=>e.source===mutual.id||e.target===mutual.id).length,2);
 assert.ok(g.nodes.every(n=>!('workspaceIdentities' in n)));
 assert.ok(!JSON.stringify(g).includes(shared));assert.ok(!JSON.stringify(g).includes('contact@example.test'));
 await f.call('/'+f.id+'/contribution','PUT',{enabled:false,scope:{kind:'all'},level:'names',includeObsidian:true},'member@example.com');
 const privateAgain=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.equal(privateAgain.nodes.length,2);assert.equal(privateAgain.edges.length,1);
 assert.deepEqual(await matchingWorkspaces(f.env,'member@example.com'),[]);
});

test('workspace matching validates tokens and restricts canonical identities to selected people',async()=>{
 const {normalizePushedGraph}=await import('../src/relevance-routes');
 assert.equal(normalizePushedGraph({nodes:[{id:'a',workspaceIdentities:{w:'not-a-token'}}],edges:[]}),null);
 const f=await setup(),{matchingKey,identityToken}=await import('../src/workspace-identity');
 const token=await identityToken(await matchingKey(f.env,f.id),'contact@example.test');
 f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:[{id:'match',name:'Contact',workspaceIdentities:{[f.id]:token}},{id:'selected',name:'Selected'}],edges:[{source:'match',target:'selected'}]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'people',personIds:['obsidian:selected']},level:'names',includeObsidian:true},'member@example.com');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 assert.ok(!g.nodes.find(n=>n.name==='Contact Name')?.sources?.includes('obsidian'));assert.equal(g.edges.length,0);
});

test('workspace capacity limits only new identities, not matching contributor evidence',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 const {matchingKey,identityToken}=await import('../src/workspace-identity');
 const {appendWorkspaceObsidian}=await import('../src/workspace-obsidian');
 const {readWorkspace}=await import('../src/workspace-store');
 const token=await identityToken(await matchingKey(f.env,f.id),'contact@example.test');
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 for(let i=1;i<10000;i++)g.nodes.push({...g.nodes[0],id:'filler-'+i,relationships:[]});
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:[{id:'new',name:'Too many'},{id:'match',name:'Contact',workspaceIdentities:{[f.id]:token}}],edges:[]}),1700000000);
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'member@example.com');
 await appendWorkspaceObsidian(f.env,await readWorkspace(f.env.DB,f.id),'owner@example.com',g);
 assert.equal(g.nodes.length,10000);assert.ok(g.nodes[0].sources!.includes('obsidian'));
 const c=g.coverage.sources.filter(c=>c.source==='obsidian'&&c.included>0).pop()!;assert.equal(c.included,1);assert.equal(c.limited,true);
});

test('workspace matching endpoint requires a valid push token and never caches keys',async()=>{
 const worker=(await import('../src/index')).default;
 const {makeSession}=await import('../src/session');
 const f=await setup();
 const req=()=>new Request('https://people.test/api/matching-workspaces');
 assert.equal((await worker.fetch(req(),f.env,{} as any)).status,401);
 const session=await makeSession('owner@example.com',f.env.TOKEN_SECRET);
 const {sessionCookie}=await import('../src/session');
 const tokenResponse=await worker.fetch(new Request('https://people.test/api/token',{headers:{cookie:sessionCookie(session).split(';')[0]}}),f.env,{} as any);
 const token=(await tokenResponse.json() as any).token;assert.ok(token);
 const get=()=>worker.fetch(new Request('https://people.test/api/matching-workspaces',{headers:{authorization:'Bearer '+token}}),f.env,{} as any);
 assert.deepEqual(await (await get()).json(),{workspaces:[]});
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true});
 const response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await response.json() as any).workspaces.length,1);
});

test('workspace introductions require membership and do not invent suggestions for names-only data',async()=>{
 const f=await setup();const response=await f.call('/'+f.id+'/introductions','POST',{});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{suggestions:[],checked:false});
 assert.equal((await f.call('/'+f.id+'/introductions','POST',{},'outsider@example.com')).status,403);
});

test('vault measured contact enables independent member scores without using private snapshot scores',async()=>{
 const f=await setup();f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'owner@example.com');
 const raw={version:1,sent:12,received:8,lastEmail:'2026-01-01T00:00:00Z',meetings:0,lastMeeting:null};
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('owner@example.com',JSON.stringify({nodes:[{id:'measured',name:'Measured',combined:99,measuredContact:raw},{id:'note',name:'Note only',combined:99},{id:'invalid',name:'Invalid',measuredContact:{...raw,sent:-1}}],edges:[]}),1700000000);
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');
 const r=g.nodes.find(n=>n.name==='Measured')!.relationships[0];assert.equal(r.evidenceCategory,'email');assert.equal(r.scoreVersion,'email-v1');assert.ok(r.score!==null&&r.score<99);assert.equal(r.activity?.sent,12);
 for(const name of ['Note only','Invalid']){const r=g.nodes.find(n=>n.name===name)!.relationships[0];assert.equal(r.score,null);assert.equal(r.evidenceCategory,'unknown');}
});

test('matched vault contact replaces older web evidence without summing overlapping counts',async()=>{
 const f=await setup(),{matchingKey,identityToken}=await import('../src/workspace-identity');
 const token=await identityToken(await matchingKey(f.env,f.id),'contact@example.test');
 f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'owner@example.com');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('owner@example.com',JSON.stringify({nodes:[{id:'a',name:'Contact Name',workspaceIdentities:{[f.id]:token},measuredContact:{version:1,sent:12,received:8,lastEmail:'2026-01-01',meetings:0,lastMeeting:null}}],edges:[]}),1700000000);
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(g.nodes.length,1);assert.equal(g.nodes[0].relationships.length,2);
 assert.equal(g.nodes[0].relationships.find(r=>r.memberName==='owner@example.com')!.activity?.sent,12);
 assert.equal(g.nodes[0].relationships.find(r=>r.memberName==='member@example.com')!.score,30);
});

test('exclude only own contribution, preserve others, and undo; exclusions survive sharing settings',async()=>{
 const f=await setup(),before=await buildWorkspaceGraph(f.env,f.id,'owner@example.com'),personId=before.nodes[0].id;
 assert.equal((await f.call('/'+f.id+'/excluded-people','POST',{personId},'outsider@example.com')).status,403);
 assert.equal((await f.call('/'+f.id+'/excluded-people','POST',{personId},'owner@example.com')).status,200);
 let graph=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(graph.nodes.length,1);assert.equal(graph.nodes[0].relationships.length,1);assert.equal(graph.nodes[0].relationships[0].memberName,'member@example.com');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'themes'},'owner@example.com');graph=await buildWorkspaceGraph(f.env,f.id,'owner@example.com');assert.equal(graph.nodes[0].relationships.length,1);
 assert.equal((await f.call('/'+f.id+'/excluded-people','DELETE',{personId},'owner@example.com')).status,200);assert.equal((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].relationships.length,2);
});

test('relationship confirmation belongs only to the contributor and can be revoked',async()=>{
 const f=await setup(),g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com'),personId=g.nodes[0].id;
 const path='/'+f.id+'/relationship-confirmations';
 assert.equal((await f.call(path,'POST',{personId},'outsider@example.com')).status,403);
 assert.equal((await f.call(path,'POST',{personId:'missing'})).status,404);
 assert.equal((await f.call(path,'POST',{personId,memberId:g.members.find(m=>!m.isMe)!.id})).status,200);
 const next=await buildWorkspaceGraph(f.env,f.id,'member@example.com');
 assert.ok(next.nodes[0].relationships.find(r=>r.memberName==='owner@example.com')?.confirmedAt);
 assert.equal(next.nodes[0].relationships.find(r=>r.memberName==='member@example.com')?.confirmedAt,undefined);
 assert.equal((await f.call(path,'DELETE',{personId})).status,200);
 assert.ok((await buildWorkspaceGraph(f.env,f.id,'owner@example.com')).nodes[0].relationships.every(r=>!r.confirmedAt));
});
test('streamed search reports real contributor searches and ends with the answer',async()=>{
 const f=await setup(),response=await f.call('/'+f.id+'/search-stream','POST',{query:'Contact'});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/ndjson/);
 const events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(events.filter(e=>e.type==='scope').length,2);assert.ok(events.some(e=>e.type==='candidate'));
 assert.equal(events.at(-1).type,'result');assert.equal(events.at(-1).answer.results[0].name,'Contact Name');
 assert.equal((await f.call('/'+f.id+'/search-stream','POST',{query:'Contact'},'outsider@example.com')).status,403);
});
test('contributor search lanes use only evidence from that contributor',async()=>{
 const f=await setup(),original=f.env.MAIL.getByName;
 f.env.MAIL.getByName=(owner:string)=>({...original(owner),exportWorkspaceSlice:async()=>{const value=await original(owner).exportWorkspaceSlice();if(owner==='owner@example.com'){Object.assign(value.slice,{themes:[{id:'memory',name:'Agent memory'}],signals:[{email:'contact@example.test',themeId:'memory',summary:'Recorded topic: Agent memory',observedAt:'2026-09-01',sourceType:'granola',confidence:1}]});}return value;}});
 const response=await f.call('/'+f.id+'/search-stream','POST',{query:'agent memory'}),events=(await response.text()).trim().split('\n').map(v=>JSON.parse(v));
 const candidates=events.filter(e=>e.type==='candidate');assert.ok(candidates.length);assert.ok(candidates.every(e=>e.label==='owner@example.com'));
});

test('traversal stops emitting evidence after sharing revision changes',async()=>{
 const f=await setup(),events:string[]=[];
 await assert.rejects(searchWorkspace(f.env,f.id,'owner@example.com','Contact',async e=>{events.push(String(e.type));if(e.type==='scope')await f.call('/'+f.id+'/contribution','PUT',{enabled:false,scope:{kind:'all'},level:'names'});}),/workspace_changed_retry/);
 assert.deepEqual(events,['start','scope']);
});

test('published vault relationship scores create score-backed routes without personal confirmation',async()=>{
 const f=await setup(),{matchingKey,identityToken}=await import('../src/workspace-identity');
 const token=await identityToken(await matchingKey(f.env,f.id),'scored@example.test');
 f.sqlite.exec('CREATE TABLE graphs (email TEXT PRIMARY KEY,json TEXT,updated_at INTEGER)');
 await f.call('/'+f.id+'/contribution','PUT',{enabled:true,scope:{kind:'all'},level:'names',includeObsidian:true},'member@example.com');
 f.sqlite.prepare('INSERT INTO graphs VALUES (?,?,?)').run('member@example.com',JSON.stringify({nodes:[{id:'s',name:'Scored',strength:70,momentum:40,combined:55,measuredContact:{version:1,sent:3,received:2,lastEmail:'2026-01-01',meetings:0,lastMeeting:null},workspaceIdentities:{[f.id]:token}},{id:'zero',name:'Zero',strength:0,momentum:70,combined:35},{id:'bad',name:'Bad',strength:120,momentum:40,combined:80}],edges:[]}),1700000000);
 const g=await buildWorkspaceGraph(f.env,f.id,'owner@example.com'),person=g.nodes.find(n=>n.name==='Scored')!,r=person.relationships[0];
 assert.equal(r.score,55);assert.equal(r.evidenceCategory,'score');assert.equal(r.confirmedAt,undefined);assert.equal(r.observedAt,'2023-11-14T22:13:20.000Z');
 const {buildAnswerCards}=await import('../src/network-answer');assert.equal(buildAnswerCards(g,[{personId:person.id}])[0].routes[0].basis,'published_score');
 for(const name of ['Zero','Bad'])assert.equal(g.nodes.find(n=>n.name===name)!.relationships[0].evidenceCategory,'unknown');
});
