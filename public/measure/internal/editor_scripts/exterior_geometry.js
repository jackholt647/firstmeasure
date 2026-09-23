/* Shared exterior geometry kernel. Metres in, metres out. No editor state. */
(function(root){
'use strict';
const C=typeof module==='object'&&module.exports?require('./vendor/clipper-lib-6.4.2-clipper.js'):root.ClipperLib;
const ear=typeof module==='object'&&module.exports?require('./vendor/earcut-3.2.3-earcut.dev.js'):root.earcut;
const GRID=1e-6,SCALE=1/GRID,CONTACT=1e-5;
const finite=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y),finite3=p=>finite(p)&&Number.isFinite(p.z);
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
function signedArea(r){if(r.length<3)return 0;const o=r[0];let sum=0;for(let i=1;i<r.length-1;i++)sum+=(r[i].x-o.x)*(r[i+1].y-o.y)-(r[i].y-o.y)*(r[i+1].x-o.x);return sum/2;}
const area=f=>Math.abs(signedArea(f.points))-(f.holes||[]).reduce((s,r)=>s+Math.abs(signedArea(r)),0);
function paths(faces){const out=[];for(const f of faces){for(const [index,ring]of [f.points,...(f.holes||[])].entries()){
 if(!ring?.length)continue;if(!ring.every(finite))throw Error('Geometry contains a non-finite coordinate.');
 const path=[];for(const p of ring){const q={X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)};if(Math.max(Math.abs(q.X),Math.abs(q.Y))>1e12)throw Error('Geometry exceeds the supported local coordinate range.');if(!path.length||q.X!==path.at(-1).X||q.Y!==path.at(-1).Y)path.push(q);}
 if(path.length>1&&path[0].X===path.at(-1).X&&path[0].Y===path.at(-1).Y)path.pop();
 if(path.length<3)continue;if(C.Clipper.Orientation(path)!==(index===0))path.reverse();out.push(path);
 }}return out;}
