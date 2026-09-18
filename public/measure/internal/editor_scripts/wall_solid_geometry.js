/* Arbitrary planar face extrusion, independent of the vertical wall model. */
(function(root){
const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
function normal(points){return K.normal(points);}
// Chamfers are finite local cuts, never infinite planes across the house.
// All selected edges/vertices participate in one operation so their patches
// are trimmed against one another before the shared corner is closed.
// Base contacts use the same 2 mm height tolerance as extrusion attachment.
// XY must lie on the actual boundary: nearby independent lines stay separate.
function bindSharedBase(faces){
 const bases=faces.filter(f=>f.baseFaceId!=null||f.baseId!=null),edges=bases.flatMap(f=>rings(f).flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]])));
 const point=p=>{let nearest=null,error=.002;for(const [a,b]of edges){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<K.CONTACT*K.CONTACT)continue;const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;if(t<0||t>1||Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)>K.CONTACT)continue;const q=mix3(a,b,t),d=Math.abs(p.z-q.z);if(d<error){nearest=q;error=d;}}return nearest?{...p,...nearest}:p;};
 return {point,faces:faces.map(f=>f.baseFaceId!=null||f.baseId!=null?f:{...f,points:f.points.map(point),holes:(f.holes||[]).map(r=>r.map(point)),retainedPoints:(f.retainedPoints||[]).map(point)})};
}
// Resolve selected visual runs against all face intervals, not a count of
// records owning the complete run. Splits and duplicate records are normal.
function chamferSelection(scene,selection){
 const edges=[];for(const [a,b] of selection.edges||[]){const v=sub(b,a),l=Math.hypot(v.x,v.y,v.z);if(l<=K.CONTACT)continue;const ts=[0,1];for(const f of scene)if(!f.deleted&&!f.snapOnly)for(const [lo,hi]of sharedIntervals(a,b,[f]))ts.push(lo,hi);ts.sort((a,b)=>a-b);const cuts=ts.filter((t,i)=>!i||(t-ts[i-1])*l>K.CONTACT);for(let i=1;i<cuts.length;i++)edges.push([mix3(a,b,cuts[i-1]),mix3(a,b,cuts[i])]);}
 return {...selection,edges:[...new Map(edges.map(pair=>[edgeKey(...pair),pair])).values()]};
}
function fillet(scene,selection,depth,angleOffset=0,rotation=0){return chamfer(scene,{...selection,rounded:true},depth,angleOffset,rotation);}
function chamfer(scene,selection,depth,angleOffset=0,rotation=0){
 const originalScene=scene,originalById=new Map(scene.map(f=>[f.id,f])),bound=bindSharedBase(scene);scene=bound.faces;selection={...selection,edges:(selection.edges||[]).map(pair=>pair.map(bound.point)),points:(selection.points||[]).map(bound.point)};const topology=K.topology(scene.filter(f=>!f.deleted&&!f.snapOnly));
 const snap=p=>({...p,...(topology.vertexAt(p)?.point||p)}),normalized=[];
 scene=scene.map(f=>{const next={...f,points:f.points.map(snap),holes:(f.holes||[]).map(r=>r.map(snap)),retainedPoints:(f.retainedPoints||[]).map(snap)};if((originalById.get(f.id)||f).points.some((p,i)=>Math.hypot(p.x-next.points[i].x,p.y-next.points[i].y,p.z-next.points[i].z)>1e-12))normalized.push(next);return next;});
 selection=chamferSelection(scene,{...selection,edges:(selection.edges||[]).map(pair=>pair.map(snap)),points:(selection.points||[]).map(snap)});
 if(!Number.isFinite(depth)||depth<0)throw Error('Chamfer depth must be zero or positive.');
 let angle=angleOffset,zero;
 try{zero=buildChamfer(scene,selection,0,angle,rotation);}catch(error){
  if(!(selection.points||[]).length)throw error;
  zero=buildChamfer(scene,selection,0,0,rotation);let lo=0,hi=1;
  for(let i=0;i<12;i++){const t=(lo+hi)/2;try{buildChamfer(scene,selection,0,angleOffset*t,rotation);lo=t;}catch{hi=t;}}
  angle=angleOffset*lo;
 }
 const result=(value,amount)=>{value={...value,metrics:value.metrics.map(m=>({...m,limited:!!m.limited||(m.amount??amount)<depth-K.CONTACT||Math.abs(angle-angleOffset)>1e-5}))};const edgeLimited=value.metrics?.some(m=>m.limited);if(amount<=K.CONTACT)return {...value,faces:originalScene,amount,requestedAmount:depth,angleOffset:angle,limited:!!edgeLimited||amount<depth-K.CONTACT||Math.abs(angle-angleOffset)>1e-5};const replaced=new Set(value.replacements.map(r=>r.face.id));return {...value,replacements:[...value.replacements.map(r=>({...r,face:originalById.get(r.face.id)||r.face})),...normalized.filter(f=>!f.chamferSupportOnly&&!replaced.has(f.id)).map(f=>({face:originalById.get(f.id),pieces:[f]}))],amount,requestedAmount:depth,angleOffset:angle,limited:!!edgeLimited||amount<depth-K.CONTACT||Math.abs(angle-angleOffset)>1e-5};};
 if(depth<=K.CONTACT)return result(buildChamfer(scene,selection,depth,angle,rotation),depth);
 try{return result(buildChamfer(scene,selection,depth,angle,rotation),depth);}catch{}
 // Bounded fitting keeps oversized drags live. Always rebuild from the original
 // scene, so approaching a limit never accumulates clipping or undo mutations.
 let lo=0,hi=depth,best=zero;
 for(let i=0,probe=depth/2;i<18&&probe>K.CONTACT;i++,probe/=2){try{const candidate=buildChamfer(scene,selection,probe,angle,rotation);if(candidate.additions.length){lo=probe;best=candidate;break;}}catch{}hi=probe;}
 if(lo)for(let i=0;i<12&&hi-lo>Math.max(K.CONTACT,depth*1e-5);i++){const probe=(lo+hi)/2;try{const candidate=buildChamfer(scene,selection,probe,angle,rotation);if(!candidate.additions.length)break;lo=probe;best=candidate;}catch{hi=probe;}}
 // Grow each edge from the valid common fit, rebuilding all shared corners.
 if(lo>K.CONTACT&&(selection.edges||[]).length>1){
  const amounts=selection.edges.map(()=>lo);
  for(let pass=0;pass<2;pass++)for(let edge=0;edge<amounts.length;edge++){
   let lower=amounts[edge],upper=depth;
   const attempt=value=>buildChamfer(scene,{...selection,edgeAmounts:amounts.map((a,i)=>i===edge?value:a)},depth,angle,rotation);
   try{best=attempt(depth);amounts[edge]=depth;continue;}catch{}
   for(let i=0;i<12&&upper-lower>Math.max(K.CONTACT,depth*1e-5);i++){const probe=(lower+upper)/2;try{const candidate=attempt(probe);if(!candidate.additions.length)break;best=candidate;lower=probe;}catch{upper=probe;}}
   amounts[edge]=lower;
  }
  best=buildChamfer(scene,{...selection,edgeAmounts:amounts},depth,angle,rotation);
  return result(best,Math.max(...amounts));
 }
 return result(best,lo);
}
// Snap chamfer shoulders to target points along lines parallel to the source edge.
function chamferSnap(metrics,points,amount,angle,screen,radius=10,adjustAngle=false){
 const candidates=[];
 for(const m of metrics){if(!m.axis||m.shoulders.length!==2||m.limited)continue;
  const axis=m.axis,origin=m.origin,dirs=m.shoulders.map(p=>{const v=sub(p,origin),l=Math.hypot(v.x,v.y,v.z);return l>K.CONTACT?{x:v.x/l,y:v.y/l,z:v.z/l}:null;});if(dirs.some(d=>!d))continue;
  const sides=dirs.map((dir,side)=>points.flatMap(target=>{const v=sub(target,origin),along=dot(v,axis),radial={x:v.x-axis.x*along,y:v.y-axis.y*along,z:v.z-axis.z*along},setback=dot(radial,dir);if(setback<=K.CONTACT||Math.hypot(radial.x-dir.x*setback,radial.y-dir.y*setback,radial.z-dir.z*setback)>K.CONTACT)return [];
   const current={x:m.shoulders[side].x+axis.x*along,y:m.shoulders[side].y+axis.y*along,z:m.shoulders[side].z+axis.z*along},a=screen(current),b=screen(target),pixels=Math.hypot(a.x-b.x,a.y-b.y);if(a.visible===false||b.visible===false||!Number.isFinite(pixels)||pixels>radius||Math.abs(setback-m.distances[side])>.5)return [];
   return [{target,current,setback,pixels,side,origin,axis}];
  }).sort((a,b)=>a.pixels-b.pixels).slice(0,3));
  const flat=dot(dirs[0],dirs[1])<-.999;
  for(const side of sides)for(const c of side){
   if(!adjustAngle)candidates.push({amount:amount*c.setback/m.distances[c.side],angle,targets:[c],score:c.pixels+radius});
   else {const sideAngle=(flat?Math.atan(amount/c.setback):Math.asin(amount/c.setback))*180/Math.PI,next=angle+(c.side===0?1:-1)*(sideAngle-m.angles[c.side]);if(Number.isFinite(next)&&Math.abs(next-angle)<=5)candidates.push({amount,angle:next,targets:[c],score:c.pixels+radius});}
  }
  const total=m.angles[0]+m.angles[1];
  if(total>=179)continue;
  for(const a of sides[0])for(const b of sides[1]){const alpha=(flat?Math.atan(Math.sqrt(b.setback/a.setback)):Math.atan2(b.setback*Math.sin(total*Math.PI/180),a.setback+b.setback*Math.cos(total*Math.PI/180)))*180/Math.PI,nextAngle=angle+alpha-m.angles[0];if(Math.abs(nextAngle-angle)>5||alpha<1||alpha>total-1)continue;
   const depth=flat?Math.sqrt(a.setback*b.setback):a.setback*Math.sin(alpha*Math.PI/180);candidates.push({amount:depth,angle:nextAngle,targets:[a,b],score:Math.max(a.pixels,b.pixels)});
  }
 }
 return candidates.sort((a,b)=>a.score-b.score)[0]||null;
}
function pointChamferSnap(metrics,points,amount,angle,rotation,screen,radius=10){
 const choices=[];
 for(const m of metrics){if(!m.pointBasis||m.limited)continue;const {baseline,u,v,n}=m.pointBasis;
  const sides=m.shoulders.map((p,side)=>{const ray=sub(p,m.origin),len=Math.hypot(ray.x,ray.y,ray.z);if(len<=K.CONTACT)return [];const dir={x:ray.x/len,y:ray.y/len,z:ray.z/len};return points.flatMap(target=>{const delta=sub(target,m.origin),setback=dot(delta,dir);if(setback<=K.CONTACT||Math.hypot(delta.x-dir.x*setback,delta.y-dir.y*setback,delta.z-dir.z*setback)>K.CONTACT||Math.abs(setback-len)>.5)return [];const a=screen(p),b=screen(target),pixels=Math.hypot(a.x-b.x,a.y-b.y);return a.visible!==false&&b.visible!==false&&pixels<=radius?[{target,origin:m.origin,side,setback,pixels}]:[];}).sort((a,b)=>a.pixels-b.pixels).slice(0,2);});
  for(const list of sides)for(const c of list)choices.push({amount:amount*c.setback/m.distances[c.side],angle,rotation,targets:[c],score:radius*3+c.pixels});
  if(sides.length!==3)continue;
  for(const a of [null,...sides[0]])for(const b of [null,...sides[1]])for(const c of [null,...sides[2]]){const targets=[a,b,c].filter(Boolean);if(targets.length<2)continue;const ps=[a,b,c].map((t,i)=>t?.target||m.shoulders[i]);let normal0=normal(ps);if(!normal0)continue;if(dot(normal0,baseline)<0)normal0={x:-normal0.x,y:-normal0.y,z:-normal0.z};if(Math.acos(Math.min(1,Math.max(-1,dot(normal0,n))))*180/Math.PI>5)continue;
   const tilt=Math.acos(Math.min(1,Math.max(-1,dot(normal0,baseline))))*180/Math.PI,azimuth=Math.atan2(dot(normal0,v),dot(normal0,u))*180/Math.PI,depth=dot(normal0,sub(ps[0],m.origin));if(depth<=K.CONTACT)continue;
   choices.push({amount:depth,angle:tilt,rotation:azimuth,targets,score:(3-targets.length)*radius+Math.max(...targets.map(t=>t.pixels))});
  }
 }
 return choices.sort((a,b)=>a.score-b.score)[0]||null;
}
function buildChamfer(scene,selection,depth,angleOffset=0,rotation=0){
 const requestedDepth=depth;
 const faces=scene.filter(f=>!f.deleted&&!f.snapOnly),unit=v=>{const l=Math.hypot(v.x,v.y,v.z);if(l<K.CONTACT)throw Error('The selected corner is degenerate.');return {x:v.x/l,y:v.y/l,z:v.z/l};},add=(a,b,s=1)=>({x:a.x+b.x*s,y:a.y+b.y*s,z:a.z+b.z*s}),distance=(a,b)=>Math.hypot(...Object.values(sub(a,b))),same=(a,b)=>distance(a,b)<=K.CONTACT;
 if(!Number.isFinite(depth)||depth<0)throw Error('Chamfer depth must be zero or positive.');
 const on=(p,a,b)=>{const v=sub(b,a),l2=dot(v,v),t=l2?dot(sub(p,a),v)/l2:-1;return t>=-1e-6&&t<=1+1e-6&&distance(p,add(a,v,t))<=K.CONTACT;};
 const touches=(f,p)=>[f.points,...(f.holes||[])].some(r=>r.some((a,i)=>on(p,a,r[(i+1)%r.length])));
 const center=ps=>ps.reduce((c,p)=>add(c,p,1/ps.length),{x:0,y:0,z:0});
 const oriented=(ps,inside)=>{let n=normal(ps);if(!n)throw Error('The chamfer would have no area.');if(dot(n,sub(inside,ps[0]))<0)n={x:-n.x,y:-n.y,z:-n.z};return {n,k:dot(n,ps[0])};};
 const pyramid=(origin,ring)=>{const inside=center([origin,...ring]);return [oriented(ring,inside),...ring.map((a,i)=>oriented([origin,a,ring[(i+1)%ring.length]],inside))];};
 const ordered=ps=>{const c=center(ps),frame=K.frame({points:ps});if(!frame)throw Error('Select a corner joining at least three non-coplanar edges.');return ps.slice().sort((a,b)=>{const x=K.local(frame,a),y=K.local(frame,b),o=K.local(frame,c);return Math.atan2(x.y-o.y,x.x-o.x)-Math.atan2(y.y-o.y,y.x-o.x);});};
 const polygonArea=f=>{const frame=K.frame(f);return frame?K.area({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))}):0;};
 const cut=(parts,cutter)=>parts.flatMap(f=>{if(cutter.corner){
  // Shared wall/roof vertices can differ by sub-micron rounding. A cutter
  // boundary coincident with this face is contact, not a half-space that may
  // discard the whole face before its corner mask is applied.
  const planes=cutter.planes.filter(p=>!f.points.every(q=>Math.abs(dot(p.n,q)-p.k)<=K.CONTACT));
  if(!volumeSection(f,planes).some(p=>polygonArea(p)>1e-10))return [f];
  const frame=K.frame(f),coplanar=cutter.masks.find(r=>r.every(p=>Math.abs(K.local(frame,p).z)<=K.CONTACT));
  const masks=coplanar?[{points:coplanar.map(p=>K.local(frame,p)),holes:[]}]:cutter.patches.flatMap(p=>K.surfaceFacets(p)).flatMap(p=>volumeSection(f,pyramid(cutter.corner,p.points))).map(p=>({points:p.points.map(p=>K.local(frame,p)),holes:(p.holes||[]).map(r=>r.map(p=>K.local(frame,p)))}));
  const local={points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))};
  return K.difference(local,K.union(masks)).map(p=>({...f,points:p.points.map(p=>K.world(frame,p)),holes:p.holes.map(r=>r.map(p=>K.world(frame,p)))}));
 }const planes=cutter.planes.filter(p=>!(p.end||cutter.owners?.includes(f.id))||!f.points.every(q=>Math.abs(dot(p.n,q)-p.k)<=K.CONTACT));return volumeSection(f,planes).some(p=>polygonArea(p)>1e-10)?volumeSection(f,planes,true).flatMap(p=>{try{K.validateFace(p);return [p];}catch{return planarUnion([p]);}}):[f];});
  const straightRings=f=>[f.points,...(f.holes||[])].map(r=>r.filter((p,i)=>{const a=r[(i+r.length-1)%r.length],b=r[(i+1)%r.length];return !on(p,a,b);}));
 const cutters=[],metrics=[],vertices=[],openBoundaries=[];
 const register=(p,edge)=>{let v=vertices.find(v=>same(v.p,p));if(!v){v={p,edges:[]};vertices.push(v);}v.edges.push(edge);};
 for(const [edgeIndex,pair] of (selection.edges||[]).entries()){
  let depth=selection.edgeAmounts?.[edgeIndex]??requestedDepth;
  const appliedAmount=depth;
  let [a,b]=pair;if(vertexKey(a)>vertexKey(b))[a,b]=[b,a];const axis=unit(sub(b,a)),mid=center([a,b]);
  const candidates=[];
  for(const f of faces){if(sharedIntervals(a,b,[f]).reduce((s,[lo,hi])=>s+hi-lo,0)>1-1e-5){candidates.push(f);continue;}
   const frame=K.frame(f);if(!frame||[a,b,mid].some(p=>Math.abs(K.local(frame,p).z)>K.CONTACT))continue;
   const local={points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))};
   if(![a,b,mid].every(p=>{const q=K.local(frame,p);return pointInRing(q,local.points)&&!local.holes.some(r=>pointInRing(q,r)&&!r.some((a,i)=>pointOnEdge(q,a,r[(i+1)%r.length])))||touches(f,p);}))continue;
   const n=unit(cross(axis,frame.n));for(const sign of [-1,1]){const plane={n:{x:n.x*sign,y:n.y*sign,z:n.z*sign},k:dot(n,a)*sign};candidates.push(...volumeSection(f,[plane]));}
  }
  const groups=[];
  for(const f of candidates){let direction=unit(cross(axis,normal(f.points)));const frame=K.frame(f),local=f.points.map(p=>K.local(frame,p));if(!pointInRing(K.local(frame,add(mid,direction,.0001)),local))direction={x:-direction.x,y:-direction.y,z:-direction.z};let group=groups.find(g=>dot(g.direction,direction)>1-1e-6);if(!group){group={direction,faces:[]};groups.push(group);}group.faces.push(f);}
  let selected=groups;
  if(groups.length>2){let best=-1;for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){const angle=Math.acos(Math.max(-1,Math.min(1,dot(groups[i].direction,groups[j].direction)))),score=Math.sin(angle);if(score>best){best=score;selected=[groups[i],groups[j]];}}}
  if(!selected.length)throw Error('The selected line has no supporting surface.');
  const owners=selected.map(g=>planarUnion(g.faces).find(f=>sharedIntervals(a,b,[f]).reduce((s,[lo,hi])=>s+hi-lo,0)>1-1e-5)||g.faces[0]),directions=selected.map(g=>g.direction);
  if(owners.length===1){const f=owners[0],n=normal(f.points),ps=faces.flatMap(f=>f.points),c=center(ps),extent=Math.max(1,...ps.map(p=>distance(p,mid)))*2,sign=dot(n,sub(c,mid))>=0?1:-1,d={x:n.x*sign,y:n.y*sign,z:n.z*sign};owners.push({points:[b,a,add(a,d,extent),add(b,d,extent)],holes:[],virtualChamferSupport:true});directions.push(d);}
  const theta=Math.acos(Math.max(-1,Math.min(1,dot(...directions))))*180/Math.PI,flat=180-theta<2,total=flat?90:180-theta;
  const alpha=Math.max(1,Math.min(total-1,total/2+angleOffset)),beta=total-alpha;
  if(selection.widthMode){const u=1/(flat?Math.tan(alpha*Math.PI/180):Math.sin(alpha*Math.PI/180)),v=1/(flat?Math.tan(beta*Math.PI/180):Math.sin(beta*Math.PI/180));depth/=Math.sqrt(u*u+v*v-2*u*v*Math.cos(theta*Math.PI/180));}
  const s1=depth/(flat?Math.tan(alpha*Math.PI/180):Math.sin(alpha*Math.PI/180)),s2=depth/(flat?Math.tan(beta*Math.PI/180):Math.sin(beta*Math.PI/180));
  const fn=normal(owners[0].points),fc=center(faces.flatMap(f=>f.points)),inward=dot(fn,sub(fc,mid))>K.CONTACT?fn:{x:-fn.x,y:-fn.y,z:-fn.z},ridgeA=add(a,inward,depth),ridgeB=add(b,inward,depth);
  // Follow each owner's actual boundary at the setback. The adjoining edges
  // need not be perpendicular, and an open wall need not have a roof cap face.

  const boundary=(owner,q,origin)=>{
   // Find the actual incident rays before consulting a merged face outline.
   // Coplanar unions may erase the vertex where a sloping seam meets this edge.
   const frame0=K.frame(owner),offset=sub(q,origin),offsetLength=Math.hypot(offset.x,offset.y,offset.z),incident=[];let hasIncidentDirection=false;
   if(offsetLength>K.CONTACT)for(const f of faces)for(const ring of straightRings(f))for(let j=0;j<ring.length;j++){const u=ring[j],v=ring[(j+1)%ring.length];if(!on(origin,u,v))continue;for(const end of [u,v]){const ray=sub(end,origin),length=Math.hypot(ray.x,ray.y,ray.z);if(length<K.CONTACT||Math.abs(K.local(frame0,end).z)>K.CONTACT)continue;const projection=dot(ray,offset)/offsetLength;if(projection<=K.CONTACT)continue;hasIncidentDirection=true;const t=offsetLength/projection;if(t>1+1e-6)continue;const point=add(origin,ray,t);if(!incident.some(p=>same(p,point)))incident.push(point);}}
   if(incident.length){incident.sort((p,q)=>distance(p,origin)-distance(q,origin));return incident[0];}if(hasIncidentDirection)throw Error('Chamfer reaches the end of an adjoining edge.');
   let before=false,after=false;for(const ring of [owner.points,...(owner.holes||[])])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if(on(origin,a,b)&&Math.abs(dot(unit(sub(b,a)),axis))>1-1e-6)for(const p of [a,b]){const t=dot(sub(p,origin),axis);before ||= t<-K.CONTACT;after ||= t>K.CONTACT;}}if(before&&after)return q;const frame=K.frame(owner),o=K.local(frame,q),av=K.local(frame,add(q,axis)),v={x:av.x-o.x,y:av.y-o.y},hits=[],localHits=[];
   for(const ring of [owner.points,...(owner.holes||[])])for(let i=0;i<ring.length;i++){const a=K.local(frame,ring[i]),b=K.local(frame,ring[(i+1)%ring.length]),w={x:b.x-a.x,y:b.y-a.y},den=v.x*w.y-v.y*w.x;if(Math.abs(den)<1e-5*Math.hypot(w.x,w.y))continue;const local=on(origin,ring[i],ring[(i+1)%ring.length]);const dx=a.x-o.x,dy=a.y-o.y,t=(dx*w.y-dy*w.x)/den,u=(dx*v.y-dy*v.x)/den;if(u>=-1e-6&&u<=1+1e-6){const hit=add(q,axis,t);hits.push(hit);if(local)localHits.push(hit);}}if(localHits.length){localHits.sort((p,q)=>distance(p,origin)-distance(q,origin));return localHits[0];}
   const start=same(origin,a),eligible=hits.filter(p=>start?dot(sub(p,mid),axis)<=K.CONTACT:dot(sub(p,mid),axis)>=-K.CONTACT);eligible.sort((p,q)=>start?dot(sub(q,p),axis):dot(sub(p,q),axis));if(!eligible.length)throw Error('Chamfer is too deep for these edges. Reduce the depth.');return eligible[0];};
  const endpoint=(origin)=>directions.map((d,i)=>depth>K.CONTACT?boundary(owners[i],add(origin,d,i?s2:s1),origin):origin);
  const [u,v]=endpoint(a),[du,dv]=endpoint(b);
  const endPlane=ps=>{const plane=oriented(ps,mid);return {...plane,end:true};};const startPlanes=depth>K.CONTACT?[endPlane([flat?ridgeA:a,u,v])]:[],finishPlanes=depth>K.CONTACT?[endPlane([flat?ridgeB:b,du,dv])]:[];
  const edge={a,b,owners,directions,alpha,beta,s1,s2};register(a,edge);register(b,edge);
  if(depth>K.CONTACT){
   if(dot(sub(du,u),axis)<=K.CONTACT||dot(sub(dv,v),axis)<=K.CONTACT)throw Error('Chamfer is too deep for these edges. Reduce the depth.');
   // An open roof/base boundary stays open; do not invent triangular cap faces.
   for(const [origin,p,q] of [[a,u,v],[b,du,dv]])if(!faces.some(f=>!owners.includes(f)&&touches(f,origin)))openBoundaries.push({points:[p,q]});
   if(selection.rounded&&!flat){
    const weight=Math.sin(theta*Math.PI/360),start={type:'conic',start:u,control:a,end:v,weight},finish={type:'conic',start:du,control:b,end:dv,weight},section={type:'conic',start:add(a,directions[0],s1),control:a,end:add(a,directions[1],s2),weight},samples=K.curveSamples(section,.001);
    for(let j=1;j<samples.length;j++){const lo=samples[j-1].curveT,hi=samples[j].curveT,points=[K.curvePoint(start,lo),K.curvePoint(start,hi),K.curvePoint(finish,hi),K.curvePoint(finish,lo)];cutters.push({owners:selected.flatMap(g=>g.faces.map(f=>f.id)),planes:[...prismPlanes([a,samples[j-1],samples[j]],axis),...startPlanes,...finishPlanes],patches:[{points,holes:[],material:owners[0].material,finishColor:owners[0].finishColor,fillet:true,curvedSurface:{type:'conic-ruled',start,finish,range:[lo,hi]}}]});}
   }else{
   cutters.push({owners:selected.flatMap(g=>g.faces.map(f=>f.id)),planes:[...prismPlanes([flat?ridgeA:a,add(a,directions[0],s1),add(a,directions[1],s2)],axis),...startPlanes,...finishPlanes],patches:(flat?[[u,ridgeA,ridgeB,du],[ridgeA,v,dv,ridgeB]]:[[u,v,dv,du]]).map(points=>({points,holes:[],material:owners[0].material,finishColor:owners[0].finishColor,chamfer:true}))});
   }
  }
  metrics.push({amount:appliedAmount,limited:appliedAmount<requestedDepth-K.CONTACT,axis,origin:mid,shoulders:[add(mid,directions[0],s1),add(mid,directions[1],s2)],angles:[alpha,beta],distances:[s1,s2],center:flat?add(mid,inward,depth):center([add(mid,directions[0],s1),add(mid,directions[1],s2)])});
 }
 for(const origin of selection.points||[]){
  let depth=requestedDepth;
  const owners=faces.filter(f=>touches(f,origin)),directions=[];
  for(const f of owners)for(const ring of straightRings(f))for(let i=0;i<ring.length;i++)if(on(origin,ring[i],ring[(i+1)%ring.length]))for(const p of [ring[i],ring[(i+1)%ring.length]])if(distance(origin,p)>K.CONTACT){const d=unit(sub(p,origin));if(!directions.some(q=>dot(d,q)>1-1e-8))directions.push(d);}
  directions.sort((a,b)=>vertexKey(a).localeCompare(vertexKey(b)));
  if(directions.length<3)throw Error('Select a corner joining at least three non-coplanar edges.');
  const baseline=unit(directions.reduce((sum,d)=>add(sum,d),{x:0,y:0,z:0})),u=unit(sub(directions[0],add({x:0,y:0,z:0},baseline,dot(directions[0],baseline)))),v=cross(baseline,u),azimuth=rotation*Math.PI/180,tilt=angleOffset*Math.PI/180;
  const n=unit(add(add({x:0,y:0,z:0},baseline,Math.cos(tilt)),add(add({x:0,y:0,z:0},u,Math.cos(azimuth)),v,Math.sin(azimuth)),Math.sin(tilt)));
  if(directions.some(d=>dot(n,d)<=.02))throw Error('This corner cannot be chamfered at that angle.');
  if(selection.widthMode){const unitShoulders=directions.map(d=>add(origin,d,1/dot(n,d)));depth/=Math.max(...unitShoulders.flatMap((p,i)=>unitShoulders.slice(i+1).map(q=>distance(p,q))));}
  const shoulders=directions.map(d=>{const reach=Math.min(...owners.flatMap(f=>straightRings(f).flatMap(r=>r.flatMap((p,i)=>on(origin,p,r[(i+1)%r.length])?[p,r[(i+1)%r.length]]:[]))).filter(p=>distance(p,origin)>K.CONTACT&&dot(unit(sub(p,origin)),d)>1-1e-6).map(p=>distance(p,origin)));const setback=depth/dot(n,d);if(depth>K.CONTACT&&setback>=reach-K.CONTACT)throw Error('Corner setback exceeds its adjoining edge.');return add(origin,d,setback);}),ring=depth>K.CONTACT?ordered(shoulders):[];
  if(ring.length){
   if(selection.rounded&&ring.length===3){
    // An affine quadric corner: in shoulder coordinates it lies on
    // (x-1)^2+(y-1)^2+(z-1)^2=2. Its boundary arcs are tangent to
    // the original incident edges, including oblique and unequal setbacks.
    const surface={type:'quadric-corner',origin:{...origin},shoulders:ring.map(p=>({...p}))},size=Math.max(...ring.map(p=>distance(p,origin))),steps=Math.min(48,Math.max(8,Math.ceil(Math.sqrt(size/.001)))),grid=new Map();
    const sample=(i,j)=>{const key=i+','+j;if(!grid.has(key)){const weights=[i,j,steps-i-j].map(x=>(x/steps)**2),sum=weights.reduce((a,b)=>a+b),b=weights.map(x=>x/sum),t=1/(1+Math.sqrt(Math.max(0,1-b.reduce((s,x)=>s+x*x,0))));grid.set(key,b.reduce((p,w,k)=>add(p,sub(ring[k],origin),w*t),{...origin}));}return grid.get(key);};
    const logical=(selection.points||[]).length===1&&!(selection.edges||[]).length;
    const patch=logical?{points:ring,holes:[],material:owners[0]?.material,finishColor:owners[0]?.finishColor,fillet:true,curvedSurface:{...surface,logical:true,domains:[{points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],holes:[]}]}}:null;
    const patches=logical?[patch]:[];if(!logical)for(let i=0;i<steps;i++)for(let j=0;j<steps-i;j++){const triangles=[[sample(i,j),sample(i+1,j),sample(i,j+1)]];if(i+j<steps-1)triangles.push([sample(i+1,j),sample(i+1,j+1),sample(i,j+1)]);for(const points of triangles)patches.push({points,holes:[],material:owners[0]?.material,finishColor:owners[0]?.finishColor,fillet:true,curvedSurface:surface});}
    const masks=logical?K.surfaceBoundaryCurves(patch).flat(2).map(c=>[origin,...K.curveSamples(c)]):[[origin,...Array.from({length:steps+1},(_,i)=>sample(i,0))],[origin,...Array.from({length:steps+1},(_,i)=>sample(0,i))],[origin,...Array.from({length:steps+1},(_,i)=>sample(i,steps-i))]];
    cutters.push({owners:owners.map(f=>f.id),planes:pyramid(origin,ring),corner:origin,masks,patches});
   }else cutters.push({owners:owners.map(f=>f.id),planes:pyramid(origin,ring),patches:[{points:ring,holes:[],material:owners[0]?.material,finishColor:owners[0]?.finishColor,chamfer:true}]});
  }
  metrics.push({pointBasis:{baseline,u,v,n},origin,shoulders,center:center(shoulders),angles:owners.map(f=>Math.acos(Math.min(1,Math.abs(dot(n,normal(f.points)))))*180/Math.PI),distances:shoulders.map(p=>distance(p,origin))});
 }
 if(!metrics.length)throw Error('Select one or more corner edges or corner points.');
 if(depth<=K.CONTACT)return {faces:scene,affected:[],metrics,replacements:[],additions:[]};
 // Offset boundaries on each original face determine the setback at a vertex.
 // Three distinct setbacks enclose a corner patch; two already meet at an edge.
 for(const vertex of vertices.filter(v=>v.edges.length>1&&!v.edges.every(e=>Math.abs(dot(unit(sub(e.b,e.a)),unit(sub(v.edges[0].b,v.edges[0].a))))>1-1e-6))){
  const ps=[];for(const f of faces.filter(f=>touches(f,vertex.p))){let parts=[f];for(const c of cutters)parts=cut(parts,c);const candidates=parts.flatMap(f=>f.points).filter(p=>!same(p,vertex.p)).sort((a,b)=>distance(a,vertex.p)-distance(b,vertex.p));const p=candidates[0],limit=Math.max(...vertex.edges.flatMap(e=>[e.s1,e.s2]))*4;if(p&&distance(p,vertex.p)<limit&&!ps.some(q=>same(p,q)))ps.push(p);}
  if(ps.length>=3){const ring=ordered(ps),frame=K.frame({points:ring});if(ring.every(p=>Math.abs(K.local(frame,p).z)<=K.CONTACT))cutters.push({planes:pyramid(vertex.p,ring),patches:[{points:ring,holes:[],material:vertex.edges[0].owners[0].material,chamfer:true,chamferCorner:true}]});else throw Error('This corner needs a smaller chamfer to keep its joining face planar.');}
 }
 const affected=[],output=[],replacements=[];
 for(const f of faces){if(f.chamferSupportOnly)continue;let parts=[f];for(const c of cutters)parts=cut(parts,c);if(parts.length!==1||Math.abs(polygonArea(f)-polygonArea(parts[0]))>1e-9)affected.push(f.id);
  const mapped=parts.map((p,i)=>({...p,id:i?f.id+'-chamfer-'+i:f.id,retainedPoints:(f.retainedPoints||[]).filter(q=>{const frame=K.frame(p),v=K.local(frame,q);return pointInRing(v,p.points.map(p=>K.local(frame,p)))||touches(p,q);})}));output.push(...mapped);if(affected.includes(f.id))replacements.push({face:f,pieces:mapped});
 }
 let patches=cutters.flatMap((c,i)=>{let ps=c.patches;for(let j=0;j<cutters.length;j++)if(i!==j)ps=cut(ps,cutters[j]);return ps;});
 patches=[...planarUnion(patches.filter(f=>!f.curvedSurface)),...patches.filter(f=>f.curvedSurface)].filter(f=>polygonArea(f)>1e-9).map((f,i)=>({...f,id:'chamfer-'+i,opening:false}));
 for(const f of [...output,...patches])K.validateFace(f);
 // Every new bevel must still touch a surviving source face. This also rejects
 // oversized cuts before they can erase a wall or create detached geometry.
 const {connected,openEnds:openPatch}=chamferConnections(output,patches,openBoundaries);
 if(!patches.length||!connected)throw Error('Chamfer is too deep for these edges. Reduce the depth.');
 return {faces:[...output,...patches],affected,metrics,replacements,additions:patches,openEnds:openPatch};
}
// Fillet tessellation has thousands of shared edges. Resolve exact shared
// edges once; only unmatched boundary edges need tolerant interval matching.
// Reachability still rejects detached patches, including a closed floating shell.
function chamferConnections(output,patches,openBoundaries){
 const faces=[...output,...patches].map(f=>f.curvedSurface?.logical?K.surfaceOutline(f):f),index=new Map(),adjacency=faces.map(()=>new Set()),bounds=faces.map(f=>{
  const ps=rings(f).flat();return {lo:{x:Math.min(...ps.map(p=>p.x)),y:Math.min(...ps.map(p=>p.y)),z:Math.min(...ps.map(p=>p.z))},hi:{x:Math.max(...ps.map(p=>p.x)),y:Math.max(...ps.map(p=>p.y)),z:Math.max(...ps.map(p=>p.z))}};
 });
 const records=faces.map((f,id)=>rings(f).flatMap(r=>r.map((a,i)=>{const b=r[(i+1)%r.length],key=edgeKey(a,b),edge={a,b,id};if(!index.has(key))index.set(key,[]);index.get(key).push(edge);return edge;})));
 const join=(a,b)=>{adjacency[a].add(b);adjacency[b].add(a);};let openEnds=false;
 for(let id=output.length;id<faces.length;id++)for(const {a,b}of records[id]){
  const exact=(index.get(edgeKey(a,b))||[]).filter(e=>e.id!==id);
  if(exact.length){for(const e of exact)join(id,e.id);continue;}
  const intervals=[];
  for(let j=0;j<faces.length;j++){
   if(j===id||['x','y','z'].some(k=>Math.max(a[k],b[k])<bounds[j].lo[k]-K.CONTACT||Math.min(a[k],b[k])>bounds[j].hi[k]+K.CONTACT))continue;
   const shared=sharedIntervals(a,b,[faces[j]]);if(shared.length){join(id,j);intervals.push(...shared);}
  }
  intervals.push(...sharedIntervals(a,b,openBoundaries));intervals.sort((a,b)=>a[0]-b[0]);let coverage=0,hi=0;
  for(const [lo,end]of intervals){coverage+=Math.max(0,end-Math.max(hi,lo));hi=Math.max(hi,end);}
  if(coverage<1-1e-4)openEnds=true;
 }
 const reached=new Set(output.map((_,i)=>i)),queue=[...reached];for(let i=0;i<queue.length;i++)for(const id of adjacency[queue[i]])if(!reached.has(id)){reached.add(id);queue.push(id);}
 return {connected:patches.every((_,i)=>reached.has(output.length+i)),openEnds};
}
// Intersect a planar region with a convex volume. The mask is built on the
// region's own plane; the shared kernel preserves holes and concave boundaries.
function volumeSection(face,planes,subtractVolume=false){
 const frame=K.frame(face);if(!frame)return [];
 const local={points:face.points.map(p=>K.local(frame,p)),holes:(face.holes||[]).map(r=>r.map(p=>K.local(frame,p)))};
 const xs=local.points.map(p=>p.x),ys=local.points.map(p=>p.y),loX=Math.min(...xs)-1,hiX=Math.max(...xs)+1,loY=Math.min(...ys)-1,hiY=Math.max(...ys)+1;
 let mask=[{x:loX,y:loY},{x:hiX,y:loY},{x:hiX,y:hiY},{x:loX,y:hiY}].map(p=>K.world(frame,p));
 for(const plane of planes){const next=[];for(let i=0;i<mask.length;i++){const a=mask[i],b=mask[(i+1)%mask.length],da=dot(plane.n,a)-plane.k,db=dot(plane.n,b)-plane.k,ia=da>=-1e-9,ib=db>=-1e-9;if(ia)next.push(a);if(ia!==ib)next.push(mix3(a,b,da/(da-db)));}mask=next;if(mask.length<3)break;}
 const cut=mask.length>=3?[{points:mask.map(p=>K.local(frame,p)),holes:[]}]:[];
 const regions=subtractVolume?K.difference(local,cut):cut.length?K.intersection([local],cut):[];
 return regions.map(r=>({...face,points:r.points.map(p=>K.world(frame,p)),holes:r.holes.map(h=>h.map(p=>K.world(frame,p)))}));
}
function prismPlanes(points,direction,length){
 const center=points.reduce((a,p)=>({x:a.x+p.x/points.length,y:a.y+p.y/points.length,z:a.z+p.z/points.length}),{x:0,y:0,z:0});
 const planes=points.map((a,i)=>{let n=cross(sub(points[(i+1)%points.length],a),direction);const l=Math.hypot(n.x,n.y,n.z);n={x:n.x/l,y:n.y/l,z:n.z/l};if(dot(n,sub(center,a))<0)n={x:-n.x,y:-n.y,z:-n.z};return {n,k:dot(n,a)};});
 if(Number.isFinite(length)){let n=normal(points);if(!n)throw Error('The sweep source has no area.');let projection=dot(n,direction);if(projection<0){n={x:-n.x,y:-n.y,z:-n.z};projection=-projection;}const k=dot(n,points[0]);planes.push({n,k},{n:{x:-n.x,y:-n.y,z:-n.z},k:-k-length*projection});}
 return planes;
}
function clipboardFrame(origin,n){
 const unit=v=>{const l=Math.hypot(v.x,v.y,v.z);return {x:v.x/l,y:v.y/l,z:v.z/l};};n=unit(n);const up=Math.abs(n.z)<.95?{x:0,y:0,z:1}:{x:0,y:1,z:0},u=unit(cross(up,n)),v=cross(n,u);return {origin:{...origin},u,v,n};
}
function copyGeometry(scene,selected,lines=[]){
 const points=[...new Map(selected.map(p=>[vertexKey(p),{x:p.x,y:p.y,z:p.z}])).values()],chosen=p=>points.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<=K.CONTACT);
 if(!points.length)throw Error('Select points to copy geometry.');
 const sources=scene.filter(f=>!f.deleted&&!f.snapOnly),curved=sources.filter(f=>f.curvedSurface?.logical&&f.points.every(chosen));
 // Selecting a curve's controls includes its derived contacts on neighboring
 // faces. Evaluation vertices are never additional user-selection requirements.
 for(const p of sources.flatMap(f=>rings(f).flat()))if(!chosen(p)&&curved.some(f=>{const uv=K.surfaceUV(f.curvedSurface,p);return Math.hypot(...Object.values(sub(K.surfacePoint(f.curvedSurface,uv.x,uv.y),p)))<K.CONTACT*2&&f.curvedSurface.domains.some(d=>[d.points,...(d.holes||[])].some(r=>r.some((a,i)=>pointOnEdge(uv,{...a,z:0},{...r[(i+1)%r.length],z:0}))));}))points.push({x:p.x,y:p.y,z:p.z});
 const faces=sources.filter(f=>rings(f).flat().every(chosen)),edges=[...new Map([...lines,...sources.flatMap(f=>rings(f).flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]])))].filter(pair=>pair.every(chosen)).map(pair=>[edgeKey(...pair),pair.map(p=>({x:p.x,y:p.y,z:p.z}))])).values()];
 const centroid=points.reduce((s,p)=>({x:s.x+p.x/points.length,y:s.y+p.y/points.length,z:s.z+p.z/points.length}),{x:0,y:0,z:0}),mounts=[];
 for(const f of sources.filter(f=>!faces.includes(f))){const frame=faceFrame(f);if(!frame)continue;const contact=points.filter(p=>Math.abs(dot(sub(p,frame.origin),frame.n))<=K.CONTACT);if(!contact.length)continue;if(mounts.some(m=>Math.abs(dot(m.frame.n,frame.n))>1-1e-6&&Math.abs(dot(sub(frame.origin,m.frame.origin),m.frame.n))<=K.CONTACT))continue;
  const origin=contact.reduce((s,p)=>({x:s.x+p.x/contact.length,y:s.y+p.y/contact.length,z:s.z+p.z/contact.length}),{x:0,y:0,z:0}),side=dot(sub(centroid,origin),frame.n),n=side<0?{x:-frame.n.x,y:-frame.n.y,z:-frame.n.z}:frame.n;mounts.push({frame:clipboardFrame(origin,n),count:contact.length});
 }
 if(!mounts.length){const frame=faces.length?faceFrame(faces[0]):sources.map(faceFrame).find(Boolean);mounts.push({frame:clipboardFrame(centroid,frame?.n||{x:0,y:0,z:1}),count:points.length,fallback:true});}
 mounts.sort((a,b)=>b.count-a.count);
 const clean=f=>({...K.mapCurveData(f,p=>({...p})),points:f.points.map(p=>({x:p.x,y:p.y,z:p.z})),holes:(f.holes||[]).map(r=>r.map(p=>({x:p.x,y:p.y,z:p.z}))),...(f.material?{material:f.material}:{}),...(f.finishColor?{finishColor:f.finishColor}:{}),...(f.trim?{trim:true}:{}),...(f.feature?{feature:JSON.parse(JSON.stringify(f.feature))}:{}),retainedPoints:(f.retainedPoints||[]).filter(chosen).map(p=>({x:p.x,y:p.y,z:p.z}))});
 return {points,edges,faces:faces.map(clean),mounts};
}
// Rigid plane edits retain depth; reflections reverse face winding as well.
function transformGeometry(clip,index,change={}){
 const center=clip.points.reduce((a,p)=>({x:a.x+p.x/clip.points.length,y:a.y+p.y/clip.points.length,z:a.z+p.z/clip.points.length}),{x:0,y:0,z:0}),frame={...clip.mounts[index].frame,origin:change.origin||center},angle=change.angle||0,c=Math.cos(angle),s=Math.sin(angle),flip=change.flip,delta=change.delta||{x:0,y:0};
 // Mirror about the bounds in the chosen plane, not the vertex average:
 // extra subdivision points must not shift the mirror axis.
 if(flip&&!change.origin){const ps=clip.points.map(p=>K.local(frame,p));frame.origin=K.world(frame,{x:(Math.min(...ps.map(p=>p.x))+Math.max(...ps.map(p=>p.x)))/2,y:(Math.min(...ps.map(p=>p.y))+Math.max(...ps.map(p=>p.y)))/2,z:0});}
 const point=p=>{const q=K.local(frame,p),x=q.x*(change.scale?.x??1)*(flip==='x'?-1:1),y=q.y*(change.scale?.y??1)*(flip==='y'?-1:1);return {...p,...K.world(frame,{x:x*c-y*s+(delta.x||0),y:x*s+y*c+(delta.y||0),z:q.z*(change.scale?.z??1)+(delta.z||0)})};};
 const vector=v=>sub(point({x:center.x+v.x,y:center.y+v.y,z:center.z+(v.z||0)}),point(center));
 const ring=r=>{const ps=r.map(point);return flip?ps.reverse():ps;};
 return {...clip,...(clip.curves?{curves:clip.curves.map(c=>K.mapCurve(c,point))}:{}),points:clip.points.map(point),edges:clip.edges.map(r=>r.map(point)),faces:clip.faces.map(f=>({...f,...K.mapCurveData(f,point),points:ring(f.points),holes:(f.holes||[]).map(ring),retainedPoints:(f.retainedPoints||[]).map(point),...(f.feature?.axis?{feature:{...f.feature,axis:vector(f.feature.axis)}}:{})})),mounts:clip.mounts.map(m=>({...m,frame:change.freezeMounts||change.scale?m.frame:clipboardFrame(point(m.frame.origin),vector(m.frame.n))}))};
}
function geometryScale(clip,index,factor,axis='all'){
 const frame=clip.mounts[index].frame,c=clip.points.reduce((s,p)=>({x:s.x+p.x/clip.points.length,y:s.y+p.y/clip.points.length,z:s.z+p.z/clip.points.length}),{x:0,y:0,z:0}),local=K.local(frame,c),origin=K.world(frame,{x:local.x,y:local.y,z:0});
 return transformGeometry(clip,index,{origin,scale:Object.fromEntries(['x','y','z'].map(a=>[a,axis==='all'||axis===a?factor:1])),freezeMounts:true});
}
function snapGeometryScale(clip,index,factor,axis,targets,edges,screen){
 const grown=geometryScale(clip,index,2,axis);let best=10,result=factor;
 for(let i=0;i<clip.points.length;i++){const p=clip.points[i],v=sub(grown.points[i],p),len=Math.hypot(v.x,v.y,v.z);if(len<K.CONTACT)continue;const dir={x:v.x/len,y:v.y/len,z:v.z/len},hit=motionSnap([p],[],dir,len*(factor-1),[],{points:targets,edges,screen,radius:10,minPixelsPerMeter:20});if(hit&&hit.distance<best){const next=1+hit.amount/len;if(next>.01){best=hit.distance;result=next;}}}
 const frame=clip.mounts[index].frame,center=clip.points.reduce((s,p)=>({x:s.x+p.x/clip.points.length,y:s.y+p.y/clip.points.length,z:s.z+p.z/clip.points.length}),{x:0,y:0,z:0}),c=K.local(frame,center),pivot={...frame,origin:K.world(frame,{x:c.x,y:c.y,z:0})};
 // Inverse scaling turns a target-point / moving-edge contact into a ray
 // intersection with the original edge, including contacts at edge interiors.
 for(const target of targets){const q=K.local(pivot,target),local=Object.fromEntries(['x','y','z'].map(a=>[a,axis==='all'||axis===a?q[a]:0])),v=sub(K.world(pivot,local),pivot.origin),len=Math.hypot(v.x,v.y,v.z);if(len<K.CONTACT)continue;const dir={x:v.x/len,y:v.y/len,z:v.z/len},hit=motionSnap([target],[],dir,len*(1/factor-1),[],{edges:clip.edges,screen,radius:10/Math.max(factor,.01),minPixelsPerMeter:20});if(hit&&hit.distance*factor<best){const next=1/(1+hit.amount/len);if(next>.01&&Number.isFinite(next)){best=hit.distance*factor;result=next;}}}
 return result;
}
// Project sticker references onto the working wall without making them weld targets.
// Parallel faces share width and height; other walls share world height only.
function stickerAlignmentTargets(faces,frame,excluded=[]){
 const targets=[];
 for(const f of faces){if(!f.feature||f.deleted||f.snapOnly||f.points.every(p=>excluded.some(q=>vertexKey(p)===vertexKey(q))))continue;
  const n=normal(f.points);if(!n)continue;const parallel=Math.abs(dot(n,frame.n))>.99999;
  const axes=parallel?['x','y']:['x','y'].filter(a=>Math.abs(frame[a==='x'?'u':'v'].z)>.99999);
  if(!axes.length)continue;
  for(const p of f.points){const q=K.local(frame,p);targets.push({...K.world(frame,{x:q.x,y:q.y,z:0}),alignmentAxes:axes,alignmentSource:{x:p.x,y:p.y,z:p.z}});}
 }
 return targets;
}
function planeAlignmentGuides(points,targets,frame){
 const guides=new Map();
 for(const p of points)for(const q of targets){const a=K.local(frame,p),b=K.local(frame,q);if(Math.abs(a.z-b.z)>K.CONTACT)continue;
  for(const axis of ['x','y']){if(q.alignmentAxes&&!q.alignmentAxes.includes(axis))continue;
   const target=q.alignmentSource||q,length=Math.hypot(target.x-p.x,target.y-p.y,target.z-p.z),sticker=!!q.alignmentSource;
   if(Math.abs(a[axis]-b[axis])>1e-6||length<1e-6)continue;
   const key=axis+':'+Math.round(a[axis]*1e6)+':'+Math.round(a.z*1e6),previous=guides.get(key);
   // Keep the actual sticker as the guide endpoint, ahead of nearer wall edges.
   if(!previous||sticker&&!previous.sticker||sticker===previous.sticker&&length<previous.length)guides.set(key,{from:p,target,length,sticker});
  }
 }return [...guides.values()];
}
function planeAlignment(points,targets,frame,screen,radius=12,axes=['u','v'],pointer=null){
 // Sticker callers supply a pointer, but rank the displacement of the supplied
 // unsnapped footprint. Cursor-to-target distance is not a snap displacement.
 const delta={x:0,y:0};
 for(const axis of axes){let best=Infinity,bestTravel=Infinity,amount=0;for(const p of points)for(const q of targets){if(q.alignmentAxes&&!q.alignmentAxes.includes(axis==='u'?'x':'y'))continue;const v=sub(q,p);if(Math.abs(dot(v,frame.n))>K.CONTACT)continue;const t=dot(v,frame[axis]),end={x:p.x+frame[axis].x*t,y:p.y+frame[axis].y*t,z:p.z+frame[axis].z*t},a=screen(p),b=screen(end);if(a.visible===false||b.visible===false)continue;const distance=Math.max(Math.hypot(a.x-b.x,a.y-b.y),Math.abs(t)*33.33);const travel=pointer?Math.abs(t):distance;if(distance<=radius&&(travel<bestTravel-1e-9||Math.abs(travel-bestTravel)<1e-9&&distance<best)){best=distance;bestTravel=travel;amount=t;}}
  delta[axis==='u'?'x':'y']=amount;
 }return delta;
}
function snapGeometryOnPlane(clip,index,targets,edges,screen,radius=10,pointer=null){
 const frame=clip.mounts[index].frame;let best=radius,delta=null;
 const offer=(p,q)=>{if(q.alignmentAxes)return;const d=sub(q,p);if(Math.abs(dot(d,frame.n))>K.CONTACT||Math.hypot(d.x,d.y,d.z)>.5)return;const a=screen(p),b=screen(q),distance=Math.hypot(a.x-b.x,a.y-b.y);if(a.visible!==false&&b.visible!==false&&distance<best){best=distance;delta={x:dot(d,frame.u),y:dot(d,frame.v)};}};
 for(const p of clip.points){for(const q of targets)offer(p,q);for(const [a,b]of edges){const v=sub(b,a),l2=dot(v,v),t=l2?Math.max(0,Math.min(1,dot(sub(p,a),v)/l2)):0;offer(p,mix3(a,b,t));}}
 if(!delta)for(const [a,b]of clip.edges){const v=sub(b,a),l2=dot(v,v);for(const q of targets){const t=l2?Math.max(0,Math.min(1,dot(sub(q,a),v)/l2)):0;offer(mix3(a,b,t),q);}}
 const snapped=delta?transformGeometry(clip,index,{delta}):clip;const alignment=planeAlignment(snapped.points,targets,frame,screen,radius,['u','v'],pointer);return Math.hypot(alignment.x,alignment.y)>1e-10?transformGeometry(snapped,index,{delta:alignment}):snapped;
}
function transformSelection(scene,original,preview,options={}){
 const moves=original.points.map((from,i)=>({from,to:preview.points[i]}));
 const find=p=>moves.find(m=>Math.hypot(p.x-m.from.x,p.y-m.from.y,p.z-m.from.z)<=K.CONTACT);
 // Carry interior stickers for whole-face translations as well as normal moves.
 for(const source of scene.filter(f=>!f.feature&&!f.deleted)){
  const corners=source.points.map(find);if(corners.some(m=>!m))continue;
  const delta=sub(corners[0].to,corners[0].from);
  if(corners.some(m=>Math.hypot(...Object.values(sub(sub(m.to,m.from),delta)))>K.CONTACT))continue;
  for(const sticker of mountedStickers(scene,source))for(const p of [...rings(sticker).flat(),...(sticker.retainedPoints||[])])if(!find(p))moves.push({from:p,to:{x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z}});
 }
 const mapped=p=>({...p,...(find(p)?.to||{})}),affected=[];
 const faces=scene.map(f=>{if(![...rings(f).flat(),...(f.retainedPoints||[])].some(find))return f;affected.push(f.id);const whole=rings(f).flat().every(find),copied=whole&&original.faces.findIndex(g=>g.points.length===f.points.length&&g.points.every(p=>f.points.some(q=>vertexKey(p)===vertexKey(q))));
  const transformed=whole&&copied>=0?preview.faces[copied]:null;
  return {...f,...(transformed?K.mapCurveData(transformed,p=>({...p})):{}),points:transformed?transformed.points:f.points.map(mapped),holes:transformed?transformed.holes:(f.holes||[]).map(r=>r.map(mapped)),retainedPoints:(f.retainedPoints||[]).map(mapped),...(transformed?.feature?{feature:transformed.feature}:{})};
 });return followTrim(scene,{faces,moves,affected},scene.filter(f=>f.points.every(p=>original.points.some(q=>vertexKey(p)===vertexKey(q)))).map(f=>f.id),options.keepTrimStatic);
}
// Fit against the actual connected geometry too: footprint bounds alone do not
// catch a neighboring face folding or collapsing as its shared vertices move.
function validTranslation(wanted,check){
 const cache=new Map(),valid=p=>{const key=p.x+':'+p.y;if(!cache.has(key))cache.set(key,check(p));return cache.get(key);};
 if(valid(wanted))return wanted;
 const origin={x:0,y:0};if(!valid(origin))return null;
 const along=(a,b)=>{let lo=0,hi=1;for(let i=0;i<28;i++){const t=(lo+hi)/2,q={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};if(valid(q))lo=t;else hi=t;}return {x:a.x+(b.x-a.x)*lo,y:a.y+(b.y-a.y)*lo};};
 const seeds=[origin,along(origin,wanted)],results=[];
 for(const seed of seeds)for(const order of [['x','y'],['y','x']]){let q={...seed};for(let pass=0;pass<3;pass++)for(const axis of order){const end={...q,[axis]:wanted[axis]};q=valid(end)?end:along(q,end);}results.push(q);}
 return results.sort((a,b)=>Math.hypot(a.x-wanted.x,a.y-wanted.y)-Math.hypot(b.x-wanted.x,b.y-wanted.y))[0];
}
// Closest allowed translation of a rigid footprint. Clamp in plane space,
// not along the last mouse segment, so one blocked axis never freezes another.
function boundedTranslation(points,regions,wanted,options={}){
 if(!points.length||!regions.length)return wanted;
 const all=regions.flatMap(f=>f.points),limits={left:Math.min(...all.map(p=>p.x))-Math.min(...points.map(p=>p.x)),right:Math.max(...all.map(p=>p.x))-Math.max(...points.map(p=>p.x)),bottom:Math.min(...all.map(p=>p.y))-Math.min(...points.map(p=>p.y)),top:Math.max(...all.map(p=>p.y))-Math.max(...points.map(p=>p.y))};
 if(options.axis==='x'){limits.bottom=Math.max(limits.bottom,0);limits.top=Math.min(limits.top,0);}if(options.axis==='y'){limits.left=Math.max(limits.left,0);limits.right=Math.min(limits.right,0);}
 if(limits.left>limits.right+1e-8||limits.bottom>limits.top+1e-8)return null;
 const cross2=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),sorted=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y),half=ps=>{const out=[];for(const p of ps){while(out.length>1&&cross2(out.at(-2),out.at(-1),p)<=1e-10)out.pop();out.push(p);}return out;},hull=[...half(sorted).slice(0,-1),...half(sorted.slice().reverse()).slice(0,-1)];
 const valid=d=>{const ps=points.map(p=>({x:p.x+d.x,y:p.y+d.y,z:0}));if(!ps.every(p=>regions.some(f=>(pointInRing(p,f.points)||f.points.some((a,i)=>pointOnEdge(p,a,f.points[(i+1)%f.points.length])))&&!(f.holes||[]).some(r=>pointInRing(p,r)&&!r.some((a,i)=>pointOnEdge(p,a,r[(i+1)%r.length]))))))return false;return hull.length<3||K.difference({points:hull.map(p=>({x:p.x+d.x,y:p.y+d.y,z:0}))},regions).reduce((s,f)=>s+K.area(f),0)<1e-8;};
 const clamp=d=>({x:Math.max(limits.left,Math.min(limits.right,d.x)),y:Math.max(limits.bottom,Math.min(limits.top,d.y))}),target=clamp(wanted);if(valid(target))return target;
 const ring=regions.length===1&&!(regions[0].holes||[]).length?(signedArea(regions[0].points)<0?regions[0].points.slice().reverse():regions[0].points):null;
 if(ring&&ring.every((p,i)=>cross2(p,ring[(i+1)%ring.length],ring[(i+2)%ring.length])>=-1e-8)){
  let polygon=[{x:limits.left,y:limits.bottom},{x:limits.right,y:limits.bottom},{x:limits.right,y:limits.top},{x:limits.left,y:limits.top}];
  for(let i=0;i<ring.length;i++){const a=ring[i],z=ring[(i+1)%ring.length],dx=z.x-a.x,dy=z.y-a.y,offset=Math.min(...points.map(p=>dx*(p.y-a.y)-dy*(p.x-a.x))),side=p=>dx*p.y-dy*p.x+offset,next=[];for(let j=0;j<polygon.length;j++){const p=polygon[j],q=polygon[(j+1)%polygon.length],u=side(p),v=side(q);if(u>=-1e-10)next.push(p);if((u>=0)!==(v>=0)){const t=u/(u-v);next.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});}}polygon=next;}
  let best=null,distance=Infinity;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((wanted.x-a.x)*dx+(wanted.y-a.y)*dy)/l2)):0,q={x:a.x+dx*t,y:a.y+dy*t},d=Math.hypot(q.x-wanted.x,q.y-wanted.y);if(d<distance){distance=d;best=q;}}if(best&&valid(best))return best;
 }
 // A feasible translation ends at a contact between a footprint vertex and
 // a boundary edge (or the reverse). Intersections of these contact segments
 // include corners of narrow/concave placement regions that grid seeds miss.
 const boundary=regions.flatMap(f=>[f.points,...(f.holes||[])]),foot=hull.length?hull:points,segments=[];
 for(const r of boundary)for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length];for(let j=0;j<foot.length;j++){const p=foot[j],q=foot[(j+1)%foot.length];segments.push([{x:a.x-p.x,y:a.y-p.y},{x:b.x-p.x,y:b.y-p.y}],[{x:a.x-p.x,y:a.y-p.y},{x:a.x-q.x,y:a.y-q.y}]);}}
 const candidates=[],offer=p=>{if(p.x>=limits.left-1e-8&&p.x<=limits.right+1e-8&&p.y>=limits.bottom-1e-8&&p.y<=limits.top+1e-8)candidates.push(p);};
 for(let i=0;i<segments.length;i++){const [a,b]=segments[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((wanted.x-a.x)*dx+(wanted.y-a.y)*dy)/l2)):0;offer(a);offer({x:a.x+t*dx,y:a.y+t*dy});
  // Clip contact segments to the allowed translation bounds before ranking.
  // With a locked horizontal coordinate, a sloped floor contact crosses x=0
  // between endpoints; omitting that intersection incorrectly picks the ceiling.
  for(const [axis,lo,hi]of [['x',limits.left,limits.right],['y',limits.bottom,limits.top]]){
   const step=b[axis]-a[axis];if(Math.abs(step)<1e-12)continue;
   for(const limit of [lo,hi]){const u=(limit-a[axis])/step;if(u>=-1e-9&&u<=1+1e-9)offer({x:a.x+u*dx,y:a.y+u*dy});}
  }
  for(let j=0;j<i;j++){const [c,d]=segments[j],ex=d.x-c.x,ey=d.y-c.y,det=dx*ey-dy*ex;if(Math.abs(det)<1e-12)continue;const u=((c.x-a.x)*ey-(c.y-a.y)*ex)/det,v=((c.x-a.x)*dy-(c.y-a.y)*dx)/det;if(u>=-1e-9&&u<=1+1e-9&&v>=-1e-9&&v<=1+1e-9)offer({x:a.x+dx*u,y:a.y+dy*u});}
 }
 candidates.sort((a,b)=>Math.hypot(a.x-wanted.x,a.y-wanted.y)-Math.hypot(b.x-wanted.x,b.y-wanted.y));const seen=new Set();for(const p of candidates){const key=Math.round(p.x*1e8)+':'+Math.round(p.y*1e8);if(seen.has(key))continue;seen.add(key);if(valid(p))return p;}
 // Concave outlines/openings: retain a valid seed and fit each independent
 // coordinate in both orders, instead of retaining the previous rendered frame.
 const seeds=[{x:0,y:0},clamp({x:0,y:0})];for(const x of [limits.left,(limits.left+limits.right)/2,limits.right])for(const y of [limits.bottom,(limits.bottom+limits.top)/2,limits.top])seeds.push({x,y});
 const results=[];for(const seed of seeds.filter(valid))for(const order of [['x','y'],['y','x']]){let current={...seed};for(let pass=0;pass<3;pass++)for(const axis of order){const end={...current,[axis]:target[axis]};if(valid(end)){current=end;continue;}let lo=0,hi=1;for(let i=0;i<35;i++){const t=(lo+hi)/2;if(valid({...current,[axis]:current[axis]+(end[axis]-current[axis])*t}))lo=t;else hi=t;}current[axis]+=(end[axis]-current[axis])*lo;}results.push(current);}
 return results.sort((a,b)=>Math.hypot(a.x-wanted.x,a.y-wanted.y)-Math.hypot(b.x-wanted.x,b.y-wanted.y))[0]||null;
}
function pasteGeometry(clip,mountIndex,target,location,options={}){
 const source=clip.mounts[mountIndex%clip.mounts.length].frame,normal0=options.normal||normal(target.points),frame=clipboardFrame(location,normal0),transform=p=>K.world(frame,K.local(source,p));
 let points=clip.points.map(transform),delta={x:0,y:0,z:0},snap=null;
 const contacts=clip.points.map((p,i)=>Math.abs(K.local(source,p).z)<=K.CONTACT?i:-1).filter(i=>i>=0),targets=[...(options.points||rings(target).flat()),...stickerAlignmentTargets(options.stickerFaces||[],frame)];
 const stickerPlacement=clip.faces.length>0&&clip.faces.every(f=>f.feature);
 if(stickerPlacement&&options.bound&&contacts.length){const region={points:target.points.map(p=>K.local(frame,p)),holes:(target.holes||[]).map(r=>r.map(p=>K.local(frame,p)))},localPoints=contacts.map(i=>K.local(frame,points[i])),fit=boundedTranslation(localPoints,[region],{x:0,y:0},{axis:'y'})||boundedTranslation(localPoints,[region],{x:0,y:0});if(fit)delta={x:frame.u.x*fit.x+frame.v.x*fit.y,y:frame.u.y*fit.x+frame.v.y*fit.y,z:frame.u.z*fit.x+frame.v.z*fit.y};}
 if(!stickerPlacement&&options.screen&&options.snap!==false){let best=options.radius||10;for(const i of contacts)for(const targetPoint of targets){if(targetPoint.alignmentAxes)continue;if(Math.abs(K.local(frame,targetPoint).z)>K.CONTACT)continue;const a=options.screen(points[i]),b=options.screen(targetPoint),pixels=Math.hypot(a.x-b.x,a.y-b.y);if(a.visible!==false&&b.visible!==false&&pixels<best&&Math.hypot(...Object.values(sub(targetPoint,points[i])))<.5){best=pixels;delta=sub(targetPoint,points[i]);snap={from:points[i],target:targetPoint};}}
  if(!snap)for(const i of contacts)for(const r of rings(target))for(let j=0;j<r.length;j++){const a=r[j],b=r[(j+1)%r.length],v=sub(b,a),l2=dot(v,v),t=l2?Math.max(0,Math.min(1,dot(sub(points[i],a),v)/l2)):0,q=mix3(a,b,t),x=options.screen(points[i]),y=options.screen(q),pixels=Math.hypot(x.x-y.x,x.y-y.y);if(pixels<best&&Math.hypot(...Object.values(sub(q,points[i])))<.5){best=pixels;delta=sub(q,points[i]);snap={from:points[i],target:q};}}
 }
 if(options.screen&&options.snap!==false){const current=points.map(p=>({x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z})),aligned=planeAlignment(contacts.map(i=>current[i]),targets,frame,options.screen,options.radius||12,['u','v'],stickerPlacement?location:null);delta={x:delta.x+frame.u.x*aligned.x+frame.v.x*aligned.y,y:delta.y+frame.u.y*aligned.x+frame.v.y*aligned.y,z:delta.z+frame.u.z*aligned.x+frame.v.z*aligned.y};if(Math.hypot(aligned.x,aligned.y)>1e-7)snap={kind:'Alignment'};}

 if(options.bound&&contacts.length){const localPoints=contacts.map(i=>K.local(frame,points[i])),localTarget={points:target.points.map(p=>K.local(frame,p)),holes:(target.holes||[]).map(r=>r.map(p=>K.local(frame,p)))},d={x:dot(delta,frame.u),y:dot(delta,frame.v)},fit=boundedTranslation(localPoints,[localTarget],d);if(fit){delta={x:frame.u.x*fit.x+frame.v.x*fit.y,y:frame.u.y*fit.x+frame.v.y*fit.y,z:frame.u.z*fit.x+frame.v.z*fit.y};}}
 const moved=p=>{const q=transform(p);return {x:q.x+delta.x,y:q.y+delta.y,z:q.z+delta.z};};points=clip.points.map(moved);
 const tf=frame,local={points:target.points.map(p=>K.local(tf,p)),holes:(target.holes||[]).map(r=>r.map(p=>K.local(tf,p)))},inside=p=>{const q=K.local(tf,p);return Math.abs(q.z)<=K.CONTACT&&(pointInRing(q,local.points)||local.points.some((a,i)=>pointOnEdge(q,a,local.points[(i+1)%local.points.length])))&&!local.holes.some(r=>pointInRing(q,r)&&!r.some((a,i)=>pointOnEdge(q,a,r[(i+1)%r.length])));};
 let valid=contacts.every(i=>inside(points[i]));
 if(contacts.length>=3){const ps=contacts.map(i=>K.local(tf,points[i])).sort((a,b)=>a.x-b.x||a.y-b.y),turn=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),half=list=>{const out=[];for(const p of list){while(out.length>1&&turn(out.at(-2),out.at(-1),p)<=1e-10)out.pop();out.push(p);}return out;},lo=half(ps),hi=half(ps.slice().reverse()),hull=[...lo.slice(0,-1),...hi.slice(0,-1)];if(hull.length>=3&&K.difference({points:hull},[local]).reduce((s,f)=>s+K.area(f),0)>1e-8)valid=false;}
