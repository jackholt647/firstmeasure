/* Optional presentation renderer. Its meshes never enter the geometry/undo/report model. */
(function(root){'use strict';
const script=document.currentScript?.src||new URL('editor_scripts/exterior_rendered.js',location.href).href;
const assetURL=new URL('../rendered_assets/',script).href;
const packs=new Map(),settings={lighting:'daylight',sun:315,exposure:1},errors=new Set();
let active=null,hud=null,pending=0,loaded=0,hdrPromise=null,environment=null,environmentRenderer=null;
const color=value=>new THREE.Color(value).convertSRGBToLinear();
function status(){if(hud){hud.querySelector('[data-export]').disabled=pending>0;hud.querySelector('[role=status]').textContent=errors.size?'Some assets unavailable — basic materials shown':pending?'Loading high-resolution assets… '+loaded+'/'+(loaded+pending):'2K materials · HDR reflections · 4K shadows';}}
function loadTexture(file,srgb){
 pending++;status();const texture=new THREE.TextureLoader().load(assetURL+file,()=>{pending--;loaded++;status();},undefined,()=>{pending--;errors.add(file);status();});
 texture.encoding=srgb?THREE.sRGBEncoding:THREE.LinearEncoding;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=8;return texture;
}
function pack(name){if(!packs.has(name))packs.set(name,{map:loadTexture(name+'-albedo.jpg',true),normalMap:loadTexture(name+'-normal.jpg',false),roughnessMap:loadTexture(name+'-arm.jpg',false)});return packs.get(name);}
function environmentMap(renderer){
 if(environmentRenderer!==renderer){environment?.dispose();environment=null;environmentRenderer=renderer;}
 if(environment)return environment.texture;
 if(!hdrPromise){
  pending++;status();hdrPromise=new Promise((resolve,reject)=>{
   const load=()=>new THREE.RGBELoader().setDataType(THREE.HalfFloatType).load(assetURL+'daylight.hdr',resolve,undefined,reject);
   if(THREE.RGBELoader)load();else{const s=document.createElement('script');s.src=new URL('vendor/RGBELoader-r128.js',script).href;s.onload=load;s.onerror=reject;document.head.appendChild(s);}
  }).then(t=>{pending--;loaded++;status();return t;},()=>{pending--;errors.add('environment');status();return null;});
 }
 const target=renderer;
 if(!renderer.userData)renderer.userData={};
 if(!renderer.userData.exteriorEnvironmentPending){renderer.userData.exteriorEnvironmentPending=true;hdrPromise.then(texture=>{
  if(!texture||environmentRenderer!==target)return;
  const generator=new THREE.PMREMGenerator(target);generator.compileEquirectangularShader();environment=generator.fromEquirectangular(texture);generator.dispose();if(active)active.scene.environment=environment.texture;
 });}
 return null;
}
function materialFor(finish,base){
 const f=root.ExteriorFinishes.resolve(finish),type=f.material;
 let name=type.startsWith('siding')?'siding':type==='brick'||type==='masonry'?'brick':type==='shingles'?'roof':type==='stone'?'brick':type.startsWith('trim')||type==='opening-trim'||type==='soffit'?'wood':'plaster';
 const natural=['brick','masonry','stone'].includes(type)&&!finish.color;
 const c=base?(finish.color||'#b3afa7'):natural?'#ffffff':f.color;
 const m=new THREE.MeshStandardMaterial({color:color(c),roughness:.82,metalness:0,side:THREE.DoubleSide,envMapIntensity:.7});
 if(!['unassigned','chimney-top'].includes(type)&&!base){
  const maps=pack(name);Object.assign(m,maps);m.aoMap=maps.roughnessMap;m.aoMapIntensity=.4;m.normalScale=new THREE.Vector2(name==='siding'?.22:.6,name==='siding'?.22:.6);
  const siding=type.startsWith('siding'),roof=type==='shingles',vertical=type.includes('vertical');
  // Neutralize scanned paint/wood color so the project's chosen finish remains authoritative.
  // Real grain and roughness remain; siding and asphalt receive correctly scaled course joints.
  m.onBeforeCompile=shader=>{
   const uv=vertical?'vUv.x':'vUv.y';
   shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
    vec4 texelColor=mapTexelToLinear(texture2D(map,vUv));
    ${natural?'diffuseColor*=texelColor;':`float grain=dot(texelColor.rgb,vec3(.2126,.7152,.0722));diffuseColor.rgb*=mix(.82,1.06,clamp(grain*2.0,0.0,1.0));`}
    ${siding||roof?`float coord=${uv}*4.0;float course=fract(coord);float aa=max(fwidth(coord)*.75,.002);float seam=1.0-smoothstep(.009-aa,.009+aa,min(course,1.0-course));float lap=mix(.90,1.0,smoothstep(.025,.22,course));diffuseColor.rgb*=lap*(1.0-.28*seam);`:''}
    #endif`);
  };
  m.customProgramCacheKey=()=>['rendered',type,natural].join(':');
 }
 return m;
}
function bevelBox(w,h,d,r){
 r=Math.max(.0001,Math.min(r,w/4,h/4,d/4));const x=-w/2+r,y=-h/2+r,W=w-2*r,H=h-2*r,s=new THREE.Shape();
 s.moveTo(x,y);s.lineTo(x+W,y);s.lineTo(x+W,y+H);s.lineTo(x,y+H);s.closePath();
 const g=new THREE.ExtrudeGeometry(s,{depth:d-2*r,bevelEnabled:true,bevelThickness:r,bevelSize:r,bevelSegments:2,steps:1,curveSegments:1});g.translate(0,0,-d/2+r);return g;
}
function openingDetails(source,target,context){
 const data=source.userData.renderedOpening;if(!data||!root.WallFeatures)return;
 const dimensions=root.WallFeatures.dimensions(data.points,data.feature);if(!dimensions)return;
 const {frame,bounds:b}=dimensions,W=root.WallSolidGeometry,world=p=>context.vector(W.fromFrame(frame,p)),origin=world({x:b.left,y:b.bottom});
 const u=world({x:b.left+1,y:b.bottom}).sub(origin),v=world({x:b.left,y:b.bottom+1}).sub(origin),su=u.length(),sv=v.length();u.normalize();v.normalize();
 const n=new THREE.Vector3().crossVectors(u,v).normalize(),center=world({x:(b.left+b.right)/2,y:(b.bottom+b.top)/2});
 if(n.dot(center.clone().sub(context.center))<0){n.negate();u.negate();origin.copy(world({x:b.right,y:b.bottom}));}

 const matrix=new THREE.Matrix4().makeBasis(u,v,n),q=new THREE.Quaternion().setFromRotationMatrix(matrix),group=new THREE.Group();group.position.copy(origin);group.quaternion.copy(q);group.scale.set(su,sv,(su+sv)/2);target.add(group);
 const width=b.right-b.left,height=b.top-b.bottom,type=data.feature.type;
 // Non-rectangular openings keep their exact source silhouette; don't add rectangular framing over them.
 const rect=data.points.length===4&&data.points.every(p=>{const a=W.inFrame(frame,p);return [b.left,b.right].some(x=>Math.abs(a.x-x)<1e-4)&&[b.top,b.bottom].some(y=>Math.abs(a.y-y)<1e-4);});
 const glass=type==='window'?new THREE.MeshPhysicalMaterial({color:color('#88a5ad'),roughness:.045,metalness:0,transmission:.25,ior:1.5,clearcoat:1,clearcoatRoughness:.025,transparent:true,opacity:.83,envMapIntensity:2.0,side:THREE.DoubleSide}):null;
 if(type==='window'){target.material.dispose();target.material=glass;target.position.addScaledVector(n,.004*(su+sv)/2);target.castShadow=false;}
 if(!rect)return;
 const white=new THREE.MeshStandardMaterial({color:color(data.color||'#ebe9e1'),roughness:.38,metalness:.08,envMapIntensity:.75});
 const rubber=type==='window'?new THREE.MeshStandardMaterial({color:color('#202829'),roughness:.8}):null;
 const box=(x,y,z,w,h,d,m=white)=>{const o=new THREE.Mesh(bevelBox(w,h,d,.006),m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;group.add(o);return o;};
 const frameWidth=Math.min(.055,width*.08,height*.07);
 if(type==='window'){
  // A shaded recess behind the glass gives the glazing depth rather than painting a blue rectangle.
  box(width/2,height/2,-.16,width-.04,height-.04,.015,new THREE.MeshStandardMaterial({color:color('#262b2c'),roughness:1}));
  for(const x of [frameWidth/2,width-frameWidth/2])box(x,height/2,.018,frameWidth,height,.09);
  for(const y of [frameWidth/2,height-frameWidth/2])box(width/2,y,.018,width,frameWidth,.09);
  for(const x of [frameWidth,width-frameWidth])box(x,height/2,-.005,.012,height-frameWidth,.025,rubber);
  for(const y of [frameWidth,height-frameWidth])box(width/2,y,-.005,width-frameWidth,.012,.025,rubber);
  box(width/2,-.012,.04,width+.045,.035,.13);
  // Thin warm interior floor catches light behind the glass without affecting model geometry.
  box(width/2,.035,-.085,width-.08,.015,.17,new THREE.MeshStandardMaterial({color:color('#b2a493'),roughness:.9}));
 }else if(type==='door'||type==='garage'){
  target.material.dispose();target.material=white.clone();target.material.color.copy(color(data.color||(type==='garage'?'#d8d7d0':'#c8b9a2')));
  const panelMat=target.material.clone();panelMat.roughness=.48;
  const rows=type==='garage'?Math.max(3,Math.round(height/.5)):3,cols=type==='garage'?Math.max(2,Math.round(width/.65)):2;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const cw=width/cols,rh=height/rows;box((col+.5)*cw,(row+.5)*rh,.012,Math.max(.04,cw-.07),Math.max(.04,rh-.08),.025,panelMat);
  }
  for(const x of [0,width])box(x,height/2,.015,.055,height+.04,.1);
  box(width/2,height,.015,width+.07,.055,.1);
  if(type==='door'){
   const metal=new THREE.MeshStandardMaterial({color:color('#b5b8bb'),metalness:.95,roughness:.2});
   box(width-.1,Math.min(1,height*.48),.054,.035,.18,.018,metal);box(width-.14,Math.min(1,height*.48),.075,.13,.016,.022,metal);
  }
 }else if(type==='vent'){
  for(let y=.04;y<height-.03;y+=.07){const l=box(width/2,y,.025,width-.02,.045,.035);l.rotation.x=-.3;}
 }
}
function releaseScene(value){if(!value)return;const geometries=new Set(),materials=new Set();value.scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])materials.add(m);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());value.sun.shadow.map?.dispose();}
function update(group,options){
 const previous=active;document.body.classList.toggle('exterior-rendered',!!options.enabled);
 if(!options.enabled){active=null;if(hud)hud.hidden=true;releaseScene(previous);return;}
 const scene=new THREE.Scene();scene.background=color('#dce5eb');scene.environment=environment?.texture||null;
 const bounds=new THREE.Box3();group.updateMatrixWorld(true);group.traverse(o=>{if(o.isMesh&&!o.isSprite&&o.userData.exteriorFinish){o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));}});
 if(bounds.isEmpty()){active=null;if(hud)hud.hidden=true;document.body.classList.remove('exterior-rendered');releaseScene(previous);return;}
 const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z,1),unit=options.vector({x:1,y:0,z:0}).distanceTo(options.vector({x:0,y:0,z:0}));
 const context={...options,center,unit},solids=[];
 group.traverse(o=>{if(o.isMesh&&!o.isSprite&&o.visible&&o.userData.exteriorFinish)solids.push(o);});
 for(const o of solids){
  const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);g.computeVertexNormals();if(g.attributes.uv)g.setAttribute('uv2',g.attributes.uv.clone());
  const base=o.userData.baseId!==undefined||o.userData.pickLayer==='base',m=materialFor(o.userData.exteriorFinish,base),copy=new THREE.Mesh(g,m);m.side=o.material.side??THREE.DoubleSide;if(o.userData.exteriorSelected){m.emissive.copy(m.color);m.emissiveIntensity=.15;}copy.castShadow=copy.receiveShadow=true;copy.name='rendered-'+(o.name||o.userData.pickLayer||'surface');scene.add(copy);openingDetails(o,copy,context);
 }
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(radius*40,radius*40),new THREE.MeshStandardMaterial({color:color('#b9b6ae'),roughness:.95}));ground.rotation.x=-Math.PI/2;ground.position.set(center.x,bounds.min.y-.02*unit,center.z);ground.receiveShadow=true;scene.add(ground);
 const sun=new THREE.DirectionalLight(0xfff1db,3);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-radius*.8,right:radius*.8,top:radius*.8,bottom:-radius*.8,near:radius*.02,far:radius*5});sun.shadow.bias=-.001;sun.shadow.normalBias=.035*unit;sun.shadow.radius=3;sun.target.position.copy(center);scene.add(sun,sun.target);
 const fill=new THREE.HemisphereLight(0xcbdfff,0x92765e,.45);scene.add(fill);
 active={scene,sun,fill,center,radius,group,sourceScene:options.scene,camera:null,renderer:null};lighting();mountHUD();hud.hidden=false;releaseScene(previous);
}
function lighting(){if(!active)return;const {sun,fill,center,radius}=active,a=settings.sun*Math.PI/180,golden=settings.lighting==='golden',overcast=settings.lighting==='overcast';sun.position.copy(center).add(new THREE.Vector3(Math.cos(a)*radius*1.6,radius*(golden?.65:1.9),Math.sin(a)*radius*1.6));sun.intensity=overcast?.7:golden?2.5:3;sun.color.set(golden?0xffc28a:0xfff1db);fill.intensity=overcast?1.1:.45;}
function render(renderer,sourceScene,camera){
 if(!active||active.sourceScene!==sourceScene)return false;
 active.renderer=renderer;active.camera=camera;active.scene.environment=environmentMap(renderer);
 const saved={toneMapping:renderer.toneMapping,toneMappingExposure:renderer.toneMappingExposure,outputEncoding:renderer.outputEncoding,physicallyCorrectLights:renderer.physicallyCorrectLights},shadow={enabled:renderer.shadowMap.enabled,type:renderer.shadowMap.type};
 try{renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=settings.exposure;renderer.physicallyCorrectLights=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.render(active.scene,camera);}finally{Object.assign(renderer,saved);Object.assign(renderer.shadowMap,shadow);}
 return true;
}
async function exportImage(){
 if(!active?.renderer||!active.camera)return;
 const value=active,r=value.renderer,size=r.getSize(new THREE.Vector2()),ratio=r.getPixelRatio(),camera=value.camera.clone(),aspect=size.x/size.y,width=Math.max(1,Math.round(aspect>=1?3840:3840*aspect)),height=Math.max(1,Math.round(aspect>=1?3840/aspect:3840));
 try{r.setPixelRatio(1);r.setSize(width,Math.min(height,3840),false);camera.aspect=width/Math.min(height,3840);camera.updateProjectionMatrix();render(r,value.sourceScene,camera);const blob=await new Promise(resolve=>r.domElement.toBlob(resolve,'image/png'));if(!blob)throw Error('Image export failed');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='exterior-rendered-4k.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){hud.querySelector('[role=status]').textContent=e.message;}finally{r.setPixelRatio(ratio);r.setSize(size.x,size.y,false);}
}
function mountHUD(){
 if(hud)return;const style=document.createElement('style');style.textContent='.exterior-rendered #wall-panel{display:none!important}';document.head.appendChild(style);hud=document.createElement('section');hud.id='exterior-rendered-controls';hud.setAttribute('aria-label','Rendered preview settings');
 hud.style.cssText='position:absolute;right:144px;top:46px;z-index:35;width:225px;padding:12px;border:1px solid #d7dde3;border-radius:10px;background:#fffffff0;color:#253442;font:12px system-ui;box-shadow:0 5px 22px #0002;backdrop-filter:blur(10px)';
 hud.innerHTML='<strong style="display:block;margin-bottom:7px">Rendered <span style="color:#657588;font-weight:400">· Preview</span></strong><div style="display:flex;gap:6px"><select aria-label="Render lighting" style="flex:1"><option value="daylight">Daylight</option><option value="golden">Golden hour</option><option value="overcast">Overcast</option></select><button type="button" data-export>Save 4K</button></div><label style="display:flex;align-items:center;margin-top:8px">Sun <input aria-label="Sun direction" type="range" min="0" max="360" value="315" style="width:100%;margin-left:12px"></label><label style="display:flex;align-items:center">Exposure <input aria-label="Render exposure" type="range" min="0.3" max="2" step="0.05" value="1" style="width:100%;margin-left:8px"></label><div role="status" style="font-size:10px;color:#617080;margin-top:5px"></div><a href="https://polyhaven.com" target="_blank" rel="noopener" style="font-size:9px;color:#617080">Powered by Poly Haven</a>';
 hud.querySelector('select').onchange=e=>{settings.lighting=e.target.value;lighting();};hud.querySelector('[aria-label="Sun direction"]').oninput=e=>{settings.sun=Number(e.target.value);lighting();};hud.querySelector('[aria-label="Render exposure"]').oninput=e=>settings.exposure=Number(e.target.value);hud.querySelector('[data-export]').onclick=exportImage;
 for(const name of ['pointerdown','pointermove','dblclick','wheel'])hud.addEventListener(name,e=>e.stopPropagation());
 (document.getElementById('three-view-wrapper')||document.body).appendChild(hud);status();
}
root.ExteriorRendered={update,render,exportImage,stop(){update(null,{enabled:false});},get active(){return !!active;}};
})(window);