function simplify(ring){
 let r=ring.slice(),changed=true;while(changed&&r.length>3){changed=false;for(let i=0;i<r.length;i++){const a=r[(i+r.length-1)%r.length],p=r[i],b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?((p.x-a.x)*dx+(p.y-a.y)*dy)/l2:0;if((l2===0||t>=0&&t<=1)&&Math.hypot(p.x-a.x-dx*t,p.y-a.y-dy*t)<=GRID){r.splice(i,1);changed=true;break;}}}return r;
}
// Node shared boundaries before quantization. A point on a sloping edge must
// become the same endpoint in both paths, not two independently rounded lines.
function nodeRegions(regions){
 const nodes=[],node=p=>{let i=nodes.findIndex(q=>Math.hypot(q.x-p.x,q.y-p.y)<=CONTACT);if(i<0){i=nodes.length;nodes.push({x:p.x,y:p.y,z:0});}return i;};
 const rings=regions.map(f=>[f.points,...(f.holes||[])].map(r=>r.map(node)));
 const expand=ring=>ring.flatMap((i,k)=>{const a=nodes[i],b=nodes[ring[(k+1)%ring.length]],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<CONTACT*CONTACT)return [];const cuts=nodes.map((p,j)=>({p,j,t:((p.x-a.x)*dx+(p.y-a.y)*dy)/l2})).filter(v=>v.t>CONTACT/Math.sqrt(l2)&&v.t<1-CONTACT/Math.sqrt(l2)&&Math.hypot(v.p.x-a.x-dx*v.t,v.p.y-a.y-dy*v.t)<=CONTACT).sort((a,b)=>a.t-b.t);return [a,...cuts.map(v=>v.p)];});
 return rings.map(rs=>({points:expand(rs[0]),holes:rs.slice(1).map(expand)}));
}
function boolean(operation,subjects,clips=[]){
 const noded=nodeRegions([...subjects,...clips]),input=paths(noded.slice(0,subjects.length)),cut=paths(noded.slice(subjects.length));if(!input.length)return [];
 // Clipper's StrictlySimple join splits coincident sloping edges at scanline
 // rounding points. Use the normal union and split only actual repeated vertices.
 const engine=new C.Clipper(),tree=new C.PolyTree();
 engine.AddPaths(input,C.PolyType.ptSubject,true);if(cut.length)engine.AddPaths(cut,C.PolyType.ptClip,true);
 if(!engine.Execute(C.ClipType[operation],tree,C.PolyFillType.pftNonZero,C.PolyFillType.pftNonZero))throw Error('Polygon operation could not complete.');
 const ring=p=>simplify(p.map(q=>({x:q.X/SCALE,y:q.Y/SCALE,z:0})));
 const split=r=>{const seen=new Map();for(let i=0;i<r.length;i++){const key=r[i].X+':'+r[i].Y;if(seen.has(key)){const j=seen.get(key);return [...split(r.slice(j,i)),...split([...r.slice(0,j),...r.slice(i)])];}seen.set(key,i);}return r.length>=3?[r]:[];};
 const regions=C.JS.PolyTreeToExPolygons(tree).flatMap(p=>split(p.outer).map(outer=>({points:ring(outer),holes:p.holes.flatMap(split).filter(h=>C.Clipper.PointInPolygon(h[0],outer)!==0).map(ring)}))).filter(f=>area(f)>GRID*GRID);
 // Order by position/area, never the traversal order of a clipping algorithm.
 const key=r=>r.points.reduce((a,p)=>p.x<a.x||(p.x===a.x&&p.y<a.y)?p:a,r.points[0]);
 regions.sort((a,b)=>key(a).x-key(b).x||key(a).y-key(b).y||area(b)-area(a));return regions;
}
const union=faces=>boolean('ctUnion',faces),difference=(face,cuts)=>boolean('ctDifference',[face],cuts),intersection=(a,b)=>boolean('ctIntersection',a,b);
function triangles(points,holes=[]){
 if(!points?.every(finite)||holes.some(r=>!r.every(finite)))throw Error('Geometry contains a non-finite coordinate.');
 const flat=[points,...holes].flat(),data=flat.flatMap(p=>[p.x,p.y]),starts=[];let count=points.length;for(const h of holes){starts.push(count);count+=h.length;}
 const ids=ear.default(data,starts,2),out=[];let total=0;
 // Sub-grid slivers from almost-collinear anchors cannot define a sweep plane.
 // Keep the original points/indices, but omit these numerical triangles.
 for(let i=0;i<ids.length;i+=3){const t=ids.slice(i,i+3),a=Math.abs(signedArea(t.map(j=>flat[j])));if(a>GRID*GRID){out.push(t);total+=a;}}
 const expected=area({points,holes}),allowance=Math.max(1e-8,Math.abs(expected)*1e-8);
 if(expected<=1e-12||!out.length||Math.abs(total-expected)>allowance)throw Error('The face does not define a valid planar region.');
 return {points:flat,triangles:out};
}
function pieces(regions){return regions.flatMap(f=>f.holes.length?triangles(f.points,f.holes).triangles.map(t=>t.map(i=>[f.points,...f.holes].flat()[i])):[f.points]);}
function normal(points){
 if(!points?.every(finite3))return null;let best=null,bestLength=0,total={x:0,y:0,z:0};const origin=points[0];
 for(let i=1;i<points.length-1;i++){const n=cross(sub(points[i],origin),sub(points[i+1],origin)),length=Math.hypot(n.x,n.y,n.z);total.x+=n.x;total.y+=n.y;total.z+=n.z;if(length>bestLength){best=n;bestLength=length;}}
 if(best&&dot(best,total)<0)best={x:-best.x,y:-best.y,z:-best.z};
 return bestLength>1e-12?{x:best.x/bestLength,y:best.y/bestLength,z:best.z/bestLength}:null;
}
function frame(face){const n=normal(face.points);if(!n)return null;const origin={...face.points[0]};let edge=face.points.map((p,i)=>sub(face.points[(i+1)%face.points.length],p)).sort((a,b)=>dot(b,b)-dot(a,a))[0],length=Math.hypot(edge.x,edge.y,edge.z);const u={x:edge.x/length,y:edge.y/length,z:edge.z/length};return {origin,u,v:cross(n,u),n};}
const local=(f,p)=>{const q=sub(p,f.origin);return {x:dot(q,f.u),y:dot(q,f.v),z:dot(q,f.n)};};
const world=(f,p)=>({x:f.origin.x+f.u.x*p.x+f.v.x*p.y+f.n.x*(p.z||0),y:f.origin.y+f.u.y*p.x+f.v.y*p.y+f.n.y*(p.z||0),z:f.origin.z+f.u.z*p.x+f.v.z*p.y+f.n.z*(p.z||0)});
function validateFace(face){if(face.curvedSurface?.logical){const mesh=surfaceMesh(face);if(!mesh.triangles.length||mesh.positions.some(p=>!finite3(p)))throw Error('The curved surface has an invalid domain.');return face;}const f=frame(face);if(!f)throw Error('A face needs three non-collinear finite points.');const rings=[face.points,...(face.holes||[])];if(rings.flat().some(p=>!finite3(p)||Math.abs(local(f,p).z)>CONTACT))throw Error('A face must remain on its supporting plane.');triangles(face.points.map(p=>local(f,p)),(face.holes||[]).map(r=>r.map(p=>local(f,p))));return face;}
const pointKey=p=>[p.x,p.y,p.z||0].map(n=>Math.round(n/CONTACT)).join(':');
// Rebuild filled boundaries after a merge, including retraced/overlapping runs.
// Different faces may legitimately share edges; their ownership stays separate.
function normalizeFace(face,split=false){
 if(face.curvedSurface||face.curves?.length)return face;
 if([face.points,...(face.holes||[])].flat().some(p=>!finite3(p)))throw Error('Geometry contains a non-finite coordinate.');
 const f=frame(face);if(!f)throw Error('The face collapsed to zero area.');
 const source=[face.points,...(face.holes||[])];
 if(source.flat().some(p=>!finite3(p)||Math.abs(local(f,p).z)>CONTACT))throw Error('A face must remain on its supporting plane.');
 const planar=source.map(r=>r.map(p=>local(f,p)));
 // Leave already simple loops byte-for-byte intact (including precise curve
 // tessellation, point order and thin valid faces). Rebuild only contacts.
 const segments=planar.flatMap((r,k)=>r.map((a,i)=>({a,b:r[(i+1)%r.length],ring:k,index:i,count:r.length})));
 const dirty=segments.some((s,i)=>{
  const u={x:s.b.x-s.a.x,y:s.b.y-s.a.y},l2=u.x*u.x+u.y*u.y;if(l2<GRID*GRID)return true;
  return segments.slice(i+1).some(t=>{
   const v={x:t.b.x-t.a.x,y:t.b.y-t.a.y},d={x:t.a.x-s.a.x,y:t.a.y-s.a.y},cross=u.x*v.y-u.y*v.x;
   if(Math.abs(cross)<GRID*Math.sqrt(l2)){
    if(Math.abs(d.x*u.y-d.y*u.x)>GRID*Math.sqrt(l2))return false;
    const lo=(d.x*u.x+d.y*u.y)/l2,hi=lo+(v.x*u.x+v.y*u.y)/l2;
    return (Math.min(1,Math.max(lo,hi))-Math.max(0,Math.min(lo,hi)))*Math.sqrt(l2)>GRID;
   }
   if(s.ring===t.ring&&(Math.abs(s.index-t.index)===1||Math.abs(s.index-t.index)===s.count-1))return false;
   const a=(d.x*v.y-d.y*v.x)/cross,b=(d.x*u.y-d.y*u.x)/cross;
   return a>=0&&a<=1&&b>=0&&b<=1;
  });
 });
 if(!dirty)return face;
 const regions=union([{points:planar[0],holes:planar.slice(1)}]);
 // A single-face edit cannot silently discard disconnected components.
 if(regions.length>1&&split)return regions.map((r,i)=>({...face,id:i?face.id+'~region-'+i:face.id,points:r.points.map(p=>world(f,p)),holes:r.holes.map(h=>h.map(p=>world(f,p))),retainedPoints:[...(face.retainedPoints||[]),...source.flat()]}));
 if(regions.length!==1)throw Error('The edit would collapse or disconnect a face.');
 const anchors=source.flat(),region=regions[0],restore=ring=>{
  let result=ring.map(p=>{const q=world(f,p),original=anchors.find(a=>distance(a,q)<=GRID*2);return original?{...original}:{...q};});
  // Preserve collinear boundary anchors and node IDs. Discarded spikes remain
  // drawing anchors, not edges or corners of the filled face.
  result=result.flatMap((a,i)=>{const b=result[(i+1)%result.length],v=sub(b,a),l2=dot(v,v);const cuts=anchors.map(p=>({p,t:dot(sub(p,a),v)/l2})).filter(({p,t})=>t>GRID&&t<1-GRID&&distance(p,{x:a.x+v.x*t,y:a.y+v.y*t,z:a.z+v.z*t})<=GRID*2).sort((a,b)=>a.t-b.t);return [a,...cuts.filter((c,j)=>!j||distance(c.p,cuts[j-1].p)>GRID).map(c=>({...c.p}))];});
  return result;
 };
 let points=restore(region.points),holes=region.holes.map(restore);
 if(dot(normal(points),f.n)<0){points.reverse();holes.forEach(r=>r.reverse());}
 const ordered=(ring,original)=>{const first=original.find(p=>ring.some(q=>distance(p,q)<=GRID));if(!first)return ring;const index=ring.findIndex(p=>distance(p,first)<=GRID);return [...ring.slice(index),...ring.slice(0,index)];};
 points=ordered(points,face.points);holes=holes.map(r=>ordered(r,(face.holes||[]).find(old=>old.some(p=>r.some(q=>distance(p,q)<=GRID)))||[]));
 const retainedPoints=[...new Map([...(face.retainedPoints||[]),...anchors.filter(p=>![points,...holes].flat().some(q=>distance(p,q)<=GRID))].map(p=>[pointKey(p),p])).values()];
 const next={...face,points,holes,...(retainedPoints.length||face.retainedPoints?{retainedPoints}:{})};
 validateFace(next);return next;
}
const normalizeFaces=face=>[normalizeFace(face,true)].flat();
// Compare filled shapes, including holes, rather than scalar area alone.
function pointRemovalChangesRegion(face,keys){
 const clean=normalizeFace(face),selected=new Set(keys),f=frame(clean);
 const shape={points:clean.points.map(p=>local(f,p)),holes:(clean.holes||[]).map(r=>r.map(p=>local(f,p)))};
 const remaining={points:clean.points.filter(p=>!selected.has(pointKey(p))).map(p=>local(f,p)),holes:(clean.holes||[]).map(r=>r.filter(p=>!selected.has(pointKey(p))).map(p=>local(f,p)))};
 if(remaining.points.length<3)return true;
 const candidate=union([remaining]);if(candidate.length!==1)return true;
 const changed=[...difference(shape,candidate),...difference(candidate[0],[shape])].reduce((sum,r)=>sum+area(r),0);
 return changed>GRID*GRID*4;
}
const edgeKey=(a,b)=>[pointKey(a),pointKey(b)].sort().join('|');
// Explicit incidence graph. Neighbor-cell searches avoid grid-boundary misses.
// Drawing anchors are kept separately and never removed by polygon booleans.
function topology(faces,anchors=[]){
 const vertices=[],edges=new Map(),cells=new Map(),faceMap=new Map();
 const cell=p=>[p.x,p.y,p.z].map(v=>Math.floor(v/CONTACT)),index=p=>{if(!finite3(p))throw Error('Topology contains a non-finite point.');const c=cell(p);for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const i of cells.get([c[0]+x,c[1]+y,c[2]+z].join(':'))||[])if(distance(vertices[i].point,p)<=CONTACT)return i;const i=vertices.length;vertices.push({id:i,point:{...p},faces:new Set(),edges:new Set(),anchors:[]});const k=c.join(':');if(!cells.has(k))cells.set(k,[]);cells.get(k).push(i);return i;};
 for(const face of faces){const id=face.id;if(faceMap.has(id))throw Error('Duplicate face identity: '+id);faceMap.set(id,{face,rings:[face.points,...(face.holes||[])].map(r=>r.map(index))});}
 for(const anchor of anchors)vertices[index(anchor)].anchors.push(anchor);
 for(const [id,entry]of faceMap)for(const ring of entry.rings)for(let i=0;i<ring.length;i++){
  const a=ring[i],b=ring[(i+1)%ring.length],p=vertices[a].point,q=vertices[b].point,v=sub(q,p),l2=dot(v,v);if(l2<CONTACT*CONTACT)continue;
  const chain=vertices.map((n,j)=>{const d=sub(n.point,p),t=dot(d,v)/l2;return {j,t,d:Math.hypot(d.x-v.x*t,d.y-v.y*t,d.z-v.z*t)};}).filter(n=>n.t>=-1e-8&&n.t<=1+1e-8&&n.d<=CONTACT).sort((a,b)=>a.t-b.t);
  for(let j=1;j<chain.length;j++){const u=chain[j-1].j,w=chain[j].j;if(u===w)continue;const key=[u,w].sort((a,b)=>a-b).join(':');if(!edges.has(key))edges.set(key,{id:key,a:u,b:w,faces:new Set()});edges.get(key).faces.add(id);for(const v of [u,w]){vertices[v].faces.add(id);vertices[v].edges.add(key);}}
 }
 return {vertices,edges,faces:faceMap,vertexAt:p=>{const c=cell(p);for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const i of cells.get([c[0]+x,c[1]+y,c[2]+z].join(':'))||[])if(distance(vertices[i].point,p)<=CONTACT)return vertices[i];return null;}};
}
// Planar half-edge arrangement used by both wall and base drafting. Geometry
// IDs and free drawing anchors survive; only the derived face loops are rebuilt.
function partition(sketch){
 const nodes=[],byId=new Map(),node=p=>{let i=nodes.findIndex(n=>Math.hypot(n.x-p.x,n.y-p.y)<=CONTACT);if(i<0){i=nodes.length;nodes.push({...p,id:p.id||'intersection:'+Math.round(p.x/GRID)+':'+Math.round(p.y/GRID)+':'+Math.round((p.z||0)/GRID)});}if(p.id)byId.set(p.id,i);return i;};
 for(const p of sketch.nodes)node(p);
 const segments=sketch.edges.map(e=>({e,a:byId.get(e.a),b:byId.get(e.b),cuts:[0,1]})).filter(e=>e.a!==undefined&&e.b!==undefined&&e.a!==e.b);
 const at=(s,t)=>{const a=nodes[s.a],b=nodes[s.b];return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:(a.z||0)+((b.z||0)-(a.z||0))*t};};
 for(let i=0;i<segments.length;i++){const a=segments[i],p=nodes[a.a],q=nodes[a.b],ux=q.x-p.x,uy=q.y-p.y,len=Math.hypot(ux,uy);if(len<=CONTACT)continue;
  for(const n of nodes){const t=((n.x-p.x)*ux+(n.y-p.y)*uy)/(len*len);if(t>0&&t<1&&Math.abs((n.x-p.x)*uy-(n.y-p.y)*ux)/len<=CONTACT)a.cuts.push(t);}
  for(let j=i+1;j<segments.length;j++){const b=segments[j],r=nodes[b.a],s=nodes[b.b],vx=s.x-r.x,vy=s.y-r.y,den=ux*vy-uy*vx;if(Math.abs(den)<=1e-12*Math.max(1,len*Math.hypot(vx,vy)))continue;const dx=r.x-p.x,dy=r.y-p.y,t=(dx*vy-dy*vx)/den,u=(dx*uy-dy*ux)/den;if(t>=0&&t<=1&&u>=0&&u<=1){a.cuts.push(t);b.cuts.push(u);}}
 }
 const edges=new Map();for(const s of segments){const chain=s.cuts.sort((a,b)=>a-b).map(t=>node(at(s,t))).filter((n,i,a)=>i===0||n!==a[i-1]);for(let i=1;i<chain.length;i++){const a=chain[i-1],b=chain[i];if(a===b)continue;const key=[a,b].sort((a,b)=>a-b).join(':');if(!edges.has(key))edges.set(key,{a,b,source:s.e});}}
 const adjacency=nodes.map(()=>new Set());for(const e of edges.values()){adjacency[e.a].add(e.b);adjacency[e.b].add(e.a);}
 const ordered=adjacency.map((neighbors,i)=>[...neighbors].sort((a,b)=>Math.atan2(nodes[a].y-nodes[i].y,nodes[a].x-nodes[i].x)-Math.atan2(nodes[b].y-nodes[i].y,nodes[b].x-nodes[i].x))),visited=new Set(),regions=[];
 for(const edge of edges.values())for(const [start,next]of [[edge.a,edge.b],[edge.b,edge.a]]){if(visited.has(start+':'+next))continue;let a=start,b=next;const ring=[];let closed=false;
  for(let steps=0;steps<=edges.size*2;steps++){const key=a+':'+b;if(visited.has(key)){closed=a===start&&b===next;break;}visited.add(key);ring.push(a);const list=ordered[b],c=list[(list.indexOf(a)+list.length-1)%list.length];a=b;b=c;}
  if(!closed)continue;let changed=true;while(changed&&ring.length>2){changed=false;for(let i=0;i<ring.length;i++)if(ring[(i+ring.length-1)%ring.length]===ring[(i+1)%ring.length]){ring.splice(i,1);ring.splice(i%ring.length,1);changed=true;break;}}
  const points=ring.map(i=>nodes[i]);if(points.length>=3&&signedArea(points)>GRID*GRID)regions.push(points);
 }
 return {nodes,regions,edges:[...edges.values()].map((e,i)=>({...e.source,id:e.source.id+':'+i,a:nodes[e.a].id,b:nodes[e.b].id}))};
}
// Exact conic definitions are persisted; sampling is only an evaluation cache.
const curvePoint=(c,t)=>{
 if(c.type==='spline'){t=Math.max(0,Math.min(1,t));let i=c.knots.findIndex((v,i)=>i&&v>=t)-1;if(i<0)i=c.segments.length-1;const q=c.segments[i],u=(t-c.knots[i])/(c.knots[i+1]-c.knots[i]),v=1-u;return Object.fromEntries(['x','y','z'].map(k=>[k,v*v*v*q[0][k]+3*v*v*u*q[1][k]+3*v*u*u*q[2][k]+u*u*u*q[3][k]]));}

 if(c.type==='surface-boundary'){const path=c.path||[c.from,c.to],at=Math.min(path.length-1,Math.max(0,t)*(path.length-1)),i=Math.min(path.length-2,Math.floor(at)),a=path[i],b=path[i+1],v=at-i;return surfacePoint(c.surface,a.x+(b.x-a.x)*v,a.y+(b.y-a.y)*v);}
 if(c.type==='conic'){const a=(1-t)*(1-t),b=2*c.weight*t*(1-t),d=t*t,w=a+b+d;return {x:(a*c.start.x+b*c.control.x+d*c.end.x)/w,y:(a*c.start.y+b*c.control.y+d*c.end.y)/w,z:(a*c.start.z+b*c.control.z+d*c.end.z)/w};}
 const angle=c.sweep*t;return {x:c.center.x+c.u.x*c.radiusX*Math.cos(angle)+c.v.x*c.radiusY*Math.sin(angle),y:c.center.y+c.u.y*c.radiusX*Math.cos(angle)+c.v.y*c.radiusY*Math.sin(angle),z:c.center.z+c.u.z*c.radiusX*Math.cos(angle)+c.v.z*c.radiusY*Math.sin(angle)};
};
const archScale=(v,k)=>({x:v.x*k,y:v.y*k,z:v.z*k});
function splineThrough(pair,controls=[],n){
 const [a,b]=pair,v=sub(b,a),l2=dot(v,v);if(l2<1e-10)throw Error('Select a line with distinct endpoints.');
 const projected=controls.map(p=>{const t=dot(sub(p,a),v)/l2,q=n?sub(p,archScale(n,dot(sub(p,a),n))):p;return {t,p:q};}).filter(q=>q.t>1e-6&&q.t<1-1e-6).sort((a,b)=>a.t-b.t),inside=[];
 for(const q of projected){if(inside.length&&q.t-inside.at(-1).t<1e-6)inside[inside.length-1]=q;else inside.push(q);}
 const ps=[a,...inside.map(q=>q.p),b].map(p=>({x:p.x,y:p.y,z:p.z})),knots=[0,...inside.map(q=>q.t),1],count=ps.length,h=knots.slice(1).map((t,i)=>t-knots[i]),second=ps.map(()=>({x:0,y:0,z:0}));
 for(const k of ['x','y','z']){const upper=[],rhs=[];for(let i=1;i<count-1;i++){const den=2*(h[i-1]+h[i])-h[i-1]*(upper[i-1]||0);upper[i]=h[i]/den;rhs[i]=(6*((ps[i+1][k]-ps[i][k])/h[i]-(ps[i][k]-ps[i-1][k])/h[i-1])-h[i-1]*(rhs[i-1]||0))/den;}for(let i=count-2;i>0;i--)second[i][k]=rhs[i]-(upper[i]||0)*second[i+1][k];}
 const segments=h.map((d,i)=>{const c1={},c2={};for(const k of ['x','y','z']){const slope=(ps[i+1][k]-ps[i][k])/d;c1[k]=ps[i][k]+d/3*(slope-d*(2*second[i][k]+second[i+1][k])/6);c2[k]=ps[i+1][k]-d/3*(slope+d*(second[i][k]+2*second[i+1][k])/6);}return [ps[i],c1,c2,ps[i+1]];});
 return {type:'spline',controls:ps,knots,segments};
}
function archSnap(pair,controls,raw,{normal:n,points=[],screen=p=>p,radius=20,snap=true}={}){
 const [a,b]=pair,v=sub(b,a),l2=dot(v,v),u=archScale(v,1/Math.sqrt(l2)),side=cross(n,u),station=p=>dot(sub(p,a),v)/l2,height=p=>dot(sub(p,a),side),at=(t,h)=>({x:a.x+t*v.x+h*side.x,y:a.y+t*v.y+h*side.y,z:a.z+t*v.z+h*side.z});
 let t=station(raw),h=height(raw),kind='',guides=[];if(!snap)return {point:at(t,h),kind,guides};
 const ps=controls.map(p=>({t:station(p),h:height(p)})),ts=[0,...ps.map(p=>p.t),1].sort((a,b)=>a-b),stations=[{t:.5,kind:'Center'},...ps.map(p=>({t:1-p.t,h:p.h,kind:'Symmetric'})),...ts.slice(1).map((x,i)=>({t:(x+ts[i])/2,kind:'Segment midpoint'}))];
 const near=points.filter(p=>Math.abs(dot(sub(p,a),n))<.002);for(const p of near)stations.push({t:station(p),kind:'Alignment'});
 const pixel=p=>{const q=screen(p),r=screen(raw);return Math.hypot(q.x-r.x,q.y-r.y);};
 let best=null;for(const c of stations){if(c.t<=1e-6||c.t>=1-1e-6)continue;const d=pixel(at(c.t,h));if(d<radius&&(!best||d<best.d-1e-4))best={...c,d};}if(best){t=best.t;kind=best.kind;if(best.h!==undefined&&pixel(at(t,best.h))<radius)h=best.h;guides.push({points:[at(t,0),at(t,h)],color:'#72ffb0',role:'arch-station'});}
 const levels=[{h:0},...ps,...near.map(p=>({h:height(p)}))];let bestHeight=null;for(const c of levels){const d=pixel(at(t,c.h));if(d<radius&&(!bestHeight||d<bestHeight.d))bestHeight={...c,d};}if(bestHeight){h=bestHeight.h;kind=kind||'Alignment';guides.push({points:[at(0,h),at(1,h)],color:'#72ffb0',role:'arch-height'});}
 return {point:at(t,h),kind,guides};
}
function archFaces(faces,c){
 const a=curvePoint(c,0),b=curvePoint(c,1),v=sub(b,a),l2=dot(v,v),param=p=>dot(sub(p,a),v)/l2,on=p=>{const t=param(p);return distance(p,{x:a.x+v.x*t,y:a.y+v.y*t,z:a.z+v.z*t})<1e-6;},samples=curveSamples(c),affected=[];
 const mapped=p=>on(p)&&param(p)>1e-7&&param(p)<1-1e-7?{...p,...curvePoint(c,param(p))}:p;
 const ring=ps=>ps.flatMap((p,i)=>{const q=ps[(i+1)%ps.length],t=param(p),u=param(q),out=[mapped(p)];if(on(p)&&on(q)&&Math.abs(t-u)>1e-8){const lo=Math.max(0,Math.min(t,u)),hi=Math.min(1,Math.max(t,u));if(hi>lo){const values=[lo,...samples.map(p=>p.curveT).filter(x=>x>lo+1e-8&&x<hi-1e-8),hi].filter(x=>x>Math.min(t,u)+1e-8&&x<Math.max(t,u)-1e-8);if(t>u)values.reverse();out.push(...values.map(t=>({...curvePoint(c,t),curveSample:!c.knots.some(k=>Math.abs(k-t)<1e-8),...(c.knots.some(k=>Math.abs(k-t)<1e-8)?{userDraftPoint:true}:{})})));}}return out;});
 const result=faces.map(f=>{if(f.deleted||f.snapOnly)return f;const points=ring(f.points),holes=(f.holes||[]).map(ring),retainedPoints=(f.retainedPoints||[]).map(mapped);if(JSON.stringify([points,holes,retainedPoints])===JSON.stringify([f.points,f.holes||[],f.retainedPoints||[]]))return f;const next={...f,points,holes,retainedPoints,curves:[...(f.curves||[]),c],...(f.feature?{feature:{...f.feature,preset:null,shape:'custom'}}:{})};validateFace(next);affected.push(f.id);return next;});
 return {faces:result,affected};
}
function curveSamples(c,tolerance=.001){
 const out=[{...curvePoint(c,0),curveT:0}],split=(a,b,pa,pb,depth)=>{const m=(a+b)/2,pm=curvePoint(c,m),linear={x:(pa.x+pb.x)/2,y:(pa.y+pb.y)/2,z:(pa.z+pb.z)/2};if(depth<14&&(distance(pm,linear)>tolerance||b-a>.125)){split(a,m,pa,pm,depth+1);split(m,b,pm,pb,depth+1);}else out.push({...pb,curveT:b});};if(c.type==='spline'){for(let i=1;i<c.knots.length;i++)split(c.knots[i-1],c.knots[i],out.at(-1),curvePoint(c,c.knots[i]),0);}else split(0,1,out[0],curvePoint(c,1),0);return out;
}
function mapCurve(c,map){if(c.type==='spline')return {...c,controls:c.controls.map(map),segments:c.segments.map(s=>s.map(map))};if(c.type==='surface-boundary')return {...c,surface:mapCurveData({curvedSurface:c.surface},map).curvedSurface};if(c.type==='conic')return {...c,start:map(c.start),control:map(c.control),end:map(c.end)};const center=map(c.center),axis=(v,r)=>sub(map({x:c.center.x+v.x*r,y:c.center.y+v.y*r,z:c.center.z+v.z*r}),center),a=axis(c.u,c.radiusX),b=axis(c.v,c.radiusY),rx=Math.hypot(a.x,a.y,a.z),ry=Math.hypot(b.x,b.y,b.z);return {...c,center,u:{x:a.x/rx,y:a.y/rx,z:a.z/rx},v:{x:b.x/ry,y:b.y/ry,z:b.z/ry},radiusX:rx,radiusY:ry};}
function curveSvg(c,project,lo=0,hi=1){if(c.type!=='ellipse'){const ps=[curvePoint(c,lo),...curveSamples(c).filter(p=>p.curveT>lo&&p.curveT<hi),curvePoint(c,hi)].map(project);return {d:ps.map((p,i)=>(i?'L ':'M ')+p.x+' '+p.y).join(' '),'vector-effect':'non-scaling-stroke'};}const o=project(c.center),a=project({x:c.center.x+c.u.x,y:c.center.y+c.u.y,z:c.center.z+c.u.z}),b=project({x:c.center.x+c.v.x,y:c.center.y+c.v.y,z:c.center.z+c.v.z}),x=c.radiusX*Math.cos(c.sweep*hi),y=c.radiusY*Math.sin(c.sweep*hi);return {d:'M '+(c.radiusX*Math.cos(c.sweep*lo))+' '+(c.radiusY*Math.sin(c.sweep*lo))+' A '+c.radiusX+' '+c.radiusY+' 0 '+(Math.abs(c.sweep*(hi-lo))>Math.PI?1:0)+' '+(c.sweep>0?1:0)+' '+x+' '+y,transform:'matrix('+[a.x-o.x,a.y-o.y,b.x-o.x,b.y-o.y,o.x,o.y].join(' ')+')','vector-effect':'non-scaling-stroke'};}
function mapCurveData(f,map){const out={};if(f.joinedChimneys)out.joinedChimneys=[...f.joinedChimneys];if(f.trimData)out.trimData={...f.trimData,layers:f.trimData.layers.map(l=>{const pair=l.pair.map(map);return {...l,pair,id:'trim:'+edgeKey(...pair)};})};if(f.curves?.length)out.curves=f.curves.map(c=>mapCurve(c,map));if(f.curvedSurface){const c=f.curvedSurface,origin=c.curve&&curvePoint(c.curve,0);out.curvedSurface={...c,...(c.type==='quadric-corner'?{origin:map(c.origin),shoulders:c.shoulders.map(map)}:c.start?{start:mapCurve(c.start,map),finish:mapCurve(c.finish,map)}:{curve:mapCurve(c.curve,map),offset:sub(map({x:origin.x+c.offset.x,y:origin.y+c.offset.y,z:origin.z+c.offset.z}),map(origin))})};}return out;}

