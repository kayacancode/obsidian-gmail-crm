import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const server=createServer(async(req,res)=>{const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!path.startsWith(root+sep)){res.setHeader('content-type','text/html');res.end('<html><head><link rel="stylesheet" href="/relationship-graph/graph.css"><style>body{margin:24px;max-width:600px;font-family:Arial}</style></head><body></body></html>');return;}try{res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'text/html');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,failure;
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(async()=>{
 const {createPeopleIntegrations}=await import('/people-integrations.mjs');window.calls=[];window.clipboardText='';
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.clipboardText=text}});
 const root=document.createElement('main');document.body.append(root);window.panel=createPeopleIntegrations(root,{request:async(path,body,method,key)=>{window.calls.push({path,body,method,key});if(path==='/api/people-agent/lens'){if(key!=='people_test_secret')throw Error('wrong token');return {fields:{focus:'Healthcare workflow tools',needs:'',offers:''}};}if(method==='GET')return {tokens:[],apiUrl:location.origin+'/api/people-agent',mcpUrl:location.origin+'/api/people-mcp'};return {token:'people_test_secret',credential:{id:'1',name:body.name,scopes:body.scopes,createdAt:Date.now(),expiresAt:Date.now()+100000}};}});window.panel.setAccount('owner@test');window.panel.refresh();
 });
 await page.getByRole('button',{name:'Copy MCP configuration',exact:true}).click();
 const config=JSON.parse(await page.evaluate(()=>window.clipboardText));assert.match(config.mcpServers.people.url,/\/api\/people-mcp$/);assert.equal(config.mcpServers.people.headers.Authorization,'Bearer <YOUR_PEOPLE_API_KEY>');
 await page.getByRole('textbox',{name:'Integration name',exact:true}).fill('My agent');await page.getByRole('button',{name:'Create API key',exact:true}).click();await page.getByRole('button',{name:'Test this key',exact:true}).click();await page.getByText('Connected. Your agent can read your saved lens.',{exact:true}).waitFor();
 const check=await page.evaluate(()=>window.calls.find(call=>call.path==='/api/people-agent/lens'));assert.equal(check.key,'people_test_secret');assert.equal(check.method,'GET');
 await page.getByRole('button',{name:'Copy MCP configuration',exact:true}).click();assert.ok(!(await page.evaluate(()=>window.clipboardText)).includes('people_test_secret'));
 await page.getByRole('button',{name:'I saved the key',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Test this key',exact:true}).count(),0);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/people-agent-onboarding-mobile.png'});
 await page.evaluate(()=>window.panel.setAccount('other@test'));assert.equal(await page.getByRole('textbox',{name:'New API key',exact:true}).count(),0);assert.deepEqual(errors,[]);
 console.log('PASS agent onboarding: MCP placeholder config, exact scoped key check, secret dismissal, account switch and mobile');
}catch(error){failure=error;}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.race([browser?.close(),new Promise(resolve=>setTimeout(resolve,2000))]);}
if(failure)console.error(failure);process.exit(failure?1:0);
