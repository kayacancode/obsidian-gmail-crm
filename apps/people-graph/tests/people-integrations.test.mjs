import assert from 'node:assert/strict';
import test from 'node:test';
import {createPeopleIntegrations} from '../public/people-integrations.mjs';

// Minimal DOM for the panel's focus, copy and account lifecycle; viewport layout
// is checked separately on the complete Accounts page.
function documentFixture(){
 const doc={activeElement:null,copied:null,defaultView:{navigator:{clipboard:{writeText:async value=>{doc.copied=value;}}}}};
 doc.createElement=tag=>({tag,ownerDocument:doc,children:[],attributes:{},style:{},textContent:'',value:'',disabled:false,
  append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},
  setAttribute(name,value){this.attributes[name]=value;},
  focus(){doc.activeElement=this;},select(){this.selected=true;},scrollIntoView(){this.scrolled=true;},
  querySelector(tag){return descendants(this).find(node=>node.tag===tag);},
 });
 doc.createTextNode=text=>({textContent:text,children:[]});
 return doc;
}
function descendants(root){return [root,...root.children.flatMap(descendants)];}
function control(root,label){return descendants(root).find(node=>node.attributes?.['aria-label']===label||node.tag==='button'&&node.textContent===label);}
async function fixture({deferCreate=false}={}){
 const doc=documentFixture(),root=doc.createElement('main');let resolveCreate;
 const credential={id:'sample-id',name:'botwick',scopes:['people:read'],createdAt:1,expiresAt:Date.now()+86400000};
 const response={token:'people_fake_test_key',credential};
 const panel=createPeopleIntegrations(root,{request:async(path,body,method)=>{
  if(method==='GET')return {tokens:[],apiUrl:'https://people.test/api/people-agent',mcpUrl:'https://people.test/api/people-mcp'};
  assert.equal(path,'/api/people/integrations');assert.deepEqual(body,{name:'botwick',scopes:['people:read']});
  return deferCreate?new Promise(resolve=>{resolveCreate=resolve;}):response;
 }});
 panel.setAccount('owner@example.test');panel.refresh();await new Promise(resolve=>setImmediate(resolve));
 const create=()=>{control(root,'Integration name').value='botwick';return descendants(root).find(node=>node.tag==='form').onsubmit({preventDefault(){}});};
 return {doc,root,panel,create,resolveCreate:()=>resolveCreate(response)};
}

test('creating a key brings its copy field into focus and prevents replacing an unsaved key',async()=>{
 const {doc,root,create}=await fixture();await create();
 const key=control(root,'New API key');assert.equal(key.value,'people_fake_test_key');
 assert.equal(doc.activeElement,key,'the new key must receive focus instead of appearing above the viewport unnoticed');
 assert.equal(key.selected,true);assert.equal(control(root,'Create API key').disabled,true);
 await control(root,'Copy API key').onclick();assert.equal(doc.copied,'people_fake_test_key');
});

test('acknowledging a copied key removes it and allows another integration',async()=>{
 const {root,create}=await fixture();await create();await control(root,'I saved the key').onclick();
 assert.equal(control(root,'New API key'),undefined);
 assert.equal(control(root,'Create API key').disabled,false);
 assert.ok(descendants(root).some(node=>node.textContent==='botwick'));
 assert.ok(!descendants(root).some(node=>node.value==='people_fake_test_key'));
});

test('leaving integrations clears the one-time key even when the panel is reopened',async()=>{
 const {root,panel,create}=await fixture();await create();panel.suspend();panel.refresh();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(control(root,'New API key'),undefined);
});

test('a key response arriving after an account switch is never displayed',async()=>{
 const {root,panel,create,resolveCreate}=await fixture({deferCreate:true});const pending=create();
 panel.setAccount('other@example.test');resolveCreate();await pending;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(control(root,'New API key'),undefined);
 assert.ok(!descendants(root).some(node=>node.value==='people_fake_test_key'));
});

test('integration scope choices send only selected grants and display administrative access accurately',async()=>{
 const doc=documentFixture(),root=doc.createElement('main');let submitted;
 const panel=createPeopleIntegrations(root,{request:async(path,body,method)=>{
  if(method==='GET')return {tokens:[{id:'source-key',name:'Source sync',scopes:['sources:manage'],expiresAt:Date.now()+86400000}],scopes:['people:read','people:write','sources:manage','sharing:manage','booking:manage','integrations:manage']};
  submitted=body;return {token:'people_test',credential:{id:'new',name:body.name,scopes:body.scopes,expiresAt:Date.now()+86400000}};
 }});
 panel.setAccount('owner@example.test');panel.refresh();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(descendants(root).some(node=>node.tag==='small'&&node.textContent.includes('sources:manage')));
 assert.ok(!descendants(root).some(node=>node.tag==='small'&&node.textContent.startsWith('Read only')));
 control(root,'Integration name').value='Source agent';
 control(root,'sources:manage').checked=true;control(root,'integrations:manage').checked=true;
 await descendants(root).find(node=>node.tag==='form').onsubmit({preventDefault(){}});
 assert.deepEqual(submitted,{name:'Source agent',scopes:['people:read','sources:manage','integrations:manage']});
});
