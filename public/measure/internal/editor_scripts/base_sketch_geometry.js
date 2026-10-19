/* Persistent base sketch: fixed wall boundary plus editable construction geometry. */
(function(root){
'use strict';
const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const B=typeof module!=='undefined'&&module.exports?require('./base_geometry.js'):root.BaseGeometry;
const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
const copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const area=ps=>ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2;
const onPlane=(p,pl,tolerance=K.CONTACT)=>!!pl&&Math.abs(p.z-pl.dx*p.x-pl.dy*p.y-pl.k)<=tolerance;
const segmentDistance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
const onRing=(p,ring,tolerance=K.CONTACT)=>ring.some((a,i)=>segmentDistance(p,a,ring[(i+1)%ring.length])<=tolerance);
const insideRing=(p,ring)=>{let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;};
const strictlyInside=(p,ring)=>!onRing(p,ring)&&insideRing(p,ring);
// Distinct supporting planes of the faces that carry a point, interior or boundary.
function supportPlanes(faces,p){const planes=[];for(const f of faces){const pl=G.plane(f.points);if(!onPlane(p,pl)||!(onRing(p,f.points)||insideRing(p,f.points)))continue;if(!planes.some(q=>f.points.every(v=>onPlane(v,q))))planes.push(pl);}return planes;}
const restoredCurveSketches=new WeakSet();
function restoreCurveGraph(base){const s=base.sketch,curves=[...new Map([...base.faces.flatMap(f=>f.curves||[]),...(s.curves||[])].map(c=>[c.id,c])).values()];if(restoredCurveSketches.has(s))return s;restoredCurveSketches.add(s);if(curves.length){s.curves=curves;K.annotateCurveGraph(s);compactCurves(s);}return s;
}
function ensure(base){
 if(base.sketch)return compactCurves(restoreCurveGraph(base));
 const nodes=[],edges=[],seen=new Map();
 const node=p=>{let i=nodes.findIndex(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<=K.CONTACT);if(i<0){i=nodes.length;nodes.push({...p,id:'p'+i,fixed:false});}return nodes[i].id;};
 for(const f of base.faces){const ids=f.points.map(node);f.points.forEach((p,i)=>p.nodeId=ids[i]);
  ids.forEach((a,i)=>{const b=ids[(i+1)%ids.length],key=[a,b].sort().join('|');if(seen.has(key))seen.get(key).count++;else{const edge={id:'e'+edges.length,a,b,fixed:false,count:1};seen.set(key,edge);edges.push(edge);}});
 }
 for(const e of edges){e.fixed=e.count===1;delete e.count;if(e.fixed)for(const id of [e.a,e.b])nodes.find(n=>n.id===id).fixed=true;}
 base.sketch={version:1,next:Math.max(nodes.length,edges.length),nodes,edges,outlines:B.boundary(base.faces.map(f=>f.points))};
 return restoreCurveGraph(base);
}
const readCache=new WeakMap();
function read(base){
 if(base.sketch)return compactCurves(restoreCurveGraph(base));
 const signature=JSON.stringify(base.faces),prior=readCache.get(base);
 if(prior?.signature===signature)return prior.sketch;
 const sketch=ensure(copy(base));readCache.set(base,{signature,sketch});return sketch;
}
function inside(s,p,base){if(base?.constructionPlane)return true;return base&&!base.origin&&!base.frame?base.faces.some(f=>G.contains(f,p)):s.outlines.some(points=>G.contains({points},p));}
function add(base,p,tolerance=.01){
 const s=ensure(base);if(![p.x,p.y,p.z].every(Number.isFinite))throw Error('Point coordinates must be finite.');
 const found=s.nodes.find(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<tolerance);if(found){found.userDraftPoint=true;delete found.curveSample;return found.id;}
 const n={...p,id:'p'+(++s.next),fixed:false,userDraftPoint:true};delete n.curveSample;s.nodes.push(n);return n.id;
}
function connect(base,ids){
 const s=ensure(base);if(ids.length<2)throw Error('Select two or more points to connect.');
 const proposed=[];
 for(let i=1;i<ids.length;i++){const a=s.nodes.find(n=>n.id===ids[i-1]),b=s.nodes.find(n=>n.id===ids[i]);if(!a||!b||a===b)continue;
  if(![a,b].every(p=>[p.x,p.y,p.z].every(Number.isFinite)))throw Error('Point coordinates must be finite.');
  if(!s.edges.some(e=>!e.curveId&&[e.a,e.b].includes(a.id)&&[e.a,e.b].includes(b.id)))proposed.push({id:'e'+(++s.next),a:a.id,b:b.id,fixed:false,userConnection:true});
 }
 s.edges.push(...proposed);resolve(base);

}
// One persistent edge per arc. Sampling is a temporary planar-arrangement adapter.
function curveEdges(s){return s.edges.flatMap(e=>{const c=e.curveId&&s.curves?.find(c=>c.id===e.curveId),byId=id=>s.nodes.find(n=>n.id===id);if(!c){if(e.curveId)throw Error('Curve edge is missing its analytic definition.');return [{...e,start:byId(e.a),end:byId(e.b)}];}const [lo,hi]=e.curveRange||[0,1],samples=K.curveSamples(c).filter(p=>p.curveT>lo&&p.curveT<hi),ps=[{...K.curvePoint(c,lo),id:e.a},...samples.map((p,i)=>({...p,id:e.id+'~sample-'+i,curveSample:true})),{...K.curvePoint(c,hi),id:e.b}];return ps.slice(1).map((p,i)=>({...e,start:ps[i],end:p}));});}
function compactCurves(s){
 if(!s.curves?.length)return s;
 const derived=new Set(s.edges.filter(e=>e.curveId).flatMap(e=>[e.a,e.b]));
 // Merge tessellation fragments, but never erase a deliberate anchor or junction.
 const anchors=new Set(s.nodes.filter(n=>n.userDraftPoint||n.curveCenter||n.curveControl).map(n=>n.id));
 const incident=new Map();for(const e of s.edges)for(const id of [e.a,e.b]){if(!incident.has(id))incident.set(id,[]);incident.get(id).push(e);}
 for(const [id,edges]of incident)if(edges.length!==2||edges.some(e=>!e.curveId||e.curveId!==edges[0].curveId))anchors.add(id);
 for(const c of s.curves){
  const edges=s.edges.filter(e=>e.curveId===c.id);if(edges.length<2)continue;
  const sorted=edges.map(e=>(e.curveRange||[0,1])[0]<=(e.curveRange||[0,1])[1]?e:{...e,a:e.b,b:e.a,curveRange:[e.curveRange[1],e.curveRange[0]]}).sort((a,b)=>(a.curveRange||[0,1])[0]-(b.curveRange||[0,1])[0]),runs=[];
  for(const e of sorted){const range=e.curveRange||[0,1],last=runs.at(-1);if(last&&last.b===e.a&&!anchors.has(e.a)&&Math.abs(last.curveRange[1]-range[0])<1e-6){last.b=e.b;last.curveRange[1]=range[1];}else runs.push({...e,curveRange:range.slice()});}
  s.edges=s.edges.filter(e=>e.curveId!==c.id).concat(runs);
 }
 const used=new Set(s.edges.flatMap(e=>[e.a,e.b]));s.nodes=s.nodes.filter(n=>used.has(n.id)||!n.curveSample&&!derived.has(n.id)||n.userDraftPoint||n.curveCenter);return s;
}
function addCurve(base,curve){
 const s=ensure(base),samples=K.curveSamples(curve);if(samples.some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Curve coordinates must be finite.');const id='curve-'+(++s.next),a=add(base,samples[0],K.GRID),b=add(base,samples.at(-1),K.GRID);
 let centerId;if(curve.center){let center=s.nodes.find(n=>Math.hypot(n.x-curve.center.x,n.y-curve.center.y,n.z-curve.center.z)<=K.CONTACT);if(!center){center={...copy(curve.center),id:'p'+(++s.next),fixed:false};s.nodes.push(center);}center.curveCenter=true;centerId=center.id;}
 s.curves||=[];s.curves.push({...copy(curve),id,...(centerId?{centerId}:{})});const controls=curve.type==='spline'?curve.controls.map(p=>add(base,p,K.GRID)):[a,b],knots=curve.type==='spline'?curve.knots:[0,1];for(let i=1;i<controls.length;i++)s.edges.push({id:'e'+(++s.next),a:controls[i-1],b:controls[i],fixed:false,userConnection:true,curveId:id,curveRange:[knots[i-1],knots[i]]});resolve(base);return b;
}
// A shared edge between faces on different planes is a fold, not a divider.
// Removing it cannot merge those faces; without this check both would vanish.
function fold(base,a,b){
 const planes=[];for(const t of [.25,.5,.75]){const m={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};
  for(const f of base.faces){const pl=G.plane(f.points);if(!onPlane(a,pl)||!onPlane(b,pl)||!onRing(m,f.points))continue;if(!planes.some(q=>f.points.every(p=>onPlane(p,q))))planes.push(pl);}
  if(planes.length>1)return true;planes.length=0;}
 return false;
}
function remove(base,pointIds,lineIds){
 const s=ensure(base),deleted=new Set(s.nodes.filter(n=>pointIds.includes(n.id)&&!n.fixed).map(n=>n.id));
 if(!(base.origin||base.frame||base.constructionPlane)){const doomed=s.edges.filter(e=>!e.fixed&&(lineIds.includes(e.id)||deleted.has(e.a)||deleted.has(e.b)));
  if(s.edges.some(e=>e.holeCut&&lineIds.includes(e.id)))throw Error('That line divides the base around an enclosed region. Remove the region outline instead.');
  if(curveEdges({...s,edges:doomed}).some(e=>e.start&&e.end&&fold(base,e.start,e.end)))throw Error('That line is the fold between base faces on different planes. Make the faces coplanar before removing it.');
 }
 s.nodes=s.nodes.filter(n=>!deleted.has(n.id));s.edges=s.edges.filter(e=>e.fixed||(!lineIds.includes(e.id)&&!deleted.has(e.a)&&!deleted.has(e.b)));
 resolve(base);
}
// Publish changed curve definitions and synchronize only persistent controls.
// Evaluated face loops are rebuilt from those definitions by resolve().
function updateCurves(base,curves,moves=[]){
 const s=ensure(base),byId=new Map(curves.map(c=>[c.id,c]));
 for(const c of curves)if(K.curveSamples(c).some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Curve coordinates must be finite.');
 for(const n of s.nodes){const p=moves.find(m=>m.id===n.id)?.point;if(p)Object.assign(n,p);}
 for(const prior of s.curves||[]){const next=byId.get(prior.id);if(prior.type!=='spline'||!next||prior.knots.length!==next.knots.length)continue;
  for(const e of s.edges.filter(e=>e.curveId===prior.id))e.curveRange=(e.curveRange||[0,1]).map(t=>{const i=prior.knots.findIndex(k=>Math.abs(k-t)<1e-7);return i<0?t:next.knots[i];});
 }
 s.curves=(s.curves||[]).map(c=>byId.get(c.id)||c);
 for(const c of curves){
  for(const e of s.edges.filter(e=>e.curveId===c.id))for(const [id,t]of [[e.a,(e.curveRange||[0,1])[0]],[e.b,(e.curveRange||[0,1])[1]]]){const n=s.nodes.find(n=>n.id===id);if(n)Object.assign(n,K.curvePoint(c,t));}
  if(c.center){let n=s.nodes.find(n=>n.id===c.centerId);const shared=(s.curves||[]).some(other=>other!==c&&other.centerId===c.centerId&&other.center&&Math.hypot(other.center.x-c.center.x,other.center.y-c.center.y,other.center.z-c.center.z)>K.CONTACT);
   if(!n||shared){n=s.nodes.find(n=>n.curveCenter&&Math.hypot(n.x-c.center.x,n.y-c.center.y,n.z-c.center.z)<=K.CONTACT);if(!n){n={...c.center,id:'p'+(++s.next),fixed:false,curveCenter:true};s.nodes.push(n);}c.centerId=n.id;}else Object.assign(n,c.center);
  }
 }
 resolve(base);
}
// Materialize intersections in the editable graph before changing coordinates.
// Face partitioning alone is not enough: an unsplit source edge would otherwise
// keep its old endpoint and regenerate a diagonal after moving a visible cut.
function nodeLines(base){
 const s=ensure(base),straight=s.edges.filter(e=>!e.curveId),graph=K.partition({nodes:s.nodes,edges:straight}),pair=e=>[e.a,e.b].sort().join('|'),old=new Map(straight.map(e=>[pair(e),e]));
 const aliases=new Map();
 for(const n of s.nodes){const target=graph.nodes.find(p=>Math.hypot(n.x-p.x,n.y-p.y)<=K.CONTACT);aliases.set(n.id,target.id);for(const flag of ['fixed','userDraftPoint','curveCenter'])if(n[flag])target[flag]=true;if(target.userDraftPoint)delete target.curveSample;}
 const edges=graph.edges.map(e=>({...e,id:old.get(pair(e))?.id||'e'+(++s.next)}));
 // Preserve isolated deliberate anchors and analytic curves; their evaluation
 // samples are not new editable vertices. Shared endpoint aliases are unified.
 s.nodes=graph.nodes;s.edges=[...edges,...s.edges.filter(e=>e.curveId).map(e=>({...e,a:aliases.get(e.a)||e.a,b:aliases.get(e.b)||e.b}))];
 for(const c of s.curves||[])if(c.centerId)c.centerId=aliases.get(c.centerId)||c.centerId;
 for(const f of base.faces)for(const p of [f.points,...(f.holes||[])].flat())if(p.nodeId)p.nodeId=aliases.get(p.nodeId)||p.nodeId;
 return s;
}
// A base point dragged in plan stays on the faces it belongs to: it is lifted
// onto one supporting plane, slides along the fold between two, and cannot
// leave the corner of three. Free anchors take the plane under their new spot.
function planarDelta(base,n,delta,free){
 let x=delta.x||0,y=delta.y||0,planes=supportPlanes(base.faces,n);
 if(free){const target={x:n.x+x,y:n.y+y},under=base.faces.filter(f=>insideRing(target,f.points)),pl=under.length&&G.plane(under[0].points);if(pl&&under.every(f=>f.points.every(p=>onPlane(p,pl))))return {x,y,z:pl.dx*target.x+pl.dy*target.y+pl.k-n.z};}
 if(!planes.length)return {x,y,z:delta.z||0};
 if(planes.length>2)throw Error('This point joins base faces on three planes and cannot move without bending one of them.');
 if(planes.length===2){const [p,q]=planes,ax=p.dx-q.dx,ay=p.dy-q.dy,l=Math.hypot(ax,ay);if(l>1e-12){const u={x:-ay/l,y:ax/l},t=x*u.x+y*u.y;x=u.x*t;y=u.y*t;}}
 return {x,y,z:planes[0].dx*x+planes[0].dy*y};
}
function move(base,ids,delta,options={}){
 const s=ensure(base),movable=s.nodes.filter(n=>ids.includes(n.id)&&(!n.fixed||options.boundary)),selected=new Set(movable.map(n=>n.id)),local=base.origin||base.frame||base.constructionPlane;
 if(!local&&delta.z){if(delta.x||delta.y)move(base,ids,{x:delta.x,y:delta.y},options);return setHeights(base,new Map(movable.map(n=>[n.id,n.z+delta.z])));}
 const offset=new Map(movable.map(n=>[n.id,local?{x:delta.x||0,y:delta.y||0,z:delta.z||0}:planarDelta(base,n,delta,!s.edges.some(e=>e.a===n.id||e.b===n.id))]));
 const shifted=(p,o)=>({x:p.x+o.x,y:p.y+o.y,z:p.z+o.z});
 for(const n of movable)if(!Object.values(shifted(n,offset.get(n.id))).every(Number.isFinite))throw Error('Point coordinates must be finite.');
 const curves=[];
 for(const c of s.curves||[]){const edges=s.edges.filter(e=>e.curveId===c.id),ends=[...new Set(edges.flatMap(e=>[e.a,e.b]))],changed=ends.filter(id=>selected.has(id));if(!changed.length&&!selected.has(c.centerId))continue;
  const o=offset.get(changed[0]??c.centerId);let map=p=>shifted(p,o);
  if(changed.length&&changed.length<ends.length){
   const moving=s.nodes.find(n=>n.id===changed[0]),fixed=s.nodes.find(n=>ends.includes(n.id)&&!selected.has(n.id)),v={x:moving.x-fixed.x,y:moving.y-fixed.y,z:moving.z-fixed.z},l2=v.x*v.x+v.y*v.y+v.z*v.z;
   // An affine change of the conic moves the endpoint, holds the opposite
   // endpoint, and preserves a smooth curve without promoting any samples.
   if(l2>K.CONTACT*K.CONTACT)map=p=>{const t=((p.x-fixed.x)*v.x+(p.y-fixed.y)*v.y+(p.z-fixed.z)*v.z)/l2;return {x:p.x+o.x*t,y:p.y+o.y*t,z:p.z+o.z*t};};
  }
  const next=K.mapCurve(c,map);if(K.curveSamples(next).some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Curve coordinates must be finite.');curves.push(next);
 }
 updateCurves(base,curves,movable.map(n=>({id:n.id,point:{...shifted(n,offset.get(n.id)),...(local&&delta.z?{manualZ:true}:{})}})));
}
// A vertical point edit is a face edit. A face that stays planar with the new
// heights follows them; any other face keeps its own vertex at the old height,
// as at a step. A face vertex that no face can follow is refused, not dropped.
function setHeights(base,heights){
 const s=ensure(base);if(!heights.size)return;
 for(const z of heights.values())if(!Number.isFinite(z))throw Error('Point coordinates must be finite.');
 if(base.origin||base.frame||base.constructionPlane){for(const n of s.nodes)if(heights.has(n.id)){n.z=heights.get(n.id);n.manualZ=true;}resolve(base);return;}
 const nodes=new Map(s.nodes.map(n=>[n.id,n])),anchor=p=>nodes.has(p.nodeId)&&!nodes.get(p.nodeId).curveSample,vertices=new Set(base.faces.flatMap(f=>f.points.filter(anchor).map(p=>p.nodeId)));
 const followed=new Set(),faces=[],planes=new Map();let bent=null;
 for(const f of base.faces){if(!f.points.some(p=>heights.has(p.nodeId))){faces.push(f);continue;}
  const anchors=f.points.filter(anchor).map(p=>heights.has(p.nodeId)?{...p,z:heights.get(p.nodeId)}:p),pl=G.plane(anchors);
  if(!pl||!anchors.every(p=>onPlane(p,pl))){bent??=f.id;faces.push(f);continue;}
  for(const p of anchors)if(heights.has(p.nodeId))followed.add(p.nodeId);
  planes.set(f.id,{from:G.plane(f.points),to:pl});faces.push({...f,points:f.points.map(p=>({...p,z:pl.dx*p.x+pl.dy*p.y+pl.k}))});
 }
 const stuck=[...heights.keys()].filter(id=>vertices.has(id)&&!followed.has(id));
 if(stuck.length)throw Error(`Raising ${stuck.length===1?'this point':'these points'} would bend base face ${bent}. Select every point of a region, or use the face height and pitch tools.`);
 const before=copy(base),bs=before.sketch,rise=new Map([...heights].filter(([id])=>nodes.has(id)&&!vertices.has(id)).map(([id,z])=>[id,z-nodes.get(id).z]));
 // Free anchors and construction lines are not face geometry; they move as drawn.
 const lift=pl=>p=>({x:p.x,y:p.y,z:pl.dx*p.x+pl.dy*p.y+pl.k});
 bs.curves=(bs.curves||[]).map(c=>{const owner=[...planes.values()].find(({from})=>K.curveSamples(c).every(p=>onPlane(p,from,.002)));if(owner)return K.mapCurve(c,lift(owner.to));
  const ends=[...new Set(bs.edges.filter(e=>e.curveId===c.id).flatMap(e=>[e.a,e.b]))],moving=ends.find(id=>rise.has(id))??(rise.has(c.centerId)?c.centerId:null);if(moving==null)return c;
  const dz=rise.get(moving),still=ends.find(id=>!rise.has(id)),a=nodes.get(still),b=nodes.get(moving),v=a&&b&&{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},l2=v?v.x*v.x+v.y*v.y+v.z*v.z:0;
  return K.mapCurve(c,l2>K.CONTACT*K.CONTACT?p=>({...p,z:p.z+dz*((p.x-a.x)*v.x+(p.y-a.y)*v.y+(p.z-a.z)*v.z)/l2}):p=>({...p,z:p.z+dz}));});
 for(const n of bs.nodes)if(rise.has(n.id)){n.z+=rise.get(n.id);n.userDraftPoint=true;delete n.curveSample;}
 for(const f of faces)if(f.curves&&planes.has(f.id))f.curves=f.curves.map(c=>K.mapCurve(c,lift(planes.get(f.id).to)));
 base.faces=faces;rebind(before,base);
}
// Divide a region around one enclosed hole into simple pieces. The preferred
// cut extends one straight hole edge both ways to the region boundary;
// otherwise two separate rays leave different hole points (corners before
// curve samples). Every ray must reach the region's own boundary before any
// other line, so no other loop or wire is crossed.
function bridge(graph,ring,holes){
 const byId=new Map(graph.nodes.map(n=>[n.id,n])),near=p=>graph.nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<=K.CONTACT);
 const key=(a,b)=>[a,b].sort().join('|'),boundary=new Set(ring.map((a,i)=>key(a.id,ring[(i+1)%ring.length].id))),straight=new Set(graph.edges.filter(e=>!e.curveId).map(e=>key(e.a,e.b)));
 const segments=graph.edges.map(e=>({a:byId.get(e.a),b:byId.get(e.b)})).filter(e=>e.a&&e.b),rings=holes.map(h=>h.map(near));
 const cast=(from,d)=>{let best=null;
  for(const e of segments){if(e.a===from||e.b===from)continue;const ux=e.b.x-e.a.x,uy=e.b.y-e.a.y,den=d.x*uy-d.y*ux;if(Math.abs(den)<1e-12)continue;const wx=e.a.x-from.x,wy=e.a.y-from.y,t=(wx*uy-wy*ux)/den,u=(wx*d.y-wy*d.x)/den;if(t>K.CONTACT&&u>=-1e-9&&u<=1+1e-9&&(!best||t<best.t))best={t,e};}
  if(!best||!boundary.has(key(best.e.a.id,best.e.b.id)))return null;
  const probe={x:from.x+d.x*Math.min(best.t/2,1e-3),y:from.y+d.y*Math.min(best.t/2,1e-3)};if(!strictlyInside(probe,ring)||holes.some(h=>insideRing(probe,h)))return null;
  const hit={x:from.x+d.x*best.t,y:from.y+d.y*best.t},to=[best.e.a,best.e.b].find(n=>Math.hypot(n.x-hit.x,n.y-hit.y)<=K.CONTACT)||hit;return {from,to,t:best.t};};
 let best=null;
 for(const h of rings){if(h.some(p=>!p))continue;for(let i=0;i<h.length;i++){const a=h[i],b=h[(i+1)%h.length],l=Math.hypot(b.x-a.x,b.y-a.y);if(l<=K.CONTACT||!straight.has(key(a.id,b.id)))continue;const d={x:(b.x-a.x)/l,y:(b.y-a.y)/l},ahead=cast(b,d),behind=cast(a,{x:-d.x,y:-d.y});if(ahead&&behind&&(!best||ahead.t+behind.t<best.length))best={length:ahead.t+behind.t,chords:[behind,ahead]};}}
 if(best)return best.chords;
 const crosses=(p,q,r,s)=>{const c=(a,b,d)=>(b.x-a.x)*(d.y-a.y)-(b.y-a.y)*(d.x-a.x);return c(p,q,r)*c(p,q,s)<0&&c(r,s,p)*c(r,s,q)<0;};
 for(const h of rings){if(h.some(p=>!p))continue;const rays=h.flatMap((p,i)=>{const prev=h[(i+h.length-1)%h.length],next=h[(i+1)%h.length],dirs=[{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1},{x:p.x-prev.x,y:p.y-prev.y},{x:p.x-next.x,y:p.y-next.y}];return dirs.map(d=>{const l=Math.hypot(d.x,d.y);return l>K.CONTACT?cast(p,{x:d.x/l,y:d.y/l}):null;}).filter(Boolean);});
  for(let i=0;i<rays.length;i++)for(let j=i+1;j<rays.length;j++){const r=rays[i],s=rays[j],length=r.t+s.t+.01*(!!r.from.curveSample+!!s.from.curveSample);if(r.from===s.from||crosses(r.from,r.to,s.from,s.to))continue;if(!best||length<best.length)best={length,chords:[r,s]};}
  if(best)return best.chords;}
 return null;
}
// One base level. A region tiled by faces of other levels repeats their old
// height (the outline left behind by a raised section) and is not a face here,
// unless faces of this level tile it too. An enclosed loop is a hole in the
// region around it, serialized as simple pieces divided by holeCut edges.
// Those cuts are derived: one that no longer reaches a hole is removed.
function level(s,group,groups,nodes,lines){
 const box=ps=>({x0:Math.min(...ps.map(p=>p.x)),x1:Math.max(...ps.map(p=>p.x)),y0:Math.min(...ps.map(p=>p.y)),y1:Math.max(...ps.map(p=>p.y))});
 const prepare=fs=>fs.map(f=>({points:f.points,box:box(f.points),area:Math.abs(area(f.points))})),others=prepare(groups.filter(g=>g!==group).flatMap(g=>g.faces)),own=prepare(group.faces);
 const tiled=(ps,faces,a,tolerance)=>{const b=box(ps),t=1e-6;let sum=0;for(const f of faces){if(f.box.x0<b.x0-t||f.box.x1>b.x1+t||f.box.y0<b.y0-t||f.box.y1>b.y1+t)continue;const inside=K.intersection([{points:ps}],[{points:f.points}]).reduce((n,r)=>n+K.area(r),0);if(inside>=f.area-tolerance)sum+=f.area;}return sum>=a-tolerance;};
 const ghost=ps=>{if(!others.length)return false;const a=Math.abs(area(ps)),tolerance=Math.max(1e-8,a*1e-6);return tiled(ps,others,a,tolerance)&&!tiled(ps,own,a,tolerance);};
 // A region enclosed only by wall-defined edges that no face covered is open
 // ground (a courtyard or a deleted face), not new base.
 const all=[...own,...others],key=(a,b)=>[a,b].sort().join('|');
 const open=(graph,ps)=>{const fixed=new Set(graph.edges.filter(e=>e.fixed).map(e=>key(e.a,e.b)));if(!ps.every((a,i)=>fixed.has(key(a.id,ps[(i+1)%ps.length].id))))return false;const tolerance=Math.max(1e-8,Math.abs(area(ps))*1e-6);return !all.some(f=>K.intersection([{points:ps}],[{points:f.points}]).reduce((n,r)=>n+K.area(r),0)>tolerance);};
 const analyze=graph=>{const ghosts=new Set(graph.regions.filter(ghost));return {ghosts,holes:graph.regions.map((ps,i)=>{if(ghosts.has(ps))return [];const inner=graph.regions.filter((q,j)=>j!==i&&q.every(p=>strictlyInside(p,ps)));return inner.length?K.union(inner.map(points=>({points}))).map(r=>r.points):[];})};};
 const z=p=>group.plane.dx*p.x+group.plane.dy*p.y+group.plane.k,known=new Set(nodes.map(n=>n.id));let edges=lines;
 if(edges.some(e=>e.holeCut)){const rings=analyze(K.partition({nodes,edges:edges.filter(e=>!e.holeCut)})).holes.flat(),byId=new Map(nodes.map(n=>[n.id,n]));
  const stale=new Set(edges.filter(e=>e.holeCut&&![e.a,e.b].some(id=>byId.has(id)&&rings.some(r=>onRing(byId.get(id),r)))).map(e=>e.id));
  if(stale.size){edges=edges.filter(e=>!stale.has(e.id));s.edges=s.edges.filter(e=>!stale.has(e.id));}}
 for(let pass=0;;pass++){
  const graph=K.partition({nodes,edges}),{ghosts,holes}=analyze(graph);for(const ps of graph.regions)if(open(graph,ps))ghosts.add(ps);
  const chords=pass<16&&graph.regions.map((ps,i)=>holes[i].length?bridge(graph,ps,holes[i]):null).find(Boolean);
  if(!chords){graph.regions=graph.regions.filter(ps=>!ghosts.has(ps));return graph;}
  // A cut that leaves a curve sample makes that exact curve point a real junction node.
  const use=p=>{if(p.id&&known.has(p.id)&&!p.curveSample)return p.id;const n={x:p.x,y:p.y,z:p.id?p.z:z(p),id:p.id&&!p.curveSample?p.id:'p'+(++s.next),fixed:false};known.add(n.id);nodes.push(n);if(!s.nodes.some(q=>q.id===n.id))s.nodes.push(n);return n.id;};
  for(const c of chords){const e={id:'e'+(++s.next),a:use(c.from),b:use(c.to),fixed:false,holeCut:true};edges.push(e);s.edges.push(e);}
 }
}
function resolve(base){
 // Unbounded construction sketches keep analytic wires; the plane editor owns region filling.
 if(base.constructionPlane){compactCurves(ensure(base));return;}
 const s=ensure(base),segments=curveEdges(s),graphNodes=[...s.nodes,...segments.flatMap(e=>[e.start,e.end]).filter(n=>n.curveSample)],graphEdges=segments.map(e=>({...e,a:e.start.id,b:e.end.id})),old=copy(base.faces),faces=[],groups=[];
 // A wall draft already has local planar coordinates. A base can have several
 // elevations or pitches; never combine those in a single XY arrangement.
 if(base.origin||base.frame)groups.push({faces:old,nodes:graphNodes,edges:graphEdges});
 else for(const f of old){const plane=G.plane(f.points);if(!plane)throw Error('The base face must have a supporting plane.');let group=groups.find(g=>f.points.every(p=>Math.abs(p.z-g.plane.dx*p.x-g.plane.dy*p.y-g.plane.k)<=K.CONTACT));if(!group){group={plane,faces:[]};groups.push(group);}group.faces.push(f);}
 const newNodes=[];
 for(const group of groups){
  const nodes=group.nodes||graphNodes.filter(p=>onPlane(p,group.plane)),ids=new Set(nodes.map(p=>p.id)),edges=group.edges||graphEdges.filter(e=>ids.has(e.a)&&ids.has(e.b));
  const graph=group.plane?level(s,group,groups,nodes,edges):K.partition({nodes,edges});
  for(const ps of graph.regions){
  const center=B.center({points:ps});
  const original=group.faces.find(f=>G.contains(f,center))||group.faces[0],plane=G.plane(original.points);
  const points=ps.map(p=>({x:p.x,y:p.y,z:p.manualZ?p.z:plane.dx*p.x+plane.dy*p.y+plane.k,nodeId:p.id}));
  // Partitioned cuts can produce small, valid corner regions on pitched bases.
  // Keep the kernel's geometry tolerance rather than the new-face UI minimum.
  B.validate({points},1e-8);const signature=ps.map(p=>p.id).sort().join('|'),match=old.find(f=>f.points.map(p=>p.nodeId).sort().join('|')===signature);
  // A divider changes a sticker's boundary, not its type. Inherit only when
  // the entire new region belongs to one prior sticker (including its holes).
  const featureOwner=match?.feature?match:old.find(f=>f.feature&&ps.every(p=>G.contains(f,p))&&K.difference({points:ps},[{points:f.points,holes:f.holes||[]}]).reduce((sum,r)=>sum+K.area(r),0)<=1e-8);
  const feature=featureOwner&&{...featureOwner.feature};
  if(feature&&K.area({points:ps})<K.area(featureOwner)-1e-8){feature.preset=null;feature.shape='custom';}

  const finish=match||old.find(f=>(f.material||f.finishColor)&&ps.every(p=>G.contains(f,p))&&K.difference({points:ps},[{points:f.points}]).reduce((sum,r)=>sum+K.area(r),0)<=1e-8);const material=finish?.material;
  // Consumed wall regions remain consumed when point insertion changes their
  // node signature or subdivides an edge. Geometry ownership survives resolution.
  const consumed=match?.solidId?match:old.find(f=>f.solidId&&ps.every(p=>G.contains(f,p))&&K.difference({points:ps},[{points:f.points,holes:f.holes||[]}]).reduce((sum,r)=>sum+K.area(r),0)<=1e-8);
  faces.push({...(!(base.origin||base.frame)&&original.baseStepId?{baseStepId:original.baseStepId}:{}),id:match?.id||'base-face-'+(++s.next),points,...(material?{material}:{}),...(finish?.finishColor?{finishColor:finish.finishColor}:{}),...(finish?.trim?{trim:true}:{}),...(finish?.trimData?{trimData:copy(finish.trimData)}:{}),...(consumed?{solidId:consumed.solidId}:{}),...(match?.boundaryHole?{boundaryHole:true}:{}),...(feature?{feature:copy(feature)}:{})});
 }
 newNodes.push(...graph.nodes);
 }
 if(!faces.length)throw Error('The base needs at least one closed face.');
 // Preserve every intentional anchor, including points unused by a face.
 for(const n of newNodes)if(!n.curveSample&&!s.nodes.some(p=>p.id===n.id))s.nodes.push(n);
 if(s.curves?.length)for(const f of faces)f.curves=(s.curves||[]).filter(c=>f.points.some((p,i)=>K.curveEdgeRange(c,p,f.points[(i+1)%f.points.length]))).map(copy);
 base.faces=faces;s.outlines=B.boundary(faces.map(f=>f.points));
}

// Rebuild the editable graph from face ownership after a footprint or plane edit.
// A shared XY corner at two elevations is two vertices; a construction segment
// is clipped and lifted independently on each of its supporting faces.
function rebind(before,after){
 const original=read(before),evaluated=curveEdges(original),old={...original,nodes:[...original.nodes,...evaluated.flatMap(e=>[e.start,e.end]).filter(n=>n.curveSample)],edges:evaluated.map(e=>({...e,a:e.start.id,b:e.end.id}))},nodes=[],edges=[],used=new Set(),byPair=new Map(),nodeIds=new Set(),sources=new Map();let next=old.next||0;
 for(const n of original.nodes)if(!sources.has(n.id))sources.set(n.id,n);
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),at=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
 const fresh=prefix=>{let id;do{id=prefix+(++next);}while(used.has(id));used.add(id);return id;};
 // Spatial lookups only narrow the candidates; every test below is the exact original one.
 const CELL=4*K.CONTACT,cells=new Map(),cell=(x,y)=>Math.floor(x/CELL)*1000003+Math.floor(y/CELL);
 const near=p=>{const x=Math.floor(p.x/CELL),y=Math.floor(p.y/CELL);let best=-1;for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(const index of cells.get((x+i)*1000003+y+j)||[])if((best<0||index<best)&&distance(nodes[index],p)<=K.CONTACT)best=index;return best<0?null:nodes[best];};
 const node=(p,preferred)=>{let n=near(p);const source=preferred&&sources.get(preferred),flags={...((p.userDraftPoint||source?.userDraftPoint)?{userDraftPoint:true}:{}),...((p.curveCenter||source?.curveCenter)?{curveCenter:true}:{})};if(n){Object.assign(n,flags);if(n.userDraftPoint)delete n.curveSample;return n.id;}const id=preferred&&!used.has(preferred)?preferred:fresh('p');used.add(id);n={...p,...flags,id,fixed:false};delete n.nodeId;if(n.userDraftPoint)delete n.curveSample;nodes.push(n);nodeIds.add(id);const key=cell(n.x,n.y);if(!cells.has(key))cells.set(key,[]);cells.get(key).push(nodes.length-1);return id;};
 const segments=[];
 for(const f of after.faces){for(const p of f.points)p.nodeId=node(p,p.nodeId);for(let i=0;i<f.points.length;i++)segments.push({a:f.points[i].nodeId,b:f.points[(i+1)%f.points.length].nodeId,boundary:true,owner:f.id});}
 // G.contains also accepts points within 2 mm of an edge; the box keeps that margin.
 const supports=before.faces.map(f=>{const xs=f.points.map(p=>p.x),ys=f.points.map(p=>p.y);return {f,plane:G.plane(f.points),box:{x0:Math.min(...xs)-.003,x1:Math.max(...xs)+.003,y0:Math.min(...ys)-.003,y1:Math.max(...ys)+.003}};});
 const on=(p,s)=>s.plane&&Math.abs(p.z-s.plane.dx*p.x-s.plane.dy*p.y-s.plane.k)<=K.CONTACT&&p.x>=s.box.x0&&p.x<=s.box.x1&&p.y>=s.box.y0&&p.y<=s.box.y1&&G.contains(s.f,p);
 const onBoundary=(p,f)=>[f.points,...(f.holes||[])].some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?((p.x-a.x)*dx+(p.y-a.y)*dy)/l2:-1;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<=K.CONTACT;}));
 const targeted=new Map(),targets=f=>{if(!targeted.has(f)){const matching=after.faces.filter(q=>q.id===f.id||String(q.id).startsWith(f.id+'-extrusion-'));targeted.set(f,matching.length?matching:after.faces);}return targeted.get(f);};
 const lift=(p,f)=>{const pl=G.plane(f.points);return {...p,z:pl.dx*p.x+pl.dy*p.y+pl.k};};
 for(const p of old.nodes)for(const support of supports.filter(s=>on(p,s)))for(const f of targets(support.f))if(G.contains(f,p)&&(p.userDraftPoint||!onBoundary(p,support.f)||onBoundary(p,f)))node(lift(p,f),p.id);
 // Deliberate exterior anchors are not clipped to the previous footprint.
 for(const p of old.nodes)if(p.userDraftPoint&&!supports.some(s=>on(p,s))&&!nodeIds.has(p.id))node(p,p.id);
 const oldNode=new Map(old.nodes.map(n=>[n.id,n]));
 for(const e of old.edges){if(e.fixed||e.chimneyFoundation)continue;const a=oldNode.get(e.a),b=oldNode.get(e.b);if(!a||!b)continue;
  // Rebuild geometric boundaries from faces, never copy an obsolete shared
  // boundary back as a construction line merely because fixed was false.
  if(supports.some(s=>{if(!on(a,s)||!on(b,s))return false;const ts=G.splitParameters(a,b,[s.f]);return ts.slice(1).every((hi,i)=>onBoundary(at(a,b,(ts[i]+hi)/2),s.f));}))continue;
  if(e.userConnection){
   const endpoint=p=>nodeIds.has(p.id)?p.id:node(p,p.id);
   const u=endpoint(a),v=endpoint(b);if(u!==v)segments.push({...e,a:u,b:v,boundary:false});continue;
  }
  for(const support of supports.filter(s=>s.plane&&[a,b].every(p=>Math.abs(p.z-s.plane.dx*p.x-s.plane.dy*p.y-s.plane.k)<=K.CONTACT))){for(const f of targets(support.f)){
   const ts=G.splitParameters(a,b,[support.f,f]);
   for(let i=1;i<ts.length;i++){const mid=at(a,b,(ts[i-1]+ts[i])/2);if(!G.contains(support.f,mid)||!G.contains(f,mid))continue;
    const u=node(lift(at(a,b,ts[i-1]),f)),v=node(lift(at(a,b,ts[i]),f));if(u!==v)segments.push({...e,a:u,b:v,boundary:false});
   }
  }}
 }
 // Node boundary T junctions as well as editable lines. No long overlapping
 // edge survives beside its shorter fragments.
 const lookup=new Map(nodes.map(n=>[n.id,n])),byX=nodes.map((n,i)=>i).sort((i,j)=>nodes[i].x-nodes[j].x||i-j),xs=byX.map(i=>nodes[i].x);
 const firstAt=x=>{let lo=0,hi=xs.length;while(lo<hi){const m=(lo+hi)>>1;if(xs[m]<x)lo=m+1;else hi=m;}return lo;};
 for(const e of segments){const a=lookup.get(e.a),b=lookup.get(e.b),len=distance(a,b);if(len<=K.CONTACT)continue;
  const pad=K.CONTACT+1e-8*len+1e-9,y0=Math.min(a.y,b.y)-pad,y1=Math.max(a.y,b.y)+pad,x1=Math.max(a.x,b.x)+pad,candidates=[];for(let i=firstAt(Math.min(a.x,b.x)-pad);i<xs.length&&xs[i]<=x1;i++){const n=nodes[byX[i]];if(n.y>=y0&&n.y<=y1)candidates.push(byX[i]);}
  const hits=candidates.sort((i,j)=>i-j).map(i=>nodes[i]).map(n=>({n,t:((n.x-a.x)*(b.x-a.x)+(n.y-a.y)*(b.y-a.y)+(n.z-a.z)*(b.z-a.z))/(len*len)})).filter(h=>h.t>=-1e-8&&h.t<=1+1e-8&&distance(h.n,at(a,b,h.t))<=K.CONTACT).sort((a,b)=>a.t-b.t);
  for(let i=1;i<hits.length;i++){const u=hits[i-1].n.id,v=hits[i].n.id;if(u===v)continue;const key=[u,v].sort().join('|');let edge=byPair.get(key);if(!edge){edge={id:fresh('e'),a:u,b:v,fixed:false,owners:new Set()};byPair.set(key,edge);edges.push(edge);}if(e.boundary)edge.owners.add(e.owner);if(e.userConnection)edge.userConnection=true;}
 }
 for(const e of edges){e.fixed=e.owners.size===1;delete e.owners;if(e.fixed){lookup.get(e.a).fixed=true;lookup.get(e.b).fixed=true;}}
 // Cut edges are rebuilt from face boundaries; keep their derived marker in plan.
 const cuts=old.edges.filter(e=>e.holeCut).map(e=>[oldNode.get(e.a),oldNode.get(e.b)]).filter(([a,b])=>a&&b);
 if(cuts.length)for(const e of edges){const m=at(lookup.get(e.a),lookup.get(e.b),.5);if(!e.fixed&&cuts.some(([a,b])=>segmentDistance(m,a,b)<=K.CONTACT))e.holeCut=true;}
 const curves=[...new Map([...(old.curves||[]),...after.faces.flatMap(f=>f.curves||[])].map(c=>[c.id,c])).values()];
 // Same result as one K.annotateCurveGraph pass over every edge: a curve can
 // only claim an edge whose ends both lie along its samples (the plan distance
 // never exceeds the 3D one), tried in curve order on node copies; junctions
 // are then counted once on every edge at a curve node.
 for(const c of curves){const close=alongSamples(K.curveSamples(c),K.CONTACT+1e-9),claim=edges.filter(e=>!e.curveId&&close(lookup.get(e.a))&&close(lookup.get(e.b)));if(claim.length)K.annotateCurveGraph({nodes:[...new Set(claim.flatMap(e=>[e.a,e.b]))].map(id=>({...lookup.get(id)})),edges:claim},[c]);}
 const curveNodes=new Set(edges.filter(e=>e.curveId).flatMap(e=>[e.a,e.b]));K.annotateCurveGraph({nodes,edges:edges.filter(e=>e.curveId||curveNodes.has(e.a)||curveNodes.has(e.b))},curves);
 const priors=new Map();for(const v of original.edges)if(v.curveId){if(!priors.has(v.curveId))priors.set(v.curveId,[]);priors.get(v.curveId).push(v);}
 for(const e of edges)if(e.curveId){const prior=priors.get(e.curveId)||[];if(prior.length)e.fixed=prior.every(v=>v.fixed);}
 const usedCurves=new Set(edges.map(e=>e.curveId).filter(Boolean));
 after.sketch={version:2,next,nodes,edges,outlines:B.boundary(after.faces.map(f=>f.points)),...(curves.length?{curves:curves.filter(c=>usedCurves.has(c.id))}:{})};compactCurves(after.sketch);return after;
}

