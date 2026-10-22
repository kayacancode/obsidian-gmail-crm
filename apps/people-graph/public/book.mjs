import {createBookingCalendar} from './booking-calendar.mjs';
const $=id=>document.getElementById(id),card=$('booking-card');
const slug=location.pathname.split('/').filter(Boolean)[1]||'',base='/api/public/booking/'+encodeURIComponent(slug);
let acceptingRequests=false,recoveryAvailable=false;
let host=null,email='',identityKey='',verified=false,busy=false,intake=null,intakeKind='standard',intakeName='',returningContact=null,currentRequest=null,poll=null,restoredDraft=null;
let idempotencyKey=crypto.randomUUID(),resumeId=new URL(location.href).searchParams.get('request');
let slotSelection={requestId:null,start:null};
let displayTimezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const statusMessage=document.createElement('p');statusMessage.className='message';statusMessage.setAttribute('role','status');statusMessage.setAttribute('aria-live','polite');
const labels={pending_approval:'Awaiting a reply',booking:'Confirming your time',cancelling:'Cancelling your booking',booked:'Confirmed',needs_new_slot:'Choose another time',declined:'Request closed',async_submitted:'Update received',cancelled:'Cancelled',expired:'Expired'};
function el(tag,className='',text=''){const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;}
function button(text,handler,className='button'){const node=el('button',className,text);node.type='button';node.addEventListener('click',handler);return node;}
function notice(text,error=false){statusMessage.textContent=text;statusMessage.classList.toggle('error',error);}
function show(...nodes){clearTimeout(poll);poll=null;card.replaceChildren(...nodes,statusMessage);notice('');}
function setBusy(value){busy=value;card.setAttribute('aria-busy',String(value));card.querySelectorAll('button,input,textarea,select').forEach(node=>{if(value){if(node.dataset.busyDisabled===undefined)node.dataset.busyDisabled=String(node.disabled);node.disabled=true;}else if(node.dataset.busyDisabled!==undefined){node.disabled=node.dataset.busyDisabled==='true';delete node.dataset.busyDisabled;}});}
async function api(suffix='',body){const response=await fetch(base+suffix,{credentials:'same-origin',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});let value;try{value=await response.json();}catch{value={};}if(!response.ok){const error=new Error(value.error||'We couldn’t complete that. Please try again.');error.status=response.status;throw error;}return value;}
function errorText(error){const known={sign_in_required:'Sign in with Google to continue.',verification_required:'Sign in with Google to continue.',sign_in_unavailable:'Google sign-in is unavailable right now. Please try again.',invalid_oauth_state:'Google sign-in did not complete. Please try again.',slot_unavailable:'That time is no longer available. Please choose another time.',slot_conflict:'That time is no longer available. Please choose another time.',rate_limited:'Please wait a little before trying again.',booking_unavailable:'Booking is temporarily unavailable. Please try again later.'};if(known[error.message])return known[error.message];if(error.status===429)return 'Please wait a little before trying again.';if(/^[a-z_]+$/.test(error.message))return 'We couldn’t complete that. Please try again.';return error.message;}
function field(name,label,{type='text',rows,required=false,placeholder='',maxLength,autocomplete}={}){const wrap=el('label','field'),input=el(rows?'textarea':'input');input.name=name;input.id='visitor-'+name;if(rows)input.rows=rows;else input.type=type;input.required=required;if(placeholder)input.placeholder=placeholder;if(maxLength)input.maxLength=maxLength;if(autocomplete)input.autocomplete=autocomplete;wrap.append(el('span','',label),input);return {wrap,input};}
function step(text){const node=el('div','step-label');node.append(el('span','step-dot'),document.createTextNode(text));return node;}
function heading(title,copy){const node=el('div');node.append(el('h2','',title));if(copy)node.append(el('p','muted',copy));return node;}
function privacy(){return el('p','privacy-note','Your email and the context you share go to your host to help them consider your request.');}
const draftStorageKey='people-booking-oauth-draft:'+slug;
function clearDraft(){try{sessionStorage.removeItem(draftStorageKey);}catch{}}
function saveDraftForSignIn(){
 if(!intake||!email||!identityKey)return;
 const values={};for(const input of intake.querySelectorAll('input,textarea'))values[input.name]=input.value;if(intakeKind==='returning')values.name=intakeName;
 try{sessionStorage.setItem(draftStorageKey,JSON.stringify({kind:intakeKind,email,identityKey,values,idempotencyKey,createdAt:Date.now()}));}catch{}
}
function takeDraft(){
 try{const raw=sessionStorage.getItem(draftStorageKey);clearDraft();if(!raw)return null;const draft=JSON.parse(raw);if(!identityKey||draft.identityKey!==identityKey||draft.email!==email||!Number.isFinite(draft.createdAt)||draft.createdAt>Date.now()||Date.now()-draft.createdAt>3600000||!draft.values||typeof draft.values!=='object'||Array.isArray(draft.values)||![undefined,'standard','returning'].includes(draft.kind))return null;if(typeof draft.idempotencyKey==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(draft.idempotencyKey))idempotencyKey=draft.idempotencyKey;return {kind:draft.kind||'standard',values:draft.values};}catch{clearDraft();return null;}
}
function clearCallbackFlags(){const url=new URL(location.href);url.searchParams.delete('signed_in');url.searchParams.delete('sign_in');history.replaceState(null,'',url);}
function authExpired(error){if(error.status!==401&&error.status!==403)return false;verified=false;showSignIn('Your session expired. Sign in with Google to continue.');return true;}
function showPaused(){const nodes=[heading('Booking is paused','Your host isn’t taking new requests right now. Existing requests can still be checked here.')];if(recoveryAvailable)nodes.push(button('View an existing request',()=>verified?void recoverRequests():showSignIn(),'button primary'));show(...nodes);}
function showSignIn(message=''){
 if(!acceptingRequests&&!recoveryAvailable){showPaused();if(message)notice(message,true);return;}
 show(step('01 · A QUICK HELLO'),heading(resumeId||!acceptingRequests?'Find your request':'A quick introduction','Sign in with Google to share your request and return to check its status.'),button('Sign in with Google',()=>void startSignIn(),'button primary'),privacy());
 if(message)notice(message,true);
}
async function startSignIn(changeAccount=false){
 if(busy)return;
 if(changeAccount){clearDraft();intake=null;intakeKind='standard';intakeName='';returningContact=null;restoredDraft=null;email='';identityKey='';verified=false;idempotencyKey=crypto.randomUUID();showSignIn();}
 setBusy(true);notice('Opening Google sign-in…');
 try{const result=await api('/sign-in',resumeId?{requestId:resumeId}:{});const url=new URL(result.url,location.origin);if(url.protocol!=='https:'||url.hostname!=='accounts.google.com'||url.username||url.password)throw new Error('Google sign-in could not be opened. Please try again.');if(!changeAccount)saveDraftForSignIn();location.assign(url.href);}catch(error){notice(errorText(error),true);}finally{setBusy(false);}
}
async function recoverRequests(){
 if(resumeId){try{const result=await api('/requests/'+encodeURIComponent(resumeId));await proceed(result);return;}catch(error){if(authExpired(error))return;if(error.status!==404){show(heading('Your request couldn’t load','You can try checking its status again.'),button('Try again',()=>void recoverRequests(),'button primary'));notice(errorText(error),true);return;}resumeId=null;}}
 try{const result=await api('/requests');if(result.requests?.length){showExisting(result.requests);return;}}catch(error){if(authExpired(error))return;show(heading('Your requests couldn’t load','Please try checking your requests again.'),button('Try again',()=>void recoverRequests(),'button primary'));notice(errorText(error),true);return;}
 if(!acceptingRequests){clearDraft();const nodes=[heading('No requests found','There are no existing requests for this Google account. Your host isn’t taking new booking requests right now.')];if(recoveryAvailable)nodes.push(button('Use another Google account',()=>void startSignIn(true),'button'));show(...nodes);return;}
 showIntake();
}
function showExisting(requests){const list=el('div','slot-list');for(const entry of requests){const request=entry.request;if(!request?.id)continue;const row=el('div','slot'),copy=el('div');copy.append(el('p','',labels[request.status]||'Request received'));if(request.slotStart)copy.append(el('small','',timeLabel(request.slotStart)));row.append(copy,button('View request',()=>void proceed(entry),'button small'));list.append(row);}const nodes=[step('WELCOME BACK'),heading('Your conversations',acceptingRequests?'You can pick up an existing request or share something new.':'Booking is paused. You can still view the status of your existing requests.'),list];if(acceptingRequests)nodes.push(button('Start a new request',startNew,'button primary'));show(...nodes);}
function startNew(){clearDraft();restoredDraft=null;if(!acceptingRequests){showPaused();return;}idempotencyKey=crypto.randomUUID();resumeId=null;currentRequest=null;intake=null;intakeKind='standard';intakeName='';const url=new URL(location.href);url.searchParams.delete('request');history.replaceState(null,'',url);showIntake();}
function verifiedAccount(){const line=el('div','verified-line','Signed in as '+email);line.append(button('Use another Google account',()=>void startSignIn(true),'button quiet'));return line;}
function fillIntake(values){for(const input of intake.querySelectorAll('input,textarea'))if(typeof values[input.name]==='string')input.value=values[input.name];}
function shareMoreContext(){const note=intake.querySelector('[name=note]')?.value||'';restoredDraft={kind:'standard',values:{name:intakeName,purpose:note}};intake=null;showIntake();}
function returningForm(values){
 const form=el('form'),note=field('note','Anything you’d like to catch up on? (optional)',{rows:4,maxLength:2000,placeholder:'A quick update, a question, or just a hello.'}),submit=el('button','button primary','Choose a time');
 intakeName=typeof values.name==='string'?values.name:returningContact.name;submit.type='submit';form.append(note.wrap,submit);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;setBusy(true);notice('Sending your request…');
  try{const result=await api('/requests',{kind:'returning',note:note.input.value.trim(),idempotencyKey});clearDraft();await proceed(result);}
  catch(error){if(error.status===409&&error.message==='intake_required'){returningContact=null;shareMoreContext();notice('Please share a little more context to continue. Your note is still here.');}else if(!authExpired(error))notice(errorText(error)+' Your details are still here.',true);}
  finally{setBusy(false);}
 });
 return form;
}
function standardForm(){
 const form=el('form'),name=field('name','Your name',{required:true,autocomplete:'name',maxLength:100}),project=field('project','What are you building?',{rows:3,required:true,maxLength:3000,placeholder:'A project, an idea, or the work you’re exploring.'}),purpose=field('purpose','What would you like to discuss?',{rows:3,required:true,maxLength:2000,placeholder:'A little specificity helps make this time useful.'}),url=field('projectUrl','Project or deck link',{type:'url',maxLength:1000,placeholder:'https://'}),referrer=field('referrer','Who introduced you?',{maxLength:200,placeholder:'Optional'}),extras=el('details');
 project.input.minLength=10;purpose.input.minLength=10;url.input.pattern='https://.*';extras.append(el('summary','','Add a link or an introduction (optional)'),url.wrap,referrer.wrap);
 const submit=el('button','button primary','Send request');submit.type='submit';form.append(name.wrap,project.wrap,purpose.wrap,extras,submit);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;setBusy(true);notice('Sending your request…');
  try{const body={name:name.input.value.trim(),project:project.input.value.trim(),purpose:purpose.input.value.trim(),projectUrl:url.input.value.trim(),referrer:referrer.input.value.trim(),idempotencyKey};const result=await api('/requests',body);clearDraft();await proceed(result);}
  catch(error){if(!authExpired(error))notice(errorText(error)+' Your details are still here.',true);}
  finally{setBusy(false);}
 });
 return form;
}
function showIntake(){
 if(!acceptingRequests){showPaused();return;}if(!verified){showSignIn();return;}
 if(!intake){
  const draft=restoredDraft;restoredDraft=null;intakeKind=draft?.kind==='standard'?'standard':returningContact?'returning':'standard';
  const values={...(draft?.values||{})};
  if(draft?.kind==='returning'&&intakeKind==='standard')values.purpose=values.note;
  intake=intakeKind==='returning'?returningForm(values):standardForm();fillIntake(values);
 }
 if(intakeKind==='returning'){
  show(step('02 · A CHANCE TO CATCH UP'),heading('Welcome back'+(intakeName?', '+intakeName:''),'It’s good to hear from you. Add a note if you’d like, then find a time to reconnect.'),verifiedAccount(),intake,button('Share more context',shareMoreContext,'button quiet'),el('p','hint','Your selected time will be sent to your host for confirmation.'),privacy());
 }else show(step('02 · A LITTLE CONTEXT'),heading('What’s on your mind?','Share enough for your host to understand the conversation you’re hoping for.'),verifiedAccount(),intake,privacy());
}

