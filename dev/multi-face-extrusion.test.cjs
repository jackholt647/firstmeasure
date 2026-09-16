const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../public/measure/internal/editor_scripts/exterior_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const face=(id,points,extra={})=>({id,points:points.map(([x,y,z])=>({x,y,z})),holes:[],...extra});
const area=f=>{const frame=W.faceFrame(f),local=p=>W.inFrame(frame,p);return K.area({points:f.points.map(local),holes:(f.holes||[]).map(r=>r.map(local))});};
const front=(id,x=0)=>face(id,[[x,0,0],[x+2,0,0],[x+2,0,3],[x,0,3]]);
test('group extrusion applies one distance along perpendicular and opposite normals and preserves stickers',()=>{
 const faces=[front('a'),face('b',[[8,1,0],[8,3,0],[8,3,3],[8,1,3]],{feature:{type:'door',preset:2},material:'brick',finishColor:'#123456'}),face('c',[[3,8,0],[1,8,0],[1,8,3],[3,8,3]],{feature:{type:'garage'}})],input={members:faces.map(f=>({face:f,sign:1,supports:[f]})),scene:faces},before=JSON.stringify(input),engine=M.createExtrusions(input);
 for(const distance of [.6096,-.3048,.9]){const r=engine.preview(distance);assert.equal(r.caps.length,3);r.caps.forEach((cap,i)=>{const n=W.normal(faces[i].points);cap.points.forEach((p,j)=>{for(const axis of ['x','y','z'])assert.ok(Math.abs(p[axis]-faces[i].points[j][axis]-n[axis]*distance)<1e-8);});assert.deepEqual(cap.feature,faces[i].feature);assert.equal(cap.finishColor,faces[i].finishColor);});assert.deepEqual(engine.preview(distance),r);}
 assert.equal(JSON.stringify(input),before);assert.throws(()=>engine.preview(NaN),/finite/);assert.equal(engine.preview(0).sides.length,0);
});
test('combined sweeps subtract both cuts from a shared neighbor',()=>{
 const a=face('a',[[2,0,0],[2,4,0],[2,4,3],[2,0,3]]),b=face('b',[[8,0,0],[8,4,0],[8,4,3],[8,0,3]]),floor=face('floor',[[0,0,0],[10,0,0],[10,4,0],[0,4,0]]),r=M.createExtrusions({members:[{face:a,sign:1,supports:[a]},{face:b,sign:-1,supports:[b]}],scene:[a,b,floor]}).preview(1),replacement=r.replacements.find(r=>r.face.id==='floor');
 assert.ok(replacement);assert.ok(Math.abs(replacement.pieces.reduce((s,f)=>s+area(f),0)-32)<1e-7);
});
test('adjacent coplanar faces cancel their internal extrusion returns',()=>{
 const a=front('a'),b=front('b',2),r=M.createExtrusions({members:[{face:a,supports:[a,b]},{face:b,supports:[a,b]}],scene:[a,b]}).preview(1);
 assert.equal(r.caps.length,2);assert.ok(!r.sides.some(f=>f.points.every(p=>Math.abs(p.x-2)<1e-8)),'No internal double face remains');assert.ok(Math.abs(r.sides.reduce((s,f)=>s+area(f),0)-14)<1e-7);
});

test('group extrusion keeps each independent roof bound and retains precise horizontal distance',()=>{
 const a=front('a'),b=front('b',5),roof={faces:[face('roof',[[-1,1,4],[8,1,4],[8,-2,1],[-1,-2,1]])]},members=[a,b].map(face=>({face,supports:[face]})),r=M.createExtrusions({members,scene:[a,b],roof}).preview(.6096);
 for(const cap of r.caps){assert.ok(cap.points.every(p=>Math.abs(p.y+.6096)<1e-8));assert.ok(Math.abs(Math.max(...cap.points.map(p=>p.z))-2.3904)<1e-6);}
});
