import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/weekly-test',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"><link rel="stylesheet" href="/atlas.css"><main id="graph"></main>'}));
 await page.goto((process.env.TEST_ORIGIN||'http://127.0.0.1:4198')+'/weekly-test');
 await page.evaluate(async()=>{
  const {mountGraph}=await import('/relationship-graph/graph.mjs');const now=Date.now();
  const r=memberId=>({memberId,memberName:memberId,evidenceCategory:'email',activity:{sent:2,received:2,meetings:0}});
  const n=(id,name,owners)=>({id,name,type:'person',relationships:owners.map(r)});
  const s=(id,owner,personId,themeId,days)=>({id,personId,themeId,sourceType:'granola',visibility:'firm',observedAt:new Date(now-days*86400000).toISOString(),ingestedAt:new Date(now).toISOString(),confidence:1,summary:'Discussed '+(themeId==='tools'?'developer tools':'product design'),evidenceRef:'workspace:'+owner+':'+id,contentHash:id,extractorVersion:'test'});
  window.g={source:'workspace',workspaceId:'w',revision:1,members:[{id:'me',name:'Kaya',isMe:true},{id:'them',name:'Sophie'}],nodes:[...Array.from({length:30},(_,i)=>n('filler'+i,'Contact '+i,[])),n('context','Sam',['me']),n('expert','Alex',['them']),n('their-context','Robin',['them']),n('my-expert','Jamie',['me']),n('mutual','Morgan',['me','them'])],edges:[],themes:[{id:'tools',name:'Developer tools'},{id:'design',name:'Product design'}],themeSignals:[s('a','me','context','tools',1),s('b','them','expert','tools',20),s('c','them','their-context','design',1),s('d','me','my-expert','design',20),s('e','them','mutual','tools',2)]};
  window.app=mountGraph(document.querySelector('#graph'),{graph:g});
 });
 const forYou=page.getByRole('region',{name:'Relevant to your week',exact:true});
 const forOthers=page.getByRole('region',{name:'People you could help with',exact:true});
 await forYou.getByRole('button',{name:'Alex',exact:true}).waitFor();await forOthers.getByRole('button',{name:'Jamie',exact:true}).waitFor();
 await page.getByRole('region',{name:'People you share',exact:true}).getByRole('button',{name:'Morgan',exact:true}).waitFor();
 assert.equal(await page.locator('.rg-node[data-node-id="expert"]').count(),1);
 await forYou.getByText('Why this person?',{exact:true}).first().click();assert.match(await forYou.innerText(),/you/);assert.match(await forYou.innerText(),/Sophie/);
 await page.getByText('What this week is based on',{exact:true}).click();
 await page.getByRole('checkbox',{name:'Include Developer tools in my week'}).uncheck();
 assert.equal(await forYou.getByRole('button',{name:'Alex',exact:true}).count(),0);assert.equal(await forOthers.getByRole('button',{name:'Jamie',exact:true}).count(),1);
 await page.evaluate(()=>app.setGraph({...g,pushedAt:new Date().toISOString()}));
 assert.equal(await forYou.getByRole('button',{name:'Alex',exact:true}).count(),0);
 await page.getByRole('button',{name:'Reset my topic adjustments'}).click();await forYou.getByRole('button',{name:'Alex',exact:true}).waitFor();
 await forYou.getByRole('button',{name:'Alex',exact:true}).click();await page.getByRole('button',{name:'Back to network',exact:true}).click();
 await page.screenshot({path:'/tmp/people-weekly-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('.rg-weekly').count(),1);
 await page.screenshot({path:'/tmp/people-weekly-mobile-top.png'});
 await forYou.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/people-weekly-mobile-matches.png'});
 await page.evaluate(()=>app.setGraph({...g,themeSignals:[]}));assert.match(await forYou.innerText(),/No supported matches/);
 assert.deepEqual(errors,[]);console.log('PASS weekly context, both directions, map, corrections, refresh, person view, empty state and mobile');
}finally{await browser.close();}
