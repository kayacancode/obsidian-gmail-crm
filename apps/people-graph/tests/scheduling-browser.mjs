import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../public/',import.meta.url));
const server=createServer(async(req,res)=>{const path=resolve(root,'.'+(req.url==='/booking'?'/booking.html':new URL(req.url,'http://local').pathname));if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,failure;
try{
 browser=await chromium.launch({headless:true,timeout:30000,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],calls=[];page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
 const origin='http://127.0.0.1:'+server.address().port;
 const settings={owner:'owner@example.test',revision:1,slug:'owner',displayName:'Owner',intro:'Hello there',thesis:'Meet people building useful tools',timezone:'America/New_York',durationMinutes:30,bufferMinutes:10,minNoticeHours:24,horizonDays:28,reviewDelayDays:7,dailyLimit:4,weeklyLimit:12,weekdays:[1,2,3,4],startTime:'09:00',endTime:'17:00',vipEmails:[],enabled:true,autoBookPriority:false};
 let tokens=[],failLoad=false,emailConfigured=false,emailActivity=null,requests=[];
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():null;calls.push({path,body});const reply=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/booking')return reply({account:{email:settings.owner},settings,requests,readiness:{signIn:true,calendar:true,people:false,pilot:true,issues:[]},calendar:{email:settings.owner},lens:{focus:'Tools',needs:'',offers:''}});
  if(path==='/api/booking/scheduling/status'){if(failLoad){failLoad=false;return reply({error:'temporarily_unavailable'},503);}return reply({readiness:{emailConfigured,emailAddress:emailConfigured?'scheduling@agent.test':null,emailActivity,apiUrl:origin+'/api/scheduling',mcpUrl:origin+'/api/scheduling/mcp',tokenExpiresInDays:90,scopes:['scheduling:read','scheduling:write']}});}
  if(path==='/api/booking/scheduling/tokens'&&body){const credential={id:'key1',name:body.name,scopes:body.scopes,createdAt:Date.now(),expiresAt:Date.now()+90*86400000,revokedAt:null,lastUsedAt:null};tokens.push(credential);return reply({token:'pgs_fixture_secret_once',credential},201);}
  if(path==='/api/booking/scheduling/tokens')return reply({tokens});
  if(path==='/api/booking/scheduling/tokens/key1/revoke'){tokens=tokens.map(t=>({...t,revokedAt:Date.now()}));return reply({ok:true});}
  return reply({error:'not_found'},404);
 });
 await page.goto(origin+'/booking');await page.getByRole('tab',{name:'Booking page',exact:true}).click();await page.getByLabel('Introduction',{exact:true}).fill('Keep this unsaved introduction');
 await page.getByRole('tab',{name:'Scheduling assistant',exact:true}).click();
 await page.getByText('Email inbox not connected yet',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save changes',exact:true}).isVisible(),false);
 assert.equal(await page.getByLabel('MCP server URL',{exact:true}).inputValue(),origin+'/api/scheduling/mcp');
 await page.getByText('Access tokens and connection setup',{exact:true}).click();
 await page.getByLabel('Connection name',{exact:true}).fill('My email assistant');
 await page.getByRole('button',{name:'Create access token',exact:true}).click();
 assert.deepEqual(calls.findLast(c=>c.path.endsWith('/tokens')&&c.body).body,{name:'My email assistant',scopes:['scheduling:read','scheduling:write']});
 assert.equal(await page.getByLabel('New access token',{exact:true}).inputValue(),'pgs_fixture_secret_once');
 assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('pgs_fixture_secret_once')),false);
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();assert.equal(await page.getByLabel('Introduction',{exact:true}).inputValue(),'Keep this unsaved introduction');
 await page.getByRole('tab',{name:'Scheduling assistant',exact:true}).click();
 await page.getByRole('button',{name:'Revoke My email assistant',exact:true}).click();
 await page.getByText('Revoked',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New access token',{exact:true}).count(),0,'revocation removes the displayed secret');
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'assistant controls fit narrow phones');
 await page.screenshot({path:'/tmp/people-scheduling-assistant-mobile.png',fullPage:true});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'/tmp/people-scheduling-assistant-desktop.png',fullPage:true});
 failLoad=true;await page.getByRole('button',{name:'Refresh assistant',exact:true}).click();await page.getByText('Could not load scheduling connections. Try again.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Refresh assistant',exact:true}).click();await page.getByText('Email inbox not connected yet',{exact:true}).waitFor();
 emailConfigured=true;emailActivity={pending:1,deliveryUnknown:2,needsAttention:1};await page.getByRole('button',{name:'Refresh assistant',exact:true}).click();await page.getByText('Your agent address',{exact:true}).waitFor();await page.getByText('Delivery is uncertain for 2 email messages.',{exact:false}).waitFor();await page.getByText('1 scheduling conversations need your attention.',{exact:false}).waitFor();
 requests=[{id:'scheduling-request',name:'Counterpart',email:'peer@example.test',project:'',purpose:'Owner-authorized meeting.',status:'pending_approval',createdAt:Date.now(),slotStart:'2026-11-02T15:00:00.000Z',slotEnd:'2026-11-02T15:30:00.000Z',scheduling:{authority:{channel:'owner_api'},input:{context:'Catch up about the new project'},timezone:'America/New_York',recommendation:{summary:'The owner authorized scheduling within their calendar rules.',reasons:['People score: 80 / 100.'],uncertainties:[]},offer:null}}];
 await page.getByRole('tab',{name:'Requests',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Times prepared',{exact:true}).waitFor();await page.getByText('Catch up about the new project',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0,'a prepared delegated request cannot bypass the exact offer selection flow');await page.getByText('Scheduling context',{exact:true}).click();await page.getByText('People score: 80 / 100.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('Scheduling browser: setup, token creation/revocation, no storage leak, preserved settings, retry and 320px mobile passed.');
}catch(error){failure=error;}finally{if(browser)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);browser.close().catch(()=>{}).finally(()=>{clearTimeout(timer);resolve();});});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
if(failure)console.error(failure);process.exit(failure?1:0);
