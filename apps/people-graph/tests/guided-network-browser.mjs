import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/guided-test',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"><link rel="stylesheet" href="/atlas.css"><main id="graph"></main>'}));
 await page.goto((process.env.TEST_ORIGIN||'http://127.0.0.1:4198')+'/guided-test');
 await page.evaluate(async()=>{const {mountGraph}=await import('/relationship-graph/graph.mjs');const r=memberId=>({memberId,memberName:memberId,evidenceCategory:'email',score:44,lastContact:'2026-09-20'});window.g={source:'workspace',workspaceId:'w',members:[{id:'j',name:'John'},{id:'k',name:'Kaya',isMe:true}],nodes:[{id:'a',name:'Alice',type:'person',relationships:[r('j')]},{id:'m',name:'Mutual',type:'person',relationships:[r('j'),r('k')]},{id:'b',name:'Bob',type:'person',relationships:[r('k')]},{id:'c',name:'Cora',type:'person',relationships:[]}],edges:[{id:'mc',source:'m',target:'c',kind:'cooccurrence',evidence:[{text:'Mentioned in the same note',date:'2026-09-20'}]}]};window.app=mountGraph(document.querySelector('#graph'),{graph:g});});
 await page.getByRole('region',{name:'Start exploring'}).waitFor();assert.equal(await page.locator('.rg-start-card').count(),0);await page.getByRole('button',{name:'Shared contacts · 1',exact:true}).waitFor();
await page.locator('.rg-node[data-node-id="a"]').click();await page.getByRole('button',{name:'Next step',exact:true}).click();
 assert.match(await page.getByRole('navigation',{name:'Path taken'}).innerText(),/You.*Mutual.*John.*Alice/s);
 assert.equal(await page.locator('.rg-canvas').evaluate(el=>getComputedStyle(el).visibility),'visible');
 assert.equal(await page.locator('.nc-nearby').count(),0);await page.getByRole('button',{name:'Find people for Mutual',exact:true}).waitFor();
 const beforeRefresh=await page.locator('.nc-walk-progress').innerText();
 await page.evaluate(()=>app.setGraph({...g,workspaceName:'Updated network'},{preserveFocus:true}));
 assert.equal(await page.locator('.nc-walk-stage').count(),1,'background refresh keeps the open person');
 assert.equal(await page.locator('.nc-walk-progress').innerText(),beforeRefresh);
 await page.getByRole('button',{name:'Back to network',exact:true}).click();
 await page.evaluate(()=>app.setGraph({...g,nodes:[...g.nodes,...Array.from({length:5000},(_,i)=>({id:'extra'+i,name:'Contact '+i,type:'person',relationships:[]}))]}));
 assert.ok((await page.locator('.rg-canvas-note').innerText()).includes('focused overview of 5004'));
 const neighborhoodCamera=await page.locator('.rg-scene').getAttribute('style');await page.getByRole('button',{name:'Fit',exact:true}).click();assert.equal(await page.locator('.rg-scene').getAttribute('style'),neighborhoodCamera,'Larger neighborhood should open fitted, not at a forced portrait scale');
await page.screenshot({path:'/tmp/guided-network-overview.png'});await page.getByRole('button',{name:'Show all 5004 people',exact:true}).click();assert.ok(!(await page.locator('.rg-canvas-note').innerText()).includes('focused overview'));await page.getByRole('button',{name:'Focused overview',exact:true}).click();
 await page.evaluate(()=>app.setSearchAnswer({query:'no match',results:[]}));assert.ok(!(await page.locator('.rg-canvas-note').innerText()).includes('focused overview'));await page.getByRole('button',{name:'Show all 5004 people',exact:true}).click();await page.getByRole('button',{name:'Focused overview',exact:true}).click();assert.match(await page.locator('.rg-canvas-note').innerText(),/12 people on map.*focused overview/);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('.rg-start-card').count(),0);await page.locator('.rg-node[data-node-id="m"]').click();await page.getByRole('navigation',{name:'Path taken'}).waitFor();await page.screenshot({path:'/tmp/guided-network-mobile.png'});
 assert.deepEqual(errors,[]);console.log('PASS guided network branching, return, visible graph, large overview, mobile');
}finally{await browser.close();}
