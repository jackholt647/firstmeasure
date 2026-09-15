const test=require('node:test'),assert=require('node:assert/strict'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),T=require('../public/measure/internal/editor_scripts/ground_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),square={id:'base-1',points:[p(0,0),p(10,0),p(10,10),p(0,10)]};
test('split creates independent polygons and moving one section changes only its wall bottoms',()=>{
 const pieces=B.split(square,[p(5,0),p(5,10)]);assert.equal(pieces.length,2);
 const left=pieces.find(f=>B.center(f).x<5),right=pieces.find(f=>B.center(f).x>5),before=JSON.stringify(right);
 Object.assign(left,B.transform(left,'move',2));
 assert.equal(JSON.stringify(right),before);
 const ground=B.terrain({faces:pieces}),walls=G.extrude({faces:[]},[{id:'e',kind:'perimeter',direction:'down',a:p(0,2,8),b:p(10,2,8)}],ground).walls;
 assert.equal(walls.length,2);assert.deepEqual(walls.map(w=>w.bottom[0].z),[2,0]);
 assert.equal(JSON.stringify(B.terrain(JSON.parse(JSON.stringify({faces:pieces})))),JSON.stringify(ground));
});
test('polyline splitting preserves a concave boundary and refuses paths leaving the face',()=>{
 const pieces=B.split(square,[p(5,0),p(3,4),p(5,10)]);
 assert.equal(pieces.length,2);assert.ok(pieces.every(f=>B.triangles(f.points).length===f.points.length-2));
 assert.throws(()=>B.split(square,[p(5,0),p(-5,4),p(5,10)]),/inside/);
 assert.throws(()=>B.split(square,[p(2,2),p(5,10)]),/boundary/);
});
test('pitch pivots about the face center and horizontal restores a plane',()=>{
 const pivot=B.center(square),tilted=B.transform(square,'pitch',.2,{x:Math.SQRT1_2,y:Math.SQRT1_2},pivot),pl=G.plane(tilted.points);
 assert.ok(Math.abs(pl.dx*pivot.x+pl.dy*pivot.y+pl.k-pivot.z)<1e-8);
 assert.ok(Math.abs(pl.dx-pl.dy)<1e-8);
 assert.ok(B.transform(tilted,'flat',0).points.every(p=>Math.abs(p.z)<1e-8));
});
test('initial base follows traced perimeter and grade without changing reference grade',()=>{
 const c=require('./fixtures/wall_gap_case.json'),D=require('../public/measure/internal/editor_scripts/wall_gaps.js'),before=JSON.stringify(c);
 const a=G.buildSources(c.roof,c.options),walls=D.repair(G.deduplicate(G.extrude(c.roof,a.sources,c.ground).walls,c.options.tolerance).walls,c.ground).walls;
 const base=B.fromRoof(c.roof,c.ground,walls);assert.equal(base.source,'Wall perimeter');
 const result=G.extrude(c.roof,a.sources,B.terrain(base));assert.equal(result.walls.length,47);assert.equal(result.warnings.length,0);
 assert.equal(JSON.stringify(c),before);
});
test('base is independent of later grade changes and roofs still intercept walls',()=>{
 const grade=T.fromPlane({x0:0,x1:10,y0:0,y1:10},{dx:.1,dy:0,k:0});
 const base=B.fromRoof({faces:[square]},grade);grade.points.forEach(p=>p.z+=5);
 assert.ok(Math.abs(T.height(B.terrain(base),p(2,2))-.2)<1e-8);
 const w=G.extrude({faces:[{id:1,points:[p(0,0,4),p(10,0,4),p(10,10,4),p(0,10,4)]}]},[{id:'roof',direction:'down',kind:'perimeter',a:p(0,2,8),b:p(10,2,8)}],B.terrain(base)).walls;
 assert.ok(w.every(w=>w.bottom.every(p=>p.z===4)));
});

 test('wall-driven base boundaries preserve split face planes and keep unrelated geometry fixed',()=>{
 const base={faces:[{id:'left',points:[{x:0,y:0,z:0},{x:2,y:0,z:.2},{x:2,y:4,z:.2},{x:0,y:4,z:0}]},{id:'right',points:[{x:2,y:0,z:.2},{x:4,y:0,z:.4},{x:4,y:4,z:.4},{x:2,y:4,z:.2}]}]},before=[{id:'wall',targetId:'ground',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:.4}]}],after=[{id:'wall',bottom:[{x:0,y:-1,z:0},{x:4,y:-1,z:.4}]}];
 const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),next=B.followWalls(base,before,after);for(const f of next.faces){assert.equal(f.points[0].y,-1);assert.equal(f.points[1].y,-1);assert.equal(f.points[2].y,4);assert.ok(f.points.every(p=>Math.abs(p.z-p.x*.1)<1e-9));}assert.equal(base.faces[0].points[0].y,0);assert.equal(B.followWalls(base,[{...before[0],targetId:'roof'}],after).faces[0].points[0].y,0);
 });

 test('a base step collapsing at a coplanar wall snap stays triangulatable',()=>{
 const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),p=(x,y)=>({x,y,z:0}),base={faces:[{id:'base',points:[[0,0],[4,0],[4,1],[8,1],[8,4],[0,4]].map(([x,y])=>p(x,y))}]},before=[{id:'main',targetId:'ground',bottom:[p(0,0),p(4,0)]},{id:'return',targetId:'ground',bottom:[p(4,0),p(4,1)]}],after=[{id:'main',bottom:[p(0,1),p(4,1)]},{id:'return',bottom:[p(4,1),p(4,1)]}];
 const next=B.followWalls(base,before,after);assert.doesNotThrow(()=>B.terrain(next));assert.equal(next.faces[0].points.length,4);assert.deepEqual(next.faces[0].points.map(p=>p.y),[1,1,4,4]);
 });