// Plan-distance test against a sampled curve, bucketed so a point checks only nearby samples.
function alongSamples(ps,tolerance){
 const xs=ps.map(p=>p.x),ys=ps.map(p=>p.y),x0=Math.min(...xs),y0=Math.min(...ys),size=Math.max(1e-3,Math.hypot(Math.max(...xs)-x0,Math.max(...ys)-y0)/32),grid=new Map(),key=(i,j)=>i*1000003+j;
 for(let n=1;n<ps.length;n++){const a=ps[n-1],b=ps[n];for(let i=Math.floor((Math.min(a.x,b.x)-tolerance-x0)/size);i<=Math.floor((Math.max(a.x,b.x)+tolerance-x0)/size);i++)for(let j=Math.floor((Math.min(a.y,b.y)-tolerance-y0)/size);j<=Math.floor((Math.max(a.y,b.y)+tolerance-y0)/size);j++){const k=key(i,j);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(n);}}
 return p=>!!p&&(grid.get(key(Math.floor((p.x-x0)/size),Math.floor((p.y-y0)/size)))||[]).some(n=>segmentDistance(p,ps[n-1],ps[n])<=tolerance);
}
const surfaceBoundaryCache=new WeakMap();
function syncSurfaceBoundaries(base,surfaces){
 if(!base?.faces?.length||!surfaces?.some(f=>f.curvedSurface&&!f.deleted&&!f.drafted))return false;
 const signature=()=>JSON.stringify([base.faces,surfaces.filter(f=>f.curvedSurface&&!f.deleted&&!f.drafted).map(f=>[f.id,f.curvedSurface])]),key=signature();if(surfaceBoundaryCache.get(base)===key)return false;
 const before=copy(base),changed=K.attachBoundaryCurves(base.faces,surfaces);if(changed)rebind(before,base);surfaceBoundaryCache.set(base,signature());return changed;
}
// Build once per draw or pick pass; each answer equals isCurveSample(base,p).
// The plan buckets only narrow candidates for the original 3D tests.
function curveSampleTest(base){
 const s=read(base);if(!s.curves?.length)return ()=>false;
 const segments=curveEdges(s).filter(e=>e.curveId).map(e=>{const a=e.start,b=e.end;return {a,b,v:{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}};}),items=[...s.nodes.map(n=>({n,reach:K.CONTACT,x0:n.x,x1:n.x,y0:n.y,y1:n.y})),...segments.map(e=>{const reach=.002+1e-5*Math.hypot(e.v.x,e.v.y)+1e-9;return {e,reach,x0:Math.min(e.a.x,e.b.x),x1:Math.max(e.a.x,e.b.x),y0:Math.min(e.a.y,e.b.y),y1:Math.max(e.a.y,e.b.y)};})];
 const x0=Math.min(...items.map(i=>i.x0)),y0=Math.min(...items.map(i=>i.y0)),size=Math.max(.01,Math.hypot(Math.max(...items.map(i=>i.x1))-x0,Math.max(...items.map(i=>i.y1))-y0)/64),grid=new Map(),key=(i,j)=>i*1000003+j;
 for(const item of items)for(let i=Math.floor((item.x0-item.reach-x0)/size);i<=Math.floor((item.x1+item.reach-x0)/size);i++)for(let j=Math.floor((item.y0-item.reach-y0)/size);j<=Math.floor((item.y1+item.reach-y0)/size);j++){const k=key(i,j);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(item);}
 return p=>{const near=grid.get(key(Math.floor((p.x-x0)/size),Math.floor((p.y-y0)/size)))||[];if(near.some(i=>i.n&&Math.hypot(i.n.x-p.x,i.n.y-p.y,i.n.z-p.z)<=K.CONTACT))return false;
  return near.some(({e})=>{if(!e)return false;const {a,v}=e,l2=v.x*v.x+v.y*v.y+v.z*v.z,t=l2?((p.x-a.x)*v.x+(p.y-a.y)*v.y+(p.z-a.z)*v.z)/l2:-1;return t>=-1e-5&&t<=1+1e-5&&Math.hypot(p.x-a.x-v.x*t,p.y-a.y-v.y*t,p.z-a.z-v.z*t)<=.002;});};
}
function isCurveSample(base,p){const s=read(base);if(!s.curves?.length||s.nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y,n.z-p.z)<=K.CONTACT))return false;
 return curveEdges(s).filter(e=>e.curveId).some(e=>{const a=e.start,b=e.end,v={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},l2=v.x*v.x+v.y*v.y+v.z*v.z,t=l2?((p.x-a.x)*v.x+(p.y-a.y)*v.y+(p.z-a.z)*v.z)/l2:-1;return t>=-1e-5&&t<=1+1e-5&&Math.hypot(p.x-a.x-v.x*t,p.y-a.y-v.y*t,p.z-a.z-v.z*t)<=.002;});
}
// Upgrade old saved graphs whose node heights lagged behind their face planes.
// The current faces stay authoritative. Version 1 resolved one plan arrangement:
// a node could be shared by faces at different heights, so a node is supported
// by its face as recorded or as it stands now. Points and lines that no face
// used were drawn deliberately, and a drawn line across a step is lifted onto
// each face it crosses.
function upgrade(base){
 if(!base?.sketch||base.sketch.version>=2)return false;
 const before=copy(base),s=before.sketch,nodes=new Map(s.nodes.map(p=>[p.id,p])),used=new Set(base.faces.flatMap(f=>f.points.map(p=>p.nodeId)));
 const recorded=before.faces.map(f=>{const points=f.points.map(p=>nodes.has(p.nodeId)?{...p,z:nodes.get(p.nodeId).z}:p),pl=G.plane(points);return pl&&points.every(p=>onPlane(p,pl))&&f.points.some((p,i)=>Math.abs(p.z-points[i].z)>K.CONTACT)?{...f,points}:null;}).filter(Boolean);
 for(const n of s.nodes)if(!n.fixed&&!used.has(n.id)){n.userDraftPoint=true;delete n.curveSample;}
 const faces=base.faces.map(f=>({f,plane:G.plane(f.points)})).filter(f=>f.plane),at=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
 s.edges=s.edges.flatMap(e=>{const a=nodes.get(e.a),b=nodes.get(e.b);if(e.fixed||e.curveId||!a||!b||faces.some(({plane})=>onPlane(a,plane)&&onPlane(b,plane)))return [e];
  const ts=G.splitParameters(a,b,base.faces),parts=[];
  for(let i=1;i<ts.length;i++){const mid=at(a,b,(ts[i-1]+ts[i])/2),owner=faces.find(({f})=>G.contains(f,mid));if(!owner)continue;const end=(t,n)=>{const p=at(a,b,t),z=owner.plane.dx*p.x+owner.plane.dy*p.y+owner.plane.k;if(n&&Math.abs(n.z-z)<=K.CONTACT)return n.id;const id='p'+(++s.next);s.nodes.push({x:p.x,y:p.y,z,id,fixed:false});return id;};
   parts.push({...e,id:'e'+(++s.next),a:end(ts[i-1],ts[i-1]===0&&a),b:end(ts[i],ts[i]===1&&b)});}
  return parts.length?parts:[e];});
 before.faces=[...before.faces,...recorded];rebind(before,base);return true;
}
const api={nodeLines,updateCurves,syncSurfaceBoundaries,isCurveSample,curveSampleTest,curveEdges,compactCurves,addCurve,read,ensure,rebind,upgrade,add,connect,remove,move,setHeights,resolve};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BaseSketchGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
