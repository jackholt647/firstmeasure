const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
const p=(x,y,z=0)=>({x,y,z}),curve={type:'ellipse',center:p(0,0),u:p(1,0),v:p(0,1),radiusX:2,radiusY:1,sweep:Math.PI};
const region=()=>({id:'arc-region',points:K.curveSamples(curve),curves:[curve],material:'brick'});
test('extrusion stores one analytic wall with a resolution-independent render mesh',()=>{
 const result=W.extrude(region(),3),walls=result.sides.filter(f=>f.curvedSurface);assert.equal(walls.length,1);const f=walls[0];assert.equal(f.material,'brick');assert.equal(f.points.length,4);assert.equal(f.curvedSurface.domains.length,1);assert.equal(f.curvedSurface.domains[0].points.length,4);
 const before=JSON.stringify(f),fine=K.surfaceMesh(f,.0002),coarse=K.surfaceMesh(f,.02);assert.ok(fine.triangles.length>coarse.triangles.length);assert.equal(JSON.stringify(f),before);assert.equal(fine.uv.length,fine.positions.length);K.validateFace(f);
 const loaded=JSON.parse(before);assert.deepEqual(K.surfaceMesh(loaded,.02),coarse);const wire=W.surfaceWire({$surfaces:[f]});assert.equal(wire.nodes.filter(p=>!p.curveSample).length,4);assert.equal(new Set(wire.edges.map(e=>e.id)).size,4);
});
test('one logical surface survives material edits, copying, and affine transforms',()=>{
 const f=W.extrude(region(),3).sides.find(f=>f.curvedSurface),clip=W.copyGeometry([f],f.points),moved=W.transformGeometry(clip,0,{scale:{x:1.5,y:2,z:.5},delta:{x:2,y:1}});assert.equal(moved.faces.length,1);assert.equal(moved.faces[0].curvedSurface.logical,true);K.validateFace(moved.faces[0]);
 const saved={$surfaces:[{...f,material:'stucco'}]};M.validateEdits(saved);assert.equal(saved.$surfaces.length,1);assert.equal(saved.$surfaces[0].material,'stucco');
});
test('arc definition stores endpoints and an unconnected center, not tessellation nodes',()=>{
 const base={faces:[{id:'base',points:[p(-4,-4),p(4,-4),p(4,4),p(-4,4)]}]};S.addCurve(base,curve);assert.equal(base.sketch.nodes.length,7);assert.equal(base.sketch.edges.filter(e=>e.curveId).length,1);assert.ok(S.curveEdges(base.sketch).length>10);const edge=base.sketch.edges.find(e=>e.curveId);S.connect(base,[edge.a,edge.b]);assert.ok(base.faces.some(f=>f.curves?.length));
 const loaded=JSON.parse(JSON.stringify(base));S.upgrade(loaded);assert.equal(loaded.sketch.edges.filter(e=>e.curveId).length,1);assert.equal(loaded.sketch.nodes.length,7);S.remove(loaded,[],[loaded.sketch.edges.find(e=>e.curveId).id]);assert.equal(loaded.sketch.edges.filter(e=>e.curveId).length,0);
});
test('legacy fillet facets migrate into a single surface without filling trimmed domains',()=>{
 const c={type:'conic-ruled',start:{type:'conic',start:p(1,0),control:p(0,0),end:p(0,1),weight:Math.SQRT1_2},finish:{type:'conic',start:p(1,0,3),control:p(0,0,3),end:p(0,1,3),weight:Math.SQRT1_2}},parts=[];
 for(let i=0;i<8;i++){const lo=i/8,hi=(i+1)/8;parts.push({id:'old-'+i,points:[[lo,0],[hi,0],[hi,.5],[lo,.5]].map(([u,v])=>K.surfacePoint(c,u,v)),curvedSurface:{...c,range:[lo,hi]},material:'siding'});}
 const fs=K.compactSurfaces(parts);assert.equal(fs.length,1);assert.equal(fs[0].points.length,4);assert.ok(K.surfaceMesh(fs[0]).positions.every(p=>p.z<=1.500001));assert.deepEqual(K.compactSurfaces(fs),fs);
});

