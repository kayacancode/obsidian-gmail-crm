import assert from 'node:assert/strict';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')errors.push(`console: ${message.text()}`);});
 const origin=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4184';

 await page.route('**/spatial-scale-harness',route=>route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/spatial.css"><div id="stage" style="width:850px"><svg id="ties"></svg><div id="nodes"></div></div>'}));
 await page.goto(origin+'/spatial-scale-harness');
 await page.evaluate(async()=>{
  const {Scene}=await import('/scene.mjs');
  const {sceneData}=await import('/model.mjs');
  window.build=count=>{
   const people=Array.from({length:count},(_,index)=>({id:'p'+index,name:'Person '+index}));
   window.data=sceneData({},people.map(node=>({node})));
   window.scene??=new Scene(document.querySelector('#stage'),node=>{window.picked=node.id;scene.set(data,[],node.id);});
   scene.set(data,[],null);
  };
  build(554);
 });
 assert.equal(await page.locator('.orb').count(),554);
 await page.locator('.orb').last().click();
 assert.equal(await page.evaluate(()=>picked),'p553');
 await page.screenshot({path:'/tmp/all-people-554.png'});
 await page.evaluate(()=>build(1500));
 assert.equal(await page.locator('.orb').count(),1500);
 assert.ok(await page.evaluate(()=>scene.elements.every(element=>{
  const x=parseFloat(element.style.getPropertyValue('--point-x')),y=parseFloat(element.style.getPropertyValue('--point-y'));
  return x>0&&x<850&&y>0&&y<510;
 })));
 await page.evaluate(()=>{scene.rotate(.25);scene.scale(.2);scene.reset();});
 await page.locator('.orb').last().click();
 assert.equal(await page.evaluate(()=>picked),'p1499');
 await page.keyboard.press('Tab');
 await page.locator('.orb').first().focus();
 assert.equal(await page.locator('.orb').first().locator('.name').evaluate(element=>getComputedStyle(element).visibility),'visible');

 await page.route('**/relationship-graph/relevance.mjs',async route=>{
  const response=await route.fetch();
  const body=(await response.text()).replace(
   'export function themeFields(graph, visibleNodes, lens) {',
   "export function themeFields(graph, visibleNodes, lens) { window.__themeFieldCalls=(window.__themeFieldCalls||0)+1;",
  );
  await route.fulfill({response,body});
 });
 await page.route('**/relationship-scale-harness',route=>route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/relationship-graph/graph.css"><main id="graph"></main>'}));
 await page.goto(origin+'/relationship-scale-harness');
 const renderElapsed=await page.evaluate(async()=>{
  const {mountGraph}=await import('/relationship-graph/graph.mjs');
  const stamp='2026-09-14T12:00:00.000Z';
  const nodes=Array.from({length:1500},(_,index)=>({id:`person-${index}`,name:`Person ${String(index).padStart(4,'0')}`,type:'person',role:index===1499?'Last searchable person':'Member'}));
  const themes=Array.from({length:120},(_,index)=>({id:`theme-${index}`,canonicalName:`Theme ${index}`,aliases:[],description:`Theme ${index} description`,status:'active'}));
  const themeSignals=Array.from({length:5000},(_,index)=>({id:`signal-${index}`,personId:`person-${index%1500}`,themeId:`theme-${index%120}`,sourceType:'product_activity',visibility:index%3===0?'private':index%3===1?'firm':'public',observedAt:stamp,ingestedAt:stamp,confidence:.8,summary:`Signal ${index}`,evidenceRef:`activity:${index}`,contentHash:`hash-${index}`,extractorVersion:'fixture-v1'}));
  const byTheme=new Map(themes.map(theme=>[theme.id,[]]));
  for(const item of themeSignals)byTheme.get(item.themeId).push(item);
  const relevance={version:1,lens:'my',calculatedAt:stamp,scoreVersion:'relevance-v1',themes:themes.map((theme,index)=>({themeId:theme.id,name:theme.canonicalName,score:40+(index%61),reason:'Product activity evidence',nodeIds:[...new Set(byTheme.get(theme.id).map(item=>item.personId))],components:byTheme.get(theme.id).map(item=>({signalId:item.id,sourceType:item.sourceType,observedAt:item.observedAt,contribution:.8}))})),connectors:[],discoveries:[]};
  const started=performance.now();
  window.relationshipGraph=mountGraph(document.querySelector('#graph'),{graph:{nodes,edges:[],themes,themeSignals,relevance,connectors:[]},lens:'my'});
  return performance.now()-started;
 });

 assert.equal(await page.locator('.rg-node').count(),80);
 assert.equal(await page.getByText('All results (1500)',{exact:true}).count(),1);
 assert.ok(await page.locator('.rg-theme-field').count()>0);
 const visibleIds=new Set(await page.locator('.rg-node').evaluateAll(nodes=>nodes.map(node=>node.dataset.nodeId)));
 const heatIds=await page.locator('.rg-person-heat').evaluateAll(nodes=>nodes.map(node=>node.dataset.personId));
 assert.ok(heatIds.length>0&&heatIds.every(id=>visibleIds.has(id)));

 const search=page.getByPlaceholder('Find a person, company, story…');
 await search.fill('Last searchable person');
 assert.equal(await page.locator('.rg-node').count(),1);
 assert.equal(await page.getByText('All results (1)',{exact:true}).count(),1);
 const selectionStarted=Date.now();
 await page.getByRole('button',{name:'Explore Person 1499'}).click();
 assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'),'person-1499');
 const selectionElapsed=Date.now()-selectionStarted;

 await search.fill('');
 await page.getByText('All results (1500)',{exact:true}).click();
 for(let pageIndex=1;pageIndex<30;pageIndex++)await page.getByRole('button',{name:'Next results'}).click();
 assert.match(await page.locator('.rg-page-status').innerText(),/Page 30 of 30/);
 await page.locator('.rg-directory-item[data-node-id="person-1499"]').click();
 assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'),'person-1499');

 const callsBeforeOff=await page.evaluate(()=>window.__themeFieldCalls);
 await page.getByLabel('Relevance now').selectOption('off');
 assert.equal(await page.locator('.rg-theme-field,.rg-person-heat,.rg-node[data-hot]').count(),0);
 assert.equal(await page.evaluate(()=>window.__themeFieldCalls),callsBeforeOff);
 assert.deepEqual(errors,[]);
 console.log(`PASS: 554/1500 spatial nodes; relationship fixture 1500 people, 120 themes, 5000 signals; 80-node canvas; all-results search/directory; visible-only heat; Off skips theme-field work. Render ${renderElapsed.toFixed(1)}ms; selection ${selectionElapsed}ms.`);
}finally{await browser.close();}
