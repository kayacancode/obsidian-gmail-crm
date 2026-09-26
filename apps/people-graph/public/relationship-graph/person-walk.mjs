import {sharedPathGraph} from './shared-paths.mjs';
export function personWalk(graph,id,paths=sharedPathGraph(graph)){
 const person=graph.nodes.find(n=>n.id===id);if(!person)return null;
 const contributors=(graph.members||[]).filter(m=>person.relationships?.some(r=>r.memberId===m.id));
 const self=graph.members?.find(m=>m.isMe),start=paths.nodes.find(n=>n.memberId===self?.id&&n.memberId);
 const byId=new Map(paths.nodes.map(n=>[n.id,n])),adj=new Map();
 for(const e of paths.edges){if(!['personal','cooccurrence'].includes(e.kind))continue;for(const [a,b]of [[e.source,e.target],[e.target,e.source]]){const list=adj.get(a)||[];list.push({id:b,edge:e});adj.set(a,list);}}
 // Prefer recorded-contact-only paths; broaden to explicitly unverified co-occurrences only if necessary.
 for(const verifiedOnly of [true,false]){if(!start)break;const q=[{id:start.id,nodes:[start],edges:[]}],seen=new Set([start.id]);for(let i=0;i<q.length;i++){const p=q[i];if(p.id===id)return {...p,contributors,message:p.edges.some(e=>e.kind!=='personal')?'This walk includes co-occurrence. Verify those relationships before requesting an introduction.':'A path through recorded contact. Select a person or connection to inspect each step.'};if(p.edges.length===6)continue;for(const next of adj.get(p.id)||[]){if(verifiedOnly&&next.edge.kind!=='personal'||seen.has(next.id)||!byId.has(next.id))continue;seen.add(next.id);q.push({id:next.id,nodes:[...p.nodes,byId.get(next.id)],edges:[...p.edges,next.edge]});}}}
 return {nodes:[person],edges:[],contributors,message:person.sources?.includes('obsidian')&&!person.identityMatchReady?'This person needs a fresh vault push to match their identity across contributors. Sharing ownership is visible below, but a relationship path is not established.':'No recorded path from you within six steps. Shared by does not mean you know this contributor or that they can introduce you.'};
}
