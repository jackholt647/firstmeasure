const test=require('node:test'),assert=require('node:assert/strict'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
const base=()=>({faces:[{id:'base',points:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}]}]});
test('wall boundaries stay fixed while user dividers create and merge faces',()=>{
 const b=base(),s=S.ensure(b);assert.ok(s.nodes.every(n=>n.fixed));assert.ok(s.edges.every(e=>e.fixed));
 const a=S.add(b,{x:5,y:0,z:0}),c=S.add(b,{x:5,y:10,z:0});S.connect(b,[a,c]);assert.equal(b.faces.length,2);
 const divider=s.edges.find(e=>!e.fixed);S.remove(b,[],[divider.id]);assert.equal(b.faces.length,1);
 S.remove(b,s.nodes.filter(n=>n.fixed).map(n=>n.id),s.edges.filter(e=>e.fixed).map(e=>e.id));
 assert.equal(s.edges.filter(e=>e.fixed).length,4);assert.equal(s.nodes.filter(n=>n.fixed).length,4);
});
test('standalone points and partial connections persist without removing the base',()=>{
 const b=base(),a=S.add(b,{x:3,y:3,z:0}),c=S.add(b,{x:7,y:7,z:0});
 S.connect(b,[a,c]);assert.equal(b.faces.length,1);
 const saved=JSON.parse(JSON.stringify(b));assert.equal(saved.sketch.nodes.filter(n=>!n.fixed).length,2);
 S.move(saved,[a],{x:1});assert.equal(saved.sketch.nodes.find(n=>n.id===a).x,4);
 S.remove(saved,[a],[]);assert.equal(saved.faces.length,1);assert.ok(!saved.sketch.edges.some(e=>e.a===a||e.b===a));
});
test('multi-segment connection divides the base and moving a bend rebuilds both faces',()=>{
 const b=base(),a=S.add(b,{x:5,y:0,z:0}),m=S.add(b,{x:4,y:5,z:0}),c=S.add(b,{x:5,y:10,z:0});
 S.connect(b,[a,m,c]);assert.equal(b.faces.length,2);S.move(b,[m],{x:2});
 assert.equal(b.faces.length,2);assert.ok(b.faces.every(f=>f.points.some(p=>p.x===6&&p.y===5)));
});
test('fixed points cannot move and invalid connections are rejected',()=>{
 const b=base(),s=S.ensure(b),before=JSON.stringify(s.nodes);
 S.move(b,s.nodes.map(n=>n.id),{x:2,y:2,z:2});assert.equal(JSON.stringify(s.nodes),before);
 assert.throws(()=>S.add(b,{x:NaN,y:0,z:0}),/finite/);
});
test('crossing user lines resolve four faces',()=>{
 const b=base(),a=S.add(b,{x:5,y:0,z:0}),c=S.add(b,{x:5,y:10,z:0}),d=S.add(b,{x:0,y:5,z:0}),e=S.add(b,{x:10,y:5,z:0});
 S.connect(b,[a,c]);S.connect(b,[d,e]);assert.equal(b.faces.length,4);
});

test('rebind does not resurrect an editable old face boundary inside the new base',()=>{
 const before={faces:[{id:'left',points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:4,z:0},{x:0,y:4,z:0}]},{id:'right',points:[{x:2,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:2,y:4,z:0}]}]};S.ensure(before);const after={faces:[{id:'merged',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]};S.rebind(before,after);const nodes=new Map(after.sketch.nodes.map(n=>[n.id,n]));assert.ok(!after.sketch.edges.some(e=>nodes.get(e.a).x===2&&nodes.get(e.b).x===2));
});

test('analytic arc persists through closed-region creation and extrusion',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),b=base(),curve={type:'ellipse',center:{x:5,y:5,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:2,radiusY:2,sweep:Math.PI};const end=S.addCurve(b,curve),start=b.sketch.nodes.find(p=>Math.hypot(p.x-7,p.y-5)<1e-5);S.connect(b,[end,start.id]);const region=b.faces.find(f=>f.curves?.length&&f.points.length>10&&Math.max(...f.points.map(p=>p.x))<8);assert.ok(region);assert.equal(b.sketch.curves.length,1);assert.equal(region.curves[0].radiusX,2);const result=W.extrude(region,3);assert.equal(result.sides.filter(f=>f.curvedSurface?.logical).length,1);assert.equal(result.cap.curves[0].center.z,3);const loaded=JSON.parse(JSON.stringify(b));assert.equal(loaded.sketch.curves[0].sweep,Math.PI);
});

