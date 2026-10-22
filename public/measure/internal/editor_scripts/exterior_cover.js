/* Textured render for the PDF's first cover page (Property Measurement Report) only; the Exterior Summary and the
 elevations keep their line drawings. Offscreen and synchronous: every map is procedural (ExteriorFinishes), so a
 capture never waits on a download. The image travels in the report snapshot as exteriorReport.coverRender. */
(function(root){'use strict';
const MAX=1400,QUALITY=.8,PAD=.035,ELEVATION=35*Math.PI/180;
const bearingOf=settings=>((Number(settings?.frontBearing)||0)%360+360)%360;
// The same configured-front camera as the line-drawing cover (ExteriorPDF.coverView), looking down 35 degrees.
function viewOf(settings){const v=root.ExteriorPDF?.coverView?.(settings);if(v)return v;const a=bearingOf(settings)*Math.PI/180;return {x:Math.sin(a),y:-Math.cos(a)};}
function render(settings={}){
 const parts=root.WallMode?.coverParts?.(),F=root.ExteriorFinishes,T=root.THREE;if(!parts||!F?.roofTexture||!T?.WebGLRenderer)return null;
 const {group,roof,vector}=parts,scene=new T.Scene(),owned={geometries:[],materials:[],textures:[]};let walls=0;
 const own=texture=>{if(!texture)return null;const copy=texture.clone();copy.needsUpdate=true;owned.textures.push(copy);return copy;};
 const add=(source,geometry)=>{
  const data=source.userData||{},base=data.baseId!==undefined||data.pickLayer==='base',finish=data.exteriorFinish||{material:'default'};
  geometry.computeVertexNormals();owned.geometries.push(geometry);
  const m=new T.MeshStandardMaterial({side:source.material?.side??T.DoubleSide,roughness:.86,metalness:0,envMapIntensity:.6});owned.materials.push(m);
  const mesh=new T.Mesh(geometry,m);mesh.userData={...data};mesh.castShadow=mesh.receiveShadow=true;
  // Same maps as Textured mode; real light replaces the display-only face shading.
  F.apply(mesh,m);F.reset(m);
  if(!finish.feature){
   const r=base&&!finish.trim&&['default','unassigned',undefined].includes(finish.material)?{material:'unassigned',color:finish.color||'#b3afa7'}:F.resolve(finish);m.color.set(r.color).convertSRGBToLinear();
   if(r.material==='shingles'){const spec=F.roofMaterials[r.category];m.roughness=spec.roughness;m.metalness=spec.metalness;m.envMapIntensity=spec.metalness>.1?.45:.9;const normal=F.roofNormalMap(r.category);if(normal){m.normalMap=normal;m.normalScale=new T.Vector2(.9,.9);}}
  }else{m.roughness=.45;}
  // Openings and their trim sit on their wall plane; keep them in front of it, as the editor does.
  // The roof and its fascia win depth ties where wall tops meet the roof plane.
  const layer=data.openingTrim?-3:data.roofTrimId?-2:finish.feature||data.exteriorFeature||data.pickLayer==='roof'?-1:0;if(layer){m.polygonOffset=true;m.polygonOffsetFactor=m.polygonOffsetUnits=layer;mesh.renderOrder=-layer;}
  m.map=own(m.map);m.normalMap=own(m.normalMap);
  if(!base&&!finish.feature&&data.pickLayer!=='roof')walls++;
  scene.add(mesh);
 };
 group.updateMatrixWorld(true);
 group.traverse(o=>{
  const data=o.userData||{};if(!o.isMesh||o.isSprite||!o.visible||data.constructionOnly||data.pickLayer==='grade')return;
  if(data.pickLayer==='roof'&&!data.roofTrimId)return; // roof surfaces and skylights are rebuilt below
  if(!data.exteriorFinish&&data.baseId===undefined&&data.pickLayer!=='base')return;
  add(o,o.geometry.clone().applyMatrix4(o.matrixWorld));
 });
 if(!walls){owned.textures.forEach(t=>t.dispose());owned.materials.forEach(m=>m.dispose());owned.geometries.forEach(g=>g.dispose());return null;}
 const temporary=[];
 if(roof?.faces?.length){const presentation=F.roofPresentation(roof);for(const face of presentation.faces)for(const mesh of F.roofMeshes(face,vector,true)){temporary.push(mesh);add(mesh,mesh.geometry);}for(const face of presentation.skylights){const mesh=F.skylightMesh(face,vector);temporary.push(mesh);add(mesh,mesh.geometry);}}
 for(const mesh of temporary)mesh.material.dispose();
 const origin=vector({x:0,y:0,z:0}),up=vector({x:0,y:0,z:1}).sub(origin).normalize(),v=viewOf(settings),toward=vector({x:v.x*Math.cos(ELEVATION),y:v.y*Math.cos(ELEVATION),z:Math.sin(ELEVATION)}).sub(origin).normalize();
 const bounds=new T.Box3().setFromObject(scene),center=bounds.getCenter(new T.Vector3()),radius=Math.max(bounds.getSize(new T.Vector3()).length()/2,1e-3);
 const camera=new T.OrthographicCamera(-1,1,1,-1,radius*.01,radius*8);camera.up.copy(up);camera.position.copy(center).addScaledVector(toward,radius*3);camera.lookAt(center);camera.updateMatrixWorld(true);
 // Frame the projected house exactly, like the line drawing's fitted orthographic projection.
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minUp=Infinity;const p=new T.Vector3(),inverse=camera.matrixWorldInverse;
 scene.traverse(o=>{const a=o.geometry?.attributes?.position;if(!a)return;for(let i=0;i<a.count;i++){p.fromBufferAttribute(a,i);minUp=Math.min(minUp,p.dot(up));p.applyMatrix4(inverse);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}});
 const w=(maxX-minX)*(1+2*PAD),h=(maxY-minY)*(1+2*PAD),cx=(minX+maxX)/2,cy=(minY+maxY)/2,aspect=w/Math.max(h,1e-9);
 Object.assign(camera,{left:cx-w/2,right:cx+w/2,top:cy+h/2,bottom:cy-h/2});camera.updateProjectionMatrix();
 const width=Math.round(aspect>=1?MAX:MAX*aspect),height=Math.round(aspect>=1?MAX/aspect:MAX);
 // Soft contact shadow on a shadow-only ground, so the page stays white around the house.
 const side=new T.Vector3().crossVectors(toward,up).normalize(),sun=new T.DirectionalLight(0xfff1db,2.7),fill=new T.HemisphereLight(0xdfe9ff,0x8f7e6c,1.1);
 sun.position.copy(center).addScaledVector(toward,radius*1.6).addScaledVector(side,radius*1.3).addScaledVector(up,radius*2.4);sun.target.position.copy(center);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);
 Object.assign(sun.shadow.camera,{left:-radius*1.4,right:radius*1.4,top:radius*1.4,bottom:-radius*1.4,near:radius*.05,far:radius*8});sun.shadow.bias=-.0004;sun.shadow.normalBias=radius*.002;sun.shadow.radius=3;
 fill.position.copy(up);scene.add(sun,sun.target,fill);
 const groundGeometry=new T.PlaneGeometry(radius*8,radius*8),ground=new T.Mesh(groundGeometry,new T.ShadowMaterial({opacity:.2}));owned.geometries.push(groundGeometry);owned.materials.push(ground.material);
 ground.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),up);ground.position.copy(center).addScaledVector(up,minUp-center.dot(up)-radius*.002);ground.receiveShadow=true;scene.add(ground);
 const canvas=root.document.createElement('canvas'),renderer=new T.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true,alpha:false});
 let environment=null;
 try{
  renderer.setPixelRatio(1);renderer.setSize(width,height,false);renderer.setClearColor(0xffffff,1);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1;renderer.physicallyCorrectLights=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  // A small sky gradient gives metal and slate something to reflect; no HDR download is needed.
  const sky=new T.Scene(),skyGeometry=new T.SphereGeometry(1,32,16),colors=[],top=new T.Color(0x9fbfe0),horizon=new T.Color(0xf4f6f8),below=new T.Color(0x7d7468),q=new T.Vector3(),pos=skyGeometry.attributes.position;
  for(let i=0;i<pos.count;i++){const d=q.fromBufferAttribute(pos,i).normalize().dot(up),c=d>=0?horizon.clone().lerp(top,Math.pow(d,.6)):horizon.clone().lerp(below,Math.min(1,-d*3));colors.push(c.r,c.g,c.b);}
  skyGeometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));const skyMaterial=new T.MeshBasicMaterial({vertexColors:true,side:T.BackSide});sky.add(new T.Mesh(skyGeometry,skyMaterial));
  const pmrem=new T.PMREMGenerator(renderer);environment=pmrem.fromScene(sky,.04);pmrem.dispose();skyGeometry.dispose();skyMaterial.dispose();scene.environment=environment.texture;
  renderer.render(scene,camera);
  return {image:canvas.toDataURL('image/jpeg',QUALITY),width,height,bearing:bearingOf(settings),view:'front-35',version:1};
 }finally{
  environment?.dispose();sun.shadow.map?.dispose();owned.textures.forEach(t=>t.dispose());owned.materials.forEach(m=>m.dispose());owned.geometries.forEach(g=>g.dispose());renderer.dispose();renderer.forceContextLoss?.();
 }
}
// A front bearing changed in the report settings re-renders the cover in that state. Any pointer press or committed
// change flushes a pending render first, so Generate never sees a cover for an older bearing.
let pending=0;
function refresh(){if(!pending)return;root.clearTimeout(pending);pending=0;const state=root.reportConfigState;if(!state?.exteriorReport)return;try{const cover=render(state.exteriorSettings||{});if(cover)state.exteriorReport.coverRender=cover;else delete state.exteriorReport.coverRender;}catch(error){delete state.exteriorReport.coverRender;console.warn('Textured cover render failed; the cover keeps the line drawing.',error);}}
if(root.document?.addEventListener){
 root.document.addEventListener('house-orientation-change',()=>{if(pending)root.clearTimeout(pending);pending=root.setTimeout(refresh,350);});
 for(const name of ['change','pointerdown'])root.document.addEventListener(name,refresh,true);
 root.document.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')refresh();},true);
}
root.ExteriorCover={render,refresh,bearingOf};
})(window);
