const test=require('node:test'),assert=require('node:assert/strict'),F=require('../public/measure/internal/editor_scripts/wall_features.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const points=[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:2},{x:0,y:0,z:2}];
const area=faces=>faces.reduce((n,f)=>{const fr=W.faceFrame(f);return n+K.area({points:f.points.map(p=>W.inFrame(fr,p))});},0);
test('two inch window trim forms an outside ring; door trim has no threshold',()=>{
 const width=.0508,window=F.trimFaces(points,F.setTrim({type:'window'},2)),door=F.trimFaces(points,F.setTrim({type:'door'},2));assert.equal(window.length,4);assert.equal(door.length,3);assert.ok(Math.abs(area(window)-((1+2*width)*(2+2*width)-2))<1e-8);assert.ok(Math.abs(area(door)-((1+2*width)*(2+width)-2))<1e-8);assert.ok(door.flatMap(f=>f.points).every(p=>p.z>=0));
});
test('trim remains attached through copy, rotate, flip, and size changes',()=>{
 const face={id:'a',points,feature:F.setTrim({type:'window',axis:{x:1,y:0,z:0}},4,'#abcdef')},clip=W.copyGeometry([face],points),moved=W.transformGeometry(clip,0,{angle:Math.PI/4});assert.equal(moved.faces[0].feature.trim.width,.1016);assert.equal(F.trimFaces(moved.faces[0].points,moved.faces[0].feature).length,4);assert.ok(F.trimFaces(points,face.feature).every(f=>f.finishColor==='#abcdef'));assert.equal(F.trimFaces(points,F.setTrim(face.feature,0)).length,0);
});
test('report snapshots retain explicit opening trim geometry and color',()=>{
 const R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),p=(x,z)=>({x,y:0,z}),wall={points:[p(-1,-1),p(3,-1),p(3,4),p(-1,4)]},opening={points,feature:F.setTrim({type:'window'},2,'#123456')};const model=R.build({faces:[wall,opening]});assert.equal(model.openings.length,1);assert.equal(model.openings[0].trim.width,.0508);assert.equal(model.openings[0].trimFaces.length,4);assert.ok(model.openings[0].trimFaces.every(f=>f.finishColor==='#123456'));
});

test('six inch recessed garage trim stays on the door plane, square to returns, without a threshold',()=>{
 const offset=.1524,angle=.31,u={x:Math.cos(angle),y:Math.sin(angle),z:0},n={x:-u.y,y:u.x,z:0},p=(x,z)=>({x:x*u.x+offset*n.x,y:x*u.y+offset*n.y,z}),ps=[p(0,0),p(16*F.FT,0),p(16*F.FT,7*F.FT),p(0,7*F.FT)],before=JSON.stringify(ps),feature=F.setTrim({type:'garage',axis:u},4),trim=F.trimFaces(ps,feature);
 assert.equal(trim.length,3);assert.equal(JSON.stringify(ps),before);assert.ok(trim.flatMap(f=>f.points).every(p=>Math.abs(p.x*n.x+p.y*n.y-offset)<1e-8&&p.z>=-1e-8),'trim keeps the six inch recess and has no bottom strip');for(const f of trim)assert.ok(Math.abs(W.normal(f.points).x*n.x+W.normal(f.points).y*n.y)>1-1e-8,'trim is square to recess returns');assert.equal(F.trimFaces(ps,F.setTrim(feature,0)).length,0);
});