test('curved takeoff uses surface area rather than the straight chord',()=>{
 const R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),c={...curve,radiusY:2},face={id:'circle',points:K.curveSamples(c),curves:[c]},f=W.extrude(face,3).sides.find(f=>f.curvedSurface),report=R.build({faces:[f]});assert.equal(report.walls.length,1);assert.ok(Math.abs(report.totals.net*.3048**2-6*Math.PI)<.01);assert.ok(Math.abs(report.walls[0].top*.3048-2*Math.PI)<.01);
});

function roundedCube(map=p=>p){
 const a=p(0,0),b=p(4,0),c=p(4,4),d=p(0,4),e=p(0,0,4),f=p(4,0,4),g=p(4,4,4),h=p(0,4,4),cube=[[a,b,f,e],[b,c,g,f],[c,d,h,g],[d,a,e,h],[a,d,c,b],[e,f,g,h]].map((points,i)=>({id:'cube-'+i,points:points.map(map),material:'brick'}));
 const faces=K.compactSurfaces(W.fillet(cube,{edges:[[map(a),map(e)]]},.4).faces);return {faces,face:faces.find(f=>f.curvedSurface),base:{faces:faces.filter(f=>f.id==='cube-4')}};
}
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
test('extruding a logical fillet sweeps each exact boundary in either direction',()=>{
 const {face}=roundedCube(),before=JSON.stringify(face),sourceCurves=K.surfaceBoundaryCurves(face).flat(2);
 for(const amount of [-.3,.3]){const result=W.extrude(face,amount),n=W.normal(face.points);assert.equal(result.sides.length,4);
  for(let i=0;i<4;i++){const side=result.sides[i];assert.equal(side.curvedSurface.logical,true);for(const u of [0,.25,.5,.75,1]){const a=K.curvePoint(sourceCurves[i],u),b={x:a.x+n.x*amount,y:a.y+n.y*amount,z:a.z+n.z*amount};assert.ok(distance(K.surfacePoint(side.curvedSurface,u,0),a)<1e-6);assert.ok(distance(K.surfacePoint(side.curvedSurface,u,1),b)<1e-6);}K.validateFace(side);}
  assert.equal(result.cap.points.length,4);assert.equal(result.cap.curvedSurface.logical,true);K.validateFace(result.cap);
 }assert.equal(JSON.stringify(face),before);
});
test('fillet extrusion updates a differently sampled base boundary and keeps the cap joined',()=>{
 const {face,faces,base}=roundedCube(),before=JSON.stringify({face,faces,base}),area=base.faces.reduce((s,f)=>s+K.area(f),0),engine=M.createExtrusion({face,scene:faces.filter(f=>f.id!=='cube-4'),base});
 for(const amount of [-.3,.3]){const r=engine.preview(amount);assert.ok(Math.abs(r.base.faces.reduce((s,f)=>s+K.area(f),0)-area)>.01);assert.equal(r.sides.length,2);assert.equal(r.replacements.length,1);assert.equal(r.replacements[0].face.id,'cube-5');
  assert.ok(r.base.faces.some(f=>f.curves?.length));const bottom=K.surfaceBoundaryCurves(r.cap).flat(2).find(c=>K.curveSamples(c).every(p=>Math.abs(p.z)<1e-6));assert.ok(bottom);
  for(const t of [.25,.5,.75]){const q=K.curvePoint(bottom,t);assert.ok(r.base.faces.some(f=>K.area(K.intersection([f],[{points:[p(q.x-.001,q.y-.001),p(q.x+.001,q.y-.001),p(q.x+.001,q.y+.001),p(q.x-.001,q.y+.001)]}])[0]||{points:[]})>0));}
 }assert.equal(JSON.stringify({face,faces,base}),before);
});
test('curved extrusion keeps its analytic lower boundary on a sloping foundation',()=>{
 const {face,faces,base}=roundedCube(p=>({...p,z:p.z+.1*p.x+.2*p.y}));for(const amount of [-.2,.2]){const r=M.createExtrusion({face,scene:faces.filter(f=>f.id!=='cube-4'),base}).preview(amount);const lower=K.surfaceBoundaryCurves(r.cap).flat(2).find(c=>K.curveSamples(c).every(p=>Math.abs(p.z-.1*p.x-.2*p.y)<.00001));assert.ok(lower);M.validateResult(r);}
});
test('roof clipping a curved extrusion preserves its surface domain and finite mesh',()=>{
 const {face,faces}=roundedCube(),roof={faces:[{id:'roof',points:[p(-2,-2,4.3),p(6,-2,2.7),p(6,6,2.7),p(-2,6,4.3)]}]};
 for(const amount of [-.3,.3]){const r=M.createExtrusion({face,scene:faces,roof}).preview(amount);assert.ok(r.cap.curvedSurface.logical);for(const p of K.surfaceMesh(r.cap).positions)assert.ok(p.z<=3.9-.2*p.x+.002);M.validateResult(r);assert.ok(r.sides.every(f=>!f.curvedSurface||f.curvedSurface.logical));}
});


