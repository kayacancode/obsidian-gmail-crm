import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let joined=false,savedContribution=null;
 const workspace={id:'test-team',name:'Betaworks',role:'member',memberId:'m2',memberCount:2,contribution:{enabled:false,scope:{kind:'all'},level:'names'}};
 await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({body:''}));
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;
 if(p==='/api/accounts')return r.fulfill({json:{account:'new@example.com',configured:true,accounts:[]}});
 if(p==='/api/workspace-invites/accept'){joined=true;return r.fulfill({json:{workspace}});}
 if(p==='/api/workspaces')return r.fulfill({json:{workspaces:joined?[workspace]:[]}});
 if(p.endsWith('/contribution')){savedContribution=r.request().postDataJSON();return r.fulfill({json:{ok:true}});}
 if(p.endsWith('/members'))return r.fulfill({json:{workspace,members:[{id:'m2',email:'new@example.com',isMe:true,role:'member',sharing:false}],invites:[]}});
 return r.fulfill({json:{graph:null}});
 });
 await page.goto((process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4194')+'/accounts.html#workspace-invite=test-team.secret');
 await page.getByRole('button',{name:'Accept invitation',exact:true}).click();
 await page.getByRole('link',{name:'Open shared network',exact:true}).waitFor();
 assert.equal(joined,true);assert.equal(await page.getByText('Nothing shared yet.',{exact:true}).count(),1);
 assert.equal(await page.getByRole('link',{name:'Open shared network',exact:true}).getAttribute('href'),'/?workspace=test-team');
 workspace.contribution={enabled:true,scope:{kind:'folders',ids:['private-folder']},level:'names'};await page.reload();await page.getByText('Members, invitations & what I share',{exact:true}).click();await page.getByLabel('Context to share').selectOption('themes');assert.equal(await page.getByLabel('Share contact display names and photos',{exact:true}).isChecked(),false);await page.getByLabel('Share contact display names and photos',{exact:true}).check();await page.getByRole('button',{name:'Save sharing choices'}).click();await page.getByText('Sharing choices saved.',{exact:true}).waitFor();assert.equal(savedContribution.shareProfiles,true);assert.deepEqual(savedContribution.scope,{kind:'folders',ids:['private-folder']});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);await page.screenshot({path:'/tmp/people-workspace-onboarding.png',fullPage:true});console.log('PASS browser-only acceptance, private default, workspace link, mobile');
}finally{await browser.close();}
const graphBrowser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await graphBrowser.newPage(),errors=[],privateCalls=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const member={memberId:'member-a',memberName:'teammate@example.com',score:82,scoreVersion:'email-v1',lastContact:'2026-09-22T12:00:00Z',evidenceCategory:'email'};
 const graph={source:'workspace',workspaceId:'test-team',workspaceName:'Betaworks',revision:1,nodes:[{id:'ada',name:'Ada Designer',type:'person',directRelationship:false,combined:null,relationships:[member]}],edges:[],themes:[],themeSignals:[],coverage:{contributors:1,unavailable:[],truncated:false}};
 await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({body:''}));
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;
 if(p==='/api/accounts')return r.fulfill({json:{account:'new@example.com',accounts:[]}});
 if(p==='/api/workspaces')return r.fulfill({json:{workspaces:[{id:'test-team',name:'Betaworks'}]}});
 if(p.endsWith('/graph'))return r.fulfill({json:{account:'new@example.com',graph}});
 if(p.endsWith('/search'))return r.fulfill({json:{query:'designer',checked:false,results:[{personId:'ada',name:'Ada Designer',score:1,reasons:[]}]}});
 if(p.endsWith('/draft'))return r.fulfill({json:{to:'teammate@example.com',introVia:'teammate@example.com',subject:'Introduction to Ada',body:'Please introduce us.',basedOn:[]}});
 if(p.endsWith('/members'))return r.fulfill({json:{workspace:{revision:1}}});
 privateCalls.push(p);return r.fulfill({json:{}});
 });
 await page.goto((process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4194')+'/?workspace=test-team');
 await page.locator('.rg-node[data-node-id="ada"]').click();
 await page.getByRole('heading',{name:'Team relationships'}).waitFor();
 assert.match(await page.locator('.rg-context-panel').innerText(),/82 \/ 100/);
 await page.getByRole('button',{name:'Request intro from teammate@example.com',exact:true}).click();
 await page.getByLabel('Draft body',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Draft body',{exact:true}).inputValue(),'Please introduce us.');
 assert.deepEqual(privateCalls,[]);assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/people-shared-graph.png',fullPage:true});console.log('PASS shared Atlas with no own inbox, member score, editable intro, no private calls');
}finally{await graphBrowser.close();}
