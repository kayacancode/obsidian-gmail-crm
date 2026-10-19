import assert from 'node:assert/strict';
import test from 'node:test';
import {createRelationshipController} from '../public/relationship-host.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(handler){
 const c=createRelationshipController({origin:'https://people.test',fetchImpl:async(path,init)=>{
  if(path==='/api/accounts')return json({account:'kaya@example.test',accounts:[]});
  if(path.startsWith('/api/graph'))return json({account:'kaya@example.test',graph:{source:path.includes('obsidian')?'obsidian':'email_accounts',nodes:[{id:'p',name:'Peer'}],edges:[],themes:[],themeSignals:[]}});
  return handler(path,init);
 }});
 await c.resume();return c;
}
test('owner lens discards a delayed private response after source changes',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const c=await fixture(()=>pending);
 assert.equal(typeof c.loadOwnerLens,'function','the personal lens needs a guarded controller entry point');
 const request=c.loadOwnerLens();
 await c.load('obsidian');release(json({fields:{focus:'Private work'}}));
 await assert.rejects(request,{name:'AbortError'});
 await assert.rejects(c.loadOwnerLens(),/My network/);
});
test('owner lens saves carry revision and conflicts remain distinguishable',async()=>{
 const calls=[];
 const c=await fixture((path,init)=>{calls.push({path,init});return json({error:'revision_conflict'},409);});
 assert.equal(typeof c.updateOwnerLens,'function','lens mutations need the guarded controller');
 await assert.rejects(c.updateOwnerLens({action:'save',revision:'r1',fields:{focus:'Agent interfaces',needs:'Research peers',offers:'Product feedback'}}),e=>e.status===409);
 assert.equal(calls[0].path,'/api/lens');
 assert.equal(JSON.parse(calls[0].init.body).revision,'r1');
 assert.equal(calls[0].init.headers.origin,'https://people.test');
});
test('sign-out aborts a pending owner match without returning private results',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const c=await fixture(path=>path==='/api/session'?json({ok:true}):pending);
 const request=c.findOwnerMatches();await c.signOut();release(json({results:[{personId:'p',reason:'Private match'}]}));
 await assert.rejects(request,{name:'AbortError'});
 await assert.rejects(c.findOwnerMatches(),/My network/);
});
