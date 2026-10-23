import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const server=createServer(async(req,res)=>{
 const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);
 if(!path.startsWith(root+sep)){res.writeHead(200,{'content-type':'text/html'}).end('<html><head><link rel="stylesheet" href="/relationship-graph/graph.css"><link rel="stylesheet" href="/relationship-host.css"><link rel="stylesheet" href="/atlas.css"><style>body{margin:0}main{height:100vh}</style></head><body></body></html>');return;}
 try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'text/html');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser,failure;
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1280,height:950}});page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.evaluate(async()=>{
  const {mountGraph}=await import('/relationship-graph/graph.mjs');
  const date=new Date(Date.now()-86400000).toISOString();
  window.notes={};window.calls=[];window.failSave=false;window.conflict=false;window.holdLoad=false;
  const data={source:'email_accounts',nodes:[{id:'a',name:'Angelica',type:'person',directRelationship:true,strength:50,combined:60},{id:'m',name:'Max',type:'person',directRelationship:true,strength:40,combined:50},{id:'s',name:'Shared Person',type:'person',directRelationship:false,via:['other@example.test']}],edges:[],themes:[{id:'t',canonicalName:'Strategy'}],themeSignals:[
   {id:'generic',personId:'a',summary:'Activity involving business planning and strategy'},
   {id:'useful',personId:'a',summary:'Testing clinic scheduling with three nursing teams.'}
  ].map(s=>({...s,themeId:'t',sourceType:'gmail_body_derived',visibility:'private',observedAt:date,ingestedAt:date,confidence:1,evidenceRef:s.id,contentHash:s.id,extractorVersion:'test'}))};
  window.mount=()=>{window.graph?.destroy();document.body.replaceChildren();const root=document.createElement('main');document.body.append(root);window.graph=mountGraph(root,{graph:data,
   onGetPersonContext:async personId=>{if(window.holdLoad&&personId==='a')await new Promise(resolve=>window.releaseLoad=resolve);return window.notes[personId]||{personId,text:'',revision:null,updatedAt:null};},
   onSavePersonContext:async input=>{window.calls.push(input);if(window.failSave)throw Error('offline');if(window.conflict)throw Object.assign(Error('person_context_conflict'),{status:409});return window.notes[input.personId]={...input,revision:'r'+window.calls.length,updatedAt:Date.now()};},
   onFindHelpers:async(id,brief)=>{const note=window.notes[id]?.text;return {checked:true,status:'ready',automatic:!brief&&!note,brief:brief||note||'',contextSource:brief?'brief':note?'saved_note':'automatic',considered:1,available:1,results:[{personId:'m',reason:'Max can discuss testing nurse handoffs.',conversation:'Which handoff assumptions should they test?',evidence:[{summary:'Ran moderated usability interviews with hospital nurses.',date,sourceType:'granola',ref:'m1'}],anchorEvidence:[]}]};}
  });};window.mount();
 });
 const open=async name=>{await page.getByRole('button',{name:'Explore '+name,exact:true}).click();};
 await open('Angelica');
 await page.getByRole('heading',{name:'Your context',exact:true}).waitFor();
 assert.equal(await page.getByText('Activity involving business planning and strategy',{exact:true}).count(),0);
 await page.getByText('Testing clinic scheduling with three nursing teams.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Add context',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Your context about Angelica',exact:true});
 const text='Building a clinic scheduling tool. Looking for nurse design partners. <script>not markup</script>';
 await input.fill(text);await page.getByRole('button',{name:'Save context',exact:true}).click();
 await page.getByText(text,{exact:true}).waitFor();
 await page.getByText('Who could help this person?',{exact:true}).click();
 await page.getByText('Using your saved context',{exact:true}).waitFor();
 await page.getByText('Why this match?',{exact:true}).click();assert.match(await page.locator('.rg-helper-card').innerText(),/Your saved context/);
 assert.equal(await page.locator('script').count(),0,'note is rendered as text');
 await page.evaluate(()=>window.mount());await open('Angelica');await page.getByText(text,{exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit context',exact:true}).click();await input.fill('Keep this unsaved correction');
 await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'Save context',exact:true}).click();
 await page.getByText('Could not save. Your text is still here.',{exact:true}).waitFor();assert.equal(await input.inputValue(),'Keep this unsaved correction');
 await page.evaluate(()=>{window.failSave=false;window.conflict=true;});await page.getByRole('button',{name:'Save context',exact:true}).click();
 await page.getByText('This context changed elsewhere. Your edit is still here. Load the latest version before saving.',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),'Keep this unsaved correction');await page.getByRole('button',{name:'Load latest context',exact:true}).click();assert.equal(await input.inputValue(),text);
 await page.evaluate(()=>window.conflict=false);await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Remove context',exact:true}).click();await page.getByRole('button',{name:'Add context',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.notes.a.text),'');assert.ok(await page.evaluate(()=>window.notes.a.revision));
 await page.evaluate(()=>{window.holdLoad=true;window.mount();});await open('Angelica');await page.getByRole('button',{name:'Close details',exact:true}).click();await open('Max');await page.getByRole('button',{name:'Add context',exact:true}).waitFor();
 await page.evaluate(()=>window.releaseLoad());assert.equal(await page.getByRole('heading',{name:'Max',exact:true}).count(),1);assert.equal(await page.getByText(text,{exact:true}).count(),0);
 await page.getByRole('button',{name:'Close details',exact:true}).click();await page.evaluate(()=>window.graph.select('s'));assert.equal(await page.getByRole('heading',{name:'Your context',exact:true}).count(),0);
 await page.getByRole('button',{name:'Close details',exact:true}).click();await open('Max');await page.getByRole('button',{name:'Add context',exact:true}).click();
 const mobileText='Building a privacy tool for small teams. Looking for design partners.';await page.getByRole('textbox',{name:'Your context about Max',exact:true}).fill(mobileText);
 await page.locator('.rg-person-context textarea').evaluate(input=>{input.focus();input.setSelectionRange(9,16);});
 await page.evaluate(()=>window.graph.setRelevance(null));
 assert.deepEqual(await page.evaluate(()=>({label:document.activeElement.getAttribute('aria-label'),start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})),{label:'Your context about Max',start:9,end:16},'background relevance refresh preserves typing focus and selection');
 await page.locator('.rg-person-context').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/person-context-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 await page.locator('.rg-person-context').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/person-context-mobile.png'});
 assert.equal(await page.getByRole('textbox',{name:'Your context about Max',exact:true}).inputValue(),mobileText,'canvas resizing preserves the active note draft');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS private person context: save/reopen/remove, errors/conflicts, selected-person isolation, provenance and mobile');
}catch(error){failure=error;}finally{if(browser)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);browser.close().catch(()=>{}).finally(()=>{clearTimeout(timer);resolve();});});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
if(failure)console.error(failure);process.exit(failure?1:0);
