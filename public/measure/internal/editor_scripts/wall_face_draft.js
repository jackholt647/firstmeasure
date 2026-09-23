/* Wall drafting uses face-local metres: x along the wall, y vertical. */
(function(){
'use strict';
// Replacement faces own the visible geometry; these local regions only mask
// their consumed source sketch. Node IDs, not stale positions, track that mask.
function syncConsumedSketchRegions(d,accept=()=>true){
 const nodes=new Map((d.sketch?.nodes||[]).map(n=>[n.id,n]));
 const moved=ring=>ring.map(p=>{const n=nodes.get(p.nodeId);return n&&(n.x!==p.x||n.y!==p.y)?{...p,x:n.x,y:n.y}:p;});
 for(const f of (d.faces||[]).filter(f=>f.solidId&&accept(f))){f.points=moved(f.points);f.holes=(f.holes||[]).map(moved);}
}
// A merged draft owns its source walls even after regeneration changes mergeGroup.
window.normalizeWallDraftOwnership=function(edits){
 window.ExteriorModel?.restoreDraftFaceOwnership(edits);
 window.WallSolidGeometry?.adoptMergedFaceSources(edits);
 const drafts=edits?.$drafts;if(!drafts)return;
 const S=window.BaseSketchGeometry,G=window.WallGeometry;
 // Repair drafts saved by earlier line-move/Resoffit commits on reload too.
 const replacements=new Set((edits.$surfaces||[]).map(f=>f.id));
 for(const d of Object.values(drafts))syncConsumedSketchRegions(d,f=>f.solidId.startsWith('line-move-')&&replacements.has(f.solidId));
 for(const [key,d]of Object.entries(drafts)){
  if(d.frame||!d.members?.length||d.deletedFaces?.length||d.removedPoints?.length||d.faces.some(f=>f.solidId||f.feature||f.material||!/^wall-(region|hole)-/.test(f.id))||d.sketch?.edges.some(e=>!e.fixed)||d.sketch?.nodes.some(n=>n.userDraftPoint))continue;
  const entry=Object.entries(drafts).filter(([k,o])=>k!==key&&!o.frame&&o.members?.length>d.members.length&&d.members.every(id=>o.members.includes(id))).sort((a,b)=>b[1].members.length-a[1].members.length)[0];
  if(!entry)continue;const owner=entry[1];S.ensure(owner);
  for(const n of d.sketch?.nodes||[]){const x=d.origin.x+d.u.x*n.x,y=d.origin.y+d.u.y*n.x,p={x:(x-owner.origin.x)*owner.u.x+(y-owner.origin.y)*owner.u.y,y:n.y,z:0};if(owner.sketch.outlines.some(points=>G.contains({points},p))&&!owner.sketch.nodes.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<.0001))S.add(owner,p,.0001);}
  delete drafts[key];
 }
};
window.createWallFaceDraft=function(host){
 let resoffitMode=false;
 const commit=host.commit;host={...host,commit(before){const M=window.ExteriorModel,state=host.state();if(M){const next=M.reconcileChimneys(state,state.wallEdits);M.validateEdits(next,before);state.wallEdits=next;}commit(before);}};
 const S=window.BaseSketchGeometry,B=window.BaseGeometry,G=window.WallGeometry,copy=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
 let preferredDraft=null,preferredSolid=null,preferredRegion=null,activeDraftKey=null,draftSelection={},picked=[],pickedLines=[],tool=null,mouse=null,selectedSolid=null,selectedRegion=null,solidMeshes=[],box=null,boxEl=null,guideEl=null,snapGuides=[],quadFinish=null,solidPoints=[],solidEdges=[],marqueeCompleted=false;
 const W=window.WallSolidGeometry,buildWire=()=>{const state=host.state(),edits=state?.wallEdits||{},C=window.WallChimneys;if(!C||!state?.chimneys?.items?.length)return W.surfaceWire(edits);return W.surfaceWire({...edits,$surfaces:(edits.$surfaces||[]).flatMap(f=>f.drafted?[f]:C.visibleParts(f,state).map(part=>({...part,retainedPoints:(part.retainedPoints||[]).filter(p=>C.visibleSegments(p,p,state,f.chimney,f.joinedChimneys).length)})))});},signature=f=>f.points.map(p=>p.nodeId).sort().join('|'),deleted=(d,f)=>(d.deletedFaces||[]).includes(signature(f))||[f.points,...(f.holes||[])].flat().some(p=>(d.removedPoints||[]).includes(p.nodeId)),lineMode=()=>typeof document!=='undefined'&&document.getElementById('base-selection')?.value==='line';
 let renderOpenings=[],selectedBasePoints=[],chamferLabels=[],chamferLayoutFrame=null;
 let lineSelection=[],supportSnapshot=null,supportIndex=null;
 // The working plane is transient. Drawn wires and filled regions use the
 // ordinary persisted model, so leaving the mode never discards geometry.
 let workingPlane=null,featurePlacementSerial=0;
 function planeTolerance(frame){
  const a=host.screen(frame.origin,'3d'),scale=Math.max(...[frame.u,frame.v,frame.n].map(v=>{const b=host.screen({x:frame.origin.x+v.x,y:frame.origin.y+v.y,z:frame.origin.z+v.z},'3d');return Math.hypot(b.x-a.x,b.y-a.y);}));
  return Math.max(window.ExteriorGeometry.CONTACT,Number.isFinite(scale)&&scale>0?2/scale:window.ExteriorGeometry.CONTACT);
 }
 function planeProject(p){const K=window.ExteriorGeometry;return K.world(workingPlane.frame,{...K.local(workingPlane.frame,p),z:0});}
 function onWorkingPlane(p){return Math.abs(window.ExteriorGeometry.local(workingPlane.frame,p).z)<=(workingPlane.tolerance??planeTolerance(workingPlane.frame));}
 function refreshPlane(){if(workingPlane){workingPlane.scene=null;workingPlane.tolerance=planeTolerance(workingPlane.frame);planeScene();}}
 function planeScene(){
  if(workingPlane.scene&&workingPlane.sceneEdits===host.state().wallEdits)return workingPlane.scene;
  const on=onWorkingPlane;workingPlane.sceneEdits=host.state().wallEdits;
  const graph=sceneLines(),lines=[...graph.lines.values()].filter(pair=>pair.every(on)),points=graph.points.filter(on);
  const roof=host.state()?.roof;if(roof?.points){points.push(...roof.points.filter(on));for(const edge of roof.connections||[]){const a=roof.points[edge.startIdx],b=roof.points[edge.endIdx];if(a&&b&&on(a)&&on(b))lines.push([a,b]);}}
  return workingPlane.scene={points,lines,curveGroups:[...graph.curveGroups.values()].filter(c=>c.pairs.every(pair=>pair.every(on)))};
 }
 // Axis-defined planes remain transient until the user confirms their angle.
 const planeDot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,planeCross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}),planeUnit=a=>{const l=Math.hypot(a.x,a.y,a.z);return l>1e-8?{x:a.x/l,y:a.y/l,z:a.z/l}:null;};
 function selectionPlane(points){
  const ps=[...new Map(points.map(p=>[W.vertexKey(p),p])).values()],origin=ps[0];if(!origin)return null;
  const far=ps.reduce((a,b)=>distance3(origin,a)>distance3(origin,b)?a:b),u=planeUnit({x:far.x-origin.x,y:far.y-origin.y,z:far.z-origin.z});if(!u)return {axis:[origin]};
  let n=null,area=0;for(const p of ps){const c=planeCross(u,{x:p.x-origin.x,y:p.y-origin.y,z:p.z-origin.z}),a=Math.hypot(c.x,c.y,c.z);if(a>area){area=a;n=planeUnit(c);}}
  if(area<=window.ExteriorGeometry.CONTACT)return {axis:[origin,far]};
  const frame={origin:copy(origin),u,v:planeCross(n,u),n};return ps.every(p=>Math.abs(window.ExteriorGeometry.local(frame,p).z)<=window.ExteriorGeometry.CONTACT)?{frame}:null;
 }
 function confirmPlaneRotation(){
  const r=workingPlane.rotation;
  if(r.single&&!r.stage){r.stage=1;r.firstAxis=copy(r.axis);r.axes=[{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}].filter(axis=>Math.abs(planeDot(axis,r.firstAxis))<.99);r.axis=copy(r.axes[0]);r.axisIndex=0;r.baseFrame=copy(workingPlane.frame);setupPlaneRotation();return;}
  delete workingPlane.rotation;refreshPlane();host.message('Plane ready - M: move; R: rotate; T: flip; Y: resize; Ctrl+C/V: copy/paste; Delete; arrows: nudge; P: exit.');host.redraw();
 }
 function startPlaneRotation(points){
  const origin=points.length===2?{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2,z:(points[0].z+points[1].z)/2}:copy(points[0]);
  const axis=points.length===2?planeUnit({x:points[1].x-points[0].x,y:points[1].y-points[0].y,z:points[1].z-points[0].z}):{x:0,y:0,z:1};if(!axis){host.message('Choose two distinct points for the plane axis.');return true;}
  workingPlane={selection:copy(points),drawing:false,display:'faint',hover:null,rotation:{origin,axis,points:copy(points),single:points.length===1,axisIndex:0,angle:0,numeric:null,radius:Math.max(1,points.length===2?distance3(...points)*.6:1.5)}};
  setupPlaneRotation();return true;
 }
 function setupPlaneRotation(){
  const r=workingPlane.rotation,project=p=>planeUnit({x:p.x-r.axis.x*planeDot(p,r.axis),y:p.y-r.axis.y*planeDot(p,r.axis),z:p.z-r.axis.z*planeDot(p,r.axis)});
  r.zero=project(r.baseFrame?(Math.abs(planeDot(r.axis,r.baseFrame.u))<.9?r.baseFrame.u:r.baseFrame.v):Math.abs(r.axis.x)<.9?{x:1,y:0,z:0}:{x:0,y:1,z:0});r.tangent=planeCross(r.axis,r.zero);r.snaps=[];
  const center=host.screen(r.origin,'3d'),pixels=Math.max(...[r.zero,r.tangent].map(v=>{const q=host.screen({x:r.origin.x+v.x,y:r.origin.y+v.y,z:r.origin.z+v.z},'3d');return Math.hypot(q.x-center.x,q.y-center.y);}));if(Number.isFinite(pixels)&&pixels>1e-4)r.radius=Math.max(65,Math.min(110,r.radius*pixels))/pixels;
  const add=(p,label)=>{
   if(r.baseFrame){const n=r.baseFrame.n,along=planeDot(n,r.axis),c=along*planeDot(p,r.axis),a=planeDot(n,p)-c,b=planeDot(planeCross(r.axis,n),p),length=Math.hypot(a,b);if(length<1e-8||Math.abs(c)>length+1e-8)return;const phase=Math.atan2(b,a),offset=Math.acos(Math.max(-1,Math.min(1,-c/length)));for(const angle of [phase+offset,phase-offset])r.snaps.push({angle:angle*180/Math.PI,label});return;}
   const v=project(p);if(v)r.snaps.push({angle:Math.atan2(planeDot(v,r.tangent),planeDot(v,r.zero))*180/Math.PI,label});
  };
  for(let a=-180;a<=180;a+=45)r.snaps.push({angle:a,label:'World 45 degree'});
  for(const v of [{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}])add(v,'World axis');
  const graph=sceneLines();for(const p of graph.points)add({x:p.x-r.origin.x,y:p.y-r.origin.y,z:p.z-r.origin.z},'Model point');for(const [a,b]of graph.lines.values())if(r.points.some(p=>onSegment(p,a,b)))add({x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},'Connected line');
  const scene=moveScene();for(const f of scene){const fr=W.faceFrame(f);if(!fr)continue;const connected=r.points.some(p=>Math.abs(window.ExteriorGeometry.local(fr,p).z)<.002&&G.contains({points:f.points.map(q=>W.inFrame(fr,q)),holes:(f.holes||[]).map(h=>h.map(q=>W.inFrame(fr,q)))},W.inFrame(fr,p)));if(!connected)continue;
   if(Math.abs(planeDot(fr.n,r.axis))<.002)add(planeCross(fr.n,r.axis),'Connected face');
   for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length];if(r.points.some(p=>onSegment(p,a,b)))add({x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},'Connected line');}
  }
  r.angle=0;r.numeric=null;updatePlaneRotation(0);host.redraw();
 }
 function updatePlaneRotation(angle){
  const p=workingPlane,r=p.rotation;r.angle=angle;const a=angle*Math.PI/180,v={x:r.zero.x*Math.cos(a)+r.tangent.x*Math.sin(a),y:r.zero.y*Math.cos(a)+r.tangent.y*Math.sin(a),z:r.zero.z*Math.cos(a)+r.tangent.z*Math.sin(a)};
  const rotate=q=>{const c=Math.cos(a),s=Math.sin(a),cross=planeCross(r.axis,q),dot=planeDot(r.axis,q);return {x:q.x*c+cross.x*s+r.axis.x*dot*(1-c),y:q.y*c+cross.y*s+r.axis.y*dot*(1-c),z:q.z*c+cross.z*s+r.axis.z*dot*(1-c)};};
  p.frame=r.baseFrame?{origin:copy(r.origin),u:rotate(r.baseFrame.u),v:rotate(r.baseFrame.v),n:rotate(r.baseFrame.n)}:{origin:copy(r.origin),u:copy(r.axis),v,n:planeCross(r.axis,v)};p.seed=[{x:-r.radius,y:-r.radius,z:0},{x:r.radius,y:r.radius,z:0}];p.scene=null;
  const axisName=Math.abs(r.axis.x)>.999?'X':Math.abs(r.axis.y)>.999?'Y':Math.abs(r.axis.z)>.999?'Z':'selected line';
  host.message('Rotate plane'+(r.single?' ('+(r.stage?2:1)+'/2)':'')+' about '+axisName+': '+angle.toFixed(1)+' degrees'+(r.snap?' - '+r.snap:'')+'; type an angle; click to confirm'+(r.single?'; P cycles rotational axes':'')+'; Escape cancels.');
 }
 function previewPlaneRotation(e){
  const r=workingPlane.rotation;if(r.numeric!==null)return;let best=Infinity,angle=r.angle;
  for(let a=-180;a<180;a+=.5){const t=a*Math.PI/180,p={x:r.origin.x+r.radius*(r.zero.x*Math.cos(t)+r.tangent.x*Math.sin(t)),y:r.origin.y+r.radius*(r.zero.y*Math.cos(t)+r.tangent.y*Math.sin(t)),z:r.origin.z+r.radius*(r.zero.z*Math.cos(t)+r.tangent.z*Math.sin(t))},q=host.screen(p,'3d'),d=Math.hypot(q.x-e.clientX,q.y-e.clientY);if(q.visible!==false&&d<best){best=d;angle=a;}}
  r.snap=null;if(!(typeof isFreeMove!=='undefined'&&isFreeMove)){let delta=3;for(const snap of r.snaps)for(const flip of [-180,0,180]){const target=snap.angle+flip,d=Math.abs(((target-angle+540)%360)-180);if(d<delta){delta=d;angle=((target+540)%360)-180;r.snap=snap.label;}}}updatePlaneRotation(angle);host.redraw();
 }
 function drawPlaneRotation(group,vector){
  const r=workingPlane.rotation;if(!r)return;const point=(angle,radius=r.radius)=>{const t=angle*Math.PI/180;return {x:r.origin.x+radius*(r.zero.x*Math.cos(t)+r.tangent.x*Math.sin(t)),y:r.origin.y+radius*(r.zero.y*Math.cos(t)+r.tangent.y*Math.sin(t)),z:r.origin.z+radius*(r.zero.z*Math.cos(t)+r.tangent.z*Math.sin(t))};};
  const line=(a,b,color)=>previewLine(group,vector,a,b,color);
  for(let a=0;a<360;a+=5)line(point(a),point(a+5),'#83cde0');line(r.origin,point(0),'#ffffff');line(r.origin,point(r.angle),'#FFD700');
  const axisEnd=sign=>({x:r.origin.x+sign*r.axis.x*r.radius*1.3,y:r.origin.y+sign*r.axis.y*r.radius*1.3,z:r.origin.z+sign*r.axis.z*r.radius*1.3});line(axisEnd(-1),axisEnd(1),'#ffffff');
  const count=Math.max(1,Math.ceil(Math.abs(r.angle)/5)),vertices=[r.origin,...Array.from({length:count+1},(_,i)=>point(r.angle*i/count))],geo=new THREE.BufferGeometry().setFromPoints(vertices.map(vector));geo.setIndex(Array.from({length:count},(_,i)=>[0,i+1,i+2]).flat());group.add(new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:'#FFD700',side:THREE.DoubleSide,transparent:true,opacity:.18,depthTest:false,depthWrite:false})));
  const label=point(Math.abs(r.angle)<20?r.angle+20:r.angle/2,r.radius*(Math.abs(r.angle)<20?1.2:.65));window.wallLengthMarker?.(group,vector,{a:label,b:label,text:String(Math.round(r.angle*1000)/1000)+'\u00b0',horizontal:true,selected:true});
 }
 function releasePlaneSourceSelection(){selectedSolid=null;selectedRegion=null;faceSelection=[];draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];selectedBasePoints=[];lineSelection=[];host.select(null);}
 function togglePlane(source=null){
  if(workingPlane?.rotation){const r=workingPlane.rotation;if(r.single){const axes=r.axes||[{x:0,y:0,z:1},{x:1,y:0,z:0},{x:0,y:1,z:0}];r.axisIndex=(r.axisIndex+1)%axes.length;r.axis=axes[r.axisIndex];setupPlaneRotation();}return true;}
  if(workingPlane&&tool&&!finishToolForSwitch())return true;
  if(workingPlane){workingPlane=null;clearGuides();host.message('Plane off � drawn geometry kept.');host.redraw();return true;}
  if(tool){host.message('Finish or cancel the current tool before choosing a plane.');return true;}
  const inferred=source?.axisPoints||(!source&&!selectedSolid&&!selectedRegion&&!faceSelection.length&&geometrySelectionPoints());if(inferred?.length){const fit=selectionPlane(inferred);if(!fit){host.message('Selected points and lines must all lie on one plane.');return true;}if(fit.axis)return startPlaneRotation(fit.axis);workingPlane={frame:fit.frame,selection:copy(inferred),drawing:false,display:'faint',hover:null,seed:inferred.map(p=>window.ExteriorGeometry.local(fit.frame,p))};releasePlaneSourceSelection();refreshPlane();host.message('Plane constrained to selected geometry. M: move; R: rotate; T: flip; Y: resize; P: exit.');host.redraw();return true;}
  source=source?.face||source;
  let face=source||selectedFinishFace();
  if(face&&selectedRegion&&!source){const d=all()[selectedRegion.draft];face=engineFace(d,face);}
  if(!face&&!selectedWorldPoints().length&&!lineSelection.length&&!pickedLines.length&&!solidEdges.length){const w=selected();if(w)face={points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]};}
  const K=window.ExteriorGeometry,frame=face&&K.frame(face);
  if(!frame||face.curvedSurface||face.points.some(p=>Math.abs(K.local(frame,p).z)>K.CONTACT)){host.message('Select a flat face, then press P to draw on its plane.');return true;}
  workingPlane={frame:copy(frame),material:face.material,finishColor:face.finishColor,selection:[],drawing:false,display:'faint',hover:null,seed:face.points.map(p=>K.local(frame,p))};
  releasePlaneSourceSelection();refreshPlane();
  host.message('Plane on - double-click: point; C: connect; N: extend; S: curve; Q: quadrilateral; drag: select; P: exit.');host.redraw();return true;
 }
 function planePoint(e){
  clearGuides();
  const d={frame:workingPlane.frame},p=rayPoint(d,e);if(!p)return null;
  const K=window.ExteriorGeometry,scene=planeScene(),local=p=>K.local(d.frame,p);
  if(typeof isFreeMove!=='undefined'&&isFreeMove)return p;
  const result=(workingPlane.action?.kind==='quad'&&W.quadDraftSnap(p,q=>planeQuad(q),scene.points.map(local),scene.lines.map(pair=>pair.map(local)),workingPlane.selection.map(local),q=>host.screen(K.world(d.frame,q),viewOf(e)),typeof snapRadius!=='undefined'?snapRadius:20,{lineCenters:host.state()?.lineCenters}))||W.draftSnap(p,scene.points.map(local),scene.lines.map(pair=>pair.map(local)),workingPlane.selection.map(local),q=>host.screen(K.world(d.frame,q),viewOf(e)),typeof snapRadius!=='undefined'?snapRadius:20,{lineCenters:host.state()?.lineCenters});
  snapGuides=result.guides;showGuides(d,e);
  // Keep the identity of a tolerance-admitted point instead of leaving a
  // second, almost coincident point on the mathematical plane.
  return {...result.point,z:result.kind==='Point'?(result.point.z||0):0};
 }
 function planeDown(e){if(tool?.kind==='arch')return e.button===0?placeArch(e):false;
  if(!workingPlane||viewOf(e)!=='3d'||e.button!==0)return false;
  mouse=e;if(tool){flushPreview();if(tool.kind==='geometryTransform')return placeGeometry();if(tool.kind==='paste')return placePaste(e);return true;}if(workingPlane.rotation){confirmPlaneRotation();return true;}if(workingPlane.action)return placePlaneAction(e);
  if(workingPlane.drawing){const q=planePoint(e);if(q){const p=window.ExteriorGeometry.world(workingPlane.frame,q);planeEdit(p,workingPlane.selection.map(a=>[a,p]));}return true;}
  beginBox(e,null);box.plane=true;box.priorPlane=workingPlane.selection.slice();
  box.click=()=>{let best=null,dist=12;for(const p of planeScene().points){const q=host.screen(p,'3d'),d=Math.hypot(q.x-e.clientX,q.y-e.clientY);if(q.visible!==false&&d<dist){best=p;dist=d;}}
   const priorLines=workingPlane.selectedLines||[],priorFaces=workingPlane.selectedFaces||[];let chosen=best?[best]:[];workingPlane.selectedLines=[];workingPlane.selectedFaces=[];
   if(lineMode()||!best){let pair=null,distance=10;for(const edge of planeScene().lines){const [a,b]=edge.map(p=>host.screen(p,'3d')),dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;if(l<1e-8)continue;const t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l)),d=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);if(d<distance){pair=edge;distance=d;}}if(pair){const curve=planeScene().curveGroups.find(c=>c.pairs.some(edge=>pair.every(p=>onSegment(p,...edge))));chosen=curve?planeScene().points.filter(p=>curve.pairs.some(edge=>onSegment(p,...edge))):pair;workingPlane.selectedLines=curve?curve.pairs:[pair];}}
   const faceMode=typeof document!=='undefined'&&document.getElementById('base-selection')?.value==='face';
   if(faceMode){const q=rayPoint({frame:workingPlane.frame},e),K=window.ExteriorGeometry,base=host.state().wallEdits.$base||host.state().base,faces=[...moveScene().filter(f=>!f.deleted&&!f.snapOnly),...(base?.faces||[]).map(f=>({...f,baseId:f.id}))],face=q&&faces.filter(f=>[f.points,...(f.holes||[])].flat().every(onWorkingPlane)).find(f=>G.contains({points:f.points.map(p=>K.local(workingPlane.frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(workingPlane.frame,p)))},q));chosen=face?[face.points,...(face.holes||[])].flat():[];workingPlane.selectedLines=[];workingPlane.selectedFaces=face?[face]:[];}
   const subtract=e.ctrlKey||e.metaKey,add=e.shiftKey||subtract,chosenLines=workingPlane.selectedLines,chosenFaces=workingPlane.selectedFaces,faceKey=f=>f.baseId?'base:'+f.baseId:f.id;
   if(add){workingPlane.selectedLines=priorLines.filter(pair=>!chosenLines.some(p=>W.edgeKey(...p)===W.edgeKey(...pair))).concat(subtract?[]:chosenLines);workingPlane.selectedFaces=priorFaces.filter(f=>!chosenFaces.some(g=>faceKey(g)===faceKey(f))).concat(subtract?[]:chosenFaces);}
   const prior=workingPlane.selection,keys=new Set(chosen.map(W.vertexKey)),others=prior.filter(p=>!keys.has(W.vertexKey(p)));
   workingPlane.selection=e.ctrlKey||e.metaKey?others:e.shiftKey?[...others,...chosen]:chosen;host.redraw();};return true;
 }
 function connectPairs(points){return points.flatMap((a,i)=>points.slice(i+1).map(b=>[a,b])).filter(([a,b])=>distance3(a,b)>window.ExteriorGeometry.CONTACT);}
 function connectWorldSelection(){
  const points=selectedWorldPoints(),pairs=connectPairs(points);if(!pairs.length)return false;
  const d=current();if(d){const ids=points.map(p=>d.sketch.nodes.find(n=>distance3(world(d,n),p)<=window.ExteriorGeometry.CONTACT)?.id);if(ids.every(Boolean))return transaction(()=>{for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)S.connect(d,[ids[i],ids[j]]);});}
  const fit=selectionPlane(points);if(fit?.frame){const prior=workingPlane;workingPlane={frame:fit.frame,selection:points,seed:[],display:'hidden'};try{return planeEdit(null,pairs);}finally{workingPlane=prior;}}
  return transaction(()=>{const edits=host.state().wallEdits,loose=edits.$loose||={points:[],edges:[]};for(const p of points)if(!loose.points.some(q=>W.vertexKey(q)===W.vertexKey(p)))loose.points.push(copy(p));for(const pair of pairs){if(!loose.edges.some(e=>W.edgeKey(...e)===W.edgeKey(...pair)))loose.edges.push(copy(pair));edits.$removedSurfaceEdges=(edits.$removedSurfaceEdges||[]).filter(id=>id!==W.edgeKey(...pair));}});
 }
 function deletePlaneSelection(){
  const plane=workingPlane,ps=plane.selection;if(!ps.length)return true;
  let ok;if(plane.selectedFaces?.length)ok=transaction(()=>{const edits=host.state().wallEdits;for(const face of plane.selectedFaces){if(face.baseId){const base=copy(edits.$base||host.state().base);base.faces=base.faces.filter(f=>f.id!==face.baseId);delete base.sketch;S.ensure(base);edits.$base=base;}else if(face.draft){const d=all()[face.draftKey],f=d?.faces.find(f=>f.id===face.regionId);if(f)d.deletedFaces=[...new Set([...(d.deletedFaces||[]),signature(f)])];}else{const f=edits.$surfaces?.find(f=>f.id===face.id);if(f)f.deleted=true;}}});
  else if(plane.selectedLines?.length){const pairs=plane.selectedLines;ok=transaction(()=>deleteLines3D(pairs));}
  else{const keys=new Set(ps.map(W.vertexKey));draftSelection={};picked=[];activeDraftKey=null;for(const [key,d]of Object.entries(all()))draftSelection[key]=d.sketch.nodes.filter(n=>keys.has(W.vertexKey(world(d,n)))).map(n=>n.id);solidPoints=[...keys];solidEdges=[];selectedBasePoints=basePoints().filter(p=>keys.has(W.vertexKey(p))).map(W.vertexKey);ok=deleteBoxSelection();}
  if(ok){plane.selection=[];plane.selectedLines=[];plane.selectedFaces=[];refreshPlane();}host.redraw();return true;
 }
 function parallelPlaneLines(){
  const plane=workingPlane,K=window.ExteriorGeometry,selected=new Set(plane.selection.map(W.vertexKey)),pairs=plane.selectedLines?.length?plane.selectedLines:planeScene().lines.filter(pair=>pair.every(p=>selected.has(W.vertexKey(p))));
  if(pairs.length<2){host.message('Select at least two lines to make parallel.');return true;}
  if(!geometryCommand('m')||tool?.kind!=='geometryTransform')return true;
  const t=tool,original=t.original,byKey=new Map(original.points.map(p=>[W.vertexKey(p),{...K.local(plane.frame,p)}])),lines=pairs.slice().sort((a,b)=>distance3(...b)-distance3(...a)),driver=lines.shift(),[a,b]=driver.map(p=>byKey.get(W.vertexKey(p))),length=Math.hypot(b.x-a.x,b.y-a.y),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length},fixed=new Set(driver.map(W.vertexKey));
  while(lines.length){const i=Math.max(0,lines.findIndex(pair=>pair.some(p=>fixed.has(W.vertexKey(p))))),pair=lines.splice(i,1)[0],keys=pair.map(W.vertexKey),[a,b]=keys.map(k=>byKey.get(k));if(keys.every(k=>fixed.has(k)))continue;const l=Math.hypot(b.x-a.x,b.y-a.y),sign=(b.x-a.x)*u.x+(b.y-a.y)*u.y<0?-1:1,dx=l*u.x*sign,dy=l*u.y*sign;
   if(fixed.has(keys[0])){b.x=a.x+dx;b.y=a.y+dy;}else if(fixed.has(keys[1])){a.x=b.x-dx;a.y=b.y-dy;}else{const x=(a.x+b.x)/2,y=(a.y+b.y)/2;a.x=x-dx/2;a.y=y-dy/2;b.x=x+dx/2;b.y=y+dy/2;}keys.forEach(k=>fixed.add(k));
  }
  try{const map=p=>byKey.has(W.vertexKey(p))?K.world(plane.frame,byKey.get(W.vertexKey(p))):p,preview={...copy(original),points:original.points.map(map),edges:original.edges.map(r=>r.map(map)),faces:original.faces.map(f=>({...f,points:f.points.map(map),holes:(f.holes||[]).map(r=>r.map(map))}))},edits=copy(t.prepared);applyLineResult(t,W.transformSelection(t.scene,original,preview),edits);window.ExteriorModel.validateEdits(edits,t.before);host.state().wallEdits=edits;t.preview=preview;t.changed=true;placeGeometry();}
  catch(error){host.state().wallEdits=t.before;tool=null;host.message(error.message);host.redraw();}return true;
 }
 function subtractPlaneRegion(){
  const plane=workingPlane,K=window.ExteriorGeometry;if(plane.selection.length<3){host.message('Select the boundary of the region to subtract.');return true;}
  const ok=transaction(()=>{const frame=plane.frame,local=p=>({...K.local(frame,p),z:0}),world=p=>K.world(frame,p),boundary=W.faceFromPoints(plane.selection.map(planeProject),planeScene().lines),cutter={points:boundary.points.map(local)},base=host.state().wallEdits.$base||host.state().base,owners=[...moveScene().filter(f=>!f.deleted&&!f.snapOnly&&!f.curvedSurface),...(base?.faces||[]).map(f=>({...f,baseId:f.id}))].filter(f=>[f.points,...(f.holes||[])].flat().every(onWorkingPlane));const edits=host.state().wallEdits;let next=0;
   for(const owner of owners){const shape={points:owner.points.map(local),holes:(owner.holes||[]).map(r=>r.map(local))},pieces=K.difference(shape,[cutter]);if(Math.abs(pieces.reduce((s,f)=>s+K.area(f),0)-K.area(shape))<1e-8)continue;
    const faces=pieces.map(piece=>{let id;do{id='plane-cut-'+Date.now()+'-'+next++;}while(edits.$surfaces?.some(f=>f.id===id));return {...owner,id,draft:false,drafted:false,points:piece.points.map(world),holes:piece.holes.map(r=>r.map(world))};});
    if(owner.baseId){const before=copy(edits.$base||base),after=copy(before);after.faces=after.faces.flatMap(f=>f.id===owner.baseId?faces.map((f,i)=>({...f,id:i?f.id:owner.baseId})):f);S.rebind(before,after);edits.$base=after;}
    else{if(owner.draft){const d=all()[owner.draftKey],f=d.faces.find(f=>f.id===owner.regionId);d.deletedFaces=[...new Set([...(d.deletedFaces||[]),signature(f)])];}else{const f=edits.$surfaces.find(f=>f.id===owner.id);f.deleted=true;}edits.$surfaces||=[];edits.$surfaces.push(...faces);}
   }
  });if(ok){plane.selectedFaces=[];refreshPlane();host.message('Selected region subtracted.');host.redraw();}return true;
 }
 function planeEdit(point,pairs=[],curve=null){
  if(!point&&!pairs.length&&!curve)return true;
  const plane=workingPlane,K=window.ExteriorGeometry,frame=plane.frame;
  const ok=transaction(()=>{
   const edits=host.state().wallEdits,loose=edits.$loose||={points:[],edges:[]};
   for(const p of [...(point?[point]:[]),...pairs.flat()]){if(!loose.points.some(q=>W.vertexKey(q)===W.vertexKey(p)))loose.points.push(p);edits.$removedSurfacePoints=(edits.$removedSurfacePoints||[]).filter(id=>id!==W.vertexKey(p));}
   if(curve){
    const drafts=edits.$drafts||={};let d=Object.values(drafts).find(d=>d.constructionPlane&&JSON.stringify(d.frame)===JSON.stringify(frame));
    if(!d){let i=0;while(drafts['plane-curves-'+i])i++;d=drafts['plane-curves-'+i]={constructionPlane:true,frame:copy(frame),members:[],faces:[],sketch:{version:2,next:0,nodes:[],edges:[],outlines:[]}};}
    S.addCurve(d,curve);const ps=K.curveSamples(curve).map(p=>K.world(frame,p));pairs=ps.slice(1).map((p,i)=>[ps[i],p]);
   }
   pairs=pairs.filter(([a,b])=>distance3(a,b)>K.CONTACT);if(!pairs.length)return;
   for(const pair of curve?[]:pairs){if(!loose.edges.some(e=>W.edgeKey(...e)===W.edgeKey(...pair)))loose.edges.push(pair);edits.$removedSurfaceEdges=(edits.$removedSurfaceEdges||[]).filter(id=>id!==W.edgeKey(...pair));}
   plane.scene=null;const scene=planeScene(),nodes=[],lookup=new Map(),node=p=>{const local={...K.local(frame,p),z:0},key=K.pointKey(local);if(!lookup.has(key)){lookup.set(key,'plane-node-'+nodes.length);nodes.push({...local,id:lookup.get(key)});}return lookup.get(key);};
   const edges=scene.lines.map(([a,b],i)=>({id:'plane-edge-'+i,a:node(a),b:node(b)}));
   const graph=K.partition({nodes,edges}),local=p=>({...K.local(frame,p),z:0}),world=p=>K.world(frame,p);
   const owners=moveScene().filter(f=>!f.deleted&&!f.snapOnly&&!f.curvedSurface&&[f.points,...(f.holes||[])].flat().every(onWorkingPlane)),shape=f=>({points:f.points.map(local),holes:(f.holes||[]).map(r=>r.map(local))}),covered=owners.map(shape);
   const base=edits.$base||host.state().base;for(const f of base?.faces||[])if(!f.deleted&&f.points.every(onWorkingPlane)){covered.push(shape(f));owners.push({...f,planeBaseId:f.id});}
   const target=host.state().wallEdits;target.$surfaces||=[];let next=0;
   const curves=Object.values(target.$drafts||{}).filter(d=>d.frame).flatMap(d=>(d.sketch?.curves||[]).map(c=>K.mapCurve(c,p=>K.world(d.frame,p)))).filter(c=>K.curveSamples(c).every(onWorkingPlane));
   const attachCurves=face=>{const matches=curves.filter(c=>{const ps=K.curveSamples(c).map(local);return ps.slice(1).some((p,i)=>W.sharedIntervals(ps[i],p,[shape(face)]).length);});if(matches.length)face.curves=[...(face.curves||[]),...matches];return face;};

   const regions=graph.regions.filter(points=>pairs.some(([a,b])=>W.sharedIntervals(local(a),local(b),[{points}]).length)).map(points=>({points,holes:[]}));
   // Closing a loop within an existing face partitions that owner, instead of
   // stacking a duplicate polygon on top or treating the loop as empty wire.
   for(const owner of owners){let pieces=[shape(owner)];for(const region of regions)pieces=pieces.flatMap(piece=>[...K.intersection([piece],[region]),...K.difference(piece,[region])]);
    if(pieces.length<=1)continue;
    if(owner.planeBaseId){const previous=copy(target.$base||base),updated=copy(previous),index=updated.faces.findIndex(f=>f.id===owner.planeBaseId);if(index<0)continue;let serial=0;const replacements=pieces.flatMap(piece=>piece.holes.length?K.pieces([piece]).map(points=>({points,holes:[]})):[piece]).map((piece,i)=>{let id=owner.planeBaseId;if(i){do{id=owner.planeBaseId+'-plane-'+serial++;}while(updated.faces.some(f=>f.id===id));}const face={...updated.faces[index],id,points:piece.points.map(world),holes:piece.holes.map(r=>r.map(world))};attachCurves(face);K.validateFace(face);return face;});updated.faces.splice(index,1,...replacements);S.rebind(previous,updated);target.$base=updated;continue;}
    const source=owner.draft?target.$drafts?.[owner.draftKey]?.faces.find(f=>f.id===owner.regionId):target.$surfaces.find(f=>f.id===owner.id);if(!source)continue;
    const ids=[];for(const piece of pieces){while(target.$surfaces.some(f=>f.id==='plane-face-'+next))next++;const face={...owner,id:'plane-face-'+next++,draft:false,drafted:false,points:piece.points.map(world),holes:piece.holes.map(r=>r.map(world))};attachCurves(face);K.validateFace(face);target.$surfaces.push(face);ids.push(face.id);}
    if(owner.draft)source.solidId=ids[0];else source.deleted=true;
   }
   for(const {points} of regions){
    for(const region of K.difference({points,holes:[]},covered)){
     if(K.area(region)<1e-8)continue;while(target.$surfaces.some(f=>f.id==='plane-face-'+next))next++;
     const face={id:'plane-face-'+next++,points:region.points.map(world),holes:region.holes.map(r=>r.map(world)),...(plane.material?{material:plane.material}:{}),...(plane.finishColor?{finishColor:plane.finishColor}:{})};
     attachCurves(face);K.validateFace(face);target.$surfaces.push(face);covered.push(region);
    }
   }
  });
  plane.scene=null;
  if(ok){if(point)plane.selection=[point];plane.drawing=false;plane.hover=null;clearGuides();}host.redraw();return ok;
 }
 // Plane tools share the same quad and analytic arc kernels as face drafting.
 function planeQuad(p){const plane=workingPlane,K=window.ExteriorGeometry;return quadCorners(plane.selection.map(p=>K.local(plane.frame,p)),p,plane.action?.diagonal);}
 function planeKey(e){
  if(workingPlane.rotation){if(e.key.toLowerCase()==='escape'){workingPlane=null;host.redraw();}else if(e.key.toLowerCase()==='enter'&&!e.repeat)confirmPlaneRotation();return true;}
  const plane=workingPlane,k=e.key.toLowerCase(),K=window.ExteriorGeometry;
  if(tool?.kind==='geometryTransform'||tool?.kind==='paste')return geometryKey(e);
  if((e.ctrlKey||e.metaKey)&&['c','v','x'].includes(k)){if(e.repeat)return true;if(k==='x'){clipboardCommand('copy');return deletePlaneSelection();}return clipboardCommand(k==='c'?'copy':'paste');}
  if((e.ctrlKey||e.metaKey)&&k!=='a')return false;
  if(k.startsWith('arrow')){const step=(e.altKey ? .25 : e.shiftKey ? 6 : 1)*F.FT/12*(e.nudgeCount||1);return nudgeGeometry(k==='arrowright'?step:k==='arrowleft'?-step:0,k==='arrowup'?step:k==='arrowdown'?-step:0);}
  if(e.repeat)return true;
  if(['m','r','t','y'].includes(k)&&!plane.action&&!plane.drawing)return geometryCommand(k);
  if(['delete','backspace'].includes(k))return deletePlaneSelection();
  if(k==='v'){createSelectedFace({points:plane.selection.map(p=>planeProject(p))});refreshPlane();return true;}
  if(k==='b')return subtractPlaneRegion();
  if(k==='l')return parallelPlaneLines();
  if(k==='a'){plane.selection=planeScene().points.slice();plane.selectedLines=[];host.redraw();return true;}
  if(['escape','enter'].includes(k)){plane.action=null;plane.drawing=false;plane.hover=null;clearGuides();}
  else if(k==='f'){if(typeof isFreeMove!=='undefined')isFreeMove=!isFreeMove;clearGuides();}
  else if(k==='s'||k==='q'){
   const n=plane.selection.length;if(k==='s'?n!==1:n<1||n>2){host.message(k==='s'?'Select one point to start a curve.':'Select one corner or two edge points for Q.');return true;}
   plane.drawing=false;plane.hover=null;clearGuides();plane.action=k==='s'?{kind:'curve',start:K.local(plane.frame,plane.selection[0]),track:{}}:{kind:'quad'};
   host.message(k==='s'?'Curve: click the center, then sweep to the endpoint; Shift-click continues; Escape cancels.':'Q: click the opposite corner, then rotate; double-click it for a rectangle.');
  }else if(k==='n'){plane.action=null;plane.drawing=true;host.message('Click to place a new point connected to the selected points; Escape cancels.');}
  else if(['c','u'].includes(k)&&!plane.action)planeEdit(null,connectPairs(plane.selection));
  host.redraw();return true;
 }
 function previewPlaneCurve(e){
  const plane=workingPlane,t=plane.action,K=window.ExteriorGeometry,raw=rayPoint({frame:plane.frame},e);clearGuides();if(!raw)return;
  const local=p=>K.local(plane.frame,p),scene=planeScene(),curves=Object.values(all()).filter(d=>d.constructionPlane&&JSON.stringify(d.frame)===JSON.stringify(plane.frame)).flatMap(d=>d.sketch.curves||[]);
  t.snap=K.curveDrawSnap({start:t.start,center:t.center,point:raw,normal:{x:0,y:0,z:1},points:scene.points.map(local),curves,screen:p=>host.screen(K.world(plane.frame,p),'3d'),snap:!(typeof isFreeMove!=='undefined'&&isFreeMove),radius:typeof snapRadius!=='undefined'?snapRadius:20});
  t.pointer=t.snap.point;t.track.close=t.snap.close;t.valid=false;
  if(t.center)try{t.curve=K.arcPreview(t.start,t.center,t.pointer,{x:0,y:0,z:1},t.track,false);t.samples=K.curveSamples(t.curve);t.pointer=t.samples.at(-1);t.valid=Math.abs(t.curve.sweep)>1e-5;}catch(error){host.message(error.message);}
  t.guides=K.curveDrawGuides({start:t.start,center:t.center,pointer:t.pointer,snap:t.snap,normal:{x:0,y:0,z:1}});
 }
 function placePlaneAction(e){
  const plane=workingPlane,t=plane.action,K=window.ExteriorGeometry;if(viewOf(e)!=='3d'||e.button!==0)return false;
  if(t.kind==='curve'){
   previewPlaneCurve(e);if(!t.center){if(t.pointer&&Math.hypot(t.pointer.x-t.start.x,t.pointer.y-t.start.y)>K.CONTACT){t.center=copy(t.pointer);t.track={};host.message('Sweep around the center, then click the endpoint.');}host.redraw();return true;}
   if(t.valid&&planeEdit(K.world(plane.frame,t.samples.at(-1)),[],t.curve)){plane.action=e.shiftKey?{kind:'curve',start:copy(t.samples.at(-1)),center:copy(t.center),track:{}}:null;host.message('Curve placed.');}host.redraw();return true;
  }
  const p=planePoint(e);if(!p)return true;
  if(plane.selection.length===1&&!t.diagonal){t.diagonal=p;t.cornerClick={x:e.clientX,y:e.clientY};host.redraw();return true;}
  let corners=planeQuad(p);if(plane.selection.length===1&&t.cornerClick&&Math.hypot(e.clientX-t.cornerClick.x,e.clientY-t.cornerClick.y)<4){const opposite=t.diagonal;t.diagonal=null;corners=planeQuad(opposite);}
  try{B.validate({points:corners});const ps=corners.map(p=>K.world(plane.frame,p));if(planeEdit(null,ps.map((p,i)=>[p,ps[(i+1)%ps.length]]))){plane.action=null;plane.selection=[];quadFinish={x:e.clientX,y:e.clientY,time:Date.now()};}}
  catch(error){host.message(error.message);}host.redraw();return true;
 }
 function drawWorkingPlane(group,vector){
  if(!workingPlane)return;const output=group;group={add(o){o.userData||={};o.userData.planeGuide=true;output.add(o);}};const K=window.ExteriorGeometry,plane=workingPlane,scene=planeScene();
  // The guide is upright within the supporting plane, independent of which
  // edge established the drawing coordinates. Keep those coordinates intact.
  const origin=plane.frame.origin,guide=F.frame([origin,...[plane.frame.u,plane.frame.v].map(a=>({x:origin.x+a.x,y:origin.y+a.y,z:origin.z+a.z}))]);
  const points=[...plane.seed.map(p=>K.world(plane.frame,p)),...scene.points,...(plane.hover?[K.world(plane.frame,plane.hover)]:[])].map(p=>K.local(guide,p));
  drawPlaneRotation(group,vector);
  const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)),span=Math.max(maxX-minX,maxY-minY,4),pad=Math.max(2,span*.3),loX=minX-pad,hiX=maxX+pad,loY=minY-pad,hiY=maxY+pad;
  const world=(x,y)=>K.world(guide,{x,y,z:0}),corners=[[loX,loY],[hiX,loY],[hiX,hiY],[loX,hiY]].map(([x,y])=>world(x,y));
  const mesh=new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(corners.map(vector)).setIndex([0,1,2,0,2,3]),new THREE.MeshBasicMaterial({color:'#51bcd6',transparent:true,opacity:.08,side:THREE.DoubleSide,depthWrite:false}));mesh.userData.workingPlane=true;group.add(mesh);
  const step=Math.pow(10,Math.floor(Math.log10(span/10)));const spacing=Math.max(step,span/40);
  for(let x=Math.ceil(loX/spacing)*spacing;x<=hiX;x+=spacing)previewLine(group,vector,world(x,loY),world(x,hiY),'#31606b',true);
  for(let y=Math.ceil(loY/spacing)*spacing;y<=hiY;y+=spacing)previewLine(group,vector,world(loX,y),world(hiX,y),'#31606b',true);
  for(const [a,b]of scene.lines)previewLine(group,vector,a,b,'#70ddeb');
  for(const pair of plane.selectedLines||[])window.wallSelectedLine(group,vector,pair.pair||pair);
  if(scene.points.length)group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(scene.points.map(vector)),new THREE.PointsMaterial({color:'#70ddeb',size:5,sizeAttenuation:false,depthTest:false})));
  if(plane.hover)group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints([vector(K.world(plane.frame,plane.hover))]),new THREE.PointsMaterial({color:'#FFD700',size:9,sizeAttenuation:false,depthTest:false})));
  if(plane.selection.length)group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(plane.selection.map(vector)),new THREE.PointsMaterial({color:'#ffffff',size:9,sizeAttenuation:false,depthTest:false})));
  if(plane.drawing&&plane.hover)for(const p of plane.selection)previewLine(group,vector,p,K.world(plane.frame,plane.hover),'#FFD700');
  const t=plane.action;if(t){const localWorld=p=>K.world(plane.frame,p),ps=t.kind==='quad'&&plane.hover?planeQuad(plane.hover):t.samples||[];for(let i=1;i<ps.length;i++)previewLine(group,vector,localWorld(ps[i-1]),localWorld(ps[i]),'#FFD700');if(t.kind==='quad'&&ps.length)previewLine(group,vector,localWorld(ps.at(-1)),localWorld(ps[0]),'#FFD700');if(t.kind==='curve'){window.wallCurveGuides?.(group,vector,(t.guides||[]).map(g=>({...g,points:g.points.map(localWorld)})));window.wallCurveCenterMarker?.(group,vector,localWorld(t.center||t.pointer||t.start));}}

 }

 const structuralPoint=(p,faces)=>supportIndex?supportIndex.point(p):W.structuralPoint(p,faces),structuralEdge=(a,b,faces)=>supportIndex?supportIndex.edge(a,b):W.structuralEdge(a,b,faces);
 const solids=()=>{const edits=host.state()?.wallEdits;if(!edits?.$surfaces)return [];edits.$surfaces=window.ExteriorGeometry.compactSurfaces(edits.$surfaces);return edits.$surfaces;};
 // Geometry queries within one synchronous render share the same wall scene.
 // Do not retain it between events: preview, cancel and undo all change geometry.
 let renderWalls=null,renderSegments=null;
 let renderCacheKey=null,renderCache=new Map(),renderCacheActive=false;
 // Share derived geometry between the two views, but only for byte-identical
 // model inputs. This cache is never used by editing/deletion transactions.
 function beginRenderCache(){for(const d of Object.values(all()))retainSourcePoints(d);renderCacheActive=true;const key=JSON.stringify([host.state(),renderWalls]);if(key!==renderCacheKey){renderCacheKey=key;renderCache=new Map();}}
 function renderDerived(key,build){if(!renderCacheActive||window.EXTERIOR_DISABLE_RENDER_CACHE===true)return build();if(!renderCache.has(key)){const label=key.startsWith('segments:')?'Draft edge preparation':key==='wire'?'Wire graph preparation':key==='support-index'?'Support index':'Support faces';renderCache.set(key,window.ExteriorPerf?.enabled?window.ExteriorPerf.measure(label,build):build());}return renderCache.get(key);}
 // Picking shares the render-derived topology, but never holds it over a
 // mutation. A rectangle enters this scope only after materializing its drafts.
 function withSelectionGeometry(fn){
  if(renderCacheActive)return fn();
  const run=()=>{const prior=[renderWalls,renderSegments,supportSnapshot,supportIndex];
   try{renderWalls=host.walls();renderSegments=new Map();beginRenderCache();
    supportSnapshot=renderDerived('support',()=>structuralFaces());
    supportIndex=renderDerived('support-index',()=>W.structuralIndex(supportSnapshot));
    return fn();
   }finally{[renderWalls,renderSegments,supportSnapshot,supportIndex]=prior;renderCacheActive=false;}
  };
  const query=()=>window.WallChimneys?.withVisibilitySnapshot?window.WallChimneys.withVisibilitySnapshot(host.state(),run):run();
  return window.ExteriorPerf?.enabled?window.ExteriorPerf.measure('Selection geometry',query):query();
 }
 const wire=()=>renderDerived('wire',buildWire);

 const walls=()=>renderWalls||host.walls();
 const all=()=>host.state()?.wallEdits?.$drafts||{},selected=()=>walls().find(w=>w.id===host.selected()),id=w=>Object.entries(all()).filter(([,d])=>!d.frame&&d.members?.includes(w.id)).sort((a,b)=>b[1].members.length-a[1].members.length)[0]?.[0]||w.mergeGroup||w.id;
 const draftKey=d=>Object.keys(all()).find(key=>all()[key]===d),isPicked=(d,nodeId)=>(draftSelection[draftKey(d)]||(current()===d?picked:[])).includes(nodeId);
 const current=()=>{const w=selected();return all()[activeDraftKey]||(w&&all()[id(w)]);};
 const currentDraftId=()=>draftKey(current())||(selected()?id(selected()):null),visibleDraft=d=>!d.mergedInto&&(d.constructionPlane|| (d.solidHost?solids().some(f=>f.id===d.solidHost&&!f.deleted):!!d.members?.length));
 // A persisted draft owns its edited geometry. Regenerating roof-to-base sources
 // can remove its former source after an inset; that must not hide the draft.
 // Consumed and deleted regions are still excluded by visibleDraftFaces.
 const engineFace=(d,f,overrides={})=>window.ExteriorModel.draftFace(d,f,overrides);
 function world(d,p){if(d.frame)return W.fromFrame(d.frame,p);return {x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};}
 function retainMergedIdentity(d){
  if(d.frame)return;
  const members=walls().filter(w=>d.members?.includes(w.id)),chimneys=members.filter(w=>w.chimney);
  if(!chimneys.length||chimneys.length===members.length)return;
  // A shared side belongs to the building plane regardless of which original
  // strip was clicked. Its chimney portion is already intentionally included.
  delete d.chimney;
  d.joinedChimneys=[...new Set([...(d.joinedChimneys||[]),...chimneys.map(w=>w.chimney.id)])];
 }
 function retainSourcePoints(d){
  retainMergedIdentity(d);
  const generated=walls().filter(w=>d.members?.includes(w.id));if(generated.length&&generated.every(w=>w.sourceId&&w.kind==='perimeter'&&!w.chimney))d.generatedRoofContact=true;
  if(d.sourcePointsVersion===1||d.frame)return;
  const members=walls().filter(w=>d.members.includes(w.id)),junctions=walls().filter(w=>!d.members.includes(w.id)).flatMap(w=>[...w.bottom,...w.top]);
  const candidates=members.flatMap(w=>[...w.bottom,...w.top].filter(p=>!w.sourceId||junctions.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-5)));
  for(const p of candidates){const q={x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0};
   if(d.sketch.nodes.some(n=>Math.hypot(n.x-q.x,n.y-q.y)<.0001)||(d.removedPoints||[]).length||!d.faces.some(f=>!deleted(d,f)&&G.contains(f,q)))continue;
   const n={...q,id:'p'+(++d.sketch.next),fixed:false,sourceSplit:true};d.sketch.nodes.push(n);
  }
  for(const f of solids().filter(f=>!f.deleted&&!f.drafted)){
   const frame=W.faceFrame(f);if(!frame)continue;const local={points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))};
   for(const n of d.sketch.nodes){if((d.removedPoints||[]).includes(n.id))continue;const p=world(d,n);if(Math.abs((p.x-frame.origin.x)*frame.n.x+(p.y-frame.origin.y)*frame.n.y+(p.z-frame.origin.z)*frame.n.z)>1e-5||!G.contains(local,W.inFrame(frame,p)))continue;
    f.retainedPoints||=[];if(![...f.points,...f.retainedPoints].some(q=>W.vertexKey(q)===W.vertexKey(p)))f.retainedPoints.push(p);
   }
  }
  d.sourcePointsVersion=1;
 }
 function retainedRegionPoints(d,f){return d.sketch.nodes.filter(n=>!n.generatedBoundary||isPicked(d,n.id)||structuralDraftPoint(d,n)).filter(n=>!(d.removedPoints||[]).includes(n.id)&&G.contains(f,n)).map(n=>world(d,n));}
 function ensure(w){
  const edits=host.state().wallEdits={...host.state().wallEdits},drafts=edits.$drafts||={};if(drafts[id(w)]&&(drafts[id(w)].faces.length||drafts[id(w)].sketch?.nodes.length||drafts[id(w)].deletedFaces?.length)){retainSourcePoints(drafts[id(w)]);return drafts[id(w)];}
  const origin={...w.bottom[0]},len=Math.hypot(w.bottom[1].x-origin.x,w.bottom[1].y-origin.y),u={x:(w.bottom[1].x-origin.x)/len,y:(w.bottom[1].y-origin.y)/len};
  const members=walls().filter(v=>id(v)===id(w)),local=p=>({x:(p.x-origin.x)*u.x+(p.y-origin.y)*u.y,y:p.z,z:0});
  const filled=members.map(v=>[v.bottom[0],v.bottom[1],v.top[1],v.top[0]].map(local)),union=W.unionPlanar(filled);
  if(members.every(v=>v.sourceId&&v.kind==='perimeter'&&!v.chimney)){
   const junctions=walls().filter(v=>!members.includes(v)).flatMap(v=>[...v.bottom,...v.top]).filter(p=>Math.abs((p.x-origin.x)*u.y-(p.y-origin.y)*u.x)<1e-5).map(local);
   for(const face of union){face.points=G.simplifyGeneratedRing(face.points.map(p=>({...p,z:0})),junctions);face.holes=(face.holes||[]).map(r=>G.simplifyGeneratedRing(r.map(p=>({...p,z:0})),junctions));}
  }
  const loops=union.map(f=>f.points),holes=union.flatMap(f=>f.holes);if(!loops.length)throw Error("Could not build the merged wall outline.");
  const d={origin,u,chimney:w.chimney&&copy(w.chimney),members:members.map(v=>v.id),faces:loops.map((points,i)=>({id:'wall-region-'+i,points:points.map(p=>({...p,z:0}))}))};d.faces.push(...holes.map((points,i)=>({id:'wall-hole-'+i,boundaryHole:true,points:points.map(p=>({...p,z:0}))})));S.ensure(d);for(const p of members.filter(v=>!v.sourceId).flatMap(v=>[...v.bottom,...v.top].map(local)))if(!d.sketch.nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y)<.0001)){const nodeId=S.add(d,p,.0001);if(d.chimney)d.sketch.nodes.find(n=>n.id===nodeId).generatedBoundary=true;}retainSourcePoints(d);classify(d);drafts[id(w)]=d;return d;
 }
 function rayPoint(d,e){
  if(host.projectPoint)return host.projectPoint(d,e);
  if(viewOf(e)==='2d'&&host.position){const z=d.sketch?.nodes.find(n=>picked.includes(n.id))?.y||0,p=host.position(e,'2d',z);if(!p)return null;if(d.frame){const n=d.frame.n,o=d.frame.origin;if(Math.abs(n.z)<1e-8)return null;p.z=o.z-(n.x*(p.x-o.x)+n.y*(p.y-o.y))/n.z;return W.inFrame(d.frame,p);}return {x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:z,z:0};}
  const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
  const o=getVector3(host.toPixel(world(d,{x:0,y:0}))),u=getVector3(host.toPixel(world(d,{x:1,y:0}))).sub(o),v=getVector3(host.toPixel(world(d,{x:0,y:1}))).sub(o),normal=u.clone().cross(v).normalize();
  const hit=ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal,o),new THREE.Vector3());if(!hit)return null;
  const q=hit.sub(o);return {x:q.dot(u)/u.lengthSq(),y:q.dot(v)/v.lengthSq(),z:0};
 }
 const viewOf=e=>e.target.closest?.('.exterior-sticker-bar')?null:e.target.closest?.('#three-view-wrapper')?'3d':e.target.closest?.('#viewport')?'2d':null;
 function clearGuides(){if(chamferLayoutFrame!=null)cancelAnimationFrame(chamferLayoutFrame);chamferLayoutFrame=null;for(const el of chamferLabels)el.remove?.();chamferLabels=[];snapGuides=[];guideEl?.remove?.();guideEl=null;}
 function showGuides(d,e){
  guideEl?.remove?.();guideEl=null;if(!snapGuides.length||typeof document==='undefined')return;
  const view=viewOf(e),element=document.getElementById(view==='3d'?'three-view-wrapper':'viewport');if(!element)return;const r=element.getBoundingClientRect(),ns='http://www.w3.org/2000/svg';guideEl=document.createElementNS(ns,'svg');
  Object.assign(guideEl.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',pointerEvents:'none',zIndex:10000,overflow:'hidden'});document.body.appendChild(guideEl);
  for(const g of snapGuides){const a=host.screen(world(d,g.p1),view),b=host.screen(world(d,g.p2),view),len=Math.hypot(b.x-a.x,b.y-a.y);if(len<1e-6)continue;const dx=(b.x-a.x)/len*5000,dy=(b.y-a.y)/len*5000,line=document.createElementNS(ns,'line');for(const [k,v]of Object.entries({x1:a.x-dx-r.left,y1:a.y-dy-r.top,x2:a.x+dx-r.left,y2:a.y+dy-r.top,stroke:'#FFD700','stroke-width':1.5,'stroke-linecap':'round',opacity:.85}))line.setAttribute(k,v);guideEl.appendChild(line);}
 }
 function snap(...args){if(!window.ExteriorPerf?.enabled)return perf_snap.apply(this,args);return window.ExteriorPerf.measure('Point snapping',()=>perf_snap.apply(this,args));}
function perf_snap(d,e,raw=null){
  const p=raw||rayPoint(d,e);clearGuides();if(!p)return null;if(typeof isFreeMove!=='undefined'&&isFreeMove)return p;
  const moving=tool?.kind==='move',excluded=new Set(moving?tool.ids:[]),nodes=draftNodes(d).filter(n=>!excluded.has(n.id)),byId=id=>d.sketch.nodes.find(n=>n.id===id),edges=d.sketch.edges.filter(e=>!excluded.has(e.a)&&!excluded.has(e.b)).map(e=>[byId(e.a),byId(e.b)]);
  const anchors=moving?d.sketch.edges.flatMap(e=>excluded.has(e.a)&&!excluded.has(e.b)?[byId(e.b)]:excluded.has(e.b)&&!excluded.has(e.a)?[byId(e.a)]:[]).concat(tool.anchor?[tool.anchor]:[]):picked.map(byId).filter(Boolean);
  const screen=p=>host.screen(world(d,p),viewOf(e)),radius=typeof snapRadius!=='undefined'?snapRadius:20;
  const result=(tool?.kind==='quad'&&W.quadDraftSnap(p,q=>quadPoints(d,q),nodes,edges,anchors,screen,radius,{lineCenters:host.state()?.lineCenters}))||W.draftSnap(p,nodes,edges,anchors,screen,radius,{lineCenters:host.state()?.lineCenters});snapGuides=result.guides;showGuides(d,e);if(result.kind)host.message(result.kind);return result.point;
 }
 function basePoints(){const base=host.state()?.wallEdits?.$base||host.state()?.base;if(!base||base.visible===false)return [];S.syncSurfaceBoundaries(base,host.state()?.wallEdits?.$surfaces);return S.read(base).nodes;}
 function deleteBoxSelection(){
  const groups=Object.entries(draftSelection).filter(([,ids])=>ids.length),baseKeys=new Set(selectedBasePoints);
  const changed=transaction(()=>{
   removeSolidPoints(solidPoints,solidEdges);for(const [key,ids]of groups){const d=all()[key];if(d)removeDraftPoints(d,ids);}
   if(baseKeys.size){const base=copy(host.state().wallEdits.$base||host.state().base),old=base.sketch;const originalFaces=base.faces,selected=p=>baseKeys.has(W.vertexKey(p))||!!p.id&&originalFaces.some(f=>{if(!G.contains(f,p))return false;const plane=G.plane(f.points);return baseKeys.has(W.vertexKey({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}));});
    base.faces=base.faces.flatMap(f=>{if(!f.points.some(selected))return [f];const points=f.points.filter((p,i)=>{if(!selected(p))return true;const a=f.points[(i+f.points.length-1)%f.points.length],b=f.points[(i+1)%f.points.length];return Math.abs((p.x-a.x)*(b.y-p.y)-(p.y-a.y)*(b.x-p.x))>1e-7;});if(points.some(selected))return [];return points.length>=3?[{...f,points}]:[];});
    delete base.sketch;S.ensure(base);for(const n of old?.nodes||[])if(!selected(n)&&base.sketch.outlines.some(points=>G.contains({points},n)))S.add(base,n,.0001);
    for(const e of old?.edges||[]){if(e.fixed)continue;const a=old.nodes.find(n=>n.id===e.a),b=old.nodes.find(n=>n.id===e.b);if(!a||!b||selected(a)||selected(b))continue;const u=base.sketch.nodes.find(n=>Math.hypot(n.x-a.x,n.y-a.y)<.0001),v=base.sketch.nodes.find(n=>Math.hypot(n.x-b.x,n.y-b.y)<.0001);if(u&&v&&!base.sketch.edges.some(e=>[e.a,e.b].includes(u.id)&&[e.a,e.b].includes(v.id)))base.sketch.edges.push({id:'e'+(++base.sketch.next),a:u.id,b:v.id,fixed:false});}
    host.state().wallEdits.$base=base;
   }
  });if(!changed)return false;draftSelection={};selectedBasePoints=[];picked=[];solidPoints=[];solidEdges=[];host.redraw();return true;
 }
 function drawBaseSelection(group,vector){if(selectedBasePoints.length){const points=basePoints().filter(p=>selectedBasePoints.includes(W.vertexKey(p)));if(points.length)group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(vector)),new THREE.PointsMaterial({color:'#fff',size:12,sizeAttenuation:false,depthTest:false})));}}
 // Keep every owning record selected for deletion/edits, but count shared
 // corners in world space using the same contact tolerance as topology.
 function selectedWorldPoints(){
  const points=[],groups={...draftSelection},d=current();if(d&&!Object.values(groups).some(ids=>ids.length))groups[draftKey(d)]=picked;
  const take=p=>{if(p&&!points.some(q=>distance3(p,q)<=window.ExteriorGeometry.CONTACT))points.push(p);};
  for(const [key,ids]of Object.entries(groups)){const owner=all()[key];if(owner)for(const n of owner.sketch.nodes)if(ids.includes(n.id))take(world(owner,n));}
  if(solidPoints.length)for(const n of wire().nodes)if(solidPoints.includes(n.id))take(n);
  if(selectedBasePoints.length)for(const p of basePoints())if(selectedBasePoints.includes(W.vertexKey(p)))take(p);
  return points;
 }
 function beginBox(e,d){marqueeCompleted=false;box={x:e.clientX,y:e.clientY,ex:e.clientX,ey:e.clientY,view:viewOf(e),draft:d,add:!!(e.shiftKey||e.ctrlKey||e.metaKey),subtract:!!(e.ctrlKey||e.metaKey),prior:picked.slice(),priorDrafts:{...copy(draftSelection),...(current()?{[draftKey(current())]:picked.slice()}:{})},priorSolids:solidPoints.slice(),priorBase:selectedBasePoints.slice()};}
 function endBox(e){if(e&&e.button!==undefined&&e.button!==0)return;
  if(!box||e?.button!==undefined&&e.button!==0)return;if(e&&viewOf(e))mouse=e;const b=box;box=null;boxEl?.remove?.();boxEl=null;
  const moved=b.moved||Math.hypot((e?.clientX??b.ex)-b.x,(e?.clientY??b.ey)-b.y)>=4;
  if(b.plane&&workingPlane){if(!moved){b.click?.();return;}marqueeCompleted=true;const selected=planeScene().points.filter(p=>{const q=host.screen(p,'3d');return q.visible!==false&&q.x>=Math.min(b.x,e?.clientX??b.ex)&&q.x<=Math.max(b.x,e?.clientX??b.ex)&&q.y>=Math.min(b.y,e?.clientY??b.ey)&&q.y<=Math.max(b.y,e?.clientY??b.ey);}),keys=new Set(selected.map(W.vertexKey));
   workingPlane.selectedLines=[];workingPlane.selectedFaces=[];workingPlane.selection=b.subtract?b.priorPlane.filter(p=>!keys.has(W.vertexKey(p))):[...new Map([...(b.add?b.priorPlane:[]),...selected].map(p=>[W.vertexKey(p),p])).values()];host.redraw();e?.stopImmediatePropagation?.();return;}
  if(!b.add&&(moved||(!b.lineClick&&!b.deferredPick)))lineSelection=[];
  if(!moved){if(!b.add)selectedBasePoints=[];if(!e||viewOf(e)===b.view)b.click?.();return;}
  marqueeCompleted=true;
  b.ex=e?.clientX??b.ex;b.ey=e?.clientY??b.ey;
  if(!(b.add&&!b.subtract&&(lineSelection.length||pickedLines.length||solidEdges.length))&&host.wallsVisible?.()!==false)for(const w of walls())ensure(w);
  return withSelectionGeometry(()=>{
  const insideCache=new Map(),left=Math.min(b.x,b.ex),right=Math.max(b.x,b.ex),top=Math.min(b.y,b.ey),bottom=Math.max(b.y,b.ey);
  const inside=p=>{const key=W.vertexKey(p);if(insideCache.has(key))return insideCache.get(key);const q=host.screen(p,b.view),inRect=Number.isFinite(q.x)&&Number.isFinite(q.y)&&q.visible!==false&&q.x>=left&&q.x<=right&&q.y>=top&&q.y<=bottom;const result=inRect&&!(b.view==='3d'&&host.state()?.translucent===false&&host.pickVisible?.(p)===false);insideCache.set(key,result);return result;};
  // Even a few pixels of pointer jitter can become a marquee. Additive line
  // gestures stay line gestures, and an empty rectangle leaves all state alone.
  if(b.add&&!b.subtract&&(lineSelection.length||pickedLines.length||solidEdges.length)){
   const hits=[...sceneLines().lines].filter(([,pair])=>pair.every(inside)&&pickLineVisible(pair,{...e,target:e?.target,clientX:host.screen(pair[0],b.view).x/2+host.screen(pair[1],b.view).x/2,clientY:host.screen(pair[0],b.view).y/2+host.screen(pair[1],b.view).y/2},.5));
   if(hits.length){const keys=new Set(lineSelection.map(l=>l.id));for(const [id,pair]of hits)if(!keys.has(id)){lineSelection.push({id,pair});keys.add(id);}host.redraw();}
   e?.stopImmediatePropagation?.();return;
  }
  draftSelection={};for(const [key,d]of Object.entries(all())){if(host.wallsVisible?.()===false||!visibleDraft(d))continue;const ids=draftNodes(d).filter(n=>inside(world(d,n))).map(n=>n.id);draftSelection[key]=b.subtract?(b.priorDrafts[key]||[]).filter(id=>!ids.includes(id)):[...new Set([...(b.add?b.priorDrafts[key]||[]:[]),...ids])];}
  solidPoints=[...new Set([...(b.add?b.priorSolids:[]),...(host.wallsVisible?.()===false?[]:wire().nodes.filter(n=>!n.curveSample).filter(inside).map(n=>n.id))])];selectedRegion=null;selectedSolid=null;pickedLines=[];solidEdges=[];selectedBasePoints=[...new Set([...(b.add?b.priorBase:[]),...basePoints().filter(inside).map(W.vertexKey)])];
  if(b.subtract){const nodes=new Map(wire().nodes.map(n=>[n.id,n])),base=new Map(basePoints().map(p=>[W.vertexKey(p),p]));solidPoints=b.priorSolids.filter(id=>!nodes.has(id)||!inside(nodes.get(id)));selectedBasePoints=b.priorBase.filter(id=>!base.has(id)||!inside(base.get(id)));}
  const first=Object.entries(draftSelection).find(([,ids])=>ids.length),w=first?walls().find(w=>all()[first[0]].members.includes(w.id)):walls()[0];(host.selectBox||host.select)(w?.id||null);activeDraftKey=first?.[0]||null;
  picked=draftSelection[draftKey(current())]||[];host.redraw();const count=selectedWorldPoints().length;host.message(count+(count===1?' point selected':' points selected'));e?.stopImmediatePropagation?.();
  });

 }
 let faceSelection=[];
 const faceKey=ref=>ref.solid?'solid:'+ref.solid:'draft:'+ref.draft+':'+ref.face;
 function selectedFaceRefs(){if((!selectedSolid&&!selectedRegion)||selectedWorldPoints().length)return [];const primary=selectedSolid?{solid:selectedSolid}:selectedRegion;return faceSelection.some(r=>faceKey(r)===faceKey(primary))?faceSelection:[primary];}
 function selectFaceRef(ref,e){
  const previous=selectedFaceRefs(),subtract=e.ctrlKey||e.metaKey;
  faceSelection=subtract?previous.filter(r=>!ref||faceKey(r)!==faceKey(ref)):e.shiftKey?[...previous.filter(r=>!ref||faceKey(r)!==faceKey(ref)),...(ref?[ref]:[])]:ref?[ref]:[];
  const last=faceSelection.at(-1);selectedSolid=last?.solid||null;selectedRegion=last&&!last.solid?last:null;
 }
 function faceChosen(ref){return selectedFaceRefs().some(r=>faceKey(r)===faceKey(ref));}
 function selectRegion(d,e,w,faceId){
  const p=faceId==null?rayPoint(d,e):null,face=faceId!=null?d.faces.find(f=>f.id===faceId&&!deleted(d,f)&&!f.solidId):p&&d.faces.filter(f=>!deleted(d,f)&&!f.solidId&&G.contains(f,p)).sort((a,b)=>Number(!!b.feature)-Number(!!a.feature)||Number(b.opening)-Number(a.opening))[0];
  if(e.shiftKey&&(lineSelection.length||pickedLines.length||solidEdges.length))return;
  if(!face&&(e.shiftKey||e.ctrlKey||e.metaKey))return;
  selectFaceRef(face?{draft:draftKey(d),face:face.id}:null,e);
  if(w){activeDraftKey=null;host.select(w.id);}draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];
  if(face){preferredDraft=draftKey(d);preferredSolid=null;preferredRegion=face.id;host.message(faceSelection.length+(faceSelection.length===1?' face selected':' faces selected'));}host.redraw();
 }
 function beginFace(e,w){
  if(!w||!viewOf(e)||e.button!==0)return false;const d=ensure(w);beginBox(e,d);box.activate=()=>{activeDraftKey=null;host.select(w.id);};box.click=()=>{activeDraftKey=null;host.select(w.id);let best=null,distance=12;for(const n of draftNodes(d)){const p=host.screen(world(d,n),viewOf(e)),dist=Math.hypot(p.x-e.clientX,p.y-e.clientY);if(dist<distance&&pickVisible(world(d,n),e)){distance=dist;best=n.id;}}if(best){draftSelection={};selectedRegion=null;selectedSolid=null;picked=e.shiftKey?[...new Set([...picked,best])]:[best];host.redraw();}else selectRegion(d,e,w);};return true;
 }
 window.addEventListener('pointerup',endBox,true);
 window.addEventListener('pointercancel',()=>{box=null;boxEl?.remove?.();boxEl=null;clearGuides();},true);
 function add(d,p){const n=S.add(d,p,.0001),node=d.sketch.nodes.find(v=>v.id===n);node.userDraftPoint=true;delete node.generatedBoundary;if(d.sketch.edges.some(e=>e.fixed&&(()=>{const a=d.sketch.nodes.find(v=>v.id===e.a),b=d.sketch.nodes.find(v=>v.id===e.b),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),t=((node.x-a.x)*dx+(node.y-a.y)*dy)/(len*len);return t>=0&&t<=1&&Math.abs((node.x-a.x)*dy-(node.y-a.y)*dx)/len<.002;})()))node.fixed=true;S.resolve(d);return n;}
 function containsRegion(f,h){const outer={points:f.points};if(!h.points.every(p=>G.contains(outer,p)))return false;const K=window.ExteriorGeometry;return K.difference({points:h.points},[outer]).reduce((area,part)=>area+K.area(part),0)<=1e-8;}
 function classify(d){const holes=d.faces.filter(f=>f.boundaryHole||f.points.every(p=>!d.sketch.nodes.find(n=>n.id===p.nodeId)?.fixed));for(const f of d.faces){f.opening=holes.includes(f);f.holes=f.opening?[]:holes.filter(h=>containsRegion(f,h)).map(h=>h.points);}}
 function transaction(fn,original){const rollback=copy(host.state().wallEdits||{}),before=copy(original??rollback);try{supportSnapshot=structuralFaces();fn();for(const d of Object.values(all()))classify(d);host.commit(before);host.redraw();return true;}catch(e){host.state().wallEdits=rollback;host.message(e.message);return false;}finally{supportSnapshot=null;}}
 function holdBoundary(e){if(['textured','rendered','match-textured'].includes(host.state()?.displayMode)&&viewOf(e)==='3d')return false;
  let d=all()[preferredDraft];if(!d&&preferredSolid){const f=solids().find(f=>f.id===preferredSolid&&!f.deleted);if(f){const frame=W.faceFrame(f),local=p=>W.inFrame(frame,p);const near=f.points.some((p,i)=>{const a=host.screen(p,'3d'),b=host.screen(f.points[(i+1)%f.points.length],'3d'),dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l2)):0;return Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy)<12;});if(near&&viewOf(e)==='3d'&&(()=>{const p=rayPoint({frame},e);return p&&pickVisible(W.fromFrame(frame,p),e);})()){d=solidDraft(f);preferredDraft=draftKey(d);}}}if(!d||!visibleDraft(d)||viewOf(e)!=='3d')return false;const hitPoint=rayPoint(d,e);if(hitPoint&&!pickVisible(world(d,hitPoint),e))return false;
  const close=d.faces.filter(f=>!f.solidId&&!deleted(d,f)).some(f=>[f.points,...(f.holes||[])].some(r=>r.some((p,i)=>{
   const a=host.screen(world(d,p),'3d'),b=host.screen(world(d,r[(i+1)%r.length]),'3d'),dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1e-8)return false;const t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l2));return Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy)<12;
  })));
  if(!close)return false;
  // An existing shared point may belong to the perpendicular neighbor's
  // graph. Mount that same world point on the preferred drawing plane.
  const local=p=>d.frame?W.inFrame(d.frame,p):({x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0});
  const plane=W.faceFrame({points:d.faces.find(f=>!f.solidId&&!deleted(d,f)).points.map(p=>world(d,p))});
  const candidates=sceneLines().points.filter(p=>Math.abs((p.x-plane.origin.x)*plane.n.x+(p.y-plane.origin.y)*plane.n.y+(p.z-plane.origin.z)*plane.n.z)<1e-5).map(p=>({p,q:host.screen(p,'3d')})).filter(({p,q})=>Math.hypot(q.x-e.clientX,q.y-e.clientY)<12&&d.faces.some(f=>!f.solidId&&!deleted(d,f)&&G.contains(f,local(p)))).sort((a,b)=>Math.hypot(a.q.x-e.clientX,a.q.y-e.clientY)-Math.hypot(b.q.x-e.clientX,b.q.y-e.clientY));
  if(candidates.length){const p=local(candidates[0].p);if(!d.sketch.nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y)<.0001))S.add(d,p,.0001);}
  activeDraftKey=draftKey(d);const w=walls().find(w=>d.members.includes(w.id));if(w)host.select(w.id);return true;
 }
 function doubleClick(e,w){
  if(tool?.kind==='arch'){placeArch(e);return finishArch();}
  if(workingPlane?.rotation)return true;if(workingPlane){if(viewOf(e)!=='3d')return false;if(quadFinish&&Date.now()-quadFinish.time<600&&Math.hypot(e.clientX-quadFinish.x,e.clientY-quadFinish.y)<6){quadFinish=null;return true;}if(workingPlane.action)return placePlaneAction(e);box=null;boxEl?.remove?.();boxEl=null;const q=planePoint(e);return q?planeEdit(window.ExteriorGeometry.world(workingPlane.frame,q)):true;}
  if(!viewOf(e))return false;mouse=e;
  if(quadFinish&&Date.now()-quadFinish.time<600&&Math.hypot(e.clientX-quadFinish.x,e.clientY-quadFinish.y)<6){quadFinish=null;return true;}
  if(tool?.kind==='material')return true;
  if(tool?.kind==='quad')return down(e,true);
  if(tool&&!finishToolForSwitch())return true;
  const before=copy(host.state().wallEdits||{});
  // Resolve the clicked face, including pasted/extruded surfaces, rather than
  // projecting onto whichever drawing plane happened to be active previously.
  transaction(()=>{
   const boundary=holdBoundary(e),ref=!boundary&&viewOf(e)==='3d'?placementHost(e,true):null;
   const fallback=!ref&&(boundary?current():w?ensure(w):current());
   if(!ref&&!fallback)throw Error('Double-click a visible face to place a point.');
   const d=ref?asDraft(ref).d:fallback,p=snap(d,e);
   if(!p)throw Error('Could not locate the point on this face.');
   draftSelection={};solidPoints=[];solidEdges=[];selectedBasePoints=[];pickedLines=[];lineSelection=[];selectedRegion=null;selectedSolid=null;
   activeDraftKey=draftKey(d);preferredDraft=activeDraftKey;preferredSolid=null;preferredRegion=null;
   host.select(walls().find(w=>d.members.includes(w.id))?.id||null);
   picked=[add(d,p)];
  },before);return true;
 }
 const pickVisible=(p,e)=>viewOf(e)!=='3d'||host.pickVisible?.(p,e)!==false;
 const pickLineVisible=(pair,e,t=.5)=>viewOf(e)!=='3d'||(host.pickLineVisible?host.pickLineVisible(pair,e):pickVisible({x:pair[0].x+(pair[1].x-pair[0].x)*t,y:pair[0].y+(pair[1].y-pair[0].y)*t,z:pair[0].z+(pair[1].z-pair[0].z)*t},e));
 function pickVisiblePoint(e){
  if(resoffitMode||tool||lineMode()||viewOf(e)!=='3d'||e.button!==0||['textured','rendered','match-textured'].includes(host.state()?.displayMode))return false;
  return withSelectionGeometry(()=>pickVisiblePointInScene(e));
 }
 function undraftedWallTopology(){return renderDerived('undrafted-wall-topology',()=>G.topology(walls().filter(w=>!Object.values(all()).some(d=>d.members.includes(w.id)))));}
 function pickVisiblePointInScene(e){
  const candidates=[];
  if(host.wallsVisible?.()!==false){
   for(const d of Object.values(all()))if(visibleDraft(d))for(const n of draftNodes(d))candidates.push({p:world(d,n),d,n});
   for(const n of wire().nodes.filter(n=>!n.curveSample))candidates.push({p:n,solid:n.id});
   const topology=undraftedWallTopology(),visible=new Set(topology.faces.flatMap(f=>f.pointIndices.map(i=>W.vertexKey(topology.points[i]))));
   for(const w of walls())if(!Object.values(all()).some(d=>d.members.includes(w.id)))for(const p of [...w.bottom,...w.top])if(!w.sourceId||visible.has(W.vertexKey(p)))candidates.push({p,w});
  }
  if(host.selectBaseEntities)for(const p of basePoints())candidates.push({p,base:true});
  let best=null,dist=12;for(const c of candidates){const q=host.screen(c.p,'3d'),r=Math.hypot(q.x-e.clientX,q.y-e.clientY);if(q.visible!==false&&r<dist&&pickVisible(c.p,e)){dist=r;best=c;}}
  if(!best)return false;
  if(e.ctrlKey||e.metaKey){beginBox(e,current());box.click=()=>{
   selectedSolid=null;selectedRegion=null;
   if(best.base&&!selectedWorldPoints().length){host.selectBaseEntities([best.p],[],true,true);return;}
   const matches=p=>distance3(p,best.p)<=window.ExteriorGeometry.CONTACT,d=current();
   if(d)draftSelection[draftKey(d)]=picked.slice();
   for(const [key,ids]of Object.entries(draftSelection)){const owner=all()[key];if(owner)draftSelection[key]=ids.filter(id=>!owner.sketch.nodes.some(n=>n.id===id&&matches(world(owner,n))));}
   picked=d?draftSelection[draftKey(d)]||[]:[];
   solidPoints=solidPoints.filter(id=>!wire().nodes.some(n=>n.id===id&&matches(n)));
   selectedBasePoints=selectedBasePoints.filter(id=>!basePoints().some(p=>W.vertexKey(p)===id&&matches(p)));
   const count=selectedWorldPoints().length;host.message(count+(count===1?' point selected':' points selected'));host.redraw();
  };return true;}
  if(e.shiftKey&&current())draftSelection[draftKey(current())]=picked.slice();
  // Keep a shared endpoint on the explicitly chosen drawing face, without
  // letting that face's boundary edge take precedence over the point.
  if(!best.base&&holdBoundary(e)){const d=current(),n=d&&draftNodes(d).find(n=>distance3(world(d,n),best.p)<.0001);if(n)best={p:best.p,d,n};}
  beginBox(e,current());box.click=()=>{
   const add=!!(e.shiftKey||e.ctrlKey||e.metaKey);
   selectedSolid=null;selectedRegion=null;
   if(best.base){if(add&&selectedWorldPoints().length){selectedBasePoints=[...new Set([...selectedBasePoints,W.vertexKey(best.p)])];host.message(selectedWorldPoints().length+' points selected');host.redraw();}else host.selectBaseEntities([best.p],[],add);return;}
   if(!add){draftSelection={};picked=[];solidPoints=[];selectedBasePoints=[];}
   pickedLines=[];solidEdges=[];lineSelection=[];selectedSolid=null;selectedRegion=null;
   if(best.solid){solidPoints=[...new Set([...solidPoints,best.solid])];(host.selectBox||host.select)(null);}
   else {const d=best.d||ensure(best.w),key=draftKey(d),n=best.n||draftNodes(d).find(n=>distance3(world(d,n),best.p)<.0001);if(!n)return;activeDraftKey=key;const ids=draftSelection[key]||[];draftSelection[key]=[...new Set([...(add?ids:[]),n.id])];picked=draftSelection[key];host.select(best.w?.id||walls().find(w=>d.members.includes(w.id))?.id||null);}
   const count=selectedWorldPoints().length;host.message(count+(count===1?' point selected':' points selected'));host.redraw();
  };return true;
 }
 function pickSolid(e,pointsOnly=false){
  // Shift extends an existing line selection; a face behind a missed edge is
  // not a replacement selection (nor is a nearby point).
  if(!tool&&e.shiftKey&&(lineSelection.length||pickedLines.length||solidEdges.length)&&viewOf(e)==='3d'){
   if(pickLine3D(e))return true;beginBox(e,current());return true;
  }
  if(pickVisiblePoint(e))return true;
  if(!tool&&e.button===0&&holdBoundary(e))return down(e,true);
  if(!tool&&e.button===0&&viewOf(e)==='3d'&&pickLine3D(e))return true;
  if(tool||!viewOf(e))return false;const graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),byId=id=>nodesById.get(id);let nearest=null,distance=12;
  if(lineMode()){for(const edge of graph.edges){const a=host.screen(byId(edge.a),viewOf(e)),b=host.screen(byId(edge.b),viewOf(e)),dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/(dx*dx+dy*dy))),dist=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);if(dist<distance&&pickLineVisible([byId(edge.a),byId(edge.b)],e,t)){distance=dist;nearest=edge.id;}}}
  else for(const n of graph.nodes.filter(n=>!n.curveSample)){const p=host.screen(n,viewOf(e)),dist=Math.hypot(p.x-e.clientX,p.y-e.clientY);if(dist<distance&&pickVisible(n,e)){distance=dist;nearest=n.id;}}
  if(nearest){beginBox(e,current());box.click=()=>{if(!e.shiftKey)draftSelection={};pickedLines=[];const list=lineMode()?solidEdges:solidPoints,next=e.shiftKey?(list.includes(nearest)?list.filter(id=>id!==nearest):[...list,nearest]):[nearest];solidPoints=lineMode()?[]:next;solidEdges=lineMode()?next:[];selectedSolid=null;selectedRegion=null;picked=[];const w=selected()||walls()[0];host.select(w?.id||null);host.redraw();};return true;}

  if(pointsOnly||!solidMeshes.length||viewOf(e)!=='3d')return false;
  const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);for(const m of solidMeshes)m.updateMatrixWorld(true);const hit=window.wallPreferredSurfaceHit(ray.intersectObjects(solidMeshes));if(!hit)return false;if(hit.object.userData.draftKey){const key=hit.object.userData.draftKey,d=all()[key],faceId=hit.object.userData.regionId;beginBox(e,d);box.click=()=>{const w=selected()||walls()[0];host.select(w?.id||null);activeDraftKey=key;selectRegion(d,e,null,faceId);};return true;}const solidId=hit.object.userData.solidId,w=selected()||walls()[0];beginBox(e,current());box.click=()=>{selectFaceRef({solid:solidId},e);draftSelection={};preferredSolid=solidId;preferredDraft=null;solidPoints=[];solidEdges=[];pickedLines=[];lineSelection=[];host.select(w?.id||null);picked=[];host.message(faceSelection.length+(faceSelection.length===1?' face selected':' faces selected'));host.redraw();};return true;
 }
 function regionSupports(d,region){return [...Object.values(all()).flatMap(other=>other.faces.filter(f=>f!==region&&!f.solidId&&!deleted(other,f)).map(f=>({points:f.points.map(p=>world(other,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(other,p)))}))),...solids().filter(f=>!f.deleted&&!f.drafted),...walls().filter(w=>!Object.values(all()).some(d=>d.members.includes(w.id))).map(w=>({points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]}))];}
 function sceneLines(){
  const priorWalls=renderWalls,priorSegments=renderSegments,priorSupport=supportSnapshot,priorIndex=supportIndex;
  renderWalls ||= host.walls();renderSegments ||= new Map();
  try{supportSnapshot ||= structuralFaces();supportIndex ||= W.structuralIndex(supportSnapshot);return collectSceneLines();}
  finally{renderWalls=priorWalls;renderSegments=priorSegments;supportSnapshot=priorSupport;supportIndex=priorIndex;}
 }
 function stickerSnapGeometry(graph,scene){
  const trims=scene.filter(f=>f.trim||f.feature?.type==='trim'),supports=scene.filter(f=>!f.trim&&f.feature?.type!=='trim'&&!f.deleted);
  const on=(p,faces)=>faces.some(f=>[f.points,...(f.holes||[])].some(r=>r.some((a,i)=>onSegment(p,a,r[(i+1)%r.length]))));
  const usable=p=>!on(p,trims)||on(p,supports);
  return {...graph,points:graph.points.filter(p=>!on(p,trims)||supports.some(f=>[f.points,...(f.holes||[])].flat().some(q=>distance3(p,q)<1e-5))),lines:new Map([...graph.lines].filter(([,pair])=>{const mid={x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2,z:(pair[0].z+pair[1].z)/2};return usable(mid);} ))};
 }
 function collectSceneLines(){
  const curveGroups=new Map(),graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),node=id=>nodesById.get(id),segments=graph.edges.map(e=>[node(e.a),node(e.b)]),points=graph.nodes.filter(n=>!n.curveSample);
  for(const e of graph.edges.filter(e=>e.curve)){if(!curveGroups.has(e.id))curveGroups.set(e.id,{id:e.id,surfaceId:e.surfaceId,pairs:[]});curveGroups.get(e.id).pairs.push([node(e.a),node(e.b)]);}
  for(const d of Object.values(all()))for(const e of draftSegments(d).filter(e=>e.curveId)){const id=draftKey(d)+':'+e.curveId;if(!curveGroups.has(id))curveGroups.set(id,{id,draftKey:draftKey(d),edgeId:e.id,edgeIds:[],pairs:[]});const group=curveGroups.get(id);if(!group.edgeIds.includes(e.id))group.edgeIds.push(e.id);group.pairs.push([world(d,e.start),world(d,e.end)]);}
  const base=host.state()?.wallEdits?.$base||host.state()?.base,baseSegments=[];if(base&&base.visible!==false){const sketch=S.read(base),nodes=new Map(sketch.nodes.map(n=>[n.id,n]));baseSegments.push(...S.curveEdges(sketch).map(e=>[e.start,e.end]).filter(pair=>pair.every(Boolean)));points.push(...sketch.nodes);segments.push(...baseSegments);}
  for(const d of Object.values(all()))if(visibleDraft(d)){segments.push(...draftSegments(d).map(e=>[world(d,e.start),world(d,e.end)]));points.push(...draftNodes(d).map(n=>world(d,n)));}
  const topology=undraftedWallTopology();points.push(...[...new Set(topology.faces.flatMap(f=>f.pointIndices))].map(i=>topology.points[i]));segments.push(...topology.connections.map(e=>[topology.points[e.startIdx],topology.points[e.endIdx]]));
  const pointIndex=W.pointRangeIndex(points),lines=new Map();for(const [a,b] of segments){const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz;if(l2<1e-12)continue;const ts=[0,1];for(const p of pointIndex.segment(a,b)){const t=((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2;if(t>1e-6&&t<1-1e-6&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy,p.z-a.z-t*dz)<1e-5)ts.push(t);}ts.sort((a,b)=>a-b);const at=t=>({x:a.x+dx*t,y:a.y+dy*t,z:a.z+dz*t});for(let i=1;i<ts.length;i++)if(ts[i]-ts[i-1]>1e-6){const pair=[at(ts[i-1]),at(ts[i])];lines.set(W.edgeKey(...pair),pair);}}
  return {points,lines,baseSegments,curveGroups};
 }
 function lineCenterPoints(){return withSelectionGeometry(()=>renderDerived('line-centers:'+JSON.stringify(workingPlane?.frame||null),buildLineCenterPoints));}
 function buildLineCenterPoints(){
  if(host.state()?.lineCenters===false)return [];
  const graph=sceneLines(),curves=[...graph.curveGroups.values()].flatMap(c=>c.pairs),base=host.state()?.wallEdits?.$base||host.state()?.base;
  if(base)curves.push(...S.curveEdges(S.read(base)).filter(e=>e.curveId).map(e=>[e.start,e.end]));
  const centers=new Map();for(const pair of graph.lines.values()){
   if(curves.some(c=>pair.every(p=>onSegment(p,...c))))continue;
   const p={x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2,z:(pair[0].z+pair[1].z)/2};
   if(workingPlane&&Math.abs(W.inFrame(workingPlane.frame,p).z)>.002)continue;
   centers.set(W.vertexKey(p),{...p,pair});
  }return [...centers.values()];
 }
 function drawLineCenters2D(rot,svg,inv){
  for(const p of lineCenterPoints()){
   const q=host.toPixel(p),a=host.toPixel(p.pair[0]),b=host.toPixel(p.pair[1]),dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<1e-8)continue;
   const x=-dy/length*6*inv,y=dx/length*6*inv;
   svg('line',{x1:q.x-x,y1:q.y-y,x2:q.x+x,y2:q.y+y,stroke:'#00FFFF','stroke-width':2*inv,opacity:.7,'data-line-center':'true','pointer-events':'none'},rot);
  }
 }
 function drawLineCenters3D(group,vector){
  const centers=lineCenterPoints();if(!centers.length)return;
  const geo=new THREE.BufferGeometry().setFromPoints(centers.map(vector)),ends=centers.flatMap(p=>{const q=vector(p.pair[1]);return [q.x,q.y,q.z];});
  geo.setAttribute('centerEnd',new THREE.Float32BufferAttribute(ends,3));
  const viewport={value:new THREE.Vector2(1,1)},material=new THREE.PointsMaterial({color:'#00FFFF',size:14,sizeAttenuation:false,depthTest:false,depthWrite:false,transparent:true,opacity:.7});
  // One batched screen-space tick per edge; camera movement updates orientation
  // in the shader without rebuilding geometry or creating selectable vertices.
  material.onBeforeCompile=shader=>{
   shader.uniforms.centerViewport=viewport;
   shader.vertexShader='attribute vec3 centerEnd; uniform vec2 centerViewport; varying vec2 centerDirection;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nvec4 endClip = projectionMatrix * modelViewMatrix * vec4(centerEnd, 1.0);\nvec2 edgeScreen = (endClip.xy / endClip.w - gl_Position.xy / gl_Position.w) * centerViewport;\ncenterDirection = length(edgeScreen) > 0.00001 ? normalize(edgeScreen) : vec2(1.0, 0.0);');
   shader.fragmentShader='varying vec2 centerDirection;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('void main() {','void main() { vec2 pixel = (gl_PointCoord - vec2(0.5)) * vec2(14.0, -14.0); if (abs(dot(pixel, centerDirection)) > 1.0 || abs(dot(pixel, vec2(-centerDirection.y, centerDirection.x))) > 6.0) discard;');
  };
  material.customProgramCacheKey=()=> 'wall-line-center-tick-v1';
  const marker=new THREE.Points(geo,material);marker.userData||={};marker.userData.lineCenters=true;
  marker.onBeforeRender=renderer=>{const r=renderer.domElement.getBoundingClientRect();viewport.value.set(r.width,r.height);};group.add(marker);
 }
 function heightPoints(){const state=host.state(),base=state.wallEdits?.$base||state.base;return [...(state.roof?.points||[]),...(base?.faces||[]).filter(f=>!f.deleted).flatMap(f=>[...f.points,...(f.holes||[]).flat(),...(f.retainedPoints||[])])];}
 function pickLine3D(e){return withSelectionGeometry(()=>pickLineInScene(e));}
 function pickLineInScene(e){let contacts;const soffits=()=>contacts ||= renderDerived('soffit-edges',()=>soffitEdges());const isSoffit=pair=>soffits().some(c=>W.sharedIntervals(...pair,[{points:c.pair}]).some(([a,b])=>b-a>.001));const dividerOnly=['textured','rendered','match-textured'].includes(host.state()?.displayMode)&&viewOf(e)==='3d',dividers=dividerOnly?indexDividers(divisionSeams()):null;
  // Resoffit highlights come from merged support outlines. Those edges need
  // not exist verbatim in the editable sketch (a turret can have split or
  // consumed return edges). Pick the same contact lines that we draw.
  const contactsScene=()=>({points:[],lines:new Map(soffits().map(c=>[c.id,c.pair])),baseSegments:[],curveGroups:new Map()});
  const scene=resoffitMode?contactsScene():sceneLines();
  if(!resoffitMode)scene.lines=new Map([...scene.lines,...soffits().map(c=>[c.id,c.pair])]);
  const {points,lines,baseSegments,curveGroups}=scene,screen=p=>host.screen(p,'3d'),valid=p=>p.visible!==false&&Number.isFinite(p.x)&&Number.isFinite(p.y);
  if(!resoffitMode&&!lineMode()&&points.some(p=>{const q=screen(p);return valid(q)&&Math.hypot(q.x-e.clientX,q.y-e.clientY)<12&&pickVisible(p,e);}))return false;
  let nearest=null,distance=10;for(const [id,pair]of lines){if(dividerOnly&&!resoffitMode&&!isDivisionPair(...pair,dividers))continue;if(host.wallsVisible?.()===false&&!baseSegments.some(edge=>W.sharedIntervals(...pair,[{points:edge}]).length))continue;const [a,b]=pair.map(screen);if(!valid(a)||!valid(b))continue;const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1)continue;const t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l2)),dist=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);if(dist<distance&&(pickLineVisible(pair,e,t)||((resoffitMode||isSoffit(pair))&&host.pickSoffitVisible?.(pair,e)))){distance=dist;nearest={id,pair};}}
  if(!nearest)return false;const curved=[...curveGroups.values()].find(g=>g.pairs.some(pair=>W.edgeKey(...pair)===W.edgeKey(...nearest.pair)));if(curved){nearest={...nearest,...curved};}const baseLine=baseSegments.some(pair=>W.sharedIntervals(...nearest.pair,[{points:pair}]).reduce((s,[a,b])=>s+b-a,0)>.99999);const wallLine=host.wallsVisible?.()!==false&&[...solids().filter(f=>!f.deleted&&!f.drafted),...Object.values(all()).flatMap(d=>d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)).map(f=>({points:f.points.map(p=>world(d,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(d,p)))}))),...walls().filter(w=>!Object.values(all()).some(d=>d.members.includes(w.id))).map(w=>({points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]}))].some(f=>W.sharedIntervals(...nearest.pair,[f]).some(([a,b])=>b-a>1e-6));beginBox(e,current());box.lineClick=true;box.click=()=>{mouse=e;const add=resoffitMode||e.ctrlKey||e.metaKey||e.shiftKey;if(nearest.draftKey){activeDraftKey=nearest.draftKey;pickedLines=nearest.edgeIds||[nearest.edgeId];picked=[];solidPoints=[];solidEdges=[];lineSelection=[];draftSelection={};selectedSolid=null;selectedRegion=null;host.message('1 curve selected');host.redraw();return;}if(baseLine&&!wallLine&&host.selectBaseEntities&&!lineSelection.some(l=>l.id===nearest.id)){lineSelection=[];host.selectBaseEntities([], [nearest.pair],add,!!(e.ctrlKey||e.metaKey));return;}lineSelection=e.ctrlKey||e.metaKey||resoffitMode&&lineSelection.some(l=>l.id===nearest.id)?lineSelection.filter(l=>l.id!==nearest.id):add?[...lineSelection.filter(l=>l.id!==nearest.id),nearest]:[nearest];draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];selectedRegion=null;selectedSolid=null;host.select(null);host.message(lineSelection.length+' lines selected');host.redraw();};return true;
 }
 function stepStatus(text){host.message(text);const button=typeof document!=='undefined'&&document.getElementById('wall-step');if(button)button.textContent=tool?.kind==='step'?'Auto-step: '+tool.count+' (S)':'Auto-step (S)';}
 function finishToolForSwitch(){
  flushPreview();const t=tool;if(!t)return true;if(t.kind==='divide'){finishDivision();return !tool;}if(t.kind==='trim')return finishTrim();if(t.kind==='arch')return finishArch();if(t.kind==='curve'){host.message('Finish the curve or press Escape before switching tools.');return false;}
  if(t.invalid||t.valid===false){host.message('The current preview is invalid. Adjust it or press Escape before switching tools.');return false;}
  if(t.kind==='geometryTransform')return placeGeometry();if(t.kind==='paste'){host.message('Place the copied geometry or press Escape before switching tools.');return false;}if(t.kind==='axisCut')return finishAxisCut();
  if(t.kind==='entityExtrude'){placeEntity(mouse);if(tool)return false;if(t.mode==='move')selectPlacedEntity(t,false);return true;}
  if(t.kind==='feature'){if(!t.preview){host.message('Place the sticker on a face or press Escape before switching tools.');return false;}placeFeature({...mouse,shiftKey:false});return !tool;}
  if(t.before){
   const changed=t.changed??(JSON.stringify(host.state().wallEdits)!==JSON.stringify(t.before));
   if(changed){try{window.ExteriorModel.validateEdits(host.state().wallEdits,t.before);host.commit(t.before);}catch(error){host.message(error.message);return false;}}
   else host.state().wallEdits=copy(t.before);
  }
  if(t.kind==='chamfer'){selectedSolid=t.additions?.[0]?.id||null;lineSelection=[];picked=[];pickedLines=[];solidPoints=[];solidEdges=[];}
  tool=null;clearGuides();host.redraw();return true;
 }
 function geometrySelectionPoints(external){
  if(external)return [...new Map([...(external.points||[]),...(external.edges||[]).flat()].map(p=>[W.vertexKey(p),p])).values()];
  if(workingPlane)return workingPlane.selection.slice();
  const d=current(),graph=wire(),points=selectedWorldPoints().concat(lineSelection.flatMap(l=>(l.pairs||[l.pair]).flat()));const sticker=featureSelection();if(selectedStickers().length>1||sticker?.solid?.feature||sticker?.f?.feature&&!sticker.d.faces.some(f=>f!==sticker.f&&!f.solidId&&!f.boundaryHole&&!deleted(sticker.d,f)))points.push(...selectedStickerPoints());const curved=solids().find(f=>f.id===selectedSolid&&f.curvedSurface?.logical);if(curved)points.push(...curved.points);
  for(const edge of graph.edges)if(solidEdges.includes(edge.id))points.push(...[edge.a,edge.b].map(id=>graph.nodes.find(n=>n.id===id)));
  if(d)for(const edge of d.sketch.edges)if(pickedLines.includes(edge.id)){points.push(...[edge.a,edge.b].map(id=>world(d,d.sketch.nodes.find(n=>n.id===id))));const c=d.sketch.curves?.find(c=>c.id===edge.curveId);if(c?.type==='spline')points.push(...c.controls.map(p=>world(d,p)));}
  return [...new Map(points.filter(Boolean).map(p=>[W.vertexKey(p),p])).values()];
 }
 // Keep plane sketches in their analytic graph during transforms. A face loop
 // is an evaluated boundary, not the control polygon for a drawn curve.
 function curveGeometrySelection(points){
  const base=host.state().wallEdits?.$base||host.state().base,owners=[...Object.entries(all()).map(([key,d])=>({key,d})),...(base?[{base:true,d:base}]:[])];
  for(const owner of owners){const {d}=owner,toWorld=p=>owner.base?p:world(d,p),nodes=d.sketch?.nodes||[],ids=points.map(p=>nodes.find(n=>distance3(toWorld(n),p)<1e-5)?.id);if(!ids.length||ids.some(id=>!id))continue;
   const selected=new Set(ids),curves=(d.sketch.curves||[]).filter(c=>{const edges=d.sketch.edges.filter(e=>e.curveId===c.id);return edges.length&&(edges.every(e=>selected.has(e.a)&&selected.has(e.b))||points.length===1&&c.type==='spline'&&c.controls.some(p=>distance3(toWorld(p),points[0])<1e-5));});if(!curves.length)continue;
   // A connected unselected arc must continue to share its endpoint.
   if(d.sketch.edges.some(e=>e.curveId&&!curves.some(c=>c.id===e.curveId)&&(selected.has(e.a)||selected.has(e.b))))continue;
   const controls=nodes.filter(n=>selected.has(n.id));if(controls.some(n=>n.fixed)&&!(points.length===1&&curves.every(c=>c.type==='spline')))continue;const frame=owner.base?W.faceFrame(d.faces[0]):d.frame||W.faceFrame({points:d.sketch.outlines[0].map(toWorld)}),clip={points:controls.map(toWorld),edges:[],faces:[],curves:curves.map(c=>window.ExteriorGeometry.mapCurve(c,toWorld)),mounts:[{frame:W.clipboardFrame(geometryCenter({points:controls.map(toWorld)}),frame.n),count:controls.length}]};
   const snapTargets={points:nodes.filter(n=>!selected.has(n.id)&&!n.curveSample).map(toWorld),edges:d.sketch.edges.filter(e=>!e.curveId&&!selected.has(e.a)&&!selected.has(e.b)).map(e=>[e.a,e.b].map(id=>toWorld(nodes.find(n=>n.id===id))))};
   return {...owner,ids:controls.map(n=>n.id),clip,snapTargets};
  }
 }
 function applyCurveGeometry(t,candidate){const edits=copy(t.prepared),owner=t.curveOwner,d=owner.base?copy(t.base):edits.$drafts[owner.key],local=p=>owner.base?p:toLocal(d,p),curves=candidate.curves.map(c=>{if(t.original.points.length!==1||c.type!=='spline')return window.ExteriorGeometry.mapCurve(c,local);const prior=t.original.curves.find(v=>v.id===c.id),ps=prior.controls.map(p=>distance3(p,t.original.points[0])<1e-5?candidate.points[0]:p);return window.ExteriorGeometry.mapCurve({...prior,...window.ExteriorGeometry.splineThrough([ps[0],ps.at(-1)],ps.slice(1,-1))},local);});
  S.updateCurves(d,curves,owner.ids.map((id,i)=>({id,point:local(candidate.points[i])})));if(owner.base)edits.$base=d;else classify(d);
  if(edits.$loose){const move=p=>{const i=t.original.points.findIndex(q=>distance3(p,q)<window.ExteriorGeometry.CONTACT);return i<0?p:{...p,...candidate.points[i]};};edits.$loose.points=edits.$loose.points.map(move);edits.$loose.edges=edits.$loose.edges.map(pair=>pair.map(move));}
  window.ExteriorModel.validateEdits(edits,t.before);return edits;
 }
 function geometryCenter(clip){return clip.points.reduce((a,p)=>({x:a.x+p.x/clip.points.length,y:a.y+p.y/clip.points.length,z:a.z+p.z/clip.points.length}),{x:0,y:0,z:0});}
 function constrainPlaneClip(clip){if(workingPlane)clip.mounts=[{frame:{...copy(workingPlane.frame),origin:geometryCenter(clip)},count:clip.points.length}];return clip;}
 function geometryStatus(){const t=tool;if(workingPlane){host.message(({m:'Move',r:'Rotate',f:'Flip '+(t.flipAxis||'original'),y:'Resize '+(t.resizeAxis||'all')}[t.editMode]||'Edit')+' on drawing plane · M / R / T / Y switches tool; T cycles flip; click or Enter places; Escape restores.');return;}if(t.stickerMove&&t.editMode==='m'){host.message(['Free on face','Left/Right','Up/Down','In/Out'][t.moveAxis||0]+' · M switches direction; click to place; Escape restores.');return;}host.message(({m:'Move on plane',r:'Rotate',f:'Flip '+(t.flipAxis==='y'?'vertical':t.flipAxis==='x'?'horizontal':'original'),y:'Resize '+(t.resizeAxis||'all').toUpperCase()}[t.editMode]||'Move')+' · Plane '+(t.mount+1)+' / '+t.clip.mounts.length+' · '+(t.editMode==='f'?'T cycles vertical / horizontal / original on this plane; X/V chooses flip. ':t.editMode==='r'?'Move around the center; snapping catches 45° increments. ':'')+'M / R / T / Y switches tool; repeat M/R/Y cycles plane; click places; Escape restores.');}
 function geometryCommand(mode,external){
  if(mode==='t')mode='f';
  if(tool?.kind==='paste'||tool?.kind==='geometryTransform'){
   const t=tool,cycle=t.editMode===mode,resetMove=t.kind==='geometryTransform'&&cycle&&mode==='m';if(t.invalid&&!resetMove){host.message('Adjust this preview or press Escape before switching.');return true;}
   if(resetMove&&(workingPlane||!t.stickerMove&&t.clip.mounts.length===1))return true;
   if(cycle&&mode==='f'){t.flipAxis=t.flipAxis==='y'?'x':t.flipAxis==='x'?null:'y';t.startEvent=mouse;previewGeometry(mouse,true);return true;}
   if(resetMove){host.state().wallEdits=copy(t.prepared);t.clip=copy(t.original);t.preview=copy(t.original);t.changed=false;t.invalid=false;t.valid=true;clearGuides();}
   else if(t.kind==='geometryTransform')t.clip=copy(t.preview||t.clip);
   if(cycle&&mode==='m'&&t.stickerMove&&!workingPlane)t.moveAxis=((t.moveAxis||0)+1)%4;else if(cycle&&!workingPlane)t.mount=(t.mount+1)%t.clip.mounts.length;
   t.numeric=null;t.inputToken={};t.rotationCenter=t.kind==='paste'&&t.preview?geometryCenter(t.preview):geometryCenter(t.clip);t.moveAnchor=t.kind==='paste'&&mode==='m'&&!cycle&&t.anchor?{...t.anchor,start:mouse&&rayPoint({frame:W.faceFrame(t.anchor.target)},mouse)}:null;if(mode==='y'&&t.editMode!=='y')t.resizeAxis='all';t.editMode=mode;t.stage=copy(t.clip);t.flipAxis='y';t.startEvent=mouse;
   t.inputFrame=t.kind==='paste'?t.anchor&&(workingPlane?{...copy(workingPlane.frame),origin:copy(t.anchor.location)}:W.clipboardFrame(t.anchor.location,t.anchor.normal)):{...t.clip.mounts[t.mount].frame,origin:geometryCenter(t.clip)};
   if(t.inputFrame&&mouse)t.startPoint=rayPoint({frame:t.inputFrame},mouse);
   if(mode==='f')previewGeometry(mouse,true);else if(t.kind==='paste'&&mouse&&cycle)previewPaste(mouse);
   geometryStatus();showResizeAxes();if(resetMove)host.redraw();return true;
  }
  if(tool)return false;
  if(external?.event)mouse=external.event;const points=geometrySelectionPoints(external);if(points.length<(workingPlane?1:3))return false;
  const before=copy(host.state().wallEdits||{});
  try{const curveOwner=curveGeometrySelection(points);if(curveOwner){const clip=constrainPlaneClip(curveOwner.clip);tool={kind:'geometryTransform',curveOwner:{key:curveOwner.key,base:curveOwner.base,ids:curveOwner.ids},snapTargets:curveOwner.snapTargets,before,prepared:copy(host.state().wallEdits),base:copy(host.state().wallEdits.$base||host.state().base),scene:[],original:copy(clip),clip,preview:copy(clip),mount:0,op:Date.now(),valid:true};geometryCommand(mode);return true;}
   const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),base=host.state().wallEdits.$base||host.state().base;if(base&&(external||selectedBasePoints.length||workingPlane))scene.push(...base.faces.map(f=>({...f,baseId:f.id,id:'base:'+f.id})));
   const snapScene=workingPlane?{points:planeScene().points,lines:new Map(planeScene().lines.map((p,i)=>[i,p]))}:sceneLines(),clip=constrainPlaneClip(W.copyGeometry(scene,points,[...snapScene.lines.values()])),selected=p=>clip.points.some(q=>distance3(p,q)<=window.ExteriorGeometry.CONTACT);const snapTargets={points:snapScene.points.filter(p=>!selected(p)),edges:[...snapScene.lines.values()].filter(pair=>pair.every(p=>!selected(p)))};
   const stickerMove=clip.faces.length>0&&clip.faces.every(f=>f.feature);if(stickerMove){const filtered=stickerSnapGeometry({points:snapTargets.points,lines:new Map(snapTargets.edges.map((pair,i)=>[i,pair]))},scene);snapTargets.points=filtered.points;snapTargets.edges=[...filtered.lines.values()];}
   tool={kind:'geometryTransform',stickerMove,snapTargets,before,prepared:copy(host.state().wallEdits),base:copy(base),scene:copy(scene),original:copy(clip),clip,preview:copy(clip),mount:0,op:Date.now(),valid:true};
   geometryCommand(mode);return true;
  }catch(error){host.state().wallEdits=before;host.message(error.message);return true;}
 }
 function constrainStickerMove(t,delta){
  if(!t.stickerMove||!t.moveAxis)return delta;
  const frame=t.stage.mounts[t.mount].frame,view=F.viewFrame(t.stage.faces[0].points,p=>host.screen(p,'3d')),axis=t.moveAxis===1?view.u:view.v;
  const x=axis.x*frame.u.x+axis.y*frame.u.y+axis.z*frame.u.z,y=axis.x*frame.v.x+axis.y*frame.v.y+axis.z*frame.v.z,amount=delta.x*x+delta.y*y;
  return {x:amount*x,y:amount*y};
 }
 function previewGeometry(...args){if(!window.ExteriorPerf?.enabled)return perf_previewGeometry.apply(this,args);return window.ExteriorPerf.measure('Geometry move preview',()=>perf_previewGeometry.apply(this,args));}
function perf_previewGeometry(e,keepAxis=false,translation=null){
  const t=tool;if(!t||!['paste','geometryTransform'].includes(t.kind)||!t.stage||!e||!t.inputFrame)return;
  if(e.buttons&6){t.reanchor=true;return;}
  if(t.reanchor){t.reanchor=false;if(t.kind==='geometryTransform')t.clip=copy(t.preview);t.stage=copy(t.clip);t.startEvent=e;t.startPoint=rayPoint({frame:t.inputFrame},e);return;}
  const normalMove=t.stickerMove&&t.editMode==='m'&&t.moveAxis===3;const q=translation||normalMove?{x:0,y:0}:rayPoint({frame:t.inputFrame},e),start=translation||normalMove?{x:0,y:0}:t.startPoint;if(!q||!start)return;
  const change={freezeMounts:t.kind==='paste'||!!workingPlane};
  if(t.editMode==='m')change.delta=normalMove?{x:0,y:0,z:t.numeric??W.dragAmount(extrudeAxis(t.stage.faces[0]),e.clientX-t.startEvent.clientX,e.clientY-t.startEvent.clientY)}:translation||constrainStickerMove(t,{x:q.x-start.x,y:q.y-start.y});
  if(workingPlane&&t.editMode==='m'&&t.numeric!=null){const d=change.delta,l=Math.hypot(d.x,d.y);change.delta={x:t.numeric*(l?d.x/l:1),y:t.numeric*(l?d.y/l:0)};}
  if(t.stickerMove&&t.editMode==='m'&&!normalMove&&t.numeric!=null){const frame=t.stage.mounts[t.mount].frame,view=F.viewFrame(t.stage.faces[0].points,p=>host.screen(p,'3d')),axis=t.moveAxis===2?view.v:view.u;change.delta={x:t.numeric*planeDot(axis,frame.u),y:t.numeric*planeDot(axis,frame.v)};}
  if(t.editMode==='r'){
   const center=t.rotationCenter||geometryCenter(t.stage),c=window.ExteriorGeometry.local(t.inputFrame,center);
   change.angle=Math.atan2(q.y-c.y,q.x-c.x)-Math.atan2(start.y-c.y,start.x-c.x);
   if(Math.hypot(start.x-c.x,start.y-c.y)<.001)change.angle=(e.clientX-t.startEvent.clientX)*Math.PI/180;
   if(!(typeof isFreeMove!=='undefined'&&isFreeMove)){const snap=Math.round(change.angle/(Math.PI/4))*Math.PI/4;if(Math.abs(snap-change.angle)<5*Math.PI/180||e.shiftKey)change.angle=snap;}
   if(workingPlane&&t.numeric!=null)change.angle=t.numeric*Math.PI/180;
  }
  if(t.editMode==='f')change.flip=t.flipAxis;
  let preview;if(t.editMode==='y'){let factor=Math.exp((e.clientX-t.startEvent.clientX-(e.clientY-t.startEvent.clientY))/160);factor=Math.max(.01,Math.min(100,factor));if(!(typeof isFreeMove!=='undefined'&&isFreeMove)){let targets=t.snapTargets,screen=p=>host.screen(p,'3d');if(t.kind==='paste'&&t.anchor){const src=t.stage.mounts[t.mount].frame,dst=workingPlane?{...workingPlane.frame,origin:t.anchor.location}:W.clipboardFrame(t.anchor.location,t.anchor.normal),toSource=p=>window.ExteriorGeometry.world(src,window.ExteriorGeometry.local(dst,p)),toWorld=p=>window.ExteriorGeometry.world(dst,window.ExteriorGeometry.local(src,p)),scene=sceneLines();targets={points:scene.points.map(toSource),edges:[...scene.lines.values()].map(r=>r.map(toSource))};screen=p=>host.screen(toWorld(p),'3d');}if(targets)factor=W.snapGeometryScale(t.stage,t.mount,factor,t.resizeAxis||'all',targets.points,targets.edges,screen);}t.scaleFactor=factor;preview=W.geometryScale(t.stage,t.mount,factor,t.resizeAxis||'all');}else preview=W.transformGeometry(t.stage,t.mount,change);if(t.kind==='geometryTransform'&&t.editMode==='m'&&!normalMove&&t.numeric==null&&!translation&&!(typeof isFreeMove!=='undefined'&&isFreeMove))preview=W.snapGeometryOnPlane(preview,t.mount,[...t.snapTargets.points,...(t.stickerMove?W.stickerAlignmentTargets(t.scene,t.stage.mounts[t.mount].frame,t.original.points):[])],t.snapTargets.edges,p=>host.screen(p,'3d'),10,t.stickerMove?window.ExteriorGeometry.world(t.inputFrame,q):null,workingPlane?.tolerance);
  if(t.kind==='geometryTransform'&&t.editMode==='m'&&!normalMove&&!workingPlane){
   if(t.stickerMove&&t.moveAxis&&!translation){const frame=t.stage.mounts[t.mount].frame,K=window.ExteriorGeometry,a=K.local(frame,t.stage.points[0]),b=K.local(frame,preview.points[0]);preview=W.transformGeometry(t.stage,t.mount,{delta:constrainStickerMove(t,{x:b.x-a.x,y:b.y-a.y})});}
   const frame=t.stage.mounts[t.mount].frame,K=window.ExteriorGeometry,contacts=t.stage.points.map(p=>K.local(frame,p)).filter(p=>Math.abs(p.z)<K.CONTACT),selected=p=>t.original.points.some(q=>distance3(p,q)<K.CONTACT),regions=t.scene.filter(f=>!f.points.every(selected)&&f.points.every(p=>Math.abs(K.local(frame,p).z)<K.CONTACT)).map(f=>({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).filter(r=>!r.every(selected)).map(r=>r.map(p=>K.local(frame,p)))}));
   if(contacts.length&&regions.length){const a=K.local(frame,t.stage.points[0]),z=K.local(frame,preview.points[0]),fit=W.boundedTranslation(contacts,regions,{x:z.x-a.x,y:z.y-a.y});if(fit)preview=W.transformGeometry(t.stage,t.mount,{delta:fit});}
  }
  if(t.kind==='paste'){t.clip=preview;previewPaste(e);return;}
  const previous=host.state().wallEdits;
  const build=candidate=>{if(t.curveOwner)return applyCurveGeometry(t,candidate);const edits=copy(t.prepared),result=W.transformSelection(t.scene,t.original,candidate,{keepTrimStatic:host.state()?.keepTrimStatic===true});applyLineResult(t,result,edits);window.ExteriorModel.validateEdits(edits,t.before);return edits;};
  try{let edits;try{edits=build(preview);}catch(error){
   if(t.editMode!=='m'||normalMove)throw error;
   const K=window.ExteriorGeometry,frame=t.stage.mounts[t.mount].frame,a=K.local(frame,t.stage.points[0]),b=K.local(frame,preview.points[0]);
   const fit=W.validTranslation({x:b.x-a.x,y:b.y-a.y},delta=>{try{build(W.transformGeometry(t.stage,t.mount,{delta}));return true;}catch{return false;}});
   if(!fit)throw error;preview=W.transformGeometry(t.stage,t.mount,{delta:fit});edits=build(preview);
  }host.state().wallEdits=edits;t.preview=preview;t.invalid=false;t.valid=true;t.changed=t.original.points.some((p,i)=>distance3(p,preview.points[i])>1e-7);geometryStatus();}
  catch(error){host.state().wallEdits=previous;t.invalid=true;t.valid=false;host.message(error.message+' Adjust the preview or press Escape.');}
  host.redraw();
 }
 function placeGeometry(){const t=tool;if(t?.kind!=='geometryTransform'||t.invalid)return true;try{if(t.changed)host.commit(t.before);else host.state().wallEdits=copy(t.before);tool=null;if(workingPlane){workingPlane.selection=copy(t.preview.points);workingPlane.selectedLines=[];workingPlane.selectedFaces=[];refreshPlane();}draftSelection={};picked=[];pickedLines=[];lineSelection=[];selectedBasePoints=[];selectedRegion=null;selectedSolid=null;solidPoints=t.preview.points.map(W.vertexKey);solidEdges=[];if(t.curveOwner){if(t.curveOwner.base){selectedBasePoints=solidPoints;solidPoints=[];}else{activeDraftKey=t.curveOwner.key;picked=t.curveOwner.ids.slice();draftSelection={[activeDraftKey]:picked.slice()};solidPoints=[];}}clearGuides();host.message('Geometry placed.');host.redraw();}catch(error){host.message(error.message);}return true;}
 function resizeAxis(axis){const t=tool;if(!t||t.editMode!=='y'||t.invalid)return;if(t.kind==='geometryTransform')t.clip=copy(t.preview||t.clip);t.stage=copy(t.clip);t.resizeAxis=axis;t.startEvent=mouse;t.startPoint=mouse&&t.inputFrame?rayPoint({frame:t.inputFrame},mouse):null;t.scaleFactor=1;geometryStatus();showResizeAxes();}
 function showResizeAxes(){const t=tool;if(t?.editMode!=='y'||typeof document==='undefined'||!document.body?.appendChild)return;
  if(t.resizeHud){for(const button of t.resizeHud.querySelectorAll('button')){const selected=button.dataset.axis===t.resizeAxis;button.setAttribute('aria-pressed',String(selected));button.style.background=selected?'#347b99':'#26343d';}return;}
  const panel=document.createElement('div');panel.className='exterior-sticker-bar geometry-resize-hud';panel.setAttribute('aria-label','Resize axes relative to reference face');panel.style.cssText='position:fixed;width:144px;height:112px;z-index:10020;background:#17232eef;border:1px solid #657985;border-radius:10px;box-shadow:0 6px 20px #0006;font:12px system-ui;';
  panel.innerHTML='<svg width="144" height="112" style="position:absolute;pointer-events:none"><path d="M70 74 L112 74 M70 74 L70 26 M70 74 L34 44" fill="none" stroke="#90b1c4" stroke-width="2"/></svg>';
  for(const [axis,x,y]of [['all',8,78],['x',108,61],['y',56,8],...(!workingPlane?[['z',16,25]]:[])]){const button=document.createElement('button');button.textContent=axis.toUpperCase();button.dataset.axis=axis;button.title={all:'Resize all axes',x:'Width',y:'Height',z:'Depth from mounting face'}[axis];button.style.cssText='position:absolute;left:'+x+'px;top:'+y+'px;border:1px solid #8ba9b9;border-radius:5px;color:white;min-width:28px;height:27px;cursor:pointer;';button.onclick=e=>{e.preventDefault();e.stopPropagation();resizeAxis(axis);};panel.appendChild(button);}
  for(const event of ['pointerdown','mousedown','dblclick'])panel.addEventListener(event,e=>e.stopPropagation());panel.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();e.stopPropagation();const axes=workingPlane?['all','x','y']:['all','x','y','z'];resizeAxis(axes[(axes.indexOf(t.resizeAxis||'all')+(e.deltaY>0?1:axes.length-1))%axes.length]);},{passive:false});document.body.appendChild(panel);t.resizeHud=panel;showResizeAxes();
  const layout=()=>{if(tool!==t||t.editMode!=='y'){panel.remove();delete t.resizeHud;return;}const preview=t.preview||t.clip,ps=preview.points.map(p=>host.screen(p,'3d')).filter(p=>p.visible!==false),view=document.getElementById('three-view-wrapper')?.getBoundingClientRect();if(view&&ps.length){const anchor={x:Math.max(...ps.map(p=>p.x)),y:Math.min(...ps.map(p=>p.y))-160},segments=preview.edges.map(r=>r.map(p=>host.screen(p,'3d'))),at=window.wallChamferLabelPosition(anchor,144,112,view,segments);panel.style.left=at.x+'px';panel.style.top=at.y+'px';}requestAnimationFrame(layout);};requestAnimationFrame(layout);
 }
 function geometryKey(e){const k=e.key.toLowerCase(),t=tool;if(k==='t'&&!e.ctrlKey&&!e.metaKey&&t.kind==='paste'&&t.clip.faces.length&&t.clip.faces.every(f=>f.feature)){if(!e.repeat){for(const clip of [t.clip,t.stage].filter(Boolean))for(const f of clip.faces)f.feature=nextStickerTrim(f.feature);previewPaste(mouse);}return true;}if(k==='f'&&!e.ctrlKey&&!e.metaKey){if(!e.repeat&&typeof isFreeMove!=='undefined'){isFreeMove=!isFreeMove;previewGeometry(mouse,true);}return true;}if(!e.ctrlKey&&!e.metaKey&&['m','r','t','y'].includes(k)){if(!e.repeat)geometryCommand(k);return true;}if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){host.state().wallEdits=copy(t.before);tool=null;clearGuides();host.redraw();return true;}if(k==='enter')return t.kind==='paste'?placePaste(mouse):placeGeometry();if(t.editMode==='f'&&['x','v'].includes(k)){t.flipAxis=k==='v'?'y':'x';previewGeometry(mouse,true);return true;}return !['shift','control','alt','meta'].includes(k);}
 function selectedFaces(){
  const faces=[];
  for(const ref of selectedFaceRefs()){
   const d=ref.solid?null:all()[ref.draft],f=ref.solid?solids().find(f=>f.id===ref.solid&&!f.deleted&&!f.drafted):d?.faces.find(f=>f.id===ref.face&&!f.solidId&&!deleted(d,f));
   if(f&&!f.boundaryHole)faces.push({d,f});
  }
  return faces;
 }
 function selectedStickers(){return selectedFaces().filter(({f})=>f.feature);}
 function selectedStickerPoints(){
  const points=[];
  for(const {d,f} of selectedStickers()){
   const vertices=[f.points,...(f.holes||[]),f.retainedPoints||[]].flat();
   points.push(...vertices.map(p=>d?world(d,p):p));
  }
  return [...new Map(points.map(p=>[W.vertexKey(p),p])).values()];
 }
 function clipboardCommand(kind,external){
  if(kind==='copy'){
   if(tool&&!finishToolForSwitch())return true;const selected=external?geometrySelectionPoints(external):(workingPlane?workingPlane.selection:[...geometrySelectionPoints(),...selectedStickerPoints()]),before=copy(host.state().wallEdits||{});
   try{const scene=moveScene().filter(f=>!f.snapOnly),base=host.state().wallEdits.$base||host.state().base;if(base)scene.push(...base.faces.map(f=>({...f,id:'base:'+f.id})));// A selected sticker owns its face, not every wall patch sharing its corners.
   const chosen=external||workingPlane?[]:selectedFaces(),stickerFaces=chosen.length&&chosen.every(({f})=>f.feature)?chosen.map(({d,f})=>d?engineFace(d,f):f):null;
   window.exteriorGeometryClipboard=stickerFaces?W.copyGeometry(stickerFaces,selectedStickerPoints()):W.copyGeometry(scene,selected,[...sceneLines().lines.values()]);const c=window.exteriorGeometryClipboard;if(workingPlane)constrainPlaneClip(c);const curves=selected.length>1?curveGeometrySelection(selected):null;if(curves&&!c.faces.length){const edges=c.edges.filter(pair=>!curves.clip.curves.some(curve=>{const ps=window.ExteriorGeometry.curveSamples(curve);return ps.slice(1).some((p,i)=>pair.every(q=>onSegment(q,ps[i],p)));}));Object.assign(c,copy(curves.clip),{edges});if(workingPlane)constrainPlaneClip(c);}host.message('Copied '+c.points.length+' points, '+c.edges.length+' lines and '+c.faces.length+' faces.');}catch(e){host.message(e.message);}finally{host.state().wallEdits=before;host.redraw();}return true;
  }
  const clip=window.exteriorGeometryClipboard;if(!clip){host.message('Copy some geometry first.');return true;}if(tool&&!finishToolForSwitch())return true;
  tool={kind:'paste',editMode:'m',clip:copy(clip),mount:0,before:copy(host.state().wallEdits||{}),preview:null,valid:false,op:Date.now()};host.message('Paste: hover a face; Ctrl+wheel changes mounting plane; click places; Escape cancels.');if(mouse)previewPaste(mouse);const activePaste=tool;let lastCamera='';const followCamera=()=>{if(tool!==activePaste)return;const next=[...(camera.matrixWorld?.elements||[]),...(camera.projectionMatrix?.elements||[])].join(',');if(next!==lastCamera&&mouse){lastCamera=next;previewPaste(mouse);}requestAnimationFrame(followCamera);};requestAnimationFrame(followCamera);return true;
 }
 function previewPaste(...args){if(!window.ExteriorPerf?.enabled)return perf_previewPaste.apply(this,args);return window.ExteriorPerf.measure('Paste preview',()=>perf_previewPaste.apply(this,args));}
function perf_previewPaste(e){if(tool?.kind!=='paste'||!e||viewOf(e)!=='3d')return;const t=tool;t.preview=null;t.valid=false;
  if(workingPlane){
   const K=window.ExteriorGeometry,frame=workingPlane.frame,q=rayPoint({frame},e);if(!q)return;
   const target={points:[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>K.world(frame,{x,y,z:0}))},location=t.editMode!=='m'&&t.anchor?t.anchor.location:K.world(frame,{...q,z:0});
   t.anchor={target,location,normal:frame.n,ref:{points:target.points}};t.ref=t.anchor.ref;
   t.preview=W.pasteGeometry(t.clip,t.mount,target,location,{frame,unbounded:true,bound:false,screen:p=>host.screen(p,'3d'),points:planeScene().points,snap:t.editMode==='m'&&!(typeof isFreeMove!=='undefined'&&isFreeMove)});t.valid=true;t.anchor.location=t.preview.location;geometryStatus();host.redraw();return;
  }
  try{let anchor=t.editMode!=='m'&&t.anchor;
   if(!anchor){const ref=host.pasteHost?.(e)||placementHost(e)||t.anchor?.ref;if(!ref){host.message('Hover a face to place copied geometry.');host.redraw();return;}const target={points:ref.points,holes:ref.d?(ref.f.holes||[]).map(r=>r.map(p=>world(ref.d,p))):(ref.solid?.holes||ref.f?.holes||[])},n=W.normal(target.points),sign=inwardDistanceSign(target),normal={x:-n.x*sign,y:-n.y*sign,z:-n.z*sign},frame=W.faceFrame(target),local=rayPoint({frame},e);if(!local)return;let location=W.fromFrame(frame,local);const move=t.moveAnchor,same=move&&(move.ref.solid?.id?move.ref.solid.id===ref.solid?.id:move.ref.d?move.ref.d===ref.d&&move.ref.f?.id===ref.f?.id:move.ref.f?.id===ref.f?.id);if(same&&move.start){const a=W.fromFrame(frame,move.start);location={x:move.location.x+location.x-a.x,y:move.location.y+location.y-a.y,z:move.location.z+location.z-a.z};}anchor={ref,target,normal,location,preservePosition:same&&distance3(location,move.location)<1e-7};}
   t.anchor=anchor;const {ref,target,location,normal}=anchor;
   const stickers=t.clip.faces.length&&t.clip.faces.every(f=>f.feature);t.preview=W.pasteGeometry(t.clip,t.mount,target,location,{normal,bound:!stickers&&t.editMode==='m',screen:p=>host.screen(p,'3d'),points:[...target.points,...sceneLines().points],stickerFaces:t.clip.faces.length&&t.clip.faces.every(f=>f.feature)?moveScene():[],snap:!stickers&&t.editMode==='m'&&!anchor.preservePosition&&!(typeof isFreeMove!=='undefined'&&isFreeMove)});if(stickers){const placed=stickerPlacement(ref,t.preview.faces,t.editMode==='m'&&!anchor.preservePosition),move=placed.move;t.preview={...t.preview,faces:placed.faces,points:t.preview.points.map(move),edges:t.preview.edges.map(r=>r.map(move)),location:move(t.preview.location),valid:true,guides:W.planeAlignmentGuides(placed.faces.flatMap(f=>f.points),placed.alignmentTargets,placed.frame)};}t.valid=t.preview.valid;t.ref=ref;if(t.preview.valid&&t.preview.location)t.anchor.location=t.preview.location;
   if(t.valid){geometryStatus();host.message('Mount '+(t.mount+1)+' / '+t.clip.mounts.length+' · '+(t.preview.snap?'Snapped · ':'')+({m:'Move',r:'Rotate',f:'Flip '+(t.flipAxis==='y'?'vertical':t.flipAxis==='x'?'horizontal':'original'),y:'Resize '+(t.resizeAxis||'all').toUpperCase()}[t.editMode])+' · M / R / T / Y; repeat M/R/Y cycles plane; T cycles vertical / horizontal / original. '+(t.editMode==='f'?'X/V: horizontal/vertical. ':'')+'Click to place; Escape cancels.');}else host.message('Mount extends outside this face. Move or rotate to fit.');
  }catch(e){host.message(e.message);}host.redraw();
 }
 function placePaste(e){previewPaste(e);const t=tool;if(!t?.valid||!t.preview)return true;try{const edits=host.state().wallEdits||={},preview=t.preview,prefix='paste-'+t.op;
   if(!workingPlane&&preview.faces.length&&preview.faces.every(f=>f.feature)){installStickers(t.ref,preview.faces);window.ExteriorModel.validateEdits(edits,t.before);host.commit(t.before);tool=null;clearGuides();host.message('Stickers placed. T cycles trim for the selected group.');host.redraw();return true;}
   const faces=F.remapDivisionGroups(preview.faces).map((f,i)=>({...f,id:prefix+'-'+i}));edits.$surfaces=[...(edits.$surfaces||[]),...faces];
   const covered=p=>faces.some(f=>[f.points,...f.holes].flat().some(q=>distance3(p,q)<1e-5)),edgeCovered=pair=>faces.some(f=>W.sharedIntervals(...pair,[f]).reduce((s,[a,b])=>s+b-a,0)>.99999);
   const loose=edits.$loose||={points:[],edges:[]};loose.points.push(...preview.points.filter(p=>!covered(p)));loose.edges.push(...preview.edges.filter(pair=>!edgeCovered(pair)));
   if(preview.curves?.length){const frame=copy(workingPlane?.frame||W.faceFrame({points:t.ref.points})),drafts=edits.$drafts||={},d=drafts[prefix+'-curves']={constructionPlane:true,frame,members:[],faces:[],sketch:{version:2,next:0,nodes:[],edges:[],outlines:[]}};for(const curve of preview.curves){const c=window.ExteriorGeometry.mapCurve(curve,p=>window.ExteriorGeometry.local(frame,p));delete c.id;S.addCurve(d,c);}}
   if(!t.ref.d&&t.ref.solid&&faces.some(f=>f.points.every(p=>Math.abs(window.ExteriorGeometry.local(W.faceFrame({points:t.ref.points}),p).z)<1e-5)))t.ref=asDraft(t.ref);
   if(t.ref.d){const d=t.ref.d,planar=faces.filter(f=>f.points.every(p=>Math.abs(window.ExteriorGeometry.local(W.faceFrame({points:t.ref.points}),p).z)<1e-5));for(const f of planar){W.importDraft(d,[f.points,...f.holes].map(r=>r.map(p=>toLocal(d,p))));classify(d);const region=matchingRegion(d,f.points.map(p=>toLocal(d,p)));if(region){region.material=f.material;region.feature=f.feature;edits.$surfaces=edits.$surfaces.filter(s=>s.id!==f.id);}}}
   window.ExteriorModel.validateEdits(edits,t.before);host.commit(t.before);tool=null;if(workingPlane){workingPlane.selection=copy(preview.points);workingPlane.selectedLines=[];workingPlane.selectedFaces=[];refreshPlane();}draftSelection={};picked=[];lineSelection=[];solidPoints=preview.points.map(W.vertexKey);selectedBasePoints=[];selectedSolid=null;selectedRegion=null;clearGuides();host.message('Geometry pasted.');host.redraw();
  }catch(error){host.state().wallEdits=copy(t.before);host.message(error.message);}return true;
 }
 function mergeAll(){
  if(tool&&!finishToolForSwitch())return false;const before=copy(host.state().wallEdits||{});
  try{const scene=moveScene().filter(f=>!f.snapOnly),base=copy(host.state().wallEdits.$base||host.state().base||null);if(base)scene.push(...base.faces.map(f=>({...f,id:'base:'+f.id,baseFaceId:f.id})));
   const groups=W.mergeConnectedFaces(scene,{preserveTrim:true});if(!groups.length){host.state().wallEdits=before;host.message('No connected faces with matching materials to merge.');return false;}
   const edits=host.state().wallEdits;let baseChanged=false,count=0;
   const joinedIds=new Set(groups.flatMap(g=>g.pieces.flatMap(f=>f.joinedChimneys||[])));
   if(joinedIds.size)for(const c of window.WallChimneys?.definitions(host.state())||[])if(joinedIds.has(c.id)){edits.$chimneys||={};edits.$chimneys[c.id]={...(edits.$chimneys[c.id]||{}),points:copy(c.points)};}

   for(const [i,g]of groups.entries()){const prefix='merged-'+Date.now()+'-'+i;count+=g.faces.length-g.pieces.length;
    if(g.faces[0].baseFaceId!=null){const ids=new Set(g.faces.map(f=>f.baseFaceId));base.faces=base.faces.filter(f=>!ids.has(f.id));base.faces.push(...g.pieces.map((f,j)=>({...f,id:g.faces[0].baseFaceId+(j?'-'+j:'')})));baseChanged=true;continue;}
    for(const f of g.faces){if(f.draft){const region=edits.$drafts[f.draftKey]?.faces.find(r=>r.id===f.regionId);if(region)region.solidId=prefix;}else edits.$surfaces=(edits.$surfaces||[]).filter(r=>r.id!==f.id);}
    edits.$surfaces=[...(edits.$surfaces||[]),...g.pieces.map((f,j)=>({...f,id:prefix+'-'+j,draft:false}))];
   }
   if(baseChanged){S.rebind(host.state().wallEdits.$base||host.state().base,base);edits.$base=base;}window.ExteriorModel.validateEdits(edits,before);host.commit(before);lineSelection=[];picked=[];pickedLines=[];solidPoints=[];solidEdges=[];draftSelection={};selectedBasePoints=[];host.message('Merged '+count+' shared face boundaries.');host.redraw();return true;
  }catch(e){host.state().wallEdits=before;host.message(e.message);host.redraw();return false;}
 }
 function startArch(){
  const K=window.ExteriorGeometry,d=current(),graph=wire(),byId=id=>graph.nodes.find(n=>n.id===id);
  const pairs=workingPlane?.selectedLines?.length?workingPlane.selectedLines.map(l=>l.pair||l):[...lineSelection.map(l=>l.pair),...solidEdges.map(id=>graph.edges.find(e=>e.id===id)).filter(Boolean).map(e=>[byId(e.a),byId(e.b)]),...(d?draftSegments(d).filter(e=>pickedLines.includes(e.id)).map(e=>[world(d,e.start),world(d,e.end)]):[])];
  const unique=[...new Map(pairs.map(p=>[W.edgeKey(...p),p])).values()];if(unique.length!==1){host.message('Select one straight line, then press A to arch it.');return true;}
  const before=copy(host.state().wallEdits||{});
  try{const pair=copy(unique[0]),scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),owners=scene.filter(f=>W.sharedIntervals(...pair,[f]).length),owner=owners.find(f=>f.feature)||owners.find(f=>f.draftKey===preferredDraft||f.id===preferredSolid)||owners[0],frame=workingPlane?.frame||owner&&W.faceFrame(owner)||d?.frame||d&&W.faceFrame({points:d.faces[0].points.map(p=>world(d,p))});
   if(!frame)throw Error('Select a line on a face or drawing plane.');
   tool={kind:'arch',before,prepared:copy(host.state().wallEdits),scene,pair,plane:{frame:copy(frame)},controls:[],guides:[],op:'arch-'+Date.now(),snapPoints:sceneLines().points,selection:dividerSelection()};
   tool.curve=K.splineThrough(pair,[],frame.n);tool.samples=K.curveSamples(tool.curve);host.message('Arch: click spline points; Enter, double-click or A finishes; Escape cancels.');host.redraw();
  }catch(error){host.state().wallEdits=before;host.message(error.message);}return true;
 }
 function previewArch(e){
  const t=tool,K=window.ExteriorGeometry,p=rayPoint(t.plane,e);if(!p)return;
  const raw=K.world(t.plane.frame,p),snap=K.archSnap(t.pair,t.controls,raw,{normal:t.plane.frame.n,points:t.snapPoints,screen:p=>host.screen(p,viewOf(e)||'3d'),snap:!(typeof isFreeMove!=='undefined'&&isFreeMove),radius:typeof snapRadius!=='undefined'?snapRadius:20});
  t.pointer=snap.point;t.guides=snap.guides;t.curve=K.splineThrough(t.pair,[...t.controls,t.pointer],t.plane.frame.n);t.samples=K.curveSamples(t.curve);host.message((snap.kind?snap.kind+' snap · ':'')+'Arch: click points; Enter / double-click / A finishes; Escape cancels.');host.redraw();
 }
 function placeArch(e){previewArch(e);const t=tool;if(t.pointer){const c=window.ExteriorGeometry.splineThrough(t.pair,[...t.controls,t.pointer],t.plane.frame.n);t.controls=copy(c.controls.slice(1,-1));t.curve=c;t.samples=window.ExteriorGeometry.curveSamples(c);}host.redraw();return true;}
 function finishArch(cancel=false){
  const t=tool,K=window.ExteriorGeometry;if(cancel){host.state().wallEdits=copy(t.before);restoreExtrusionSelection(t);tool=null;host.message('Arch cancelled.');host.redraw();return true;}
  try{const c={...K.splineThrough(t.pair,t.controls,t.plane.frame.n),id:t.op},samples=K.curveSamples(c);
   if(!t.controls.length||samples.every(p=>onSegment(p,...t.pair))){host.state().wallEdits=copy(t.before);tool=null;host.message('Line unchanged.');host.redraw();return true;}
   const result=K.archFaces(t.scene,c),edits=copy(t.prepared),changedDrafts=new Set();
   edits.$surfaces=(edits.$surfaces||[]).map(f=>result.faces.find(r=>r.id===f.id&&!r.draft)||f);
   for(const f of result.faces.filter(f=>f.draft&&result.affected.includes(f.id))){const d=edits.$drafts[f.draftKey],old=d.faces.find(r=>r.id===f.regionId),local=p=>toLocal(d,p);if(!old)continue;Object.assign(old,{points:f.points.map(p=>({...p,...local(p)})),holes:f.holes.map(r=>r.map(p=>({...p,...local(p)}))),curves:f.curves.map(c=>K.mapCurve(c,local)),retainedPoints:f.retainedPoints.map(local),...(f.feature?{feature:f.feature}:{})});changedDrafts.add(f.draftKey);}
   for(const key of changedDrafts)S.rebind(t.prepared.$drafts[key],edits.$drafts[key]);
   // Free sketch segments use the same persisted spline, with no duplicate chord.
   for(const [key,d]of Object.entries(edits.$drafts||{})){if(changedDrafts.has(key))continue;const original=t.prepared.$drafts[key],edges=original.sketch.edges.filter(e=>{const a=original.sketch.nodes.find(n=>n.id===e.a),b=original.sketch.nodes.find(n=>n.id===e.b);return a&&b&&W.edgeKey(world(original,a),world(original,b))===W.edgeKey(...t.pair);});if(!edges.length)continue;d.sketch.edges=d.sketch.edges.filter(e=>!edges.some(q=>q.id===e.id));S.addCurve(d,K.mapCurve(c,p=>toLocal(d,p)));}
   const loose=edits.$loose?.edges||[];if(loose.some(pair=>W.edgeKey(...pair)===W.edgeKey(...t.pair))){edits.$loose.edges=loose.filter(pair=>W.edgeKey(...pair)!==W.edgeKey(...t.pair));const d={constructionPlane:true,frame:copy(t.plane.frame),members:[],faces:[],sketch:{version:2,next:0,nodes:[],edges:[],outlines:[]}};edits.$drafts||={};edits.$drafts[t.op]=d;S.addCurve(d,K.mapCurve(c,p=>K.local(t.plane.frame,p)));}
   window.ExteriorModel.validateEdits(edits,t.before);host.state().wallEdits=edits;host.commit(t.before);tool=null;lineSelection=[];pickedLines=[];solidEdges=[];picked=[];solidPoints=[];draftSelection={};if(workingPlane){workingPlane.selectedLines=[];workingPlane.selection=[];refreshPlane();}host.message('Arch placed.');host.redraw();
  }catch(error){host.state().wallEdits=copy(t.prepared);host.message(error.message+' Adjust the spline points or press Escape.');}return true;
 }
 function archKey(e){const k=e.key.toLowerCase();if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey))return finishArch(true);if((k==='a'||k==='enter')&&!e.ctrlKey&&!e.metaKey&&!e.repeat)return finishArch();if(k==='f'&&!e.repeat&&typeof isFreeMove!=='undefined'){isFreeMove=!isFreeMove;if(mouse)previewArch(mouse);}return true;}
 function drawArch3D(group,vector){if(tool?.kind!=='arch')return;const t=tool;window.wallCurveGuides?.(group,vector,t.guides);for(let i=1;i<t.samples.length;i++)previewLine(group,vector,t.samples[i-1],t.samples[i],'#FFD700');for(const p of [...t.controls,...(t.pointer?[t.pointer]:[])])previewPoint(group,vector,p,'#72ffb0',8);}
 function drawArch2D(rot,svg,inv){if(tool?.kind!=='arch')return;const t=tool;for(const g of [...t.guides,{points:t.samples,color:'#FFD700'}])svg('polyline',{points:g.points.map(p=>{const q=host.toPixel(p);return q.x+','+q.y;}).join(' '),fill:'none',stroke:g.color,'stroke-width':2*inv,'pointer-events':'none'},rot);for(const p of t.controls){const q=host.toPixel(p);svg('circle',{cx:q.x,cy:q.y,r:4*inv,fill:'#72ffb0','pointer-events':'none'},rot);}}
 function startCurve(){
  const ps=selectedWorldPoints();if(ps.length!==1||!mouse)return false;const before=copy(host.state().wallEdits),p=ps[0];let d=current();
  const contains=d=>d&&draftNodes(d).some(n=>W.vertexKey(world(d,n))===W.vertexKey(p));
  if(!contains(d)){d=Object.values(all()).find(contains);if(!d){const f=solids().find(f=>!f.deleted&&!f.drafted&&[...f.points,...(f.retainedPoints||[])].some(q=>W.vertexKey(q)===W.vertexKey(p)));if(f)d=solidDraft(f);}if(!d){const w=walls().find(w=>[...w.bottom,...w.top].some(q=>W.vertexKey(q)===W.vertexKey(p)));if(w)d=ensure(w);}}
  if(!d)return false;activeDraftKey=draftKey(d);let start=d.sketch.nodes.find(n=>W.vertexKey(world(d,n))===W.vertexKey(p));if(!start){const id=add(d,toLocal(d,p));start=d.sketch.nodes.find(n=>n.id===id);}picked=[start.id];draftSelection={[activeDraftKey]:picked};solidPoints=[];solidEdges=[];lineSelection=[];
  tool={kind:'curve',before,start:copy(start),track:{}};host.message('Curve: click the center, then sweep to the endpoint; Escape cancels.');host.redraw();return true;
 }
 function previewCurve(e){const t=tool,d=current(),raw=rayPoint(d,e);if(!raw)return;const K=window.ExteriorGeometry,enabled=!(typeof isFreeMove!=='undefined'&&isFreeMove);t.snap=K.curveDrawSnap({start:t.start,center:t.center,point:raw,normal:{x:0,y:0,z:1},points:d.sketch.nodes,curves:d.sketch.curves||[],screen:p=>host.screen(world(d,p),viewOf(e)||'3d'),snap:enabled,radius:typeof snapRadius!=='undefined'?snapRadius:20});const q=t.snap.point;t.pointer=q;t.track.close=t.snap.close;if(t.center){try{t.curve=window.ExteriorGeometry.arcPreview(t.start,t.center,q,{x:0,y:0,z:1},t.track,false);t.samples=window.ExteriorGeometry.curveSamples(t.curve);t.pointer=t.samples.at(-1);t.valid=Math.abs(t.curve.sweep)>1e-5;host.message((t.valid?'Curve':'Invalid curve')+' · '+(t.curve.radiusX===t.curve.radiusY?'Circle':'Ellipse')+' · '+(t.curve.sweep*180/Math.PI).toFixed(1)+'° · click endpoint; Shift-click continues; Escape cancels.');}catch(error){t.valid=false;host.message(error.message);}}t.guides=K.curveDrawGuides({start:t.start,center:t.center,pointer:t.pointer,snap:t.snap,normal:{x:0,y:0,z:1}});host.redraw();}
 function placeCurve(e){
  previewCurve(e);const t=tool;if(!t.center){if(t.pointer&&Math.hypot(t.pointer.x-t.start.x,t.pointer.y-t.start.y)>1e-5){t.center=copy(t.pointer);t.track={};host.message('Sweep around the center, then click the endpoint. Shift-click continues another arc.');host.redraw();}return true;}
  if(t.valid){const d=current();if(transaction(()=>{picked=[S.addCurve(d,t.curve)];},t.before)){clearGuides();if(e.shiftKey){const start=d.sketch.nodes.find(n=>n.id===picked[0]);tool={kind:'curve',before:copy(host.state().wallEdits),start:copy(start),center:copy(t.center),track:{}};draftSelection={[draftKey(d)]:picked};host.message('Continue around the same center. Shift-click adds another arc; click finishes; Escape cancels the pending arc.');}else{tool=null;host.message('Curve placed.');}host.redraw();}}return true;
 }

 function extrudeFace(external){if(tool&&!finishToolForSwitch())return false;const before=copy(host.state().wallEdits||{}),face=copy(external.face);face.id='curve-source-'+Date.now();host.state().wallEdits.$surfaces=[...(host.state().wallEdits.$surfaces||[]),face];picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];selectedRegion=null;selectedSolid=face.id;mouse=external.event;const handled=key({key:'e'});if(tool?.kind==='extrude'){tool.before=before;tool.supports=[face];tool.priorSolid=null;host.state().wallEdits=copy(before);}else host.state().wallEdits=before;return handled;}
 function chamferCommand(external=null,rounded=false){
  if(tool&&!finishToolForSwitch())return true;
  const before=copy(host.state().wallEdits||{}),d=current(),graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),byId=id=>nodesById.get(id);
  let edges=external?.pair?[external.pair]:external?.edges||[...lineSelection.map(l=>l.pair),...solidEdges.map(id=>graph.edges.find(e=>e.id===id)).filter(Boolean).map(e=>[byId(e.a),byId(e.b)]),...(d?pickedLines.map(id=>d.sketch.edges.find(e=>e.id===id)).filter(Boolean).map(e=>[world(d,d.sketch.nodes.find(n=>n.id===e.a)),world(d,d.sketch.nodes.find(n=>n.id===e.b))]):[])];
  edges=[...new Map(edges.map(pair=>[W.edgeKey(...pair),pair])).values()];
  const points=external?.point?[external.point]:external?.points||selectedWorldPoints();
  if(edges.length&&points.length){host.message('Select edges or corner points for chamfering, not both together.');return true;}
  try{
   const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),base=copy(host.state().wallEdits.$base||host.state().base||null);
   if(base)scene.push(...base.faces.filter(f=>!f.deleted).map(f=>({...f,id:'base:'+f.id,baseFaceId:f.id})));
   scene.push(...(host.state().roof?.faces||[]).filter(f=>!f.deleted&&f.points?.every(window.ExteriorGeometry.finite3)).map((f,i)=>({...f,id:'chamfer-roof-support:'+i,chamferSupportOnly:true})));
   const selection={edges:copy(edges),points:copy(points),rounded},initial=W.chamfer(scene,selection,0),anchor=external?.event||mouse;
   if(!anchor)throw Error('Move the mouse into the 3D view before starting a chamfer.');
   const metric=W.chamfer(scene,selection,.000001).metrics[0],a=host.screen(metric.origin,'3d'),b=host.screen(metric.center,'3d'),axis={x:(b.x-a.x)/.000001,y:(b.y-a.y)/.000001};
   tool={kind:'chamfer',rounded,before,prepared:copy(host.state().wallEdits),scene,base,snapPoints:sceneLines().points,selection,metrics:initial.metrics,pointMode:points.length>0,startX:anchor.clientX,startY:anchor.clientY,axis,pixels:Math.max(Math.hypot(axis.x,axis.y),40),amount:0,angleRaw:0,angle:0,rotation:0,valid:true,changed:false,op:Date.now()};
   if(external?.event)mouse=external.event;chamferStatus();host.redraw();
  }catch(error){host.state().wallEdits=before;tool=null;host.message(error.message);host.redraw();}return true;
 }
 function chamferWidth(m){return m?Math.max(0,...m.shoulders.flatMap((p,i)=>m.shoulders.slice(i+1).map(q=>distance3(p,q)))):0;}
 function chamferStatus(){const t=tool;if(t?.kind!=='chamfer')return;host.message((t.pointMode?(t.rounded?'Corner fillet · tilt ':'Corner chamfer · tilt ')+(t.appliedAngle??t.angle).toFixed(1)+'° · rotation '+t.rotation.toFixed(1)+'°':(t.rounded?'Fillet · ':'Chamfer · ')+t.metrics.map(m=>m.angles.map(a=>a.toFixed(1)+'°').join(' / ')).join('; '))+' · width '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((chamferWidth(t.metrics[0])/.3048), 'ft') : (chamferWidth(t.metrics[0])/.3048).toFixed(4)+" ft")+". "+(t.limited?'Size/angle limit reached on some chamfers; other edges can keep growing. ':'')+(t.pointMode?'Mouse up/down: depth; left/right: rotation. ':'Mouse: depth. ')+(t.chamferSnap?(t.chamferSnap.targets.length>1?'Multiple sides snapped. ':'Side snapped. '):'')+'Wheel: angle; click: place; Escape: cancel.');}
 function previewChamfer(e,adjustAngle=false){const t=tool;if(t?.kind!=='chamfer')return;
  if(e){t.amount=t.numeric??Math.max(0,t.pointMode?(t.startY-e.clientY)/t.pixels:W.dragAmount(t.axis,e.clientX-t.startX,e.clientY-t.startY));if(t.pointMode)t.rotation=(e.clientX-t.startX)*.5;}
  try{let result=W.chamfer(t.scene,{...t.selection,widthMode:t.numeric!=null},t.amount,t.angle,t.rotation);t.chamferSnap=null;
   if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){
    const snap=t.pointMode?W.pointChamferSnap(result.metrics,t.snapPoints,t.amount,t.angle,t.rotation,p=>host.screen(p,'3d')):W.chamferSnap(result.metrics,t.snapPoints,t.amount,t.angle,p=>host.screen(p,'3d'),10,adjustAngle);
    if(snap){try{const fitted=W.chamfer(t.scene,t.selection,snap.amount,snap.angle,snap.rotation??t.rotation);
     const aligned=snap.targets.every(c=>fitted.metrics.some(m=>distance3(m.origin,c.origin)<1e-5&&m.shoulders.some(p=>{if(!m.axis)return distance3(p,c.target)<1e-5;const v={x:c.target.x-p.x,y:c.target.y-p.y,z:c.target.z-p.z},along=v.x*m.axis.x+v.y*m.axis.y+v.z*m.axis.z;return Math.hypot(v.x-along*m.axis.x,v.y-along*m.axis.y,v.z-along*m.axis.z)<1e-5;})));
     if(aligned){result=fitted;t.chamferSnap=snap;}
    }catch{}}
   }
   const edits=copy(t.prepared);let baseChanged=false;const base=copy(t.base);
   for(const {face,pieces}of result.replacements){
    if(face.baseFaceId!=null){base.faces=base.faces.filter(f=>f.id!==face.baseFaceId);base.faces.push(...pieces.map((f,i)=>({...f,id:i?face.baseFaceId+'-chamfer-'+i:face.baseFaceId})));baseChanged=true;continue;}
    const prefix='chamfer-'+t.op+'-'+face.id;
    if(face.draft){const region=edits.$drafts[face.draftKey]?.faces.find(f=>f.id===face.regionId);if(region)region.solidId=prefix;}else edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==face.id);
    edits.$surfaces=[...(edits.$surfaces||[]),...pieces.map((f,i)=>({...f,id:prefix+'-'+i,draft:false}))];
   }
   const additions=result.additions.map(f=>({...f,id:'chamfer-'+t.op+'-'+f.id}));edits.$surfaces=[...(edits.$surfaces||[]),...additions];
   if(baseChanged){window.ExteriorGeometry.attachBoundaryCurves(base.faces,edits.$surfaces);S.rebind(t.base,base);edits.$base=base;}
   window.ExteriorModel.validateEdits(edits,t.before);host.state().wallEdits=edits;t.metrics=result.metrics;t.appliedAmount=result.amount;t.limited=result.limited;t.appliedAngle=result.angleOffset;t.valid=true;t.changed=result.amount>window.ExteriorGeometry.CONTACT;t.additions=additions;chamferStatus();
  }catch(error){t.valid=false;host.message('Chamfer preview rejected at '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((t.amount/.3048), 'ft') : (t.amount/.3048).toFixed(4)+" ft")+". "+error.message+' Adjust the mouse or Ctrl+wheel; Escape cancels.');}host.redraw();
 }
 function chamferWheel(e){const t=tool;if(t?.kind!=='chamfer'||!viewOf(e))return false;
  const delta=Math.max(-120,Math.min(120,e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?120:1)));t.angleRaw=Math.max(-60,Math.min(60,t.angleRaw-delta*.01));
  const step=Math.round(t.angleRaw/15)*15;t.angle=Math.abs(step-t.angleRaw)<.6?step:t.angleRaw;previewChamfer(null,true);return true;
 }
 function drawChamfer(group,vector){
  if(chamferLayoutFrame!=null)cancelAnimationFrame(chamferLayoutFrame);chamferLayoutFrame=null;
  for(const el of chamferLabels)el.remove?.();chamferLabels=[];if(tool?.kind!=='chamfer')return;
  for(const c of tool.chamferSnap?.targets||[])previewLine(group,vector,c.current||c.origin,c.target,'#72ffb0',false);
  const placed=[],colors=['#ffd04d','#72d9ed','#ffad91'],rect=typeof renderer!=='undefined'?renderer.domElement.getBoundingClientRect():null;
  for(const [index,m]of (tool.metrics||[]).entries()){
   m.shoulders.forEach((p,i)=>previewLine(group,vector,m.origin,p,colors[i%colors.length],false));previewLine(group,vector,m.origin,m.center,'#ffffff',false);
   if(typeof document==='undefined'||!rect)continue;
   const centerDistance=Math.hypot(m.center.x-m.origin.x,m.center.y-m.origin.y,m.center.z-m.origin.z),label=document.createElement('div');
   Object.assign(label.style,{position:'fixed',pointerEvents:'none',zIndex:10001,width:'154px',boxSizing:'border-box',padding:'6px 8px',border:'1px solid #66737e',borderRadius:'6px',background:'rgba(20,27,33,.94)',color:'#fff',font:'12px/1.5 system-ui',boxShadow:'0 2px 6px #0006'});
   const title=document.createElement('div');title.textContent=(tool.pointMode?'Corner ':'Edge ')+(index+1);title.style.fontWeight='600';label.appendChild(title);if(m.limited??tool.limited){const limit=document.createElement('div');limit.style.color='#ffd04d';limit.textContent='Size / angle limit';label.appendChild(limit);}
   m.shoulders.forEach((p,i)=>{const row=document.createElement('div');row.style.color=colors[i%colors.length];row.textContent=String.fromCharCode(65+i)+'  '+(m.angles[i]??0).toFixed(1)+'°  ·  '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((m.distances[i]/.3048), 'ft') : (m.distances[i]/.3048).toFixed(1)+"′")+"";label.appendChild(row);});
   const widthRow=document.createElement('div');widthRow.textContent=(tool.pointMode?'Max width  ':'Width  ')+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((chamferWidth(m)/.3048), 'ft') : (chamferWidth(m)/.3048).toFixed(1)+"′")+"";widthRow.style.fontWeight='600';label.appendChild(widthRow);
   const middle=document.createElement('div');middle.textContent='Center  '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((centerDistance/.3048), 'ft') : (centerDistance/.3048).toFixed(1)+"′")+"";label.appendChild(middle);
   if(tool.pointMode){const row=document.createElement('div');row.textContent='Tilt '+(tool.appliedAngle??tool.angle).toFixed(1)+'° · Rot '+(tool.chamferSnap?.rotation??tool.rotation).toFixed(1)+'°';label.appendChild(row);}
   document.body.appendChild(label);chamferLabels.push(label);placed.push({label,metric:m,height:20*(m.shoulders.length+3+(tool.pointMode?1:0)+(tool.limited?1:0))});
  }
  if(placed.length){const currentTool=tool,worldSegments=[...(tool.selection.edges||[]),...tool.scene.flatMap(f=>[f.points,...(f.holes||[])].flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]]))),...(tool.additions||[]).flatMap(f=>f.points.map((p,i)=>[p,f.points[(i+1)%f.points.length]])),...tool.metrics.flatMap(m=>m.shoulders.map(p=>[m.origin,p]))];
   let lastView=null;const layout=()=>{if(tool!==currentTool||!chamferLabels.length)return;const viewport=renderer.domElement.getBoundingClientRect(),viewKey=[viewport.left,viewport.top,viewport.width,viewport.height,...(camera.matrixWorld?.elements||[]),...(camera.projectionMatrix?.elements||[])].join(',');if(viewKey===lastView){chamferLayoutFrame=requestAnimationFrame(layout);return;}lastView=viewKey;const segments=worldSegments.map(pair=>pair.map(p=>host.screen(p,'3d'))).filter(pair=>pair.every(p=>p.visible!==false&&Number.isFinite(p.x)&&Number.isFinite(p.y))),occupied=[];
    for(const entry of placed){const width=entry.label.offsetWidth||154,height=entry.label.offsetHeight||entry.height,anchor=host.screen(entry.metric.origin,'3d'),at=window.wallChamferLabelPosition(anchor,width,height,viewport,segments,occupied);entry.label.style.left=at.x+'px';entry.label.style.top=at.y+'px';occupied.push({...at,width,height});}
    chamferLayoutFrame=requestAnimationFrame(layout);
   };layout();
  }
 }
 function stepCommand(){
  const T=window.WallSteps;if(!T)return false;if(tool?.kind==='step'){tool.count++;previewStep();return true;}
  if(tool){host.message('Place the current edit or press Escape before stepping.');return true;}
  if(lineSelection.length!==1){host.message('Select one diagonal line on a face, then press S.');return true;}
  const before=copy(host.state().wallEdits||{});
  try{const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),pair=copy(lineSelection[0].pair),candidates=scene.filter(f=>{const frame=W.faceFrame(f);return frame&&(W.sharedIntervals(...pair,[f]).length||pair.every(p=>Math.abs((p.x-frame.origin.x)*frame.n.x+(p.y-frame.origin.y)*frame.n.y+(p.z-frame.origin.z)*frame.n.z)<1e-5&&G.contains({points:f.points.map(q=>W.inFrame(frame,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(frame,q)))},W.inFrame(frame,p))));}),owner=candidates.find(f=>f.draftKey===preferredDraft||f.id===preferredSolid)||candidates[0];
   if(!owner)throw Error('Select a line attached to a face.');const frame=W.faceFrame(owner);T.pattern(pair,frame,1,.5);
   tool={kind:'step',before,scene,sceneDrafts:copy(all()),pair,plane:{frame},count:1,anchor:.5,valid:false,op:Date.now()};previewStep(mouse);
  }catch(error){host.state().wallEdits=before;tool=null;stepStatus(error.message);host.redraw();}return true;
 }
 function stepWheel(e){if(!e.ctrlKey)return false;if(['paste','geometryTransform'].includes(tool?.kind)&&tool.editMode==='y'&&viewOf(e)){const axes=workingPlane?['all','x','y']:['all','x','y','z'];resizeAxis(axes[(axes.indexOf(tool.resizeAxis||'all')+(e.deltaY>0?1:axes.length-1))%axes.length]);return true;}if(tool?.kind==='paste'&&tool.editMode==='m'&&viewOf(e)){if(workingPlane)return true;tool.mount=(tool.mount+(e.deltaY>0?1:-1)+tool.clip.mounts.length)%tool.clip.mounts.length;if(mouse)previewPaste(mouse);return true;}if(chamferWheel(e))return true;if(tool?.kind!=='step'||!viewOf(e))return false;tool.sizeScale=window.WallSteps.wheelScale(tool.sizeScale,e);previewStep();return true;}
 function previewStep(e){
  const t=tool,T=window.WallSteps;if(!t||t.kind!=='step')return;const p=e&&rayPoint(t.plane,e);if(p)t.anchor=W.fromFrame(t.plane.frame,p);
  try{const pattern=T.pattern(t.pair,t.plane.frame,t.count,t.anchor,t.sizeScale||1);t.preview=pattern;const result=T.apply(t.scene,pattern),edits=copy(t.before);edits.$drafts=copy(t.sceneDrafts);
   edits.$surfaces=[...(edits.$surfaces||[]).filter(f=>f.drafted),...result.faces.filter(f=>!f.draft)];
   for(const f of result.faces.filter(f=>f.draft&&result.affected.includes(f.id))){const region=edits.$drafts[f.draftKey]?.faces.find(r=>r.id===f.regionId);if(region){const id='stepped-'+f.id+'-'+t.op;region.solidId=id;edits.$surfaces.push({...f,id,draft:false});}}
   // A free construction segment lives in the sketch, rather than a face ring.
   // Replace it there as well, preserving its endpoint IDs and other split points.
   for(const [key,d]of Object.entries(edits.$drafts||{}))if(!result.faces.some(f=>f.draftKey===key&&result.affected.includes(f.id))){const old=copy(d.sketch),node=id=>old.nodes.find(n=>n.id===id),changed=old.edges.filter(edge=>W.sharedIntervals(...t.pair,[{points:[world(d,node(edge.a)),world(d,node(edge.b))]}]).length);if(!changed.length)continue;
    for(const n of d.sketch.nodes){const q=T.mapPoint(world(d,n),pattern).point;Object.assign(n,toLocal(d,q));}
    d.sketch.edges=d.sketch.edges.filter(edge=>!changed.some(e=>e.id===edge.id));for(const edge of changed){const points=T.rewriteEdge(world(d,node(edge.a)),world(d,node(edge.b)),pattern),ids=points.map(p=>S.add(d,toLocal(d,p),.000001));S.connect(d,ids);}S.resolve(d);
   }
   host.state().wallEdits=edits;t.valid=true;t.pattern=pattern;if(t.sizeScale&&t.count>1)t.sizeScale=pattern.spacing*pattern.sections/pattern.run;lineSelection=pattern.points.slice(1).map((p,i)=>({pair:[pattern.points[i],p],id:W.edgeKey(pattern.points[i],p)}));
   stepStatus(t.count+(t.count===1?' step':' steps')+' · rise '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((Math.abs(pattern.rise)/t.count/.3048), 'ft') : (Math.abs(pattern.rise)/t.count/.3048).toFixed(2)+" ft")+" · spacing "+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((pattern.spacing/.3048), 'ft') : (pattern.spacing/.3048).toFixed(2)+" ft")+". S count; move offset; Ctrl+wheel width; click to place; Escape cancels.");
  }catch(error){t.valid=false;stepStatus(error.message+' Choose another offset or press Escape.');}host.redraw();
 }
 function cancelStep(){const t=tool;host.state().wallEdits=t.before;lineSelection=[{pair:t.pair,id:W.edgeKey(...t.pair)}];tool=null;stepStatus('Stepping canceled. Press S to start again with one step.');host.redraw();}

 // Entity extrusion uses the original, immutable scene for both hover and distance.
 const distance3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
 function onSegment(p,a,b,tol=.0001){const l=distance3(a,b);if(l<1e-8)return distance3(p,a)<tol;const t=((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y)+(p.z-a.z)*(b.z-a.z))/(l*l);return t>=-tol/l&&t<=1+tol/l&&distance3(p,{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t})<tol;}
 function beginEntity(mode,external=null){
  if(tool&&!finishToolForSwitch())return true;if(external?.event)mouse=external.event;if(!mouse)return false;const points=external?[]:selectedWorldPoints(),source=external?external.point:(points.length===1?points[0]:null),pair=external?external.pair:(lineSelection.length===1?lineSelection[0].pair:null);
  if(!source&&!pair)return false;if(mode==='move'&&pair&&beginLineMove(false,{pair,event:mouse,includeBase:!!external}))return true;
  const before=copy(host.state().wallEdits||{}),base=copy(before.$base||host.state().base),scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted);
  if(base)for(const f of base.faces)scene.push({...copy(f),id:'base:'+f.id,baseId:f.id});
  const graph=sceneLines(),segments=[...graph.lines.values(),...(base?.faces||[]).flatMap(f=>f.points.map((p,i)=>[p,f.points[(i+1)%f.points.length]])),...(base?.sketch?.edges||[]).map(e=>[e.a,e.b].map(id=>base.sketch.nodes.find(n=>n.id===id))).filter(pair=>pair.every(Boolean))];
  const candidates=source?segments.filter(([a,b])=>onSegment(source,a,b)).flatMap(pair=>pair.filter(p=>distance3(p,source)>.0001).map(end=>({end,length:distance3(source,end),direction:{x:(end.x-source.x)/distance3(source,end),y:(end.y-source.y)/distance3(source,end),z:(end.z-source.z)/distance3(source,end)}}))):scene.filter(f=>{const frame=W.faceFrame(f);return frame&&(W.sharedIntervals(...pair,[f]).length||pair.every(p=>Math.abs((p.x-frame.origin.x)*frame.n.x+(p.y-frame.origin.y)*frame.n.y+(p.z-frame.origin.z)*frame.n.z)<.0001&&G.contains({points:f.points.map(q=>W.inFrame(frame,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(frame,q)))},W.inFrame(frame,p))));}).map(face=>({face,frame:W.faceFrame(face)}));
  if(!candidates.length){host.state().wallEdits=before;if(mode==='move')return false;host.message('Select a point on a line, or a line shared by a face.');return true;}
  tool={kind:'entityExtrude',external:!!external,mode,source:source&&copy(source),pair:pair&&copy(pair),candidates,before,base,scene,snapGeometry:graph,heightPoints:heightPoints(),sceneDrafts:copy(all()),op:Date.now(),amount:0,valid:false};previewEntity(mouse);return true;
 }
 function previewEntity(...args){if(!window.ExteriorPerf?.enabled)return perf_previewEntity.apply(this,args);return window.ExteriorPerf.measure('Entity preview',()=>perf_previewEntity.apply(this,args));}
function perf_previewEntity(e){
  const t=tool;t.valid=false;t.preview=null;t.measure=null;t.pathSnap=null;host.state().wallEdits=copy(t.before);
  try{
   let chosen,amount,points,direction;
   if(t.source){
    const a=host.screen(t.source,'3d');let best=Infinity;
    for(const c of t.candidates){const b=host.screen(c.end,'3d'),dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1)continue;const u=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/l2)),score=Math.hypot(e.clientX-a.x-dx*u,e.clientY-a.y-dy*u);if(score<best){best=score;chosen=c;amount=u*c.length;}}
    if(!chosen)throw Error('Turn the view to see a connected line.');
    direction=chosen.direction;if(t.numeric==null&&typeof THREE!=='undefined'){const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);const a=getVector3(host.toPixel(t.source)),b=getVector3(host.toPixel(chosen.end)),hit=new THREE.Vector3();ray.ray.distanceSqToSegment(a,b,new THREE.Vector3(),hit);amount=hit.distanceTo(a)/a.distanceTo(b)*chosen.length;}amount=t.numeric??amount;
    if(amount<0){const opposite=t.candidates.find(c=>c.direction.x*direction.x+c.direction.y*direction.y+c.direction.z*direction.z<-.99999);if(!opposite)throw Error('There is no connected line in the negative direction.');chosen=opposite;direction=opposite.direction;}
    if(Math.abs(amount)>chosen.length+.0001)throw Error('Distance extends past the connected line.');
    if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){
     // Each connected path has its own bounded candidates; height references may
     // be anywhere in the model, but the new point must remain on this segment.
     chosen.motionCandidates||=W.motionSnapCandidates([t.source],[],direction,t.scene,{points:t.snapGeometry.points,edges:[...t.snapGeometry.lines.values()],heightPoints:t.heightPoints}).filter(s=>s.amount>=0&&s.amount<=chosen.length);
     const snap=W.motionSnap([t.source],[],direction,amount,t.scene,{candidates:chosen.motionCandidates,screen:p=>host.screen(p,'3d'),radius:10,minPixelsPerMeter:33.33});
     if(snap){amount=snap.amount;t.pathSnap=snap;}
    }
    const p={x:t.source.x+direction.x*Math.abs(amount),y:t.source.y+direction.y*Math.abs(amount),z:t.source.z+direction.z*Math.abs(amount)};
    points=[p];t.measure=[t.source,p];
   }else{
    let best=Infinity;const mid={x:(t.pair[0].x+t.pair[1].x)/2,y:(t.pair[0].y+t.pair[1].y)/2,z:(t.pair[0].z+t.pair[1].z)/2};
    for(const c of t.candidates){const q=rayPoint({frame:c.frame},e);if(!q||!G.contains({points:c.face.points.map(p=>W.inFrame(c.frame,p)),holes:(c.face.holes||[]).map(r=>r.map(p=>W.inFrame(c.frame,p)))},q))continue;const wp=W.fromFrame(c.frame,q),score=getVector3(host.toPixel(wp)).distanceTo(camera.position);if(score<best){chosen=c;chosen.hit=q;best=score;}}
    if(!chosen)throw Error('Hover over a face sharing the selected line.');
    const frame=chosen.frame,a=W.inFrame(frame,t.pair[0]),b=W.inFrame(frame,t.pair[1]),length=Math.hypot(b.x-a.x,b.y-a.y),u={x:-(b.y-a.y)/length,y:(b.x-a.x)/length};const centerLocal=W.inFrame(frame,B.center(chosen.face));if((centerLocal.x-a.x)*u.x+(centerLocal.y-a.y)*u.y<0){u.x=-u.x;u.y=-u.y;}
    amount=t.numeric??((chosen.hit.x-a.x)*u.x+(chosen.hit.y-a.y)*u.y);
    direction={x:frame.u.x*u.x+frame.v.x*u.y,y:frame.u.y*u.x+frame.v.y*u.y,z:frame.u.z*u.x+frame.v.z*u.y};
    if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){const snap=W.motionSnap(t.pair,[t.pair],direction,amount,t.scene,{points:t.snapGeometry.points,edges:[...t.snapGeometry.lines.values()],heightPoints:t.heightPoints,alignmentNormal:frame.n,excludeMoving:true,screen:p=>host.screen(p,'3d'),radius:10,minPixelsPerMeter:33.33});if(snap){amount=snap.amount;t.pathSnap=snap;}}
    const center={x:(a.x+b.x)/2+u.x*amount,y:(a.y+b.y)/2+u.y*amount,z:0},face={points:chosen.face.points.map(p=>W.inFrame(frame,p)),holes:(chosen.face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))};
    if(t.mode==='move')points=t.pair.map(p=>({x:p.x+direction.x*amount,y:p.y+direction.y*amount,z:p.z+direction.z*amount}));
    else{const ends=window.WallAxisCuts.targets(face,center,{x:b.x-a.x,y:b.y-a.y},[],face.points,.001);if(ends.length!==2)throw Error('The new line must fit inside the hovered face.');points=ends.map(p=>W.fromFrame(frame,p));}
    t.owner=chosen.face;t.measure=[mid,W.fromFrame(frame,center)];
   }
   t.amount=amount;t.preview=points;t.valid=Math.abs(amount)>1e-6;
   if(t.mode==='move'&&t.valid){const pairs=t.source?[[t.source,t.source]]:[t.pair],delta=t.source?distance3(t.source,points[0]):amount,result=W.slideLines(t.scene,pairs,direction,delta),edits=copy(t.before);edits.$drafts=copy(t.sceneDrafts);applyLineResult(t,result,edits);host.state().wallEdits=edits;}
   host.message((t.pathSnap?t.pathSnap.kind+' snap · ':'')+(t.mode==='move'?'Move':'Extrude')+': '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((amount/.3048), 'ft') : (amount/.3048).toFixed(2)+" ft")+" · type a distance; click to place.");
  }catch(error){host.state().wallEdits=copy(t.before);t.valid=false;host.message(error.message);}host.redraw();
 }
 function placeEntity(e){const t=tool;if(!t.valid)return;
  try{if(t.mode!=='move'){
   host.state().wallEdits=copy(t.before);host.state().wallEdits.$drafts=copy(t.sceneDrafts);const points=t.preview;
   const owners=t.source?t.scene.filter(f=>{const fr=W.faceFrame(f),p=points[0];return fr&&Math.abs((p.x-fr.origin.x)*fr.n.x+(p.y-fr.origin.y)*fr.n.y+(p.z-fr.origin.z)*fr.n.z)<.0001&&G.contains({points:f.points.map(q=>W.inFrame(fr,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(fr,q)))},W.inFrame(fr,p));}):[t.owner];
   const done=new Set();for(const f of owners){
    if(f.baseId){if(done.has('$base'))continue;done.add('$base');const base=host.state().wallEdits.$base||copy(t.base);const ids=points.map(p=>S.add(base,p,.001));ids.forEach(id=>base.sketch.nodes.find(n=>n.id===id).userDraftPoint=true);if(ids.length>1)S.connect(base,ids);else S.resolve(base);host.state().wallEdits.$base=base;continue;}
    const d=f.draftKey?all()[f.draftKey]:solidDraft(solids().find(s=>s.id===f.id));if(!d||done.has(draftKey(d)))continue;done.add(draftKey(d));const old=copy(d.faces),ids=points.map(p=>add(d,toLocal(d,p)));if(ids.length>1)S.connect(d,ids);restoreMovedRegions(d,old);
   }
   if(!done.size)throw Error('No editable face supports this placement.');
  }host.commit(t.before);tool=null;lineSelection=[];picked=[];solidPoints=[];
  if(t.mode!=='move')selectPlacedEntity(t,!!e?.shiftKey);host.redraw();
  }catch(error){host.state().wallEdits=copy(t.before);t.valid=false;host.message(error.message);host.redraw();}
 }
 // A world-space vertex is not necessarily selected in an editable draft.
 // Resolve its live owner before starting a connected drawing operation.
 function pointDrawingOwner(points){
  const supports=(d,f)=>!f.solidId&&!f.boundaryHole&&!deleted(d,f)&&points.every(p=>{const face=engineFace(d,f),fr=W.faceFrame(face);return fr&&Math.abs(window.ExteriorGeometry.local(fr,p).z)<.002&&G.contains(f,toLocal(d,p));});
  const candidates=Object.entries(all()).flatMap(([key,d])=>d.faces.filter(f=>supports(d,f)).map(f=>({key,d,f})));
  for(const f of solids().filter(f=>!f.deleted&&!f.drafted)){const fr=W.faceFrame(f);if(fr&&points.every(p=>Math.abs(window.ExteriorGeometry.local(fr,p).z)<.002&&G.contains({points:f.points.map(q=>W.inFrame(fr,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(fr,q)))},W.inFrame(fr,p))))candidates.push({f,solid:f});}
  candidates.sort((a,b)=>Number(!!b.f.feature)-Number(!!a.f.feature)||Number(b.key===preferredDraft)-Number(a.key===preferredDraft));
  const owner=candidates[0];if(!owner)return null;const d=owner.d||solidDraft(owner.solid);activeDraftKey=draftKey(d);preferredDraft=activeDraftKey;preferredRegion=owner.d?owner.f.id:d.faces.find(f=>f.feature)?.id||d.faces[0]?.id;
  picked=points.map(p=>add(d,toLocal(d,p)));draftSelection={};solidPoints=[];selectedBasePoints=[];selectedSolid=null;selectedRegion=null;return d;
 }
 function selectPlacedEntity(t,keepSource){
  const points=t.source?[...t.preview,...(keepSource?[t.source]:[])]:[],pairs=t.source?[]:[t.preview,...(keepSource?[t.pair]:[])];
  draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];selectedBasePoints=[];selectedRegion=null;selectedSolid=null;lineSelection=[];
  if(t.external&&host.selectBaseEntities){host.selectBaseEntities(points,pairs);return;}
  if(pairs.length){lineSelection=pairs.map(pair=>({pair:copy(pair),id:W.edgeKey(...pair)}));}
  else{const entries=Object.entries(all()).filter(([,d])=>points.every(p=>draftNodes(d).some(n=>distance3(world(d,n),p)<.001))).sort(([a],[b])=>Number(b===preferredDraft)-Number(a===preferredDraft)),entry=entries[0];
   if(entry){const [key,d]=entry;activeDraftKey=key;preferredDraft=key;picked=[...new Set(points.map(p=>draftNodes(d).find(n=>distance3(world(d,n),p)<.001).id))];draftSelection[key]=picked.slice();}
   else{const graph=wire();solidPoints=graph.nodes.filter(n=>points.some(p=>distance3(n,p)<.001)).map(n=>n.id);
    for(const [key,d]of Object.entries(all())){const ids=draftNodes(d).filter(n=>points.some(p=>distance3(world(d,n),p)<.001)).map(n=>n.id);if(ids.length)draftSelection[key]=ids;}
    activeDraftKey=Object.keys(draftSelection)[0]||null;picked=draftSelection[activeDraftKey]||[];
   }
  }
  host.message((points.length||pairs.length)+(points.length?' points selected':' lines selected'));
 }
 function beginLineMove(sharedOnly=false,external=null,extrude=false){
  if(external?.event)mouse=external.event;if(!mouse)return false;
  const pairs=external?.pair?[external.pair]:lineSelection.map(l=>l.pair);if(!pairs.length)return false;
  const before=copy(host.state().wallEdits||{}),base=copy(before.$base||host.state().base),scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted);
  if(base&&external?.includeBase)scene.push(...base.faces.map(f=>({...copy(f),id:'base:'+f.id,baseId:f.id})));
  for(const d of Object.values(all()))if(d.sketch.nodes.some(n=>pairs.some(pair=>onSegment(world(d,n),...pair))))S.nodeLines(d);
  const unique=new Map();for(const f of scene){if(!W.faceFrame(f)||!pairs.every(pair=>W.sharedIntervals(...pair,[f]).reduce((sum,[a,b])=>sum+b-a,0)>.99999))continue;const key=[f.points,...(f.holes||[])].map(r=>r.map(W.vertexKey).sort().join(';')).sort().join('/');if(!unique.has(key))unique.set(key,f);}
  let candidates=[...unique.values()];if(sharedOnly&&candidates.length!==2){host.state().wallEdits=before;return false;}
  if(!sharedOnly&&!candidates.length)candidates=scene.filter(f=>{const frame=W.faceFrame(f);return frame&&pairs.every(pair=>pair.every(p=>Math.abs(window.ExteriorGeometry.local(frame,p).z)<1e-5&&G.contains({points:f.points.map(q=>W.inFrame(frame,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(frame,q)))},W.inFrame(frame,p))));});
  // A chain around several walls can share one motion axis (e.g. vertical)
  // without sharing a single supporting face. Keep every edge on its wall.
  if(!sharedOnly&&!candidates.length&&pairs.length>1){
   const owners=pairs.map(pair=>scene.filter(f=>W.faceFrame(f)&&W.sharedIntervals(...pair,[f]).reduce((sum,[a,b])=>sum+b-a,0)>.99999));
   if(owners.every(fs=>fs.length))candidates=owners[0].filter(f=>{const n=W.faceFrame(f).n,[a,b]=pairs[0],u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},d={x:n.y*u.z-n.z*u.y,y:n.z*u.x-n.x*u.z,z:n.x*u.y-n.y*u.x},length=Math.hypot(d.x,d.y,d.z);return length>1e-8&&owners.every((fs,i)=>{const [a,b]=pairs[i],l=distance3(a,b);return l>1e-8&&Math.abs(d.x*(b.x-a.x)+d.y*(b.y-a.y)+d.z*(b.z-a.z))<1e-5*length*l&&fs.some(f=>Math.abs(planeDot(d,W.faceFrame(f).n))<1e-5*length);});});
  }
  if(!candidates.length){host.state().wallEdits=before;return false;}
  const preferred=candidates.findIndex(f=>f.draftKey===preferredDraft||f.id===preferredSolid);if(preferred>0)candidates=[candidates[preferred],...candidates.filter((_,i)=>i!==preferred)];
  // Keep the gesture source and snap targets independent of every rendered preview.
  tool={kind:'lineMove',extrude,before,stageBefore:copy(host.state().wallEdits),base,scene:copy(scene),sceneDrafts:copy(all()),snapGeometry:(()=>{const graph=sceneLines();return {points:copy(graph.points),lines:new Map([...graph.lines].map(([id,pair])=>[id,copy(pair)]))};})(),heightPoints:copy(heightPoints()),pairs:copy(pairs),originalPairs:copy(pairs),initialMouse:mouse,candidates:candidates.map(f=>({id:f.id,frame:copy(W.faceFrame(f))})),planeIndex:0,amount:0,changed:false,op:Date.now()};
  tool.planarDraftKey=planarLineOwner(scene,pairs);setLinePlane();return true;
 }
 function setLinePlane(){const t=tool,frame=t.candidates[t.planeIndex].frame,[a,b]=t.pairs[0],u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},length=Math.hypot(u.x,u.y,u.z),n=frame.n;
  t.direction={x:(n.y*u.z-n.z*u.y)/length,y:(n.z*u.x-n.x*u.z)/length,z:(n.x*u.y-n.y*u.x)/length};if(t.direction.z<-.99999)t.direction={x:-t.direction.x,y:-t.direction.y,z:-t.direction.z};t.plane={frame};t.start=rayPoint(t.plane,mouse);t.baseAmount=0;t.amount=0;t.numeric=null;
  if(t.normalMode)t.direction=copy(n);
  const start=host.screen(a,'3d'),end=host.screen({x:a.x+t.direction.x,y:a.y+t.direction.y,z:a.z+t.direction.z},'3d');t.screenAxis={x:end.x-start.x,y:end.y-start.y};t.startEvent=mouse;t.inputToken={};
  const feature=t.scene.find(f=>f.feature&&t.pairs.length===1&&W.sharedIntervals(a,b,[f]).reduce((s,[lo,hi])=>s+hi-lo,0)>.99999);
  t.dimension=null;if(feature&&!t.normalMode){const values=feature.points.map(p=>(p.x-a.x)*t.direction.x+(p.y-a.y)*t.direction.y+(p.z-a.z)*t.direction.z),lo=Math.min(...values),hi=Math.max(...values);if(Math.abs(lo)<1e-5||Math.abs(hi)<1e-5){const opposite=Math.abs(lo)>Math.abs(hi)?lo:hi,axis=F.dimensions(feature.points,feature.feature).frame.u;t.dimension={opposite,sign:opposite>0?-1:1,label:Math.abs(t.direction.x*axis.x+t.direction.y*axis.y+t.direction.z*axis.z)>.5?'Width':'Height'};}}
  host.message((t.extrude?'Extrude lines':'Move line')+' - '+(t.normalMode?'Perpendicular to wall':'Along wall')+' - Face '+(t.planeIndex+1)+' / '+t.candidates.length+' - M changes face'+(t.extrude?'; E toggles along/perpendicular':'')+'. Click to place; Escape cancels.');host.redraw();
 }
 function toggleLineExtrusion(){const t=tool;flushPreview();t.normalMode=!t.normalMode;host.state().wallEdits=copy(t.before);t.changed=false;t.invalid=false;t.result=null;t.pathSnap=null;t.navigation=false;lineSelection=t.originalPairs.map(pair=>({id:W.edgeKey(...pair),pair}));setLinePlane();return true;}
 function cycleLinePlane(){const t=tool;
  // Candidate probing always uses the original geometry and original cursor.
  // Only a click commits a displacement before another move is started.
  t.planeIndex=(t.planeIndex+1)%t.candidates.length;t.invalid=false;t.changed=false;t.result=null;t.pathSnap=null;t.navigation=false;
  host.state().wallEdits=copy(t.before);lineSelection=t.originalPairs.map(pair=>({id:W.edgeKey(...pair),pair}));
  setLinePlane();t.start=rayPoint(t.plane,t.initialMouse);if(mouse)previewLineMove(mouse);return true;
 }
 function previewLineMove(...args){if(!window.ExteriorPerf?.enabled)return perf_previewLineMove.apply(this,args);return window.ExteriorPerf.measure('Line move preview',()=>perf_previewLineMove.apply(this,args));}
function perf_previewLineMove(e){
  const t=tool,p=rayPoint(t.plane,e);if(!t.normalMode&&!p)return;if(!t.normalMode&&!t.start){t.start=p;return;}
  const u=t.plane.frame.u,v=t.plane.frame.v,du=t.direction.x*u.x+t.direction.y*u.y+t.direction.z*u.z,dv=t.direction.x*v.x+t.direction.y*v.y+t.direction.z*v.z;
  if(t.navigation){t.navigation=false;t.start=p;t.startEvent=e;t.baseAmount=t.amount||0;const a=t.pairs[0][0],b={x:a.x+t.direction.x,y:a.y+t.direction.y,z:a.z+t.direction.z},sa=host.screen(a,'3d'),sb=host.screen(b,'3d');t.screenAxis={x:sb.x-sa.x,y:sb.y-sa.y};return;}
  let amount=t.numeric??((t.baseAmount||0)+(t.normalMode?W.dragAmount(t.screenAxis,e.clientX-t.startEvent.clientX,e.clientY-t.startEvent.clientY):(p.x-t.start.x)*du+(p.y-t.start.y)*dv));t.pathSnap=null;
  if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){t.pathSnap=W.motionSnap(t.pairs.flat(),t.pairs,t.direction,amount,t.scene,{heightPoints:t.heightPoints,points:t.snapGeometry.points,edges:[...t.snapGeometry.lines.values()],alignmentNormal:t.plane.frame.n,excludeMoving:true,screen:p=>host.screen(p,'3d'),radius:12,minPixelsPerMeter:33.33});if(t.pathSnap)amount=t.pathSnap.amount;}
  try{const edits=copy(t.stageBefore||t.before);edits.$drafts=copy(t.sceneDrafts);let result;
   if(t.normalMode){const move=p=>({x:p.x+t.direction.x*amount,y:p.y+t.direction.y*amount,z:p.z+t.direction.z*amount});result={pairs:t.pairs.map(pair=>pair.map(move))};if(Math.abs(amount)>1e-6){edits.$surfaces||=[];for(const [i,[a,b]]of t.pairs.entries()){const support=t.scene.find(f=>W.sharedIntervals(a,b,[f]).length),face={id:'line-extrude-'+t.op+'-'+i,points:[a,b,move(b),move(a)],...(support?.material?{material:support.material}:{}),...(support?.finishColor?{finishColor:support.finishColor}:{})};window.ExteriorGeometry.validateFace(face);edits.$surfaces.push(face);}}window.ExteriorModel.validateEdits(edits,t.before);}
   else if(t.planarDraftKey&&!t.extrude){
    const previous=host.state().wallEdits;host.state().wallEdits=edits;
    try{result={pairs:moveDraftLines(edits.$drafts[t.planarDraftKey],t.pairs,{x:t.direction.x*amount,y:t.direction.y*amount,z:t.direction.z*amount})};}
    finally{host.state().wallEdits=previous;}
   }else{result=W.slideLines(copy(t.scene),t.pairs,t.direction,amount,{preserveConnections:t.extrude});applyLineResult(t,result,edits);}
   host.state().wallEdits=edits;t.invalid=false;t.changed=Math.abs(amount)>1e-6;t.amount=amount;t.result=result;lineSelection=result.pairs.map(pair=>({id:W.edgeKey(...pair),pair}));host.message(t.pathSnap?t.pathSnap.kind+' snap - click to place':'Face '+(t.planeIndex+1)+' / '+t.candidates.length+' - Line offset: '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((amount/.3048), 'ft') : (amount/.3048).toFixed(2)+" ft")+" - M changes face; click to place");
  }catch(error){t.invalid=true;t.pathSnap=null;host.message(error.message);}host.redraw();
 }
 function applyLineResult(t,result,edits){
  if(t.scene&&!result.trimFollowed)result=W.followTrim(t.scene,result,(result.affected||[]).filter(id=>!t.scene.find(f=>f.id===id)?.trim),host.state()?.keepTrimStatic===true);
  if(edits.$loose&&!t.extrude){const move=p=>({...p,...(result.moves.find(m=>distance3(m.from,p)<1e-5)?.to||{})});edits.$loose={points:edits.$loose.points.map(move),edges:edits.$loose.edges.map(pair=>pair.map(move))};}
   edits.$surfaces=[...(edits.$surfaces||[]).filter(f=>f.drafted),...result.faces.filter(f=>!f.draft&&!f.baseId)];
   for(const f of result.faces.filter(f=>f.draft&&result.affected.includes(f.id))){const region=edits.$drafts[f.draftKey]?.faces.find(r=>r.id===f.regionId);if(region){const id='line-move-'+f.id+'-'+t.op;region.solidId=id;edits.$surfaces.push({...f,id,draft:false});}}
   if(!t.extrude)for(const [key,d]of Object.entries(edits.$drafts||{})){if(d.sketch.nodes.some(n=>result.moves.some(m=>distance3(world(d,n),m.from)<1e-5)))S.nodeLines(d);for(const n of d.sketch.nodes){const p=world(d,n),move=result.moves.find(m=>Math.hypot(m.from.x-p.x,m.from.y-p.y,m.from.z-p.z)<1e-5);if(move){const q=d.frame?W.inFrame(d.frame,move.to):{x:(move.to.x-d.origin.x)*d.u.x+(move.to.y-d.origin.y)*d.u.y,y:move.to.z,z:0};Object.assign(n,q);}}
    // Consumed regions mask the original sketch after their replacement face
    // is materialized. Keep that mask in the same local coordinates as the
    // moved sketch nodes, or its former boundary leaks out as loose geometry.
    syncConsumedSketchRegions(d);
   }

  if(t.extrude){
   // Sketch and loose edges retain their original endpoints. Only the selected
   // face boundaries move; fill any uncovered original-to-clone connections.
   const loose=edits.$loose||={points:[],edges:[]},supports=result.faces.filter(f=>!f.deleted);
   for(const {from:a,to:b}of result.moves){if(distance3(a,b)<1e-6)continue;let lo=0;
    const intervals=W.sharedIntervals(a,b,[...supports,...loose.edges.map(points=>({points}))]);
    for(const [start,end]of [...intervals,[1,1]]){if(start-lo>1e-6){const at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});loose.edges.push([at(lo),at(start)]);}lo=Math.max(lo,end);}
   }
  }
  if(result.faces.some(f=>f.baseId&&result.affected.includes(f.id))){const base=copy(t.base||edits.$base||host.state().base);for(const f of result.faces.filter(f=>f.baseId)){const target=base.faces.find(b=>b.id===f.baseId);if(target){target.points=f.points;if(f.curves)target.curves=copy(f.curves);}}const before=copy(t.base||edits.$base||host.state().base);S.rebind(before,base);edits.$base=base;}
 }
 function deleteLines3D(selectedSegments=lineSelection.map(l=>l.pair)){
  selectedSegments=removeDivisionSegments(selectedSegments);if(!selectedSegments.length)return;
  const previousWalls=renderWalls;renderWalls ||= host.walls();
  try{for(const w of renderWalls)ensure(w);}finally{renderWalls=previousWalls;}
  const segments=selectedSegments,faces=[],refs=new Map();
  for(const [key,d]of Object.entries(all()))if(visibleDraft(d))for(const f of d.faces)if(!f.boundaryHole&&!f.solidId&&!deleted(d,f)){const id='draft:'+key+':'+f.id;faces.push(engineFace(d,f,{id}));refs.set(id,{d,f});}
  for(const f of solids())if(!f.deleted&&!f.drafted){const id='solid:'+f.id;faces.push({...f,id});refs.set(id,{f});}
  const edits=host.state().wallEdits,openDrafts=Object.values(all()).filter(visibleDraft),lines=[...(edits.$loose?.edges||[]),...openDrafts.flatMap(d=>draftSegments(d).filter(e=>d.constructionPlane||e.userConnection).map(e=>[world(d,e.start),world(d,e.end)]))],curves=openDrafts.flatMap(d=>(d.sketch.curves||[]).map(c=>({...window.ExteriorGeometry.mapCurve(c,p=>world(d,p)),id:draftKey(d)+':'+c.id}))),result=W.removeFaceEdges(faces,segments,{lines,curves});
  for(const id of result.removed){const {d,f}=refs.get(id);if(f.feature)f.preserveBoundaryWire=true;if(d)d.deletedFaces=[...new Set([...(d.deletedFaces||[]),signature(f)])];else f.deleted=true;}
  // Keep any part of the selected edge still on the merged outer boundary
  // (for example the chimney portion above the adjoining roof/wall).
  const erased=segments.flatMap(([a,b])=>{const out=[];let lo=0;const at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});for(const [start,end]of [...W.sharedIntervals(a,b,result.merged),[1,1]]){if(start-lo>1e-6)out.push([at(lo),at(start)]);lo=Math.max(lo,end);}return out;});
  // Retain endpoint nodes, split partial boundary edges, and remove only the selected wire.
  const cuts=erased.map(points=>({points}));for(const d of Object.values(all())){const edges=[];for(const e of d.sketch.edges){
   if(e.curveId){const curve=d.sketch.curves.find(c=>c.id===e.curveId),hits=S.curveEdges({...d.sketch,edges:[e]}).flatMap(s=>W.sharedIntervals(world(d,s.start),world(d,s.end),cuts).map(([lo,hi])=>[s.start.curveT+(s.end.curveT-s.start.curveT)*lo,s.start.curveT+(s.end.curveT-s.start.curveT)*hi]));
    if(!hits.length){edges.push(e);continue;}const [begin,end]=e.curveRange||[0,1],node=t=>{if(Math.abs(t-begin)<1e-8)return e.a;if(Math.abs(t-end)<1e-8)return e.b;const p=window.ExteriorGeometry.curvePoint(curve,t);let n=d.sketch.nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<1e-6);if(!n){n={...p,id:'p'+(++d.sketch.next),fixed:e.fixed};d.sketch.nodes.push(n);}return n.id;};let lo=begin;for(const [start,finish]of [...hits.sort((a,b)=>a[0]-b[0]),[end,end]]){if(start-lo>1e-8)edges.push({...e,id:'e'+(++d.sketch.next),a:node(lo),b:node(start),curveRange:[lo,start]});lo=Math.max(lo,finish);}continue;
   }
   const a=d.sketch.nodes.find(n=>n.id===e.a),b=d.sketch.nodes.find(n=>n.id===e.b);let lo=0;const intervals=W.sharedIntervals(world(d,a),world(d,b),cuts);if(!intervals.length){edges.push(e);continue;}const node=t=>{if(t<1e-6)return a.id;if(t>1-1e-6)return b.id;const p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:0};let n=d.sketch.nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<1e-6);if(!n){n={...p,id:'p'+(++d.sketch.next),fixed:e.fixed};d.sketch.nodes.push(n);}return n.id;};for(const [start,end]of [...intervals,[1,1]]){if(start-lo>1e-6)edges.push({...e,id:'e'+(++d.sketch.next),a:node(lo),b:node(start)});lo=end;}}d.sketch.edges=edges;}
  edits.$removedSurfaceEdges=[...new Set([...(edits.$removedSurfaceEdges||[]),...erased.map(s=>W.edgeKey(...s))])];
  edits.$surfaces||=[];let next=0;for(const f of result.merged){while(edits.$surfaces.some(s=>s.id==='line-merge-'+next))next++;edits.$surfaces.push({...f,id:'line-merge-'+next++});}
  W.adoptMergedFaceSources(edits);
 }
 function visibleDraftSegments(d,segments){
  const consumed=d.faces.filter(f=>f.solidId),live=d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f));if(!consumed.length)return segments;
  const rings=[...consumed,...live].flatMap(f=>[f.points,...(f.holes||[])]),out=[];
  for(const edge of segments){const a=edge.start,b=edge.end,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,ts=[0,1];if(l2<1e-12)continue;
   for(const ring of rings)for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length],ux=q.x-p.x,uy=q.y-p.y,den=dx*uy-dy*ux;
    if(Math.abs(den)>1e-10){const t=((p.x-a.x)*uy-(p.y-a.y)*ux)/den,u=((p.x-a.x)*dy-(p.y-a.y)*dx)/den;if(t>0&&t<1&&u>=0&&u<=1)ts.push(t);}
    else if(Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)<1e-8)for(const p of [ring[i],q]){const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;if(t>0&&t<1)ts.push(t);}
   }
   ts.sort((a,b)=>a-b);const at=t=>({x:a.x+dx*t,y:a.y+dy*t,z:0}),runs=[];for(let i=1;i<ts.length;i++){if(ts[i]-ts[i-1]<1e-8)continue;const p=at((ts[i]+ts[i-1])/2);if(consumed.some(f=>G.contains(f,p))&&!live.some(f=>G.contains(f,p)))continue;const previous=runs[runs.length-1];if(previous&&Math.abs(previous[1]-ts[i-1])<1e-8)previous[1]=ts[i];else runs.push([ts[i-1],ts[i]]);}for(const [lo,hi] of runs)out.push({...edge,start:at(lo),end:at(hi)});
  }return out;
 }
 function draftSegments(d){if(renderSegments?.has(d))return renderSegments.get(d);const result=renderDerived('segments:'+draftKey(d),()=>computeDraftSegments(d));renderSegments?.set(d,result);return result;}
 function computeDraftSegments(d){
  if(d.mergedInto)return [];
  const local=f=>({points:f.points.map(p=>({...p,z:0})),holes:(f.holes||[]).map(r=>r.map(p=>({...p,z:0})))}),supports=d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)).map(local),cuts=d.faces.filter(f=>f.solidId).flatMap(f=>W.freeEdges(local(f),supports)).map(points=>({points})),result=[];
  for(const edge of S.curveEdges(d.sketch)){if((d.removedPoints||[]).includes(edge.a)||(d.removedPoints||[]).includes(edge.b))continue;const a=edge.start,b=edge.end;let lo=0;for(const [start,end]of [...W.sharedIntervals(a,b,cuts),[1,1]]){if(start-lo>1e-7){const at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:0});result.push({...edge,start:at(lo),end:at(start)});}lo=end;}}return visibleDraftSegments(d,result).flatMap(edge=>(window.WallChimneys?.visibleSegments(world(d,edge.start),world(d,edge.end),host.state(),d.chimney,d.joinedChimneys)||[[world(d,edge.start),world(d,edge.end)]]).map(([a,b])=>({...edge,start:toLocal(d,a),end:toLocal(d,b)})));
 }
 function consumedDraftPoint(d,n){
  // Imported snap intersections can survive in the sketch without appearing in
  // any resolved face's node IDs. They still belong to the moved source region.
  if(!d.faces.some(f=>f.solidId&&G.contains(f,n)))return false;
  return !d.faces.some(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)&&G.contains(f,n));
 }
 function draftNodes(d){if(d.mergedInto)return [];const consumed=new Set(d.faces.filter(f=>f.solidId).flatMap(f=>[f.points,...(f.holes||[])].flat().map(p=>p.nodeId))),retained=new Set(d.faces.filter(f=>!f.solidId).flatMap(f=>[f.points,...(f.holes||[])].flat().map(p=>p.nodeId)));return d.sketch.nodes.filter(n=>!n.generatedBoundary||isPicked(d,n.id)||structuralDraftPoint(d,n)).filter(n=>!(d.removedPoints||[]).includes(n.id)&&(!consumed.has(n.id)||retained.has(n.id))&&!consumedDraftPoint(d,n)).filter(n=>!host.state()?.chimneys?.items?.length||window.WallChimneys.visibleSegments(world(d,n),world(d,n),host.state(),d.chimney,d.joinedChimneys).length||draftSegments(d).some(e=>Math.hypot(e.start.x-n.x,e.start.y-n.y)<.0001||Math.hypot(e.end.x-n.x,e.end.y-n.y)<.0001));}
 function soffitEdges(){
  const R=window.WallResoffit;if(!R||!host.state()?.roof)return [];
  const faces=supportSnapshot||structuralFaces(),contacts=R.candidates(faces,host.state().roof,host.state().sources),geo=undraftedWallTopology();
  const byGroup=new Map(geo.faces.filter(f=>f.mergeGroup).map(f=>[f.mergeGroup,f]));
  // The contact mesh retains survey stations, while the visible/editable
  // boundary joins them. Color and pick that same boundary, not a second path.
  const result=contacts.map(c=>{
   const group=faces[c.faceId]?.generatedMergeGroup,face=group&&byGroup.get(group);if(!face)return c;
   let best=null,error=Infinity;
   for(const ids of face.boundary||[]){
    const pair=ids.map(i=>geo.points[i]),[a,b]=pair,dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz;if(l2<.0004)continue;
    const projections=c.pair.map(p=>{const t=((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2;return {t,d:Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy,p.z-a.z-t*dz)};});
    if(projections.some(p=>p.t<-1e-5||p.t>1+1e-5||p.d>.050001))continue;
    const span=Math.abs(projections[1].t-projections[0].t)*Math.sqrt(l2),length=distance3(...c.pair);if(span<length*Math.cos(5*Math.PI/180))continue;
    const score=Math.max(...projections.map(p=>p.d));if(score<error){best=pair;error=score;}
   }
   return best?{...c,id:W.edgeKey(...best),pair:best}:c;
  });
  return [...new Map(result.map(c=>[c.id,c])).values()];
 }
 function resoffit(depth){
  if(tool||workingPlane){host.message('Finish the current edit before resoffiting.');return false;}
  const pairs=lineSelection.flatMap(l=>l.pairs||[l.pair]);if(!pairs.length){host.message('Select roof-contact soffit lines first.');return false;}
  const before=copy(host.state().wallEdits||{});let result;
  const ok=transaction(()=>{
   const scene=moveScene().filter(f=>!f.snapOnly),base=copy(host.state().wallEdits.$base||host.state().base);
   scene.push(...(base?.faces||[]).filter(f=>!f.deleted).map(f=>({...f,id:'resoffit-base:'+f.id,baseId:f.id})));
   result=window.WallResoffit.apply(scene,pairs,depth,host.state().roof,host.state().sources,{keepTrimStatic:host.state().keepTrimStatic});
   const edits=copy(host.state().wallEdits);applyLineResult({scene,base,op:Date.now()},result,edits);host.state().wallEdits=edits;
   lineSelection=result.pairs.map(pair=>({id:W.edgeKey(...pair),pair}));
  },before);
  if(ok)host.message(result.limited?'Resoffit applied; lower roof layers retain their required clearance.':'Selected soffits updated; neighboring wall planes preserved.');
  return ok;
 }
 function moveScene(...args){if(!window.ExteriorPerf?.enabled)return perf_moveScene.apply(this,args);return window.ExteriorPerf.measure('Snap scene build',()=>perf_moveScene.apply(this,args));}
function perf_moveScene(){
  window.normalizeWallDraftOwnership(host.state().wallEdits);
  for(const w of walls())ensure(w);
  return [...solids().filter(f=>!f.drafted),...Object.entries(all()).flatMap(([key,d])=>d.sketch.outlines.map((points,i)=>({id:'restore:'+key+':'+i,points:points.map(p=>world(d,p)),holes:[],snapOnly:true,restoreFor:d.faces.map(f=>f.solidId).filter(Boolean),draftKey:key}))),...Object.entries(all()).flatMap(([key,d])=>d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)).map(f=>engineFace(d,f,{id:'draft:'+key+':'+f.id,draft:true,draftKey:key,regionId:f.id,retainedPoints:retainedRegionPoints(d,f)})))];
 }
 // Resolving coincident corners can replace point IDs. Keep consumed regions by
 // their moved boundary as well as their previous graph signature.
 function restoreMovedRegions(d,old){
  const moved=p=>{const n=d.sketch.nodes.find(n=>n.id===p.nodeId);return n?{...p,x:n.x,y:n.y}:p;};
  const regions=old.filter(f=>f.solidId).map(f=>({...f,points:f.points.map(moved),holes:(f.holes||[]).map(r=>r.map(moved))}));
  for(const f of d.faces){const prior=old.find(o=>signature(o)===signature(f));if(prior?.solidId){f.solidId=prior.solidId;continue;}const region=regions.find(r=>f.points.every(p=>G.contains(r,p))&&G.contains(r,B.center(f)));if(region){f.solidId=region.solidId;}}
 }
 function trimExtrudedSides(sides,prepared=null){
  const result=prepared||W.trimExtrusion(sides,(tool.scene||[]).filter(f=>f.id!==tool.face.id)),edits=host.state().wallEdits;
  for(const {face,pieces} of result.replacements){
   const prefix='swept-'+face.id+'-'+tool.op;
   if(face.draft){const region=all()[face.draftKey]?.faces.find(f=>f.id===face.regionId);if(region)region.solidId=prefix;}
   else edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==face.id);
   edits.$surfaces=[...(edits.$surfaces||[]),...pieces.map((f,i)=>({...f,id:prefix+'-'+i,draft:false}))];
  }
  return result.sides;
 }
 function applyFabricMove(scene,id,amount){
  const result=W.moveFabric(scene.filter(f=>!f.snapOnly),id,amount,{keepTrimStatic:host.state()?.keepTrimStatic===true}),edits=host.state().wallEdits;
  tool.detached=!!result.detached;
  const next=[];for(const f of result.faces){if(!f.draft){next.push(f);continue;}if(!result.affected.includes(f.id))continue;const d=all()[f.draftKey],region=d?.faces.find(r=>r.id===f.regionId);if(!region)continue;const solidId='moved-'+f.id;region.solidId=solidId;next.push({...f,id:solidId,draft:false});}
  edits.$surfaces=[...solids().filter(f=>f.drafted),...next];
  const base=edits.$base||host.state().base;if(base&&result.moves.length){const before=[],after=[];for(const f of scene.filter(f=>!f.snapOnly&&!f.deleted))for(const ring of [f.points,...(f.holes||[])])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],ma=result.moves.find(m=>W.vertexKey(m.from)===W.vertexKey(a)),mb=result.moves.find(m=>W.vertexKey(m.from)===W.vertexKey(b));if(!ma&&!mb)continue;const key='move-base-'+before.length;before.push({id:key,targetId:'ground',bottom:[a,b]});after.push({id:key,bottom:[ma?.to||a,mb?.to||b]});}edits.$base=B.followWalls(base,before,after);}
  return edits.$surfaces.find(f=>f.id===id||f.id==='moved-'+id);
 }
 function applySolidMove(scene,id,amount){
  const result=W.moveSurface(scene.filter(f=>!f.snapOnly),id,amount,{keepTrimStatic:host.state()?.keepTrimStatic===true}),edits=host.state().wallEdits;edits.$surfaces=[...solids().filter(f=>f.drafted),...result.faces.filter(f=>!f.draft)];
  for(const f of result.faces.filter(f=>f.draft)){const original=scene.find(o=>o.id===f.id);if(!original||f.points.every((p,i)=>distance3(p,original.points[i])<1e-7))continue;const d=all()[f.draftKey],region=d?.faces.find(r=>r.id===f.regionId),frame=W.faceFrame(original);if(!region||f.points.every(p=>Math.abs(window.ExteriorGeometry.local(frame,p).z)<1e-5))continue;region.solidId='moved-'+f.id;edits.$surfaces.push({...f,id:region.solidId,draft:false});}
  for(const d of Object.values(all())){let changed=false;const old=copy(d.faces);for(const n of d.sketch.nodes){const p=world(d,n),move=result.moves.find(m=>W.vertexKey(m.from)===W.vertexKey(p));if(!move)continue;const q=move.to,off=d.frame?((q.x-d.frame.origin.x)*d.frame.n.x+(q.y-d.frame.origin.y)*d.frame.n.y+(q.z-d.frame.origin.z)*d.frame.n.z):(q.x-d.origin.x)*-d.u.y+(q.y-d.origin.y)*d.u.x;if(Math.abs(off)>1e-5)continue;if(d.frame)Object.assign(n,W.inFrame(d.frame,q));else{n.x=(q.x-d.origin.x)*d.u.x+(q.y-d.origin.y)*d.u.y;n.y=q.z;}changed=true;}if(changed){S.resolve(d);restoreMovedRegions(d,old);classify(d);}}
  const base=edits.$base||host.state().base;if(base&&B.followWalls){const before=[],after=[];for(const f of scene.filter(f=>!f.snapOnly&&!f.deleted))for(const ring of [f.points,...(f.holes||[])])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],ma=result.moves.find(m=>W.vertexKey(m.from)===W.vertexKey(a)),mb=result.moves.find(m=>W.vertexKey(m.from)===W.vertexKey(b));if(!ma&&!mb)continue;const key='base-edge-'+before.length;before.push({id:key,targetId:'ground',bottom:[a,b]});after.push({id:key,bottom:[ma?.to||a,mb?.to||b]});}edits.$base=B.followWalls(base,before,after);}
  return edits.$surfaces.find(f=>f.id===id||f.id==='moved-'+id);
 }
 function mergeContained(cap,target){
  const edits=host.state().wallEdits;edits.$drafts=edits.$drafts||{};let key=target.draftKey,d=key&&all()[key];
  if(!d){key='solid:'+target.id;d=all()[key];if(!d){const frame=W.faceFrame(target);d={frame,solidHost:target.id,members:[],faces:[{id:'surface-'+target.id,points:target.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);all()[key]=d;for(const hole of target.holes||[])W.importDraft(d,[hole.map(p=>W.inFrame(frame,p))]);}const original=solids().find(f=>f.id===target.id);if(original)original.drafted=true;}
  const local=p=>d.frame?W.inFrame(d.frame,p):{x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0},before=copy(d.faces);
  const incoming={points:cap.points.map(local),holes:(cap.holes||[]).map(r=>r.map(local))};
  W.importDraft(d,[incoming.points,...incoming.holes]);
  // A newly placed face owns its imported boundary, even if those IDs belonged
  // to geometry deleted earlier. Do not revive unrelated deleted regions.
  const restored=d.faces.filter(f=>f.points.every(p=>G.contains(incoming,p))&&G.contains(incoming,B.center(f))),restoredIds=new Set(restored.flatMap(f=>f.points.map(p=>p.nodeId)));
  for(const f of restored)if(f.solidId===cap.id)delete f.solidId;
  d.removedPoints=(d.removedPoints||[]).filter(id=>!restoredIds.has(id));d.deletedFaces=(d.deletedFaces||[]).filter(key=>!restored.some(f=>signature(f)===key));
  for(const f of d.faces){const old=before.find(o=>signature(o)===signature(f));if(old?.solidId&&old.solidId!==cap.id)f.solidId=old.solidId;}classify(d);
  edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==cap.id&&!(f.id.startsWith(cap.id+'-side-')&&!W.normal(f.points)));activeDraftKey=key;selectedSolid=null;selectedRegion=null;picked=[];solidPoints=[];draftSelection={};
 }
 function mergeWallContained(preview,sourceId){
  const source=preview.find(w=>w.id===sourceId);if(!source)return false;
  const polygon=w=>({id:w.id,points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]}),cap=polygon(source),target=preview.find(w=>w.id!==sourceId&&W.containedBy(cap,polygon(w)));if(!target)return false;
  const targetDraft=ensure(target);let sourceDraft=all()[id(source)];if(!sourceDraft){const frame=W.faceFrame(cap);sourceDraft={frame,members:[source.id],faces:[{id:'source-'+source.id,points:cap.points.map(p=>W.inFrame(frame,p))}]};S.ensure(sourceDraft);all()[id(source)]=sourceDraft;}
  if(sourceDraft===targetDraft)return false;
  const graph=copy(sourceDraft.sketch),local=p=>targetDraft.frame?W.inFrame(targetDraft.frame,p):{x:(p.x-targetDraft.origin.x)*targetDraft.u.x+(p.y-targetDraft.origin.y)*targetDraft.u.y,y:p.z,z:0};
  mergeContained(cap,{...polygon(target),draftKey:id(target)});
  const ids=new Map(graph.nodes.map(n=>[n.id,S.add(targetDraft,local(world(sourceDraft,n)))]));for(const edge of graph.edges)if(ids.get(edge.a)!==ids.get(edge.b))S.connect(targetDraft,[ids.get(edge.a),ids.get(edge.b)]);W.importDraft(targetDraft,[]);classify(targetDraft);
  sourceDraft.deletedFaces=sourceDraft.faces.map(signature);sourceDraft.mergedInto=id(target);return true;
 }
 function roofTarget(face,amount,radius){
  const n=W.normal(face.points),roof=host.roof?.();if(!roof||!n||Math.abs(n.z)>1e-5||!window.findWallRoofSnap)return null;
  const u={x:n.y,y:-n.x},ts=face.points.map(p=>p.x*u.x+p.y*u.y),lo=Math.min(...ts),hi=Math.max(...ts),ends=[lo,hi].map(t=>face.points.filter((p,i)=>Math.abs(ts[i]-t)<1e-5).sort((a,b)=>b.z-a.z)[0]);
  const bottom=ends.map(p=>({...p,z:Math.min(...face.points.filter(q=>Math.hypot(q.x-p.x,q.y-p.y)<1e-5).map(q=>q.z))}));
  const target=window.findWallRoofSnap({bottom,top:ends},amount,roof,radius,{fitSurface:!!roof.faces?.length});if(!target)return null;
  const [a,b]=target.edge,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
  const topIds=face.points.map((p,i)=>face.points.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<1e-5&&q.z>p.z+1e-5)?-1:i).filter(i=>i>=0);
  target.topIds=topIds;target.height=p=>{const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;return a.z+t*(b.z-a.z);};
  if(topIds.some(i=>target.height({x:face.points[i].x+n.x*target.amount,y:face.points[i].y+n.y*target.amount})===null))return null;
  return target;
 }
 function fitSolidRoof(cap,sides,target){
  const moves=target.topIds.map(i=>({from:{...cap.points[i]},z:target.height(cap.points[i])}));
  if(moves.some(m=>m.z===null||cap.points.some((p,i)=>!target.topIds.includes(i)&&Math.hypot(p.x-m.from.x,p.y-m.from.y)<.003&&p.z>=m.z-.01)))throw Error('Roof edge cannot fit this wall without collapsing it.');
  for(const face of [cap,...sides])for(const p of [face.points,...(face.holes||[])].flat()){const m=moves.find(m=>W.vertexKey(m.from)===W.vertexKey(p));if(m)p.z=m.z;}
  return moves;
 }
 function applyRoofMoves(moves){
  for(const face of solids())for(const p of [face.points,...(face.holes||[])].flat()){const m=moves.find(m=>W.vertexKey(m.from)===W.vertexKey(p));if(m)p.z=m.z;}
  for(const d of Object.values(all())){let changed=false;const old=copy(d.faces);for(const p of d.sketch.nodes){const q=world(d,p),m=moves.find(m=>W.vertexKey(m.from)===W.vertexKey(q));if(!m)continue;q.z=m.z;if(d.frame)Object.assign(p,W.inFrame(d.frame,q));else p.y=q.z;changed=true;}if(changed){S.resolve(d);for(const f of d.faces){const prior=old.find(o=>signature(o)===signature(f));if(prior?.solidId)f.solidId=prior.solidId;}classify(d);}}
 }
 function inwardDistanceSign(face){
  const sign=W.inwardSign(face,host.state()?.wallEdits?.$base?.faces||host.state()?.base?.faces||[]);if(sign!==null)return sign;
  const n=W.normal(face.points),c=face.points.reduce((s,p)=>({x:s.x+p.x/face.points.length,y:s.y+p.y/face.points.length,z:s.z+p.z/face.points.length}),{x:0,y:0,z:0});
  if(!n)return 1;const a=getVector3(host.toPixel(c)),b=getVector3(host.toPixel({x:c.x+n.x,y:c.y+n.y,z:c.z+n.z}));
  return (b.x-a.x)*(camera.position.x-a.x)+(b.y-a.y)*(camera.position.y-a.y)+(b.z-a.z)*(camera.position.z-a.z)>0?-1:1;
 }
 function extrudeAxis(face,amount=0){
  const n=window.WallSolidGeometry.normal(face.points),c=face.points.reduce((s,p)=>({x:s.x+p.x/face.points.length,y:s.y+p.y/face.points.length,z:s.z+p.z/face.points.length}),{x:0,y:0,z:0});
  const at=t=>host.screen({x:c.x+n.x*t,y:c.y+n.y*t,z:c.z+n.z*t},'3d'),a=at(amount),b=at(amount+1);return {x:b.x-a.x,y:b.y-a.y};
 }
 function outwardDistanceSign(face){
  const bases=host.state()?.wallEdits?.$base?.faces||host.state()?.base?.faces||[],inward=W.inwardSign(face,bases);if(inward!==null)return -inward;
  // Detached caps can be beyond their old footprint. Keep their direction
  // relative to the building instead of changing it when the camera moves.
  const n=W.normal(face.points),center=geometryCenter(face),nearest=bases.map(base=>geometryCenter(base)).sort((a,b)=>distance3(a,center)-distance3(b,center))[0];
  if(nearest&&Math.abs(n.z)<.1){const dot=(center.x-nearest.x)*n.x+(center.y-nearest.y)*n.y;if(Math.abs(dot)>1e-6)return Math.sign(dot);}
  return -inwardDistanceSign(face);
 }
 function restoreExtrusionSelection(t){faceSelection=copy(t.selection.faces);selectedSolid=t.selection.solid;selectedRegion=copy(t.selection.region);activeDraftKey=t.selection.draft;draftSelection=copy(t.selection.draftSelection);picked=t.selection.picked.slice();pickedLines=t.selection.pickedLines.slice();solidPoints=t.selection.solidPoints.slice();solidEdges=t.selection.solidEdges.slice();lineSelection=copy(t.selection.lineSelection);selectedBasePoints=t.selection.selectedBasePoints.slice();}
 // Divider previews never mutate the model. One click replaces the participating
 // sections atomically, so cancel, undo and orientation changes cannot accumulate edits.
 function divisionScene(){return window.ExteriorModel.collect(host.state()).filter(f=>f.feature);}
 let renderDividerIndex=null,renderDividers=null,renderedDivisionTrim=new Set();
 function divisionSeams(){return renderDividers||F.divisionSegments(divisionScene());}
 function indexDividers(seams){return window.ExteriorModel.indexOpenings(seams.map(s=>({points:s.pair})));}
 function dividerTargets(a,b,index=renderDividerIndex){return (index||indexDividers(divisionSeams())).query(['x','y','z'].map(k=>[Math.min(a[k],b[k]),Math.max(a[k],b[k])]));}
 function isDivisionPair(a,b,index=renderDividerIndex){return W.sharedIntervals(a,b,dividerTargets(a,b,index)).reduce((sum,[lo,hi])=>sum+hi-lo,0)>.99999;}
 function dividerSelection(){return {faces:copy(faceSelection),solid:selectedSolid,region:copy(selectedRegion),draft:activeDraftKey,draftSelection:copy(draftSelection),picked:picked.slice(),pickedLines:pickedLines.slice(),solidPoints:solidPoints.slice(),solidEdges:solidEdges.slice(),lineSelection:copy(lineSelection),selectedBasePoints:selectedBasePoints.slice()};}
 function startDivision(){
  const ref=featureSelection();if(!ref?.feature||!['window','door','garage'].includes(ref.feature.type))return false;
  try{const scene=divisionScene(),seed=scene.find(f=>ref.solid?f.id===ref.solid.id:f.draftKey===draftKey(ref.d)&&f.regionId===ref.f.id);if(!seed)return false;
   const faces=F.divisionMembers(scene,seed),frame=F.viewFrame(seed.points,p=>host.screen(p,'3d')),layout=F.divisionLayout(faces,frame),section=F.divisionLayout([seed],frame);
   tool={kind:'divide',before:copy(host.state().wallEdits||{}),selection:dividerSelection(),faces:copy(faces),layout,orientation:section.height>=section.width?'horizontal':'vertical',groupId:seed.feature.divisionGroup||F.divisionId(),op:F.divisionId(),numeric:null,amount:null};
   previewDivision(mouse);return true;
  }catch(error){host.message(error.message);return true;}
 }
 function previewDivision(e){
  const t=tool,b=t.layout.bounds,h=t.orientation==='horizontal',size=h?t.layout.height:t.layout.width;
  let amount=t.numeric;if(amount==null){const p=e&&rayPoint({frame:t.layout.frame},e);amount=p?(h?b.top-p.y:p.x-b.left):size/2;amount=Math.max(.0001,Math.min(size-.0001,amount));
   const middle=h?{x:(b.left+b.right)/2,y:b.top-amount,z:0}:{x:b.left+amount,y:(b.bottom+b.top)/2,z:0},center={x:(b.left+b.right)/2,y:(b.top+b.bottom)/2,z:0},a=host.screen(W.fromFrame(t.layout.frame,middle),'3d'),c=host.screen(W.fromFrame(t.layout.frame,center),'3d');if(Math.hypot(a.x-c.x,a.y-c.y)<8)amount=size/2;
  }
  t.amount=amount;t.result=null;t.invalid=false;
  try{t.result=F.divideSticker(t.faces,t.orientation,amount,{frame:t.layout.frame,groupId:t.groupId,operationId:t.op});host.message('Divide '+(h?'from top: ':'from left: ')+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((amount/F.FT), 'ft') : (amount/F.FT).toFixed(2)+"′")+" / "+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity(((size-amount)/F.FT), 'ft') : ((size-amount)/F.FT).toFixed(2)+"′")+". L changes direction; type a distance; click to place.");}
  catch(error){t.invalid=true;host.message(error.message);}host.redraw();
 }
 function replaceDivisionFaces(sources,faces){
  const edits=host.state().wallEdits,ids=new Set(sources.filter(f=>!f.draft).map(f=>f.id));
  for(const f of sources)if(f.draft){const source=all()[f.draftKey]?.faces.find(r=>r.id===f.regionId);if(source){source.solidId=faces[0].id;source.opening=false;}}
  edits.$surfaces=[...(edits.$surfaces||[]).filter(f=>!ids.has(f.id)),...faces.map(f=>({...f,draft:false,deleted:false}))];
 }
 function finishDivision(){
  const t=tool;if(!t.result||t.invalid)return true;
  try{replaceDivisionFaces(t.faces,t.result.faces);window.ExteriorModel.validateEdits(host.state().wallEdits,t.before);picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];draftSelection={};selectedRegion=null;faceSelection=[];selectedSolid=t.result.faces[0].id;host.commit(t.before);tool=null;host.message('Sticker divided. Select a dashed segment and Delete to merge its sections.');host.redraw();}
  catch(error){host.state().wallEdits=copy(t.before);host.message(error.message);}return true;
 }
 function removeDivisionSegments(segments){
  const remaining=[];
  for(const pair of segments){const faces=divisionScene(),result=F.mergeStickerDivider(faces,pair);if(!result){remaining.push(pair);continue;}replaceDivisionFaces(faces.filter(f=>result.removed.includes(f.id)),[result.face]);}
  return remaining;
 }
 function drawDivision(group,vector){if(tool?.kind!=='divide'||!tool.result)return;const t=tool,b=t.layout.bounds,h=t.orientation==='horizontal',fr=t.layout.frame,at=p=>W.fromFrame(fr,p);
  for(const seam of t.result.seams){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(seam.pair.map(vector)),new THREE.LineDashedMaterial({color:'#fff',dashSize:.09,gapSize:.06,depthTest:false}));line.computeLineDistances();line.userData.exteriorSelection=true;line.renderOrder=1003;group.add(line);}
  const a=h?{x:(b.left+b.right)/2,y:b.top,z:0}:{x:b.left,y:(b.top+b.bottom)/2,z:0},c=h?{...a,y:b.bottom}:{...a,x:b.right},m=h?{...a,y:b.top-t.amount}:{...a,x:b.left+t.amount};
  for(const [p,q]of [[a,m],[m,c]])window.wallLengthMarker?.(group,vector,{a:at(p),b:at(q),length:distance3(at(p),at(q)),selected:true});
 }
 function startMultiExtrusion(){
  let refs=copy(selectedFaceRefs());const points=refs.length?[]:selectedWorldPoints();if((refs.length<2&&points.length<3)||!mouse)return false;
  const before=copy(host.state().wallEdits||{}),selection={faces:copy(faceSelection),solid:selectedSolid,region:copy(selectedRegion),draft:activeDraftKey,draftSelection:copy(draftSelection),picked:picked.slice(),pickedLines:pickedLines.slice(),solidPoints:solidPoints.slice(),solidEdges:solidEdges.slice(),lineSelection:copy(lineSelection),selectedBasePoints:selectedBasePoints.slice()};
  try{
   const scene=moveScene();if(!refs.length){const keys=new Set(points.map(W.vertexKey));refs=scene.filter(f=>!f.snapOnly&&!f.deleted&&[f.points,...(f.holes||[])].flat().every(p=>keys.has(W.vertexKey(p)))).map(f=>f.draft?{draft:f.draftKey,face:f.regionId}:{solid:f.id});if(refs.length<2){host.state().wallEdits=before;return false;}}const members=refs.map(ref=>{const face=scene.find(f=>ref.solid?f.id===ref.solid:f.draftKey===ref.draft&&f.regionId===ref.face&&!f.snapOnly);if(!face)throw Error('A selected face is no longer available.');const d=ref.draft&&all()[ref.draft],region=d?.faces.find(f=>f.id===ref.face);return {face:copy(face),sign:outwardDistanceSign(face),supports:region?regionSupports(d,region):null,ref};});
   const primary=members.at(-1),axis=extrudeAxis(primary.face),base=copy(before.$base||host.state().base);
   tool={kind:'multiExtrude',members,face:primary.face,selection,before,prepared:copy(host.state().wallEdits),scene,base,roof:host.roof?.(),axis:{x:axis.x*primary.sign,y:axis.y*primary.sign},startX:mouse.clientX,startY:mouse.clientY,baseAmount:0,amount:0,op:Date.now(),snapGeometry:sceneLines(),heightPoints:heightPoints()};
   tool.engine=window.ExteriorModel.createExtrusions({keepTrimStatic:host.state()?.keepTrimStatic===true,members,scene,base,roof:tool.roof});host.state().wallEdits=copy(before);
   host.message('Extrude '+members.length+' faces together; drag or type a distance; click to place; Escape cancels.');host.redraw();
  }catch(error){host.state().wallEdits=before;tool=null;host.message(error.message);host.redraw();}return true;
 }
 function previewMultiExtrusion(e){
  const t=tool,primary=t.members.at(-1);if(t.navigation){t.navigation=false;t.startX=e.clientX;t.startY=e.clientY;t.baseAmount=t.amount;const axis=extrudeAxis(t.face,t.amount*primary.sign);t.axis={x:axis.x*primary.sign,y:axis.y*primary.sign};return;}
  let amount=t.numeric??(t.baseAmount+W.dragAmount(t.axis,e.clientX-t.startX,e.clientY-t.startY));t.pathSnap=null;
  if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){
   const rings=[t.face.points,...(t.face.holes||[])],points=rings.flat(),edges=rings.flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]])),normal=W.normal(t.face.points),scene=t.scene.filter(f=>!t.members.some(m=>m.face.id===f.id));
   t.motionCandidates||=W.motionSnapCandidates(points,edges,normal,scene,{heightPoints:t.heightPoints,points:t.snapGeometry.points,edges:[...t.snapGeometry.lines.values()]});
   const snap=W.motionSnap(points,edges,normal,amount*primary.sign,scene,{candidates:t.motionCandidates,heightPoints:t.heightPoints,screen:p=>host.screen(p,'3d'),radius:12,minPixelsPerMeter:33.33});if(snap){amount=snap.amount*primary.sign;t.pathSnap=snap;}
  }
  if(!t.invalid&&t.changed&&Math.abs(t.amount-amount)<1e-8&&t.roof===host.roof?.())return;
  const previous=host.state().wallEdits;
  try{
   if(Math.abs(amount)<1e-6){host.state().wallEdits=copy(t.before);restoreExtrusionSelection(t);t.amount=0;t.changed=false;t.invalid=false;t.previewCaps=[];host.redraw();return;}
   if(t.roof!==host.roof?.()){t.roof=host.roof?.();t.engine=window.ExteriorModel.createExtrusions({keepTrimStatic:host.state()?.keepTrimStatic===true,members:t.members,scene:t.scene,base:t.base,roof:t.roof});}
   const result=t.engine.preview(amount),edits=copy(t.prepared);host.state().wallEdits=edits;
   const sides=trimExtrudedSides(result.sides,result);if(result.base)edits.$base=result.base;
   const ids=new Set(result.caps.map(f=>f.id));edits.$surfaces=[...(edits.$surfaces||[]).filter(f=>!ids.has(f.id)),...sides.map(f=>({...f,id:f.id+'-'+t.op,draft:false}))];
   const selected=[];
   for(let i=0;i<result.caps.length;i++){
    const cap=result.caps[i],member=t.members[i],below=cap.deleted?null:W.belowBase(cap,W.baseScope(member.face,t.base?.faces||[]));
    if(!below){edits.$surfaces.push({...cap,draft:false});if(!cap.deleted)selected.push({solid:cap.id});}
    else edits.$baseCuts=[...(edits.$baseCuts||[]),...below.cuts.map((cut,j)=>({...cut,id:cap.id+'-base-'+j}))];
    if(member.ref.draft){const region=all()[member.ref.draft]?.faces.find(f=>f.id===member.ref.face);if(region){region.solidId=cap.id;region.opening=false;}}
   }
   window.ExteriorModel.validateEdits(edits,t.before);draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];selectedBasePoints=[];faceSelection=selected;selectedSolid=selected.at(-1)?.solid||null;selectedRegion=null;t.previewCaps=result.caps;t.amount=amount;t.changed=true;t.invalid=false;
   host.message('Extruding '+t.members.length+' faces: '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((amount/.3048), 'ft') : (amount/.3048).toFixed(2)+"′")+" each; click to place.");
  }catch(error){host.state().wallEdits=previous;t.invalid=true;host.message(error.message);}host.redraw();
 }
 function finishMultiExtrusion(){flushPreview();const t=tool;if(t.invalid)return true;if(t.changed)host.commit(t.before);else{host.state().wallEdits=copy(t.before);restoreExtrusionSelection(t);}tool=null;clearGuides();host.redraw();return true;}
 function startQuad(){if(tool&&!finishToolForSwitch())return true;
  const before=copy(host.state().wallEdits||{});try{
   let d=current();const groups=Object.entries(draftSelection).filter(([,ids])=>ids.length);
   // IDs such as p4 belong to a particular draft. The host's selected wall
   // can change independently; never reinterpret those IDs on that wall.
   if(groups.length===1&&!solidPoints.length){activeDraftKey=groups[0][0];d=all()[activeDraftKey];picked=groups[0][1].slice();}
   if(solidPoints.length){const ps=wire().nodes.filter(n=>solidPoints.includes(n.id));if(ps.length<1||ps.length>2)throw Error('Select one corner or two edge points for Q');
    const owner=solids().find(f=>!f.deleted&&!f.drafted&&(()=>{const fr=W.faceFrame(f);return fr&&ps.every(p=>{const q=W.inFrame(fr,p);return Math.abs(q.z)<1e-5&&G.contains({points:f.points.map(p=>W.inFrame(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(fr,p)))},q);});})());
    if(!owner)throw Error('Select corners on the same editable face.');d=solidDraft(owner);activeDraftKey=draftKey(d);picked=ps.map(p=>add(d,toLocal(d,p)));solidPoints=[];solidEdges=[];draftSelection={};
   }
   if(!d||picked.length<1||picked.length>2||picked.some(id=>!d.sketch.nodes.some(n=>n.id===id)))throw Error('Select one corner or two edge points for Q');
   activeDraftKey=draftKey(d);draftSelection={[activeDraftKey]:picked.slice()};
   tool={kind:'quad',before};selectedRegion=null;selectedSolid=null;host.message('Q: click the opposite corner, then rotate; double-click it for a rectangle.');host.redraw();
  }catch(e){host.state().wallEdits=before;host.message(e.message);}return true;
 }
 function quadPoints(d,p){return quadCorners(picked.map(id=>d.sketch.nodes.find(n=>n.id===id)),p,tool.diagonal);}
 function quadCorners(nodes,p,diagonal){if(nodes.length===2){const [a,b]=nodes,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),h=((p.x-a.x)*-dy+(p.y-a.y)*dx)/(len*len);return [a,b,{x:b.x-dy*h,y:b.y+dx*h,z:0},{x:a.x-dy*h,y:a.y+dx*h,z:0}];}
  const a=nodes[0];if(!a)return [];if(!diagonal)return [a,{x:p.x,y:a.y,z:0},p,{x:a.x,y:p.y,z:0}];const b=diagonal,c={x:(a.x+b.x)/2,y:(a.y+b.y)/2},radius=Math.hypot(a.x-b.x,a.y-b.y)/2,l=Math.hypot(p.x-c.x,p.y-c.y)||1,v={x:(p.x-c.x)*radius/l,y:(p.y-c.y)*radius/l};return [a,{x:c.x+v.x,y:c.y+v.y,z:0},b,{x:c.x-v.x,y:c.y-v.y,z:0}];
 }
 function down(e,skipSolid=false){
  const before=copy(tool?.before||host.state().wallEdits||{});
  try{return downUnsafe(e,skipSolid);}catch(error){
   host.state().wallEdits=before;tool=null;box=null;boxEl?.remove?.();boxEl=null;clearGuides();
   host.message('Edit canceled: '+error.message);host.redraw();return true;
  }
 }
 function downUnsafe(e,skipSolid=false){
  if(workingPlane)return planeDown(e);
  flushPreview();
  if(!viewOf(e)||e.button!==0)return false;if(tool?.kind==='arch')return placeArch(e);if(tool?.kind==='divide'){previewDivision(e);return finishDivision();}if(tool?.kind==='multiExtrude')return finishMultiExtrusion();if(tool?.kind==='trim'){finishTrim();return true;}if(tool?.kind==='curveMove'){if(tool.changed)host.commit(tool.before);tool=null;host.redraw();return true;}if(tool?.kind==='curve')return placeCurve(e);if(tool?.kind==='geometryTransform')return placeGeometry();if(tool?.kind==='paste')return placePaste(e);if(tool?.kind==='chamfer'){if(tool.valid){if(tool.changed)host.commit(tool.before);else host.state().wallEdits=tool.before;selectedSolid=tool.additions?.[0]?.id||null;lineSelection=[];picked=[];solidPoints=[];solidEdges=[];pickedLines=[];tool=null;host.redraw();}return true;}if(tool?.kind==='material')return paintMaterial(e);if(tool?.kind==='entityExtrude'){placeEntity(e);return true;}if(tool?.kind==='axisCut'&&!finishAxisCut())return true;if(tool?.kind==='step'){if(tool.valid){host.commit(tool.before);tool=null;stepStatus('Stepped line placed.');host.redraw();}return true;}if(tool?.kind==='feature')return placeFeature(e);if(tool?.kind==='lineMove'){if(tool.invalid)return true;if(tool.changed)host.commit(tool.before);else host.state().wallEdits=tool.before;tool=null;host.redraw();return true;}if(tool?.kind==='extrude'){if(tool.moveMode)previewFaceSlide(e);if(tool.invalid)return true;if(tool.changed)host.commit(tool.before);else host.state().wallEdits=tool.before;if(tool.belowBase)selectedSolid=null;tool=null;clearGuides();host.redraw();return true;}if(skipSolid&&!tool&&viewOf(e)==='3d'&&pickLine3D(e))return true;if(!skipSolid&&!tool&&pickSolid(e))return true;let d=current();if(!d){const w=selected();if(!w){beginBox(e,null);return true;}d=ensure(w);}
  if(tool?.kind==='quad'){const p=snap(d,e);if(!p)return true;if(picked.length===1&&!tool.diagonal){tool.diagonal=p;tool.cornerClick={x:e.clientX,y:e.clientY};return true;}let corners=quadPoints(d,p);if(picked.length===1&&tool.cornerClick&&Math.hypot(e.clientX-tool.cornerClick.x,e.clientY-tool.cornerClick.y)<4){const opposite=tool.diagonal;tool.diagonal=null;corners=quadPoints(d,opposite);}quadFinish={x:e.clientX,y:e.clientY,time:Date.now()};const t=tool,priorPicked=picked.slice(),ok=transaction(()=>{B.validate({points:corners});const ids=corners.map(p=>add(d,p));S.connect(d,[...ids,ids[0]]);picked=[];},t.before);if(ok){tool=null;clearGuides();}else{picked=priorPicked;tool=t;tool.diagonal=null;tool.cornerClick=null;}host.redraw();return true;}
  if(tool){if(['move','scale','rotate'].includes(tool.kind)){host.commit(tool.before);tool=null;clearGuides();host.redraw();return true;}
   const p=snap(d,e);if(p){const placed=transaction(()=>{const next=add(d,p);for(const from of picked)if(from!==next)S.connect(d,[from,next]);picked=[next];},tool.before);if(placed){tool=null;clearGuides();}host.redraw();}return true;
  }
  if(lineMode()){let best=null,distance=12;for(const edge of d.sketch.edges){const a=host.screen(world(d,d.sketch.nodes.find(n=>n.id===edge.a)),viewOf(e)),b=host.screen(world(d,d.sketch.nodes.find(n=>n.id===edge.b)),viewOf(e)),dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/(dx*dx+dy*dy))),dist=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);if(dist<distance&&pickLineVisible([edge.a,edge.b].map(id=>world(d,d.sketch.nodes.find(n=>n.id===id))),e,t)){distance=dist;best=edge.id;}}if(best){pickedLines=e.shiftKey?(pickedLines.includes(best)?pickedLines.filter(id=>id!==best):[...pickedLines,best]):[best];picked=[];solidPoints=[];solidEdges=[];selectedRegion=null;selectedSolid=null;host.redraw();return true;}}
  let best=null,distance=12;for(const n of draftNodes(d)){const p=host.screen(world(d,n),viewOf(e)),dist=Math.hypot(p.x-e.clientX,p.y-e.clientY);if(dist<distance&&pickVisible(world(d,n),e)){distance=dist;best=n.id;}}
  if(!best){beginBox(e,d);box.click=()=>selectRegion(d,e);return true;}beginBox(e,d);box.click=()=>{if(!e.shiftKey)draftSelection={};selectedRegion=null;pickedLines=[];solidPoints=[];solidEdges=[];picked=e.shiftKey?(picked.includes(best)?picked.filter(n=>n!==best):[...picked,best]):[best];if(e.shiftKey)draftSelection[draftKey(d)]=picked.slice();host.redraw();};return true;
 }
 const draftSupportCache=new Map();
 function structuralFaces(...args){if(!window.ExteriorPerf?.enabled)return perf_structuralFaces.apply(this,args);return window.ExteriorPerf.measure('Support topology',()=>perf_structuralFaces.apply(this,args));}
function perf_structuralFaces(includeConsumed=false){
  const faces=solids().filter(f=>!f.deleted&&!f.drafted).slice();
  for(const d of Object.values(all()))if(visibleDraft(d)&&!d.mergedInto){
   const cacheId=draftKey(d)+':'+includeConsumed,cacheKey=JSON.stringify(d),prior=draftSupportCache.get(cacheId);
   if(prior?.key===cacheKey){faces.push(...prior.faces);continue;}
   const draftFaces=[];
   const live=d.faces.filter(f=>(includeConsumed||!f.solidId)&&!deleted(d,f));
   // A recess is a real boundary of the remaining wall. Unioning only the
   // outer rings silently filled that recess and classified its rim as loose wire.
   const same=(a,b)=>a.length===b.length&&a.every(p=>b.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<1e-5));
   // Labeled, unextruded features fill their host opening. Do not triangulate
   // and subtract a circular hole only to add the same material back again.
   const material=live.map(f=>({...f,holes:(f.holes||[]).filter(r=>!live.some(g=>g.feature&&same(g.points,r)))})),filled=material.filter(f=>!f.feature||!material.some(g=>g!==f&&!g.feature&&f.points.every(p=>G.contains(g,p)))).flatMap(f=>f.holes?.length?W.subtract(f,f.holes.map(points=>({points}))):[f.points]);
   for(const points of B.boundary(filled)){const holes=B.boundary(W.subtract({points},filled.map(points=>({points}))));draftFaces.push(engineFace(d,{points,holes},{retainedPoints:[]}));}
   draftSupportCache.delete(cacheId);draftSupportCache.set(cacheId,{key:cacheKey,faces:draftFaces});if(draftSupportCache.size>512)draftSupportCache.delete(draftSupportCache.keys().next().value);
   faces.push(...draftFaces);
  }
  for(const w of walls())if(!Object.values(all()).some(d=>d.members.includes(w.id)))faces.push({chimney:w.chimney,generatedMergeGroup:w.mergeGroup,points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]]});
  return faces.flatMap(f=>window.WallChimneys?.visibleParts(f,host.state())||[f]);
 }
 function structuralDraftPoint(d,n){return structuralPoint(world(d,n),supportSnapshot||structuralFaces());}
 function structuralDraftEdge(d,e){return structuralEdge(world(d,e.start||d.sketch.nodes.find(n=>n.id===e.a)),world(d,e.end||d.sketch.nodes.find(n=>n.id===e.b)),supportSnapshot||structuralFaces());}
 function removableDraftPoint(d,n){return !structuralDraftPoint(d,n);}
 function healInteriorDrawingPoints(points){
  const K=window.ExteriorGeometry,records=[];for(const [key,d]of Object.entries(all()))for(const f of d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)))records.push({d,f,face:engineFace(d,f,{id:'draft:'+key+':'+f.id})});for(const f of solids().filter(f=>!f.deleted&&!f.drafted))records.push({f,face:f});
  const same=(a,b)=>distance3(a,b)<K.CONTACT,touches=(f,p)=>[f.points,...(f.holes||[])].flat().some(q=>same(p,q)),groups=[];
  for(const r of records){const frame=K.frame(r.face);if(!frame)continue;let g=groups.find(g=>r.face.points.every(p=>Math.abs(K.local(g.frame,p).z)<K.CONTACT));if(!g){g={frame,records:[]};groups.push(g);}g.records.push(r);}
  const edits=host.state().wallEdits;for(const g of groups){if(!points.some(p=>g.records.some(r=>touches(r.face,p))))continue;const local=f=>({points:f.points.map(p=>K.local(g.frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(g.frame,p)))}),outline=K.union(g.records.map(r=>local(r.face))),boundary=(p,r)=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?((p.x-a.x)*dx+(p.y-a.y)*dy)/l2:-1;return t>=0&&t<=1&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<K.CONTACT;});
   const safe=points.filter(p=>g.records.some(r=>touches(r.face,p))&&!records.some(r=>!g.records.includes(r)&&touches(r.face,p))&&outline.some(f=>G.contains({points:f.points},K.local(g.frame,p))&&!boundary(K.local(g.frame,p),f.points)));
   if(!safe.length)continue;const affected=g.records.filter(r=>safe.some(p=>touches(r.face,p)));if(affected.length<2||affected[0].d&&affected.every(r=>r.d===affected[0].d))continue;
   const merged=K.union(affected.map(r=>local(r.face))),source=affected.slice().sort((a,b)=>K.area(local(b.face))-K.area(local(a.face)))[0].face;
   for(const r of affected)if(r.d)r.d.deletedFaces=[...new Set([...(r.d.deletedFaces||[]),signature(r.f)])];else r.f.deleted=true;
   edits.$surfaces||=[];let next=0;for(const f of merged){while(edits.$surfaces.some(f=>f.id==='interior-delete-'+next))next++;edits.$surfaces.push({id:'interior-delete-'+next++,points:f.points.map(p=>K.world(g.frame,p)),holes:f.holes.map(r=>r.map(p=>K.world(g.frame,p))),material:source.material,retainedPoints:affected.flatMap(r=>r.face.retainedPoints||[]).filter(p=>!points.some(q=>same(p,q)))});}
  }
 }
 function healCoplanarPointDeletion(points){if(!points.length)return;const groups=W.mergeAtPoints(moveScene().filter(f=>!f.snapOnly&&!f.deleted),points),edits=host.state().wallEdits;
  for(const [i,g]of groups.entries()){const prefix='point-merge-'+Date.now()+'-'+i;for(const f of g.faces){if(f.draft){const region=all()[f.draftKey]?.faces.find(r=>r.id===f.regionId);if(region)region.solidId=prefix;}else {const original=edits.$surfaces?.find(r=>r.id===f.id);if(original)original.deleted=true;}}
   edits.$surfaces||=[];edits.$surfaces.push(...g.pieces.map((f,j)=>({...f,id:prefix+'-'+j,draft:false,drafted:false})));}
 }
 function createSelectedFace(selection){const points=selection?.points||selectedWorldPoints();if(points.length<3){host.message('Select at least three coplanar points, then press V.');return true;}
  const ok=transaction(()=>{const scene=moveScene(),edges=scene.flatMap(f=>[f.points,...(f.holes||[])].flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]]))),face=W.faceFromPoints(points,edges),edits=host.state().wallEdits;edits.$surfaces||=[];face.id='filled-face-'+Date.now();window.WallChimneys?.preserveFilledFace(face,host.state());const frame=W.faceFrame(face),local=f=>({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))});for(const old of scene.filter(f=>!f.snapOnly&&!f.deleted)){const n=W.normal(old.points);if(!n||Math.abs(n.x*frame.n.x+n.y*frame.n.y+n.z*frame.n.z)<1-1e-5||old.points.some(p=>Math.abs((p.x-frame.origin.x)*frame.n.x+(p.y-frame.origin.y)*frame.n.y+(p.z-frame.origin.z)*frame.n.z)>window.ExteriorGeometry.CONTACT))continue;if(window.ExteriorGeometry.difference(local(old),[local(face)]).reduce((s,f)=>s+window.ExteriorGeometry.area(f),0)>1e-8)continue;if(old.draft){const region=all()[old.draftKey]?.faces.find(f=>f.id===old.regionId);if(region)region.solidId=face.id;}else {const original=edits.$surfaces.find(f=>f.id===old.id);if(original)original.deleted=true;}}edits.$surfaces.push(face);edits.$removedSurfacePoints=(edits.$removedSurfacePoints||[]).filter(id=>!face.points.some(p=>W.vertexKey(p)===id));edits.$removedSurfaceEdges=(edits.$removedSurfaceEdges||[]).filter(id=>!face.points.some((p,i)=>W.edgeKey(p,face.points[(i+1)%face.points.length])===id));selectedSolid=face.id;});if(ok){picked=[];pickedLines=[];solidPoints=[];solidEdges=[];selectedBasePoints=[];draftSelection={};selectedRegion=null;lineSelection=[];host.message('Face created from '+points.length+' selected points.');}return true;
 }
 function removeDraftPoints(d,ids){if(d.constructionPlane){S.remove(d,ids,[]);d.sketch.curves=(d.sketch.curves||[]).filter(c=>d.sketch.edges.some(e=>e.curveId===c.id));return;}healCoplanarPointDeletion(d.sketch.nodes.filter(n=>ids.includes(n.id)).map(n=>world(d,n)));
  healInteriorDrawingPoints(d.sketch.nodes.filter(n=>ids.includes(n.id)).map(n=>world(d,n)));
  // A corner of an interior sketch region is not a corner of the supporting
  // wall. Only perimeter points and actual non-coplanar attachments can remove it.
  const supports=Object.values(all()).flatMap(other=>other.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(other,f)).map(f=>({points:f.points.map(p=>world(other,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(other,p)))}))).concat(solids().filter(f=>!f.deleted&&!f.drafted)),plane=W.normal(d.sketch.outlines[0].map(p=>world(d,p))),onOutline=n=>[...d.sketch.outlines,...window.ExteriorGeometry.union(d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f)).map(f=>({points:f.points,holes:f.holes||[]}))).map(f=>f.points)].some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?((n.x-a.x)*dx+(n.y-a.y)*dy)/l2:-1;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(n.x-a.x-t*dx,n.y-a.y-t*dy)<1e-5;})),corners=d.sketch.nodes.filter(n=>ids.includes(n.id)&&W.structuralPoint(world(d,n),supports.filter(f=>{const normal=W.normal(f.points);return onOutline(n)||normal&&plane&&Math.abs(normal.x*plane.x+normal.y*plane.y+normal.z*plane.z)<1-1e-6;})));
  if(corners.length){const keys=corners.map(n=>W.vertexKey(world(d,n)));W.deleteSurfaceElements(host.state().wallEdits,keys);for(const other of Object.values(all())){const matches=other.sketch.nodes.filter(n=>keys.includes(W.vertexKey(world(other,n)))).map(n=>n.id);other.removedPoints=[...new Set([...(other.removedPoints||[]),...matches])];for(const face of other.faces){if(face.solidId||face.boundaryHole||(other.deletedFaces||[]).includes(signature(face)))continue;const selected=[face.points,...(face.holes||[])].flat().filter(p=>matches.includes(p.nodeId));if(selected.length&&window.ExteriorGeometry.pointRemovalChangesRegion(face,selected.map(window.ExteriorGeometry.pointKey)))other.deletedFaces=[...new Set([...(other.deletedFaces||[]),signature(face)])];}}}
  const removed=d.sketch.nodes.filter(n=>ids.includes(n.id)&&!corners.includes(n)),wanted=new Set(removed.map(n=>n.id));if(!wanted.size)return;
  W.deleteSurfaceElements(host.state().wallEdits,removed.map(n=>W.vertexKey(world(d,n))));
  if(!d.faces.some(f=>!f.boundaryHole&&!f.solidId&&!deleted(d,f))){d.removedPoints=[...new Set([...(d.removedPoints||[]),...wanted])];return;}
  const old=copy(d.faces);d.sketch.outlines=d.sketch.outlines.map(r=>r.filter(p=>!removed.some(n=>Math.hypot(n.x-p.x,n.y-p.y)<.002)));d.sketch.nodes=d.sketch.nodes.filter(n=>!wanted.has(n.id));d.sketch.edges=d.sketch.edges.filter(e=>!e.fixed&&!wanted.has(e.a)&&!wanted.has(e.b));
  // Rebuild the locked perimeter without the redundant points; only user dividers disappear.
  for(const ring of d.sketch.outlines)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1e-10)continue;const nodes=d.sketch.nodes.filter(n=>Math.abs((n.x-a.x)*dy-(n.y-a.y)*dx)/Math.sqrt(l2)<.002).map(n=>({n,t:((n.x-a.x)*dx+(n.y-a.y)*dy)/l2})).filter(v=>v.t>=-1e-6&&v.t<=1+1e-6).sort((a,b)=>a.t-b.t);for(let j=1;j<nodes.length;j++)d.sketch.edges.push({id:'e'+(++d.sketch.next),a:nodes[j-1].n.id,b:nodes[j].n.id,fixed:true});}
  S.resolve(d);for(const f of d.faces){const prior=old.find(o=>signature(o)===signature(f));if(prior?.solidId)f.solidId=prior.solidId;}
  d.deletedFaces=(d.deletedFaces||[]).filter(key=>d.faces.some(f=>signature(f)===key));
 }
 function removeSolidPoints(ids,edges=[]){const graph=wire();healCoplanarPointDeletion(graph.nodes.filter(n=>ids.includes(n.id)));healInteriorDrawingPoints(graph.nodes.filter(n=>ids.includes(n.id)));W.deleteSurfaceElements(host.state().wallEdits,ids,edges);for(const d of Object.values(all())){const matching=d.sketch.nodes.filter(n=>ids.includes(W.vertexKey(world(d,n)))).map(n=>n.id);if(matching.length)removeDraftPoints(d,matching);}}

 // Feature polygons share the draft graph, so editing their edges edits real faces.
 const F=window.WallFeatures;
 const toLocal=(d,p)=>d.frame?W.inFrame(d.frame,p):{x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0};
 function solidDraft(f){if(f.curvedSurface?.logical)throw Error('Select the curved surface to move, rotate or resize it; its curved boundaries remain linked.');const key='solid:'+f.id;host.state().wallEdits.$drafts||={};let d=all()[key];if(!d){const frame=F.frame(f.points);d={frame,joinedChimneys:f.joinedChimneys&&copy(f.joinedChimneys),chimney:f.chimney&&copy(f.chimney),solidHost:f.id,members:[],faces:[{id:'surface-'+f.id,points:f.points.map(p=>W.inFrame(frame,p)),...(f.material?{material:f.material}:{}),finishColor:f.finishColor,trim:f.trim,...(f.trimData?{trimData:copy(f.trimData)}:{}),...window.ExteriorGeometry.mapCurveData(f,p=>W.inFrame(frame,p)),...(f.feature?{feature:copy(f.feature)}:{})}]};S.ensure(d);all()[key]=d;for(const r of f.holes||[])W.importDraft(d,[r.map(p=>W.inFrame(frame,p))]);// Retained anchors from an earlier extrusion can outlive their old face height.
 // Import only anchors on the current surface; stale anchors must not prevent editing.
 const shape={points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))},rings=[shape.points,...shape.holes];
 for(const p of f.retainedPoints||[]){const q=W.inFrame(frame,p);if(Math.abs(q.z)<=window.ExteriorGeometry.CONTACT&&(G.contains(shape,q)||rings.some(r=>r.some((a,i)=>onSegment(q,a,r[(i+1)%r.length],window.ExteriorGeometry.CONTACT)))))S.add(d,{...q,z:0},.0001);}}f.drafted=true;return d;}
 function selectedFinishFace(){if((!selectedSolid&&!selectedRegion)||selectedWorldPoints().length)return null;return selectedSolid?solids().find(f=>f.id===selectedSolid&&!f.deleted):selectedRegion?all()[selectedRegion.draft]?.faces.find(f=>f.id===selectedRegion.face&&!f.boundaryHole):null;}
 function updateFaceFinish(face,changes){Object.assign(face,changes);if(face.trimData){face.trimData=copy(face.trimData);const target=face.trimData.layers.at(-1)||face.trimData.base;Object.assign(target,changes);}}
 function applySelectedFinish(changes){const faces=selectedFaceRefs().map(r=>r.solid?solids().find(f=>f.id===r.solid&&!f.deleted):all()[r.draft]?.faces.find(f=>f.id===r.face&&!f.solidId&&!f.boundaryHole)).filter(f=>f&&!f.feature);if(!faces.length)return false;const ok=transaction(()=>{for(const face of faces)updateFaceFinish(face,changes);});if(ok){tool=null;host.message(faces.length+' selected face finishes updated.');}return true;}
 function colorCommand(color){if(color!=='default'&&!/^#[0-9a-f]{6}$/i.test(color))return false;if(tool&&tool.kind!=='material'){host.message('Finish or cancel the current operation first.');return true;}if(!tool&&applySelectedFinish({finishColor:color==='default'?null:color}))return true;tool={kind:'material',type:tool?.type||null,color};host.message('Paint color: click a wall section; Escape finishes.');host.redraw();return true;}
 function materialCommand(type){if(!window.ExteriorMaterials?.[type])return false;if(tool&&tool.kind!=='material'){host.message('Finish or cancel the current operation first.');return true;}if(!tool&&applySelectedFinish({material:type}))return true;tool={kind:'material',type,color:tool?.kind==='material'?tool.color:undefined};host.message('Paint '+window.ExteriorMaterials[type].label+': click wall sections; Escape finishes.');host.redraw();return true;}
 function paintMaterial(e){let ref;const ok=transaction(()=>{ref=placementHost(e);if(!ref)return;const f=ref.f||ref.solid;if(f.feature)return;updateFaceFinish(f,{...(tool.type?{material:tool.type}:{}),...(tool.color?{finishColor:tool.color==='default'?null:tool.color}:{})});});if(ok&&ref)host.message((window.ExteriorMaterials[tool.type]?.label||'Color')+' assigned. Click another face; Escape finishes.');return true;}
 function materialColor(f){
  // Trim is a visible finish strip even when wall material colors are hidden.
  // Otherwise a one-sided band on an existing divider blends into the wall.
  if(f.trim||f.material?.startsWith('trim-'))return f.finishColor||host.state()?.finishDefaults?.trimColor||'#f5f3ef';
  return host.state()?.materialColors!==false&&(f.finishColor||window.ExteriorMaterials?.[f.material]?.color);
 }
 function openingTrimItems(type){
 const items=[];for(const f of solids())if(!f.deleted&&!f.drafted&&f.feature?.type===type)items.push({ref:{solid:f.id},f,points:f.points});
 for(const [key,d]of Object.entries(all()))for(const f of d.faces)if(!f.solidId&&!f.boundaryHole&&!deleted(d,f)&&f.feature?.type===type)items.push({ref:{draft:key,face:f.id},f,points:f.points.map(p=>world(d,p))});
 return items.map((item,i)=>({...item,key:faceKey(item.ref),label:F.defs.get(type).name+' '+(i+1)+' · '+F.label(item.points,item.f.feature),selected:faceChosen(item.ref),width:(item.f.feature.trim?.width||0)/.0254}));
 }
 function selectOpeningTrim(type,key,checked=true){
 if(tool&&!finishToolForSwitch())return;
 const items=openingTrimItems(type);let refs=key?selectedFaceRefs().filter(r=>faceKey(r)!==key):[];
 if(checked)refs.push(...items.filter(i=>!key||i.key===key).map(i=>i.ref));
 picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];draftSelection={};selectedBasePoints=[];
 faceSelection=refs;selectedSolid=refs[0]?.solid||null;selectedRegion=refs[0]?.draft?refs[0]:null;host.redraw();
 }
 function applyOpeningTrim(type,inches,color){if(tool&&!finishToolForSwitch())return false;const faces=selectedFaces().filter(({f})=>f.feature?.type===type);if(!faces.length){host.message('Select '+type+' faces to change their trim.');return false;}return transaction(()=>{for(const {f}of faces)f.feature=F.setTrim(f.feature,inches,color);host.message(faces.length+' '+type+' trim settings updated.');});}
 function featureSelection(){if(selectedSolid){const f=solids().find(f=>f.id===selectedSolid&&!f.deleted);if(f)return {solid:f,points:f.points,feature:f.feature};}const d=all()[selectedRegion?.draft],f=d?.faces.find(f=>f.id===selectedRegion.face&&!f.solidId&&!deleted(d,f));if(f)return {d,f,points:f.points.map(p=>world(d,p)),feature:f.feature};
  if(lineSelection.length){for(const d of Object.values(all()))for(const f of d.faces.filter(f=>f.feature&&!f.solidId&&!deleted(d,f))){const points=f.points.map(p=>world(d,p));if(lineSelection.every(l=>W.sharedIntervals(...l.pair,[{points}]).length))return {d,f,points,feature:f.feature};}}return null;}
 function selectFeature(d,f){faceSelection=[];activeDraftKey=draftKey(d);preferredDraft=activeDraftKey;preferredSolid=null;preferredRegion=f.id;selectedRegion={draft:activeDraftKey,face:f.id};selectedSolid=null;picked=[];pickedLines=[];solidPoints=[];solidEdges=[];lineSelection=[];draftSelection={};}
 function asDraft(selection){if(selection.d)return selection;const d=solidDraft(selection.solid),f=d.faces.find(f=>!f.solidId&&!deleted(d,f));return {d,f,points:f.points.map(p=>world(d,p)),feature:f.feature};}
 function matchingRegion(d,points){return d.faces.filter(f=>!f.boundaryHole&&f.points.every(p=>G.contains({points},p))&&points.every(p=>G.contains({points:f.points},p))).sort((a,b)=>a.points.length-b.points.length)[0];}
 function editRegion(d,f,points){if(f.feature)F.validate(points,d.sketch.outlines,d.faces.filter(o=>o!==f&&(o.feature||o.boundaryHole)&&!o.solidId&&!deleted(d,o)));B.validate({points});S.nodeLines(d);const meta=f.feature&&copy(f.feature),old=copy(d.faces),priorPoints=f.points.map(p=>world(d,p));
  if(points.length===f.points.length){const moves=f.points.map((p,i)=>({id:p.nodeId,to:points[i]}));
   // Resolved face loops can omit collinear anchors and coincident sketch nodes.
   // Carry every sticker-owned anchor through the same affine edit as its face.
   if(meta){const a=f.points[0],b=f.points[1],j=f.points.findIndex(p=>Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))>1e-8),c=f.points[j];if(c){const det=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);for(const n of d.sketch.nodes){if(n.fixed||moves.some(m=>m.id===n.id)||!G.contains(f,n))continue;const u=((n.x-a.x)*(c.y-a.y)-(n.y-a.y)*(c.x-a.x))/det,v=((b.x-a.x)*(n.y-a.y)-(b.y-a.y)*(n.x-a.x))/det;moves.push({id:n.id,to:{x:points[0].x+u*(points[1].x-points[0].x)+v*(points[j].x-points[0].x),y:points[0].y+u*(points[1].y-points[0].y)+v*(points[j].y-points[0].y),z:0}});}}}
for(const m of moves){const n=d.sketch.nodes.find(n=>n.id===m.id);if(!n)throw Error('Resolve the face boundary before editing it.');if(meta&&n.fixed&&!d.sketch.outlines.some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],u={x:b.x-a.x,y:b.y-a.y},l2=u.x*u.x+u.y*u.y,t=((m.to.x-a.x)*u.x+(m.to.y-a.y)*u.y)/l2;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(m.to.x-a.x-t*u.x,m.to.y-a.y-t*u.y)<1e-5;})))throw Error('That would move a shared building boundary off its face.');Object.assign(n,m.to);}S.resolve(d);
  }else{const boundary=new Set(f.points.map(p=>p.nodeId));d.sketch.edges=d.sketch.edges.filter(e=>e.fixed||!boundary.has(e.a)||!boundary.has(e.b));delete f.feature;S.resolve(d);W.importDraft(d,[points]);}
  restoreMovedRegions(d,old);classify(d);const next=matchingRegion(d,points);if(!next)throw Error('This edit would cross a divider or split the feature.');if(meta)next.feature=meta;if(priorPoints.length===points.length){const moves=priorPoints.map((from,i)=>({from,to:world(d,points[i])})),move=p=>({...p,...(moves.find(m=>distance3(m.from,p)<=window.ExteriorGeometry.CONTACT)?.to||{})}),edits=host.state().wallEdits;if(edits.$loose){edits.$loose.points=edits.$loose.points.map(move);edits.$loose.edges=edits.$loose.edges.map(pair=>pair.map(move));}for(const surface of edits.$surfaces||[])if(surface.retainedPoints)surface.retainedPoints=surface.retainedPoints.map(move);}selectFeature(d,next);return next;
 }
 function removeSticker(ref){
  const edits=host.state().wallEdits,points=ref.d?ref.f.points.map(p=>world(ref.d,p)):ref.f.points,K=window.ExteriorGeometry;
  const sameRing=r=>r.length>=3&&r.every(p=>points.some(q=>distance3(p,q)<=K.CONTACT))&&points.every(p=>r.some(q=>distance3(p,q)<=K.CONTACT));
  const sources=[];if(ref.d){const live=ref.d.faces.find(f=>f.id===ref.f.id);if(live)sources.push({d:ref.d,f:live});}
  else{edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==ref.f.id);for(const d of Object.values(all()))for(const f of d.faces)if(f.solidId===ref.f.id)sources.push({d,f});}
  for(const {d,f}of sources){
   const old=copy(d.faces),shape={points:f.points.map(p=>({...p,...(f.solidId?d.sketch.nodes.find(n=>n.id===p.nodeId):null),z:0}))},inside=n=>G.contains(shape,n),boundary=pair=>W.sharedIntervals(...pair,[shape]).reduce((sum,[a,b])=>sum+b-a,0)>.99999;
   const candidates=new Set(d.sketch.nodes.filter(inside).map(n=>n.id));
   d.sketch.edges=d.sketch.edges.filter(e=>e.fixed||!boundary([e.a,e.b].map(id=>d.sketch.nodes.find(n=>n.id===id))));
   const used=new Set(d.sketch.edges.flatMap(e=>[e.a,e.b]));d.sketch.nodes=d.sketch.nodes.filter(n=>n.fixed||!candidates.has(n.id)||used.has(n.id));
   delete f.feature;delete f.solidId;d.faces=d.faces.filter(other=>other!==f);
   if(d.faces.length){S.resolve(d);restoreMovedRegions(d,old.filter(o=>o.id!==f.id));classify(d);}else{d.sketch.edges=[];d.sketch.nodes=[];d.sketch.outlines=[];}
   d.deletedFaces=(d.deletedFaces||[]).filter(key=>d.faces.some(f=>signature(f)===key));
  }
  for(const surface of edits.$surfaces||[])if(!surface.deleted){surface.holes=(surface.holes||[]).filter(r=>!sameRing(r));}
  const boundary=p=>points.some((a,i)=>onSegment(p,a,points[(i+1)%points.length]));
  if(edits.$loose){edits.$loose.edges=edits.$loose.edges.filter(pair=>W.sharedIntervals(...pair,[{points}]).reduce((sum,[a,b])=>sum+b-a,0)<.99999);edits.$loose.points=edits.$loose.points.filter(p=>!boundary(p));}
  for(const surface of edits.$surfaces||[])if(surface.retainedPoints)surface.retainedPoints=surface.retainedPoints.filter(p=>!boundary(p)||[surface.points,...(surface.holes||[])].some(r=>r.some((a,i)=>onSegment(p,a,r[(i+1)%r.length]))));
 }
 function deleteSelectedStickers(){const refs=selectedFaces();if(!refs.length||refs.some(r=>!r.f.feature))return false;
  const ok=transaction(()=>{for(const ref of refs)removeSticker(ref);});if(ok){faceSelection=[];selectedSolid=null;selectedRegion=null;preferredSolid=null;preferredRegion=null;picked=[];pickedLines=[];solidPoints=[];solidEdges=[];host.redraw();}return true;
 }
 function resizeFeature(selection,type,index){const ref=asDraft(selection),{d,f}=ref,def=F.defs.get(type),preset=def.sizes[index],frame=F.orientedFrame(ref.points,ref.feature?.axis),local=ref.points.map(p=>W.inFrame(frame,p)),boundaries=[...d.sketch.outlines,...d.sketch.edges.filter(e=>{const nodes=[e.a,e.b].map(id=>d.sketch.nodes.find(n=>n.id===id));return nodes.some(n=>!G.contains({points:f.points},n));}).map(e=>[e.a,e.b].map(id=>d.sketch.nodes.find(n=>n.id===id)))].map(r=>r.map(p=>W.inFrame(frame,world(d,p)))),anchor=F.anchors(local,boundaries),next=F.resized(local,preset,anchor).map(p=>toLocal(d,W.fromFrame(frame,p)));
  // Keep vertex ordering and split points when scaling a shape in place.
  let points=next;if((preset.shape==='rectangle'&&f.feature?.shape!=='circle')||(preset.shape==='circle'&&f.feature?.shape==='circle')){const a=F.bounds(local),b=F.bounds(F.resized(local,preset,anchor));points=local.map(p=>toLocal(d,W.fromFrame(frame,{x:b.left+(p.x-a.left)/(a.right-a.left)*(b.right-b.left),y:b.bottom+(p.y-a.bottom)/(a.top-a.bottom)*(b.top-b.bottom),z:0})));}
  const result=editRegion(d,f,points);result.feature={...(result.feature||{}),type,preset:index,shape:preset.shape,axis:frame.u};return result;
 }
 function applySelectedFeature(type){
  const faces=selectedFaces();if(!faces.length)return false;
  return transaction(()=>{for(const {d,f} of faces){if(type==='none')delete f.feature;else f.feature={...(f.feature||{}),type,preset:null,shape:f.feature?.shape||'custom',axis:f.feature?.axis||F.orientedFrame(d?f.points.map(p=>world(d,p)):f.points).u};}host.message(faces.length+' selected face'+(faces.length===1?'':'s')+' updated; each size kept.');});
 }
 function featureCommand(type,index,place=false){if(!F)return false;if(type==='none'){if(tool&&!finishToolForSwitch())return true;if(selectedFaces().length)return applySelectedFeature(type);const selection=featureSelection();if(!selection)return false;return transaction(()=>{delete (selection.f||selection.solid).feature;});}const def=F.defs.get(type);if(!def)return false;
  if(tool?.kind==='feature'){const same=tool.type===type;if(!same)tool.trimInches=0;tool.type=type;tool.index=Number.isInteger(index)?index:same?F.nextPreset(type,tool.index):(def.defaultPreset??0);if(mouse)previewFeature(mouse);return true;}
  if(tool&&!finishToolForSwitch())return true;if(!place&&index===null&&selectedFaces().length)return applySelectedFeature(type);const selection=!place&&featureSelection();if(selection){return transaction(()=>{if(index!==null&&(selection.feature?.type===type||Number.isInteger(index))){resizeFeature(selection,type,Number.isInteger(index)?index:F.nextPreset(type,selection.feature?.preset??-1));}else{const f=selection.f||selection.solid;f.feature={type,preset:null,shape:f.feature?.shape||'custom',axis:f.feature?.axis||F.orientedFrame(selection.points).u};host.message(def.name+' - current dimensions kept; press '+(def.key?.toUpperCase()||'the library button')+' again for common sizes.');}});}
  tool={kind:'feature',type,index:Number.isInteger(index)?index:(def.defaultPreset??0),session:++featurePlacementSerial,preview:null};host.message('Place '+def.name+' on a face. Use the library to cycle sizes; R rotates; Shift-click keeps placing.');if(mouse)previewFeature(mouse);host.redraw();return true;
 }
 function placementHost(e,includeFeatures=false){
  if(host.featureHost)return host.featureHost(e);
  const candidates=[],usable=f=>f&&!f.solidId&&!f.boundaryHole&&(includeFeatures||!f.feature);
  let ray=null;
  if(viewOf(e)==='3d'&&typeof THREE!=='undefined'){
   const r=renderer.domElement.getBoundingClientRect();ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
   if(tool?.kind==='feature'||tool?.kind==='paste'){
   // Placement uses complete supporting faces, not their rendered cutouts.
   // A sticker/opening under the cursor must not send the ray to a rear wall.
   for(const d of Object.values(all()))if(visibleDraft(d)){
    const p=rayPoint(d,e);if(!p)continue;
    for(const f of d.faces)if(usable(f)&&!deleted(d,f)&&G.contains(f,p))candidates.push({d,f,points:f.points.map(p=>world(d,p))});
   }
   for(const f of solids())if(!f.deleted&&!f.drafted&&!f.boundaryHole&&(includeFeatures||!f.feature)){
    const frame=F.frame(f.points),p=rayPoint({frame},e);
    if(p&&G.contains({points:f.points.map(q=>W.inFrame(frame,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(frame,q)))},p))candidates.push({solid:f,points:f.points});
   }
   }else{
    for(const m of solidMeshes)m.updateMatrixWorld(true);
    const hit=ray.intersectObjects(solidMeshes)[0];
    if(hit){const data=hit.object.userData;
     if(data.draftKey){const d=all()[data.draftKey],p=rayPoint(d,e),f=d.faces.find(f=>f.id===data.regionId);if(usable(f)&&!deleted(d,f)&&p&&G.contains(f,p))candidates.push({d,f,points:f.points.map(p=>world(d,p))});}
     else{const f=solids().find(f=>f.id===data.solidId);if(f&&!f.deleted&&!f.drafted&&(includeFeatures||!f.feature))candidates.push({solid:f,points:f.points});}
    }
   }
  }
  // Generated walls and edited surfaces participate in the same depth comparison.
  const w=host.hit?.(e);if(w){const d=ensure(w),p=rayPoint(d,e),f=p&&d.faces.find(f=>usable(f)&&!deleted(d,f)&&G.contains(f,p));if(f)candidates.push({d,f,points:f.points.map(p=>world(d,p))});}
  if(ray&&candidates.length>1){const distance=ref=>{const frame=F.frame(ref.points),p=rayPoint({frame},e);if(!p)return Infinity;return getVector3(host.toPixel(W.fromFrame(frame,p))).distanceTo(ray.ray.origin);};candidates.sort((a,b)=>distance(a)-distance(b));}
  return candidates[0]||null;
 }
 function previewFeature(...args){if(!window.ExteriorPerf?.enabled)return perf_previewFeature.apply(this,args);return window.ExteriorPerf.measure('Sticker preview',()=>perf_previewFeature.apply(this,args));}
 function stickerPlacement(ref,faces,snap=true){
  const frame=F.frame(ref.points),scene=moveScene(),graph=stickerSnapGeometry(sceneLines(),scene),onPlane=p=>Math.abs(window.ExteriorGeometry.local(frame,p).z)<=window.ExteriorGeometry.CONTACT;
  const alignmentTargets=W.stickerAlignmentTargets(scene.filter(f=>!f.trim&&f.feature?.type!=='trim'),frame),boundary=[ref.points.map(p=>W.inFrame(frame,p))],holes=(ref.f?.holes||ref.solid?.holes||[]).map(r=>r.map(p=>W.inFrame(frame,ref.d?world(ref.d,p):p))),targets=[...boundary,...[...graph.lines.values()].filter(pair=>pair.every(onPlane)).map(pair=>pair.map(p=>W.inFrame(frame,p))),...graph.points.filter(onPlane).map(p=>[W.inFrame(frame,p)]),...alignmentTargets.map(p=>[{...W.inFrame(frame,p),alignmentAxes:p.alignmentAxes,alignmentCenter:p.alignmentCenter}])];
  const shapes=faces.map(f=>f.points.map(p=>W.inFrame(frame,p)));if(shapes.flat().some(p=>Math.abs(p.z)>window.ExteriorGeometry.CONTACT))throw Error('Place stickers together on one supporting face.');
  const placed=F.placeGroup(shapes,targets,p=>host.screen(W.fromFrame(frame,p),'3d'),snap&&!(typeof isFreeMove!=='undefined'&&isFreeMove)?12:0,boundary.map(points=>({points,holes}))),a=shapes[0][0],b=placed[0][0],delta={x:frame.u.x*(b.x-a.x)+frame.v.x*(b.y-a.y),y:frame.u.y*(b.x-a.x)+frame.v.y*(b.y-a.y),z:frame.u.z*(b.x-a.x)+frame.v.z*(b.y-a.y)},move=p=>({...p,x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z});
  for(const points of placed)F.validate(points,boundary,holes.map(points=>({points})));
  return {faces:faces.map(f=>({...f,points:f.points.map(move),holes:(f.holes||[]).map(r=>r.map(move)),retainedPoints:(f.retainedPoints||[]).map(move)})),move,alignmentTargets,frame};
 }
 function installStickers(ref,faces){const {d}=asDraft(ref),placed=[];
  for(const source of F.remapDivisionGroups(faces)){const local=source.points.map(p=>toLocal(d,p));F.validate(local,d.sketch.outlines,d.faces.filter(f=>(f.feature||f.boundaryHole)&&!f.solidId&&!deleted(d,f)));W.importDraft(d,[local]);classify(d);const face=matchingRegion(d,local);if(!face)throw Error('The sticker crosses an existing divider.');face.feature=copy(source.feature);if(source.material)face.material=source.material;if(source.finishColor)face.finishColor=source.finishColor;placed.push({draft:draftKey(d),face:face.id});}
  selectFeature(d,d.faces.find(f=>f.id===placed.at(-1).face));faceSelection=placed;return placed;
 }
function perf_previewFeature(e){if(!F||viewOf(e)!=='3d')return;tool.preview=null;const ref=placementHost(e);if(!ref){host.redraw();return;}try{const frame=F.frame(ref.points),p=rayPoint({frame},e);if(!p)return;const preset={...F.defs.get(tool.type).sizes[tool.index]};if(tool.rotated)[preset.w,preset.h]=[preset.h,preset.w];
  const shape=F.shape({left:p.x-preset.w*F.FT/2,right:p.x+preset.w*F.FT/2,bottom:p.y-preset.h*F.FT/2,top:p.y+preset.h*F.FT/2},preset.shape).map(p=>W.fromFrame(frame,p)),placed=stickerPlacement(ref,[{points:shape}]);tool.alignmentTargets=placed.alignmentTargets;const worldPoints=placed.faces[0].points;tool.preview={ref,points:worldPoints,axis:tool.rotated?frame.v:frame.u};host.message(F.defs.get(tool.type).name+' '+F.label(worldPoints)+' � Trim '+(tool.trimInches?tool.trimInches+' in':'off')+' � T cycles trim � click to place');}catch(error){host.message(error.message);}host.redraw();}
 function placeFeature(e){previewFeature(e);if(!tool.preview)return true;const {ref,points,axis}=tool.preview,type=tool.type,index=tool.index,shape=F.defs.get(type).sizes[index].shape;const ok=transaction(()=>installStickers(ref,[{points,feature:F.setTrim({type,preset:index,shape,axis},tool.trimInches||0,host.state()?.finishDefaults?.trimColor||'#f5f3ef')}]));if(ok&&!e.shiftKey)tool=null;host.redraw();return true;}
 const moveNames=['In/Out','Left/Right','Up/Down','Free on face'];
 function moveModeStatus(){host.message(moveNames[tool.moveMode||0]+' - M switches direction; click to place; Escape cancels.');}
 function cycleFaceMove(e){const t=tool;if(e.repeat)return;host.state().wallEdits=copy(t.before);host.state().wallEdits.$drafts=copy(t.sceneDrafts);selectedSolid=t.priorSolid||null;activeDraftKey=t.priorDraft||null;selectedRegion=copy(t.priorRegion);t.moveMode=t.face.feature?({3:1,1:2,2:0,0:3}[t.moveMode]):(t.moveMode+1)%4;t.inputToken={};t.numeric=null;t.changed=false;t.amount=0;t.baseAmount=0;t.previewCap=null;t.pathSnap=null;t.contained=null;t.belowBase=null;t.roofSnap=null;t.mergeSeams=[];t.invalid=false;t.startX=mouse.clientX;t.startY=mouse.clientY;t.axis=extrudeAxis(t.face);t.moveFrame=F.viewFrame(t.face.points,p=>host.screen(p,'3d'));t.planeStart=rayPoint({frame:t.moveFrame},mouse);moveModeStatus();host.redraw();}
 function previewFaceSlide(...args){if(!window.ExteriorPerf?.enabled)return perf_previewFaceSlide.apply(this,args);return window.ExteriorPerf.measure('Sticker move preview',()=>perf_previewFaceSlide.apply(this,args));}
function perf_previewFaceSlide(e){const t=tool;if(t.face.feature)t.snapGeometry=stickerSnapGeometry(t.snapGeometry,t.scene||[]); t.pathSnap=null;const frame=t.moveFrame,raw=rayPoint({frame},e);if(!raw||!t.planeStart){t.invalid=true;host.message('Turn toward the face to move along it.');return;}let dx=t.moveMode===2?0:raw.x-t.planeStart.x,dy=t.moveMode===1?0:raw.y-t.planeStart.y;if(t.numeric!=null){if(t.moveMode===1)dx=t.numeric;else dy=t.numeric;}t.amount=t.moveMode===1?dx:dy;
  if(t.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){const axes=t.moveMode===1?['u']:t.moveMode===2?['v']:['u','v'],targets=[...t.snapGeometry.points.filter(q=>!t.face.points.some((p,i)=>onSegment(q,p,t.face.points[(i+1)%t.face.points.length]))),...(t.face.feature?W.stickerAlignmentTargets(t.scene||[],t.moveFrame,t.face.points):[])],points=t.face.points.map(p=>({x:p.x+frame.u.x*dx+frame.v.x*dy,y:p.y+frame.u.y*dx+frame.v.y*dy,z:p.z+frame.u.z*dx+frame.v.z*dy})),aligned=W.planeAlignment(points,targets,frame,p=>host.screen(p,'3d'),12,axes,t.face.feature?window.ExteriorGeometry.world(frame,raw):null);dx+=aligned.x;dy+=aligned.y;t.amount=t.moveMode===1?dx:dy;}

  const owner=t.sceneDrafts[t.moveReference.key],moving=owner.faces.find(f=>f.id===t.moveReference.id),regions=owner.sketch.outlines.map(r=>({points:r.map(p=>window.ExteriorGeometry.local(frame,world(owner,p)))})),obstacles=owner.faces.filter(f=>f!==moving&&(f.feature||f.boundaryHole)&&!f.solidId&&!deleted(owner,f));
  for(const region of regions)region.holes=obstacles.map(f=>f.points.map(p=>window.ExteriorGeometry.local(frame,world(owner,p))));
  const fit=W.boundedTranslation(t.face.points.map(p=>window.ExteriorGeometry.local(frame,p)),regions,{x:dx,y:dy},{axis:t.moveMode===1?'x':t.moveMode===2?'y':null});if(fit){dx=fit.x;dy=fit.y;t.amount=t.moveMode===1?dx:dy;}
  const previous=copy(host.state().wallEdits),priorSelection=selectedRegion&&copy(selectedRegion);host.state().wallEdits=copy(t.before);host.state().wallEdits.$drafts=copy(t.sceneDrafts);
  try{const d=all()[t.moveReference.key],f=d.faces.find(f=>f.id===t.moveReference.id),points=t.face.points.map(p=>toLocal(d,{x:p.x+frame.u.x*dx+frame.v.x*dy,y:p.y+frame.u.y*dx+frame.v.y*dy,z:p.z+frame.u.z*dx+frame.v.z*dy})),next=editRegion(d,f,points);t.changed=Math.hypot(dx,dy)>1e-7;t.invalid=false;t.previewCap={...t.face,points:next.points.map(p=>world(d,p))};moveModeStatus();}catch(error){host.state().wallEdits=previous;selectedRegion=priorSelection;t.invalid=true;host.message(error.message+' Shift the pointer or press Escape.');}host.redraw();
 }
 function finishAxisCut(){if(tool?.kind!=='axisCut')return false;if(!tool.valid)return false;const t=tool;try{host.commit(t.before);tool=null;}catch(error){host.state().wallEdits=copy(t.before);tool=null;host.message('Cut not created: '+error.message);}host.redraw();return true;}
 function axisCut(k){if(tool?.kind==='axisCut'&&tool.axis===k){tool.index=(tool.index+1)%tool.variants.length;previewAxisCut();return true;}const d=current(),n=d&&picked.length===1&&d.sketch.nodes.find(n=>n.id===picked[0]);return n?cutFromPoint(world(d,n),k):false;}
 function cutFromPoint(p,k,preferredBase=null){
  if(tool)return false;
  const before=copy(host.state().wallEdits||{});
  try{return buildAxisCut(p,k,preferredBase);}catch(error){host.state().wallEdits=before;tool=null;host.message('Cut not created: '+error.message);host.redraw();return true;}
 }
 function cutFromPoints(points,k,preferredBase=null){
  if(points.length===1)return cutFromPoint(points[0],k,preferredBase);if(tool||!points.length)return false;
  const before=copy(host.state().wallEdits||{}),selection=copy({picked,draftSelection,solidPoints,selectedBasePoints}),priorDraft=activeDraftKey;
  try{const starts=[...new Map(points.map(p=>[W.vertexKey(p),p])).values()],groups=starts.map(p=>buildAxisCut(p,k,preferredBase,true)),valid=groups.filter(g=>g.length),skipped=groups.length-valid.length;
   if(!valid.length){host.state().wallEdits=before;host.message('No '+(k==='v'?'vertical':'horizontal')+' cuts fit the selected points.');host.redraw();return true;}
   const count=Math.max(...valid.map(g=>g.length)),variants=Array.from({length:count},(_,i)=>valid.map(g=>g[i%g.length]));if(count>1)variants.push(valid.flat());
   tool={kind:'axisCut',external:true,axis:k,before,base:copy(before.$base||host.state().base),preparedEdits:copy(host.state().wallEdits),starts:copy(starts),start:copy(starts[0]),selection,priorDraft,index:0,variants,pointCount:valid.length,skipped};previewAxisCut();return true;
  }catch(error){host.state().wallEdits=before;tool=null;host.message('Cuts not created: '+error.message);host.redraw();return true;}
 }
 function buildAxisCut(p,k,preferredBase=null,collectOnly=false){
  const A=window.WallAxisCuts;if(!A||tool)return false;const before=copy(host.state().wallEdits||{}),base=copy(before.$base||host.state().base),candidates=[];
  const containsCutPoint=(face,p)=>G.contains(face,p)||[face.points,...(face.holes||[])].some(r=>r.some((a,i)=>onSegment({...p,z:0},{...a,z:0},{...r[(i+1)%r.length],z:0},1e-5)));
  // Candidate discovery is read-only outside the faces incident to this point.
  const cutWalls=walls(),previousWalls=renderWalls;renderWalls=cutWalls;
  try{for(const w of cutWalls){const face={points:[...w.bottom,...w.top.slice().reverse()]},fr=W.faceFrame(face);if(!fr)continue;const local=W.inFrame(fr,p);if(Math.abs((p.x-fr.origin.x)*fr.n.x+(p.y-fr.origin.y)*fr.n.y+(p.z-fr.origin.z)*fr.n.z)<.002&&containsCutPoint({points:face.points.map(q=>W.inFrame(fr,q))},local))ensure(w);}}finally{renderWalls=previousWalls;}
  for(const f of solids().filter(f=>!f.deleted&&!f.drafted&&!f.trim&&f.feature?.type!=='trim')){const fr=W.faceFrame(f);if(fr&&Math.abs(fr.n.z)<1e-5&&Math.abs((p.x-fr.origin.x)*fr.n.x+(p.y-fr.origin.y)*fr.n.y+(p.z-fr.origin.z)*fr.n.z)<.002&&containsCutPoint({points:f.points.map(q=>W.inFrame(fr,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(fr,q)))},W.inFrame(fr,p)))solidDraft(f);}
  for(const [key,d]of Object.entries(all()))for(const f of d.faces.filter(f=>!f.solidId&&!deleted(d,f)&&!f.trim&&f.feature?.type!=='trim')){const face={points:f.points.map(q=>world(d,q)),holes:(f.holes||[]).map(r=>r.map(q=>world(d,q)))},n=W.normal(face.points);if(!n||Math.abs(n.z)>1e-5||Math.abs((p.x-face.points[0].x)*n.x+(p.y-face.points[0].y)*n.y+(p.z-face.points[0].z)*n.z)>.002||!containsCutPoint(f,toLocal(d,p)))continue;const graph=stickerSnapGeometry({points:d.sketch.nodes.map(q=>world(d,q)),lines:new Map(d.sketch.edges.map(e=>[e.id,[e.a,e.b].map(id=>world(d,d.sketch.nodes.find(n=>n.id===id)))]))},d.faces.filter(f=>!deleted(d,f)).map(f=>({...f,points:f.points.map(q=>world(d,q)),holes:(f.holes||[]).map(r=>r.map(q=>world(d,q)))}))),targets=A.wall(face,p,k,[...graph.lines.values()],graph.points);if(targets.length)candidates.push({key,face:f.id,feature:!!f.feature,targets});}
  if(k==='h'&&base){S.ensure(base);for(const f of base.faces){const fr=W.faceFrame(f);if(!fr||Math.abs((p.x-fr.origin.x)*fr.n.x+(p.y-fr.origin.y)*fr.n.y+(p.z-fr.origin.z)*fr.n.z)>.002)continue;const local=q=>W.inFrame(fr,q),face={points:f.points.map(local)},origin=A.boundaryPoint(face,local(p));if(!containsCutPoint(face,origin))continue;let direction;try{direction=A.perpendicular(face,origin);}catch{continue;}const nodes=base.sketch.nodes.map(n=>{const q=f.points.find(q=>q.nodeId===n.id);return q?{...n,z:q.z}:n;}).filter(n=>Math.abs((n.x-fr.origin.x)*fr.n.x+(n.y-fr.origin.y)*fr.n.y+(n.z-fr.origin.z)*fr.n.z)<.002),byId=id=>nodes.find(n=>n.id===id),edges=base.sketch.edges.map(e=>[byId(e.a),byId(e.b)]).filter(e=>e.every(Boolean)),targets=A.targets(face,origin,direction,edges.map(e=>e.map(local)),nodes.map(local),.001).map(q=>W.fromFrame(fr,q));if(targets.length)candidates.push({base:true,face:f.id,start:W.fromFrame(fr,origin),targets});}}
  const trimCorner=Object.values(all()).some(d=>d.faces.some(f=>f.feature?.trim&&f.points.some((q,i)=>{const a=f.points[(i+f.points.length-1)%f.points.length],b=f.points[(i+1)%f.points.length];return distance3(world(d,q),p)<1e-5&&Math.abs((q.x-a.x)*(b.y-q.y)-(q.y-a.y)*(b.x-q.x))>1e-7;})));
  candidates.sort((a,b)=>(trimCorner?1:-1)*(Number(!!a.feature)-Number(!!b.feature))||Number(b.base?b.face===preferredBase:b.key===preferredDraft&&b.face===preferredRegion)-Number(a.base?a.face===preferredBase:a.key===preferredDraft&&a.face===preferredRegion)||(k==='v'?Math.max(...b.targets.map(q=>q.z))-Math.max(...a.targets.map(q=>q.z)):0));
  if(collectOnly)return candidates.map(c=>({...c,start:c.start||copy(p)}));
  if(!candidates.length){host.state().wallEdits=before;host.message('No '+(k==='h'?'horizontal or base':'vertical')+' cut fits from this point.');return true;}
  const variants=candidates.map(c=>[c]);if(candidates.length>1)variants.push(candidates);tool={kind:'axisCut',external:true,axis:k,before,base,preparedEdits:copy(host.state().wallEdits),start:copy(p),source:picked[0],index:0,variants,priorDraft:activeDraftKey};previewAxisCut();return true;
 }
 // Importing a solid creates a draft AND marks its backing surface drafted.
 // Preview/cycling must restore both together or the unsplit solid covers the cut.
 function previewAxisCut(){const t=tool;host.state().wallEdits=copy(t.preparedEdits);t.lines=[];try{for(const c of t.variants[t.index]){if(c.base){const base=host.state().wallEdits.$base||copy(t.base),start=S.add(base,c.start||t.start,.001);for(const p of c.targets){const end=S.add(base,p,.001);if(end!==start)S.connect(base,[start,end]);t.lines.push([c.start||t.start,p]);}host.state().wallEdits.$base=base;}else{const d=all()[c.key],old=copy(d.faces),start=add(d,toLocal(d,c.start||t.start));for(const p of c.targets){const end=add(d,toLocal(d,p));if(end!==start)S.connect(d,[start,end]);t.lines.push([c.start||t.start,p]);}restoreMovedRegions(d,old);classify(d);}}const normalized=copy(host.state().wallEdits);window.ExteriorModel?.validateEdits(normalized,t.before);host.state().wallEdits=normalized;t.valid=true;const choices=t.variants[t.index];host.message((t.axis==='v'?'Vertical':'Horizontal')+(t.pointCount?' cuts from '+t.pointCount+' points'+(t.skipped?' ('+t.skipped+' without a valid cut)':''): ' cut')+': '+(choices.length>1?'all adjoining faces':choices[0].base?'base face':'wall face')+' · '+t.axis.toUpperCase()+' cycles; click to place; Escape cancels.');}catch(error){host.state().wallEdits=copy(t.before);t.valid=false;tool=null;host.message('Cut not created: '+error.message);}host.redraw();}
 function pointNudgePlan(source,e,step,lines){
  const sx=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0,sy=e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0,a=host.screen(source,'3d'),candidates=[];
  for(const pair of lines)if(onSegment(source,...pair))for(const end of pair){const length=distance3(source,end);if(length<1e-5)continue;const b=host.screen(end,'3d'),pixels=Math.hypot(b.x-a.x,b.y-a.y);if(pixels<1e-5)continue;const score=((b.x-a.x)*sx+(b.y-a.y)*sy)/pixels;if(score>.2)candidates.push({end,length,score});}
  candidates.sort((a,b)=>b.score-a.score||a.length-b.length);const c=candidates[0];if(!c)return null;
  const direction={x:(c.end.x-source.x)/c.length,y:(c.end.y-source.y)/c.length,z:(c.end.z-source.z)/c.length},amount=Math.min(step,c.length),point={x:source.x+direction.x*amount,y:source.y+direction.y*amount,z:source.z+direction.z*amount};
  return {source,point,direction,amount};
 }
 function nudgePoints(e,step,points){
  const lines=[...sceneLines().lines.values()],plans=points.map(p=>pointNudgePlan(p,e,step,lines));
  if(!plans.some(Boolean)){host.message('No connected line runs in that screen direction.');return true;}
  // Compute every destination before editing, then update shared vertices once.
  // Sequential nudges can otherwise move a point twice when it lands on another
  // selected point's old position, and produce multiple undo records.
  const moving=plans.filter(Boolean),curveMoves=moving.flatMap(plan=>{
   const owner=Object.entries(all()).find(([,d])=>d.sketch.edges.some(e=>e.curveId&&[e.a,e.b].some(id=>{const n=d.sketch.nodes.find(n=>n.id===id);return n&&distance3(world(d,n),plan.source)<1e-5;})));
   if(!owner)return [];const [key,d]=owner,n=d.sketch.nodes.find(n=>distance3(world(d,n),plan.source)<1e-5),a=toLocal(d,plan.source),b=toLocal(d,plan.point);
   return [{plan,key,id:n.id,delta:{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}}];
  }),ok=transaction(()=>{
   for(const move of curveMoves){const d=all()[move.key];S.move(d,[move.id],move.delta,{boundary:true});classify(d);}
   const straight=moving.filter(plan=>!curveMoves.some(m=>m.plan===plan));if(!straight.length)return;
   const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),base=copy(host.state().wallEdits.$base||host.state().base);
   if(base)for(const f of base.faces)scene.push({...copy(f),id:'base:'+f.id,baseId:f.id});
   const result=W.slideLines(scene,straight.map(p=>[p.source,p.source]),{x:0,y:0,z:0},1,{pointMoves:straight.map(p=>({from:p.source,to:p.point}))}),edits=copy(host.state().wallEdits);
   applyLineResult({base,scene,op:Date.now()},result,edits);host.state().wallEdits=edits;
  });
  if(ok){selectPlacedEntity({source:points[0],preview:points.map((p,i)=>plans[i]?.point||p)},false);host.redraw();}return true;
 }
 function nudgePoint(e,step){
  const source=selectedWorldPoints()[0];if(!source)return false;
  const plan=pointNudgePlan(source,e,step,sceneLines().lines.values());if(!plan){host.message('No connected line runs in that screen direction.');return true;}
  const {point,direction,amount}=plan;
  const owner=Object.entries(all()).find(([,d])=>d.sketch.edges.some(e=>e.curveId&&[e.a,e.b].some(id=>{const n=d.sketch.nodes.find(n=>n.id===id);return n&&distance3(world(d,n),source)<1e-5;})));
  if(owner){const [key,d]=owner,id=d.sketch.nodes.find(n=>distance3(world(d,n),source)<1e-5).id,a=toLocal(d,source),b=toLocal(d,point);const ok=transaction(()=>{const d=all()[key];S.move(d,[id],{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},{boundary:true});classify(d);});if(ok){selectPlacedEntity({source,preview:[point]},false);host.redraw();}return true;}
  const ok=transaction(()=>{const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),base=copy(host.state().wallEdits.$base||host.state().base);if(base)for(const f of base.faces)scene.push({...copy(f),id:'base:'+f.id,baseId:f.id});
   const result=W.slideLines(scene,[[source,source]],direction,amount),edits=copy(host.state().wallEdits);applyLineResult({base,scene,op:Date.now()},result,edits);host.state().wallEdits=edits;
  });
  if(ok){selectPlacedEntity({source,preview:[point]},false);host.redraw();}return true;
 }
 function nudge(...args){if(!window.ExteriorPerf?.enabled)return perf_nudge.apply(this,args);return window.ExteriorPerf.measure('Nudge',()=>perf_nudge.apply(this,args));}
 function completePointGeometry(points){
  if(points.length<3)return false;
  if(curveGeometrySelection(points))return true;
  const selected=p=>points.some(q=>distance3(p,q)<=window.ExteriorGeometry.CONTACT);
  return solids().some(f=>!f.deleted&&!f.drafted&&f.points.every(selected))||Object.values(all()).some(d=>d.faces.some(f=>!f.solidId&&!f.boundaryHole&&!deleted(d,f)&&f.points.every(p=>selected(world(d,p)))));
 }
function perf_nudge(e){const step=(e.altKey ? .25 : e.shiftKey ? 6 : 1)*F.FT/12*(e.nudgeCount||1),dx=e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,dy=e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0;const points=selectedWorldPoints();if(points.length&&!selectedFaceRefs().length&&!completePointGeometry(points))return points.length===1?nudgePoint(e,step):nudgePoints(e,step,points);if(geometrySelectionPoints().length>=3)return nudgeGeometry(dx,dy);if(points.length)return points.length===1?nudgePoint(e,step):nudgePoints(e,step,points);const selection=featureSelection();
  if(lineSelection.length){const pairs=copy(lineSelection);return transaction(()=>{
    for(const w of walls())ensure(w);
    const live=(d,f)=>!f.solidId&&!f.boundaryHole&&!deleted(d,f),supports=(face,pair)=>{if(W.sharedIntervals(...pair,[face]).length)return true;const frame=W.faceFrame(face);if(!frame)return false;const local={points:face.points.map(p=>W.inFrame(frame,p)),holes:(face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))};return pair.every(p=>{const q=W.inFrame(frame,p);return Math.abs(q.z)<1e-5&&G.contains(local,q);});},shape=(d,f)=>({points:f.points.map(p=>world(d,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(d,p)))}),matches=d=>d&&!d.mergedInto&&pairs.every(l=>d.faces.some(f=>live(d,f)&&supports(shape(d,f),l.pair)));
    // A preferred draft may have been consumed by a move or extrusion. Resolve
    // ownership from live geometry instead of dereferencing its missing face.
    let d=[selection?.d,all()[preferredDraft],...Object.values(all())].find(matches);
    if(!d){const solid=solids().find(f=>!f.deleted&&!f.drafted&&pairs.every(l=>supports(f,l.pair)));if(solid)d=solidDraft(solid);}
    const face=d?.faces.find(f=>live(d,f)&&pairs.some(l=>supports(shape(d,f),l.pair)));
    if(!face)throw Error('Select a line on an editable face.');
    const frame=F.viewFrame(face.points.map(p=>world(d,p)),p=>host.screen(p,'3d')),delta={x:frame.u.x*dx+frame.v.x*dy,y:frame.u.y*dx+frame.v.y*dy,z:frame.u.z*dx+frame.v.z*dy};
    const segments=pairs.map(l=>l.pair),scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),owner=planarLineOwner(scene,segments);
    let movedPairs;if(owner===draftKey(d))movedPairs=moveDraftLines(d,segments,delta);
    else{const result=W.slideLines(scene,segments,delta,1),edits=copy(host.state().wallEdits);applyLineResult({scene,op:Date.now()},result,edits);host.state().wallEdits=edits;movedPairs=result.pairs;}
    lineSelection=movedPairs.map(pair=>({pair,id:W.edgeKey(...pair)}));preferredDraft=draftKey(d);
   });}
  if(!selection)return false;return transaction(()=>{const {d,f,points}=asDraft(selection),frame=F.viewFrame(points,p=>host.screen(p,'3d')),next=points.map(p=>toLocal(d,{x:p.x+frame.u.x*dx+frame.v.x*dy,y:p.y+frame.u.y*dx+frame.v.y*dy,z:p.z+frame.u.z*dx+frame.v.z*dy}));editRegion(d,f,next);});
 }


 function planarLineOwner(scene,pairs){
  const owners=scene.filter(f=>!f.deleted&&[...f.points,...(f.holes||[]).flat(),...(f.retainedPoints||[])].some(p=>pairs.some(pair=>onSegment(p,...pair))));
  const keys=new Set(owners.map(f=>f.draftKey));if(keys.size!==1||keys.has(undefined))return null;
  const key=[...keys][0],d=all()[key];return d&&!d.faces.some(f=>f.solidId||f.feature)&&!d.sketch.curves?.length?key:null;
 }
 function nudgeLineMove(e){
  const t=tool,step=(e.altKey?.25:e.shiftKey?6:1)*F.FT/12,axis=t.screenAxis,sx=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0,sy=e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0,dot=axis.x*sx+axis.y*sy;
  if(Math.abs(dot)<1e-6){host.message('Use the arrow keys along the selected movement direction.');return true;}
  t.numeric=(t.amount||0)+Math.sign(dot)*step;previewLineMove(mouse);
  if(!t.invalid){host.commit(t.before);tool=null;host.redraw();}return true;
 }
 // Planar line editing changes the shared graph once, then derives its faces.
 // Neither movement method clips to the old outline; that outline is an output.
 function moveDraftLines(d,pairs,delta){
  S.nodeLines(d);const before=copy(d.faces),moves=new Map(),profileMoves=new Set(),source=new Map(d.sketch.nodes.map(n=>[n.id,{...n}]));
  const boundaries=d.sketch.edges.filter(e=>e.fixed&&!e.curveId).map(e=>[source.get(e.a),source.get(e.b)]);
  const heights=x=>boundaries.flatMap(([a,b])=>{if(Math.abs(b.x-a.x)<1e-8)return [];const t=(x-a.x)/(b.x-a.x);return t>=-1e-7&&t<=1+1e-7?[a.y+(b.y-a.y)*t]:[];});
  for(const n of d.sketch.nodes){const p=world(d,n);if(!pairs.some(pair=>onSegment(p,...pair)))continue;
   const q=toLocal(d,{x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z});
   // Horizontal divider motion follows its existing wall profile. At a slope
   // transition the new endpoint is evaluated on that segment, not translated
   // at the former height. Outside the finite profile, free drawing still works.
   if(Math.abs(q.y-n.y)<1e-7&&Math.abs(q.x-n.x)>1e-8&&pairs.some(pair=>onSegment(p,...pair)&&Math.abs(pair[0].z-pair[1].z)>1e-5)){
    const from=heights(n.x),to=heights(q.x);
    const divider=d.sketch.edges.some(e=>!e.fixed&&[e.a,e.b].includes(n.id)&&pairs.some(pair=>[source.get(e.a),source.get(e.b)].every(p=>onSegment(world(d,p),...pair))));
    if(divider&&from.length&&to.length){if(Math.abs(n.y-Math.max(...from))<1e-5){q.y=Math.max(...to);profileMoves.add(n.id);}else if(Math.abs(n.y-Math.min(...from))<1e-5){q.y=Math.min(...to);profileMoves.add(n.id);}}
   }
   moves.set(n.id,q);
  }
  if(!moves.size)throw Error('The selected line no longer belongs to this face. Select it again.');
  // Slide the attachment through the existing boundary graph. Moving its old
  // incident edges would cut across a roof corner when crossing into the next
  // segment. Keep real corners; dissolve only the old collinear attachment.
  for(const id of profileMoves){const incident=d.sketch.edges.filter(e=>e.fixed&&[e.a,e.b].includes(id)),n=source.get(id),ends=incident.map(e=>source.get(e.a===id?e.b:e.a));
   if(incident.length===2&&Math.abs((ends[0].x-n.x)*(ends[1].y-n.y)-(ends[0].y-n.y)*(ends[1].x-n.x))<1e-7){
    d.sketch.edges=d.sketch.edges.filter(e=>!incident.includes(e));d.sketch.edges.push({...incident[0],id:'e'+(++d.sketch.next),a:ends[0].id,b:ends[1].id});
   }else if(incident.length){const anchor={...n,id:'p'+(++d.sketch.next),userDraftPoint:false};d.sketch.nodes.push(anchor);for(const e of incident){if(e.a===id)e.a=anchor.id;if(e.b===id)e.b=anchor.id;}}
  }
  for(const n of d.sketch.nodes)if(moves.has(n.id))Object.assign(n,moves.get(n.id));
  if(profileMoves.size)S.nodeLines(d);
  S.resolve(d);restoreMovedRegions(d,before);classify(d);
  const translate=p=>{const node=[...source.values()].find(n=>distance3(world(d,n),p)<1e-5),q=node&&moves.get(node.id);return q?world(d,q):{x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z};};
  return pairs.map(pair=>pair.map(translate));
 }

 function nudgeGeometry(dx,dy){
  if(!geometryCommand('m')||tool?.kind!=='geometryTransform')return false;
  const t=tool,frame=t.clip.mounts[t.mount].frame,plane=workingPlane?.frame;
  // A construction frame can begin on any edge (or diagonal). Reorient movement
  // upright on that plane and toward the viewed side, without changing its geometry.
  const points=plane?[plane.origin,...[plane.u,plane.v].map(axis=>({x:plane.origin.x+axis.x,y:plane.origin.y+axis.y,z:plane.origin.z+axis.z}))]:t.clip.faces[0]?.points||t.clip.points;
  const view=F.viewFrame(points,p=>host.screen(p,'3d'));
  const delta={x:view.u.x*dx+view.v.x*dy,y:view.u.y*dx+view.v.y*dy,z:view.u.z*dx+view.v.z*dy};
  const dot=axis=>delta.x*axis.x+delta.y*axis.y+delta.z*axis.z;
  previewGeometry(mouse||{clientX:0,clientY:0,buttons:0},false,{x:dot(frame.u),y:dot(frame.v)});
  if(t.invalid){host.state().wallEdits=t.before;tool=null;host.redraw();return true;}
  return placeGeometry();
 }
 function finishTrim(){if(tool?.kind!=='trim'||!tool.valid)return false;host.commit(tool.before);tool=null;lineSelection=[];pickedLines=[];solidEdges=[];picked=[];solidPoints=[];host.message('Trim placed.');host.redraw();return true;}
 function previewTrim(){const t=tool;host.state().wallEdits=copy(t.prepared);try{
  const result=window.WallTrim.partition(t.scene,t.pairs,t.variant,t.width,t.segments,t.finishColor,t.materialOptions);if(!result.replacements.length)throw Error('Select a straight line on a wall face for trim.');
  const edits=host.state().wallEdits;
  for(const {face,pieces}of result.replacements){
   if(face.draft){const region=all()[face.draftKey]?.faces.find(f=>f.id===face.regionId);if(region)region.solidId='trim:'+face.id;}
   else edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==face.id);
   edits.$surfaces=[...(edits.$surfaces||[]),...pieces];
  }
  t.valid=true;host.message('Trim '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((t.width/.3048), 'ft') : (t.width/.3048).toFixed(2)+" ft")+" · "+(result.corner?'both walls':['first side','opposite side','centered'][t.variant])+' · T cycles sides; type width; click to place; Escape cancels.');
 }catch(error){host.state().wallEdits=copy(t.prepared);t.valid=false;host.message(error.message);}host.redraw();}
 function autoTrim(width=window.WallTrim?.defaultWidth){
  if(!Number.isFinite(width)||width<=0)return false;
  if(tool&&!finishToolForSwitch())return false;if(!window.WallTrim)return false;
  const before=copy(host.state().wallEdits||{});
  try{
   const state=host.state(),scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted),visible=scene.flatMap(f=>window.WallChimneys?.visibleParts(f,state)||[f]);
   const pairs=window.WallTrim.candidates(visible,{roof:state.roof,base:state.wallEdits.$base||state.base,ground:state.ground});
   if(!pairs.length){state.wallEdits=before;host.message('No untrimmed exterior corners found.');host.redraw();return false;}
   tool={kind:'trim',before,prepared:copy(state.wallEdits),scene:copy(scene),pairs,segments:pairs,variant:0,width};previewTrim();
   if(!tool.valid){state.wallEdits=before;tool=null;host.redraw();return false;}
   window.ExteriorModel.validateEdits(state.wallEdits,before);finishTrim();selectedSolid=null;selectedRegion=null;host.message('Auto trim applied to '+pairs.length+' corner runs.');return true;
  }catch(error){host.state().wallEdits=before;tool=null;host.message(error.message);host.redraw();return false;}
 }
 function removeSelectedTrim(pairs=null){
  const selected=selectedFinishFace();if(!pairs&&!selected?.trim)return false;
  const before=copy(host.state().wallEdits||{});
  try{
   const source=moveScene().filter(f=>!f.snapOnly&&!f.deleted),supports=Object.entries(all()).flatMap(([key,d])=>d.faces.filter(f=>f.solidId?.startsWith('trim:')).map(f=>({...f,id:f.solidId.slice(5),points:f.points.map(p=>world(d,p)),holes:(f.holes||[]).map(r=>r.map(p=>world(d,p)))}))),scene=window.WallTrim.adoptLegacy(source,supports),face=selectedSolid?scene.find(f=>f.id===selectedSolid):scene.find(f=>f.draftKey===selectedRegion?.draft&&f.regionId===selectedRegion?.face),result=pairs?window.WallTrim.removeEdges(scene,pairs):window.WallTrim.remove(scene,face);
   if(!result)throw Error('The selected trim source could not be found.');const edits=host.state().wallEdits;
   for(const {face,pieces}of result.replacements){if(face.draft){const region=all()[face.draftKey]?.faces.find(f=>f.id===face.regionId);if(region)region.solidId='untrim:'+face.id;}else edits.$surfaces=(edits.$surfaces||[]).filter(f=>f.id!==face.id);edits.$surfaces=[...(edits.$surfaces||[]),...pieces];}
   window.ExteriorModel.validateEdits(edits,before);host.commit(before);selectedSolid=null;selectedRegion=null;draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];
   lineSelection=result.pairs.map(pair=>({id:W.edgeKey(...pair),pair}));host.message('Trim removed. Source line selected; T reapplies trim and cycles sides.');host.redraw();return true;
  }catch(error){host.state().wallEdits=before;host.message(error.message);host.redraw();return true;}
 }
 function selectedTrimPairs(){
  const d=current(),graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),byId=id=>nodesById.get(id),pairs=[...lineSelection.map(l=>l.pair),...solidEdges.map(id=>graph.edges.find(e=>e.id===id)).filter(Boolean).map(e=>[byId(e.a),byId(e.b)]),...(d?pickedLines.map(id=>d.sketch.edges.find(e=>e.id===id)).filter(e=>e&&!e.curveId).map(e=>[world(d,d.sketch.nodes.find(n=>n.id===e.a)),world(d,d.sketch.nodes.find(n=>n.id===e.b))]):[])];return pairs;
 }
 function trimMaterials(){return [...new Set(window.ExteriorModel.collect(host.state(),walls()).filter(f=>!f.deleted&&!f.feature).map(f=>window.WallTrim.materialKey(f,host.state()?.finishDefaults)))].sort();}
 function selectTrimEdges(kind,materials){
  if(tool&&!finishToolForSwitch())return false;
  const state=host.state(),original=state.wallEdits;let scene;try{state.wallEdits=copy(original);scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted);}finally{state.wallEdits=original;}const visible=scene.flatMap(f=>window.WallChimneys?.visibleParts(f,state)||[f]);
  const options={roof:state.roof,base:state.wallEdits.$base||state.base,ground:state.ground,materials,defaults:state.finishDefaults};
  const pairs=window.WallTrim.selectionPairs(visible,kind,options);
  const segments=[...sceneLines().lines.values()].flatMap(([a,b])=>W.sharedIntervals(a,b,pairs.map(points=>({points}))).map(([lo,hi])=>[lo,hi].map(t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}))));
  lineSelection=[...new Map([...(kind.endsWith('-untrimmed')?[]:selectedTrimPairs()),...segments].map(pair=>[W.edgeKey(...pair),{id:W.edgeKey(...pair),pair:copy(pair)}])).values()];
  pickedLines=[];solidEdges=[];host.select(null);host.message(lineSelection.length+' trim lines selected');host.redraw();return true;
 }
 function applyTrim(width=window.WallTrim.defaultWidth,finishColor,external=[],materials){
  if(tool&&!finishToolForSwitch())return false;
  const pairs=[...selectedTrimPairs(),...external];if(!pairs.length){host.message('Select wall or ground edges for trim.');return false;}
  const before=copy(host.state().wallEdits||{});
  try{const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted);tool={kind:'trim',before,prepared:copy(host.state().wallEdits),scene:copy(scene),pairs:copy(pairs),segments:copy(pairs),variant:0,width,finishColor,materialOptions:{materials,defaults:host.state().finishDefaults}};previewTrim();
   if(!tool.valid)throw Error('No selected edges touch the enabled trim materials.');
   window.ExteriorModel.validateEdits(host.state().wallEdits,before);return finishTrim();
  }catch(error){host.state().wallEdits=before;tool=null;host.message(error.message);host.redraw();return false;}
 }
 function nextStickerTrim(feature){const inches=(feature.trim?.width||0)/.0254,index=F.trimSizes.findIndex(n=>Math.abs(n-inches)<1e-6);return F.setTrim(feature,F.trimSizes[(index+1)%F.trimSizes.length],feature.trim?.color||host.state()?.finishDefaults?.trimColor||'#f5f3ef');}
 function cycleStickerTrim(){
  const refs=selectedStickers().filter(({f})=>F.supportsTrim(f.feature?.type));if(!refs.length)return false;
  return transaction(()=>{for(const {f}of refs){f.feature=nextStickerTrim(f.feature);}host.message('Sticker trim updated; T cycles off, 2, 3, 4 and 6 inches.');});
 }
 function trimCommand(){
  if(!tool&&cycleStickerTrim())return true;
  if(tool?.kind==='trim'){tool.variant=(tool.variant+1)%3;previewTrim();return true;}if(tool||!window.WallTrim)return false;if(removeSelectedTrim())return true;
  const pairs=selectedTrimPairs();if(!pairs.length)return false;
  const before=copy(host.state().wallEdits);try{const scene=moveScene().filter(f=>!f.snapOnly&&!f.deleted);tool={kind:'trim',before,prepared:copy(host.state().wallEdits),scene:copy(scene),pairs:copy(pairs),segments:copy([...sceneLines().lines.values()]),variant:0,width:window.WallTrim.defaultWidth};previewTrim();}catch(error){host.state().wallEdits=before;tool=null;host.message(error.message);}return true;
 }
 function selectedStickerHeightInput(){
  if(selectedFaceRefs().length!==1)return null;
  const ref=featureSelection();if(!ref?.feature||!mouse)return null;
  const dimensions=F.dimensions(ref.points,ref.feature),frame=dimensions.frame;
  const top=ref.points.filter(p=>Math.abs(W.inFrame(frame,p).y-dimensions.bounds.top)<1e-5).sort((a,b)=>W.inFrame(frame,a).x-W.inFrame(frame,b).x);
  if(top.length<2)return null;
  const token=ref.f||ref.solid;
  return {token,axis:0,label:'Height',amount:dimensions.height*F.FT,set(value){
   if(value==null)return;
   if(!tool&&!beginLineMove(false,{pair:[top[0],top.at(-1)],event:mouse}))return;
   if(tool?.kind!=='lineMove'||!tool.dimension)return;
   tool.inputToken=token;distanceInput().set(value);
  }};
 }
 function distanceInput(){if(workingPlane&&tool?.kind==='geometryTransform'&&['m','r'].includes(tool.editMode)){const t=tool;return {token:t.inputToken||t,unit:t.editMode==='r'?'degrees':undefined,unitsPerInput:t.editMode==='r'?1:undefined,label:t.editMode==='r'?'Rotation':'Distance',allowZero:true,amount:t.numeric||0,set(value){flushPreview();if(tool!==t)return;t.numeric=value;if(mouse)previewGeometry(mouse);}};}if(tool?.kind==='divide'){const t=tool;return {token:t.inputToken||t,label:t.orientation==='horizontal'?'Divide from top':'Divide from left',amount:t.amount,allowZero:true,set(value){if(tool!==t)return;t.numeric=value;previewDivision(mouse);}};}if(tool?.kind==='multiExtrude'){const t=tool;return {token:t,label:'Extrusion (each face)',amount:t.amount,allowZero:true,set(value){flushPreview();if(tool!==t)return;t.numeric=value;if(mouse)runPointer(mouse);}};}if(tool?.kind==='geometryTransform'&&tool.stickerMove&&tool.editMode==='m'){const t=tool;return {token:t.inputToken||t,label:['Distance','Left/Right','Up/Down','In/Out'][t.moveAxis||0],amount:t.numeric||0,allowZero:true,set(value){if(tool!==t)return;if(value!==null&&!t.moveAxis)t.moveAxis=1;t.numeric=value;geometryStatus();if(mouse)previewGeometry(mouse);}};}if(workingPlane?.rotation){const r=workingPlane.rotation;return {token:r,axis:r.axisIndex,unit:'degrees',unitsPerInput:1,allowZero:true,label:'Plane angle',amount:r.angle,set(value){if(workingPlane?.rotation!==r)return;r.numeric=value;r.snap=null;if(value!==null)updatePlaneRotation(value);host.redraw();}};}if(!tool)return selectedStickerHeightInput();if(tool?.kind==='trim'){const t=tool;return {token:t,label:'Trim width',unit:'inches',unitsPerInput:.0254,amount:t.width,set(value){if(value!=null&&value>0){t.width=value;previewTrim();}}};}if(!tool||!['extrude','lineMove','entityExtrude','chamfer'].includes(tool.kind))return null;const t=tool;if(t.kind==='lineMove'&&t.dimension){const d=t.dimension;return {token:t.inputToken||t,axis:t.planeIndex,label:d.label,amount:((t.amount||0)-d.opposite)*d.sign,set(value){flushPreview();if(tool!==t)return;t.numeric=value==null?null:d.opposite+d.sign*value;if(mouse)runPointer(mouse);}};}const sign=t.kind==='extrude'&&!t.moveMode?(t.inwardSign||1):1;return {token:t,axis:t.kind==='lineMove'?t.inputToken:t.inputToken||0,allowZero:t.kind==='lineMove',label:t.kind==='lineMove'?(t.extrude?'Extrusion':'Move distance'):t.kind==='chamfer'?'Width':t.moveReference?moveNames[t.moveMode||0]:undefined,amount:t.kind==='chamfer'?chamferWidth(t.metrics?.[0]):t.amount==null?t.amount:t.amount*sign,set(value){flushPreview();if(tool!==t)return;if(t.moveReference&&t.moveMode===3&&value!==null){t.moveMode=1;moveModeStatus();}t.numeric=value==null?null:value*sign;if(mouse)runPointer(mouse);}};}
 function key(e){const k=e.key.toLowerCase();if(tool?.kind==='arch')return archKey(e);if(!tool&&k==='a'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.repeat)return startArch();if(tool?.kind==='lineMove'&&k.startsWith('arrow')&&!e.ctrlKey&&!e.metaKey)return nudgeLineMove(e);if(workingPlane){if(k==='p'&&!e.ctrlKey&&!e.metaKey){if(!e.repeat)togglePlane();return true;}return planeKey(e);}if(!tool&&!e.ctrlKey&&!e.metaKey&&k==='c'&&selectedWorldPoints().length>=2)return connectWorldSelection();if(k==='e'&&!e.ctrlKey&&!e.metaKey&&tool?.kind==='lineMove'&&tool.extrude){if(!e.repeat)toggleLineExtrusion();return true;}if(tool?.kind==='divide'){if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){restoreExtrusionSelection(tool);tool=null;host.redraw();return true;}if(k==='l'&&!e.ctrlKey&&!e.metaKey){if(!e.repeat){tool.orientation=tool.orientation==='horizontal'?'vertical':'horizontal';tool.numeric=null;tool.inputToken={};previewDivision(mouse);}return true;}if(k==='enter')return finishDivision();return !['shift','control','alt','meta'].includes(k);}if(!tool&&k==='l'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&startDivision())return true;if(k==='t'&&!e.ctrlKey&&!e.metaKey&&tool?.kind==='feature'&&F.supportsTrim(tool.type)){if(!e.repeat){tool.trimInches=Math.round((nextStickerTrim(F.setTrim({type:tool.type},tool.trimInches||0)).trim?.width||0)/.0254);if(mouse)previewFeature(mouse);host.redraw();}return true;}if(tool?.kind==='multiExtrude'){if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){host.state().wallEdits=copy(tool.before);restoreExtrusionSelection(tool);tool=null;clearGuides();host.redraw();return true;}if(k==='enter')return finishMultiExtrusion();if(k==='e')return true;}if(!tool&&k==='e'&&!e.ctrlKey&&!e.metaKey&&startMultiExtrusion())return true;if(k==='p'&&!e.ctrlKey&&!e.metaKey){if(!e.repeat)togglePlane();return true;}if(workingPlane&&!e.ctrlKey&&!e.metaKey)return planeKey(e);if(!tool&&k==='v'&&!e.ctrlKey&&!e.metaKey&&selectedWorldPoints().length>=3)return createSelectedFace();if(!tool&&['delete','backspace'].includes(k)&&selectedFinishFace()?.trim&&removeSelectedTrim())return true;if(tool?.kind==='trim'){if(k==='t'&&!e.repeat)trimCommand();else if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){host.state().wallEdits=tool.before;tool=null;host.redraw();}else if(k==='enter')finishTrim();return true;}if(k==='t'&&!tool&&!e.ctrlKey&&!e.metaKey&&trimCommand())return true;if(tool?.kind==='curveMove'){if(k==='escape'){host.state().wallEdits=tool.before;tool=null;host.redraw();}return true;}if(!tool&&k==='m'&&current()?.sketch.edges.some(e=>pickedLines.includes(e.id)&&e.curveId)){const d=current(),ids=[...new Set(d.sketch.edges.filter(e=>pickedLines.includes(e.id)).flatMap(e=>[e.a,e.b]))];tool={kind:'curveMove',ids,before:copy(host.state().wallEdits),start:rayPoint(d,mouse),draftKey:draftKey(d)};host.message('Move curve on its plane; click to place; Escape cancels.');return true;}if(tool?.kind==='curve'){if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){host.state().wallEdits=tool.before;tool=null;host.message('Curve preview canceled.');host.redraw();}else if(k==='f'&&typeof isFreeMove!=='undefined'){isFreeMove=!isFreeMove;previewCurve(mouse);}return true;}if(k==='s'&&!e.ctrlKey&&!e.metaKey&&!tool&&mouse&&selectedWorldPoints().length===1)return startCurve();if((e.ctrlKey||e.metaKey)&&['c','v'].includes(k))return clipboardCommand(k==='c'?'copy':'paste');if(tool?.kind==='paste'||tool?.kind==='geometryTransform')return geometryKey(e);if(k==='m'&&!e.ctrlKey&&!e.metaKey&&tool?.kind==='lineMove'){if(!e.repeat)cycleLinePlane();return true;}if(!tool&&!e.ctrlKey&&!e.metaKey&&lineSelection.length&&((k==='e'&&beginLineMove(false,null,true))||(k==='m'&&beginLineMove(false))))return true;if(!tool&&k==='r'&&!e.ctrlKey&&!e.metaKey&&(lineSelection.length||pickedLines.length||solidEdges.length||selectedWorldPoints().length===1))return chamferCommand(null,true);if(!tool&&!e.ctrlKey&&!e.metaKey&&!(k==='f'&&e.shiftKey)&&['m','r','t','y'].includes(k)&&geometrySelectionPoints().length>=3)return geometryCommand(k);
  if(tool&&e.repeat&&['m','e','c','n','q','h','v','s','w','d','u','y'].includes(k))return true;
  // Repeating Move is not a tool switch or a placement. Cycling move tools
  // handle M above/below; single-direction moves retain their original snapshot.
  if(k==='m'&&!e.ctrlKey&&!e.metaKey&&tool&&(tool.kind==='move'||tool.kind==='entityExtrude'&&tool.mode==='move'||tool.kind==='extrude'&&tool.mode==='move'&&!tool.moveReference))return true;
  const cycle=tool&&(tool.kind==='axisCut'&&['h','v'].includes(k)||tool.kind==='step'&&k==='s'||tool.kind==='extrude'&&tool.mode==='move'&&tool.moveReference&&k==='m'||tool.kind==='feature'&&['w','d','r'].includes(k));
  if(tool&&!cycle&&!e.ctrlKey&&!e.metaKey&&['m','e','c','n','q','h','v','s','w','d','u','y'].includes(k)&&!finishToolForSwitch())return true;
 if(tool?.kind==='chamfer'){if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){host.state().wallEdits=tool.before;tool=null;host.redraw();}return true;}if(!tool&&k==='c'&&!e.ctrlKey&&!e.metaKey)return chamferCommand();if(tool?.kind==='material'){if(k==='escape'){tool=null;host.message('Material painting finished.');host.redraw();return true;}if(['shift','control','alt','meta'].includes(k))return false;tool=null;}if(k==='q'&&!tool&&!e.ctrlKey&&!e.metaKey)return startQuad();if(tool?.kind==='entityExtrude'){if(k==='f'&&!e.ctrlKey&&!e.metaKey&&typeof isFreeMove!=='undefined'){if(!e.repeat){isFreeMove=!isFreeMove;if(mouse)previewEntity(mouse);}return true;}if(k==='escape'){host.state().wallEdits=tool.before;tool=null;host.redraw();}return true;}if(!tool&&!e.ctrlKey&&!e.metaKey&&['e','m'].includes(k)&&beginEntity(k==='e'?'extrude':'move'))return true;if(!tool&&selectedBasePoints.length&&['delete','backspace'].includes(k)){deleteBoxSelection();return true;}if(tool?.kind==='axisCut'){if(!e.ctrlKey&&!e.metaKey&&['h','v'].includes(k)){if(e.repeat)return true;if(k===tool.axis)return axisCut(k);const starts=copy(tool.starts||[tool.start]);if(finishAxisCut())return cutFromPoints(starts,k);return true;}if(k==='escape'||(k==='z'&&(e.ctrlKey||e.metaKey))){const t=tool;host.state().wallEdits=t.before;activeDraftKey=t.priorDraft;if(t.selection){({picked,draftSelection,solidPoints,selectedBasePoints}=copy(t.selection));}else picked=current()?.sketch?.nodes.some(n=>n.id===t.source)?[t.source]:[];tool=null;host.redraw();return true;}if(!finishAxisCut())return true;}if(k==='m'&&tool?.kind==='extrude'&&tool.mode==='move'&&tool.moveReference){cycleFaceMove(e);return true;}if(F&&!e.altKey&&['w','d','g'].includes(k)){if(e.repeat)return true;const type=k==='w'?'window':k==='g'?'garage':'door',modify=e.ctrlKey||e.metaKey||(!tool&&!!featureSelection()?.feature);if(modify){if(!featureSelection()){host.message('Select a face to set its sticker type.');return true;}if(tool?.kind==='feature')tool=null;}return featureCommand(type,undefined,!modify);}if(F&&!e.ctrlKey&&!e.metaKey){if(tool?.kind==='feature'){if(k==='escape'){tool=null;host.redraw();return true;}if(k==='r'){tool.rotated=!tool.rotated;if(mouse)previewFeature(mouse);return true;}}if(!tool&&k.startsWith('arrow'))return nudge(e);}let d=current();if(!tool&&!e.ctrlKey&&!e.metaKey&&['h','v'].includes(k)){const points=selectedWorldPoints();if(points.length)return cutFromPoints(points,k);host.message('Select one or more points to create a '+(k==='v'?'vertical':'horizontal')+' cut.');return true;}box=null;boxEl?.remove?.();boxEl=null;
  if(k==='s'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){if(!e.repeat)stepCommand();return true;}
  if(tool?.kind==='step'){if(k==='escape'||(k==='z'&&(e.ctrlKey||e.metaKey)))cancelStep();return true;}
  if(tool?.kind==='lineMove'&&k==='enter'){flushPreview();return down({...mouse,button:0});}
  if(tool?.kind==='lineMove'&&(k==='escape'||(k==='z'&&(e.ctrlKey||e.metaKey)))){host.state().wallEdits=tool.before;lineSelection=(tool.originalPairs||tool.pairs).map(pair=>({id:W.edgeKey(...pair),pair}));tool=null;host.redraw();return true;}
  if(!tool&&k==='m'&&lineSelection.length){beginLineMove();return true;}
  if(!tool&&k==='escape'&&lineSelection.length){lineSelection=[];host.redraw();return true;}
  if(!tool&&lineSelection.length&&['delete','backspace'].includes(k)){transaction(deleteLines3D);lineSelection=[];host.redraw();return true;}
  const groups=Object.entries(draftSelection).filter(([,ids])=>ids.length);
  if(!tool&&(groups.length>1||(groups.length&&solidPoints.length))){
   if(['m','y','r','n','q'].includes(k)){host.message('Select points on one face for this plane editing tool.');return true;}
   if(['c','u'].includes(k)){transaction(()=>{for(const [key,ids]of groups)if(ids.length>1)S.connect(all()[key],ids);});return true;}
   if(k==='f'&&e.shiftKey){transaction(()=>{if(solidPoints.length>=3)W.restoreSurface(host.state().wallEdits,solidPoints);for(const [key,ids]of groups){const d=all()[key],set=new Set(ids);for(const f of d.faces)if(f.points.length===set.size&&f.points.every(p=>set.has(p.nodeId)))d.deletedFaces=(d.deletedFaces||[]).filter(key=>key!==signature(f));}});return true;}
   if(['delete','backspace'].includes(k)){transaction(()=>{removeSolidPoints(solidPoints,solidEdges);for(const [key,ids]of groups){const d=all()[key];if(ids.length)removeDraftPoints(d,ids);}});draftSelection={};picked=[];solidPoints=[];host.redraw();return true;}
  }
  if(!tool&&(k==='delete'||k==='backspace')){
   if(deleteSelectedStickers())return true;
   if(!solidPoints.length&&solidEdges.length){const graph=wire(),segments=graph.edges.filter(e=>solidEdges.includes(e.id)).map(e=>[graph.nodes.find(n=>n.id===e.a),graph.nodes.find(n=>n.id===e.b)]);transaction(()=>deleteLines3D(segments));solidEdges=[];host.redraw();return true;}
   if(pickedLines.length&&d&&!d.sketch.edges.some(e=>pickedLines.includes(e.id)&&e.curveId)&&viewOf(mouse)==='3d'){const segments=draftSegments(d).filter(e=>pickedLines.includes(e.id)).map(e=>[world(d,e.start),world(d,e.end)]);transaction(()=>deleteLines3D(segments));pickedLines=[];host.redraw();return true;}
   if(solidPoints.length||solidEdges.length){transaction(()=>removeSolidPoints(solidPoints,solidEdges));solidPoints=[];solidEdges=[];host.redraw();return true;}
   if(pickedLines.length&&d){transaction(()=>{const old=copy(d.faces);S.remove(d,[],pickedLines);for(const f of d.faces){const prior=old.find(o=>signature(o)===signature(f));if(prior?.solidId)f.solidId=prior.solidId;}d.deletedFaces=(d.deletedFaces||[]).filter(key=>d.faces.some(f=>signature(f)===key));});pickedLines=[];host.redraw();return true;}
   if(selectedSolid){transaction(()=>{const f=solids().find(f=>f.id===selectedSolid);if(f)f.deleted=true;});selectedSolid=null;preferredSolid=null;host.redraw();return true;}
   if(d&&selectedRegion?.draft===currentDraftId()){transaction(()=>{const f=d.faces.find(f=>f.id===selectedRegion.face);if(f)d.deletedFaces=[...new Set([...(d.deletedFaces||[]),signature(f)])];});selectedRegion=null;host.redraw();return true;}
  }
  if(k==='f'&&e.shiftKey&&!tool&&(solidPoints.length>=3||picked.length>=3)){
   if(solidPoints.length){transaction(()=>{selectedSolid=W.restoreSurface(host.state().wallEdits,solidPoints);});solidPoints=[];host.redraw();return true;}
   if(d){transaction(()=>{const wanted=new Set(picked),faces=d.faces.filter(f=>f.points.length===wanted.size&&f.points.every(p=>wanted.has(p.nodeId)));if(!faces.length)throw Error('Select all boundary points of the face.');for(const f of faces)d.deletedFaces=(d.deletedFaces||[]).filter(key=>key!==signature(f));});host.redraw();return true;}
  }
  if(k==='f'&&tool&&typeof isFreeMove!=='undefined'){isFreeMove=!isFreeMove;if(mouse)movePointer(mouse);return true;}
  if(!tool&&solidPoints.length&&['m','y','r'].includes(k)){host.message('Select a face to move this generated geometry.');return true;}
  if((k==='y'||k==='r')&&picked.length&&d){if(tool)return true;if(picked.some(id=>d.sketch.nodes.find(n=>n.id===id)?.fixed)){host.message('Boundary points are locked');return true;}if(!mouse)return true;const originals=picked.map(id=>copy(d.sketch.nodes.find(n=>n.id===id))),center=originals.reduce((c,p)=>({x:c.x+p.x/originals.length,y:c.y+p.y/originals.length}),{x:0,y:0}),start=rayPoint(d,mouse);if(!start)return true;tool={kind:k==='y'?'scale':'rotate',before:copy(host.state().wallEdits),originals,center,start};return true;}
  if(k==='r'&&selectedSolid){const f=solids().find(f=>f.id===selectedSolid);if(f){const ps=f.points.map(p=>getVector3(host.toPixel(p))),center=ps.reduce((a,p)=>a.add(p),new THREE.Vector3()).multiplyScalar(1/ps.length),n=ps[1].clone().sub(ps[0]).cross(ps[2].clone().sub(ps[0])).normalize();if(n.dot(camera.position.clone().sub(center))<0)n.negate();const distance=camera.position.distanceTo(controls.target),damping=controls.enableDamping;try{controls.enableDamping=false;controls.update();}finally{controls.enableDamping=damping;}controls.target.copy(center);camera.position.copy(center).addScaledVector(n,distance);camera.up.set(0,Math.abs(n.y)>.99?0:1,Math.abs(n.y)>.99?-1:0);camera.lookAt(center);controls.update();}return true;}

  if((k==='escape'||(k==='z'&&(e.ctrlKey||e.metaKey)))&&tool?.kind==='extrude'){host.state().wallEdits=tool.before;selectedSolid=tool.priorSolid||null;activeDraftKey=tool.priorDraft||null;if(tool.moveReference)selectedRegion=tool.priorRegion;tool=null;clearGuides();host.redraw();return true;}
  if((k==='m'||k==='e')&&!picked.length&&mouse){let face=selectedSolid&&solids().find(f=>f.id===selectedSolid),region;
   const before=copy(host.state().wallEdits||{});
   if(!face&&d&&selectedRegion?.draft===currentDraftId()){region=d.faces.find(f=>f.id===selectedRegion.face);if(region){face=engineFace(d,region,{id:'region-'+currentDraftId()+'-'+region.id,retainedPoints:retainedRegionPoints(d,region),chimney:d.chimney&&{...copy(d.chimney),drivesFootprint:k==='m'&&!d.faces.some(f=>f!==region&&!f.boundaryHole&&!f.solidId&&!deleted(d,f))}});}}
   const wholeDraft=region&&d.frame&&!d.faces.some(f=>f!==region&&!f.boundaryHole&&!f.solidId&&!deleted(d,f));
   const supports=region?regionSupports(d,region):null;let scene=face?moveScene():null;if(region)scene=scene.map(f=>f.draftKey===currentDraftId()&&f.regionId===region.id?{...face,draft:false}:f);
   if(face){const moveReference=k==='m'&&region&&d.faces.some(f=>f!==region&&!f.boundaryHole&&!f.solidId&&!deleted(d,f))?{key:currentDraftId(),id:region.id}:null;tool={moveReference,moveMode:0,priorRegion:selectedRegion&&copy(selectedRegion),wholeDraft,mode:k==='e'?'extrude':'move',supports,scene,snapGeometry:sceneLines(),heightPoints:heightPoints(),sceneDrafts:scene?copy(all()):null,kind:'extrude',inwardSign:inwardDistanceSign(face),face:copy(face),before,priorSolid:selectedSolid,priorDraft:activeDraftKey,startX:mouse.clientX,startY:mouse.clientY,baseAmount:0,axis:extrudeAxis(face),baseFaces:copy(window.WallSolidGeometry.baseScope(face,host.state()?.wallEdits?.$base?.faces||host.state()?.base?.faces||[])),op:Date.now(),draftKey:region?currentDraftId():null,regionId:region?.id};if(moveReference){if(face.feature&&k==='m'){tool.moveMode=3;tool.moveFrame=F.viewFrame(face.points,p=>host.screen(p,'3d'));tool.planeStart=rayPoint({frame:tool.moveFrame},mouse);}moveModeStatus();host.redraw();}return true;}
  }
if(k==='n'&&!tool){const ps=selectedWorldPoints();if(ps.length){const before=copy(host.state().wallEdits);d=pointDrawingOwner(ps);if(d){tool={kind:'draw',before};host.message('Click on this face to place the connected point');host.redraw();return true;}}}
if(!d&&['n','q'].includes(k)&&selected())d=ensure(selected());if(!d)return false;
  if(k==='z'&&(e.ctrlKey||e.metaKey)&&tool){if(tool.before)host.state().wallEdits=tool.before;tool=null;clearGuides();host.redraw();return true;}
  if(k==='escape'&&tool){if(tool.before)host.state().wallEdits=tool.before;tool=null;clearGuides();host.redraw();return true;}
  if(k==='c'||k==='u'){transaction(()=>S.connect(d,picked));return true;}
  if(k==='q')return startQuad();
  if(k==='n'){tool={kind:'draw'};host.message('Click on this face to place the connected point');return true;}
  if(k==='m'&&picked.length){if(picked.some(id=>d.sketch.nodes.find(n=>n.id===id)?.fixed)){host.message('Boundary points are locked');return true;}if(mouse){tool={kind:'move',before:copy(host.state().wallEdits),start:rayPoint(d,mouse),anchor:copy(d.sketch.nodes.find(n=>n.id===picked[0])),ids:picked.slice()};}return true;}
  if((k==='delete'||k==='backspace')&&picked.length){transaction(()=>removeDraftPoints(d,picked));picked=[];return true;}
  return false;
 }
 function movePointer(...args){if(!window.ExteriorPerf?.enabled)return perf_movePointer.apply(this,args);return window.ExteriorPerf.measure('Draft pointer update',()=>perf_movePointer.apply(this,args));}
function perf_movePointer(e){if(workingPlane&&!tool&&!box){mouse=e;if(workingPlane.rotation){if(viewOf(e)==='3d'&&!(e.buttons&6))previewPlaneRotation(e);return;}if(viewOf(e)==='3d'&&!(e.buttons&6)&&(workingPlane.drawing||workingPlane.action)){if(workingPlane.action?.kind==='curve')previewPlaneCurve(e);else workingPlane.hover=planePoint(e);host.redraw();}else{workingPlane.hover=null;clearGuides();host.redraw();}return;}if(tool?.kind==='curveMove'){const t=tool,p=rayPoint(current(),e);if(!p)return;host.state().wallEdits=copy(t.before);try{S.move(all()[t.draftKey],t.ids,{x:p.x-t.start.x,y:p.y-t.start.y});t.changed=true;}catch(error){host.message(error.message);}host.redraw();return;}
  if(box&&!(e.buttons&1)){box=null;boxEl?.remove?.();boxEl=null;}
  if(!host.active()&&!box)return;if(box){if(e.buttons&6)return;box.ex=e.clientX;box.ey=e.clientY;if(box.moved||Math.hypot(box.ex-box.x,box.ey-box.y)>=4){box.moved=true;e.stopImmediatePropagation();e.preventDefault();if(typeof document!=='undefined'){if(!boxEl){boxEl=document.createElement('div');Object.assign(boxEl.style,{position:'fixed',pointerEvents:'none',border:'1px dashed #1a73e8',background:'rgba(26,115,232,0.2)',zIndex:10001});document.body.appendChild(boxEl);}Object.assign(boxEl.style,{left:Math.min(box.x,box.ex)+'px',top:Math.min(box.y,box.ey)+'px',width:Math.abs(box.ex-box.x)+'px',height:Math.abs(box.ey-box.y)+'px'});}return;}}if(!viewOf(e))return;mouse=e;if(!tool){clearGuides();return;}if(e.buttons&6){clearGuides();tool.navigation=true;if(tool.kind==='geometryTransform'||tool.kind==='paste')tool.reanchor=true;return;}if(tool.kind==='extrude'&&tool.moveMode&&tool.navigation){tool.navigation=false;const now=F.viewFrame(tool.face.points,p=>host.screen(p,'3d')),q=rayPoint({frame:now},e),delta=tool.previewCap?{x:tool.previewCap.points[0].x-tool.face.points[0].x,y:tool.previewCap.points[0].y-tool.face.points[0].y,z:tool.previewCap.points[0].z-tool.face.points[0].z}:{x:0,y:0,z:0};tool.moveFrame=now;tool.planeStart=q&&{x:q.x-delta.x*now.u.x-delta.y*now.u.y-delta.z*now.u.z,y:q.y-delta.x*now.v.x-delta.y*now.v.y-delta.z*now.v.z,z:0};return;}if(tool.kind==='extrude'&&tool.navigation){tool.navigation=false;tool.startX=e.clientX;tool.startY=e.clientY;tool.baseAmount=tool.amount||0;tool.axis=extrudeAxis(tool.face,tool.amount||0);return;}
  if(tool.kind==='divide'){e.preventDefault();e.stopImmediatePropagation();previewDivision(e);return;}if(tool.kind==='multiExtrude'){e.preventDefault();e.stopImmediatePropagation();previewMultiExtrusion(e);return;}if(tool.kind==='material'||tool.kind==='axisCut')return;if(tool.kind==='step'){e.stopImmediatePropagation();e.preventDefault();previewStep(e);return;}
  if(tool.kind==='lineMove'){e.stopImmediatePropagation();e.preventDefault();previewLineMove(e);return;}
  if(tool.kind==='arch'){previewArch(e);return;}if(tool.kind==='curve'){previewCurve(e);return;}if(tool.kind==='geometryTransform'){previewGeometry(e);return;}if(tool.kind==='paste'){if(tool.editMode==='m'){if(!(e.buttons&6))previewPaste(e);}else previewGeometry(e);return;}if(tool.kind==='chamfer'){e.preventDefault();e.stopImmediatePropagation();previewChamfer(e);return;}if(tool.kind==='entityExtrude'){e.preventDefault();e.stopImmediatePropagation();previewEntity(e);return;}if(tool.kind==='feature'){previewFeature(e);return;}if(tool.kind==='extrude'&&tool.moveMode){e.stopImmediatePropagation();e.preventDefault();previewFaceSlide(e);return;}if(tool.kind==='extrude'){e.stopImmediatePropagation();e.preventDefault();const lastMotion={amount:tool.amount,changed:tool.changed,pathSnap:tool.pathSnap,contained:tool.contained,roofSnap:tool.roofSnap,belowBase:tool.belowBase,mergeSeams:tool.mergeSeams};let amount=tool.numeric??(tool.baseAmount+window.WallSolidGeometry.dragAmount(tool.axis,e.clientX-tool.startX,e.clientY-tool.startY));tool.belowBase=null;tool.pathSnap=null;tool.mergeSeams=[];tool.contained=null;tool.roofSnap=null;tool.detached=false;const rawAmount=amount;const snap=W.containedSnap(tool.face,amount,tool.scene||[]),pixels=Math.max(Math.hypot(tool.axis.x,tool.axis.y),33.33);if(tool.numeric==null&&snap&&Math.abs(snap.amount-amount)<((typeof isFreeMove!=='undefined'&&isFreeMove)?1e-5:12/pixels)){amount=snap.amount;tool.contained=snap;}if(tool.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){const rings=[tool.face.points,...(tool.face.holes||[])];tool.motionCandidates||=W.motionSnapCandidates(rings.flat(),rings.flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]])),W.normal(tool.face.points),tool.scene||[],{heightPoints:tool.heightPoints,points:tool.snapGeometry.points,edges:[...tool.snapGeometry.lines.values()]});const path=W.motionSnap(rings.flat(),rings.flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]])),W.normal(tool.face.points),rawAmount,tool.scene||[],{candidates:tool.motionCandidates,heightPoints:tool.heightPoints,points:tool.snapGeometry.points,edges:[...tool.snapGeometry.lines.values()],screen:p=>host.screen(p,'3d'),radius:12,minPixelsPerMeter:33.33});if(path&&(!tool.contained||Math.abs(path.amount-rawAmount)<Math.abs(amount-rawAmount))){amount=path.amount;tool.pathSnap=path;tool.contained=null;}}const roofSnap=tool.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)&&roofTarget(tool.face,rawAmount,12/pixels);if(roofSnap){amount=roofSnap.amount;tool.roofSnap=roofSnap;tool.contained=null;tool.pathSnap=null;}if(tool.engineRoof===host.roof?.()&&!tool.invalid&&tool.previewCap&&!roofSnap&&!lastMotion.roofSnap&&Math.abs(amount-lastMotion.amount)<1e-8){Object.assign(tool,lastMotion);return;}tool.amount=amount;tool.changed=Math.abs(amount)>1e-6||!!roofSnap;tool.invalid=false;const lastPreview=copy(host.state().wallEdits);host.state().wallEdits=copy(tool.before);if(!tool.changed){host.redraw();return;}const edits=host.state().wallEdits;if(tool.sceneDrafts)edits.$drafts=copy(tool.sceneDrafts);let cap,sides=[];try{
 const sweep=()=>{
  const boundRoof=host.roof?.();if(tool.engineRoof!==boundRoof){tool.engine=null;tool.engineRoof=boundRoof;}
  tool.engine ||= window.ExteriorModel.createExtrusion({keepTrimStatic:host.state()?.keepTrimStatic===true,face:tool.face,scene:tool.scene,supports:tool.supports,roof:host.roof?.(),base:tool.before.$base||host.state().base});
  const result=tool.engine.preview(amount,{fit:tool.roofSnap&&!host.roof?.()?.faces?.length?(cap,sides)=>fitSolidRoof(cap,sides,tool.roofSnap):null});
  cap=result.cap;sides=trimExtrudedSides(result.sides,result);if(result.base)edits.$base=result.base;if(result.fitMoves)applyRoofMoves(result.fitMoves);
 };
 if(tool.mode==='extrude')sweep();else{
  try{
   edits.$drafts=copy(tool.sceneDrafts);
   if(tool.draftKey&&!tool.wholeDraft)cap=applyFabricMove(tool.scene,tool.face.id,amount);
   else{try{cap=applySolidMove(tool.scene,tool.face.id,amount);if(cap)window.ExteriorModel.validateEdits(edits,tool.before);}catch{edits.$drafts=copy(tool.sceneDrafts);cap=applyFabricMove(tool.scene,tool.face.id,amount);}}
   if(!cap)throw Error('The moved face has no connected result.');
   if(host.roof?.()?.faces?.length){
    const fitted=W.roofExtrusion(tool.face,amount,{cap:copy(cap),sides:[]},host.roof());
    const moves=cap.points.flatMap(p=>{const matches=fitted.cap.deleted?[]:fitted.cap.points.filter(q=>Math.hypot(p.x-q.x,p.y-q.y)<.003);if(!matches.length)return [];const z=Math.max(...matches.map(q=>q.z));return p.z>z+.00001?[{from:copy(p),z}]:[];});
    applyRoofMoves(moves);cap=fitted.cap;
    const n=W.normal(tool.face.points),origin=cap.points[0];sides=fitted.sides.filter(f=>f.points.every(p=>Math.abs((p.x-origin.x)*n.x+(p.y-origin.y)*n.y+(p.z-origin.z)*n.z)<.00001));
   }else if(tool.roofSnap)applyRoofMoves(fitSolidRoof(cap,sides,tool.roofSnap));
  }catch(error){
   // A contained region cannot leave its plane without connecting material.
   // Rebuild that operation from the same immutable input used by E.
   for(const key of Object.keys(edits))delete edits[key];Object.assign(edits,copy(tool.before),{$drafts:copy(tool.sceneDrafts)});sweep();
  }
 }
}catch(error){host.state().wallEdits=lastPreview;Object.assign(tool,lastMotion);tool.invalid=true;host.message(error.message);host.redraw();return;}tool.belowBase=cap.deleted?null:window.WallSolidGeometry.belowBase(cap,tool.baseFaces);edits.$surfaces=[...(edits.$surfaces||[]).filter(f=>f.id!==cap.id),...(tool.belowBase?[]:[cap]),...sides.map(f=>({...f,id:f.id+'-'+tool.op}))];selectedSolid=cap.deleted?(sides.length?(sides.find(f=>f.roofContact)||sides[0]).id+'-'+tool.op:null):cap.id;if(tool.belowBase)edits.$baseCuts=[...(edits.$baseCuts||[]),...tool.belowBase.cuts.map((cut,i)=>({...cut,id:cap.id+'-base-'+i}))];if(tool.draftKey){const region=all()[tool.draftKey].faces.find(f=>f.id===tool.regionId);region.solidId=cap.id;region.opening=false;}if(tool.contained&&!tool.belowBase&&!cap.deleted){for(const ring of [cap.points,...(cap.holes||[])])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});for(const [lo,hi]of W.sharedIntervals(a,b,tool.scene.filter(f=>!f.snapOnly&&!f.deleted&&f.id!==cap.id&&W.coplanarContact(cap,f))))tool.mergeSeams.push([at(lo),at(hi)]);}const target=tool.scene.find(f=>f.id===tool.contained.targetId);if(target&&W.containedBy(cap,target)){try{mergeContained(cap,target);}catch(error){host.state().wallEdits=lastPreview;Object.assign(tool,lastMotion);tool.invalid=true;host.message(error.message);host.redraw();return;}}else if(!target||target.snapOnly||!W.coplanarContact(cap,target))tool.contained=null;}if(cap?.chimney?.drivesFootprint)host.state().wallEdits=window.ExteriorModel.reconcileChimneys(host.state(),edits);tool.previewCap=copy(cap.deleted?(sides.find(f=>f.roofContact)||sides[0]||cap):cap);host.message(tool.detached?'Detached move: adjoining faces cannot stay planar. E creates an extrusion with connecting sides.':tool.pathSnap?tool.pathSnap.kind+' snap - click to place':tool.roofSnap?'Roof edge snap (position + height)':tool.contained?(tool.contained.kind==='adjacent'?'Coplanar snap · shared wall edges':'Contained coplanar face · merge into draft geometry on placement'):tool.belowBase?'Entire face below base · click to remove and create opening': (tool.mode==='move'?'Wall offset: ':'Extrusion: ')+(amount*(tool.inwardSign||1)).toFixed(2)+' m');host.redraw();return;}
  const d=current();if(!d)return;
  if(tool.navigation){tool.navigation=false;tool.start=rayPoint(d,e);tool.reference=copy(host.state().wallEdits);if(tool.kind==='move')tool.anchor=copy(d.sketch.nodes.find(n=>n.id===tool.ids[0]));if(['scale','rotate'].includes(tool.kind))tool.originals=tool.originals.map(o=>copy(d.sketch.nodes.find(n=>n.id===o.id)));return;}
  e.stopImmediatePropagation();e.preventDefault();let raw=rayPoint(d,e);if(!raw)return;if(tool.kind==='move'&&tool.start)raw={x:tool.anchor.x+raw.x-tool.start.x,y:tool.anchor.y+raw.y-tool.start.y,z:0};const p=['scale','rotate'].includes(tool.kind)?raw:snap(d,e,raw);if(!p)return;
  if(['scale','rotate'].includes(tool.kind)){const t=tool,c=t.center,angle=Math.atan2(p.y-c.y,p.x-c.x)-Math.atan2(t.start.y-c.y,t.start.x-c.x),step=Math.PI/4,nearest=Math.round(angle/step)*step,a=!(typeof isFreeMove!=='undefined'&&isFreeMove)&&Math.abs(angle-nearest)<Math.PI/36?nearest:angle,scale=Math.hypot(p.x-c.x,p.y-c.y)/Math.max(.001,Math.hypot(t.start.x-c.x,t.start.y-c.y));host.state().wallEdits=copy(t.reference||t.before);const next=current();try{for(const o of t.originals){const n=next.sketch.nodes.find(n=>n.id===o.id),dx=o.x-c.x,dy=o.y-c.y,q=t.kind==='scale'?{x:c.x+dx*scale,y:c.y+dy*scale}:{x:c.x+dx*Math.cos(a)-dy*Math.sin(a),y:c.y+dx*Math.sin(a)+dy*Math.cos(a)};Object.assign(n,q);}S.resolve(next);classify(next);clearGuides();if(t.kind==='rotate'&&a===nearest){snapGuides=[{p1:c,p2:{x:c.x+Math.cos(a),y:c.y+Math.sin(a)}}];showGuides(next,e);}host.message(t.kind==='scale'?'Scale: '+scale.toFixed(2):'Rotation: '+(a*180/Math.PI).toFixed(1)+'°');}catch(error){host.state().wallEdits=copy(t.before);host.message(error.message);}}
  else if(tool.kind==='move'&&tool.start){const key=currentDraftId();host.state().wallEdits=copy(tool.reference||tool.before);try{S.move(all()[key],tool.ids,{x:p.x-tool.anchor.x,y:p.y-tool.anchor.y});classify(all()[key]);}catch(error){host.message(error.message);}}
  else tool.preview=p;host.redraw();
 }
 let pendingPreview=null,previewFrame=null;
 function flushPreview(){const pending=pendingPreview;pendingPreview=null;if(previewFrame!==null){if(previewFrame===true)window.ExteriorFramePipeline?.cancel('wall-preview');else cancelAnimationFrame(previewFrame);previewFrame=null;}if(pending&&pending.tool===tool)runPointer(pending.event);}
 function runPointer(e){if(tool?.kind==='trim')return;const action=tool?.kind,start=performance.now();try{movePointer(e);}catch(error){const before=tool?.before;tool=null;if(before)host.state().wallEdits=before;clearGuides();host.message('Preview canceled: '+error.message);console.error('Exterior preview failed',error);host.redraw();}finally{const ms=performance.now()-start;if(action&&ms>150)console.warn('Slow exterior preview',{action,milliseconds:Math.round(ms)});}}
 window.addEventListener('pointermove',e=>{
  if(tool&&['geometryTransform','paste','feature','extrude','multiExtrude','entityExtrude','lineMove'].includes(tool.kind)&&viewOf(e)&&!(e.buttons&6)){
   e.preventDefault();e.stopImmediatePropagation();pendingPreview={tool,event:e};if(previewFrame===null){if(window.ExteriorFramePipeline){previewFrame=true;window.ExteriorFramePipeline.enqueue('wall-preview',flushPreview,10);}else previewFrame=requestAnimationFrame(flushPreview);}
  }else{flushPreview();runPointer(e);}
 },true);
 function visibleDraftFaces(d,f){
  // Display clipping creates fresh coordinates without sketch node IDs. Apply
  // deletion/ownership checks to the source face, never to that derived polygon.
  if(f.boundaryHole||f.solidId||deleted(d,f))return [];

  const face=engineFace(d,f),parts=host.state()?.chimneys?.items?.length?window.WallChimneys.visibleParts(face,host.state()):[face];
  return parts.flatMap(part=>window.ExteriorModel.cutOpenings(part,renderOpenings)).map(part=>({...f,points:part.points.map(p=>toLocal(d,p)),holes:(part.holes||[]).map(r=>r.map(p=>toLocal(d,p)))}));
 }
 function drawDraftPart(group,vector,d,source,f,inner){if(f.boundaryHole||f.solidId||deleted(d,f))return;const chosen=faceChosen({draft:draftKey(d),face:source.id}),opening=inner.includes(source),holes=f.holes?.length?f.holes:opening?[]:inner.filter(h=>h!==source&&containsRegion(f,h)).map(h=>h.points),polys=[f.points,...holes],points=polys.flat(),tri=window.ExteriorGeometry.triangles(polys[0],holes).triangles;
    const geo=new THREE.BufferGeometry().setFromPoints(points.map(p=>vector(world(d,p))));geo.setIndex(tri.flat());const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:f.feature&&F?.defs.get(f.feature.type)?.color||materialColor(f)||(d.chimney?window.WallChimneys.COLOR:opening?'#ff962f':'#ffd84d'),side:THREE.DoubleSide,transparent:true,opacity:chosen ? .85 : opening ? .65 : .3,depthWrite:false}));mesh.userData.pickLayer='walls';mesh.userData.exteriorSelected=chosen;mesh.userData.exteriorFeature=!!f.feature;if(f.feature){mesh.renderOrder=1;Object.assign(mesh.material,{polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});}window.ExteriorFinishes?.prepare(mesh,{...f,points:f.points.map(p=>world(d,p))},points.map(p=>world(d,p)));group.add(mesh);if(f.feature)featureDimensions(group,vector,f.points.map(p=>world(d,p)),f.feature,chosen);else if(!f.curvedSurface&&host.state()?.wallCenters!==false)window.wallCenterMarker?.(group,vector,world(d,B.center(f)));if(d.frame||f.feature||host.state()?.chimneys?.items?.length||!d.members.some(id=>walls().some(w=>w.id===id))){mesh.userData.draftKey=draftKey(d);mesh.userData.regionId=source.id;solidMeshes.push(mesh);}
   }
 function draw3D(group,vector){
  drawWorkingPlane(group,vector);
  solidMeshes=[];
  for(let d of Object.values(all())){retainSourcePoints(d);if(!d.faces.length&&!d.sketch.nodes.length&&!d.deletedFaces?.length){const w=walls().find(w=>d.members.includes(w.id));if(w)d=ensure(w);}if(!visibleDraft(d))continue;
   const inner=d.faces.filter(f=>f.boundaryHole||f.points.every(p=>!d.sketch.nodes.find(n=>n.id===p.nodeId)?.fixed));
   for(const source of d.faces)visibleDraftFaces(d,source).forEach((f,index)=>{
    const draw=target=>{const before=solidMeshes.length;drawDraftPart(target,vector,d,source,f,inner);return solidMeshes.splice(before);};
    const pickable=!!(d.frame||f.feature||host.state()?.chimneys?.items?.length||!d.members.some(id=>walls().some(w=>w.id===id)));
    const picks=window.WallMode?.renderChunk&&!f.feature?.divisionGroup&&tool?.kind!=='divide'?window.WallMode.renderChunk('draft:'+draftKey(d)+':'+source.id+':'+index,[f,d.frame,d.origin,d.u,d.chimney,inner,faceChosen({draft:draftKey(d),face:source.id}),pickable,host.state()?.wallCenters,host.state()?.featureDimensions,renderDividers,tool?.mergeSeams,tool?.kind,!!tool?.moveReference],group,draw):draw(group);
    solidMeshes.push(...picks);
   });
   for(const edge of draftSegments(d)){const [a,b]=[edge.start,edge.end].map(p=>world(d,p));previewLine(group,vector,a,b,current()===d&&pickedLines.includes(edge.id)?'#fff':structuralDraftEdge(d,edge)?'#e7ad52':'#6ce4ed');}
   for(const source of d.faces.filter(f=>faceChosen({draft:draftKey(d),face:f.id})))for(const f of visibleDraftFaces(d,source)){if(!f.solidId&&!deleted(d,f))drawSelectionOutline(group,vector,engineFace(d,f));}
   for(const n of draftNodes(d))previewPoint(group,vector,world(d,n),isPicked(d,n.id)?'#fff':structuralDraftPoint(d,n)?'#e7ad52':'#6ce4ed',isPicked(d,n.id)?12:8);
   if(current()===d&&tool?.preview&&tool.kind==='quad'){const ps=quadPoints(d,tool.preview);if(ps.length){const geo=new THREE.BufferGeometry().setFromPoints([...ps,ps[0]].map(p=>vector(world(d,p))));group.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:'#fff',depthTest:false})));}}
   if(current()===d&&tool?.preview&&tool.kind!=='quad')for(const id of picked){const a=d.sketch.nodes.find(n=>n.id===id);if(a){const geo=new THREE.BufferGeometry().setFromPoints([vector(world(d,a)),vector(world(d,tool.preview))]);group.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:'#fff',depthTest:false})));}}
  }
 }
 function previewPoint(group,vector,p,color,size){if(group.point){group.point(vector(p),color,size);return;}const geo=new THREE.BufferGeometry().setFromPoints([vector(p)]);group.add(new THREE.Points(geo,new THREE.PointsMaterial({color,size,sizeAttenuation:false,depthTest:false})));}
 function previewLine(group,vector,a,b,color,depthTest=false){
  const intervals=W.sharedIntervals(a,b,[...(tool?.mergeSeams||[]).map(points=>({points})),...dividerTargets(a,b)]),at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});let start=0;
  const draw=(lo,hi,dashed)=>{if(hi-lo<1e-7)return;if(!dashed&&group.segment){group.segment(vector(at(lo)),vector(at(hi)),color,depthTest);return;}const geo=new THREE.BufferGeometry().setFromPoints([at(lo),at(hi)].map(vector)),material=dashed?new THREE.LineDashedMaterial({color:color==='#fff'?'#fff':'#65e6ff',dashSize:.12,gapSize:.08,depthTest:false}):new THREE.LineBasicMaterial({color,depthTest}),line=new THREE.Line(geo,material);if(dashed){line.computeLineDistances();line.userData.exteriorDivider=true;if(color==='#fff')line.userData.exteriorSelection=true;line.renderOrder=1002;}group.add(line);};
  for(const [lo,hi]of intervals){draw(start,lo,false);draw(lo,hi,true);start=hi;}draw(start,1,false);
 }
 function movingFace(points){const t=tool;if(!t?.moveReference)return false;const face=t.previewCap||t.face;return points.length===face.points.length&&points.every(p=>face.points.some(q=>W.vertexKey(p)===W.vertexKey(q)));}
 function drawMoveIndicator(group,vector){const t=tool;if(!t?.moveReference)return;const overlay={add(o){o.renderOrder=1002;group.add(o);}},face=t.previewCap||t.face,dimensions=F.dimensions(face.points,face.feature),center=W.fromFrame(dimensions.frame,{x:(dimensions.bounds.left+dimensions.bounds.right)/2,y:(dimensions.bounds.bottom+dimensions.bounds.top)/2,z:0}),frame=F.viewFrame(face.points,p=>host.screen(p,'3d')),axes=t.moveMode===3?[frame.u,frame.v]:[t.moveMode===1?frame.u:t.moveMode===2?frame.v:frame.n];
  for(const axis of axes){const at=(s,v=axis)=>({x:center.x+v.x*s,y:center.y+v.y*s,z:center.z+v.z*s}),a=host.screen(center,'3d'),b=host.screen(at(1),'3d'),length=Math.min(1,Math.max(.12,36/Math.max(36,Math.hypot(b.x-a.x,b.y-a.y)))),wing=Math.abs(axis.z)>.7?frame.u:frame.v;
   previewLine(overlay,vector,at(-length),at(length),'#fff');for(const sign of [-1,1]){const end=at(sign*length),base=at(sign*length*.72);for(const side of [-1,1])previewLine(overlay,vector,end,{x:base.x+wing.x*length*.16*side,y:base.y+wing.y*length*.16*side,z:base.z+wing.z*length*.16*side},'#fff');}}
  window.wallLengthMarker?.(group,vector,{a:center,b:center,length:0,text:moveNames[t.moveMode||0],centerY:-.65,horizontal:true,moveIndicator:true});
 }
 function drawStickerPreview(group,vector,points,feature,valid=true){const frame=F.frame(points),geo=new THREE.BufferGeometry().setFromPoints(points.map(vector));geo.setIndex(THREE.ShapeUtils.triangulateShape(points.map(p=>{const q=W.inFrame(frame,p);return new THREE.Vector2(q.x,q.y);}),[]).flat());const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:valid?F.defs.get(feature.type).color:'#ff7575',side:THREE.DoubleSide,transparent:true,opacity:.7,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));if(valid){mesh.userData.exteriorFeature=true;window.ExteriorFinishes?.prepare(mesh,{points,feature},points);}group.add(mesh);for(let i=0;i<points.length;i++)previewLine(group,vector,points[i],points[(i+1)%points.length],'#fff');featureDimensions(group,vector,points,feature);}
 function stickerTrimFaces(points,feature){
  if(!feature?.trim?.width)return [];
  if(!feature.divisionGroup)return F.trimFaces(points,feature);
  const preview=tool?.kind==='paste'&&tool.preview?.faces?.some(f=>f.feature?.divisionGroup===feature.divisionGroup&&f.points.every(p=>points.some(q=>distance3(p,q)<1e-5))),key=(preview?'preview:':'')+feature.divisionGroup;
  if(renderedDivisionTrim.has(key))return [];renderedDivisionTrim.add(key);
  return F.groupedStickers((preview?tool.preview.faces:divisionScene()).filter(f=>f.feature?.divisionGroup===feature.divisionGroup)).flatMap(f=>F.trimFaces(f.points,f.feature));
 }
 function featureDimensions(group,vector,points,feature,selected=false){
 for(const f of stickerTrimFaces(points,feature)){const fr=W.faceFrame(f),geo=new THREE.BufferGeometry().setFromPoints(f.points.map(vector));geo.setIndex(window.ExteriorGeometry.triangles(f.points.map(p=>W.inFrame(fr,p)),[]).triangles.flat());const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:f.finishColor,side:THREE.DoubleSide,transparent:true,opacity:.9,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3}));mesh.renderOrder=2;mesh.raycast=()=>{};window.ExteriorFinishes?.prepare(mesh,{...f,openingTrim:true},f.points);group.add(mesh);for(let i=0;i<f.points.length;i++)previewLine(group,vector,f.points[i],f.points[(i+1)%f.points.length],selected?'#FFD700':f.finishColor);}
 if(!F||host.state()?.featureDimensions===false||tool?.kind==='divide'&&tool.faces.some(f=>f.points.length===points.length&&f.points.every(p=>points.some(q=>distance3(p,q)<1e-5))))return;const d=F.dimensions(points,feature),c={x:(d.bounds.left+d.bounds.right)/2,y:(d.bounds.bottom+d.bounds.top)/2,z:0},a=W.fromFrame(d.frame,{...c,x:d.bounds.left}),b=W.fromFrame(d.frame,{...c,x:d.bounds.right});window.wallLengthMarker?.(group,vector,{a,b,length:0,text:F.label(points,feature),selected,...(movingFace(points)?{centerY:1.65,horizontal:true}:{})});}
 function featureEdges(){return [...Object.values(all()).flatMap(d=>d.faces.filter(f=>f.feature&&!f.solidId&&!deleted(d,f)).map(f=>({points:f.points.map(p=>world(d,p))}))),...solids().filter(f=>f.feature&&!f.drafted&&!f.deleted)];}
 function drawLengths(group,vector){
  const mode=host.state()?.lineLengthMode||(host.state()?.wallLengths===false?'off':'moving');if(mode==='off'||(mode!=='all'&&!tool))return;
  let edges=[];
  if(mode==='all'){edges=[...sceneLines().lines.values()].map(([a,b])=>({a,b,length:Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}));}
  else if(tool.kind==='lineMove'&&tool.changed){edges=tool.pairs.map(pair=>{const a={x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2,z:(pair[0].z+pair[1].z)/2},b={x:a.x+tool.direction.x*tool.amount,y:a.y+tool.direction.y*tool.amount,z:a.z+tool.direction.z*tool.amount};return {a,b,length:Math.abs(tool.amount)};});}
  else if(tool.kind==='multiExtrude'&&tool.changed){edges=tool.members.map((m,i)=>{const a=m.face.points[0],n=W.normal(m.face.points),b={x:a.x+n.x*tool.amount*m.sign,y:a.y+n.y*tool.amount*m.sign,z:a.z+n.z*tool.amount*m.sign};return {a,b,length:Math.abs(tool.amount)};});}
  else if(tool.kind==='extrude'&&tool.changed&&tool.previewCap){edges=W.attachedLengths(tool.previewCap,supportSnapshot||structuralFaces());
   if(!edges.length&&Math.abs(tool.amount)>1e-6)edges=[{a:tool.face.points[0],b:tool.previewCap.points[0],length:Math.hypot(tool.previewCap.points[0].x-tool.face.points[0].x,tool.previewCap.points[0].y-tool.face.points[0].y,tool.previewCap.points[0].z-tool.face.points[0].z)}];
  }else if(tool.kind==='move'&&current()){
   const d=current(),points=d.sketch.nodes.filter(n=>tool.ids.includes(n.id)).map(n=>world(d,n));edges=[...sceneLines().lines.values()].filter(pair=>pair.some(p=>points.some(q=>W.vertexKey(p)===W.vertexKey(q)))).map(([a,b])=>({a,b,length:Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}));
  }
  const features=featureEdges();for(const edge of edges)if(!W.sharedIntervals(edge.a,edge.b,features).length)window.wallLengthMarker?.(group,vector,edge);
 }
 function drawEntity(group,vector){if(tool?.kind==='axisCut'&&host.wallsVisible?.()===false)for(const pair of tool.lines||[])previewLine(group,vector,...pair,'#FFD700');if(tool?.kind==='entityExtrude'&&tool.preview){const ps=tool.preview;if(ps.length===2)previewLine(group,vector,...ps,tool.valid?'#fff':'#ff6666');else{const geo=new THREE.BufferGeometry().setFromPoints(ps.map(vector));group.add(new THREE.Points(geo,new THREE.PointsMaterial({color:tool.valid?'#fff':'#ff6666',size:12,sizeAttenuation:false,depthTest:false})));}if(tool.measure){previewLine(group,vector,...tool.measure,'#FFD700');if(host.state()?.lineLengthMode!=='off')window.wallLengthMarker?.(group,vector,{a:tool.measure[0],b:tool.measure[1],length:distance3(...tool.measure)});}}}
 function drawSelectionOutline(group,vector,face){
  const outline=window.ExteriorGeometry.surfaceOutline(face);
  if(face.feature?.divisionGroup){for(const ring of [outline.points,...(outline.holes||[])])for(let i=0;i<ring.length;i++)previewLine(group,vector,ring[i],ring[(i+1)%ring.length],'#fff');return;}
  for(const ring of [outline.points,...(outline.holes||[])]){
   if(!ring.length)continue;
   const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([...ring,ring[0]].map(vector)),new THREE.LineBasicMaterial({color:'#fff',depthTest:false}));
   line.userData.exteriorSelection=true;line.renderOrder=1002;group.add(line);
  }
 }
 function drawSolidPart(group,vector,source,f){if(f.deleted||f.drafted)return;if(f.curvedSurface?.logical){const data=window.ExteriorGeometry.surfaceMesh(f),geo=new THREE.BufferGeometry().setFromPoints(data.positions.map(vector));geo.setIndex(data.triangles.flat());if(THREE.Float32BufferAttribute&&geo.setAttribute)geo.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv.flatMap(p=>[p.x,p.y]),2));geo.computeVertexNormals?.();const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:materialColor(f)||'#ffd84d',side:THREE.DoubleSide,transparent:true,opacity:.5,depthWrite:false}));mesh.userData.solidId=source.id;mesh.userData.exteriorSelected=faceChosen({solid:source.id});mesh.userData.exteriorFeature=!!f.feature;if(f.feature){mesh.renderOrder=1;Object.assign(mesh.material,{polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});}mesh.userData.curvedSurface=true;window.ExteriorFinishes?.prepare(mesh,f,data.positions,data.uv);group.add(mesh);solidMeshes.push(mesh);if(mesh.userData.exteriorSelected)drawSelectionOutline(group,vector,f);return;}const frame=W.faceFrame(f);if(!frame)return;const {origin,u,v}=frame,local=p=>new THREE.Vector2((p.x-origin.x)*u.x+(p.y-origin.y)*u.y+(p.z-origin.z)*u.z,(p.x-origin.x)*v.x+(p.y-origin.y)*v.y+(p.z-origin.z)*v.z),polys=[f.points,...(f.holes||[])];const geo=new THREE.BufferGeometry().setFromPoints(polys.flat().map(vector));geo.setIndex(window.ExteriorGeometry.triangles(polys[0].map(local),polys.slice(1).map(h=>h.map(local))).triangles.flat());const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:f.feature&&F?.defs.get(f.feature.type)?.color||materialColor(f)||(f.chimney?window.WallChimneys.COLOR:'#ffd84d'),side:THREE.DoubleSide,transparent:true,opacity:.5,depthWrite:false}));mesh.userData.solidId=source.id;mesh.userData.exteriorSelected=faceChosen({solid:source.id});mesh.userData.exteriorFeature=!!f.feature;if(f.feature){mesh.renderOrder=1;Object.assign(mesh.material,{polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});}window.ExteriorFinishes?.prepare(mesh,f,polys.flat());group.add(mesh);solidMeshes.push(mesh);if(mesh.userData.exteriorSelected)drawSelectionOutline(group,vector,f);if(f.feature)featureDimensions(group,vector,f.points,f.feature,mesh.userData.exteriorSelected);else if(!f.curvedSurface&&host.state()?.wallCenters!==false)window.wallCenterMarker?.(group,vector,{x:f.points.reduce((s,p)=>s+p.x,0)/f.points.length,y:f.points.reduce((s,p)=>s+p.y,0)/f.points.length,z:f.points.reduce((s,p)=>s+p.z,0)/f.points.length});}
 function drawSolids(group,vector){
  F?.refreshUI?.();if(tool?.kind==='geometryTransform'&&tool.preview){const c=geometryCenter(tool.preview),frame=tool.clip.mounts[tool.mount].frame;for(const [axis,color]of [[frame.u,'#ffba65'],[frame.v,'#8ce9ff']])previewLine(group,vector,{x:c.x-axis.x,y:c.y-axis.y,z:c.z-axis.z},{x:c.x+axis.x,y:c.y+axis.y,z:c.z+axis.z},color,false);group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(tool.preview.points.map(vector)),new THREE.PointsMaterial({color:'#8ce9ff',size:9,sizeAttenuation:false,depthTest:false})));}if(tool?.kind==='paste'&&tool.preview){const p=tool.preview,color=tool.valid?'#8ce9ff':'#ff7575';for(const curve of p.curves||[]){const samples=window.ExteriorGeometry.curveSamples(curve);for(let i=1;i<samples.length;i++)previewLine(group,vector,samples[i-1],samples[i],color,false);}for(const pair of p.edges)if(!p.faces.some(f=>f.feature&&pair.every(p=>f.points.some(q=>distance3(p,q)<1e-7))))previewLine(group,vector,...pair,color,false);for(const f of p.faces){if(f.feature){drawStickerPreview(group,vector,f.points,f.feature,tool.valid);continue;}const frame=W.faceFrame(f),local=q=>{const p=W.inFrame(frame,q);return new THREE.Vector2(p.x,p.y);},geo=new THREE.BufferGeometry().setFromPoints([f.points,...f.holes].flat().map(vector));geo.setIndex(window.ExteriorGeometry.triangles(f.points.map(local),f.holes.map(r=>r.map(local))).triangles.flat());group.add(new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.35,depthWrite:false})));}if(!p.faces.length||!p.faces.every(f=>f.feature))group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(p.points.map(vector)),new THREE.PointsMaterial({color,size:9,sizeAttenuation:false,depthTest:false})));}drawMoveIndicator(group,vector);drawEntity(group,vector);if(tool?.kind==='axisCut')for(const pair of tool.lines||[])previewLine({add(o){o.renderOrder=1002;group.add(o);}},vector,...pair,'#FFD700');
  if(tool?.kind==='step'&&tool.preview){const t=tool,points=t.preview.points;for(let i=1;i<points.length;i++)previewLine(group,vector,points[i-1],points[i],t.valid?'#FFD700':'#ff6666');const g=new THREE.BufferGeometry().setFromPoints(t.pair.map(vector)),guide=new THREE.Line(g,new THREE.LineDashedMaterial({color:'#FFD700',dashSize:.12,gapSize:.08,depthTest:false,transparent:true,opacity:.6}));guide.computeLineDistances();group.add(guide);const dot=new THREE.BufferGeometry().setFromPoints([vector(t.preview.anchor)]);group.add(new THREE.Points(dot,new THREE.PointsMaterial({color:'#fff',size:11,sizeAttenuation:false,depthTest:false})));}

  if(tool?.kind==='feature'&&tool.preview)drawStickerPreview(group,vector,tool.preview.points,F.setTrim({type:tool.type,axis:tool.preview.axis},tool.trimInches||0,host.state()?.finishDefaults?.trimColor||'#f5f3ef'));

  if(tool&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){
   const t=tool;let guides=t.kind==='paste'&&t.preview?.valid?t.preview.guides:[];
   if(t.kind==='geometryTransform'&&!t.invalid&&t.preview)guides=W.planeAlignmentGuides(t.preview.points,[...(t.snapTargets?.points||[]),...(t.stickerMove?W.stickerAlignmentTargets(t.scene,t.preview.mounts[t.mount].frame,t.original.points):[])],t.preview.mounts[t.mount].frame);
   if(t.kind==='extrude'&&t.moveMode&&!t.invalid&&t.previewCap){const targets=[...t.snapGeometry.points.filter(q=>!t.face.points.some((p,i)=>onSegment(q,p,t.face.points[(i+1)%t.face.points.length]))),...(t.face.feature?W.stickerAlignmentTargets(t.scene||[],t.moveFrame,t.face.points):[])];guides=W.planeAlignmentGuides(t.previewCap.points,targets,t.moveFrame);}
   if(t.kind==='feature'&&t.preview)guides=W.planeAlignmentGuides(t.preview.points,[...sceneLines().points,...(t.alignmentTargets||[])],F.frame(t.preview.points));
   for(const guide of guides||[]){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([guide.from,guide.target].map(vector)),new THREE.LineBasicMaterial({color:'#FFD700',depthTest:false}));line.renderOrder=1003;line.userData.alignmentGuide=true;group.add(line);}
  }
  if(tool?.pathSnap){const s=tool.pathSnap;previewLine(group,vector,...(s.edge||[s.from,s.target]),'#FFD700',false);const g=new THREE.BufferGeometry().setFromPoints([vector(s.target)]);group.add(new THREE.Points(g,new THREE.PointsMaterial({color:'#FFD700',size:11,sizeAttenuation:false,depthTest:false})));}

  if(tool?.contained?.kind==='adjacent'){const face=tool.scene.find(f=>f.id===tool.contained.targetId);if(face){for(let i=0;i<face.points.length;i++)previewLine(group,vector,face.points[i],face.points[(i+1)%face.points.length],'#FFD700');}}
  if(tool?.roofSnap){const geo=new THREE.BufferGeometry().setFromPoints(tool.roofSnap.edge.map(vector));group.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:'#FFD700',depthTest:false})));}
  if(tool?.belowBase)for(const cut of tool.belowBase.cuts){const geo=new THREE.BufferGeometry().setFromPoints([...cut.points,cut.points[0]].map(vector)),line=new THREE.Line(geo,new THREE.LineDashedMaterial({color:'#fff',dashSize:.15,gapSize:.08,depthTest:false}));line.computeLineDistances();group.add(line);}

  for(const source of solids()){
   const parts=(window.WallChimneys?.visibleParts(source,host.state())||[source]).flatMap(part=>window.ExteriorModel.cutOpenings(part,renderOpenings));
   parts.forEach((f,index)=>{
    const draw=target=>{const before=solidMeshes.length;drawSolidPart(target,vector,source,f);return solidMeshes.splice(before);};
    const picks=window.WallMode?.renderChunk&&!f.feature?.divisionGroup&&tool?.kind!=='divide'?window.WallMode.renderChunk('solid:'+source.id+':'+index,[f,faceChosen({solid:source.id}),host.state()?.wallCenters,host.state()?.featureDimensions,renderDividers,tool?.mergeSeams,tool?.kind,!!tool?.moveReference],group,draw):draw(group);
    solidMeshes.push(...picks);
   });
  }
  const graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),byId=id=>nodesById.get(id);for(const e of graph.edges){previewLine(group,vector,byId(e.a),byId(e.b),solidEdges.includes(e.id)?'#fff':structuralEdge(byId(e.a),byId(e.b),supportSnapshot||structuralFaces())?'#e7ad52':'#6ce4ed',true);}for(const n of graph.nodes.filter(n=>!n.curveSample))previewPoint(group,vector,n,solidPoints.includes(n.id)?'#fff':structuralPoint(n,supportSnapshot||structuralFaces())?'#e7ad52':'#6ce4ed',solidPoints.includes(n.id)?12:8);
 }
 function resolveMovedDraft(d){
  try{S.resolve(d);}catch(error){
   if(error.message!=='The base needs at least one closed face.')throw error;
   // Saved sketches can retain obsolete boundary links after corner merges.
   // Reconnect the current wall perimeter; never discard editable interior lines.
   const sketch=d.sketch;sketch.edges=sketch.edges.filter(e=>!e.fixed);
   for(const ring of sketch.outlines){const ids=ring.map(p=>{let node=sketch.nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<.001);if(!node){node={...p,id:'p'+(++sketch.next),fixed:true};sketch.nodes.push(node);}return node.id;});for(let i=0;i<ids.length;i++){const a=ids[i],b=ids[(i+1)%ids.length];if(a!==b&&!sketch.edges.some(e=>e.a===a&&e.b===b||e.a===b&&e.b===a))sketch.edges.push({id:'e'+(++sketch.next),a,b,fixed:true});}}
   S.resolve(d);
  }
 }
 function reflow(before,changed,edits){
  for(const d of Object.values(edits.$drafts||{})){if(d.frame||d.mergedInto)continue;
   const first=before.find(w=>d.members.includes(w.id)),next=first&&changed.find(w=>w.id===first.id);if(!next&&!changed.some(w=>d.members.includes(w.id)))continue;
   const old=copy(d),normal={x:-d.u.y,y:d.u.x};if(next){const offset=(next.bottom[0].x-first.bottom[0].x)*normal.x+(next.bottom[0].y-first.bottom[0].y)*normal.y;d.origin.x+=normal.x*offset;d.origin.y+=normal.y*offset;}
   const local=p=>({x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0});
   for(const n of d.sketch.nodes.filter(n=>n.fixed||old.sketch.outlines.some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=((n.x-a.x)*dx+(n.y-a.y)*dy)/l2;return t>=-1e-6&&t<=1+1e-6&&Math.abs((n.x-a.x)*dy-(n.y-a.y)*dx)/Math.sqrt(l2)<.002;})))){const p=world(old,n);let best=null,distance=.02;
    for(const w of before.filter(w=>d.members.includes(w.id))){const v=changed.find(v=>v.id===w.id)||w,ps=[...w.bottom,...w.top],qs=[...v.bottom,...v.top];for(const [a,b]of [[0,1],[1,3],[3,2],[2,0]]){const u={x:ps[b].x-ps[a].x,y:ps[b].y-ps[a].y,z:ps[b].z-ps[a].z},len=u.x*u.x+u.y*u.y+u.z*u.z,t=Math.max(0,Math.min(1,((p.x-ps[a].x)*u.x+(p.y-ps[a].y)*u.y+(p.z-ps[a].z)*u.z)/len)),dist=Math.hypot(p.x-ps[a].x-t*u.x,p.y-ps[a].y-t*u.y,p.z-ps[a].z-t*u.z);if(dist<distance){distance=dist;best={x:qs[a].x+t*(qs[b].x-qs[a].x),y:qs[a].y+t*(qs[b].y-qs[a].y),z:qs[a].z+t*(qs[b].z-qs[a].z)};}}}
    if(best)Object.assign(n,local(best));
   }
   const members=before.filter(w=>d.members.includes(w.id)).map(w=>changed.find(v=>v.id===w.id)||w);d.sketch.outlines=B.boundary(members.map(w=>[w.bottom[0],w.bottom[1],w.top[1],w.top[0]].map(local)));
   if(!d.sketch.outlines.length){d.faces=[];continue;}
   if(!d.faces.length)d.faces=d.sketch.outlines.map((points,i)=>({id:'revived-'+i,points:copy(points)}));
   resolveMovedDraft(d);restoreMovedRegions(d,old.faces);classify(d);
  }
 }
 function drawNudgePreview(group,vector,pending){
  let points=pending?.preview?.points||copy(workingPlane?workingPlane.selection:selectedWorldPoints());const pairs=lineSelection.flatMap(l=>l.pairs||[l.pair]);
  if(pending){
   if(!pending.preview){
    const plane=workingPlane?.frame,axes=plane&&[plane.origin,...[plane.u,plane.v].map(a=>({x:plane.origin.x+a.x,y:plane.origin.y+a.y,z:plane.origin.z+a.z}))];
    const lines=!plane&&points.length?[...sceneLines().lines.values()]:[];
    pending.preview={points,view:axes&&F.viewFrame(axes,p=>host.screen(p,'3d')),plans:!plane&&points.map(p=>pointNudgePlan(p,pending,Infinity,lines))};
   }
   const {view,plans}=pending.preview,step=(pending.altKey?.25:pending.shiftKey?6:1)*F.FT/12*pending.nudgeCount,dx=pending.key==='ArrowRight'?step:pending.key==='ArrowLeft'?-step:0,dy=pending.key==='ArrowUp'?step:pending.key==='ArrowDown'?-step:0;
   points=points.map((p,i)=>{if(view)return {x:p.x+view.u.x*dx+view.v.x*dy,y:p.y+view.u.y*dx+view.v.y*dy,z:p.z+view.u.z*dx+view.v.z*dy};const plan=plans?.[i];if(!plan)return p;const amount=Math.min(step,plan.amount);return {x:p.x+plan.direction.x*amount,y:p.y+plan.direction.y*amount,z:p.z+plan.direction.z*amount};});
  }
  if(points.length)group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(vector)),new THREE.PointsMaterial({color:'#ffffff',size:7,sizeAttenuation:false,depthTest:false,depthWrite:false})));
  for(const pair of pairs)window.wallSelectedLine?.(group,vector,pair);
 }
 return {drawNudgePreview,openingTrimItems,selectOpeningTrim,applyOpeningTrim,featurePlacement:()=>tool?.kind==='feature'?{type:tool.type,index:tool.index,trimInches:tool.trimInches||0,session:tool.session}:null,resoffit,soffitEdges,setResoffitMode(value){resoffitMode=!!value;host.redraw();},selectionSnapshot:()=>copy({preferredDraft,preferredSolid,preferredRegion,activeDraftKey,draftSelection,picked,pickedLines,selectedSolid,selectedRegion,solidPoints,solidEdges,selectedBasePoints,lineSelection,faceSelection,workingPlane:workingPlane&&{frame:workingPlane.frame,material:workingPlane.material,finishColor:workingPlane.finishColor,selection:workingPlane.selection,selectedLines:workingPlane.selectedLines,selectedFaces:workingPlane.selectedFaces,tolerance:workingPlane.tolerance,display:workingPlane.display,seed:workingPlane.seed}}),restoreSelection(value){const s=copy(value||{});preferredDraft=s.preferredDraft||null;preferredSolid=s.preferredSolid||null;preferredRegion=s.preferredRegion||null;activeDraftKey=s.activeDraftKey||null;draftSelection=s.draftSelection||{};picked=s.picked||[];pickedLines=s.pickedLines||[];selectedSolid=s.selectedSolid||null;selectedRegion=s.selectedRegion||null;solidPoints=s.solidPoints||[];solidEdges=s.solidEdges||[];selectedBasePoints=s.selectedBasePoints||[];lineSelection=s.lineSelection||[];faceSelection=s.faceSelection||[];workingPlane=s.workingPlane?{...s.workingPlane,drawing:false,hover:null}:null;},togglePlane,planeView:()=>workingPlane&&({frame:workingPlane.frame,display:workingPlane.display,rotating:!!workingPlane.rotation}),setPlaneDisplay(value){if(workingPlane&&['normal','faint','hidden'].includes(value)){workingPlane.display=value;host.redraw();}},planeActive:()=>!!workingPlane,planeDown,pointSelection:()=>(workingPlane?workingPlane.selection:selectedWorldPoints()).map(p=>({...p})),createSelectedFace,extrudeFace,geometryCommand,clipboardCommand,mergeAll,autoTrim,trimMaterials,removeTrim:()=>{const pairs=selectedTrimPairs();return removeSelectedTrim(pairs.length?pairs:null);},selectTrimEdges,applyTrim,pickVisiblePoint,finishToolForSwitch,chamferCommand,trimCommand,materialCommand,colorCommand,activeMaterial:()=>tool?.kind==='material'?tool.type:selectedFinishFace()?.material||null,finishAxisCut,interaction:()=>workingPlane?workingPlane.rotation?'Rotate drawing plane':'Drawing plane':tool?({divide:'Divide window / door',multiExtrude:'Extrude selected faces',geometryTransform:'Transform geometry',paste:'Paste geometry',extrude:tool.mode==='move'?'Move face':'Extrude face',entityExtrude:tool.mode==='move'?'Move point / line':'Extrude point / line',chamfer:tool.rounded?'Fillet':'Chamfer',material:'Paint material',axisCut:'H/V cut',lineMove:tool.extrude?'Extrude lines':'Move line',step:'Auto-step',arch:'Arch line',curve:'Draw curve',draw:'Draw line',quad:'Draw rectangle',feature:'Place feature'}[tool.kind]||tool.kind):box?.moved?'Rectangle selection':null,cancelPointerGesture(){marqueeCompleted=false;box=null;boxEl?.remove?.();boxEl=null;},drawEntity,beginEntity,distanceInput,drawBaseSelection,hasBaseSelection:()=>selectedBasePoints.length>0||!!tool?.external,consumeSelectionClick:()=>marqueeCompleted,startBox(e,click){if(tool||box)return false;beginBox(e,current());box.deferredPick=true;box.click=click;return true;},finishPointer:endBox,cutFromPoint,cutFromPoints,pickPoint:e=>pickSolid(e,true),pickLine3D,stepWheel,stepCommand,featureCommand,featureSelection,featureContext(e){if(tool?.kind==='feature'){featureCommand(tool.type);return 'cycle';}return featureSelection()?'face':false;},mergeWallContained,draw2D(rot,svg,inv){drawArch2D(rot,svg,inv);renderDividers=F.divisionSegments(divisionScene());renderDividerIndex=indexDividers(renderDividers);F?.refreshUI?.();if(tool?.kind==='curve'){const d=current(),t=tool,ps=t.samples||[t.start,t.pointer||t.start];for(const g of t.guides||[])svg('polyline',{points:g.points.map(p=>{const q=host.toPixel(world(d,p));return q.x+','+q.y;}).join(' '),fill:'none',stroke:g.color,'stroke-width':inv,'stroke-dasharray':(5*inv)+' '+(4*inv),'data-curve-guide':g.role,'pointer-events':'none'},rot);svg('polyline',{points:ps.map(p=>{const q=host.toPixel(world(d,p));return q.x+','+q.y;}).join(' '),fill:'none',stroke:t.valid===false?'#ff6666':'#FFD700','stroke-width':2*inv,'pointer-events':'none'},rot);const marker=host.toPixel(world(d,t.center||t.pointer||t.start));svg('circle',{cx:marker.x,cy:marker.y,r:8*inv,fill:'none',stroke:'#72ffb0','stroke-width':1.5*inv,'pointer-events':'none'},rot);if(t.center){const a=host.toPixel(world(d,t.start)),b=host.toPixel(world(d,t.center));svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#72ffb0','stroke-dasharray':'5 5','stroke-width':inv},rot);}}renderWalls=host.walls();renderSegments=new Map();try{beginRenderCache();supportSnapshot=renderDerived('support',()=>structuralFaces());supportIndex=renderDerived('support-index',()=>W.structuralIndex(supportSnapshot));drawLineCenters2D(rot,svg,inv);for(const d of Object.values(all())){for(const edge of draftSegments(d)){const a=host.toPixel(world(d,edge.start)),b=host.toPixel(world(d,edge.end));svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:current()===d&&pickedLines.includes(edge.id)?'#fff':structuralDraftEdge(d,edge)?'#e7ad52':'#6ce4ed','stroke-dasharray':isDivisionPair(world(d,edge.start),world(d,edge.end))?(5*inv)+' '+(4*inv):undefined,'stroke-width':2*inv,'pointer-events':'none'},rot);}for(const n of draftNodes(d)){const p=host.toPixel(world(d,n));svg('circle',{cx:p.x,cy:p.y,r:(isPicked(d,n.id)?6:4)*inv,fill:isPicked(d,n.id)?'#fff':structuralDraftPoint(d,n)?'#e7ad52':'#6ce4ed','pointer-events':'none'},rot);}}const graph=wire(),nodesById=new Map(graph.nodes.map(n=>[n.id,n])),byId=id=>nodesById.get(id);for(const e of graph.edges){const a=host.toPixel(byId(e.a)),b=host.toPixel(byId(e.b));svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:solidEdges.includes(e.id)?'#fff':structuralEdge(byId(e.a),byId(e.b),supportSnapshot||structuralFaces())?'#e7ad52':'#6ce4ed','stroke-dasharray':isDivisionPair(byId(e.a),byId(e.b))?(5*inv)+' '+(4*inv):undefined,'stroke-width':2*inv,'pointer-events':'none'},rot);}for(const n of graph.nodes.filter(n=>!n.curveSample)){const p=host.toPixel(n);svg('circle',{cx:p.x,cy:p.y,r:(solidPoints.includes(n.id)?6:4)*inv,fill:solidPoints.includes(n.id)?'#fff':structuralPoint(n,supportSnapshot||structuralFaces())?'#e7ad52':'#6ce4ed','pointer-events':'none'},rot);}}finally{renderDividerIndex=null;renderDividers=null;supportSnapshot=null;supportIndex=null;renderWalls=null;renderSegments=null;renderCacheActive=false;}},holdBoundary,beginFace,pickSolid,reflow,doubleClick,down,key,draw3D(group,vector){renderedDivisionTrim=new Set();renderDividers=F.divisionSegments(divisionScene());renderDividerIndex=indexDividers(renderDividers);renderOpenings=window.ExteriorModel.indexOpenings(window.ExteriorModel.collect(host.state()).filter(f=>f.feature));drawBaseSelection(group,vector);renderWalls=host.walls();renderSegments=new Map();const output=window.wallGeometryBatch?.(group)||group;try{beginRenderCache();supportSnapshot=renderDerived('support',()=>structuralFaces());supportIndex=renderDerived('support-index',()=>W.structuralIndex(supportSnapshot));drawLineCenters3D(group,vector);draw3D(output,vector);drawSolids(output,vector);drawLengths(output,vector);drawDivision(output,vector);drawChamfer(output,vector);drawArch3D(output,vector);for(const c of renderDerived('soffit-edges',()=>soffitEdges())){const mid=c.pair.reduce((p,q)=>({x:p.x+q.x/2,y:p.y+q.y/2,z:p.z+q.z/2}),{x:0,y:0,z:0}),at=host.screen(mid,'3d');if(at&&(!host.pickSoffitVisible||host.pickSoffitVisible(c.pair,{clientX:at.x,clientY:at.y}))&&!lineSelection.some(l=>W.sharedIntervals(...c.pair,[{points:l.pair}]).length))window.wallSoffitLine(group,vector,c.pair);}if(tool?.kind==='curve'){const t=tool,d=current(),ps=t.samples||[t.start,t.pointer||t.start];window.wallCurveGuides?.(output,vector,(t.guides||[]).map(g=>({...g,points:g.points.map(p=>world(d,p))})));for(let i=1;i<ps.length;i++)previewLine(output,vector,world(d,ps[i-1]),world(d,ps[i]),t.valid===false?'#ff6666':'#FFD700');if(t.center)previewLine(output,vector,world(d,t.start),world(d,t.center),'#72ffb0');window.wallCurveCenterMarker?.(output,vector,world(d,t.center||t.pointer||t.start));}for(const selection of lineSelection)for(const pair of selection.pairs||[selection.pair]){const line={...selection,pair};if(window.wallSelectedLine&&!isDivisionPair(...line.pair))window.wallSelectedLine(output,vector,line.pair);else previewLine(output,vector,...line.pair,'#fff',false);}output.flush?.();}finally{output.disposePending?.();renderedDivisionTrim.clear();renderDividerIndex=null;renderDividers=null;renderOpenings=[];supportSnapshot=null;supportIndex=null;renderWalls=null;renderSegments=null;renderCacheActive=false;}},discardEmpty:id=>{for(const [key,d]of Object.entries(all()))if(d.members.includes(id)&&!d.faces.some(f=>f.material||f.finishColor)&&!(d.deletedFaces||[]).length&&!d.sketch.edges.some(e=>!e.fixed)&&d.sketch.nodes.length===d.sketch.outlines.flat().length)delete all()[key];},modified:id=>Object.values(all()).some(d=>d.members.includes(id)&&(d.sketch.edges.some(e=>!e.fixed)||d.sketch.nodes.length>d.sketch.outlines.flat().length)),has:id=>Object.values(all()).some(d=>d.members.includes(id)&&(d.faces.length||d.sketch.nodes.length||d.deletedFaces?.length)),canBox:()=>walls().length>0||solids().length>0||Object.values(all()).some(visibleDraft),busy:()=>!!tool||!!box||!!workingPlane?.rotation,clear(){resoffitMode=false;pendingPreview=null;if(previewFrame===true)window.ExteriorFramePipeline?.cancel('wall-preview');else if(previewFrame!==null)cancelAnimationFrame(previewFrame);previewFrame=null;workingPlane=null;faceSelection=[];preferredDraft=null;preferredSolid=null;preferredRegion=null;solidMeshes=[];quadFinish=null;selectedBasePoints=[];lineSelection=[];clearGuides();box=null;boxEl?.remove?.();boxEl=null;if(tool?.before)host.state().wallEdits=tool.before;tool=null;const stepButton=typeof document!=='undefined'&&document.getElementById('wall-step');if(stepButton)stepButton.textContent='Auto-step (S)';activeDraftKey=null;draftSelection={};picked=[];pickedLines=[];solidPoints=[];solidEdges=[];selectedSolid=null;selectedRegion=null;}};
};
})();