// Curves are model geometry. Facets and UVs are disposable evaluation results.
function surfacePoint(c,u,v){
 if(c.type==='quadric-corner'){
  const w=[u*u,v*v,(1-u-v)**2],sum=w.reduce((a,b)=>a+b),b=w.map(x=>x/sum),t=1/(1+Math.sqrt(Math.max(0,1-b.reduce((s,x)=>s+x*x,0))));
  return b.reduce((p,w,i)=>({x:p.x+(c.shoulders[i].x-c.origin.x)*w*t,y:p.y+(c.shoulders[i].y-c.origin.y)*w*t,z:p.z+(c.shoulders[i].z-c.origin.z)*w*t}),{...c.origin});
 }
 const a=curvePoint(c.start||c.curve,u),b=c.finish?curvePoint(c.finish,u):{x:a.x+c.offset.x,y:a.y+c.offset.y,z:a.z+c.offset.z};
 return {x:a.x+(b.x-a.x)*v,y:a.y+(b.y-a.y)*v,z:a.z+(b.z-a.z)*v};
}
function surfaceUV(c,p,range=[0,1]){
 if(c.type==='quadric-corner'){
  const [a,b,d]=c.shoulders.map(p=>sub(p,c.origin)),q=sub(p,c.origin),den=dot(a,cross(b,d)),w=[dot(q,cross(b,d)),dot(a,cross(q,d)),dot(a,cross(b,q))].map(x=>Math.sqrt(Math.max(0,x/den))),sum=w.reduce((a,b)=>a+b);return {x:w[0]/sum,y:w[1]/sum,z:0};
 }
 const at=u=>{const a=surfacePoint(c,u,0),b=surfacePoint(c,u,1),d=sub(b,a),v=dot(sub(p,a),d)/dot(d,d),q={x:a.x+d.x*v,y:a.y+d.y*v,z:a.z+d.z*v};return {u,v,error:distance(q,p)};};
 const [lower,upper]=range,step=(upper-lower)/32;let best=at(lower);for(let i=1;i<=32;i++){const q=at(lower+i*step);if(q.error<best.error)best=q;}let lo=Math.max(lower,best.u-step),hi=Math.min(upper,best.u+step);for(let i=0;i<42;i++){const a=at(lo+(hi-lo)/3),b=at(hi-(hi-lo)/3);if(a.error<b.error)hi=b.u;else lo=a.u;}const q=at((lo+hi)/2),clean=x=>Math.abs(x)<1e-6?0:Math.abs(x-1)<1e-6?1:x;return {x:clean(q.u),y:clean(q.v),z:0};
}
function surfaceDomain(c){return c.domains||[{points:c.type==='quadric-corner'?[{x:0,y:0},{x:1,y:0},{x:0,y:1}]:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],holes:[]}];}
// Parameter-space boundaries remain exact even for trimmed curved surfaces.
function surfaceBoundaryCurves(face){const c=face.curvedSurface;return surfaceDomain(c).map(d=>[d.points,...(d.holes||[])].map(r=>{
 const controls=c.boundaryControls,indices=r.map((p,i)=>!controls||controls.some(q=>distance({...p,z:0},{...q,z:0})<CONTACT)?i:-1).filter(i=>i>=0);if(!indices.length)indices.push(0);
 return indices.map((index,j)=>{const end=indices[(j+1)%indices.length],path=[r[index]];for(let i=(index+1)%r.length;i!==end;i=(i+1)%r.length)path.push(r[i]);path.push(r[end]);return {type:'surface-boundary',surface:c,from:path[0],to:path.at(-1),...(path.length>2?{path}:{})};});
 }));}
