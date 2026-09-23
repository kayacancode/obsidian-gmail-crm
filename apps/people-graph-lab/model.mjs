export function normalize(input) {
 const g=input?.graph ?? input;
 if(!Array.isArray(g?.nodes)||!Array.isArray(g?.edges)) throw Error('Choose a people graph JSON file with nodes and edges.');
 if(g.nodes.length>1500||g.edges.length>20000) throw Error('This prototype supports up to 1,500 people and 20,000 connections.');
 const ids=new Set();
 const nodes=g.nodes.map(n=>{
  if(!n||typeof n.id!=='string'||!n.id||ids.has(n.id)) throw Error('Each person needs a unique text ID.');
  ids.add(n.id);
  return {...n,name:String(n.name||'Unnamed person'),company:String(n.company||'Unspecified'),strength:Number.isFinite(n.strength)?Math.max(0,Math.min(100,n.strength)):null};
 });
 const edges=g.edges.map(e=>{
  if(!e||!ids.has(e.source)||!ids.has(e.target)) throw Error('A connection references a person missing from this file.');
  return {...e,weight:Number.isFinite(e.weight)?Math.max(1,e.weight):1,types:Array.isArray(e.types)?e.types.filter(t=>typeof t==='string'):[],contexts:Array.isArray(e.contexts)?e.contexts.filter(t=>typeof t==='string'):[]};
 }).filter(e=>e.source!==e.target);
 return {nodes,edges,pushedAt:g.pushedAt};
}
export function focus(graph,query) {
 const q=query.trim().toLowerCase(); if(!q) return graph;
 const hit=n=>`${n.name} ${n.company}`.toLowerCase().includes(q);
 const ids=new Set(graph.nodes.filter(hit).map(n=>n.id));
 const edges=graph.edges.filter(e=>ids.has(e.source)||ids.has(e.target)||e.contexts.some(c=>c.toLowerCase().includes(q)));
 edges.forEach(e=>{ids.add(e.source);ids.add(e.target);});
 return {...graph,nodes:graph.nodes.filter(n=>ids.has(n.id)),edges};
}
export function metrics(graph) {
 const byId=new Map(graph.nodes.map(n=>[n.id,n]));
 return new Map(graph.nodes.map(n=>{
  const es=graph.edges.filter(e=>e.source===n.id||e.target===n.id);
  const neighbors=new Set(es.map(e=>e.source===n.id?e.target:e.source));
  return [n.id,{connections:neighbors.size,introductions:es.filter(e=>e.types.some(t=>t==='introduced'||t==='introduced_by')).length,companies:new Set([...neighbors].map(id=>byId.get(id).company)).size}];
 }));
}
export function daysAgo(date,now=new Date().toISOString()) {
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
 const days=Math.floor((Date.parse(now.slice(0,10))-Date.parse(date.slice(0,10)))/86400000);
 return Number.isFinite(days)&&days>=0?days:null;
}