for(const pair of clip.edges)if(pair.every(p=>Math.abs(K.local(source,p).z)<=K.CONTACT))for(let i=0;i<=20;i++)valid&&=inside(moved(mix3(pair[0],pair[1],i/20)));
 const guides=valid&&options.snap!==false?planeAlignmentGuides(contacts.map(i=>points[i]),targets,frame):[];
 return {points,location:{x:location.x+delta.x,y:location.y+delta.y,z:location.z+delta.z},edges:clip.edges.map(pair=>pair.map(moved)),faces:clip.faces.map(f=>({...f,...K.mapCurveData(f,moved),points:f.points.map(moved),holes:f.holes.map(r=>r.map(moved)),retainedPoints:f.retainedPoints.map(moved),...(f.feature?.axis?{feature:{...f.feature,axis:sub(moved({x:source.origin.x+f.feature.axis.x,y:source.origin.y+f.feature.axis.y,z:source.origin.z+(f.feature.axis.z||0)}),moved(source.origin))}}:{})})),valid,snap,guides};
}
// A merged wall/chimney region owns the joined area; do not clip it back out
// using the source chimney footprint. It no longer drives a single chimney side.
function mergedOwnership(faces){
 const joinedChimneys=[...new Set(faces.flatMap(f=>[...(f.joinedChimneys||[]),...(f.chimney?.id?[f.chimney.id]:[])]))];
 return joinedChimneys.length?{chimney:undefined,joinedChimneys}:{};
}
function mergeConnectedFaces(scene,{preserveTrim=false}={}){
 const groups=[];
 const compatible=(a,b)=>(a.material||'default')===(b.material||'default')&&(a.finishColor||null)===(b.finishColor||null)&&!!a.trim===!!b.trim&&JSON.stringify(a.feature||null)===JSON.stringify(b.feature||null)&&!!a.baseFaceId===!!b.baseFaceId&&(!preserveTrim||JSON.stringify(a.trimData||null)===JSON.stringify(b.trimData||null));
 for(const face of scene.filter(f=>!f.deleted&&!f.snapOnly&&!f.chamferSupportOnly&&(!preserveTrim||!f.trim))){
  const touching=groups.filter(g=>g.some(f=>compatible(face,f)&&coplanarContact(face,f)));
  if(!touching.length){groups.push([face]);continue;}const group=touching[0];group.push(face);for(const other of touching.slice(1)){group.push(...other);groups.splice(groups.indexOf(other),1);}
 }
 return groups.filter(g=>g.length>1).map(faces=>({faces,pieces:planarUnion(faces).map(f=>({...f,...mergedOwnership(faces),retainedPoints:[...new Map(faces.flatMap(g=>[...g.points,...(g.retainedPoints||[])]).filter(p=>rings(f).some(r=>r.some((a,i)=>pointOnEdge(p,a,r[(i+1)%r.length])))).map(p=>[vertexKey(p),p])).values()]}))}));
}
function planarUnion(faces){
 const groups=[];for(const f of faces){const frame=K.frame(f);if(!frame)continue;let group=groups.find(g=>Math.abs(dot(g.frame.n,frame.n))>1-1e-8&&f.points.every(p=>Math.abs(K.local(g.frame,p).z)<=K.CONTACT));if(!group){group={frame,source:f,faces:[]};groups.push(group);}group.faces.push(f);}
 return groups.flatMap(({frame,source,faces})=>K.union(faces.map(f=>({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))}))).map(r=>({...source,points:r.points.map(p=>K.world(frame,p)),holes:r.holes.map(h=>h.map(p=>K.world(frame,p)))})));
}
// Remove the space above finite roof surfaces from a horizontal wall sweep.
// Include the cutter boundary inside the sweep: this creates the sloped return
// and the exact first-contact corner, rather than bending a four-point face.
function roofExtrusion(source,amount,shape,roof){
 const n=normal(source.points);if(!roof?.faces?.length||!n||Math.abs(n.z)>K.CONTACT||Math.abs(amount)<K.CONTACT)return shape;
 // The roof owns its surface. Keep only exposed portions of sweep returns,
 // including when motion is exactly coplanar and never enters a roof cutter.
 const exposed=faces=>faces.flatMap(f=>{const frame=K.frame(f),local=g=>({points:g.points.map(p=>K.local(frame,p)),holes:(g.holes||[]).map(r=>r.map(p=>K.local(frame,p)))});
  const roofs=roof.faces.filter(r=>!r.deleted&&r.points?.every(K.finite3)&&r.points.every(p=>Math.abs(K.local(frame,p).z)<=K.CONTACT));if(!roofs.length)return [f];
  return K.difference(local(f),roofs.map(local)).map((r,i)=>({...f,id:i?f.id+'-exposed-'+i:f.id,points:r.points.map(p=>K.world(frame,p)),holes:r.holes.map(r=>r.map(p=>K.world(frame,p)))}));});
 const direction={x:n.x*Math.sign(amount),y:n.y*Math.sign(amount),z:0},length=Math.abs(amount),frame=K.frame(source);
 const mesh=source.curvedSurface?.logical?K.surfaceMesh(source):null,triangles=mesh?mesh.triangles.map(t=>t.map(i=>mesh.positions[i])):(()=>{const m=K.triangles(source.points.map(p=>K.local(frame,p)),(source.holes||[]).map(r=>r.map(p=>K.local(frame,p))));return m.triangles.map(t=>t.map(i=>K.world(frame,m.points[i])));})();
 const prisms=triangles.map(points=>prismPlanes(points,direction,length));
 const sweepShell=[...K.surfaceFacets(shape.cap),...extrude(source,amount,{facets:true}).sides];
 const zMax=Math.max(...source.points.map(p=>p.z),...shape.cap.points.map(p=>p.z))+1,cutters=[];
 for(const roofFace of roof.faces){
  if(roofFace.deleted||!roofFace.points?.every(K.finite3))continue;
  const rf=K.frame(roofFace),rt=K.triangles(roofFace.points.map(p=>K.local(rf,p)),(roofFace.holes||[]).map(r=>r.map(p=>K.local(rf,p))));
  const measured=[roofFace.points,...(roofFace.holes||[])].flat().map(p=>({world:p,local:K.local(rf,p)}));
  for(const ids of rt.triangles){const points=ids.map(i=>{const q=rt.points[i],hit=measured.find(p=>Math.hypot(p.local.x-q.x,p.local.y-q.y)<K.CONTACT);return hit?{...hit.world}:K.world(rf,q);});let rn=normal(points);if(!rn||Math.abs(rn.z)<K.CONTACT)continue;if(rn.z<0)rn={x:-rn.x,y:-rn.y,z:-rn.z};const roofPlane={n:rn,k:dot(rn,points[0])};
   // Use the rendered triangle plane: measured roof polygons need not be exactly
   // coplanar. A whole-polygon plane disagrees with the cutter's side walls.
   if(!source.points.some(p=>dot(rn,p)<roofPlane.k-K.CONTACT))continue;
   // Once the sweep reaches a roof, leaving its finite footprint must not
   // restore the old height or create an upright curtain along the eave.
   // Extend the roof footprint only forward along this motion, so unrelated
   // roof planes cannot constrain a sweep that never passes beneath them.
   const footprint=[...points,...points.map(p=>({x:p.x+direction.x*length,y:p.y+direction.y*length}))].sort((a,b)=>a.x-b.x||a.y-b.y),turn=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),half=ps=>{const out=[];for(const p of ps){while(out.length>1&&turn(out.at(-2),out.at(-1),p)<=1e-12)out.pop();out.push(p);}return out;},lo=half(footprint),hi=half(footprint.slice().reverse()),boundary=[...lo.slice(0,-1),...hi.slice(0,-1)].map(p=>({...p,z:(roofPlane.k-rn.x*p.x-rn.y*p.y)/rn.z}));
   // Sweep the space above the roof itself. At an eave the limiting height
   // stays at the last roof contact; it neither jumps back up nor extrapolates
   // neighboring roof slopes into a discontinuous crease outside the roof.
   const shifted=points.map(p=>({x:p.x+direction.x*length,y:p.y+direction.y*length,z:p.z})),ceilingPlanes=[{n:rn,k:Math.min(roofPlane.k,dot(rn,shifted[0]))}];
   for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];let en=cross(sub(b,a),direction),size=Math.hypot(en.x,en.y,en.z);if(size<K.CONTACT||Math.abs(en.z)/size<K.CONTACT)continue;if(en.z<0)size=-size;en={x:en.x/size,y:en.y/size,z:en.z/size};const k=dot(en,a);if([...points,...shifted].every(p=>dot(en,p)>=k-K.CONTACT))ceilingPlanes.push({n:en,k});}
   // Use the actual roof plane under its footprint. Carry a lower limit
   // forward only outside measured roof coverage, never beneath another facet.
   const outside=K.difference({points:boundary,holes:[]},roof.faces.filter(f=>!f.deleted));
   const regions=[{points,ceiling:[roofPlane]},...outside.flatMap(f=>{const t=K.triangles(f.points,f.holes);return t.triangles.map(ids=>({points:ids.map(i=>t.points[i]),ceiling:ceilingPlanes}));})];
   for(const region of regions){
    const edge=region.points.map(p=>({...p,z:(roofPlane.k-rn.x*p.x-rn.y*p.y)/rn.z}));
    const planes=[...prismPlanes(edge,{x:0,y:0,z:1}),...region.ceiling];
    if(!sweepShell.some(f=>f.points.some(p=>dot(roofPlane.n,p)>roofPlane.k+K.CONTACT))||!sweepShell.some(f=>volumeSection(f,planes).length))continue;
    const bounds=[{points:edge,holes:[],roofContact:true}];for(let i=0;i<edge.length;i++){const a=edge[i],b=edge[(i+1)%edge.length];if(Math.min(a.z,b.z)<zMax)bounds.push({points:[a,b,{...b,z:zMax},{...a,z:zMax}],holes:[]});}
    cutters.push({planes,bounds,ceilingPlanes:region.ceiling});
   }
  }
 }
 if(!cutters.length)return {...shape,sides:exposed(shape.sides)};
 const trim=(faces,skip=-1)=>{for(let i=0;i<cutters.length;i++)if(i!==skip)faces=faces.flatMap(f=>volumeSection(f,cutters[i].planes,true));return faces;};
 const caps=K.compactSurfaces(trim(K.surfaceFacets(shape.cap)));
 const shell=[...K.surfaceFacets(source),...sweepShell];
 const patches=cutters.flatMap((c,i)=>trim(c.bounds.filter(f=>!f.roofContact&&!shell.some(s=>{const sf=K.frame(s);return sf&&f.points.every(p=>Math.abs(K.local(sf,p).z)<=K.CONTACT);})).flatMap(f=>volumeSection(f,c.planes)).flatMap(f=>prisms.flatMap(planes=>volumeSection(f,planes))),i));
 // A roof cut through a smooth surface produces evaluated boundary samples,
 // not a new editable corner at every triangle crossing. Keep the roof-plane
 // transitions and endpoints as controls, while retaining the full trim domain.
 for(const f of caps)if(f.curvedSurface?.logical){const c=f.curvedSurface,controls=[],original=source.curvedSurface?.boundaryControls||source.curvedSurface?.domains?.flatMap(d=>[d.points,...(d.holes||[])].flat())||[];
  for(const d of c.domains)for(const ring of [d.points,...(d.holes||[])])for(let i=0;i<ring.length;i++){
   const uv=ring[i],ps=[ring[(i+ring.length-1)%ring.length],uv,ring[(i+1)%ring.length]].map(p=>K.surfacePoint(c,p.x,p.y)),corner=original.some(p=>Math.hypot(p.x-uv.x,p.y-uv.y)<K.CONTACT),smooth=!corner&&cutters.some(({ceilingPlanes})=>ceilingPlanes.some(plane=>ps.every(p=>Math.abs(dot(plane.n,p)-plane.k)<.002)));if(!smooth)controls.push(uv);
  }
  c.boundaryControls=controls;f.points=controls.map(p=>K.surfacePoint(c,p.x,p.y));
 }
 const cap=caps.length?{...caps[0],id:shape.cap.id,retainedPoints:[]}:{...shape.cap,deleted:true,retainedPoints:[]};
 const endFaces=[cap,...caps.slice(1).map(f=>({...f,retainedPoints:[]}))];
 for(const endFace of endFaces)for(const p of endFace.deleted?[]:shape.cap.retainedPoints||[]){const q={...p};for(const c of cutters)if(c.planes.slice(0,-c.ceilingPlanes.length).every(plane=>dot(plane.n,q)>=plane.k-K.CONTACT)){q.z=Math.min(q.z,Math.max(...c.ceilingPlanes.map(plane=>(plane.k-plane.n.x*q.x-plane.n.y*q.y)/plane.n.z)));}const cf=K.frame(endFace),v=K.local(cf,q),rs=[endFace.points,...endFace.holes].map(r=>r.map(p=>K.local(cf,p)));const boundary=rs.some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],d=sub(b,a),l2=dot(d,d),t=l2?dot(sub(v,a),d)/l2:0;return t>=0&&t<=1&&Math.hypot(v.x-a.x-d.x*t,v.y-a.y-d.y*t)<=K.CONTACT;}));if(boundary||pointInRing(v,rs[0])&&!rs.slice(1).some(r=>pointInRing(v,r)))endFace.retainedPoints.push(q);}
 // Planar union cannot transfer the first patch's curve range to an entire
 // joined strip. Retain curved patches until their parameter domains unite.
 const returns=exposed([...endFaces.slice(1),...trim(shape.sides),...patches.map(f=>({...f,material:source.material,finishColor:source.finishColor,chimney:source.chimney?{...source.chimney,derived:true,drivesFootprint:false}:undefined}))]);
 const sides=[...planarUnion(returns.filter(f=>!f.curvedSurface)),...returns.filter(f=>f.curvedSurface)].map((f,i)=>({...f,id:source.id+'-roof-return-'+i,opening:false}));
 return {cap,sides};
}
// A cap finish belongs to the top, never to newly exposed shaft walls.
function finishExtrusionSides(face,sides,options){
 if(!face.chimney?.cap&&face.material!=='chimney-top')return;
 for(const side of sides){if(side.chimney)side.chimney.cap=false;if(face.material!=='chimney-top')continue;
  const neighbor=(options.supports||[]).find(f=>f.material!=='chimney-top'&&!f.feature&&sharedIntervals(side.points[0],side.points[1],[f]).some(([lo,hi])=>hi-lo>.99999));
  side.material=neighbor?.material||'default';side.finishColor=neighbor?.finishColor;
 }
}
function extrude(face,amount,options={}){if(face.curvedSurface?.logical)return extrudeCurved(face,amount,options);const n=normal(face.points);if(!n)throw Error('The face has no area.');const moved=p=>({x:p.x+n.x*amount,y:p.y+n.y*amount,z:p.z+n.z*amount}),cap={...face,...K.mapCurveData(face,moved),opening:false,points:face.points.map(moved),retainedPoints:(face.retainedPoints||[]).map(moved),holes:(face.holes||[]).map(h=>h.map(moved))},sides=[];
 if(Math.abs(amount)>1e-6)for(const [ring,points]of [face.points,...(face.holes||[])].entries())for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],intervals=options.supports?sharedIntervals(a,b,options.supports):[[0,1]];for(const [part,[lo,hi]]of intervals.entries()){const p=mix3(a,b,lo),q=mix3(a,b,hi);let curvedSurface;for(const curve of face.curves||[]){const samples=K.curveSamples(curve);for(let j=1;j<samples.length;j++)if(pointOnEdge(p,samples[j-1],samples[j])&&pointOnEdge(q,samples[j-1],samples[j])){const start=samples[j-1],end=samples[j],v=sub(end,start),l2=dot(v,v),parameter=p=>start.curveT+(end.curveT-start.curveT)*dot(sub(p,start),v)/l2;curvedSurface={type:'ellipse-extrusion',curve,offset:{x:n.x*amount,y:n.y*amount,z:n.z*amount},range:[parameter(p),parameter(q)]};break;}}sides.push({... (curvedSurface?{curvedSurface}:{}),...((face.material)?{material:face.material}:{}),...(face.finishColor?{finishColor:face.finishColor}:{}),...((face.chimney)?{chimney:{...face.chimney,drivesFootprint:false,derived:true}}:{}),id:face.id+'-side-'+ring+'-'+i+'-'+part,points:[p,q,moved(q),moved(p)],holes:[],opening:false});}}
 delete cap.attachment;finishExtrusionSides(face,sides,options);return {cap,sides:options.facets?sides:K.compactSurfaces(sides)};}
