/* Exterior operation boundary. Immutable inputs, validated results, explicit commit. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports;
const K=node?require('./exterior_geometry.js'):root.ExteriorGeometry,W=node?require('./wall_solid_geometry.js'):root.WallSolidGeometry,B=node?require('./base_geometry.js'):root.BaseGeometry,G=node?require('./wall_geometry.js'):root.WallGeometry;
// Exactly JSON.parse(JSON.stringify(value)) for plain data, without the text
// round trip: same keys and order, -0 becomes 0, non-finite numbers become
// null, undefined/function/symbol members are dropped (null in arrays), and
// nothing is shared with the input. Anything else (toJSON, boxed primitives,
// other classes, a "__proto__" key, cycles, BigInt, a top-level undefined)
// takes the JSON round trip, including its errors. wall_face_draft.js keeps
// the same function for its own realm.
const JSON_COPY_FAIL={},JSON_COPY_ROOT=Object.prototype,jsonCopyTag=Object.prototype.toString;
function jsonCopyValue(v){
 if(v===null)return null;
 switch(typeof v){case 'number':return v-v===0?(v===0?0:v):null;case 'string':case 'boolean':return v;case 'object':break;default:throw JSON_COPY_FAIL;}
 if(typeof v.toJSON==='function')throw JSON_COPY_FAIL;
 if(Array.isArray(v)){const n=v.length,out=new Array(n);for(let i=0;i<n;i++){const x=v[i],t=typeof x;out[i]=t==='undefined'||t==='function'||t==='symbol'?null:jsonCopyValue(x);}return out;}
 const p=Object.getPrototypeOf(v);
 if(p!==JSON_COPY_ROOT&&(p===null?typeof JSON.isRawJSON==='function'&&JSON.isRawJSON(v):Object.getPrototypeOf(p)!==null||jsonCopyTag.call(v)!=='[object Object]'))throw JSON_COPY_FAIL;
 const out={},keys=Object.keys(v);
 for(let i=0;i<keys.length;i++){const k=keys[i],x=v[k],t=typeof x;if(t==='undefined'||t==='function'||t==='symbol')continue;if(k==='__proto__')throw JSON_COPY_FAIL;out[k]=jsonCopyValue(x);}
 return out;
}
function copy(x){try{return jsonCopyValue(x);}catch{return JSON.parse(JSON.stringify(x));}}
// JSON.stringify(a)===JSON.stringify(b), compared without building the strings.
const same=(a,b)=>W.jsonEqual?W.jsonEqual(a,b):JSON.stringify(a)===JSON.stringify(b);
const world=(d,p)=>d.frame?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};
// One boundary between editable local regions and world-space engine faces.
// Geometry and appearance belong to the region; joined-plane ownership can be
// inherited from its draft. All callers must preserve both when materializing it.
function draftFace(d,f,overrides={}){
 const map=p=>world(d,p),joinedChimneys=[...new Set([...(d.joinedChimneys||[]),...(f.joinedChimneys||[])])];
 return {...copy(f),...(d.closedSoffit?{closedSoffit:copy(d.closedSoffit),roofLayer:true}:{}),...(d.generatedRoofContact?{generatedRoofContact:true}:{}),...K.mapCurveData(f,map),chimney:(f.chimney||d.chimney)?copy(f.chimney||d.chimney):undefined,...(joinedChimneys.length?{joinedChimneys}:{}),points:f.points.map(map),holes:(f.holes||[]).map(r=>r.map(map)),retainedPoints:overrides.retainedPoints||(d.sketch?.nodes||[]).filter(p=>!(d.removedPoints||[]).includes(p.id)&&G.contains(f,p)).map(p=>({...map(p),anchorId:overrides.draftKey?overrides.draftKey+':'+p.id:undefined})),...overrides};
}
// Older edits split a face twice into the same '<id>~region-1', and saved or
// history snapshots can still hold both. The first record keeps its identity,
// which existing references found first; each later duplicate gets an unused
// region identity. Geometry and ownership fields are unchanged.
function repairFaceIdentities(edits){
 let changed=false;
 const unique=records=>{const ids=new Set(records.map(f=>f.id)),seen=new Set();for(const f of records){if(!seen.has(f.id)){seen.add(f.id);continue;}const base=String(f.id).replace(/~region-\d+$/,'');let k=1;while(ids.has(base+'~region-'+k))k++;f.id=base+'~region-'+k;ids.add(f.id);seen.add(f.id);changed=true;}};
 unique(edits?.$surfaces||[]);for(const d of Object.values(edits?.$drafts||{}))unique(d.faces||[]);
 return changed;
}
// Repair the missing ownership field in persisted operation replacements. The
// stored source IDs prove ancestry; do not guess from proximity or recompute faces.
// This is the loader's ownership pass, so it also restores unique face identities.
function restoreDraftFaceOwnership(edits){
 let changed=repairFaceIdentities(edits);
 for(const f of edits?.$surfaces||[]){
  const d=edits.$drafts?.[f.draftKey],source=d?.faces.find(r=>r.id===f.regionId);
  if(!source?.solidId||!(f.id===source.solidId||f.id.startsWith(source.solidId+'-')))continue;
  const joined=[...new Set([...(f.joinedChimneys||[]),...(d.joinedChimneys||[]),...(source.joinedChimneys||[])])];
  if(joined.length!==(f.joinedChimneys||[]).length){f.joinedChimneys=joined;changed=true;}
 }
 return changed;
}
function collect(state,rawWalls=[]){
 // Wall mode can render a completed roof before a wall model is generated.
 const edits=state?.wallEdits||{},drafts=Object.entries(edits.$drafts||{}).filter(([,d])=>!d.mergedInto),claimed=new Set(drafts.flatMap(([,d])=>d.members||[])),faces=[];
 for(const f of edits.$surfaces||[])if(!f.deleted&&!f.drafted)faces.push({...f});
 for(const [key,d]of drafts)for(const f of d.faces||[]){const signature=f.points.map(p=>p.nodeId).sort().join('|');if(f.solidId||f.boundaryHole||(d.deletedFaces||[]).includes(signature)||f.points.some(p=>(d.removedPoints||[]).includes(p.nodeId)))continue;
 faces.push(draftFace(d,f,{id:'draft:'+key+':'+f.id,draft:true,draftKey:key,regionId:f.id}));}
 for(const w of rawWalls)if(!claimed.has(w.id)&&!drafts.some(([,d])=>G.draftOwnsWall(d,w)))faces.push({id:'wall:'+w.id,points:[...w.bottom,...w.top.slice().reverse()],chimney:w.chimney});
 return faces;
}
// Resolve openings from current geometry, without baking stale cutouts into a
// host when a sticker moves, resizes, changes type or is deleted.
const openingCache=new Map(),openingCacheLimit=512;
const openingBounds=points=>['x','y','z'].map(axis=>[Math.min(...points.map(p=>p[axis])),Math.max(...points.map(p=>p[axis]))]);
// Conservative spatial broad phase: exact plane and polygon checks still decide
// the cuts. Long faces fall back to the complete list rather than losing targets.
function indexOpenings(features){
 const cells=new Map(),oversized=[],size=4;
 const keys=box=>{const ranges=box.map(([lo,hi])=>[Math.floor((lo-.002)/size),Math.floor((hi+.002)/size)]);if(ranges.reduce((n,[lo,hi])=>n*(hi-lo+1),1)>4096)return null;const result=[];for(let x=ranges[0][0];x<=ranges[0][1];x++)for(let y=ranges[1][0];y<=ranges[1][1];y++)for(let z=ranges[2][0];z<=ranges[2][1];z++)result.push(x+':'+y+':'+z);return result;};
 for(const f of features){const bins=keys(openingBounds(f.points));if(!bins){oversized.push(f);continue;}for(const key of bins){if(!cells.has(key))cells.set(key,[]);cells.get(key).push(f);}}
 return {query(box){const bins=keys(box);return bins?[...new Set([...oversized,...bins.flatMap(key=>cells.get(key)||[])])]:features;}};
}

// A sticker on a curved face is the same surface trimmed to its outline, so the cut is in (u,v).
function cutSurfaceOpenings(face,features){
 const c=face.curvedSurface,key=JSON.stringify(K.surfaceDefinition(c));if(!Array.isArray(features))features=features.query(openingBounds(K.surfaceMesh(face).positions));
 const cuts=features.filter(f=>f!==face&&f.feature&&!f.deleted&&!f.drafted&&f.curvedSurface?.logical&&JSON.stringify(K.surfaceDefinition(f.curvedSurface))===key).flatMap(f=>f.curvedSurface.domains);
 if(!cuts.length)return [face];
 const domains=c.domains.flatMap(d=>K.difference(d,cuts));return domains.length?[{...face,curvedSurface:{...c,domains}}]:[];
}
function cutOpenings(face,features){
 if(face.curvedSurface?.logical&&!face.feature&&!face.deleted)return cutSurfaceOpenings(face,features);
 if(face.feature||face.curvedSurface||face.deleted)return [face];
 const frame=W.faceFrame(face);if(!frame)return [face];
 const local=p=>K.local(frame,p),shape=f=>({points:f.points.map(local),holes:(f.holes||[]).map(r=>r.map(local))});
 const box=openingBounds(face.points);if(!Array.isArray(features))features=features.query(box);
 const cuts=features.filter(f=>{if(f===face||!f.feature||f.deleted||f.drafted||f.solidId)return false;const other=openingBounds(f.points);return box.every(([lo,hi],i)=>other[i][1]>=lo-.002&&other[i][0]<=hi+.002)&&f.points.every(p=>Math.abs(local(p).z)<=.002);}).map(shape);
 if(!cuts.length)return [face];
 const original=shape(face),key=JSON.stringify([original,cuts]);let parts=openingCache.get(key);
 if(parts){openingCache.delete(key);openingCache.set(key,parts);}else{parts=K.difference(original,cuts);openingCache.set(key,parts);if(openingCache.size>openingCacheLimit)openingCache.delete(openingCache.keys().next().value);}
 if(Math.abs(parts.reduce((sum,f)=>sum+K.area(f),0)-K.area(original))<1e-8)return [face];
 return parts.map(part=>({...face,points:part.points.map(p=>W.fromFrame(frame,p)),holes:part.holes.map(r=>r.map(p=>W.fromFrame(frame,p)))}));
}
// A published planar face has three distinct corners and more than grid width.
// Clipping noise is removed where an operation makes it, never published.
function degenerateFace(f){
 if(f.curvedSurface)return false;const r=f.points,corners=r.filter((p,i)=>K.CONTACT<Math.hypot(p.x-r[(i+1)%r.length].x,p.y-r[(i+1)%r.length].y,p.z-r[(i+1)%r.length].z));if(corners.length<3)return true;
 const frame=K.frame(f),area=K.area({points:r.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(h=>h.map(p=>K.local(frame,p)))}),longest=Math.max(...r.map((p,i)=>Math.hypot(p.x-r[(i+1)%r.length].x,p.y-r[(i+1)%r.length].y,p.z-r[(i+1)%r.length].z)));
 return area/longest<=K.GRID;
}
function validateResult(result){
 for(const f of [result.cap,...(result.sides||[]),...(result.replacements||[]).flatMap(r=>r.pieces)].filter(f=>f&&!f.deleted)){K.validateFace(f);if(degenerateFace(f))throw Error('The result contains a zero-area face.');}
 for(const f of result.base?.faces||[]){if(!f.points.every(K.finite3))throw Error('Base update produced a non-finite coordinate.');K.triangles(f.points,f.holes||[]);}
 return result;
}
function conformBase(source,cap,sides,base){
 const n=W.normal(source.points);if(!base||!W.horizontalSweep(n))return;
 if(source.curvedSurface?.logical){if(Math.abs(n.z)>K.CONTACT)return;
  const delta={x:cap.points[0].x-source.points[0].x,y:cap.points[0].y-source.points[0].y,z:cap.points[0].z-source.points[0].z},outline=K.surfaceOutline(source),planes=base.faces.map(f=>({f,plane:G.plane(f.points)})).filter(({f,plane})=>plane&&outline.points.some(p=>G.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002));
  const fit=p=>{const old={x:p.x-delta.x,y:p.y-delta.y,z:p.z-delta.z},contact=planes.find(({plane})=>Math.abs(old.z-plane.dx*old.x-plane.dy*old.y-plane.k)<K.CONTACT);return contact?{...p,z:contact.plane.dx*p.x+contact.plane.dy*p.y+contact.plane.k}:p;};
  for(const f of [cap,...sides])Object.assign(f,K.mapCurveData(f,fit),{points:f.points.map(fit),holes:(f.holes||[]).map(r=>r.map(fit))});return;
 }
 // Slide a ground contact up or down within the cap plane. On a vertical
 // wall that is a purely vertical move; on a leaning wall it keeps the cap planar.
 const up={x:-n.x*n.z,y:-n.y*n.z,z:1-n.z*n.z},size=Math.hypot(up.x,up.y,up.z),w={x:up.x/size,y:up.y/size,z:up.z/size};
 const changes=[];for(let i=0;i<source.points.length;i++){const p=source.points[i],q=cap.points[i],contact=base.faces.find(f=>{const plane=G.plane(f.points);return plane&&G.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002;});if(!contact)continue;const plane=G.plane(contact.points);changes.push({from:{...q},plane,z:plane.dx*q.x+plane.dy*q.y+plane.k});}
 // Each point slides by its own offset, so distinct nearby points stay distinct.
 for(const f of [cap,...sides])for(const p of [f.points,...(f.holes||[])].flat()){const c=changes.find(c=>Math.hypot(p.x-c.from.x,p.y-c.from.y,p.z-c.from.z)<=K.CONTACT);if(!c)continue;if(!w.x&&!w.y){p.z=c.z;continue;}const {dx,dy,k}=c.plane,t=(dx*p.x+dy*p.y+k-p.z)/(w.z-dx*w.x-dy*w.y);p.x+=t*w.x;p.y+=t*w.y;p.z+=t*w.z;}
}
// A return runs along the wall it starts on. Walls are square only to within
// survey and edit rounding, so a return swept along the face normal leaves the
// adjoining wall's plane by microns per metre, stops counting as part of it
// and is built as a separate wall beside it. Slide each swept corner within
// the cap plane onto that wall. A wall within a degree or two of square (RAIL_ANGLE)
// counts: closer than that it is the wall the return belongs to, not a second one.
function alignReturns(face,cap,sides,scene){
 const n=W.normal(face.points);if(!n||face.curvedSurface)return;
 const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<=K.CONTACT;
 const onRing=(p,f)=>[f.points,...(f.holes||[])].some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],d=sub(b,a),l2=dot(d,d),t=l2?Math.max(0,Math.min(1,dot(sub(p,a),d)/l2)):0;return near(p,{x:a.x+d.x*t,y:a.y+d.y*t,z:a.z+d.z*t});}));
 const walls=scene.filter(f=>!f.deleted&&!f.feature&&!f.curvedSurface).map(f=>({f,m:W.normal(f.points)})).filter(w=>w.m),moves=[];
 for(let i=0;i<face.points.length;i++){const p=face.points[i],q=cap.points[i],length=Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z);if(length<=K.CONTACT)continue;
  for(const {f,m}of walls){const off=dot(sub(q,f.points[0]),m),u=sub(m,{x:n.x*dot(m,n),y:n.y*dot(m,n),z:n.z*dot(m,n)}),size=dot(u,u);
   if(Math.abs(off)<=1e-9||Math.abs(off)>length*Math.tan(W.RAIL_ANGLE)||size<.25||Math.abs(dot(sub(p,f.points[0]),m))>K.CONTACT||!onRing(p,f))continue;
   moves.push({from:{...q},to:{x:q.x-u.x*off/size,y:q.y-u.y*off/size,z:q.z-u.z*off/size}});break;
  }
 }
 for(const g of [cap,...sides])for(const p of [g.points,...(g.holes||[])].flat()){const move=moves.find(m=>near(p,m.from));if(move)Object.assign(p,move.to);}
}
// Where there is no base under a wall, its foot is the line its neighbours
// stand on. A cap pushed in along a wall whose foot rises keeps to that foot,
// rather than hanging below it and leaving a wedge of return under the wall.
function conformFooting(face,cap,sides,scene,base){
 const n=W.normal(face.points);if(!n||face.curvedSurface||Math.abs(n.z)>K.CONTACT)return;
 const plan=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<=K.CONTACT;
 // Past the end of the wall its foot continues on the same line.
 const foot=(f,p,beyond=false)=>{let z=null,past=null,gap=Infinity;for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1e-10)continue;const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;if(Math.hypot(a.x+dx*t-p.x,a.y+dy*t-p.y)>1e-4)continue;const h=a.z+(b.z-a.z)*t,out=Math.max(-t,t-1,0)*Math.sqrt(l2);if(out>1e-6){if(out<gap-1e-6||Math.abs(out-gap)<=1e-6&&h<past){gap=out;past=h;}continue;}if(z===null||h<z)z=h;}return z===null&&beyond?past:z;};
 const walls=scene.filter(f=>!f.deleted&&!f.feature&&!f.curvedSurface).map(f=>({f,m:W.normal(f.points)})).filter(w=>w.m&&Math.abs(w.m.z)<.02),changes=[];
 for(let i=0;i<face.points.length;i++){const p=face.points[i],q=cap.points[i];if(plan(p,q)<=K.CONTACT||face.points.some(o=>plan(o,p)<=K.CONTACT&&o.z<p.z-K.CONTACT))continue;
  if(base?.faces?.some(f=>{const plane=G.plane(f.points);return plane&&G.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002;}))continue;
  const top=Math.max(...cap.points.filter(o=>plan(o,q)<=K.CONTACT).map(o=>o.z));
  for(const {f,m}of walls){if([p,q].some(o=>Math.abs((o.x-f.points[0].x)*m.x+(o.y-f.points[0].y)*m.y+(o.z-f.points[0].z)*m.z)>K.CONTACT))continue;
   const from=foot(f,p),along=foot(f,{x:p.x+(q.x-p.x)*.001,y:p.y+(q.y-p.y)*.001}),to=along===null?null:foot(f,q,true);if(from===null||to===null||Math.abs(from-p.z)>1e-4||Math.abs(to-q.z)<=1e-9||to>=top-.02)continue;
   changes.push({from:{...q},z:to});break;
  }
 }
 for(const g of [cap,...sides])for(const p of [g.points,...(g.holes||[])].flat()){const c=changes.find(c=>near(p,c.from));if(c)p.z=c.z;}
}
// The corners of a pushed face are fitted to what it stands on (the base, the foot of the wall beside it). The
// points it keeps along its edges are fitted with them: one at a corner goes where the corner went, one on an edge
// stays on that edge. swept: the outline as it was swept, before fitting. Left where the sweep put them, they
// stayed at the old height, under the wall they belong to.
function followRetained(cap,swept){
 if(!cap.retainedPoints?.length||swept.length!==cap.points.length)return;const far=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),n=swept.length;
 cap.retainedPoints=cap.retainedPoints.map(r=>{const i=swept.findIndex(p=>far(p,r)<=K.CONTACT);if(i>=0)return {...r,x:cap.points[i].x,y:cap.points[i].y,z:cap.points[i].z};
  for(let j=0;j<n;j++){const a=swept[j],b=swept[(j+1)%n],u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},l2=u.x*u.x+u.y*u.y+u.z*u.z;if(l2<1e-12)continue;const t=((r.x-a.x)*u.x+(r.y-a.y)*u.y+(r.z-a.z)*u.z)/l2;if(t<=0||t>=1||far(r,{x:a.x+u.x*t,y:a.y+u.y*t,z:a.z+u.z*t})>K.CONTACT)continue;
   const p=cap.points[j],q=cap.points[(j+1)%n];return {...r,x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,z:p.z+(q.z-p.z)*t};}
  return r;});
}
function extrusionTrim(scene,sources,caps,keepStatic){
 const selected=new Set(sources.map(f=>f.id)),faces=[...scene.filter(f=>!selected.has(f.id)),...caps];
 const moved=W.followTrim([...scene.filter(f=>!selected.has(f.id)),...sources],{faces,moves:[],affected:[]},[...selected],keepStatic);
 const ids=new Set(moved.affected);return {ids,replacements:moved.faces.filter(f=>ids.has(f.id)).map(f=>({face:scene.find(s=>s.id===f.id),pieces:[f,...(moved.trimFragments?.[f.id]||[])]})).filter(r=>r.face)};
}
function planarExtrusionReturns(sides){
 // Ground fitting can twist a return along a slanted source edge. Preserve
 // all four boundary corners by tessellating that return before booleans.
 return sides.flatMap(face=>{if(face.curvedSurface)return [face];const frame=K.frame(face);if(!frame)return [face];const rings=[face.points,...(face.holes||[])],points=rings.flat(),local=rings.map(r=>r.map(p=>K.local(frame,p)));if(local.flat().every(p=>Math.abs(p.z)<=K.CONTACT))return [face];return K.triangles(local[0],local.slice(1)).triangles.map((ids,i)=>({...face,id:i?face.id+'-facet-'+i:face.id,points:ids.map(j=>points[j]),holes:[]}));});
}
function createExtrusion(input){
 const start=copy(input),face=start.face,scene=(start.scene||[]).filter(f=>!f.deleted&&!f.snapOnly&&f.id!==face.id);
 // A face whose corners meet within contact tolerance is one edge to the
 // incidence graph; its sweep could only publish another zero-area face.
 K.validateFace(face);if(degenerateFace(face))throw Error('The face has no area.');const topology=K.topology([face,...scene,...(start.base?.faces||[]).map(f=>({...f,id:'base:'+f.id}))],scene.flatMap(f=>f.retainedPoints||[]));
 // Keep shared edge anchors even when boolean boundaries omit collinear points.
 face.retainedPoints=[...new Map([...(face.retainedPoints||[]),...topology.vertices.filter(v=>v.faces.has(face.id)).map(v=>v.point)].map(p=>[K.pointKey(p),p])).values()];
 let previousAmount=null,previous=null;
 return {face:copy(face),topology,preview(amount,{fit=null}={}){
  if(!Number.isFinite(amount))throw Error('Enter a finite extrusion distance.');if(!fit&&amount===previousAmount&&previous)return copy(previous);
  // A standalone face sweeps its whole boundary. A sticker or an earlier cap
  // retains supported returns. A region of a coplanar host wall closes
  // everything except an intentionally open door threshold (a recess gets its
  // ceiling). None returns along the ground: the base update moves the base.
  const supports=start.supports||scene,patch=supports.some(f=>W.coplanarContact(face,f)&&face.points.some((p,i)=>W.sharedIntervals(p,face.points[(i+1)%face.points.length],[f]).length)),hosted=face.supportedExtrusion||face.feature||patch;
  let shape=W.extrude(face,amount,{facets:true,completeBoundary:!hosted,hostedPatch:patch&&!face.feature&&!face.supportedExtrusion,direction:start.direction,supports,ground:start.base?.faces});if(hosted)shape.cap.supportedExtrusion=true;const swept=shape.cap.points.map(p=>({x:p.x,y:p.y,z:p.z}));conformBase(face,shape.cap,shape.sides,start.base);alignReturns(face,shape.cap,shape.sides,scene);conformFooting(face,shape.cap,shape.sides,scene,start.base);followRetained(shape.cap,swept);shape.sides=planarExtrusionReturns(shape.sides);const fitMoves=fit?fit(shape.cap,shape.sides):null;const base=start.base?B.extrudeWall(start.base,face,shape.cap):null;shape=W.roofExtrusion(face,amount,shape,start.roof,{direction:start.direction});
  const trim=extrusionTrim(scene,[face],[shape.cap],start.keepTrimStatic),trimmed=W.trimExtrusion(shape.sides,scene.filter(f=>!trim.ids.has(f.id)));trimmed.replacements.push(...trim.replacements);trimmed.sides=K.compactSurfaces(trimmed.sides);K.attachBoundaryCurves(trimmed.replacements.flatMap(r=>r.pieces),[shape.cap,...trimmed.sides]);
  const result=validateResult({cap:shape.cap,sides:trimmed.sides,replacements:trimmed.replacements,base,amount,fitMoves});
  if(!fit){previousAmount=amount;previous=copy(result);}return result;
 }};
}
// A shared distance with independent face normals. Build every sweep from the
// same immutable shell, then trim their combined returns once. Applying each
// replacement separately would overwrite earlier cuts to a shared neighbor.
function createExtrusions(input){
 const start=copy(input),members=start.members,ids=new Set(members.map(m=>m.face.id));
 if(members.length<2||ids.size!==members.length)throw Error('Select distinct faces to extrude together.');
 const scene=start.scene||[],neighbors=scene.filter(f=>!ids.has(f.id)),topology=K.topology([...members.map(m=>m.face),...neighbors.filter(f=>!f.snapOnly&&!f.deleted)],scene.flatMap(f=>f.retainedPoints||[]));
 for(const {face}of members)face.retainedPoints=[...new Map([...(face.retainedPoints||[]),...topology.vertices.filter(v=>v.faces.has(face.id)).map(v=>v.point)].map(p=>[K.pointKey(p),p])).values()];
 const engines=members.map(m=>createExtrusion({face:m.face,scene:[],supports:m.supports||scene.filter(f=>f.id!==m.face.id),roof:start.roof,base:start.base}));
 let previousAmount=null,previous=null;
 return {preview(amount){
  if(!Number.isFinite(amount))throw Error('Enter a finite extrusion distance.');
  if(amount===previousAmount&&previous)return copy(previous);
  const results=engines.map((engine,i)=>engine.preview(amount*(members[i].sign||1))),caps=results.map(r=>r.cap);
  let sides=[];
  for(const result of results){const trimmed=W.trimExtrusion(result.sides,sides),changed=new Set(trimmed.replacements.map(r=>r.face.id));sides=[...sides.filter(f=>!changed.has(f.id)),...trimmed.replacements.flatMap(r=>r.pieces),...trimmed.sides];}
  const trim=extrusionTrim(scene,members.map(m=>m.face),caps,start.keepTrimStatic),trimmed=W.trimExtrusion(sides,neighbors.filter(f=>!trim.ids.has(f.id)));trimmed.replacements.push(...trim.replacements);trimmed.sides=K.compactSurfaces(trimmed.sides);
  K.attachBoundaryCurves(trimmed.replacements.flatMap(r=>r.pieces),[...caps,...trimmed.sides]);
  let base=start.base?copy(start.base):null;
  if(base)for(let i=0;i<members.length;i++)base=B.extrudeWall(base,members[i].face,caps[i]);
  validateResult({cap:caps[0],sides:[...caps.slice(1),...trimmed.sides],replacements:trimmed.replacements});
  previousAmount=amount;previous={caps,sides:trimmed.sides,replacements:trimmed.replacements,base,amount};return copy(previous);
 }};
}
// Any command can use the same rollback boundary, including tools still using
// the saved-project adapter. Validation runs before a candidate is published.
function transaction(before,operation,validate=()=>{}){const candidate=copy(before);operation(candidate);validate(candidate,before);return candidate;}
function reconcileChimneys(state,edits){
 const C=node?require('./wall_chimneys.js'):root.WallChimneys;if(!C)return edits;
 const base=edits.$base||state.base;if(!state.chimneys?.items?.length&&!base?.chimneyFoundationVersion&&!base?.faces?.some(f=>f.chimneyFoundation))return edits;
 const candidate={...state,base:copy(state.base||null),wallEdits:copy(edits)};C.syncFoundation(candidate);C.alignRoofContacts?.(candidate);
 if(!candidate.wallEdits.$base&&!same(candidate.base,state.base||null))candidate.wallEdits.$base=candidate.base;
 return candidate.wallEdits;
}
// Preview and placement must publish the same normalized candidate. Never mutate
// the caller while reconciling or validating: failures leave its preview intact.
function prepareEdits(state,edits,before={}){const reconciled=reconcileChimneys(state,edits),next=reconciled===edits?copy(edits):reconciled;validateEdits(next,before,true);W.restoreCreatedSurfaceWire(next,before);W.followWireExclusions(next,before);W.localizeWireMasks(next);settleDeletedWire({...state,wallEdits:next});return next;}
// Deleted faces stop drawing lines (W.settleDeletedWire). The lines a drawing's live regions and the generated
// walls draw themselves are not kept a second time as free-standing lines.
function settleDeletedWire(state){const edits=state?.wallEdits;if(!edits)return false;let cover=[];try{cover=collect(state,state.alignedWalls||[]).filter(f=>f.draft||String(f.id).startsWith('wall:'));}catch(e){cover=[];}const base=(edits.$base||state.base)?.faces||[];return W.settleDeletedWire(edits,[...cover,...base.filter(f=>!f.curves?.length)]);}
// unshared: the caller guarantees edits and before have no objects in common
// (e.g. prepareEdits' fresh copy), so a prior surface can be compared when
// needed instead of first serializing every one; nothing here changes before.
function validateEdits(edits,before={},unshared=false){
 if(edits.$surfaces)edits.$surfaces=K.compactSurfaces(edits.$surfaces);
 if(edits.$loose){if((edits.$loose.points||[]).some(p=>!K.finite3(p))||(edits.$loose.edges||[]).some(pair=>pair.length!==2||pair.some(p=>!K.finite3(p))))throw Error('Copied geometry contains an invalid point or line.');}
 let unchanged;if(unshared){const old=new Map((before.$surfaces||[]).map(f=>[f.id,f]));unchanged=f=>old.has(f.id)&&same(old.get(f.id),f);}else{const old=new Map((before.$surfaces||[]).map(f=>[f.id,JSON.stringify(f)]));unchanged=f=>old.get(f.id)===JSON.stringify(f);}
 if(edits.$surfaces){const ids=new Set(edits.$surfaces.map(f=>f.id));edits.$surfaces=edits.$surfaces.flatMap(f=>{if(f.deleted||f.drafted||unchanged(f))return [f];const parts=K.normalizeFaces(f,ids);for(const part of parts){ids.add(part.id);K.validateFace(part);}Object.assign(f,parts[0]);return [f,...parts.slice(1)];});}
 const oldDrafts=before.$drafts||{};for(const [key,d]of Object.entries(edits.$drafts||{})){if(same(d,oldDrafts[key]))continue;const regionIds=new Set((d.faces||[]).map(f=>f.id));d.faces=(d.faces||[]).flatMap(f=>{if(f.solidId||f.boundaryHole||(d.deletedFaces||[]).includes(f.points.map(p=>p.nodeId).sort().join('|')))return [f];
  // A cut ending at an opening can split a bridged wall ring into multiple
  // valid regions. Retain each region and its sketch-node ownership.
  const parts=f.feature?[K.normalizeFace(f)]:K.normalizeFaces(f,regionIds),anchors=[f.points,...(f.holes||[])].flat();for(const part of parts)regionIds.add(part.id);
  for(const part of parts){if(parts.length>1){const restore=p=>{const a=anchors.find(a=>Math.hypot(a.x-p.x,a.y-p.y,(a.z||0)-(p.z||0))<=K.CONTACT);if(a)return {...p,nodeId:a.nodeId};const n=d.sketch?.nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<=K.CONTACT);if(!n)throw Error('The split wall needs a connected sketch point.');return {...p,nodeId:n.id};};part.points=part.points.map(restore);part.holes=(part.holes||[]).map(r=>r.map(restore));}K.triangles(part.points,part.holes||[]);}
  Object.assign(f,parts[0]);return [f,...parts.slice(1)];});}
 if(edits.$base&&!same(edits.$base.faces,before.$base?.faces))for(const f of edits.$base.faces)K.triangles(f.points,f.holes||[]);
}
const api={version:2,settleDeletedWire,followRetained,indexOpenings,cutOpenings,draftFace,repairFaceIdentities,restoreDraftFaceOwnership,reconcileChimneys,prepareEdits,collect,createExtrusion,createExtrusions,validateResult,validateEdits,transaction,jsonCopy:copy};if(node)module.exports=api;else root.ExteriorModel=api;
})(typeof window==='undefined'?globalThis:window);
