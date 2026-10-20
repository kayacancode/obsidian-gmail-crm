import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../public/',import.meta.url));
const html='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"></head><body style="margin:0"><div id="graph"></div></body></html>';
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://local').pathname;
 if(pathname==='/__person-connection-fixture'){res.setHeader('content-type','text/html');res.end(html);return;}
 const path=resolve(root,'.'+pathname);
 if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}
 try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
let browserServer,browser;
const watchdog=setTimeout(()=>{console.error('FAIL person connection browser: exceeded 45-second test deadline');browserServer?.process()?.kill('SIGKILL');server.closeAllConnections();process.exit(1);},45000);
async function boundedClose(operation){
 let timer;
 try{await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser shutdown timeout')),5000);})]);}
 finally{clearTimeout(timer);}
}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 // launchServer exposes only this test's child process, so shutdown can be bounded.
 browserServer=await chromium.launchServer({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',timeout:10000});
 browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:10000});
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
 page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/__person-connection-fixture');
 await page.evaluate(async()=>{
  const {mountGraph}=await import('/relationship-graph/graph.mjs');
  window.connectionCalls=[];window.connectionPending={};
  window.connectionResponses={
   reciprocal:{status:'found',origin:{introducerName:'Analisa',observedAt:'2026-10-01T12:00:00Z',subject:'Introducing Jordan and you',quote:'I’d like to introduce you to Jordan. <img src=x onerror=alert(1)>',url:'https://mail.google.com/mail/u/0/#all/123abc'}},
   incoming:{status:'not_found'},unknown:{status:'not_found'},shared:{status:'not_found'},disabled:{status:'disabled'},retry:{status:'unavailable'},
   outreach:{status:'not_found',connection:{direction:'sent',observedAt:'2026-10-01T12:00:00Z',subject:'Product demo',quote:'I’d love to show you the demo. I’ll bring Morgan into the conversation.',url:'https://mail.google.com/mail/u/0/#all/direct123'}},
   reply:{status:'not_found',connection:{direction:'received',observedAt:'2026-10-02T12:00:00Z',subject:'Re: <b>Product demo</b>',quote:'Thanks for reaching out. <img src=x onerror=alert(1)>',url:'https://mail.google.com.evil.test/email'}},
   blank:{status:'not_found',connection:{direction:'sent',observedAt:'2026-10-01T12:00:00Z',subject:'',quote:'Here is the prototype we discussed.',url:'https://mail.google.com/mail/u/0/#all/blank123'}},
   unsafe:{status:'found',origin:{introducerName:'Analisa <b>Example</b>',observedAt:'2026-10-01',subject:'A long subject '+('A'.repeat(160)),quote:'An introduction to a person with a long reference '+('x'.repeat(200)),url:'https://mail.google.com.evil.test/email'}},
  };
  window.connectionFixture={source:'email_accounts',nodes:[
   {id:'reciprocal',name:'Jordan Rivera',type:'person',directRelationship:true,contactActivity:{sent:12,received:7,meetings:2},strength:70,momentum:50,combined:60},
   {id:'incoming',name:'Maya Chen',type:'person',directRelationship:true,contactActivity:{sent:0,received:3,meetings:0},strength:20,momentum:20,combined:20},
   {id:'unknown',name:'Avery Stone',type:'person',combined:90,lastContact:'2026-10-19T12:00:00Z'},
   {id:'shared',name:'Sam Patel',type:'person',directRelationship:false,via:['Morgan Lee'],contactActivity:{sent:888,received:777,meetings:66}},
   ...['outreach','reply','blank'].map(id=>({id,name:id+' Person',directRelationship:true,contactActivity:{sent:4,received:3,meetings:1}})),
   ...['disabled','retry','unsafe','delayed'].map(id=>({id,name:id+' Person',type:'person',directRelationship:true})),
  ],edges:[
   {id:'undirected-intro',source:'unknown',target:'shared',kind:'cooccurrence',types:['introduced_by'],label:'via Morgan'},
   ...['reciprocal','incoming'].map(target=>({id:'connector-'+target,source:'unknown',target,kind:'cooccurrence',label:'Recorded together'})),
   {id:'shared-email-context',source:'outreach',target:'shared',kind:'cooccurrence',types:['shared_email'],label:'Shared email'},
  ],themes:[{id:'context',canonicalName:'product demo',status:'active'}],themeSignals:[]};
  const signal=(id,personId,sourceType,summary,observedAt)=>({id,personId,themeId:'context',sourceType,visibility:'private',summary,observedAt,ingestedAt:observedAt,confidence:1,evidenceRef:'account:'+id,contentHash:id,extractorVersion:'fixture'});
  window.connectionFixture.themeSignals=[
   ...Array.from({length:24},(_,i)=>signal('metadata-'+i,'outreach','gmail_subject','Subject metadata matched Product Demo',`2026-10-${String(i+1).padStart(2,'0')}T12:00:00Z`)),
   signal('metadata-only','incoming','gmail_subject','Subject metadata matched Product Demo','2026-10-20T12:00:00Z'),
   signal('real-body','outreach','gmail_body_derived','Could you send the working prototype?','2026-09-30T12:00:00Z'),
   signal('real-meeting','outreach','granola','We discussed feedback on the prototype.','2026-09-29T12:00:00Z'),
   signal('real-note','outreach','obsidian_note','Product research partner.','2026-09-28T12:00:00Z'),
  ];
  window.connectionGraph=mountGraph(document.querySelector('#graph'),{graph:window.connectionFixture,onConnectionOrigin:(id,signal)=>{
   window.connectionCalls.push({id,signal});
   if(id==='delayed')return new Promise(resolve=>{window.connectionPending[id]=resolve;});
   return Promise.resolve(window.connectionResponses[id]);
  }});
 });
 const panel=page.getByRole('region',{name:'Selected item and connections'});
 const cases=[
  {id:'reciprocal',name:'Jordan Rivera',line:'Introduced by Analisa',detail:'12 sent · 7 received · 2 meeting records. From your imported history.'},
  {id:'incoming',name:'Maya Chen',line:'They’ve emailed you',detail:'0 sent · 3 received. From your imported history.'},
  {id:'unknown',name:'Avery Stone',line:'In your network',detail:'The imported records don’t say how you first connected.'},
  {id:'shared',name:'Sam Patel',line:'Shared by Morgan Lee',detail:'This person was shared into your network. A share does not record an introduction.'},
  {id:'outreach',name:'outreach Person',line:'You emailed about Product demo',detail:'4 sent · 3 received · 1 meeting record. From your imported history.',emailContext:true},
  {id:'reply',name:'reply Person',line:'They emailed you about Re: <b>Product demo</b>',detail:'4 sent · 3 received · 1 meeting record. From your imported history.',emailContext:true},
  {id:'blank',name:'blank Person',line:'You’ve exchanged emails',detail:'4 sent · 3 received · 1 meeting record. From your imported history.',emailContext:true},
 ];
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});
  for(const sample of cases){
   await page.evaluate(id=>window.connectionGraph.select(id),sample.id);
   const heading=panel.getByRole('heading',{level:2,name:sample.name,exact:true});await heading.waitFor();
   const summary=panel.locator('.rg-how-you-know'),line=summary.locator('.rg-connection-line'),details=summary.locator('details').filter({has:page.getByText('Connection details',{exact:true})});
   await page.waitForFunction(expected=>document.querySelector('.rg-connection-line')?.textContent===expected,sample.line);
   assert.equal(await line.innerText(),sample.line,`${sample.id} has the evidence-supported direction at ${width}px`);
   if(['reciprocal','incoming'].includes(sample.id))assert.equal(await panel.getByRole('button',{name:/^Request intro from /}).count(),0,'existing direct contacts do not ask for a new introduction');
   if(sample.id==='shared')assert.equal(await panel.getByRole('button',{name:'Request intro from Avery Stone'}).count(),1,'shared-only contacts retain introduction choices');
   assert.equal(await heading.evaluate(node=>node.nextElementSibling?.matches('.rg-how-you-know')&&node.nextElementSibling.firstElementChild?.matches('.rg-connection-line')),true,'connection summary is immediately below the person name');
   assert.equal(await details.evaluate(node=>node.open),false,'counts and caveats start collapsed');
   assert.equal(await details.locator('p').first().isVisible(),false);
   await details.getByText('Connection details',{exact:true}).click();
   assert.equal(await details.locator('p').first().innerText(),sample.detail);
   assert.equal(await details.locator('p').first().isVisible(),true,'disclosure exposes the actual counts or the evidence limitation');
   if(sample.id!=='reciprocal')assert.equal(await details.getByText('No introduction email found in the messages checked.',{exact:true}).count(),1,'bounded search outcome is kept in details, not the headline');
   if(sample.emailContext){
    const source=summary.locator('details').filter({has:page.getByText('Email context',{exact:true})});
    assert.equal(await source.evaluate(node=>node.open),false);
    await source.getByText('Email context',{exact:true}).click();
    const expected=await page.evaluate(id=>window.connectionResponses[id].connection,sample.id);
    assert.equal(await source.locator('blockquote').innerText(),expected.quote);
    assert.equal(await source.locator('.rg-introduction-subject').textContent(),expected.subject||'(No subject)');
    assert.equal(await source.locator('img,b').count(),0,'direct source fields are plain text');
    assert.equal(await source.getByRole('link',{name:'Open in Gmail'}).count(),sample.id==='reply'?0:1,'direct source uses the same strict Gmail link policy');
    assert.equal(await summary.getByText('Introduction email',{exact:true}).count(),0,'a direct message is not mislabeled as an introduction');
    assert.doesNotMatch(await line.innerText(),/introduced|first|Morgan/,'shared edges and people named in the quote do not create an introduction claim');
   }
   if(sample.id==='outreach'){
    const recent=panel.locator('section').filter({has:page.getByRole('heading',{name:'Recent context',exact:true})});
    assert.equal(await recent.locator('.nc-memory').count(),3);
    for(const text of ['Could you send the working prototype?','We discussed feedback on the prototype.','Product research partner.'])assert.equal(await recent.getByText(text,{exact:true}).count(),1,'older substantive context survives newer metadata matches');
    assert.doesNotMatch(await recent.innerText(),/Subject metadata matched/);
    if(width!==320)await page.screenshot({path:width===1280?'/tmp/person-email-context-desktop.png':'/tmp/person-email-context-mobile.png'});
   }
   if(sample.id==='incoming')assert.equal(await panel.getByRole('heading',{name:'Recent context',exact:true}).count(),0,'metadata-only context is not promoted into the recent-context panel');
   if(sample.id==='reciprocal'){
    const intro=summary.locator('details').filter({has:page.getByText('Introduction email',{exact:true})});
    assert.equal(await intro.evaluate(node=>node.open),false,'private quote starts collapsed');
    await intro.getByText('Introduction email',{exact:true}).click();
    assert.equal(await intro.locator('blockquote').innerText(),'I’d like to introduce you to Jordan. <img src=x onerror=alert(1)>');
    assert.equal(await intro.locator('img').count(),0,'source quote is plain text');
    assert.match(await intro.innerText(),/Introducing Jordan and you/);
    assert.equal(await intro.getByRole('link',{name:'Open in Gmail'}).getAttribute('href'),'https://mail.google.com/mail/u/0/#all/123abc');
   }
   if(['unknown','shared'].includes(sample.id)){
    assert.doesNotMatch(await line.innerText(),/introduced|exchanged|emailed|you met/i,'sharing and undirected intro edges cannot invent personal history');
    assert.doesNotMatch(await summary.innerText(),/888|777|66/,'another contributor’s counts are not the viewer’s activity');
   }
   const bounds=await summary.evaluate(node=>{const r=node.getBoundingClientRect(),h=node.previousElementSibling.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,headingBottom:h.bottom,scroll:node.scrollWidth,width:node.clientWidth,viewport:innerWidth,pageWidth:document.documentElement.scrollWidth};});
   assert.ok(bounds.top>=bounds.headingBottom&&bounds.top-bounds.headingBottom<=24,'summary stays visually adjacent to the name');
   assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport+1&&bounds.scroll<=bounds.width+1&&bounds.pageWidth<=bounds.viewport+1,`no horizontal overflow for ${sample.id} at ${width}px`);
   if(sample.id==='reciprocal'&&width!==320){await heading.scrollIntoViewIfNeeded();await page.screenshot({path:width===1280?'/tmp/person-connection-desktop.png':'/tmp/person-connection-mobile.png'});}
  }
 }
 assert.equal(await page.evaluate(()=>window.connectionCalls.filter(call=>call.id==='reciprocal').length),1,'reselecting and resizing reuse the mounted graph cache');
 await page.evaluate(()=>window.connectionGraph.select('disabled'));
 await panel.getByText('Connect Gmail conversation context to find introductions',{exact:true}).waitFor();
 assert.equal(await panel.getByRole('link',{name:'Manage Gmail context'}).getAttribute('href'),'/accounts.html');
 await page.evaluate(()=>window.connectionGraph.select('retry'));
 await panel.getByRole('button',{name:'Retry introduction lookup'}).waitFor();
 await page.evaluate(()=>{window.connectionResponses.retry={status:'found',origin:{...window.connectionResponses.reciprocal.origin,introducerName:'Taylor',subject:''}};});
 await panel.getByRole('button',{name:'Retry introduction lookup'}).click();
 await panel.getByText('Introduced by Taylor',{exact:true}).waitFor();
 assert.equal(await panel.locator('.rg-introduction-subject').textContent(),'(No subject)','an email without a subject can still record a verified introduction');
 assert.equal(await page.evaluate(()=>window.connectionCalls.filter(call=>call.id==='retry').length),2,'retry issues a new lookup');
 await page.evaluate(()=>window.connectionGraph.select('unsafe'));
 await panel.getByText('Introduced by Analisa <b>Example</b>',{exact:true}).waitFor();
 await panel.getByText('Introduction email',{exact:true}).click();
 assert.equal(await panel.locator('.rg-how-you-know b').count(),0);
 assert.equal(await panel.getByRole('link',{name:'Open in Gmail'}).count(),0,'lookalike Gmail host is never linked');
 assert.equal(await panel.locator('.rg-how-you-know').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'long source text wraps on mobile');
 await page.evaluate(()=>window.connectionGraph.select('delayed'));
 await panel.getByText('Looking for your introduction…',{exact:true}).waitFor();
 await page.evaluate(()=>{window.connectionGraph.select('incoming');window.connectionPending.delayed(window.connectionResponses.reciprocal);});
 await panel.getByText('They’ve emailed you',{exact:true}).waitFor();
 assert.equal(await panel.getByRole('heading',{level:2}).innerText(),'Maya Chen','late response cannot replace the selected person');
 // Replacing the graph invalidates both cached and pending private responses.
 await page.evaluate(()=>{window.connectionGraph.setGraph(window.connectionFixture);window.connectionGraph.select('delayed');});
 await panel.getByText('Looking for your introduction…',{exact:true}).waitFor();
 const beforeShared=await page.evaluate(()=>window.connectionCalls.length);
 await page.evaluate(()=>{window.connectionGraph.setGraph({...window.connectionFixture,source:'workspace'});window.connectionPending.delayed(window.connectionResponses.reciprocal);window.connectionGraph.select('unknown');});
 assert.equal(await page.evaluate(()=>window.connectionCalls.length),beforeShared,'workspace never invokes the private callback');
 assert.equal(await page.evaluate(()=>window.connectionCalls.filter(call=>call.id==='delayed').at(-1).signal.aborted),true);
 assert.doesNotMatch(await panel.locator('.rg-connection-line').innerText(),/Introduced by/);
 await page.evaluate(()=>{window.connectionGraph.setGraph(window.connectionFixture);window.connectionGraph.select('delayed');});
 await panel.getByText('Looking for your introduction…',{exact:true}).waitFor();
 await page.evaluate(()=>{window.connectionGraph.destroy();window.connectionPending.delayed(window.connectionResponses.reciprocal);});
 assert.equal(await page.locator('#graph').innerText(),'','detached graph remains empty after a late response');
 assert.deepEqual(errors,[]);
 console.log('PASS person connection browser: automatic introducer lookup, exact source disclosure, private cache and stale-result isolation, retry and disabled states, safe text/links, desktop and mobile layout');
}catch(error){console.error(error);process.exitCode=1;}
finally{
 server.closeAllConnections();server.close();
 try{if(browser)await boundedClose(()=>browser.close());if(browserServer)await boundedClose(()=>browserServer.close());}
 catch(error){console.warn('Browser assertions finished; forced cleanup after '+error.message);browserServer?.process()?.kill('SIGKILL');}
 clearTimeout(watchdog);
 // A macOS Chrome shutdown can leave Playwright transport handles alive after its
 // child has exited. All assertions have completed and owned resources are closed.
 process.exit(process.exitCode||0);
}
