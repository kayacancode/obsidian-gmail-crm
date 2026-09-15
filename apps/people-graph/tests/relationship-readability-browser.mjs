import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const origin = process.env.PEOPLE_TEST_ORIGIN || 'http://127.0.0.1:4183';
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1596, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(4000);
  await page.route('**/readability-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/relationship-graph/graph.css"></head><body style="margin:0"><div id="graph"></div></body></html>' }));
  await page.goto(`${origin}/readability-fixture`);
  await page.evaluate(async () => {
    const { mountGraph } = await import('/relationship-graph/graph.mjs');
    const stamp = '2026-09-14T12:00:00Z';
    const names = ['Agent memory', 'Design review', 'Developer tools', 'Research', 'Collaboration', ...Array.from({length:118}, (_,i) => `Updated Invitation ${i}`)];
    const nodes = Array.from({length:115}, (_,i) => ({id:`p${i}`,name:`Person ${i} With A Longer Name`,role:'Chief Product Strategy Officer',company:'Example Company',type:'person'}));
    const signals = names.flatMap((name,i) => (i===122 ? [nodes[114]] : nodes.slice(0,80).filter((_,j)=>j%3===i%3)).map(node=>({id:`s${i}-${node.id}`,themeId:`t${i}`,personId:node.id,visibility:'private',sourceType:'gmail_subject',summary:name,confidence:.8,observedAt:stamp,ingestedAt:stamp,evidenceRef:`e${i}-${node.id}`,contentHash:'fixture',extractorVersion:'metadata-v1'})));
    window.readabilityData = {nodes,edges:[{id:'tie',source:'p0',target:'p1',kind:'cooccurrence',label:'shared email'},{id:'bridge',source:'p1',target:'p114',kind:'personal',label:'worked with'}],themes:names.map((name,i)=>({id:`t${i}`,name})),themeSignals:signals,relevance:{version:1,lens:'my',calculatedAt:stamp,scoreVersion:'relevance-v1',themes:names.map((name,i)=>({themeId:`t${i}`,name,score:90,reason:'Gmail Subject evidence',nodeIds:signals.filter(s=>s.themeId===`t${i}`).map(s=>s.personId),components:signals.filter(s=>s.themeId===`t${i}`).map(s=>({signalId:s.id,sourceType:s.sourceType,observedAt:stamp,contribution:10}))})),connectors:[],discoveries:[]}};
    window.readabilityGraph = mountGraph(document.querySelector('#graph'), {graph:window.readabilityData});
  });
  const check = async (name, fn) => { try { await fn(); console.log(`PASS: ${name}`); } catch(error) { failures.push(`${name}: ${error.message}`); console.error(`FAIL: ${name}: ${error.message}`); } };
  for (const width of [1596, 859, 390, 320]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    await check(`full network is on the map at ${width}px`, async () => {
      assert.equal(await page.locator('.rg-node').count(),115,'overview must not sample the network');
      const canvas=await page.locator('.rg-canvas').boundingBox();
      const topic=await page.getByRole('region',{name:'Topics and themes'}).boundingBox();
      const rects=await page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
      assert.ok(rects.every(r=>r.left>=canvas.x&&r.right<=canvas.x+canvas.width&&r.top>=topic.y+topic.height&&r.bottom<=canvas.y+canvas.height-60),'Fit must frame every portrait below the theme controls');
      assert.doesNotMatch(await page.locator('.rg-canvas-note').innerText(),/more in search/);
    });
    for (const zoom of [1,.75]) {
    if(zoom<1) for(let i=0;i<3;i++) await page.locator('[data-action="zoom-out"]').click();
    await check(`portraits, long labels and badges do not overlap at ${width}px / ${zoom} zoom`, async () => {
      const collisions = await page.locator('.rg-node').evaluateAll(nodes => {
        const rects=nodes.map(n=>{const parts=[n,n.querySelector('.rg-node-label'),n.parentNode.querySelector(`.rg-person-heat[data-person-id="${n.dataset.nodeId}"]`)].filter(Boolean).map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);return {left:Math.min(...parts.map(r=>r.left)),right:Math.max(...parts.map(r=>r.right)),top:Math.min(...parts.map(r=>r.top)),bottom:Math.max(...parts.map(r=>r.bottom))}});
        let count=0;for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)count++;}return count;
      });
      assert.equal(collisions,0);
    });
    await check(`topics visible above people at ${width}px`, async () => {
      const panel=page.getByRole('region',{name:'Topics and themes'});
      assert.equal(await panel.count(),1);
      const box=await panel.boundingBox();assert.ok(box.y>=0&&box.y+box.height<900);
      const first=await page.locator('.rg-node').first().boundingBox();assert.ok(first.y>=box.y+box.height+12);
      for(const badge of await page.locator('.rg-person-heat').all()) { const r=await badge.boundingBox();if(r)assert.ok(r.y>box.y+box.height,'why-now controls cannot be covered by the topic bar'); }
      assert.match(await panel.innerText(),/subject/i);
      assert.equal(await page.getByLabel('Browse all themes').locator('option').count(),124);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    });
    }
    await page.locator('[data-action="fit"]').click();
  }
  await check('overview has bounded heat and no field of anonymous dots', async () => {
    assert.ok(await page.locator('.rg-theme-field').count()<=3);
    assert.ok(await page.locator('.rg-person-heat').count()<=3);
    assert.equal(await page.getByRole('button',{name:'•',exact:true}).count(),0);
    const layers = await page.locator('.rg-theme-field').evaluateAll(nodes=>nodes.map(n=>({opacity:Number(getComputedStyle(n).opacity),background:getComputedStyle(n).backgroundImage})));
    assert.ok(layers.every(layer=>layer.opacity>=.18&&layer.opacity<=.46));
    assert.ok(layers.every(layer=>layer.background.includes('125px 105px')),'heat extends visibly beyond the photo footprint');
  });
  await page.setViewportSize({width:1596,height:900});
  await page.waitForTimeout(100);
  await check('unpromoted themes remain discoverable and select one focused field', async () => {
    await page.getByLabel('Browse all themes').selectOption('t122');
    assert.equal(await page.locator('.rg-theme-field').count(),1);
    assert.equal(await page.locator('.rg-node[data-node-id="p114"]').count(),1);
    assert.equal(await page.locator('.rg-node').count(),115,'theme focus must retain the network');
    const viewport=await page.locator('.rg-map-viewport').boundingBox();
    const person=await page.locator('.rg-node[data-node-id="p114"]').boundingBox();
    assert.ok(person.x>=viewport.x&&person.x+person.width<=viewport.x+viewport.width&&person.y>=viewport.y&&person.y+person.height<=viewport.y+viewport.height,'theme focus brings its distant member into view');
    assert.equal(await page.getByLabel('Browse all themes').evaluate(n=>n===n.ownerDocument.activeElement),true);
    assert.match(await page.getByLabel('Why this is hot now',{exact:true}).innerText(),/Updated Invitation 117/);
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return [n.dataset.nodeId,r.x,r.y,r.width];}));
    const before=await positions();await page.getByLabel('Relevance now').selectOption('off');
    assert.deepEqual(await positions(),before,'Off preserves the selected-theme arrangement');
    await page.getByRole('button',{name:'Relationships',exact:true}).click();
    assert.equal(await page.locator('.rg-node').first().getAttribute('data-node-id'),'p0','overview clears retained ordering in Off');
    await page.getByLabel('Relevance now').selectOption('my');
    await page.getByLabel('Browse all themes').selectOption('t122');
    await page.getByLabel('Relevance now').selectOption('off');
    await page.getByRole('searchbox').fill('Person 0');
    await page.locator('.rg-node[data-node-id="p0"]').click();
    assert.equal(await page.locator('.rg-node[data-node-id="p0"][data-active="true"]').count(),1,'explicit selection clears retained theme ordering in Off');
    assert.equal(await page.locator('.rg-node').first().getAttribute('data-node-id'),'p0');
    await page.getByRole('button',{name:'Relationships',exact:true}).click();
    assert.equal(await page.locator('.rg-node').first().getAttribute('data-node-id'),'p0','overview clears retained ordering in Off');
    await page.getByLabel('Relevance now').selectOption('my');
    await page.getByRole('button',{name:'All themes',exact:true}).click();
  });
  await check('selection keeps context readable and reserves room for details', async () => {
    await page.locator('.rg-node[data-node-id="p0"]').click();
    const opacity=await page.locator('.rg-node[data-context="true"]').first().evaluate(n=>Number(getComputedStyle(n).opacity));assert.ok(opacity>=.5);
    const panel=await page.getByLabel('Selected item and connections').boundingBox();
    const viewport=await page.locator('.rg-map-viewport').boundingBox();assert.ok(viewport.x+viewport.width<panel.x,'panned map is clipped before the detail rail');
    const selected=await page.locator('.rg-node[data-node-id="p0"]').boundingBox();assert.ok(selected.x>=viewport.x&&selected.x+selected.width<=viewport.x+viewport.width);
    assert.equal(await page.locator('.rg-node').count(),115);
    assert.equal(await page.locator('.rg-node[data-node-id="p0"] .rg-node-label').isVisible(),true,'selection zoom reveals names');
  });
  await check('pan and zoom keep every person; Fit restores the whole network', async () => {
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width];}));
    const before=await positions();await page.locator('[data-action="canvas"]').press('ArrowRight');assert.notDeepEqual(await positions(),before);
    await page.locator('[data-action="zoom-in"]').click();assert.equal(await page.locator('.rg-node').count(),115);
    await page.locator('[data-action="fit"]').click();
    const viewport=await page.locator('.rg-map-viewport').boundingBox();
    assert.ok((await positions()).every(([x,y,width])=>x>=viewport.x&&x+width<=viewport.x+viewport.width&&y>=viewport.y&&y+width<=viewport.y+viewport.height));
    assert.equal(await page.locator('.rg-node .rg-node-label').first().isVisible(),false,'overview reduces label clutter, not the number of people');
  });
  await check('off removes heat without shifting people; all 115 remain searchable', async () => {
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>[n.dataset.nodeId,n.style.left,n.style.top,n.style.width]));
    const before=await positions();await page.getByLabel('Relevance now').selectOption('off');
    assert.deepEqual(await positions(),before);assert.equal(await page.locator('.rg-theme-field,.rg-person-heat').count(),0);
    await page.getByRole('searchbox').fill('Person 114');await page.locator('.rg-node[data-node-id="p114"]').waitFor();
  });
  await page.getByRole('button',{name:'Relationships',exact:true}).click();
  await check('path search cannot mix the world camera with route coordinates', async () => {
    await page.getByRole('button',{name:'Find a path ↗',exact:true}).click();
    await page.getByRole('searchbox').fill('Person 114');await page.locator('.rg-node[data-node-id="p114"]').click();
    await page.getByRole('button',{name:'Save this path',exact:true}).waitFor();
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width];}));
    const canvas=await page.locator('.rg-canvas').boundingBox();
    assert.ok((await positions()).every(([x,y,w])=>x>=canvas.x&&x+w<=canvas.x+canvas.width&&y>=canvas.y&&y+w<=canvas.y+canvas.height),'route portraits must stay in frame after searching for a destination');
    const before=await positions();await page.getByRole('searchbox').fill('Person 1');assert.deepEqual(await positions(),before,'search cannot pan the active route');
    await page.getByRole('searchbox').fill('');await page.getByRole('button',{name:'← Canvas',exact:true}).click();
  });
  await page.getByRole('button',{name:'Relationships',exact:true}).click();
  await check('returning from a resized path refocuses the selected person', async () => {
    await page.getByRole('searchbox').fill('Person 114');await page.locator('.rg-node[data-node-id="p114"]').click();
    await page.getByRole('button',{name:'Find a path ↗',exact:true}).click();
    await page.setViewportSize({width:390,height:900});
    await page.getByRole('button',{name:'← Canvas',exact:true}).click();
    const viewport=await page.locator('.rg-map-viewport').boundingBox(),person=await page.locator('.rg-node[data-node-id="p114"]').boundingBox();
    assert.ok(person.x>=viewport.x&&person.x+person.width<=viewport.x+viewport.width&&person.y>=viewport.y&&person.y+person.height<=viewport.y+viewport.height,'selected person remains in the new viewport');
    assert.equal(await page.locator('.rg-node').count(),115);
  });
  await page.getByRole('button',{name:'Relationships',exact:true}).click();
  await page.getByLabel('Relevance now').selectOption('my');
  await page.screenshot({path:'/tmp/people-full-network-mobile.png',fullPage:true});
  await page.setViewportSize({width:1596,height:900});await page.waitForTimeout(100);
  await page.screenshot({path:'/tmp/people-readability-desktop.png',fullPage:true});
  assert.deepEqual(failures,[]);
} finally { await browser.close(); }