test('outward extrusion starting on a sloping roof has four controls instead of triangle-crossing points',()=>{
 const {face,faces}=roundedCube(p=>({...p,z:p.z===4?4+.4*p.x+.3*p.y:p.z})),roof={faces:[{points:[p(-2,-2,2.6),p(6,-2,5.8),p(6,6,8.2),p(-2,6,5)]}]};
 const r=M.createExtrusion({face,scene:faces.filter(f=>f.id!=='cube-5'),roof}).preview(-.7),cap=r.cap;assert.equal(cap.points.length,4);assert.equal(K.surfaceMesh(cap).boundaries.length,4);const wire=W.surfaceWire({$surfaces:[cap]});assert.equal(wire.nodes.filter(p=>!p.curveSample).length,4);assert.equal(new Set(wire.edges.map(e=>e.id)).size,4);
 assert.ok(cap.curvedSurface.domains[0].points.length>10);for(const f of [cap,...r.sides])for(const q of f.curvedSurface?K.surfaceMesh(f).positions:f.points)assert.ok(q.z<=4+.4*q.x+.3*q.y+.002);
 const saved=JSON.parse(JSON.stringify(cap));assert.deepEqual(K.surfaceMesh(saved),K.surfaceMesh(cap));const sweep=W.extrude(saved,-.1);assert.equal(sweep.sides.length,4);assert.ok(sweep.sides.every(f=>f.curvedSurface.logical));
});

test('partially roof-clipped curved returns retain the complete curve range and area',()=>{
 const arc={...curve,radiusX:2,radiusY:2,sweep:Math.PI/2},face=W.extrude({id:'arc',points:[...K.curveSamples(arc),p(0,0)],curves:[arc]},4).sides.find(f=>f.curvedSurface),roof={faces:[{points:[p(-3,-3,5),p(6,-3,3.2),p(6,6,3.2),p(-3,6,5)]}]},amount=.7;
 const shape=W.extrude(face,amount,{facets:true}),tops=shape.sides.filter(f=>f.points.every(p=>Math.abs(p.z-4)<1e-6));
 const clipped=ring=>{const out=[],height=p=>4.4-.2*p.x-p.z;for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],da=height(a),db=height(b);if(da>=0)out.push(a);if((da>=0)!==(db>=0)){const t=da/(da-db);out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:4});}}return out;};
 const expected=tops.reduce((sum,f)=>sum+K.area({points:clipped(f.points)}),0),result=M.createExtrusion({face,supports:[K.surfaceOutline(face)],roof}).preview(amount),returns=result.sides.filter(f=>K.surfaceMesh(f).positions.every(p=>Math.abs(p.z-4)<1e-5)),actual=returns.reduce((sum,f)=>sum+K.surfaceArea(f),0);assert.ok(expected>.01);assert.ok(Math.abs(actual-expected)<.003,JSON.stringify({actual,expected}));
});


