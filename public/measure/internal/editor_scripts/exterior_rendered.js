/* Optional presentation renderer. Its meshes never enter the geometry/undo/report model. */
(function(root){'use strict';
const script=document.currentScript?.src||new URL('editor_scripts/exterior_rendered.js',location.href).href;
const assetURL=new URL('../rendered_assets/',script).href;
const packs=new Map(),settings={lighting:'daylight',sun:315,exposure:1},errors=new Set();
const presentationParts=root.ExteriorSceneCache?new root.ExteriorSceneCache():null;
let active=null,hud=null,graphics=null,pending=0,loaded=0,hdrPromise=null,environment=null,environmentRenderer=null;
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
 const width=b.right-b.left,height=b.top-b.bottom,type=data.feature.type,glazed=type==='window'||type==='skylight';
 // Non-rectangular openings keep their exact source silhouette; don't add rectangular framing over them.
 const rect=data.points.length===4&&data.points.every(p=>{const a=W.inFrame(frame,p);return [b.left,b.right].some(x=>Math.abs(a.x-x)<1e-4)&&[b.top,b.bottom].some(y=>Math.abs(a.y-y)<1e-4);});
 const glass=glazed?new THREE.MeshPhysicalMaterial({color:color('#88a5ad'),roughness:.045,metalness:0,transmission:.25,ior:1.5,clearcoat:1,clearcoatRoughness:.025,transparent:true,opacity:.83,envMapIntensity:2.0,side:THREE.DoubleSide}):null;
 if(glazed){target.material.dispose();target.material=glass;target.position.addScaledVector(n,.004*(su+sv)/2);target.castShadow=false;}
 if(!rect)return;
 const white=new THREE.MeshStandardMaterial({color:color(data.color||(type==='skylight'?'#41494e':'#ebe9e1')),roughness:.38,metalness:.08,envMapIntensity:.75});
 const rubber=glazed?new THREE.MeshStandardMaterial({color:color('#202829'),roughness:.8}):null;
 const box=(x,y,z,w,h,d,m=white)=>{const o=new THREE.Mesh(bevelBox(w,h,d,.006),m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;group.add(o);return o;};
 const frameWidth=Math.min(.055,width*.08,height*.07);
 if(glazed){
  // A shaded recess behind the glass gives the glazing depth rather than painting a blue rectangle.
  box(width/2,height/2,-.16,width-.04,height-.04,.015,new THREE.MeshStandardMaterial({color:color('#262b2c'),roughness:1}));
  for(const x of [frameWidth/2,width-frameWidth/2])box(x,height/2,.018,frameWidth,height,.09);
  for(const y of [frameWidth/2,height-frameWidth/2])box(width/2,y,.018,width,frameWidth,.09);
  for(const x of [frameWidth,width-frameWidth])box(x,height/2,-.005,.012,height-frameWidth,.025,rubber);
  for(const y of [frameWidth,height-frameWidth])box(width/2,y,-.005,width-frameWidth,.012,.025,rubber);
  if(type!=='skylight')box(width/2,-.012,.04,width+.045,.035,.13);
  // Thin warm interior floor catches light behind the glass without affecting model geometry.
  if(type!=='skylight')box(width/2,.035,-.085,width-.08,.015,.17,new THREE.MeshStandardMaterial({color:color('#b2a493'),roughness:.9}));
 }else if(type==='door'||type==='garage'){
  target.material.dispose();target.material=white.clone();target.material.side=THREE.DoubleSide;target.material.color.copy(color(data.color||(type==='garage'?'#d8d7d0':'#c8b9a2')));
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
function releaseScene(value){if(!value)return;value.groundImage?.material.map?.dispose();const geometries=new Set(),materials=new Set();value.scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])materials.add(m);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());if(value.sun!==active?.sun)value.sun?.shadow.map?.dispose();}
function update(...args){if(!window.ExteriorPerf?.enabled)return perf_update.apply(this,args);return window.ExteriorPerf.measure('PBR scene rebuild',()=>perf_update.apply(this,args));}
function perf_update(group,options){
 const previous=active;document.body.classList.toggle('exterior-rendered',!!options.enabled);
 if(!options.enabled){active=null;presentationParts?.clear();if(graphics){graphics.hidden=true;graphics.open=false;}releaseScene(previous);return;}
 const scene=new THREE.Scene();scene.background=color('#dce5eb');scene.environment=environment?.texture||null;
 // Use the editor's visible surfaces, including its actual sloped grade and base.
 // An independent studio floor would ignore layer visibility and obscure foundations.
 const solids=[],isBase=o=>o.userData.baseId!==undefined||o.userData.pickLayer==='base',isGrade=o=>o.userData.pickLayer==='grade';
 group.updateMatrixWorld(true);group.traverseVisible(o=>{if(o.isMesh&&!o.isSprite&&(o.userData.exteriorFinish||isBase(o)||isGrade(o)))solids.push(o);});
 const bounds=new THREE.Box3();for(const o of solids){o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));}
 if(bounds.isEmpty()){active=null;presentationParts?.clear();if(graphics){graphics.hidden=true;graphics.open=false;}document.body.classList.remove('exterior-rendered');releaseScene(previous);return;}
 const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z,1);
 const context={...options,center};
 presentationParts?.begin(root.WallMode?.finishDefaults||{});
 try{
 for(const o of solids){
  const build=target=>{
  const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);g.computeVertexNormals();if(g.attributes.uv)g.setAttribute('uv2',g.attributes.uv.clone());
  const base=isBase(o),grade=isGrade(o),m=grade?new THREE.MeshStandardMaterial({color:color('#999386'),roughness:.95,side:THREE.DoubleSide}):materialFor(o.userData.exteriorFinish||{material:'default'},base),copy=new THREE.Mesh(g,m);
  m.side=o.material.side??THREE.DoubleSide;if(o.userData.exteriorSelected){m.emissive.copy(m.color);m.emissiveIntensity=.15;}
  // Resolve only coplanar depth ties; retain measured heights and grade slopes.
  if(base||grade){m.polygonOffset=true;m.polygonOffsetFactor=base?-1:1;m.polygonOffsetUnits=base?-1:1;copy.renderOrder=base?1:0;}
  copy.castShadow=!grade;copy.receiveShadow=true;copy.name='rendered-'+(o.name||(base?'base':o.userData.pickLayer)||'surface');copy.userData.presentationLayer=base?'base':o.userData.pickLayer;
  target.add(copy);openingDetails(o,copy,context);

  };
  if(presentationParts)presentationParts.part('surface:'+o.uuid,[o.geometry.uuid,Object.values(o.geometry.attributes).map(a=>a.version),o.geometry.index?.version,o.matrixWorld.elements,o.material.side,o.userData,o.userData.renderedOpening?[center.x,center.y,center.z]:null],scene,build);else build(scene);
 }
 const unit=options.vector({x:1,y:0,z:0}).distanceTo(options.vector({x:0,y:0,z:0}));
 const makeLights=target=>{const sun=new THREE.DirectionalLight(0xfff1db,3),fill=new THREE.HemisphereLight(0xcbdfff,0x92765e,.45);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);target.add(sun,sun.target,fill);return {sun,fill};};
 const {sun,fill}=presentationParts?presentationParts.part('lighting',[],scene,makeLights):makeLights(scene);
 Object.assign(sun.shadow.camera,{left:-radius*.8,right:radius*.8,top:radius*.8,bottom:-radius*.8,near:radius*.02,far:radius*5});sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias=-.001;sun.shadow.normalBias=.035*unit;sun.shadow.radius=3;sun.target.position.copy(center);
 active={scene,sun,fill,center,radius,groundY:bounds.min.y-unit*.005,group,sourceScene:options.scene,camera:null,renderer:null};lighting();mountHUD();graphics.hidden=false;if(!previous)graphics.open=false;presentationParts?.commit();releaseScene(previous);
 }catch(error){presentationParts?.rollback();active=previous;releaseScene({scene});if(previous)lighting();throw error;}
}
function lighting(){if(!active)return;const {sun,fill,center,radius}=active,a=settings.sun*Math.PI/180,golden=settings.lighting==='golden',overcast=settings.lighting==='overcast';sun.position.copy(center).add(new THREE.Vector3(Math.cos(a)*radius*1.6,radius*(golden?.65:1.9),Math.sin(a)*radius*1.6));sun.intensity=overcast?.7:golden?2.5:3;sun.color.set(golden?0xffc28a:0xfff1db);fill.intensity=overcast?1.1:.45;}
function syncGroundImage(){
 const source=root.exteriorGroundImageSource?.();
 if(!source){if(active.groundImage)active.groundImage.visible=false;return;}
 source.updateMatrixWorld(true);
 const width=source.geometry.parameters?.width,height=source.geometry.parameters?.height,map=source.material.map;
 if(!width||!height||!map)return;
 let ground=active.groundImage;
 if(!ground){ground=active.groundImage=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshStandardMaterial({roughness:1,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:4,polygonOffsetUnits:4}));ground.name='rendered-image-ground';ground.userData.presentationLayer='image';ground.userData.exteriorReferenceImagery=true;ground.receiveShadow=true;active.scene.add(ground);}
 ground.visible=true;
 if(ground.userData.sourceMap!==map){ground.material.map?.dispose();ground.material.map=map.clone();ground.material.map.encoding=THREE.sRGBEncoding;ground.material.map.needsUpdate=true;ground.material.needsUpdate=true;ground.userData.sourceMap=map;}
 const key=[width,height,...source.matrixWorld.elements,active.groundY].join(',');
 if(ground.userData.layout!==key){const position=ground.geometry.attributes.position,p=new THREE.Vector3();for(let i=0;i<4;i++){p.set(i%2?width/2:-width/2,i<2?height/2:-height/2,0).applyMatrix4(source.matrixWorld);position.setXYZ(i,p.x,active.groundY,p.z);}position.needsUpdate=true;ground.geometry.computeVertexNormals();ground.geometry.computeBoundingSphere();ground.userData.layout=key;}
}
function render(renderer,sourceScene,camera){
 if(!active||active.sourceScene!==sourceScene)return false;
 syncGroundImage();
 active.renderer=renderer;active.camera=camera;active.scene.environment=environmentMap(renderer);
 const saved={toneMapping:renderer.toneMapping,toneMappingExposure:renderer.toneMappingExposure,outputEncoding:renderer.outputEncoding,physicallyCorrectLights:renderer.physicallyCorrectLights},shadow={enabled:renderer.shadowMap.enabled,type:renderer.shadowMap.type};
 try{renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=settings.exposure;renderer.physicallyCorrectLights=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.render(active.scene,camera);}finally{Object.assign(renderer,saved);Object.assign(renderer.shadowMap,shadow);}
 return true;
}
async function exportImage(){
 if(!active?.renderer||!active.camera)return;
 const value=active,r=value.renderer,size=r.getSize(new THREE.Vector2()),ratio=r.getPixelRatio(),camera=value.camera.clone(),aspect=size.x/size.y,width=Math.max(1,Math.round(aspect>=1?3840:3840*aspect)),height=Math.max(1,Math.round(aspect>=1?3840/aspect:3840));
 try{r.setPixelRatio(1);r.setSize(width,Math.min(height,3840),false);camera.aspect=width/Math.min(height,3840);camera.updateProjectionMatrix();render(r,value.sourceScene,camera);const blob=await new Promise(resolve=>r.domElement.toBlob(resolve,'image/png'));if(!blob)throw Error('Image export failed');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='exterior-textured-4k.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){hud.querySelector('[role=status]').textContent=e.message;}finally{r.setPixelRatio(ratio);r.setSize(size.x,size.y,false);}
}
function mountHUD(){
 if(hud)return;const style=document.createElement('style');style.textContent=`
 .exterior-rendered #wall-panel:not(.exterior-debug-tabs){display:none!important}
 #exterior-graphics{position:relative;color:#202124;font:12px system-ui}
 #exterior-graphics[hidden]{display:none!important}
 #exterior-graphics>summary{display:flex;align-items:center;justify-content:center;width:36px;list-style:none;cursor:pointer;height:34px;box-sizing:border-box;padding:0 9px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#202124;font-weight:600;white-space:nowrap}
 #exterior-graphics>summary::-webkit-details-marker{display:none}
 #exterior-graphics>summary:hover{background:#f0f2f5}
 #exterior-graphics[open]>summary{background:#e8f0fe;color:#1a73e8;border-color:#1a73e8}
 #exterior-graphics>summary svg{width:18px;height:18px}
 #exterior-rendered-controls{position:absolute;right:0;top:calc(100% + 6px);z-index:3000;width:260px;box-sizing:border-box;padding:12px;border:1px solid #ccd2d9;border-radius:8px;background:#fff;color:#253442;font:12px system-ui;box-shadow:0 5px 18px #0002}
 #exterior-main-toolbar #exterior-rendered-controls input[type=range]{width:100%;padding:0;border:0}
 #exterior-rendered-controls select{min-width:0;background:#fff;color:#253442;border:1px solid #ccd2d9;border-radius:4px}
 `;document.head.appendChild(style);
 graphics=document.createElement('details');graphics.id='exterior-graphics';graphics.hidden=true;
 const summary=document.createElement('summary');summary.setAttribute('aria-controls','exterior-rendered-controls');summary.setAttribute('aria-label','Graphics');summary.title='Graphics';summary.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M6 13l4-4 3 3 2-2 3 3"/></svg>';graphics.appendChild(summary);
 hud=document.createElement('section');hud.id='exterior-rendered-controls';hud.setAttribute('aria-label','Textured graphics settings');graphics.appendChild(hud);
 hud.innerHTML='<strong style="display:block;margin-bottom:7px">Graphics</strong><div style="display:flex;gap:6px"><select aria-label="Render lighting" style="flex:1"><option value="daylight">Daylight</option><option value="golden">Golden hour</option><option value="overcast">Overcast</option></select><button type="button" data-export>Save 4K</button></div><label style="display:flex;align-items:center;margin-top:8px">Sun <input aria-label="Sun direction" type="range" min="0" max="360" value="315" style="width:100%;margin-left:12px"></label><label style="display:flex;align-items:center">Exposure <input aria-label="Render exposure" type="range" min="0.3" max="2" step="0.05" value="1" style="width:100%;margin-left:8px"></label><div role="status" style="font-size:10px;color:#617080;margin-top:5px"></div><a href="https://polyhaven.com" target="_blank" rel="noopener" style="font-size:9px;color:#617080">Powered by Poly Haven</a>';
 hud.querySelector('select').onchange=e=>{settings.lighting=e.target.value;lighting();};hud.querySelector('[aria-label="Sun direction"]').oninput=e=>{settings.sun=Number(e.target.value);lighting();};hud.querySelector('[aria-label="Render exposure"]').oninput=e=>settings.exposure=Number(e.target.value);hud.querySelector('[data-export]').onclick=exportImage;
 for(const name of ['pointerdown','pointermove','dblclick','wheel'])graphics.addEventListener(name,e=>e.stopPropagation());
 document.addEventListener('pointerdown',e=>{if(!graphics.contains(e.target))graphics.open=false;});
 graphics.addEventListener('keydown',e=>{if(e.key==='Escape'){graphics.open=false;summary.focus();e.preventDefault();}e.stopPropagation();});
 const advanced=document.getElementById('wall-advanced'),main=document.getElementById('exterior-main-toolbar')||document.getElementById('global-toolbar')||document.body;
 if(advanced?.parentElement===main)advanced.insertAdjacentElement('afterend',graphics);else main.appendChild(graphics);status();
}
root.ExteriorRendered={get captureStatus(){return {active:!!active,pending,errors:[...errors]};},update,render,exportImage,stop(){update(null,{enabled:false});},get active(){return !!active;}};
})(window);
