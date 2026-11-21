import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const context=await browser.newContext();let approved=false,started=false,redeemed=false;
 const module=await readFile(new URL('../public/desktop-auth.mjs',import.meta.url),'utf8');
 await context.route('https://vault.test/**',r=>r.fulfill({contentType:'text/html',body:'<iframe src="https://people.test/?obsidian=1"></iframe><script>window.addEventListener("message",e=>window.handoff=e.data)</script>'}));
 await context.route('https://people.test/**',async r=>{
  const url=new URL(r.request().url());
  if(url.pathname==='/desktop-auth.mjs')return r.fulfill({contentType:'text/javascript',body:module});
  if(url.pathname==='/api/desktop-auth/start'){started=true;return r.fulfill({json:{ok:true}});}
  if(url.pathname==='/api/desktop-auth/redeem'){
   if(!approved)return r.fulfill({status:202,json:{pending:true}});
   redeemed=true;return r.fulfill({json:{ok:true},headers:{'set-cookie':'__Host-people-desktop=test; Path=/; HttpOnly; Secure; SameSite=None; Partitioned'}});
  }
  const cookie=r.request().headers().cookie;
  return r.fulfill({contentType:'text/html',body:cookie?.includes('__Host-people-desktop=test')?'<h1>Authenticated graph</h1>':'<div id="signin"></div><script type="module">import {installDesktopSignIn} from "/desktop-auth.mjs";installDesktopSignIn(document.querySelector("#signin"));</script>'});
 });
 const page=await context.newPage();await page.goto('https://vault.test/');
 const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'Sign in using your browser'}).click();
 await page.waitForFunction(()=>window.handoff?.type==='people:browser-signin');
 const message=await page.evaluate(()=>window.handoff);assert.match(message.url,/^https:\/\/people.test\/desktop-signin.html#[a-f0-9]{64}$/);assert.equal(started,true);
 approved=true;await frame.getByRole('heading',{name:'Authenticated graph'}).waitFor();assert.equal(redeemed,true);
 const cookies=await context.cookies();assert.ok(cookies.some(c=>c.name==='__Host-people-desktop'&&c.httpOnly&&c.secure&&c.sameSite==='None'));
 console.log('PASS: browser handoff, partitioned cookie and authenticated embedded reload');
}finally{await browser.close();}
