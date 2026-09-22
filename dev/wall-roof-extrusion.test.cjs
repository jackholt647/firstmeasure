const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
const p=(x,y,z)=>({x,y,z}),near=(a,b)=>Math.abs(a-b)<K.CONTACT;
const wall=(bottom=0,top=3)=>({id:'wall',material:'brick',points:[p(0,0,bottom),p(4,0,bottom),p(4,0,top),p(0,0,top)]});
const roof=(height=3,end=-2)=>({faces:[{points:[p(-1,1,height+1),p(5,1,height+1),p(5,end,height+end),p(-1,end,height+end)]}]});
function sweep(face,d,r){const before=JSON.stringify({face,r}),out=M.createExtrusion({face,roof:r,scene:[],supports:[face]}).preview(d);assert.equal(JSON.stringify({face,r}),before);for(const f of [out.cap,...out.sides].filter(f=>!f.deleted))K.validateFace(f);return out;}
function area(f){const frame=K.frame(f);return K.area({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))});}
test('outward wall extrusion follows a descending roof, leaves lower points fixed, and reaches the finite edge',()=>{
 for(const distance of [.1,1,2]){const r=sweep(wall(),distance,roof());assert.ok(r.cap.points.filter(p=>near(p.z,0)).length===2);assert.ok(r.cap.points.every(p=>p.z<=3-distance+K.CONTACT));assert.ok(r.cap.points.every(p=>near(p.y,-distance)));assert.ok(!r.sides.some(f=>f.points.every(p=>near(p.z,3+p.y))));}
});
test('moving toward a higher roof stays at the original height and an unrelated roof does not constrain the sweep',()=>{
 const r=sweep(wall(),-.5,roof());assert.ok(r.cap.points.every(p=>near(p.z,0)||near(p.z,3)));assert.ok(!r.sides.some(f=>f.roofContact));
 const away=roof();away.faces[0].points.forEach(p=>p.x+=20);const u=sweep(wall(),1,away);assert.equal(Math.max(...u.cap.points.map(p=>p.z)),3);
});
test('first contact midway creates a level segment followed by a roof segment and shared bend points',()=>{
 const r=sweep(wall(),2,roof(4,-3));assert.equal(Math.max(...r.cap.points.map(p=>p.z)),2);
 for(const x of [0,4]){const side=r.sides.find(f=>f.points.every(p=>near(p.x,x)));assert.ok(side.points.some(p=>near(p.y,-1)&&near(p.z,3)));assert.equal(side.points.length,5);}
 assert.ok(!r.sides.some(f=>f.roofContact));const level=r.sides.find(f=>f.points.every(p=>near(p.z,3)));assert.ok(level);assert.ok(near(area(level),4));
});
test('a thin strip may taper completely into the roof without a phantom cap or collapse error',()=>{
 const r=sweep(wall(2,3),1,roof(3,-1));assert.equal(r.cap.deleted,true);assert.ok(!r.sides.some(f=>f.roofContact));assert.ok(r.sides.every(f=>f.points.every(p=>p.z<=3+p.y+K.CONTACT)));assert.ok(r.sides.every(f=>area(f)>1e-8));
});
test('a roof ridge across the moving face adds a cap corner and preserves the original opening',()=>{
 const face=wall(0,4);face.holes=[[p(1,0,.2),p(2,0,.2),p(2,0,1),p(1,0,1)]];
 const r=sweep(face,1,{faces:[{points:[p(0,0,3),p(2,0,4),p(2,-2,2),p(0,-2,1)]},{points:[p(2,0,4),p(4,0,3),p(4,-2,1),p(2,-2,2)]}]});
 assert.ok(r.cap.points.some(p=>near(p.x,2)&&near(p.z,3)));assert.equal(r.cap.holes.length,1);assert.ok(near(area({points:r.cap.holes[0]}),.8));assert.equal(r.sides.filter(f=>f.roofContact).length,0);
});
test('roof fitting retains valid anchors on the lowered cap',()=>{
 const face=wall();face.retainedPoints=[p(2,0,3),p(2,0,1)];const r=sweep(face,1,roof());assert.ok(r.cap.retainedPoints.some(p=>near(p.x,2)&&near(p.z,2)));assert.ok(r.cap.retainedPoints.some(p=>near(p.x,2)&&near(p.z,1)));
});
test('a roof-mounted structure already above a roof is not deleted by that roof',()=>{
 const face=wall(5,6),r=sweep(face,1,roof());assert.ok(!r.cap.deleted);assert.ok(r.cap.points.every(p=>near(p.z,5)||near(p.z,6)));
});
test('roof valleys may split a cap into multiple editable pieces without losing either piece',()=>{
 const face=wall(2,4),r=sweep(face,1,{faces:[{points:[p(0,0,4),p(2,0,2),p(2,-2,0),p(0,-2,2)]},{points:[p(2,0,2),p(4,0,4),p(4,-2,2),p(2,-2,0)]}]});
 const caps=[r.cap,...r.sides].filter(f=>!f.deleted&&f.points.every(p=>near(p.y,-1)));assert.equal(caps.length,2);assert.ok(near(caps.reduce((s,f)=>s+area(f),0),1));
});

