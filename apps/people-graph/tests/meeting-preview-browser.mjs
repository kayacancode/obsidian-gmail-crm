import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  page.setDefaultTimeout(4000);
  const writes=[],requests=[],errors=[];let authorized=true;
  page.on('request',request=>requests.push(request.url()));
  page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE ERROR:',error.message);});
  const nodes=Array.from({length:115},(_,i)=>({id:`p${i}`,name:i?'Person '+i:'Ada',company:'example.test',type:'person'}));
  const graph={source:'email_accounts',pushedAt:'2026-09-15T12:00:00Z',nodes,edges:[],themes:[],themeSignals:[],relevance:{version:1,lens:'my',calculatedAt:'2026-09-15T12:00:00Z',scoreVersion:'relevance-v1',themes:[],connectors:[],discoveries:[]}};
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){}}}}'}));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()!=='GET')writes.push(path);
    if(path==='/api/config')return route.fulfill({json:{googleClientId:'test-client'}});
    if(path==='/api/session'&&route.request().method()==='DELETE'){authorized=false;return route.fulfill({json:{ok:true}});}
    if(!authorized)return route.fulfill({status:401,json:{error:'missing_token'}});
    if(path==='/api/accounts')return route.fulfill({json:{account:'owner@example.test',accounts:[]}});
    if(path==='/api/graph')return route.fulfill({json:{account:'owner@example.test',graph}});
    if(path==='/api/relevance')return route.fulfill({json:graph.relevance});
    return route.fulfill({json:{themes:[],themeSignals:[]}});
  });
  const stamp=new Date().toISOString();
  const batch={version:1,id:'pilot',account:'owner@example.test',reviewedAt:stamp,notes:[{id:'11111111-1111-4111-8111-111111111111',title:'Private fictional planning',date:stamp}],themes:[{id:'memory',name:'Fictional memory priority',status:'active',whyNow:'A recent explicit question.',suggestion:'Review the need before contacting anyone.',evidence:[{noteId:'11111111-1111-4111-8111-111111111111',text:'A fictional need was recorded.',attribution:'Meeting summary, not a direct quote'}],people:[{label:'Ada Rivera',matchName:'Ada',matchCompany:'example.test',context:'Named in a summary, not proof of expertise.'}]},{id:'old',name:'Completed fictional task',status:'superseded',whyNow:'A newer decision replaced the old task.',suggestion:'Do not repeat the old action.',evidence:[{noteId:'11111111-1111-4111-8111-111111111111',text:'The fictional transfer completed.',attribution:'Meeting summary'}],people:[]}]};
  const upload=async value=>page.getByLabel('Reviewed meeting batch').setInputFiles({name:'reviewed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
  await page.goto(process.env.PEOPLE_TEST_ORIGIN || 'http://127.0.0.1:4183');
  await page.getByRole('button',{name:'Meeting preview',exact:true}).click();
  assert.equal(await page.getByRole('dialog').count(),1,await page.locator('body').innerText());
  await upload({...batch,account:'foreign@example.test'});
  await page.getByRole('button',{name:'Load private preview',exact:true}).click();
  await page.getByText('This preview belongs to a different account.',{exact:true}).waitFor();
  assert.match(await page.getByRole('dialog').innerText(),/different account/);
  await upload(batch);await page.getByRole('button',{name:'Load private preview',exact:true}).click();
  await page.getByRole('button',{name:'Why Fictional memory priority is hot now'}).waitFor();
  assert.equal(await page.locator('.rg-node').count(),115);
  for (const width of [1280, 1024, 859, 390]) {
    await page.setViewportSize({width,height:900});
    const overlaps = await page.evaluate(() => {
      const source=document.querySelector('#source-wrap').getBoundingClientRect();
      return [...document.querySelectorAll('.top-actions > *')].some(element => {
        const actions=element.getBoundingClientRect();
        return actions.width > 0 && source.left < actions.right && source.right > actions.left && source.top < actions.bottom && source.bottom > actions.top;
      });
    });
    assert.equal(overlaps,false,`preview controls must not overlap the source picker at ${width}px`);
  }
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Why Fictional memory priority is hot now'}).click();
  const panel=page.getByLabel('Why this is hot now',{exact:true});
  assert.match(await panel.innerText(),/Our suggestion/i);assert.match(await panel.innerText(),/Meeting summary, not a direct quote/);
  assert.equal(await panel.getByRole('link',{name:'Private fictional planning'}).getAttribute('href'),'https://notes.granola.ai/d/11111111-1111-4111-8111-111111111111');
  await panel.getByRole('button',{name:'Still relevant',exact:true}).click();
  assert.match(await panel.innerText(),/7 days/);
  await panel.getByRole('button',{name:'Resolved',exact:true}).click();
  assert.equal(await page.locator('.rg-node[data-hot="true"]').count(),0);
  await panel.getByRole('button',{name:'Review meeting batch',exact:true}).click();
  assert.match(await page.getByLabel('Meeting preview review').innerText(),/superseded/);
  assert.match(await page.getByLabel('Meeting preview review').innerText(),/resolved/);
  for(const lens of ['firm','public','off']){
    await page.getByLabel('Relevance now').selectOption(lens);
    assert.doesNotMatch(await page.locator('body').innerText(),/Fictional memory priority|Private fictional planning/);
  }
  await page.getByLabel('Relevance now').selectOption('my');
  await page.getByRole('button',{name:'Review meeting batch',exact:true}).click();
  assert.match(await page.getByLabel('Meeting preview review').innerText(),/Fictional memory priority/);
  assert.deepEqual(writes,[],'preview and feedback must not call mutation APIs');
  assert.ok(requests.every(url=>!decodeURIComponent(url).includes('meeting-preview:')),'private preview identifiers must not leave the browser, including GET evidence lookups');
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('Fictional')),false);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('button',{name:'Meeting preview',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Review meeting batch',exact:true}).count(),0);
  await page.getByRole('button',{name:'Meeting preview',exact:true}).click();await upload(batch);await page.getByRole('button',{name:'Load private preview',exact:true}).click();
  await page.getByRole('button',{name:'Why Fictional memory priority is hot now'}).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Meeting preview',exact:true}).waitFor({state:'hidden'});
  assert.doesNotMatch(await page.locator('body').innerText(),/Fictional memory priority|Private fictional planning/);
  assert.deepEqual(errors,[]);
  console.log('PASS: private batch import, account binding, source evidence, local feedback, shared-lens isolation, full network, refresh and sign-out clearing.');
  await page.close();
} finally {await browser.close();}
