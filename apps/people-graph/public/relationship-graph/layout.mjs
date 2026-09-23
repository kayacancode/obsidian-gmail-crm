// Deterministic clusters; camera changes never shuffle the people.
export function spatialLayout(nodes, edges, themes, spacing=165) {
  const ordered=[...nodes].sort((a,b)=>a.id.localeCompare(b.id));
  const group=new Map(),labels=new Map();
  for(const theme of themes) {
    labels.set(theme.themeId,theme.name);
    for(const id of theme.nodeIds) if(!group.has(id)) group.set(id,theme.themeId);
  }
  for(const n of ordered) if(!group.has(n.id)&&n.company&&!/^(gmail|googlemail|outlook|hotmail|yahoo|icloud)\./i.test(n.company)) {
    group.set(n.id,`company:${n.company}`);labels.set(`company:${n.company}`,n.company);
  }
  const links=edges.filter(e=>e.source!==e.target).slice().sort((a,b)=>(b.weight||1)-(a.weight||1));
  for(let pass=0;pass<3;pass++)for(const e of links) {
    if(group.has(e.source)&&!group.has(e.target))group.set(e.target,group.get(e.source));
    else if(group.has(e.target)&&!group.has(e.source))group.set(e.source,group.get(e.target));
  }
  const groups=new Map();
  for(const n of ordered){const key=group.get(n.id)||'other';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n);}
  const clusters=[...groups].sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0]));
  const points=[],centers=[];
  const spread=Math.max(280,Math.sqrt(nodes.length)*95);
  clusters.forEach(([key,members],i)=>{
    const angle=i*2.3999632297,r=clusters.length===1?0:spread*Math.sqrt(i/clusters.length);
    const cx=Math.cos(angle)*r,cy=Math.sin(angle)*r;
    centers.push({key,name:labels.get(key)||null,x:cx,y:cy});
    members.forEach((n,j)=>{const a=j*2.3999632297,rr=Math.sqrt(j)*150;points.push({id:n.id,x:cx+Math.cos(a)*rr,y:cy+Math.sin(a)*rr});});
  });
  const byId=new Map(points.map(p=>[p.id,p]));
  // Relax links lightly; use local collision buckets to keep large graphs responsive.
  for(let pass=0;pass<70;pass++) {
    if(pass<40)for(const e of links){const a=byId.get(e.source),b=byId.get(e.target);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;if(d>210){const f=Math.min(.008,(d-210)/d*.012);a.x+=dx*f;a.y+=dy*f;b.x-=dx*f;b.y-=dy*f;}}
    const buckets=new Map();
    for(const p of points){const gx=Math.floor(p.x/(spacing+15)),gy=Math.floor(p.y/(spacing+15));
      for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const q of buckets.get(`${x},${y}`)||[]){let dx=p.x-q.x,dy=p.y-q.y,d=Math.hypot(dx,dy);if(d<spacing){if(d<.01){dx=1;dy=1;d=Math.SQRT2;}const f=(spacing-d)/d*.51;p.x+=dx*f;p.y+=dy*f;q.x-=dx*f;q.y-=dy*f;}}
      const key=`${gx},${gy}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(p);
    }
  }
  const minX=Math.min(0,...points.map(p=>p.x))-110,minY=Math.min(0,...points.map(p=>p.y))-110;
  const positions=new Map(points.map(p=>[p.id,{x:p.x-minX,y:p.y-minY,size:76,labelWidth:136}]));
  return {positions,width:Math.max(300,...points.map(p=>p.x-minX+110)),height:Math.max(300,...points.map(p=>p.y-minY+130)),
    clusters:centers.filter(c=>c.name&&groups.get(c.key).length>=3).map(c=>{const ps=groups.get(c.key).map(n=>positions.get(n.id));return {name:c.name,x:ps.reduce((s,p)=>s+p.x,0)/ps.length,y:Math.min(...ps.map(p=>p.y))-70};})};
}
