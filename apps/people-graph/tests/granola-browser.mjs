import assert from 'node:assert/strict';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4183';
const browser=await chromium.launch({
  executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,
});

const googleStub=`window.google={accounts:{id:{initialize(o){window.login=o.callback},renderButton(el){const b=document.createElement('button');b.textContent='Test Google sign in';b.onclick=()=>window.login({credential:'fictional-google-token'});el.append(b)},disableAutoSelect(){}}}};`;

function status(overrides={}){return {connected:false,status:null,range:null,lastSync:0,nextSync:0,error:'',counts:{folders:0,notes:0,pending:0,extracted:0,failed:0,skipped:0},folders:[],...overrides};}
const FOLDERS=[{id:'fol_1234567890abcd',name:'Pilot',parentId:null,excluded:false,noteCount:3},{id:'fol_2234567890abcd',name:'Personal',parentId:null,excluded:false,noteCount:1}];

async function fixture(options={}){
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  const errors=[];
  const requests=[];
  const state={signed:options.signed??false,owner:'owner@example.test',rejectKey:false,granola:status()};
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:googleStub}));
  await page.route('**/api/config',route=>route.fulfill({json:{googleClientId:'fictional-client'}}));
  await page.route('**/api/graph?source=obsidian',route=>route.fulfill({json:{account:state.owner,graph:null}}));
  await page.route('**/api/session',route=>{
    if(route.request().method()==='DELETE'){state.signed=false;return route.fulfill({json:{ok:true}});}
    state.signed=true;
    return route.fulfill({json:{ok:true}});
  });
  await page.route('**/api/accounts',route=>route.fulfill({
    status:state.signed?200:401,
    json:state.signed?{account:state.owner,configured:true,accounts:[]}:{error:'missing_token'},
  }));
  await page.route('**/api/granola/status',async route=>{
    const request=route.request();
    if(request.method()!=='GET')return route.fallback();
    requests.push({url:request.url(),method:'GET',body:null});
    await route.fulfill({json:state.granola});
  });
  await page.route('**/api/granola/connect',async route=>{
    const request=route.request();
    const body=request.postDataJSON();
    requests.push({url:request.url(),method:'POST',body});
    if(state.rejectKey){
      await route.fulfill({status:422,json:{error:'granola_unauthorized',message:'Granola rejected this API key. Check it and try again.'}});
      return;
    }
    state.granola=status({connected:true,status:'syncing',range:body.range,folders:FOLDERS,counts:{folders:FOLDERS.length,notes:4,pending:4,extracted:0,failed:0,skipped:0}});
    await route.fulfill({json:state.granola});
  });
  await page.route('**/api/granola/folders',async route=>{
    const request=route.request();
    const body=request.postDataJSON();
    requests.push({url:request.url(),method:'PATCH',body});
    const excluded=new Set(body.excluded);
    state.granola.folders=state.granola.folders.map(f=>({...f,excluded:excluded.has(f.id)}));
    await route.fulfill({json:state.granola});
  });
  await page.route('**/api/granola/sync',async route=>{
    const request=route.request();
    requests.push({url:request.url(),method:'POST',body:null});
    state.granola.status='syncing';
    await route.fulfill({json:state.granola});
  });
  await page.route('**/api/granola/connection',async route=>{
    const request=route.request();
    requests.push({url:request.url(),method:'DELETE',body:null});
    state.granola=status();
    await route.fulfill({json:{ok:true}});
  });
  return {page,errors,requests,state};
}

async function signIn(page){
  await page.getByRole('button',{name:'Test Google sign in'}).click();
  await page.waitForSelector('#granola-root h2');
  await page.waitForFunction(()=>!document.querySelector('#granola-api-key')?.disabled);
}

