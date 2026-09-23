import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MailSync} from '../src/mail-sync';
import {requireGoogleUser} from '../src/index';
import {fetchPublicSource} from '../src/public-sources';
import {relevanceRoute} from '../src/relevance-routes';
import {RelevanceStore} from '../src/relevance-store';
import type {ThemeSignal} from '../src/relevance-model';

const NOW=Date.parse('2026-09-14T12:00:00.000Z');
const STAMP=new Date(NOW).toISOString();

function storage(owner='owner-a'){
 const db=new DatabaseSync(':memory:'),kv=new Map<string,unknown>([['owner',owner]]);
 const ctx={storage:{sql:{exec(sql:string,...args:unknown[]){
  if(sql.includes('CREATE TABLE')){db.exec(sql);return {toArray:()=>[]};}
  const statement=db.prepare(sql),rows=/^(?:SELECT|PRAGMA|EXPLAIN)/i.test(sql)?statement.all(...args):(statement.run(...args),[]);
  return {toArray:()=>rows};
 }},get:async(key:string)=>kv.get(key),put:async(key:string,value:unknown)=>{kv.set(key,value);},delete:async(key:string)=>kv.delete(key),setAlarm:async(value:number)=>{kv.set('alarm',value);},deleteAlarm:async()=>{kv.delete('alarm');},transactionSync<T>(fn:()=>T){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}}};
 return {db,kv,ctx};
}

function signal(visibility:'private'|'firm'|'public'):ThemeSignal{
 return {id:`signal-${visibility}`,owner:'owner-a',personId:`person-${visibility}`,themeId:`theme-${visibility}`,sourceType:'product_activity',visibility,observedAt:STAMP,ingestedAt:STAMP,confidence:1,summary:`${visibility} evidence`,evidenceRef:`activity:${visibility}`,contentHash:`hash-${visibility}`,extractorVersion:'fixture-v1'};
}

test('server lenses keep Firm exactly firm through scoring, evidence, and routes',async()=>{
 const {db,ctx}=storage(),store=new RelevanceStore(ctx as any,async()=>'owner-a');
 try{
  await store.ingest(['private','firm','public'].map(value=>signal(value as 'private'|'firm'|'public')));
  assert.deepEqual((await store.snapshot('my',NOW)).themes.map(theme=>theme.themeId).sort(),['theme-firm','theme-private','theme-public']);
  assert.deepEqual((await store.snapshot('firm',NOW)).themes.map(theme=>theme.themeId),['theme-firm']);
  assert.deepEqual((await store.snapshot('public',NOW)).themes.map(theme=>theme.themeId),['theme-public']);
  const stub={bindOwner:async()=>{},hasMailGraph:async()=>true,relevance:(lens:any)=>store.snapshot(lens,NOW),evidence:(themeId:string,lens:any)=>store.evidence(themeId,lens)};
  const env={MAIL:{getByName:()=>stub},GOOGLE_CLIENT_ID:'client',TOKEN_SECRET:'secret'} as any;
  const response=await relevanceRoute(new Request('https://people.test/api/relevance?lens=firm'),env,'owner-a');
  assert.deepEqual((await response.json() as any).themes.map((theme:any)=>theme.themeId),['theme-firm']);
  const evidence=await relevanceRoute(new Request('https://people.test/api/themes/theme-public/evidence?lens=firm'),env,'owner-a');
  assert.deepEqual(await evidence.json(),{theme:null,signals:[]});
 }finally{db.close();}
});

test('pushed connector scoring preserves real, co-occurrence, and interpretation edge classes',async()=>{
 const {db,ctx}=storage(),store=new RelevanceStore(ctx as any,async()=>'owner-a');
 const graph={nodes:['hub','real','shared','interpreted'].map(id=>({id,name:id})),edges:[
  {source:'hub',target:'real',weight:1,types:['worked_with']},
  {source:'hub',target:'shared',weight:4,types:['shared_email']},
  {source:'hub',target:'interpreted',kind:'interpretation',weight:2,types:['collaborated']},
 ],themes:[],themeSignals:[]};
 try{
  const attached=await store.attachPushedGraph(graph,'my',NOW),byId=new Map(attached.connectors.map(item=>[item.nodeId,item]));
  assert.equal(byId.get('real')?.evidenceClass,'documented');
  assert.equal(byId.get('shared')?.evidenceClass,'inferred');
  assert.equal(byId.get('interpreted')?.evidenceClass,'inferred');
  assert.equal(byId.get('hub')?.documentedDegree,1);
  assert.equal(byId.get('hub')?.inferredDegree,2);
  assert.deepEqual(attached.edges,graph.edges);
 }finally{db.close();}
});

