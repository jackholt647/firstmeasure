/* Persistent base sketch: fixed wall boundary plus editable construction geometry. */
(function(root){
'use strict';
const K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
const B=typeof module!=='undefined'&&module.exports?require('./base_geometry.js'):root.BaseGeometry;
const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
const copy=v=>JSON.parse(JSON.stringify(v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const area=ps=>ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2;
function ensure(base){
 if(base.sketch)return compactCurves(base.sketch);
 const nodes=[],edges=[],seen=new Map();
 const node=p=>{let i=nodes.findIndex(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<=K.CONTACT);if(i<0){i=nodes.length;nodes.push({...p,id:'p'+i,fixed:false});}return nodes[i].id;};
 for(const f of base.faces){const ids=f.points.map(node);f.points.forEach((p,i)=>p.nodeId=ids[i]);
  ids.forEach((a,i)=>{const b=ids[(i+1)%ids.length],key=[a,b].sort().join('|');if(seen.has(key))seen.get(key).count++;else{const edge={id:'e'+edges.length,a,b,fixed:false,count:1};seen.set(key,edge);edges.push(edge);}});
 }
 for(const e of edges){e.fixed=e.count===1;delete e.count;if(e.fixed)for(const id of [e.a,e.b])nodes.find(n=>n.id===id).fixed=true;}
 base.sketch={version:1,next:Math.max(nodes.length,edges.length),nodes,edges,outlines:B.boundary(base.faces.map(f=>f.points))};
 return base.sketch;
}
const readCache=new WeakMap();
function read(base){
 if(base.sketch)return compactCurves(base.sketch);
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
function curveEdges(s){return s.edges.flatMap(e=>{const c=e.curveId&&s.curves?.find(c=>c.id===e.curveId),byId=id=>s.nodes.find(n=>n.id===id);if(!c)return [{...e,start:byId(e.a),end:byId(e.b)}];const [lo,hi]=e.curveRange||[0,1],samples=K.curveSamples(c).filter(p=>p.curveT>lo&&p.curveT<hi),ps=[{...K.curvePoint(c,lo),id:e.a},...samples.map((p,i)=>({...p,id:e.id+'~sample-'+i,curveSample:true})),{...K.curvePoint(c,hi),id:e.b}];return ps.slice(1).map((p,i)=>({...e,start:ps[i],end:p}));});}
function compactCurves(s){
 if(!s.curves?.length)return s;
 const derived=new Set(s.edges.filter(e=>e.curveId).flatMap(e=>[e.a,e.b]));
 // Merge tessellation fragments, but never erase a deliberate anchor or junction.
 const anchors=new Set(s.nodes.filter(n=>n.userDraftPoint||n.curveCenter).map(n=>n.id));
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
 s.curves||=[];s.curves.push({...copy(curve),id,...(centerId?{centerId}:{})});s.edges.push({id:'e'+(++s.next),a,b,fixed:false,userConnection:true,curveId:id,curveRange:[0,1]});resolve(base);return b;
}
function remove(base,pointIds,lineIds){
 const s=ensure(base),deleted=new Set(s.nodes.filter(n=>pointIds.includes(n.id)&&!n.fixed).map(n=>n.id));
 s.nodes=s.nodes.filter(n=>!deleted.has(n.id));s.edges=s.edges.filter(e=>e.fixed||(!lineIds.includes(e.id)&&!deleted.has(e.a)&&!deleted.has(e.b)));
 resolve(base);
}
// Publish changed curve definitions and synchronize only persistent controls.
// Evaluated face loops are rebuilt from those definitions by resolve().
function updateCurves(base,curves,moves=[]){
 const s=ensure(base),byId=new Map(curves.map(c=>[c.id,c]));
 for(const c of curves)if(K.curveSamples(c).some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Curve coordinates must be finite.');
 for(const n of s.nodes){const p=moves.find(m=>m.id===n.id)?.point;if(p)Object.assign(n,p);}
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
function move(base,ids,delta){
 const s=ensure(base),movable=s.nodes.filter(n=>ids.includes(n.id)&&!n.fixed),selected=new Set(movable.map(n=>n.id)),translated=p=>({x:p.x+(delta.x||0),y:p.y+(delta.y||0),z:p.z+(delta.z||0)});
 for(const n of movable)if(!Object.values(translated(n)).every(Number.isFinite))throw Error('Point coordinates must be finite.');
 const curves=[];
 for(const c of s.curves||[]){const edges=s.edges.filter(e=>e.curveId===c.id),ends=[...new Set(edges.flatMap(e=>[e.a,e.b]))],changed=ends.filter(id=>selected.has(id));if(!changed.length&&!selected.has(c.centerId))continue;
  let map=translated;
  if(changed.length&&changed.length<ends.length){
   const moving=s.nodes.find(n=>n.id===changed[0]),fixed=s.nodes.find(n=>ends.includes(n.id)&&!selected.has(n.id)),v={x:moving.x-fixed.x,y:moving.y-fixed.y,z:moving.z-fixed.z},l2=v.x*v.x+v.y*v.y+v.z*v.z;
   // An affine change of the conic moves the endpoint, holds the opposite
   // endpoint, and preserves a smooth curve without promoting any samples.
   if(l2>K.CONTACT*K.CONTACT)map=p=>{const t=((p.x-fixed.x)*v.x+(p.y-fixed.y)*v.y+(p.z-fixed.z)*v.z)/l2;return {x:p.x+(delta.x||0)*t,y:p.y+(delta.y||0)*t,z:p.z+(delta.z||0)*t};};
  }
  const next=K.mapCurve(c,map);if(K.curveSamples(next).some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Curve coordinates must be finite.');curves.push(next);
 }
 updateCurves(base,curves,movable.map(n=>({id:n.id,point:{...translated(n),...(delta.z?{manualZ:true}:{})}})));
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
  const onPlane=p=>!group.plane||Math.abs(p.z-group.plane.dx*p.x-group.plane.dy*p.y-group.plane.k)<=K.CONTACT;
  const nodes=group.nodes||graphNodes.filter(onPlane),ids=new Set(nodes.map(p=>p.id));
  const graph=K.partition({nodes,edges:group.edges||graphEdges.filter(e=>ids.has(e.a)&&ids.has(e.b))});
  for(const ps of graph.regions){
  const center=B.center({points:ps});
  const original=group.faces.find(f=>G.contains(f,center))||group.faces[0],plane=G.plane(original.points);
  const points=ps.map(p=>({x:p.x,y:p.y,z:p.manualZ?p.z:plane.dx*p.x+plane.dy*p.y+plane.k,nodeId:p.id}));
  B.validate({points});const signature=ps.map(p=>p.id).sort().join('|'),match=old.find(f=>f.points.map(p=>p.nodeId).sort().join('|')===signature);
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
 if(s.curves?.length)for(const f of faces)f.curves=(s.curves||[]).filter(c=>graphEdges.some(e=>e.curveId===c.id&&f.points.some(p=>p.nodeId===e.a)&&f.points.some(p=>p.nodeId===e.b))).map(copy);
 base.faces=faces;s.outlines=B.boundary(faces.map(f=>f.points));
}

// Rebuild the editable graph from face ownership after a footprint or plane edit.
// A shared XY corner at two elevations is two vertices; a construction segment
// is clipped and lifted independently on each of its supporting faces.
function rebind(before,after){
 const original=read(before),evaluated=curveEdges(original),old={...original,nodes:[...original.nodes,...evaluated.flatMap(e=>[e.start,e.end]).filter(n=>n.curveSample)],edges:evaluated.map(e=>({...e,a:e.start.id,b:e.end.id}))},nodes=[],edges=[],used=new Set(),byPair=new Map();let next=old.next||0;
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),at=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
 const fresh=prefix=>{let id;do{id=prefix+(++next);}while(used.has(id));used.add(id);return id;};
 const node=(p,preferred)=>{let n=nodes.find(n=>distance(n,p)<=K.CONTACT);const source=preferred&&original.nodes.find(q=>q.id===preferred),flags={...((p.userDraftPoint||source?.userDraftPoint)?{userDraftPoint:true}:{}),...((p.curveCenter||source?.curveCenter)?{curveCenter:true}:{})};if(n){Object.assign(n,flags);if(n.userDraftPoint)delete n.curveSample;return n.id;}const id=preferred&&!used.has(preferred)?preferred:fresh('p');used.add(id);n={...p,...flags,id,fixed:false};delete n.nodeId;if(n.userDraftPoint)delete n.curveSample;nodes.push(n);return id;};
 const segments=[];
 for(const f of after.faces){for(const p of f.points)p.nodeId=node(p,p.nodeId);for(let i=0;i<f.points.length;i++)segments.push({a:f.points[i].nodeId,b:f.points[(i+1)%f.points.length].nodeId,boundary:true,owner:f.id});}
 const supports=before.faces.map(f=>({f,plane:G.plane(f.points)}));
 const on=(p,s)=>s.plane&&Math.abs(p.z-s.plane.dx*p.x-s.plane.dy*p.y-s.plane.k)<=K.CONTACT&&G.contains(s.f,p);
 const onBoundary=(p,f)=>[f.points,...(f.holes||[])].some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,t=l2?((p.x-a.x)*dx+(p.y-a.y)*dy)/l2:-1;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<=K.CONTACT;}));
 const targets=f=>{const matching=after.faces.filter(q=>q.id===f.id||String(q.id).startsWith(f.id+'-extrusion-'));return matching.length?matching:after.faces;};
 const lift=(p,f)=>{const pl=G.plane(f.points);return {...p,z:pl.dx*p.x+pl.dy*p.y+pl.k};};
 for(const p of old.nodes)for(const support of supports.filter(s=>on(p,s)))for(const f of targets(support.f))if(G.contains(f,p)&&(p.userDraftPoint||!onBoundary(p,support.f)||onBoundary(p,f)))node(lift(p,f),p.id);
 // Deliberate exterior anchors are not clipped to the previous footprint.
 for(const p of old.nodes)if(p.userDraftPoint&&!supports.some(s=>on(p,s))&&!nodes.some(n=>n.id===p.id))node(p,p.id);
 const oldNode=new Map(old.nodes.map(n=>[n.id,n]));
 for(const e of old.edges){if(e.fixed||e.chimneyFoundation)continue;const a=oldNode.get(e.a),b=oldNode.get(e.b);if(!a||!b)continue;
  // Rebuild geometric boundaries from faces, never copy an obsolete shared
  // boundary back as a construction line merely because fixed was false.
  if(supports.some(s=>{if(!on(a,s)||!on(b,s))return false;const ts=G.splitParameters(a,b,[s.f]);return ts.slice(1).every((hi,i)=>onBoundary(at(a,b,(ts[i]+hi)/2),s.f));}))continue;
  if(e.userConnection){
   const endpoint=p=>nodes.find(n=>n.id===p.id)?.id||node(p,p.id);
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
 const lookup=new Map(nodes.map(n=>[n.id,n]));
 for(const e of segments){const a=lookup.get(e.a),b=lookup.get(e.b),len=distance(a,b);if(len<=K.CONTACT)continue;
  const hits=nodes.map(n=>({n,t:((n.x-a.x)*(b.x-a.x)+(n.y-a.y)*(b.y-a.y)+(n.z-a.z)*(b.z-a.z))/(len*len)})).filter(h=>h.t>=-1e-8&&h.t<=1+1e-8&&distance(h.n,at(a,b,h.t))<=K.CONTACT).sort((a,b)=>a.t-b.t);
  for(let i=1;i<hits.length;i++){const u=hits[i-1].n.id,v=hits[i].n.id;if(u===v)continue;const key=[u,v].sort().join('|');let edge=byPair.get(key);if(!edge){edge={id:fresh('e'),a:u,b:v,fixed:false,owners:new Set()};byPair.set(key,edge);edges.push(edge);}if(e.boundary)edge.owners.add(e.owner);if(e.userConnection)edge.userConnection=true;}
 }
 for(const e of edges){e.fixed=e.owners.size===1;delete e.owners;if(e.fixed){lookup.get(e.a).fixed=true;lookup.get(e.b).fixed=true;}}
 const curves=[...new Map([...(old.curves||[]),...after.faces.flatMap(f=>f.curves||[])].map(c=>[c.id,c])).values()];for(const c of curves){const samples=K.curveSamples(c);for(const e of edges){const a=lookup.get(e.a),b=lookup.get(e.b);for(let j=1;j<samples.length;j++){const p=samples[j-1],q=samples[j],v={x:q.x-p.x,y:q.y-p.y,z:q.z-p.z},l2=v.x*v.x+v.y*v.y+v.z*v.z,parameter=x=>((x.x-p.x)*v.x+(x.y-p.y)*v.y+(x.z-p.z)*v.z)/l2,t=parameter(a),u=parameter(b),tolerance=K.CONTACT/Math.sqrt(l2),snap=t=>Math.abs(t)<tolerance?0:Math.abs(t-1)<tolerance?1:t;if(t>=-tolerance&&t<=1+tolerance&&u>=-tolerance&&u<=1+tolerance&&distance(a,at(p,q,t))<K.CONTACT&&distance(b,at(p,q,u))<K.CONTACT){e.curveId=c.id;e.fixed=original.edges.filter(e=>e.curveId===c.id).every(e=>e.fixed);e.curveRange=[p.curveT+(q.curveT-p.curveT)*snap(t),p.curveT+(q.curveT-p.curveT)*snap(u)];break;}}}}
 after.sketch={version:2,next,nodes,edges,outlines:B.boundary(after.faces.map(f=>f.points)),...(curves.length?{curves:curves.filter(c=>edges.some(e=>e.curveId===c.id))}:{})};compactCurves(after.sketch);return after;
}

const surfaceBoundaryCache=new WeakMap();
function syncSurfaceBoundaries(base,surfaces){
 if(!base?.faces?.length||!surfaces?.some(f=>f.curvedSurface&&!f.deleted&&!f.drafted))return false;
 const signature=()=>JSON.stringify([base.faces,surfaces.filter(f=>f.curvedSurface&&!f.deleted&&!f.drafted).map(f=>[f.id,f.curvedSurface])]),key=signature();if(surfaceBoundaryCache.get(base)===key)return false;
 const before=copy(base),changed=K.attachBoundaryCurves(base.faces,surfaces);if(changed)rebind(before,base);surfaceBoundaryCache.set(base,signature());return changed;
}
function isCurveSample(base,p){const s=read(base);if(!s.curves?.length||s.nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y,n.z-p.z)<=K.CONTACT))return false;
 return curveEdges(s).filter(e=>e.curveId).some(e=>{const a=e.start,b=e.end,v={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},l2=v.x*v.x+v.y*v.y+v.z*v.z,t=l2?((p.x-a.x)*v.x+(p.y-a.y)*v.y+(p.z-a.z)*v.z)/l2:-1;return t>=-1e-5&&t<=1+1e-5&&Math.hypot(p.x-a.x-v.x*t,p.y-a.y-v.y*t,p.z-a.z-v.z*t)<=.002;});
}
// Upgrade old saved graphs whose node heights lagged behind their face planes.
// The old node IDs provide the original support; the current faces stay authoritative.
function upgrade(base){
 if(!base?.sketch||base.sketch.version>=2)return false;
 const before=copy(base),nodes=new Map(before.sketch.nodes.map(p=>[p.id,p]));
 for(const f of before.faces){const points=f.points.map(p=>nodes.has(p.nodeId)?{...p,z:nodes.get(p.nodeId).z}:p);if(G.plane(points))f.points=points;}
 rebind(before,base);return true;
}
const api={nodeLines,updateCurves,syncSurfaceBoundaries,isCurveSample,curveEdges,compactCurves,addCurve,read,ensure,rebind,upgrade,add,connect,remove,move,resolve};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BaseSketchGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
