/* Editable house base polygons. All coordinates are metres; faces own their
   vertices so adjacent floor sections can have independent elevations. */
(function(root){
'use strict';
const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
const copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const area=ps=>ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2;
const center=f=>f.points.reduce((s,p)=>({x:s.x+p.x/f.points.length,y:s.y+p.y/f.points.length,z:s.z+p.z/f.points.length}),{x:0,y:0,z:0});
function triangles(points){return K.triangles(points).triangles;}
function validate(f,minArea=.001){
 if(f.points.length<3||f.points.some(p=>![p.x,p.y,p.z].every(Number.isFinite))||Math.abs(area(f.points))<minArea)throw Error('A base face needs a nonzero, finite area.');
 triangles(f.points);return f;
}
function terrain(base){
 const points=[],faces=[];
 for(const f of base.faces){const n=points.length;points.push(...f.points);faces.push(...triangles(f.points).map(t=>t.map(i=>i+n)));}
 return {points,faces};
}
function boundary(polys){return K.union(polys.map(points=>({points}))).map(f=>f.points);}
function wallLoops(walls,grade,occluders=[]){
 const ground=p=>{for(const ids of grade.faces){const f={points:ids.map(i=>grade.points[i])};if(G.contains(f,p)){const pl=G.plane(f.points);return pl.dx*p.x+pl.dy*p.y+pl.k;}}return null;};
 // Cluster endpoints for connectivity, but trace their actual positions so
 // a repaired wall is not clipped away by a snapped foundation corner.
 const nodes=[],adj=[],endsByEdge=new Map();const node=p=>{let i=nodes.findIndex(q=>dist(p,q)<.05);if(i<0){i=nodes.length;nodes.push(p);adj.push(new Set());}return i;};
 for(const w of walls){if(!w.bottom.every(p=>{const z=ground(p);return z!==null&&Math.abs(z-p.z)<.05;}))continue;const a=node(w.bottom[0]),b=node(w.bottom[1]);if(a!==b){adj[a].add(b);adj[b].add(a);endsByEdge.set(a+':'+b,w.bottom);endsByEdge.set(b+':'+a,[w.bottom[1],w.bottom[0]]);}}
 // A chimney masks a wall interval without opening the house footprint.
 // Reconnect dangling ends only when the whole link is masked by the same chimney.
 const ends=nodes.map((p,i)=>i).filter(i=>adj[i].size===1);
 for(let a=0;a<ends.length;a++)for(let b=a+1;b<ends.length;b++){
  const i=ends[a],j=ends[b];if(adj[i].size!==1||adj[j].size!==1)continue;
  const p=nodes[i],q=nodes[j],len=dist(p,q);if(len<1e-6)continue;
  const u=nodes[[...adj[i]][0]],v=nodes[[...adj[j]][0]];
  if((u.x-p.x)*(q.x-p.x)+(u.y-p.y)*(q.y-p.y)>=0||(v.x-q.x)*(p.x-q.x)+(v.y-q.y)*(p.y-q.y)>=0)continue;
  if(!occluders.some(f=>[p,q,{x:(p.x+q.x)/2,y:(p.y+q.y)/2}].every(n=>G.contains(f,n)||f.points.some((r,k)=>G.onEdge(n,r,f.points[(k+1)%f.points.length],.05)))))continue;
  adj[i].add(j);adj[j].add(i);
 }
 const sorted=adj.map((ids,i)=>[...ids].sort((a,b)=>Math.atan2(nodes[a].y-nodes[i].y,nodes[a].x-nodes[i].x)-Math.atan2(nodes[b].y-nodes[i].y,nodes[b].x-nodes[i].x))),seen=new Set(),loops=[];
 for(let i=0;i<nodes.length;i++)for(const j of sorted[i]){
  if(seen.has(i+':'+j))continue;const loop=[];let a=i,b=j,closed=false;
  for(let step=0;step<1000;step++){const key=a+':'+b;if(seen.has(key)){closed=a===i&&b===j;break;}seen.add(key);for(const p of endsByEdge.get(key)||[nodes[a],nodes[b]])if(!loop.length||dist(loop[loop.length-1],p)>1e-7)loop.push(p);const list=sorted[b],n=list[(list.indexOf(a)+list.length-1)%list.length];a=b;b=n;}
  if(loop.length>1&&dist(loop[0],loop[loop.length-1])<1e-7)loop.pop();
  if(closed&&loop.length>=3&&area(loop)>.05){try{validate({points:loop});loops.push(loop);}catch{}}
 }return loops;
}
function groundWalls(walls,grade){
 const terrainFaces=grade.faces.map(ids=>({points:ids.map(i=>grade.points[i])}));
 return walls.filter(w=>w.bottom.every(p=>terrainFaces.some(f=>{const pl=G.plane(f.points);return G.contains(f,p)&&Math.abs(p.z-pl.dx*p.x-pl.dy*p.y-pl.k)<.05;})));
}
function coversWalls(loops,walls){
 return walls.every(w=>[...w.bottom,{x:(w.bottom[0].x+w.bottom[1].x)/2,y:(w.bottom[0].y+w.bottom[1].y)/2}].every(p=>loops.some(points=>G.contains({points},p)||points.some((a,i)=>G.onEdge(p,a,points[(i+1)%points.length],.05)))));
}
// If interrupted wall runs cannot form a loop, retain the chosen roof setback
// instead of silently reverting to the eave footprint. Clipper handles concave
// corners, disconnected wings and offsets which collapse narrow regions.
function insetRoof(roof,setback,chimneys=[],sources=null){
 const C=typeof module==='object'&&module.exports?require('./vendor/clipper-lib-6.4.2-clipper.js'):root.ClipperLib;
 const notchFill=chimneys.filter(c=>c.roofCrossing).map(c=>{
  const {a,b,outward}=c.roofCrossing,inside=c.points.filter(p=>(p.x-a.x)*outward.x+(p.y-a.y)*outward.y<=1e-6),points=[...inside,a,b];
  const center=points.reduce((s,p)=>({x:s.x+p.x/points.length,y:s.y+p.y/points.length}),{x:0,y:0});
  return {points:points.sort((p,q)=>Math.atan2(p.y-center.y,p.x-center.x)-Math.atan2(q.y-center.y,q.x-center.x))};
 });
 // Surveyed layers can meet a millimetre apart in plan. Weld those contact
 // vertices before offsetting so a tiny union edge cannot turn into a long
 // setback notch. This only normalizes the footprint, never the roof itself.
 const clearanceLayers=new Set((sources||[]).flatMap(s=>s.clearanceRoofIds||[]));
 const contacts=roof.faces.filter(f=>clearanceLayers.has(f.id)).flatMap(f=>f.points);
 const input=[...roof.faces.map(f=>({points:f.points})),...notchFill];
 const regions=K.union(input.map(f=>({points:f.points.map(p=>contacts.find(q=>dist(p,q)<.002)||p)}))),scale=1/K.GRID;
 if(!setback&&!sources?.length)return regions.map(f=>f.points);
 const offset=new C.ClipperOffset(4),paths=[];
 for(const f of regions){const path=f.points.map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)}));if(!C.Clipper.Orientation(path))path.reverse();paths.push(path);}
 offset.AddPaths(paths,C.JoinType.jtMiter,C.EndType.etClosedPolygon);
 const result=[];offset.Execute(result,-setback*scale);
 let regular=result.map(path=>({points:path.map(p=>({x:p.X/scale,y:p.Y/scale}))}));
 if(sources?.some(s=>s.contactSetback!==undefined||s.clearanceRoofIds?.length)){
  const paths=[];
  for(const region of regions){
   let ps=region.points;if(area(ps)<0)ps=ps.slice().reverse();
   const edges=ps.map((a,i)=>{const b=ps[(i+1)%ps.length],length=dist(a,b),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length},n={x:-u.y,y:u.x};
    const matches=sources.filter(s=>s.originalA&&[s.originalA,s.originalB].every(p=>Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)<.005)&&Math.abs((s.originalB.x-s.originalA.x)*u.x+(s.originalB.y-s.originalA.y)*u.y)>.01);
    const overlapping=matches.filter(s=>{const ts=[s.originalA,s.originalB].map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y).sort((a,b)=>a-b);return Math.min(length,ts[1])-Math.max(0,ts[0])>.002;});
    // The union has lost roof elevations: a tiny lower cap must not reduce
    // the entire main eave's setback. Keep the deeper supporting body here;
    // each narrow layer adds its own reduced footprint below.
    const offsets=overlapping.map(s=>s.setback),d=offsets.length?Math.max(...offsets):setback;
    return {a:{x:a.x+n.x*d,y:a.y+n.y*d},b:{x:b.x+n.x*d,y:b.y+n.y*d}};
   });
   const points=edges.flatMap((e,i)=>{const prev=edges[(i+edges.length-1)%edges.length],u={x:prev.b.x-prev.a.x,y:prev.b.y-prev.a.y},v={x:e.b.x-e.a.x,y:e.b.y-e.a.y},den=u.x*v.y-u.y*v.x;
    if(Math.abs(den)<1e-9)return dist(prev.b,e.a)<1e-6?[e.a]:[prev.b,e.a];const t=((e.a.x-prev.a.x)*v.y-(e.a.y-prev.a.y)*v.x)/den;return [{x:prev.a.x+u.x*t,y:prev.a.y+u.y*t}];
   });
   paths.push(points.map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)})));
  }
  const simplified=C.Clipper.SimplifyPolygons(paths,C.PolyFillType.pftPositive);
  if(simplified.length)regular=simplified.map(path=>({points:path.map(p=>({x:p.X/scale,y:p.Y/scale}))}));
 }
 // Small, separate lower roofs need their own reduced setback. Offsetting
 // only the union with the main roof erases these supporting wall footprints.
 const groups=[...new Set(G.roofLayers(roof).values())];
 for(const group of groups){
  const limit=G.layerSetback(group,setback);
  if(limit>=setback-1e-6&&!group.some(f=>clearanceLayers.has(f.id)))continue;
  if(group.length===1&&group[0].points.every((p,i,ps)=>cross(ps[(i+ps.length-1)%ps.length],p,ps[(i+1)%ps.length])*area(ps)>=-1e-8)){
   let parts=[{points:group[0].points}];
   for(const edge of roof.connections||[]){if(!['eave','rake'].includes(edge.type))continue;const a=roof.points[edge.startIdx],b=roof.points[edge.endIdx],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(G.chimneyContact(roof,a,b)||!group[0].points.some((p,i)=>G.onEdge(mid,p,group[0].points[(i+1)%group[0].points.length],1e-5)))continue;
    const len=dist(a,b),u={x:(b.x-a.x)/len,y:(b.y-a.y)/len},n={x:-u.y,y:u.x};if(!G.contains(group[0],{x:mid.x+n.x*.02,y:mid.y+n.y*.02})){n.x=-n.x;n.y=-n.y;}
    const at=(t,d)=>({x:a.x+u.x*t+n.x*d,y:a.y+u.y*t+n.y*d}),size=10000;parts=K.intersection(parts,[{points:[at(-size,limit),at(size,limit),at(size,size),at(-size,size)]}]);
   }
   regular.push(...parts);continue;
  }
  const small=K.union(group.map(f=>({points:f.points}))),offset=new C.ClipperOffset(4),paths=small.map(f=>f.points.map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)})));
  for(const path of paths)if(!C.Clipper.Orientation(path))path.reverse();offset.AddPaths(paths,C.JoinType.jtMiter,C.EndType.etClosedPolygon);const output=[];offset.Execute(output,-limit*scale);regular.push(...output.map(path=>({points:path.map(p=>({x:p.X/scale,y:p.Y/scale}))})));
 }
 return K.union(regular).map(f=>f.points);
}
function fromRoof(roof,grade,walls=[],setback=0,chimneys=null,sources=null){
 const C=typeof module==='object'&&module.exports?require('./wall_chimneys.js'):root.WallChimneys;
 const occluders=chimneys?.items||C?.detect(roof)?.items||[];
 const plane=G.plane(grade.points),traced=wallLoops(walls,grade,occluders);
 // A small closed dormer loop must not stand in for an open main perimeter.
 const complete=traced.length&&coversWalls(traced,groundWalls(walls,grade));
 let loops=complete?traced:insetRoof(roof,setback,occluders,sources);
 // A measured flashing and the default inset can describe the same wall a
 // centimetre apart. Resolve that construction contact before unioning the
 // supporting bodies, rather than leaving two overlapping wall planes.
 if(!complete&&sources){
  loops=loops.map(ring=>{const result=ring.map(p=>({...p}));for(let i=0;i<ring.length;i++){
   const a=ring[i],b=ring[(i+1)%ring.length],length=dist(a,b);if(length<1)continue;
   const u={x:(b.x-a.x)/length,y:(b.y-a.y)/length};
   const candidates=sources.filter(s=>s.kind==='flashing'&&Math.abs((s.b.x-s.a.x)*u.y-(s.b.y-s.a.y)*u.x)<.002&&[s.a,s.b].every(p=>Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)<.02)).filter(s=>{const ts=[s.a,s.b].map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y).sort((a,b)=>a-b);return Math.min(length,ts[1])-Math.max(0,ts[0])>.15;});
   if(!candidates.length)continue;const s=candidates[0],d={x:s.b.x-s.a.x,y:s.b.y-s.a.y},l2=d.x*d.x+d.y*d.y;
   for(const j of [i,(i+1)%ring.length]){const p=result[j],t=((p.x-s.a.x)*d.x+(p.y-s.a.y)*d.y)/l2;result[j]={...p,x:s.a.x+t*d.x,y:s.a.y+t*d.y};}
  }return result;});loops=K.union(loops.map(points=>({points}))).map(f=>f.points);
 }
 // Boolean roof unions can retain sub-pixel survey drift beside a chimney.
 // Resolve those foundation junctions onto the measured volume boundary so
 // its exposed shell and the generated house wall share the same endpoint.
 if(!complete&&sources)loops=loops.map(ring=>ring.map(p=>{
  let best=p,distance=.005;
  for(const c of occluders)for(let i=0;i<c.points.length;i++){
   const a=c.points[i],b=c.points[(i+1)%c.points.length],dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy,t=((p.x-a.x)*dx+(p.y-a.y)*dy)/length;
   if(t<0||t>1)continue;const q={x:a.x+dx*t,y:a.y+dy*t},d=dist(p,q);if(d<distance){best=q;distance=d;}
  }return best;
 }));
 if(!loops.length)throw Error('Cannot trace a closed house outline from the roof.');
 return {visible:true,centers:true,source:complete?'Wall perimeter':setback?'Inset roof footprint':'Roof footprint',faces:loops.map((ps,i)=>validate({id:'base-'+(i+1),points:ps.map(p=>({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}))}))};
}
// A fallback foundation is the regularized union of the inset roof bodies.
// Use that same boundary for ground-reaching walls, rather than clipping an
// independently mitered set of open source runs against it. Upper roof-mounted
// walls remain independent and keep their roof contact elevations.
function usesRoofEnvelope(base,grade){
 if(!['Inset roof footprint','Roof footprint'].includes(base?.source)||!grade?.faces?.length)return false;
 const planes=grade.faces.map(ids=>{const points=ids.map(i=>grade.points[i]);return {points,plane:G.plane(points)};});
 return base.faces.every(f=>f.points.every(p=>planes.some(g=>G.contains(g,p)&&Math.abs(p.z-g.plane.dx*p.x-g.plane.dy*p.y-g.plane.k)<.002)));
}
function clipRoofTops(walls,roof){
 const triangles=roof.faces.flatMap(f=>{const mesh=K.triangles(f.points,f.holes||[]);return mesh.triangles.map(ids=>({id:f.id,points:ids.map(i=>mesh.points[i])}));}).map(f=>({...f,plane:G.plane(f.points)})).filter(f=>f.plane);
 const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),height=(f,p)=>f.plane.dx*p.x+f.plane.dy*p.y+f.plane.k;
 return walls.flatMap(w=>{
  const ts=G.splitParameters(...w.bottom,triangles),out=[];
  for(let i=1;i<ts.length;i++){
   const lo=ts[i-1],hi=ts[i],mid=mix(...w.top,(lo+hi)/2),cover=triangles.filter(f=>G.contains(f,mid)).sort((a,b)=>height(b,mid)-height(a,mid))[0];
   const bottom=[lo,hi].map(t=>mix(...w.bottom,t)),top=[lo,hi].map((t,j)=>{const p=mix(...w.top,t);return {...p,z:Math.max(bottom[j].z,Math.min(p.z,cover?height(cover,p):Infinity))};});
   if(dist(...bottom)<.002||top.every((p,j)=>p.z-bottom[j].z<.00001))continue;
   out.push({...w,id:ts.length===2?w.id:w.id+':roof-'+i,bottom,top});
  }return out;
 });
}
function reconcileRoofWalls(walls,roof,sources,base,grade){
 if(!usesRoofEnvelope(base,grade))return walls;
 const C=typeof module==='object'&&module.exports?require('./wall_chimneys.js'):root.WallChimneys;
 const faces=C?C.buildingBase({base}):base.faces,regions=K.union(faces),terrainFaces=grade.faces.map(ids=>({points:ids.map(i=>grade.points[i])}));
 const height=(plane,p)=>plane.dx*p.x+plane.dy*p.y+plane.k;
 const floor=p=>{const f=terrainFaces.find(f=>G.contains(f,p));return f?height(G.plane(f.points),p):height(G.plane(grade.points),p);};
 const remaining=walls.filter(w=>!(w.kind==='perimeter'&&String(w.targetId).startsWith('ground'))&&!w.bottom.every(p=>Math.abs(p.z-floor(p))<.02));
 const perimeters=sources.filter(s=>s.kind==='perimeter'),result=[];
 const clearanceIds=new Set(sources.flatMap(s=>s.clearanceRoofIds||[])),lowerFaces=roof.faces.filter(f=>clearanceIds.has(f.id));
 for(let fi=0;fi<regions.length;fi++)for(const ring of [regions[fi].points,...regions[fi].holes])for(let ei=0;ei<ring.length;ei++){
  const a=ring[ei],b=ring[(ei+1)%ring.length],length=dist(a,b);if(length<.002)continue;
  const u={x:(b.x-a.x)/length,y:(b.y-a.y)/length},at=p=>((p.x-a.x)*u.x+(p.y-a.y)*u.y)/length;
  const parallel=perimeters.filter(s=>Math.abs((s.b.x-s.a.x)*u.y-(s.b.y-s.a.y)*u.x)/dist(s.a,s.b)<.01);
  const cuts=[0,1,...G.splitParameters({...a,z:0},{...b,z:0},roof.faces)];
  for(const s of parallel)for(const p of [s.a,s.b]){const t=at(p);if(t>0&&t<1&&Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)<.01)cuts.push(t);}
  const ts=[...new Set(cuts.map(t=>+t.toFixed(8)))].sort((a,b)=>a-b);
  for(let i=1;i<ts.length;i++){
   const point=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}),p=point(ts[i-1]),q=point(ts[i]),mid=point((ts[i-1]+ts[i])/2);if(dist(p,q)<.002)continue;
   const score=s=>{const d={x:s.b.x-s.a.x,y:s.b.y-s.a.y},l=dist(s.a,s.b),t=Math.max(0,Math.min(1,((mid.x-s.a.x)*d.x+(mid.y-s.a.y)*d.y)/(l*l)));return dist(mid,{x:s.a.x+d.x*t,y:s.a.y+d.y*t});};
   const ranked=parallel.map(s=>({s,d:score(s)})).sort((a,b)=>a.d-b.d),owner=ranked[0]&&ranked[0].d<=Math.max(.02,4*(ranked[0].s.setback||0))?ranked[0].s:null;
   const roofFace=roof.faces.filter(f=>G.contains({...f,holes:[]},mid)).map(f=>({f,plane:G.plane(f.points)})).filter(f=>f.plane).sort((a,b)=>height(b.plane,mid)-height(a.plane,mid))[0];
   const plane=owner?.sourcePlane||roofFace?.plane;if(!plane)continue;
   // Offset source planes extrapolate a pitch beyond its measured hip seam.
   // The finite roof face covering this interval caps that extrapolation.
   // The support under a lower cap ends at that cap. Short survey-junction
   // edges can be closer to the main source, but must not grow through it.
   const lower=lowerFaces.filter(f=>G.contains(f,mid)&&!sources.some(s=>s.kind==='flashing'&&s.parentId===f.id&&G.onEdge(mid,s.a,s.b,.002))).map(f=>G.plane(f.points)).filter(Boolean);
   const ceiling=point=>Math.min(height(plane,point),roofFace?height(roofFace.plane,point):Infinity,...lower.map(p=>height(p,point)));
   const bottom=[p,q].map(p=>({...p,z:floor(p)})),top=[p,q].map(p=>({...p,z:Math.max(floor(p),ceiling(p))}));if(top.every((p,i)=>p.z-bottom[i].z<.02))continue;
   result.push({id:`envelope-${fi}-${ei}-${i}`,sourceId:owner?.id||`envelope-${fi}-${ei}`,sourceRoofId:owner?.parentId??roofFace?.f.id,kind:'perimeter',type:owner?.type||'wall',targetId:'ground:envelope',bottom,top});
  }
 }
 // The incoming upper walls are already deduplicated. Reapplying survey
 // alignment here would move the exact foundation junctions apart again.
 return G.deduplicate(clipRoofTops([...remaining,...result],roof),.002,{preserveJunctions:true}).walls;
}
function repairInitial(base,roof,grade,walls){
 if(base?.source!=='Wall perimeter'||base.sketch?.nodes.some(p=>!p.fixed)||base.sketch?.edges.some(e=>!e.fixed))return base;
 const pl=G.plane(grade.points),loops=base.faces.map(f=>f.points);
 // Only repair the unmistakably incomplete, grade-aligned generated footprint.
 // Do not reinterpret edited elevations or a substantial existing foundation.
 const footprint=boundary(roof.faces.map(f=>f.points));
 if(loops.reduce((s,r)=>s+Math.abs(area(r)),0)>=footprint.reduce((s,r)=>s+Math.abs(area(r)),0)*.05)return base;
 if(!base.faces.every(f=>f.points.every(p=>Math.abs(p.z-pl.dx*p.x-pl.dy*p.y-pl.k)<1e-6)))return base;
 if(coversWalls(loops,groundWalls(walls,grade)))return base;
 return {...fromRoof(roof,grade,walls),visible:base.visible,centers:base.centers};
}
function fitGrade(base,grade){
 if(base.chimneyFoundationParts?.length){const C=typeof module!=='undefined'&&module.exports?require('./wall_chimneys.js'):root.WallChimneys;base={...base,faces:C.buildingBase({base})};}
 if(!grade?.faces?.length)throw Error('A grade surface is required to rebuild the foundation.');
 // Chimney extensions are regenerated from their source after the house grade is fitted.
 const footprint=boundary(base.faces.filter(f=>!f.chimneyFoundation).map(f=>f.points)),faces=[],groups=new Map();
 const clip=(poly,a,b)=>{const result=[],side=p=>cross(a,b,p);for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],dp=side(p),dq=side(q);if(dp>=-1e-9)result.push(p);if((dp>=-1e-9)!==(dq>=-1e-9)){const t=dp/(dp-dq);result.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}}return result;};
 for(const ids of grade.faces){const points=ids.map(i=>grade.points[i]);let plane=G.plane(points);if(!plane)continue;
  // A horizontal triangle can fit to +epsilon or -epsilon. Compare heights,
  // not formatted coefficient strings (which distinguish positive/negative zero).
  if(points.every(p=>p.z===points[0].z))plane={dx:0,dy:0,k:points[0].z};
  let group=[...groups.values()].find(g=>footprint.flat().every(p=>Math.abs((g.plane.dx-plane.dx)*p.x+(g.plane.dy-plane.dy)*p.y+g.plane.k-plane.k)<1e-6));
  if(!group){group={plane,pieces:[]};groups.set(groups.size,group);}const {pieces}=group;
  for(const indices of triangles(points)){let triangle=indices.map(i=>points[i]);if(area(triangle)<0)triangle.reverse();
   for(const ring of footprint)for(const indices of triangles(ring)){let poly=indices.map(i=>ring[i]);for(let i=0;i<3&&poly.length;i++)poly=clip(poly,triangle[i],triangle[(i+1)%3]);if(poly.length>=3&&Math.abs(area(poly))>1e-7)pieces.push(poly);}
  }
 }
 for(const {plane,pieces} of groups.values()){
  for(const ring of boundary(pieces))faces.push(validate({id:'base-'+(faces.length+1),points:ring.map(p=>({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}))}));
 }
 const expected=footprint.reduce((s,r)=>s+Math.abs(area(r)),0),covered=faces.reduce((s,f)=>s+Math.abs(area(f.points)),0);
 if(!faces.length||Math.abs(expected-covered)>Math.max(.001,expected*1e-5))throw Error('The grade must cover the entire foundation before rebuilding it.');
 return {visible:true,centers:base.centers!==false,source:'Rebuilt to grade',faces};
}
function split(face,path){
 const ps=copy(face.points),pl=G.plane(ps);
 const locate=p=>{
  let best=null;
  for(let i=0;i<ps.length;i++){const a=ps[i],b=ps[(i+1)%ps.length],len=dist(a,b),t=Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/(len*len))),q={x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y),z:a.z+t*(b.z-a.z)},d=dist(p,q);
   if(!best||d<best.d)best={i,t,q,d};
  }return best;
 };
 if(path.length<2)throw Error('Select at least two boundary points.');
 const start=locate(path[0]),end=locate(path[path.length-1]);
 if(start.d>.08||end.d>.08||dist(start.q,end.q)<.02)throw Error('Start and finish the split on different boundary points.');
 const ring=[];
 ps.forEach((p,i)=>{ring.push(p);for(const hit of [start,end].filter(h=>h.i===i&&h.t>1e-6&&h.t<1-1e-6).sort((a,b)=>a.t-b.t))ring.push(hit.q);});
 const a=ring.findIndex(p=>dist(p,start.q)<1e-6),b=ring.findIndex(p=>dist(p,end.q)<1e-6);
 const inner=path.slice(1,-1).map(p=>({...p,z:pl.dx*p.x+pl.dy*p.y+pl.k}));
 const line=[start.q,...inner,end.q];
 for(let i=1;i<line.length;i++)for(let t=1;t<20;t++){const p={x:line[i-1].x+(line[i].x-line[i-1].x)*t/20,y:line[i-1].y+(line[i].y-line[i-1].y)*t/20};if(!G.contains(face,p))throw Error('The split path must stay inside one base face.');}
 const walk=(from,to)=>{const arr=[];for(let i=from;;i=(i+1)%ring.length){arr.push(ring[i]);if(i===to)break;}return arr;};
 return [validate({id:face.id,points:[...walk(a,b),...inner.slice().reverse()]}),validate({id:face.id+'-split',points:[...walk(b,a),...inner]})].map(copy);
}
function transform(face,mode,value,direction={x:1,y:0},pivot=center(face)){
 const next=copy(face),plane=mode==='pitch'?G.plane(face.points):null;
 for(const p of next.points){
  if(mode==='move')p.z+=value;
  if(mode==='flat')p.z=pivot.z;
  if(mode==='pitch'){
   const along=(p.x-pivot.x)*direction.x+(p.y-pivot.y)*direction.y;
   const perpendicular=-(p.x-pivot.x)*direction.y+(p.y-pivot.y)*direction.x;
   p.z=pivot.z+value*along+(-plane.dx*direction.y+plane.dy*direction.x)*perpendicular;
  }
 }return next;
}
function cleanBoundary(points){
 const ring=points.map(p=>({...p}));let changed=true;
 while(changed&&ring.length>=3){changed=false;for(let i=0;i<ring.length;i++){const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length];if(dist(a,b)<1e-6||Math.abs(cross(a,b,c))<1e-8){ring.splice(i,1);changed=true;break;}}}
 return ring;
}
// Carry perimeter points with their driving wall, retaining each base face's plane.
function followWalls(base,before,after){
 if(!base?.faces?.length)return base;const next=copy(base),segments=[];
 for(const w of before){if(!String(w.targetId||'').startsWith('ground'))continue;const moved=after.find(v=>v.id===w.id);if(moved)segments.push({a:w.bottom[0],b:w.bottom[1],c:moved.bottom[0],d:moved.bottom[1]});}
 const move=p=>{let best=null;for(const s of segments){const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y,l2=dx*dx+dy*dy;if(l2<1e-10)continue;const t=((p.x-s.a.x)*dx+(p.y-s.a.y)*dy)/l2,dist=Math.hypot(p.x-s.a.x-t*dx,p.y-s.a.y-t*dy);if(t<-.001||t>1.001||dist>.03||Math.abs(p.z-s.a.z-t*(s.b.z-s.a.z))>.08)continue;const q={...p,x:s.c.x+t*(s.d.x-s.c.x),y:s.c.y+t*(s.d.y-s.c.y)};if(!best||dist<best.dist)best={q,dist};}return best?.q||{...p};};
 for(const f of next.faces){const original=base.faces.find(o=>o.id===f.id)||f,plane=G.plane(original.points);const expanded=[];for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;expanded.push(a);if(l2<1e-10)continue;const hits=segments.flatMap(s=>[s.a,s.b]).map(p=>({p,t:((p.x-a.x)*dx+(p.y-a.y)*dy)/l2})).filter(({p,t})=>t>1e-6&&t<1-1e-6&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<.002&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.08).sort((a,b)=>a.t-b.t);for(const h of hits)if(!expanded.some(p=>dist(p,h.p)<.001))expanded.push({...h.p});}f.points=cleanBoundary(expanded.map(p=>{const q=move(p);q.z=plane.dx*q.x+plane.dy*q.y+plane.k;return q;}));}
 next.faces=next.faces.filter(f=>f.points.length>=3&&Math.abs(area(f.points))>=.001);
 for(const f of next.faces)validate(f);
 const S=typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):root.BaseSketchGeometry,source=copy(base);source.faces=copy(next.faces);if(source.sketch)source.sketch.nodes=source.sketch.nodes.map(move);S.rebind(source,next);
 return next;
}
// Extrusion sweeps the foundation perimeter, leaving the adjacent footprint fixed.
// Remove zero-width reversals without simplifying ordinary collinear split points.
function cleanBoundarySpikes(base){
 if(!base?.faces)return base;let changed=false;const next=copy(base),tol=1e-6;
 for(const f of next.faces){const ring=f.points;let again=true;while(again&&ring.length>3){again=false;for(let i=0;i<ring.length;i++){const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length],ab=dist(a,b),bc=dist(b,c);if(ab<tol||bc<tol||(Math.abs(cross(a,b,c))/Math.max(ab,bc)<tol&&(a.x-b.x)*(c.x-b.x)+(a.y-b.y)*(c.y-b.y)>0)){ring.splice(i,1);changed=again=true;break;}}}}
 if(!changed)return base;
 if(base.sketch){const S=typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):root.BaseSketchGeometry;delete next.sketch;for(const f of next.faces)for(const p of f.points)delete p.nodeId;const graph=S.ensure(next),inside=p=>next.faces.some(f=>G.contains(f,p)),node=p=>{let n=graph.nodes.find(n=>dist(n,p)<.0001);if(!n){n={...p,id:'p'+(++graph.next),fixed:false};graph.nodes.push(n);}return n.id;};
 for(const p of base.sketch.nodes)if(inside(p))node(p);
 for(const e of base.sketch.edges.filter(e=>!e.fixed)){const a=base.sketch.nodes.find(n=>n.id===e.a),b=base.sketch.nodes.find(n=>n.id===e.b);if(!a||!b)continue;const at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),ts=G.splitParameters(a,b,next.faces);for(let i=1;i<ts.length;i++){if(!inside(at((ts[i-1]+ts[i])/2)))continue;const u=node(at(ts[i-1])),v=node(at(ts[i]));if(u!==v&&!graph.edges.some(e=>[e.a,e.b].includes(u)&&[e.a,e.b].includes(v)))graph.edges.push({id:'e'+(++graph.next),a:u,b:v,fixed:false});}}
 }return next;
}
function extrudeWall(base,source,cap){
 if(!base?.faces?.length)return base;
 const W=typeof module!=='undefined'&&module.exports?require('./wall_solid_geometry.js'):root.WallSolidGeometry;
 const delta={x:cap.points[0].x-source.points[0].x,y:cap.points[0].y-source.points[0].y};
 if(Math.hypot(delta.x,delta.y)<1e-7)return base;
 // Test contact locally instead of requiring a stitched global boundary. Tiny
 // split edges and chimney junctions must not suppress unrelated base edits.
 const insideRing=(p,ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[j],b=ring[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;};
 const insideBase=p=>base.faces.some(f=>insideRing(p,f.points)&&!(f.holes||[]).some(r=>insideRing(p,r)));
 const onPerimeter=(p,a,b)=>{const length=dist(a,b),nx=-(b.y-a.y)/length*.0001,ny=(b.x-a.x)/length*.0001;return insideBase({x:p.x+nx,y:p.y+ny})!==insideBase({x:p.x-nx,y:p.y-ny});};
 let changed=false;const next=copy(base);next.faces=base.faces.flatMap(f=>{
  const pl=G.plane(f.points),lift=p=>({...p,z:pl.dx*p.x+pl.dy*p.y+pl.k}),cuts=[],adds=[];
  // The foundation may sample the same exact arc at different parameters.
  // Sweep its existing boundary segments so no old polygonal baseline survives.
  const outline=K.surfaceOutline(source),near=p=>[outline.points,...(outline.holes||[])].some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz,t=l2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy,p.z-a.z-t*dz)<=.002;}));
  const pairs=source.curvedSurface?.logical?[f.points,...(f.holes||[])].flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]])).filter(([a,b])=>near(a)&&near(b)&&near({x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2})):source.points.map((a,i)=>[a,source.points[(i+1)%source.points.length]]);
  for(const [a,b]of pairs){if(dist(a,b)<1e-7)continue;
   for(const [lo,hi]of W.sharedIntervals(a,b,[f])){
    const at=t=>{let p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},best=null;for(let j=0;j<f.points.length;j++){const c=f.points[j],d=f.points[(j+1)%f.points.length],dx=d.x-c.x,dy=d.y-c.y,l2=dx*dx+dy*dy;if(l2<1e-14)continue;const u=Math.max(0,Math.min(1,((p.x-c.x)*dx+(p.y-c.y)*dy)/l2)),q={x:c.x+u*dx,y:c.y+u*dy},distance=dist(p,q);if(!best||distance<best.distance)best={q,distance};}return lift(best&&best.distance<.002?best.q:p);},p=at(lo),q=at(hi),m=at((lo+hi)/2);
    if(!onPerimeter(m,p,q))continue;
    const points=[p,q,lift({x:q.x+delta.x,y:q.y+delta.y}),lift({x:p.x+delta.x,y:p.y+delta.y})];if(Math.abs(area(points))<1e-7)continue;
    const len=Math.hypot(delta.x,delta.y),probe={x:m.x+delta.x/len*1e-4,y:m.y+delta.y/len*1e-4};
    let inside=false;for(let j=0,k=f.points.length-1;j<f.points.length;k=j++){const a=f.points[k],b=f.points[j];if((a.y>probe.y)!==(b.y>probe.y)&&probe.x<(b.x-a.x)*(probe.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}
    (inside?cuts:adds).push({points});
   }
  }
  if(!cuts.length&&!adds.length)return [copy(f)];changed=true;
  const regions=K.union([...K.difference(f,cuts),...adds]);
  return regions.flatMap((r,i)=>{
   // Bases use simple polygons; retain a real hole as disjoint pieces.
   const rings=r.holes.length?W.subtract(r,r.holes.map(points=>({points}))):[r.points];
   return rings.map((points,j)=>validate({...copy(f),id:i||j?f.id+'-extrusion-'+i+'-'+j:f.id,points:points.map(lift)},1e-8));
  });
 });
 if(!changed)return base;if(!next.faces.length)throw Error('The extrusion would remove the entire base.');
 K.attachBoundaryCurves(next.faces,[cap]);
 const S=typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):root.BaseSketchGeometry;S.rebind(base,next);

 return next;
}
// Vertical translation snaps to existing vertex heights and nearby base planes.
function heightSnap(face,others,amount,screen){let best=null;const moving=face.points,shift=(p,z)=>({...p,z:p.z+z});for(const target of others.filter(f=>!f.deleted&&f.id!==face.id)){const plane=G.plane(target.points);if(!plane)continue;for(const p of moving){const candidates=target.points.map(q=>({amount:q.z-p.z,guide:q}));if(G.contains(target,p))candidates.push({amount:plane.dx*p.x+plane.dy*p.y+plane.k-p.z,guide:{...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}});for(const c of candidates){const delta=Math.abs(c.amount-amount);if(delta>.3)continue;const a=screen(shift(p,amount)),b=screen(shift(p,c.amount)),pixels=Math.hypot(a.x-b.x,a.y-b.y);if(!Number.isFinite(pixels)||pixels>10)continue;let aligned=null;for(let i=0;i<moving.length;i++){const a=shift(moving[i],c.amount),b=shift(moving[(i+1)%moving.length],c.amount);if([a,b].every(q=>Math.abs(q.z-plane.dx*q.x-plane.dy*q.y-plane.k)<1e-6)){aligned=[a,b];break;}}const score=pixels-(aligned?1:0);if(!best||score<best.score-1e-7)best={amount:c.amount,score,guide:aligned||[shift(p,c.amount),c.guide],target:target.id,kind:aligned?'Edge / plane height snap':'Point height snap'};}}}return best;}
// Prefer a substantial boundary edge (or its perpendicular) over world axes.
// Short notches must not rotate the layout of the whole foundation.
function boundaryAxis(face,direction,tolerance=5*Math.PI/180){
 const len=Math.hypot(direction.x,direction.y);if(len<1e-10)return null;
 const input={x:direction.x/len,y:direction.y/len},limit=Math.cos(tolerance);let best=null;
 for(let i=0;i<face.points.length;i++){const a=face.points[i],b=face.points[(i+1)%face.points.length],length=Math.hypot(b.x-a.x,b.y-a.y);if(length<1e-5)continue;
  const along={x:(b.x-a.x)/length,y:(b.y-a.y)/length};for(const axis of [along,{x:-along.y,y:along.x}]){let dot=axis.x*input.x+axis.y*input.y;if(dot<0){axis.x=-axis.x;axis.y=-axis.y;dot=-dot;}if(dot<limit)continue;
   if(!best||length>best.length+1e-5||Math.abs(length-best.length)<=1e-5&&dot>best.dot)best={direction:axis,length,dot,edge:[a,b],angle:Math.acos(Math.min(1,dot))};
  }
 }return best;
}
const api={usesRoofEnvelope,reconcileRoofWalls,boundaryAxis,cleanBoundarySpikes,extrudeWall,heightSnap,center,triangles,terrain,fromRoof,repairInitial,fitGrade,split,transform,validate,boundary,followWalls};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BaseGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
