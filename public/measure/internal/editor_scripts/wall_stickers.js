/* Sticker outlines: the one shape model for windows, doors, garage doors and vents.
   An outline is a closed loop of vertices in its host plane's frame; each edge is
   straight, a spline through interior controls, or an elliptical arc. Vertices and
   spline controls are the only editable points; tessellation is always derived.
   See dev/EXTERIOR_STICKERS.md. Pure geometry: no editor state. */
(function(root){'use strict';
const node=typeof module!=='undefined'&&module.exports;
const K=node?require('./exterior_geometry.js'):root.ExteriorGeometry;
const features=()=>node?require('./wall_features.js'):root.WallFeatures;
const VERSION=1,MIN_SIZE=.01,OVERLAP_AREA=1e-5,SAME=1e-6;

const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:(a.z||0)-(b.z||0)}),dot=(a,b)=>a.x*b.x+a.y*b.y+(a.z||0)*(b.z||0),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
const copy=value=>JSON.parse(JSON.stringify(value));
const segDist=(p,a,b)=>{const u=sub(b,a),l2=dot(u,u),t=l2?Math.max(0,Math.min(1,dot(sub(p,a),u)/l2)):0;return dist(p,{x:a.x+u.x*t,y:a.y+u.y*t,z:(a.z||0)+(u.z||0)*t});};
const flat=p=>({x:p.x,y:p.y});
const local=(frame,p)=>{const d=sub(p,frame.origin);return {x:dot(d,frame.u),y:dot(d,frame.v)};};
const world=(frame,p)=>({x:frame.origin.x+frame.u.x*p.x+frame.v.x*p.y,y:frame.origin.y+frame.u.y*p.x+frame.v.y*p.y,z:frame.origin.z+frame.u.z*p.x+frame.v.z*p.y});
const area=ps=>ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-q.x*p.y;},0)/2;
const bounds=ps=>({left:Math.min(...ps.map(p=>p.x)),right:Math.max(...ps.map(p=>p.x)),bottom:Math.min(...ps.map(p=>p.y)),top:Math.max(...ps.map(p=>p.y))});

// ---- Segments -------------------------------------------------------------

// The analytic curve for edge i, in frame coordinates (z = 0), or null if straight.
function segmentCurve(outline,i){
 const loop=outline.loop,a=loop[i],b=loop[(i+1)%loop.length],seg=a.seg;if(!seg)return null;
 // A spline read from a face keeps its exact definition until its controls are edited.
 if(seg.type==='spline'){if(seg.curve)return copy(seg.curve);const via=(seg.via||[]).map(p=>({x:p.x,y:p.y,z:0}));if(!via.length)return null;return K.splineThrough([{x:a.x,y:a.y,z:0},{x:b.x,y:b.y,z:0}],via);}
 if(seg.type==='ellipse')return ellipseCurve(seg);
 throw Error('Unknown sticker edge type '+seg.type+'.');
}
// Elliptical arcs are axis aligned in the frame. A circle may start anywhere; an
// oval starts on an axis (a0 a multiple of pi/2), which covers half and quarter arcs.
function ellipseCurve(seg){
 const {center,rx,ry,a0,a1}=seg,c={x:center.x,y:center.y,z:0},sweep=a1-a0;
 if(Math.abs(rx-ry)<SAME)return {type:'ellipse',version:1,center:c,u:{x:Math.cos(a0),y:Math.sin(a0),z:0},v:{x:-Math.sin(a0),y:Math.cos(a0),z:0},radiusX:rx,radiusY:ry,sweep};
 const quarter=Math.round(a0/(Math.PI/2));if(Math.abs(a0-quarter*Math.PI/2)>1e-9)throw Error('An oval arc must start on one of its axes.');
 const turn=((quarter%4)+4)%4,axes=[[{x:1,y:0},{x:0,y:1},rx,ry],[{x:0,y:1},{x:-1,y:0},ry,rx],[{x:-1,y:0},{x:0,y:-1},rx,ry],[{x:0,y:-1},{x:1,y:0},ry,rx]][turn];
 return {type:'ellipse',version:1,center:c,u:{...axes[0],z:0},v:{...axes[1],z:0},radiusX:axes[2],radiusY:axes[3],sweep};
}
// Frame-coordinate tessellation: the ring (vertices first in each edge) and curve records.
function tessellate(outline){
 const ring=[],curves=[],loop=outline.loop;
 loop.forEach((a,i)=>{
  ring.push({x:a.x,y:a.y,vertex:i});const c=segmentCurve(outline,i);if(!c)return;curves.push({...c,edge:i});
  let samples=K.curveSamples(c).slice(1,-1);if(Math.hypot(K.curvePoint(c,0).x-a.x,K.curvePoint(c,0).y-a.y)>Math.hypot(K.curvePoint(c,1).x-a.x,K.curvePoint(c,1).y-a.y))samples=samples.reverse();
  for(const p of samples)ring.push({x:p.x,y:p.y,sample:true});
 });
 return {ring,curves};
}
// World geometry for a face record: ring points (samples flagged) and analytic curves.
function toWorld(outline,idPrefix='sticker'){
 const {ring,curves}=tessellate(outline),f=outline.frame;
 return {points:ring.map(p=>({...world(f,p),...(p.sample?{curveSample:true}:{})})),curves:curves.map(({edge,...c})=>({...K.mapCurve(c,p=>({...world(f,p)})),id:idPrefix+'-edge-'+edge}))};
}
// Every editable point: vertices then spline controls, with stable ids.
function controls(outline){
 const out=[];outline.loop.forEach((a,i)=>out.push({id:'v'+i,x:a.x,y:a.y}));
 outline.loop.forEach((a,i)=>(a.seg?.type==='spline'?a.seg.via:[]).forEach((p,j)=>out.push({id:'c'+i+'.'+j,x:p.x,y:p.y})));
 return out;
}
function controlsWorld(outline){return controls(outline).map(c=>({id:c.id,...world(outline.frame,c)}));}

