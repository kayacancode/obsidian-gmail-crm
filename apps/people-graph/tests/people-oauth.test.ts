import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPeopleMemoryCredential,listPeopleMemoryCredentials,revokePeopleMemoryCredential} from '../src/people-memory-auth';
import {fixture,origin,resource,owner,redirect,verifier} from './people-oauth-fixture';

test('People OAuth discovery advertises the canonical resource and browser sign-in without a key',async t=>{
 const f=await fixture(t),challenge=await f.send('/api/people-mcp');assert.equal(challenge.status,401);assert.match(challenge.headers.get('www-authenticate')??'',/oauth-protected-resource/);
 const metadata=await (await f.send('/.well-known/oauth-protected-resource/api/people-mcp')).json() as any;assert.equal(metadata.resource,resource);assert.deepEqual(metadata.authorization_servers,[origin]);assert.deepEqual(metadata.scopes_supported,['people:read','people:write','offline_access']);
 const head=await f.send('/.well-known/oauth-protected-resource/api/people-mcp',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const authorization=await (await f.send('/.well-known/oauth-authorization-server')).json() as any;assert.equal(authorization.authorization_endpoint,origin+'/oauth/authorize');assert.equal(authorization.token_endpoint,origin+'/oauth/token');assert.equal(authorization.registration_endpoint,origin+'/oauth/register');assert.deepEqual(authorization.code_challenge_methods_supported,['S256']);
 const client=await f.register(),signin=await f.send(await f.authUrl(client));const html=await signin.text();assert.equal(signin.status,200);assert.match(html,/google-signin/);assert.ok(!html.includes('name="handle"'));assert.equal(signin.headers.get('cache-control'),'no-store');assert.match(signin.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
});

test('People OAuth rejects scope escalation, incorrect resources and missing S256 before consent',async t=>{
 const f=await fixture(t),client=await f.register(),cookie=await f.session();
 for(const extra of [{scope:'people:read sources:manage'},{scope:'people:write'},{code_challenge:null},{code_challenge_method:'plain'},{resource:'https://foreign.test/api/people-mcp'},{redirect_uri:'https://foreign.test/callback'}]){
  const response=await f.send(await f.authUrl(client,undefined,extra),{headers:{cookie}});assert.ok(response.status>=400||response.status===302,JSON.stringify(extra));assert.ok(!(await response.text()).includes('name="handle"'));if(response.headers.has('location')){const target=new URL(response.headers.get('location')!);assert.equal(target.origin,new URL(redirect).origin);assert.ok(target.searchParams.has('error'));}
 }
 const confidential=await f.register({token_endpoint_auth_method:'client_secret_post'});const noPkce=await f.send(await f.authUrl(confidential,undefined,{code_challenge:null,code_challenge_method:null}),{headers:{cookie}});assert.notEqual(noPkce.status,200);
});

test('People OAuth consent is escaped, browser-bound, owner-bound and same-origin',async t=>{
 const f=await fixture(t),client=await f.register({client_name:'<script>alert(1)</script>'}),consent=await f.begin(client);
 assert.ok(!consent.html.includes('<script>alert(1)</script>'));assert.match(consent.html,/&lt;script&gt;/);assert.ok(consent.html.includes(owner));assert.ok(consent.html.includes('chatgpt.example.test'));
 assert.equal((await f.approve(consent,{}, {origin:'https://evil.test'})).status,403);
 assert.ok((await f.approve(consent,{}, {cookie:await f.session()})).status>=400);
 assert.ok((await f.approve(consent,{owner:'other@example.test'})).status>=400);
 assert.ok((await f.approve(consent,{}, {cookie:consent.cookie.replace(/__Host-people-session=[^;]+/,await f.session('other@example.test'))})).status>=400);
 const good=await f.approve(consent);assert.equal(good.status,302);assert.ok((await f.approve(consent)).status>=400);
 assert.equal((await listPeopleMemoryCredentials(f.env.DB,owner)).length,1);
});

test('People OAuth denial returns only to the registered client and creates no credential',async t=>{
 const f=await fixture(t),client=await f.register(),consent=await f.begin(client),response=await f.approve(consent,{decision:'deny'});
 assert.equal(response.status,302);const target=new URL(response.headers.get('location')!);assert.equal(target.origin,new URL(redirect).origin);assert.equal(target.searchParams.get('error'),'access_denied');assert.deepEqual(await listPeopleMemoryCredentials(f.env.DB,owner),[]);
});

test('People OAuth code exchange opens the existing owner-scoped MCP and rejects code replay',async t=>{
 const f=await fixture(t),auth=await f.authorize();assert.ok(auth.tokens.access_token);assert.ok(auth.tokens.refresh_token);assert.equal(auth.tokens.token_type.toLowerCase(),'bearer');assert.ok(auth.tokens.expires_in<=3600);
 const response=await f.mcp(auth.tokens.access_token);assert.equal(response.status,200);const data=await f.result(response);assert.equal(data.result.tools.length,9);assert.ok(data.result.tools.some((tool:any)=>tool.name==='update_people_lens'));
 const lookup=await f.mcp(auth.tokens.access_token,'tools/call',{name:'lookup_relationship_memory',arguments:{email:'person@example.test'}});assert.equal(lookup.status,200);assert.equal((await f.result(lookup)).result.isError,undefined);assert.ok(f.calls.length);assert.ok(f.calls.every(actor=>actor===owner));
 assert.equal((await f.exchange(auth.input)).status,400);
 const rows=await listPeopleMemoryCredentials(f.env.DB,owner);assert.equal(rows.length,1);assert.match(rows[0].name,/OAuth/);assert.ok(!JSON.stringify(rows).includes(auth.tokens.access_token));assert.deepEqual(await listPeopleMemoryCredentials(f.env.DB,'other@example.test'),[]);
});

test('People OAuth PKCE and resource are enforced during token exchange',async t=>{
 const f=await fixture(t),client=await f.register(),consent=await f.begin(client),approved=await f.approve(consent),code=new URL(approved.headers.get('location')!).searchParams.get('code')!;
 const input={grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,code_verifier:'b'.repeat(64),resource};
 assert.equal((await f.exchange(input)).status,400);
 assert.equal((await f.exchange({...input,code_verifier:verifier,resource:'https://foreign.test/api/people-mcp'})).status,400);
});

test('People OAuth refresh downscoping removes write tools and cannot expand permissions',async t=>{
 const f=await fixture(t),auth=await f.authorize();
 const refreshed=await f.exchange({grant_type:'refresh_token',client_id:auth.client.client_id,refresh_token:auth.tokens.refresh_token,scope:'people:read',resource});assert.equal(refreshed.status,200,await refreshed.clone().text());const tokens=await refreshed.json() as any;
 const data=await f.result(await f.mcp(tokens.access_token));assert.equal(data.result.tools.length,6);assert.ok(!data.result.tools.some((tool:any)=>tool.name==='update_people_lens'));
 const expanded=await f.exchange({grant_type:'refresh_token',client_id:auth.client.client_id,refresh_token:tokens.refresh_token,scope:'people:read sources:manage',resource});assert.equal(expanded.status,400);
 const read=await f.authorize('people:read');assert.ok(!read.tokens.refresh_token);assert.equal((await f.result(await f.mcp(read.tokens.access_token))).result.tools.length,6);
});

test('People OAuth owner revocation blocks both existing access and refresh immediately',async t=>{
 const f=await fixture(t),auth=await f.authorize(),[grant]=await listPeopleMemoryCredentials(f.env.DB,owner);
 await assert.rejects(()=>revokePeopleMemoryCredential(f.env.DB,'other@example.test',grant.id),/not_found/);assert.equal((await f.mcp(auth.tokens.access_token)).status,200);
 await revokePeopleMemoryCredential(f.env.DB,owner,grant.id);assert.equal((await f.mcp(auth.tokens.access_token)).status,401);
 const refreshed=await f.exchange({grant_type:'refresh_token',client_id:auth.client.client_id,refresh_token:auth.tokens.refresh_token,resource});assert.equal(refreshed.status,400);assert.equal((await refreshed.json() as any).error,'invalid_grant');
});

test('People OAuth credentials never reach Google or website-only APIs; legacy People MCP remains usable',async t=>{
 const f=await fixture(t),auth=await f.authorize();let external=0;t.mock.method(globalThis,'fetch',async()=>{external++;throw Error('No external fetch permitted');});
 for(const path of ['/api/graph','/api/people/integrations','/api/accounts','/api/granola','/api/token'])assert.equal((await f.send(path,{headers:{authorization:'Bearer '+auth.tokens.access_token}})).status,401,path);
 assert.equal(external,0);
 const legacy=await createPeopleMemoryCredential(f.env.DB,owner,{name:'Legacy CLI',scopes:['people:read']});delete f.env.OAUTH_KV;
 assert.equal((await f.mcp(legacy.token)).status,200);assert.equal((await f.send('/api/people-agent/lookup?email=person%40example.test',{headers:{authorization:'Bearer '+legacy.token}})).status,200);
});

test('People OAuth simultaneous consent and code redemption each succeed only once',async t=>{
 const f=await fixture(t),client=await f.register(),consent=await f.begin(client);
 const approvals=await Promise.all([f.approve(consent),f.approve(consent)]);
 assert.equal(approvals.filter(response=>response.status===302).length,1);
 assert.equal((await listPeopleMemoryCredentials(f.env.DB,owner)).length,1);
 const code=new URL(approvals.find(response=>response.status===302)!.headers.get('location')!).searchParams.get('code')!;
 const input={grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:redirect,code_verifier:verifier,resource};
 const responses=await Promise.all([f.exchange(input),f.exchange(input)]);
 assert.equal(responses.filter(response=>response.status===200).length,1);
 assert.equal(responses.filter(response=>response.status===400).length,1);
});

test('People OAuth displayed expiry tracks the approved connection lifetime and protocol revocation',async t=>{
 const f=await fixture(t),auth=await f.authorize(),[grant]=await listPeopleMemoryCredentials(f.env.DB,owner);
 assert.ok(grant.expiresAt<=Date.now()+30*86400000);assert.ok(grant.expiresAt>Date.now()+29*86400000);
 const revoked=await f.exchange({client_id:auth.client.client_id,token:auth.tokens.refresh_token,token_type_hint:'refresh_token'});assert.equal(revoked.status,200);
 assert.equal((await f.mcp(auth.tokens.access_token)).status,401);
 assert.ok((await listPeopleMemoryCredentials(f.env.DB,owner)).find(row=>row.id===grant.id)!.revokedAt);
 const read=await f.authorize('people:read');const rows=await listPeopleMemoryCredentials(f.env.DB,owner),short=rows.find(row=>row.id!==grant.id)!;
 assert.ok(short.expiresAt<=Date.now()+3600000);assert.ok(short.expiresAt>Date.now()+3500000);assert.ok(!read.tokens.refresh_token);
});

test('People OAuth ignores fabricated and foreign-client revocations; access-only revocation preserves refresh',async t=>{
 const f=await fixture(t),auth=await f.authorize(),foreign=await f.register(),[grant]=await listPeopleMemoryCredentials(f.env.DB,owner);
 const fabricated=auth.tokens.refresh_token.replace(/[^:]+$/,'fabricated-secret');
 for(const input of [{client_id:auth.client.client_id,token:fabricated},{client_id:foreign.client_id,token:auth.tokens.refresh_token}]){
  const response=await f.exchange({...input,token_type_hint:'refresh_token'});assert.equal(response.status,200);
  assert.equal((await f.mcp(auth.tokens.access_token)).status,200);
  assert.equal((await listPeopleMemoryCredentials(f.env.DB,owner)).find(row=>row.id===grant.id)!.revokedAt,null);
 }
 const accessRevoked=await f.exchange({client_id:auth.client.client_id,token:auth.tokens.access_token,token_type_hint:'access_token'});assert.equal(accessRevoked.status,200);
 assert.equal((await f.mcp(auth.tokens.access_token)).status,401);assert.equal((await listPeopleMemoryCredentials(f.env.DB,owner)).find(row=>row.id===grant.id)!.revokedAt,null);
 const refreshed=await f.exchange({client_id:auth.client.client_id,grant_type:'refresh_token',refresh_token:auth.tokens.refresh_token,resource});assert.equal(refreshed.status,200);
 assert.equal((await f.mcp((await refreshed.json() as any).access_token)).status,200);
});
