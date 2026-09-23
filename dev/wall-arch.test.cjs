const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry');
const p=(x,y,z=0)=>({x,y,z}),pair=[p(0,0),p(10,0)],n=p(0,0,1),near=(a,b)=>assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-7);
test('natural spline interpolates controls, remains straight at zero, and preserves mirrored symmetry',()=>{
 const c=K.splineThrough(pair,[p(2,1),p(8,1)],n);near(K.curvePoint(c,.2),p(2,1));near(K.curvePoint(c,.8),p(8,1));near(K.curvePoint(c,0),pair[0]);near(K.curvePoint(c,1),pair[1]);
 for(let t=0;t<=1;t+=.01)assert.ok(Math.abs(K.curvePoint(c,t).y-K.curvePoint(c,1-t).y)<1e-8);
 assert.ok(K.curveSamples(K.splineThrough(pair,[p(4,0)],n)).every(p=>p.y===0));
 const shifted=K.mapCurve(c,p=>({x:2*p.x+3,y:p.y-4,z:p.z+1}));near(K.curvePoint(shifted,.2),p(7,-3,1));
 const samples=K.curveSamples(JSON.parse(JSON.stringify(c)));assert.ok(samples.some(q=>q.curveT===.2));
});
test('off-center interpolation is smooth at every knot and passes through the clicked position',()=>{
 const c=K.splineThrough(pair,[p(7,3),p(3,.8)],n);for(const t of c.knots.slice(1,-1)){const e=1e-6,a=K.curvePoint(c,t-e),b=K.curvePoint(c,t),d=K.curvePoint(c,t+e);assert.ok(Math.abs((b.y-a.y)/e-(d.y-b.y)/e)<.001);}near(K.curvePoint(c,.7),p(7,3));
});
test('snap offers center, mirrored stations/heights, interval midpoints and nearby alignment',()=>{
 const options={normal:n,screen:p=>({x:p.x*100,y:p.y*100}),radius:15};near(K.archSnap(pair,[],p(5.05,1),options).point,p(5,1));
 const mirrored=K.archSnap(pair,[p(2,1)],p(8.04,1.03),options);near(mirrored.point,p(8,1));assert.equal(mirrored.kind,'Symmetric');
 near(K.archSnap(pair,[p(2,1)],p(1.03,2),options).point,p(1,2));
 near(K.archSnap(pair,[],p(6.04,1.97),{...options,points:[p(6,2)]}).point,p(6,2));
 near(K.archSnap(pair,[],p(5.05,1),{...options,snap:false}).point,p(5.05,1));
});
test('one shared curve replaces both sides of a face split and remains available to extrusion',()=>{
 const c={...K.splineThrough([p(0,2),p(4,2)],[p(2,3)],n),id:'arch'},faces=[{id:'low',points:[p(0,0),p(4,0),p(4,2),p(0,2)]},{id:'high',points:[p(0,2),p(4,2),p(4,5),p(0,5)]}];
 const r=K.archFaces(faces,c);assert.deepEqual(r.affected,['low','high']);for(const f of r.faces){K.validateFace(f);assert.ok(f.points.some(p=>p.x===2&&p.y===3));}
 const e=W.extrude(r.faces[0],.5);assert.ok(e.sides.some(f=>f.curvedSurface?.curve.type==='spline'));assert.ok(e.cap.curves?.length);
});

test('surface spline has one line identity and no selectable tessellation anchors',()=>{
 const c={...K.splineThrough([p(0,2),p(4,2)],[p(2,3)],n),id:'arc'},face=K.archFaces([{id:'f',points:[p(0,0),p(4,0),p(4,2),p(0,2)]}],c).faces[0],wire=W.surfaceWire({$surfaces:[face]});
 const curved=wire.edges.filter(e=>e.curve);assert.ok(curved.length>10);assert.equal(new Set(curved.map(e=>e.id)).size,1);assert.equal(wire.nodes.filter(n=>!n.curveSample).length,5);
});
