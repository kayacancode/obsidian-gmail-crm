export const VIEWS = [
 {id:'galaxy',name:'People galaxy',tag:'Find your clusters',description:'Company groups form spiral arms. Follow the connections between them.',color:'#b8a0ff',bg:'#100e24'},
 {id:'orbits',name:'Relationship orbits',tag:'See who is close',description:'Stronger recorded relationships orbit closer to the center. Unscored people sit on the outer ring.',color:'#ffb28b',bg:'#24131b'},
 {id:'helix',name:'Contact helix',tag:'Travel through time',description:'People follow a spiral from older to more recent last contact. This shows last-contact dates, not a complete message timeline.',color:'#91e5d2',bg:'#082322'},
 {id:'city',name:'Company city',tag:'Explore your organizations',description:'Each tower is a company or email-domain group. Height represents the number of people in the displayed group.',color:'#aacaff',bg:'#101d36'},
 {id:'sphere',name:'Connection globe',tag:'Explore the whole network',description:'People cover a globe; larger points have more recorded connections. Positions do not represent geography.',color:'#e9bdff',bg:'#22132c'},
 {id:'bridges',name:'Bridge observatory',tag:'Find connections across groups',description:'Separated company groups reveal recorded edges that cross group boundaries. These are not guaranteed introduction paths.',color:'#ffda84',bg:'#241d10'},
 {id:'terrain',name:'Relationship landscape',tag:'Notice strong, quiet relationships',description:'Height shows relationship strength; depth shows time since last contact. Missing scores and dates are labeled in the person card.',color:'#b9dd9b',bg:'#132019'},
 {id:'islands',name:'Context islands',tag:'Follow a shared subject',description:'Islands group people by frequent words found in recorded connection context. These are text clues, not verified areas of expertise.',color:'#87ddea',bg:'#0c2231'},
 {id:'panel',name:'Panel studio',tag:'Build a group around an idea',description:'Search a topic and select people for your session shortlist. The stage arranges your choices; it does not infer availability or qualifications.',color:'#f5a8c7',bg:'#291725'},
 {id:'tunnel',name:'Memory tunnel',tag:'Move through your network’s history',description:'Last-contact dates create layers of depth. Select someone to read the context attached to their connections.',color:'#b7bafc',bg:'#14152d'}
];
const TAU=Math.PI*2;
export function layout(view,graph,nodes,shortlist=new Set()) {
 const groups=[...new Set(nodes.map(n=>n.company||'Unrecorded'))];
 const degrees=new Map(nodes.map(n=>[n.id,graph.ties.get(n.id)?.length||0]));
 const maxDegree=Math.max(1,...degrees.values());
 const dates=nodes.map(n=>Date.parse(n.lastContact)).filter(Number.isFinite);
 const min=Math.min(...dates),max=Math.max(...dates),span=Math.max(86400000,max-min);
 const topicCounts=new Map(),topics=new Map();
 const stop=new Set('with from this that your about have team review meeting update notes'.split(' '));
 if(view==='islands'){
  for(const n of nodes){const words=[...new Set((graph.ties.get(n.id)||[]).flatMap(e=>e.contexts).join(' ').toLowerCase().match(/[a-z]{5,}/g)||[])].filter(w=>!stop.has(w));topics.set(n.id,words);words.forEach(w=>topicCounts.set(w,(topicCounts.get(w)||0)+1));}
 }
 const topTopics=[...topicCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([t])=>t);
 const topicFor=n=>topTopics.find(t=>topics.get(n.id)?.includes(t))||'Other context';
 const islandGroups=[...topTopics,'Other context'];
 const counts=new Map(),seen=new Map();nodes.forEach(n=>{const g=view==='islands'?topicFor(n):n.company||'Unrecorded';counts.set(g,(counts.get(g)||0)+1);});
 const dateRanks=new Map();
 const guides=[];const positions=nodes.map((n,i)=>{
  const group=view==='islands'?topicFor(n):n.company||'Unrecorded',gs=view==='islands'?islandGroups:groups,g=gs.indexOf(group),j=seen.get(group)||0;seen.set(group,j+1);
  const a=i/Math.max(1,nodes.length)*TAU,ga=g/Math.max(1,gs.length)*TAU,local=j/Math.max(1,counts.get(group))*TAU;
  const strength=(n.strength??0)/100,date=Date.parse(n.lastContact),age=Number.isFinite(date)?(max-date)/span:1;
  let x=0,y=0,z=0;
  if(view==='galaxy'){const angle=ga+j*.38,r=85+Math.sqrt(j+1)*40;x=Math.cos(angle)*r;z=Math.sin(angle)*r;y=Math.sin(j*2.4+g)*26;}
  if(view==='orbits'){const r=65+(1-strength)*245;x=Math.cos(a)*r;z=Math.sin(a)*r;y=Math.sin(a*3)*30;}
  if(view==='helix'){const key=Number.isFinite(date)?date:'unknown',rank=dateRanks.get(key)||0;dateRanks.set(key,rank+1);const angle=age*TAU*2.4+rank*.24,r=160+(Math.floor(rank/24)*20);x=Math.cos(angle)*r;z=Math.sin(angle)*r;y=210-age*420;}
  if(view==='city'){const cols=Math.ceil(Math.sqrt(groups.length));x=(g%cols-(cols-1)/2)*145+Math.cos(local)*28;z=(Math.floor(g/cols)-(Math.ceil(groups.length/cols)-1)/2)*145+Math.sin(local)*28;y=-95+j*23;}
  if(view==='sphere'){const v=1-2*(i+.5)/Math.max(1,nodes.length),phi=i*2.399963;x=235*Math.sqrt(1-v*v)*Math.cos(phi);z=235*Math.sqrt(1-v*v)*Math.sin(phi);y=235*v;}
  if(view==='bridges'){x=Math.cos(ga)*245+Math.cos(local)*48;z=Math.sin(ga)*245+Math.sin(local)*48;y=Math.sin(j*2.1)*58;}
  if(view==='terrain'){x=(i/Math.max(1,nodes.length-1)-.5)*540;z=(age-.5)*350;y=strength*230-100;}
  if(view==='islands'){x=Math.cos(ga)*225+Math.cos(local)*50;z=Math.sin(ga)*225+Math.sin(local)*50;y=35+Math.sin(j*2.1)*35;}
  if(view==='panel'){const chosen=[...shortlist],slot=chosen.indexOf(n.id);const angle=slot>=0?slot/Math.max(1,chosen.length)*TAU:a;const r=slot>=0?115:290;x=Math.cos(angle)*r;z=Math.sin(angle)*r;y=slot>=0?55:-35;}
  if(view==='tunnel'){x=Math.cos(a*3)*150;y=Math.sin(a*3)*150;z=(age-.5)*650;}
  return {id:n.id,x,y,z,group,g,size:5+Math.sqrt(degrees.get(n.id)/maxDegree)*7};
 });
 if(['galaxy','orbits','panel'].includes(view))for(const r of [100,200,300])guides.push({kind:'ring',x:0,y:-50,z:0,r});
 if(['city','bridges','islands'].includes(view))for(const group of new Set(positions.map(p=>p.group))){const ps=positions.filter(p=>p.group===group);const x=ps.reduce((s,p)=>s+p.x,0)/ps.length,z=ps.reduce((s,p)=>s+p.z,0)/ps.length;guides.push({kind:view==='city'?'tower':'island',x,z,y:-115,h:ps.length*23+30,r:60,label:group});}
 if(view==='tunnel')for(let z=-340;z<=340;z+=85)guides.push({kind:'portal',x:0,y:0,z,r:185});
 if(view==='terrain')guides.push({kind:'grid',y:-115});
 if(view==='helix')guides.push({kind:'axis',x:0,y:-230,z:0,h:460});
 if(view==='sphere')for(let y=-150;y<=150;y+=75)guides.push({kind:'ring',x:0,z:0,y,r:Math.sqrt(235**2-y**2)});
 return {positions,guides};
}
