import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/topic-test',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"><link rel="stylesheet" href="/atlas.css"><main id="graph"></main>'}));
 await page.goto('http://127.0.0.1:4198/topic-test');
 await page.evaluate(async()=>{
 const {mountGraph}=await import('/relationship-graph/graph.mjs');const s=(id,personId,themeId,summary,date='2026-09-20T12:00:00Z')=>({id,personId,themeId,summary,sourceType:'granola',observedAt:date,ingestedAt:date,visibility:'firm',confidence:1,evidenceRef:'workspace:j:'+id,contentHash:id,extractorVersion:'test',provenance:{title:'Agents and memory',canonicalUrl:'https://granola.ai/d/example',publisherHost:'granola.ai',observedAt:date,retrievedAt:date,timeBasis:'observed'}});
 window.app=mountGraph(document.querySelector('#graph'),{graph:{source:'workspace',workspaceId:'w',themes:[{id:'m',name:'Agent memory'},{id:'m2',name:'Agent memory'},{id:'d',name:'Design'}],members:[{id:'k',name:'Kaya',isMe:true},{id:'j',name:'John'}],nodes:['Alex','Becca','Kaspian','Other'].map((name,i)=>({id:String(i),name,type:'person',relationships:[{memberId:'j',memberName:'John',evidenceCategory:'email'}]})),edges:[],themeSignals:[s('s1','0','m','Interest: Building agent memory'),s('s2','1','m2','Commitment: Send the memory prototype'),s('s3','2','m','Recorded topic: Agent memory'),s('s4','3','d','Unrelated design discussion','2026-09-24T12:00:00Z')]}});
 });
 await page.getByRole('button',{name:'Agent memory · 3 people',exact:true}).click();const panel=page.getByRole('complementary',{name:'Agent memory topic context'});await panel.waitFor();
 assert.equal(await page.locator('.rg-canvas .rg-node').count(),3);assert.ok(await page.locator('.rg-canvas .rg-node').first().evaluate(el=>el.getAnimations().length>0));
 assert.ok((await panel.textContent()).includes('Send the memory prototype'));assert.ok(!(await panel.textContent()).includes('Unrelated design'));assert.ok((await panel.textContent()).includes('Latest shared record · 2026-09-20'));
 assert.ok(await panel.evaluate(el=>{const p=el.getBoundingClientRect(),v=document.querySelector('.rg-map-viewport').getBoundingClientRect();return p.x>=v.right&&p.right<=innerWidth;}));
 await page.waitForTimeout(900);await page.screenshot({path:'/tmp/topic-cluster-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/topic-cluster-mobile.png'});
 await panel.getByRole('button',{name:'Close topic context'}).click();assert.equal(await panel.count(),0);await page.getByRole('button',{name:'Clear filter',exact:true}).click();
 await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Agent memory · 3 people',exact:true}).click();assert.equal(await page.locator('.rg-canvas .rg-node').first().evaluate(el=>el.getAnimations().length),0);
 await panel.getByRole('button',{name:/Becca Last topic/}).click();await page.getByRole('heading',{name:'Explore Becca',exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('PASS merged topic counts, animated cluster, scoped recap, mobile, reduced motion and person navigation');
}finally{await browser.close();}
