import assert from 'node:assert/strict';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4183';
const browser=await chromium.launch({
  executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,
});

const googleStub=`window.google={accounts:{id:{initialize(o){window.login=o.callback},renderButton(el){const b=document.createElement('button');b.textContent='Test Google sign in';b.onclick=()=>window.login({credential:'fictional-google-token'});el.append(b)},disableAutoSelect(){}}}};`;

function folder(id,name){return {id,name,parentFolderId:null};}
function note(id,title,createdAt='2026-08-14T12:00:00.000Z'){return {id,title,createdAt,updatedAt:'2026-08-15T12:00:00.000Z'};}

async function fixture(options={}){
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  const errors=[];
  const requests=[];
  const state={signed:options.signed??true,owner:'owner@example.test',deleteFails:false};
  let granolaHandler=options.granolaHandler||((path)=>path.endsWith('/folders')
    ?{status:200,json:{folders:[],hasMore:false,cursor:null}}
    :{status:200,json:{notes:[],hasMore:false,cursor:null}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:googleStub}));
  await page.route('**/api/config',route=>route.fulfill({json:{googleClientId:'fictional-client'}}));
  await page.route('**/api/graph?source=obsidian',route=>route.fulfill({json:{account:state.owner,graph:null}}));
  await page.route('**/api/session',route=>{
    if(route.request().method()==='DELETE'){
      if(state.deleteFails)return route.fulfill({status:500,json:{error:'session_delete_failed'}});
      state.signed=false;
    }else state.signed=true;
    return route.fulfill({json:{ok:true}});
  });
  await page.route('**/api/accounts',route=>route.fulfill({
    status:state.signed?200:401,
    json:state.signed?{account:state.owner,configured:true,accounts:[]}:{error:'missing_token'},
  }));
  await page.route('**/api/granola/*',async route=>{
    const request=route.request();
    const path=new URL(request.url()).pathname;
    const body=request.postDataJSON();
    requests.push({path,body,headers:request.headers()});
    const result=await granolaHandler(path,body,requests.length);
    await route.fulfill(result);
  });
  return {page,errors,requests,state,setGranolaHandler(handler){granolaHandler=handler;}};
}

async function connect(page,key='grn_fictional_test_key'){
  await page.getByLabel('Granola API key',{exact:true}).fill(key);
  const button=page.getByRole('button',{name:'Connect Granola',exact:true});
  const colors=await button.evaluate(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,color:style.color};});
  assert.deepEqual(colors,{background:'rgb(52, 75, 67)',color:'rgb(255, 255, 255)'});
  await button.click();
}

