import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../public/',import.meta.url));
const html='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/relationship-graph/graph.css"></head><body style="margin:0"><div id="graph"></div></body></html>';
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://local').pathname;
 if(pathname==='/__person-connection-fixture'){res.setHeader('content-type','text/html');res.end(html);return;}
 const path=resolve(root,'.'+pathname);
 if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return;}
 try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
let browserServer,browser;
const watchdog=setTimeout(()=>{console.error('FAIL person connection browser: exceeded 45-second test deadline');browserServer?.process()?.kill('SIGKILL');server.closeAllConnections();process.exit(1);},45000);
async function boundedClose(operation){
 let timer;
 try{await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser shutdown timeout')),5000);})]);}
 finally{clearTimeout(timer);}
}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 // launchServer exposes only this test's child process, so shutdown can be bounded.
 browserServer=await chromium.launchServer({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',timeout:10000});
 browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:10000});
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];
 page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/__person-connection-fixture');
 await page.evaluate(async()=>{
  const {mountGraph}=await import('/relationship-graph/graph.mjs');
  window.connectionGraph=mountGraph(document.querySelector('#graph'),{graph:{source:'email_accounts',nodes:[
   {id:'reciprocal',name:'Jordan Rivera',type:'person',directRelationship:true,contactActivity:{sent:12,received:7,meetings:2},strength:70,momentum:50,combined:60},
   {id:'incoming',name:'Maya Chen',type:'person',directRelationship:true,contactActivity:{sent:0,received:3,meetings:0},strength:20,momentum:20,combined:20},
   {id:'unknown',name:'Avery Stone',type:'person',combined:90,lastContact:'2026-10-19T12:00:00Z'},
   {id:'shared',name:'Sam Patel',type:'person',directRelationship:false,via:['Morgan Lee'],contactActivity:{sent:888,received:777,meetings:66}},
  ],edges:[{id:'undirected-intro',source:'unknown',target:'shared',kind:'cooccurrence',types:['introduced_by'],label:'via Morgan'}],themes:[],themeSignals:[]}});
 });
 const panel=page.getByRole('region',{name:'Selected item and connections'});
 const cases=[
  {id:'reciprocal',name:'Jordan Rivera',line:'You’ve exchanged emails',detail:'12 sent · 7 received · 2 meeting records. From your imported history.'},
  {id:'incoming',name:'Maya Chen',line:'They’ve emailed you',detail:'0 sent · 3 received. From your imported history.'},
  {id:'unknown',name:'Avery Stone',line:'In your network',detail:'The imported records don’t say how you first connected.'},
  {id:'shared',name:'Sam Patel',line:'Shared by Morgan Lee',detail:'This person was shared into your network. A share does not record an introduction.'},
 ];
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});
  for(const sample of cases){
   await page.evaluate(id=>window.connectionGraph.select(id),sample.id);
   const heading=panel.getByRole('heading',{level:2,name:sample.name,exact:true});await heading.waitFor();
   const summary=panel.locator('.rg-how-you-know'),line=summary.locator('.rg-connection-line'),details=summary.locator('details');
   assert.equal(await line.innerText(),sample.line,`${sample.id} has the evidence-supported direction at ${width}px`);
   assert.equal(await heading.evaluate(node=>node.nextElementSibling?.matches('.rg-how-you-know')&&node.nextElementSibling.firstElementChild?.matches('.rg-connection-line')),true,'connection summary is immediately below the person name');
   assert.equal(await details.evaluate(node=>node.open),false,'counts and caveats start collapsed');
   assert.equal(await details.locator('p').isVisible(),false);
   await details.getByText('Connection details',{exact:true}).click();
   assert.equal(await details.locator('p').innerText(),sample.detail);
   assert.equal(await details.locator('p').isVisible(),true,'disclosure exposes the actual counts or the evidence limitation');
   if(['unknown','shared'].includes(sample.id)){
    assert.doesNotMatch(await line.innerText(),/introduced|exchanged|emailed|you met/i,'sharing and undirected intro edges cannot invent personal history');
    assert.doesNotMatch(await summary.innerText(),/888|777|66/,'another contributor’s counts are not the viewer’s activity');
   }
   const bounds=await summary.evaluate(node=>{const r=node.getBoundingClientRect(),h=node.previousElementSibling.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,headingBottom:h.bottom,scroll:node.scrollWidth,width:node.clientWidth,viewport:innerWidth,pageWidth:document.documentElement.scrollWidth};});
   assert.ok(bounds.top>=bounds.headingBottom&&bounds.top-bounds.headingBottom<=24,'summary stays visually adjacent to the name');
   assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport+1&&bounds.scroll<=bounds.width+1&&bounds.pageWidth<=bounds.viewport+1,`no horizontal overflow for ${sample.id} at ${width}px`);
   if(sample.id==='reciprocal'&&width!==320){await heading.scrollIntoViewIfNeeded();await page.screenshot({path:width===1280?'/tmp/person-connection-desktop.png':'/tmp/person-connection-mobile.png'});}
  }
 }
 assert.deepEqual(errors,[]);
 console.log('PASS person connection browser: below-name placement, reciprocal/incoming direction, unknown/shared attribution, disclosure counts, desktop and mobile overflow');
}catch(error){console.error(error);process.exitCode=1;}
finally{
 server.closeAllConnections();server.close();
 try{if(browser)await boundedClose(()=>browser.close());if(browserServer)await boundedClose(()=>browserServer.close());}
 catch(error){console.warn('Browser assertions finished; forced cleanup after '+error.message);browserServer?.process()?.kill('SIGKILL');}
 clearTimeout(watchdog);
 // A macOS Chrome shutdown can leave Playwright transport handles alive after its
 // child has exited. All assertions have completed and owned resources are closed.
 process.exit(process.exitCode||0);
}
