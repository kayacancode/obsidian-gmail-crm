const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4182/spatial.html');
assert.equal(await page.locator('.orb').count(),7);
const before=await page.locator('.orb').first().getAttribute('style');await page.getByRole('button',{name:'Rotate network right'}).click();assert.notEqual(await page.locator('.orb').first().getAttribute('style'),before);
await page.screenshot({path:'/tmp/people-spatial.png',fullPage:true});
await page.locator('.orb').first().click();assert.match(await page.locator('#card').innerText(),/Why this connection/i);
await page.getByRole('button',{name:'Add to shortlist +',exact:true}).click();assert.ok(await page.getByRole('button',{name:'Remove from shortlist −',exact:true}).isVisible());
await page.screenshot({path:'/tmp/people-spatial-person.png',fullPage:true});
await page.getByRole('button',{name:'Explore Studio updates'}).click();assert.match(await page.locator('#card').innerText(),/What they are looking for/i);
await page.getByRole('button',{name:'Draft a one-on-one'}).click();await page.getByRole('textbox',{name:'Message draft'}).fill('My edited note');assert.equal(await page.getByRole('textbox',{name:'Message draft'}).inputValue(),'My edited note');
await page.getByRole('button',{name:'Build a panel',exact:true}).click();await page.getByRole('button',{name:'View shortlist (1)'}).click();assert.match(await page.locator('#card').innerText(),/Amara Chen/);
await page.getByRole('textbox',{name:'Explore the demo network'}).fill('Where are all my friends right now?');await page.getByRole('button',{name:'Explore question',exact:true}).click();assert.match(await page.locator('.query-note').innerText(),/not connected yet/);
await page.getByRole('button',{name:'Find investors',exact:true}).click();assert.equal(await page.locator('.orb').count(),3);
await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Build a panel',exact:true}).click();await page.waitForTimeout(200);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/people-spatial-mobile.png',fullPage:true});
assert.deepEqual(errors,[]);console.log('PASS: 3D rotation, person/company cards, shortlist, editable draft, unsupported query, scenario switching, mobile layout, no JS errors.');
}finally{await browser.close();}