// ---- Reading a face ---------------------------------------------------------

// The outline of a sticker face, in world coordinates, from any storage form.
// A face written by the sticker writer carries its outline; anything else is read
// from its analytic curves and its non-sample points, once.
function read(face){
 const outline=face.feature?.outline;
 if(outline?.v===VERSION&&matches(outline,face.points))return copy(outline);
 return fromFace(face);
}
function matches(outline,points){
 try{const expected=toWorld(outline).points;if(expected.length!==points.length)return false;
  const start=points.findIndex(p=>dist(p,expected[0])<=1e-5);if(start<0)return false;
  for(const step of [1,-1]){let ok=true;for(let i=0;i<expected.length&&ok;i++)ok=dist(points[(start+step*i+points.length*2)%points.length],expected[i])<=1e-5;if(ok)return true;}
  return false;}catch{return false;}
}
function frameFor(points,feature){
 // Level (u horizontal) unless the sticker carries its own axis.
 const F=features(),f=feature?.axis?F.orientedFrame(points,feature.axis):F.frame(points);
 // Origin at the lower-left of the face keeps frame coordinates small and positive.
 const ps=points.map(p=>local(f,p)),b=bounds(ps);return {...f,origin:world(f,{x:b.left,y:b.bottom})};
}
function fromFace(face){
 const points=face.points,feature=face.feature||{},frame=frameFor(points,feature),toLocal=p=>local(frame,p),curves=face.curves||[];
 // A legacy round window is a 48-gon with no curve: it is an ellipse.
 if(feature.shape==='circle'&&!curves.length){const b=bounds(points.map(toLocal)),center={x:(b.left+b.right)/2,y:(b.bottom+b.top)/2},rx=(b.right-b.left)/2,ry=(b.top-b.bottom)/2;
  return {v:VERSION,frame,loop:[{x:center.x+rx,y:center.y,seg:{type:'ellipse',center,rx,ry,a0:0,a1:Math.PI}},{x:center.x-rx,y:center.y,seg:{type:'ellipse',center,rx,ry,a0:Math.PI,a1:2*Math.PI}}]};}
 const sample=curves.length?K.curveSamplePoint(face):()=>false,ring=points.filter((p,i)=>dist(p,points[(i+1)%points.length])>SAME);
 // Defining points by ring index; tessellation samples are only evidence of a curve.
 let defining=ring.map((p,i)=>({p,i})).filter(({p})=>!sample(p));
 if(defining.length<2)throw Error('This sticker has no closed outline.');
 const near=(a,b)=>dist(a,b)<=1e-4,records=curves.map(c=>{const ctrl=c.type==='spline'?c.controls:[K.curvePoint(c,0),K.curvePoint(c,1)];const poly=K.curveSamples(c);return {c,ctrl,on:p=>poly.some((q,k)=>k&&segDist(p,poly[k-1],q)<=1e-4)};});
 // Start on a vertex that is not inside any curve, so no curve wraps past the start unseen.
 const interior=p=>records.some(r=>r.ctrl.slice(1,-1).some(q=>near(q,p)));const start=defining.findIndex(d=>!interior(d.p));if(start>0)defining=[...defining.slice(start),...defining.slice(0,start)];
 const n=ring.length,between=(from,to)=>{const out=[];for(let k=(from+1)%n;k!==to;k=(k+1)%n)out.push(ring[k]);return out;};
 const loop=[];
 for(let i=0;i<defining.length;){
  const a=defining[i];let used=null;
  for(const r of records){for(const order of [r.ctrl,r.ctrl.slice().reverse()]){if(!near(order[0],a.p))continue;
   // The curve runs forward along the ring from a to its other end, through its controls.
   for(let j=i+1;j<=defining.length;j++){const b=defining[j%defining.length];if(!near(b.p,order.at(-1)))continue;
    const path=between(a.i,b.i);if(!path.length||!path.every(r.on))break;
    used={c:r.c,order,last:j};break;}
   if(used)break;}if(used)break;}
  if(!used){loop.push({...toLocal(a.p)});i++;continue;}
  loop.push({...toLocal(a.p),seg:segmentFrom(used.c,used.order,frame)});i=used.last;
 }
 // A curve that ends on the first vertex closes the loop; drop the repeated start.
 if(loop.length>1&&dist(loop.at(-1),loop[0])<=1e-4)loop.pop();
 if(loop.length<2||loop.length<3&&!loop.some(v=>v.seg))throw Error('This sticker has no closed outline.');
 return {v:VERSION,frame,loop};
}
function segmentFrom(c,order,frame){
 const toLocal=p=>local(frame,p);
 if(c.type==='spline'){const reversed=order[0]!==c.controls[0];const via=c.controls.slice(1,-1).map(toLocal);const {id,...exact}=c;return {type:'spline',via:reversed?via.reverse():via,curve:K.mapCurve(exact,p=>({...toLocal(p),z:0}))};}
 if(c.type==='ellipse'||!c.type){
  const center=toLocal(c.center),ax=toLocal({x:c.center.x+c.u.x,y:c.center.y+c.u.y,z:c.center.z+c.u.z}),u={x:ax.x-center.x,y:ax.y-center.y};
  const start=toLocal(K.curvePoint(c,0)),end=toLocal(K.curvePoint(c,1)),aligned=Math.abs(Math.abs(u.x)-1)<1e-6||Math.abs(Math.abs(u.y)-1)<1e-6||Math.abs(c.radiusX-c.radiusY)<SAME;
  if(aligned){const rx=Math.abs(u.x)>.5?c.radiusX:c.radiusY,ry=Math.abs(u.x)>.5?c.radiusY:c.radiusX,angle=p=>Math.atan2((p.y-center.y)/ry,(p.x-center.x)/rx),turn=a=>((a%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
   // Walk from the loop's start to its end through the curve's midpoint.
   const forward=dist(order[0],K.curvePoint(c,0))<=1e-4,from=forward?start:end,to=forward?end:start,a0=angle(from),mid=turn(angle(toLocal(K.curvePoint(c,.5)))-a0);
   let span=turn(angle(to)-a0);if(span<1e-9)span=2*Math.PI;const a1=mid<span?a0+span:a0-(2*Math.PI-span);
   return {type:'ellipse',center,rx,ry,a0,a1};}
 }
 // Anything else (conics, rotated ovals) is carried as a spline through its shape.
 const pts=[.25,.5,.75].map(t=>toLocal(K.curvePoint(c,t)));const forward=dist(order[0],K.curvePoint(c,0))<=1e-4;return {type:'spline',via:forward?pts:pts.reverse()};
}

// ---- Transforms -------------------------------------------------------------

function mapAll(outline,map){
 const out=copy(outline);
 for(const v of out.loop){Object.assign(v,map(v));const s=v.seg;if(s?.type==='spline'){s.via=s.via.map(p=>({...p,...map(p)}));if(s.curve)s.curve=K.mapCurve(s.curve,p=>({...map(p),z:0}));}}
 // An ellipse survives only a map that keeps it an axis-aligned ellipse; otherwise it becomes a spline.
 out.loop.forEach((v,i)=>{const s=v.seg;if(s?.type!=='ellipse')return;const o=outline.loop[i].seg,c=map(o.center),rx=map({x:o.center.x+o.rx,y:o.center.y}),ry=map({x:o.center.x,y:o.center.y+o.ry});
  const ex={x:rx.x-c.x,y:rx.y-c.y},ey={x:ry.x-c.x,y:ry.y-c.y};
  if(Math.abs(ex.y)<1e-9&&Math.abs(ey.x)<1e-9&&ex.x>0&&ey.y>0)v.seg={...s,center:c,rx:ex.x,ry:ey.y};
  else v.seg={type:'spline',via:[.25,.5,.75].map(t=>{const a=o.a0+(o.a1-o.a0)*t;return map({x:o.center.x+o.rx*Math.cos(a),y:o.center.y+o.ry*Math.sin(a)});})};});
 return out;
}
function translate(outline,dx,dy){return mapAll(outline,p=>({x:p.x+dx,y:p.y+dy}));}
function affine(outline,map){return mapAll(outline,map);}
// Box resize (presets, typed sizes, Y): controls scale with the box.
function resize(outline,box){
 const b=bounds(tessellate(outline).ring),sx=(box.right-box.left)/Math.max(b.right-b.left,1e-12),sy=(box.top-box.bottom)/Math.max(b.top-b.bottom,1e-12);
 return mapAll(outline,p=>({x:box.left+(p.x-b.left)*sx,y:box.bottom+(p.y-b.bottom)*sy}));
}
function outlineBounds(outline){return bounds(tessellate(outline).ring);}
// Move controls to new positions ({id:{x,y}} in frame metres). A curved edge whose
// ends move keeps its rise over the chord: its unmoved controls follow the chord,
// and an elliptical arc becomes a spline.
function moveControlsTo(outline,targets){
 const out=copy(outline),n=out.loop.length,moved=i=>!!targets['v'+i];
 out.loop.forEach((v,i)=>{const t=targets['v'+i];if(t){v.x=t.x;v.y=t.y;}});
 out.loop.forEach((v,i)=>{const s=outline.loop[i].seg;if(!s)return;const a0=outline.loop[i],b0=outline.loop[(i+1)%n],a1=out.loop[i],b1=out.loop[(i+1)%n],endsMoved=moved(i)||moved((i+1)%n);
  const own=s.type==='spline'&&s.via.some((_,j)=>targets['c'+i+'.'+j]);if(!endsMoved&&!own)return;// an untouched curve
  let via=s.type==='spline'?s.via.map(p=>({...p})):[.25,.5,.75].map(t=>{const a=s.a0+(s.a1-s.a0)*t;return {x:s.center.x+s.rx*Math.cos(a),y:s.center.y+s.ry*Math.sin(a)};});
  if(endsMoved)via=via.map(p=>chordFollow(p,a0,b0,a1,b1));
  if(s.type==='spline')via=via.map((p,j)=>targets['c'+i+'.'+j]?{x:targets['c'+i+'.'+j].x,y:targets['c'+i+'.'+j].y}:p);
  v.seg={type:'spline',via};});
 return out;
}
function moveControls(outline,ids,dx,dy){const targets={};for(const c of controls(outline))if(ids.includes(c.id))targets[c.id]={x:c.x+dx,y:c.y+dy};return moveControlsTo(outline,targets);}
// The affine map (frame metres) that takes one point list onto another, or null
// when no affine map does (to within 1e-6 m).
function fitAffine(from,to){
 if(from.length!==to.length||from.length<3)return null;let m=[[0,0,0],[0,0,0],[0,0,0]],rx=[0,0,0],ry=[0,0,0];
 from.forEach((p,i)=>{const r=[p.x,p.y,1];for(let a=0;a<3;a++){for(let b=0;b<3;b++)m[a][b]+=r[a]*r[b];rx[a]+=r[a]*to[i].x;ry[a]+=r[a]*to[i].y;}});
 const solve=(A,b)=>{A=A.map((row,i)=>[...row,b[i]]);for(let c=0;c<3;c++){let pivot=c;for(let r=c+1;r<3;r++)if(Math.abs(A[r][c])>Math.abs(A[pivot][c]))pivot=r;if(Math.abs(A[pivot][c])<1e-12)return null;[A[c],A[pivot]]=[A[pivot],A[c]];for(let r=0;r<3;r++){if(r===c)continue;const k=A[r][c]/A[c][c];for(let j=c;j<4;j++)A[r][j]-=k*A[c][j];}}return A.map((row,i)=>row[3]/row[i]);};
 const ax=solve(m,rx),ay=solve(m,ry);if(!ax||!ay)return null;const map=p=>({x:ax[0]*p.x+ax[1]*p.y+ax[2],y:ay[0]*p.x+ay[1]*p.y+ay[2]});
 return from.every((p,i)=>Math.hypot(map(p).x-to[i].x,map(p).y-to[i].y)<=1e-6)?map:null;
}
function chordFollow(p,a0,b0,a1,b1){
 const d0={x:b0.x-a0.x,y:b0.y-a0.y},l0=Math.hypot(d0.x,d0.y)||1,t=((p.x-a0.x)*d0.x+(p.y-a0.y)*d0.y)/(l0*l0),h=((p.y-a0.y)*d0.x-(p.x-a0.x)*d0.y)/l0;
 const d1={x:b1.x-a1.x,y:b1.y-a1.y},l1=Math.hypot(d1.x,d1.y)||1,nx=-d1.y/l1,ny=d1.x/l1;return {x:a1.x+d1.x*t+nx*h,y:a1.y+d1.y*t+ny*h};
}
// Delete controls. A vertex's two edges join; their curve controls carry over, so an
// arch that loses an end continues from the neighbouring vertex. Fewer than three
// vertices without a curve is no closed face: null.
function deleteControls(outline,ids){
 const chosen=new Set(ids),out=copy(outline);
 out.loop.forEach((v,i)=>{if(v.seg?.type==='spline')v.seg.via=v.seg.via.filter((_,j)=>!chosen.has('c'+i+'.'+j));if(v.seg?.type==='spline'&&!v.seg.via.length)delete v.seg;});
 let loop=out.loop;
 for(let i=loop.length-1;i>=0;i--){if(!chosen.has('v'+i))continue;const prev=loop[(i-1+loop.length)%loop.length],cur=loop[i];
  const via=[...viaOf(prev,cur,loop[(i+1)%loop.length]),];prev.seg=via.length?{type:'spline',via}:undefined;if(!prev.seg)delete prev.seg;loop=loop.filter((_,j)=>j!==i);}
 out.loop=loop;
 if(loop.length<2||loop.length<3&&!loop.some(v=>v.seg))return null;return out;
}
// Controls of the edges prev->cur and cur->next, as points of one joined edge.
function viaOf(prev,cur,next){
 const pts=s=>s?.type==='spline'?s.via:s?.type==='ellipse'?[.25,.5,.75].map(t=>{const a=s.a0+(s.a1-s.a0)*t;return {x:s.center.x+s.rx*Math.cos(a),y:s.center.y+s.ry*Math.sin(a)};}):[];
 const first=pts(prev.seg),second=pts(cur.seg);if(!first.length&&!second.length)return [];
 // The deleted vertex stays a control only when it lay between two curved edges.
 return [...first,...(first.length&&second.length?[{x:cur.x,y:cur.y}]:[]),...second];
}

// ---- Validation ---------------------------------------------------------------

// The one closed-face check: finite, simple, big enough. Placement on a host is
// checked by the editor with the frame ring (inside host, no sticker overlap).
function check(outline){
 const {ring}=tessellate(outline);
 if(ring.length<3||!ring.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))throw Error('Feature geometry is invalid.');
 const b=bounds(ring);if(b.right-b.left<MIN_SIZE||b.top-b.bottom<MIN_SIZE)throw Error('Keep the shape at least 0.4 inches wide and high.');
 if(Math.abs(area(ring))<1e-8)throw Error('A sticker needs a closed face.');
 const n=ring.length,cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){if(j===i+1||(i===0&&j===n-1))continue;const a=ring[i],b=ring[(i+1)%n],c=ring[j],d=ring[(j+1)%n];
  const d1=cross(a,b,c),d2=cross(a,b,d),d3=cross(c,d,a),d4=cross(c,d,b);if(((d1>1e-12&&d2<-1e-12)||(d1<-1e-12&&d2>1e-12))&&((d3>1e-12&&d4<-1e-12)||(d3<-1e-12&&d4>1e-12)))throw Error('That would make the sticker cross itself.');}
 return true;
}

const api={VERSION,OVERLAP_AREA,read,fromFace,matches,frameFor,tessellate,toWorld,controls,controlsWorld,segmentCurve,translate,affine,resize,outlineBounds,moveControls,moveControlsTo,fitAffine,deleteControls,check,local,world};
if(node)module.exports=api;else root.WallStickers=api;
})(typeof window!=='undefined'?window:globalThis);
