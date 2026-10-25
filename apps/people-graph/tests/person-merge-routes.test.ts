import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './person-context.test';
import {opaque} from '../src/mail-model';

test('owner person merges require a session, same-origin writes and exact bounded fields',async()=>{
 const f=await fixture();try{
  const path='/api/people/person-merges';
  assert.equal((await f.request(path,undefined,{signed:false})).status,401);
  assert.equal((await f.request(path,{sourceId:f.personId,targetId:'other'},{origin:'https://untrusted.test'})).status,403);
  for(const body of [{sourceId:f.personId,targetId:'other',owner:'other@example.test'},{sourceId:f.personId},{sourceId:'a@example.test',targetId:'other'}])assert.equal((await f.request(path,body)).status,400);
  assert.equal((await f.request(path,undefined,{method:'PUT'})).status,405);
  f.add('ada@new.example.test','Ada');const alias=await opaque('owner@example.test','ada@new.example.test',f.env.TOKEN_SECRET);
  const result=await f.request(path,{sourceId:alias,targetId:f.personId});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual((await (await f.request(path)).json()).merges,{[alias]:f.personId});
  assert.equal((await f.request(path,{sourceId:'unknown',targetId:f.personId})).status,404);
  assert.equal((await f.request(path,{sourceId:alias},{method:'DELETE'})).status,200);
  assert.deepEqual((await (await f.request(path)).json()).merges,{});
 }finally{f.db.close();}
});
