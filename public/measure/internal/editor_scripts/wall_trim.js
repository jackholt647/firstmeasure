/* Finish strips partition a supporting face; they never offset its surface. */
(function(root){'use strict';
const common=typeof module!=='undefined'&&module.exports;
const K=common?require('./exterior_geometry.js'):root.ExteriorGeometry;
const W=common?require('./wall_solid_geometry.js'):root.WallSolidGeometry;
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const boundaries=faces=>faces.flatMap(f=>[f.points,...(f.holes||[])].flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]])));
const at=(a,u,t)=>({x:a.x+u.x*t,y:a.y+u.y*t,z:a.z+u.z*t});
// Follow only connected collinear segments. A crossing or an isolated point is
// not an endpoint, and a gap never becomes an imaginary continuation.
function runs(pairs,segments=pairs){
 const result=new Map();
 for(const [a,b]of pairs){const d=sub(b,a),length=Math.hypot(d.x,d.y,d.z);if(length<=K.CONTACT)continue;const u={x:d.x/length,y:d.y/length,z:d.z/length};
  const spans=[];for(const pair of segments){const ts=pair.map(p=>dot(sub(p,a),u));if(pair.some((p,i)=>{const q=at(a,u,ts[i]);return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)>K.CONTACT;}))continue;spans.push(ts.sort((a,b)=>a-b));}
  let lo=0,hi=length,changed=true;while(changed){changed=false;for(const [x,y]of spans)if(x<=hi+K.CONTACT&&y>=lo-K.CONTACT){const l=Math.min(lo,x),h=Math.max(hi,y);if(l<lo||h>hi){lo=l;hi=h;changed=true;}}}
  const pair=[at(a,u,lo),at(a,u,hi)];result.set(W.edgeKey(...pair),pair);
 }
 return [...result.values()];
}
function contains2(face,p){
 const inside=ring=>{let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;};
 return inside(face.points)&&!(face.holes||[]).some(inside);
}
function prepared(face){const frame=W.faceFrame(face);return frame?{face,frame,local:{points:face.points.map(p=>W.inFrame(frame,p)),holes:(face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))}}:null;}
// Classify the smaller corner wedge against the actual shell, not polygon
// winding (imported and edited walls need not share a winding convention).
function insideShell(p,shell){
 let votes=0;for(const d of [{x:1,y:.37139,z:0},{x:-.52713,y:1,z:0},{x:.19371,y:-1,z:0}]){
  const hits=[];for(const {frame,local}of shell){const den=dot(frame.n,d);if(Math.abs(den)<1e-8)continue;const t=dot(sub(frame.origin,p),frame.n)/den;if(t<=K.CONTACT)continue;if(contains2(local,W.inFrame(frame,at(p,d,t))))hits.push(t);}
  hits.sort((a,b)=>a-b);if(hits.filter((t,i)=>!i||t-hits[i-1]>K.CONTACT).length%2)votes++;
 }return votes>=2;
}
function outwardCorner(a,b,owners,shell){
 const delta=sub(b,a),length=Math.hypot(delta.x,delta.y,delta.z),edge={x:delta.x/length,y:delta.y/length,z:delta.z/length},mid=at(a,edge,length/2),step=Math.min(.001,length/20),inward=[];
 for(const face of owners){const item=prepared(face),n=item.frame.n,v={x:n.y*edge.z-n.z*edge.y,y:n.z*edge.x-n.x*edge.z,z:n.x*edge.y-n.y*edge.x};
  const sign=contains2(item.local,W.inFrame(item.frame,at(mid,v,step)))?1:contains2(item.local,W.inFrame(item.frame,at(mid,v,-step)))?-1:0;
  if(sign)inward.push({x:v.x*sign,y:v.y*sign,z:v.z*sign});
 }
 for(let i=0;i<inward.length;i++)for(let j=i+1;j<inward.length;j++){
  const a=inward[i],b=inward[j];if(Math.abs(dot(a,b))>.99999)continue;const sum={x:a.x+b.x,y:a.y+b.y,z:a.z+b.z},l=Math.hypot(sum.x,sum.y,sum.z),v={x:sum.x/l,y:sum.y/l,z:sum.z/l};
  if(insideShell(at(mid,v,step),shell)&&!insideShell(at(mid,v,-step),shell))return true;
 }return false;
}
function materialKey(face,defaults={}){
 const material=face.material;
 return !material||material==='default'?(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':defaults.material||'unassigned'):material;
}
const defaultMaterial=id=>['default','unassigned','siding','siding-vertical','soffit'].includes(id);
const eligibleMaterial=(face,options)=>!Array.isArray(options.materials)||options.materials.includes(materialKey(face,options.defaults));
function candidates(faces,options={}){const {roof,base,ground}=options;
 const eligible=faces.filter(f=>!f.deleted&&!f.snapOnly&&!f.feature&&!f.curvedSurface).map((f,i)=>({...f,id:i})).filter(f=>{const frame=W.faceFrame(f);return !!frame;});
 const shell=faces.filter(f=>!f.deleted&&!f.snapOnly).map(prepared).filter(Boolean);
 const graph=K.topology(eligible),pairs=[],exclusions=[...(roof?.faces||[]),...(base?.faces||[]),...(ground?.faces||[]).filter(f=>f.points)];
 for(const edge of graph.edges.values()){
  const owners=[...edge.faces].map(id=>graph.faces.get(id).face);if(owners.length<2||owners.every(f=>f.trim)||!owners.some(f=>eligibleMaterial(f,options)))continue;
  const normals=owners.map(f=>W.faceFrame(f).n);if(!normals.some((a,i)=>normals.slice(i+1).some(b=>Math.abs(dot(a,b))<.99999)))continue;
  const a=graph.vertices[edge.a].point,b=graph.vertices[edge.b].point,u=sub(b,a);if(!outwardCorner(a,b,owners,shell))continue;let lo=0;
  for(const [start,end]of [...W.sharedIntervals(a,b,exclusions),[1,1]]){if(start-lo>1e-7)pairs.push([at(a,u,lo),at(a,u,start)]);lo=Math.max(lo,end);}
 }
 return runs(pairs);
}
// Ground selection uses actual shared boundary intervals, including slopes
// and partial edges. It never guesses ground from a global minimum height.
function groundCandidates(faces,options={}){const {base,ground}=options;
 const supports=[...(base?.faces||[]),...(ground?.faces||[])].filter(f=>!f.deleted&&f.points),pairs=[];
 for(const face of faces){if(face.deleted||face.snapOnly||face.feature||face.trim||face.curvedSurface||!eligibleMaterial(face,options))continue;
  const frame=W.faceFrame(face);if(!frame||Math.abs(frame.n.z)>.99999)continue;
  for(const [a,b]of boundaries([face])){const u=sub(b,a);for(const [lo,hi]of W.sharedIntervals(a,b,supports))if(hi-lo>1e-7)pairs.push([at(a,u,lo),at(a,u,hi)]);}
 }
 return runs(pairs);
}
function partition(faces,pairs,variant=0,width=.1524,segments=boundaries(faces),finishColor,options={}){
 if(!Number.isFinite(width)||width<=K.CONTACT)throw Error('Enter a positive trim width.');
 const cutters=new Map(),cornerPairs=[];
 for(const pair of runs(pairs,segments)){
  const dir=sub(pair[1],pair[0]),length=Math.hypot(dir.x,dir.y,dir.z);if(length<K.CONTACT)continue;
  const owners=[];
  for(const face of faces){
   if(face.deleted||face.snapOnly||face.feature||face.curvedSurface)continue;
   const frame=W.faceFrame(face);if(!frame)continue;
   if(pair.some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>K.CONTACT))continue;
   const local={points:face.points.map(p=>W.inFrame(frame,p)),holes:(face.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))};
   let [a,b]=pair.map(p=>W.inFrame(frame,p));
   // A canonical direction makes cycling independent of edge winding.
   if(a.x>b.x+K.CONTACT||Math.abs(a.x-b.x)<=K.CONTACT&&a.y>b.y)[a,b]=[b,a];
   const l=Math.hypot(b.x-a.x,b.y-a.y),u={x:(b.x-a.x)/l,y:(b.y-a.y)/l},v={x:-u.y,y:u.x};
   // Local polygon frames can run in opposite directions across a shared line.
   // Choose the trim side in world space so coplanar owners agree: upward for
   // horizontal/sloping runs, then positive X/Y for a vertical run.
   const across={x:frame.u.x*v.x+frame.v.x*v.y,y:frame.u.y*v.x+frame.v.y*v.y,z:frame.u.z*v.x+frame.v.z*v.y};
   const side=Math.abs(across.z)>1e-8?across.z:Math.abs(across.x)>1e-8?across.x:across.y;
   if(side<0){v.x=-v.x;v.y=-v.y;}
   const box=(lo,hi,start,end)=>({points:[[start,lo],[end,lo],[end,hi],[start,hi]].map(([x,y])=>({x:a.x+u.x*x+v.x*y,y:a.y+u.y*x+v.y*y})),holes:[]});
   // A narrow finite probe requires actual contact with this selected segment.
   if(!K.intersection([local],[box(-.0001,.0001,0,l)]).some(f=>K.area(f)>1e-10))continue;
   const coordinates=local.points.map(p=>({x:(p.x-a.x)*u.x+(p.y-a.y)*u.y,y:(p.x-a.x)*v.x+(p.y-a.y)*v.y}));
   owners.push({face,frame,local,box,coordinates,length:l});
  }
  // Classify each supporting plane separately. A return/soffit touching a
  // divider must not turn the two coplanar wall regions into a corner.
  for(const owner of owners){
   const sheet=owners.filter(o=>Math.abs(dot(owner.frame.n,o.frame.n))>=.99999);
   const sides=sheet.flatMap(o=>o.coordinates.map(p=>p.y));
   owner.perimeter=!sides.some(y=>y>K.CONTACT)||!sides.some(y=>y<-K.CONTACT);
  }
  const corner=owners.some(o=>o.perimeter&&owners.some(b=>b!==o&&b.perimeter&&Math.abs(dot(o.frame.n,b.frame.n))<.99999));cornerPairs.push(corner);
  for(const owner of owners){
   const {face,frame,local,box,coordinates,length:runLength}=owner;
   if(!eligibleMaterial(face,options))continue;
   let lo=variant===1?-width:variant===2?-width/2:0,hi=variant===1?0:variant===2?width/2:width;
   // Perimeter edges have only an inward side; corners get a full strip on each wall.
   if(owner.perimeter){
    const positive=coordinates.reduce((s,p)=>s+p.y,0)>=0;lo=positive?0:-width;hi=positive?width:0;
   }
   const cut=box(lo,hi,0,runLength),parts=K.intersection([local],[cut]);if(!parts.length)continue;
   let entry=cutters.get(face);if(!entry){entry={face,frame,local,strips:[]};cutters.set(face,entry);}
   entry.strips.push({parts,id:'trim:'+K.edgeKey(...pair),pair:pair.map(p=>({...p})),width,variant,material:Math.abs(dir.z)/length>.707?'trim-vertical':'trim-horizontal'});
  }
 }
 const replacements=[];
 for(const {face,frame,local,strips}of cutters.values()){
  const previous=face.trimData,base=previous?.base||{material:face.material,finishColor:face.finishColor,trim:!!face.trim};
  let cells=[{...local,layers:previous?.layers||[]}];
  for(const strip of strips){const next=[];for(const cell of cells){
   next.push(...K.difference(cell,strip.parts).map(p=>({...p,layers:cell.layers})));
   const layer={id:strip.id,pair:strip.pair,width:strip.width,variant:strip.variant,material:strip.material,finishColor:finishColor|| (face.trim?face.finishColor:undefined)};
   next.push(...K.intersection([cell],strip.parts).map(p=>({...p,layers:[...cell.layers.filter(l=>l.id!==layer.id),layer]})));
  }cells=next;}
  const pieces=cells.map(({layers,...p})=>{const top=layers.at(-1);return {...p,material:top?.material||face.material,finishColor:top?top.finishColor:face.finishColor,trim:top?true:face.trim,trimData:{host:previous?.host||face.id,base,layers}};});
  const total=pieces.reduce((s,p)=>s+K.area(p),0);if(Math.abs(total-K.area(local))>1e-5)throw Error('Trim could not preserve the complete face.');
  replacements.push({face,pieces:pieces.filter(f=>K.area(f)>1e-10).map((p,i)=>({...face,...p,id:face.id+'-trim-'+i,draft:false,points:p.points.map(q=>W.fromFrame(frame,q)),holes:(p.holes||[]).map(r=>r.map(q=>W.fromFrame(frame,q)))}))});
 }
 return {replacements,corner:cornerPairs.some(Boolean)};
}
// Recover source edges for trim saved by the previous format. Original consumed
// draft regions are the preferred evidence; shared corner edges are next.
function adoptLegacy(faces,supports=[]){
 const root=f=>String(f.id).split('-trim-')[0],hosts=new Set(faces.filter(f=>f.trim&&!f.trimData&&String(f.id).includes('-trim-')).map(root));
 return faces.map(face=>{
  const host=root(face);if(face.trimData||!hosts.has(host))return face;
  const original=supports.find(f=>f.id===host),neighbor=faces.find(f=>root(f)===host&&!f.trim),base={material:original?.material||neighbor?.material,finishColor:original?.finishColor||neighbor?.finishColor,trim:false};
  if(!face.trim)return {...face,trimData:{host,base,layers:[]}};
  const edges=boundaries([face]),length=pair=>{const d=sub(pair[1],pair[0]);return Math.hypot(d.x,d.y,d.z);},normal=W.faceFrame(face).n;
  const corners=faces.filter(f=>f!==face&&Math.abs(dot(normal,W.faceFrame(f)?.n||normal))<.99999),contacts=edges.filter(pair=>length(pair)>=Math.max(...edges.map(length))*.5&&W.sharedIntervals(...pair,original?[original]:corners).some(([lo,hi])=>hi-lo>.999));
  const choices=(contacts.length?contacts:edges).sort((a,b)=>length(b)-length(a)||((a[0].z+a[1].z)-(b[0].z+b[1].z))||((a[0].x+a[1].x)-(b[0].x+b[1].x))||((a[0].y+a[1].y)-(b[0].y+b[1].y))),pair=choices[0];
  if(!pair)return face;return {...face,trimData:{host,base,layers:[{id:'trim:'+K.edgeKey(...pair),pair:pair.map(p=>({...p})),material:face.material,finishColor:face.finishColor,variant:0,width:.1524}]}};
 });
}
function remove(faces,selected){
 const layer=selected?.trimData?.layers?.at(-1);if(!layer)return null;
 const hosts=new Set(faces.filter(f=>f.trimData?.layers?.some(l=>l.id===layer.id)).map(f=>f.trimData.host)),groups=[];
 for(const face of faces){if(!hosts.has(face.trimData?.host))continue;
  const data=face.trimData,layers=data.layers.filter(l=>l.id!==layer.id),removed=layers.length!==data.layers.length,top=layers.at(-1);
  const material=removed?(top?.material||data.base.material):face.material,finishColor=removed?(top?top.finishColor:data.base.finishColor):face.finishColor,trim=removed?(!!top||data.base.trim):face.trim;
  const key=JSON.stringify([data.host,layers,material,finishColor,!!trim]),frame=W.faceFrame(face);
  let group=groups.find(g=>g.key===key&&face.points.every(p=>Math.abs(dot(sub(p,g.frame.origin),g.frame.n))<K.CONTACT));
  if(!group){group={key,frame,faces:[],material,finishColor,trim,data:{...data,layers}};groups.push(group);}group.faces.push(face);
 }
 const replacements=[];
 for(const group of groups){const {frame}=group,local=f=>({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))}),united=K.union(group.faces.map(local));
  const pieces=united.map((p,i)=>({...group.faces[0],id:group.faces[0].id+'-untrim-'+i,draft:false,material:group.material,finishColor:group.finishColor,trim:group.trim,trimData:group.data,points:p.points.map(p=>W.fromFrame(frame,p)),holes:p.holes.map(r=>r.map(p=>W.fromFrame(frame,p)))}));
  group.faces.forEach((face,i)=>replacements.push({face,pieces:i?[]:pieces}));
 }
 return {replacements,pairs:[layer.pair]};
}
const api={materialKey,defaultMaterial,runs,candidates,groundCandidates,partition,adoptLegacy,remove,defaultWidth:.1524};if(common)module.exports=api;else root.WallTrim=api;
})(typeof window!=='undefined'?window:globalThis);
