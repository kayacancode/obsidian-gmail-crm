// A curated interaction prototype. All biographies, dates and updates below are fictional.
const people=[
{id:'amara',name:'Amara Chen',initials:'AC',company:'studio',role:'Design engineer',color:'#e4c1a3',topics:['panel','design'],why:'Makes complex agent systems understandable through interface design.',memory:'Sample memory · discussed a developer-tools workshop 18 days ago.',bio:'Design engineer exploring how people understand and steer AI systems.'},
{id:'kai',name:'Kai Morgan',initials:'KM',company:'frontier',role:'Agent infrastructure',color:'#b5c8e1',topics:['panel'],why:'Builds retrieval and memory infrastructure for agents.',memory:'Sample memory · met at an agent infrastructure roundtable 8 days ago.',bio:'Works on the boundary between agent memory, retrieval, and practical developer infrastructure.'},
{id:'ada',name:'Ada Flores',initials:'AF',company:'frontier',role:'Open-source researcher',color:'#cec0df',topics:['panel'],why:'Brings a research and open-source perspective on context evaluation.',memory:'Sample memory · exchanged evaluation notes 32 days ago.',bio:'Researcher focused on evaluating retrieval systems and making the results reproducible.'},
{id:'ren',name:'Ren Blake',initials:'RB',company:'seed',role:'Early-stage investor',color:'#e7c4ca',topics:['panel','investors'],why:'Connects technical founders with early customers and collaborators.',memory:'Sample memory · caught up about developer tools 24 days ago.',bio:'Early-stage investor interested in developer tools, open-source businesses, and AI infrastructure.'},
{id:'alma',name:'Alma Ford',initials:'AF',company:'seed',role:'Infrastructure investor',color:'#c8d5b3',topics:['investors'],why:'Looks at infrastructure economics and developer adoption.',memory:'Sample memory · shared an infrastructure thesis 45 days ago.',bio:'Invests in teams building the next generation of infrastructure.'},
{id:'theo',name:'Theo Park',initials:'TP',company:'studio',role:'Product designer',color:'#c1d9d0',topics:['design'],why:'Prototypes collaborative workflows for technical teams.',memory:'Sample memory · reviewed a prototype 12 days ago.',bio:'Product designer working on collaboration, knowledge tools, and expressive interfaces.'}
];
const companies=[{id:'studio',name:'Studio',initials:'S',role:'Product & design',updates:'Exploring new ways for teams to collaborate with AI in their daily work.',needs:'Looking for design partners to test a collaborative workspace.'},{id:'frontier',name:'Frontier',initials:'F',role:'Open agent infrastructure',updates:'Released an experimental toolkit for evaluating agent memory and retrieval quality.',needs:'Looking for engineering collaborators and teams with realistic retrieval workloads.'},{id:'seed',name:'Seed House',initials:'SH',role:'Early-stage capital',updates:'Hosting small founder conversations around AI infrastructure and developer tools.',needs:'Looking to meet technical founders working on new infrastructure.'}];
const lenses={panel:{question:'Who could join a context engineering panel in New York?',title:'A panel with a few different perspectives.',description:'Bring together infrastructure, research, design, and an investor’s view. These example people have complementary backgrounds.',label:'Panel possibilities'},investors:{question:'Who could help an early-stage AI infrastructure team?',title:'Start with a shared thesis.',description:'Two example investors with complementary interests in developer tools and infrastructure.',label:'Investor possibilities'},design:{question:'Who could be a design partner for an agent workspace?',title:'People who think by making.',description:'A small group to explore interfaces, build prototypes, and learn from real workflows.',label:'Design partners'}};
const $=s=>document.querySelector(s);let lens='panel',selected=null,screen='results',yaw=-.18,pitch=.08,zoom=1,visible=[],positions=[],drag=null,moved=false;const shortlist=new Set();
const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
function add(parent,tag,text,cls){const e=make(tag,text,cls);parent.append(e);return e;}
function action(parent,label,fn,primary=false){const b=add(parent,'button',label,primary?'action primary':'action');b.onclick=fn;return b;}
function initials(p){return p.initials;}
function go(next,id=selected){screen=next;selected=id;draw();if(matchMedia('(max-width:720px)').matches)$('#card').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});}
function candidate(parent,p){const b=add(parent,'button',undefined,'candidate');const avatar=add(b,'span',initials(p),'mini');avatar.style.background=p.color;const who=add(b,'span',p.name,'who');add(who,'small',p.role);add(b,'span','↗','arrow');b.onclick=()=>go('person',p.id);}
function renderCard(){
 const card=$('#card');card.replaceChildren();
 if(screen!=='results'){const back=add(card,'button',screen==='company'||screen==='draft'?'← Back to person':'← Back to possibilities','back');back.onclick=()=>go(screen==='company'||screen==='draft'?'person':'results',screen==='company'?people.find(p=>p.id===selected)?.id||visible.find(n=>!n.isCompany)?.id:selected);}
 const top=add(card,'div',undefined,'card-top');add(top,'i',undefined,'spark');top.append(document.createTextNode(screen==='results'?'A possible starting point':screen==='person'?'The person behind the possibility':screen==='company'?'Company context':screen==='shortlist'?'Your shortlist':'Draft workspace'));
 if(screen==='results'){
  add(card,'h2',lenses[lens].title);add(card,'p',lenses[lens].description);
  add(card,'div','A curated example · not a live AI answer','tag');
  add(card,'div',lenses[lens].label,'card-label');people.filter(p=>p.topics.includes(lens)).forEach(p=>candidate(card,p));
  action(card,`View shortlist (${shortlist.size}) →`,()=>go('shortlist'),true);
  const mem=add(card,'div',undefined,'memory');add(mem,'p','In a connected version, each recommendation would show supporting notes and a dated location signal. Being based in New York would not confirm someone is there today.');
 }else if(screen==='person'){
  const p=people.find(p=>p.id===selected);if(!p){screen='results';renderCard();return;}
  add(card,'h2',p.name);add(card,'span',p.role,'tag');add(card,'span','New York · sample profile','tag');add(card,'p',p.bio);
  add(card,'div','Why this connection','card-label');add(card,'p',p.why);
  action(card,`Explore ${companies.find(c=>c.id===p.company).name} updates ↗`,()=>go('company'));
  action(card,shortlist.has(p.id)?'Remove from shortlist −':'Add to shortlist +',()=>{shortlist.has(p.id)?shortlist.delete(p.id):shortlist.add(p.id);renderCard();});
  action(card,`Draft a note to ${p.name.split(' ')[0]} ↗`,()=>go('draft'),true);
  const mem=add(card,'div',undefined,'memory');add(mem,'div','Relationship memory','card-label');add(mem,'p',p.memory);add(mem,'p','Illustrative memory. No email or meeting records are connected here.');
 }else if(screen==='company'){
  const p=people.find(p=>p.id===selected),c=companies.find(c=>c.id===p.company);add(card,'h2',c.name);add(card,'span','Illustrative company update','tag');add(card,'p',c.updates);add(card,'div','What they are looking for','card-label');const f=add(card,'div',undefined,'fact');add(f,'p',c.needs);add(f,'small','Fictional scenario · not current company news');
  action(card,'Explore investors in this space ↗',()=>setLens('investors'));
  action(card,`Draft a one-on-one with ${p.name.split(' ')[0]} ↗`,()=>go('draft'),true);
  add(card,'div','People at this company','card-label');people.filter(x=>x.company===c.id).forEach(x=>candidate(card,x));
 }else if(screen==='shortlist'){
  add(card,'h2',shortlist.size?'A few people to start with.':'Make room for a good conversation.');add(card,'p','Select people in the network and add them here. This shortlist lasts for this page session.');people.filter(p=>shortlist.has(p.id)).forEach(p=>candidate(card,p));if(!shortlist.size)action(card,'Explore the people →',()=>go('results'),true);
 }else if(screen==='draft'){
  const p=people.find(p=>p.id===selected);add(card,'h2',`A note to ${p.name.split(' ')[0]}.`);add(card,'p','Edit this local draft. Nothing is sent or scheduled.');const t=add(card,'textarea',undefined,'draft');t.setAttribute('aria-label','Message draft');t.value=`Hi ${p.name.split(' ')[0]},\n\nI’m exploring ${lens==='panel'?'a context engineering panel in New York':lens==='investors'?'AI infrastructure and would value your perspective':'design partnerships for an agent workspace'}. Your work on ${p.role.toLowerCase()} came to mind.\n\nWould you be open to a conversation?`;
  action(card,'Select draft text',()=>{t.focus();t.select();},true);
 }
}
function setLens(value){lens=value;screen='results';selected=null;$('#query').value=lenses[lens].question;$('.query-note').textContent='Example scenarios · location and background are sample data, not verified availability.';document.querySelectorAll('[data-lens]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.lens===lens)));draw();}
function draw(){
 const ps=people.filter(p=>p.topics.includes(lens));const ids=new Set(ps.map(p=>p.company));visible=[...ps,...companies.filter(c=>ids.has(c.id)).map(c=>({...c,isCompany:true}))];
 $('#scene-count').textContent=`${ps.length} people · ${ids.size} companies`;$('#scene-label').textContent='01 / '+lenses[lens].label.toUpperCase();
 const ns=$('#nodes');ns.replaceChildren();$('#ties').replaceChildren();
 positions=visible.map((n,i)=>{const a=i/visible.length*Math.PI*2;return {x:Math.cos(a)*240,y:Math.sin(a)*135,z:Math.sin(a*2+.4)*145};});
 visible.forEach(n=>{const b=add(ns,'button',undefined,`orb${n.isCompany?' company':''}${selected===n.id?' selected':''}`);b.style.setProperty('--orb-color',n.color||'#fff');b.setAttribute('aria-label',`${n.name}, ${n.role}`);add(b,'span',n.initials,'portrait');add(b,'span',n.name,'name');add(b,'span',n.role,'role');b.onclick=()=>{if(moved)return;if(n.isCompany){const p=ps.find(p=>p.company===n.id);go('company',p.id);}else go('person',n.id);};});
 renderCard();project();
}
function project(){
 const stage=$('#stage'),w=stage.clientWidth,h=stage.clientHeight,s=Math.min(w/660,h/480)*zoom;
 const points=positions.map(p=>{const x=p.x*Math.cos(yaw)+p.z*Math.sin(yaw),z=-p.x*Math.sin(yaw)+p.z*Math.cos(yaw),y=p.y*Math.cos(pitch)-z*Math.sin(pitch),depth=p.y*Math.sin(pitch)+z*Math.cos(pitch),perspective=700/(700-depth);return {x:w/2+x*s*perspective,y:h/2+y*s*perspective,z:depth,k:perspective*Math.min(1,w/530)*zoom};});
 [...$('#nodes').children].forEach((e,i)=>{const p=points[i];e.style.transform=`translate(${p.x}px,${p.y}px) scale(${p.k})`;e.style.zIndex=Math.round(p.z+400);e.style.opacity=.7+(p.z+260)/1100;});
 const svg=$('#ties');svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.replaceChildren();visible.forEach((n,i)=>{if(n.isCompany)return;const j=visible.findIndex(c=>c.id===n.company),a=points[i],b=points[j];if(!b)return;const line=document.createElementNS('http://www.w3.org/2000/svg','line');for(const [key,value] of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:selected===n.id?'#ca744f':'#819983','stroke-opacity':selected===n.id?.65:.24,'stroke-width':selected===n.id?1.6:1}))line.setAttribute(key,value);svg.append(line);});
}
$('#stage').onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,yaw,pitch};moved=false;};
window.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5){moved=true;$('#stage').classList.add('dragging');yaw=drag.yaw+dx*.006;pitch=Math.max(-.7,Math.min(.7,drag.pitch-dy*.004));project();}});
window.addEventListener('pointerup',()=>{drag=null;$('#stage').classList.remove('dragging');setTimeout(()=>{moved=false;},0);});window.addEventListener('pointercancel',()=>{drag=null;$('#stage').classList.remove('dragging');});
$('#left').onclick=()=>{yaw-=.25;project();};$('#right').onclick=()=>{yaw+=.25;project();};$('#zoom-in').onclick=()=>{zoom=Math.min(1.25,zoom+.1);project();};$('#zoom-out').onclick=()=>{zoom=Math.max(.7,zoom-.1);project();};$('#reset-camera').onclick=()=>{yaw=-.18;pitch=.08;zoom=1;project();};
$('#query-form').onsubmit=e=>{e.preventDefault();const q=$('#query').value.toLowerCase();const found=q.includes('invest')?'investors':q.includes('design')?'design':q.includes('panel')||q.includes('context')?'panel':null;if(found)setLens(found);else $('.query-note').textContent='This prototype supports the three example scenarios below. Choose one to explore; free-form AI search is not connected yet.';};
 document.querySelectorAll('[data-lens]').forEach(b=>b.onclick=()=>setLens(b.dataset.lens));new ResizeObserver(project).observe($('#stage'));draw();
