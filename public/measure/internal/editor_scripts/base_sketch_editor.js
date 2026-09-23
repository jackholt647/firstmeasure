/* Point/line editing over the base sketch, isolated from roof edit handlers. */
(function(){
'use strict';
window.createBaseSketchEditor=function(host){
 const S=window.BaseSketchGeometry,G=window.WallGeometry,copy=v=>JSON.parse(JSON.stringify(v));
 let selected=[],lines=[],drag=null,armed=false,box=null,rect=null,preferredFace=null,preview=null,axisPreview=null,curveTool=null,lastView=null;
 const sketch=()=>S.read(host.base()),mode=()=>host.mode(),active=()=>host.active()&&mode()!=='face';
 const support=()=>preferredFace&&(host.base().faces.find(f=>f.id===preferredFace.id)||preferredFace);
 function setFace(f){preferredFace=f&&copy(f);selected=[];lines=[];}
 const onFace=(p,f)=>{const plane=f&&G.plane(f.points);return plane&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002&&G.contains(f,p);};
 function references(){const f=support();return f?[...host.base().faces.flatMap(f=>f.points),...(host.referencePoints?.()||[])].filter(p=>!p.curveSample&&!S.isCurveSample(host.base(),p)&&onFace(p,f)&&!sketch().nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y,actual(n).z-p.z)<.001)):[];}
 function referenceAt(e,v){return references().map(p=>({p,q:host.screen(p,v)})).filter(({p,q})=>Math.hypot(q.x-e.clientX,q.y-e.clientY)<12&&(v!=='3d'||host.pickVisible?.(p)!==false)).sort((a,b)=>Math.hypot(a.q.x-e.clientX,a.q.y-e.clientY)-Math.hypot(b.q.x-e.clientX,b.q.y-e.clientY))[0]?.p;}
 function inScope(p){const plane=support()&&G.plane(support().points);return !plane||Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002;}
 function connect(ids){S.connect(host.base(),ids);}
 const node=id=>sketch().nodes.find(n=>n.id===id);
 const actual=n=>n;
 function report(){host.message((mode()==='line'?lines.length+' lines':selected.length+' points')+' selected · gold = fixed wall boundary · cyan = editable');host.redraw();}
 function perform(fn){const before=copy(host.base());try{fn();host.commit(before);return true;}catch(e){host.restore(before);host.message(e.message);host.redraw();return false;}}
 function position(e,v,unbounded=false){
  const f=curveTool?.face||support()||host.faceAt(e,v),plane=f&&G.plane(f.points);let p=host.position(e,v,f?f.points[0].z:host.base().faces[0].points[0].z);
  if(!p)return;
  if(plane){
   // Intersect the cursor ray with the pitched face, not a horizontal slice.
   if(v==='3d'){const a=host.position(e,v,p.z),b=host.position(e,v,p.z+1);if(!a||!b)return;const dx=b.x-a.x,dy=b.y-a.y,den=1-plane.dx*dx-plane.dy*dy;if(Math.abs(den)<1e-8)return;const dz=(plane.dx*a.x+plane.dy*a.y+plane.k-a.z)/den;p={x:a.x+dx*dz,y:a.y+dy*dz,z:a.z+dz};}
   else p.z=plane.dx*p.x+plane.dy*p.y+plane.k;
  }
  if(!unbounded&&window.WallSolidGeometry&&!(typeof isFreeMove!=='undefined'&&isFreeMove)){
   const nodes=[...sketch().nodes.map(actual).filter(inScope),...references()],byId=id=>nodes.find(n=>n.id===id),edges=S.curveEdges(sketch()).map(e=>Object.assign([e.start,e.end],{curveId:e.curveId})).filter(pair=>pair.every(p=>p&&inScope(p)));
   p=window.WallSolidGeometry.draftSnap(p,nodes,edges,selected.map(byId).filter(Boolean),p=>host.screen(plane?{...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}:p,v),typeof snapRadius!=='undefined'?snapRadius:20,{lineCenters:host.lineCenters?.()!==false}).point;
   if(plane)p.z=plane.dx*p.x+plane.dy*p.y+plane.k;
  }
  return p;
 }
 function startArch(){
  const edge=lines.length===1&&sketch().edges.find(e=>e.id===lines[0]);if(!edge||edge.curveId){host.message('Select one straight line, then press A to arch it.');return true;}
  const pair=[node(edge.a),node(edge.b)].map(copy),face=support()||host.base().faces.find(f=>pair.every(p=>onFace(p,f)));if(!face)return false;
  curveTool={kind:'arch',start:pair[0],pair,face,normal:window.WallSolidGeometry.normal(face.points),controls:[],samples:pair,before:copy(host.base()),edgeId:edge.id};drag=null;armed=false;preview=null;host.message('Arch: click points; Enter / double-click / A finishes; Escape cancels.');host.redraw();return true;
 }
 function archMove(e,v){const t=curveTool,K=window.ExteriorGeometry,raw=position(e,v,true);if(!raw)return;t.snap=K.archSnap(t.pair,t.controls,raw,{normal:t.normal,points:[...sketch().nodes,...references()],screen:p=>host.screen(p,v),snap:!(typeof isFreeMove!=='undefined'&&isFreeMove),radius:typeof snapRadius!=='undefined'?snapRadius:20});t.pointer=t.snap.point;t.guides=t.snap.guides;t.curve=K.splineThrough(t.pair,[...t.controls,t.pointer],t.normal);t.samples=K.curveSamples(t.curve);host.message((t.snap.kind?t.snap.kind+' snap · ':'')+'Arch: click points; Enter / double-click / A finishes; Escape cancels.');host.redraw();}
 function archDown(e,v){archMove(e,v);const t=curveTool;if(t.pointer)t.controls=window.ExteriorGeometry.splineThrough(t.pair,[...t.controls,t.pointer],t.normal).controls.slice(1,-1);return true;}
 function finishArch(){const t=curveTool,K=window.ExteriorGeometry,c={...K.splineThrough(t.pair,t.controls,t.normal),id:'arch-'+Date.now()};if(!t.controls.length||K.curveSamples(c).every(p=>G.onEdge(p,...t.pair,1e-6))){curveTool=null;report();return true;}
  if(perform(()=>{const base=host.base(),result=K.archFaces(base.faces,c);if(result.affected.length){base.faces=result.faces;S.rebind(t.before,base);}else{base.sketch.edges=base.sketch.edges.filter(e=>e.id!==t.edgeId);S.addCurve(base,c);}})){curveTool=null;lines=[];selected=[];report();}return true;
 }
 function curveMove(e,v){if(curveTool.kind==='arch')return archMove(e,v);const t=curveTool,raw=position(e,v,true);if(!raw)return;const K=window.ExteriorGeometry,enabled=!(typeof isFreeMove!=='undefined'&&isFreeMove);t.snap=K.curveDrawSnap({start:t.start,center:t.center,point:raw,normal:t.normal,points:[...sketch().nodes,...references()],curves:sketch().curves||[],screen:p=>host.screen(p,v),snap:enabled,radius:typeof snapRadius!=='undefined'?snapRadius:20});const q=t.snap.point;t.pointer=q;t.track.close=t.snap.close;if(t.center){try{t.curve=window.ExteriorGeometry.arcPreview(t.start,t.center,q,t.normal,t.track,false);t.samples=window.ExteriorGeometry.curveSamples(t.curve);t.pointer=t.samples.at(-1);t.valid=Math.abs(t.curve.sweep)>1e-5;host.message((t.valid?'Curve':'Invalid curve')+' · '+(t.curve.radiusX===t.curve.radiusY?'Circle':'Ellipse')+' · '+(t.curve.sweep*180/Math.PI).toFixed(1)+'° · Click endpoint; Shift-click continues; Escape cancels.');}catch(error){t.valid=false;host.message(error.message);}}t.guides=K.curveDrawGuides({start:t.start,center:t.center,pointer:t.pointer,snap:t.snap,normal:t.normal});host.redraw();}
 function curveDown(e,v){if(curveTool.kind==='arch')return archDown(e,v);curveMove(e,v);const t=curveTool;if(!t.center){if(!t.pointer||Math.hypot(t.pointer.x-t.start.x,t.pointer.y-t.start.y,t.pointer.z-t.start.z)<1e-5)return true;t.center={...t.pointer};t.track={};host.message('Move around the center to set sweep; radius snaps to a circle. Shift-click continues another arc.');host.redraw();return true;}if(!t.valid)return true;let id;if(perform(()=>{id=S.addCurve(host.base(),t.curve);})){selected=[id];if(e.shiftKey){curveTool={start:copy(node(id)),center:copy(t.center),normal:copy(t.normal),face:t.face,track:{}};host.message('Continue around the same center. Shift-click adds another arc; click finishes; Escape cancels the pending arc.');host.redraw();}else{curveTool=null;report();}}return true;}

 function insert(e,v,join=false){lastView=v;const p=position(e,v);if(!p){host.message('Place the point on the selected base face.');return false;}const from=join&&selected.length===1?selected[0]:null;let id;const ok=perform(()=>{id=S.add(host.base(),p,.0001);if(from&&from!==id)connect([from,id]);else S.resolve(host.base());});if(ok){selected=[id];lines=[];armed=false;preview=null;report();}return ok;
 }
 function closest(e,v){
  let id=null,best=12;
  if(mode()==='line'){
   for(const edge of S.curveEdges(sketch())){const a=host.screen(edge.start,v),b=host.screen(edge.end,v),dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((e.clientX-a.x)*dx+(e.clientY-a.y)*dy)/(dx*dx+dy*dy))),d=Math.hypot(e.clientX-a.x-t*dx,e.clientY-a.y-t*dy);if(d<best&&(v!=='3d'||host.pickLineVisible?.([edge.start,edge.end],e)!==false)){id=edge.id;best=d;}}
  }else for(const n of sketch().nodes.filter(n=>inScope(actual(n)))){const p=host.screen(actual(n),v),d=Math.hypot(p.x-e.clientX,p.y-e.clientY);if(d<best&&(v!=='3d'||host.pickVisible?.(actual(n))!==false)){best=d;id=n.id;}}
  return id;
 }
 function down(e,v){lastView=v;
  if(!active()||!v||e.button!==0)return false;
  if(curveTool)return curveDown(e,v);
  if(axisPreview){if(axisPreview.valid){host.commit(axisPreview.before);axisPreview=null;report();}return true;}if(armed){insert(e,v,true);return true;}
  if(drag?.height){move(e,v);host.commit(drag.original);drag=null;return true;}
  let id=closest(e,v);const ref=!id&&referenceAt(e,v);if(ref){if(e.ctrlKey||e.metaKey){report();return true;}if(!perform(()=>{id=S.add(host.base(),ref,.0001);S.resolve(host.base());}))return true;}

  if(!id){
   if(host.isCenter(e,v)){selected=[];lines=[];return false;}
   if(v==='2d'||v==='3d'){box={x:e.clientX,y:e.clientY,ex:e.clientX,ey:e.clientY,add:e.shiftKey||e.ctrlKey||e.metaKey,subtract:!!(e.ctrlKey||e.metaKey),view:v,face:host.faceAt(e,v)};return true;}
   selected=[];lines=[];report();return true;
  }
  let list=mode()==='line'?lines:selected;
  if(e.ctrlKey||e.metaKey)list=list.filter(x=>x!==id);else if(e.shiftKey)list=[...new Set([...list,id])];else if(!list.includes(id))list=[id];
  if(mode()==='line'){lines=list;selected=[];}else{selected=list;lines=[];}
  const edges=sketch().edges.filter(e=>lines.includes(e.id)),ids=mode()==='line'?[...new Set(edges.flatMap(e=>[e.a,e.b]))]:selected;
  const locked=edges.some(e=>e.fixed)||ids.some(id=>node(id)?.fixed);
  if(!e.ctrlKey&&!e.metaKey&&!locked&&ids.length){const p=actual(node(ids[0]));drag={ids,heights:ids.map(id=>actual(node(id)).z),original:copy(host.base()),start:host.position(e,v,p.z),z:p.z,y:e.clientY,view:v};}
  report();return true;
 }
 function move(e,v){if(v)lastView=v;
  if(!(e.buttons&1)&&(box||(drag&&!drag.height))){cancel();return false;}
  if(!active()||(e.buttons&6))return false;
  if(curveTool&&v){curveMove(e,v);return true;}
  if(armed&&v){preview=position(e,v);host.redraw();return true;}
  if(box){
   box.ex=e.clientX;box.ey=e.clientY;if(!rect){rect=document.createElement('div');Object.assign(rect.style,{position:'fixed',pointerEvents:'none',border:'1px dashed #1a73e8',background:'rgba(26,115,232,0.2)',zIndex:10000});document.body?.appendChild(rect);}
   Object.assign(rect.style,{left:Math.min(box.x,box.ex)+'px',top:Math.min(box.y,box.ey)+'px',width:Math.abs(box.ex-box.x)+'px',height:Math.abs(box.ey-box.y)+'px'});return true;
  }
  if(!drag)return false;if(drag.height&&!v)return true;
  const d=drag,p=d.start&&host.position(e,d.view,d.z),delta=d.height||e.shiftKey?{z:(d.y-e.clientY)*.03}:p?{x:p.x-d.start.x,y:p.y-d.start.y}:{};
  host.restore(copy(d.original));
  if(d.height||e.shiftKey)d.ids.forEach((id,i)=>{node(id).z=d.heights[i];});
  try{S.move(host.base(),d.ids,delta);d.changed=true;d.invalid=false;host.redraw();}catch(err){d.invalid=true;host.restore(copy(d.original));host.message(err.message);}return true;
 }
 function up(e){
  if(e&&e.button!==undefined&&e.button!==0)return false;
  if(box){
   const b=box;box=null;rect?.remove?.();rect=null;
   if(Math.hypot(b.ex-b.x,b.ey-b.y)<4&&b.face){setFace(b.face);host.selectFace?.(b.face);report();return true;}
   const inside=n=>{if(b.view==='3d'&&host.opaque?.()&&host.pickVisible?.(actual(n))===false)return false;const p=host.screen(actual(n),b.view||'2d');return p.x>=Math.min(b.x,b.ex)&&p.x<=Math.max(b.x,b.ex)&&p.y>=Math.min(b.y,b.ey)&&p.y<=Math.max(b.y,b.ey);};
   if(mode()==='line'){const ids=sketch().edges.filter(e=>inside(node(e.a))&&inside(node(e.b))).map(e=>e.id);lines=b.subtract?lines.filter(id=>!ids.includes(id)):[...new Set([...(b.add?lines:[]),...ids])];selected=[];}
   else{const ids=sketch().nodes.filter(inside).map(n=>n.id);selected=b.subtract?selected.filter(id=>!ids.includes(id)):[...new Set([...(b.add?selected:[]),...ids])];lines=[];}
   report();return true;
  }
  if(!drag||drag.height)return false;
  const d=drag;drag=null;if(d.changed)host.commit(d.original);return true;
 }
 function perpendicularCut(){const A=window.WallAxisCuts,W=window.WallSolidGeometry;if(!A||!W||selected.length!==1)return false;if(axisPreview){axisPreview.index=(axisPreview.index+1)%axisPreview.variants.length;previewCut();return true;}const start=actual(node(selected[0])),before=copy(host.base()),candidates=[];for(const f of host.base().faces.filter(f=>onFace(start,f))){const frame=W.faceFrame(f),local=p=>W.inFrame(frame,p),face={points:f.points.map(local)},origin=A.boundaryPoint(face,local(start));let direction;try{direction=A.perpendicular(face,origin);}catch{continue;}const nodes=sketch().nodes.map(actual).filter(p=>onFace(p,f)),byId=id=>nodes.find(n=>n.id===id),edges=sketch().edges.map(e=>[byId(e.a),byId(e.b)]).filter(pair=>pair.every(Boolean)),targets=A.targets(face,origin,direction,edges.map(e=>e.map(local)),nodes.map(local)).map(p=>W.fromFrame(frame,p));if(targets.length)candidates.push({face:f.id,targets});}candidates.sort((a,b)=>Number(b.face===support()?.id)-Number(a.face===support()?.id));if(!candidates.length){host.message('Select one point on a base edge with space for a perpendicular cut.');return true;}const variants=candidates.map(c=>[c]);if(candidates.length>1)variants.push(candidates);axisPreview={before,start:{...start},source:selected[0],variants,index:0};previewCut();return true;}
 function previewCut(){const t=axisPreview;host.restore(copy(t.before));t.lines=[];try{for(const c of t.variants[t.index])for(const p of c.targets){const id=S.add(host.base(),p,.0001);S.connect(host.base(),[t.source,id]);t.lines.push([t.start,p]);}t.valid=true;host.message('Perpendicular base cut: '+(t.variants[t.index].length>1?'both sides':'side '+(t.index+1))+' - H cycles; click to place; Escape cancels.');}catch(error){host.restore(copy(t.before));t.valid=false;host.message(error.message);}host.redraw();}
 function finishToolForSwitch(){if(curveTool){host.message('Finish the curve or press Escape before switching tools.');return false;}if(axisPreview?.valid===false||drag?.invalid){host.message('Correct or cancel the current preview before switching tools.');return false;}if(axisPreview){host.commit(axisPreview.before);axisPreview=null;}if(drag){const d=drag;drag=null;if(d.changed)host.commit(d.original);}armed=false;preview=null;return true;}
 function keyDown(e){
  if(!active())return false;const k=e.key.toLowerCase();
  if(curveTool?.kind==='arch'){if(k==='escape'||k==='z'&&(e.ctrlKey||e.metaKey)){cancel();report();}else if((k==='a'||k==='enter')&&!e.repeat)finishArch();else if(k==='f'&&!e.repeat&&typeof isFreeMove!=='undefined')isFreeMove=!isFreeMove;return true;}if(k==='a'&&!e.ctrlKey&&!e.metaKey&&!e.repeat&&!curveTool)return startArch();
  if(k==='escape'){cancel();return false;}if(curveTool){if(k==='f'&&typeof isFreeMove!=='undefined')isFreeMove=!isFreeMove;return true;}if(drag&&!e.ctrlKey&&!e.metaKey&&['m','h','n','c','u','delete','backspace'].includes(k)){if(e.repeat||!finishToolForSwitch())return true;}if(axisPreview){if(k==='h'&&!e.repeat)perpendicularCut();else if(k==='z'&&(e.ctrlKey||e.metaKey))cancel();return true;}if(k==='h'&&selected.length===1){if(!e.repeat)perpendicularCut();return true;}
  if(k==='s'&&!e.ctrlKey&&!e.metaKey&&selected.length===1){const start={...actual(node(selected[0]))},face=support()||host.base().faces.find(f=>onFace(start,f));curveTool={start,face,normal:window.WallSolidGeometry.normal(face.points),track:{}};armed=false;preview=null;host.message('Curve: click the center, then sweep to the endpoint; Escape cancels.');return true;}
  if(k==='n'){armed=true;preview=null;host.message(selected.length===1?'Click an endpoint on this base face; Escape cancels.':'Click the base to place a starting point.');host.redraw();return true;}
  if(['c','u'].includes(k)){if(perform(()=>connect(selected)))report();return true;}
  if(['delete','backspace'].includes(k)){perform(()=>S.remove(host.base(),selected,lines));selected=selected.filter(id=>node(id));lines=lines.filter(id=>sketch().edges.some(e=>e.id===id));report();return true;}
  if(['m','h'].includes(k)&&(selected.length||lines.length)){
   const edges=sketch().edges.filter(e=>lines.includes(e.id)),ids=lines.length?[...new Set(edges.flatMap(e=>[e.a,e.b]))]:selected;
   if(edges.some(e=>e.fixed)||ids.some(id=>node(id)?.fixed)){host.message('Wall-defined points and lines are locked. Select a face to adjust its base plane.');return true;}
   if(k==='m'){const m=host.mouse();if(m)drag={height:true,ids,heights:ids.map(id=>actual(node(id)).z),original:copy(host.base()),y:m.e.clientY,view:m.v};host.message('Move vertically to preview; click to place.');}
   else perform(()=>{const ns=ids.map(node),z=ns.reduce((sum,n)=>sum+actual(n).z,0)/ns.length;for(const n of ns){n.z=z;n.manualZ=true;}S.resolve(host.base());});
   return true;
  }
  return false;
 }
 function cancel(){curveTool=null;if(axisPreview){host.restore(axisPreview.before);axisPreview=null;}if(drag)host.restore(drag.original);drag=null;armed=false;preview=null;box=null;rect?.remove?.();rect=null;}
 function color(fixed,chosen){return chosen?'#fff':fixed?'#e7ad52':'#6ce4ed';}
 function draw2D(rot,svg,inv){
  if(host.base()?.visible===false)return;
  if(curveTool){const t=curveTool,ps=t.samples||[t.start,t.pointer||t.start];for(const g of t.guides||[])svg('polyline',{points:g.points.map(p=>{const q=host.toPixel(p);return q.x+','+q.y;}).join(' '),fill:'none',stroke:g.color,'stroke-width':inv,'stroke-dasharray':(5*inv)+' '+(4*inv),'data-curve-guide':g.role,'pointer-events':'none'},rot);svg('polyline',{points:ps.map(p=>{const q=host.toPixel(p);return q.x+','+q.y;}).join(' '),fill:'none',stroke:t.valid===false?'#ff6666':'#FFD700','stroke-width':2*inv,'pointer-events':'none'},rot);const marker=host.toPixel(t.center||t.pointer||t.start);svg('circle',{cx:marker.x,cy:marker.y,r:8*inv,fill:'none',stroke:'#72ffb0','stroke-width':1.5*inv,'pointer-events':'none'},rot);if(t.center){const a=host.toPixel(t.start),b=host.toPixel(t.center);svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#72ffb0','stroke-dasharray':'5 5','stroke-width':inv},rot);}}
  for(const pair of axisPreview?.lines||[]){const [a,b]=pair.map(host.toPixel);svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#FFD700','stroke-width':2*inv,'pointer-events':'none'},rot);}
  if(armed&&preview&&selected.length===1){const a=host.toPixel(actual(node(selected[0]))),b=host.toPixel(preview);svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:'#FFD700','stroke-width':2*inv,'pointer-events':'none'},rot);}
  for(const curve of sketch().curves||[]){const ranges=sketch().edges.filter(e=>e.curveId===curve.id&&e.curveRange).map(e=>e.curveRange.slice().sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]),spans=[];for(const r of ranges){const last=spans.at(-1);if(last&&r[0]<=last[1]+1e-6)last[1]=Math.max(last[1],r[1]);else spans.push(r.slice());}for(const [lo,hi]of spans)svg('path',{...window.ExteriorGeometry.curveSvg(curve,host.toPixel,lo,hi),fill:'none',stroke:sketch().edges.some(e=>e.curveId===curve.id&&lines.includes(e.id))?'#fff':'#6ce4ed','stroke-width':2,'pointer-events':'none'},rot);}
  for(const e of sketch().edges.filter(e=>!e.curveId)){const a=host.toPixel(actual(node(e.a))),b=host.toPixel(actual(node(e.b)));svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:color(e.fixed,lines.includes(e.id)),'stroke-width':(lines.includes(e.id)?4:2)*inv,'pointer-events':'none'},rot);}
  for(const n of sketch().nodes){const p=host.toPixel(actual(n));svg(n.fixed?'rect':'circle',n.fixed?{x:p.x-4*inv,y:p.y-4*inv,width:8*inv,height:8*inv,fill:color(true,selected.includes(n.id)),'pointer-events':'none'}:{cx:p.x,cy:p.y,r:(selected.includes(n.id)?6:4)*inv,fill:color(false,selected.includes(n.id)),'pointer-events':'none'},rot);}
 }
 function draw3D(group,vector){
  if(host.base()?.visible===false)return;
  if(curveTool){const t=curveTool;window.wallCurveGuides?.(group,vector,t.guides);for(const ps of [t.samples||[t.start,t.pointer||t.start],...(t.center?[[t.start,t.center]]:[])]){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(ps.map(vector)),new THREE.LineBasicMaterial({color:t.valid===false?'#ff6666':'#FFD700',depthTest:false}));line.renderOrder=25;group.add(line);}window.wallCurveCenterMarker?.(group,vector,t.center||t.pointer||t.start);}
  for(const pair of axisPreview?.lines||[]){const geo=new THREE.BufferGeometry().setFromPoints(pair.map(vector)),line=new THREE.Line(geo,new THREE.LineBasicMaterial({color:'#FFD700',depthTest:false}));line.renderOrder=25;group.add(line);}
  if(armed&&preview&&selected.length===1){const geo=new THREE.BufferGeometry().setFromPoints([actual(node(selected[0])),preview].map(vector));const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color:'#FFD700',depthTest:false}));line.renderOrder=25;group.add(line);}
  for(const p of references()){const geo=new THREE.BufferGeometry().setFromPoints([vector(p)]),point=new THREE.Points(geo,new THREE.PointsMaterial({color:'#e7ad52',size:8,sizeAttenuation:false,depthTest:false}));point.renderOrder=21;group.add(point);}
  for(const e of S.curveEdges(sketch())){const geo=new THREE.BufferGeometry().setFromPoints([vector(e.start),vector(e.end)]),obj=new THREE.Line(geo,new THREE.LineBasicMaterial({color:color(e.fixed,lines.includes(e.id)),depthTest:false}));obj.renderOrder=20;group.add(obj);}
  for(const n of sketch().nodes){const geo=new THREE.BufferGeometry().setFromPoints([vector(actual(n))]),obj=new THREE.Points(geo,new THREE.PointsMaterial({color:color(n.fixed,selected.includes(n.id)),size:selected.includes(n.id)?12:8,sizeAttenuation:false,depthTest:false}));obj.renderOrder=21;group.add(obj);}
 }