test('rebuilding to grade follows separate grade planes and refuses partial coverage',()=>{
 const base={faces:[{id:'f',points:[{x:0,y:0,z:50},{x:4,y:0,z:50},{x:4,y:4,z:50},{x:0,y:4,z:50}]}]},grade={points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:4,z:0},{x:0,y:4,z:0},{x:4,y:0,z:2},{x:4,y:4,z:2}],faces:[[0,1,2,3],[1,4,5,2]]};
 const result=B.fitGrade(base,grade);assert.equal(result.faces.length,2);for(const f of result.faces)for(const p of f.points)assert.ok(Math.abs(p.z-Math.max(0,p.x-2))<1e-8);assert.equal(base.faces[0].points[0].z,50);
 assert.throws(()=>B.fitGrade(base,{...grade,faces:[grade.faces[0]]}),/entire foundation/);
});

test('a flat grade with opposite signed numerical slopes rebuilds without a diagonal divider',()=>{
 const z=55.12,grade={points:[{x:-13.136,y:-15.213999999999999,z},{x:23.204000000000004,y:-15.213999999999999,z},{x:23.204000000000004,y:21.356,z},{x:-13.136,y:21.356,z}],faces:[[0,1,2],[0,2,3]]},base={faces:[{id:'base',points:[{x:0,y:0,z:1},{x:10,y:0,z:1},{x:10,y:10,z:1},{x:0,y:10,z:1}]}]};
 const next=B.fitGrade(base,grade);assert.equal(next.faces.length,1);assert.ok(next.faces[0].points.every(p=>Math.abs(p.z-z)<1e-9));
 const S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');S.ensure(next);assert.ok(next.sketch.edges.every(e=>e.fixed),'No editable diagonal should enter the base sketch');
});

test('triangulation accepts closed triangular wall rings and consecutive duplicate corners without mutating points',()=>{
 for(const points of [[p(0,0),p(1.524,0),p(1.524,.7619435329),p(0,0)],[p(0,0),p(1,0),p(1,0),p(1,1),p(0,1)]]){
  const before=JSON.stringify(points),triangles=B.triangles(points);assert.equal(triangles.length,new Set(points.map(p=>p.x+','+p.y)).size-2);
  assert.ok(triangles.every(t=>t.length===3&&new Set(t.map(i=>points[i].x+','+points[i].y)).size===3));assert.equal(JSON.stringify(points),before);
 }
});

