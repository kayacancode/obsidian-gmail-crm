import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';

const INBOX='inbox@example.test',CONTACT='ada@example.test';
type Calls={life:number;work:number};
/** Fake Workers AI: answers the work-context schema with no facts and the life schema with `signals`. */
function ai(signals:unknown[],calls:Calls){
 return {run:async(_model:string,input:{response_format?:{json_schema?:{properties?:Record<string,unknown>}}})=>{
  const life=!!input.response_format?.json_schema?.properties?.signals;
  if(life){calls.life++;return {response:{signals}};}
  calls.work++;return {response:{facts:[]}};
 }} as unknown as Ai;
}
function gmailFull(id:string,text:string){
 return {id,threadId:'t-'+id,internalDate:String(Date.now()-60_000),payload:{mimeType:'text/plain',headers:[{name:'From',value:`Ada <${CONTACT}>`},{name:'To',value:INBOX},{name:'Date',value:new Date(Date.now()-60_000).toUTCString()},{name:'Message-ID',value:`<${id}@example.test>`}],body:{data:Buffer.from(text).toString('base64url')}}};
}
// Private DO internals are exercised directly; element access is the test seam.
type Internals={automaticMessageContext(a:unknown,id:string,access:string):Promise<void>;get(email:string):unknown;lifeFromGranola(input:{noteId:string;meetingAt:string;text:string;attendees:{email:string;name:string}[];contentHash?:string}):Promise<void>;granola():{disconnect():Promise<void>}};
const internals=(service:unknown)=>service as Internals;

async function mailRun(signalsOn:boolean,calls:Calls){
 const f=await fixture();
 if(signalsOn)await f.service.setLifeSignals(true);
 f.env.AI=ai([{start:1,end:1,anchor:1,category:'travel',summary:'Back from two weeks in Japan'}],calls);
 f.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(INBOX,'m1',CONTACT);
 const realFetch=globalThis.fetch;
 globalThis.fetch=(async()=>Response.json(gmailFull('m1','Hi Kaya. I just got back from two weeks in Japan. Let us catch up soon.'))) as typeof fetch;
 try{await internals(f.service).automaticMessageContext(internals(f.service).get(INBOX),'m1','token');}
 finally{globalThis.fetch=realFetch;}
 return f;
}

test('life hooks: opted-in mail stores a first-hand travel signal for the sender',async()=>{
 const calls={life:0,work:0},f=await mailRun(true,calls);
 const {signals}=await f.service.listLifeSignals(f.personId);
 assert.deepEqual(signals.map(s=>[s.category,s.source,s.summary]),[['travel','gmail','Back from two weeks in Japan']]);
 assert.equal(calls.life,1);
});

test('life hooks: with signals off, mail never reaches the life extractor',async()=>{
 const calls={life:0,work:0},f=await mailRun(false,calls);
 assert.equal(calls.life,0);
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});

test('life hooks: a processed message is not extracted twice',async()=>{
 const calls={life:0,work:0},f=await mailRun(true,calls);
 const realFetch=globalThis.fetch;
 globalThis.fetch=(async()=>Response.json(gmailFull('m1','Hi Kaya. I just got back from two weeks in Japan. Let us catch up soon.'))) as typeof fetch;
 try{await internals(f.service).automaticMessageContext(internals(f.service).get(INBOX),'m1','token');}
 finally{globalThis.fetch=realFetch;}
 assert.equal(calls.life,1);
});

test('life hooks: an owner note about a person becomes a sensitive signal',async()=>{
 const f=await fixture(),calls={life:0,work:0};
 await f.service.setLifeSignals(true);
 f.env.AI=ai([{start:0,end:0,anchor:0,category:'health',summary:'Father has been ill'}],calls);
 await f.service.captureRelationshipMemory({email:CONTACT,name:'Ada',text:'Her dad has been ill since the spring.',sourceKind:'text',sourceId:'agent:note-1'});
 const {signals}=await f.service.listLifeSignals(f.personId);
 assert.deepEqual(signals.map(s=>[s.category,s.tier,s.source]),[['health','sensitive','memory']]);
});