test('coplanar roof coverage removes only covered return area and preserves roof holes',()=>{
 const face=wall(),flat={points:[p(0,0,3),p(2,0,3),p(2,-2,3),p(0,-2,3)]},r=sweep(face,1,{faces:[flat]});
 const tops=r.sides.filter(f=>f.points.every(p=>near(p.z,3)));assert.ok(near(tops.reduce((s,f)=>s+area(f),0),2));assert.ok(tops.every(f=>f.points.every(p=>p.x>=2-K.CONTACT)));
 const full={points:[p(0,0,3),p(4,0,3),p(4,-2,3),p(0,-2,3)],holes:[[p(1,-.2,3),p(2,-.2,3),p(2,-.8,3),p(1,-.8,3)]]},u=sweep(face,1,{faces:[full]});
 const exposed=u.sides.filter(f=>f.points.every(p=>near(p.z,3)));assert.equal(exposed.length,1);assert.ok(near(area(exposed[0]),.6));
 const deleted=sweep(face,1,{faces:[{...full,deleted:true}]});assert.ok(near(deleted.sides.filter(f=>f.points.every(p=>near(p.z,3))).reduce((s,f)=>s+area(f),0),4));
});


test('roof-covered returns are removed even when a different roof section clips the sweep',()=>{
 const r=sweep(wall(0,4),1,{faces:[{points:[p(0,0,4),p(2,0,4),p(2,-2,2),p(0,-2,2)]},{points:[p(2,0,4),p(4,0,4),p(4,-2,4),p(2,-2,4)]}]});
 assert.ok(!r.sides.some(f=>f.points.every(p=>near(p.z,4))));assert.ok(r.cap.points.some(p=>near(p.z,3)));
});


test('after roof contact an extrusion stays constrained past the finite eave',()=>{
 const r=sweep(wall(),2,roof(3,-.5));assert.ok(r.cap.points.every(p=>p.z<=2.5+K.CONTACT));assert.ok(!r.sides.some(f=>f.points.every(p=>near(p.y,-.5))));
});

test('saved inner roof corner reaches measured eave elevations without an artificial trim gap',()=>{
 const fixture=require('./fixtures/roof-inner-corner.json');for(const face of fixture.walls){const out=sweep(face,.4572,fixture.roof),edge=fixture.roof.connections.map(c=>[fixture.roof.points[c.startIdx],fixture.roof.points[c.endIdx]]).find(([a,b])=>out.cap.points.filter(p=>p.z>162).filter(p=>Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))/Math.hypot(b.x-a.x,b.y-a.y)<.00001).length>=2&&Math.abs(a.z-164.49600219726562)<.00001);assert.ok(edge);const [a,b]=edge;for(const p of out.cap.points.filter(p=>p.z>162&&require('../public/measure/internal/editor_scripts/wall_geometry').onEdge(p,a,b,.00001)))assert.ok(Math.abs(p.z-a.z)<.00001,'wall reaches measured eave exactly');}
});

for(const sideDistance of [.5,.501,.6])for(const angle of [0,.71])test(`side then front extrusion keeps the entire roof contact (${sideDistance}, rotation ${angle})`,()=>{
 const rotate=p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z}),unrotate=p=>rotateBack(p),rotateBack=p=>({x:p.x*Math.cos(angle)+p.y*Math.sin(angle),y:-p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z});
 const r={faces:[{points:[p(0,1,4),p(4,1,4),p(4,-2,1),p(0,-2,1)].map(rotate)}]},front={id:'front',points:[p(.5,0,0),p(3,0,0),p(3,0,3),p(.5,0,3)].map(rotate)},left={id:'left',points:[p(.5,1,0),p(.5,0,0),p(.5,0,3),p(.5,1,4)].map(rotate)},before=JSON.stringify({r,front,left});
 const first=M.createExtrusion({face:left,scene:[front],roof:r}).preview(sideDistance),next=first.replacements.find(r=>r.face.id===front.id).pieces[0];
 const engine=M.createExtrusion({face:JSON.parse(JSON.stringify(next)),scene:[first.cap,...first.sides],roof:r});
 for(const distance of [.2,.5,.8]){
  const result=engine.preview(distance),faces=[result.cap,...result.sides,...result.replacements.flatMap(r=>r.pieces)];
  for(const f of faces){K.validateFace(f);for(const point of [...f.points,...(f.retainedPoints||[])].map(unrotate))assert.ok(point.z<=3+point.y+K.CONTACT,'all shared boundary anchors follow the roof');}
  const top=result.cap.points.filter(p=>p.z>1);assert.ok(top.every(p=>near(p.z,3-distance)),'no upright sliver at the previously moved side');
 }
 assert.equal(JSON.stringify({r,front,left}),before,'preview/cancellation does not mutate its inputs');
});