test('reload upgrade preserves an open analytic curve and its sampled edge links',()=>{
 const b=base(),curve={type:'ellipse',center:{x:5,y:5,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:2,radiusY:1,sweep:2};S.addCurve(b,curve);const loaded=JSON.parse(JSON.stringify(b));S.upgrade(loaded);assert.equal(loaded.sketch.curves.length,1);assert.ok(loaded.sketch.edges.some(e=>e.curveId===loaded.sketch.curves[0].id));
});


test('intentional points on an arc survive rebinding and remain connected at a wall boundary',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),b=base(),curve={type:'ellipse',center:{x:5,y:5,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:3,radiusY:3,sweep:Math.PI};
 S.addCurve(b,curve);S.rebind(b,b);const id=S.add(b,K.curvePoint(curve,.5),.0001);S.resolve(b);S.rebind(b,b);
 assert.ok(b.sketch.nodes.some(n=>n.id===id),'placed midpoint must survive curve compaction');
 const wall=S.add(b,{x:5,y:10,z:0});S.connect(b,[id,wall]);S.rebind(b,b);
 assert.ok(b.sketch.edges.some(e=>!e.curveId&&[e.a,e.b].includes(id)),'line must remain attached to the intentional curve point');
 assert.equal(b.sketch.edges.filter(e=>e.curveId&&[e.a,e.b].includes(id)).length,2);
 const center=b.sketch.curves[0].centerId;assert.ok(b.sketch.nodes.some(n=>n.id===center&&n.curveCenter));
});

test('dividing a sticker retains its type and orientation with custom child dimensions',()=>{
 for(const type of ['window','door','garage']){const b=base();b.origin={x:0,y:0,z:0};b.u={x:1,y:0};b.faces[0].feature={type,preset:0,shape:'rectangle',axis:{x:1,y:0,z:0}};
 S.ensure(b);const a=S.add(b,{x:5,y:0,z:0}),c=S.add(b,{x:5,y:10,z:0});S.connect(b,[a,c]);assert.equal(b.faces.length,2);
 for(const f of b.faces){assert.equal(f.feature.type,type);assert.equal(f.feature.preset,null);assert.deepEqual(f.feature.axis,{x:1,y:0,z:0});assert.equal(Math.max(...f.points.map(p=>p.x))-Math.min(...f.points.map(p=>p.x)),5);}
 S.resolve(b);assert.ok(b.faces.every(f=>f.feature.type===type));}
});


test('exterior connections survive commit, reload and movement without filling open wires',()=>{
 const b=base(),a=S.add(b,{x:5,y:5,z:0}),c=S.add(b,{x:15,y:5,z:0});
 S.connect(b,[a,c]);S.rebind(b,b);
 const loaded=JSON.parse(JSON.stringify(b));S.move(loaded,[c],{x:3});S.rebind(loaded,loaded);
 assert.equal(loaded.faces.length,1);
 assert.ok(loaded.sketch.nodes.some(n=>n.id===c&&n.x===18));
 assert.ok(loaded.sketch.edges.some(e=>e.userConnection&&[e.a,e.b].includes(c)));
});

test('connections bridge concave outlines and retain the closed exterior region',()=>{
 for(const local of [false,true]){
 const b={faces:[{id:'concave',points:[[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]].map(([x,y])=>({x,y,z:0}))}]};
 if(local)b.origin={x:0,y:0,z:0};
 const a=S.add(b,{x:10,y:3,z:0}),c=S.add(b,{x:3,y:10,z:0});S.connect(b,[a,c]);
 assert.equal(b.faces.length,2);S.rebind(b,b);S.resolve(b);assert.equal(b.faces.length,2);
 }
});

