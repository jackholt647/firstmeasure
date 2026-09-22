/* Base-layer interactions are isolated from the roof editor and its undo stack. */

(function(){

'use strict';

const B=window.BaseGeometry,G=window.WallGeometry,copy=v=>JSON.parse(JSON.stringify(v)),COLOR='#d6a4ff';

window.createBaseEditor=function(host){

 let selectedFace=null,selectedFaces=[],planeCycle=null,points=[],tool=null,drag=null,mouse=null,history=[],project='',meshes=[],message='',marquee=null,selectionBox=null,gradeBadge=null;

 let sketchEditor=null,pendingBinding=null;

 const state=()=>host.state(),base=()=>{const b=state()?.base;window.BaseSketchGeometry?.syncSurfaceBoundaries?.(b,state()?.wallEdits?.$surfaces);return b;},$=id=>document.getElementById('base-'+id);

 const displayed=f=>{const cuts=state()?.wallEdits?.$baseCuts||[];return cuts.length&&window.WallSolidGeometry?window.WallSolidGeometry.subtract(f,cuts):[f.points];};

 const face=()=>base()?.faces.find(f=>f.id===selectedFace);

 const reference=id=>planeCycle&&planeCycle.step<planeCycle.ids.length&&planeCycle.ids[planeCycle.step]===id;

 const active=()=>host.enabled()&&base()?.visible!==false&&host.layer()==='base';

 function checkpoint(){record(copy(base()));if(history.length>40)history.shift();}

 function record(before){history.push({baseBefore:copy(before),wallEditsBefore:copy(state().wallEdits||{})});const entry=history.at(-1);pendingBinding=entry;if(entry.wallEditsBefore.$base)entry.wallEditsBefore.$base=copy(before);}
 function followBase(){const entry=pendingBinding;pendingBinding=null;if(!entry?.baseBefore||!window.WallBaseBinding)return;const next=base();try{window.BaseSketchGeometry?.rebind(next,next);state().wallEdits=window.WallBaseBinding.follow(entry.wallEditsBefore,entry.baseBefore,next);if(entry.wallEditsBefore.$base)state().wallEdits.$base=next;}catch(error){state().wallEdits=entry.wallEditsBefore;state().base=entry.baseBefore;if(history.at(-1)===entry)history.pop();host.redraw();throw error;}}
 function restoreHistory(){const entry=history.pop();if(entry.baseBefore){state().wallEdits=entry.wallEditsBefore;state().base=entry.baseBefore;return;}if(entry.foundationBefore){state().base=entry.foundationBefore;state().wallEdits||={};if(entry.baseCuts===null)delete state().wallEdits.$baseCuts;else state().wallEdits.$baseCuts=entry.baseCuts;}else state().base=entry;}
 function rebuildGrade(){
  cancel();sketchEditor?.clear();host.setLayer('base');
  const before=copy(base()),wallEditsBefore=copy(state().wallEdits||{}),next=B.fitGrade(before,state().ground);
  // Reground must use the same attachment mapping as an ordinary base edit.
  // Compute it first: invalid attached faces must not leave half an edit behind.
  const edits=window.WallBaseBinding?window.WallBaseBinding.follow(wallEditsBefore,before,next):copy(wallEditsBefore);
  if(edits.$base)edits.$base=next;delete edits.$baseCuts;
  history.push({baseBefore:before,wallEditsBefore});host.recordHistory?.({base:copy(before),wallEdits:copy(wallEditsBefore)});
  state().wallEdits=edits;state().base=next;
  window.WallChimneys?.syncFoundation(state(),{force:true});select(null);message='Base and attached walls regrounded';changed(false);
 }
 function changed(rebind=true){const entry=pendingBinding;if(rebind)followBase();else pendingBinding=null;if(rebind&&entry)host.recordHistory?.({base:copy(entry.baseBefore),wallEdits:copy(entry.wallEditsBefore)});host.changed();render();}

 function select(f){selectedFace=f?.id??null;selectedFaces=f?[f.id]:[];planeCycle=null;points=[];tool=null;message='';}

 function selectFace(f,add=false){

  planeCycle=null;message='';points=[];

  if(!add)selectedFaces=[f.id];

  else if(selectedFaces.includes(f.id))selectedFaces=selectedFaces.filter(id=>id!==f.id);

  else selectedFaces.push(f.id);

  selectedFace=selectedFaces.includes(f.id)?f.id:selectedFaces[selectedFaces.length-1]??null;sketchEditor?.setFace(f);

 }

 function alignFaces(){

  if(!planeCycle){

   checkpoint();planeCycle={original:copy(base()),ids:selectedFaces.slice(),step:-1};

  }

  const c=planeCycle;c.step=(c.step+1)%(c.ids.length+1);

  const originals=c.ids.map(id=>c.original.faces.find(f=>f.id===id));

  const master=originals[c.step];

  const all=originals.flatMap(f=>f.points);

  const plane=master?G.plane(master.points):{dx:0,dy:0,k:all.reduce((sum,p)=>sum+p.z,0)/all.length};

  if(!plane)throw Error('The reference face does not define a plane.');

  for(const f of base().faces){if(!c.ids.includes(f.id))continue;const original=originals.find(o=>o.id===f.id);f.points=original.points.map(p=>({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}));}

  window.BaseSketchGeometry?.rebind(c.original,base());
  message=master?`Coplanar to ${master.id} (${c.step+1}/${c.ids.length+1}) · H cycles original reference planes`:`All selected faces horizontal (${c.ids.length+1}/${c.ids.length+1}) · H returns to the first reference`;

  pendingBinding=history.at(-1);changed();

 }

 function action(fn){return ()=>{try{if(!host.ensure())return;fn();}catch(e){message=e.message;render();}};}

 function setup(panel){

  const box=document.createElement('div');box.innerHTML='<hr><h3>Editing</h3><div class="wall-row"><button id="base-visible">Base visible</button><button id="base-undo">Undo base</button><button id="base-rebuild-grade" title="Fit the base and attached wall bottoms to the current reference grade">Reground</button></div><div class="wall-fields"><label>Layer<select id="base-layer"><option value="base">Base</option><option value="walls">Walls</option></select></label><label>Selection<select id="base-selection"><option value="point">Points</option><option value="line">Lines</option><option value="face">Faces</option></select></label></div><div class="wall-row"><button id="base-connect">U · Connect</button><button id="base-new">N · Draw line</button><button id="base-curve" title="Draw a circular or elliptical arc from a selected point on a face">S · Draw curve</button><button id="base-delete">Delete</button><button id="base-move">M · Height</button><button id="base-chamfer" title="Bevel selected corner edges or corner points">C &#183; Chamfer</button><button id="base-fillet" title="Round selected wall edges or corner points">R · Fillet</button><button id="base-extrude">E · Extrude</button><button id="base-flat">H · Horizontal</button><button id="base-pitch">Y · Pitch</button></div><p id="base-status"></p>';

  panel.appendChild(box);

  sketchEditor=window.createBaseSketchEditor?.({pickVisible:host.pickVisible,pickLineVisible:host.pickLineVisible,opaque:()=>host.state()?.translucent===false,base,active,mode:()=>$('selection').value,position,screen,toPixel:host.toPixel,mouse:()=>mouse,

   referencePoints:()=>{const W=window.WallSolidGeometry,edits=state()?.wallEdits||{};return [...(host.walls?.()||[]).flatMap(w=>[...w.bottom,...w.top]),...(W?.surfaceWire(edits).nodes||[]).filter(n=>!n.curveSample),...Object.values(edits.$drafts||{}).flatMap(d=>(d.sketch?.nodes||[]).map(n=>d.frame?W.fromFrame(d.frame,n):{x:d.origin.x+d.u.x*n.x,y:d.origin.y+d.u.y*n.x,z:n.y}))];},selectFace:f=>{selectFace(f);render();host.redraw();},faceAt:(e,v)=>hit(e,v)?.f||face(),isCenter:(e,v)=>hit(e,v)?.index===-1,

   restore:value=>{state().base=value;},commit:before=>{record(before);planeCycle=null;changed();},

   message:text=>{message=text;render();},redraw:host.redraw});

  const readout=document.createElement('p');readout.id='base-grade-readout';box.appendChild(readout);

  gradeBadge=document.createElement('div');gradeBadge.id='base-grade-preview';gradeBadge.hidden=true;

  Object.assign(gradeBadge.style,{position:'fixed',pointerEvents:'none',zIndex:10001,padding:'7px 10px',border:'1px solid #d6a4ff',borderRadius:'6px',background:'rgba(25,20,32,.94)',color:'#fff',font:'13px system-ui',whiteSpace:'pre-line'});

  document.body?.appendChild(gradeBadge);

  $('visible').onclick=action(()=>{base().visible=!base().visible;if(!base().visible){select(null);host.selectVisibleLayer?.();}changed();});

  $('rebuild-grade').onclick=action(rebuildGrade);


  $('layer').onchange=()=>{cancel();host.setLayer($('layer').value);render();};

  $('selection').onchange=()=>{sketchEditor?.clear();points=[];message='';host.redraw();};

  $('undo').onclick=action(()=>{if(host.undo){host.undo();return;}sketchEditor?.clear();if(history.length){restoreHistory();select(null);changed(false);}});

  for(const [id,key]of [['connect','u'],['chamfer','c'],['fillet','r'],['curve','s'],['new','n'],['delete','delete'],['move','m'],['extrude','e'],['flat','h'],['pitch','y']])$(id).onclick=()=>{const e={key,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}};if(!host.handleKey?.(e))keyDown(e);};

  window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',cancel,true);

 }

 function render(){

  if(!$('status'))return;

  if(project!==host.id()){project=host.id();select(null);history=[];drag=null;message='';}

  if(!$('visible').dataset.layerIcon)$('visible').textContent='Base';$('visible').setAttribute('aria-pressed',String(base()?.visible!==false));



  $('chamfer').textContent='C · Chamfer';$('extrude').disabled=false;$('layer').value=host.layer();$('undo').disabled=host.canUndo?!host.canUndo():!history.length;if(host.undo)$('undo').textContent='Undo';$('move').textContent=host.layer()==='walls'?'M · In / out':'M · Height';

  for(const id of ['connect','new','delete','pitch'])$(id).disabled=host.layer()!=='base';

  $('status').textContent=message||(host.layer()==='walls'?'Walls selected':tool?tool.kind==='pitch'?(tool.direction?'Move vertically to preview pitch; click to place.':'Click to set radius and direction; near 45° increments snap.') :tool.kind==='path'?'Click a split path; Enter to finish.':'Move vertically to preview elevation; click to place.':face()?(selectedFaces.length>1?selectedFaces.length+' faces selected · H cycles reference planes':selectedFace+' · '+points.length+' selected points'):(base()?.faces.length||0)+' base faces · select a face or boundary points');

  renderGrade();

 }

 function renderGrade(){

  const plane=face()&&G.plane(face().points),visible=active()&&plane;

  const format=slope=>`${(slope*100).toFixed(1)}% · ${(Math.atan(slope)*180/Math.PI).toFixed(1)}°`;

  const text=visible?`Face grade: ${format(Math.hypot(plane.dx,plane.dy))}`:'';

  if($('grade-readout'))$('grade-readout').textContent=text;

  if(!gradeBadge)return;

  gradeBadge.hidden=!(visible&&tool?.kind==='pitch'&&mouse);

  if(gradeBadge.hidden)return;

  const directional=tool.direction?plane.dx*tool.direction.x+plane.dy*tool.direction.y:null;

  gradeBadge.textContent=directional===null?text:`Along handle: ${format(directional)}\n${text}`;

  gradeBadge.style.left=Math.max(8,Math.min(mouse.e.clientX+18,(window.innerWidth||Infinity)-260))+'px';

  gradeBadge.style.top=Math.max(8,Math.min(mouse.e.clientY+18,(window.innerHeight||Infinity)-70))+'px';

 }

 function view(e){if(e.target.closest?.('#wall-panel,.enh-control-panel,.controls-3d-actions'))return null;return e.target.closest?.('#three-view-wrapper')?'3d':e.target.closest?.('#viewport')?'2d':null;}

 function position(e,v,z){return host.position(e,v,z);}

 function screen(p,v){

  if(v==='2d'){const q=host.toPixel(p),m=document.getElementById('geo-rotation-group').getScreenCTM(),d=new DOMPoint(q.x,q.y).matrixTransform(m);return {x:d.x,y:d.y};}

  const q=getVector3(host.toPixel(p)).project(camera),r=renderer.domElement.getBoundingClientRect();return {x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2};

 }

 function hit(e,v){

  let best=null,d=12;
  let front=null;
  if(v==='3d'&&typeof THREE!=='undefined'){
   const r=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
   for(const m of meshes)m.updateMatrixWorld(true);front=ray.intersectObjects(meshes)[0]||null;
  }


  for(const f of base().faces.filter(f=>!front||f.id===front.object.userData.baseId)){

   const candidates=f.points.map((p,i)=>({p,i})).filter(c=>!window.BaseSketchGeometry?.isCurveSample?.(base(),c.p));

   if(state()?.wallCenters!==false)candidates.push({p:B.center(f),i:-1});

   for(const c of candidates){const q=screen(c.p,v),n=Math.hypot(q.x-e.clientX,q.y-e.clientY);if(n<d){d=n;best={f,index:c.i};}}

  }

  if(best)return best;

  if(v==='2d'){for(const f of [...base().faces].reverse()){const p=position(e,v,B.center(f).z);if(p&&displayed(f).some(points=>G.contains({points},p)))return {f,index:null};}}

  else if(front)return {f:base().faces.find(f=>f.id===front.object.userData.baseId),index:null};
  return null;

 }

 function finishPath(){

  const f=face();if(!f)throw Error('Select a base face first.');

  const path=tool?.kind==='path'?tool.path:points.map(i=>f.points[i]);

  const result=B.split(f,path);checkpoint();const i=base().faces.indexOf(f);result[1].id='base-'+Date.now();base().faces.splice(i,1,...result);select(result[0]);changed();

 }


 function stepCommand(){
  if(!active())return false;
  try{if(tool&&tool.kind!=='step')throw Error('Place the current edit or press Escape first.');
   if(!tool){const f=face();if(!f)throw Error('Select a sloped base face first.');sketchEditor?.clear();points=[];tool={kind:'step',original:copy(base()),originalEdits:copy(state().wallEdits||{}),faceId:f.id,count:1,anchor:null,valid:false};}
   else tool.count++;
   previewStep();
  }catch(e){message=e.message;}render();host.redraw();return true;
 }
 function stepWheel(e){if(!e.ctrlKey)return false;if(!active()||tool?.kind!=='step'||!view(e))return false;tool.sizeScale=window.WallSteps.wheelScale(tool.sizeScale,e);previewStep();render();host.redraw();return true;}
 function previewStep(e){const t=tool;if(!t||t.kind!=='step')return;
  try{const source=t.original.faces.find(f=>f.id===t.faceId),pl=G.plane((t.original.stepPatterns?.[source.baseStepId]?.source||source).points);
   if(e&&mouse){const p=position(e,mouse.v,B.center(source).z);if(p)t.anchor={...p,z:pl.dx*p.x+pl.dy*p.y+pl.k};}
   const result=window.WallSteps.basePattern(t.original,t.faceId,t.count,t.anchor,t.sizeScale||1,{alignToBoundary:!(typeof isFreeMove!=='undefined'&&isFreeMove)}),next=result.base,edits=window.WallBaseBinding.follow(t.originalEdits,t.original,next);
   if(t.originalEdits.$base)edits.$base=next;state().wallEdits=edits;state().base=next;t.valid=true;t.pattern=result.pattern;if(t.sizeScale&&t.count>1)t.sizeScale=t.pattern.spacing*t.pattern.sections/t.pattern.run;
   message=t.count+' base steps · '+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((Math.abs(t.pattern.rise)/t.count/.3048), 'ft') : (Math.abs(t.pattern.rise)/t.count/.3048).toFixed(2)+" ft")+" rise · "+(window.ReportUnits?.current().metric ? window.ReportUnits.current().quantity((t.pattern.spacing/.3048), 'ft') : (t.pattern.spacing/.3048).toFixed(2)+" ft")+" width"+(result.alignedToBoundary?' · aligned to base edge':'')+' · S count; move offset; Ctrl+wheel width; click to place';
  }catch(e){t.valid=false;message=e.message;}
 }
 function placeStep(){if(!tool?.valid)return;const t=tool,next=copy(base());state().wallEdits=copy(t.originalEdits);state().base=next;record(t.original);tool=null;changed();}
 function finishToolForSwitch(){
  try{
   if(tool?.numericInvalid||tool?.valid===false){message='Adjust the invalid preview or press Escape before switching tools.';render();return false;}
   if(tool?.kind==='step'){placeStep();return !tool;}
   if(tool?.kind==='path'){if(tool.path.length<2){message='Finish the path or press Escape before switching tools.';render();return false;}finishPath();tool=null;}
   if(tool?.original){const t=tool;if(JSON.stringify(base())!==JSON.stringify(t.original)){record(t.original);changed();}tool=null;}
   if(drag){const d=drag;drag=null;if(JSON.stringify(base())!==JSON.stringify(d.original)){record(d.original);changed();}}
   return sketchEditor?.finishToolForSwitch?.()!==false;
  }catch(error){message=error.message;render();return false;}
 }
 function keyDown(e){

  if(!active())return false;

  const k=e.key.toLowerCase();if(k==='s'&&(e.ctrlKey||e.metaKey))return false;if(!['f','c','u','n','m','h','y','escape','enter','z','delete','backspace','tab','s'].includes(k))return false;

  e.preventDefault();e.stopImmediatePropagation();

  try{

   message='';
   if(!e.ctrlKey&&!e.metaKey&&tool&&['m','y','n','h','c','u','s'].includes(k)&&!(tool.kind==='step'&&k==='s')&&!(tool.kind==='path'&&k==='c')&&!finishToolForSwitch())return true;

   if(k==='escape'){cancel();return true;}
   if(k==='s'&&!e.ctrlKey&&!e.metaKey){if(!tool&&(sketchEditor?.singlePoint()||sketchEditor?.interaction()==='Draw curve'))return sketchEditor.keyDown(e);if(!e.repeat)stepCommand();return true;}
   if(tool?.kind==='step'){if(k==='enter')placeStep();return true;}

   if(k==='tab'&&sketchEditor){sketchEditor.clear();const modes=['point','line','face'];$('selection').value=modes[(modes.indexOf($('selection').value)+1)%modes.length];points=[];message='';render();host.redraw();return true;}

   if(k==='n'&&sketchEditor)$('selection').value='point';

   if(sketchEditor&&!(tool?.kind==='pitch'||tool?.kind==='height')&&sketchEditor.keyDown(e)){e.preventDefault();e.stopImmediatePropagation();return true;}

   if(k==='z'&&(e.ctrlKey||e.metaKey)){sketchEditor?.clear();if(history.length){restoreHistory();select(null);changed(false);}return true;}

   if(k==='enter'){if(tool?.numericInvalid)return true;if(tool?.kind==='path')finishPath();else if(tool?.original&&(tool.kind==='height'||tool.direction)){record(tool.original);tool=null;changed();}return true;}

   if(k==='c'){finishPath();return true;}

   if(!face())throw Error('Select a base face or one of its points first.');

   if(k!=='h')planeCycle=null;

   if(k==='h'){

    if(e.repeat)return true;

    cancelPreview();

    if(selectedFaces.length>1&&!points.length){alignFaces();return true;}

    checkpoint();const f=face(),z=B.center(f).z;

    if(points.length){const z=points.reduce((s,i)=>s+f.points[i].z,0)/points.length;points.forEach(i=>f.points[i].z=z);}

    else Object.assign(f,B.transform(f,'flat',0));
    window.BaseSketchGeometry?.rebind(history.at(-1).baseBefore,base());

    changed();return true;

   }

   if(k==='n')tool={kind:'path',path:points.length?[copy(face().points[points[0]])]:[]};

   if(k==='m'){cancelPreview();tool={kind:'height',original:copy(base()),f:copy(face()),clientY:mouse?.e.clientY};}

   if(k==='y'){cancelPreview();points=[];tool={kind:'pitch',original:copy(base()),f:copy(face()),pivot:B.center(face()),direction:null,radius:0};}

   render();host.redraw();

  }catch(err){message=err.message;render();}return true;

 }

 function pitchDirection(p){const dx=p.x-tool.pivot.x,dy=p.y-tool.pivot.y,angle=Math.atan2(dy,dx),input={x:Math.cos(angle),y:Math.sin(angle)};
  if(typeof isFreeMove!=='undefined'&&isFreeMove)return input;
  const snap=B.boundaryAxis(tool.f,input);if(snap)return snap.direction;
  const world=Math.round(angle/(Math.PI/4))*Math.PI/4;return Math.abs(angle-world)<Math.PI/36?{x:Math.cos(world),y:Math.sin(world)}:input;
 }
 function down(e){

  if(!active()||e.button!==0)return false;const v=view(e);if(!v)return false;mouse={e,v};if(tool?.numericInvalid)return true;

  try{

   if(tool?.kind==='step'){placeStep();return true;}
   if(tool?.kind==='path'){const p=position(e,v,B.center(face()).z);if(p){const h=hit(e,v);tool.path.push(h?.f===face()&&Number.isInteger(h.index)&&h.index>=0?copy(face().points[h.index]):p);host.redraw();}return true;}

   if(tool?.kind==='pitch'&&!tool.direction){const p=position(e,v,tool.pivot.z);if(!p)return true;const dx=p.x-tool.pivot.x,dy=p.y-tool.pivot.y,r=Math.hypot(dx,dy);if(r<.1)throw Error('Choose a radius of at least 10 cm.');

    tool.direction=pitchDirection(p);tool.radius=r;tool.clientY=e.clientY;host.redraw();render();return true;

   }

   if(tool){preview(e);record(tool.original);tool=null;changed();return true;}

   if(sketchEditor&&face()&&$('selection').value==='face'){const h=hit(e,v);if((Number.isInteger(h?.index)&&h.index>=0)||sketchEditor.canHit(e,v))$('selection').value='point';}
   if(sketchEditor&&!sketchEditor.busy()){const h=hit(e,v);if(h&&(h.index===null||h.index===-1)&&!sketchEditor.canPick(e,v)){selectFace(h.f,e.shiftKey||e.ctrlKey||e.metaKey);render();host.redraw();return true;}}
   if(sketchEditor?.down(e,v))return true;

   if(v==='2d'){

    const h=hit(e,v);

    if(!h||h.index===null){marquee={x:e.clientX,y:e.clientY,ex:e.clientX,ey:e.clientY,add:e.shiftKey,face:selectedFace,points:points.slice(),hit:h,mode:$('selection').value};return true;}

   }

   const h=hit(e,v);if(!h){select(null);render();host.redraw();return true;}

   if($('selection').value==='face'||h.index===null||h.index===-1){selectFace(h.f,e.shiftKey);render();host.redraw();return true;}

   planeCycle=null;message='';selectedFaces=[h.f.id];

   if(selectedFace!==h.f.id){selectedFace=h.f.id;points=[];}

   if(h.index!==null&&h.index>=0&&$('selection').value!=='face'){

    if(e.shiftKey){if(!points.includes(h.index))points.push(h.index);}

    else if(!points.includes(h.index))points=[h.index];

    drag={original:copy(base()),f:copy(face()),clientY:e.clientY,view:v,start:position(e,v,face().points[h.index].z),indices:points.slice(),point:copy(face().points[h.index])};

   }else points=[];

   render();host.redraw();return true;

  }catch(err){message=err.message;render();return true;}

 }

 function move(e){
  if(!(e.buttons&1)&&(drag||marquee)){cancel();return;}

  const v=view(e);if(v)mouse={e,v};

  if(!active()||(e.buttons&6))return;

  if(sketchEditor?.move(e,v)){e.preventDefault();e.stopImmediatePropagation();return;}

  if(marquee){marquee.ex=e.clientX;marquee.ey=e.clientY;drawBox();e.preventDefault();e.stopImmediatePropagation();return;}

  if(!drag){if(tool){if(v)preview(e);render();host.redraw();}return;}

  e.preventDefault();e.stopImmediatePropagation();

  const d=drag,f=face();if(!f)return;

  try{

   if(d.tool?.kind==='pitch'){

    const slope=(d.clientY-e.clientY)*.03/d.tool.radius;

    Object.assign(f,B.transform(d.f,'pitch',slope,d.tool.direction,d.tool.pivot));

   }else if(d.tool?.kind==='height') {

    const delta=(d.clientY-e.clientY)*.03;

    f.points=copy(d.f.points);for(const i of points.length?points:f.points.map((_,i)=>i))f.points[i].z+=delta;

   }else{

    if(!d.start)return;const p=position(e,d.view,d.point.z);if(!p)return;

    f.points=copy(d.f.points);for(const i of d.indices){if(e.shiftKey)f.points[i].z+=(d.clientY-e.clientY)*.03;else{f.points[i].x+=p.x-d.start.x;f.points[i].y+=p.y-d.start.y;}}

   }

   B.validate(f);
  window.BaseSketchGeometry?.rebind(d.original,base());d.changed=true;renderGrade();host.redraw();

  }catch(err){Object.assign(f,copy(d.f));message=err.message;}

 }

 function up(e){
  if(e.button!==undefined&&e.button!==0)return;

  if(sketchEditor?.up(e)){e.stopImmediatePropagation();return;}

  if(marquee){finishBox();e.stopImmediatePropagation();return;}

  if(!drag)return;const d=drag;drag=null;e.stopImmediatePropagation();

  if(d.changed){record(d.original);tool=null;changed();}

 }

 function cancelPreview(){if(tool?.originalEdits)state().wallEdits=copy(tool.originalEdits);if(tool?.original)state().base=tool.original;tool=null;}

 function cancel(){sketchEditor?.cancel();if(drag){state().base=drag.original;drag=null;}cancelPreview();marquee=null;selectionBox?.remove?.();selectionBox=null;message='';host.redraw();render();}

 function preview(e){
  if(tool?.kind==='step'){previewStep(e);return;}

  if(!tool?.original||tool.kind==='pitch'&&!tool.direction)return;

  const f=face();if(!f)return;

  if(tool.clientY===undefined)tool.clientY=e.clientY;

  let delta=tool.numeric??((tool.clientY-e.clientY)*.03);tool.amount=delta;tool.heightSnap=null;if(tool.kind==='height'&&tool.numeric==null&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){tool.heightSnap=B.heightSnap(tool.f,tool.original.faces,delta,p=>screen(p,mouse?.v||'3d'));if(tool.heightSnap){delta=tool.heightSnap.amount;message=tool.heightSnap.kind;}else message='';}

  if(tool.kind==='height'){f.points=copy(tool.f.points);for(const i of points.length?points:f.points.map((_,i)=>i))f.points[i].z+=delta;}

  else {const pl=G.plane(tool.f.points),slope=tool.numeric!=null?Math.tan(tool.numeric*Math.PI/180):pl.dx*tool.direction.x+pl.dy*tool.direction.y+delta/tool.radius;Object.assign(f,B.transform(tool.f,'pitch',slope,tool.direction,tool.pivot));tool.amount=Math.atan(slope)*180/Math.PI;}

  B.validate(f);
  window.BaseSketchGeometry?.rebind(tool.original,base());

 }

 function drawBox(){

  if(!selectionBox){selectionBox=document.createElement('div');Object.assign(selectionBox.style,{position:'fixed',pointerEvents:'none',border:'1px solid #d6a4ff',background:'rgba(214,164,255,.12)',zIndex:10000});document.body?.appendChild(selectionBox);}

  Object.assign(selectionBox.style,{left:Math.min(marquee.x,marquee.ex)+'px',top:Math.min(marquee.y,marquee.ey)+'px',width:Math.abs(marquee.ex-marquee.x)+'px',height:Math.abs(marquee.ey-marquee.y)+'px'});

 }

 function finishBox(){

  const box=marquee;marquee=null;selectionBox?.remove?.();selectionBox=null;

  if(Math.hypot(box.ex-box.x,box.ey-box.y)<4){if(box.hit?.f)selectFace(box.hit.f,box.add);else if(!box.add)select(null);render();host.redraw();return;}

  if(box.mode==='face'){

   const inside=p=>{const q=screen(p,'2d');return q.x>=Math.min(box.x,box.ex)&&q.x<=Math.max(box.x,box.ex)&&q.y>=Math.min(box.y,box.ey)&&q.y<=Math.max(box.y,box.ey);};

   const ids=base().faces.filter(f=>[...f.points,B.center(f)].some(inside)).map(f=>f.id);

   selectedFaces=[...new Set([...(box.add?selectedFaces:[]),...ids])];selectedFace=selectedFaces[selectedFaces.length-1]??null;points=[];planeCycle=null;message='';render();host.redraw();return;

  }

  const candidates=base().faces.map(f=>({f,ids:f.points.flatMap((p,i)=>{if(window.BaseSketchGeometry?.isCurveSample?.(base(),p))return [];const q=screen(p,'2d');return q.x>=Math.min(box.x,box.ex)&&q.x<=Math.max(box.x,box.ex)&&q.y>=Math.min(box.y,box.ey)&&q.y<=Math.max(box.y,box.ey)?[i]:[];})})).filter(c=>c.ids.length);

  // Connections subdivide one face; prefer that face when adding to its selection.

  const chosen=candidates.find(c=>c.f.id===box.face)||candidates.sort((a,b)=>b.ids.length-a.ids.length)[0];

  if(chosen){selectedFace=chosen.f.id;selectedFaces=[selectedFace];planeCycle=null;message='';points=[...new Set([...(box.add&&box.face===selectedFace?box.points:[]),...chosen.ids])];}

  else if(!box.add)select(null);

  render();host.redraw();

 }

 function guides(){

  if(tool?.heightSnap)return tool.heightSnap.guide;
  if(tool?.kind==='path')return tool.path;

  if(tool?.kind!=='pitch')return [];

  const p=tool.pivot;let radius=tool.radius,direction=tool.direction;

  if(!direction&&mouse){const q=position(mouse.e,mouse.v,p.z);if(q){radius=Math.hypot(q.x-p.x,q.y-p.y);direction=pitchDirection(q);}}

  if(!direction)return [];

  const pl=G.plane(face().points),slope=pl.dx*direction.x+pl.dy*direction.y;

  const norm=v=>{const n=Math.hypot(v.x,v.y,v.z);return {x:v.x/n,y:v.y/n,z:v.z/n};};

  const u=norm({x:direction.x,y:direction.y,z:slope}),n=norm({x:-pl.dx,y:-pl.dy,z:1});

  const v={x:n.y*u.z-n.z*u.y,y:n.z*u.x-n.x*u.z,z:n.x*u.y-n.y*u.x};

  const at=a=>({x:p.x+radius*(Math.cos(a)*u.x+Math.sin(a)*v.x),y:p.y+radius*(Math.cos(a)*u.y+Math.sin(a)*v.y),z:p.z+radius*(Math.cos(a)*u.z+Math.sin(a)*v.z)});

  const line=[p,at(0)];for(let i=0;i<=64;i++)line.push(at(i*Math.PI/32));return line;

 }

 function draw2D(rot,svg,inv){

  if(!base()||base().visible===false)return;

  for(const f of base().faces){const ps=f.points.map(p=>host.toPixel(p)),chosen=selectedFaces.includes(f.id);

   for(const poly of displayed(f))svg('polygon',{points:poly.map(p=>host.toPixel(p)).map(p=>p.x+','+p.y).join(' '),fill:reference(f.id)?'#ffbf69':chosen?'#efdcff':COLOR,'fill-opacity':chosen?.22:.08,stroke:(state()?.wallEdits?.$baseCuts||[]).length?'none':reference(f.id)?'#ffbf69':COLOR,'stroke-width':2*inv,'pointer-events':'none'},rot);

   if((state()?.wallEdits?.$baseCuts||[]).length){for(const ring of [f.points,...state().wallEdits.$baseCuts.filter(c=>!c.faceIds||c.faceIds.includes(f.id)).map(c=>c.points)]){const qs=ring.map(host.toPixel);svg('polyline',{points:[...qs,qs[0]].map(p=>p.x+','+p.y).join(' '),fill:'none',stroke:COLOR,'stroke-width':2*inv,'pointer-events':'none'},rot);}}

   f.points.forEach((p,i)=>{if(window.BaseSketchGeometry?.isCurveSample?.(base(),p))return;const q=ps[i];svg('circle',{cx:q.x,cy:q.y,r:(chosen&&points.includes(i)?6:4)*inv,fill:chosen&&points.includes(i)?'#fff':COLOR,'pointer-events':'none'},rot);});

   if(state()?.wallCenters!==false){const q=host.toPixel(B.center(f));svg('circle',{cx:q.x,cy:q.y,r:6*inv,fill:chosen?'#fff':COLOR,stroke:'#613278','stroke-width':inv,'pointer-events':'none'},rot);}

  }

  const ps=guides().map(p=>host.toPixel(p));if(ps.length)svg('polyline',{points:ps.map(p=>p.x+','+p.y).join(' '),fill:'none',stroke:tool?.heightSnap?'#FFD700':'#fff','stroke-width':2*inv,'pointer-events':'none'},rot);

  sketchEditor?.draw2D(rot,svg,inv);

 }

 function draw3D(group,vector){

  meshes=[];if(!base()||base().visible===false)return;

  for(const f of base().faces){

   const polygons=displayed(f),vertices=[],indices=[];for(const poly of polygons){const offset=vertices.length/3;vertices.push(...poly.flatMap(p=>{const v=vector(p);return [v.x,v.y,v.z];}));indices.push(...B.triangles(poly).flat().map(i=>i+offset));}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);

   const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:reference(f.id)?'#ffbf69':selectedFaces.includes(f.id)?'#efdcff':COLOR,side:THREE.DoubleSide,transparent:true,opacity:.28,depthWrite:false}));mesh.userData.baseId=f.id;window.ExteriorFinishes?.prepare(mesh,{...f,material:f.material||'default'},polygons.flat());group.add(mesh);meshes.push(mesh);

   const edge=f.points.flatMap((p,i)=>[p,f.points[(i+1)%f.points.length]]),geo=new THREE.BufferGeometry();geo.setFromPoints(edge.map(vector));group.add(new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:COLOR,depthTest:false})));

   const dots=f.points.map((p,i)=>({p,chosen:f.id===selectedFace&&points.includes(i)})).filter(d=>!window.BaseSketchGeometry?.isCurveSample?.(base(),d.p));if(state()?.wallCenters!==false)window.wallCenterMarker?.(group,vector,B.center(f));

   for(const selected of [false,true]){const ps=dots.filter(d=>d.chosen===selected).map(d=>vector(d.p));const geo=new THREE.BufferGeometry().setFromPoints(ps);group.add(new THREE.Points(geo,new THREE.PointsMaterial({color:selected?'#fff':COLOR,size:selected?12:8,sizeAttenuation:false,depthTest:false})));}

  }

  const guide=guides();if(guide.length){const geo=new THREE.BufferGeometry().setFromPoints(guide.map(vector));group.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:tool?.heightSnap?'#FFD700':'#fff',depthTest:false})));}

  sketchEditor?.draw3D(group,vector);

 }

 return {selectionSnapshot:()=>copy({selectedFace,selectedFaces,points,planeCycle,mode:$('selection')?.value,sketch:sketchEditor?.selectionSnapshot?.()}),restoreSelection(value){const s=copy(value||{});selectedFace=s.selectedFace||null;selectedFaces=s.selectedFaces||[];points=s.points||[];planeCycle=s.planeCycle||null;if(s.mode&&$('selection'))$('selection').value=s.mode;sketchEditor?.restoreSelection?.(s.sketch);},selectedFaceGeometry:()=>face()&&({face:copy(face()),event:mouse?.e}),finishToolForSwitch,chamferSelection:()=>({...sketchEditor?.chamferSelection(),view:mouse?.v,event:mouse?.e}),stepWheel,stepCommand,cancelPointerGesture(){sketchEditor?.cancelPointerGesture();if(drag||marquee)cancel();},interaction:()=>tool?"Base "+tool.kind:drag?"Move base":marquee?"Rectangle selection":sketchEditor?.interaction(),selectEntities:(ps,pairs,add,subtract)=>{selectedFace=null;selectedFaces=[];points=[];sketchEditor?.selectEntities(ps,pairs,add,subtract);render();host.redraw();},selectedFaceId:()=>selectedFace,entitySelection:()=>({point:sketchEditor?.singlePoint()||(face()&&points.length===1?copy(face().points[points[0]]):null),pair:sketchEditor?.singleLine(),event:mouse?.e}),distanceInput(){if(!tool||!['height','pitch'].includes(tool.kind)||tool.kind==='pitch'&&!tool.direction)return null;const t=tool,angle=t.kind==='pitch';const pl=angle?G.plane(face().points):null;return {token:t,...(angle?{unit:'degrees',unitsPerInput:1,allowZero:true}:{}),amount:angle?Math.atan(pl.dx*t.direction.x+pl.dy*t.direction.y)*180/Math.PI:t.amount,set(value){if(angle&&value!=null&&Math.abs(value)>=90){t.numericInvalid=true;message='Enter an angle between -90 and 90 degrees.';render();return;}t.numericInvalid=false;t.numeric=value;message='';if(mouse)preview(mouse.e);host.redraw();render();}};},finishPointer:up,singlePoint:()=>sketchEditor?.singlePoint()||(face()&&points.length===1?copy(face().points[points[0]]):null),busy:()=>!!tool||!!drag||!!marquee||!!sketchEditor?.busy(),canHit:e=>base()?.visible!==false&&!!base()&&!!view(e)&&(!!hit(e,view(e))||!!sketchEditor?.canHit(e,view(e))),clearSelection(){select(null);sketchEditor?.clear();},setup,render,draw2D,draw3D,down,keyDown,doubleClick:e=>{if(!active())return false;$('selection').value='point';return sketchEditor?.doubleClick(e,view(e));},leave:cancel};

};

})();
