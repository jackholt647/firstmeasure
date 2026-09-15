const test = require('node:test');
const assert = require('node:assert/strict');
const root = '../public/measure/internal/editor_scripts/';
const K = require(root + 'exterior_geometry.js');
const M = require(root + 'exterior_model.js');
const S = require(root + 'base_sketch_geometry.js');
const C = require(root + 'wall_chimneys.js');
const rectangle = (x0,y0,x1,y1,z=0) => [{x:x0,y:y0,z},{x:x1,y:y0,z},{x:x1,y:y1,z},{x:x0,y:y1,z}];
const freeze = value => { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };

test('boolean holes retain area without triangle stitching and survive a second union', () => {
  const cut = K.difference({points:rectangle(0,0,10,10)},[{points:rectangle(2,2,8,8)}]);
  assert.equal(cut.length,1);assert.equal(cut[0].holes.length,1);assert.equal(K.area(cut[0]),64);
  K.triangles(cut[0].points,cut[0].holes);
  const restored=K.union([...cut,{points:rectangle(2,2,8,8)}]);
  assert.equal(restored.length,1);assert.equal(restored[0].holes.length,0);assert.equal(K.area(restored[0]),100);
});

test('shared vertices node T junctions while separate step heights remain separate', () => {
  const graph=K.topology([{id:'left',points:rectangle(0,0,2,4)},{id:'right',points:rectangle(2,0,4,2)},{id:'upper',points:rectangle(0,0,2,4,1)}]);
  const seam=graph.vertexAt({x:2,y:2,z:0});assert.ok(seam.faces.has('left'));assert.ok(seam.faces.has('right'));
  assert.notEqual(graph.vertexAt({x:2,y:0,z:0}).id,graph.vertexAt({x:2,y:0,z:1}).id);
});

test('a cut on a lower base cannot weld or repartition the upper base', () => {
  const base={faces:[{id:'lower',points:rectangle(0,0,2,4)},{id:'upper',points:rectangle(2,0,4,4,1)}]};
  S.ensure(base);assert.equal(base.sketch.nodes.length,8);
  const upper=JSON.stringify(base.faces[1]);
  const a=S.add(base,{x:0,y:2,z:0}),b=S.add(base,{x:2,y:2,z:0});S.connect(base,[a,b]);
  assert.equal(base.faces.length,3);assert.equal(JSON.stringify(base.faces.find(f=>f.id==='upper')),upper);
  assert.equal(base.faces.filter(f=>f.points.every(p=>p.z===0)).length,2);
  S.resolve(base);assert.equal(base.faces.length,3);
});

test('failed commands cannot modify their input and invalid geometry is rejected before publication', () => {
  const before=freeze({$surfaces:[{id:'face',points:rectangle(0,0,4,4)}]});
  assert.throws(()=>M.transaction(before,edits=>{edits.$surfaces[0].points[0].z=NaN;},M.validateEdits),/finite|plane/);
  assert.equal(before.$surfaces[0].points[0].z,0);
  assert.throws(()=>M.transaction(before,edits=>{edits.$surfaces.pop();throw Error('cancel');}),/cancel/);
  assert.equal(before.$surfaces.length,1);
});

test('normal and triangulation tolerate collinear leading vertices without NaN or reversed winding', () => {
  const points=[{x:0,y:0,z:0},{x:0,y:0,z:0},{x:2,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}];
  assert.equal(K.normal(points).z,1);K.validateFace({points});
  const concave=[{x:0,y:0,z:0},{x:5,y:0,z:0},{x:5,y:1,z:0},{x:1,y:1,z:0},{x:1,y:5,z:0},{x:0,y:5,z:0}];
  assert.equal(K.normal(concave).z,1);assert.equal(K.normal(concave.slice().reverse()).z,-1);
});

test('chimney drawing is read only on a frozen saved model', () => {
  const outline=rectangle(0,0,10,10),points=rectangle(8,4,12,6,5),roof={points,connections:points.map((p,i)=>({startIdx:i,endIdx:(i+1)%4,type:'chimney_edge'})),faces:[]};
  const state=freeze({roof,chimneys:C.detect(roof),base:{faces:[{id:'base',points:outline}]},wallEdits:{},options:{ground:0}});
  const walls=freeze(outline.map((a,i)=>({id:'wall'+i,bottom:[a,outline[(i+1)%4]],top:[{...a,z:5},{...outline[(i+1)%4],z:5}]})));
  const before=JSON.stringify(state);assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,3);C.compose(walls,state);assert.equal(JSON.stringify(state),before);
});