// Sweep evaluated boundaries, never the chord joining logical control points.
// Keep the cap exact and use temporary planar patches for neighboring booleans.
function extrudeCurved(face,amount,options){
 const n=normal(face.points);if(!n)throw Error('The face has no extrusion direction.');
 const offset={x:n.x*amount,y:n.y*amount,z:n.z*amount},moved=p=>({x:p.x+offset.x,y:p.y+offset.y,z:p.z+offset.z}),cap={...face,...K.mapCurveData(face,moved),points:face.points.map(moved),holes:[],retainedPoints:[],opening:false},sides=[];
 delete cap.attachment;
 const supports=options.supports?.map(K.surfaceOutline);
 if(Math.abs(amount)>K.CONTACT)for(const [i,curve]of K.surfaceBoundaryCurves(face).flat(2).entries()){
  const samples=K.curveSamples(curve),onBoundary=p=>supports.some(f=>rings(f).some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],v=sub(b,a),l2=dot(v,v),t=l2?Math.max(0,Math.min(1,dot(sub(p,a),v)/l2)):0;return Math.hypot(...Object.values(sub(p,mix3(a,b,t))))<=.002;}))),attached=!supports||samples.every(onBoundary);
  for(let j=1;j<samples.length;j++){const a=samples[j-1],b=samples[j],intervals=attached?[[0,1]]:sharedIntervals(a,b,supports);
   for(const [part,[lo,hi]]of intervals.entries()){const p=mix3(a,b,lo),q=mix3(a,b,hi),points=[p,q,moved(q),moved(p)];if(!normal(points))continue;
    const crossArea=cross(sub(q,p),offset);if(Math.hypot(crossArea.x,crossArea.y,crossArea.z)<1e-10)continue;
    const range=[lo,hi].map(t=>a.curveT+(b.curveT-a.curveT)*t);
    sides.push({id:face.id+'-side-'+i+'-'+j+'-'+part,points,holes:[],material:face.material,finishColor:face.finishColor,chimney:face.chimney&&{...face.chimney,drivesFootprint:false,derived:true},curvedSurface:{type:'ellipse-extrusion',curve,offset,range}});
   }
  }
 }
 finishExtrusionSides(face,sides,options);return {cap,sides:options.facets?sides:K.compactSurfaces(sides)};
}
// Cancel overlapping material when a return sweeps along an existing side.
// The neighbor loses the swept area; the new return keeps only area beyond it.
// Reassemble disjoint clipping fragments by cancelling their shared edges.
// Unlike footprint tracing, this must not weld centimetres-apart vertices or
// probe across a narrow remaining strip while the mouse is moving.
function pointInRing(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
function fragmentRings(pieces){return K.union(pieces.map(points=>({points}))).flatMap(f=>[f.points,...f.holes]);}
function joinFragments(pieces){return K.union(pieces.map(points=>({points})));}
function unionPlanar(polys){return K.union(polys.map(points=>({points})));}
// Roof-derived wall seams carry millimetre measurement differences. Only a
// newly clipped remnant of a much larger generated wall uses this tolerance;
// existing thin faces and explicitly typed features are not simplified.
function sweepRemnant(piece,source){
 if(source.feature||piece.feature||!source.draftKey||source.draftKey.startsWith('solid:'))return false;
 const measure=f=>{const frame=faceFrame(f);if(!frame)return {area:0,width:0};const area=K.area({points:f.points.map(p=>inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))}),length=Math.max(...f.points.map((p,i)=>Math.hypot(...Object.values(sub(p,f.points[(i+1)%f.points.length])))));return {area,width:area/length};};
 const a=measure(source),b=measure(piece);return a.width>.03&&b.width<=.003&&b.area<a.area*.01;
}
function cleanupSweepRemnants(edits){if(!edits?.$surfaces)return false;const before=edits.$surfaces.length;edits.$surfaces=edits.$surfaces.filter(f=>{
 if(f.deleted||f.drafted||!String(f.id).startsWith('swept-'))return true;const d=edits.$drafts?.[f.draftKey],region=d?.faces.find(r=>r.id===f.regionId&&r.solidId);if(!region)return true;
 const world=p=>d.frame?fromFrame(d.frame,p):({x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y}),source={...region,draftKey:f.draftKey,points:region.points.map(world),holes:(region.holes||[]).map(r=>r.map(world))};return !sweepRemnant(f,source);
 });return edits.$surfaces.length!==before;}
