/* Materialize editable parapet caps and inner walls once during From Roof. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports;
const G=node?require('./wall_geometry.js'):root.WallGeometry,K=node?require('./exterior_geometry.js'):root.ExteriorGeometry;
const WIDTH=6*G.INCH,HEIGHT=24*G.INCH,EPS=.002;
const copy=p=>({...p}),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),cross=(a,b)=>a.x*b.y-a.y*b.x;
function build(roof,sources,walls){
 const runs=[];
 for(const s of sources||[]){
  if(s.kind!=='perimeter'||s.type!=='parapet'||s.referenceOnly)continue;
  const face=roof.faces.find((f,i)=>(f.id??i)===s.parentId);if(!face)continue;
  const length=distance(s.a,s.b);if(length<EPS)continue;
  const u={x:(s.b.x-s.a.x)/length,y:(s.b.y-s.a.y)/length},n={x:-u.y,y:u.x},mid={x:(s.a.x+s.b.x)/2,y:(s.a.y+s.b.y)/2};
  if(!G.contains(face,{x:mid.x+n.x*.02,y:mid.y+n.y*.02})){n.x=-n.x;n.y=-n.y;}
  const at=t=>({x:s.a.x+u.x*t,y:s.a.y+u.y*t,z:s.a.z+(s.b.z-s.a.z)*t/length}),intervals=[];
  // A merged wall may span both parapet and ordinary edges. Only cover the
  // surviving top intervals belonging to this parapet source.
  for(const w of walls){
   if(w.chimney||!w.top)continue;
   if(w.top.some(p=>Math.abs((p.x-s.a.x)*u.y-(p.y-s.a.y)*u.x)>EPS))continue;
   const ts=w.top.map(p=>(p.x-s.a.x)*u.x+(p.y-s.a.y)*u.y);
   if(w.top.some((p,i)=>Math.abs(p.z-at(ts[i]).z)>EPS))continue;
   const a=Math.max(0,Math.min(...ts)),b=Math.min(length,Math.max(...ts));if(b-a>EPS)intervals.push([a,b]);
  }
  const merged=[];for(const span of intervals.sort((a,b)=>a[0]-b[0])){const last=merged.at(-1);if(last&&span[0]<=last[1]+EPS)last[1]=Math.max(last[1],span[1]);else merged.push(span.slice());}
  for(const [i,span]of merged.entries()){
   const outer=span.map(at);
   if(runs.some(r=>outer.every(p=>r.outer.some(q=>distance(p,q)<EPS&&Math.abs(p.z-q.z)<EPS))))continue;
   runs.push({id:'parapet:'+s.id+':'+i,sourceId:s.id,roofId:s.parentId,outer,inner:outer.map(p=>({x:p.x+n.x*WIDTH,y:p.y+n.y*WIDTH,z:p.z})),n,u});
  }
 }
 // Offset adjacent runs together. The shared miter belongs to both caps and
 // both inside walls, including concave corners and reversed roof lines.
 for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
  const a=runs[i],b=runs[j],den=cross(a.u,b.u);
  for(let ai=0;ai<2;ai++)for(let bi=0;bi<2;bi++){
   const p=a.outer[ai],q=b.outer[bi];if(distance(p,q)>EPS||Math.abs(p.z-q.z)>EPS)continue;
   if(Math.abs(den)<1e-8)continue;
   const pa={x:p.x+a.n.x*WIDTH,y:p.y+a.n.y*WIDTH},pb={x:q.x+b.n.x*WIDTH,y:q.y+b.n.y*WIDTH};
   const t=cross({x:pb.x-pa.x,y:pb.y-pa.y},b.u)/den;
   const join={x:pa.x+a.u.x*t,y:pa.y+a.u.y*t,z:(p.z+q.z)/2};
   a.inner[ai]=copy(join);b.inner[bi]=copy(join);
  }
 }
 const faces=[];
 function add(id,points,normal,parapet){
  const n=K.normal(points);if(!n)throw Error('The parapet is too narrow for a six-inch cap.');
  if(n.x*normal.x+n.y*normal.y+n.z*normal.z<0)points.reverse();
  // Unequal surveyed corner heights can make a cap nonplanar. Triangulate
  // that cap explicitly rather than flattening or moving its shared corners.
  const f={id,points,holes:[],parapet};
  try{K.validateFace(f);faces.push(f);}catch(error){
   if(!id.endsWith(':cap'))throw error;
   for(const [i,ids]of [[0,1,2],[0,2,3]].entries()){const piece={id:id+':'+i,points:ids.map(j=>copy(points[j])),holes:[],parapet};K.validateFace(piece);faces.push(piece);}
  }
 }
 for(const r of runs){
  const raised=p=>({...p,z:p.z+HEIGHT});
  add(r.id+':outside',[...r.outer.map(copy),...r.outer.slice().reverse().map(raised)],{x:-r.n.x,y:-r.n.y,z:0},{sourceId:r.sourceId,part:'outside'});
  add(r.id+':cap',[...r.outer.map(raised),...r.inner.slice().reverse().map(raised)],{x:0,y:0,z:1},{sourceId:r.sourceId,roofId:r.roofId,part:'cap'});
  add(r.id+':inside',[...r.inner.map(copy),...r.inner.slice().reverse().map(raised)],{...r.n,z:0},{sourceId:r.sourceId,part:'inside'});
  for(let end=0;end<2;end++){
   // A shared cross-section is internal to a continuous parapet. Every
   // other endpoint needs an editable face connecting its outer and inner skins.
   const joined=runs.some(other=>other!==r&&other.outer.some((p,i)=>distance(p,r.outer[end])<EPS&&Math.abs(p.z-r.outer[end].z)<EPS&&distance(other.inner[i],r.inner[end])<EPS));
   if(joined)continue;
   const sign=end?1:-1;
   add(r.id+':end-'+end,[copy(r.outer[end]),copy(r.inner[end]),raised(r.inner[end]),raised(r.outer[end])],{x:r.u.x*sign,y:r.u.y*sign,z:0},{sourceId:r.sourceId,part:'end',end});
  }
 }
 return faces;
}
// Cut only the visible roof beneath live raised parapet caps. The surveyed
// roof stays intact, and moved/deleted editable faces define the current inset.
function roofWithInsets(roof,surfaces=[]){
 const caps=surfaces.filter(f=>f.parapet?.part==='cap'&&!f.deleted&&!f.drafted);
 if(!roof||!caps.length)return roof;
 const faces=roof.faces.flatMap(face=>{
  const plane=G.plane(face.points);if(!plane)return [face];
  const cuts=caps.filter(cap=>String(face.id).split(':opening-')[0]===String(cap.parapet.roofId)&&cap.points.every(p=>p.z-plane.dx*p.x-plane.dy*p.y-plane.k>0));
  if(!cuts.length||!K.intersection([face],cuts).length)return [face];
  const original=[face.points,...(face.holes||[])].flat(),lift=p=>({...p,z:original.find(q=>distance(p,q)<1e-6)?.z??(plane.dx*p.x+plane.dy*p.y+plane.k)});
  return K.difference(face,cuts).map((part,i)=>({...face,id:face.id+':parapet-'+i,points:part.points.map(lift),holes:(part.holes||[]).map(r=>r.map(lift))}));
 });
 return {...roof,faces};
}
const api={build,roofWithInsets,WIDTH,HEIGHT};if(node)module.exports=api;else root.WallParapets=api;
})(typeof window==='undefined'?globalThis:window);