// A saved sketch edge and its quantized face boundary may differ by a micron.
// That is the starting boundary, not an obstruction immediately ahead of H.
test('axis cuts ignore a coincident legacy edge at the ray origin',()=>{
 const A=require(root+'wall_axis_cuts.js'),face={points:rectangle(0,0,4,4)},start={x:2,y:0,z:0};
 const target=A.targets(face,start,{x:0,y:1},[[{x:0,y:.0000006},{x:4,y:.0000006}]],[],.001);
 assert.equal(target.length,1);assert.deepEqual(target[0],{x:2,y:4,z:0});
});

test('reading an uninitialized base sketch for rendering does not initialize saved state',()=>{
 const base=freeze({faces:[{id:'base',points:rectangle(0,0,4,4)}]});
 assert.equal(S.read(base).nodes.length,4);assert.equal(base.sketch,undefined);assert.ok(base.faces[0].points.every(p=>p.nodeId===undefined));
});

test('arc sweep follows path through major arcs and resets at a complete revolution',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),center={x:0,y:0,z:0},start={x:2,y:0,z:0},n={x:0,y:0,z:1};for(const sign of [1,-1]){const track={};let curve;for(const a of [.5,2,3.5,5,6.4]){curve=K.arcPreview(start,center,{x:2*Math.cos(a*sign),y:2*Math.sin(a*sign),z:0},n,track);if(a===5)assert.ok(Math.abs(curve.sweep-sign*5)<1e-8);}assert.ok(Math.abs(curve.sweep-sign*(6.4-2*Math.PI))<1e-8);}
});

test('curve drawing snaps centers and shared-radius endpoints in the supporting plane',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y,z=0)=>({x,y,z}),center=p(0,0),start=p(2,0),normal=p(0,0,1),screen=p=>({x:p.x*100,y:p.y*100}),snap=args=>K.curveDrawSnap({start,normal,screen,...args});
 const c=snap({point:p(3,1.04)});assert.ok(Math.abs(c.point.x-2-c.point.y)<1e-8);assert.ok(c.alignment);
 const existing=p(1.97,1.06);assert.deepEqual(snap({point:p(2,1.05),points:[existing]}).point,existing);
 const angle=.31,curve={type:'ellipse',center,u:p(Math.cos(angle),Math.sin(angle)),v:p(-Math.sin(angle),Math.cos(angle)),radiusX:3,radiusY:4,sweep:Math.PI/2};
 const opposite=p(-3*Math.cos(angle+.01),-3*Math.sin(angle+.01)),q=snap({center,point:opposite,curves:[curve]}),expected=p(-3*Math.cos(angle),-3*Math.sin(angle));assert.ok(Math.hypot(q.point.x-expected.x,q.point.y-expected.y)<1e-8);assert.equal(q.radius,3);assert.ok(q.alignment);
 assert.deepEqual(snap({center,point:opposite,curves:[curve],snap:false}),{point:opposite});
 const endpoint=p(3,3),oval=K.arcPreview(start,center,endpoint,normal,{},false);assert.ok(Math.abs(oval.u.x*oval.v.x+oval.u.y*oval.v.y)<1e-8);assert.ok(Math.abs(oval.radiusY-Math.hypot(3,3))<1e-8);
});

test('snapping to the start closes a full curve in either sweep direction',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y)=>({x,y,z:0}),start=p(2,0),center=p(0,0),normal={x:0,y:0,z:1};
 for(const sign of [-1,1]){const track={preciseEndpoint:true};for(const a of [1,2,3,4,5])K.arcPreview(start,center,p(2*Math.cos(a),sign*2*Math.sin(a)),normal,track,false);track.close=true;const c=K.arcPreview(start,center,start,normal,track,false);assert.ok(Math.abs(c.sweep-sign*2*Math.PI)<1e-8);assert.ok(Math.hypot(K.curvePoint(c,1).x-2,K.curvePoint(c,1).y)<1e-8);}
});

