const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  async function openConversation(name) {
    const toggle=page.getByRole('button',{name:/What’s coming up in your conversations/});
    if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
    await page.getByRole('button',{name:`Explore conversation: ${name}`,exact:true}).click();
  }
  async function openMenu(){if(!await page.locator('#viewer-menu').getAttribute('open')) {if(await page.locator('#viewer-menu').evaluate(el=>!el.open))await page.getByText('Menu',{exact:true}).click();}}
  const errors = [];
  const graphRequests = [];
  const sessionMethods = [];
  let authorized = false;
  let graphStatus = 200;
  let empty = false;
  let accountsAbort = false;
  let tokenSwitch = false;
  let account = 'alice@example.test';
  let workflowGraph = null;
  let mailboxChoice = false;
  const baseGraph = {
    source: 'email_accounts',
    pushedAt: '2026-09-13T12:00:00Z',
    nodes: [
      { id: 'ada', name: 'Ada Rivera', type: 'person', role: 'Founder' },
      { id: 'bo', name: 'Bo Chen', type: 'person', role: 'Designer' },
    ],
    edges: [{ id: 'ada-bo', source: 'ada', target: 'bo', kind: 'personal', label: 'worked with', evidence: [{ id: 'note', title: 'Project note' }] }],
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{id:{initialize(o){window.testSignIn=o.callback},renderButton(el){const b=document.createElement('button');b.textContent='Test sign in';b.onclick=()=>window.testSignIn({credential:'test-id-token'});el.append(b)},disableAutoSelect(){}}}};` }));
  await page.route('**/api/accounts', (route) => accountsAbort
    ? route.abort('failed')
    : route.fulfill({ status: authorized ? 200 : 401, json: authorized ? { account, accounts: mailboxChoice ? [{email:'unmatched@example.test'},{email:'mail@example.test'}] : [{email:'mail@example.test'}] } : { error: 'missing_token' } }));
  await page.route('**/api/config', (route) => route.fulfill({ json: { googleClientId: 'test-client' } }));
  await page.route('**/api/token', (route) => {
    if (tokenSwitch) account = 'bob@example.test';
    return route.fulfill({ json: { email: account, token: `${account}-private-token` } });
  });
  await page.route('**/api/session', (route) => {
    sessionMethods.push(route.request().method());
    if (route.request().method() === 'POST') authorized = true;
    if (route.request().method() === 'DELETE') authorized = false;
    return route.fulfill({ json: { ok: true, account } });
  });
  await page.route('**/api/graph*', (route) => {
    const url = new URL(route.request().url());
    graphRequests.push(`${url.pathname}${url.search}`);
    if (graphStatus !== 200) return route.fulfill({ status: graphStatus, json: { error: 'test' } });
    const obsidian = url.searchParams.get('source') === 'obsidian';
    const graph = obsidian
      ? { ...baseGraph, source: 'obsidian', nodes: [{ id: 'obsidian', name: 'Obsidian Person', type: 'person' }], edges: [] }
      : account === 'bob@example.test'
        ? { ...baseGraph, nodes: [{ id: 'bob-person', name: 'Bob Private Person', type: 'person' }], edges: [] }
        : baseGraph;
    return route.fulfill({ json: { account, graph: empty ? null : workflowGraph ?? graph } });
  });

  const origin = process.env.PEOPLE_TEST_ORIGIN || 'http://127.0.0.1:4183';
  await page.goto(origin);
  await page.getByRole('button', { name: 'Test sign in' }).click();
  await page.getByRole('region', { name: 'Authenticated relationship graph' }).waitFor({ state: 'visible' });
  assert.match(await page.locator('#graph').innerText(), /Ada Rivera/);
  assert.equal(await page.locator('input[type="search"]:visible').count(),1,'one primary search');
  assert.equal(await page.locator('.app-header #network-search').count(),1);
  await page.getByRole('button',{name:'Answer',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Answer',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Wander',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Guided graph walk'}).isVisible(),true);
  await page.getByRole('button',{name:'Close graph walk',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isVisible(),false);
  await page.getByText('Menu',{exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isVisible(),true);
  await page.getByText('Menu',{exact:true}).click();
  assert.equal(await page.getByLabel('Graph source').inputValue(), 'best');
  assert.match(await page.locator('#viewer-status').innerText(), /EMAIL METADATA AND AUTOMATIC SCORES/);
  await page.locator('.rg-node').filter({ hasText: 'Ada Rivera' }).click();
  await page.getByRole('button', { name: /worked with: Ada Rivera and Bo Chen/ }).click();
  assert.match(await page.locator('.rg-evidence-panel').innerText(), /Project note/);
  await page.getByRole('button', { name: 'Close evidence' }).click();
  await page.locator('.rg-node').filter({ hasText: 'Ada Rivera' }).click();
  await page.getByRole('button', { name: 'Find a path from Ada ↗' }).click();
  await page.getByLabel('Path destination person').selectOption('bo');
  await page.getByRole('button', { name: 'Save this path' }).click();
  assert.match(await page.locator('#viewer-status').innerText(), /SAVED THIS EXACT PATH FOR THIS SESSION/);
  await page.getByRole('button', { name: 'Restore Ada Rivera → Bo Chen' }).waitFor();
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('people-relationship-trails:'))), []);
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/people-relationship-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '/tmp/people-relationship.png', fullPage: true });

  await openMenu();
  await page.getByLabel('Graph source').selectOption('obsidian');
  await page.locator('.rg-node').filter({ hasText: 'Obsidian Person' }).waitFor();
  assert.equal(graphRequests.at(-1), '/api/graph?source=obsidian');
  assert.match(page.url(), /source=obsidian/);

  graphStatus = 401;
  await openMenu();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('#gate').getByText('Your session expired.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Authenticated relationship graph' }).isHidden(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /Obsidian Person/);

  graphStatus = 200;
  empty = true;
  await page.getByRole('button', { name: 'Test sign in' }).click();
  await page.getByText('Your graph is ready for its first source.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Connect email accounts ↗' }).getAttribute('href'), '/accounts.html');

  empty = false;
  await openMenu();
  await page.getByLabel('Graph source').selectOption('best');
  await page.locator('.rg-node').filter({ hasText: 'Ada Rivera' }).waitFor();
  await openMenu();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('Your relationships, in context.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Authenticated relationship graph' }).isHidden(), true);
  assert.equal(await page.getByRole('region', { name: 'Paths held for this session' }).isHidden(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /Ada Rivera/);

  authorized = true;
  accountsAbort = true;
  await page.reload();
  await page.getByText('We couldn’t load your graph.', { exact: true }).waitFor();
  accountsAbort = false;
  await page.getByRole('button', { name: 'Retry ↗' }).click();
  await page.locator('.rg-node').filter({ hasText: 'Ada Rivera' }).waitFor();

  await page.locator('.rg-node').filter({ hasText: 'Ada Rivera' }).click();
  await page.getByRole('button', { name: 'Find a path from Ada ↗' }).click();
  await page.getByLabel('Path destination person').selectOption('bo');
  await page.getByRole('button', { name: 'Save this path' }).click();
  await page.getByRole('button', { name: 'Restore Ada Rivera → Bo Chen' }).waitFor();
  tokenSwitch = true;
  await openMenu();
  await page.getByRole('button', { name: 'Connect Obsidian', exact: true }).click();
  await page.getByRole('button', { name: 'Generate private push token' }).click();
  await page.locator('.rg-node').filter({ hasText: 'Bob Private Person' }).waitFor();
  await openMenu();
  assert.match(await page.locator('#account').innerText(), /BOB@EXAMPLE\.TEST/);
  await page.getByText('Menu',{exact:true}).click();
  assert.equal(await page.getByRole('region', { name: 'Paths held for this session' }).isHidden(), true);
  assert.equal(await page.getByRole('button', { name: 'Restore Ada Rivera → Bo Chen' }).count(), 0);
  assert.deepEqual(sessionMethods, ['POST', 'POST', 'DELETE']);

  // Exercise the authenticated host, including confirmation gates and source completion.
  authorized=true;account='alice@example.test';
  const stamp='2026-09-14T12:00:00Z';
  const hostSignals=['memory','health'].map((themeId,i)=>({id:`host-${i}`,themeId,personId:'ada',visibility:'public',sourceType:'public_url',summary:'Public research',observedAt:stamp,ingestedAt:stamp,confidence:.8,evidenceRef:'public-source:source-one',contentHash:'hash',extractorVersion:'public-v1'}));
  hostSignals.forEach(signal=>signal.provenance={canonicalUrl:'https://example.com/research',publisherHost:'example.com',observedAt:stamp,retrievedAt:stamp,timeBasis:'observed'});
  const hostSnapshot={version:1,lens:'my',calculatedAt:stamp,scoreVersion:'relevance-v1',themes:hostSignals.map(s=>({themeId:s.themeId,name:s.themeId,score:70,reason:'Recent research',nodeIds:['ada'],components:[{signalId:s.id,sourceType:s.sourceType,observedAt:stamp,contribution:40}]})),connectors:[],discoveries:[]};
  workflowGraph={...baseGraph,themes:hostSignals.map(s=>({id:s.themeId,canonicalName:s.themeId,status:'active',aliases:[],description:''})),themeSignals:hostSignals,relevance:hostSnapshot,connectors:[{nodeId:'ada',score:3,evidenceClass:'documented',documentedDegree:2,inferredDegree:0,sampledPathCount:1}]};
  const workflowCalls=[];
  let expiredWorkflow=false;
  let holdPreview=false, heldPreview=null;
  await page.route('**/api/relevance?*',route=>{workflowCalls.push('relevance');return route.fulfill({status:expiredWorkflow?401:200,json:hostSnapshot});});
  await page.route('**/api/themes/*/feedback*',route=>{workflowCalls.push({feedback:route.request().postDataJSON()});return route.fulfill({json:{id:'feedback'}});});
  await page.route('**/api/themes/*/evidence?*',route=>{workflowCalls.push('evidence');return route.fulfill({json:{theme:workflowGraph.themes[0],signals:hostSignals}});});
  await page.route('**/api/retrieval/*',route=>{
    const endpoint=new URL(route.request().url()).pathname.split('/').at(-1);workflowCalls.push(`retrieval:${endpoint}`);
    if(endpoint==='preview'){
      const input=route.request().postDataJSON();
      if(input.account==='unmatched@example.test')return route.fulfill({status:400,json:{error:'retrieval_failed'}});
      if(holdPreview){heldPreview=route;return;}
      return route.fulfill({json:{...input,maxMessages:50,maxBytes:1000000,fingerprint:'f'.repeat(43),before:1800000000,after:1797408000,expiresAt:1800600000}});
    }
    if(endpoint==='confirm')workflowCalls.push({retrievalConfirm:route.request().postDataJSON()});
    return route.fulfill({json:{id:'job-one',status:endpoint==='confirm'?'queued':'complete',processed:2,assertions:1}});
  });
  await page.route('**/api/public-sources/*',route=>{
    const endpoint=new URL(route.request().url()).pathname.split('/').at(-1);workflowCalls.push(`public:${endpoint}`);
    workflowCalls.push({publicSource:new URL(route.request().url()).search});
    if(endpoint==='source-one'&&!workflowGraph.themes.length)workflowGraph={...workflowGraph,themes:hostSignals.map(s=>({id:s.themeId,canonicalName:s.themeId,status:'active',aliases:[],description:''})),themeSignals:hostSignals,relevance:hostSnapshot};
    return route.fulfill({json:endpoint==='preview'?{canonicalUrl:'https://example.com/research',publisherHost:'example.com',visibility:'public',contentType:'text/html'}:{id:'source-one',status:endpoint==='confirm'?'queued':'complete',canonicalUrl:'https://example.com/research',visibility:'public'}});
  });
  await page.goto(origin);
  await openConversation('memory');
  const hostWhy=page.getByLabel('Why this is hot now',{exact:true});
  async function checkReloadedProvenance(){
    await page.reload();
    await openConversation('memory');
    const link=hostWhy.getByRole('link',{name:'Open source: example.com',exact:true});
    assert.equal(await link.getAttribute('href'),'https://example.com/research');
    assert.match(await link.getAttribute('rel'),/noopener/);
    assert.match(await hostWhy.innerText(),/Publisher: example.com/);
    assert.match(await hostWhy.innerText(),/Observed 2026-09-14.*Retrieved 2026-09-14/);
  }
  await checkReloadedProvenance();
  await hostWhy.getByRole('button',{name:'Pin',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-action="theme-pin"]').disabled);
  for(const action of ['Mute','Expire']){
    await hostWhy.getByRole('button',{name:action,exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-action="theme-pin"]').disabled);
  }
  await hostWhy.getByRole('button',{name:'Correct',exact:true}).click();
  await page.getByLabel('Replacement theme').selectOption('health');
  await hostWhy.getByRole('button',{name:'Save correction'}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-action="theme-pin"]').disabled);
  assert.deepEqual(workflowCalls.filter(c=>c.feedback).map(c=>c.feedback),[{action:'pin'},{action:'mute'},{action:'expire'},{action:'correct',replacementThemeId:'health'}]);
  await page.getByLabel('Relevance now').selectOption('public');
  await openConversation('memory');
  await hostWhy.getByRole('button',{name:'Add public source',exact:true}).click();
  const publicDialog=page.getByRole('dialog',{name:'Add public source'});
  await publicDialog.getByLabel('Public URL').fill('https://example.com/research');
  await publicDialog.getByRole('button',{name:'Preview source'}).click();
  await publicDialog.getByRole('button',{name:'Confirm public source'}).waitFor();
  assert.equal(workflowCalls.includes('public:confirm'),false);
  assert.match(await publicDialog.innerText(),/https:\/\/example.com\/research/);
  assert.match(await publicDialog.innerText(),/Public|text\/html/);
  await publicDialog.getByRole('button',{name:'Confirm public source'}).click();
  await page.locator('#viewer-status').filter({hasText:'Public source complete'}).waitFor();
  assert.equal(workflowCalls.includes('public:source-one'),true);
  const firstPolls=workflowCalls.filter(call=>call==='public:source-one').length;
  await openConversation('memory');
  await hostWhy.getByRole('button',{name:'Add public source',exact:true}).click();
  await publicDialog.getByLabel('Public URL').fill('https://example.com/research');
  await publicDialog.getByRole('button',{name:'Preview source'}).click();
  await publicDialog.getByRole('button',{name:'Confirm public source'}).click();
  await page.locator('#viewer-status').filter({hasText:'Public source complete'}).waitFor();
  assert.equal(workflowCalls.filter(call=>call==='public:source-one').length,firstPolls+1);
  await openConversation('memory');
  await hostWhy.getByRole('button',{name:'Add public source',exact:true}).click();
  await page.keyboard.press('Escape');
  await publicDialog.waitFor({state:'hidden'});
  await page.locator('.rg-person-heat[data-person-id="ada"]').first().click();
  mailboxChoice=true;
  await hostWhy.getByRole('button',{name:'Retrieve more context'}).click();
  const retrieveDialog=page.getByRole('dialog',{name:'Retrieve more context'});
  await retrieveDialog.getByRole('status').filter({hasText:'400'}).waitFor();
  assert.equal(await retrieveDialog.getByRole('button',{name:'Confirm retrieval'}).isDisabled(),true);
  await retrieveDialog.getByLabel('Mailbox').selectOption('mail@example.test');
  await page.waitForFunction(()=>!document.querySelector('.workflow-dialog button').disabled);
  await retrieveDialog.getByRole('button',{name:'Confirm retrieval'}).waitFor();
  assert.equal(workflowCalls.includes('retrieval:confirm'),false);
  assert.match(await retrieveDialog.innerText(),/mail@example.test|50 messages|1 MB|ephemerally|not retained/);
  assert.equal(await retrieveDialog.getByLabel('Time window').inputValue(),'30');
  holdPreview=true;
  await retrieveDialog.getByLabel('Time window').selectOption('90');
  assert.equal(await retrieveDialog.getByRole('button',{name:'Confirm retrieval'}).isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('.workflow-dialog [aria-label="Time window"]').value==='90');
  for(let attempt=0;!heldPreview&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(heldPreview,'the selected mailbox/window must produce a fresh preview');
  holdPreview=false;
  await heldPreview.fulfill({json:{...heldPreview.request().postDataJSON(),maxMessages:50,maxBytes:1000000,fingerprint:'g'.repeat(43),before:1800000000,after:1792224000,expiresAt:1800600000}});
  await retrieveDialog.getByRole('button',{name:'Confirm retrieval'}).click();
  await page.locator('#viewer-status').filter({hasText:'Retrieval complete'}).waitFor();
  assert.ok(workflowCalls.indexOf('retrieval:preview')<workflowCalls.indexOf('retrieval:confirm'));
  assert.equal(workflowCalls.find(call=>call.retrievalConfirm).retrievalConfirm.account,'mail@example.test');
  assert.equal(workflowCalls.find(call=>call.retrievalConfirm).retrievalConfirm.windowDays,90);
  assert.equal(await page.locator('.rg-node[data-connector="documented"]').count(),1);
  assert.equal(await page.locator('#viewer-status').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
  assert.equal(workflowCalls.includes('evidence'),true);
  expiredWorkflow=true;
  await page.getByLabel('Relevance now').selectOption('my');
  await page.locator('#gate').filter({hasText:'session expired'}).waitFor();
  assert.equal(await page.locator('.rg-node,.workflow-dialog').count(),0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(key=>/relevance|retrieval/.test(key))),[]);
  expiredWorkflow=false;await page.getByRole('button',{name:'Test sign in'}).click();
  await page.locator('.rg-node[data-node-id="ada"]').waitFor();
  workflowGraph={...workflowGraph,source:'obsidian',themes:[],themeSignals:[],relevance:{...hostSnapshot,themes:[]}};
  await page.reload();
  await page.getByRole('button',{name:'Explore Ada Rivera',exact:true}).click();
  assert.equal(await page.locator('.rg-theme-field').count(),0);
  await page.getByRole('button',{name:'Retrieve more context',exact:true}).click();
  await retrieveDialog.getByRole('status').filter({hasText:'no verified Gmail person mapping'}).waitFor();
  assert.equal(await retrieveDialog.getByRole('button',{name:'Confirm retrieval'}).isDisabled(),true);
  await page.keyboard.press('Escape');
  const coldPositions=await page.locator('.rg-node').evaluateAll(nodes=>nodes.map(node=>[node.dataset.nodeId,node.style.left,node.style.top]));
  await page.getByRole('button',{name:'Add public source',exact:true}).click();
  await publicDialog.getByLabel('Public URL').fill('https://example.com/research');
  await publicDialog.getByRole('button',{name:'Preview source'}).click();
  await publicDialog.getByRole('button',{name:'Confirm public source'}).click();
  await page.locator('#viewer-status').filter({hasText:'Public source complete'}).waitFor();
  assert.equal(await page.locator('.rg-theme-field').count(),2);
  assert.deepEqual(await page.locator('.rg-node').evaluateAll(nodes=>nodes.map(node=>[node.dataset.nodeId,node.style.left,node.style.top])),coldPositions);
  assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'),'ada');
  assert.ok(workflowCalls.some(call=>call.publicSource==='?source=obsidian'));
  await checkReloadedProvenance();

  // Draft a note: the model writes it, the owner edits it, and nothing is ever sent from here.
  const draftBody='Hi Ada, you mentioned wanting an intro to a fintech founder in the pilot sync. I have two people in mind and would be glad to introduce you this week.';
  let draftResponse={status:200,json:{to:'ada@example.test',name:'Ada Rivera',subject:'Following up on the fintech intro',body:draftBody,checked:true,warnings:[],
    basedOn:[{summary:'Ask: \u201cAda asked for an intro to a fintech founder.\u201d',observedAt:'2026-09-14T12:00:00Z',title:'Pilot sync with Ada'},
      {summary:'Interest: \u201cagent memory\u201d',observedAt:'2026-09-02T12:00:00Z'}]}};
  await page.route('**/api/people/draft',route=>{workflowCalls.push({draft:route.request().postDataJSON()});return route.fulfill(draftResponse);});
  await page.evaluate(()=>{window.copiedText=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText.push(text);}}});});
  await page.locator('.rg-node').filter({hasText:'Ada Rivera'}).click();
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  const draftDialog=page.getByRole('dialog',{name:'Draft a note'});
  await draftDialog.getByLabel('Subject').waitFor();
  assert.deepEqual(workflowCalls.find(call=>call.draft).draft,{personId:'ada'});
  assert.equal(await draftDialog.getByLabel('Subject').inputValue(),'Following up on the fintech intro');
  assert.equal(await draftDialog.getByLabel('Draft body').inputValue(),draftBody);
  assert.match(await draftDialog.innerText(),/Based on:/);
  assert.match(await draftDialog.innerText(),/Pilot sync with Ada/);
  assert.match(await draftDialog.innerText(),/Nothing is sent until you send it from your mail client\./);
  assert.match(await draftDialog.innerText(),/Checked against your notes\./);
  const mailto=draftDialog.getByRole('link',{name:'Open in email \u2197'});
  assert.equal(await mailto.getAttribute('href'),`mailto:ada@example.test?subject=${encodeURIComponent('Following up on the fintech intro')}&body=${encodeURIComponent(draftBody)}`);
  await draftDialog.getByLabel('Subject').fill('Quick hello');
  assert.equal(await mailto.getAttribute('href'),`mailto:ada@example.test?subject=Quick%20hello&body=${encodeURIComponent(draftBody)}`);
  await draftDialog.getByRole('button',{name:'Copy',exact:true}).click();
  await page.locator('.workflow-dialog [role="status"]').filter({hasText:'Copied'}).waitFor();
  assert.equal(await page.evaluate(()=>window.copiedText.at(-1)),`Quick hello\n\n${draftBody}`);
  await page.keyboard.press('Escape');
  await draftDialog.waitFor({state:'hidden'});
  draftResponse={status:200,json:{...draftResponse.json,to:null}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await draftDialog.getByLabel('Subject').waitFor();
  assert.equal(await draftDialog.getByRole('link',{name:'Open in email \u2197'}).count(),0,'no address means no mail client link');
  await page.keyboard.press('Escape');
  // A checked draft with warnings shows them as a list, and never the "Checked against your
  // notes." sentence \u2014 the two are mutually exclusive.
  draftResponse={status:200,json:{...draftResponse.json,to:'ada@example.test',checked:true,
    warnings:['This draft may mention something not in your notes.','This draft asks for money or credentials; do not send it as is.']}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await draftDialog.getByLabel('Subject').waitFor();
  assert.match(await draftDialog.innerText(),/This draft may mention something not in your notes\./);
  assert.match(await draftDialog.innerText(),/This draft asks for money or credentials; do not send it as is\./);
  assert.ok(!(await draftDialog.innerText()).includes('Checked against your notes.'),'warnings and the all-clear sentence are mutually exclusive');
  await page.keyboard.press('Escape');
  // An unchecked draft (no TYPESAFE_API_KEY, or a failed check) shows neither warnings nor the
  // all-clear sentence.
  draftResponse={status:200,json:{...draftResponse.json,checked:false,warnings:[]}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await draftDialog.getByLabel('Subject').waitFor();
  assert.ok(!(await draftDialog.innerText()).includes('Checked against your notes.'),'an unchecked draft shows no check status');
  await page.keyboard.press('Escape');
  draftResponse={status:503,json:{error:'ai_unavailable',message:'The drafting model is unavailable. Try again shortly.'}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await page.locator('.workflow-dialog [role="status"]').filter({hasText:'The drafting model is unavailable. Try again shortly.'}).waitFor();
  assert.equal(await draftDialog.getByLabel('Subject').count(),0,'a failed draft shows nothing to copy or send');
  await page.keyboard.press('Escape');
  // A server error body with no message falls back to readable copy, never the raw "Context
  // request failed (…)." text.
  draftResponse={status:502,json:{error:'invalid_draft'}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await page.locator('.workflow-dialog [role="status"]').filter({hasText:'Could not draft a note right now. Try again in a moment.'}).waitFor();
  assert.equal(await draftDialog.getByLabel('Subject').count(),0,'a failed draft shows nothing to copy or send');
  await page.keyboard.press('Escape');
  // A mailto-unsafe stored address (header-injection characters) never renders a link, even
  // if the server ever sent one back: the client re-checks independently of the server.
  draftResponse={status:200,json:{to:'victim?bcc=attacker@evil.test',name:'Ada Rivera',subject:'Following up on the fintech intro',body:draftBody,basedOn:[]}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  await draftDialog.getByLabel('Subject').waitFor();
  assert.equal(await draftDialog.getByRole('link',{name:'Open in email ↗'}).count(),0,'a mailto-unsafe address renders no mail client link');
  await page.keyboard.press('Escape');

  // A person who is only in the graph because someone shared them cannot be written to directly:
  // the server returns introVia and the owner's address, and the dialog becomes an intro request.
  const introBody='Would you be up for introducing me to Ada Rivera? We are both working on agent memory.';
  draftResponse={status:200,json:{to:'owner@example.test',introVia:'owner@example.test',name:'Ada Rivera',
    subject:'Intro to Ada Rivera?',body:introBody,basedOn:[{summary:'Interest: “agent memory”',observedAt:'2026-09-02T12:00:00Z'}]}};
  await page.getByRole('button',{name:'Draft a note',exact:true}).click();
  const introDialog=page.getByRole('dialog',{name:'Intro request to owner@example.test'});
  await introDialog.getByLabel('Subject').waitFor();
  assert.match(await introDialog.innerText(),/Intro request to owner@example\.test/);
  assert.match(await introDialog.innerText(),/asks owner@example\.test for an introduction/);
  assert.ok(!(await introDialog.innerText()).includes('Draft for Ada Rivera'),'an intro request is not addressed to the shared person');
  assert.equal(await introDialog.getByRole('link',{name:'Open in email ↗'}).getAttribute('href'),
    `mailto:owner@example.test?subject=${encodeURIComponent('Intro to Ada Rivera?')}&body=${encodeURIComponent(introBody)}`);
  await page.keyboard.press('Escape');
  await introDialog.waitFor({state:'hidden'});

  // Search my network: the field sits above the graph, results are ranked and explained, and
  // choosing one selects that person through the graph's own node selection.
  let searchDelay=0;
  let searchResponse={status:200,json:{query:'fintech fundraising',checked:true,results:[
    {personId:'bo',name:'Bo Chen',company:'design.example',lastContact:'2026-09-09T00:00:00.000Z',score:0.824,
      reasons:[{summary:'Raising a seed round for a fintech product',observedAt:'2026-09-01T11:00:00Z',title:'Pilot sync'}]},
    {personId:'ada',name:'Ada Rivera',company:'fintech.example',lastContact:'2026-09-10T00:00:00.000Z',score:0.41,reasons:[]}]}};
  await page.route('**/api/people/search',async route=>{
    workflowCalls.push({search:route.request().postDataJSON()});
    if(searchDelay)await new Promise(resolve=>setTimeout(resolve,searchDelay));
    return route.fulfill(searchResponse);
  });
  const networkQuery=page.getByLabel('Ask your network');
  assert.equal(await networkQuery.getAttribute('placeholder'),'Find a person or ask your network\u2026');
  searchDelay=400;
  await networkQuery.fill('fintech fundraising');
  await networkQuery.press('Enter');
  await page.locator('#network-search').getByText('Searching\u2026').waitFor();
  searchDelay=0;
  const searchResults=page.getByRole('list',{name:'Network search results'});
  await searchResults.getByRole('button',{name:/Bo Chen/}).waitFor();
  assert.deepEqual(workflowCalls.at(-1),{search:{query:'fintech fundraising'}});
  assert.match(await searchResults.innerText(),/82%/);
  assert.match(await searchResults.innerText(),/design\.example/);
  assert.match(await searchResults.innerText(),/Raising a seed round for a fintech product/);
  assert.match(await searchResults.innerText(),/Pilot sync/);
  // The label is a micro-label like the other status chrome: the copy is exact, the CSS uppercases it.
  assert.match(await page.locator('#network-search').innerText(),/Ranked by Jev/i);
  await searchResults.getByRole('button',{name:/Bo Chen/}).click();
  assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'),'bo');
  assert.equal(await searchResults.count(),0,'choosing a person closes the list');
  assert.equal(await networkQuery.inputValue(),'');
  // An empty result is a plain sentence, and an unchecked ranking says so.
  searchResponse={status:200,json:{query:'underwater basket weaving',checked:false,results:[]}};
  await networkQuery.fill('underwater basket weaving');
  await networkQuery.press('Enter');
  await page.locator('#network-search').getByText('No one in your network matches yet.').waitFor();
  assert.match(await page.locator('#network-search').innerText(),/Keyword match only/i);
  await networkQuery.press('Escape');
  assert.ok(!(await page.locator('#network-search').innerText()).includes('No one in your network matches yet.'),'Escape dismisses the results');
  assert.equal(await networkQuery.inputValue(),'');
  // A failed search reads as copy the owner can act on, never a raw status code.
  searchResponse={status:503,json:{error:'mail_not_configured',message:'Email connections are not enabled on this server yet.'}};
  await networkQuery.fill('fintech');
  await networkQuery.press('Enter');
  await page.locator('#network-search').getByText('Email connections are not enabled on this server yet.').waitFor();
  assert.equal(await searchResults.count(),0);
  await page.getByRole('button',{name:'Clear search',exact:true}).click();
  assert.equal(await networkQuery.inputValue(),'');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);

  // Mount the real renderer with controllable host boundaries. Removing lens filtering,
  // state preservation, or request-generation guards must fail these assertions.
  await page.evaluate(async () => {
    const { mountGraph } = await import('/relationship-graph/graph.mjs');
    const date = '2026-09-14T12:00:00Z';
    const signals = [
      ['s1', 'memory', 'ada', 'private', 'granola', 'Private agent memory discussion'],
      ['s2', 'memory', 'bo', 'public', 'public_url', 'Public memory research'],
      ['s3', 'health', 'bo', 'private', 'obsidian_note', 'Private health note'],
      ['s4', 'health', 'cia', 'firm', 'calendar', 'Firm health meeting'],
    ].map(([id, themeId, personId, visibility, sourceType, summary]) => ({
      id, themeId, personId, visibility, sourceType, summary, observedAt: date, ingestedAt: date,
      confidence: .8, evidenceRef: `evidence:${id}`, contentHash: id, extractorVersion: 'fixture-v1', modelId: 'fixture',
    }));
    window.heatFixture = {
      meta: { fictional: true },
      nodes: ['Ada Rivera', 'Bo Chen', 'Cia Ford', 'Dee Park', 'Eli Lin', 'Fay Singh', 'Gus Lee', 'Hal Jo']
        // Cia is in this graph only because owner@example.test shared her: she carries `via`.
        .map((name, i) => ({ id: ['ada', 'bo', 'cia', 'dee', 'eli', 'fay', 'gus', 'hal'][i], name, type: 'person', photoPosition: `${i % 4 * 33.333}% ${Math.floor(i / 4) * 33.333}%`, ...(i === 2 ? { via: ['owner@example.test'] } : {}) })),
      edges: [{ id: 'ada-bo', source: 'ada', target: 'bo', kind: 'personal', label: 'worked with' }],
      themes: [{ id: 'memory', name: 'Agent memory' }, { id: 'health', name: 'Health systems' }],
      themeSignals: signals,
      relevance: {
        version: 1, lens: 'my', calculatedAt: date, scoreVersion: 'relevance-v1',
        themes: ['memory', 'health'].map((themeId, i) => ({ themeId, name: i ? 'Health systems' : 'Agent memory', score: i ? 72 : 90,
          reason: i ? 'Recent note and upcoming meeting' : 'Recent discussion and public research',
          nodeIds: i ? ['bo', 'cia'] : ['ada', 'bo'], components: signals.filter(s => s.themeId === themeId).map(s => ({signalId: s.id, sourceType: s.sourceType, observedAt: date, contribution: 40})) })),
        connectors: [{nodeId:'ada',score:3.2,evidenceClass:'documented',documentedDegree:3,inferredDegree:0,sampledPathCount:2},
          {nodeId:'bo',score:2.4,evidenceClass:'inferred',documentedDegree:0,inferredDegree:2,sampledPathCount:1}],
        discoveries: ['dee', 'eli', 'fay', 'gus', 'hal', 'cia'].map((nodeId, i) => ({nodeId,score:12-i,reason:'Agent memory via unexpected documented bridge',themeIds:['memory'],pathNodeIds:['ada','bo',nodeId],freshness:'recent',relationshipUncertainty:'documented'})),
      },
    };
    const standaloneRoot=document.querySelector('#graph').cloneNode(false);
    document.querySelector('#graph').replaceWith(standaloneRoot);
    // The renderer fixture has no host status callback; discard the previous
    // account-switch toast before exercising standalone renderer controls.
    document.querySelector('#viewer-status').remove();
    window.heatCalls = [];
    const deferred = kind => payload => {
      window.heatCalls.push({ kind, payload });
      return new Promise((resolve, reject) => { window.heatPending = { resolve, reject }; });
    };
    window.heatGraph = mountGraph(document.querySelector('#graph'), {
      graph: window.heatFixture, demo: true,
      onLensChange: deferred('lens'), onThemeFeedback: deferred('feedback'),
      onRetrievePreview: deferred('retrieve'), onOpenPublicSource: deferred('public'),
    });
  });
  page.setDefaultTimeout(10_000);
  const lens = page.getByLabel('Relevance now');
  assert.equal(await lens.count(), 1, 'renderer offers a removable relevance lens');
  assert.equal(await page.locator('.rg-theme-field').count(), 2);
  assert.equal(await page.locator('.rg-node[data-hot="true"]').count(), 3);
  assert.equal(await page.locator('.rg-node[data-connector="documented"]').count(), 1);
  assert.equal(await page.locator('.rg-node[data-connector="inferred"]').count(), 1);
  const positions = () => page.locator('.rg-node').evaluateAll(nodes => nodes.map(n => [n.dataset.nodeId,n.style.left,n.style.top,n.style.width]));
  const initialPositions = await positions();
  // Only a shared person is marked, and only the Firm lens explains shared evidence.
  assert.equal(await page.locator('.rg-node[data-via="true"]').count(), 1, 'only the shared person is marked as shared');
  await page.getByRole('button',{name:/What’s coming up in your conversations/}).click();
  assert.doesNotMatch(await page.locator('.rg-topic-explanation').innerText(), /shared with you/i, 'only Firm explains shared evidence');
  await openConversation('Agent memory');
  const why = page.getByLabel('Why this is hot now', {exact:true});
  assert.match(await why.innerText(), /PRIVATE EVIDENCE/);
  assert.match(await why.innerText(), /PUBLIC EVIDENCE/);
  assert.match(await why.innerText(), /Meeting · 2026-09-14/, 'evidence reads as a source label and a date');
  assert.doesNotMatch(await why.innerText(), /80% confidence/, 'scoring internals stay behind the details toggle');
  await why.locator('.rg-evidence-details summary').first().click();
  assert.match(await why.innerText(), /80% confidence · contribution 40\.00/);
  assert.match(await page.getByLabel('Adjacent discoveries').innerText(), /documented bridge/i);
  assert.equal(await page.locator('.rg-discovery').count(), 5);
  assert.equal(await page.locator('.rg-directory-item').count(), 2, 'theme selection narrows the directory');
  await page.screenshot({path:'/tmp/people-heat-desktop-why.png',fullPage:true});
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.rg-theme-field').first().evaluate(node => getComputedStyle(node).borderTopStyle), 'solid');
  assert.equal(await page.locator('.rg-node[data-hot="true"]').first().evaluate(node => getComputedStyle(node.querySelector('.rg-portrait'),'::after').animationName), 'none');
  await page.emulateMedia({media:'screen'});
  await why.getByRole('button', {name:'Pin',exact:true}).click();
  assert.equal(await why.getByRole('button', {name:'Mute',exact:true}).isDisabled(), true);
  await page.evaluate(() => window.heatPending.reject(new Error('sensitive backend detail')));
  await page.getByRole('status').filter({hasText:'Could not update relevance'}).waitFor();
  assert.equal(await page.locator('.rg-theme-field').count(), 1, 'failed mutation preserves the focused theme');
  assert.doesNotMatch(await page.locator('#graph').innerText(), /sensitive backend detail/);
  await why.getByRole('button', {name:'Correct',exact:true}).click();
  await page.getByLabel('Replacement theme').selectOption('health');
  await why.getByRole('button', {name:'Save correction',exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.heatCalls.at(-1)), {kind:'feedback',payload:{themeId:'memory',personId:null,action:'correct',replacementThemeId:'health'}});
  await page.evaluate(() => window.heatPending.resolve());
  await page.getByRole('status').filter({hasText:'Relevance updated'}).waitFor();
  await why.getByRole('button', {name:'Expire',exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.heatCalls.at(-1).payload), {themeId:'memory',personId:null,action:'expire'});
  await page.evaluate(() => { window.staleSelection = window.heatPending; });
  await page.getByRole('button', {name:'Explore Ada Rivera',exact:true}).click();
  await page.evaluate(() => { const stale=structuredClone(window.heatFixture); stale.relevance.themes=[]; window.staleSelection.resolve(stale); });
  assert.equal(await page.locator('.rg-theme-field').count(), 2, 'selection discards stale mutation response');
  await page.getByRole('button', {name:'Relationships',exact:true}).click();
  await openConversation('Agent memory');
  await why.getByRole('button', {name:'Retrieve more context',exact:true}).click();
  assert.equal(await page.evaluate(() => window.heatCalls.at(-1).kind), 'retrieve');
  await page.evaluate(() => window.heatPending.resolve());
  await why.getByRole('button', {name:'Add public source',exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.heatCalls.at(-1)), {kind:'public',payload:{themeId:'memory',personId:null}});
  await page.evaluate(() => window.heatPending.resolve());
  await lens.selectOption('public');
  assert.equal(await page.locator('.rg-theme-field').count(), 1);
  assert.equal(await page.locator('.rg-node[data-hot="true"]').count(), 1);
  assert.doesNotMatch(await page.locator('#graph').innerText(), /Private agent memory|PRIVATE EVIDENCE|Health systems/);
  await page.evaluate(() => { window.staleHeat = window.heatPending; });
  await lens.selectOption('firm');
  assert.equal(await page.locator('.rg-theme-field').count(), 1);
  await page.evaluate(() => window.staleHeat.resolve(window.heatFixture));
  assert.equal(await lens.inputValue(), 'firm');
  assert.equal(await page.getByRole('button', {name:'Explore conversation: Agent memory',exact:true}).count(), 0);
  await openConversation('Health systems');
  assert.match(await why.innerText(), /FIRM EVIDENCE/);
  assert.doesNotMatch(await why.innerText(), /PRIVATE EVIDENCE|PUBLIC EVIDENCE/);
  // The Firm lens is where a sharer's evidence appears, and says so.
  await page.getByRole('button',{name:/What’s coming up in your conversations/}).click();
  assert.match(await page.locator('.rg-topic-explanation').innerText(), /shared with you/i);
  assert.match(await page.locator('.rg-topic-explanation').innerText(), /via/i);
  await lens.selectOption('off');
  assert.equal(await page.locator('.rg-theme-field,.rg-why-panel,.rg-discoveries,[data-hot],[data-heat-level],[data-connector]').count(), 0);
  assert.deepEqual(await positions(), initialPositions, 'heat and lens selection never move nodes');
  await page.screenshot({path:'/tmp/people-heat-desktop-off.png',fullPage:true});
  await lens.selectOption('my');
  await page.getByRole('button', {name:'Explore Ada Rivera',exact:true}).click();
  await page.getByRole('button', {name:'Zoom in',exact:true}).click();
  const selectedPositions = await positions();
  const history = await page.getByLabel('Exploration history').innerText();
  await page.evaluate(() => window.heatGraph.setRelevance(window.heatFixture, 'my'));
  assert.deepEqual(await positions(), selectedPositions);
  assert.equal(await page.getByLabel('Exploration history').innerText(), history);
  assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'), 'ada');
  await page.getByRole('button', {name:'Find a path from Ada ↗'}).click();
  await page.getByLabel('Path destination person').selectOption('bo');
  await page.getByRole('button', {name:'Save this path'}).waitFor();
  const path = await page.getByLabel('Compare introduction paths').innerText();
  await page.evaluate(() => window.heatGraph.setRelevance(window.heatFixture, 'my'));
  assert.equal(await page.getByLabel('Compare introduction paths').innerText(), path);
  await page.getByRole('button', {name:'← Canvas',exact:true}).click();
  await page.getByRole('button', {name:'Relationships',exact:true}).click();
  await page.screenshot({path:'/tmp/people-heat-desktop.png',fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.rg-node[data-hot="true"]').first().evaluate(node => getComputedStyle(node.querySelector('.rg-portrait'),'::after').animationName), 'none');
  await page.setViewportSize({width:320,height:844});
  await openConversation('Agent memory');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path:'/tmp/people-heat-mobile.png',fullPage:true});
  await lens.selectOption('off');
  await page.screenshot({path:'/tmp/people-heat-mobile-off.png',fullPage:true});
  await page.evaluate(()=>{
    const fixture=structuredClone(window.heatFixture);
    fixture.relevance.themes=fixture.relevance.themes.filter(theme=>theme.themeId==='memory');
    fixture.relevance.themes[0].score=2;
    fixture.relevance.themes[0].nodeScores={ada:65,bo:2};
    window.heatGraph.setRelevance(fixture,'my');
  });
  assert.equal(await page.locator('.rg-node[data-node-id="ada"]').getAttribute('data-heat-level'),'2');
  assert.equal(await page.locator('.rg-node[data-node-id="bo"]').getAttribute('data-heat-level'),'1');
  await page.evaluate(() => {
    const fixture = structuredClone(window.heatFixture);
    fixture.nodes.forEach(node => { node.visibility = 'public'; node.observedAt = '2026-09-14T12:00:00Z'; });
    fixture.nodes.find(node => node.id === 'dee').permission = 'denied';
    fixture.nodes.find(node => node.id === 'eli').identityResolved = false;
    fixture.edges.push(...['cia', 'dee', 'eli'].map(id => ({id:`bo-${id}`,source:'bo',target:id,kind:'personal',label:'worked with'})),
      {id:'bo-fay',source:'bo',target:'fay',kind:'cooccurrence',label:'same conference'});
    fixture.themeSignals = ['cia','dee','eli','fay'].map(id => ({...fixture.themeSignals[1],id:`signal-${id}`,personId:id}));
    fixture.relevance.themes = [{...fixture.relevance.themes[0],nodeIds:['cia','dee','eli','fay'],components:fixture.themeSignals.map(s => ({signalId:s.id,sourceType:s.sourceType,observedAt:s.observedAt,contribution:1}))}];
    fixture.relevance.discoveries = [];
    window.heatGraph.setGraph(fixture);
    window.heatGraph.setRelevance(fixture,'public');
    window.heatGraph.select('ada');
  });
  assert.equal(await page.locator('.rg-discovery').count(), 1, 'real scorer excludes denied, unresolved and cooccurrence-only candidates');
  assert.match(await page.getByLabel('Adjacent discoveries').innerText(), /Cia Ford/);
  assert.match(await page.getByLabel('Adjacent discoveries').innerText(), /Documented bridge: Bo Chen/);
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.equal(await page.locator('.rg-node').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node.querySelector('.rg-portrait'),'::after').animationName !== 'none').length <= 3), true, 'balanced heat animates at most three people');
  await page.locator('.rg-discovery').click();
  assert.equal(await page.locator('.rg-node[data-active="true"]').getAttribute('data-node-id'), 'cia');
  assert.match(await page.getByLabel('Exploration history').innerText(), /Cia Ford/);

  // Cia was shared by owner@example.test: her node carries a "via <owner>" line under the name,
  // a dashed ring, and the person panel says who shared her and where their evidence appears.
  // This runs at 320 px with the selection made from the discovery list.
  const sharedNode = page.locator('.rg-node[data-node-id="cia"]');
  assert.equal(await sharedNode.getAttribute('data-via'), 'true');
  assert.equal(await page.locator('.rg-node[data-via="true"]').count(), 1);
  assert.equal(await sharedNode.locator('.rg-node-via').evaluate(node => node.textContent), 'via owner@example.test');
  assert.equal(await sharedNode.locator('.rg-portrait').evaluate(node => getComputedStyle(node, '::before').borderTopStyle), 'dashed',
    'a shared person is drawn with a dashed ring');
  assert.equal(await page.locator('.rg-node[data-node-id="ada"] .rg-portrait').evaluate(node => getComputedStyle(node, '::before').content), 'none',
    'a person the viewer knows themselves gets no shared ring');
  const sharedPanel = page.getByLabel('Selected item and connections');
  assert.match(await sharedPanel.innerText(), /Shared with you by owner@example\.test/);
  assert.match(await sharedPanel.innerText(), /Firm lens/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  assert.deepEqual(errors, []);
  console.log('PASS: relationship host authentication, owner graph, source selection, expiry, empty graph, sign-out, balanced heat, exact lenses, corrections, stale callbacks, preserved graph state and mobile/reduced-motion.');
} finally {
  await browser.close();
}
