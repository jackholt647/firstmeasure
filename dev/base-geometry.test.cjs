const test=require('node:test'),assert=require('node:assert/strict'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),T=require('../public/measure/internal/editor_scripts/ground_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),square={id:'base-1',points:[p(0,0),p(10,0),p(10,10),p(0,10)]};
test('level pivot follows a single horizontal shared edge, including partial and subdivided contacts',()=>{
 const low={id:'low',points:[p(0,0,0),p(10,0,0),p(10,5,1),p(0,5,1)]},slope={id:'slope',points:[p(0,5,1),p(5,5,1),p(10,5,1),p(10,10,3),p(0,10,3)]},high={id:'high',points:[p(2,10,3),p(8,10,3),p(8,15,4),p(2,15,4)]};
 for(const [face,z]of [[low,1],[high,3]]){const before=JSON.stringify(slope),pivot=B.levelPivot(face,[low,slope,high]),flat=B.transform(face,'flat',0,{x:1,y:0},pivot);assert.equal(pivot.z,z);assert.ok(flat.points.every(p=>p.z===z));assert.deepEqual(flat.points.map(p=>[p.x,p.y]),face.points.map(p=>[p.x,p.y]));assert.equal(JSON.stringify(slope),before);}
 assert.deepEqual(B.levelPivot(slope,[low,slope,high]),B.center(slope),'two neighbours retain the center');
});
test('level pivot ignores corner-only and vertically separated contacts and does not flatten about a sloped seam',()=>{
 const f={id:'f',points:[p(0,0),p(10,0,1),p(10,10,1),p(0,10)]};
 const corner={id:'corner',points:[p(10,10,1),p(12,10,1),p(12,12,1)]},above={id:'above',points:[p(10,0,2),p(12,0,2),p(12,10,2),p(10,10,2)]},sloped={id:'slope',points:[p(0,10),p(10,10,1),p(10,12,1),p(0,12)]};
 for(const others of [[],[corner],[above],[sloped]])assert.deepEqual(B.levelPivot(f,[f,...others]),B.center(f));
});
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

test('explicit setbacks survive an interrupted wall perimeter instead of reverting to roof edges',()=>{
 const D=require('../public/measure/internal/editor_scripts/wall_gaps'),c=require('./fixtures/base-rebuild-chimney.json');
 for(const inches of [2.4,12,18,24]){
  const sources=G.buildSources(c.roof,{soffit:inches}).sources,walls=D.repair(G.deduplicate(G.extrude(c.roof,sources,c.ground).walls,18*G.INCH).walls,c.ground).walls;
  const base=B.fromRoof(c.roof,c.ground,walls,inches*G.INCH);assert.ok(['Wall perimeter','Inset roof footprint'].includes(base.source));
  // Overlap reconciliation can now close this captured outline. An actually
  // interrupted outline must still retain the requested setback as its fallback.
  assert.equal(B.fromRoof(c.roof,c.ground,[],inches*G.INCH).source,'Inset roof footprint');
  const roofArea=require('../public/measure/internal/editor_scripts/exterior_geometry').area;
  assert.ok(base.faces.reduce((n,f)=>n+roofArea(f),0)<B.fromRoof(c.roof,c.ground).faces.reduce((n,f)=>n+roofArea(f),0));
 }
});
test('fallback inset handles concave roofs and rejects a setback that consumes the whole footprint',()=>{
 const points=[p(0,0,5),p(10,0,5),p(10,4,5),p(4,4,5),p(4,10,5),p(0,10,5)],roof={faces:[{points}]},grade=T.fromPlane({x0:-1,x1:11,y0:-1,y1:11},{dx:0,dy:0,k:0});
 const b=B.fromRoof(roof,grade,[],1);assert.equal(b.faces.length,1);assert.ok(b.faces[0].points.some(p=>p.x===3&&p.y===3));assert.throws(()=>B.fromRoof(roof,grade,[],6),/closed house outline/);
});
test('pitch is square to a fold the face shares, so a move down brings both ends of the fold onto the neighbour',()=>{
 const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),p=(x,y,z=0)=>({x,y,z});
 // Two level faces meeting along x=4. The far edge of the right face runs 0.0013 degrees off parallel to the fold,
 // as the edges of a surveyed building do.
 const tilt=Math.tan(.0013*Math.PI/180),left={id:'left',points:[p(0,0),p(4,0),p(4,6),p(0,6)]},right={id:'right',points:[p(4,0),p(12,0),p(12+6*tilt,6),p(4,6)]};
 const far={x:-1,y:tilt},length=Math.hypot(far.x,far.y),wanted={x:far.x/length,y:far.y/length};
 // Taking the direction from the far edge (square to it) is what tilted the fold.
 const fromFarEdge=B.boundaryAxis(right,wanted)?.direction||wanted,axis=B.foldAxis(right,[left,right],fromFarEdge);
 assert.ok(axis&&Math.abs(Math.abs(axis.x)-1)<1e-12&&Math.abs(axis.y)<1e-12,'square to the fold exactly: '+JSON.stringify(axis));
 assert.equal(B.foldAxis(right,[left,right],{x:Math.cos(.2),y:Math.sin(.2)}),null,'a direction that is plainly another one is left alone');
 assert.equal(B.foldAxis(left,[left],{x:1,y:0}),null,'a face with no neighbour has no fold');
 const fold=f=>f.points.filter(q=>Math.abs(q.x-4)<1e-9).map(q=>q.z);
 const skew=fold(B.transform(right,'pitch',.2,wanted,B.center(right))),square=B.transform(right,'pitch',.2,axis,B.center(right));
 assert.ok(Math.abs(skew[0]-skew[1])>1e-5,'pitched off the far edge, the fold ends differ by '+Math.abs(skew[0]-skew[1]));
 assert.ok(Math.abs(fold(square)[0]-fold(square)[1])<1e-9,'pitched square to the fold, it stays level');
 // Moving it back down snaps the fold onto the neighbour, not some other edge that is level with the neighbour's plane.
 const snap=B.heightSnap(square,[left],-fold(square)[0]+.004,q=>({x:q.x*100+q.y*10,y:q.z*100}));
 assert.ok(snap,'a snap is offered');assert.equal(snap.kind,'Edge / plane height snap');
 const landed=fold(B.transform(square,'move',snap.amount));assert.ok(landed.every(z=>Math.abs(z)<1e-9),'both ends of the fold are on the neighbour: '+landed);
});
test('a base face that spans no area is dropped on open, so the base can be drawn (FM-630)',()=>{
 const p=(x,y,z=0)=>({x,y,z}),square={id:'a',points:[p(0,0),p(4,0),p(4,3),p(0,3)]};
 // An older point weld saved a two-point face; a face of three points on one line spans no area either.
 const base={faces:[square,{id:'b',points:[p(0,0),p(4,0)]},{id:'c',points:[p(0,0),p(2,0),p(4,0)]}]};
 assert.throws(()=>B.terrain(base));
 assert.equal(B.dropEmptyFaces(base),true);assert.deepEqual(base.faces.map(f=>f.id),['a']);
 assert.equal(B.terrain(base).faces.length,2);
 assert.equal(B.dropEmptyFaces(base),false,'nothing else to drop');
 // A pitched face and a sliver of real area stay.
 const kept={faces:[square,{id:'pitched',points:[p(0,3,0),p(4,3,0),p(4,4,1)]},{id:'sliver',points:[p(0,0),p(4,0),p(2,-.0001)]}]};
 assert.equal(B.dropEmptyFaces(kept),false);assert.equal(kept.faces.length,3);
});
test('a spike of no width in a base outline is dropped on open, so the base can be drawn (FM-636)',()=>{
 // 119 River Bottom Cir: a wall pushed in 0.3 m beside a wall 0.17 degrees off square, then welded. The outline runs
 // out to the old corner (index 9) and straight back over the new one (index 8).
 const ring=[[3.171918999999998,-7.465042,187.33401489257812],[4.703606,-6.813468,187.334015],[6.03934,-3.718708000000001,187.334015],[5.6254709275691015,-2.6005780370269624,187.334015],[6.288896573395286,-2.26143221808202,187.334015],[7.038392,-0.5247340000000003,187.33401489257812],[6.687445,0.680326,187.334015],[6.410943793756931,0.7996697655594129,187.33401495875452],[7.162915595406734,2.541873132801378,187.3340149579086],[7.439081276100453,2.4217520060043882,187.334015],[4.751574895988572,3.5907107768487805,187.33401489257812],[4.52244,4.152602,187.33401496046372],[3.83763782807678,4.45046193517846,187.33401489257812],[3.428297,4.296125,187.33401496315523],[3.266399999852551,4.236702999945881,187.334015],[2.418171,4.605649,187.334015],[3.786760959721362,7.777675906644848,187.334015],[-3.6347333154761388,10.979393136099997,187.334015],[-5.050734794534255,7.697734666743617,187.3340149819248],[-5.555636,7.917347,187.3340149703455],[-5.676935,7.637723,187.334015],[-5.810529,8.027934,187.3340149705946],[-6.12011859219134,7.3161648226187594,187.334015],[-5.840798,7.194671,187.33401497066976],[-5.840771,7.194733,187.33401497066973],[-5.838581,7.193781,187.3340149706676],[-6.292428,6.141893,187.33401489257812],[-6.752863622950377,5.091778834677825,187.33401489257812],[-6.759085,5.094455,187.334015],[-7.03908603361314,5.21437192151467,187.334015],[-7.34466,4.500869000000001,187.334015],[-6.971192826629505,4.6703549244718845,187.334015],[-5.278446,3.932917,187.33401497028265],[-5.279037,3.931557,187.3340149702833],[-5.00129043973374,3.8107491912652653,187.334015],[-6.333513,0.747881,187.33401497150984],[-6.335962,0.74893,187.33401497151226],[-6.335957,0.748942,187.33401497151223],[-6.61595915889796,0.86885862897844,187.334015],[-6.921532,0.15535600000000005,187.334015],[-6.547871142720817,0.32493093523037575,187.334015],[-5.394128,-0.1769010000000002,187.33401489257812],[-6.709238010142512,-3.2004260233183057,187.334015],[-6.07407705887908,-3.47669513641684,187.33401489257812],[-7.54605399999518,-6.887115999988831,187.334015],[1.6991710000102822,-10.877019999976179,187.334015]];
 const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);
 const points=ring.map(([x,y,z],i)=>({x,y,z,nodeId:'n'+i})),before=area(points);
 const sketch={nodes:points.map(({x,y,z,nodeId})=>({x,y,z,id:nodeId,fixed:true})),edges:[[7,8],[8,9],[8,10],[10,11],[3,40]].map(([a,b],i)=>({id:'e'+i,a:'n'+a,b:'n'+b,fixed:a!==3}))};
 const base={faces:[{id:'base-1',points}],sketch};
 assert.throws(()=>B.terrain(base),/valid planar region/);
 assert.equal(B.dropSpikes(base),true);
 assert.deepEqual(base.faces[0].points.map(p=>p.nodeId),points.map(p=>p.nodeId).filter(id=>id!=='n9'));
 assert.ok(Math.abs(area(base.faces[0].points)-before)<1e-9,'the spike enclosed nothing');
 assert.ok(B.terrain(base).faces.length>0);
 // The line out to the old corner goes with it; every other line and corner stays as it was.
 assert.deepEqual(sketch.edges.map(e=>e.id),['e0','e2','e3','e4']);assert.ok(!sketch.nodes.some(n=>n.id==='n9'));assert.equal(sketch.nodes.length,ring.length-1);
 assert.equal(B.dropSpikes(base),false,'nothing else to drop');
 // A narrow notch of real width, and a corner where the outline only turns, stay.
 const notch={faces:[{id:'a',points:[p(0,0),p(2,0),p(2,1),p(2.001,1),p(2.001,0),p(4,0),p(4,3),p(0,3)]}]};
 assert.equal(B.dropSpikes(notch),false);assert.equal(notch.faces[0].points.length,8);
 // A spike in a hole goes too.
 const holed={faces:[{id:'h',points:[p(0,0),p(10,0),p(10,10),p(0,10)],holes:[[p(2,2),p(4,2),p(4,4),p(2,4),p(2,5)]]}]};
 assert.equal(B.dropSpikes(holed),true);assert.equal(holed.faces[0].holes[0].length,4);
});
