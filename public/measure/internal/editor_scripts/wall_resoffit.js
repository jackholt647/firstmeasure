/* Local soffit edits: translate selected wall planes and intersect their neighbors. */
(function(root){
'use strict';
const node=typeof module==='object'&&module.exports;
const K=node?require('./exterior_geometry.js'):root.ExteriorGeometry;
const G=node?require('./wall_geometry.js'):root.WallGeometry;
const W=node?require('./wall_solid_geometry.js'):root.WallSolidGeometry;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const length=v=>Math.hypot(v.x,v.y,v.z),mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const rings=f=>[f.points,...(f.holes||[])],same=(a,b)=>length(sub(a,b))<.002;
const on=(p,a,b)=>{const d=sub(b,a),l=dot(d,d),t=l?dot(sub(p,a),d)/l:0;return t>=-1e-5&&t<=1+1e-5&&same(p,mix(a,b,t));};
function roofPlanes(roof){return (roof?.faces||[]).flatMap(f=>{const mesh=K.triangles(f.points,f.holes||[]);return mesh.triangles.map(ids=>({points:ids.map(i=>mesh.points[i])}));}).map(f=>({...f,plane:G.plane(f.points)})).filter(f=>f.plane);}
function candidates(faces,roof,sources){
 const planes=roofPlanes(roof),result=[];
 for(const [index,f]of faces.entries()){
  const normal=K.normal(f.points);if(f.deleted||f.chimney||f.trim||f.feature||!normal||Math.abs(normal.z)>.02)continue;
  for(let i=0;i<f.points.length;i++){
   const a=f.points[i],b=f.points[(i+1)%f.points.length],len=Math.hypot(b.x-a.x,b.y-a.y);if(len<.02)continue;
   const u={x:(b.x-a.x)/len,y:(b.y-a.y)/len};
   const center=f.points.reduce((p,q)=>({x:p.x+q.x/f.points.length,y:p.y+q.y/f.points.length,z:p.z+q.z/f.points.length}),{x:0,y:0,z:0});
   if(center.z>=a.z+((center.x-a.x)*u.x+(center.y-a.y)*u.y)*(b.z-a.z)/len-1e-6)continue;
   if(![0,.5,1].every(t=>{const p=mix(a,b,t);return planes.some(r=>G.contains(r,p)&&Math.abs(p.z-r.plane.dx*p.x-r.plane.dy*p.y-r.plane.k)<.025);}))continue;
   const matching=[];
   for(const s of sources||[]){
    if(s.kind!=='perimeter'||!s.originalA||!['eave','rake'].includes(s.type))continue;
    const p=s.originalA,q=s.originalB,sl=Math.hypot(q.x-p.x,q.y-p.y);if(sl<.02||Math.abs((q.x-p.x)*u.y-(q.y-p.y)*u.x)/sl>.01)continue;
    const ts=[p,q].map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y).sort((a,b)=>a-b);if(Math.min(len,ts[1])-Math.max(0,ts[0])<.01)continue;
    let n={x:-(q.y-p.y)/sl,y:(q.x-p.x)/sl,z:0};const face=roof.faces.find(f=>f.id===s.parentId),mid=mix(p,q,.5);
    if(dot(sub(s.a,p),n)<-.00001||Math.abs(dot(sub(s.a,p),n))<.00001&&face&&!G.contains(face,{x:mid.x+n.x*.02,y:mid.y+n.y*.02}))n={x:-n.x,y:-n.y,z:0};
    const inset=dot(sub(mix(a,b,.5),p),n);if(inset<-.025||inset>5)continue;
    const point=mix(a,b,.5),contact=s.sourcePlane&&Math.abs(point.z-s.sourcePlane.dx*point.x-s.sourcePlane.dy*point.y-s.sourcePlane.k)<.05;
    if(contact&&(Math.abs(inset-s.setback)<.03||f.resoffitSource!=null&&f.resoffitSource===s.id))matching.push({source:s,normal:n,inset,score:Math.abs(inset-s.setback)});
   }
   matching.sort((a,b)=>a.score-b.score);if(!matching.length)continue;
   result.push({id:W.edgeKey(a,b),faceId:f.id??index,pair:[a,b],...matching[0]});
  }
 }return result;
}
function solve(constraints){
 const basis=[];
 for(const c of constraints){let v={...c.n},value=c.value;for(const b of basis){const t=dot(v,b.v);v={x:v.x-t*b.v.x,y:v.y-t*b.v.y,z:v.z-t*b.v.z};value-=t*b.value;}const l=length(v);if(l<.0005){if(Math.abs(value)>.002)throw Error('These soffits cannot meet while preserving their connected planes.');continue;}basis.push({v:{x:v.x/l,y:v.y/l,z:v.z/l},value:value/l});}
 return basis.reduce((p,b)=>({x:p.x+b.v.x*b.value,y:p.y+b.v.y*b.value,z:p.z+b.v.z*b.value}),{x:0,y:0,z:0});
}
function apply(faces,pairs,depth,roof,sources,options={}){
 if(!Number.isFinite(depth)||depth<0||depth>5)throw Error('Enter a soffit depth from 0 to 16 feet.');
 const choices=candidates(faces,roof,sources).filter(c=>pairs.some(pair=>W.sharedIntervals(...pair,[{points:c.pair}]).some(([a,b])=>b-a>.001)));
 if(!choices.length)throw Error('Select roof-contact soffit lines first.');
 const requests=new Map();let limited=false;
 for(const c of choices){const minimum=c.source.clearanceRoofIds?.length?c.source.contactSetback||0:0,target=Math.max(depth,minimum);limited ||= target>depth+.002;
  const request={n:c.normal,value:target-c.inset};const old=requests.get(c.faceId);if(old&&Math.abs(old.value-request.value)>.002)throw Error('The selected face has incompatible soffit references.');requests.set(c.faceId,request);
 }
 // Connected coplanar fragments belong to the same wall, including its openings.
 for(let changed=true;changed;){changed=false;for(const f of faces){if(f.deleted||requests.has(f.id)||f.baseId||f.chimney||f.trim)continue;const n=K.normal(f.points);if(!n)continue;for(const [id,r]of requests){const owner=faces.find(f=>f.id===id);if(!owner||Math.abs(dot(n,r.n))<.9999||f.points.some(p=>Math.abs(dot(sub(p,owner.points[0]),r.n))>.002))continue;
   if(rings(f).some(ring=>ring.some((p,i)=>W.sharedIntervals(p,ring[(i+1)%ring.length],[owner]).length))){requests.set(f.id,r);changed=true;break;}
  }}
 }
 const planes=roofPlanes(roof),graph=K.topology(faces.filter(f=>!f.deleted),faces.flatMap(f=>f.retainedPoints||[])),moves=[];
 for(const v of graph.vertices){const p=v.point,owners=faces.filter(f=>!f.deleted&&rings(f).some(r=>r.some((a,i)=>on(p,a,r[(i+1)%r.length]))));if(!owners.some(f=>requests.has(f.id)))continue;
  const constraints=[];for(const f of owners){const request=requests.get(f.id),n=K.normal(f.points);if(request)constraints.push({n:request.n,value:request.value});else if(n&&!f.trim)constraints.push({n,value:0});}
  const supports=planes.filter(f=>G.contains(f,p)&&Math.abs(p.z-f.plane.dx*p.x-f.plane.dy*p.y-f.plane.k)<.025);
  // Solve plan junctions first, then sample the finite roof at the new point.
  // A corner may cross a hip into another pitch during this edit.
  if(supports.length)constraints.push({n:{x:0,y:0,z:1},value:0});
  const d=solve(constraints),to={x:p.x+d.x,y:p.y+d.y,z:p.z+d.z};
  if(supports.length){const reference=supports[0].plane,expected=p.z+reference.dx*d.x+reference.dy*d.y,heights=planes.filter(f=>G.contains(f,to)).map(f=>f.plane.dx*to.x+f.plane.dy*to.y+f.plane.k).sort((a,b)=>Math.abs(a-expected)-Math.abs(b-expected));if(!heights.length)throw Error('This soffit depth moves a wall outside its roof.');to.z=heights[0];}
  moves.push({from:p,to});
 }
 // Generated boundaries can retain millimetre-wide survey seams at a junction.
 // Move the coincident end of that seam with its corner, rather than folding
 // the tiny strip over when the corner slides along the neighboring plane.
 const primary=moves.slice();
 for(const f of faces.filter(f=>!f.deleted&&!f.trim&&!f.feature))for(const ring of rings(f))for(const p of ring){
  if(moves.some(m=>same(m.from,p)))continue;
  const corner=primary.find(m=>Math.abs(m.from.z-p.z)<.002&&length(sub(m.from,p))<.005&&ring.some(q=>same(q,m.from)));
  if(corner)moves.push({from:p,to:corner.to});
 }
 const movedPoint=p=>{const move=moves.filter(m=>same(m.from,p)).sort((a,b)=>length(sub(a.from,p))-length(sub(b.from,p)))[0];return move?{...p,x:p.x+move.to.x-move.from.x,y:p.y+move.to.y-move.from.y,z:p.z+move.to.z-move.from.z}:p;},affected=[];
 const result=faces.map(f=>{if(f.deleted)return f;const replace=ring=>ring.flatMap((a,i)=>{const b=ring[(i+1)%ring.length],u=sub(b,a),l2=dot(u,u),cuts=moves.filter(m=>!same(m.from,a)&&!same(m.from,b)&&on(m.from,a,b)).sort((m,n)=>dot(sub(m.from,a),u)-dot(sub(n.from,a),u));return [a,...cuts.map(m=>m.from)].map(movedPoint);}).filter((p,i,all)=>length(sub(p,all[(i+1)%all.length]))>1e-7);
  const next={...f,points:replace(f.points),holes:(f.holes||[]).map(replace),retainedPoints:(f.retainedPoints||[]).map(movedPoint)};
  if(JSON.stringify(next.points)===JSON.stringify(f.points)&&JSON.stringify(next.holes)===JSON.stringify(f.holes||[]))return f;
  const choice=choices.find(c=>c.faceId===f.id);if(choice)next.resoffitSource=choice.source.id;
  const n=K.normal(f.points),request=requests.get(f.id),offset=request?request.value*dot(request.n,n):0;
  const project=p=>{const d=dot(sub(p,f.points[0]),n)-offset;return {...p,x:p.x-n.x*d,y:p.y-n.y*d,z:p.z-n.z*d};};
  next.points=next.points.map(project);next.holes=next.holes.map(r=>r.map(project));
  // A shortened neighbor may still have intermediate roof vertices beyond
  // its new corner. Clip those to the moved plane instead of folding the ring.
  if(!requests.has(f.id))for(const [id,r]of requests){
   const owner=faces.find(o=>o.id===id);if(!owner||Math.abs(dot(n,r.n))>.9999||!rings(f).some(ring=>ring.some((p,i)=>W.sharedIntervals(p,ring[(i+1)%ring.length],[owner]).length)))continue;
   const original=f.points.map(p=>dot(sub(p,owner.points[0]),r.n)),side=original.reduce((a,b)=>a+b,0)>=0?1:-1;
   if(Math.min(...original)<-.002&&Math.max(...original)>.002)continue;
   const clip=ring=>ring.flatMap((a,i)=>{const b=ring[(i+1)%ring.length],da=side*(dot(sub(a,owner.points[0]),r.n)-r.value),db=side*(dot(sub(b,owner.points[0]),r.n)-r.value),inside=da>=-1e-7,other=db>=-1e-7;return [...(inside?[a]:[]),...(inside!==other?[mix(a,b,da/(da-db))]:[])];}).filter((p,i,all)=>length(sub(p,all[(i+1)%all.length]))>1e-7);
   next.points=clip(next.points);next.holes=next.holes.map(clip).filter(r=>r.length>=3);
  }
  try{K.validateFace(next);}catch(e){throw Error('This depth would collapse or overlap a connected face. Select the adjoining soffits together or use a smaller change.');}if(dot(K.normal(f.points),K.normal(next.points))<=0)throw Error('This depth would reverse a neighboring wall. Select the adjoining soffits together or use a smaller change.');affected.push(f.id);return next;
 });
 const followed=W.followTrim(faces,{faces:result,moves,affected},[...requests.keys()],options.keepTrimStatic);
 return {...followed,trimFollowed:true,affected:[...new Set([...affected,...(followed.affected||[])])],pairs:choices.map(c=>c.pair.map(movedPoint)),limited};
}
const api={candidates,apply,COLOR:'#ef633c'};if(node)module.exports=api;else root.WallResoffit=api;
})(typeof window==='undefined'?globalThis:window);
