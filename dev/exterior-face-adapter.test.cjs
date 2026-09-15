const test=require('node:test'),assert=require('node:assert/strict'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
const copy=x=>JSON.parse(JSON.stringify(x)),saved=require('./fixtures/remote-indent-chimney.json'),area=f=>{const frame=W.faceFrame(f);return K.area({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))});};
function beforeIndent(){const state=copy(saved);for(const d of Object.values(state.wallEdits.$drafts))for(const f of d.faces)if(f.solidId?.startsWith('swept-')||f.solidId?.startsWith('region-R20'))delete f.solidId;state.wallEdits.$surfaces=state.wallEdits.$surfaces.filter(f=>!f.id.startsWith('swept-')&&!f.id.startsWith('region-R20'));return state;}
test('remote indent retains the joined chimney extent of its perpendicular wall',()=>{
 const state=beforeIndent(),before=JSON.stringify(state),scene=M.collect(state),source=scene.find(f=>f.draftKey==='R20.0:0'&&f.regionId==='base-face-11'),neighbor=scene.find(f=>f.draftKey?.startsWith('R17.1:0')),cap=saved.wallEdits.$surfaces.find(f=>f.id==='region-R20.0:0-base-face-11'),n=W.normal(source.points),amount=['x','y','z'].reduce((s,k)=>s+(cap.points[0][k]-source.points[0][k])*n[k],0);
 const engine=M.createExtrusion({face:source,scene}),result=engine.preview(amount),replacement=result.replacements.find(r=>r.face.id===neighbor.id);assert.ok(replacement,'The indent must trim the adjoining end of the long wall');
 assert.deepEqual(neighbor.joinedChimneys,state.wallEdits.$drafts[neighbor.draftKey].joinedChimneys);
 const remote=neighbor.points.filter(p=>Math.abs(['x','y','z'].reduce((s,k)=>s+(p[k]-source.points[0][k])*n[k],0))>2);assert.ok(remote.length>=3);for(const p of remote)assert.ok(replacement.pieces.some(f=>f.points.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-5)),'Far wall corners must remain in place');assert.equal(replacement.pieces.length,1);
 for(const piece of replacement.pieces){assert.deepEqual(piece.joinedChimneys,neighbor.joinedChimneys);assert.ok(Math.abs(C.visibleParts(piece,state).reduce((s,p)=>s+area(p),0)-area(piece))<1e-7,'Clipping must not reopen the distant chimney seam');}
 assert.equal(JSON.stringify(state),before,'Preview must not mutate the model');
 const untouched=scene.filter(f=>f.id!==source.id&&!result.replacements.some(r=>r.face.id===f.id));assert.ok(untouched.length>3);assert.equal(JSON.stringify(engine.preview(amount)),JSON.stringify(result),'Repeated preview is deterministic');
});
test('saved replacement repair restores only proven ownership and leaves geometry and finishes unchanged',()=>{
 const state=copy(saved),edits=state.wallEdits,surface=edits.$surfaces.find(f=>f.draftKey?.startsWith('R17.1:0')),before=JSON.stringify(edits),lost=area(surface)-C.visibleParts(surface,state).reduce((s,p)=>s+area(p),0);
 assert.ok(lost>.1,'Saved fixture must reproduce clipping at the far chimney');
 const unrelated={...copy(surface),id:'unrelated-copy',finishColor:'#aabbcc'};edits.$surfaces.push(unrelated);surface.material='custom';surface.finishColor='#112233';const geometry=JSON.stringify(edits.$surfaces.map(f=>[f.points,f.holes]));
 assert.equal(M.restoreDraftFaceOwnership(edits),true);assert.deepEqual(surface.joinedChimneys,['roof-chimney-11-12-13-14']);assert.equal(unrelated.joinedChimneys,undefined);assert.equal(surface.material,'custom');assert.equal(surface.finishColor,'#112233');assert.equal(JSON.stringify(edits.$surfaces.map(f=>[f.points,f.holes])),geometry);
 assert.ok(Math.abs(C.visibleParts(surface,state).reduce((s,p)=>s+area(p),0)-area(surface))<1e-7);assert.equal(M.restoreDraftFaceOwnership(edits),false);assert.notEqual(JSON.stringify(edits),before);
});
test('draft adapter preserves inherited ownership, face metadata, local geometry and analytic curves',()=>{
 for(const framed of [false,true]){
  const points=[{x:0,y:0,z:0,nodeId:'a'},{x:2,y:0,z:0,nodeId:'b'},{x:2,y:2,z:0,nodeId:'c'},{x:0,y:2,z:0,nodeId:'d'}],d={origin:{x:10,y:20},u:{x:0,y:1},joinedChimneys:['parent'],chimney:{id:'parent',side:1},faces:[],sketch:{nodes:points.map(p=>({...p,id:p.nodeId}))}};
  if(framed)d.frame={origin:{x:10,y:20,z:30},u:{x:0,y:1,z:0},v:{x:0,y:0,z:1},n:{x:1,y:0,z:0}};
  const f={id:'region',points,holes:[],joinedChimneys:['child'],material:'horizontal-siding',finishColor:'#334455',trim:true,feature:{type:'window'},futureMetadata:{value:'preserved'},curves:[{type:'conic',start:points[0],control:{x:1,y:1,z:0},end:points[1],weight:1}]};d.faces.push(f);
  const before=JSON.stringify(d),face=M.draftFace(d,f,{id:'face',draftKey:'d'}),collected=M.collect({wallEdits:{$drafts:{d}}})[0];assert.deepEqual(face.joinedChimneys,['parent','child']);assert.deepEqual(collected.joinedChimneys,face.joinedChimneys);
  for(const key of ['material','finishColor','feature','trim','futureMetadata'])assert.deepEqual(face[key],f[key]);assert.deepEqual(face.curves[0].start,face.points[0]);assert.equal(face.points[0].z,framed?30:0);face.futureMetadata.value='changed';face.chimney.side=3;assert.equal(JSON.stringify(d),before);
 }
});