test('metadata rebuild query uses the account and descending date index',()=>{
 const {db,ctx}=storage();
 try{
  new MailSync(ctx as any,{GOOGLE_CLIENT_ID:'client',TOKEN_SECRET:'secret'} as any);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT email,canonical,date,subject FROM contributions WHERE account=? AND date>=? ORDER BY date DESC LIMIT 5000').all('mail@example.test',0) as {detail:string}[];
  assert.match(plan.map(row=>row.detail).join('\n'),/contributions_account_date/);
 }finally{db.close();}
});

function publicTransport(body:string,contentType:string):typeof fetch{
 return (async(input:RequestInfo|URL)=>String(input).startsWith('https://cloudflare-dns.com/')
  ? Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]})
  : new Response(body,{headers:{'content-type':contentType}})) as typeof fetch;
}

test('public feeds reject unsupported and conflicting XML encoding declarations',async()=>{
 const supported='<?xml version="1.0" encoding="UTF-8"?><rss><channel><item><title>Agent memory</title></item></channel></rss>';
 assert.equal((await fetchPublicSource('https://example.com/feed.xml',publicTransport(supported,'application/rss+xml'))).text,'Agent memory');
 const unsupported=supported.replace('UTF-8','ISO-8859-1');
 await assert.rejects(fetchPublicSource('https://example.com/feed.xml',publicTransport(unsupported,'application/rss+xml')),{message:'public_content_type'});
 await assert.rejects(fetchPublicSource('https://example.com/feed.xml',publicTransport(supported,'application/rss+xml; charset=us-ascii')),{message:'public_content_type'});
 const duplicate=supported.replace('?>',' encoding=ISO-8859-1?>');
 const unknown=supported.replace('?>',' garbage?>');
 await assert.rejects(fetchPublicSource('https://example.com/feed.xml',publicTransport(duplicate,'application/rss+xml')),{message:'public_content_type'});
 await assert.rejects(fetchPublicSource('https://example.com/feed.xml',publicTransport(unknown,'application/rss+xml')),{message:'public_content_type'});
});

test('ignored foreign SVG permits its self-closing shapes without exposing hidden text',async()=>{
 const body='<html><body><svg><path d="M0 0"/></svg><p>Agent memory systems</p></body></html>';
 const result=await fetchPublicSource('https://example.com/docs',publicTransport(body,'text/html'));
 assert.equal(result.text,'Agent memory systems');
 const integration='<html><body><svg><foreignObject><template/></foreignObject></svg><p>HIDDEN CANARY</p></body></html>';
 await assert.rejects(fetchPublicSource('https://example.com/docs',publicTransport(integration,'text/html')),{message:'public_parse_failed'});
});

test('Google identity fetch has a deadline and bounds a dishonest streamed response',async()=>{
 const originalFetch=globalThis.fetch;let signal:AbortSignal|undefined,chunks=0;const totalChunks=100;
 globalThis.fetch=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  signal=init?.signal??undefined;
  const body=new ReadableStream<Uint8Array>({pull(controller){chunks++;controller.enqueue(new Uint8Array(8_192).fill(120));if(chunks===totalChunks)controller.close();}});
  return new Response(body,{headers:{'content-length':'1'}});
 }) as typeof fetch;
 try{
  const result=await requireGoogleUser(new Request('https://people.test/api/relevance',{headers:{authorization:'Bearer test-token'}}),{GOOGLE_CLIENT_ID:'client',TOKEN_SECRET:'secret'} as any);
  assert.deepEqual(result,{error:'invalid_token'});
  assert.ok(signal);
  assert.equal(chunks<totalChunks,true);
 }finally{globalThis.fetch=originalFetch;}
});