function trimExtrusion(sides,neighbors){
 // Openings keep their identity and dimensions; wall returns must never union
 // with a window or door just because they meet on the same plane.
 const changes=new Map(),originals=neighbors.filter(f=>!f.deleted&&!f.snapOnly&&!f.feature);
 const difference=(face,cuts)=>{
  const frame=faceFrame(face),local=f=>({points:f.points.map(p=>inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))});
  return K.difference(local(face),cuts.map(local)).map((region,i)=>({...face,id:face.id+'-trim-'+i,points:region.points.map(p=>fromFrame(frame,p)),holes:region.holes.map(r=>r.map(p=>fromFrame(frame,p))),retainedPoints:(face.retainedPoints||[]).filter(p=>{const q=inFrame(frame,p);return pointInRing(q,region.points)||region.points.some((a,j)=>pointOnEdge(q,a,region.points[(j+1)%region.points.length]));})}));
 };
 const area=f=>{const frame=faceFrame(f);return Math.abs(signedArea(f.points.map(p=>inFrame(frame,p))))-(f.holes||[]).reduce((s,r)=>s+Math.abs(signedArea(r.map(p=>inFrame(frame,p)))),0);};
 const remaining=[];
 for(const side of sides){
  const overlaps=originals.filter(f=>coplanarContact(side,f)&&area(side)-difference(side,[f]).reduce((s,p)=>s+area(p),0)>1e-7);
  if(!overlaps.length){remaining.push(side);continue;}
  remaining.push(...difference(side,overlaps));
  for(const f of overlaps){const prior=changes.get(f.id)||{face:f,cuts:[]};prior.cuts.push(side);changes.set(f.id,prior);}
 }
 // Sub-micron residual strips are clipping noise between independently rounded
 // shared planes. They must not become selectable faces or dangling wire.
 const usable=f=>{const length=Math.max(...f.points.map((p,i)=>Math.hypot(...Object.values(sub(p,f.points[(i+1)%f.points.length])))));return length>1e-8&&area(f)/length>1e-6;};
 const replacements=[...changes.values()].map(({face,cuts})=>({face,pieces:difference(face,cuts).filter(p=>usable(p)&&!sweepRemnant(p,face))}));
 const output=[];
 for(const raw of remaining){let side=raw;if(!usable(side))continue;
  // A return extending a coplanar neighbor is part of that wall, not a new
  // dividing face. Merge only new return material; preserve other user seams.
  for(const neighbor of originals){
   if(!coplanarContact(side,neighbor))continue;
   let replacement=replacements.find(r=>r.face.id===neighbor.id),pieces=replacement?.pieces||[neighbor],merged=false;
   for(let i=0;i<pieces.length;i++){
    const f=pieces[i];if(!rings(side).some(r=>r.some((p,j)=>sharedIntervals(p,r[(j+1)%r.length],[f]).length)))continue;
    const frame=faceFrame(f),local=g=>({points:g.points.map(p=>inFrame(frame,p)),holes:(g.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))}),a=local(f),c=local(side);
    for(const ring of [c.points,...c.holes])for(const p of ring){let best=1e-5,q=null;for(const r of [a.points,...a.holes])for(let j=0;j<r.length;j++){const x=r[j],y=r[(j+1)%r.length],dx=y.x-x.x,dy=y.y-x.y,l2=dx*dx+dy*dy,t=l2?Math.max(0,Math.min(1,((p.x-x.x)*dx+(p.y-x.y)*dy)/l2)):0,h={x:x.x+t*dx,y:x.y+t*dy,z:0},d=Math.hypot(h.x-p.x,h.y-p.y);if(d<best){best=d;q=h;}}if(q)Object.assign(p,q);}
    const union=K.union([a,c]);if(union.length!==1)continue;
    const joined={...f,points:union[0].points.map(p=>fromFrame(frame,p)),holes:union[0].holes.map(r=>r.map(p=>fromFrame(frame,p)))};
    joined.retainedPoints=[...new Map([...(f.retainedPoints||[]),...rings(f).flat(),...(side.retainedPoints||[]),...rings(side).flat()].map(p=>[vertexKey(p),p])).values()];
    pieces=pieces.slice();pieces[i]=joined;if(replacement)replacement.pieces=pieces;else{replacement={face:neighbor,pieces};replacements.push(replacement);}merged=true;break;
   }
   if(merged){side=null;break;}
  }
  if(side)output.push(side);
 }
 return {sides:output,replacements};
}
const mix3=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const rings=f=>[f.points,...(f.holes||[])];
function sharedIntervals(a,b,faces){
 const ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,l2=ux*ux+uy*uy+uz*uz;if(l2<1e-12)return [];const intervals=[];
 const minX=Math.min(a.x,b.x)-1e-5,maxX=Math.max(a.x,b.x)+1e-5,minY=Math.min(a.y,b.y)-1e-5,maxY=Math.max(a.y,b.y)+1e-5,minZ=Math.min(a.z,b.z)-1e-5,maxZ=Math.max(a.z,b.z)+1e-5;
 // Reject distant segments before the exact collinearity/overlap test. Keep
 // the original tolerances; this only avoids work on impossible contacts.
 for(const face of faces){if(face.deleted)continue;for(const ring of rings(face))for(let i=0;i<ring.length;i++){
  const c=ring[i],d=ring[(i+1)%ring.length];
  if(Math.max(c.x,d.x)<minX||Math.min(c.x,d.x)>maxX||Math.max(c.y,d.y)<minY||Math.min(c.y,d.y)>maxY||Math.max(c.z,d.z)<minZ||Math.min(c.z,d.z)>maxZ)continue;
  const tc=((c.x-a.x)*ux+(c.y-a.y)*uy+(c.z-a.z)*uz)/l2,td=((d.x-a.x)*ux+(d.y-a.y)*uy+(d.z-a.z)*uz)/l2;
  if(Math.hypot(c.x-(a.x+ux*tc),c.y-(a.y+uy*tc),c.z-(a.z+uz*tc))>1e-5||Math.hypot(d.x-(a.x+ux*td),d.y-(a.y+uy*td),d.z-(a.z+uz*td))>1e-5)continue;
  const lo=Math.max(0,Math.min(tc,td)),hi=Math.min(1,Math.max(tc,td));if(hi-lo>1e-7)intervals.push([lo,hi]);
 }}
 intervals.sort((a,b)=>a[0]-b[0]);const merged=[];for(const pair of intervals){const last=merged.at(-1);if(last&&pair[0]<=last[1]+1e-7)last[1]=Math.max(last[1],pair[1]);else merged.push(pair);}return merged;
}
function freeEdges(face,supports){const edges=[];for(const ring of rings(face))for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];let lo=0;for(const [start,end]of [...sharedIntervals(a,b,supports),[1,1]]){if(start-lo>1e-7)edges.push([mix3(a,b,lo),mix3(a,b,start)]);lo=end;}}return edges;}
function pointOnEdge(p,a,b){const u=sub(b,a),l2=dot(u,u);if(l2<1e-12)return false;const t=dot(sub(p,a),u)/l2;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(...Object.values(sub(p,mix3(a,b,t))))<1e-5;}
function slideLines(faces,pairs,direction,amount,options={}){
 const bound=Math.abs(amount)>1e-12?bindSharedBase(faces):{faces,point:p=>p};faces=bound.faces;pairs=pairs.map(pair=>pair.map(bound.point));
 const selected=p=>pairs.some(([a,b])=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-8?Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)<1e-5:pointOnEdge(p,a,b)),vertices=[...pairs.flat(),...faces.flatMap(f=>[...rings(f).flat(),...(f.retainedPoints||[])])].filter(selected),moves=[];
 for(const p of vertices)if(!moves.some(m=>Math.hypot(...Object.values(sub(m.from,p)))<1e-6))moves.push({from:p,to:{x:p.x+direction.x*amount,y:p.y+direction.y*amount,z:p.z+direction.z*amount}});
 const matching=p=>moves.find(m=>Math.hypot(...Object.values(sub(m.from,p)))<1e-5),affected=[];
 const result=faces.map(f=>{if(f.deleted)return f;
  const replace=ring=>{const expanded=[];for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],u=sub(b,a);expanded.push(a);for(const p of pairs.flat().filter(p=>pointOnEdge(p,a,b)&&Math.hypot(...Object.values(sub(p,a)))>1e-5&&Math.hypot(...Object.values(sub(p,b)))>1e-5).sort((p,q)=>dot(sub(p,a),u)-dot(sub(q,a),u)))if(!expanded.some(q=>Math.hypot(...Object.values(sub(p,q)))<1e-5))expanded.push(p);}const translated=p=>({...p,...(matching(p)?.to||{})});
   // Extruding a boundary keeps transverse neighbor edges fixed and inserts
   // a connecting segment; edges parallel to the motion can shorten normally.
   const keep=(a,b)=>{if(!options.preserveConnections||!!matching(a)===!!matching(b))return false;const u=sub(b,a),d={x:direction.x*amount,y:direction.y*amount,z:direction.z*amount};return Math.hypot(u.y*d.z-u.z*d.y,u.z*d.x-u.x*d.z,u.x*d.y-u.y*d.x)>1e-7;};
   const moved=expanded.flatMap((p,i)=>{const prev=expanded[(i+expanded.length-1)%expanded.length],next=expanded[(i+1)%expanded.length];return [keep(prev,p)?p:translated(p),keep(p,next)?p:translated(p)];});return moved.filter((p,i)=>Math.hypot(...Object.values(sub(p,moved[(i+moved.length-1)%moved.length])))>1e-6);};
  const next=K.normalizeFace({...f,points:replace(f.points),holes:(f.holes||[]).map(replace),retainedPoints:(f.retainedPoints||[]).map(p=>({...p,...(matching(p)?.to||{})}))});
  if(JSON.stringify(next.points)===JSON.stringify(f.points)&&JSON.stringify(next.holes)===JSON.stringify(f.holes||[])&&JSON.stringify(next.retainedPoints)===JSON.stringify(f.retainedPoints||[]))return f;
  const frame=faceFrame(next);if(!frame||rings(next).flat().some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>1e-5))throw Error('That position would bend an adjoining face out of plane.');
  for(const ring of rings(next))baseGeometry().validate({points:ring.map(p=>inFrame(frame,p))});if(JSON.stringify(next.points)!==JSON.stringify(f.points)||JSON.stringify(next.holes)!==JSON.stringify(f.holes||[]))affected.push(f.id);return next;
 });return {faces:result,moves,affected,pairs:pairs.map(pair=>pair.map(p=>matching(p).to))};
}
// Carry coplanar finish strips with their support; shared ends on other planes
// follow the changed edge while their opposite ends stay fixed. Always evaluate
// from the gesture's original scene, never from the previous preview.
function ownsPoint(face,p){
 const frame=faceFrame(face);if(!frame)return false;const q=inFrame(frame,p);
 if(Math.abs(dot(sub(p,frame.origin),frame.n))>K.CONTACT)return false;
 const rs=rings(face).map(r=>r.map(p=>inFrame(frame,p)));
 return rs.some(r=>r.some((a,i)=>pointOnEdge(q,a,r[(i+1)%r.length])))||pointInRing(q,rs[0])&&!rs.slice(1).some(r=>pointInRing(q,r));
}
function trimRunMap(trim,map,keepStatic=false){
  // A trim run follows its supporting line. Moving one end sideways translates
  // the run across its width; only longitudinal displacement stretches its end.
  // Otherwise a vertical corner strip becomes a diagonal across the return wall.
  const run=(trim.trimData?.layers||[]).filter(l=>l.pair&&!l.joinIds).at(-1);
  if(run&&!keepStatic){const v=sub(run.pair[1],run.pair[0]),length=Math.hypot(v.x,v.y,v.z);if(length>K.CONTACT){const u={x:v.x/length,y:v.y/length,z:v.z/length},deltas=trim.points.map(p=>sub(map(p),p)),lateral=deltas.map(d=>{const t=dot(d,u);return {x:d.x-u.x*t,y:d.y-u.y*t,z:d.z-u.z*t};}),active=lateral.filter(d=>Math.hypot(d.x,d.y,d.z)>K.CONTACT);
   if(active.length&&active.every(d=>Math.hypot(...Object.values(sub(d,active[0])))<=K.CONTACT)){const offset=active[0],prior=map;map=p=>{const along=dot(sub(prior(p),p),u);return {...p,x:p.x+offset.x+u.x*along,y:p.y+offset.y+u.y*along,z:p.z+offset.z+u.z*along};};}
  }}
 return map;
}
function followTrim(scene,result,selectedIds=[],keepStatic=false){
 const selected=new Set(selectedIds),byId=new Map(result.faces.map(f=>[f.id,f]));
 const supports=scene.filter(f=>selected.has(f.id)&&!f.trim&&!f.feature&&!f.deleted).map(before=>({before,after:byId.get(before.id)})).filter(({before,after})=>after&&!after.deleted&&before.points.length===after.points.length);
 if(!supports.length)return result;
 const edges=f=>rings(f).flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]]));
 const changed=new Map(),maps=new Map(),fragments={};
 for(const trim of scene){if(!trim.trim||trim.deleted||trim.snapOnly||selected.has(trim.id))continue;
  let map=null;
  for(const {before,after}of supports){
   const shared=edges(trim).some(([a,b])=>sharedIntervals(a,b,[before]).some(([lo,hi])=>hi-lo>1e-6));
   const sameHost=trim.trimData?.host&&trim.trimData.host===before.trimData?.host;
   if(!shared&&!sameHost)continue;
   if(keepStatic){map=p=>({...p});break;}
   const n=normal(before.points),coplanar=n&&trim.points.every(p=>Math.abs(dot(sub(p,before.points[0]),n))<=K.CONTACT);
   const changes=before.points.map((p,i)=>sub(after.points[i],p)),delta=changes[0];
   const translation=changes.every(d=>Math.hypot(d.x-delta.x,d.y-delta.y,d.z-delta.z)<=K.CONTACT);
   const onEdge=p=>{for(let i=0;i<before.points.length;i++){const a=before.points[i],b=before.points[(i+1)%before.points.length];if(!pointOnEdge(p,a,b))continue;const u=sub(b,a),t=dot(sub(p,a),u)/dot(u,u);return mix3(after.points[i],after.points[(i+1)%after.points.length],t);}return null;};
   // A same-plane trim band is part of the face footprint, not a fixed neighbor.
   if(coplanar&&translation){map=p=>({ ...p,x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z});break;}
   if(coplanar){
    const boundary=before.points.map((a,i)=>({a,b:before.points[(i+1)%before.points.length],i})).filter(({a,b})=>sharedIntervals(a,b,[trim]).length);
    if(boundary.length){const edge=boundary.sort((a,b)=>Math.hypot(...Object.values(sub(b.b,b.a)))-Math.hypot(...Object.values(sub(a.b,a.a))))[0],u=sub(edge.b,edge.a),d0=changes[edge.i],d1=changes[(edge.i+1)%changes.length];
     map=p=>{const t=dot(sub(p,edge.a),u)/dot(u,u),d=mix3(d0,d1,t);return {...p,x:p.x+d.x,y:p.y+d.y,z:p.z+d.z};};break;
    }
   }
   if(coplanar&&sameHost){
    const origin=before.points[0],i=before.points.reduce((best,p,j)=>dot(sub(p,origin),sub(p,origin))>dot(sub(before.points[best],origin),sub(before.points[best],origin))?j:best,1),u=sub(before.points[i],origin),j=before.points.reduce((best,p,k)=>dot(cross(u,sub(p,origin)),cross(u,sub(p,origin)))>dot(cross(u,sub(before.points[best],origin)),cross(u,sub(before.points[best],origin)))?k:best,0),v=sub(before.points[j],origin),aa=dot(u,u),bb=dot(v,v),ab=dot(u,v),det=aa*bb-ab*ab;
    if(det>1e-16){map=p=>{const q=sub(p,origin),a=(dot(q,u)*bb-dot(q,v)*ab)/det,b=(dot(q,v)*aa-dot(q,u)*ab)/det;return {...p,...Object.fromEntries(['x','y','z'].map(k=>[k,p[k]+delta[k]+a*(changes[i][k]-delta[k])+b*(changes[j][k]-delta[k])]))};};break;}
   }
   const prior=map;map=p=>({...p,...(onEdge(p)||prior?.(p)||p)});
  }
  if(!map)continue;
  map=trimRunMap(trim,map,keepStatic);
  const next={...trim,...K.mapCurveData(trim,map),points:trim.points.map(map),holes:(trim.holes||[]).map(r=>r.map(map)),retainedPoints:(trim.retainedPoints||[]).filter(p=>ownsPoint(trim,p)).map(map)};
  if(trim.trimData)next.trimData={...trim.trimData,layers:trim.trimData.layers.map(l=>({...l,pair:l.pair?.map(map)}))};
  changed.set(trim.id,next);maps.set(trim.id,map);
 }
 // A corner run owns strips on both incident faces and its join cells. Follow
 // the saved run identity across those faces rather than guessing by angle.
 const runMaps=new Map(),seeds=new Set();
 for(const f of scene){if(!changed.has(f.id)||!supports.some(({before})=>{const n=normal(before.points);return n&&f.points.every(p=>Math.abs(dot(sub(p,before.points[0]),n))<=K.CONTACT);}))continue;const map=maps.get(f.id);seeds.add(f.id);
  if(!f.points.some(p=>Math.hypot(...Object.values(sub(map(p),p)))>1e-8)&&!keepStatic)continue;
  for(const layer of f.trimData?.layers||[])if(!layer.joinIds){if(!runMaps.has(layer.id))runMaps.set(layer.id,[]);runMaps.get(layer.id).push({map,face:f,pair:layer.pair});}
 }
 for(const trim of scene){if(!trim.trim||trim.deleted||trim.snapOnly||selected.has(trim.id)||seeds.has(trim.id))continue;
  const candidates=(trim.trimData?.layers||[]).flatMap(l=>[l.id,...(l.joinIds||[])].flatMap(id=>runMaps.get(id)||[]));
  const source=candidates.find(({face,pair})=>{if(!pair)return false;const u=sub(pair[1],pair[0]),ts=f=>f.points.map(p=>dot(sub(p,pair[0]),u)),a=ts(face),b=ts(trim);return Math.min(Math.max(...a),Math.max(...b))-Math.max(Math.min(...a),Math.min(...b))>K.CONTACT*Math.hypot(u.x,u.y,u.z);});if(!source)continue;const map=source.map;
  const next={...trim,...K.mapCurveData(trim,map),points:trim.points.map(map),holes:(trim.holes||[]).map(r=>r.map(map)),retainedPoints:(trim.retainedPoints||[]).filter(p=>ownsPoint(trim,p)).map(map),trimData:{...trim.trimData,layers:trim.trimData.layers.map(l=>({...l,pair:l.pair?.map(map)}))}};
  changed.set(trim.id,next);maps.set(trim.id,map);
 }
 for(const [id,face]of changed)try{K.validateFace(face);}catch(e){e.message+=' [trim '+id+']';throw e;}
 // Repair the other side of each moved trim boundary as part of the same
 // transaction. This stretches return-wall faces and the ends of crossing bands.
 const bindings=scene.filter(f=>maps.has(f.id)).flatMap(f=>edges(f).map(([a,b])=>({a,b,map:maps.get(f.id)})));
 const bindingPoint=(p,available)=>{for(const {a,b,map}of available)if(pointOnEdge(p,a,b)){const q=map(p);if(Math.hypot(...Object.values(sub(q,p)))>1e-8)return {...p,...q};}return p;},bind=p=>bindingPoint(p,bindings);
 if(!keepStatic)for(const face of [...scene.filter(f=>f.trim),...scene.filter(f=>!f.trim)]){if(selected.has(face.id)||changed.has(face.id)||face.feature||face.deleted||face.snapOnly)continue;
  if(!rings(face).flat().some(p=>bind(p)!==p))continue;
  const available=bindings.slice(),map=face.trim?trimRunMap(face,p=>bindingPoint(p,available)):p=>bindingPoint(p,available);
  const next={...face,points:face.points.map(map),holes:(face.holes||[]).map(r=>r.map(map)),retainedPoints:(face.retainedPoints||[]).filter(p=>!face.trim||ownsPoint(face,p)).map(map)};
  if(face.trimData)next.trimData={...face.trimData,layers:face.trimData.layers.map(l=>({...l,pair:l.pair?.map(map)}))};
  const support=faceFrame(face);if(!support||next.points.some(p=>Math.abs(dot(sub(p,support.origin),support.n))>K.CONTACT))continue;
  const normalized=[K.normalizeFace(next,true)].flat();normalized.forEach(K.validateFace);changed.set(face.id,normalized[0]);if(normalized.length>1)fragments[face.id]=normalized.slice(1);maps.set(face.id,map);if(face.trim)bindings.push(...edges(face).map(([a,b])=>({a,b,map})));
 }
 // Publish one authoritative destination for each anchor. Intermediate corner
 // maps must not leave duplicate moves whose first entry wins in draft rebinding.
 const finalMoves=new Map((result.moves||[]).map(m=>[vertexKey(m.from),m]));
 for(const face of scene)if(changed.has(face.id)){const map=maps.get(face.id)||bind;for(const p of [...rings(face).flat(),...(face.retainedPoints||[]).filter(p=>ownsPoint(face,p))]){const to=map(p);if(Math.hypot(...Object.values(sub(to,p)))>1e-8)finalMoves.set(vertexKey(p),{from:p,to});}}
 return {...result,trimFragments:fragments,faces:result.faces.flatMap(f=>[changed.get(f.id)||f,...(fragments[f.id]||[])]),moves:[...finalMoves.values()],affected:[...new Set([...(result.affected||[]),...changed.keys(),...Object.values(fragments).flat().map(f=>f.id)])]};
}
// Stickers belong to the supporting footprint, including its opening holes.
function mountedStickers(faces,source){
 if(!source||source.feature)return [];
 return faces.filter(f=>f.id!==source.id&&f.feature&&!f.deleted&&!f.snapOnly&&containedBy(f,{...source,holes:[]}));
}
function moveFabric(faces,id,amount,options={}){
 const source=faces.find(f=>f.id===id),n=source&&normal(source.points);if(!n)throw Error('Select a valid face.');
 const graph=K.topology(faces.filter(f=>!f.deleted),faces.flatMap(f=>f.retainedPoints||[]));
 const attached=new Set(mountedStickers(faces,source).map(f=>f.id));
 const moves=graph.vertices.filter(v=>v.faces.has(id)||[...v.faces].some(id=>attached.has(id))||v.anchors.some(p=>(source.retainedPoints||[]).some(q=>Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z)<=K.CONTACT))).map(v=>v.point).map(p=>({from:p,to:{x:p.x+n.x*amount,y:p.y+n.y*amount,z:p.z+n.z*amount}}));
 const replace=ring=>{const expanded=[];for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],u=sub(b,a),l2=dot(u,u);expanded.push(a);const cuts=moves.filter(m=>pointOnEdge(m.from,a,b)).map(m=>({p:m.from,t:l2?dot(sub(m.from,a),u)/l2:0})).filter(v=>v.t>1e-6&&v.t<1-1e-6).sort((a,b)=>a.t-b.t);for(const v of cuts)if(!expanded.some(p=>vertexKey(p)===vertexKey(v.p)))expanded.push(v.p);}return expanded.map(p=>({...p,...(moves.find(m=>Math.hypot(m.from.x-p.x,m.from.y-p.y,m.from.z-p.z)<=K.CONTACT)?.to||{})}));};
 const affected=new Set([id]);
 const moved=faces.map(f=>{if(f.deleted)return f;const next={...f,retainedPoints:(f.retainedPoints||[]).map(p=>({...p,...(moves.find(m=>Math.hypot(m.from.x-p.x,m.from.y-p.y,m.from.z-p.z)<=K.CONTACT)?.to||{})})),points:replace(f.points),holes:(f.holes||[]).map(replace)};if(JSON.stringify(next.points)===JSON.stringify(f.points)&&JSON.stringify(next.holes)===JSON.stringify(f.holes||[]))return f;affected.add(f.id);
  return next;
 });
 // The caller may construct connecting returns, but must never silently detach.
 const result=followTrim(faces,{faces:moved,moves,affected:[...affected],detached:false},[id],options.keepTrimStatic);
 // Validate after attachment updates: the intermediate shared-edge move can
 // temporarily fold a strip whose complete footprint is about to follow.
 try{for(const f of result.faces)if(result.affected.includes(f.id)&&!f.deleted)K.validateFace(f);}catch{throw Error('Moving this face requires connecting returns.');}
 return result;
}
function moveSurface(faces,id,amount,options={}){
 const original=faces.find(f=>f.id===id);if(!original)throw Error('Select an existing face.');const n=normal(original.points);if(!n)throw Error('The selected face has no area.');const moves=[];
 const graph=K.topology(faces.filter(f=>!f.deleted),faces.flatMap(f=>f.retainedPoints||[]));
 const attached=new Set(mountedStickers(faces,original).map(f=>f.id));
 for(const p of graph.vertices.filter(v=>v.faces.has(id)||[...v.faces].some(id=>attached.has(id))||v.anchors.some(p=>(original.retainedPoints||[]).some(q=>Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z)<=K.CONTACT))).map(v=>v.point)){
  const constraints=[{n,value:amount}];for(const other of faces.filter(f=>f.id!==id&&!f.deleted)){const nn=normal(other.points);if(nn&&Math.abs(dot(n,nn))<.99999&&rings(other).some(r=>r.some((a,i)=>pointOnEdge(p,a,r[(i+1)%r.length]))))constraints.push({n:nn,value:0});}
  // Minimum displacement satisfying the translated face and fixed neighbor planes.
  const basis=[];for(const c of constraints){let v={...c.n},value=c.value;for(const b of basis){const t=dot(v,b.v);v={x:v.x-t*b.v.x,y:v.y-t*b.v.y,z:v.z-t*b.v.z};value-=t*b.value;}const len=Math.hypot(v.x,v.y,v.z);if(len<1e-8){if(Math.abs(value)>1e-5)throw Error('This corner cannot move while preserving its connected planes.');continue;}basis.push({v:{x:v.x/len,y:v.y/len,z:v.z/len},value:value/len});}
  const delta=basis.reduce((d,b)=>({x:d.x+b.v.x*b.value,y:d.y+b.v.y*b.value,z:d.z+b.v.z*b.value}),{x:0,y:0,z:0});moves.push({from:p,to:{x:p.x+delta.x,y:p.y+delta.y,z:p.z+delta.z}});
 }
 const moved=faces.map(f=>{const replace=ring=>{const expanded=[];for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],u=sub(b,a),l2=dot(u,u);expanded.push(a);const inserts=moves.filter(m=>pointOnEdge(m.from,a,b)).map(m=>({p:m.from,t:l2?dot(sub(m.from,a),u)/l2:0})).filter(v=>v.t>1e-6&&v.t<1-1e-6).sort((a,b)=>a.t-b.t);for(const v of inserts)if(!expanded.some(p=>vertexKey(p)===vertexKey(v.p)))expanded.push(v.p);}return expanded.map(p=>({...p,...(moves.find(m=>Math.hypot(m.from.x-p.x,m.from.y-p.y,m.from.z-p.z)<=K.CONTACT)?.to||{})}));};return {...f,retainedPoints:(f.retainedPoints||[]).map(p=>({...p,...(moves.find(m=>Math.hypot(m.from.x-p.x,m.from.y-p.y,m.from.z-p.z)<=K.CONTACT)?.to||{})})),points:replace(f.points),holes:(f.holes||[]).map(replace)};});
 const selected=moved.find(f=>f.id===id);delete selected.attachment;return followTrim(faces,{faces:moved,moves},[id],options.keepTrimStatic);
}
function snapDirection(origin,p,edges,tolerance=.1){const dx=p.x-origin.x,dy=p.y-origin.y,len=Math.hypot(dx,dy);if(len<1e-9)return p;const dirs=[];for(let i=0;i<8;i++)dirs.push({x:Math.cos(i*Math.PI/4),y:Math.sin(i*Math.PI/4),label:'45-degree grid'});for(const [a,b]of edges){const x=b.x-a.x,y=b.y-a.y,l=Math.hypot(x,y);if(l>1e-8)dirs.push({x:x/l,y:y/l,label:'Parallel to edge'});}
 let best=tolerance,result=p;for(const u of dirs){const t=dx*u.x+dy*u.y,q={x:origin.x+t*u.x,y:origin.y+t*u.y,z:0},d=Math.hypot(q.x-p.x,q.y-p.y);if(d<best){best=d;result={...q,snapLabel:u.label};}}return result;}