test('life hooks: a meeting note attributes a signal only to the attendee it names',async()=>{
 const f=await fixture(),calls={life:0,work:0};
 await f.service.setLifeSignals(true);
 f.env.AI=ai([{start:0,end:0,anchor:0,category:'moved',summary:'Moved to Lisbon'}],calls);
 await internals(f.service).lifeFromGranola({noteId:'n1',meetingAt:new Date(Date.now()-3_600_000).toISOString(),text:'Ada mentioned she moved to Lisbon in March.',attendees:[{email:CONTACT,name:'Ada Lovelace'},{email:'sam@example.test',name:'Sam Lee'}]});
 const {signals}=await f.service.listLifeSignals(f.personId);
 assert.deepEqual(signals.map(s=>[s.category,s.source]),[['moved','granola']]);
});

test('life hooks: turning Gmail context off deletes that inbox\'s life signals',async()=>{
 const f=await mailRun(true,{life:0,work:0});
 assert.equal((await f.service.listLifeSignals(f.personId)).signals.length,1);
 await f.service.setAutomaticContext(INBOX,false);
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});

test('life hooks: deleting a memory entry deletes the signals it produced',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 f.env.AI=ai([{start:0,end:0,anchor:0,category:'health',summary:'Father has been ill'}],{life:0,work:0});
 const captured=await f.service.captureRelationshipMemory({email:CONTACT,name:'Ada',text:'Her dad has been ill since the spring.',sourceKind:'text',sourceId:'agent:note-2'});
 const memory=await f.service.getRelationshipMemory(f.personId);
 await f.service.deleteRelationshipEntry({personId:f.personId,entryId:captured.entryId,revision:memory.revision});
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});

test('life hooks: disconnecting Granola deletes meeting-note signals',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 f.env.AI=ai([{start:0,end:0,anchor:0,category:'moved',summary:'Moved to Lisbon'}],{life:0,work:0});
 await internals(f.service).lifeFromGranola({noteId:'n1',meetingAt:new Date(Date.now()-3_600_000).toISOString(),text:'Ada mentioned she moved to Lisbon in March.',attendees:[{email:CONTACT,name:'Ada Lovelace'}]});
 assert.equal((await f.service.listLifeSignals(f.personId)).signals.length,1);
 await internals(f.service).granola().disconnect();
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});

test('life hooks: switching signals off during extraction stores nothing',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 f.env.AI={run:async()=>{await f.service.setLifeSignals(false);return {response:{signals:[{start:0,end:0,anchor:0,category:'health',summary:'Father has been ill'}]}};}} as unknown as Ai;
 await f.service.captureRelationshipMemory({email:CONTACT,name:'Ada',text:'Her dad has been ill since the spring.',sourceKind:'text',sourceId:'agent:note-3'});
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});

test('life hooks: revoking Gmail context during extraction stores nothing',async()=>{
 const f=await fixture();
 await f.service.setLifeSignals(true);
 f.env.AI={run:async(_model:string,input:{response_format?:{json_schema?:{properties?:Record<string,unknown>}}})=>{
  if(!input.response_format?.json_schema?.properties?.signals)return {response:{facts:[]}};
  await f.service.setAutomaticContext(INBOX,false);
  return {response:{signals:[{start:1,end:1,anchor:1,category:'travel',summary:'Back from Japan'}]}};
 }} as unknown as Ai;
 f.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(INBOX,'m1',CONTACT);
 const realFetch=globalThis.fetch;
 globalThis.fetch=(async()=>Response.json(gmailFull('m1','Hi Kaya. I just got back from two weeks in Japan. Let us catch up soon.'))) as typeof fetch;
 try{await internals(f.service).automaticMessageContext(internals(f.service).get(INBOX),'m1','token');}
 finally{globalThis.fetch=realFetch;}
 assert.deepEqual((await f.service.listLifeSignals(f.personId)).signals,[]);
});