// Reproduces the oblique-face loop: the pointer is near the starting radius,
// at a different distance. Endpoint fitting used to divide by sin(angle).
test('ellipse preview near either radius axis stays bounded and cannot shear backwards',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y,z=0)=>({x,y,z}),normal=p(0,0,1),center=p(4,4),u=p(Math.SQRT1_2,Math.SQRT1_2),v=p(-u.y,u.x),at=(x,y)=>p(center.x+u.x*x+v.x*y,center.y+u.y*x+v.y*y),start=at(2,0);
 for(const sign of [-1,1])for(const angle of [.00001,.001,.01,.1]){
  const end=at(sign*3*Math.cos(angle),3*Math.sin(angle)),c=K.arcPreview(start,center,end,normal,{},false),samples=K.curveSamples(c);
  assert.ok(Math.abs(c.u.x*c.v.x+c.u.y*c.v.y)<1e-10);
  for(const q of samples){const x=(q.x-center.x)*u.x+(q.y-center.y)*u.y,y=(q.x-center.x)*v.x+(q.y-center.y)*v.y;assert.ok(Math.abs(x)<=2+1e-8);assert.ok(Math.abs(x*x/4+y*y/9-1)<1e-8);}
 }
});
test('45 degree centers produce exact circle radius snaps on a foreshortened face',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y,z=0)=>({x,y,z}),start=p(2,2),normal=p(0,0,1),screen=p=>({x:100*(p.x+.4*p.y),y:30*p.y});
 const cs=K.curveDrawSnap({start,normal,point:p(3.01,3),screen}),center=cs.point,r=Math.hypot(start.x-center.x,start.y-center.y);assert.ok(cs.alignment);
 const point=p(center.x+r*.7075,center.y-r*.7075),snap=K.curveDrawSnap({start,center,normal,point,screen}),c=K.arcPreview(start,center,snap.point,normal,{},false);
 assert.equal(snap.radius,r);assert.ok(Math.abs(c.radiusX-c.radiusY)<1e-8);for(const q of K.curveSamples(c))assert.ok(Math.abs(Math.hypot(q.x-center.x,q.y-center.y)-r)<1e-8);
 const end=K.curvePoint(c,1);assert.ok(Math.hypot(end.x-snap.point.x,end.y-snap.point.y)<1e-8);
});

test('quarter-circle snap uses the starting spoke and beats a nearby shorter point',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y,z=0)=>({x,y,z}),center=p(2,2),normal=p(0,0,1),angle=.27,start=p(2+2*Math.cos(angle),2+2*Math.sin(angle)),at=r=>p(2-r*Math.sin(angle),2+r*Math.cos(angle)),screen=p=>({x:p.x*100,y:p.y*100}),short=at(1.88),q=K.curveDrawSnap({start,center,normal,point:at(1.93),points:[short],screen});
 assert.ok(Math.abs(q.radius-2)<1e-8);assert.deepEqual(q.radiusSource,start);assert.ok(Math.hypot(q.point.x-at(2).x,q.point.y-at(2).y)<1e-8);assert.ok(q.alignment);
 const c=K.arcPreview(start,center,q.point,normal,{},false);assert.ok(Math.abs(c.sweep-Math.PI/2)<1e-8);assert.equal(c.radiusX,c.radiusY);
 const guides=K.curveDrawGuides({start,center,pointer:q.point,snap:q,normal});assert.ok(guides.some(g=>g.role==='radius-source'&&g.points[1]===start));assert.ok(guides.some(g=>g.role==='angle'));const circle=guides.find(g=>g.role==='radius-circle');assert.ok(circle);for(const point of circle.points)assert.ok(Math.abs(Math.hypot(point.x-2,point.y-2)-2)<1e-8);
 const exact=K.curveDrawSnap({start,center,normal,point:short,points:[short],screen});assert.deepEqual(exact.target,short);assert.ok(K.curveDrawGuides({start,center,pointer:exact.point,snap:exact,normal}).some(g=>g.role==='point-target'&&g.points[1]===short));
});