function surfaceOutline(face){if(!face.curvedSurface?.logical)return face;const domains=surfaceBoundaryCurves(face),rings=domains.flatMap(d=>d.map(r=>r.flatMap(c=>curveSamples(c).slice(0,-1))));return {...face,points:rings[0],holes:rings.slice(1),curves:domains.flat(2)};}
function compactSurfaces(faces){
 const out=[],groups=new Map();for(const f of faces){if(!f.curvedSurface||f.curvedSurface.logical||f.deleted||f.drafted||f.roof){out.push(f);continue;}const {range,domains,logical,...definition}=f.curvedSurface,key=JSON.stringify(definition)+':'+(f.material||'')+':'+(f.finishColor||'')+':'+JSON.stringify(f.chimney||null);if(!groups.has(key))groups.set(key,{definition,faces:[]});groups.get(key).faces.push(f);}
 for(const {definition,faces:parts}of groups.values()){
  const parameter=(p,range)=>{const uv=surfaceUV(definition,p,range);if(definition.type==='quadric-corner'){const steps=Math.min(48,Math.max(8,Math.ceil(Math.sqrt(Math.max(...definition.shoulders.map(p=>distance(p,definition.origin)))/.001))));for(const n of [steps,steps*2]){const q={x:Math.round(uv.x*n)/n,y:Math.round(uv.y*n)/n,z:0};if(q.x>=0&&q.y>=0&&q.x+q.y<=1+1e-8&&distance(surfacePoint(definition,q.x,q.y),p)<CONTACT*2)return q;}}return uv;};
  const domains=union(parts.map(f=>({points:f.points.map(p=>parameter(p,f.curvedSurface.range)),holes:(f.holes||[]).map(r=>r.map(p=>parameter(p,f.curvedSurface.range)))})));
  if(!domains.length){out.push(...parts);continue;}
  const curvedSurface={...definition,logical:true,domains},points=domains.flatMap(d=>d.points.map(p=>surfacePoint(definition,p.x,p.y)));
  out.push({...parts[0],points,holes:[],curvedSurface,retainedPoints:[],curveMemberIds:undefined});
 }
 return out;
}
const surfaceCache=new WeakMap();
function surfaceMesh(face,tolerance=.001){
 const c=face.curvedSurface,signature=JSON.stringify(c)+':'+tolerance,prior=surfaceCache.get(face);if(prior?.signature===signature)return prior.mesh;
 const domains=surfaceDomain(c),positions=[],uv=[],indices=[],lookup=new Map(),boundaries=[];
 const vertex=p=>{const key=pointKey(p);if(lookup.has(key))return lookup.get(key);const i=positions.length;lookup.set(key,i);positions.push(surfacePoint(c,p.x,p.y));uv.push({x:p.x,y:p.y});return i;};
 const addRegion=r=>{const tri=triangles(r.points,r.holes||[]);for(const t of tri.triangles)indices.push(t.map(i=>vertex(tri.points[i])));};
 // Ruled sections vary only along their arc; their second coordinate is linear.
 const times=c.type==='quadric-corner'?null:[...new Set([0,1,...curveSamples(c.start||c.curve,tolerance).map(p=>p.curveT),...(c.finish?curveSamples(c.finish,tolerance).map(p=>p.curveT):[])])].sort((a,b)=>a-b);
 if(times){for(let i=1;i<times.length;i++)for(const d of intersection(domains,[{points:[{x:times[i-1],y:0},{x:times[i],y:0},{x:times[i],y:1},{x:times[i-1],y:1}],holes:[]}]))addRegion(d);}
 else {const full=domains.length===1&&!domains[0].holes?.length&&domains[0].points.length===3&&[{x:0,y:0},{x:1,y:0},{x:0,y:1}].every(p=>domains[0].points.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<1e-12));
 // An untrimmed corner already fills the parameter triangle. Clipping every
 // render cell back to that same triangle wastes work on every live preview.
 const size=Math.max(...c.shoulders.map(p=>distance(p,c.origin))),n=Math.min(48,Math.max(8,Math.ceil(Math.sqrt(size/tolerance))));for(let i=0;i<n;i++)for(let j=0;j<n-i;j++){const p=(x,y)=>({x:x/n,y:y/n}),cells=[[p(i,j),p(i+1,j),p(i,j+1)]];if(i+j<n-1)cells.push([p(i+1,j),p(i+1,j+1),p(i,j+1)]);for(const points of cells){if(full)indices.push(points.map(vertex));else for(const r of intersection(domains,[{points,holes:[]}]))addRegion(r);}}}
 for(const curve of surfaceBoundaryCurves(face).flat(2))boundaries.push(curveSamples(curve,tolerance));
 const mesh={positions,uv,triangles:indices,boundaries};surfaceCache.set(face,{signature,mesh});return mesh;
}
// Share explicit curved boundaries with adjoining planar faces (notably the
// foundation). Their polygon loops are evaluation output, not new controls.
function attachBoundaryCurves(faces,surfaces){
 const curves=[];for(const f of compactSurfaces(surfaces||[])){const c=f.curvedSurface;if(!c?.logical||f.deleted||f.drafted)continue;
  const definitions=c.type==='quadric-corner'?c.shoulders.map((p,i)=>({type:'conic',start:p,control:c.origin,end:c.shoulders[(i+1)%3],weight:Math.SQRT1_2})):c.start?[c.start,c.finish]:[c.curve,mapCurve(c.curve,p=>({x:p.x+c.offset.x,y:p.y+c.offset.y,z:p.z+c.offset.z}))];
  for(const [i,curve]of definitions.entries())curves.push({...curve,id:'surface-boundary:'+f.id+':'+i});
 }
 let changed=false;for(const f of faces){const fr=frame(f);if(!fr)continue;const rings=[f.points,...(f.holes||[])],nearBoundary=p=>rings.some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],v=sub(b,a),l2=dot(v,v),t=l2?dot(sub(p,a),v)/l2:-1;return t>=-1e-5&&t<=1+1e-5&&distance(p,{x:a.x+v.x*t,y:a.y+v.y*t,z:a.z+v.z*t})<=.002;}));
  const found=[];for(const c of curves){const samples=curveSamples(c);if(samples.some(p=>Math.abs(local(fr,p).z)>.002))continue;const curve=mapCurve(c,p=>world(fr,{...local(fr,p),z:0})),ps=curveSamples(curve);if(ps.length>2&&ps.every(nearBoundary))found.push(curve);}
  if(found.length){const next=[...(f.curves||[]).filter(c=>!String(c.id).startsWith('surface-boundary:')),...found];if(JSON.stringify(next)!==JSON.stringify(f.curves)){f.curves=next;changed=true;}}
 }return changed;
}
function surfaceArea(f,tolerance=.0001){const m=surfaceMesh(f,tolerance);return m.triangles.reduce((sum,t)=>{const [a,b,c]=t.map(i=>m.positions[i]),n=cross(sub(b,a),sub(c,a));return sum+Math.hypot(n.x,n.y,n.z)/2;},0);}
function surfaceFacets(f){if(!f.curvedSurface?.logical)return [f];const mesh=surfaceMesh(f);return mesh.triangles.map((t,i)=>({...f,id:f.id+'~sample-'+i,surfaceId:f.id,points:t.map(i=>mesh.positions[i]),holes:[],curvedSurface:{...f.curvedSurface,logical:false,domains:undefined}}));}
// Curve drawing snaps in the supporting plane, using screen-space distances.
// Shared centers are identified by position as well as persisted IDs so older
// saved arcs participate without a migration or duplicate center node.
function curveDrawSnap({start,center,point,normal:n,points=[],curves=[],screen,radius=12,snap=true}){
 if(!snap)return {point};const origin=center||start,project=p=>{const d=dot(sub(p,origin),n);return {x:p.x-n.x*d,y:p.y-n.y*d,z:p.z-n.z*d};},pixel=(a,b)=>{const p=screen(a),q=screen(b);return p.visible===false||q.visible===false?Infinity:Math.hypot(p.x-q.x,p.y-q.y);};
 const refs=points.filter(p=>Math.abs(dot(sub(p,origin),n))<CONTACT&&(!center||distance(p,center)>CONTACT)),shared=center?curves.filter(c=>c.center&&distance(c.center,center)<CONTACT):[];
 if(center){refs.push(start);for(const c of shared)refs.push(curvePoint(c,0),curvePoint(c,1));}
 const nearest=refs.map(p=>({p,d:pixel(p,point)})).filter(x=>x.d<=radius).sort((a,b)=>a.d-b.d)[0],pointSnap=()=>({point:{...nearest.p},target:nearest.p,...(center&&Math.abs(distance(nearest.p,center)-distance(start,center))<CONTACT?{radius:distance(start,center),radiusSource:start}:{}),close:!!center&&distance(nearest.p,start)<CONTACT});
 // A deliberate point hit wins; merely passing near a shorter-radius point
 // must not mask the circle through the selected starting point.
 if(nearest&&(!center||nearest.d<=3))return pointSnap();
 const q=project(point),delta=sub(q,origin),r=Math.hypot(delta.x,delta.y,delta.z);if(r<CONTACT)return {point:q};
 let axis=project({x:origin.x+1,y:origin.y,z:origin.z}),u=sub(axis,origin),len=Math.hypot(u.x,u.y,u.z);if(len<CONTACT){axis=project({x:origin.x,y:origin.y+1,z:origin.z});u=sub(axis,origin);len=Math.hypot(u.x,u.y,u.z);}u={x:u.x/len,y:u.y/len,z:u.z/len};const v=cross(n,u),theta=Math.atan2(dot(delta,v),dot(delta,u));
 const directions=Array.from({length:8},(_,i)=>({a:i*Math.PI/4}));if(center)for(const p of [start,...shared.flatMap(c=>[curvePoint(c,0),curvePoint(c,1)])]){const d=sub(p,center),a=Math.atan2(dot(d,v),dot(d,u));for(let i=0;i<8;i++)directions.push({a:a+i*Math.PI/4,source:p});}
 const at=(a,r)=>({x:origin.x+r*(u.x*Math.cos(a)+v.x*Math.sin(a)),y:origin.y+r*(u.y*Math.cos(a)+v.y*Math.sin(a)),z:origin.z+r*(u.z*Math.cos(a)+v.z*Math.sin(a))}),nearAngles=directions.filter(c=>Math.abs(Math.atan2(Math.sin(c.a-theta),Math.cos(c.a-theta)))<Math.PI/30);
 const radii=center?[start,...shared.flatMap(c=>[curvePoint(c,0),curvePoint(c,1)])].map(source=>({value:distance(source,center),source})).filter((c,i,all)=>c.value>CONTACT&&!all.slice(0,i).some(p=>Math.abs(p.value-c.value)<CONTACT)):[];
 for(const length of radii){
  // First catch exact angle/radius intersections, including quarter turns
  // relative to the starting spoke on any face orientation.
  const joint=nearAngles.map(c=>({...c,d:pixel(at(c.a,length.value),q)})).filter(c=>c.d<=radius).sort((a,b)=>a.d-b.d)[0];
  // On an oblique face, distance to the projected circle is not the screen
  // distance along the raw radial ray. Search the nearby circle arc instead.
  let lo=theta-Math.PI/8,hi=theta+Math.PI/8;for(let i=0;i<22;i++){const a=(2*lo+hi)/3,b=(lo+2*hi)/3;if(pixel(at(a,length.value),q)<pixel(at(b,length.value),q))hi=b;else lo=a;}let angle=(lo+hi)/2;
  if(pixel(at(theta,length.value),q)<=pixel(at(angle,length.value),q)+1e-7)angle=theta;
  if(joint||pixel(at(angle,length.value),q)<=radius){const a=joint?.a??angle,point=at(a,length.value);return {point,radius:length.value,radiusSource:length.source,...(joint?{alignment:[origin,point],angleSource:joint.source}:{}),close:distance(point,start)<CONTACT};}
 }
 if(nearest)return pointSnap();
 const angle=nearAngles.map(c=>({...c,d:pixel(at(c.a,r),q)})).filter(c=>c.d<=radius).sort((a,b)=>a.d-b.d)[0];
 return angle?{point:at(angle.a,r),alignment:[origin,at(angle.a,r)],angleSource:angle.source,close:false}:{point:q,close:false};
}
// Geometry for both renderers: every snap names its source with a spoke or
// connector; equal radii also show the actual reference circle.
function curveDrawGuides({start,center,pointer,snap={},normal:n}){
 const guides=[],line=(a,b,role,color)=>{if(a&&b&&distance(a,b)>CONTACT)guides.push({points:[a,b],role,color});},end=pointer||start;
 if(center){line(center,start,'start-radius','#72ffb0');line(center,end,snap.radius?'equal-radius':'end-radius',snap.radius?'#65e6ff':'#72ffb0');}
 if(snap.alignment)line(snap.alignment[0],end,'angle','#FFD700');
 if(snap.angleSource&&center)line(center,snap.angleSource,'angle-source','#FFD700');
 if(snap.target)line(center||start,snap.target,'point-target','#ffb5f1');
 if(snap.radius&&center){line(center,snap.radiusSource||start,'radius-source','#65e6ff');const a=sub(start,center),l=Math.hypot(a.x,a.y,a.z),u={x:a.x/l,y:a.y/l,z:a.z/l},v=cross(n,u),points=Array.from({length:97},(_,i)=>{const t=i*Math.PI/48;return {x:center.x+snap.radius*(u.x*Math.cos(t)+v.x*Math.sin(t)),y:center.y+snap.radius*(u.y*Math.cos(t)+v.y*Math.sin(t)),z:center.z+snap.radius*(u.z*Math.cos(t)+v.z*Math.sin(t))};});guides.push({points,role:'radius-circle',color:'#65e6ff'});}
 return guides;
}

