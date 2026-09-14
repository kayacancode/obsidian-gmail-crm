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
    window.readabilityData = {nodes,edges:[{id:'tie',source:'p0',target:'p1',kind:'cooccurrence',label:'shared email'}],themes:names.map((name,i)=>({id:`t${i}`,name})),themeSignals:signals,relevance:{version:1,lens:'my',calculatedAt:stamp,scoreVersion:'relevance-v1',themes:names.map((name,i)=>({themeId:`t${i}`,name,score:90,reason:'Gmail Subject evidence',nodeIds:signals.filter(s=>s.themeId===`t${i}`).map(s=>s.personId),components:signals.filter(s=>s.themeId===`t${i}`).map(s=>({signalId:s.id,sourceType:s.sourceType,observedAt:stamp,contribution:10}))})),connectors:[],discoveries:[]}};
    window.readabilityGraph = mountGraph(document.querySelector('#graph'), {graph:window.readabilityData});
  });
  const check = async (name, fn) => { try { await fn(); console.log(`PASS: ${name}`); } catch(error) { failures.push(`${name}: ${error.message}`); console.error(`FAIL: ${name}: ${error.message}`); } };
  for (const width of [1596, 859, 390, 320]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    for (const zoom of [1,.75]) {
    if(zoom<1) for(let i=0;i<3;i++) await page.locator('[data-action="zoom-out"]').click();
    await check(`portraits, long labels and badges do not overlap at ${width}px / ${zoom} zoom`, async () => {
      const collisions = await page.locator('.rg-node').evaluateAll(nodes => {
        const rects=nodes.map(n=>{const r=n.getBoundingClientRect(),label=n.querySelector('.rg-node-label').getBoundingClientRect(),badge=n.parentNode.querySelector(`.rg-person-heat[data-person-id="${n.dataset.nodeId}"]`)?.getBoundingClientRect();return {left:Math.min(r.left,label.left,badge?.left??Infinity),right:Math.max(r.right,label.right,badge?.right??-Infinity),top:Math.min(r.top,badge?.top??Infinity),bottom:Math.max(r.bottom,label.bottom)}});
        let count=0;for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)count++;}return count;
      });
      assert.equal(collisions,0);
    });
    await check(`topics visible above people at ${width}px`, async () => {
      const panel=page.getByRole('region',{name:'Topics and themes'});
      assert.equal(await panel.count(),1);
      const box=await panel.boundingBox();assert.ok(box.y>=0&&box.y+box.height<900);
      const first=await page.locator('.rg-node').first().boundingBox();assert.ok(first.y>=box.y+box.height+12);
      for(const badge of await page.locator('.rg-person-heat').all()) { const r=await badge.boundingBox();assert.ok(r.y>box.y+box.height,'why-now controls cannot be covered by the topic bar'); }
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
  });
  await page.setViewportSize({width:1596,height:900});
  await page.waitForTimeout(100);
  await check('unpromoted themes remain discoverable and select one focused field', async () => {
    await page.getByLabel('Browse all themes').selectOption('t122');
    assert.equal(await page.locator('.rg-theme-field').count(),1);
    assert.equal(await page.locator('.rg-node[data-node-id="p114"]').count(),1);
    assert.equal(await page.getByLabel('Browse all themes').evaluate(n=>n===n.ownerDocument.activeElement),true);
    assert.match(await page.getByLabel('Why this is hot now',{exact:true}).innerText(),/Updated Invitation 117/);
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>[n.dataset.nodeId,n.style.left,n.style.top]));
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
    const right=await page.locator('.rg-node').evaluateAll(nodes=>Math.max(...nodes.map(n=>n.getBoundingClientRect().right)));assert.ok(right<panel.x);
  });
  await check('off removes heat without shifting people; all 115 remain searchable', async () => {
    const positions=()=>page.locator('.rg-node').evaluateAll(nodes=>nodes.map(n=>[n.dataset.nodeId,n.style.left,n.style.top,n.style.width]));
    const before=await positions();await page.getByLabel('Relevance now').selectOption('off');
    assert.deepEqual(await positions(),before);assert.equal(await page.locator('.rg-theme-field,.rg-person-heat').count(),0);
    await page.getByRole('searchbox').fill('Person 114');await page.locator('.rg-node[data-node-id="p114"]').waitFor();
  });
  await page.getByRole('button',{name:'Relationships',exact:true}).click();
  await page.getByLabel('Relevance now').selectOption('my');
  await page.screenshot({path:'/tmp/people-readability-desktop.png',fullPage:true});
  assert.deepEqual(failures,[]);
} finally { await browser.close(); }
