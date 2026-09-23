import assert from 'node:assert/strict';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4183';
const browser=await chromium.launch({
  executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,
});

const googleStub=`window.google={accounts:{id:{initialize(o){window.login=o.callback},renderButton(el){const b=document.createElement('button');b.textContent='Test Google sign in';b.onclick=()=>window.login({credential:'fictional-google-token'});el.append(b)},disableAutoSelect(){}}}};`;

const FOLDERS=[{id:'fol_1234567890abcd',name:'Pilot',parentId:null,excluded:false,noteCount:3},
  {id:'fol_2234567890abcd',name:'Personal',parentId:null,excluded:false,noteCount:1}];
const NODES=[{id:'person-ada',name:'Ada Rivera',company:'fintech.example',type:'person'},
  {id:'person-bo',name:'Bo Chen',company:'design.example',type:'person'},
  {id:'person-cia',name:'Cia Ford',company:'ops.example',type:'person'},
  // Reached this graph through somebody else's share: not this owner's to pass on.
  {id:'person-dee',name:'Dee Shared',company:'via.example',type:'person',via:['friend@example.test']}];

async function fixture(options={}){
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  const errors=[];
  const requests=[];
  const state={
    signed:options.signed??false,
    owner:'owner@example.test',
    shares:{outgoing:[],incoming:[]},
    shareError:null,
    ...options.state,
  };
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:googleStub}));
  await page.route('**/api/config',route=>route.fulfill({json:{googleClientId:'fictional-client'}}));
  await page.route('**/api/graph?source=obsidian',route=>route.fulfill({json:{account:state.owner,graph:null}}));
  await page.route('**/api/session',route=>{
    state.signed=route.request().method()!=='DELETE';
    return route.fulfill({json:{ok:true}});
  });
  await page.route('**/api/accounts',route=>route.fulfill({
    status:state.signed?200:401,
    json:state.signed?{account:state.owner,configured:true,accounts:[]}:{error:'missing_token'},
  }));
  await page.route('**/api/granola/status',route=>{
    requests.push({path:'/api/granola/status',method:'GET',body:null});
    return route.fulfill({json:{connected:true,status:'connected',folders:FOLDERS,identities:[],
      counts:{folders:2,notes:4,pending:0,extracted:4,failed:0,skipped:0},range:'all',lastSync:0,nextSync:0,error:''}});
  });
  await page.route('**/api/graph',route=>{
    const url=new URL(route.request().url());
    if(url.search)return route.fallback();
    requests.push({path:'/api/graph',method:'GET',body:null});
    return route.fulfill({json:{account:state.owner,graph:{nodes:NODES,edges:[]}}});
  });
  await page.route('**/api/shares',async route=>{
    const request=route.request();
    const method=request.method();
    if(method==='GET'){
      requests.push({path:'/api/shares',method,body:null});
      return route.fulfill({json:state.shares});
    }
    const body=request.postDataJSON();
    requests.push({path:'/api/shares',method,body});
    if(state.shareError){const error=state.shareError;state.shareError=null;return route.fulfill(error);}
    if(method==='DELETE'){
      state.shares.outgoing=state.shares.outgoing.filter(share=>share.viewerEmail!==body.viewerEmail);
      return route.fulfill({json:{ok:true}});
    }
    state.shares.outgoing=[...state.shares.outgoing.filter(share=>share.viewerEmail!==body.viewerEmail),
      {viewerEmail:body.viewerEmail,scope:body.scope,level:body.level,updatedAt:Date.now()}];
    return route.fulfill({json:{ok:true,people:3}});
  });
  await page.route('**/api/shares/hide',async route=>{
    const body=route.request().postDataJSON();
    requests.push({path:'/api/shares/hide',method:route.request().method(),body});
    const share=state.shares.incoming.find(item=>item.ownerEmail===body.ownerEmail);
    if(!share)return route.fulfill({status:404,json:{error:'unknown_share'}});
    share.hidden=body.hidden;
    return route.fulfill({json:{ok:true}});
  });
  return {page,errors,requests,state};
}

async function signIn(page){
  await page.getByRole('button',{name:'Test Google sign in'}).click();
  await page.waitForSelector('#share-root h2');
  await page.waitForFunction(()=>!document.querySelector('#share-viewer')?.disabled);
}

