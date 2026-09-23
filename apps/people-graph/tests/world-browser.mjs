import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4183';
 await page.goto(base+'/world/');await page.locator('.entry').first().waitFor();assert.equal(await page.locator('.entry').count(),6);
 await page.screenshot({path:'/tmp/people-world-town.png',fullPage:true});
 await page.locator('.entry').first().click();assert.equal(await page.locator('.entry').count(),8);assert.equal(await page.locator('#place').innerText(),'THE OFFICE');
 await page.screenshot({path:'/tmp/people-world-office.png',fullPage:true});
 await page.locator('.entry').first().click();await page.getByRole('button',{name:'Add to shortlist',exact:true}).click();assert.equal(await page.locator('#saved-count').innerText(),'1');
 await page.locator('#context-tab').click();await page.locator('.context-entry').first().click();assert.equal(await page.locator('.context-entry[aria-pressed=true]').count(),1);
 await page.locator('#query').fill('zzznomatches');await page.locator('#search').evaluate(f=>f.requestSubmit());await page.getByText('No matching people.',{exact:false}).waitFor();await page.locator('#clear').click();
 await page.locator('#back').click();await page.waitForFunction(()=>document.querySelector('#place').textContent==='TOWN MAP');await page.goForward();await page.waitForFunction(()=>document.querySelector('#place').textContent==='THE OFFICE');
 await page.locator('#pause').click();assert.equal(await page.locator('#pause').innerText(),'Resume walking');await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#pause').disabled);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/people-world-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.route('**/api/graph',r=>r.fulfill({status:401,body:'{}'}));await page.locator('#source').click();await page.getByRole('link',{name:'Open sign-in ↗'}).waitFor();assert.equal(await page.locator('#source-label').innerText(),'FICTIONAL DEMO');
 await page.unroute('**/api/graph');await page.route('**/api/graph',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({graph:{nodes:Array.from({length:20},(_,i)=>({id:'p'+i,name:'Private Person '+i,company:'x'.repeat(100)+'.example.com'})),edges:[]}})}));await page.locator('#source').click();await page.waitForFunction(()=>document.querySelector('#source-label').textContent==='PRIVATE NETWORK');assert.equal(await page.locator('.entry').count(),1);await page.locator('.entry').click();assert.equal(await page.locator('.entry').count(),16);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long company wraps on mobile');await page.locator('#next').click();assert.equal(await page.locator('.entry').count(),4);assert.equal(await page.locator('#page').innerText(),'2 / 2');assert.ok(!page.url().includes('Example'));
 await page.locator('#source').click();assert.equal(await page.locator('#source-label').innerText(),'FICTIONAL DEMO');assert.equal(await page.locator('#saved-count').innerText(),'0');assert.equal(await page.locator('#place').innerText(),'TOWN MAP');assert.deepEqual(errors,[]);
 await page.route('**/pixel-harness',r=>r.fulfill({contentType:'text/html',body:'<canvas style="width:1000px;height:700px"></canvas>'}));await page.setViewportSize({width:1200,height:900});await page.goto(base+'/pixel-harness');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(async()=>{const {PixelWorld}=await import('/world/pixels.mjs');window.picks=[];window.scene=new PixelWorld(document.querySelector('canvas'),h=>picks.push(h));scene.set({mode:'office',items:Array.from({length:8},(_,i)=>({id:'p'+i,name:'Person '+i}))});});
 await page.waitForTimeout(180);assert.ok(await page.evaluate(()=>scene.time>0));await page.evaluate(()=>scene.toggle());const time=await page.evaluate(()=>scene.time);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>scene.time),time);
 const pt=await page.evaluate(()=>{const h=scene.hits.find(h=>h.id==='p3'),r=scene.canvas.getBoundingClientRect();return {x:r.x+scene.ox+(h.x+h.w/2)*scene.zoom,y:r.y+scene.oy+(h.y+h.h/2)*scene.zoom};});await page.mouse.click(pt.x,pt.y);assert.equal(await page.evaluate(()=>picks.at(-1).id),'p3');await page.mouse.move(0,0);assert.equal(await page.evaluate(()=>scene.hovered),null);await page.evaluate(()=>scene.dispose());assert.equal(await page.evaluate(()=>scene.frame),null);

 console.log('PASS: town/office, person details, shortlist, context, search, history, motion, mobile, auth gating, private pagination and source reset.');
} finally {await browser.close();}
