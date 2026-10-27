import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../public/',import.meta.url));
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://local');
 const path=resolve(root,'.'+(url.pathname==='/booking'?'/booking.html':url.pathname.startsWith('/book/')?'/book.html':url.pathname));
 if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}
 try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,failure;
const origin='http://127.0.0.1:'+server.address().port;
try{
 browser=await chromium.launch({headless:true,timeout:30000,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],calls=[];
 const googleOwnerStub=`window.google={accounts:{id:{initialize(options){window.ownerSignIn=options.callback},renderButton(element){const button=document.createElement('button');button.textContent='Test owner Google sign in';button.onclick=()=>window.ownerSignIn({credential:'synthetic-owner-credential'});element.append(button)},disableAutoSelect(){}}}};`;
 await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:googleOwnerStub}));
 await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-10-23T16:00:00Z');});
 page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));
 let settings={owner:'kaya@example.test',revision:1,slug:'kaya',displayName:'Kaya Jones',intro:'A little context makes a better conversation.',thesis:'Applied AI for small teams',timezone:'America/New_York',durationMinutes:30,bufferMinutes:10,minNoticeHours:24,horizonDays:28,reviewDelayDays:7,dailyLimit:4,weeklyLimit:12,weekdays:[1,2,3,4,5],startTime:'09:00',endTime:'17:00',vipEmails:['sam@example.test'],enabled:false,autoBookPriority:false};
 const request={id:'r1',owner:settings.owner,email:'sam@example.test',name:'Sam Rivera',project:'An agent research studio',purpose:'Compare deployment lessons',projectUrl:'https://example.test',referrer:'Alex',createdAt:1792591200000,updatedAt:1792591200000,status:'pending_approval',slotStart:'2026-11-04T15:00:00Z',slotEnd:'2026-11-04T15:30:00Z',eventId:null,idempotencyKey:'r1',decision:{tier:'review',reasons:['Relevant applied research'],uncertainties:['Introduction is unverified'],policyRevision:1,fit:{fit:'possible',reasons:['Relevant applied research'],evidence:['Project: agent research studio'],model:'fixture'},people:{status:'matched',name:'Sam',email:'sam@example.test',reason:'Exact address match',lastSync:'2026-10-21T09:00:00Z'}}};
 let initialMainLens={focus:'',needs:'   ',offers:''},savedLens={revision:'r1',fields:{focus:'',needs:'   ',offers:''},suggestions:[{id:'unconfirmed',kind:'focus',text:'Never import this suggestion'}]},failLens=false;
 let proposedTimes=null,failProposal=false,expireProposal=false,closedProposal=false,staleProposal=false;
 let publicSlots=[{start:'2026-11-04T15:00:00Z',end:'2026-11-04T15:30:00Z'}];
 let ownerStatus=200,failSave=false,conflict=false,available=true,publicNext='select_slot',slotNext='pending_approval',failSlot=false,failSignIn=false,ready=false,saveCalls=0,slugConflict=false,visitorHistory=[],statusValue='pending_approval',failSubmit=false,recoveryAvailable=true,visitor=null,oauthRequestId=null,invalidSignInUrl=false,expireSubmit=false,signInReady=true,oauthIdentityKey='identity-visitor',oauthEmail='visitor@example.test',returningContact=null,requireIntake=false,publicIntakeKind='standard';
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='POST'?req.postDataJSON():null;
  calls.push({path,body});const reply=(value,status=200)=>route.fulfill({status,json:value});
  if(path==='/api/config')return reply({googleClientId:'fixture-client'});
  if(path==='/api/session'){assert.equal(req.method(),'POST');assert.equal(req.headers().authorization,'Bearer synthetic-owner-credential');ownerStatus=200;return reply({ok:true});}
  if(path==='/api/booking')return reply(ownerStatus===200?{account:{email:settings.owner},settings,requests:[request],readiness:{signIn:ready&&signInReady,calendar:ready,people:true,pilot:true,issues:ready?[]:['Connect a booking calendar.']},lens:initialMainLens,calendar:ready?{email:settings.owner}:null}:{error:'Sign in required'},ownerStatus);
  if(path==='/api/lens'){if(failLens){failLens=false;return reply({error:'temporarily_unavailable'},503);}return reply(savedLens);}
  if(path==='/api/booking/settings'){saveCalls++;if(slugConflict){slugConflict=false;return reply({error:'slug_taken'},409);}if(failSave){failSave=false;return reply({error:'Please try again'},503);}if(conflict){conflict=false;settings={...settings,revision:2,intro:'Changed elsewhere'};return reply({error:'settings_changed'},409);}settings={...body,revision:settings.revision+1};return reply({settings});}
  if(path==='/api/booking/calendar/connect')return reply({url:'https://accounts.google.com/o/oauth2/v2/auth?state=booking-fixture'});
  if(path==='/api/booking/requests/r1/approve-proposal'){if(staleProposal){staleProposal=false;return reply({error:'proposal_changed'},409);}request.status='booked';request.slotStart=body.start;request.slotEnd=request.proposedTimes.slots.find(slot=>slot.start===body.start).end;request.slotSource='suggested';return reply({request});}
  if(path==='/api/booking/requests/r1/request-times'){request.status='needs_new_slot';request.proposedTimes=null;request.slotStart=null;request.slotEnd=null;return reply({request});}
  if(path==='/api/booking/requests/r1/approve'){request.status='booked';return reply({request});}
  if(path==='/api/booking/requests/r1/cancel'){request.status='cancelled';return reply({request});}
  if(path==='/api/public/booking/kaya')return reply({page:{displayName:'Kaya Jones',intro:'A little context makes a better conversation.',timezone:settings.timezone,durationMinutes:30},available,recoveryAvailable,visitor,returningContact});
  if(path==='/api/public/booking/kaya/sign-in'){
   if(failSignIn){failSignIn=false;return reply({error:'sign_in_unavailable'},503);}
   oauthRequestId=body.requestId||null;
   return reply({url:invalidSignInUrl?'https://accounts.google.com.evil.test/sign-in':'https://accounts.google.com/o/oauth2/v2/auth?state=visitor-fixture'});
  }
  if(path.startsWith('/api/public/booking/kaya/')&&!visitor)return reply({error:'sign_in_required'},401);
  if(path==='/api/public/booking/kaya/requests'&&req.method()==='POST'&&expireSubmit){expireSubmit=false;visitor=null;return reply({error:'sign_in_required'},401);}
  if(path==='/api/public/booking/kaya/requests'&&req.method()==='GET')return reply({requests:visitorHistory});
  if(path==='/api/public/booking/kaya/requests'&&failSubmit){failSubmit=false;return reply({error:'booking_failed'},503);}
  if(path==='/api/public/booking/kaya/requests'&&requireIntake){requireIntake=false;return reply({error:'intake_required'},409);}
  if(path==='/api/public/booking/kaya/requests'){publicIntakeKind=body.kind==='returning'?'returning':'standard';return reply({request:{id:'visit-1',intakeKind:publicIntakeKind,status:publicNext==='async'?'async_submitted':'pending_approval',slotStart:null,slotEnd:null},next:publicNext});}
  if(path.endsWith('/slots'))return reply({slots:publicSlots});
  if(path.endsWith('/requests/visit-1/proposals')){if(closedProposal){closedProposal=false;proposedTimes=null;statusValue='booked';return reply({error:'request_closed'},409);}if(expireProposal){expireProposal=false;visitor=null;return reply({error:'sign_in_required'},401);}if(failProposal){failProposal=false;return reply({error:'ambiguous_proposal_time'},400);}proposedTimes={timezone:body.timezone,revision:'proposal-v1',slots:body.times.map(value=>({start:value+':00Z',end:value.slice(0,14)+'30:00Z'}))};return reply({request:{id:'visit-1',intakeKind:publicIntakeKind,status:'pending_approval',slotStart:null,slotEnd:null,proposedTimes,slotSource:'suggested'},next:'pending_approval'});}
  if(path.endsWith('/requests/visit-1/slot')){if(failSlot){failSlot=false;return reply({error:'That time is no longer available'},409);}return reply({request:{id:'visit-1',intakeKind:publicIntakeKind,status:slotNext,slotStart:body.start,slotEnd:'2026-11-04T15:30:00Z'},next:slotNext});}
  if(path.endsWith('/requests/visit-1')&&proposedTimes)return reply({request:{id:'visit-1',intakeKind:publicIntakeKind,status:statusValue,slotStart:null,slotEnd:null,proposedTimes,slotSource:'suggested'},next:'pending_approval'});
  if(path.endsWith('/requests/visit-1'))return reply({request:{id:'visit-1',intakeKind:publicIntakeKind,status:statusValue,slotStart:'2026-11-04T15:00:00Z',slotEnd:'2026-11-04T15:30:00Z'},next:'pending_approval'});
  return reply({error:'Unexpected API call'},404);
 });
 await page.goto(origin+'/booking?request=r1');
 const linkedRequest=page.locator('[data-request-id="r1"]');await linkedRequest.waitFor();
 assert.equal(await page.getByRole('tab',{name:'Requests',exact:true}).getAttribute('aria-selected'),'true','email review links open the request inbox');
 assert.equal(await linkedRequest.evaluate(card=>document.activeElement===card),true,'email review links focus the matching request');
 assert.equal(await linkedRequest.getByRole('button',{name:'Approve request',exact:true}).isVisible(),true);
 assert.equal(await linkedRequest.getByRole('button',{name:'Decline request',exact:true}).isVisible(),true);
 assert.match(await linkedRequest.innerText(),/An agent research studio/);assert.match(await linkedRequest.innerText(),/Compare deployment lessons/);
 assert.equal(calls.filter(call=>call.path.startsWith('/api/booking/requests/')).length,0,'opening a review link never changes a request');
 await page.goto(origin+'/booking');
 await page.getByRole('tab',{name:'Requests',exact:true}).focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.getByRole('tab',{name:'Booking page',exact:true}).getAttribute('aria-selected'),'true','arrow keys navigate owner tabs');
 assert.equal(await page.getByRole('checkbox',{name:'Accept booking requests'}).isDisabled(),true,'publishing waits for Google sign-in and calendar readiness');
 const intro=page.getByRole('textbox',{name:'Introduction',exact:true});await intro.fill('My edited introduction');
 failSave=true;await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Please try again'}).waitFor();
 assert.equal(await intro.inputValue(),'My edited introduction','failed save must retain owner edits');
 conflict=true;await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('button',{name:'Load latest settings',exact:true}).waitFor();
 assert.equal(await intro.inputValue(),'My edited introduction','revision conflict must not silently overwrite edits');
 await page.getByRole('button',{name:'Load latest settings',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Latest settings loaded'}).waitFor();
 assert.equal(await intro.inputValue(),'Changed elsewhere');
 await intro.fill('My unsaved introduction');
 await page.getByRole('tab',{name:'Rules',exact:true}).click();
 const lensButton=page.getByRole('button',{name:'Use my saved lens',exact:true}),thesis=page.getByRole('textbox',{name:'Meeting thesis',exact:true});
 const shortcut=page.getByRole('checkbox',{name:'Offer a shorter form to returning contacts',exact:true}),cutoff=page.getByRole('spinbutton',{name:'Returning contact score cutoff',exact:true});
 assert.equal(await shortcut.isChecked(),true,'legacy settings show the enabled returning shortcut default');
 assert.equal(await cutoff.inputValue(),'70','legacy settings show the default People score cutoff');
 await cutoff.fill('70.5');assert.equal(await cutoff.evaluate(input=>input.checkValidity()),false,'the shortcut cutoff accepts whole scores only');
 await cutoff.fill('101');assert.equal(await cutoff.evaluate(input=>input.checkValidity()),false,'scores above 100 cannot be saved');
 await cutoff.fill('0');assert.equal(await cutoff.evaluate(input=>input.checkValidity()),false,'scores below 1 cannot be saved');
 await cutoff.fill('75');await shortcut.uncheck();
 assert.match(await page.locator('#rules-panel').innerText(),/My Network/);
 assert.match(await page.locator('#rules-panel').innerText(),/returning requests.*approval|returning.*review/i,'the intake shortcut does not grant automatic booking');
 const emptyLensMessage='Your lens is empty. Add your focus in Network → Your lens, then use it here.';
 assert.equal(await lensButton.isEnabled(),true,'an empty initial lens must keep the explicit import action available');
 await page.getByRole('status').filter({hasText:emptyLensMessage}).waitFor();
 const lensEditor=page.getByRole('link',{name:'Edit lens in Network ↗',exact:true});
 assert.equal(await lensEditor.getAttribute('href'),'/');assert.equal(await lensEditor.getAttribute('target'),'_blank');assert.match(await lensEditor.getAttribute('rel'),/noopener/);
 await thesis.fill('My unsaved meeting thesis');
 await page.getByRole('spinbutton',{name:'Buffer (minutes)',exact:true}).fill('25');
 await page.getByRole('textbox',{name:'VIP email addresses',exact:true}).fill('draft@example.test');
 const formDraft=()=>page.locator('#owner-root form').evaluate(form=>[...form.querySelectorAll('input,textarea,select')].map(input=>({name:input.name,value:input.value,checked:input.checked})));
 const beforeEmptyLens=await formDraft(),lensReadsBefore=calls.filter(call=>call.path==='/api/lens').length;
 await lensButton.click();
 await page.waitForFunction(()=>document.querySelector('#owner-root').getAttribute('aria-busy')==='false');
 assert.equal(calls.filter(call=>call.path==='/api/lens').length,lensReadsBefore+1,'each explicit import reads the current owner lens');
 await page.getByRole('status').filter({hasText:emptyLensMessage}).waitFor();
 assert.deepEqual(await formDraft(),beforeEmptyLens,'an empty lens preserves every draft field');
 assert.equal(await lensButton.isEnabled(),true,'an empty lens can be retried after editing Network');
 assert.equal(saveCalls,2,'empty imports cannot save booking settings');
 await page.locator('#rules-panel .form-section').first().screenshot({path:'/tmp/people-booking-empty-lens.png'});
 savedLens={...savedLens,revision:'r2',fields:{focus:'  Practical agent interfaces  ',needs:'  Design partners ',offers:'Product feedback  '}};
 await lensButton.click();
 await page.getByRole('status').filter({hasText:'Your saved lens is ready to review'}).waitFor();
 assert.equal(await thesis.inputValue(),'Focused on: Practical agent interfaces\n\nLooking for: Design partners\n\nCan offer: Product feedback','imports fresh confirmed fields saved after the Booking page loaded');
 assert.doesNotMatch(await thesis.inputValue(),/Never import this suggestion/,'unconfirmed lens suggestions are not part of the thesis');
 assert.deepEqual((await formDraft()).filter(input=>input.name!=='thesis'),beforeEmptyLens.filter(input=>input.name!=='thesis'),'importing the lens preserves all other unsaved settings');
 assert.equal(saveCalls,2,'lens prefill requires an explicit save');
 await thesis.fill('Keep my revised draft');
 const beforeFailedLens=await formDraft();failLens=true;
 await lensButton.click();
 await page.getByRole('status').filter({hasText:'Your saved lens could not be loaded'}).waitFor();
 assert.deepEqual(await formDraft(),beforeFailedLens,'failed lens fetches preserve every draft field');
 assert.equal(await lensButton.isEnabled(),true,'failed lens fetches leave the import action retryable');
 assert.equal(saveCalls,2,'failed imports cannot save booking settings');
 savedLens={...savedLens,revision:'r3',fields:{focus:'  Practical agent interfaces  ',needs:' ',offers:' Updated product feedback '}};
 await lensButton.click();
 await page.getByRole('status').filter({hasText:'Your saved lens is ready to review'}).waitFor();
 assert.equal(await thesis.inputValue(),'Focused on: Practical agent interfaces\n\nCan offer: Updated product feedback','retry imports the newest saved lens and omits blank fields');
 assert.equal(saveCalls,2,'successful retries still require an explicit save');
 assert.equal(calls.filter(call=>call.path==='/api/lens'&&call.body).length,0,'importing never writes to the owner lens');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Saved'}).waitFor();
 const saved=calls.findLast(call=>call.path==='/api/booking/settings').body;
 assert.equal(saved.revision,2);assert.deepEqual(saved.weekdays,[1,2,3,4,5]);assert.equal(saved.autoBookPriority,false);assert.equal(saved.returningContactsEnabled,false);assert.equal(saved.returningScoreThreshold,75);
 await page.getByRole('tab',{name:'Requests',exact:true}).click();
 assert.match(await page.locator('#requests-panel').innerText(),/Introduction is unverified/);
 await page.getByRole('button',{name:'Approve request',exact:true}).click();
 await page.getByRole('button',{name:'Cancel booking',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0,'confirmed bookings must have cancellation, not approval');
 ready=true;await page.reload();await page.getByRole('tab',{name:'Booking page',exact:true}).click();
 assert.equal(await page.getByRole('checkbox',{name:'Accept booking requests'}).isDisabled(),false,'Google sign-in and calendar readiness enable publishing without email delivery');
 assert.match(await page.locator('.setup-list').innerText(),/Google sign-in.*Ready/);
 assert.doesNotMatch(await page.locator('.setup').innerText(),/Email delivery/i);
 signInReady=false;await page.reload();await page.getByRole('tab',{name:'Booking page',exact:true}).click();
 assert.equal(await page.getByRole('checkbox',{name:'Accept booking requests'}).isDisabled(),true,'sign-in must be ready even when a calendar is connected');
 signInReady=true;await page.reload();await page.getByRole('tab',{name:'Booking page',exact:true}).click();
 slugConflict=true;await page.getByRole('textbox',{name:'Booking link name',exact:true}).fill('taken-link');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByRole('status').filter({hasText:'already in use'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Booking link name',exact:true}).inputValue(),'taken-link');
 assert.equal(await page.getByRole('button',{name:'Load latest settings',exact:true}).isVisible(),false,'a taken slug is a validation error, not a revision conflict');
 initialMainLens=null;await page.reload();await page.getByRole('tab',{name:'Rules',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Your saved lens could not be loaded'}).waitFor();
 assert.equal(await lensButton.isEnabled(),true,'failed initial lens loading must leave fresh imports available');
 initialMainLens={...savedLens.fields};
 request.status='booking';await page.reload();await page.getByRole('button',{name:'Retry confirmation',exact:true}).waitFor();
 await page.getByRole('button',{name:'Retry confirmation',exact:true}).click();await page.getByRole('button',{name:'Cancel booking',exact:true}).waitFor();
 request.status='cancelling';await page.reload();await page.getByRole('button',{name:'Retry cancellation',exact:true}).waitFor();
 await page.getByRole('button',{name:'Retry cancellation',exact:true}).click();await page.locator('.status-pill').filter({hasText:'Cancelled'}).waitFor();
 assert.equal(calls.findLast(call=>call.path.startsWith('/api/booking/requests/')).path,'/api/booking/requests/r1/cancel','cancellation recovery retries cancel, never approve');
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'owner page fits mobile');
 await page.screenshot({path:'/tmp/people-booking-owner-mobile.png',fullPage:true});
 await page.getByRole('tab',{name:'Rules',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'returning contact Rules fit mobile');
 await page.getByRole('heading',{name:'A shorter hello for familiar people',exact:true}).locator('..').screenshot({path:'/tmp/people-booking-returning-rules-mobile.png'});
 await page.setViewportSize({width:1280,height:900});await page.getByRole('tab',{name:'Requests',exact:true}).click();
 await page.screenshot({path:'/tmp/people-booking-owner-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.route('https://accounts.google.com/**',route=>{
  if(new URL(route.request().url()).pathname==='/gsi/client')return route.fulfill({contentType:'text/javascript',body:googleOwnerStub});
  if(new URL(route.request().url()).searchParams.get('state')==='booking-fixture')return route.fulfill({contentType:'text/html',body:'<h1>Calendar permission</h1>'});
  visitor={email:oauthEmail,identityKey:oauthIdentityKey};const callback=new URL('/book/kaya?signed_in=1',origin);if(oauthRequestId)callback.searchParams.set('request',oauthRequestId);
  return route.fulfill({status:302,headers:{location:callback.href}});
 });
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();
 const disconnectCalls=calls.filter(call=>call.path==='/api/booking/calendar/disconnect').length;
 await page.getByRole('button',{name:'Reconnect Google Calendar',exact:true}).click();
 await page.getByRole('heading',{name:'Calendar permission',exact:true}).waitFor();
 assert.equal(new URL(page.url()).hostname,'accounts.google.com','connected calendars can request a renewed OAuth grant');
 assert.equal(calls.filter(call=>call.path==='/api/booking/calendar/connect').length,1);
 assert.equal(calls.filter(call=>call.path==='/api/booking/calendar/disconnect').length,disconnectCalls,'reconnecting must not disconnect the existing grant first');
 request.status='pending_approval';ownerStatus=401;await page.goto(origin+'/booking?request=r1');await page.getByRole('heading',{name:'Your booking space is private.',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Meeting thesis',exact:true}).count(),0,'unauthenticated visitors cannot see owner forms');
 assert.equal(await page.locator('[data-request-id="r1"]').count(),0,'an email review link still requires the owner session');
 assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Decline request',exact:true}).count(),0);
 const reviewLocation=page.url(),actionsBeforeOwnerSignIn=calls.filter(call=>call.path.startsWith('/api/booking/requests/')).length;
 await page.locator('#booking-signin').getByRole('button',{name:'Test owner Google sign in',exact:true}).click();
 await page.getByRole('button',{name:'Approve request',exact:true}).waitFor();
 assert.equal(page.url(),reviewLocation,'Google owner sign-in preserves the emailed review URL');
 assert.equal(await page.locator('[data-request-id="r1"]').evaluate(card=>document.activeElement===card),true,'successful owner sign-in focuses the emailed request');
 assert.equal(await page.getByRole('button',{name:'Decline request',exact:true}).isVisible(),true);
 assert.equal(calls.filter(call=>call.path.startsWith('/api/booking/requests/')).length,actionsBeforeOwnerSignIn,'sign-in itself does not approve or decline the linked request');
 async function signIn({fail=false,recover=false,paused=false,empty=false,returning=false}={}){
  visitor=null;await page.goto(origin+'/book/kaya');
  if(paused)await page.getByRole('button',{name:'View an existing request',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Email',exact:true}).count(),0,'Google sign-in needs no email-code form');
  failSignIn=fail;await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
  if(fail){await page.getByRole('status').filter({hasText:'Google sign-in is unavailable'}).waitFor();await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();}
  if(empty)await page.getByRole('heading',{name:'No requests found',exact:true}).waitFor();
  else if(recover)await page.getByRole('heading',{name:'Your conversations',exact:true}).waitFor();
  else if(returning)await page.getByRole('heading',{name:'Welcome back, Sam Rivera',exact:true}).waitFor();
  else await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('signed_in'),false,'handled OAuth flags are removed from the page URL');
 }
 visitor=null;await page.goto(origin+'/book/kaya?signed_in=1');await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 await page.screenshot({path:'/tmp/people-booking-google-signin-mobile.png',fullPage:true});
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).count(),0,'a callback query cannot grant a visitor session');
 await page.goto(origin+'/book/kaya?sign_in=failed');await page.getByRole('status').filter({hasText:'Google sign-in did not complete'}).waitFor();
 assert.equal(new URL(page.url()).searchParams.has('sign_in'),false,'failed callback flags are removed after displaying the error');
 invalidSignInUrl=true;await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Google sign-in could not be opened'}).waitFor();
 assert.equal(new URL(page.url()).origin,origin,'untrusted OAuth destinations must not navigate the visitor');invalidSignInUrl=false;
 await signIn({fail:true});
 assert.match(await page.locator('.verified-line').innerText(),/visitor@example.test/);
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Visitor');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('An agent workflow');
 await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).fill('How we evaluate useful interfaces');
 expireSubmit=true;await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
 await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Visitor','OAuth renewal must preserve the visitor draft');
 failSubmit=true;await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Your details are still here'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Visitor');
 await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.locator('.calendar-time').waitFor();
 assert.doesNotMatch(await page.locator('main').innerText(),/priority|thesis|unverified|Relevant applied research|tier/i,'public UI never reveals private evaluation details');
 failSlot=true;await page.locator('.calendar-time').click();
 await page.getByRole('status').filter({hasText:'no longer available'}).waitFor();
 assert.equal(await page.locator('.calendar-time').count(),1,'slot errors retain the selection flow');
 await page.locator('.calendar-time').click();
 await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
 assert.match(await page.locator('main').innerText(),/not confirmed/i,'pending approval is not presented as a reservation');
 const submitted=calls.find(call=>call.path==='/api/public/booking/kaya/requests'&&call.body).body;
 assert.equal(submitted.name,'Visitor');assert.ok(submitted.idempotencyKey);
 const retryBodies=calls.filter(call=>call.path==='/api/public/booking/kaya/requests'&&call.body).map(call=>call.body);
 assert.equal(retryBodies[0].idempotencyKey,retryBodies[1].idempotencyKey,'OAuth renewal retains the original request key');
 assert.equal(retryBodies[1].idempotencyKey,retryBodies[2].idempotencyKey,'retry reuses request key after a lost response');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'public page fits mobile');
 await page.screenshot({path:'/tmp/people-booking-public-mobile.png',fullPage:true});
 publicNext='async';await signIn();
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('New visitor');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('A design studio');
 await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).fill('Share a short update');
 await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.getByRole('heading',{name:'Thanks for the update',exact:true}).waitFor();
 assert.equal(await page.locator('.calendar-time').count(),0);
 publicNext='select_slot';slotNext='booking';await signIn();
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Another visitor');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('A new agent interface');
 await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).fill('Useful deployment lessons');
 await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.locator('.calendar-time').click();
 await page.getByRole('heading',{name:'Confirming your time',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'You’re booked',exact:true}).count(),0,'uncertain calendar writes cannot appear confirmed');
 statusValue='booked';await page.getByRole('button',{name:'Check request status',exact:true}).click();
 await page.getByRole('heading',{name:'You’re booked',exact:true}).waitFor();
 visitorHistory=[{request:{id:'visit-1',status:'needs_new_slot',slotStart:null,slotEnd:null},next:'select_slot'}];
 await signIn({recover:true});await page.getByRole('button',{name:'View request',exact:true}).click();
 await page.getByRole('heading',{name:'Let’s find another time',exact:true}).waitFor();
 await page.locator('.calendar-time').waitFor();
 statusValue='cancelling';await page.goto(origin+'/book/kaya?request=visit-1');
 await page.getByRole('heading',{name:'Cancelling your booking',exact:true}).waitFor();
 assert.match(await page.locator('main').innerText(),/not confirmed yet/i,'uncertain cancellations must not appear complete');
 assert.equal(await page.getByRole('heading',{name:'Booking cancelled',exact:true}).count(),0);
 statusValue='cancelled';await page.getByRole('heading',{name:'Booking cancelled',exact:true}).waitFor({timeout:12000});
 statusValue='booked';available=false;visitor=null;await page.goto(origin+'/book/kaya');await page.getByRole('heading',{name:'Booking is paused',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Email',exact:true}).count(),0);
 visitor={email:'visitor@example.test',identityKey:oauthIdentityKey};await page.goto(origin+'/book/kaya?request=visit-1');await page.getByRole('heading',{name:'You’re booked',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Start a new request',exact:true}).count(),0,'paused pages recover valid existing sessions without offering new intake');
 const slotsBeforePausedRecovery=calls.filter(call=>call.path.endsWith('/slots')).length;
 await signIn({paused:true,recover:true});await page.getByRole('button',{name:'View request',exact:true}).click();
 await page.getByRole('heading',{name:'Another time is needed',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Choose another time',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Start a new request',exact:true}).count(),0);
 assert.equal(calls.filter(call=>call.path.endsWith('/slots')).length,slotsBeforePausedRecovery,'paused recovery does not request new slots');
 visitorHistory=[];await signIn({paused:true,empty:true});
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).count(),0,'no history while paused cannot fall through to intake');
 recoveryAvailable=false;visitor=null;await page.goto(origin+'/book/kaya');await page.getByRole('heading',{name:'Booking is paused',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'View an existing request',exact:true}).count(),0,'recovery sign-in is offered only when available');
 visitor={email:'visitor@example.test',identityKey:oauthIdentityKey};await page.goto(origin+'/book/kaya?request=visit-1');await page.getByRole('heading',{name:'You’re booked',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Start a new request',exact:true}).count(),0,'existing sessions can still read status when fresh sign-in is unavailable');
 available=true;recoveryAvailable=true;visitor=null;statusValue='pending_approval';
 await page.goto(origin+'/book/kaya?request=visit-1');await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
 await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
 assert.equal(calls.findLast(call=>call.path.endsWith('/sign-in')).body.requestId,'visit-1','OAuth must preserve an existing request for recovery');
 assert.match(await page.locator('main').innerText(),/return to this page|check.*here/i,'pending requests direct visitors to their status page');
 assert.equal(calls.some(call=>/\/(challenge|verify)$/.test(call.path)),false,'Google sign-in must never call email-code endpoints');
 visitorHistory=[];await signIn();
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Old request draft');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('A project already submitted');
 await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).fill('An earlier meeting request');
 expireSubmit=true;await page.getByRole('button',{name:'Send request',exact:true}).click();await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 visitorHistory=[{request:{id:'visit-2',status:'pending_approval',slotStart:null,slotEnd:null},next:'select_slot'}];
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.getByRole('heading',{name:'Your conversations',exact:true}).waitFor();
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'','starting a new request after history recovery discards the old draft');
 visitorHistory=[];await signIn();
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Private draft');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('Private project details');
 await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).fill('Private meeting context');
 expireSubmit=true;await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();oauthIdentityKey='identity-other';
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'','the same email with a different Google identity must not restore another account’s draft');
 assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('people-booking-oauth-draft:')).length),0,'OAuth draft storage is cleared after callback handling');
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Discard on account change');
 await Promise.all([page.waitForEvent('domcontentloaded'),page.getByRole('button',{name:'Use another Google account',exact:true}).click()]);await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'','an explicit account change discards the unfinished draft');
 await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Discard even when OAuth fails');failSignIn=true;
 await page.getByRole('button',{name:'Use another Google account',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Google sign-in is unavailable'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).count(),0,'a failed account switch must not leave the previous account’s draft on screen');
 assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('people-booking-oauth-draft:')).length),0,'a failed sign-in start must not persist a draft');


 // Returning contacts use only the authenticated metadata and explicitly submit an optional note.
 returningContact={name:'Sam Rivera'};visitor=null;oauthIdentityKey='identity-visitor';slotNext='pending_approval';publicNext='select_slot';statusValue='pending_approval';visitorHistory=[];
 await page.goto(origin+'/book/kaya?signed_in=1');await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Welcome back, Sam Rivera',exact:true}).count(),0,'recognition is hidden until a visitor is authenticated');
 const submissions=()=>calls.filter(call=>call.path==='/api/public/booking/kaya/requests'&&call.body);
 const beforeWelcome=submissions().length;
 await signIn({returning:true});
 const catchup=page.getByRole('textbox',{name:'Anything you’d like to catch up on? (optional)',exact:true});
 assert.equal(submissions().length,beforeWelcome,'recognition must never submit automatically');
 assert.match(await page.locator('.verified-line').innerText(),/visitor@example.test/);
 assert.equal(await catchup.getAttribute('maxlength'),'2000');
 assert.equal(await catchup.getAttribute('required'),null);
 assert.equal(await page.getByRole('textbox',{name:'What are you building?',exact:true}).count(),0);
 assert.doesNotMatch(await page.locator('#booking-card').innerText(),/company|score|threshold|thesis|priority/i,'returning visitors see no inferred employer or private evaluation');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the returning form fits mobile');
 await page.screenshot({path:'/tmp/people-booking-returning-mobile.png',fullPage:true});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'/tmp/people-booking-returning-desktop.png',fullPage:true});
 await catchup.fill('A quick update on our work');
 await page.getByRole('button',{name:'Share more context',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Sam Rivera');
 assert.equal(await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).inputValue(),'A quick update on our work');
 assert.equal(await page.getByRole('textbox',{name:'What are you building?',exact:true}).inputValue(),'','recognition does not invent project or employer context');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('Our new interface project');
 expireSubmit=true;await page.getByRole('button',{name:'Send request',exact:true}).click();
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
 await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'What are you building?',exact:true}).inputValue(),'Our new interface project','a standard draft stays standard even while the contact qualifies');
 assert.equal(await catchup.count(),0);
 // Empty notes are valid and selecting a time still requires owner confirmation.
 await signIn({returning:true});await page.getByRole('button',{name:'Choose a time',exact:true}).click();
 await page.locator('.calendar-time').waitFor();
 assert.deepEqual(Object.keys(submissions().at(-1).body).sort(),['idempotencyKey','kind','note']);
 assert.equal(submissions().at(-1).body.kind,'returning');assert.equal(submissions().at(-1).body.note,'');
 assert.match(await page.locator('#booking-card').innerText(),/host.*confirmation/,'returning slot selection explains owner confirmation');
 await page.locator('.calendar-time').click();await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
 assert.match(await page.locator('#booking-card').innerText(),/not confirmed|host.*confirm/);
 // OAuth renewal and retries retain the returning note and request key.
 await signIn({returning:true});await catchup.fill('  Comparing notes after our last chat  ');
 const returningStart=submissions().length;expireSubmit=true;
 await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
 await catchup.waitFor();assert.equal(await catchup.inputValue(),'  Comparing notes after our last chat  ');
 failSubmit=true;await page.getByRole('button',{name:'Choose a time',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Your details are still here'}).waitFor();
 assert.equal(await catchup.inputValue(),'  Comparing notes after our last chat  ');
 await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.locator('.calendar-time').waitFor();
 const returningAttempts=submissions().slice(returningStart).map(call=>call.body);
 assert.equal(returningAttempts.length,3);assert.equal(new Set(returningAttempts.map(body=>body.idempotencyKey)).size,1,'returning renewal and retries use one request key');
 assert.equal(returningAttempts[2].note,'Comparing notes after our last chat');
 // A stale eligibility response switches to complete intake without losing entered context.
 await signIn({returning:true});await catchup.fill('Keep this catch-up note');requireIntake=true;
 await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 const staleKey=submissions().at(-1).body.idempotencyKey;
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Sam Rivera');
 assert.equal(await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).inputValue(),'Keep this catch-up note');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('A new research project');
 await page.getByRole('button',{name:'Send request',exact:true}).click();await page.locator('.calendar-time').waitFor();
 assert.equal(submissions().at(-1).body.idempotencyKey,staleKey,'eligibility fallback retains the original request key');
 assert.equal(submissions().at(-1).body.name,'Sam Rivera');assert.equal(submissions().at(-1).body.purpose,'Keep this catch-up note');
 assert.notEqual(submissions().at(-1).body.kind,'returning');
 // A returning draft becomes full intake if eligibility expires during Google renewal.
 await signIn({returning:true});await catchup.fill('Keep this note through renewal');expireSubmit=true;
 await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 const renewalKey=submissions().at(-1).body.idempotencyKey;returningContact=null;
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Sam Rivera');
 assert.equal(await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).inputValue(),'Keep this note through renewal');
 await page.getByRole('textbox',{name:'What are you building?',exact:true}).fill('A useful new research tool');
 await page.getByRole('button',{name:'Send request',exact:true}).click();await page.locator('.calendar-time').waitFor();
 assert.equal(submissions().at(-1).body.idempotencyKey,renewalKey);
 // Request recovery always takes precedence over recognition, including paused pages.
 returningContact={name:'Sam Rivera'};visitorHistory=[{request:{id:'visit-1',intakeKind:'returning',status:'pending_approval',slotStart:null,slotEnd:null},next:'select_slot'}];
 await signIn({recover:true});assert.equal(await catchup.count(),0);
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();await catchup.waitFor();assert.equal(await catchup.inputValue(),'');
 await page.goto(origin+'/book/kaya?request=visit-1');await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();assert.equal(await catchup.count(),0);
 available=false;await signIn({paused:true,recover:true});assert.equal(await catchup.count(),0);assert.equal(await page.getByRole('button',{name:'Start a new request',exact:true}).count(),0);
 visitorHistory=[];await signIn({paused:true,empty:true});assert.equal(await catchup.count(),0);available=true;
 // Draft identity, email and lifetime are all required, even for recognized contacts.
 await signIn({returning:true});
 const seedReturningDraft=async overrides=>page.evaluate(overrides=>sessionStorage.setItem('people-booking-oauth-draft:kaya',JSON.stringify({kind:'returning',email:'visitor@example.test',identityKey:'identity-visitor',values:{name:'Private prior name',note:'Private prior catch-up'},idempotencyKey:'private-draft-request-key',createdAt:Date.now(),...overrides})),overrides);
 for(const overrides of [{identityKey:'identity-other'},{email:'other@example.test'},{createdAt:Date.now()-3600001},{createdAt:Date.now()+60000}]){
  await seedReturningDraft(overrides);await page.reload();await catchup.waitFor();assert.equal(await catchup.inputValue(),'','invalid returning drafts cannot restore private context');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('people-booking-oauth-draft:kaya')),null);
 }
 await catchup.fill('Private returning context');expireSubmit=true;await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 oauthEmail='another@example.test';returningContact=null;
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'');assert.equal(await page.getByRole('textbox',{name:'What would you like to discuss?',exact:true}).inputValue(),'','a changed authenticated email must discard a returning draft');
 oauthEmail='visitor@example.test';returningContact={name:'Sam Rivera'};await signIn({returning:true});await catchup.fill('Discard on account switch');failSignIn=true;
 await page.getByRole('button',{name:'Use another Google account',exact:true}).click();await page.getByRole('status').filter({hasText:'Google sign-in is unavailable'}).waitFor();
 assert.equal(await catchup.count(),0);assert.equal(await page.getByRole('heading',{name:'Welcome back, Sam Rivera',exact:true}).count(),0,'an account switch immediately removes previous recognition');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('people-booking-oauth-draft:kaya')),null);
 returningContact=null;

 // Month calendar: only the chosen day's times, exact timestamps and no implied reservation.
 publicSlots=[
  {start:'2026-10-29T15:00:00Z',end:'2026-10-29T15:30:00Z'},
  {start:'2026-10-29T15:15:00Z',end:'2026-10-29T15:45:00Z'},
  {start:'2026-10-31T23:30:00Z',end:'2026-11-01T00:00:00Z'},
  {start:'2026-11-01T05:30:00Z',end:'2026-11-01T06:00:00Z'},
  {start:'2026-11-01T06:30:00Z',end:'2026-11-01T07:00:00Z'},
  {start:'2026-11-02T14:00:00Z',end:'2026-11-02T14:30:00Z'},
  {start:'2026-11-02T14:15:00Z',end:'2026-11-02T14:45:00Z'},
  {start:'2026-11-02T15:00:00Z',end:'2026-11-02T15:30:00Z'},
  {start:'2026-11-02T16:00:00Z',end:'2026-11-02T16:30:00Z'},
  {start:'2026-12-01T14:00:00Z',end:'2026-12-01T14:30:00Z'}];
 visitorHistory=[];publicNext='select_slot';slotNext='pending_approval';returningContact={name:'Sam Rivera'};
 await page.setViewportSize({width:1280,height:900});await signIn({returning:true});
 await page.getByRole('button',{name:'Choose a time',exact:true}).click();await page.locator('.booking-calendar').waitFor();
 await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('America/New_York');
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-10');
 assert.equal(await page.locator('.calendar-time').count(),2,'show only the first available day’s times');
 assert.equal(await page.locator('[data-date="2026-10-29"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('[data-date="2026-10-28"]').isDisabled(),true,'unavailable dates cannot be selected');
 assert.equal(await page.getByRole('button',{name:'Previous month',exact:true}).isDisabled(),true);
 const slotPosts=()=>calls.filter(call=>/\/requests\/[^/]+\/slot$/.test(call.path));
 const beforeCalendar=slotPosts().length;
 await page.locator('[data-date="2026-10-31"]').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('.calendar-time').count(),1);
 assert.equal(await page.locator('[data-date="2026-10-31"]').getAttribute('aria-pressed'),'true','keyboard selects a date');
 await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('Asia/Tokyo');
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-11','timezone changes move the selected instant into the correct month');
 assert.equal(await page.locator('[data-date="2026-11-01"]').getAttribute('aria-pressed'),'true');
 await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('America/New_York');
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-10');
 await page.getByRole('button',{name:'Next month',exact:true}).click();
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-11');
 const repeatedTimes=await page.locator('.calendar-time').allTextContents();assert.equal(repeatedTimes.length,2);assert.notEqual(repeatedTimes[0],repeatedTimes[1],'DST repeated local times remain distinguishable');
 assert.equal(slotPosts().length,beforeCalendar,'date, timezone and month navigation never reserve a time');
 await page.locator('[data-date="2026-11-02"]').click();
 publicSlots=publicSlots.filter(slot=>slot.start!=='2026-11-02T14:00:00Z');
 await page.getByRole('button',{name:'Refresh available times',exact:true}).click();await page.locator('.booking-calendar').waitFor();
 assert.equal(await page.locator('[data-date="2026-11-02"]').getAttribute('aria-pressed'),'true','refresh keeps the selected date even if its first slot was taken');
 assert.equal(await page.locator('.calendar-time').first().getAttribute('data-start'),'2026-11-02T14:15:00Z');
 await page.screenshot({path:'/tmp/people-booking-month-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/people-booking-month-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'calendar fits mobile width');
 await page.setViewportSize({width:320,height:740});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'calendar fits a narrow phone');
 await page.getByRole('button',{name:'Next month',exact:true}).click();
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-12');
 assert.equal(await page.getByRole('button',{name:'Next month',exact:true}).isDisabled(),true);
 failSlot=true;await page.locator('.calendar-time').click();await page.getByRole('status').filter({hasText:'no longer available'}).waitFor();
 assert.equal(await page.locator('.calendar-time').count(),1,'slot conflicts preserve the calendar');
 assert.equal(await page.getByRole('button',{name:'Next month',exact:true}).isDisabled(),true,'busy-state recovery preserves disabled navigation');
 assert.equal(await page.locator('[data-date="2026-12-02"]').isDisabled(),true);
 await page.locator('.calendar-time').click();await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
 assert.equal(slotPosts().at(-1).body.start,'2026-12-01T14:00:00Z','send the exact supplied instant without timezone conversion');
 publicSlots=[];await signIn({returning:true});await page.getByRole('button',{name:'Choose a time',exact:true}).click();
 await page.getByRole('heading',{name:'No open times just now',exact:true}).waitFor();assert.equal(await page.locator('.calendar-time').count(),0);
 publicSlots=[{start:'2026-10-29T15:00:00Z',end:'2026-10-29T15:30:00Z'},{start:'2026-12-01T14:00:00Z',end:'2026-12-01T14:30:00Z'}];
 await page.getByRole('button',{name:'Check availability',exact:true}).click();await page.locator('.booking-calendar').waitFor();
 await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('America/New_York');
 await page.getByRole('button',{name:'Next month',exact:true}).click();
 assert.equal(await page.locator('.booking-calendar').getAttribute('data-month'),'2026-11');assert.equal(await page.locator('.calendar-time').count(),0,'an empty intermediate month has no selectable times');
 assert.match(await page.locator('.booking-calendar').innerText(),/no.*available|no.*times/i);
 // Regrouping must not replace the anchor with an earlier slot on the same Tokyo date.
 publicSlots=[3,4,5].flatMap(day=>Array.from({length:8},(_,hour)=>({start:`2026-11-0${day}T${hour+14}:00:00Z`,end:`2026-11-0${day}T${hour+14}:30:00Z`})));
 await page.getByRole('button',{name:'Refresh available times',exact:true}).click();await page.locator('.booking-calendar').waitFor();
 await page.locator('[data-date="2026-11-04"]').click();
 for(let repeat=0;repeat<2;repeat++){
  await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('Asia/Tokyo');
  assert.equal(await page.locator('[data-date="2026-11-04"]').getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Refresh available times',exact:true}).click();await page.locator('.booking-calendar').waitFor();
  await page.getByRole('combobox',{name:'Display timezone',exact:true}).selectOption('America/New_York');
  assert.equal(await page.locator('[data-date="2026-11-04"]').getAttribute('aria-pressed'),'true','timezone changes and refresh preserve the selected instant without day drift');
 }
 // Suggested times remain optional, precise, editable and private to the signed-in visitor.
 await page.getByRole('button',{name:'None of these times work? Suggest a time',exact:true}).click();
 await page.getByRole('heading',{name:'Suggest a time',exact:true}).waitFor();
 const proposalZone=page.getByRole('combobox',{name:'Suggested times timezone',exact:true});
 assert.equal(await proposalZone.inputValue(),'America/New_York','suggestions start in the calendar display timezone');
 await proposalZone.selectOption('UTC');
 const proposalInput=index=>page.getByLabel('Preferred time '+index,{exact:true});
 await proposalInput(1).fill('2026-11-09T10:00');
 await page.getByRole('button',{name:'Add another time',exact:true}).click();
 await proposalInput(2).fill('2026-11-09T10:00');
 const proposalPosts=()=>calls.filter(call=>call.path.endsWith('/proposals'));
 const beforeDuplicate=proposalPosts().length;
 await page.getByRole('button',{name:'Send suggested times',exact:true}).click();
 await page.getByRole('status').filter({hasText:'different time'}).waitFor();
 assert.equal(proposalPosts().length,beforeDuplicate,'duplicate starts are rejected before submission');
 await proposalInput(2).fill('2026-11-10T14:00');
 await page.getByRole('button',{name:'Add another time',exact:true}).click();await proposalInput(3).fill('2026-11-11T11:00');
 assert.equal(await page.getByRole('button',{name:'Add another time',exact:true}).isDisabled(),true,'only three precise suggestions are allowed');
 await page.getByRole('button',{name:'Remove preferred time 3',exact:true}).click();
 failProposal=true;await page.getByRole('button',{name:'Send suggested times',exact:true}).click();
 await page.getByRole('status').filter({hasText:'daylight saving'}).waitFor();
 assert.equal(await proposalInput(1).inputValue(),'2026-11-09T10:00','server failures retain form values');
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'/tmp/people-booking-suggested-desktop.png',fullPage:true});
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'suggestions fit narrow phones');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.locator('#booking-card').screenshot({path:'/tmp/people-booking-suggested-mobile.png'});
 await page.getByRole('button',{name:'Back to calendar',exact:true}).click();await page.locator('.booking-calendar').waitFor();
 await page.getByRole('button',{name:'None of these times work? Suggest a time',exact:true}).click();
 assert.equal(await proposalInput(2).inputValue(),'2026-11-10T14:00','calendar navigation retains the unsent suggestions');
 await page.getByRole('button',{name:'Send suggested times',exact:true}).click();
 await page.getByRole('heading',{name:'Suggested times sent',exact:true}).waitFor();
 assert.deepEqual(proposalPosts().at(-1).body,{timezone:'UTC',times:['2026-11-09T10:00','2026-11-10T14:00']},'send civil strings and explicit timezone without browser date conversion');
 assert.match(await page.locator('.proposed-times').innerText(),/Nov 9|9 Nov/);
 assert.match(await page.locator('#booking-card').innerText(),/not confirmed/);
 await page.reload();await page.getByRole('heading',{name:'Suggested times sent',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Preferred time 1',{exact:true}).count(),0,'request recovery displays saved proposals instead of reopening intake');
 statusValue='needs_new_slot';await page.getByRole('button',{name:'Check request status',exact:true}).click();
 await page.getByRole('heading',{name:'Let’s find another time',exact:true}).waitFor();
 assert.equal(await page.locator('.proposed-times li').count(),2,'an unavailable suggestion keeps saved alternatives visible on status refresh');
 assert.equal(await page.locator('.booking-calendar').count(),0,'retained proposals do not unexpectedly reopen the calendar');
 await page.reload();await page.getByRole('button',{name:'Edit suggested times',exact:true}).waitFor();
 assert.equal(await page.locator('.proposed-times li').count(),2,'saved alternatives survive request recovery');
 assert.equal(await page.getByRole('button',{name:'Choose from the calendar',exact:true}).count(),1);
 statusValue='pending_approval';await page.getByRole('button',{name:'Edit suggested times',exact:true}).click();
 assert.equal(await proposalInput(1).inputValue(),'2026-11-09T10:00','editing uses the saved proposal timezone');
 await proposalInput(1).fill('2026-11-12T10:00');expireProposal=true;
 await page.getByRole('button',{name:'Send suggested times',exact:true}).click();await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
 await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();await page.getByRole('heading',{name:'Suggested times sent',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit suggested times',exact:true}).click();
 assert.equal(await proposalInput(1).inputValue(),'2026-11-12T10:00','same-identity sign-in renewal preserves unsent edits');
 failSignIn=true;await page.getByRole('button',{name:'Use another Google account',exact:true}).click();await page.getByRole('status').filter({hasText:'Google sign-in is unavailable'}).waitFor();
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('people-booking-proposal-draft:kaya')),null,'account switching immediately clears proposal drafts');
 proposedTimes=null;publicSlots=[];visitorHistory=[];await signIn({returning:true});await page.getByRole('button',{name:'Choose a time',exact:true}).click();
 await page.getByRole('heading',{name:'No open times just now',exact:true}).waitFor();
 await page.getByRole('button',{name:'None of these times work? Suggest a time',exact:true}).click();
 assert.equal(await proposalInput(1).inputValue(),'','new requests never inherit previous visitor suggestions');
 const intakePostsBeforeClosed=calls.filter(call=>call.path==='/api/public/booking/kaya/requests'&&call.body).length;
 await proposalInput(1).fill('2026-11-12T10:00');closedProposal=true;
 await page.getByRole('button',{name:'Send suggested times',exact:true}).click();
 await page.getByRole('heading',{name:'You’re booked',exact:true}).waitFor();
 assert.equal(await page.locator('.proposal-form').count(),0,'a concurrent owner booking closes the stale proposal form');
 assert.equal(await page.getByRole('button',{name:'Try availability again',exact:true}).count(),0,'closed requests do not enter an availability retry loop');
 assert.equal(calls.filter(call=>call.path==='/api/public/booking/kaya/requests'&&call.body).length,intakePostsBeforeClosed,'recovering a closed request never creates another request');
 // Owners approve a stored suggestion explicitly without discarding any settings draft.
 ownerStatus=200;request.status='pending_approval';request.slotStart=null;request.slotEnd=null;
 request.proposedTimes={timezone:'America/Los_Angeles',revision:'owner-proposal-v2',slots:[{start:'2026-11-09T17:00:00Z',end:'2026-11-09T17:30:00Z'},{start:'2026-11-10T18:00:00Z',end:'2026-11-10T18:30:00Z'}]};
 await page.setViewportSize({width:1280,height:900});await page.goto(origin+'/booking');
 assert.match(await page.locator('.proposed-times').innerText(),/America\/New York/);assert.match(await page.locator('.proposed-times').innerText(),/America\/Los Angeles/);
 assert.equal(await page.getByRole('button',{name:'Approve request',exact:true}).count(),0,'suggestions require approving a specific stored choice');
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();await intro.fill('Keep my private owner draft');await page.getByRole('tab',{name:'Requests',exact:true}).click();
 staleProposal=true;await page.getByRole('button',{name:'Approve this time',exact:true}).first().click();
 await page.getByRole('status').filter({hasText:'changed'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Approve this time',exact:true}).count(),2,'stale approval does not claim confirmation');
 await page.locator('.request-card').screenshot({path:'/tmp/people-booking-suggested-owner.png'});
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'owner suggested-time actions fit narrow phones');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.locator('.request-card').screenshot({path:'/tmp/people-booking-suggested-owner-mobile.png'});
 await page.getByRole('button',{name:'Approve this time',exact:true}).nth(1).click();await page.getByRole('button',{name:'Cancel booking',exact:true}).waitFor();
 const approval=calls.findLast(call=>call.path.endsWith('/approve-proposal'));
 assert.deepEqual(approval.body,{start:'2026-11-10T18:00:00Z',revision:'owner-proposal-v2'},'owner approves exact stored instant and revision');
 await page.getByRole('tab',{name:'Booking page',exact:true}).click();assert.equal(await intro.inputValue(),'Keep my private owner draft','review actions do not replace the settings form');
 request.status='pending_approval';request.slotStart=null;request.slotEnd=null;await page.getByRole('tab',{name:'Requests',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByRole('button',{name:'Ask for different times',exact:true}).click();await page.locator('.status-pill').filter({hasText:'Needs another time'}).waitFor();
 assert.equal(calls.at(-1).path,'/api/booking/requests/r1/request-times');assert.equal(await page.getByRole('button',{name:'Approve this time',exact:true}).count(),0);
 await page.goto(origin+'/book/missing');await page.getByRole('heading',{name:'This booking page isn’t here',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Email',exact:true}).count(),0,'unknown booking links have no intake form');
 assert.deepEqual(errors,[],'pages execute without uncaught browser errors');
 console.log('Booking browser: owner settings, conflicts, readiness, email review deep links, review actions, private/public isolation, Google sign-in, draft recovery, returning contacts, eligibility fallback, month calendar, timezone/DST selection, refresh, request, slot recovery, paused-page recovery, suggested times, proposal drafts, precise owner approval, settings preservation, async, and mobile passed.');
}catch(error){failure=error;}finally{
 // Some Chrome builds exit without acknowledging close; never strand the local fixture server.
 if(browser)await new Promise(resolve=>{const timeout=setTimeout(resolve,5000);browser.close().catch(()=>{}).finally(()=>{clearTimeout(timeout);resolve();});});
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

if(failure)console.error(failure);
// Release any orphaned Playwright transport after the fixture server and browser are closed.
process.exit(failure?1:0);
