import {element,action} from './contact-sheet.mjs';

export function incidentConnections(graph,personId,allowed=n=>!['denied','conflicted'].includes(n.permission)&&!n.permissionConflict&&n.identityResolved!==false&&n.identityStatus!=='unresolved'){
 const people=new Map(graph.nodes.filter(allowed).map(n=>[n.id,n]));
 return (graph.edges||[]).flatMap(edge=>{
  const id=edge.source===personId?edge.target:edge.target===personId?edge.source:null,person=people.get(id);
  if(!person)return [];
  const direction=edge.direction==='source_to_target'?(edge.source===personId?'Outgoing':'Incoming'):edge.direction==='target_to_source'?(edge.target===personId?'Outgoing':'Incoming'):null;
  return [{edge,person,direction}];
 }).sort((a,b)=>a.person.name.localeCompare(b.person.name)||a.edge.id.localeCompare(b.edge.id));
}

export function connectionSection(doc,graph,personId,{allowed,onPerson,selectedEdgeId}={}){
 const connections=incidentConnections(graph,personId,allowed);if(!connections.length)return null;
 const section=element(doc,'section','rg-profile-section rg-connections');section.setAttribute('aria-label','Connections');section.append(element(doc,'h3','','Connections'));
 for(const {edge,person,direction} of connections){
  const row=element(doc,'details','rg-connection');row.dataset.edgeId=edge.id;row.open=edge.id===selectedEdgeId;
  row.append(element(doc,'summary','',[edge.label||'Recorded connection',person.name,direction].filter(Boolean).join(' · ')));
  row.append(action(doc,'Open '+person.name,()=>onPerson?.(person.id),'rg-text-button'));
  if(edge.kind!=='personal')row.append(element(doc,'p','rg-source','Recorded context · relationship unverified'));
  const records=edge.evidence?.length?edge.evidence:[{date:edge.observedAt}];
  for(const evidence of records){
   const item=element(doc,'article','rg-connection-evidence'),p=evidence.provenance||edge.provenance;
   if(evidence.title)item.append(element(doc,'strong','',evidence.title));
   if(evidence.text)item.append(element(doc,'p','rg-copy',evidence.text));
   const confidence=evidence.confidence??edge.confidence;
   const source=[p?.sourceType||p?.source,evidence.date||p?.observedAt||edge.observedAt,evidence.owner||edge.owner,Number.isFinite(confidence)?Math.round(confidence*100)+'% confidence':null].filter(Boolean);
   if(source.length)item.append(element(doc,'p','rg-source',source.join(' · ')));
   if(p?.introducerName)item.append(element(doc,'p','rg-source','Introducer · '+p.introducerName));
   const url=evidence.url||p?.url;
   if(url){const link=element(doc,'a','rg-text-button','Open source');link.href=url;link.target='_blank';link.rel='noopener noreferrer';item.append(link);}
   if(!evidence.title&&!evidence.text&&!source.length&&!url)item.append(element(doc,'p','rg-source','Evidence not included'));
   row.append(item);
  }
  section.append(row);
 }
 return section;
}
