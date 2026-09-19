import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listGranolaNotes,getGranolaNote,getGranolaTranscript,GranolaClientError} from '../src/granola-client';

const KEY='grn_fictional_key_123456';
const NOTE='not_1234567890abcd';
async function withFetch<T>(fake:typeof fetch,run:()=>Promise<T>):Promise<T>{const o=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=o;}}

test('listGranolaNotes encodes date filters and omits folder when not given',async()=>{
 let url='';
 await withFetch((async(input:any)=>{url=String(input);return Response.json({notes:[],hasMore:false,cursor:null});}) as typeof fetch,async()=>{
  await listGranolaNotes(KEY,{createdAfter:'2026-06-01T00:00:00.000Z',updatedAfter:'2026-08-01T00:00:00.000Z'});
 });
 const u=new URL(url);
 assert.equal(u.origin+u.pathname,'https://public-api.granola.ai/v1/notes');
 assert.deepEqual([...u.searchParams],[['page_size','30'],['created_after','2026-06-01T00:00:00.000Z'],['updated_after','2026-08-01T00:00:00.000Z']]);
});

test('getGranolaNote normalises attendees, folders, dates and drops transcript fields',async()=>{
 const raw={id:NOTE,object:'note',title:'Pilot sync',owner:{name:'Me',email:'ME@example.test'},created_at:'2026-08-14T12:00:00Z',updated_at:'2026-08-15T12:00:00Z',web_url:'https://notes.granola.ai/d/abc',
  calendar_event:{event_title:'Pilot',invitees:[{email:'ada@example.test'}],organiser:'me@example.test',scheduled_start_time:'2026-08-14T11:00:00Z',scheduled_end_time:'2026-08-14T12:00:00Z'},
  attendees:[{name:'Ada Lovelace',email:'Ada@Example.test'},{name:null,email:'bob@example.test'},{name:'No Email',email:null}],
  folder_membership:[{id:'fol_1234567890abcd',object:'folder',name:'Pilot',parent_folder_id:null}],
  summary_text:'Ada asked for an intro.',summary_markdown:'## x',private_notes_text:'my note',private_notes_markdown:'my note',transcript:[{text:'SECRET'}]};
 const note=await withFetch((async()=>Response.json(raw)) as typeof fetch,()=>getGranolaNote(KEY,NOTE));
 assert.deepEqual(note,{id:NOTE,title:'Pilot sync',webUrl:'https://notes.granola.ai/d/abc',createdAt:'2026-08-14T12:00:00Z',updatedAt:'2026-08-15T12:00:00Z',meetingAt:'2026-08-14T11:00:00Z',dateBasis:'scheduled',ownerEmail:'me@example.test',folderIds:['fol_1234567890abcd'],attendees:[{email:'ada@example.test',name:'Ada Lovelace'},{email:'bob@example.test',name:'bob'}],summary:'Ada asked for an intro.',privateNotes:'my note'});
 assert.ok(!JSON.stringify(note).includes('SECRET'));
});

test('getGranolaNote falls back to created_at and rejects non-granola web urls',async()=>{
 const raw={id:NOTE,object:'note',title:null,created_at:'2026-08-14T12:00:00Z',updated_at:'2026-08-15T12:00:00Z',web_url:'http://evil.test/x',calendar_event:null,attendees:[],folder_membership:[],summary_text:null,private_notes_text:null};
 const note=await withFetch((async()=>Response.json(raw)) as typeof fetch,()=>getGranolaNote(KEY,NOTE));
 assert.equal(note.title,'Untitled meeting');assert.equal(note.webUrl,null);assert.equal(note.meetingAt,'2026-08-14T12:00:00Z');assert.equal(note.dateBasis,'created');assert.equal(note.summary,'');assert.equal(note.privateNotes,'');
});

test('getGranolaTranscript joins speaker lines and paginates',async()=>{
 let url='';
 const page=await withFetch((async(input:any)=>{url=String(input);return Response.json({transcript:[{speaker:{name:'Ada',source:'speaker',attribution:'them'},text:'Hello there.',start_time:'2026-08-14T11:00:00Z',end_time:'2026-08-14T11:00:05Z'},{speaker:{source:'microphone',attribution:'me'},text:'Hi.',start_time:'2026-08-14T11:00:05Z',end_time:'2026-08-14T11:00:06Z'}],hasMore:true,cursor:'c2'});}) as typeof fetch,()=>getGranolaTranscript(KEY,NOTE,'c1'));
 const u=new URL(url);
 assert.equal(u.pathname,`/v1/notes/${NOTE}/transcript`);assert.deepEqual([...u.searchParams],[['page_size','100'],['cursor','c1']]);
 assert.deepEqual(page,{text:'Ada: Hello there.\nme: Hi.',hasMore:true,cursor:'c2'});
});

test('note detail with a bad id shape fails closed',async()=>{
 await withFetch((async()=>Response.json({id:'nope',object:'note',title:'x',created_at:'2026-08-14T12:00:00Z',updated_at:'2026-08-15T12:00:00Z',attendees:[],folder_membership:[]})) as typeof fetch,async()=>{
  await assert.rejects(getGranolaNote(KEY,NOTE),(e:any)=>e instanceof GranolaClientError&&e.diagnostic==='note_shape');
 });
});
