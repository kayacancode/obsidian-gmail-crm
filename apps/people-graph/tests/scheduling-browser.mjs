import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../public/',import.meta.url));
const server=createServer(async(req,res)=>{const path=resolve(root,'.'+(new URL(req.url,'http://local').pathname==='/booking'?'/booking.html':new URL(req.url,'http://local').pathname));if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,failure;
try{
 browser=await chromium.launch({headless:true,timeout:30000,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],calls=[];page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
 const origin='http://127.0.0.1:'+server.address().port;
 const settings={owner:'owner@example.test',revision:1,slug:'owner',displayName:'Owner',intro:'Hello there',thesis:'Meet people building useful tools',timezone:'America/New_York',durationMinutes:30,bufferMinutes:10,minNoticeHours:24,horizonDays:28,reviewDelayDays:7,dailyLimit:4,weeklyLimit:12,weekdays:[1,2,3,4],startTime:'09:00',endTime:'17:00',vipEmails:[],enabled:true,autoBookPriority:false};
 let tokens=[],failLoad=false,emailConfigured=false,emailActivity=null,requests=[],refreshNeedsContext=false;
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():null;calls.push({path,body});const reply=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/booking')return reply({account:{email:settings.owner},settings,requests,readiness:{signIn:true,calendar:true,people:false,pilot:true,issues:[]},calendar:{email:settings.owner},lens:{focus:'Tools',needs:'',offers:''}});
  if(path==='/api/booking/scheduling/status'){if(failLoad){failLoad=false;return reply({error:'temporarily_unavailable'},503);}return reply({readiness:{emailConfigured,emailAddress:emailConfigured?'scheduling@agent.test':null,emailActivity,apiUrl:origin+'/api/scheduling',mcpUrl:origin+'/api/scheduling/mcp',tokenExpiresInDays:90,scopes:['scheduling:read','scheduling:write']}});}
  if(path==='/api/booking/scheduling/tokens'&&body){const credential={id:'key1',name:body.name,scopes:body.scopes,createdAt:Date.now(),expiresAt:Date.now()+90*86400000,revokedAt:null,lastUsedAt:null};tokens.push(credential);return reply({token:'pgs_fixture_secret_once',credential},201);}
  if(path==='/api/booking/scheduling/tokens')return reply({tokens});
  if(path==='/api/booking/scheduling/tokens/key1/revoke'){tokens=tokens.map(t=>({...t,revokedAt:Date.now()}));return reply({ok:true});}
  if(path==='/api/booking/scheduling/requests/scheduling-request/approve'){
   requests=requests.map(r=>({...r,scheduling:{...r.scheduling,approval:{policyRevision:1,approvedAt:Date.now()},offer:{revision:'approved-offer',slots:[{id:'one',start:'2026-11-02T15:00:00.000Z',end:'2026-11-02T15:30:00.000Z'}]}}}));
   return reply({requiresReview:false,offer:requests[0].scheduling.offer});
  }
  if(path==='/api/booking/scheduling/requests/scheduling-request/refresh')return reply({requiresReview:true,needsContext:refreshNeedsContext,offer:null});
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
 requests=[{id:'scheduling-request',name:'Counterpart',email:'peer@example.test',project:'',purpose:'Owner-authorized meeting.',status:'pending_approval',createdAt:Date.now(),slotStart:'2026-11-02T15:00:00.000Z',slotEnd:'2026-11-02T15:30:00.000Z',decision:{tier:'priority',policyRevision:1,reasons:['The purpose fits your saved thesis.']},scheduling:{assessmentVersion:1,settingsRevision:1,authority:{channel:'owner_api'},input:{context:'Catch up about the new project'},timezone:'America/New_York',recommendation:{summary:'The purpose fits your saved thesis.',reasons:['People score: 80 / 100.'],uncertainties:[]},offer:null}}];
 await page.getByRole('tab',{name:'Requests',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Times prepared',{exact:true}).waitFor();await page.getByText('Catch up about the new project',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0,'a prepared delegated request cannot bypass the exact offer selection flow');await page.getByText('Scheduling context',{exact:true}).click();await page.getByText('People score: 80 / 100.',{exact:true}).waitFor();
 requests[0].decision={tier:'review',policyRevision:1,reasons:['The meeting purpose needs more detail.'],uncertainties:['No specific project was described.'],fit:{evidence:[]}};
 requests[0].scheduling.authority.channel='owner_email';requests[0].scheduling.recommendation={summary:'Review before offering times.',reasons:['The meeting purpose needs more detail.'],uncertainties:['No specific project was described.']};
 await page.goto(origin+'/booking?request=scheduling-request');await page.getByText('Awaiting your review',{exact:true}).waitFor();
 await page.getByText('The meeting purpose needs more detail.',{exact:true}).first().waitFor();
 assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0);
 assert.equal(await page.locator('[data-request-id="scheduling-request"]').evaluate(node=>node===document.activeElement),true,'owner email link focuses the matching request');
 await page.getByRole('button',{name:'Reassess request',exact:true}).click();await page.getByText('Request reassessed. Your review is still needed.',{exact:true}).waitFor();
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.site-header').count(),1);assert.ok(await page.getByRole('heading',{name:'Counterpart',exact:true}).evaluate(node=>node.getBoundingClientRect().height)<60,'the counterpart name stays readable on mobile');assert.ok(await page.getByRole('button',{name:'Offer times anyway',exact:true}).evaluate(node=>node.getBoundingClientRect().height)<75,'the primary review action does not break into individual words');await page.locator('[data-request-id="scheduling-request"]').screenshot({path:'/tmp/people-meeting-review-mobile.png'});
 await page.getByRole('button',{name:'Offer times anyway',exact:true}).click();await page.getByText('Waiting for their choice',{exact:true}).waitFor();
 assert.deepEqual(calls.findLast(c=>c.path.endsWith('/approve')).body,{policyRevision:1});
 assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),0,'approved requests cannot trigger a second override from the UI');
 await page.getByText('Times are ready. The email conversation will continue with the available options.',{exact:true}).waitFor();
 // An approved email group can move its existing options into one shared thread.
 assert.equal(await page.getByRole('button',{name:'Continue in shared email',exact:true}).count(),0,'single guest requests do not show a group migration action');
 requests[0].scheduling.input.attendees=['peer@example.test','second@example.test'];
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Continue in shared email',exact:true}).waitFor();
 const callsBeforeShared=calls.filter(c=>c.path.endsWith('/approve')).length;
 await page.getByRole('button',{name:'Continue in shared email',exact:true}).click();await page.getByText('Times are ready. The email conversation will continue with the available options.',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/approve')).length,callsBeforeShared+1);
 assert.deepEqual(calls.findLast(c=>c.path.endsWith('/approve')).body,{policyRevision:1});
 assert.equal(calls.some(c=>c.path==='/api/booking/requests/scheduling-request/approve'),false,'continuing email cannot book on behalf of guests');
 delete requests[0].scheduling.input.attendees;
 // Missing context is a counterpart question, while model/source problems still require owner review.
 requests[0].decision={tier:'review',policyRevision:1,reasons:['The meeting purpose needs more detail.'],uncertainties:[],fit:{fit:'needs_context',evidence:[]},people:{status:'not_found',lastSync:new Date().toISOString()}};
 delete requests[0].scheduling.approval;requests[0].scheduling.offer=null;requests[0].slotStart=null;requests[0].slotEnd=null;
 requests[0].scheduling.input.context='Can we meet?';requests[0].scheduling.contextReplies=[{context:'Our project builds an interface for agent handoffs.',evidenceId:'peer-reply-1'}];
 requests[0].scheduling.recommendation={summary:'More meeting context is needed.',reasons:[],uncertainties:[]};
 await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Waiting for meeting context',{exact:true}).waitFor();
 assert.equal(await page.getByText('Awaiting your review',{exact:true}).count(),0);
 await page.getByText('Scheduling context',{exact:true}).click();
 await page.getByText('Original meeting context',{exact:true}).waitFor();await page.getByText('Our project builds an interface for agent handoffs.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('[data-request-id="scheduling-request"]').screenshot({path:'/tmp/people-meeting-context-mobile.png'});
 assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),1,'the owner can still explicitly override a context request');
 refreshNeedsContext=true;await page.getByRole('button',{name:'Reassess request',exact:true}).click();await page.getByText('Request reassessed. Waiting for more meeting context.',{exact:true}).waitFor();refreshNeedsContext=false;
 requests[0].scheduling.contextAssessmentPending='peer-reply-1';
 for(const tier of ['review','priority']){requests[0].decision.tier=tier;await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Awaiting your review',{exact:true}).waitFor();await page.getByText('Context received. Reassessment is pending; retry or review this request.',{exact:true}).waitFor();assert.equal(await page.getByText('Waiting for meeting context',{exact:true}).count(),0,'a saved reply awaiting reassessment must not ask for another reply');assert.equal(await page.getByRole('button',{name:'Reassess request',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),1);}
 delete requests[0].scheduling.contextAssessmentPending;requests[0].decision.tier='review';
 requests[0].decision.uncertainties=['People lookup is unavailable.'];await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Awaiting your review',{exact:true}).waitFor();assert.equal(await page.getByText('Waiting for meeting context',{exact:true}).count(),0);
 requests[0].decision.uncertainties=[];requests[0].decision.people.lastSync=new Date(Date.now()-2*86400000).toISOString();await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Awaiting your review',{exact:true}).waitFor();assert.equal(await page.getByText('Waiting for meeting context',{exact:true}).count(),0);
 for(const people of [{status:'unavailable',lastSync:new Date().toISOString()},{status:'matched',email:'wrong@example.test',lastSync:new Date().toISOString()}]){requests[0].decision.people=people;await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Awaiting your review',{exact:true}).waitFor();assert.equal(await page.getByText('Waiting for meeting context',{exact:true}).count(),0,'context requires a usable source for the fixed counterpart');}
 requests[0].decision.people={status:'not_found',lastSync:new Date().toISOString()};
 requests[0].decision.people.lastSync=new Date().toISOString();requests[0].scheduling.contextReplies.push({context:'Let us chat more about it.',evidenceId:'peer-reply-2'});await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/booking'),page.getByRole('button',{name:'Refresh',exact:true}).click()]);await page.locator('#owner-root[aria-busy="false"]').waitFor();await page.getByText('Awaiting your review',{exact:true}).waitFor();assert.equal(await page.getByText('Waiting for meeting context',{exact:true}).count(),0,'two context replies end automatic questions');
 // Historical requests must not present old delegation as a meeting judgment.
 requests[0].decision={tier:'review',policyRevision:1,reasons:['The owner explicitly authorized this scheduling request.'],fit:{model:'not_assessed',evidence:[]}};
 delete requests[0].scheduling.assessmentVersion;delete requests[0].scheduling.approval;
 requests[0].scheduling.recommendation={summary:'The owner authorized scheduling within their calendar rules.',reasons:[],uncertainties:[]};
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByText('This request predates meeting assessment. Reassess it before offering or confirming times.',{exact:true}).waitFor();
 assert.equal(await page.getByText('The owner explicitly authorized this scheduling request.',{exact:true}).count(),0);
 assert.equal(await page.getByText('The owner authorized scheduling within their calendar rules.',{exact:true}).count(),0);
 assert.equal(await page.getByText('Only you can see this assessment. No times have been offered for this decision.',{exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),0);
 assert.equal(await page.getByText('Prepared times',{exact:false}).count(),0);
 // Updating request state must use the server's policy without replacing a dirty settings form.
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();await page.getByLabel('Introduction',{exact:true}).fill('Keep edits while requests refresh');
 settings.revision=2;settings.intro='A newer saved introduction';
 requests[0].scheduling.assessmentVersion=1;
 await page.getByRole('tab',{name:'Requests',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByText('Your meeting rules changed after this assessment. Reassess this request before offering or confirming times.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),0,'a stale assessment cannot be approved against newer rules');
 requests[0].decision={tier:'review',policyRevision:2,reasons:['The current meeting purpose needs more detail.'],fit:{evidence:[]}};requests[0].scheduling.settingsRevision=2;
 await page.getByRole('button',{name:'Reassess request',exact:true}).click();await page.getByText('Request reassessed. Your review is still needed.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Offer times anyway',exact:true}).count(),1,'fresh request policy is compared to the refreshed server revision');
 await page.getByText('The current meeting purpose needs more detail.',{exact:true}).waitFor();assert.equal(await page.getByText('Your meeting rules changed after this assessment. Reassess this request before offering or confirming times.',{exact:true}).count(),0);
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();assert.equal(await page.getByLabel('Introduction',{exact:true}).inputValue(),'Keep edits while requests refresh');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 assert.equal(calls.findLast(c=>c.path==='/api/booking/settings').body.revision,1,'the unsaved form keeps its original revision for conflict detection');
 assert.deepEqual(errors,[]);console.log('Scheduling browser: setup, token creation/revocation, no storage leak, preserved settings, context evidence and review gates, legacy review, independent policy refresh, retry and 320px mobile passed.');
}catch(error){failure=error;}finally{if(browser)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);browser.close().catch(()=>{}).finally(()=>{clearTimeout(timer);resolve();});});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
if(failure)console.error(failure);process.exit(failure?1:0);
