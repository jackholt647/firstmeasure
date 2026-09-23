/* Manual wall vertex offsets stay separate from generated, base-bound geometry. */

(function(){

'use strict';
// Apply one display policy to every exterior layer, including depth-only cues.
// Markers draw as whole overlays only when their anchor is visible. Cache camera/surface state so idle frames do not repeat ray tests.
const wallPointOcclusionScenes=new WeakMap();
const wallPointBiasPixels=4,wallLineBiasPixels=10;
function wallOcclusionFrame(renderer,scene,camera){
 let frame=wallPointOcclusionScenes.get(scene);
  if(!frame||frame.frame!==renderer.info.render.frame||frame.camera!==camera){
   const meshes=[],parts=[...camera.matrixWorld.elements,...camera.projectionMatrix.elements];
   scene.traverseVisible(o=>{
    if(!o.isMesh||o.isSprite)return;
    // Reference DSM/photogrammetry can contain millions of triangles. It is
    // not an editable wall and must not enter per-marker/label ray tests.
    for(let parent=o;parent;parent=parent.parent)if(parent.userData?.exteriorReferenceImagery)return;
    const materials=Array.isArray(o.material)?o.material:[o.material];
    if(!materials.some(m=>m&&m.visible!==false&&m.depthWrite&&!m.transparent))return;
    meshes.push(o);parts.push(o.id,o.geometry.id,o.geometry.getAttribute('position')?.version,o.geometry.index?.version,...o.matrixWorld.elements);
   });
   frame={frame:renderer.info.render.frame,camera,meshes,key:parts.join(',')};wallPointOcclusionScenes.set(scene,frame);
  }
 return frame;
}
window.wallPointOcclusion=function(object,enabled){
 object.userData.pointOcclusionEnabled=enabled;
 if(object.userData.pointOcclusionInstalled||!object.geometry?.getAttribute)return;
 object.userData.pointOcclusionInstalled=true;
 const previous=object.onBeforeRender,originalIndex=object.geometry.index,originalRange={...object.geometry.drawRange};
 const filteredIndex=new THREE.BufferAttribute(new Uint32Array(originalIndex?originalIndex.count:object.geometry.getAttribute('position').count),1);
 let lastKey=null;
 object.onBeforeRender=function(renderer,scene,camera,...args){
  previous?.call(this,renderer,scene,camera,...args);
  if(!this.userData.pointOcclusionEnabled){if(lastKey!==null){this.geometry.setIndex(originalIndex);this.geometry.setDrawRange(originalRange.start,originalRange.count);}lastKey=null;return;}
  const frame=wallOcclusionFrame(renderer,scene,camera);
  const position=this.geometry.getAttribute('position'),size=renderer.getSize(new THREE.Vector2()),material=this.material;
  const key=frame.key+':'+size.x+','+size.y+','+material.size+':'+position.version+':'+this.matrixWorld.elements.join(',');
  if(key===lastKey)return;lastKey=key;
  const ray=new THREE.Raycaster(),p=new THREE.Vector3(),projected=new THREE.Vector3(),sample=new THREE.Vector2(),indices=[];
  for(let j=0;j<(originalIndex?originalIndex.count:position.count);j++){
   const i=originalIndex?originalIndex.getX(j):j;
   p.fromBufferAttribute(position,i).applyMatrix4(this.matrixWorld);projected.copy(p).project(camera);
   if(projected.z<-1||projected.z>1)continue;
   // Test the actual point, not the square's corners: a hidden anchor must
   // not leak through a wall just because its marker overlaps a silhouette.
   const view=p.clone().applyMatrix4(camera.matrixWorldInverse),pixelDepth=2*(camera.isPerspectiveCamera?Math.abs(view.z):1)/(camera.projectionMatrix.elements[5]*Math.max(1,size.y));
   const epsilon=Math.max(Math.max(1,p.length(),Math.abs(view.z))*2e-6,pixelDepth*wallPointBiasPixels);
   ray.setFromCamera(sample.set(projected.x,projected.y),camera);
   const forward=new THREE.Vector3(0,0,-1).transformDirection(camera.matrixWorld);
   ray.far=Math.max(0,p.clone().sub(ray.ray.origin).dot(ray.ray.direction)-epsilon/Math.max(.001,ray.ray.direction.dot(forward)));
   const visible=!ray.intersectObjects(frame.meshes,false).length;
   if(visible)indices.push(i);
  }
  filteredIndex.array.set(indices);filteredIndex.needsUpdate=true;
  this.geometry.setIndex(filteredIndex);this.geometry.setDrawRange(0,indices.length);
 };
};

// Whole-label visibility comes from its surface anchor, not per-glyph depth.
// Leave the sprite renderable when hidden so orbiting can reveal it next frame.
window.wallLabelOcclusion=function(object,enabled){
 object.userData.labelOcclusionEnabled=enabled;
 if(object.userData.labelOcclusionInstalled)return;
 object.userData.labelOcclusionInstalled=true;
 const previous=object.onBeforeRender,opacity=object.material.opacity;let lastKey=null,visible=true;
 object.onBeforeRender=function(renderer,scene,camera,...args){
  previous?.call(this,renderer,scene,camera,...args);
  if(!this.userData.labelOcclusionEnabled){this.material.opacity=opacity;lastKey=null;return;}
  const frame=wallOcclusionFrame(renderer,scene,camera),key=frame.key+':'+this.matrixWorld.elements.join(',');
  if(key!==lastKey){lastKey=key;const p=new THREE.Vector3().setFromMatrixPosition(this.matrixWorld),q=p.clone().project(camera),ray=new THREE.Raycaster();visible=q.z>=-1&&q.z<=1;
   if(visible){ray.setFromCamera(new THREE.Vector2(q.x,q.y),camera);ray.far=p.clone().sub(ray.ray.origin).dot(ray.ray.direction)-Math.max(1,p.length())*2e-6;visible=!ray.intersectObjects(frame.meshes,false).length;}
  }
  this.material.opacity=visible?opacity:0;
 };
};
// Move drafting wire ten CSS pixels toward the camera in depth only. Keep its
// projected position and real geometry unchanged, and retain wall occlusion.
window.wallLineDepthBias=function(object,enabled){
 const material=object.material;material.userData||={};
 let state=material.userData.wallLineDepthBias;
 if(!state){
  state=material.userData.wallLineDepthBias={height:{value:1},pixels:{value:0}};
  const compile=material.onBeforeCompile,cache=material.customProgramCacheKey?.bind(material);
  const cacheKey=cache?.()||'';
  material.onBeforeCompile=function(shader,...args){compile?.call(this,shader,...args);shader.uniforms.wallLineViewportHeight=state.height;shader.uniforms.wallLineBiasPixels=state.pixels;
   shader.vertexShader='uniform float wallLineViewportHeight;\nuniform float wallLineBiasPixels;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
    float wallPixelDepth = 2.0 * (isPerspectiveMatrix(projectionMatrix) ? abs(mvPosition.z) : 1.0) / (projectionMatrix[1][1] * wallLineViewportHeight);
    vec4 wallNearPosition = projectionMatrix * vec4(mvPosition.xy, min(-0.00001, mvPosition.z + (wallLineBiasPixels > 0.0 ? max(wallPixelDepth * wallLineBiasPixels, max(1.0, length(mvPosition.xyz)) * 0.000002) : 0.0)), 1.0);
    gl_Position.z = max(-gl_Position.w, wallNearPosition.z / wallNearPosition.w * gl_Position.w);
   `);
  };
  material.customProgramCacheKey=()=>cacheKey+'|wall-line-depth-v2';material.needsUpdate=true;
 }
 state.pixels.value=enabled?wallLineBiasPixels:0;
 if(object.userData.wallLineDepthInstalled)return;object.userData.wallLineDepthInstalled=true;
 const previous=object.onBeforeRender;
 object.onBeforeRender=function(renderer,...args){previous?.call(this,renderer,...args);state.height.value=Math.max(1,renderer.domElement.getBoundingClientRect().height);};
};
window.exteriorSurfaceDisplay=function(group,mode=true){
 const translucent=mode===true||mode==='translucent',textured=['textured','rendered','match-textured'].includes(mode);
 group.traverse(o=>{
  const line=o.isLine||o.isLineSegments;
  if(line||o.isPoints||o.isSprite){o.userData||={};if(!('exteriorVisible' in o.userData))o.userData.exteriorVisible=o.visible;o.visible=textured&&!line&&!o.userData.exteriorSelection?false:o.userData.exteriorVisible;}
  if(!o.material||o.userData?.planeGuide||o.userData?.curveCenterIndicator||o.userData?.curveSnapGuide||o.userData?.alignmentGuide||o.userData?.exteriorDivider)return;
  for(const m of (Array.isArray(o.material)?o.material:[o.material])){
   m.userData||={};const saved=m.userData.exteriorDisplay||(m.userData.exteriorDisplay={opacity:m.opacity,transparent:m.transparent,depthTest:m.depthTest,depthWrite:m.depthWrite,map:m.map,vertexColors:m.vertexColors,polygonOffset:m.polygonOffset,polygonOffsetFactor:m.polygonOffsetFactor,polygonOffsetUnits:m.polygonOffsetUnits});
   Object.assign(m,saved);window.ExteriorFinishes?.reset?.(m);
   if(m.color){m.userData.exteriorColor??=m.color.getHex();m.color.setHex(m.userData.exteriorColor);}
   if(o.isMesh&&!o.isSprite&&m.color){
    if(!translucent&&!textured){
     // Muted midtone fills leave bright drafting lines clearly distinguishable.
     const hsl=m.color.getHSL({});m.color.setHSL(hsl.h,hsl.s*.32,hsl.l*.65);
    }
    if(textured)window.ExteriorFinishes?.apply(o,m);
    // Brighten the existing hue consistently in every display mode.
    if(o.userData.exteriorSelected&&THREE.Color&&m.color.lerp){m.color.lerp(new THREE.Color('#ffffff'),.6);if(translucent)m.opacity=.95;}
   }
   // Bias filled surfaces slightly behind their coplanar drafting edges.
   // Keep depth testing on the edges so nearer faces still hide them.
   if(!translucent){m.depthTest=true;if(o.isMesh&&!o.isSprite){m.opacity=1;m.transparent=false;m.depthWrite=true;m.polygonOffset=true;m.polygonOffsetFactor=o.userData.exteriorFeature?-1:1;m.polygonOffsetUnits=o.userData.exteriorFeature?-1:1;}if(line)m.depthWrite=false;}
   if(textured&&(line||o.userData?.exteriorSelection)){m.color?.setHex(o.userData?.exteriorSelection?0xffffff:0x303840);m.vertexColors=false;m.opacity=o.userData?.exteriorSelection ? .9 : .35;m.transparent=true;m.depthTest=true;m.depthWrite=false;}
   // Selected stickers must win coplanar depth ties in solid display modes.
   // Keep normal depth testing so genuinely nearer walls still occlude them.
   if(o.isMesh&&o.userData?.exteriorFeature){o.renderOrder=o.userData.exteriorSelected?2:1;m.polygonOffset=true;m.polygonOffsetFactor=o.userData.exteriorSelected?-4:-1;m.polygonOffsetUnits=o.userData.exteriorSelected?-4:-1;}
   // Fascia must retain its coplanar priority after textured-mode material setup.
   if(o.isMesh&&(o.userData?.roofTrimId||o.userData?.openingTrim)){m.polygonOffset=true;m.polygonOffsetFactor=-2;m.polygonOffsetUnits=-2;o.renderOrder=2;}
   // Separate coplanar grade/base depth without changing measured elevations.
   if(o.isMesh&&o.userData?.pickLayer==='grade'){m.polygonOffset=true;m.polygonOffsetFactor=4;m.polygonOffsetUnits=4;}
   if(line){m.depthTest=translucent?saved.depthTest:true;m.depthWrite=false;o.userData.exteriorLineOrder??=o.renderOrder;o.renderOrder=translucent?o.userData.exteriorLineOrder:(o.userData.exteriorSelection||o.userData.exteriorLineOrder>0?999:998);window.wallLineDepthBias(o,!translucent);}
   if(o.userData?.selectedLineDepth){m.depthTest=!translucent;m.depthWrite=false;}
   if(o.userData?.exteriorSoffit){m.depthTest=!translucent;m.depthWrite=false;m.color?.set?.('#ef633c');m.opacity=1;o.renderOrder=999.5;}
   // Point squares are drafting overlays: a surface must never slice them.
   if(o.isPoints){m.depthTest=false;m.depthWrite=false;o.renderOrder=1000;window.wallPointOcclusion(o,!translucent);}
   // Annotation sprites must remain overlays in every surface display mode.
   if(o.isSprite&&(o.userData?.wallFeature||o.userData?.wallLength!==undefined||o.userData?.moveIndicator)){m.depthTest=false;m.depthWrite=false;window.wallLabelOcclusion(o,!translucent);}
   m.needsUpdate=true;
  }
 });
};


// Capture the connected coplanar component before a gesture. Disconnected

// walls on the same plane remain valid alignment targets.

window.connectedWallPlane=function(walls,id){

 const start=walls.find(w=>w.id===id);if(!start)return [];

 const a=start.bottom[0],b=start.bottom[1],len=Math.hypot(b.x-a.x,b.y-a.y);if(len<.005)return [];

 const u={x:(b.x-a.x)/len,y:(b.y-a.y)/len};

 const coplanar=w=>{const dx=w.bottom[1].x-w.bottom[0].x,dy=w.bottom[1].y-w.bottom[0].y,l=Math.hypot(dx,dy);return l>.005&&Math.abs(u.x*dy-u.y*dx)/l<1e-5&&w.bottom.every(p=>Math.abs(u.x*(p.y-a.y)-u.y*(p.x-a.x))<.02);};

 const connected=(w,v)=>w.bottom.some((p,i)=>v.bottom.some((q,j)=>Math.hypot(p.x-q.x,p.y-q.y)<.03&&Math.min(w.top[i].z,v.top[j].z)-Math.max(p.z,q.z)>=-.002));

 const component=[start];for(let i=0;i<component.length;i++)for(const w of walls)if(!component.includes(w)&&coplanar(w)&&connected(component[i],w))component.push(w);

 return component.map(w=>w.id);

};

// Compute from the gesture's original geometry; repeated previews never accumulate.

window.moveWallPlane=function(walls,id,amount,state){

 const G=window.WallGeometry,copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

 const group=!state._movingIds&&state.wallEdits?.$merges?.find(ids=>ids.includes(id));

 if(group?.length>1){

  const source=walls.find(w=>w.id===id),a=source.bottom[0],b=source.bottom[1],updates=new Map();

  for(const member of group){const w=walls.find(w=>w.id===member);if(!w)continue;const dot=(b.x-a.x)*(w.bottom[1].x-w.bottom[0].x)+(b.y-a.y)*(w.bottom[1].y-w.bottom[0].y);

   for(const next of window.moveWallPlane(walls,member,amount*(dot<0?-1:1),{...state,_movingIds:group})){const before=walls.find(w=>w.id===next.id),combined=updates.get(next.id)||copy(before);for(const edge of ['bottom','top'])for(let i=0;i<2;i++)if(dist(before[edge][i],next[edge][i])>1e-8||Math.abs(before[edge][i].z-next[edge][i].z)>1e-8)combined[edge][i]=next[edge][i];updates.set(next.id,combined);}

  }return [...updates.values()];

 }

 const wall=walls.find(w=>w.id===id);if(!wall)throw Error('Select a wall first.');

 const a=wall.bottom[0],b=wall.bottom[1],length=dist(a,b);if(length<.005)throw Error('Wall is too short to move.');

 const u={x:(b.x-a.x)/length,y:(b.y-a.y)/length},n={x:-u.y,y:u.x};

 const result=copy(walls),edits=new Map(),cross=(a,b)=>a.x*b.y-a.y*b.x;

 // Extend the neighbor's actual edge, including intentional steps. Surface

 // fitting is deliberately excluded from manual wall moves.

 function edgeHeight(w,index,q){

  const edge=index<2?w.bottom:w.top,a=edge[0],b=edge[1],dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;

  if(len<1e-10)return edge[index%2].z;

  const t=((q.x-a.x)*dx+(q.y-a.y)*dy)/len;

  return a.z+t*(b.z-a.z);

 }

 function put(w,index,q,z){

  const next=result.find(v=>v.id===w.id);(index<2?next.bottom:next.top)[index%2]={x:q.x,y:q.y,z};edits.set(w.id,next);

 }

 for(let end=0;end<2;end++){

  const p=wall.bottom[end],shift={x:p.x+n.x*amount,y:p.y+n.y*amount};

  const neighbors=[];

  for(const w of walls){if(w.id===id||state._movingIds?.includes(w.id)||state._detachIds?.includes(w.id))continue;

   for(let j=0;j<2;j++){const linked=state.wallEdits?.$joints?.some(pair=>pair.some(v=>v.id===id&&v.end===end)&&pair.some(v=>v.id===w.id&&v.end===j));if(linked||(dist(w.bottom[j],p)<.03&&Math.min(w.top[j].z,wall.top[end].z)-Math.max(w.bottom[j].z,p.z)>.02))neighbors.push({w,j});}

  }

  let corner=null;

  for(const {w,j} of neighbors){

   const other=w.bottom[1-j],v={x:other.x-w.bottom[j].x,y:other.y-w.bottom[j].y},den=cross(u,v);

   if(Math.abs(den)<.00001){if(Math.abs(amount)>.000001)throw Error('This corner also belongs to a parallel wall. Move a different face.');continue;}

   const t=cross({x:w.bottom[j].x-shift.x,y:w.bottom[j].y-shift.y},v)/den;

   const q={x:shift.x+u.x*t,y:shift.y+u.y*t};

   if(corner&&dist(corner,q)>.003)throw Error('This junction cannot move without rotating another wall.');

   // A return can shorten to zero and grow on the opposite side while its

   // supporting plane stays fixed. Snapping is a stop suggestion, not a limit.

   corner=q;

  }

  const q=corner||shift;

  for(const offset of [0,2]){

   const edge=offset===0?'bottom':'top',original=wall[edge][end];

   const guide=neighbors.slice().sort((a,b)=>Math.abs(a.w[edge][a.j].z-original.z)-Math.abs(b.w[edge][b.j].z-original.z))[0];

   const z=guide?original.z+edgeHeight(guide.w,guide.j+offset,q)-guide.w[edge][guide.j].z:original.z;

   put(wall,end+offset,q,z);

   for(const {w,j}of neighbors)put(w,j+offset,q,edgeHeight(w,j+offset,q));

  }

 }

 const moved=result.find(w=>w.id===id);

 if((moved.bottom[1].x-moved.bottom[0].x)*u.x+(moved.bottom[1].y-moved.bottom[0].y)*u.y<.01)throw Error('The wall would collapse.');

 for(const w of edits.values())if(w.top.some((p,i)=>p.z<=w.bottom[i].z+.01))throw Error('The wall top would fall below its bottom edge.');

 return [...edits.values()];

};

// Visible roof edges provide snap targets; the extrusion engine also constrains
// the sweep continuously beneath visible roof surfaces.

window.wallCrossesRoof=function(wall,roof){
 const G=window.WallGeometry,a=wall.bottom[0],b=wall.bottom[1],dx=b.x-a.x,dy=b.y-a.y,mix=(ps,t)=>ps[0].z+(ps[1].z-ps[0].z)*t,eps=.01;
 for(const f of roof?.faces||[]){const pl=G.plane(f.points);if(!pl)continue;const z=t=>pl.dx*(a.x+dx*t)+pl.dy*(a.y+dy*t)+pl.k,cuts=[0,1];
  for(const ring of [f.points,...(f.holes||[])])for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length],ux=q.x-p.x,uy=q.y-p.y,den=dx*uy-dy*ux;if(Math.abs(den)<1e-10)continue;const t=((p.x-a.x)*uy-(p.y-a.y)*ux)/den,s=((p.x-a.x)*dy-(p.y-a.y)*dx)/den;if(t>0&&t<1&&s>=0&&s<=1)cuts.push(t);}
  for(const fn of [t=>z(t)-mix(wall.bottom,t)-eps,t=>mix(wall.top,t)-z(t)-eps]){const x=fn(0),y=fn(1),t=x/(x-y);if(t>0&&t<1)cuts.push(t);}
  cuts.sort((a,b)=>a-b);for(let i=1;i<cuts.length;i++){const t=(cuts[i-1]+cuts[i])/2,p={x:a.x+dx*t,y:a.y+dy*t};if(cuts[i]-cuts[i-1]>1e-8&&G.contains(f,p)&&!(f.holes||[]).some(points=>G.contains({points},p))&&z(t)>mix(wall.bottom,t)+eps&&z(t)<mix(wall.top,t)-eps)return true;}
 }return false;
};
window.findWallRoofSnap=function(wall,amount,roof,radius,options={}){
 const a=wall.bottom[0],b=wall.bottom[1],len=Math.hypot(b.x-a.x,b.y-a.y);if(len<.005)return null;

 const u={x:(b.x-a.x)/len,y:(b.y-a.y)/len},n={x:-u.y,y:u.x};let best=null;

 for(const c of roof?.connections||[]){const p=roof.points[c.startIdx],q=roof.points[c.endIdx];if(!p||!q||![p.z,q.z].every(Number.isFinite))continue;

  const dx=q.x-p.x,dy=q.y-p.y,l=Math.hypot(dx,dy);if(l<.005||Math.abs(u.x*dy-u.y*dx)/l>1e-4)continue;

  const offset=(p.x-a.x)*n.x+(p.y-a.y)*n.y,error=Math.abs(offset-amount);if(error>radius)continue;

  const span=[p,q].map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y);if(Math.max(...span)<-.03||Math.min(...span)>len+.03)continue;

  const heightError=Math.abs((p.z+q.z-wall.top[0].z-wall.top[1].z)/2);
  const bottom=wall.bottom.map(v=>({...v,x:v.x+n.x*offset,y:v.y+n.y*offset})),top=bottom.map(v=>({...v,z:p.z+((v.x-p.x)*dx+(v.y-p.y)*dy)/(l*l)*(q.z-p.z)}));
  if(!options.fitSurface&&window.wallCrossesRoof({bottom,top},roof))continue;
  if(!best||error<best.error-1e-6||Math.abs(error-best.error)<1e-6&&heightError<best.heightError)best={amount:offset,edge:[p,q],error,heightError};

 }return best;

};

window.fitWallTopToRoof=function(changed,movingIds,snap,roof){
 const [a,b]=snap.edge,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,updates=[];

 for(const w of changed.filter(w=>movingIds.includes(w.id)))for(const p of w.top){const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;



  const z=a.z+t*(b.z-a.z),bottom=w.bottom.find(q=>Math.hypot(p.x-q.x,p.y-q.y)<.003);if(bottom&&z<=bottom.z+.01)return false;updates.push({p,from:{...p},z});

 }

 if(roof)for(const w of changed.filter(w=>movingIds.includes(w.id))){const top=w.top.map(p=>({...p,z:updates.find(u=>u.p===p)?.z??p.z}));if(window.wallCrossesRoof({...w,top},roof))return false;}
 for(const update of updates)for(const w of changed)for(const p of w.top)if(Math.hypot(p.x-update.from.x,p.y-update.from.y,p.z-update.from.z)<.003)p.z=update.z;
 return updates.length>0;

};

// One area-weighted surface centroid per logical face, including merged steps.

window.wallFaceCenters=function(walls){

 const groups=new Map();

 for(const w of walls){const id=w.mergeGroup||w.id;if(!groups.has(id))groups.set(id,{id:w.id,members:[],point:{x:0,y:0,z:0},area:0});const group=groups.get(id);group.members.push(w.id);

  const ps=[w.bottom[0],w.bottom[1],w.top[1],w.top[0]];

  for(const ids of [[0,1,2],[0,2,3]]){const [a,b,c]=ids.map(i=>ps[i]),u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};const area=Math.hypot(u.y*v.z-u.z*v.y,u.z*v.x-u.x*v.z,u.x*v.y-u.y*v.x)/2;

   for(const axis of ['x','y','z'])group.point[axis]+=area*(a[axis]+b[axis]+c[axis])/3;group.area+=area;

  }

 }

 return [...groups.values()].filter(g=>g.area>1e-8).map(g=>({...g,point:{x:g.point.x/g.area,y:g.point.y/g.area,z:g.point.z/g.area}}));

};

window.wallCenterMarker=function(group,vector,point){
 const geo=new THREE.BufferGeometry().setFromPoints([vector(point)]),material=new THREE.PointsMaterial({color:'#fff5bd',size:9,sizeAttenuation:false,depthTest:false});
 material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('void main() {','void main() { if (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;');};
 material.customProgramCacheKey=()=> 'wall-center-circle';const marker=new THREE.Points(geo,material);marker.userData||={};marker.userData.faceCenter=true;group.add(marker);
};
// Place readouts outside padded projected geometry, not merely beside its midpoint.
window.wallChamferLabelPosition=function(anchor,width,height,viewport,segments,placed=[]){
 const padding=24,margin=10,clamp=p=>({x:Math.max(viewport.left+margin,Math.min(viewport.right-width-margin,p.x)),y:Math.max(viewport.top+margin,Math.min(viewport.bottom-height-margin,p.y))});
 const intersects=(a,b,r)=>{let lo=0,hi=1;for(const [k,min,max]of [['x',r.x,r.x+r.width],['y',r.y,r.y+r.height]]){const d=b[k]-a[k];if(Math.abs(d)<1e-9){if(a[k]<min||a[k]>max)return false;}else{let u=(min-a[k])/d,v=(max-a[k])/d;if(u>v)[u,v]=[v,u];lo=Math.max(lo,u);hi=Math.min(hi,v);if(lo>hi)return false;}}return true;};
 const candidates=[];for(const gap of [48,96,160,240])for(const [dx,dy]of [[1,1],[-1,1],[1,-1],[-1,-1],[0,1],[0,-1],[1,0],[-1,0]])candidates.push(clamp({x:anchor.x+(dx>0?gap:dx<0?-width-gap:-width/2),y:anchor.y+(dy>0?gap:dy<0?-height-gap:-height/2)}));
 for(let y=viewport.top+margin;y<=viewport.bottom-height-margin;y+=40)for(let x=viewport.left+margin;x<=viewport.right-width-margin;x+=40)candidates.push({x,y});
 let best=null,score=Infinity;for(const p of candidates){const box={x:p.x-padding,y:p.y-padding,width:width+padding*2,height:height+padding*2};const overlaps=placed.filter(r=>p.x<r.x+r.width+12&&p.x+width+12>r.x&&p.y<r.y+r.height+12&&p.y+height+12>r.y).length,hits=segments.filter(([a,b])=>intersects(a,b,box)).length;const distance=Math.hypot(p.x+width/2-anchor.x,p.y+height/2-anchor.y),value=overlaps*1e9+hits*1e6+distance;if(value<score){score=value;best=p;}}
 return best||clamp(anchor);
};
window.wallSoffitLine=function(group,vector,pair){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pair.map(vector)),new THREE.LineBasicMaterial({color:'#ef633c',depthTest:false,depthWrite:false,transparent:true}));line.userData.exteriorSoffit=true;line.renderOrder=999.5;group.add(line);};
window.wallSelectedLine=function(group,vector,pair){
 if(!THREE.Sprite){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pair.map(vector)),new THREE.LineBasicMaterial({color:'#fff',depthTest:false}));line.userData.exteriorSelection=true;line.renderOrder=1000;group.add(line);return;}
 const [a,b]=pair,sprite=new THREE.Sprite(new THREE.SpriteMaterial({color:'#fff',depthTest:false,depthWrite:false,sizeAttenuation:false}));sprite.userData.exteriorSelection=true;sprite.userData.selectedLineDepth=true;sprite.position.copy(vector({x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2}));sprite.renderOrder=999;
 const depths={value:new THREE.Vector2()};
 sprite.material.onBeforeCompile=shader=>{shader.uniforms.wallSelectedLineDepth=depths;shader.vertexShader='uniform vec2 wallSelectedLineDepth;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <logdepthbuf_vertex>','gl_Position.z = mix(wallSelectedLineDepth.x, wallSelectedLineDepth.y, uv.x) * gl_Position.w;\n#include <logdepthbuf_vertex>');};
 sprite.material.customProgramCacheKey=()=> 'wall-selected-line-depth-v1';
 sprite.onBeforeRender=(renderer,scene,camera)=>{const r=renderer.domElement.getBoundingClientRect(),p=vector(a).clone().project(camera),q=vector(b).clone().project(camera),dx=(q.x-p.x)*r.width/2,dy=(q.y-p.y)*r.height/2,scale=2/(r.height*camera.projectionMatrix.elements[5]);// Perspective does not project the world midpoint to the screen midpoint.
 const biasedDepth=point=>{const v=vector(point).clone().applyMatrix4(camera.matrixWorldInverse),pixel=2*(camera.isPerspectiveCamera?Math.abs(v.z):1)/(r.height*camera.projectionMatrix.elements[5]);v.z=Math.min(-.00001,v.z+pixel*3);return Math.max(-1,v.applyMatrix4(camera.projectionMatrix).z);};depths.value.set(biasedDepth(a),biasedDepth(b));
 const center=vector(a).clone().set((p.x+q.x)/2,(p.y+q.y)/2,(p.z+q.z)/2).unproject(camera);sprite.position.copy(sprite.parent? sprite.parent.worldToLocal(center):center);sprite.material.rotation=Math.atan2(dy,dx);sprite.scale.set(Math.hypot(dx,dy)*scale,3*scale,1);sprite.updateMatrixWorld(true);sprite.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse,sprite.matrixWorld);};group.add(sprite);
};
// Screen-facing center cue, with a fixed pixel size even on oblique faces.
let curveCenterTexture;
window.wallCurveCenterMarker=function(group,vector,point){
 if(typeof document==='undefined'||!THREE.Sprite)return;
 if(!curveCenterTexture){const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');if(!ctx)return;
 ctx.beginPath();ctx.arc(32,32,23,0,Math.PI*2);ctx.strokeStyle='#15251e';ctx.lineWidth=9;ctx.stroke();ctx.strokeStyle='#72ffb0';ctx.lineWidth=4;ctx.stroke();curveCenterTexture=new THREE.CanvasTexture(canvas);}
 const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:curveCenterTexture,transparent:true,depthTest:false,depthWrite:false,sizeAttenuation:false}));sprite.position.copy(vector(point));sprite.renderOrder=1003;sprite.userData.curveCenterIndicator=true;
 sprite.onBeforeRender=(renderer,scene,camera)=>{const height=renderer.domElement.getBoundingClientRect().height,scale=48/(height*camera.projectionMatrix.elements[5]);sprite.scale.set(scale,scale,1);sprite.updateMatrixWorld(true);};group.add(sprite);
};
window.wallCurveGuides=function(group,vector,guides){
 for(const guide of guides||[]){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(guide.points.map(vector)),new THREE.LineDashedMaterial({color:guide.color,dashSize:.12,gapSize:.08,transparent:true,opacity:guide.role==='radius-circle'?.65:.95,depthTest:false,depthWrite:false}));line.computeLineDistances();line.renderOrder=1002;line.userData.curveSnapGuide=guide.role;group.add(line);}
};
// Reference-count text textures across scene rebuilds; only unused labels may
// be evicted. Materials remain per-sprite so rotation and selection stay local.
const lengthTextures=new Map();
function pruneLengthTextures(){for(const [key,entry]of lengthTextures){if(lengthTextures.size<=256)break;if(!entry.users){lengthTextures.delete(key);entry.texture.dispose();}}}
window.wallLengthMarker=function(group,vector,edge){
 if(typeof document==='undefined'||!THREE.Sprite)return;
 const text=edge.text||(window.ReportUnits?.current().distance(edge.length,(edge.length/.3048).toFixed(1)+'\u2032')??(edge.length/.3048).toFixed(1)+'\u2032'),key=JSON.stringify([text,!!edge.selected]);
 let entry=lengthTextures.get(key);
 if(!entry){
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');if(!ctx)return;
 ctx.fillStyle='#fff';ctx.font=(edge.selected?'bold ':'')+'40px Segoe UI, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.strokeStyle=edge.selected?'#245b92':'#000';ctx.lineWidth=edge.selected?8:4;ctx.lineJoin='round';ctx.strokeText(text,128,32);ctx.fillText(text,128,32);
 const texture=new THREE.CanvasTexture(canvas);texture.userData||={};texture.userData.exteriorLabelShared=true;entry={texture,users:0};lengthTextures.set(key,entry);
 }else{lengthTextures.delete(key);lengthTextures.set(key,entry);}
 entry.users++;pruneLengthTextures();
 const material=new THREE.SpriteMaterial({map:entry.texture,transparent:true,depthTest:false,depthWrite:false,sizeAttenuation:false}),dispose=material.dispose?.bind(material);let released=false;
 material.dispose=()=>{if(released)return;released=true;entry.users--;dispose?.();pruneLengthTextures();};
 const sprite=new THREE.Sprite(material);
 sprite.position.copy(vector({x:(edge.a.x+edge.b.x)/2,y:(edge.a.y+edge.b.y)/2,z:(edge.a.z+edge.b.z)/2}));sprite.scale.set(.08,.02,1);sprite.center?.set(.5,edge.centerY??(edge.text ? .5 : .05));
 // Keep the text small and aligned to the projected edge, including during orbit.
 sprite.onBeforeRender=(renderer,scene,camera)=>{
  const r=renderer.domElement.getBoundingClientRect(),a=vector(edge.a).clone().project(camera),b=vector(edge.b).clone().project(camera);
  let angle=Math.atan2((b.y-a.y)*r.height,(b.x-a.x)*r.width);if(angle>Math.PI/2)angle-=Math.PI;if(angle<-Math.PI/2)angle+=Math.PI;sprite.material.rotation=edge.horizontal?0:angle;
  const height=(edge.selected?18:14)*64/40,scale=2*height/(r.height*camera.projectionMatrix.elements[5]);sprite.scale.set(scale*4,scale,1);
  // The renderer has already updated world matrices before this callback.
  // Refresh ours now so a newly rebuilt label uses its pixel size this frame.
  sprite.updateMatrixWorld(true);
 };
 sprite.renderOrder=1001;if(edge.selected)sprite.userData.exteriorSelection=true;sprite.userData.wallLength=edge.length;if(edge.text&&!edge.moveIndicator)sprite.userData.wallFeature=true;if(edge.moveIndicator)sprite.userData.moveIndicator=true;group.add(sprite);
};
// Batch plain drafting wire and square markers; meshes and shader labels keep
// their individual objects for picking and screen-size rendering.
window.wallGeometryBatch=function(group){
 const batches=new Map(),colors=new Map();
 const raw=(line,positions,color,size,depthTest)=>{
  if(!colors.has(color))colors.set(color,new THREE.Color(color).getHex());
  const key=JSON.stringify([line?'line':'point',colors.get(color),1,false,depthTest,true,line?undefined:size,line?undefined:false,line?1:undefined,0]);let b=batches.get(key);
  if(!b){const material=line?new THREE.LineBasicMaterial({color,depthTest}):new THREE.PointsMaterial({color,size,sizeAttenuation:false,depthTest});b={line,material,order:0,positions:[]};batches.set(key,b);}
  for(const p of positions)b.positions.push(p.x,p.y,p.z);
 };
 return {point:THREE.Color&&THREE.Float32BufferAttribute?(p,color,size)=>raw(false,[p],color,size,false):undefined,segment:THREE.Color&&THREE.Float32BufferAttribute?(a,b,color,depthTest)=>raw(true,[a,b],color,undefined,depthTest):undefined,add(o){
  const m=o.material,p=o.geometry?.getAttribute?.('position'),line=o.isLine&&!o.isLineSegments&&m?.type==='LineBasicMaterial',point=o.isPoints&&m?.type==='PointsMaterial'&&!m.map;
  if(o.userData?.planeGuide||!p||(!line&&!point)||o.geometry.index||o.position.lengthSq()||o.rotation.x||o.rotation.y||o.rotation.z||o.scale.x!==1||o.scale.y!==1||o.scale.z!==1){group.add(o);return;}
  const key=JSON.stringify([line?'line':'point',m.color.getHex(),m.opacity,m.transparent,m.depthTest,m.depthWrite,m.size,m.sizeAttenuation,m.linewidth,o.renderOrder]);let b=batches.get(key);
  if(!b){b={line,material:m,order:o.renderOrder,positions:[]};batches.set(key,b);}else m.dispose();
  const push=i=>b.positions.push(p.getX(i),p.getY(i),p.getZ(i));
  if(line)for(let i=1;i<p.count;i++){push(i-1);push(i);}else for(let i=0;i<p.count;i++)push(i);
  o.geometry.dispose();
 },flush(){for(const [key,b]of batches){let built=false;const build=target=>{built=true;b.consumed=true;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(b.positions,3));const o=b.line?new THREE.LineSegments(geometry,b.material):new THREE.Points(geometry,b.material);o.renderOrder=b.order;target.add(o);};if(window.WallMode?.renderChunk)window.WallMode.renderChunk('wire-batch:'+key,b.positions,group,build);else build(group);if(!built)b.material.dispose();}batches.clear();},disposePending(){for(const b of batches.values())if(!b.consumed)b.material.dispose();batches.clear();}};
};

// Select from editable surfaces across layers. Roof faces are reference-only;
// they do not block picking, but their editable fascia panels still do.
// Mounted stickers and their hosts can be exactly coplanar. Prefer a sticker
// only within floating-point depth tolerance; nearer geometry still occludes it.
window.wallPreferredSurfaceHit=function(hits){
 const sorted=[...hits].sort((a,b)=>a.distance-b.distance),front=sorted[0];if(!front)return null;
 const epsilon=Math.max(1,front.point?.length?.()||0,front.distance||0)*1e-6;
 return sorted.find(h=>h.object.userData?.exteriorFeature&&Math.abs(h.distance-front.distance)<=epsilon)||front;
};
window.wallNearestSurface=function(group,e){
 if(!group||typeof THREE==='undefined'||!e.target.closest?.('#three-view-wrapper'))return null;
 const visible=o=>{for(let p=o;p;p=p.parent)if(p.visible===false)return false;return true;},meshes=[];
 group.traverse(o=>{const d=o.userData||{},layer=d.pickLayer||(d.baseId!==undefined?'base':d.solidId!==undefined||d.draftKey!==undefined?'walls':null);if(o.isMesh&&layer&&(layer!=='roof'||d.roofTrimId!==undefined)&&visible(o)&&(Array.isArray(o.material)?o.material.some(m=>m.visible!==false):o.material?.visible!==false)){o.updateMatrixWorld(true);meshes.push(o);}});
 const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
 const hits=ray.intersectObjects(meshes).sort((a,b)=>a.distance-b.distance);let hit=window.wallPreferredSurfaceHit(hits);if(!hit)return null;
 // Grade is a reference surface. At a numerically coincident base, prefer the
 // editable face; do not let Float32 triangulation order decide each click.
 if(hit.object.userData.pickLayer==='grade'){const normal=h=>h.face?.normal.clone().transformDirection(h.object.matrixWorld),n=normal(hit),scale=Math.max(1,(hit.point?.length()||0),hit.distance),epsilon=scale*1e-6;const base=hits.find(h=>h.object.userData.baseId!==undefined&&Math.abs(h.distance-hit.distance)<=epsilon&&n&&Math.abs(n.dot(normal(h)||n))>1-1e-6);if(base)hit=base;}
 const d=hit.object.userData;return {...hit,layer:d.pickLayer||(d.baseId!==undefined?'base':'walls')};
};
// Test the actual candidate against rendered surfaces, including transparent
// faces. Transparency is a display option, not permission to pick through it.
window.wallPointPickVisible=function(group,p,tolerance=0){
 const projected=p.clone().project(camera);if(projected.z<-1||projected.z>1)return false;
 const r=renderer.domElement.getBoundingClientRect(),e={clientX:r.left+(projected.x+1)*r.width/2,clientY:r.top+(1-projected.y)*r.height/2,target:{closest:s=>s==='#three-view-wrapper'}};
 const front=window.wallNearestSurface(group,e);if(!front)return true;
 const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(projected.x,projected.y),camera);
 const depth=p.clone().sub(ray.ray.origin).dot(ray.ray.direction),epsilon=Math.max(1,p.length(),front.distance)*2e-6;
 return depth<=front.distance+epsilon+tolerance;
};
window.wallLinePickVisible=function(group,a,b,e,tolerance=0){
 const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
 const point=new THREE.Vector3();ray.ray.distanceSqToSegment(a,b,null,point);return window.wallPointPickVisible(group,point,tolerance);
};
window.createWallEditor=function(host){

 // One wall composition per render, including the nested drafting renderer.
 const sourceWalls=host.walls;let frameWalls=null;
 host={...host,walls:()=>frameWalls||sourceWalls()};
 function inWallFrame(fn){const previous=frameWalls;try{frameWalls=previous||sourceWalls();return fn();}finally{frameWalls=previous;}}
 let selected=null,indices=[],drag=null,armed=false,history=[],future=[],mouse=null,snapping=true;

 const copy=v=>JSON.parse(JSON.stringify(v)),active=()=>host.enabled()&&host.layer()==='walls'&&(host.visible()||draft?.hasBaseSelection());

 const vertices=w=>[...w.bottom,...w.top],key=w=>w.id;

 function record(before){history.push(copy(before));future=[];host.recordHistory?.(copy(before));}
 const draft=window.createWallFaceDraft?.({pickVisible:host.pickVisible,pickLineVisible:host.pickLineVisible,pickSoffitVisible:host.pickSoffitVisible,pasteHost:host.pasteHost,selectBaseEntities:host.selectBaseEntities,state:host.state,walls:host.walls,wallsVisible:host.visible,hit,roof:()=>host.state()?.boundExtrusionToRoof!==false?(window.WallChimneys?.roofWithOpenings(host.state())||host.state()?.roof):null,active,selected:()=>selected,select:id=>{selected=id;indices=[];host.setLayer?.('walls',false,true);},selectBox:id=>{selected=id;indices=[];host.setLayer?.('walls',true,true);},screen,position:host.position,toPixel:host.toPixel,message:text=>host.message?.(text),redraw:host.redraw,commit:before=>{record(before);host.changed();}});

 function apply(walls){

  const edits=host.state()?.wallEdits||{};

  if(!Object.keys(edits).length)return walls;

  return walls.map(w=>{

   const e=edits[key(w)]||{};

   const next=copy(w),ground=String(w.targetId).startsWith('ground');

   vertices(next).forEach((p,i)=>{const d=e[i];if(!d)return;p.x+=d.x||0;p.y+=d.y||0;

    if(Number.isFinite(d.wallLineZ)){p.z=d.wallLineZ;return;}

    if(i>=2||!ground)p.z+=d.z||0;

    if(i<2&&ground)p.z=host.floorHeight(p)??(p.z+(d.planeMove?(d.z||0):0));

   });const merged=edits.$merges?.find(ids=>ids.includes(w.id));if(merged)next.mergeGroup=merged.slice().sort().join('|');return next;

  }).filter(w=>Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)>.005);

 }

 function screen(p,v){

  if(v==='2d'){const q=host.toPixel(p),d=new DOMPoint(q.x,q.y).matrixTransform(document.getElementById('geo-rotation-group').getScreenCTM());return {x:d.x,y:d.y};}

  const q=getVector3(host.toPixel(p)).project(camera),r=renderer.domElement.getBoundingClientRect();return {x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2,visible:q.z>=-1&&q.z<=1};

 }

 function hit(e){

  if(!host.enabled()||!host.visible())return null;

  const view=e.target.closest?.('#three-view-wrapper')?'3d':e.target.closest?.('#viewport')?'2d':null;

  if(!view)return null;

  let best=null,distance=Infinity;

  if(view==='3d'){

   const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();

   ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);

   for(const w of host.walls().filter(w=>!host.state?.()?.wallEdits?.$drafts?.[w.mergeGroup||w.id]?.mergedInto)){

    const vs=[w.bottom[0],w.bottom[1],w.top[1],w.top[0]].map(p=>getVector3(host.toPixel(p)));

    for(const ids of [[0,1,2],[0,2,3]]){

     const point=ray.ray.intersectTriangle(...ids.map(i=>vs[i]),false,new THREE.Vector3());

     if(point){const d=point.distanceTo(ray.ray.origin);if(d<distance){distance=d;best=w;}}

    }

   }

  }else{

   for(const w of host.walls().filter(w=>!host.state?.()?.wallEdits?.$drafts?.[w.mergeGroup||w.id]?.mergedInto))for(const edge of [w.bottom,w.top]){

    const a=screen(edge[0],view),b=screen(edge[1],view),dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;

    const t=length?Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/length)):0;

    const d=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);

    if(d<=8&&d<distance){distance=d;best=w;}

   }

  }

  return best;

 }

 function pick(e,align=false,chosen=null){

  const w=chosen||hit(e);if(!w)return false;

  if(!align&&draft?.beginFace(e,w))return true;

  selected=key(w);indices=[0,1,2,3];drag=null;armed=false;host.setLayer?.('walls');

  if(!align)draft?.down(e);

  if(align){

   const vs=vertices(w).map(p=>getVector3(host.toPixel(p))),center=getVector3(host.toPixel(window.wallFaceCenters(host.walls()).find(c=>c.members.includes(w.id)).point));

   const normal=vs[1].clone().sub(vs[0]).cross(vs[2].clone().sub(vs[0])).normalize();

   if(normal.lengthSq()>0){

    if(normal.dot(camera.position.clone().sub(center))<0)normal.negate();

    const distance=Math.max(camera.position.distanceTo(controls.target),1);

    // OrbitControls clears its pending rotation/pan deltas on an undamped

    // update. Flush them before installing the new pose, then restore inertia

    // for subsequent manual orbiting.

    const damping=controls.enableDamping;

    try{controls.enableDamping=false;controls.update();}

    finally{controls.enableDamping=damping;}

    controls.target.copy(center);camera.position.copy(center).addScaledVector(normal,distance);camera.up.set(0,1,0);camera.lookAt(center);controls.update();

   }

  }

  host.redraw();return true;

 }

 function down(e){

  if(!active()||e.button!==0)return false;

  const view=e.target.closest?.('#three-view-wrapper')?'3d':e.target.closest?.('#viewport')?'2d':null;if(!view)return false;

  if(!drag)draft?.finishAxisCut();
  if(!drag&&!draft?.busy()&&draft?.pickVisiblePoint(e))return true;
  if(!drag&&!draft?.busy()&&view==='3d'&&draft?.pickLine3D(e))return true;
  if(!drag&&!draft?.busy()&&draft?.holdBoundary(e))return draft.down(e,true);
  if(!drag&&!draft?.busy()&&draft?.pickPoint(e))return true;
  if(!drag&&!draft?.busy()){const front=hit(e),current=host.walls().find(w=>w.id===selected);if(front&&front.id!==selected&&!(front.mergeGroup&&front.mergeGroup===current?.mergeGroup)){draft?.clear();return pick(e);}}

  if(!drag&&draft?.down(e))return true;

  const walls=host.walls();

  if(drag?.plane){const d=drag;drag=null;if(d.changed){record(d.original);host.changed();}host.message?.('');return true;}

  mouse={e,view};

  if(armed&&selected){const w=walls.find(w=>key(w)===selected);if(w){drag={view,wall:copy(w),startY:e.clientY,original:copy({...host.state().wallEdits}),height:true};return true;}}

  const surface=hit(e);

  let best=null,d=14;

  for(const w of walls){

   if(surface&&key(w)!==key(surface))continue;

   const ps=vertices(w);

   for(const [i,p]of ps.entries()){const q=screen(p,view),n=Math.hypot(e.clientX-q.x,e.clientY-q.y);if(n<d){d=n;best={w,i};}}

  }

  for(const c of window.wallFaceCenters(walls)){

   if(surface&&!c.members.includes(surface.id))continue;const q=screen(c.point,view),n=Math.hypot(e.clientX-q.x,e.clientY-q.y);

   if(n<d){d=n;best={w:walls.find(w=>w.id===(c.members.includes(selected)?selected:c.id)),i:4};}

  }

  if(!best)return pick(e);

  if(selected!==key(best.w)){selected=key(best.w);indices=[];}

  if(best.i===4){indices=[0,1,2,3];host.redraw();return true;}else if(e.shiftKey){if(!indices.includes(best.i))indices.push(best.i);}else indices=[best.i];

  if(draft){host.message?.('Boundary points are locked');host.redraw();return true;}

  const p=vertices(best.w)[indices[0]],start=host.position(e,view,p.z);

  drag={view,wall:copy(best.w),original:copy({...host.state().wallEdits}),start,startX:e.clientX,startY:e.clientY,p};

  host.redraw();return true;

 }

 function keyDown(...args){if(!window.ExteriorPerf?.enabled)return perf_keyDown.apply(this,args);return window.ExteriorPerf.measure('Wall keyboard update',()=>perf_keyDown.apply(this,args));}
function perf_keyDown(e){

  if(!active())return false;const k=e.key.toLowerCase();if(k==='s'&&(e.ctrlKey||e.metaKey))return false;if(!['b','l','a','p','t','x','enter','v','s','w','d','g','arrowleft','arrowright','arrowup','arrowdown','m','e','h','escape','z','f','r','c','u','n','delete','backspace','q','y'].includes(k))return false;

  e.stopImmediatePropagation();e.preventDefault();

  if((e.ctrlKey||e.metaKey)&&(k==='y'||(k==='z'&&e.shiftKey))){if(!drag&&!draft?.busy()&&future.length){history.push(copy(host.state().wallEdits||{}));draft?.clear();host.state().wallEdits=future.pop();host.changed();host.redraw();}return true;}
  if(drag&&!e.ctrlKey&&!e.metaKey&&['e','c','n','q','h','v','s','w','d','g','y','u'].includes(k)){const prior=drag;drag=null;armed=false;if(prior.changed){record(prior.original);host.changed();}else host.state().wallEdits=prior.original;}
  if(!drag&&draft?.key(e))return true;

  if(k==='r'){const w=host.walls().find(w=>w.id===selected);if(w)pick(mouse?.e||e,true,w);return true;}

  if(k==='f'){snapping=!snapping;if(typeof isFreeMove!=='undefined')isFreeMove=!snapping;host.message?.(snapping?'Wall snapping on':'Wall snapping off');if(drag?.plane&&mouse)movePointer(mouse.e);return true;}

  if(k==='escape'){if(drag)host.state().wallEdits=drag.original;drag=null;armed=false;host.message?.('');host.redraw();return true;}

  if(k==='z'&&(e.ctrlKey||e.metaKey)){if(drag){host.state().wallEdits=drag.original;drag=null;host.message?.('');host.redraw();return true;}if(history.length){future.push(copy(host.state().wallEdits||{}));draft?.clear();host.state().wallEdits=history.pop();host.changed();host.redraw();}return true;}

  if(k==='m'){

   if(drag?.plane)return true;

   draft?.discardEmpty(selected);

   if(typeof isFreeMove!=='undefined')snapping=!isFreeMove;

   const walls=copy(host.walls()),w=walls.find(w=>key(w)===selected);if(!w||!mouse)return true;

   const len=Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y);if(len<.005)return true;

   const n={x:-(w.bottom[1].y-w.bottom[0].y)/len,y:(w.bottom[1].x-w.bottom[0].x)/len},center=window.wallFaceCenters(walls).find(c=>c.members.includes(w.id)).point;

   const a=screen(center,mouse.view),b=screen({...center,x:center.x+n.x,y:center.y+n.y},mouse.view);

   drag={plane:true,walls,normal:n,view:mouse.view,startX:mouse.e.clientX,startY:mouse.e.clientY,center,amount:0,baseAmount:0,axis:{x:b.x-a.x,y:b.y-a.y},original:copy({...host.state().wallEdits})};

   let movingIds=drag.original.$merges?.find(ids=>ids.includes(selected))||[selected];

   movingIds=[...new Set(movingIds.flatMap(id=>window.WallGeometry.generatedMoveGroup?.(walls,id)||[id]))];drag.movingIds=movingIds;drag.movementOriginal=copy(drag.original);

   if(movingIds.length>1){const ids=new Set(movingIds),groups=drag.movementOriginal.$merges||[];for(const g of groups)if(g.some(id=>ids.has(id)))for(const id of g)ids.add(id);drag.movingIds=movingIds=[...ids];drag.movementOriginal.$merges=[...groups.filter(g=>g.some(id=>ids.has(id))===false),movingIds];}

   drag.excluded=window.connectedWallPlane(walls,selected).filter(id=>!movingIds.includes(id));

   const separates=pair=>pair.some(v=>movingIds.includes(v.id))&&pair.some(v=>drag.excluded.includes(v.id));

   const joints=copy(drag.original.$joints||[]).filter(pair=>!separates(pair));

   for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++)for(let a=0;a<2;a++)for(let b=0;b<2;b++){

    const x=walls[i],y=walls[j];if(separates([{id:x.id},{id:y.id}]))continue;if(Math.hypot(x.bottom[a].x-y.bottom[b].x,x.bottom[a].y-y.bottom[b].y)>.03||Math.min(x.top[a].z,y.top[b].z)-Math.max(x.bottom[a].z,y.bottom[b].z)<=.02)continue;

    if(!joints.some(pair=>pair.some(v=>v.id===x.id&&v.end===a)&&pair.some(v=>v.id===y.id&&v.end===b)))joints.push([{id:x.id,end:a},{id:y.id,end:b}]);

   }

   drag.joints=joints;

   indices=[0,1,2,3];host.message?.('Move wall � click to place');return true;

  }

  if(drag?.plane)return true;

  if(k==='h'&&selected){

   const w=host.walls().find(w=>key(w)===selected);if(!w)return true;

   const ps=vertices(w),ids=indices.length===4?[2,3]:indices,z=ids.reduce((s,i)=>s+ps[i].z,0)/ids.length;

   record(copy(host.state().wallEdits||{}));const edits=host.state().wallEdits||={},offsets=edits[selected]||={};

   for(const i of ids){const d=offsets[i]||={};d.z=(d.z||0)+z-ps[i].z;if(Number.isFinite(d.wallLineZ))d.wallLineZ=z;}host.changed();

  }return true;

 }

 function movePointer(...args){if(!window.ExteriorPerf?.enabled)return perf_movePointer.apply(this,args);return window.ExteriorPerf.measure('Wall pointer update',()=>perf_movePointer.apply(this,args));}
function perf_movePointer(e){
  if(drag&&!drag.plane&&!(e.buttons&1)){host.state().wallEdits=drag.original;drag=null;armed=false;host.redraw();}

  const view=e.target.closest?.('#three-view-wrapper')?'3d':e.target.closest?.('#viewport')?'2d':null;

  if(view)mouse={e,view};

  if(drag?.plane&&active()){

   if(view!==drag.view)return;

   const d=drag;

   if(e.buttons&6){d.navigation=true;return;}

   if(d.navigation){

    d.navigation=false;d.startX=e.clientX;d.startY=e.clientY;d.baseAmount=d.amount||0;

    const a=screen(d.center,d.view),b=screen({...d.center,x:d.center.x+d.normal.x,y:d.center.y+d.normal.y},d.view);d.axis={x:b.x-a.x,y:b.y-a.y};return;

   }

   e.stopImmediatePropagation();e.preventDefault();const axisLength=Math.hypot(d.axis.x,d.axis.y);

   // Face-on views project the normal to a point; vertical mouse travel then

   // controls depth at a stable scale instead of dividing by a tiny projection.

   let amount=d.numeric??(d.baseAmount+(axisLength>8?((e.clientX-d.startX)*d.axis.x+(e.clientY-d.startY)*d.axis.y)/(axisLength*axisLength):(d.startY-e.clientY)*.03));

   const rawAmount=amount;let snapWall=null;

   if(d.numeric==null&&snapping){const source=d.walls.find(w=>w.id===selected),a=source.bottom[0],b=source.bottom[1],length=Math.hypot(b.x-a.x,b.y-a.y),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length};let best=Math.min(.2,axisLength>8?10/axisLength:.12);

    for(const w of d.walls){if(w.id===selected||d.excluded.includes(w.id)||(w.mergeGroup&&w.mergeGroup===source.mergeGroup))continue;const v={x:w.bottom[1].x-w.bottom[0].x,y:w.bottom[1].y-w.bottom[0].y},len=Math.hypot(v.x,v.y);if(len<.005||Math.abs(u.x*v.y-u.y*v.x)/len>1e-5)continue;

     const target=(w.bottom[0].x-a.x)*d.normal.x+(w.bottom[0].y-a.y)*d.normal.y,delta=Math.abs(target-amount);if(delta<best){best=delta;snapWall=w;amount=target;}

    }

   }

   let roofSnap=snapping&&host.state()?.boundExtrusionToRoof!==false?window.findWallRoofSnap(d.walls.find(w=>w.id===selected),rawAmount,host.state()?.roof,Math.min(.2,axisLength>8?10/axisLength:.12)):null;

   if(roofSnap){amount=roofSnap.amount;snapWall=null;}d.roofSnap=null;

   const lastPreview=host.state().wallEdits,lastGesture={amount:d.amount,changed:d.changed,snapId:d.snapId,seams:d.seams,roofSnap:d.roofSnap};try{

    let changed=window.moveWallPlane(d.walls,selected,amount,{...host.state(),_detachIds:d.excluded,wallEdits:{...d.movementOriginal,$joints:d.joints}}),edits=copy(d.movementOriginal);

    if(roofSnap){if(window.fitWallTopToRoof(changed,d.movingIds||[selected],roofSnap,host.state()?.roof))d.roofSnap=roofSnap;else{roofSnap=null;amount=rawAmount;changed=window.moveWallPlane(d.walls,selected,amount,{...host.state(),_detachIds:d.excluded,wallEdits:{...d.movementOriginal,$joints:d.joints}});}}

    edits.$joints=d.joints;

    for(const w of changed){const original=d.walls.find(v=>v.id===w.id),offsets=edits[w.id]||={};vertices(w).forEach((p,i)=>{const old=vertices(original)[i],o=offsets[i]||={};o.x=(o.x||0)+p.x-old.x;o.y=(o.y||0)+p.y-old.y;o.z=(o.z||0)+p.z-old.z;o.planeMove=true;o.wallLineZ=p.z;});}

    d.snapId=snapWall?.id;d.seams=[];

    if(snapWall){

     const preview=d.walls.map(w=>changed.find(v=>v.id===w.id)||w),start=preview.find(w=>w.id===selected),members=[start],samePlane=w=>w.bottom.every(p=>Math.abs((p.x-start.bottom[0].x)*d.normal.x+(p.y-start.bottom[0].y)*d.normal.y)<.002);

     for(let pass=0;pass<preview.length;pass++)for(const w of preview){if(members.includes(w)||d.excluded.includes(w.id)||!samePlane(w)||Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)<.005)continue;

      let joined=false;for(const m of members)for(let i=0;i<2;i++)for(let j=0;j<2;j++)if(Math.hypot(m.bottom[i].x-w.bottom[j].x,m.bottom[i].y-w.bottom[j].y)<.003){const lo=Math.max(m.bottom[i].z,w.bottom[j].z),hi=Math.min(m.top[i].z,w.top[j].z);if(hi-lo>.02&&((m.bottom[1-i].x-m.bottom[i].x)*(w.bottom[1-j].x-w.bottom[j].x)+(m.bottom[1-i].y-m.bottom[i].y)*(w.bottom[1-j].y-w.bottom[j].y))<0){joined=true;d.seams.push([{...m.bottom[i],z:lo},{...m.top[i],z:hi}]);}}

      if(joined)members.push(w);

     }

     if(members.length>1){const ids=new Set(members.map(w=>w.id)),groups=edits.$merges||[];for(const group of groups)if(group.some(id=>ids.has(id)))for(const id of group)ids.add(id);edits.$merges=[...groups.filter(group=>!group.some(id=>ids.has(id))),[...ids]];}

    }

    // M never generates bridge faces; E owns point duplication and returns.
    edits.$surfaces||=[];

    draft?.reflow(d.walls,changed,edits);

    const base=d.original.$base||host.state().base;if(base&&window.BaseGeometry?.followWalls)edits.$base=window.BaseGeometry.followWalls(base,d.walls,changed);

    host.state().wallEdits=edits;const contained=Math.abs(amount)>1e-6&&draft?.mergeWallContained(d.walls.map(w=>changed.find(v=>v.id===w.id)||w),selected);d.amount=amount;d.changed=Math.abs(amount)>.000001||!!roofSnap;d.invalid=false;host.message?.(`Wall offset: ${amount.toFixed(2)} m${roofSnap?' � Roof edge snap (position + height)':contained?' � Contained face merged into draft geometry':snapWall?' � Coplanar snap: '+snapWall.id+(d.seams.length?' � merge on placement':''):snapping?'':' � snap off'}`);host.redraw();

   }catch(error){host.state().wallEdits=lastPreview;Object.assign(d,lastGesture);d.invalid=true;try{host.redraw();}catch(_){}host.message?.(error.message+' Showing last valid position; click to place or Escape to cancel.');}

   return;

  }

  if(!drag||!active())return;e.stopImmediatePropagation();e.preventDefault();const d=drag;

  if(!d.height&&!d.changed&&Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<4)return;

  const edits=copy(d.original),offsets=edits[selected]||={},dz=(d.startY-e.clientY)*.03;

  const q=d.start&&host.position(e,d.view,d.p.z);

  for(const i of indices){const o=offsets[i]||={};if(d.height||e.shiftKey){o.z=(o.z||0)+dz;if(Number.isFinite(o.wallLineZ))o.wallLineZ=vertices(d.wall)[i].z+dz;}else if(q){o.x=(o.x||0)+q.x-d.start.x;o.y=(o.y||0)+q.y-d.start.y;}}

  host.state().wallEdits=edits;d.changed=true;host.redraw();

 }

 window.addEventListener('pointerdown',e=>{if(drag?.plane&&(e.button===1||e.button===2))drag.navigation=true;},true);

 window.addEventListener('wheel',()=>{if(drag?.plane)drag.navigation=true;},true);

 window.addEventListener('pointermove',movePointer,true);

 window.addEventListener('pointerup',e=>{if(e.button!==undefined&&e.button!==0)return;if(!drag||drag.plane)return;e.stopImmediatePropagation();const d=drag;drag=null;armed=false;if(d.changed){record(d.original);host.changed();}},true);

 function draw2D(rot,svg,inv){

  if(!host.enabled()||!host.visible())return;

  draft?.draw2D(rot,svg,inv);

  if(!active())return;

  if(drag&&host.state()?.wallLengths!==false){const walls=host.walls(),wall=walls.find(w=>w.id===selected);if(wall){const points=[wall.bottom[0],wall.bottom[1],wall.top[1],wall.top[0]],faces=walls.map(w=>({points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]}));for(const edge of window.WallSolidGeometry.attachedLengths({points},faces))window.wallLengthMarker(group,vector,edge);}}
  if(drag?.roofSnap){const [a,b]=drag.roofSnap.edge.map(p=>host.toPixel(p));svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#FFD700','stroke-width':5*inv,'pointer-events':'none'},rot);}

  for(const edge of drag?.seams||[]){const p=host.toPixel(edge[0]);svg('circle',{cx:p.x,cy:p.y,r:7*inv,fill:'none',stroke:'#65e6ff','stroke-width':2*inv,'stroke-dasharray':`${2*inv} ${2*inv}`,'pointer-events':'none'},rot);}

  for(const w of host.walls()){

   if(key(w)===selected||key(w)===drag?.snapId)for(const edge of [w.bottom,w.top]){const a=host.toPixel(edge[0]),b=host.toPixel(edge[1]);svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#fff','stroke-width':4*inv,'pointer-events':'none'},rot);}

  }

  if(host.state()?.wallCenters!==false)for(const c of window.wallFaceCenters(host.walls().filter(w=>!draft?.has(w.id)))){const q=host.toPixel(c.point);svg('circle',{cx:q.x,cy:q.y,r:5*inv,'data-wall-id':c.id,fill:c.members.includes(selected)?'#fff':'#ffbc36','pointer-events':'none'},rot);}

 }

 function draw3D(group,vector){

  if(!host.enabled())return;if(!host.visible()){draft?.drawBaseSelection(group,vector);draft?.drawEntity(group,vector);return;}

  draft?.draw3D(group,vector);

  if(!active())return;

  if(drag&&host.state()?.wallLengths!==false){const walls=host.walls(),wall=walls.find(w=>w.id===selected);if(wall){const points=[wall.bottom[0],wall.bottom[1],wall.top[1],wall.top[0]],faces=walls.map(w=>({points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]}));for(const edge of window.WallSolidGeometry.attachedLengths({points},faces))window.wallLengthMarker(group,vector,edge);}}
  if(drag?.roofSnap){const g=new THREE.BufferGeometry().setFromPoints(drag.roofSnap.edge.map(vector));group.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:'#FFD700',depthTest:false})));}

  if(drag?.seams?.length){const g=new THREE.BufferGeometry().setFromPoints(drag.seams.flat().map(vector)),line=new THREE.LineSegments(g,new THREE.LineDashedMaterial({color:'#65e6ff',dashSize:.12,gapSize:.08,depthTest:false}));line.computeLineDistances();group.add(line);}

  const chosen=host.walls().find(w=>key(w)===selected);

  for(const chosen of host.walls().filter(w=>!draft?.has(w.id)&&( w.id===selected||w.id===drag?.snapId||(w.mergeGroup&&w.mergeGroup===host.walls().find(v=>v.id===selected)?.mergeGroup)))){const vs=[chosen.bottom[0],chosen.bottom[1],chosen.top[1],chosen.top[0]],g=new THREE.BufferGeometry().setFromPoints(vs.map(vector));g.setIndex([0,1,2,0,2,3]);group.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:chosen.id===drag?.snapId?'#65e6ff':'#fff',side:THREE.DoubleSide,transparent:true,opacity:.35,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1})));}

  if(host.state()?.wallCenters!==false)for(const c of window.wallFaceCenters(host.walls().filter(w=>!draft?.has(w.id))))window.wallCenterMarker(group,vector,c.point);
  const ps=[];for(const w of host.walls())if(key(w)===selected&&!draft?.has(w.id))ps.push(...indices.map(i=>vertices(w)[i]));

  const geo=new THREE.BufferGeometry().setFromPoints(ps.map(vector));group.add(new THREE.Points(geo,new THREE.PointsMaterial({color:'#fff',size:10,sizeAttenuation:false,depthTest:false})));

 }

 return {resetPosition(){

  const edits=host.state()?.wallEdits;if(!selected||!edits?.[selected])return false;

  record(copy(edits));if(edits.$merges)edits.$merges=edits.$merges.filter(ids=>!ids.includes(selected));if(edits.$joints)edits.$joints=edits.$joints.filter(pair=>!pair.some(v=>v.id===selected));for(const offset of Object.values(edits[selected])){delete offset.x;delete offset.y;}

  host.changed();return true;

 },drawNudgePreview:(...args)=>draft?.drawNudgePreview(...args),resoffit:depth=>draft?.resoffit(depth),setResoffitMode:value=>draft?.setResoffitMode(value),selectionSnapshot:()=>copy({selected,indices,draft:draft?.selectionSnapshot?.()}),restoreSelection(value){const s=copy(value||{});selected=s.selected||null;indices=s.indices||[];draft?.restoreSelection?.(s.draft);},togglePlane:source=>draft?.togglePlane(source),planeView:()=>draft?.planeView(),setPlaneDisplay:value=>draft?.setPlaneDisplay(value),planeActive:()=>draft?.planeActive(),planeDown:e=>draft?.planeDown(e),pointSelection:()=>draft?.pointSelection()||[],createSelectedFace:selection=>draft?.createSelectedFace(selection),extrudeFace:(...args)=>draft?.extrudeFace(...args),geometryCommand:(...args)=>draft?.geometryCommand(...args),clipboardCommand:(...args)=>draft?.clipboardCommand(...args),mergeAll:()=>host.enabled()&&draft?.mergeAll(),autoTrim:width=>host.enabled()&&draft?.autoTrim(width),trimMaterials:()=>draft?.trimMaterials()||[],removeTrim:()=>host.enabled()&&draft?.removeTrim(),selectTrimEdges:(...args)=>host.enabled()&&draft?.selectTrimEdges(...args),applyTrim:(...args)=>host.enabled()&&draft?.applyTrim(...args),chamferCommand:(selection,rounded)=>active()&&draft?.chamferCommand(selection,rounded),activeMaterial:()=>draft?.activeMaterial(),colorCommand:color=>active()&&draft?.colorCommand(color),materialCommand:(...args)=>active()&&draft?.materialCommand(...args),interaction:()=>draft?.interaction()||(drag?"Move wall":armed?"Move wall":null),cancelPointerGesture(){draft?.cancelPointerGesture();if(drag&&!drag.plane){host.state().wallEdits=drag.original;drag=null;armed=false;}},beginEntity:(mode,selection)=>draft?.beginEntity(mode,selection),distanceInput:()=>draft?.distanceInput()||(drag?.plane?{token:drag,amount:drag.amount,set(value){drag.numeric=value;if(mouse)movePointer(mouse.e);}}:null),consumeSelectionClick:()=>draft?.consumeSelectionClick(),startBox:(e,click)=>host.enabled()&&draft?.startBox(e,click),finishPointer:e=>draft?.finishPointer(e),cutFromPoint:(p,k,base)=>host.enabled()&&draft?.cutFromPoint(p,k,base),cutFromPoints:(ps,k,base)=>host.enabled()&&draft?.cutFromPoints(ps,k,base),stepWheel:e=>active()&&draft?.stepWheel(e),stepCommand:()=>active()&&draft?.stepCommand(),featureCommand:(...args)=>active()&&draft?.featureCommand(...args),openingTrimItems:type=>draft?.openingTrimItems(type)||[],selectOpeningTrim:(...args)=>draft?.selectOpeningTrim(...args),applyOpeningTrim:(...args)=>draft?.applyOpeningTrim(...args),featurePlacement:()=>draft?.featurePlacement(),featureSelection:()=>draft?.featureSelection(),featureContext:e=>active()&&draft?.featureContext(e),canBox:()=>active()&&draft?.canBox(),pickPoint:e=>host.enabled()&&draft?.pickVisiblePoint(e),pickLine:e=>host.enabled()&&draft?.pickLine3D(e),pickSurface:e=>host.enabled()&&host.visible()&&draft?.pickSolid(e),doubleClick:e=>active()&&draft?.doubleClick(e,hit(e)||host.walls().find(w=>w.id===selected)),hasDraft:id=>draft?.has(id),apply,down,pick,hit,busy:()=>!!drag||armed||!!draft?.busy(),clear(){draft?.clear();if(drag)host.state().wallEdits=drag.original;drag=null;armed=false;selected=null;indices=[];},keyDown,draw2D:(...args)=>inWallFrame(()=>draw2D(...args)),draw3D:(...args)=>inWallFrame(()=>draw3D(...args)),leave(){draft?.clear();if(drag)host.state().wallEdits=drag.original;drag=null;selected=null;indices=[];armed=false;history=[];future=[];}};

};

})();
