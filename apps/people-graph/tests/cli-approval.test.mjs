import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
test('editing a code invalidates an in-flight device preview',async()=>{
 const elements=new Map();const element=s=>{if(!elements.has(s))elements.set(s,{value:'',hidden:true,disabled:false,textContent:'',replaceChildren(){}});return elements.get(s);};let resolve;
 const sandbox={document:{querySelector:element},fetch:()=>new Promise(r=>resolve=r),setTimeout,window:{},console};vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../public/cli.mjs',import.meta.url),'utf8'),sandbox);
 element('#user-code').value='AAAAAAAAAAAA';const pending=element('#code-form').onsubmit({preventDefault(){}});element('#user-code').value='BBBBBBBBBBBB';element('#user-code').oninput();resolve({ok:true,json:async()=>({owner:'owner@test',deviceName:'Device A'})});await pending;assert.equal(element('#approval').hidden,true);
});
