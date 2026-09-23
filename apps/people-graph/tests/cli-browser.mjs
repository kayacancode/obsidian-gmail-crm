import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let approved=false,previewOwner='owner@test.com',expired=false; let failRevoke=true;
 await page.route('https://accounts.google.com/gsi/client',r=>r.fulfill({body:''}));
 await page.route('**/api/cli/device/preview',r=>r.fulfill(expired?{status:400,json:{error:'invalid_code'}}:{json:{deviceName:'My Mac',owner:previewOwner,scope:'Read-only People queries'}}));
 await page.route('**/api/cli/device/approve',r=>{approved=true;return r.fulfill({json:{approved:true}});});
 await page.goto((process.env.PEOPLE_TEST_ORIGIN||'http://127.0.0.1:4183')+'/cli.html');
 await page.getByLabel('Code from your terminal').fill('ABCDEF123456');await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByText('My Mac', {exact:false}).waitFor();assert.equal(approved,false);
 previewOwner='other@test.com';await page.getByRole('button',{name:'Approve read-only access'}).click();await page.getByText('Your account changed.',{exact:false}).waitFor();assert.equal(approved,false);
 await page.getByRole('button',{name:'Approve read-only access'}).click();await page.getByText('Connected. Return to your terminal.').waitFor();assert.equal(approved,true);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 expired=true;await page.reload();await page.getByLabel('Code from your terminal').fill('ABCDEF123456');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByText('This code is unavailable or expired.',{exact:false}).waitFor();assert.ok(await page.locator('#approval').isHidden());
 await page.evaluate(async()=>{const {createCliDevices}=await import('/cli-devices.mjs');const root=document.createElement('section');root.id='test-devices';document.body.append(root);window.devicePanel=createCliDevices({root,request:async(path)=>{if(path.includes('revoke'))throw Error('offline');return {devices:[{id:'d',name:'Laptop',expiresAt:2000000000}]};}});window.devicePanel.setAccount('owner@test');});
 await page.getByText('Laptop', {exact:false}).waitFor();await page.getByRole('button',{name:'Revoke access'}).click();await page.getByText('Could not revoke access.',{exact:false}).waitFor();assert.ok(await page.getByText('Laptop',{exact:false}).isVisible());await page.evaluate(()=>window.devicePanel.clear());assert.ok(await page.locator('#test-devices').isHidden());
 console.log('PASS: approval requires explicit confirmation, shows owner and device, works on mobile');
}finally{await browser.close();}