try{
  {
    const test=await fixture({signed:false});
    const {page,requests}=test;
    await page.goto(origin+'/accounts?tab=granola');
    const granolaTab=page.getByRole('tab',{name:'Granola',exact:true});
    await granolaTab.waitFor();
    assert.equal(await granolaTab.getAttribute('aria-selected'),'true');
    assert.match(await page.getByRole('tabpanel',{name:'Granola'}).innerText(),/Sign in to People/);
    assert.ok(await page.getByLabel('Granola API key',{exact:true}).isDisabled());
    assert.equal(requests.length,0,'Granola must not be contacted before explicit submission');
    await page.getByRole('button',{name:'Test Google sign in'}).click();
    await page.waitForFunction(()=>!document.querySelector('#granola-api-key')?.disabled);
    assert.ok(await page.getByLabel('Granola API key',{exact:true}).isEnabled());
    await page.close();
  }

  {
    const folderPages=[
      {folders:[folder('fol_00000000000001','Product'),folder('fol_00000000000002','Research')],hasMore:true,cursor:'folder-page-2'},
      {folders:[folder('fol_00000000000003','Advisors')],hasMore:false,cursor:null},
    ];
    const notePages=[
      {notes:[note('not_00000000000001','<img src=x onerror=alert(1)>')],hasMore:true,cursor:'note-page-2'},
      {notes:[note('not_00000000000002','Fictional customer call')],hasMore:false,cursor:null},
    ];
    const test=await fixture({granolaHandler:(path,body)=>{
      const pages=path.endsWith('/folders')?folderPages:notePages;
      if(path.endsWith('/notes')&&body.folderId==='fol_00000000000002')return {status:200,json:{notes:[],hasMore:false,cursor:null}};
      return {status:200,json:body.cursor?pages[1]:pages[0]};
    }});
    const {page,errors,requests,state}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page);
    await page.getByText('Connected for this session',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    assert.deepEqual(requests[0].body,{apiKey:'grn_fictional_test_key'});
    assert.equal(requests[0].headers.authorization,undefined);
    const folderSelect=page.getByLabel('Granola folder',{exact:true});
    assert.equal(await folderSelect.inputValue(),'');
    assert.ok(await page.getByRole('button',{name:'Browse notes',exact:true}).isDisabled());
    await page.getByRole('button',{name:'More folders',exact:true}).click();
    await folderSelect.locator('option',{hasText:'Advisors'}).waitFor({state:'attached'});
    assert.equal(await folderSelect.locator('option').count(),4);
    await folderSelect.selectOption('fol_00000000000001');
    await page.getByRole('button',{name:'Browse notes',exact:true}).click();
    await page.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();
    assert.equal(await page.locator('#granola-root img').count(),0,'note titles must remain text');
    assert.match(await page.getByText(/^Created /).first().innerText(),/^Created /);
    await page.getByRole('button',{name:'More notes',exact:true}).click();
    await page.getByText('Fictional customer call',{exact:true}).waitFor();
    assert.deepEqual(requests.at(-1).body,{apiKey:'grn_fictional_test_key',folderId:'fol_00000000000001',cursor:'note-page-2'});
    await page.screenshot({path:'/tmp/people-granola-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/people-granola-mobile.png',fullPage:true});
    await page.setViewportSize({width:320,height:740});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const beforeFolderChoice=requests.length;
    await folderSelect.selectOption('fol_00000000000002');
    assert.equal(requests.length,beforeFolderChoice,'choosing a folder must not browse automatically');
    assert.equal(await page.getByText('Fictional customer call',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Browse notes',exact:true}).click();
    await page.getByText('No notes are available in this folder.',{exact:true}).waitFor();

    const gmailTab=page.getByRole('tab',{name:'Gmail',exact:true});
    await page.getByRole('tab',{name:'Granola',exact:true}).press('ArrowLeft');
    assert.equal(await gmailTab.getAttribute('aria-selected'),'true');
    await page.getByRole('tab',{name:'Granola',exact:true}).click();
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.equal(await page.locator('#granola-root').getByText('Product',{exact:true}).count(),0);

    await connect(page);
    await page.getByText('Connected for this session',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('tab',{name:'Granola',exact:true}).waitFor();
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');
    assert.equal(await page.locator('#granola-root').getByText('Product',{exact:true}).count(),0);
    await connect(page);
    await page.getByText('Connected for this session',{exact:true}).waitFor();
    state.deleteFails=true;
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByText('Sign-out failed. Please retry.',{exact:true}).waitFor();
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');

    state.deleteFails=false;
    await page.getByRole('tab',{name:'Granola',exact:true}).click();
    await connect(page);
    await page.getByText('Connected for this session',{exact:true}).waitFor();
    await page.waitForTimeout(5200);
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isVisible(),'same-account polling must retain the connection');
    state.owner='new-owner@example.test';
    await page.waitForFunction(()=>document.querySelector('#identity')?.textContent==='new-owner@example.test',null,{timeout:7000});
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    let release;
    const deferred=new Promise(resolve=>{release=resolve;});
    const test=await fixture({granolaHandler:async()=>{await deferred;return {status:200,json:{folders:[folder('fol_00000000000009','Late private folder')],hasMore:false,cursor:null}};}});
    const {page,errors}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page,'grn_fictional_deferred_key');
    await page.getByRole('tab',{name:'Gmail',exact:true}).click();
    release();
    await page.waitForTimeout(100);
    await page.getByRole('tab',{name:'Granola',exact:true}).click();
    assert.equal(await page.getByText('Late private folder',{exact:true}).count(),0);
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    const test=await fixture({granolaHandler:()=>({status:422,json:{error:'granola_unauthorized',message:'raw upstream secret must never render'}})});
    const {page,errors}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page,'grn_fictional_rejected_key');
    await page.getByText('Granola rejected that API key. Check it and try again.',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');
    assert.equal(await page.getByText(/raw upstream secret/).count(),0);
    assert.deepEqual(errors,[]);
    await page.reload();
    assert.ok(await page.getByText('Connected for this session',{exact:true}).isHidden());
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');
    await page.close();
  }

  {
    let mode='empty';
    const test=await fixture({granolaHandler:()=>mode==='empty'
      ?{status:200,json:{folders:[],hasMore:false,cursor:null}}
      :mode==='app-auth'
        ?{status:401,json:{error:'missing_token',message:'raw app auth body'}}
        :{status:502,json:{error:'granola_unavailable',message:'raw upstream detail'}}});
    const {page,errors}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page,'grn_fictional_empty_key');
    await page.getByText('Connected for this session',{exact:true}).waitFor();
    await page.getByText('No Granola folders are available.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Disconnect Granola',exact:true}).click();
    mode='api-error';
    await connect(page,'grn_fictional_api_error');
    await page.getByText('Granola browsing is temporarily unavailable. Try again.',{exact:true}).waitFor();
    assert.equal(await page.getByText(/raw upstream detail/).count(),0);
    assert.equal(await page.getByLabel('Granola API key',{exact:true}).inputValue(),'');
    mode='app-auth';
    await connect(page,'grn_fictional_app_auth');
    await page.getByText('Sign in to People before connecting Granola.',{exact:true}).waitFor();
    assert.ok(await page.getByLabel('Granola API key',{exact:true}).isDisabled());
    assert.equal(await page.getByText(/raw app auth body/).count(),0);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    const pages=Array.from({length:10},(_,pageIndex)=>({
      folders:Array.from({length:30},(_,index)=>folder(`fol_${String(pageIndex*30+index).padStart(14,'0')}`,`Folder ${pageIndex*30+index+1}`)),
      hasMore:true,
      cursor:`cursor-${pageIndex+1}`,
    }));
    const test=await fixture({granolaHandler:(path,body)=>{
      if(path.endsWith('/notes'))return {status:200,json:{notes:[],hasMore:false,cursor:null}};
      const pageIndex=body.cursor?Number(body.cursor.split('-')[1]):0;
      return {status:200,json:pages[pageIndex]};
    }});
    const {page,errors}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page,'grn_fictional_limit_key');
    for(let index=1;index<10;index++)await page.getByRole('button',{name:'More folders',exact:true}).click();
    await page.getByText('Folder limit reached. Showing the first 300 folders.',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Granola folder',{exact:true}).locator('option').count(),301);
    assert.equal(await page.getByRole('button',{name:'More folders',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  {
    const notePages=Array.from({length:10},(_,pageIndex)=>({
      notes:Array.from({length:30},(_,index)=>note(`not_${String(pageIndex*30+index).padStart(14,'0')}`,`Note ${pageIndex*30+index+1}`)),
      hasMore:true,
      cursor:`note-cursor-${pageIndex+1}`,
    }));
    const test=await fixture({granolaHandler:(path,body)=>{
      if(path.endsWith('/folders'))return {status:200,json:{folders:[folder('fol_00000000000001','Limit test')],hasMore:false,cursor:null}};
      const pageIndex=body.cursor?Number(body.cursor.split('-').at(-1)):0;
      return {status:200,json:notePages[pageIndex]};
    }});
    const {page,errors}=test;
    await page.goto(origin+'/accounts?tab=granola');
    await connect(page,'grn_fictional_note_limit');
    await page.getByLabel('Granola folder',{exact:true}).selectOption('fol_00000000000001');
    await page.getByRole('button',{name:'Browse notes',exact:true}).click();
    for(let index=1;index<10;index++)await page.getByRole('button',{name:'More notes',exact:true}).click();
    await page.getByText('Note limit reached. Showing the first 300 notes.',{exact:true}).waitFor();
    assert.equal(await page.locator('.granola-notes li').count(),300);
    assert.equal(await page.getByRole('button',{name:'More notes',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    await page.close();
  }

  console.log('PASS: Granola sign-in gate, memory-only connection, safe paged browsing, resets, stale-response fencing, limits, responsive layout and errors.');
}finally{
  await browser.close();
}
