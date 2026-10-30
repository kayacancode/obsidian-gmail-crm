import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
test('editing a code invalidates an in-flight device preview',async()=>{
 const elements=new Map();const element=s=>{if(!elements.has(s))elements.set(s,{value:'',hidden:true,disabled:false,textContent:'',replaceChildren(){}});return elements.get(s);};let resolve;
 const sandbox={document:{querySelector:element},fetch:()=>new Promise(r=>resolve=r),setTimeout,window:{},console};vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../public/cli.mjs',import.meta.url),'utf8'),sandbox);
 element('#user-code').value='AAAAAAAAAAAA';const pending=element('#code-form').onsubmit({preventDefault(){}});element('#user-code').value='BBBBBBBBBBBB';element('#user-code').oninput();resolve({ok:true,json:async()=>({owner:'owner@test',deviceName:'Device A'})});await pending;assert.equal(element('#approval').hidden,true);
});

function approvalFixture(previews){
 const elements=new Map(),element=s=>{if(!elements.has(s))elements.set(s,{value:'',hidden:true,disabled:false,textContent:'',children:[],replaceChildren(...nodes){this.children=nodes;}});return elements.get(s);};
 const approved=[];let count=0;
 const sandbox={document:{querySelector:element,createElement:()=>({textContent:''})},fetch:async(path,options)=>{
  if(path.endsWith('/preview'))return {ok:true,json:async()=>previews[Math.min(count++,previews.length-1)]};
  if(path.endsWith('/approve')){approved.push(JSON.parse(options.body));return {ok:true,json:async()=>({approved:true})};}
  throw Error('Unexpected request '+path);
 },setTimeout,window:{},console};
 vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../public/cli.mjs',import.meta.url),'utf8'),sandbox);
 element('#user-code').value='ABCDEF123456';
 return {element,approved,preview:()=>element('#code-form').onsubmit({preventDefault(){}})};
}
const scopedPreview={owner:'owner@test',deviceName:'Terminal',scopes:['people:read','people:write'],scopeDescriptions:[
 {scope:'people:read',description:'Read your private People network, Lens and relationship context'},
 {scope:'people:write',description:'Edit your private Lens, people and relationship context'}
],credentialExpiresInDays:90};

test('scoped approval displays exact scope descriptions and submits the reviewed grants',async()=>{
 const {element,approved,preview}=approvalFixture([scopedPreview]);await preview();
 assert.equal(element('#approval').hidden,false);
 assert.deepEqual(element('#scopes').children.map(node=>node.textContent),[
  'people:read — Read your private People network, Lens and relationship context',
  'people:write — Edit your private Lens, people and relationship context'
 ]);
 assert.equal(element('#expiry').textContent,'Access expires after 90 days. Revoke it any time in Accounts → Integrations.');
 assert.equal(element('#approve').textContent,'Approve these permissions');
 await element('#approve').onclick();
 assert.deepEqual(approved,[{userCode:'ABCDEF123456',expectedOwner:'owner@test',expectedScopes:['people:read','people:write']}]);
});

test('scopes changed after preview require fresh review before approval',async()=>{
 const changed={...scopedPreview,scopes:['people:read'],scopeDescriptions:[scopedPreview.scopeDescriptions[0]]};
 const {element,approved,preview}=approvalFixture([scopedPreview,changed]);await preview();await element('#approve').onclick();
 assert.deepEqual(approved,[]);assert.equal(element('#approval').hidden,false);
 assert.match(element('#status').textContent,/permissions changed/);
 assert.equal(element('#scopes').children.length,1);
 await element('#approve').onclick();assert.deepEqual(approved[0].expectedScopes,['people:read']);
});

test('scoped approval remains unavailable if any permission description is missing',async()=>{
 const {element,approved,preview}=approvalFixture([{...scopedPreview,scopeDescriptions:[scopedPreview.scopeDescriptions[0]]}]);await preview();await element('#approve').onclick();
 assert.equal(element('#approval').hidden,true);assert.deepEqual(approved,[]);
});
