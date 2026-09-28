import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4198/');
 await page.evaluate(async()=>{
  const {mountContactSheet,contactCard}=await import('/relationship-graph/contact-sheet.mjs');
  document.body.replaceChildren();const container=document.createElement('div');document.body.append(container);
  const graph={source:'workspace',members:[{id:'me',isMe:true,name:'Kaya'}],nodes:[{id:'p',name:'Test Person',relationships:[{memberId:'me',evidenceCategory:'email',score:44}]}],themeSignals:[{id:'s',personId:'p',sourceType:'granola',observedAt:'2026-09-20',summary:'Recorded topic: Agent memory',evidenceRef:'workspace:me:s',provenance:{title:'Memory design sync'}}]};
  const sheet=mountContactSheet(container,{onConfirmRelationship:async(id,confirmed)=>{if(id!=='p')throw Error('wrong person');if(confirmed)graph.nodes[0].relationships[0].confirmedAt='2026-09-28T00:00:00Z';else delete graph.nodes[0].relationships[0].confirmedAt;sheet.setCard(contactCard(graph,'p'));}});sheet.setCard(contactCard(graph,'p'));
 });
 await page.getByRole('heading',{name:'Last shared conversation',exact:true}).waitFor();await page.getByText('Memory design sync',{exact:true}).waitFor();
 await page.getByRole('button',{name:'I know this person — confirm relationship',exact:true}).click();await page.getByText('✓ Relationship confirmed by you · 2026-09-28',{exact:true}).waitFor();await page.getByText('Activity score: 44 / 100',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Remove my confirmation',exact:true}).click();await page.getByRole('button',{name:'I know this person — confirm relationship',exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('PASS confirmation, revocation, unchanged score and shared memory');
}finally{await browser.close();}