function arcPreview(start,center,p,normal0,track={},snap=true){
 const a=sub(start,center),radiusX=Math.hypot(a.x,a.y,a.z);if(radiusX<CONTACT)throw Error('Place the center away from the starting point.');const u={x:a.x/radiusX,y:a.y/radiusX,z:a.z/radiusX},perpendicular=cross(normal0,u),q=sub(p,center),radius=Math.hypot(dot(q,u),dot(q,perpendicular));let v=perpendicular,radiusY=Math.abs(radius-radiusX)<=CONTACT||snap&&Math.abs(radius-radiusX)<=Math.max(.02,radiusX*.04)?radiusX:Math.max(CONTACT,radius),angle=Math.atan2(dot(q,v)/radiusY,dot(q,u)/radiusX);
 // Keep the axes perpendicular. Forcing an arbitrary pointer onto the curve
 // by shearing the second axis becomes singular beside the starting radius:
 // a small mouse movement could produce a long loop behind the starting point.
 // The mouse sets the second radius and direction; the endpoint is the point
 // on that ellipse in that direction. Circle snaps therefore remain exact.

 const priorSweep=track.sweep||0;let delta=angle-(track.angle||0);while(delta>Math.PI)delta-=2*Math.PI;while(delta< -Math.PI)delta+=2*Math.PI;let sweep=(track.sweep||0)+delta;if(Math.abs(sweep)>=Math.PI*2)sweep%=Math.PI*2;if(track.close&&Math.abs(priorSweep)>Math.PI)sweep=Math.sign(priorSweep)*Math.PI*2;track.angle=angle;track.sweep=sweep;
 return {type:'ellipse',version:1,center:{...center},u,v,radiusX,radiusY,sweep};
}
const api={splineThrough,archSnap,archFaces,normalizeFaces,normalizeFace,pointRemovalChangesRegion,curveDrawGuides,curveDrawSnap,surfaceBoundaryCurves,surfaceOutline,attachBoundaryCurves,surfaceArea,surfacePoint,surfaceUV,surfaceMesh,surfaceFacets,compactSurfaces,curveSvg,mapCurveData,curvePoint,curveSamples,mapCurve,arcPreview,version:2,partition,GRID,CONTACT,finite3,signedArea,area,union,difference,intersection,pieces,triangles,normal,frame,local,world,validateFace,pointKey,edgeKey,topology};
if(typeof module==='object'&&module.exports)module.exports=api;else root.ExteriorGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
