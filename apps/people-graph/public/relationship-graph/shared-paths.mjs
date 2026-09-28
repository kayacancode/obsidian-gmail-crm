import {supportsIntroduction,scoreBacked} from './relationship-support.mjs';
// Only the permission-filtered snapshot is traversed. Membership itself is not an edge.
export function sharedPathGraph(graph) {
 if(graph.source!=='workspace')return graph;
 const nodes=[...graph.nodes],edges=[...graph.edges],ids=new Set(nodes.map(n=>n.id));
 for(const member of graph.members||[]){
  let id='workspace-member:'+member.id;while(ids.has(id))id+=':';ids.add(id);
  const links=graph.nodes.flatMap(person=>{
   if(person.sources?.includes('obsidian')&&!person.identityMatchReady)return [];
   const r=person.relationships?.find(r=>r.memberId===member.id&&supportsIntroduction(r));if(!r)return [];
   return [{id:'member-link:'+JSON.stringify([id,person.id]),source:id,target:person.id,kind:'personal',scoreBacked:scoreBacked(r),confirmedAt:r.confirmedAt,score:r.score,scoreVersion:r.scoreVersion,weight:1,label:scoreBacked(r)?'Score-backed relationship':r.evidenceCategory==='email'?'Recorded email contact':'Recorded meeting',owner:member.name,contributors:[member.id],memberId:member.id,personId:person.id,evidence:[{title:scoreBacked(r)?'Published Obsidian people score · '+r.score+'/100':r.confirmedAt?'Relationship confirmed by '+member.name:r.evidenceCategory==='email'?'Email contact':'Meeting attendance',text:scoreBacked(r)?'Contributor-published relationship estimate, not a personal confirmation. Updated '+(r.observedAt?.slice(0,10)||'date unavailable'):r.confirmedAt?'This contributor explicitly confirmed knowing this person. Introduction willingness is separate.':'Recorded activity does not confirm closeness or willingness to introduce.',owner:member.name,date:r.confirmedAt||(scoreBacked(r)?r.observedAt:r.lastContact)||null}]}];
  });
  if(links.length){nodes.push({id,type:'person',name:member.isMe?'You ('+member.name+')':member.name,role:'Network contributor',company:'',memberId:member.id,relationships:[],via:[],photoUrl:null});edges.push(...links);}
 }
 return {...graph,nodes,edges};
}
