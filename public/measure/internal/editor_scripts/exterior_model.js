/* Exterior operation boundary. Immutable inputs, validated results, explicit commit. */
(function(root){'use strict';
const node=typeof module==='object'&&module.exports;
const K=node?require('./exterior_geometry.js'):root.ExteriorGeometry,W=node?require('./wall_solid_geometry.js'):root.WallSolidGeometry,B=node?require('./base_geometry.js'):root.BaseGeometry,G=node?require('./wall_geometry.js'):root.WallGeometry;
const copy=x=>JSON.parse(JSON.stringify(x));
const world=(d,p)=>d.frame?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};
// One boundary between editable local regions and world-space engine faces.
// Geometry and appearance belong to the region; joined-plane ownership can be
// inherited from its draft. All callers must preserve both when materializing it.
function draftFace(d,f,overrides={}){
 const map=p=>world(d,p),joinedChimneys=[...new Set([...(d.joinedChimneys||[]),...(f.joinedChimneys||[])])];
 return {...copy(f),...K.mapCurveData(f,map),chimney:(f.chimney||d.chimney)?copy(f.chimney||d.chimney):undefined,...(joinedChimneys.length?{joinedChimneys}:{}),points:f.points.map(map),holes:(f.holes||[]).map(r=>r.map(map)),retainedPoints:overrides.retainedPoints||(d.sketch?.nodes||[]).filter(p=>!(d.removedPoints||[]).includes(p.id)&&G.contains(f,p)).map(p=>({...map(p),anchorId:overrides.draftKey?overrides.draftKey+':'+p.id:undefined})),...overrides};
}
// Repair the missing ownership field in persisted operation replacements. The
// stored source IDs prove ancestry; do not guess from proximity or recompute faces.
function restoreDraftFaceOwnership(edits){
 let changed=false;
 for(const f of edits?.$surfaces||[]){
  const d=edits.$drafts?.[f.draftKey],source=d?.faces.find(r=>r.id===f.regionId);
  if(!source?.solidId||!(f.id===source.solidId||f.id.startsWith(source.solidId+'-')))continue;
  const joined=[...new Set([...(f.joinedChimneys||[]),...(d.joinedChimneys||[]),...(source.joinedChimneys||[])])];
  if(joined.length!==(f.joinedChimneys||[]).length){f.joinedChimneys=joined;changed=true;}
 }
 return changed;
}
function collect(state,rawWalls=[]){
 const edits=state.wallEdits||{},drafts=Object.entries(edits.$drafts||{}).filter(([,d])=>!d.mergedInto),claimed=new Set(drafts.flatMap(([,d])=>d.members||[])),faces=[];
 for(const f of edits.$surfaces||[])if(!f.deleted&&!f.drafted)faces.push({...f});
 for(const [key,d]of drafts)for(const f of d.faces||[]){const signature=f.points.map(p=>p.nodeId).sort().join('|');if(f.solidId||f.boundaryHole||(d.deletedFaces||[]).includes(signature)||f.points.some(p=>(d.removedPoints||[]).includes(p.nodeId)))continue;
 faces.push(draftFace(d,f,{id:'draft:'+key+':'+f.id,draft:true,draftKey:key,regionId:f.id}));}
 for(const w of rawWalls)if(!claimed.has(w.id))faces.push({id:'wall:'+w.id,points:[...w.bottom,...w.top.slice().reverse()],chimney:w.chimney});
 return faces;
}
function validateResult(result){
 for(const f of [result.cap,...(result.sides||[]),...(result.replacements||[]).flatMap(r=>r.pieces)].filter(f=>f&&!f.deleted))K.validateFace(f);
 for(const f of result.base?.faces||[]){if(!f.points.every(K.finite3))throw Error('Base update produced a non-finite coordinate.');K.triangles(f.points,f.holes||[]);}
 return result;
}
function conformBase(source,cap,sides,base){
 if(!base||Math.abs(W.normal(source.points).z)>K.CONTACT)return;
 if(source.curvedSurface?.logical){
  const delta={x:cap.points[0].x-source.points[0].x,y:cap.points[0].y-source.points[0].y,z:cap.points[0].z-source.points[0].z},outline=K.surfaceOutline(source),planes=base.faces.map(f=>({f,plane:G.plane(f.points)})).filter(({f,plane})=>plane&&outline.points.some(p=>G.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002));
  const fit=p=>{const old={x:p.x-delta.x,y:p.y-delta.y,z:p.z-delta.z},contact=planes.find(({plane})=>Math.abs(old.z-plane.dx*old.x-plane.dy*old.y-plane.k)<K.CONTACT);return contact?{...p,z:contact.plane.dx*p.x+contact.plane.dy*p.y+contact.plane.k}:p;};
  for(const f of [cap,...sides])Object.assign(f,K.mapCurveData(f,fit),{points:f.points.map(fit),holes:(f.holes||[]).map(r=>r.map(fit))});return;
 }
 const changes=[];for(let i=0;i<source.points.length;i++){const p=source.points[i],q=cap.points[i],contact=base.faces.find(f=>{const plane=G.plane(f.points);return plane&&G.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.002;});if(!contact)continue;const plane=G.plane(contact.points);changes.push({from:{...q},z:plane.dx*q.x+plane.dy*q.y+plane.k});}
 for(const f of [cap,...sides])for(const p of [f.points,...(f.holes||[])].flat()){const c=changes.find(c=>Math.hypot(p.x-c.from.x,p.y-c.from.y,p.z-c.from.z)<=K.CONTACT);if(c)p.z=c.z;}
}
function createExtrusion(input){
 const start=copy(input),face=start.face,scene=(start.scene||[]).filter(f=>!f.deleted&&!f.snapOnly&&f.id!==face.id);
 K.validateFace(face);const topology=K.topology([face,...scene,...(start.base?.faces||[]).map(f=>({...f,id:'base:'+f.id}))],scene.flatMap(f=>f.retainedPoints||[]));
 // Keep shared edge anchors even when boolean boundaries omit collinear points.
 face.retainedPoints=[...new Map([...(face.retainedPoints||[]),...topology.vertices.filter(v=>v.faces.has(face.id)).map(v=>v.point)].map(p=>[K.pointKey(p),p])).values()];
 let previousAmount=null,previous=null;
 return {face:copy(face),topology,preview(amount,{fit=null}={}){
  if(!Number.isFinite(amount))throw Error('Enter a finite extrusion distance.');if(!fit&&amount===previousAmount&&previous)return copy(previous);
  let shape=W.extrude(face,amount,{facets:true,supports:start.supports||scene});conformBase(face,shape.cap,shape.sides,start.base);const fitMoves=fit?fit(shape.cap,shape.sides):null;const base=start.base?B.extrudeWall(start.base,face,shape.cap):null;shape=W.roofExtrusion(face,amount,shape,start.roof);
  const trimmed=W.trimExtrusion(shape.sides,scene);trimmed.sides=K.compactSurfaces(trimmed.sides);K.attachBoundaryCurves(trimmed.replacements.flatMap(r=>r.pieces),[shape.cap,...trimmed.sides]);
  const result=validateResult({cap:shape.cap,sides:trimmed.sides,replacements:trimmed.replacements,base,amount,fitMoves});
  if(!fit){previousAmount=amount;previous=copy(result);}return result;
 }};
}
// Any command can use the same rollback boundary, including tools still using
// the saved-project adapter. Validation runs before a candidate is published.
function transaction(before,operation,validate=()=>{}){const candidate=copy(before);operation(candidate);validate(candidate,before);return candidate;}
function reconcileChimneys(state,edits){
 const C=node?require('./wall_chimneys.js'):root.WallChimneys;if(!C)return edits;
 const candidate={...state,base:copy(state.base||null),wallEdits:copy(edits)};C.syncFoundation(candidate);C.alignRoofContacts?.(candidate);
 if(!candidate.wallEdits.$base&&JSON.stringify(candidate.base)!==JSON.stringify(state.base||null))candidate.wallEdits.$base=candidate.base;
 return candidate.wallEdits;
}
function validateEdits(edits,before={}){
 if(edits.$surfaces)edits.$surfaces=K.compactSurfaces(edits.$surfaces);
 if(edits.$loose){if((edits.$loose.points||[]).some(p=>!K.finite3(p))||(edits.$loose.edges||[]).some(pair=>pair.length!==2||pair.some(p=>!K.finite3(p))))throw Error('Copied geometry contains an invalid point or line.');}
 const old=new Map((before.$surfaces||[]).map(f=>[f.id,JSON.stringify(f)]));
 for(const f of edits.$surfaces||[])if(!f.deleted&&!f.drafted&&old.get(f.id)!==JSON.stringify(f))K.validateFace(f);
 const oldDrafts=before.$drafts||{};for(const [key,d]of Object.entries(edits.$drafts||{})){if(JSON.stringify(d)===JSON.stringify(oldDrafts[key]))continue;for(const f of d.faces||[]){if(f.solidId||f.boundaryHole)continue;K.triangles(f.points,f.holes||[]);}}
 if(edits.$base&&JSON.stringify(edits.$base.faces)!==JSON.stringify(before.$base?.faces))for(const f of edits.$base.faces)K.triangles(f.points,f.holes||[]);
}
const api={version:2,draftFace,restoreDraftFaceOwnership,reconcileChimneys,collect,createExtrusion,validateResult,validateEdits,transaction};if(node)module.exports=api;else root.ExteriorModel=api;
})(typeof window==='undefined'?globalThis:window);