test('base follows moved wall bottoms beyond its old outline and keeps exterior connections attached',()=>{
 const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),b=base();
 const a=S.add(b,{x:10,y:0,z:0}),c=S.add(b,{x:15,y:-3,z:0});S.connect(b,[a,c]);S.rebind(b,b);
 const before=[{id:'wall',targetId:'ground',bottom:[{x:10,y:0,z:0},{x:10,y:10,z:0}]}];
 const after=[{...before[0],bottom:[{x:12,y:0,z:0},{x:12,y:10,z:0}]}];
 const result=B.followWalls(b,before,after);
 assert.equal(Math.max(...result.faces.flatMap(f=>f.points.map(p=>p.x))),12);
 const n=result.sketch.nodes.find(n=>n.id===a);assert.equal(n.x,12);
 assert.ok(result.sketch.edges.some(e=>e.userConnection&&[e.a,e.b].includes(a)));
 assert.ok(result.sketch.nodes.some(n=>n.id===c&&n.x===15));
});


test('analytic curves cross the base boundary and survive rebinding without clipping',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),b=base();
 const c={type:'ellipse',center:{x:10,y:5,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:3,radiusY:2,sweep:Math.PI};
 S.addCurve(b,c);S.rebind(b,b);const saved=JSON.parse(JSON.stringify(b));S.rebind(saved,saved);
 assert.equal(saved.sketch.curves.length,1);const curve=saved.sketch.curves[0];assert.equal(curve.sweep,Math.PI);
 const segments=S.curveEdges(saved.sketch).filter(e=>e.curveId);assert.ok(segments.some(e=>e.start.x>12.9));assert.ok(segments.some(e=>e.end.x<7.1));
});

test('planar editing nodes crossings, deduplicates overlaps and keeps stable graph IDs',()=>{
 const b=base();b.origin={x:0,y:0,z:0};S.ensure(b);
 const p=(x,y)=>S.add(b,{x,y,z:0}),a=p(3,0),c=p(3,12),left=p(0,5),right=p(10,5);S.connect(b,[a,c]);S.connect(b,[left,right]);
 const extra=p(8,11);S.nodeLines(b);const s=b.sketch;
 const cross=s.nodes.find(n=>n.x===3&&n.y===5),upper=s.nodes.find(n=>n.x===3&&n.y===10);
 assert.ok(cross&&upper);assert.equal(s.edges.filter(e=>[e.a,e.b].includes(cross.id)).length,4);assert.equal(s.edges.filter(e=>[e.a,e.b].includes(upper.id)).length,4);
 assert.ok(s.nodes.some(n=>n.id===extra&&n.userDraftPoint));
 const before=JSON.stringify(s);S.nodeLines(b);assert.equal(JSON.stringify(s),before);
 const pair=e=>[e.a,e.b].sort().join('|');assert.equal(new Set(s.edges.map(pair)).size,s.edges.length);
});

test('rounded spline boundaries restore analytic sketch edges at creation and reload',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry'),p=(x,y)=>({x,y,z:0}),curve={...K.splineThrough([p(0,3),p(2,3)],[p(1,4)],p(0,0)),id:'arch'},face=K.archFaces([{id:'panel',points:[p(0,0),p(2,0),p(2,3),p(0,3)],holes:[]}],curve).faces[0];
 face.points=face.points.map(p=>({x:Math.round(p.x*1e6)/1e6,y:Math.round(p.y*1e6)/1e6,z:0}));const base={faces:[face]},sketch=S.ensure(base);assert.equal(sketch.curves.length,1);assert.equal(sketch.nodes.length,5);assert.equal(sketch.edges.filter(e=>e.curveId).length,2);assert.ok(sketch.nodes.some(n=>Math.abs(n.y-4)<1e-6));
 const loaded=JSON.parse(JSON.stringify(base));delete loaded.sketch;const rebuilt=S.ensure(loaded);assert.equal(rebuilt.nodes.length,5);assert.equal(rebuilt.curves[0].controls.length,3);assert.equal(rebuilt.edges.filter(e=>e.curveId).length,2);
 const corrupt={nodes:rebuilt.nodes,edges:[{...rebuilt.edges.find(e=>e.curveId),curveId:'missing'}],curves:[]};assert.throws(()=>S.curveEdges(corrupt),/analytic definition/);
});
