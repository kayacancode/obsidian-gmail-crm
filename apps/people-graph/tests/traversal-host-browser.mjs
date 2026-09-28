import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const graph={source:'workspace',workspaceId:'test',workspaceName:'Test',revision:1,nodes:[{id:'a',name:'Ada',type:'person',relationships:[{memberId:'me',evidenceCategory:'email'}]}],edges:[],members:[{id:'me',name:'You',isMe:true}],themes:[],themeSignals:[],coverage:{unavailable:[]}};
 await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({body:''}));
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;
  if(p==='/api/accounts')return r.fulfill({json:{account:'user@example.com',accounts:[]}});
  if(p==='/api/workspaces')return r.fulfill({json:{workspaces:[{id:'test',name:'Test'}]}});
  if(p.endsWith('/graph'))return r.fulfill({json:{account:'user@example.com',graph}});
  if(p.endsWith('/members'))return r.fulfill({json:{workspace:{revision:1}}});
  if(p.endsWith('/search-stream'))return r.fulfill({contentType:'application/x-ndjson',body:[{type:'start',label:'Shared network loaded',people:1,unavailable:0},{type:'scope',memberId:'me',label:'You',people:1,matches:1},{type:'candidate',memberId:'me',label:'You',personId:'a',reason:'Profile match',evidence:[]},{type:'result',answer:{query:'Ada',results:[{personId:'a',name:'Ada',score:1,reasons:[]}],checked:false}}].map(e=>JSON.stringify(e)+'\n').join('')});
  return r.fulfill({json:{}});
 });
 await page.goto('http://127.0.0.1:4198/?workspace=test');await page.getByRole('searchbox',{name:'Ask your network',exact:true}).fill('Ada');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('heading',{name:'Follow the answer',exact:true}).waitFor();await page.getByRole('heading',{name:'People to explore',exact:true}).waitFor();assert.equal(await page.getByRole('dialog',{name:'Person and introduction route'}).count(),0);
 await page.locator('.nc-traversal-result').click();await page.getByRole('region',{name:'Focused connection walk'}).waitFor();await page.getByRole('button',{name:'Clear search',exact:true}).click();assert.equal(await page.locator('.nc-traversal').count(),0);assert.deepEqual(errors,[]);console.log('PASS shared query stream, graph result, open person and clear lifecycle');
}finally{await browser.close();}
