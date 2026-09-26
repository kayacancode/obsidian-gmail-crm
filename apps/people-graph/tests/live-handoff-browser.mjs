import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const graph={source:'workspace',workspaceId:'team',workspaceName:'Our team',revision:1,members:[{id:'me',name:'Viewer',isMe:true},{id:'other',name:'Teammate'}],nodes:[{id:'a',name:'Real fixture contact',type:'person',relationships:[{memberId:'other',memberName:'Teammate',evidenceCategory:'email',score:61}]}],edges:[],themes:[],themeSignals:[],coverage:{sources:[],contributors:1}};
 await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({body:''}));
 await page.route('**/api/**',r=>{const path=new URL(r.request().url()).pathname;calls.push({path,body:r.request().postData()});if(path==='/api/accounts')return r.fulfill({json:{account:'viewer@example.com',accounts:[]}});if(path==='/api/workspaces')return r.fulfill({json:{workspaces:[{id:'team',name:'Our team'}]}});if(path.endsWith('/graph'))return r.fulfill({json:{account:'viewer@example.com',graph}});if(path.endsWith('/search'))return r.fulfill({json:{checked:false,results:[{personId:'a',name:'Real fixture contact',reasons:[]}]}});if(path.endsWith('/members'))return r.fulfill({json:{workspace:{revision:1}}});return r.fulfill({json:{requests:[]}});});
 await page.goto('http://127.0.0.1:4196/?workspace=team');
 await page.getByRole('heading',{name:'Our team',exact:true}).waitFor({timeout:5000});
 await page.getByRole('button',{name:'Who can help with our agent interfaces event?',exact:true}).click();
 await page.getByRole('dialog',{name:'Person and introduction route'}).getByRole('heading',{name:'Real fixture contact'}).waitFor();
 assert.ok(calls.some(c=>c.path==='/api/workspaces/team/search'));assert.ok(!calls.some(c=>c.path.includes('intro-requests')&&c.body));
 await page.getByRole('button',{name:'Ask Teammate for an intro'}).click();await page.getByLabel('Message',{exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Send request',exact:true}).isVisible());
 await page.getByRole('button',{name:'Close introduction sheet'}).click();await page.screenshot({path:'/tmp/live-handoff-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/live-handoff-mobile.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS shared header, real scoped search integration, explicit send composer, mobile');
}finally{await browser.close();}
