import {normalize,focus,metrics,daysAgo} from './model.mjs';
import {demo} from './demo.mjs';
const $=s=>document.querySelector(s), d3=window.d3;
const palette=['#c5e7aa','#b1b9f0','#e7b589','#7ac8c7','#dc9dbb','#d8d391'];
let graph=normalize(demo()),view='atlas',query='',selected=null,allNames=false,simulation;
const descriptions={
 atlas:['The people between worlds','People grouped by company. Glowing rings mark recorded introduction ties; lines show the available relationship evidence.'],
 pulse:['Keep the good connections alive','Strength meets time since last contact. Strong, quiet relationships appear toward the upper right. This is a snapshot, not a trend.'],
 context:['A different network for every question','Search a topic to bring matching people and connection context into focus. The inner orbit holds people with more connections in this view.']
};
function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
function append(parent,tag,text,cls){const x=el(tag,text,cls);parent.append(x);return x;}
function companies(){return [...new Set(graph.nodes.map(n=>n.company))];}
function color(n){return palette[companies().indexOf(n.company)%palette.length];}
function initials(n){return n.name.split(/\s+/).slice(0,2).map(s=>s[0]).join('');}
function row(parent,n,metric,action){const b=append(parent,'button',undefined,'person-row');const name=append(b,'span',n.name);append(name,'small',n.company);append(b,'b',metric);b.onclick=action||(()=>{selected=n.id;render();});}
function renderDetail(g,m){
 const panel=$('#detail');panel.replaceChildren();
 const n=g.nodes.find(n=>n.id===selected);
 if(!n){
  append(panel,'div','READING THE NETWORK','kicker');
  append(panel,'h2',view==='pulse'?'Worth a hello.':view==='context'?'Context changes everything.':'Some people open worlds.');
  append(panel,'p',view==='pulse'?'Look for relationships with substantial history and a long gap since contact. A gap is a prompt to investigate, not a judgment.':'Explore the people linking different companies. Click a person to inspect the exact connection types and supporting context.');
  append(panel,'h3',view==='pulse'?'Strong & quiet':'Connectors in this view');
  const ranking=[...g.nodes].sort((a,b)=>view==='pulse'?((b.strength??0)*(daysAgo(b.lastContact)??0)-(a.strength??0)*(daysAgo(a.lastContact)??0)):m.get(b.id).companies-m.get(a.id).companies||m.get(b.id).introductions-m.get(a.id).introductions).slice(0,5);
  ranking.forEach(n=>row(panel,n,view==='pulse'?(daysAgo(n.lastContact)===null?'—':`${daysAgo(n.lastContact)}d`):`${m.get(n.id).companies} ↗`));
  append(panel,'h3','How to read this');
  append(panel,'p',view==='pulse'?'Position uses the existing strength score (0–100) and last-contact date. Missing or future dates appear in the unknown lane.': 'Color = company. Size = connections in this view. Glow = recorded introduction relationships. Cross-company reach is a structural clue, not proof of a successful introduction.');
  return;
 }
 const back=append(panel,'button','← View overview','detail-back');back.onclick=()=>{selected=null;render();};
 append(panel,'div',initials(n),'avatar');append(panel,'h2',n.name);append(panel,'p',n.company);
 const stats=append(panel,'div',undefined,'stats');
 [[m.get(n.id).connections,'visible connections'],[m.get(n.id).introductions,'introduction ties'],[n.strength??'—','strength / 100'],[daysAgo(n.lastContact)===null?'—':`${daysAgo(n.lastContact)}d`,'since last contact']].forEach(([value,label])=>{const s=append(stats,'div');append(s,'strong',value);append(s,'span',label);});
 append(panel,'h3','Why this person?');append(panel,'p',`Connected to people in ${m.get(n.id).companies} companies in this view. Introduction ties record a relationship type; this snapshot does not establish who introduced whom.`);
 append(panel,'h3','Connection evidence');
 const edges=g.edges.filter(e=>e.source===n.id||e.target===n.id);
 if(!edges.length)append(panel,'p','No connection evidence in this view.');
 edges.slice(0,30).forEach(e=>{const other=g.nodes.find(x=>x.id===(e.source===n.id?e.target:e.source));const box=append(panel,'div',undefined,'evidence');row(box,other,'↗');append(box,'small',e.types.join(' · ').replaceAll('_',' ')||'Unspecified relationship');e.contexts.forEach(c=>append(box,'p',c));if(!e.contexts.length)append(box,'p','No supporting context included in this snapshot.');});
 if(edges.length>30)append(panel,'p',`${edges.length-30} more connections. Narrow the search to explore them.`);
}
function render(){
 simulation?.stop();
 const g=focus(graph,query),m=metrics(g);
 if(!g.nodes.some(n=>n.id===selected))selected=null;
 document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
 document.querySelectorAll('[data-topic]').forEach(b=>b.setAttribute('aria-pressed',String(query===b.dataset.topic)));
 $('#total').textContent=graph.nodes.length;$('#view-title').textContent=descriptions[view][0];$('#view-description').textContent=descriptions[view][1];
 $('#count').textContent=`${g.nodes.length} people · ${g.edges.length} connections`;$('#empty').hidden=g.nodes.length>0;
 $('#legend').replaceChildren();companies().slice(0,6).forEach((c,i)=>{const s=append($('#legend'),'span');const dot=append(s,'i');dot.style.background=palette[i];s.append(document.createTextNode(c));});
 if(companies().length>6)append($('#legend'),'span',`+${companies().length-6} companies (colors repeat)`);
 renderDetail(g,m);
 const host=$('#chart');host.replaceChildren();if(!g.nodes.length)return;
 const W=host.clientWidth,H=host.clientHeight,pad=W<500?30:55;
 const svg=d3.select(host).append('svg').attr('viewBox',`0 0 ${W} ${H}`).attr('aria-label',descriptions[view][0]);
 const defs=svg.append('defs');const glow=defs.append('filter').attr('id','glow').attr('x','-100%').attr('y','-100%').attr('width','300%').attr('height','300%');glow.append('feGaussianBlur').attr('stdDeviation',7);
 const plot=svg.append('g'),groups=[...new Set(g.nodes.map(n=>n.company))];
 const centers=new Map(groups.map((c,i)=>{const a=i/groups.length*2*Math.PI-Math.PI/2;return [c,{x:W/2+Math.cos(a)*W*.29,y:H/2+Math.sin(a)*H*.29}];}));
 const nodes=g.nodes.map((n,i)=>({...n,x:W/2+Math.sin(i*2.4)*70,y:H/2+Math.cos(i*2.4)*70,r:Math.min(17,4+Math.sqrt(m.get(n.id).connections)*2)}));
 if(view==='atlas'){
  for(const [c,p] of centers){plot.append('ellipse').attr('cx',p.x).attr('cy',p.y).attr('rx',Math.max(30,W*.15)).attr('ry',85).attr('fill',color(g.nodes.find(n=>n.company===c))).attr('fill-opacity',.025).attr('stroke','#38453e').attr('stroke-dasharray','2 6');plot.append('text').attr('x',p.x).attr('y',p.y-90).attr('text-anchor','middle').attr('class','group-label').text(c.length>24?c.slice(0,22)+'…':c);}
 }
 const known=nodes.filter(n=>daysAgo(n.lastContact)!==null&&n.strength!==null),maxDays=Math.max(180,...known.map(n=>daysAgo(n.lastContact)));
 if(view==='pulse'){
  const x=d3.scaleLinear().domain([0,maxDays]).range([pad,W-pad]);const y=d3.scaleLinear().domain([0,100]).range([H-90,40]);
  plot.append('rect').attr('x',x(maxDays*.5)).attr('y',40).attr('width',(W-2*pad)/2).attr('height',(H-130)/2).attr('fill','#c5e7aa').attr('opacity',.045);
  [0,25,50,75,100].forEach(v=>{plot.append('line').attr('x1',pad).attr('x2',W-pad).attr('y1',y(v)).attr('y2',y(v)).attr('stroke','#2a3539');plot.append('text').attr('x',pad-9).attr('y',y(v)+4).attr('text-anchor','end').attr('class','axis-label').text(v);});
  [0,.25,.5,.75,1].forEach(v=>plot.append('text').attr('x',x(maxDays*v)).attr('y',H-68).attr('text-anchor','middle').attr('class','axis-label').text(`${Math.round(maxDays*v)}d`));
  plot.append('text').attr('x',pad).attr('y',20).attr('class','axis-label').text('STRENGTH ↑');plot.append('text').attr('x',W-pad).attr('y',H-47).attr('text-anchor','end').attr('class','axis-label').text('TIME SINCE CONTACT →');
  const unknown=nodes.filter(n=>!known.includes(n));
  if(unknown.length)plot.append('text').attr('x',pad).attr('y',H-10).attr('class','axis-label').text('UNKNOWN DATE / STRENGTH');
  nodes.forEach(n=>{const i=unknown.indexOf(n);n.x=i<0?x(daysAgo(n.lastContact)):pad+i%Math.max(1,Math.floor((W-pad*2)/18))*18;n.y=i<0?y(n.strength):H-30;n.r=Math.min(n.r,9);});
 }
 if(view==='context'){
  const max=Math.max(...nodes.map(n=>m.get(n.id).connections),1);
  [0.23,.41,.65].forEach(r=>plot.append('circle').attr('cx',W/2).attr('cy',H/2).attr('r',Math.min(W,H)*r).attr('fill','none').attr('stroke','#344239').attr('stroke-dasharray','3 6'));
  const sorted=[...nodes].sort((a,b)=>m.get(b.id).connections-m.get(a.id).connections);
  const inner=sorted.filter(n=>m.get(n.id).connections>=max*.6),outer=sorted.filter(n=>m.get(n.id).connections<max*.6);
  [inner,outer].forEach((ring,k)=>ring.forEach((n,i)=>{const a=i/ring.length*Math.PI*2-Math.PI/2;const r=Math.min(W,H)*(k===0?.23:.41);n.x=W/2+Math.cos(a)*r;n.y=H/2+Math.sin(a)*r;}));
  plot.append('text').attr('x',W/2).attr('y',H/2-4).attr('text-anchor','middle').attr('fill','#c9edb0').attr('font-size',13).text(query||'Your network');plot.append('text').attr('x',W/2).attr('y',H/2+15).attr('text-anchor','middle').attr('class','axis-label').text('CONTEXT LENS');
 }
 const byId=new Map(nodes.map(n=>[n.id,n]));const links=g.edges.map(e=>({...e,source:byId.get(e.source),target:byId.get(e.target)}));
 const neighbor=new Set(selected?g.edges.filter(e=>e.source===selected||e.target===selected).flatMap(e=>[e.source,e.target]):[]);
 const lines=plot.append('g').selectAll('line').data(view==='pulse'?[]:links).join('line').attr('stroke',e=>selected&&(e.source.id===selected||e.target.id===selected)?'#c9edb0':'#526b64').attr('stroke-width',e=>Math.min(2,.4+e.weight*.25)).attr('opacity',e=>!selected ? .27 : (e.source.id===selected||e.target.id===selected) ? .8 : .07);
 const ns=plot.append('g').selectAll('g').data(nodes).join('g').attr('class','node').attr('role','button').attr('tabindex',0).attr('aria-label',n=>`${n.name}, ${m.get(n.id).connections} connections`).attr('opacity',n=>selected&&!neighbor.has(n.id)&&n.id!==selected ? .25 : 1).on('click',(event,n)=>{selected=n.id;render();}).on('keydown',(event,n)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selected=n.id;render();}});
 ns.filter(n=>m.get(n.id).introductions>0).append('circle').attr('r',n=>n.r+8).attr('fill',n=>color(n)).attr('opacity',.18).attr('filter','url(#glow)');
 ns.append('circle').attr('r',n=>n.r).attr('fill',n=>color(n)).attr('stroke',n=>n.id===selected?'#fff':'#12181e').attr('stroke-width',n=>n.id===selected?3:2);
 ns.filter(n=>m.get(n.id).introductions>0).append('circle').attr('r',n=>n.r+4).attr('fill','none').attr('stroke',n=>color(n)).attr('stroke-opacity',.35);
 ns.append('title').text(n=>`${n.name}\n${n.company}\n${m.get(n.id).introductions} introduction ties`);
 ns.append('text').attr('y',n=>n.r+18).attr('text-anchor','middle').text(n=>allNames||n.id===selected||m.get(n.id).connections>=8?n.name:'');
 function tick(){nodes.forEach(n=>{n.x=Math.max(20,Math.min(W-20,n.x));n.y=Math.max(25,Math.min(H-28,n.y));});ns.attr('transform',n=>`translate(${n.x},${n.y})`);lines.attr('x1',e=>e.source.x).attr('y1',e=>e.source.y).attr('x2',e=>e.target.x).attr('y2',e=>e.target.y);}
 if(view==='atlas')simulation=d3.forceSimulation(nodes).force('x',d3.forceX(n=>centers.get(n.company).x).strength(.12)).force('y',d3.forceY(n=>centers.get(n.company).y).strength(.12)).force('charge',d3.forceManyBody().strength(-45)).force('collide',d3.forceCollide(n=>n.r+10)).on('tick',tick);
 tick();
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});
$('#search').oninput=e=>{query=e.target.value;render();};
$('#clear').onclick=()=>{query='';$('#search').value='';render();};
document.querySelectorAll('[data-topic]').forEach(b=>b.onclick=()=>{query=b.dataset.topic;$('#search').value=query;view='context';render();});
$('#labels').onclick=()=>{allNames=!allNames;$('#labels').setAttribute('aria-pressed',String(allNames));$('#labels').textContent=allNames?'Key names only':'Show all names';render();};
$('#upload').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>3_000_000)throw Error('Choose a graph file smaller than 3 MB.');const incoming=normalize(JSON.parse(await f.text()));graph=incoming;query='';selected=null;$('#search').value='';$('#source').textContent=`Local file: ${f.name}`;$('.topics').hidden=true;$('#error').textContent='';render();}catch(err){$('#error').textContent=err.message;}e.target.value='';};
$('#reset').onclick=()=>{graph=normalize(demo());query='';selected=null;$('#search').value='';$('#source').textContent='Fictional sample network';$('.topics').hidden=false;$('#error').textContent='';render();};
let resize;new ResizeObserver(()=>{clearTimeout(resize);resize=setTimeout(render,100);}).observe($('#chart'));
render();
