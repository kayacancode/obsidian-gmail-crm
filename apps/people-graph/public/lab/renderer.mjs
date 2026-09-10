const palette=['#bda9ff','#85dfd4','#ffc698','#f5a4ce','#a8c9ff','#d5e69d'];
export class Space {
 constructor(canvas,{select=()=>{},interactive=true}={}){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');this.yaw=-.45;this.pitch=.32;this.zoom=1;this.select=select;this.points=[];this.links=[];this.guides=[];this.selected=null;this.drag=null;this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(canvas);
  if(interactive){
   canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);this.drag={x:e.clientX,y:e.clientY,yaw:this.yaw,pitch:this.pitch,moved:false};});
   canvas.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.abs(dx)+Math.abs(dy)>4)this.drag.moved=true;this.yaw=this.drag.yaw+dx*.007;this.pitch=Math.max(-1.2,Math.min(1.2,this.drag.pitch+dy*.005));this.draw();});
   canvas.addEventListener('pointerup',e=>{if(this.drag&&!this.drag.moved){const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const hit=this.projected?.filter(p=>Math.hypot(p.sx-x,p.sy-y)<Math.max(16,p.radius+6)).sort((a,b)=>b.depth-a.depth)[0];if(hit)this.select(hit.id);}this.drag=null;});
   canvas.addEventListener('pointercancel',()=>this.drag=null);
   canvas.addEventListener('wheel',e=>{e.preventDefault();this.scale(-Math.sign(e.deltaY)*.08);},{passive:false});
   canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','0'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft')this.yaw-=.15;if(e.key==='ArrowRight')this.yaw+=.15;if(e.key==='ArrowUp')this.pitch-=.1;if(e.key==='ArrowDown')this.pitch+=.1;if(e.key==='+')this.scale(.1);if(e.key==='-')this.scale(-.1);if(e.key==='0')this.reset();this.draw();}});
  }
 }
 set(data,edges,view,selected=null){this.points=data.positions;this.guides=data.guides;this.links=edges;this.view=view;this.selected=selected;
 const bounds=[...this.points,...this.guides.flatMap(g=>g.kind==='tower'?[g,{...g,y:g.y+g.h}]:[])];
 const ranges=['x','y','z'].map(axis=>{const values=bounds.map(p=>p[axis]).filter(Number.isFinite);return values.length?[Math.min(...values),Math.max(...values)]:[0,0];});
 this.center=ranges.map(([a,b])=>(a+b)/2);this.fit=Math.min(1,550/Math.max(1,...ranges.map(([a,b])=>b-a)));this.draw();}
 scale(d){this.zoom=Math.max(.5,Math.min(2,this.zoom+d));this.draw();}
 reset(){this.yaw=-.45;this.pitch=.32;this.zoom=1;this.draw();}
 project(p){const original=p;p={...p,x:(p.x-this.center[0])*this.fit,y:(p.y-this.center[1])*this.fit,z:(p.z-this.center[2])*this.fit};const x=p.x*Math.cos(this.yaw)+p.z*Math.sin(this.yaw),z=-p.x*Math.sin(this.yaw)+p.z*Math.cos(this.yaw),y=p.y*Math.cos(this.pitch)-z*Math.sin(this.pitch),depth=p.y*Math.sin(this.pitch)+z*Math.cos(this.pitch);const k=1000/(1000-depth);return {...original,sx:this.w/2+x*this.unit*k,sy:this.h/2-y*this.unit*k,depth,k,radius:(p.size||5)*k*Math.max(.65,this.unit)};}
 line(points,color,width=1,close=false){const c=this.ctx;c.beginPath();points.forEach((p,i)=>{const q=this.project(p);i?c.lineTo(q.sx,q.sy):c.moveTo(q.sx,q.sy);});if(close)c.closePath();c.strokeStyle=color;c.lineWidth=width;c.stroke();}
 draw(){if(!this.view)return;const c=this.ctx,w=this.canvas.clientWidth,h=this.canvas.clientHeight;if(!w||!h)return;this.w=w;this.h=h;const dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=w*dpr;this.canvas.height=h*dpr;c.scale(dpr,dpr);this.unit=Math.min(w/750,h/650)*this.zoom;
  c.fillStyle=this.view.bg;c.fillRect(0,0,w,h);const glow=c.createRadialGradient(w*.5,h*.55,0,w*.5,h*.55,w*.65);glow.addColorStop(0,this.view.color+'1f');glow.addColorStop(1,this.view.bg);c.fillStyle=glow;c.fillRect(0,0,w,h);
  for(let i=0;i<65;i++){c.fillStyle='#ffffff'+(i%3===0?'45':'20');c.fillRect((Math.sin(i*127.1)*.5+.5)*w,(Math.cos(i*73.7)*.5+.5)*h,1,1);}
  for(const g of this.guides){const color=this.view.color+'30';if(['ring','island','portal'].includes(g.kind)){const points=Array.from({length:65},(_,i)=>{const a=i/64*Math.PI*2;return {x:g.x+Math.cos(a)*g.r,y:g.y+(g.kind==='portal'?Math.sin(a)*g.r:0),z:g.z+(g.kind==='portal'?0:Math.sin(a)*g.r)};});this.line(points,color);if(g.kind==='island'){const p=this.project(g);c.fillStyle=this.view.color+'10';c.beginPath();points.forEach((q,i)=>{const r=this.project(q);i?c.lineTo(r.sx,r.sy):c.moveTo(r.sx,r.sy);});c.fill();}}
   if(g.kind==='tower'){const corners=[[-40,-40],[40,-40],[40,40],[-40,40]];for(const dy of [0,g.h])this.line(corners.map(([x,z])=>({x:g.x+x,z:g.z+z,y:g.y+dy})),color,1,true);for(const [x,z]of corners)this.line([{x:g.x+x,z:g.z+z,y:g.y},{x:g.x+x,z:g.z+z,y:g.y+g.h}],color);}
   if(g.kind==='axis')this.line([g,{...g,y:g.y+g.h}],color);
   if(g.kind==='grid')for(let i=-300;i<=300;i+=50){this.line([{x:i,y:g.y,z:-220},{x:i,y:g.y,z:220}],color);this.line([{x:-300,y:g.y,z:i},{x:300,y:g.y,z:i}],color);}
   if(g.label){const p=this.project({...g,y:g.y-25});c.fillStyle=this.view.color+'b0';c.font='10px system-ui';c.textAlign='center';c.fillText(g.label.slice(0,25),p.sx,p.sy);}
  }
  const points=this.points.map(p=>this.project(p)),map=new Map(points.map(p=>[p.id,p]));
  for(const e of this.links){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;const active=e.source===this.selected||e.target===this.selected,cross=a.group!==b.group;c.beginPath();c.moveTo(a.sx,a.sy);if(this.view.id==='bridges')c.quadraticCurveTo((a.sx+b.sx)/2,(a.sy+b.sy)/2-65,b.sx,b.sy);else c.lineTo(b.sx,b.sy);c.strokeStyle=active?this.view.color:this.view.id==='bridges'&&cross?this.view.color+'75':this.view.color+'1c';c.lineWidth=active?1.8:.65;c.stroke();}
  this.projected=points.sort((a,b)=>a.depth-b.depth);
  for(const p of this.projected){const color=palette[p.g%palette.length],active=p.id===this.selected;c.globalAlpha=Math.max(.35,Math.min(1,(p.depth+600)/850));const glow=c.createRadialGradient(p.sx,p.sy,0,p.sx,p.sy,p.radius*3.4);glow.addColorStop(0,color+'70');glow.addColorStop(1,color+'00');c.fillStyle=glow;c.beginPath();c.arc(p.sx,p.sy,p.radius*3.4,0,Math.PI*2);c.fill();const sphere=c.createRadialGradient(p.sx-p.radius*.3,p.sy-p.radius*.4,0,p.sx,p.sy,p.radius);sphere.addColorStop(0,'#ffffff');sphere.addColorStop(.25,color);sphere.addColorStop(1,color+'65');c.fillStyle=sphere;c.beginPath();c.arc(p.sx,p.sy,p.radius,0,Math.PI*2);c.fill();if(active){c.strokeStyle='#fff';c.lineWidth=1.5;c.beginPath();c.arc(p.sx,p.sy,p.radius+7,0,Math.PI*2);c.stroke();}if(active||this.points.length<15){c.font='12px system-ui';c.textAlign='center';c.fillStyle='#fff';c.fillText(p.name||'',p.sx,p.sy+p.radius+23);}c.globalAlpha=1;}
 }
 destroy(){this.observer.disconnect();}
}
