import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/path-test',r=>r.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"><link rel="stylesheet" href="/atlas.css"><main id="graph"></main>'}));
 await page.goto('http://127.0.0.1:4196/path-test');
 await page.evaluate(async()=>{const {mountGraph}=await import('/relationship-graph/graph.mjs');const r=memberId=>({memberId,memberName:memberId,evidenceCategory:'email',lastContact:'2026-09-20'});window.g={source:'workspace',workspaceId:'w',members:[{id:'j',name:'John'},{id:'k',name:'Kaya',isMe:true}],nodes:[{id:'a',name:'Alice',type:'person',relationships:[r('j')]},{id:'m',name:'Mutual',type:'person',relationships:[r('j'),r('k')]},{id:'b',name:'Bob',type:'person',relationships:[r('k')]}],edges:[]};window.app=mountGraph(document.querySelector('#graph'),{graph:g});});
 assert.equal(await page.getByRole('link',{name:'Invite to network ↗'}).getAttribute('href'),'/accounts?tab=workspace&workspace=w');
 await page.getByRole('button',{name:'Find a path ↗'}).click();await page.getByLabel('To person search',{exact:true}).fill('Bob');await page.getByLabel('Path destination person',{exact:true}).selectOption('b');
 await page.getByRole('list',{name:'Connection path step by step'}).waitFor();assert.equal(await page.locator('.rg-path-step').count(),5);assert.equal(await page.getByRole('button',{name:'Save this path',exact:true}).count(),0);assert.ok((await page.locator('.rg-path-walk').innerText()).includes('John'));assert.ok((await page.locator('.rg-path-walk').innerText()).includes('2026-09-20'));await page.screenshot({path:'/tmp/shared-path-desktop.png',fullPage:true});
 await page.locator('.rg-path-step').last().getByRole('button',{name:'View person'}).click();await page.getByRole('dialog').getByRole('heading',{name:'Bob',exact:true}).waitFor();await page.getByRole('button',{name:'Close person sheet'}).click();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/shared-path-mobile.png',fullPage:true});
 await page.evaluate(()=>app.setGraph({...g,members:[g.members[0]]}));await page.getByText('No recorded people path between Alice and Bob.').waitFor();assert.equal(await page.locator('.rg-path-step').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS cross-contributor route, endpoint search, evidence walk, person sheet, mobile and removal invalidation');
}finally{await browser.close();}