function rememberRequest(request){currentRequest=request;resumeId=request.id;const url=new URL(location.href);url.searchParams.set('request',request.id);history.replaceState(null,'',url);}
async function proceed(result){if(!result.request?.id)throw new Error('Your request could not be loaded. Please try again.');rememberRequest(result.request);if(acceptingRequests&&(result.request.status==='needs_new_slot'||(result.request.status==='pending_approval'&&result.next==='select_slot'&&!result.request.slotStart))){await showSlots();return;}showStatus(result.request);}
function timeLabel(value,options={}){try{return new Intl.DateTimeFormat(undefined,{timeZone:displayTimezone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...options}).format(new Date(value));}catch{return 'Time unavailable';}}
function timezoneSelect(onChange){const label=el('label','field'),select=el('select');select.setAttribute('aria-label','Display timezone');const zones=[...new Set([displayTimezone,host.timezone,'UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','Europe/Paris','Asia/Singapore','Asia/Tokyo','Australia/Sydney'])];for(const zone of zones){const option=el('option','',zone.replaceAll('_',' '));option.value=zone;select.append(option);}select.value=displayTimezone;select.addEventListener('change',()=>{displayTimezone=select.value;onChange();});label.append(el('span','','Times shown in'),select);return label;}
async function showSlots(){if(!acceptingRequests){if(currentRequest)showStatus(currentRequest);else showPaused();return;}const request=currentRequest;show(step('03 · FIND A MOMENT'),heading(request.status==='needs_new_slot'?'Let’s find another time':'Choose a time that works',request.intakeKind==='returning'?'Your selected time will be sent to your host for confirmation.':'Your selected time will be confirmed after the next step.'),el('p','loading','Checking availability…'));try{const result=await api('/slots?requestId='+encodeURIComponent(request.id));renderSlots(result.slots||[]);}catch(error){if(authExpired(error))return;show(heading('Let’s find a time','Your request is saved. Availability couldn’t load just now.'),button('Try availability again',()=>void showSlots(),'button primary'));notice(errorText(error),true);}}
function renderSlots(slots){
 if(!slots.length){show(step('03 · FIND A MOMENT'),heading('No open times just now','Your request is saved. You can check again later for availability.'),button('Check availability',()=>void showSlots(),'button primary'),button('View request status',()=>showStatus(currentRequest),'button quiet'));return;}
 const requestId=currentRequest.id;
 const calendar=createBookingCalendar({slots,timeZone:displayTimezone,selectedStart:slotSelection.requestId===requestId?slotSelection.start:null,
  onDayChange:start=>{slotSelection={requestId,start};},
  onChoose:async slot=>{
   if(busy)return;setBusy(true);notice('Checking this time…');
   try{const result=await api('/requests/'+encodeURIComponent(requestId)+'/slot',{start:slot.start});rememberRequest(result.request);showStatus(result.request);}
   catch(error){if(!authExpired(error))notice(errorText(error),true);}
   finally{setBusy(false);}
  }
 });
 const head=heading(currentRequest.status==='needs_new_slot'?'Let’s find another time':'Choose a time that works',currentRequest.intakeKind==='returning'?'Your selected time will be sent to your host for confirmation.':'A selected time is a preference until your booking is confirmed.');
 show(step('03 · FIND A MOMENT'),head,timezoneSelect(()=>calendar.setTimeZone(displayTimezone)),calendar.element,button('Refresh available times',()=>void showSlots(),'button quiet'));
}
function showStatus(request){const copy={pending_approval:['Request received','Your preferred time is not confirmed yet. Your host will review your request. Return to this page to check their response.'],booking:['Confirming your time','We’re checking the booking with the calendar. It is not confirmed yet. You can safely check back here.'],cancelling:['Cancelling your booking','We’re checking the cancellation with the calendar. The cancellation is not confirmed yet. You can safely check back here.'],booked:['You’re booked','Your time is confirmed. Look out for the calendar invitation in your inbox.'],needs_new_slot:acceptingRequests?['Let’s find another time','The previous time is no longer available. Choose another time to continue.']:['Another time is needed','The previous time is no longer available. Booking is paused, so you can’t select a new time right now.'],declined:['Thanks for reaching out','Your host isn’t able to take this conversation right now. Thank you for sharing the context.'],async_submitted:['Thanks for the update','Your context and any project link have been shared with your host. There’s no meeting to schedule right now.'],cancelled:['Booking cancelled',acceptingRequests?'This meeting has been cancelled. You can send a new request when the time is right.':'This meeting has been cancelled. Your host isn’t taking new requests right now.'],expired:['This request has expired',acceptingRequests?'You can start a new request with a fresh update.':'Your host isn’t taking new requests right now.']}[request.status]||['Request received','Your request is saved. Check back for an update.'];const nodes=[el('div','confirmation-mark',request.status==='booked'?'✓':'↗'),heading(...copy)];if(request.slotStart){const time=el('div','confirmation-time');time.append(el('p','',timeLabel(request.slotStart)),el('small','muted',displayTimezone.replaceAll('_',' ')));nodes.push(time);}if(acceptingRequests&&request.status==='needs_new_slot')nodes.push(button('Choose another time',()=>void showSlots(),'button primary'));if(['pending_approval','booking','cancelling','needs_new_slot'].includes(request.status))nodes.push(button('Check request status',refreshStatus,'button'));if(acceptingRequests)nodes.push(button('Start a new request',()=>verified?startNew():showSignIn(),'button quiet'));show(...nodes);if(['booking','cancelling'].includes(request.status))poll=setTimeout(()=>{if(!document.hidden&&!busy)void refreshStatus();},8000);}
async function refreshStatus(){if(busy||!currentRequest)return;setBusy(true);try{const result=await api('/requests/'+encodeURIComponent(currentRequest.id));rememberRequest(result.request);if(acceptingRequests&&result.request.status==='needs_new_slot')await showSlots();else showStatus(result.request);}catch(error){if(!authExpired(error))notice(errorText(error),true);}finally{setBusy(false);}}
async function load(){
 const failed=new URL(location.href).searchParams.get('sign_in')==='failed';clearCallbackFlags();
 try{
  const result=await api();host=result.page;acceptingRequests=result.available===true;recoveryAvailable=result.recoveryAvailable===true;
  email=typeof result.visitor?.email==='string'?result.visitor.email:'';identityKey=typeof result.visitor?.identityKey==='string'?result.visitor.identityKey:'';verified=!!email;returningContact=verified&&identityKey&&typeof result.returningContact?.name==='string'?{name:result.returningContact.name}:null;restoredDraft=verified?takeDraft():null;if(!verified)clearDraft();
  $('host-name').textContent='A conversation with '+host.displayName+'.';$('host-intro').textContent=host.intro;document.title='Meet '+host.displayName+' · People';$('meeting-meta').replaceChildren(el('span','',host.durationMinutes+' minutes'),el('span','',host.timezone.replaceAll('_',' ')));
  if(failed){showSignIn('Google sign-in did not complete. Please try again.');return;}
  if(verified){await recoverRequests();return;}
  if(!acceptingRequests){showPaused();return;}
  showSignIn();
 }catch(error){show(heading(error.status===404?'This booking page isn’t here':'This page couldn’t load',error.status===404?'Check the link with the person who shared it.':'Please try again in a moment.'));if(error.status!==404)card.append(button('Try again',load,'button'));}
}
void load();
