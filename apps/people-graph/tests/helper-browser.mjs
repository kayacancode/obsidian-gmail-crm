import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4198/');
 await page.evaluate(async()=>{
  document.body.replaceChildren();const root=document.createElement('main');document.body.append(root);
  const {mountGraph}=await import('/relationship-graph/graph.mjs');
  const date=new Date(Date.now()-86400000).toISOString();
  window.graph=mountGraph(root,{onFindHelpers:async(id,brief)=>{if(brief==='fail')return {checked:false,status:'unavailable'};return {checked:true,status:'ready',considered:1,available:1,results:[{personId:'m',reason:'Relevant research experience',evidence:[{summary:'Ran moderated usability interviews with hospital nurses',date,sourceType:'granola',ref:'sm'}]}]};},graph:{nodes:[{id:'a',name:'Angelica',strength:50,combined:60,directRelationship:true},{id:'m',name:'Max',strength:40,combined:50,directRelationship:true}],edges:[],themes:[{id:'t',canonicalName:'User research'}],themeSignals:[{id:'sa',personId:'a',summary:'Building user research interviews for design teams'},{id:'sm',personId:'m',summary:'Helping design teams conduct user research interviews'}].map(s=>({...s,themeId:'t',sourceType:'granola',visibility:'private',observedAt:date,ingestedAt:date,confidence:1,evidenceRef:s.id,contentHash:s.id,extractorVersion:'test'}))}});
 });
 await page.getByRole('button',{name:'Explore Angelica',exact:true}).click();
 await page.getByText('Who could help this person?',{exact:true}).click();
 await page.locator('.rg-helper-card').waitFor();assert.equal(await page.locator('.rg-helper-card').count(),1);
 await page.getByText('Why this match?',{exact:true}).click();
 assert.match(await page.locator('.rg-helper-card').innerText(),/Building user research interviews/);
 await page.getByRole('button',{name:'Draft an introduction',exact:true}).click();
 const draft=page.getByRole('textbox',{name:'Introduction draft for Angelica and Max'});assert.match(await draft.inputValue(),/Would you both be open/);
 await draft.fill('My edited invitation');assert.equal(await draft.inputValue(),'My edited invitation');
 const brief=page.getByRole('textbox',{name:'What is Angelica building or looking for help with?'});
 await brief.fill('Needs feedback on a clinical scheduling prototype');await page.getByRole('button',{name:'Find people who could help',exact:true}).click();
 await page.getByText('Relevant research experience',{exact:true}).waitFor();await page.getByText('Why this match?',{exact:true}).click();assert.match(await page.locator('.rg-helper-card').innerText(),/hospital nurses/);
 await page.getByRole('button',{name:'Draft an introduction',exact:true}).click();assert.match(await draft.inputValue(),/Your description of Angelica/);
 await brief.fill('fail');await page.getByRole('button',{name:'Find people who could help',exact:true}).click();await page.getByText(/The search could not finish/).waitFor();assert.equal(await brief.inputValue(),'fail');
 await page.screenshot({path:'/tmp/helper-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/helper-mobile.png'});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS helper suggestions: evidence, editable unsent draft, desktop and mobile');
}finally{await browser.close();}
