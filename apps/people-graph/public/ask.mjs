// Guest ask: a verified visitor asks the owner's network a question and sees only the owner's
// approved answers. People are described, never named, until they agree to an introduction.
const $=id=>document.getElementById(id),card=$('ask-card');
const slug=location.pathname.split('/').filter(Boolean)[1]||'',base='/api/public/ask/'+encodeURIComponent(slug);
const MAX_QUESTION=500;
const STATUS={pending:'Waiting for an answer',answered:'Answered',declined:'Not answered',expired:'Expired unanswered'};
const INTRO={proposed:'Introduction requested',asked_introducer:'Introduction requested',introducer_accepted:'Checking with them',target_opted_in:'They agreed to meet',made:'Introduced',met:'Introduced',not_met:'Introduced',declined:'Introduction declined',expired:'Introduction expired'};
const ERRORS={guest_ask_disabled:'This page isn’t taking questions right now.',guest_rate_limited:'You can ask three questions a day. Please come back tomorrow.',verification_required:'Sign in with Google to continue.',invalid_request:'Questions are 1 to 500 characters.',guest_ask_state_invalid:'That already happened.',introduction_budget:'Too many introductions are open right now. Please try again later.',not_found:'That question was not found.'};
const status=document.createElement('p');status.className='message';status.setAttribute('role','status');status.setAttribute('aria-live','polite');

function el(tag,className='',text=''){const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;}
function button(text,handler,className='button'){const node=el('button',className,text);node.type='button';node.addEventListener('click',handler);return node;}
function notice(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
function show(...nodes){card.replaceChildren(...nodes,status);}
async function api(suffix='',body){
 const response=await fetch(base+suffix,{credentials:'same-origin',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 let value={};try{value=await response.json();}catch{}
 if(!response.ok){const error=new Error(value.error||'unavailable');error.status=response.status;throw error;}
 return value;
}
const errorText=error=>ERRORS[error.message]||'Something went wrong. Please try again.';

async function signIn(){
 try{const {url}=await api('/sign-in',{});location.assign(url);}catch(error){notice(errorText(error),true);}
}

function questionForm(){
 const form=el('form','ask-form'),label=el('label','field'),text=el('textarea');
 text.name='question';text.rows=4;text.maxLength=MAX_QUESTION;text.required=true;text.placeholder='For example: who knows how hospitals schedule nurses?';
 label.append(el('span','',`Your question (up to ${MAX_QUESTION} characters)`),text);
 const submit=el('button','button primary','Ask');submit.type='submit';
 form.append(label,submit);
 form.addEventListener('submit',async event=>{
  event.preventDefault();submit.disabled=true;
  try{await api('/questions',{question:text.value});text.value='';notice('Sent. You’ll see the answer here once it’s ready.');await render();}
  catch(error){notice(errorText(error),true);}
  finally{submit.disabled=false;}
 });
 return form;
}

function person(question,p){
 const item=el('li','ask-person');item.append(el('p','',p.name?`${p.name}: ${p.description}`:p.description));
 if(p.introduction)item.append(el('p','muted',INTRO[p.introduction]||p.introduction));
 else item.append(button('Ask for an introduction',async()=>{
  try{await api(`/questions/${encodeURIComponent(question.id)}/introductions`,{ref:p.ref});notice('Introduction requested. Nothing is shared until they agree.');await render();}
  catch(error){notice(errorText(error),true);}
 }));
 return item;
}

function questionItem(question){
 const item=el('article','ask-question');
 item.append(el('h3','',question.question),el('p','muted',STATUS[question.status]||question.status));
 if(question.answer){
  item.append(el('p','',question.answer.text));
  const list=el('ul','ask-people');for(const p of question.answer.people)list.append(person(question,p));
  if(question.answer.people.length)item.append(list);
 }
 return item;
}

async function render(){
 const page=await api('');
 if(page.page?.displayName)$('host-name').textContent=`Ask ${page.page.displayName}’s network`;
 if(!page.enabled)return show(el('h2','','Not taking questions right now'),el('p','muted',ERRORS.guest_ask_disabled));
 if(!page.visitor)return show(el('h2','','Sign in to ask'),el('p','muted','Your Google email goes to the owner with your question, so they know who is asking.'),button('Sign in with Google',signIn,'button primary'));
 const {questions}=await api('/questions');
 const list=el('div','ask-questions');for(const q of questions)list.append(questionItem(q));
 show(el('p','muted',`Signed in as ${page.visitor.email}`),questionForm(),...(questions.length?[el('h2','','Your questions'),list]:[]),agentSection());
}

/** A token for the guest's own agent (MCP tools ask_network and my_questions), shown once. */
function agentSection(){
 const section=el('section','ask-agent');
 section.append(el('h2','','Ask from your own agent'),el('p','muted','Connect an MCP client to ask and check answers for you. The token lasts seven days and is shown once; anyone holding it can ask as you.'));
 section.append(button('Create an agent token',async()=>{
  try{
   const {token,mcp,expiresAt}=await api('/agent-token',{});
   const field=(label,value)=>{const wrap=el('label','field'),input=el('input');input.readOnly=true;input.value=value;wrap.append(el('span','',label),input);return wrap;};
   section.replaceChildren(el('h2','','Ask from your own agent'),field('MCP endpoint',mcp),field('Bearer token',token),el('p','muted',`Valid until ${new Date(expiresAt).toLocaleDateString()}.`));
  }catch(error){notice(errorText(error),true);}
 }));
 return section;
}

const params=new URL(location.href).searchParams;
if(params.get('sign_in')==='failed')notice('Google sign-in didn’t finish. Please try again.',true);
if(params.has('signed_in')||params.has('sign_in')){const url=new URL(location.href);url.search='';history.replaceState(null,'',url);}
render().catch(error=>show(el('p','message error',errorText(error))));