test('wall extrusion trims or extends only the swept base perimeter and preserves neighboring corners',()=>{
 const base={faces:[{id:'floor',points:[p(0,0),p(8,0),p(8,4),p(0,4)]}]},wall={points:[p(2,0),p(6,0),p(6,0,2),p(2,0,2)]},before=JSON.stringify(base);
 for(const delta of [1,-1,.0001,-.0001]){const cap={points:wall.points.map(p=>({...p,y:p.y+delta}))},next=B.extrudeWall(base,wall,cap);assert.equal(next.faces.length,1);const ring=next.faces[0].points;for(const q of [p(0,0),p(8,0),p(2,delta),p(6,delta)])assert.ok(ring.some(v=>Math.hypot(v.x-q.x,v.y-q.y)<1e-7));const area=Math.abs(ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p.x*q.y-p.y*q.x;},0)/2);assert.ok(Math.abs(area-(32-4*delta))<1e-7);}
 assert.equal(JSON.stringify(base),before);
});
test('extrusion ignores elevated features and interior base edges',()=>{
 const base={faces:[{id:'a',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},{id:'b',points:[p(4,0),p(8,0),p(8,4),p(4,4)]}]};
 for(const points of [[p(0,0,1),p(4,0,1),p(4,0,3),p(0,0,3)],[p(4,0),p(4,4),p(4,4,3),p(4,0,3)]]){const wall={points},cap={points:points.map(p=>({...p,x:p.x+.5,y:p.y+.5}))};assert.equal(B.extrudeWall(base,wall,cap),base);}
});
test('a recess preserves base subdivisions, pitch and useful construction points without its old front edge',()=>{
 const S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js'),base={faces:[{id:'a',points:[p(0,0),p(4,0),p(4,4,1),p(0,4,1)]},{id:'b',points:[p(4,0),p(8,0),p(8,4,1),p(4,4,1)]}]};S.ensure(base);S.add(base,p(7,2,.5));const wall={points:[p(2,0),p(6,0),p(6,0,3),p(2,0,3)]},cap={points:wall.points.map(p=>({...p,y:p.y+1}))},next=B.extrudeWall(base,wall,cap);
 assert.equal(next.faces.length,2);assert.ok(next.faces.flatMap(f=>f.points).every(p=>Math.abs(p.z-.25*p.y)<1e-8));assert.ok(next.sketch.nodes.some(p=>p.x===7&&p.y===2));
 const byId=id=>next.sketch.nodes.find(n=>n.id===id);assert.ok(!next.sketch.edges.some(e=>{const a=byId(e.a),b=byId(e.b);return a.y===0&&b.y===0&&Math.max(a.x,b.x)>2&&Math.min(a.x,b.x)<6;}));S.resolve(next);assert.equal(next.faces.length,2);
});

test('roof regeneration traces the inset wall perimeter across a chimney-covered gap',()=>{
 const c=require('./fixtures/base-rebuild-chimney.json'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),before=JSON.stringify(c),base=B.fromRoof(c.roof,c.ground,c.walls);
 assert.equal(base.source,'Wall perimeter');
 for(const w of c.walls.filter(w=>w.bottom.every(p=>Math.abs(p.z-157.69)<1e-6)))for(const p of w.bottom)assert.ok(base.faces.some(f=>f.points.some((a,i)=>G.onEdge(p,a,f.points[(i+1)%f.points.length],.05))),w.id+' must mount on base boundary');
 const state={roof:c.roof,ground:c.ground,base,chimneys:C.detect(c.roof),wallEdits:{}};C.syncFoundation(state);
 const shell=C.compose(c.walls,state).filter(w=>w.chimney);assert.ok(shell.length>=3,'chimney must remain exposed outside the wall footprint');
 assert.equal(JSON.stringify(c),before);
 // A genuinely open wall outline must not be closed just by extrapolation.
 const roof={...c.roof,connections:[]};assert.equal(B.fromRoof(roof,c.ground,c.walls).source,'Roof footprint');
});
