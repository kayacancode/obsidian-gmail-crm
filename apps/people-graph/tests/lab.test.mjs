import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize} from '../public/model.mjs';
import {demo} from '../public/lab/demo.mjs';
import {VIEWS,layout} from '../public/lab/layouts.mjs';
test('ten layouts produce distinct finite 3D coordinates without changing graph identity',()=>{const graph=normalize(demo()),signatures=new Set();assert.equal(VIEWS.length,10);for(const view of VIEWS){const result=layout(view.id,graph,graph.nodes);assert.deepEqual(result.positions.map(p=>p.id),graph.nodes.map(n=>n.id));assert.ok(result.positions.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));signatures.add(JSON.stringify(result.positions.map(p=>[p.x,p.y,p.z])));}assert.equal(signatures.size,10);});
test('layouts tolerate empty graphs and unknown scores and dates',()=>{for(const nodes of [[],[{id:'1',name:'Unknown'}]]){const graph=normalize({nodes,edges:[]});for(const view of VIEWS)assert.ok(layout(view.id,graph,graph.nodes).positions.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));}});

test('helix separates people with identical or missing last-contact dates',()=>{for(const lastContact of [undefined,'2026-09-01']){const graph=normalize({nodes:Array.from({length:30},(_,i)=>({id:String(i),lastContact})),edges:[]});const positions=layout('helix',graph,graph.nodes).positions;assert.equal(new Set(positions.map(p=>JSON.stringify([p.x,p.y,p.z]))).size,30);}});
