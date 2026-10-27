#!/usr/bin/env node
/**
 * Local-only product tour with fictional data. Run from anywhere:
 *   node apps/people-graph/scripts/readme-preview.mjs
 *   PORT=4319 node apps/people-graph/scripts/readme-preview.mjs
 * Routes: /, /?person=maya, /?workspace=studio, /booking?request=request-maya,
 * /book/alex (signed-in fictional visitor; Choose a time opens the calendar).
 * This serves the actual public UI. Mutations affect only process memory;
 * no accounts, providers, email delivery, or Calendar APIs are connected.
 */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {createReadmeFixtures} from './readme-fixtures.mjs';
const port=Number(process.env.PORT||4318);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT must be an integer between 1024 and 65535.');
const origin='http://127.0.0.1:'+port,root=fileURLToPath(new URL('../public/',import.meta.url)),f=createReadmeFixtures(origin);
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)throw Error('body_too_large');}return raw?JSON.parse(raw):{};}
const nextStep=r=>r.status==='booked'?'booked':r.slotStart||r.proposedTimes?'pending_approval':'select_slot';
function publicRecord(r){return {id:r.id,status:r.status,intakeKind:r.intakeKind||'returning',slotStart:r.slotStart??null,slotEnd:r.slotEnd??null,...(r.proposedTimes?{proposedTimes:r.proposedTimes,slotSource:'suggested'}:{})};}
async function api(req,res,u){
 const p=u.pathname,b=['POST','PUT','PATCH','DELETE'].includes(req.method)?await body(req):{};
 if(p==='/api/config')return json(res,{googleClientId:null});
 if(p==='/api/session')return json(res,{ok:true});
 if(p==='/api/accounts')return json(res,{account:f.owner,configured:true,accounts:[{email:f.owner,status:'connected',lastSync:f.now,processed:124,contextEnabled:true,calendarEnabled:true,calendarStatus:'ready',photoCount:12}]});
 if(p==='/api/graph')return json(res,{account:f.owner,graph:f.graph});
 if(p==='/api/workspaces')return json(res,{workspaces:[{id:'studio',name:'Common Ground',role:'owner'}]});
 if(p==='/api/workspaces/studio/graph')return json(res,{account:f.owner,graph:f.shared});
 if(p==='/api/workspaces/studio/members')return json(res,{members:f.members});
 if(p==='/api/lens'){
  if(b.action==='save')f.lens.fields={...f.lens.fields,...b.fields};
  if(b.action==='learning')f.lens.enabled=b.enabled;
  if(b.action==='granola')f.lens.granolaEnabled=b.enabled;
  if(b.action){f.lens.revision='lens-'+Date.now();f.lens.updatedAt=new Date().toISOString();}
  return json(res,f.lens);
 }
 if(p==='/api/lens/matches')return json(res,f.lensMatches);
 if(p.endsWith('/helpers'))return json(res,f.helperResult);
 if(p==='/api/people/memory'){
  const id=b.personId||u.searchParams.get('personId');
  if(req.method==='POST')f.memories.set(id,{...f.memories.get(id),...b,revision:'memory-'+Date.now(),updatedAt:Date.now()});
  return json(res,f.memories.get(id)||{personId:id,revision:null,text:'',entries:[],interests:[]});
 }
 if(p==='/api/people/memory/structure')return json(res,{company:'Fieldwork',building:'An agent workspace for customer research.',needs:'Research teams to test the workflow.',offers:'Research synthesis and product feedback.',interests:['Research workflows']});
 if(p==='/api/people/connection-origin')return json(res,b.personId==='maya'?{status:'found',origin:{introducerName:'Sam Rivera',observedAt:f.stamp(21),subject:'Alex, meet Maya',quote:'Alex, meet Maya. Maya is building a research workspace, and I thought you would enjoy comparing notes.',url:'https://mail.google.com/mail/u/0/#all/fictional-preview-introduction'}}:{status:'not_found',connection:{direction:'received',observedAt:f.stamp(2),subject:'Following up on our conversation',quote:'Enjoyed comparing notes. Let’s keep talking as the product develops.',url:'https://mail.google.com/mail/u/0/#all/fictional-preview-followup'}});
 if(p==='/api/relevance')return json(res,{version:1,lens:'my',calculatedAt:f.stamp(0),scoreVersion:'documentation-preview',themes:[],connectors:[],discoveries:[]});
 if(p.endsWith('/search')){
  const query=String(b.query||'').toLowerCase(),hits=f.nodes.filter(n=>(n.name+' '+n.description+' '+n.company).toLowerCase().includes(query)),results=hits.length?hits:f.nodes.slice(0,3);
  return json(res,{answer:'Maya and Jordan are working on exactly this question. Sam can help connect the work to research teams.',results:results.map(n=>({personId:n.id,name:n.name,reason:n.description})),matches:results.map(n=>({personId:n.id,name:n.name,reason:n.description})),personIds:results.map(n=>n.id),checked:true});
 }
 if(p==='/api/booking')return json(res,{account:{email:f.owner},settings:f.settings,requests:f.requests,readiness:{signIn:true,calendar:true,people:true,pilot:true,issues:[]},lens:f.lens.fields,calendar:{email:f.owner}});
 if(p==='/api/booking/settings'){Object.assign(f.settings,b,{revision:f.settings.revision+1});return json(res,{settings:f.settings});}
 if(p==='/api/booking/scheduling/status')return json(res,{readiness:{ready:true,emailConfigured:true,emailAddress:'scheduling@example.test',emailActivity:{pending:0,deliveryUnknown:0,needsAttention:0},apiUrl:origin+'/api/scheduling',mcpUrl:origin+'/api/scheduling-mcp',tokenExpiresInDays:30}});
 if(p==='/api/booking/scheduling/tokens')return json(res,{tokens:[]});
 const requestAction=/^\/api\/booking\/requests\/([^/]+)\/(approve|decline|cancel|email|request-times|approve-proposal)$/.exec(p);
 if(requestAction){const r=f.requests.find(r=>r.id===requestAction[1]);if(!r)return json(res,{error:'not_found'},404);r.status=({approve:'booked',decline:'declined',cancel:'cancelled','request-times':'needs_new_slot','approve-proposal':'booked'})[requestAction[2]]||r.status;return json(res,{request:r,ok:true});}
 const base='/api/public/booking/alex';
 if(p===base)return json(res,{page:{displayName:f.settings.displayName,intro:f.settings.intro,timezone:f.settings.timezone,durationMinutes:f.settings.durationMinutes},available:true,recoveryAvailable:true,visitor:{email:'sam@example.test',identityKey:'fictional-sam'},returningContact:{name:'Sam Rivera'}});
 if(p===base+'/slots')return json(res,{slots:f.slots});
 if(p===base+'/requests'){
  if(req.method==='GET')return json(res,{requests:[...f.publicRequests.values()].map(r=>({request:publicRecord(r),next:nextStep(r)}))});
  const prior=[...f.publicRequests.values()].find(r=>r.idempotencyKey===b.idempotencyKey);if(prior)return json(res,{request:publicRecord(prior),next:nextStep(prior)});
  const r={id:'preview-'+(f.publicRequests.size+1),status:'pending_approval',intakeKind:b.kind==='returning'?'returning':'standard',name:b.name||'Sam Rivera',idempotencyKey:b.idempotencyKey,slotStart:null,slotEnd:null};f.publicRequests.set(r.id,r);return json(res,{request:publicRecord(r),next:'select_slot'});
 }
 const visit=/^\/api\/public\/booking\/alex\/requests\/([^/]+)(?:\/(slot|proposals))?$/.exec(p);
 if(visit){const r=f.publicRequests.get(visit[1]);if(!r)return json(res,{error:'not_found'},404);if(visit[2]==='slot'){const slot=f.slots.find(s=>s.start===b.start);if(!slot)return json(res,{error:'slot_unavailable'},409);Object.assign(r,{slotStart:slot.start,slotEnd:slot.end,status:r.intakeKind==='returning'?'pending_approval':'booked'});}if(visit[2]==='proposals')r.proposedTimes={timezone:b.timezone,revision:'proposal-1',slots:(b.times||[]).map(t=>({start:new Date(t).toISOString(),end:new Date(+new Date(t)+1800000).toISOString()}))};return json(res,{request:publicRecord(r),next:nextStep(r)});}
 if(p==='/api/granola/status')return json(res,{connected:true,status:'connected',lastSync:f.now,noteCount:12,folders:[],identities:[]});
 if(p==='/api/people/integrations')return json(res,{tokens:[],apiUrl:origin+'/api/people-agent',mcpUrl:origin+'/api/people-mcp',scopes:['people:read','people:write']});
 if(p.endsWith('/introductions'))return json(res,{suggestions:[],checked:true});
 if(p.endsWith('/introduction-requests'))return json(res,{requests:[]});
 console.warn('Unimplemented preview API:',req.method,p);return json(res,{error:'preview_route_not_implemented'},404);
}
const server=createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,origin);
  // Prevent the actual UI's Google script from contacting a live provider.
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; form-action 'self'");
  if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  const route=u.pathname==='/'?'/index.html':u.pathname==='/booking'?'/booking.html':u.pathname.startsWith('/book/')?'/book.html':u.pathname==='/accounts'?'/accounts.html':u.pathname;
  const path=resolve(root,'.'+decodeURIComponent(route));if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}
  const contents=await readFile(path);res.writeHead(200,{'content-type':({'.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(path)]||'application/octet-stream','cache-control':'no-store'});res.end(contents);
 }catch(error){if(error.code==='ENOENT')res.writeHead(404).end();else{console.error(error);json(res,{error:'preview_failed'},500);}}
});
server.listen(port,'127.0.0.1',()=>console.log('Fictional People documentation preview: '+origin+'\nNetwork / · Person /?person=maya · Shared /?workspace=studio · Booking /booking?request=request-maya · Calendar /book/alex'));