test('real house fillet crosses its finite eave without upright curtains or restored height',()=>{
 const input=require('./fixtures/curved-wall-eave.json'),before=JSON.stringify(input),engine=M.createExtrusion(input),height=(cap,u)=>{const values=[];for(const d of cap.curvedSurface.domains)for(let i=0;i<d.points.length;i++){const a=d.points[i],b=d.points[(i+1)%d.points.length];if(u>=Math.min(a.x,b.x)&&u<=Math.max(a.x,b.x)&&Math.abs(b.x-a.x)>1e-10)values.push(a.y+(b.y-a.y)*(u-a.x)/(b.x-a.x));}return K.surfacePoint(cap.curvedSurface,u,Math.max(...values)).z;};
 let previous=[Infinity,Infinity,Infinity];for(const amount of [.1,.3,.5,.7,1,1.25]){const result=engine.preview(-amount);assert.ok(result.sides.every(f=>f.curvedSurface),`upright eave curtain at ${amount}`);const heights=[.1,.5,.9].map(u=>height(result.cap,u));heights.forEach((z,i)=>assert.ok(z<=previous[i]+.002,`height restored outside eave at ${amount}`));previous=heights;assert.ok(result.cap.points.length<=6);M.validateResult(result);}
 const r=engine.preview(-1);assert.ok(r.cap.points.length<=6);assert.equal(K.surfaceMesh(r.cap).boundaries.length,r.cap.points.length);assert.equal(W.surfaceWire({$surfaces:[r.cap]}).nodes.filter(p=>!p.curveSample).length,r.cap.points.length);assert.equal(JSON.stringify(input),before);
});


test('saved failing outward extrusion removes all three eave curtains',()=>{
 const input=require('./fixtures/saved-curved-wall-eave.json'),before=JSON.stringify(input),r=M.createExtrusion(input).preview(input.amount);assert.equal(r.sides.length,2);assert.ok(r.sides.every(f=>f.curvedSurface?.logical));assert.ok(r.cap.points.length<=6);assert.ok(K.surfaceMesh(r.cap).positions.every(K.finite3));const top=K.surfaceMesh(r.cap).positions.filter(p=>p.z>160);assert.ok(top.length>10);assert.ok(Math.max(...top.map(p=>p.z))<Math.max(...input.face.points.map(p=>p.z))-.01);assert.equal(JSON.stringify(input),before);M.validateResult(r);
});

test('quadric render mesh covers full corners and still respects trimmed parameter domains',()=>{
 const surface={type:'quadric-corner',origin:p(0,0,0),shoulders:[p(2,0,0),p(0,2,0),p(0,0,2)],logical:true,domains:[{points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],holes:[]}]};
 const face={id:'corner',points:surface.shoulders,curvedSurface:surface},mesh=K.surfaceMesh(face),trimmed={...face,curvedSurface:{...surface,domains:[{points:[{x:0,y:0},{x:.5,y:0},{x:0,y:.5}],holes:[]}]}};
 const area=m=>m.triangles.reduce((sum,t)=>{const [a,b,c]=t.map(i=>m.uv[i]);return sum+Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;},0),partial=K.surfaceMesh(trimmed);
 assert.ok(Math.abs(area(mesh)-.5)<1e-6);assert.ok(Math.abs(area(partial)-.125)<1e-6);assert.ok(partial.uv.every(p=>p.x+p.y<=.500001));
 for(const m of [mesh,partial])for(const q of m.positions)assert.ok(Math.abs((q.x/2-1)**2+(q.y/2-1)**2+(q.z/2-1)**2-2)<1e-6);
});

test('closed circle reuses its starting node and stores its center without spokes',()=>{
 const base={faces:[{id:'b',points:[p(0,0),p(10,0),p(10,10),p(0,10)]}]},curve={type:'ellipse',center:p(5,5),u:p(1,0),v:p(0,1),radiusX:2,radiusY:2,sweep:2*Math.PI};
 S.addCurve(base,curve);const edge=base.sketch.edges.find(e=>e.curveId),center=base.sketch.nodes.find(n=>n.id===base.sketch.curves[0].centerId);
 assert.equal(edge.a,edge.b);assert.ok(center.curveCenter);assert.ok(base.sketch.edges.every(e=>e.a!==center.id&&e.b!==center.id));assert.equal(base.faces.length,2);
 const loaded=JSON.parse(JSON.stringify(base));S.upgrade(loaded);assert.equal(loaded.sketch.curves[0].centerId,center.id);assert.ok(loaded.sketch.nodes.some(n=>n.id===center.id));
});