try{
  {
    // 1. connect, 2. folder toggle, 3. sync now + disconnect confirm
    const test=await fixture();
    const {page,requests,errors}=test;
    await page.goto(origin+'/accounts.html?tab=granola');
    await signIn(page);

    await page.fill('#granola-api-key','grn_fictional_key_123456');
    await page.selectOption('#granola-range','all');
    await page.click('#granola-root button.primary');
    await page.waitForSelector('.granola-card .status');
    assert.equal(requests.find(r=>r.url.endsWith('/api/granola/connect')).body.range,'all');
    assert.equal(await page.inputValue('#granola-api-key').catch(()=>''),'');
    assert.match(await page.textContent('.granola-card .status'),/Syncing/);
    assert.equal((await page.$$('.granola-folders input[type=checkbox]')).length,2);
    assert.ok(!(await page.content()).includes('grn_fictional_key_123456'));

    // 2. folder toggle
    await page.uncheck('.granola-folders input[value="fol_2234567890abcd"]');
    await page.waitForFunction(()=>document.querySelector('.granola-folders li[data-id="fol_2234567890abcd"] .hint')?.textContent.includes('Hidden'));
    assert.deepEqual(requests.find(r=>r.url.endsWith('/api/granola/folders')).body,{excluded:['fol_2234567890abcd']});

    // 3. sync now + disconnect confirm
    test.state.granola.status='connected';
    await page.waitForSelector('.granola-card button:has-text("Sync now"):not([disabled])');
    await page.click('.granola-card button:has-text("Sync now")');
    assert.ok(requests.some(r=>r.url.endsWith('/api/granola/sync')));
    page.once('dialog',d=>d.accept());
    await page.click('.granola-card button:has-text("Disconnect")');
    await page.waitForSelector('#granola-api-key');
    assert.ok(requests.some(r=>r.url.endsWith('/api/granola/connection')&&r.method==='DELETE'));
    assert.ok(await page.isHidden('.granola-card'));

    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 4. rejected key shows the safe message and keeps the form
    const test=await fixture();
    const {page,errors}=test;
    test.state.rejectKey=true;
    await page.goto(origin+'/accounts.html?tab=granola');
    await signIn(page);
    await page.fill('#granola-api-key','grn_fictional_bad_key');
    await page.selectOption('#granola-range','recent');
    await page.click('#granola-root button.primary');
    await page.waitForFunction(()=>document.querySelector('.granola-status')?.textContent.includes('rejected that API key'));
    assert.match(await page.textContent('.granola-status'),/rejected that API key/);
    assert.ok(await page.isVisible('#granola-api-key'),'form must remain visible after a rejected key');
    assert.ok(!(await page.content()).includes('grn_fictional_bad_key'));
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 5. reconnect_required state shows a key field and Reconnect button
    const test=await fixture();
    const {page,errors}=test;
    test.state.granola=status({connected:true,status:'reconnect_required',range:'all',folders:FOLDERS});
    await page.goto(origin+'/accounts.html?tab=granola');
    await signIn(page);
    await page.waitForSelector('.granola-card');
    assert.ok(await page.isVisible('#granola-api-key'),'reconnect requires re-entering the key');
    await page.getByRole('button',{name:'Reconnect Granola',exact:true}).waitFor();
    assert.equal(await page.isVisible('#granola-range'),false,'range picker is hidden while reconnecting');
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    // 6. sign-out clears the card back to the signed-out gate; mobile width 320 has no horizontal overflow
    const test=await fixture();
    const {page,errors}=test;
    await page.goto(origin+'/accounts.html?tab=granola');
    await signIn(page);
    await page.fill('#granola-api-key','grn_fictional_key_123456');
    await page.selectOption('#granola-range','all');
    await page.click('#granola-root button.primary');
    await page.waitForSelector('.granola-card .status');

    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:320,height:740});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:1360,height:1000});

    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByRole('button',{name:'Test Google sign in'}).waitFor();
    assert.match(await page.textContent('.granola-signin'),/Sign in to People/);
    assert.ok(await page.isHidden('.granola-card'));
    assert.ok(await page.isDisabled('#granola-api-key'));

    assert.deepEqual(errors,[]);
    await page.close();
  }

  console.log('PASS: Granola connect, folder exclusion, sync now, disconnect confirm, rejected key, reconnect flow, sign-out reset, and mobile layout.');
}finally{
  await browser.close();
}
