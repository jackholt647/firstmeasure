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
// Surveyed wall joins may differ by a few millimetres after projection.
function adjacent(f,g){return rings(f).some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],u=sub(b,a),l2=dot(u,u);if(l2<1e-8)return false;return rings(g).some(s=>s.some((c,j)=>{const d=s[(j+1)%s.length],t=dot(sub(c,a),u)/l2,v=dot(sub(d,a),u)/l2;return length(sub(c,mix(a,b,t)))<.005&&length(sub(d,mix(a,b,v)))<.005&&(Math.min(1,Math.max(t,v))-Math.max(0,Math.min(t,v)))*Math.sqrt(l2)>.002;}));}));}
function roofPlanes(roof){return (roof?.faces||[]).flatMap(f=>{const mesh=K.triangles(f.points,f.holes||[]);return mesh.triangles.map(ids=>({points:ids.map(i=>mesh.points[i])}));}).map(f=>({...f,plane:G.plane(f.points)})).filter(f=>f.plane);}
// Follow the contacted roof sheet through actual edge crossings. Sampling all
// overlapping roofs at the destination can jump from a lower return to a
// turret roof and collapse both ends of the return onto the same point.
function followRoof(p,to,supports,planes,samples=null){
 const height=(r,q)=>r.dx*q.x+r.dy*q.y+r.k,dx=to.x-p.x,dy=to.y-p.y,cuts=[0,1];
 for(const f of planes)for(let i=0;i<f.points.length;i++){
  const a=f.points[i],b=f.points[(i+1)%f.points.length],ux=b.x-a.x,uy=b.y-a.y,den=dx*uy-dy*ux;if(Math.abs(den)<1e-12)continue;
  const t=((a.x-p.x)*uy-(a.y-p.y)*ux)/den,u=((a.x-p.x)*dy-(a.y-p.y)*dx)/den;if(t>1e-7&&t<1-1e-7&&u>=-1e-7&&u<=1+1e-7)cuts.push(t);
 }
 cuts.sort((a,b)=>a-b);let plane=supports.slice().sort((a,b)=>Math.abs(height(a.plane,p)-p.z)-Math.abs(height(b.plane,p)-p.z))[0].plane;
 for(let i=1;i<cuts.length;i++){
  if(cuts[i]-cuts[i-1]<1e-7)continue;const at=mix(p,to,cuts[i-1]),mid=mix(p,to,(cuts[i]+cuts[i-1])/2),expected=height(plane,mid);
  const next=planes.filter(f=>G.contains(f,mid)&&Math.abs(height(f.plane,at)-height(plane,at))<.002).sort((a,b)=>Math.abs(height(a.plane,mid)-expected)-Math.abs(height(b.plane,mid)-expected));
  if(next.length){const other=next[0].plane;if(samples&&cuts[i-1]>1e-7&&Math.hypot(other.dx-plane.dx,other.dy-plane.dy)>1e-6)samples.push({...at,z:(height(plane,at)+height(other,at))/2});plane=other;}
 }
 return height(plane,to);
}
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
    if(f.resoffitSource!=null&&s.id!==f.resoffitSource)continue;
    if(s.kind!=='perimeter'||!s.originalA||!['eave','rake'].includes(s.type))continue;
    const p=s.originalA,q=s.originalB,sl=Math.hypot(q.x-p.x,q.y-p.y);if(sl<.02||Math.abs((q.x-p.x)*u.y-(q.y-p.y)*u.x)/sl>.01)continue;
    const ts=[p,q].map(p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y).sort((a,b)=>a-b);if(Math.min(len,ts[1])-Math.max(0,ts[0])<.01)continue;
    let n={x:-(q.y-p.y)/sl,y:(q.x-p.x)/sl,z:0};const face=roof.faces.find(f=>f.id===s.parentId),mid=mix(p,q,.5);
    if(dot(sub(s.a,p),n)<-.00001||Math.abs(dot(sub(s.a,p),n))<.00001&&face&&!G.contains(face,{x:mid.x+n.x*.02,y:mid.y+n.y*.02}))n={x:-n.x,y:-n.y,z:0};
    const inset=dot(sub(f.points[0],mid),normal)/dot(n,normal);if(inset<-.025||inset>5)continue;
    const point=mix(a,b,.5),contact=s.sourcePlane&&Math.abs(point.z-s.sourcePlane.dx*point.x-s.sourcePlane.dy*point.y-s.sourcePlane.k)<.05;
    if((contact&&Math.abs(inset-s.setback)<.03)||f.resoffitSource!=null&&f.resoffitSource===s.id)matching.push({source:s,normal:n,inset,score:Math.abs(inset-s.setback)});
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
  const normal=K.normal(faces.find(f=>f.id===c.faceId).points),alignment=dot(normal,c.normal);
  const request={n:normal,value:(target-c.inset)*alignment};const old=requests.get(c.faceId);if(old&&Math.abs(old.value-request.value)>.002)throw Error('The selected face has incompatible soffit references.');requests.set(c.faceId,request);
 }
 // Connected coplanar fragments belong to the same wall, including its openings.
 for(let changed=true;changed;){changed=false;for(const f of faces){if(f.deleted||requests.has(f.id)||f.baseId||f.chimney||f.trim)continue;const n=K.normal(f.points);if(!n)continue;for(const [id,r]of requests){const owner=faces.find(f=>f.id===id);if(!owner||Math.abs(dot(n,r.n))<.9999||f.points.some(p=>Math.abs(dot(sub(p,owner.points[0]),r.n))>.002))continue;
   if(f.resoffitSource!=null&&f.resoffitSource===owner.resoffitSource||adjacent(f,owner)){requests.set(f.id,r);changed=true;break;}
  }}
 }
 // When an inset consumes a short adjoining wall, its two junctions become
 // one. Connect the surviving planes across it before solving either corner.
 const consumed=new Set(),bridges=[];
 for(const f of faces){const n=K.normal(f.points);if(f.deleted||requests.has(f.id)||f.baseId||f.chimney||f.trim||!n||Math.abs(n.z)>.02)continue;
  for(const [id,r]of requests){const owner=faces.find(o=>o.id===id);if(!owner||Math.abs(dot(n,r.n))>.9999||!adjacent(f,owner))continue;
   const distances=f.points.map(p=>dot(sub(p,owner.points[0]),r.n)),side=distances.reduce((a,b)=>a+b,0)>=0?1:-1;
   if(Math.min(...distances)<-.002&&Math.max(...distances)>.002)continue;
   if(Math.max(...distances.map(d=>side*(d-r.value)))<-.002){consumed.add(f.id);break;}
  }
 }
 for(const f of faces.filter(f=>consumed.has(f.id))){const neighbors=faces.filter(o=>!o.deleted&&!consumed.has(o.id)&&!o.trim&&Math.abs(K.normal(o.points)?.z||0)<.02&&adjacent(f,o));bridges.push({face:f,neighbors});}
 const planes=roofPlanes(roof),graph=K.topology(faces.filter(f=>!f.deleted),faces.flatMap(f=>f.retainedPoints||[])),moves=[];
 for(const v of graph.vertices){const p=v.point,owners=faces.filter(f=>!f.deleted&&!consumed.has(f.id)&&rings(f).some(r=>r.some((a,i)=>on(p,a,r[(i+1)%r.length]))));
  for(const b of bridges)if(rings(b.face).some(r=>r.some((a,i)=>on(p,a,r[(i+1)%r.length]))))for(const f of b.neighbors)if(!owners.includes(f))owners.push(f);
  if(!owners.some(f=>requests.has(f.id)))continue;
  const constraints=[];for(const f of owners){const request=requests.get(f.id),n=K.normal(f.points);if(request)constraints.push({n:request.n,value:request.value-dot(sub(p,f.points[0]),request.n)});else if(n&&!f.trim)constraints.push({n,value:-dot(sub(p,f.points[0]),n)});}
  const supports=planes.filter(f=>G.contains(f,p)&&Math.abs(p.z-f.plane.dx*p.x-f.plane.dy*p.y-f.plane.k)<.025);
  // Solve plan junctions first, then follow the contacted roof at the new point.
  // A corner may cross a hip into another pitch during this edit.
  if(supports.length)constraints.push({n:{x:0,y:0,z:1},value:0});
  const d=solve(constraints),to={x:p.x+d.x,y:p.y+d.y,z:p.z+d.z};
  if(supports.length)to.z=followRoof(p,to,supports,planes);
  moves.push({from:p,to,junction:constraints.filter(c=>Math.abs(c.n.z)<.02).length});
 }
 // Generated boundaries can retain millimetre-wide survey seams at a junction.
 // Move the coincident end of that seam with its corner, rather than folding
 // the tiny strip over when the corner slides along the neighboring plane.
 const primary=moves.slice();
 for(const f of faces.filter(f=>!f.deleted&&!f.trim&&!f.feature))for(const ring of rings(f))for(const p of ring){
  const corners=primary.filter(m=>Math.abs(m.from.z-p.z)<.002&&length(sub(m.from,p))<.005&&ring.some(q=>same(q,m.from))).sort((a,b)=>b.junction-a.junction);
  const corner=corners[0];if(!corner)continue;const existing=moves.find(m=>same(m.from,p));
  if(existing&&corner.junction>existing.junction)existing.to={...corner.to};else if(!existing)moves.push({from:p,to:{...corner.to},junction:corner.junction});
 }
 const movedPoint=p=>{const move=moves.filter(m=>same(m.from,p)).sort((a,b)=>length(sub(a.from,p))-length(sub(b.from,p)))[0];return move?{...p,x:p.x+move.to.x-move.from.x,y:p.y+move.to.y-move.from.y,z:p.z+move.to.z-move.from.z}:p;},affected=[];
 const usedIds=new Set(faces.map(f=>f.id));
 const result=faces.flatMap(f=>{if(f.deleted)return f;if(consumed.has(f.id)){affected.push(f.id);return {...f,deleted:true};}const replace=ring=>ring.flatMap((a,i)=>{const b=ring[(i+1)%ring.length],u=sub(b,a),l2=dot(u,u),cuts=moves.filter(m=>!same(m.from,a)&&!same(m.from,b)&&on(m.from,a,b)).sort((m,n)=>dot(sub(m.from,a),u)-dot(sub(n.from,a),u));return [a,...cuts.map(m=>m.from)].map(movedPoint);}).filter((p,i,all)=>length(sub(p,all[(i+1)%all.length]))>1e-7);
  const next={...f,points:replace(f.points),holes:(f.holes||[]).map(replace),retainedPoints:(f.retainedPoints||[]).map(movedPoint)};
  if(JSON.stringify(next.points)===JSON.stringify(f.points)&&JSON.stringify(next.holes)===JSON.stringify(f.holes||[]))return f;
  const choice=choices.find(c=>c.faceId===f.id);if(choice)next.resoffitSource=choice.source.id;
  const n=K.normal(f.points),request=requests.get(f.id),offset=request?request.value*dot(request.n,n):0;
  const project=p=>{const d=dot(sub(p,f.points[0]),n)-offset;return {...p,x:p.x-n.x*d,y:p.y-n.y*d,z:p.z-n.z*d};};
  next.points=next.points.map(project);next.holes=next.holes.map(r=>r.map(project));
  const roofEdge=(a,b)=>[0,.5,1].every(t=>{const p=mix(a,b,t);return planes.some(f=>G.contains(f,p)&&Math.abs(p.z-f.plane.dx*p.x-f.plane.dy*p.y-f.plane.k)<.025);});
  // A translated edge may cross a hip. Insert the actual pitch transitions,
  // rather than drawing one chord between endpoints on different roof planes.
  const refine=ring=>ring.flatMap((a,i)=>{const b=ring[(i+1)%ring.length];if(Math.hypot(a.x-b.x,a.y-b.y)<.002)return [a];
   const original=rings(f).some(r=>r.some((p,j)=>roofEdge(p,r[(j+1)%r.length])&&on(a,project(movedPoint(p)),project(movedPoint(r[(j+1)%r.length])))&&on(b,project(movedPoint(p)),project(movedPoint(r[(j+1)%r.length])))));
   if(!original)return [a];const supports=planes.filter(r=>G.contains(r,a)&&Math.abs(a.z-r.plane.dx*a.x-r.plane.dy*a.y-r.plane.k)<.025);if(!supports.length)return [a];
   const samples=[];followRoof(a,b,supports,planes,samples);return [a,...samples.map(project)];
  });next.points=refine(next.points);next.holes=next.holes.map(refine);

  // A shortened neighbor may still have intermediate roof vertices beyond
  // its new corner. Clip those to the moved plane instead of folding the ring.
  for(const owner of faces.filter(o=>!o.deleted&&!consumed.has(o.id)&&o.id!==f.id&&!o.trim&&!o.feature)){
   const r=requests.get(owner.id)||{n:K.normal(owner.points),value:0};if(!r.n||Math.abs(dot(n,r.n))>.9999||!adjacent(f,owner))continue;
   const original=f.points.map(p=>dot(sub(p,owner.points[0]),r.n)),side=original.reduce((a,b)=>a+b,0)>=0?1:-1;
   if(Math.min(...original)<-.002&&Math.max(...original)>.002)continue;
   const clip=ring=>ring.flatMap((a,i)=>{const b=ring[(i+1)%ring.length],da=side*(dot(sub(a,owner.points[0]),r.n)-r.value),db=side*(dot(sub(b,owner.points[0]),r.n)-r.value),inside=da>=-1e-7,other=db>=-1e-7;return [...(inside?[a]:[]),...(inside!==other?[mix(a,b,da/(da-db))]:[])];}).filter((p,i,all)=>length(sub(p,all[(i+1)%all.length]))>1e-7);
   next.points=clip(next.points);next.holes=next.holes.map(clip).filter(r=>r.length>=3);
  }
  // A return legitimately disappears when its two boundaries meet (for
  // example zero overhang). Keep a tombstone so editable drafts are consumed.
  const frame=K.frame(f),region={points:next.points.map(p=>K.local(frame,p)),holes:next.holes.map(r=>r.map(p=>K.local(frame,p)))};
  // Area alone misses tall, near-zero-width returns: micrometre survey
  // drift can leave a reversed strip when zero depth meets the chimney.
  // Use the shared contact tolerance for the width of a vertical return.
  const spans=next.points.map(p=>p.x*n.y-p.y*n.x),collapsedReturn=Math.abs(n.z)<.02&&Math.max(...spans)-Math.min(...spans)<K.CONTACT;
  if(next.points.length<3||K.area(region)<1e-8||collapsedReturn){if(requests.has(f.id))throw Error("This depth leaves no wall between the adjoining boundaries.");affected.push(f.id);return {...f,deleted:true};}
  let pieces;try{const normalized=K.normalizeFace(next,!f.baseId);pieces=Array.isArray(normalized)?normalized:[normalized];for(const piece of pieces)K.validateFace(piece);}catch(e){throw Error('The requested depth cannot form a continuous wall at this junction.');}
  if(pieces.some(piece=>dot(n,K.normal(piece.points))<=0))throw Error('This depth would reverse a neighboring wall. Select the adjoining soffits together or use a smaller change.');affected.push(f.id);
  return pieces.map((piece,i)=>{if(!i)return piece;let serial=1,id;do{id=f.id+'~resoffit-'+serial++;}while(usedIds.has(id));usedIds.add(id);return {...piece,id,draft:false};});
 });
 const followed=W.followTrim(faces,{faces:result,moves,affected},[...requests.keys()],options.keepTrimStatic);
 const selectedSources=new Set(choices.map(c=>c.source.id)),selectedPairs=candidates(followed.faces.filter(f=>requests.has(f.id)||selectedSources.has(f.resoffitSource)),roof,sources).map(c=>c.pair);
 return {...followed,trimFollowed:true,affected:[...new Set([...affected,...(followed.affected||[])])],pairs:selectedPairs,limited};
}
const api={candidates,apply,COLOR:'#ef633c'};if(node)module.exports=api;else root.WallResoffit=api;
})(typeof window==='undefined'?globalThis:window);