function bridges(before,changed,excluded,existing=[]){
 const vertices=w=>[...w.bottom,...w.top],mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
 const output=JSON.parse(JSON.stringify(existing));
 for(const f of output){const a=f.attachment,w=a&&changed.find(w=>w.id===a.wallId);if(w){const ps=vertices(w);f.points[2]=mix(ps[a.a],ps[a.b],a.t1);f.points[3]=mix(ps[a.a],ps[a.b],a.t0);}}
 for(const w of before.filter(w=>!excluded.includes(w.id))){const moved=changed.find(v=>v.id===w.id);if(!moved)continue;const ps=vertices(w),qs=vertices(moved);
  for(const other of before.filter(w=>excluded.includes(w.id)))for(const [a,b]of [[0,1],[1,3],[3,2],[2,0]])for(const [c,d]of [[0,1],[1,3],[3,2],[2,0]]){
   const vs=vertices(other),u=sub(ps[b],ps[a]),len=dot(u,u);if(len<1e-10)continue;const project=p=>dot(sub(p,ps[a]),u)/len;
   if([vs[c],vs[d]].some(p=>{const t=project(p),q=mix(ps[a],ps[b],t);return Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)>.02;}))continue;
   const ts=[project(vs[c]),project(vs[d])].sort((a,b)=>a-b),t0=Math.max(0,ts[0]),t1=Math.min(1,ts[1]);if((t1-t0)*Math.sqrt(len)<.02)continue;
   const id='bridge-'+w.id+'-'+a+'-'+b+'-'+other.id;if(output.some(f=>f.id===id))continue;
   const points=[mix(ps[a],ps[b],t0),mix(ps[a],ps[b],t1),mix(qs[a],qs[b],t1),mix(qs[a],qs[b],t0)];if(!normal(points))continue;output.push({id,points,holes:[],attachment:{wallId:w.id,a,b,t0,t1}});
  }
 }
 return output;
}
// Project the normal into the current view; only a face-on depth axis needs a fallback.
function dragAmount(axis,dx,dy){const l2=axis.x*axis.x+axis.y*axis.y;return l2>64?(dx*axis.x+dy*axis.y)/l2:-dy*.03;}
const baseGeometry=()=>typeof module!=='undefined'&&module.exports?require('./base_geometry.js'):root.BaseGeometry;
const signedArea=ps=>ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2;
function subtract(face,cuts){const plane=wallGeometry().plane(face.points);return K.pieces(K.difference(face,cuts.filter(c=>!c.faceIds||c.faceIds.includes(face.id)))).map(r=>r.map(p=>({...p,z:plane?plane.dx*p.x+plane.dy*p.y+plane.k:0})));}
function snapBase(face,amount,faces){
 const n=normal(face.points);if(!n||face.holes?.length)return null;let best=null;
 for(const base of faces){const bn=normal(base.points);if(!bn||Math.abs(dot(n,bn))<.99999)continue;
  const distance=dot(sub(base.points[0],face.points[0]),bn)/dot(n,bn),points=face.points.map(p=>({x:p.x+n.x*distance,y:p.y+n.y*distance,z:p.z+n.z*distance}));
  if(base.points.some(p=>Math.abs(dot(sub(p,base.points[0]),bn))>.01))continue;
  const original=Math.abs(signedArea(base.points)),remaining=subtract(base,[{points}]).reduce((s,p)=>s+Math.abs(signedArea(p)),0);if(original-remaining<.0001)continue;
  if(best&&Math.abs(distance-best.amount)<.001)best.faceIds.push(base.id);
  else if(!best||Math.abs(distance-amount)<Math.abs(best.amount-amount))best={amount:distance,faceIds:[base.id]};
 }return best;
}
// Restrict deletion to the connected base footprint under the original face.
const wallGeometry=()=>typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
function baseScope(face,faces){
 const G=wallGeometry(),area=ps=>Math.abs(signedArea(ps));
 const on=(p,a,b)=>{const u=sub(b,a),l=u.x*u.x+u.y*u.y,t=l?((p.x-a.x)*u.x+(p.y-a.y)*u.y)/l:-1;return t>=-1e-7&&t<=1+1e-7&&Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)<1e-6*Math.sqrt(l);};
 const matches=b=>face.structureId==null||b.structureId==null||face.structureId===b.structureId;
 const candidates=faces.filter(matches),chosen=new Set(candidates.filter(b=>face.points.some(p=>G.contains(b,p)||b.points.some((a,i)=>on(p,a,b.points[(i+1)%b.points.length])))||(area(face.points)>1e-8&&area(face.points)-subtract(face,[b]).reduce((s,p)=>s+area(p),0)>1e-8)));
 let changed=true;while(changed){changed=false;for(const b of candidates){if(chosen.has(b))continue;const connected=[...chosen].some(a=>a.points.some((p,i)=>b.points.some((q,j)=>{const r=a.points[(i+1)%a.points.length],s=b.points[(j+1)%b.points.length],dx=r.x-p.x,dy=r.y-p.y,l=Math.hypot(dx,dy);if(l<1e-8||Math.abs((s.x-q.x)*dy-(s.y-q.y)*dx)>1e-7*l||Math.abs((q.x-p.x)*dy-(q.y-p.y)*dx)>1e-7*l)return false;const ts=[((q.x-p.x)*dx+(q.y-p.y)*dy)/l,((s.x-p.x)*dx+(s.y-p.y)*dy)/l].sort((a,b)=>a-b);return Math.min(l,ts[1])-Math.max(0,ts[0])>1e-5;})));if(connected){chosen.add(b);changed=true;}}}
 return [...chosen];
}
function clipTriangle(points,triangle){
 if(signedArea(triangle)<0)triangle=triangle.slice().reverse();let out=points;
 for(let i=0;i<3&&out.length;i++){const a=triangle[i],b=triangle[(i+1)%3],side=p=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x),next=[];for(let j=0;j<out.length;j++){const p=out[j],q=out[(j+1)%out.length],dp=side(p),dq=side(q),ip=dp>=-1e-9,iq=dq>=-1e-9;if(ip)next.push(p);if(ip!==iq){const t=dp/(dp-dq);next.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,z:p.z+(q.z-p.z)*t});}}out=next.filter((p,j)=>{const q=next[(j+next.length-1)%next.length];return Math.hypot(p.x-q.x,p.y-q.y)>1e-10;});}return out;
}
function belowBase(face,faces){
 if(!faces.length)return null;const G=wallGeometry(),B=baseGeometry(),area=Math.abs(signedArea(face.points));
 if(area<1e-8||Math.abs(normal(face.points)?.z||0)<K.CONTACT){
  // A vertical face projects to line intervals, so test their full coverage.
  for(let i=0;i<face.points.length;i++){const a=face.points[i],b=face.points[(i+1)%face.points.length],u=sub(b,a),ts=[0,1];
   for(const base of faces)for(let j=0;j<base.points.length;j++){const c=base.points[j],d=base.points[(j+1)%base.points.length],v=sub(d,c),den=u.x*v.y-u.y*v.x;if(Math.abs(den)<1e-10)continue;const t=((c.x-a.x)*v.y-(c.y-a.y)*v.x)/den,q=((c.x-a.x)*u.y-(c.y-a.y)*u.x)/den;if(t>0&&t<1&&q>=0&&q<=1)ts.push(t);}
   ts.sort((a,b)=>a-b);const at=t=>({x:a.x+u.x*t,y:a.y+u.y*t,z:a.z+u.z*t});
   for(let j=1;j<ts.length;j++){const midpoint=at((ts[j-1]+ts[j])/2),covered=faces.filter(base=>B.triangles(base.points).some(ids=>{let triangle=ids.map(i=>base.points[i]);if(signedArea(triangle)<0)triangle.reverse();return triangle.every((p,k)=>{const q=triangle[(k+1)%3];return (q.x-p.x)*(midpoint.y-p.y)-(q.y-p.y)*(midpoint.x-p.x)>=-1e-8;});}));if(!covered.length)return null;for(const base of covered){const pl=G.plane(base.points);if(!pl||[at(ts[j-1]),at(ts[j])].some(p=>p.z>=pl.dx*p.x+pl.dy*p.y+pl.k-1e-5))return null;}}
  }return {cuts:[]};
 }
 // Uncovered footprint is never enough evidence to delete a face.
 if(subtract(face,faces).reduce((s,p)=>s+Math.abs(signedArea(p)),0)>Math.max(1e-8,area*1e-7))return null;
 // Triangulate on the face's supporting plane before projecting to XY.
 // Nearly vertical valid faces can have crossed/degenerate XY projections.
 const sourceFrame=faceFrame(face),sourcePoints=rings(face).flat(),sourceTriangles=K.triangles(face.points.map(p=>K.local(sourceFrame,p)),(face.holes||[]).map(r=>r.map(p=>K.local(sourceFrame,p)))).triangles;
 const cuts=[];
 for(const base of faces){const plane=G.plane(base.points);if(!plane)continue;
  for(const t of sourceTriangles)for(const u of B.triangles(base.points)){
   const poly=clipTriangle(t.map(i=>sourcePoints[i]),u.map(i=>base.points[i]));if(poly.length<3||Math.abs(signedArea(poly))<1e-8)continue;
   if(poly.some(p=>p.z>=plane.dx*p.x+plane.dy*p.y+plane.k-1e-5))return null;
   cuts.push({faceIds:[base.id],points:poly.map(p=>({...p,z:plane.dx*p.x+plane.dy*p.y+plane.k}))});
  }
 }return cuts.length?{cuts}:null;
}
// Face-local roof-style inference, measured in screen pixels under the current camera.
function draftSnap(raw,nodes,edges,anchors,screen,radius=20){
 const cursor=screen(raw),distance=p=>{const q=screen(p);return Math.hypot(q.x-cursor.x,q.y-cursor.y);},guide=(p,u)=>({p1:p,p2:{x:p.x+u.x,y:p.y+u.y}}),guides=[],seen=new Set();
 const addGuide=(p,u)=>{const l=Math.hypot(u.x,u.y);if(l<1e-9)return;u={x:u.x/l,y:u.y/l};if(u.x<0||(Math.abs(u.x)<1e-9&&u.y<0))u={x:-u.x,y:-u.y};const key=[u.x,u.y,p.x*-u.y+p.y*u.x].map(x=>x.toFixed(5)).join(',');if(!seen.has(key)){seen.add(key);guides.push(guide(p,u));}};
 const project=g=>{const dx=g.p2.x-g.p1.x,dy=g.p2.y-g.p1.y,t=((raw.x-g.p1.x)*dx+(raw.y-g.p1.y)*dy)/(dx*dx+dy*dy);return {x:g.p1.x+t*dx,y:g.p1.y+t*dy,z:0};};
 const direct=[];for(const n of nodes)direct.push({point:n,guides:[],kind:'Point'});
 // Curve tessellation supplies finite snap edges, never synthetic midpoints or angle guides.
 for(const pair of edges){if(pair.curveId)continue;const [a,b]=pair,u={x:b.x-a.x,y:b.y-a.y};direct.push({point:{x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:0},guides:[guide(a,u)],kind:'Midpoint'});
  addGuide(a,u);for(const origin of [a,b,...anchors])for(const angle of [0,Math.PI/4,Math.PI/2,-Math.PI/4])addGuide(origin,{x:u.x*Math.cos(angle)-u.y*Math.sin(angle),y:u.x*Math.sin(angle)+u.y*Math.cos(angle)});
 }
 for(const p of [...nodes,...anchors])for(let i=0;i<4;i++)addGuide(p,{x:Math.cos(i*Math.PI/4),y:Math.sin(i*Math.PI/4)});
 const directHit=direct.map(c=>({...c,d:distance(c.point)})).filter(c=>c.d<radius).sort((a,b)=>a.d-b.d)[0];
 // Find the closest point on the *projected finite edge*. A perpendicular
 // projection in face coordinates is not perpendicular after perspective.
 const edgeHits=edges.map(([a,b])=>{
  let lo=0,hi=1;for(let i=0;i<36;i++){const t1=lo+(hi-lo)/3,t2=hi-(hi-lo)/3;if(distance(mix3({...a,z:0},{...b,z:0},t1))<distance(mix3({...a,z:0},{...b,z:0},t2)))hi=t2;else lo=t1;}
  let t=(lo+hi)/2;const dx=b.x-a.x,dy=b.y-a.y,local=Math.max(0,Math.min(1,((raw.x-a.x)*dx+(raw.y-a.y)*dy)/(dx*dx+dy*dy)));
  const at=t=>({x:a.x+dx*t,y:a.y+dy*t,z:0});if(distance(at(local))<=distance(at(t))+1e-8)t=local;
  const point=at(t);return {a,b,point,d:distance(point)};
 }).filter(h=>h.d<radius).sort((a,b)=>a.d-b.d);
 const edge=edgeHits[0];
 if(directHit&&(!edge||pointOnEdge({...directHit.point,z:0},{...edge.a,z:0},{...edge.b,z:0})||directHit.d<edge.d))return directHit;
 if(edge){
  const {a,b}=edge,u={x:b.x-a.x,y:b.y-a.y},hits=[];
  // Preserve horizontal/parallel alignment, but constrain it to the real edge.
  for(const g of guides){const v={x:g.p2.x-g.p1.x,y:g.p2.y-g.p1.y},den=u.x*v.y-u.y*v.x;if(Math.abs(den)<1e-9)continue;
   const t=((g.p1.x-a.x)*v.y-(g.p1.y-a.y)*v.x)/den;if(t<0||t>1)continue;
   const point={x:a.x+t*u.x,y:a.y+t*u.y,z:0},d=distance(point);if(d<radius)hits.push({point,d,guides:[guide(a,u),g],kind:'Edge intersection'});
  }
  if(hits.length)return hits.sort((a,b)=>a.d-b.d)[0];
  return {point:edge.point,guides:[guide(a,u)],kind:'Edge'};
 }
 if(directHit)return directHit;
 const near=guides.map(g=>({g,p:project(g)})).map(c=>({...c,d:distance(c.p)})).filter(c=>c.d<radius*3).sort((a,b)=>a.d-b.d).slice(0,48),hits=[];
 for(let i=0;i<near.length;i++)for(let j=i+1;j<near.length;j++){const a=near[i].g,b=near[j].g,u={x:a.p2.x-a.p1.x,y:a.p2.y-a.p1.y},v={x:b.p2.x-b.p1.x,y:b.p2.y-b.p1.y},den=u.x*v.y-u.y*v.x;if(Math.abs(den)<1e-8)continue;const t=((b.p1.x-a.p1.x)*v.y-(b.p1.y-a.p1.y)*v.x)/den,p={x:a.p1.x+t*u.x,y:a.p1.y+t*u.y,z:0},d=distance(p);if(d<radius)hits.push({point:p,guides:[a,b],d,kind:'Guide intersection'});}
 if(hits.length)return hits.sort((a,b)=>a.d-b.d)[0];const single=near.find(c=>c.d<radius);return single?{point:single.p,guides:[single.g],kind:'Guide'}:{point:raw,guides:[],kind:null};
}
// Solve snaps through the quadrilateral construction, so fixed corners and the
// rectangle/circle constraint stay intact while a derived corner finds a guide.
function quadDraftSnap(raw,corners,nodes,edges,anchors,screen,radius=20){
 const initial=corners(raw),origin=screen(raw);let best=null;
 for(let i=0;i<initial.length;i++){
  const hit=draftSnap(initial[i],nodes,edges,anchors,screen,radius);if(!hit.kind)continue;
  const guides=hit.guides.length?hit.guides:[{p1:hit.point,p2:{x:hit.point.x+1,y:hit.point.y}},{p1:hit.point,p2:{x:hit.point.x,y:hit.point.y+1}}];
  const equations=guides.map(g=>{const dx=g.p2.x-g.p1.x,dy=g.p2.y-g.p1.y,len=Math.hypot(dx,dy);return p=>{const q=corners(p)[i];return ((q.x-g.p1.x)*dy-(q.y-g.p1.y)*dx)/len;};});
  let p={...raw},movable=false;for(let iteration=0;iteration<20;iteration++)for(const fn of equations){const f=fn(p),h=1e-5,gx=(fn({...p,x:p.x+h})-f)/h,gy=(fn({...p,y:p.y+h})-f)/h,l2=gx*gx+gy*gy;if(l2<1e-10)continue;movable=true;p.x-=f*gx/l2;p.y-=f*gy/l2;}
  if(!movable||equations.some(fn=>Math.abs(fn(p))>1e-5))continue;const q=screen(p),distance=Math.hypot(q.x-origin.x,q.y-origin.y);
  // Ignore alignments inherent in the rectangle itself; they must not mask a
  // nearby opposite-corner constraint that actually changes its construction.
  if(distance<1e-5||distance>radius||!Number.isFinite(distance))continue;
  const priority=['Point','Midpoint'].includes(hit.kind)?0:hit.kind==='Guide intersection'?1:2;
  if(!best||priority<best.priority||priority===best.priority&&distance<best.distance)best={point:p,guides,kind:'Quadrilateral '+hit.kind.toLowerCase(),distance,priority};
 }
 return best;
}
// Face visibility is independent of its retained boundary wire.
const vertexKey=p=>[p.x,p.y,p.z].map(v=>Number(v).toFixed(6)).join(',');
const edgeKey=(a,b)=>[vertexKey(a),vertexKey(b)].sort().join('|');
// Sorted-axis broad phase for point/segment contact searches. Query the most
// selective axis, then apply the full box; callers retain their exact contact test.
function pointRangeIndex(points){
 const axes=['x','y','z'],sorted=axes.map(axis=>points.slice().sort((a,b)=>a[axis]-b[axis]));
 const lower=(ps,axis,value)=>{let lo=0,hi=ps.length;while(lo<hi){const mid=(lo+hi)>>>1;if(ps[mid][axis]<value)lo=mid+1;else hi=mid;}return lo;};
 return {segment(a,b,tolerance=1e-5){const boxes=axes.map(axis=>[Math.min(a[axis],b[axis])-tolerance,Math.max(a[axis],b[axis])+tolerance]);let best=null;
  for(let i=0;i<3;i++){const ps=sorted[i],axis=axes[i],[min,max]=boxes[i],lo=lower(ps,axis,min);let hi=lower(ps,axis,max);while(hi<ps.length&&ps[hi][axis]===max)hi++;if(!best||hi-lo<best.hi-best.lo)best={ps,lo,hi};}
  return best.ps.slice(best.lo,best.hi).filter(p=>axes.every((axis,i)=>p[axis]>=boxes[i][0]&&p[axis]<=boxes[i][1]));
 }};
}

