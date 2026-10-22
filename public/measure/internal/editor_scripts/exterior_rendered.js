/* Optional presentation renderer. Its meshes never enter the geometry/undo/report model. */
(function(root){'use strict';
const script=document.currentScript?.src||new URL('editor_scripts/exterior_rendered.js',location.href).href;
const assetURL=new URL('../rendered_assets/',script).href;
const packs=new Map(),settings={lighting:'daylight',sun:315,exposure:1},errors=new Set();
const presentationParts=root.ExteriorSceneCache?new root.ExteriorSceneCache():null;
let active=null,hud=null,graphics=null,pending=0,loaded=0,hdrPromise=null,environment=null,environmentRenderer=null;
const color=value=>new THREE.Color(value).convertSRGBToLinear();
function status(){if(hud){hud.querySelector('[data-export]').disabled=pending>0;hud.querySelector('[role=status]').textContent=errors.size?'Some assets unavailable — basic materials shown':pending?'Loading high-resolution assets… '+loaded+'/'+(loaded+pending):'2K materials · HDR reflections · 4K shadows';}}
const loads=[];
function loadTexture(file,srgb){
 pending++;status();let done;loads.push(new Promise(resolve=>done=resolve));const texture=new THREE.TextureLoader().load(assetURL+file,()=>{pending--;loaded++;status();done(true);},undefined,()=>{pending--;errors.add(file);status();done(false);});
 texture.encoding=srgb?THREE.sRGBEncoding:THREE.LinearEncoding;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=8;return texture;
}
function pack(name){if(!packs.has(name))packs.set(name,{map:loadTexture(name+'-albedo.jpg',true),normalMap:loadTexture(name+'-normal.jpg',false),roughnessMap:loadTexture(name+'-arm.jpg',false)});return packs.get(name);}
function loadEnvironment(){
 if(!hdrPromise){
  pending++;status();hdrPromise=new Promise((resolve,reject)=>{
   const load=()=>new THREE.RGBELoader().setDataType(THREE.HalfFloatType).load(assetURL+'daylight.hdr',resolve,undefined,reject);
   if(THREE.RGBELoader)load();else{const s=document.createElement('script');s.src=new URL('vendor/RGBELoader-r128.js',script).href;s.onload=load;s.onerror=reject;document.head.appendChild(s);}
  }).then(t=>{pending--;loaded++;status();return t;},()=>{pending--;errors.add('environment');status();return null;});
 }
 return hdrPromise;
}
// Resolves true once every texture requested so far and the HDR have loaded, false on any failure or timeout.
function assetsReady(timeout=20000){
 const all=Promise.all([...loads,loadEnvironment()]).then(()=>!errors.size);
 return Promise.race([all,new Promise(resolve=>setTimeout(()=>resolve(false),timeout))]);
}
function environmentMap(renderer){
 if(environmentRenderer!==renderer){environment?.dispose();environment=null;environmentRenderer=renderer;}
 if(environment)return environment.texture;
 loadEnvironment();
 const target=renderer;
 if(!renderer.userData)renderer.userData={};
 if(!renderer.userData.exteriorEnvironmentPending){renderer.userData.exteriorEnvironmentPending=true;hdrPromise.then(texture=>{
  if(!texture||environmentRenderer!==target)return;
  const generator=new THREE.PMREMGenerator(target);generator.compileEquirectangularShader();environment=generator.fromEquirectangular(texture);generator.dispose();if(active)active.scene.environment=environment.texture;
 });}
 return null;
}
const packName=type=>type.startsWith('siding')?'siding':type==='brick'||type==='masonry'?'brick':type==='shingles'?'roof':type==='stone'?'brick':type.startsWith('trim')||type==='opening-trim'||type==='soffit'?'wood':'plaster';
// Mean albedo of each photo map in linear light, and the mean of the paint-grain factor the shader applies to
// painted finishes (see materialFor). Computed once from the 2K albedo JPGs; dev/roof-materials.test.cjs checks them.
const PACK_MEANS={brick:{linear:[.1402,.0776,.0516],grain:.8627},siding:{linear:[.0734,.0481,.0328],grain:.8451},plaster:{linear:[.2733,.2518,.1889],grain:.9406},wood:{linear:[.0519,.0114,.0036],grain:.8293},roof:{linear:[.0603,.0623,.0629],grain:.8497}};
// The color a finish averages to as Textured mode draws it: map mean x tint. Falls back to the finish color
// when its map is unavailable (the material is then drawn untextured in that color too).
function averageFinishColor(finish){
 const f=root.ExteriorFinishes.resolve(finish),type=f.material;if(['unassigned','chimney-top','shingles'].includes(type))return color(f.color);
 const name=packName(type),mean=PACK_MEANS[name];if(!mean||errors.has(name+'-albedo.jpg'))return color(f.color);
 if(['brick','masonry','stone'].includes(type)&&!finish.color)return new THREE.Color(...mean.linear);
 return color(f.color).multiplyScalar(mean.grain*(type.startsWith('siding')?.97:1));
}
// A chimney's cap is plain, in the average color of its sides; the dominant side finish by area wins.
function chimneyCapColors(objects){
 const byChimney=new Map(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
 for(const o of objects){
  const finish=o.userData?.exteriorFinish;if(!finish?.chimney||finish.chimneyCap||finish.feature||finish.trim)continue;
  const g=o.geometry,pos=g?.attributes?.position;if(!pos)continue;o.updateMatrixWorld?.(true);let area=0;const idx=g.index,count=idx?idx.count:pos.count,at=i=>idx?idx.getX(i):i;
  for(let i=0;i+2<count;i+=3){a.fromBufferAttribute(pos,at(i)).applyMatrix4(o.matrixWorld);b.fromBufferAttribute(pos,at(i+1)).applyMatrix4(o.matrixWorld);c.fromBufferAttribute(pos,at(i+2)).applyMatrix4(o.matrixWorld);area+=b.sub(a).cross(c.sub(a)).length()/2;}
  const key=JSON.stringify(root.ExteriorFinishes.resolve(finish))+(finish.color||''),entry=byChimney.get(finish.chimney)||new Map();byChimney.set(finish.chimney,entry);const prior=entry.get(key)||{area:0,finish};prior.area+=area;entry.set(key,prior);
 }
 const out=new Map();for(const [id,entry]of byChimney){const best=[...entry.values()].sort((x,y)=>y.area-x.area)[0];if(best)out.set(id,averageFinishColor(best.finish));}
 return out;
}
function materialFor(finish,base,context){
 const f=root.ExteriorFinishes.resolve(finish),type=f.material;
 // Sticker trim is painted wood: the trim default (or its own colour) with a satin sheen, never the flat scanned-wood white.
 if(type==='opening-trim'&&!base)return new THREE.MeshPhysicalMaterial({color:color(f.color),roughness:.42,metalness:0,clearcoat:.3,clearcoatRoughness:.4,side:THREE.DoubleSide,envMapIntensity:.9});
 // An untyped sticker that was never painted takes the untyped main colour instead of the wall behind it.
 if(finish.feature&&!finish.featureType&&!base&&(!finish.material||finish.material==='default'))return new THREE.MeshStandardMaterial({color:color(finish.color||root.ExteriorFinishes.stickerColor?.(undefined,'main')||'#deddd6'),roughness:.6,metalness:0,side:THREE.DoubleSide,envMapIntensity:.7});
 if(finish.chimneyCap&&!finish.color&&context?.capColors?.has(finish.chimney))return new THREE.MeshStandardMaterial({color:context.capColors.get(finish.chimney).clone(),roughness:.88,metalness:0,side:THREE.DoubleSide,envMapIntensity:.6});
 // Ridge and hip caps: the category's cap map, a shade off the roof color.
 if(type==='shingles'&&finish.roofCap&&!base){const F=root.ExteriorFinishes,spec=F.roofMaterials[f.category],cap=F.roofCapSpecs[f.category],m=new THREE.MeshStandardMaterial({color:color(f.color).multiplyScalar(cap?.shade||.92),roughness:spec.roughness,metalness:spec.metalness,side:THREE.DoubleSide,envMapIntensity:spec.metalness>.1?.5:.8,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});m.map=F.roofCapTexture(f.category);const normal=F.roofCapNormalMap(f.category);if(normal){m.normalMap=normal;m.normalScale=new THREE.Vector2(.9,.9);}return m;}
 // Roof coverings use the seeded procedural maps of their category, tinted by the roof color.
 if(type==='shingles'&&!base){const F=root.ExteriorFinishes,spec=F.roofMaterials[f.category],m=new THREE.MeshStandardMaterial({color:color(f.color),roughness:spec.roughness,metalness:spec.metalness,side:THREE.DoubleSide,envMapIntensity:spec.metalness>.1?.5:.8});m.map=F.roofTexture(f.category);const normal=F.roofNormalMap(f.category);if(normal){m.normalMap=normal;m.normalScale=new THREE.Vector2(.9,.9);}return m;}
 let name=packName(type);
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
 // Doors of any outline: the default door material in the door's color, with recessed grooves traced in its own shape.
 const F=root.ExteriorFinishes,doorSpec=F?.doorFinishes?.[type];
 if(doorSpec){
  const outline=data.points.map(p=>{const a=W.inFrame(frame,p);return {x:a.x-b.left,y:a.y-b.bottom};}),inset=F.doorNormalMap(outline,type,rect);
  target.material.dispose();target.material=new THREE.MeshStandardMaterial({color:color(data.color||F.stickerColor?.(type,'main')||doorSpec.color),roughness:doorSpec.roughness,metalness:0,side:THREE.DoubleSide,envMapIntensity:.7});
  if(inset){target.material.normalMap=inset;target.material.normalScale=new THREE.Vector2(1,1);}
 }
 if(!rect)return;
 const white=new THREE.MeshStandardMaterial({color:color(doorSpec?(F.stickerColor?.(type,'trim')||'#ebe9e1'):data.color||(type==='skylight'?'#41494e':'#ebe9e1')),roughness:.38,metalness:.08,envMapIntensity:.75});
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
  // Panels are the recessed grooves of the door's inset map; the frame is real geometry.
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
const TRIM_PROUD=.015;
const unitOf=context=>context.vector?context.vector({x:1,y:0,z:0}).distanceTo(context.vector({x:0,y:0,z:0})):1;
// A flat trim polygon (world positions, any winding) becomes a closed slab offset by +-depth along its normal.
function trimSlab(geometry,depth){
 const pos=geometry.attributes.position,index=geometry.index,count=index?index.count:pos.count,at=i=>new THREE.Vector3().fromBufferAttribute(pos,index?index.getX(i):i),tris=[];
 for(let i=0;i+2<count;i+=3)tris.push([at(i),at(i+1),at(i+2)]);
 const n=new THREE.Vector3();for(const [a,b,c]of tris)n.add(new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)));if(n.lengthSq()<1e-20)return geometry.clone();n.normalize();
 const up=n.clone().multiplyScalar(depth),down=up.clone().negate(),out=[],edges=new Map(),key=(a,b)=>[a,b].map(v=>v.toArray().map(x=>x.toFixed(6)).join(',')).join('|');
 for(const [a,b,c]of tris){out.push(a.clone().add(up),b.clone().add(up),c.clone().add(up),a.clone().add(down),c.clone().add(down),b.clone().add(down));for(const [p,q]of [[a,b],[b,c],[c,a]]){const k=key(q,p);if(edges.has(k))edges.delete(k);else edges.set(key(p,q),[p,q]);}}
 for(const [p,q]of edges.values())out.push(p.clone().add(down),q.clone().add(down),q.clone().add(up),p.clone().add(down),q.clone().add(up),p.clone().add(up));
 const slab=new THREE.BufferGeometry().setFromPoints(out);slab.computeVertexNormals();
 return slab;
}
const isBase=o=>o.userData.baseId!==undefined||o.userData.pickLayer==='base',isGrade=o=>o.userData.pickLayer==='grade';
function presentationCopy(o,context,target){
  const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);g.computeVertexNormals();if(g.attributes.uv)g.setAttribute('uv2',g.attributes.uv.clone());
  const base=isBase(o),grade=isGrade(o),m=grade?new THREE.MeshStandardMaterial({color:color('#999386'),roughness:.95,side:THREE.DoubleSide}):materialFor(o.userData.exteriorFinish||{material:'default'},base,context),copy=new THREE.Mesh(g,m);
  m.side=o.material.side??THREE.DoubleSide;if(o.userData.exteriorSelected&&!context.plain){m.emissive.copy(m.color);m.emissiveIntensity=.15;}
  // Resolve only coplanar depth ties; retain measured heights and grade slopes.
  if(base||grade){m.polygonOffset=true;m.polygonOffsetFactor=base?-1:1;m.polygonOffsetUnits=base?-1:1;copy.renderOrder=base?1:0;}
  copy.castShadow=!grade;copy.receiveShadow=true;copy.name='rendered-'+(o.name||(base?'base':o.userData.pickLayer)||'surface');copy.userData.presentationLayer=base?'base':o.userData.pickLayer;
  // Sticker trim is a thin slab straddling the wall plane, so its face stands TRIM_PROUD off the wall on whichever
  // side is outside and never shares a depth with the wall or the door; stickers win remaining coplanar ties.
  if(o.userData.openingTrim||o.userData.exteriorFinish?.material==='opening-trim'){copy.geometry=trimSlab(g,TRIM_PROUD*(context.unit||unitOf(context)));g.dispose();m.polygonOffset=true;m.polygonOffsetFactor=m.polygonOffsetUnits=-2;copy.renderOrder=2;}
  else if(o.userData.exteriorFeature||o.userData.exteriorFinish?.feature){m.polygonOffset=true;m.polygonOffsetFactor=m.polygonOffsetUnits=-1;copy.renderOrder=1;}
  target.add(copy);openingDetails(o,copy,context);return copy;
}
function releaseScene(value){if(!value)return;value.groundImage?.material.map?.dispose();const geometries=new Set(),materials=new Set();value.scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])materials.add(m);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());if(value.sun!==active?.sun)value.sun?.shadow.map?.dispose();}
function update(...args){if(!window.ExteriorPerf?.enabled)return perf_update.apply(this,args);return window.ExteriorPerf.measure('PBR scene rebuild',()=>perf_update.apply(this,args));}
function perf_update(group,options){
 const previous=active;document.body.classList.toggle('exterior-rendered',!!options.enabled);
 if(!options.enabled){active=null;presentationParts?.clear();if(graphics){graphics.hidden=true;graphics.open=false;}releaseScene(previous);return;}
 const scene=new THREE.Scene();scene.background=color('#dce5eb');scene.environment=environment?.texture||null;
 // Use the editor's visible surfaces, including its actual sloped grade and base.
 // An independent studio floor would ignore layer visibility and obscure foundations.
 const solids=[];
 group.updateMatrixWorld(true);group.traverseVisible(o=>{if(o.isMesh&&!o.isSprite&&(o.userData.exteriorFinish||isBase(o)||isGrade(o)))solids.push(o);});
 const bounds=new THREE.Box3();for(const o of solids){o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));}
 if(bounds.isEmpty()){active=null;presentationParts?.clear();if(graphics){graphics.hidden=true;graphics.open=false;}document.body.classList.remove('exterior-rendered');releaseScene(previous);return;}
 const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z,1);
 const context={...options,center,capColors:chimneyCapColors(solids)};
 presentationParts?.begin(root.WallMode?.finishDefaults||{});
 try{
 for(const o of solids){
  const build=target=>presentationCopy(o,context,target);
  if(presentationParts)presentationParts.part('surface:'+o.uuid,[o.geometry.uuid,Object.values(o.geometry.attributes).map(a=>a.version),o.geometry.index?.version,o.matrixWorld.elements,o.material.side,o.userData,o.userData.renderedOpening?[center.x,center.y,center.z]:null,o.userData.exteriorFinish?.chimneyCap?context.capColors.get(o.userData.exteriorFinish.chimney)?.getHex():null],scene,build);else build(scene);
 }
 const unit=options.vector({x:1,y:0,z:0}).distanceTo(options.vector({x:0,y:0,z:0}));
 const makeLights=lightRig;
 const {sun,fill}=presentationParts?presentationParts.part('lighting',[],scene,makeLights):makeLights(scene);
 Object.assign(sun.shadow.camera,{left:-radius*.8,right:radius*.8,top:radius*.8,bottom:-radius*.8,near:radius*.02,far:radius*5});sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias=-.001;sun.shadow.normalBias=.035*unit;sun.shadow.radius=3;sun.target.position.copy(center);
 active={scene,sun,fill,center,radius,groundY:bounds.min.y-unit*.005,group,sourceScene:options.scene,camera:null,renderer:null};lighting();mountHUD();graphics.hidden=false;if(!previous)graphics.open=false;presentationParts?.commit();releaseScene(previous);
 }catch(error){presentationParts?.rollback();active=previous;releaseScene({scene});if(previous)lighting();throw error;}
}
function lightRig(target){const sun=new THREE.DirectionalLight(0xfff1db,3),fill=new THREE.HemisphereLight(0xcbdfff,0x92765e,.45);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);target.add(sun,sun.target,fill);return {sun,fill};}
function lighting(){if(active)placeLights(active);}
function placeLights(rig){const {sun,fill,center,radius}=rig,a=settings.sun*Math.PI/180,golden=settings.lighting==='golden',overcast=settings.lighting==='overcast';sun.position.copy(center).add(new THREE.Vector3(Math.cos(a)*radius*1.6,radius*(golden?.65:1.9),Math.sin(a)*radius*1.6));sun.intensity=overcast?.7:golden?2.5:3;sun.color.set(golden?0xffc28a:0xfff1db);fill.intensity=overcast?1.1:.45;}
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
root.ExteriorRendered={trimSlab,TRIM_PROUD,get captureStatus(){return {active:!!active,pending,errors:[...errors]};},get settings(){return {...settings};},presentationCopy,materialFor,assetsReady,loadEnvironment,lightRig,placeLights,chimneyCapColors,averageFinishColor,PACK_MEANS,update,render,exportImage,stop(){update(null,{enabled:false});},get active(){return !!active;}};
})(window);