return {selectionSnapshot:()=>copy({selected,lines,preferredFace}),restoreSelection(value){const s=copy(value||{});selected=s.selected||[];lines=s.lines||[];preferredFace=s.preferredFace||null;},finishToolForSwitch,chamferSelection:()=>({points:selected.map(id=>copy(actual(node(id)))),edges:sketch().edges.filter(e=>lines.includes(e.id)).map(e=>[copy(actual(node(e.a))),copy(actual(node(e.b)))])}),cancelPointerGesture(){if(box||(drag&&!drag.height))cancel();},interaction:()=>curveTool?(curveTool.kind==='arch'?"Arch line":"Draw curve"):axisPreview?"Base cut":armed?"Draw on base":drag?"Move base point":box?"Rectangle selection":null,selectEntities(ps,pairs,add=false,subtract=false){const priorPoints=selected.slice(),priorLines=lines.slice();const near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<.001;selected=sketch().nodes.filter(n=>ps.some(p=>near(actual(n),p))).map(n=>n.id);lines=sketch().edges.filter(e=>pairs.some(([a,b])=>{return S.curveEdges(sketch()).filter(segment=>segment.id===e.id).some(segment=>window.WallSolidGeometry.sharedIntervals(segment.start,segment.end,[{points:[a,b]}]).length);})).map(e=>e.id);if(subtract){selected=priorPoints.filter(id=>!selected.includes(id));lines=priorLines.filter(id=>!lines.includes(id));}else if(add){selected=[...new Set([...priorPoints,...selected])];lines=[...new Set([...priorLines,...lines])];}preferredFace=null;report();},canPick:(e,v)=>!!closest(e,v)||!!referenceAt(e,v),singleLine:()=>lines.length===1?sketch().edges.filter(e=>e.id===lines[0]).map(e=>[copy(actual(node(e.a))),copy(actual(node(e.b)))])[0]:null,singlePoint:()=>selected.length===1&&node(selected[0])?copy(actual(node(selected[0]))):null,setFace,canHit:(e,v)=>!!v&&!!referenceAt(e,v),busy:()=>!!curveTool||!!axisPreview||!!drag||!!box||armed,down,move,up,keyDown,cancel,draw2D,draw3D,doubleClick(e,v){if(curveTool?.kind==='arch'){archDown(e,v);return finishArch();}if(active()&&mode()==='point'){insert(e,v);return true;}return false;},clear(){cancel();preferredFace=null;selected=[];lines=[];}};
};
})();