try{
  {
    // 1. Share all meetings, 2. the list of shares, 3. revoke behind a confirm dialog.
    const test=await fixture();
    const {page,requests,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    assert.equal(await page.getByRole('tab',{name:'Sharing',exact:true}).getAttribute('aria-selected'),'true');
    assert.match(await page.textContent('#share-root'),/You have not shared your network with anyone yet\./);
    assert.match(await page.textContent('#share-root'),/Nobody has shared their network with you yet\./);

    // The level names are plain language, not the server's codes.
    assert.deepEqual(await page.locator('#share-level option').allTextContents(),
      ['Names and companies only','Plus themes and meeting titles','Plus quoted statements']);
    assert.match(await page.textContent('#share-root'),/No themes, no quotes\./);
    await page.selectOption('#share-level','statements');
    await page.waitForFunction(()=>document.querySelector('#share-root').textContent.includes('short quotes'));

    assert.ok(await page.isDisabled('#share-root button.primary'),'Share stays disabled until an address is typed');
    await page.fill('#share-viewer','viewer@example.test');
    await page.click('#share-root button.primary');
    await page.waitForSelector('.share-list li[data-viewer="viewer@example.test"]');
    const created=requests.find(r=>r.path==='/api/shares'&&r.method==='POST');
    assert.deepEqual(created.body,{viewerEmail:'viewer@example.test',scope:{kind:'all'},level:'statements'});
    assert.match(await page.textContent('.share-status'),/Shared with viewer@example\.test/);
    assert.match(await page.textContent('.share-list li[data-viewer="viewer@example.test"]'),/All meetings · Plus quoted statements/);
    assert.equal(await page.inputValue('#share-viewer'),'');

    // 3. revoke asks first, and a cancelled dialog changes nothing.
    page.once('dialog',dialog=>{assert.match(dialog.message(),/Stop sharing your network with viewer@example\.test\?/);return dialog.dismiss();});
    await page.click('.share-list li[data-viewer="viewer@example.test"] button');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.share-list li[data-viewer="viewer@example.test"]').count(),1,'a dismissed confirm keeps the share');
    assert.equal(requests.filter(r=>r.method==='DELETE').length,0);
    page.once('dialog',dialog=>dialog.accept());
    await page.click('.share-list li[data-viewer="viewer@example.test"] button');
    await page.waitForSelector('.share-list li[data-viewer="viewer@example.test"]',{state:'detached'});
    assert.deepEqual(requests.find(r=>r.method==='DELETE').body,{viewerEmail:'viewer@example.test'});
    assert.match(await page.textContent('.share-status'),/no longer share/);

    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 4. Folder scope reads the Granola folders and sends the ticked ids.
    const test=await fixture();
    const {page,requests,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    await page.check('input[name="share-scope"][value="folders"]');
    await page.waitForSelector('.share-folders li[data-id="fol_1234567890abcd"]');
    assert.ok(requests.some(r=>r.path==='/api/granola/status'));
    assert.match(await page.textContent('.share-folders'),/Pilot/);
    await page.fill('#share-viewer','viewer@example.test');
    assert.ok(await page.isDisabled('#share-root button.primary'),'a folder share needs at least one folder');
    await page.check('.share-folders input[value="fol_2234567890abcd"]');
    await page.click('#share-root button.primary');
    await page.waitForSelector('.share-list li[data-viewer="viewer@example.test"]');
    assert.deepEqual(requests.find(r=>r.method==='POST'&&r.path==='/api/shares').body,
      {viewerEmail:'viewer@example.test',scope:{kind:'folders',ids:['fol_2234567890abcd']},level:'names'});
    assert.match(await page.textContent('.share-list li[data-viewer="viewer@example.test"]'),/Personal · Names and companies only/);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 5. People scope: a searchable checklist from the owner's own graph, sent as person ids.
    const test=await fixture();
    const {page,requests,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    await page.check('input[name="share-scope"][value="people"]');
    await page.waitForSelector('.share-people li[data-person-id="person-ada"]');
    assert.ok(requests.some(r=>r.path==='/api/graph'));
    assert.equal(await page.locator('.share-people li[data-person-id]').count(),3);
    assert.equal(await page.locator('.share-people li[data-person-id="person-dee"]').count(),0,
      'a person somebody else shared is not this owner’s to share on');
    await page.check('.share-people input[value="person-bo"]');
    await page.fill('#share-person-search','ada');
    await page.waitForFunction(()=>document.querySelectorAll('.share-people li[data-person-id]').length===1);
    assert.equal(await page.locator('.share-people li[data-person-id="person-ada"]').count(),1);
    await page.check('.share-people input[value="person-ada"]');
    await page.fill('#share-viewer','viewer@example.test');
    await page.click('#share-root button.primary');
    await page.waitForSelector('.share-list li[data-viewer="viewer@example.test"]');
    const posted=requests.find(r=>r.method==='POST'&&r.path==='/api/shares').body;
    assert.equal(posted.scope.kind,'people');
    assert.deepEqual([...posted.scope.personIds].sort(),['person-ada','person-bo'],'a filtered list keeps earlier choices');
    assert.match(await page.textContent('.share-list li[data-viewer="viewer@example.test"]'),/2 chosen people/);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 6. Shared with me: the level, Hide and Show, and the refusal message for a lost share.
    const test=await fixture({state:{shares:{outgoing:[],
      incoming:[{ownerEmail:'friend@example.test',level:'themes',updatedAt:Date.now(),hidden:false}]}}});
    const {page,requests,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    await page.waitForSelector('.share-list li[data-owner="friend@example.test"]');
    assert.match(await page.textContent('.share-list li[data-owner="friend@example.test"]'),/Plus themes/);
    await page.click('.share-list li[data-owner="friend@example.test"] button:has-text("Hide")');
    await page.waitForSelector('.share-list li[data-owner="friend@example.test"] button:has-text("Show")');
    assert.deepEqual(requests.find(r=>r.path==='/api/shares/hide').body,{ownerEmail:'friend@example.test',hidden:true});
    assert.match(await page.textContent('.share-list li[data-owner="friend@example.test"]'),/Hidden from your graph/);
    await page.click('.share-list li[data-owner="friend@example.test"] button:has-text("Show")');
    await page.waitForSelector('.share-list li[data-owner="friend@example.test"] button:has-text("Hide")');
    assert.deepEqual(requests.filter(r=>r.path==='/api/shares/hide').at(-1).body,{ownerEmail:'friend@example.test',hidden:false});
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 7. Server refusals read as something the owner can act on, and never lose the form.
    const test=await fixture();
    const {page,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    test.state.shareError={status:409,json:{error:'share_limit'}};
    await page.fill('#share-viewer','viewer@example.test');
    await page.click('#share-root button.primary');
    await page.waitForFunction(()=>document.querySelector('.share-status')?.textContent.includes('up to 50 people'));
    assert.equal(await page.inputValue('#share-viewer'),'viewer@example.test','a refused share keeps what was typed');
    test.state.shareError={status:400,json:{error:'invalid_request'}};
    await page.click('#share-root button.primary');
    await page.waitForFunction(()=>document.querySelector('.share-status')?.textContent.includes('Check the email address'));
    assert.ok(await page.isVisible('#share-viewer'));
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 8. Sign-out clears the tab, and the panel fits a 320 px screen.
    const test=await fixture({state:{shares:{outgoing:[{viewerEmail:'viewer@example.test',scope:{kind:'all'},level:'statements',updatedAt:Date.now()}],
      incoming:[{ownerEmail:'friend@example.test',level:'names',updatedAt:Date.now(),hidden:false}]}}});
    const {page,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    await page.waitForSelector('.share-list li[data-owner="friend@example.test"]');
    await page.check('input[name="share-scope"][value="people"]');
    await page.waitForSelector('.share-people li[data-person-id="person-ada"]');
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no horizontal overflow at ${width}px`);
    }
    await page.screenshot({path:'/tmp/people-share-mobile.png',fullPage:true});
    await page.setViewportSize({width:1360,height:1000});
    await page.screenshot({path:'/tmp/people-share.png',fullPage:true});

    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByRole('button',{name:'Test Google sign in'}).waitFor();
    assert.match(await page.textContent('.share-signin'),/Sign in to People/);
    assert.equal(await page.locator('.share-list li').count(),0,'sign-out leaves no shared address on the page');
    assert.ok(!(await page.content()).includes('friend@example.test'));
    assert.ok(await page.isHidden('.share-form'));
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 8b. `clear()` on its own — what sign-out and pagehide call — returns the panel to its
    // signed-out state, account included, not to an empty signed-in form.
    const test=await fixture();
    const {page,errors}=test;
    await page.goto(origin+'/accounts.html?tab=share');
    await signIn(page);
    const state=await page.evaluate(async()=>{
      const {createSharePanel}=await import('/share-panel.mjs');
      const root=document.createElement('div');root.id='clear-probe';document.body.append(root);
      const panel=createSharePanel(root,{});
      panel.setAccount('a@x.test');
      const signedIn={prompt:root.querySelector('.share-signin').hidden,form:root.querySelector('.share-form').hidden};
      panel.clear();
      return {signedIn,prompt:root.querySelector('.share-signin').hidden,form:root.querySelector('.share-form').hidden};
    });
    assert.deepEqual(state.signedIn,{prompt:true,form:false},'setAccount shows the form and hides the prompt');
    assert.equal(state.prompt,false,'clear() shows the sign-in prompt again');
    assert.equal(state.form,true,'and hides the share form');
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 9. Switching tabs keeps the Gmail and Granola panels working, and the URL names the tab.
    const test=await fixture();
    const {page,errors}=test;
    await page.goto(origin+'/accounts.html');
    await page.getByRole('button',{name:'Test Google sign in'}).click();
    await page.locator('#accounts-area').waitFor({state:'visible'});
    assert.ok(await page.isHidden('#share-panel'));
    await page.getByRole('tab',{name:'Sharing',exact:true}).click();
    assert.ok(await page.isVisible('#share-panel'));
    assert.match(page.url(),/tab=share/);
    await page.getByRole('tab',{name:'Granola',exact:true}).click();
    assert.ok(await page.isHidden('#share-panel'));
    assert.match(page.url(),/tab=granola/);
    await page.getByRole('tab',{name:'Gmail',exact:true}).click();
    assert.ok(await page.isVisible('#gmail-panel'));
    assert.doesNotMatch(page.url(),/tab=/);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  console.log('PASS: Sharing tab creation, folder and people scopes, plain-language levels, share list, revoke confirm, hide/show, refusals, sign-out reset, clear() reset, mobile layout and tab switching.');
}finally{
  await browser.close();
}