function surfaceWire(edits){const curved=K.compactSurfaces(edits.$surfaces||[]).filter(f=>f.curvedSurface?.logical&&!f.deleted&&!f.drafted);edits={...edits,$surfaces:(edits.$surfaces||[]).filter(f=>!f.curvedSurface)};const nodes=new Map(),edges=new Map(),removed=new Set(edits.$removedSurfacePoints||[]),removedEdges=new Set(edits.$removedSurfaceEdges||[]);
 const cuts=[...removedEdges].map(key=>({points:key.split('|').map(s=>{const [x,y,z]=s.split(',').map(Number);return {x,y,z};})})).filter(f=>f.points.length===2&&f.points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));
 for(const f of (edits.$surfaces||[]).filter(f=>!f.drafted&&!f.replacedBy))for(const p of (f.retainedPoints||[]).filter(p=>!f.trim||ownsPoint(f,p))){const k=vertexKey(p);if(!removed.has(k))nodes.set(k,{...p,id:k});}
 for(const f of (edits.$surfaces||[]).filter(f=>!f.drafted&&!f.replacedBy))for(const ring of [f.points,...(f.holes||[])])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],ka=vertexKey(a),kb=vertexKey(b);if(!removed.has(ka))nodes.set(ka,{...a,id:ka});if(removed.has(ka)||removed.has(kb))continue;const at=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});let lo=0;for(const [start,end]of [...sharedIntervals(a,b,cuts),[1,1]]){if(start-lo>1e-7){const x=at(lo),y=at(start),kx=vertexKey(x),ky=vertexKey(y),key=edgeKey(x,y);nodes.set(kx,{...x,id:kx});nodes.set(ky,{...y,id:ky});edges.set(key,{id:key,a:kx,b:ky});}lo=end;}}
 const curvedOwners=new Map();for(const f of edits.$surfaces||[])if(!f.drafted&&f.curvedSurface){const {range,...surface}=f.curvedSurface,key=JSON.stringify(surface)+':'+(f.material||'')+':'+(f.finishColor||'');for(const r of rings(f))for(let i=0;i<r.length;i++){const id=edgeKey(r[i],r[(i+1)%r.length]);if(!curvedOwners.has(id))curvedOwners.set(id,[]);curvedOwners.get(id).push(key);}}
 for(const [id,owners]of curvedOwners)if(owners.length===2&&owners[0]===owners[1])edges.delete(id);
 for(const p of edits.$loose?.points||[]){const k=vertexKey(p);if(!removed.has(k))nodes.set(k,{...p,id:k});}
 for(const pair of edits.$loose?.edges||[]){const [a,b]=pair,ka=vertexKey(a),kb=vertexKey(b),key=edgeKey(a,b);if(removed.has(ka)||removed.has(kb)||removedEdges.has(key))continue;nodes.set(ka,{...a,id:ka});nodes.set(kb,{...b,id:kb});edges.set(key,{id:key,a:ka,b:kb});}
 for(const f of curved){const mesh=K.surfaceMesh(f),anchors=new Set(f.points.map(vertexKey));
  const onBoundary=p=>{const uv=K.surfaceUV(f.curvedSurface,p);if(!Number.isFinite(uv.x)||Math.hypot(...Object.values(sub(K.surfacePoint(f.curvedSurface,uv.x,uv.y),p)))>.002)return false;return f.curvedSurface.domains.some(d=>[d.points,...(d.holes||[])].some(r=>r.some((a,i)=>pointOnEdge(uv,{...a,z:0},{...r[(i+1)%r.length],z:0}))));};
  for(const n of nodes.values())if(!anchors.has(n.id)&&onBoundary(n))n.curveSample=true;
  for(const [id,e]of edges)if(onBoundary(nodes.get(e.a))&&onBoundary(nodes.get(e.b)))edges.delete(id);
  for(const [index,ps]of mesh.boundaries.entries()){const id=f.id+'~curve-'+index;for(let i=0;i<ps.length;i++){const p=ps[i],key=vertexKey(p);nodes.set(key,{...p,id:key,curveSample:!anchors.has(key)});if(i){const a=vertexKey(ps[i-1]);edges.set(id+':'+i,{id,a,b:key,curve:true,surfaceId:f.id});}}}
 }
 return {nodes:[...nodes.values()],edges:[...edges.values()]};
}
function structuralPoint(p,faces){return faces.filter(f=>!f.deleted&&!f.drafted).flatMap(f=>K.normalizeFaces(f)).some(f=>rings(f).some(r=>r.some((q,i)=>{if(vertexKey(q)!==vertexKey(p))return false;const a=sub(r[(i+r.length-1)%r.length],q),b=sub(r[(i+1)%r.length],q),c=cross(a,b);return dot(a,b)>=0||Math.hypot(c.x,c.y,c.z)>1e-6*Math.max(1,Math.hypot(a.x,a.y,a.z)*Math.hypot(b.x,b.y,b.z));})));}
// Build render classification once instead of scanning every face per marker.
function structuralIndex(faces){
 const points=new Set(),segments=[],edgeCache=new Map();
 for(const f of faces.filter(f=>!f.deleted&&!f.drafted).flatMap(f=>K.normalizeFaces(f)))for(const r of rings(f))for(let i=0;i<r.length;i++){
  const p=r[i],q=r[(i+1)%r.length],a=sub(r[(i+r.length-1)%r.length],p),b=sub(q,p),c=cross(a,b);
  if(dot(a,b)>=0||Math.hypot(c.x,c.y,c.z)>1e-6*Math.max(1,Math.hypot(a.x,a.y,a.z)*Math.hypot(b.x,b.y,b.z)))points.add(vertexKey(p));
  segments.push({c:p,d:q,minX:Math.min(p.x,q.x),maxX:Math.max(p.x,q.x),minY:Math.min(p.y,q.y),maxY:Math.max(p.y,q.y),minZ:Math.min(p.z,q.z),maxZ:Math.max(p.z,q.z)});
 }
 return {point:p=>points.has(vertexKey(p)),edge:(a,b)=>{
  const key=edgeKey(a,b);if(edgeCache.has(key))return edgeCache.get(key);
  const ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,l2=ux*ux+uy*uy+uz*uz;let yes=false;
  const minX=Math.min(a.x,b.x)-1e-5,maxX=Math.max(a.x,b.x)+1e-5,minY=Math.min(a.y,b.y)-1e-5,maxY=Math.max(a.y,b.y)+1e-5,minZ=Math.min(a.z,b.z)-1e-5,maxZ=Math.max(a.z,b.z)+1e-5;
  if(l2>1e-12)for(const segment of segments){
   if(segment.maxX<minX||segment.minX>maxX||segment.maxY<minY||segment.minY>maxY||segment.maxZ<minZ||segment.minZ>maxZ)continue;
   const {c,d}=segment,tc=((c.x-a.x)*ux+(c.y-a.y)*uy+(c.z-a.z)*uz)/l2,td=((d.x-a.x)*ux+(d.y-a.y)*uy+(d.z-a.z)*uz)/l2;
   if(Math.hypot(c.x-a.x-ux*tc,c.y-a.y-uy*tc,c.z-a.z-uz*tc)>1e-5||Math.hypot(d.x-a.x-ux*td,d.y-a.y-uy*td,d.z-a.z-uz*td)>1e-5)continue;
   if(Math.min(1,Math.max(tc,td))-Math.max(0,Math.min(tc,td))>1e-7){yes=true;break;}
  }
  edgeCache.set(key,yes);return yes;
 }};
}
function structuralEdge(a,b,faces){return sharedIntervals(a,b,faces.filter(f=>!f.deleted&&!f.drafted).flatMap(f=>K.normalizeFaces(f))).length>0;}
function deleteSurfaceElements(edits,pointIds=[],edgeIds=[]){const points=new Set(pointIds),edges=new Set(edgeIds);edits.$removedSurfacePoints=[...new Set([...(edits.$removedSurfacePoints||[]),...points])];edits.$removedSurfaceEdges=[...new Set([...(edits.$removedSurfaceEdges||[]),...edges])];
 for(const f of edits.$surfaces||[]){if(f.drafted)continue;if(!f.deleted)Object.assign(f,K.normalizeFace(f));const selected=rings(f).flat().filter(p=>points.has(vertexKey(p))),defines=selected.length>0&&K.pointRemovalChangesRegion(f,selected.map(K.pointKey));if(defines||rings(f).some(r=>r.some((p,i)=>edges.has(edgeKey(p,r[(i+1)%r.length])))))f.deleted=true;else if(selected.length){f.points=f.points.filter(p=>!points.has(vertexKey(p)));f.holes=(f.holes||[]).map(r=>r.filter(p=>!points.has(vertexKey(p))));}}
}
// Removing a coplanar divider unions its incident regions. An exterior edge,
// including a crease shared by different planes, invalidates its incident face.
function removeFaceEdges(faces,segments){
 const parent=faces.map((_,i)=>i),affected=new Set(),invalid=new Set(),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
 const samePlane=(a,b)=>{const f=faceFrame(a),n=normal(b.points);return f&&n&&Math.abs(dot(f.n,n))>1-1e-5&&b.points.every(p=>Math.abs(dot(sub(p,f.origin),f.n))<=K.CONTACT);};
 // A displayed seam may be an edge of one face inside another overlapping face.
 const covers=(a,b,f)=>{const frame=faceFrame(f);if(!frame||[a,b].some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>K.CONTACT))return false;
  const x=inFrame(frame,a),y=inFrame(frame,b),dx=y.x-x.x,dy=y.y-x.y,ts=[0,1],local=rings(f).map(r=>r.map(p=>inFrame(frame,p)));
  for(const r of local)for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length],ux=q.x-p.x,uy=q.y-p.y,den=dx*uy-dy*ux;if(Math.abs(den)<1e-12)continue;const t=((p.x-x.x)*uy-(p.y-x.y)*ux)/den,u=((p.x-x.x)*dy-(p.y-x.y)*dx)/den;if(t>0&&t<1&&u>=0&&u<=1)ts.push(t);}
  ts.sort((a,b)=>a-b);return ts.slice(1).some((t,i)=>{const mid=(t+ts[i])/2,p={x:x.x+dx*mid,y:x.y+dy*mid};return t-ts[i]>1e-6&&pointInRing(p,local[0])&&!local.slice(1).some(r=>pointInRing(p,r));});
 };
 for(const [a,b] of segments){const boundary=faces.map((f,i)=>({f,i})).filter(({f})=>sharedIntervals(a,b,[f]).some(([lo,hi])=>hi-lo>1e-6));
  const incident=faces.map((f,i)=>({f,i})).filter(v=>boundary.some(b=>b.i===v.i)||(!v.f.feature&&covers(a,b,v.f)&&boundary.some(b=>samePlane(b.f,v.f))));
  const pairs=[];for(const v of incident)for(const peer of incident)if(v.i<peer.i&&samePlane(v.f,peer.f)){
   const frame=faceFrame(v.f),regions=K.union([v.f,peer.f].map(f=>({points:f.points.map(p=>inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))}))).map(f=>({points:f.points.map(p=>fromFrame(frame,p)),holes:f.holes.map(r=>r.map(p=>fromFrame(frame,p)))}));
   // Coincident faces can share an outer edge too. Removing that edge must
   // invalidate them; only an internal seam can disappear into a merged face.
   const border=sharedIntervals(a,b,regions).reduce((s,[lo,hi])=>s+hi-lo,0);
   const covered=sharedIntervals(a,b,[v.f,peer.f]).reduce((s,[lo,hi])=>s+hi-lo,0);
   if(covered-border>1e-6)pairs.push([v.i,peer.i]);
  }
  // A coplanar merge takes precedence over deleting unrelated creases touching
  // the same line, including chimney sides continuing above the roof.
  if(pairs.length){for(const [i,j]of pairs){affected.add(i);affected.add(j);parent[find(j)]=find(i);}}
  else for(const {i}of boundary){affected.add(i);invalid.add(i);}
 }
 const groups=new Map();for(const i of affected){const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}
 const merged=[];for(const ids of groups.values()){if(ids.some(i=>invalid.has(i)))continue;const members=ids.map(i=>faces[i]),frame=faceFrame(members[0]),B=baseGeometry(),locals=members.map(f=>({points:f.points.map(p=>inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))}));
  const retainedPoints=[...new Map(members.flatMap(f=>[...rings(f).flat(),...(f.retainedPoints||[])]).map(p=>[vertexKey(p),p])).values()];
  for(const region of K.union(locals))merged.push({...members[0],...mergedOwnership(members),mergedSources:members.map(f=>f.id),points:region.points.map(p=>fromFrame(frame,p)),holes:region.holes.map(r=>r.map(p=>fromFrame(frame,p))),retainedPoints});
 }
 return {removed:[...affected].map(i=>faces[i].id),merged};
}
// A merge replaces its source faces; a plain deletion deliberately leaves wire.
// Older projects recorded both cases as deletion. Recover only sources covered
// by an original line-merge surface, including one subsequently made editable.
function adoptMergedFaceSources(edits){
 if(!edits?.$surfaces?.length)return false;
 const targets=edits.$surfaces.filter(f=>/^line-merge-/.test(f.id)),sources=[];
 if(!targets.length)return false;
 for(const [key,d]of Object.entries(edits.$drafts||{}))for(const f of d.faces||[]){
  if(f.solidId||!(d.deletedFaces||[]).includes(f.points.map(p=>p.nodeId).sort().join('|')))continue;
  const world=p=>d.frame?fromFrame(d.frame,p):({x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y});
  sources.push({id:'draft:'+key+':'+f.id,record:f,d,face:{points:f.points.map(world),holes:(f.holes||[]).map(r=>r.map(world))}});
 }
 for(const f of edits.$surfaces)if(f.deleted&&!f.replacedBy)sources.push({id:'solid:'+f.id,record:f,face:f});
 let changed=false;
 for(const source of sources){
  const target=targets.find(t=>t!==source.record&&(t.mergedSources?t.mergedSources.includes(source.id):(()=>{
   const frame=faceFrame(t),n=normal(source.face.points);if(!frame||!n||Math.abs(dot(frame.n,n))<1-1e-5||source.face.points.some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>K.CONTACT))return false;
   const local=f=>({points:f.points.map(p=>inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>inFrame(frame,p)))});
   return K.difference(local(source.face),[local(t)]).reduce((s,f)=>s+K.area(f),0)<1e-5;
  })()));
  if(!target)continue;
  if(source.d)source.record.solidId=target.id;else source.record.replacedBy=target.id;
  changed=true;
 }
 return changed;
}
function faceFromPoints(selected,edges=[]){
 const points=[...new Map(selected.map(p=>[vertexKey(p),{x:p.x,y:p.y,z:p.z}])).values()];if(points.length<3)throw Error('Select at least three coplanar points.');
 let triple=null,best=0;for(let i=1;i<points.length;i++)for(let j=i+1;j<points.length;j++){const n=cross(sub(points[i],points[0]),sub(points[j],points[0])),size=dot(n,n);if(size>best){best=size;triple=[points[0],points[i],points[j]];}}
 const frame=triple&&faceFrame({points:triple});if(!frame||best<1e-16)throw Error('The selected points must enclose an area.');if(points.some(p=>Math.abs(dot(sub(p,frame.origin),frame.n))>K.CONTACT))throw Error('Select points on one plane.');
 const neighbors=points.map(()=>new Set());for(const [a,b]of edges){const i=points.findIndex(p=>vertexKey(p)===vertexKey(a)),j=points.findIndex(p=>vertexKey(p)===vertexKey(b));if(i>=0&&j>=0&&i!==j){neighbors[i].add(j);neighbors[j].add(i);}}
 let ordered=[];if(neighbors.every(n=>n.size===2)){let previous=-1,current=0;do{ordered.push(points[current]);const next=[...neighbors[current]].find(i=>i!==previous);previous=current;current=next;}while(current!==0&&ordered.length<points.length);if(current!==0||ordered.length!==points.length)ordered=[];}
 if(!ordered.length){const local=points.map(p=>inFrame(frame,p)),center={x:local.reduce((s,p)=>s+p.x,0)/points.length,y:local.reduce((s,p)=>s+p.y,0)/points.length};ordered=points.map((p,i)=>({p,angle:Math.atan2(local[i].y-center.y,local[i].x-center.x)})).sort((a,b)=>a.angle-b.angle).map(v=>v.p);}
 const face={points:ordered,holes:[],material:'default'};K.validateFace(face);return face;
}
function mergeAtPoints(scene,points){
 const wanted=new Set(points.map(vertexKey)),touches=f=>rings(f).some(r=>r.some((a,i)=>points.some(p=>pointOnEdge(p,a,r[(i+1)%r.length]))));
 return mergeConnectedFaces(scene.filter(touches)).filter(g=>g.pieces.some(touches)).map(g=>{const pieces=g.pieces.map(f=>({...f,points:f.points.filter(p=>!wanted.has(vertexKey(p))),holes:(f.holes||[]).map(r=>r.filter(p=>!wanted.has(vertexKey(p)))),retainedPoints:(f.retainedPoints||[]).filter(p=>!wanted.has(vertexKey(p)))}));try{pieces.forEach(K.validateFace);}catch(e){return null;}return {...g,pieces};}).filter(Boolean);
}
function restoreSurface(edits,pointIds){const wanted=new Set(pointIds),wire=surfaceWire(edits),available=new Set(wire.nodes.map(n=>n.id));if(pointIds.length<3||pointIds.some(id=>!available.has(id)))throw Error('Select at least three existing points.');
 const matches=(edits.$surfaces||[]).filter(f=>f.deleted&&f.points.length===wanted.size&&f.points.every(p=>wanted.has(vertexKey(p)))&&[f.points,...(f.holes||[])].every(r=>r.every((p,i)=>wire.edges.some(e=>e.id===edgeKey(p,r[(i+1)%r.length])))));
 if(!matches.length)throw Error('Select the boundary points of a deleted face with its edges still present.');for(const f of matches)f.deleted=false;return matches[0].id;
}
function faceFrame(face){return K.frame(face);}
const inFrame=(frame,p)=>({...K.local(frame,p),z:0}),fromFrame=(frame,p)=>K.world(frame,{...p,z:0});
function containedBy(source,target){
 const f=faceFrame(target),n=normal(source.points);if(!f||!n||Math.abs(dot(n,f.n))<.99999||source.points.some(p=>Math.abs(dot(sub(p,f.origin),f.n))>1e-5))return false;
 const local={points:source.points.map(p=>inFrame(f,p))},outer={points:target.points.map(p=>inFrame(f,p))},area=Math.abs(signedArea(local.points));if(area<1e-6||area>=Math.abs(signedArea(outer.points))-1e-6)return false;
 if(subtract(local,[outer]).reduce((s,p)=>s+Math.abs(signedArea(p)),0)>1e-7)return false;
 for(const hole of target.holes||[]){const remaining=subtract(local,[{points:hole.map(p=>inFrame(f,p))}]).reduce((s,p)=>s+Math.abs(signedArea(p)),0);if(area-remaining>1e-7)return false;}return true;
}
function coplanarContact(source,target){
 const a=normal(source.points),b=normal(target.points);if(!a||!b||Math.abs(dot(a,b))<.99999||source.points.some(p=>Math.abs(dot(sub(p,target.points[0]),b))>1e-5))return false;
 return rings(source).some(r=>r.some((p,i)=>sharedIntervals(p,r[(i+1)%r.length],[target]).some(([lo,hi])=>hi-lo>1e-6)));
}
// Snap along the permitted motion axis against finite geometry, even when
// the target is only a point or edge rather than a parallel containing face.
function motionSnapCandidates(points,edges,direction,faces,options={}){
 const tol=1e-5,targets=faces.filter(f=>!f.deleted&&!f.snapOnly&&!f.drafted),targetPoints0=[...targets.flatMap(f=>[...rings(f).flat(),...(f.retainedPoints||[])]),...(options.points||[])],targetEdges0=[...targets.flatMap(f=>rings(f).flatMap(r=>r.map((p,i)=>[p,r[(i+1)%r.length]]))),...(options.edges||[])];
 const moving=p=>edges.some(([a,b])=>pointOnEdge(p,a,b)),targetPoints=[...new Map(targetPoints0.filter(p=>!options.excludeMoving||!moving(p)).map(p=>[vertexKey(p),p])).values()],targetEdges=[...new Map(targetEdges0.filter(([a,b])=>!options.excludeMoving||!moving(a)||!moving(b)).map(e=>[edgeKey(...e),e])).values()],planes=targets.map(f=>({f,frame:faceFrame(f)})).filter(x=>x.frame);const candidates=[];
 const at=(p,t)=>({x:p.x+direction.x*t,y:p.y+direction.y*t,z:p.z+direction.z*t});
 const offer=(t,p,target,kind,edge)=>{if(Number.isFinite(t)&&Math.abs(t)>=1e-6)candidates.push({amount:t,from:p,target,kind,edge});};
 for(const p of points){
  // Alignment continues across gaps between coplanar stickers and host edges.
  if(options.alignmentNormal)for(const q of targetPoints){const v=sub(q,p);if(Math.abs(dot(v,options.alignmentNormal))<tol){const t=dot(v,direction);offer(t,p,at(p,t),'Alignment',[at(p,t),q]);}}
  for(const q of targetPoints){const v=sub(q,p),t=dot(v,direction);if(Math.hypot(...Object.values(sub(q,at(p,t))))<tol)offer(t,p,q,'Point');}
  for(const [a,b]of targetEdges){const u=sub(b,a),v=sub(a,p),c=dot(u,u),bn=dot(direction,u),den=c-bn*bn;if(den<1e-12)continue;const t=(dot(direction,v)*c-dot(u,v)*bn)/den,s=(bn*dot(direction,v)-dot(u,v))/den,q=mix3(a,b,s);if(s>=-1e-6&&s<=1+1e-6&&Math.hypot(...Object.values(sub(q,at(p,t))))<tol)offer(t,p,q,'Edge',[a,b]);}
  for(const {f,frame}of planes){const den=dot(frame.n,direction);if(!frame||Math.abs(den)<1e-8)continue;const t=dot(sub(frame.origin,p),frame.n)/den,q=at(p,t),local=inFrame(frame,q),outer=f.points.map(p=>inFrame(frame,p));if(pointInRing(local,outer)&&!(f.holes||[]).some(r=>pointInRing(local,r.map(p=>inFrame(frame,p)))))offer(t,p,q,'Face');}
 }
 for(const [a,b]of edges){const u=sub(b,a),c=dot(u,u),bn=dot(direction,u),den=c-bn*bn;if(den<1e-12)continue;for(const q of targetPoints){const v=sub(q,a),t=(dot(direction,v)*c-dot(u,v)*bn)/den,s=(dot(u,v)-bn*dot(direction,v))/den,p=mix3(a,b,s);if(s>=0&&s<=1&&Math.hypot(...Object.values(sub(q,at(p,t))))<tol)offer(t,p,q,'Point');}}
 // Elevation is a model-wide constraint: horizontal separation is irrelevant.
 if(Math.abs(direction.z)>1e-8){const heights=[...new Map([...targetPoints,...(options.heightPoints||[])].filter(p=>Number.isFinite(p.z)).map(p=>[p.z.toFixed(6),p])).values()];for(const p of points)for(const q of heights){const t=(q.z-p.z)/direction.z,hit=at(p,t);offer(t,p,hit,'Height',[hit,q]);}}
 return candidates;
}
function motionSnap(points,edges,direction,amount,faces,options={}){
 const candidates=options.candidates||motionSnapCandidates(points,edges,direction,faces,options);let best=null;
 for(const candidate of candidates){const t=candidate.amount,p=candidate.from;let distance=Math.abs(t-amount);
  if(options.screen){const at=t=>({x:p.x+direction.x*t,y:p.y+direction.y*t,z:p.z+direction.z*t}),a=options.screen(at(amount)),b=options.screen(at(t));if(a.visible===false||b.visible===false)continue;distance=Math.max(Math.hypot(a.x-b.x,a.y-b.y),Math.abs(t-amount)*(options.minPixelsPerMeter||0));}
  if(!Number.isFinite(distance)||distance>(options.radius??.15))continue;
  if(!best||distance<best.distance-1e-7||(Math.abs(distance-best.distance)<1e-7&&candidate.kind==='Point'))best={...candidate,distance};
 }return best;
}
function containedSnap(source,amount,faces){const n=normal(source.points);if(!n)return null;let best=null;
 for(const target of faces){if(target.id===source.id||target.deleted||target.drafted||(target.snapOnly&&!target.restoreFor?.includes(source.id)))continue;const tn=normal(target.points);if(!tn||Math.abs(dot(n,tn))<.99999)continue;const offset=dot(sub(target.points[0],source.points[0]),tn)/dot(n,tn);if(Math.abs(offset)<1e-5)continue;const moved={...source,points:source.points.map(p=>({x:p.x+n.x*offset,y:p.y+n.y*offset,z:p.z+n.z*offset}))};const contained=containedBy(moved,target);if((contained||!target.snapOnly&&coplanarContact(moved,target))&&(!best||Math.abs(offset-amount)<Math.abs(best.amount-amount)))best={amount:offset,targetId:target.id,kind:contained?'contained':'adjacent'};}return best;
}
function importDraft(d,loops){
 const S=typeof module!=='undefined'&&module.exports?require('./base_sketch_geometry.js'):root.BaseSketchGeometry;
 for(const ring of loops){const ids=ring.map(p=>S.add(d,{...p,z:0}));S.connect(d,[...ids,ids[0]]);}
 // Materialize intersections, then split and deduplicate coincident edge fragments.
 for(const f of d.faces)for(const p of f.points)if(!d.sketch.nodes.some(n=>n.id===p.nodeId))d.sketch.nodes.push({...p,id:p.nodeId,fixed:false});
 const unique=new Map();for(const e of d.sketch.edges){const a=d.sketch.nodes.find(n=>n.id===e.a),b=d.sketch.nodes.find(n=>n.id===e.b),u=sub(b,a),l2=dot(u,u);if(l2<1e-10)continue;const ns=d.sketch.nodes.filter(p=>pointOnEdge(p,a,b)).map(p=>({p,t:dot(sub(p,a),u)/l2})).sort((a,b)=>a.t-b.t);for(let i=1;i<ns.length;i++){const x=ns[i-1].p,y=ns[i].p;if(x.id===y.id||ns[i].t-ns[i-1].t<1e-7)continue;const key=[x.id,y.id].sort().join('|'),prior=unique.get(key);if(prior){prior.fixed=prior.fixed||e.fixed;}else unique.set(key,{...e,id:'e'+(++d.sketch.next),a:x.id,b:y.id});if(e.fixed){x.fixed=true;y.fixed=true;}}}
 d.sketch.edges=[...unique.values()];S.resolve(d);return d;
}
// Lengths are measured in world metres, not projected screen distances.
function attachedLengths(cap,faces){
 const found=new Map(),capEdges=new Set(rings(cap).flatMap(r=>r.map((p,i)=>edgeKey(p,r[(i+1)%r.length]))));
 const attached=p=>rings(cap).some(r=>r.some((a,i)=>pointOnEdge(p,a,r[(i+1)%r.length])));
 for(const f of faces.filter(f=>!f.deleted&&!f.snapOnly))for(const r of rings(f))for(let i=0;i<r.length;i++){
  const a=r[i],b=r[(i+1)%r.length],key=edgeKey(a,b);if(capEdges.has(key)||(!attached(a)&&!attached(b)))continue;
  const length=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);if(length>1e-6)found.set(key,{a,b,length});
 }return [...found.values()];
}
// Positive typed wall offsets point into the base footprint, independent of winding.
// Return null when the footprint does not distinguish the two sides.
function inwardSign(face,bases){
 const n=normal(face.points);if(!n||Math.abs(n.z)>.1)return null;
 const c=face.points.reduce((s,p)=>({x:s.x+p.x/face.points.length,y:s.y+p.y/face.points.length}),{x:0,y:0});
 const inside=p=>bases.some(f=>pointInRing(p,f.points)&&!(f.holes||[]).some(h=>pointInRing(p,h)));
 for(const distance of [.005,.02,.1]){const a=inside({x:c.x+n.x*distance,y:c.y+n.y*distance}),b=inside({x:c.x-n.x*distance,y:c.y-n.y*distance});if(a!==b)return a?1:-1;}
 return null;
}
const api={ownsPoint,followTrim,pointRangeIndex,stickerAlignmentTargets,planeAlignment,planeAlignmentGuides,adoptMergedFaceSources,faceFromPoints,mergeAtPoints,fillet,validTranslation,boundedTranslation,geometryScale,snapGeometryScale,snapGeometryOnPlane,transformGeometry,transformSelection,clipboardFrame,copyGeometry,pasteGeometry,mergeConnectedFaces,pointChamferSnap,chamferSnap,chamfer,roofExtrusion,inwardSign,cleanupSweepRemnants,sweepRemnant,motionSnapCandidates,structuralIndex,joinFragments,motionSnap,slideLines,attachedLengths,unionPlanar,trimExtrusion,moveFabric,quadDraftSnap,normal,extrude,snapDirection,bridges,dragAmount,subtract,snapBase,baseScope,belowBase,draftSnap,vertexKey,edgeKey,surfaceWire,structuralPoint,structuralEdge,deleteSurfaceElements,removeFaceEdges,restoreSurface,sharedIntervals,freeEdges,moveSurface,faceFrame,inFrame,fromFrame,containedBy,coplanarContact,containedSnap,importDraft};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallSolidGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
