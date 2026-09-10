import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

export class District {
  constructor(host,onSelect){
    this.host=host;this.onSelect=onSelect;this.actors=[];this.motion=0;this.frame=null;this.disposed=false;this.userPaused=false;this.reduced=matchMedia('(prefers-reduced-motion: reduce)');this.key='';this.pickables=[];this.groups=new Map();
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
    this.renderer.setClearColor(0x151d27);this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;
    this.canvas=this.renderer.domElement;this.canvas.setAttribute('aria-label','Architectural district. Drag to orbit, scroll or pinch to zoom. Select a tower, then a floor to explore people.');this.canvas.tabIndex=0;host.append(this.canvas);this.figureLabel=document.createElement('span');this.figureLabel.className='figure-label';this.figureLabel.hidden=true;host.append(this.figureLabel);
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(37,1,.1,180);this.camera.position.set(23,18,27);
    const pmrem=new THREE.PMREMGenerator(this.renderer),room=new RoomEnvironment();this.environment=pmrem.fromScene(room,.04);this.scene.environment=this.environment.texture;pmrem.dispose();room.dispose();
    this.controls=new OrbitControls(this.camera,this.canvas);this.controls.target.set(0,4,0);this.controls.minDistance=9;this.controls.maxDistance=60;this.controls.maxPolarAngle=Math.PI*.48;this.controls.enablePan=false;this.controls.addEventListener('change',()=>this.draw());
    this.scene.add(new THREE.HemisphereLight(0xb8dbff,0x4c3e2d,1.1));
    const sun=new THREE.DirectionalLight(0xffe6c2,2.4);sun.position.set(-12,22,12);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-19,right:19,top:19,bottom:-19,near:1,far:65});sun.shadow.normalBias=.035;this.scene.add(sun);
    const rim=new THREE.DirectionalLight(0x8bbfff,2);rim.position.set(12,12,-15);this.scene.add(rim);
    this.mats={stone:new THREE.MeshStandardMaterial({color:0xd5d9d7,roughness:.5,metalness:.15}),dark:new THREE.MeshStandardMaterial({color:0x303d45,roughness:.35,metalness:.65}),glass:new THREE.MeshPhysicalMaterial({color:0x24596c,metalness:.68,roughness:.16,clearcoat:1}),brass:new THREE.MeshStandardMaterial({color:0xb79c68,metalness:.8,roughness:.25}),light:new THREE.MeshStandardMaterial({color:0xffe5a9,emissive:0xffb35a,emissiveIntensity:.8}),leaf:new THREE.MeshStandardMaterial({color:0x466653,roughness:.95}),bark:new THREE.MeshStandardMaterial({color:0x74614c,roughness:1}),ground:new THREE.MeshStandardMaterial({color:0x1a2730,roughness:.65}),white:new THREE.MeshStandardMaterial({color:0xf0f0e7,roughness:.6}),person:new THREE.MeshStandardMaterial({color:0xd96c35,roughness:.7})};
    this.world=new THREE.Group();this.scene.add(this.world);this.ray=new THREE.Raycaster();let start;this.hovered=null;
    this.canvas.addEventListener('pointerdown',e=>{start=[e.clientX,e.clientY];this.dragging=true;});this.canvas.addEventListener('pointercancel',()=>{this.dragging=false;});
    this.canvas.addEventListener('pointerup',e=>{this.dragging=false;if(!start||Math.hypot(e.clientX-start[0],e.clientY-start[1])>5)return;const r=this.canvas.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),this.camera);const hit=this.ray.intersectObjects(this.pickables,false)[0];if(hit){const {group,person}=hit.object.userData;this.onSelect(group,this.inside?person:null);}});
    this.canvas.addEventListener('pointermove',e=>{
      if(!this.inside||this.dragging)return;
      const r=this.canvas.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),this.camera);
      this.hovered=this.ray.intersectObjects(this.pickables,false)[0]?.object.userData.person||null;this.canvas.style.cursor=this.hovered?'pointer':'grab';this.draw();
    });
    this.canvas.addEventListener('pointerleave',()=>{this.hovered=null;this.dragging=false;this.draw();});
    this.visibility=()=>{this.stopAnimation();this.schedule();};document.addEventListener('visibilitychange',this.visibility);
    this.motionChange=()=>{this.stopAnimation();this.schedule();this.host.dispatchEvent(new CustomEvent('motionchange'));};this.reduced.addEventListener('change',this.motionChange);
    this.canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','0'].includes(e.key)){e.preventDefault();if(e.key==='0')this.reset();else if(e.key==='+'||e.key==='-')this.zoom(e.key==='+'?.85:1.15);else this.rotate(e.key==='ArrowLeft'?-.15:e.key==='ArrowRight'?.15:0,e.key==='ArrowUp'?-.1:e.key==='ArrowDown'?.1:0);}});
    this.canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();host.dataset.lost='true';this.stopAnimation();this.canvas.setAttribute('aria-label','3D rendering paused. Reload this page to restore it. Organization selection remains available below.');});
    this.resize=new ResizeObserver(()=>{const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);this.draw();this.schedule();});this.resize.observe(host);
  }
  mesh(parent,geometry,material,x=0,y=0,z=0){const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  box(parent,w,h,d,mat,x=0,y=0,z=0){return this.mesh(parent,new THREE.BoxGeometry(w,h,d),mat,x,y,z);}
  tree(parent,x,y,z,size=.45){this.mesh(parent,new THREE.CylinderGeometry(.035,.05,size,5),this.mats.bark,x,y+size/2,z);this.mesh(parent,new THREE.IcosahedronGeometry(size*.55,1),this.mats.leaf,x,y+size,z);}
  clear(){this.stopAnimation();this.actors=[];this.hovered=null;this.figureLabel.hidden=true;for(const m of this.roomMaterials||[]){m.map?.dispose();m.dispose();}this.roomMaterials=[];this.world.traverse(o=>{if(o.geometry)o.geometry.dispose();});this.world.clear();this.pickables=[];this.groups.clear();}
  update(groups,selectedGroup,selectedPerson){
    this.canvas.setAttribute('aria-label','Architectural district. Drag to orbit, scroll to zoom, select a tower to enter.');this.inside=false;this.controls.minDistance=9;this.controls.maxDistance=60;
    const previousGroup=this.selectedGroup;this.selectedGroup=selectedGroup;
    const key=JSON.stringify(groups.map(g=>[g.name,g.people.map(n=>n.id)]));
    if(key!==this.key){this.key=key;this.clear();const M=this.mats;
      this.box(this.world,23,.4,17,M.dark,0,-.45,0);this.box(this.world,22.6,.2,16.6,M.stone,0,-.17,0);this.box(this.world,22,.04,16,M.ground,0,-.05,0);
      for(const x of [-10.7,10.7])this.box(this.world,.035,.02,15.8,M.light,x,0,0);for(const z of [-7.7,7.7])this.box(this.world,21.5,.02,.035,M.light,0,0,z);
      for(const z of [-.55,.55])this.box(this.world,21,.025,.3,M.stone,0,0,z);
      for(let i=0;i<20;i++){const x=-9.6+i;this.tree(this.world,x,0,i%2?6.8:-6.8,.55);if(i%3===0){this.box(this.world,.5,.06,.14,M.brass,x,.08,6);this.mesh(this.world,new THREE.CapsuleGeometry(.055,.16,2,5),M.person,x,.16,1.1);}}
      const max=Math.max(1,...groups.map(g=>g.people.length));
      groups.forEach((g,i)=>{
        const floors=7+Math.round(Math.sqrt(g.people.length/max)*7),tower=new THREE.Group();tower.position.set((i%3-1)*6.5,0,(Math.floor(i/3)-.5)*7);this.world.add(tower);
        this.box(tower,4.5,.25,5.1,M.stone,0,.1,0);this.box(tower,3.5,.65,3.8,M.glass,0,.52,0);this.box(tower,3.8,.1,4.1,M.brass,0,.89,0);
        const windows=[],type=i%3,roofs=[];
        for(let f=0;f<floors;f++){
          const y=1+f*.54,level=new THREE.Group();tower.add(level);level.position.y=y;
          // Three sculptural families: curved balconies, setback terraces, and a twisting stack.
          const shrink=type===1?1-Math.floor(f/4)*.12:1;
          level.rotation.y=type===2?f*.048:0;
          if(type===1)level.position.x=Math.floor(f/4)*.19;
          let facade,slab;
          if(type===0){facade=this.mesh(level,new THREE.CylinderGeometry(1.34,1.34,.49,32),M.glass,0,.26,0);slab=this.mesh(level,new THREE.CylinderGeometry(1.65,1.65,.075,32),M.stone,0,0,0);const rail=this.mesh(level,new THREE.TorusGeometry(1.53,.018,4,48),M.brass,0,.17,0);rail.rotation.x=Math.PI/2;
            for(let j=0;j<18;j++){const a=j/18*Math.PI*2;const post=this.box(level,.025,.48,.025,M.brass,Math.cos(a)*1.35,.27,Math.sin(a)*1.35);if((f*7+j)%5<2){const win=this.box(level,.16,.29,.025,M.light,Math.cos(a)*1.355,.27,Math.sin(a)*1.355);win.rotation.y=Math.PI/2-a;}}
          }else{const w=2.65*shrink,d=2.8*shrink;facade=this.box(level,w,.48,d,M.glass,0,.27,0);slab=this.box(level,w+.36,.075,d+.36,M.stone);for(let j=0;j<7;j++){for(const side of [-1,1]){this.box(level,.027,.48,.035,M.brass,(j-3)*w/7,.27,side*(d/2+.015));if((f*3+j+i)%4<2)this.box(level,w/9,.28,.025,M.light,(j-3)*w/7,.27,side*(d/2+.026));}}
            if(type===1&&f%4===0){this.box(level,w+.25,.12,.4,M.dark,0,.1,d/2+.06);for(let t=0;t<4;t++)this.tree(level,(t-1.5)*.55,.13,d/2,.3);}
          }
          const person=g.people[f%g.people.length]?.id;for(const m of [facade,slab]){m.userData={group:g.name,person};this.pickables.push(m);}roofs.push(slab);
        }
        const top=1+floors*.54;
        if(type===0){this.mesh(tower,new THREE.CylinderGeometry(1.58,1.58,.14,32),M.brass,0,top,0);this.mesh(tower,new THREE.CylinderGeometry(.75,.75,.55,24),M.glass,0,top+.3,0);}else{const crown=this.box(tower,2.2,.15,2.4,M.brass,.3,top,0);crown.rotation.y=type===2?floors*.048:0;for(let t=0;t<5;t++)this.tree(tower,(t-2)*.35,top+.08,.3,.35);}
        for(let t=0;t<4;t++)this.tree(tower,-1.9,0,(t-1.5)*1.05,.45);
        const halo=this.mesh(tower,new THREE.TorusGeometry(2.35,.035,6,64),M.light,0,.3,0);halo.rotation.x=Math.PI/2;halo.visible=false;
        this.groups.set(g.name,{tower,halo,roofs});
      });
      this.optimize();this.reset();
    }
    for(const [name,g]of this.groups){g.halo.visible=name===selectedGroup;for(const roof of g.roofs)roof.material=roof.userData.person===selectedPerson?this.mats.light:this.mats.stone;}
    if(selectedGroup&&previousGroup!==selectedGroup&&this.groups.has(selectedGroup)){
      const center=this.groups.get(selectedGroup).tower.position.clone();center.y=3.8;
      const offset=this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(this.host.clientWidth<600?25:19);
      this.controls.target.copy(center);this.camera.position.copy(center.add(offset));this.controls.update();
    }
    this.draw();
  }
  interior(name,people,floor,selected){
    this.canvas.setAttribute('aria-label','Company interior. Select a miniature person for details. Drag to orbit; arrow keys rotate. Movement can be paused below.');this.inside=true;this.controls.minDistance=5;this.controls.maxDistance=45;
    const key=JSON.stringify(['interior',name,floor,people.map(n=>n.id)]);
    if(this.key!==key){this.key=key;this.clear();const M=this.mats;
      this.box(this.world,16,.22,12,M.stone,0,-.2,0);
      this.box(this.world,16,5.8,.16,M.dark,0,2.8,-5.8);
      for(const x of [-7.9,7.9]){this.box(this.world,.14,5.8,12,M.glass,x,2.8,0);for(let z=-5;z<=5;z+=2)this.box(this.world,.09,5.8,.08,M.brass,x,2.8,z);}
      for(const x of [-7.5,7.5])this.box(this.world,.04,.025,11.3,M.light,x,0,0);
      for(let x=-6;x<=6;x+=3)this.box(this.world,1.5,.04,.06,M.light,x,5.3,-5.65);
      this.box(this.world,3.8,.65,1.3,M.dark,0,.3,2.5);this.box(this.world,3.8,.15,1.3,M.brass,0,.7,2.5);
      for(const x of [-6.8,6.8]){this.box(this.world,.8,.55,.8,M.dark,x,.25,-4.8);this.tree(this.world,x,.5,-4.8,1.5);}
      people.forEach((n,i)=>this.createFigure(n,i,name));
      this.camera.position.set(0,5.4,Math.min(44,Math.max(13.8,22/(this.host.clientWidth/Math.max(1,this.host.clientHeight)))));this.controls.target.set(0,2,-1.1);this.controls.update();
    }
    this.selectedGroup=name;this.selectedPerson=selected;for(const a of this.actors)a.ring.visible=a.id===selected;this.draw();this.schedule();
  }
  createFigure(n,i,name){
    const body=new THREE.Group();this.world.add(body);
    const coat=new THREE.MeshStandardMaterial({color:[0x558797,0xb47755,0x718a6d,0x8d7fa2,0xbf9a58,0x537e76,0x9a6570,0x667eab][i%8],roughness:.85});
    const skin=new THREE.MeshStandardMaterial({color:0xe4d8bc,roughness:.8});this.roomMaterials.push(coat,skin);
    this.mesh(body,new THREE.SphereGeometry(.235,16,12),skin,0,1.78,0);
    this.mesh(body,new THREE.CylinderGeometry(.08,.09,.15,8),skin,0,1.52,0);
    this.mesh(body,new THREE.CapsuleGeometry(.25,.36,5,12),coat,0,1.23,0);
    const legs=[],arms=[];
    for(const side of [-1,1]){
      const leg=new THREE.Group();leg.position.set(side*.135,.91,0);body.add(leg);legs.push(leg);
      this.mesh(leg,new THREE.CapsuleGeometry(.095,.62,4,8),this.mats.dark,0,-.4,0);
      this.box(leg,.2,.12,.34,this.mats.dark,0,-.83,.07);
      const arm=new THREE.Group();arm.position.set(side*.32,1.4,0);body.add(arm);arms.push(arm);
      this.mesh(arm,new THREE.CapsuleGeometry(.075,.38,4,8),coat,side*.025,-.23,0);
      this.mesh(arm,new THREE.SphereGeometry(.078,8,6),skin,side*.025,-.5,0);
    }
    const ring=this.mesh(body,new THREE.TorusGeometry(.49,.022,5,32),this.mats.light,0,.015,0);ring.rotation.x=Math.PI/2;ring.visible=false;
    const hitMat=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false});this.roomMaterials.push(hitMat);
    const hit=this.mesh(body,new THREE.CapsuleGeometry(.39,1.25,3,8),hitMat,0,1,0);hit.castShadow=false;hit.receiveShadow=false;hit.userData={group:name,person:n.id};this.pickables.push(hit);
    const actor={id:n.id,name:n.name,body,arms,legs,ring,x:(i%4-1.5)*3.1,z:i<4?-3.15:-.15,phase:i*.81,time:0};this.actors.push(actor);body.position.set(actor.x,0,actor.z);this.pose(actor,0);
  }
  pose(a,dt){
    if(a.id===this.selectedPerson||a.id===this.hovered){for(const limb of [...a.arms,...a.legs])limb.rotation.x=0;return;}
    a.time+=dt;const t=a.time*.38+a.phase;
    a.body.position.set(a.x+Math.sin(t)*.58,Math.abs(Math.sin(a.time*5+a.phase))*.018,a.z+Math.cos(t)*.62);
    a.body.rotation.y=Math.atan2(Math.cos(t)*.58,-Math.sin(t)*.62);
    const swing=Math.sin(a.time*5+a.phase)*.36;
    a.legs[0].rotation.x=swing;a.legs[1].rotation.x=-swing;a.arms[0].rotation.x=-swing*.75;a.arms[1].rotation.x=swing*.75;
  }
  paused(){return this.userPaused||this.reduced.matches;}
  toggleMotion(){this.userPaused=!this.userPaused;this.stopAnimation();this.schedule();this.host.dispatchEvent(new CustomEvent('motionchange'));return this.paused();}
  stopAnimation(){if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;this.lastFrame=null;}
  schedule(){
    if(this.frame!==null||this.disposed||!this.inside||!this.actors.length||this.paused()||document.hidden||this.host.hidden||!this.host.clientWidth||this.host.dataset.lost)return;
    this.frame=requestAnimationFrame(now=>{this.frame=null;if(!this.inside||this.disposed)return;const dt=this.lastFrame===null?0:Math.min(.06,(now-this.lastFrame)/1000);if(this.lastFrame===null||dt>=1/30){this.lastFrame=now;for(const a of this.actors)this.pose(a,dt);this.draw();}this.schedule();});
  }
  optimize(){
    this.world.updateMatrixWorld(true);
    const keep=new Set([...this.pickables,...[...this.groups.values()].map(g=>g.halo)]),batches=new Map(),remove=[];
    this.world.traverse(o=>{if(!o.isMesh||keep.has(o))return;const list=batches.get(o.material)||[];list.push(o.geometry.clone().applyMatrix4(o.matrixWorld));batches.set(o.material,list);remove.push(o);});
    for(const o of remove){o.removeFromParent();o.geometry.dispose();}
    for(const [material,geometries]of batches){const merged=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());if(merged)this.mesh(this.world,merged,material);}
  }
  draw(){if(this.disposed)return;if(this.host.clientWidth&&this.host.clientHeight&&!this.host.hidden){this.renderer.render(this.scene,this.camera);const actor=this.inside?this.actors.find(a=>a.id===(this.hovered||this.selectedPerson)):null;this.figureLabel.hidden=!actor;if(actor){const p=actor.body.position.clone();p.y+=2.3;p.project(this.camera);this.figureLabel.textContent=actor.name;this.figureLabel.style.left=((p.x+1)*this.host.clientWidth/2)+'px';this.figureLabel.style.top=((1-p.y)*this.host.clientHeight/2)+'px';}}}
  reset(){if(this.inside){this.camera.position.set(0,5.4,Math.min(44,Math.max(13.8,22/(this.host.clientWidth/Math.max(1,this.host.clientHeight)))));this.controls.target.set(0,2,-1.1);this.controls.update();this.draw();return;}const narrow=this.host.clientWidth<600;this.camera.position.set(narrow?30:23,narrow?27:18,narrow?37:27);this.controls.target.set(0,3.3,0);this.controls.update();this.draw();}
  rotate(theta,phi=0){const v=this.camera.position.clone().sub(this.controls.target),s=new THREE.Spherical().setFromVector3(v);s.theta+=theta;s.phi=THREE.MathUtils.clamp(s.phi+phi,.2,1.5);this.camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(this.controls.target));this.controls.update();this.draw();}
  zoom(factor){const v=this.camera.position.clone().sub(this.controls.target);v.setLength(THREE.MathUtils.clamp(v.length()*factor,9,60));this.camera.position.copy(v.add(this.controls.target));this.controls.update();this.draw();}
  dispose(){this.disposed=true;this.stopAnimation();document.removeEventListener('visibilitychange',this.visibility);this.reduced.removeEventListener('change',this.motionChange);this.figureLabel.remove();this.resize.disconnect();this.controls.dispose();this.clear();Object.values(this.mats).forEach(m=>m.dispose());this.environment.dispose();this.renderer.dispose();this.canvas.remove();}
}
