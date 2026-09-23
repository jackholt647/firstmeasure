const test=require('node:test'),assert=require('node:assert/strict'),G=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z)=>({x,y,z});
test('direction snaps use world-plane axes and existing sloped edges',()=>{const a={x:0,y:0},b={x:3,y:.03};assert.equal(G.snapDirection(a,b,[],.1).y,0);const angle=Math.PI/18,q=G.snapDirection(a,{x:2,y:2*Math.tan(angle)+.02},[[a,{x:4,y:4*Math.tan(angle)}]],.1);assert.ok(Math.abs(q.y/q.x-Math.tan(angle))<1e-9);assert.equal(q.snapLabel,'Parallel to edge');});
test('recesses have caps and side faces, including horizontal surfaces that can themselves extrude',()=>{const face={id:'opening',points:[p(0,0,0),p(2,0,0),p(2,0,3),p(0,0,3)]},before=JSON.stringify(face),r=G.extrude(face,1);assert.equal(r.sides.length,4);assert.ok(r.cap.points.every(p=>p.y===-1));const floor=r.sides[0];assert.ok(Math.abs(G.normal(floor.points).z)===1);const next=G.extrude(floor,.5);assert.equal(next.sides.length,4);assert.equal(JSON.stringify(face),before);});
test('separating coplanar halves adds and updates a connecting wall along the shared edge',()=>{const wall=(id,x0,x1)=>({id,bottom:[p(x0,0,0),p(x1,0,0)],top:[p(x0,0,3),p(x1,0,3)]}),a=wall('a',0,2),b=wall('b',2,4),m=JSON.parse(JSON.stringify(a));for(const edge of ['bottom','top'])for(const p of m[edge])p.y=1;const faces=G.bridges([a,b],[m],['b']);assert.equal(faces.length,1);assert.equal(faces[0].points.length,4);assert.ok(faces[0].points.every(p=>p.x===2));for(const edge of ['bottom','top'])for(const p of m[edge])p.y=2;const next=G.bridges([a,b],[m],[],faces);assert.equal(next.length,1);assert.equal(next[0].points[2].y,2);assert.equal(next[0].points[0].y,0);});

test('extrusion follows the projected normal from either side and on horizontal faces',()=>{
 assert.equal(G.dragAmount({x:100,y:0},100,0),1);
 assert.equal(G.dragAmount({x:-100,y:0},100,0),-1);
 assert.equal(G.dragAmount({x:0,y:-100},0,-100),1);
 assert.equal(G.dragAmount({x:0,y:100},0,-100),-1);
 assert.equal(G.dragAmount({x:0,y:0},0,-100),3);
});
const area=ps=>Math.abs(ps.reduce((s,p,i)=>{const q=ps[(i+1)%ps.length];return s+p.x*q.y-p.y*q.x;},0)/2);
test('base subtraction handles interior holes, edge notches, complete removal and repeat cuts',()=>{
 const face={id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]};
 const inner={points:[p(1,1,0),p(3,1,0),p(3,3,0),p(1,3,0)]},notch={points:[p(-1,1,0),p(2,1,0),p(2,3,0),p(-1,3,0)]};
 for(const cut of [inner,notch]){assert.equal(G.subtract(face,[cut]).reduce((s,ps)=>s+area(ps),0),12);assert.equal(G.subtract(face,[cut,cut]).reduce((s,ps)=>s+area(ps),0),12);}
 assert.equal(G.subtract(face,[face]).length,0);
 assert.equal(G.subtract(face,[{...inner,faceIds:['other']}]).reduce((s,ps)=>s+area(ps),0),16);
});
test('base snap requires coplanarity and footprint overlap and includes adjacent base faces',()=>{
 const face={id:'floor',points:[p(1,1,2),p(3,1,2),p(3,3,2),p(1,3,2)]};
 const base={id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]};
 assert.deepEqual(G.snapBase(face,-1.9,[base]),{amount:-2,faceIds:['base']});
 assert.deepEqual(G.snapBase(face,-1.9,[base,{...base,id:'next'}]).faceIds,['base','next']);
 assert.equal(G.snapBase({...face,points:face.points.map(p=>({...p,x:p.x+10}))},-2,[base]),null);
 assert.equal(G.snapBase({...face,points:face.points.map(p=>({...p,z:p.z+p.x}))},-2,[base]),null);
});

test('face guides snap to crossing point alignments, edge parallels and perpendiculars in screen pixels',()=>{
 const screen=p=>({x:p.x*100,y:p.y*100});
 const aligned=G.draftSnap({x:2.04,y:3.03},[{x:2,y:0},{x:0,y:3}],[],[],screen,12);
 assert.ok(Math.abs(aligned.point.x-2)<1e-8&&Math.abs(aligned.point.y-3)<1e-8);assert.equal(aligned.guides.length,2);
 const slope=Math.tan(Math.PI/18),edge=[{x:0,y:0},{x:10,y:10*slope}],origin={x:1,y:4};
 const parallel=G.draftSnap({x:5,y:4+4*slope+.015},[],[edge],[origin],screen,8);
 assert.ok(Math.abs((parallel.point.y-origin.y)-(parallel.point.x-origin.x)*slope)<1e-8);assert.ok(parallel.guides.length);
 const perp=G.draftSnap({x:10-slope*2+.01,y:10*slope+2},[],[edge],[],screen,8);
 assert.ok(Math.abs((perp.point.x-10)+(perp.point.y-10*slope)*slope)<1e-8);
 const far=G.draftSnap({x:4,y:2.4},[{x:0,y:0}],[],[],screen,5);assert.equal(far.kind,null);
});

test('below-base removal requires the entire sloping face and its covered footprint below the local base',()=>{
 const base={id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]},floor={id:'floor',points:[p(1,1,-.1),p(3,1,-.1),p(3,3,-.1),p(1,3,-.1)]};
 assert.ok(G.belowBase(floor,[base]));
 assert.equal(G.belowBase({...floor,points:floor.points.map(p=>({...p,z:0}))},[base]),null);
 assert.equal(G.belowBase({...floor,points:floor.points.map(p=>({...p,z:(p.x-2)*.1}))},[base]),null);
 assert.equal(G.belowBase({...floor,points:floor.points.map(p=>({...p,x:p.x+2}))},[base]),null);
 const sloped={...base,points:base.points.map(p=>({...p,z:p.x*.2}))};assert.ok(G.belowBase({...floor,points:floor.points.map(p=>({...p,z:p.x*.1}))},[sloped]));
});
test('base coverage detects a lower interior step even when every outer corner is below the surrounding base',()=>{
 const strip=(id,x0,x1,z)=>({id,points:[p(x0,0,z),p(x1,0,z),p(x1,4,z),p(x0,4,z)]}),bases=[strip('left',0,1,0),strip('ditch',1,3,-2),strip('right',3,4,0)],face={points:[p(.5,1,-1),p(3.5,1,-1),p(3.5,3,-1),p(.5,3,-1)]};
 assert.equal(G.belowBase(face,bases),null);assert.ok(G.belowBase({...face,points:face.points.map(p=>({...p,z:-3}))},bases));
 assert.equal(G.belowBase(face,[bases[0],bases[2]]),null);
});
test('base scope excludes detached neighboring structures, and vertical faces can be wholly below base',()=>{
 const base={id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]},neighbor={id:'other',points:base.points.map(p=>({...p,x:p.x+10,z:20}))},face={points:[p(1,1,2),p(3,1,2),p(3,3,2),p(1,3,2)]};
 assert.deepEqual(G.baseScope(face,[base,neighbor]).map(f=>f.id),['base']);
 const vertical={points:[p(1,1,-3),p(3,1,-3),p(3,1,-1),p(1,1,-1)]};assert.ok(G.belowBase(vertical,[base]));assert.equal(G.belowBase({...vertical,points:vertical.points.map(p=>({...p,z:p.z+2}))},[base]),null);
});

test('deleted saved surfaces retain wire, restore with F, and shared point deletion removes all dependent faces',()=>{
 const face={id:'cap',points:[p(0,0,0),p(2,0,0),p(2,0,2),p(0,0,2)]},side={id:'side',points:[p(2,0,0),p(2,2,0),p(2,2,2),p(2,0,2)]};
 const edits={$surfaces:[face,side]},before=G.surfaceWire(edits);face.deleted=true;assert.equal(G.surfaceWire(edits).edges.length,before.edges.length);assert.equal(G.surfaceWire(edits).nodes.length,before.nodes.length);
 const loaded=JSON.parse(JSON.stringify(edits));assert.equal(G.restoreSurface(loaded,face.points.map(G.vertexKey)),'cap');assert.equal(loaded.$surfaces[0].deleted,false);
 G.deleteSurfaceElements(loaded,[G.vertexKey(p(2,0,0))]);assert.ok(loaded.$surfaces.every(f=>f.deleted));assert.equal(G.surfaceWire(loaded).nodes.length,before.nodes.length-1);assert.throws(()=>G.restoreSurface(loaded,face.points.map(G.vertexKey)),/existing points/);
});
test('deleting an edge retains its endpoints and removes faces that use it',()=>{
 const f={id:'face',points:[p(0,0,0),p(2,0,0),p(2,0,2),p(0,0,2)]},edits={$surfaces:[f]};G.deleteSurfaceElements(edits,[],[G.edgeKey(f.points[0],f.points[1])]);assert.equal(f.deleted,true);assert.equal(G.surfaceWire(edits).nodes.length,4);assert.equal(G.surfaceWire(edits).edges.length,3);
});

test('a door on a free perimeter edge extrudes only three shared edges; an interior window extrudes four',()=>{
 const door={id:'door',points:[p(1,0,0),p(3,0,0),p(3,0,2),p(1,0,2)]},wall={points:[p(0,0,0),p(1,0,0),p(1,0,2),p(3,0,2),p(3,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]};
 const result=G.extrude(door,1,{supports:[wall]});assert.equal(result.sides.length,3);assert.ok(result.sides.every(f=>!f.points.every(p=>p.z===0)));assert.equal(G.freeEdges(door,[wall]).length,1);
 const floor={points:[p(0,0,0),p(4,0,0),p(4,-4,0),p(0,-4,0)]};assert.equal(G.extrude(door,1,{supports:[wall,floor]}).sides.length,4);
 const windowFace={...door,points:door.points.map(p=>({...p,z:p.z+1}))},surround={points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)],holes:[windowFace.points]};assert.equal(G.extrude(windowFace,1,{supports:[surround]}).sides.length,4);
});
test('moving an existing side face changes shared endpoints and preserves neighbor planes without adding faces',()=>{
 const side={id:'side',points:[p(1,0,0),p(1,-2,0),p(1,-2,2),p(1,0,2)]},cap={id:'cap',points:[p(1,-2,0),p(3,-2,0),p(3,-2,2),p(1,-2,2)]},top={id:'top',points:[p(1,0,2),p(1,-2,2),p(3,-2,2),p(3,0,2)]};
 const before=[side,cap,top],n=G.normal(side.points),next=G.moveSurface(before,'side',1).faces;assert.equal(next.length,3);assert.deepEqual(next.map(f=>f.id),before.map(f=>f.id));assert.ok(next[0].points.every(p=>p.x===1+n.x));assert.ok(next[1].points.every(p=>p.y===-2));assert.ok(next[2].points.every(p=>p.z===2));assert.equal(next[1].points[0].x,1+n.x);
 const again=G.moveSurface(JSON.parse(JSON.stringify(next)),'side',.5).faces;assert.equal(again.length,3);assert.ok(again[0].points.every(p=>p.x===1+n.x*1.5));assert.equal(before[0].points[0].x,1);
});
test('angled neighbors keep their plane when an existing face moves',()=>{
 const selected={id:'move',points:[p(0,0,0),p(0,2,0),p(0,2,2),p(0,0,2)]},angled={id:'angle',points:[p(0,0,0),p(2,2,0),p(2,2,2),p(0,0,2)]};const result=G.moveSurface([selected,angled],'move',1).faces;assert.ok(result[1].points.every(p=>Math.abs(p.x-p.y)<1e-8));assert.equal(result.length,2);
});

test('contained coplanar snapping requires full coverage and ignores initial coplanarity',()=>{
 const small={id:'small',points:[p(1,-1,1),p(2,-1,1),p(2,-1,2),p(1,-1,2)]},large={id:'large',points:[p(0,0,0),p(6,0,0),p(6,0,6),p(0,0,6)]};
 assert.deepEqual(G.containedSnap(small,-.95,[small,large]),{amount:-1,targetId:'large',kind:'contained'});
 const placed={...small,points:small.points.map(p=>({...p,y:0}))};assert.equal(G.containedBy(placed,large),true);assert.equal(G.containedSnap(placed,.2,[large]),null);
 assert.equal(G.containedBy({...placed,points:placed.points.map(p=>({...p,x:p.x+5}))},large),false);
 assert.equal(G.containedBy(placed,{...large,holes:[placed.points]}),false);
 const rotate=p=>({x:p.x,y:p.z,z:-p.y});assert.ok(G.containedBy({...placed,points:placed.points.map(rotate)},{...large,points:large.points.map(rotate)}));
});
test('importing contained boundaries deduplicates nodes, crossing intersections, and partial overlapping edges',()=>{
 const S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js'),d={faces:[{id:'target',points:[p(0,0,0),p(6,0,0),p(6,6,0),p(0,6,0)]}]};S.ensure(d);
 const ring=[p(1,1,0),p(3,1,0),p(3,3,0),p(1,3,0)];G.importDraft(d,[ring]);const count=[d.sketch.nodes.length,d.sketch.edges.length];G.importDraft(d,[ring]);assert.deepEqual([d.sketch.nodes.length,d.sketch.edges.length],count);assert.equal(d.faces.length,2);
 G.importDraft(d,[[p(2,1,0),p(4,1,0),p(4,2,0),p(2,2,0)]]);const keys=d.sketch.edges.map(e=>[e.a,e.b].sort().join('|'));assert.equal(new Set(keys).size,keys.length);assert.ok(d.sketch.nodes.some(n=>Math.abs(n.x-3)<1e-8&&Math.abs(n.y-2)<1e-8));
});

 test('structural classification follows live face corners, while deleting a collinear point preserves the face',()=>{
 const face={id:'wall',points:[p(0,0,0),p(1,0,0),p(2,0,0),p(2,0,2),p(0,0,2)]},edits={$surfaces:[face]};assert.equal(G.structuralPoint(p(0,0,0),[face]),true);assert.equal(G.structuralPoint(p(1,0,0),[face]),false);assert.equal(G.structuralEdge(p(0,0,0),p(1,0,0),[face]),true);
 G.deleteSurfaceElements(edits,[G.vertexKey(p(1,0,0))]);assert.ok(!face.deleted);assert.equal(face.points.length,4);assert.ok(G.surfaceWire(edits).edges.some(e=>e.id===G.edgeKey(p(0,0,0),p(2,0,0))));
 G.deleteSurfaceElements(edits,[G.vertexKey(p(0,0,0))]);assert.equal(face.deleted,true);assert.equal(G.structuralPoint(p(2,0,2),[face]),false);assert.equal(G.structuralEdge(p(2,0,0),p(2,0,2),[face]),false);
 });

test('line removal merges coplanar regions but removes faces at a crease and leaves other geometry alone',()=>{
 const a={id:'a',points:[p(0,0,0),p(2,0,0),p(2,0,4),p(0,0,4)]},b={id:'b',points:[p(2,0,0),p(4,0,0),p(4,0,4),p(2,0,4)]},edge=[p(2,0,0),p(2,0,4)];
 const result=G.removeFaceEdges([a,b], [edge]);assert.deepEqual(result.removed,['a','b']);assert.equal(result.merged.length,1);assert.equal(G.surfaceWire({$surfaces:result.merged}).nodes.length,6); // Divider anchors survive independently of simplified face corners.
 const crease={id:'crease',points:[p(2,0,0),p(2,2,0),p(2,2,4),p(2,0,4)]};const cut=G.removeFaceEdges([a,crease,{...b,id:'far',points:b.points.map(v=>({...v,x:v.x+20}))}],[edge]);assert.deepEqual(cut.removed,['a','crease']);assert.equal(cut.merged.length,0);
});
test('partial edge deletion only hides that segment and retains both endpoints',()=>{
 const face={id:'a',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]},edits={$surfaces:[face],$removedSurfaceEdges:[G.edgeKey(p(1,0,0),p(3,0,0))]};const wire=G.surfaceWire(edits);
 assert.ok(wire.edges.some(e=>e.id===G.edgeKey(p(0,0,0),p(1,0,0))));assert.ok(wire.edges.some(e=>e.id===G.edgeKey(p(3,0,0),p(4,0,0))));assert.ok(!wire.edges.some(e=>e.id===G.edgeKey(p(0,0,0),p(4,0,0))));assert.equal(wire.nodes.length,6);
});

test('merging coplanar faces preserves window holes, and deleting a window outline fills it',()=>{
 const a={id:'a',points:[p(0,0,0),p(2,0,0),p(2,0,4),p(0,0,4)],holes:[[p(.5,0,1),p(1.5,0,1),p(1.5,0,2),p(.5,0,2)]]},b={id:'b',points:[p(2,0,0),p(4,0,0),p(4,0,4),p(2,0,4)]};
 const merged=G.removeFaceEdges([a,b],[[p(2,0,0),p(2,0,4)]]).merged;assert.equal(merged.length,1);assert.equal(merged[0].holes.length,1);
 const window={id:'window',points:a.holes[0]};const filled=G.removeFaceEdges([a,window],[[window.points[0],window.points[1]]]).merged;assert.equal(filled.length,1);assert.equal(filled[0].holes.length,0);
});

test('quadrilateral snaps derived corners to a point and returns yellow-guide geometry',()=>{
 const corners=p=>[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:p.y,z:0},{x:0,y:p.y,z:0}],screen=p=>({x:p.x*100,y:p.y*100});
 const hit=G.quadDraftSnap({x:1,y:1.9,z:0},corners,[{x:2,y:2,z:0}],[],[],screen,20);assert.ok(hit);assert.ok(Math.abs(hit.point.y-2)<1e-6);assert.equal(corners(hit.point)[2].x,2);assert.equal(hit.guides.length,2);
});
test('opposite corner snaps to a slanted edge while a rectangular extrusion retains its fixed edge',()=>{
 const corners=p=>[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:p.y,z:0},{x:0,y:p.y,z:0}],screen=p=>({x:p.x*100,y:p.y*100}),edge=[{x:1,y:1.5,z:0},{x:3,y:2.5,z:0}];
 const hit=G.quadDraftSnap({x:.8,y:1.88,z:0},corners,[],[edge],[],screen,20);assert.ok(hit);assert.ok(Math.abs(hit.point.y-2)<1e-6);assert.ok(hit.guides.length);assert.deepEqual(corners(hit.point).slice(0,2),corners({y:0}).slice(0,2));
});

test('M moves a full-height middle region and rotates shared neighbors without new faces',()=>{
 const rect=(id,x0,x1)=>({id,points:[p(x0,0,0),p(x1,0,0),p(x1,0,3),p(x0,0,3)]}),faces=[rect('left',0,1),rect('middle',1,2),rect('right',2,3)],before=JSON.stringify(faces);
 const result=G.moveFabric(faces,'middle',1);assert.equal(result.detached,false);assert.equal(result.faces.length,3);assert.equal(result.affected.length,3);assert.ok(result.faces.find(f=>f.id==='middle').points.every(p=>p.y===-1));assert.equal(result.faces[0].points[0].y,0);assert.equal(result.faces[0].points[1].y,-1);assert.equal(JSON.stringify(faces),before);
});
test('M requires connecting returns when its parent would otherwise become nonplanar',()=>{
 const inner=[p(1,0,1),p(2,0,1),p(2,0,2),p(1,0,2)],parent={id:'parent',points:[p(0,0,0),p(3,0,0),p(3,0,3),p(0,0,3)],holes:[inner]},source={id:'inner',points:inner};
 const before=JSON.stringify([parent,source]);assert.throws(()=>G.moveFabric([parent,source],'inner',1),/connecting returns/);assert.equal(JSON.stringify([parent,source]),before);
});

test('finite edge snapping measures perspective screen distance and wins over off-edge guides',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),a={x:0,y:0,z:0},b={x:0,y:5,z:0};
 const screen=p=>({x:(p.x+.8*p.y)*100/(1+.1*p.y),y:20*p.y/(1+.1*p.y)}),raw={x:.09,y:1.4,z:0};
 const hit=W.draftSnap(raw,[a,b],[[a,b]],[],screen,4);assert.equal(hit.point.x,0);assert.match(hit.kind,/Edge/);assert.ok(hit.guides.length);
 const q=screen(hit.point),r=screen(raw);assert.ok(Math.hypot(q.x-r.x,q.y-r.y)<4);
 const node={x:.005,y:2.3,z:0},exact=W.draftSnap({x:0,y:2.3,z:0},[a,b,node],[[a,b]],[],p=>({x:p.x*100,y:p.y*100}),20);assert.equal(exact.point.x,0);
});

test('render structural index agrees with geometry classification without changing editable points',()=>{
 const faces=[{points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]}],before=JSON.stringify(faces),index=G.structuralIndex(faces);
 const points=[...faces[0].points,{x:1,y:0,z:0},{x:1,y:0,z:2},{x:4,y:0,z:2},{x:0,y:0,z:4.1}];
 for(const p of points)assert.equal(index.point(p),G.structuralPoint(p,faces));
 for(const a of points)for(const b of points)assert.equal(index.edge(a,b),G.structuralEdge(a,b,faces));
 assert.equal(JSON.stringify(faces),before);
});

test('bounded planar translation slides along rectangle and angled limits',()=>{
 const footprint=[p(1,1,0),p(2,1,0),p(2,2,0),p(1,2,0)],wall={points:[p(0,0,0),p(10,0,0),p(10,10,0),p(0,10,0)]};
 assert.deepEqual(G.boundedTranslation(footprint,[wall],{x:-100,y:3}),{x:-1,y:3});assert.deepEqual(G.boundedTranslation(footprint,[wall],{x:-200,y:5}),{x:-1,y:5});
 const triangle={points:[p(0,0,0),p(10,0,0),p(0,10,0)]},a=G.boundedTranslation(footprint,[triangle],{x:8,y:3});assert.ok(Math.abs(a.x+a.y-6)<1e-7);const b=G.boundedTranslation(footprint,[triangle],{x:8,y:5});assert.ok(b.y>a.y&&b.x<a.x);
 const locked=G.boundedTranslation(footprint,[triangle],{x:100,y:0},{axis:'x'});assert.ok(Math.abs(locked.x-6)<1e-7);assert.equal(locked.y,0);
});

test('merged source upgrade preserves unrelated deleted faces and respects holes and planes',()=>{
 const rect=(id,x,y=0)=>({id,points:[p(x,y,0),p(x+1,y,0),p(x+1,y,1),p(x,y,1)],deleted:true});
 const merged={id:'line-merge-0',points:[p(0,0,0),p(4,0,0),p(4,0,2),p(0,0,2)],holes:[[p(2,0,0),p(3,0,0),p(3,0,1),p(2,0,1)]]},a=rect('a',0),outside=rect('outside',5),hole=rect('hole',2),otherPlane=rect('parallel',0,.2),e={$surfaces:[a,outside,hole,otherPlane,merged]};
 assert.equal(G.adoptMergedFaceSources(e),true);assert.equal(a.replacedBy,merged.id);
 for(const f of [outside,hole,otherPlane])assert.equal(f.replacedBy,undefined);
 const wire=G.surfaceWire(e);assert.ok(wire.nodes.some(n=>n.x===6),'Ordinary deleted face wire remains editable');
 assert.equal(G.adoptMergedFaceSources(e),false);
});

test('deleting an underlying divider cannot consume an unsplit sticker covering it',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),rect=(x,z,w,h)=>[{x,y:0,z},{x:x+w,y:0,z},{x:x+w,y:0,z:z+h},{x,y:0,z:z+h}],faces=[{id:'lower',points:rect(0,0,4,2)},{id:'upper',points:rect(0,2,4,2)},{id:'window',feature:{type:'window'},points:rect(1,1,2,2)}];
 const result=W.removeFaceEdges(faces,[[{x:0,y:0,z:2},{x:4,y:0,z:2}]]);assert.ok(!result.removed.includes('window'));assert.equal(result.removed.length,2);assert.equal(result.merged.length,1);
});


test('moving a supporting face carries only its coplanar stickers and opening boundaries',()=>{
 const rect=(id,x,z,w,h,y=0)=>({id,points:[p(x,y,z),p(x+w,y,z),p(x+w,y,z+h),p(x,y,z+h)]});
 for(const holes of [false,true])for(const method of ['moveSurface','moveFabric','transformSelection']){
  const wall=rect('wall',0,0,8,5),window={...rect('window',1,1,2,2),feature:{type:'window'}},door={...rect('door',4,0,2,3),feature:{type:'door'}},ordinary=rect('ordinary',1,3.5,1,1),behind={...rect('behind',1,1,2,2,1),feature:{type:'window'}},outside={...rect('outside',10,1,2,2),feature:{type:'garage'}};
  if(holes)wall.holes=[window.points,door.points];const scene=[wall,window,door,ordinary,behind,outside],before=JSON.stringify(scene);let result;
  if(method==='transformSelection'){const clip=G.copyGeometry(scene,wall.points,[]),preview=G.transformGeometry(clip,0,{delta:{x:.3,y:0}});result=G.transformSelection(scene,clip,preview);}else result=G[method](scene,'wall',.3);
  const moved=result.faces.find(f=>f.id==='wall'),delta={x:moved.points[0].x-wall.points[0].x,y:moved.points[0].y-wall.points[0].y,z:moved.points[0].z-wall.points[0].z};
  for(const sticker of [window,door]){const next=result.faces.find(f=>f.id===sticker.id);assert.deepEqual(next.feature,sticker.feature);next.points.forEach((q,i)=>{for(const axis of ['x','y','z'])assert.ok(Math.abs(q[axis]-sticker.points[i][axis]-delta[axis])<1e-8,method+' '+sticker.id);});}
  for(const other of [ordinary,behind,outside])assert.deepEqual(result.faces.find(f=>f.id===other.id).points,other.points);
  assert.equal(JSON.stringify(scene),before);
 }
});


test('sticker alignment reaches inset edges and perpendicular wall heights without false width snaps',()=>{
 const wall={points:[p(0,0,0),p(8,0,0),p(8,0,6),p(0,0,6)]},frame=G.faceFrame(wall),screen=q=>({x:q.x*100,y:q.z*100});
 const garage={feature:{type:'garage'},points:[p(2,.3,0),p(5,.3,0),p(5,.3,3),p(2,.3,3)]};
 const side={feature:{type:'window'},points:[p(6,1,2),p(6,3,2),p(6,3,4),p(6,1,4)]};
 const inset=G.stickerAlignmentTargets([garage],frame),corner=G.stickerAlignmentTargets([side],frame);
 assert.equal(inset.length,5);assert.equal(inset.filter(q=>q.alignmentCenter).length,1);assert.equal(G.stickerAlignmentTargets([{...garage,trim:true}],frame).length,0);assert.ok(inset.every(q=>q.y===0));assert.ok(corner.every(q=>q.alignmentAxes.length===1));
 const a=G.planeAlignment([p(2.06,0,1)],inset,frame,screen);assert.ok(Math.abs(a.x+.06)<1e-8);assert.equal(a.y,0);
 const b=G.planeAlignment([p(5.94,0,3.94)],corner,frame,screen);assert.equal(b.x,0);assert.ok(Math.abs(b.y-.06)<1e-8);
 assert.equal(G.stickerAlignmentTargets([{...side,feature:null}],frame).length,0);
 assert.equal(G.stickerAlignmentTargets([garage],frame,garage.points).length,0);
 assert.ok(G.planeAlignmentGuides([p(3,0,4)],corner,frame).length);
 const clip=G.copyGeometry([{id:'moving',points:[p(5.94,0,3),p(6.94,0,3),p(6.94,0,3.94),p(5.94,0,3.94)]}],[p(5.94,0,3),p(6.94,0,3),p(6.94,0,3.94),p(5.94,0,3.94)],[]),snapped=G.snapGeometryOnPlane(clip,0,corner,[],screen);
 assert.ok(snapped.points.every(q=>q.y===0));assert.ok(Math.abs(snapped.points[0].x-5.94)<1e-8);assert.ok(Math.abs(snapped.points[2].z-4)<1e-8);
});

test('point range index conservatively retains segment contacts in every orientation',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),points=Array.from({length:10000},(_,i)=>p(i,10,10));
 points.push(p(0,0,0),p(.5,0,0),p(1,0,0),p(.5,.000009,0),p(.5,.001,0));const index=W.pointRangeIndex(points),near=index.segment(p(0,0,0),p(1,0,0));assert.equal(near.length,4);assert.deepEqual(index.segment(p(1,0,0),p(0,0,0)),near);
 for(const [a,b]of [[p(0,0,0),p(20,20,20)],[p(2,0,0),p(2,20,20)],[p(0,10,10),p(0,10,10)]]){
  const expected=points.filter(p=>['x','y','z'].every(k=>p[k]>=Math.min(a[k],b[k])-1e-5&&p[k]<=Math.max(a[k],b[k])+1e-5));assert.deepEqual(new Set(index.segment(a,b)),new Set(expected));
 }
});

for(const setback of [18,24])test(`captured generated front extrusion keeps its canonical source rim at ${setback} inches`,()=>{
 const WG=require('../public/measure/internal/editor_scripts/wall_geometry'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),M=require('../public/measure/internal/editor_scripts/exterior_model'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),setback),geo=WG.topology(WG.canonicalGeneratedWalls(r.composed)),front=geo.faces.find(f=>f.mergeGroup?.includes('envelope-0-18-')),face={id:'front',generatedRoofContact:true,points:front.pointIndices.map(i=>geo.points[i])},before=JSON.stringify(r.state.roof);
 const engine=M.createExtrusion({face,scene:[],supports:[face],roof:r.state.roof});
 for(const amount of [-.1,-.3,-.6]){const shape=engine.preview(amount);if(setback===18&&amount<0){assert.equal(shape.cap.points.length,4);assert.equal(shape.sides.length,4);assert.ok(shape.sides.every(f=>f.points.length===4),'no old stations, thin roof patches or diagonal repair faces');}
  const shell=[face,shape.cap,...shape.sides];shell.forEach(K.validateFace);
  for(const f of shell)for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length],covered=G.sharedIntervals(a,b,shell.filter(other=>other!==f)).reduce((sum,[lo,hi])=>sum+hi-lo,0);const onRoof=[.1,.5,.9].every(t=>{const p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};return r.state.roof.faces.some(f=>{const plane=WG.plane(f.points);return plane&&WG.contains(f,p)&&Math.abs(p.z-plane.dx*p.x-plane.dy*p.y-plane.k)<.05;});});assert.ok((1-covered)*Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<2*K.CONTACT||onRoof,'Every extrusion boundary meets an adjoining face or the owning roof: '+JSON.stringify({setback,amount,a,b,covered}));}
 }
 assert.equal(JSON.stringify(r.state.roof),before,'contact normalization never rewrites the measured roof');
});
test('authored nonuniform faces extrude their exact boundary without replacing it with a rectangle',()=>{
 const face={id:'ragged',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(3,0,4),p(2,0,3.5),p(0,0,4)]},shape=G.extrude(face,.3);assert.equal(shape.cap.points.length,6);assert.equal(shape.sides.length,6);
 for(let i=0;i<face.points.length;i++){assert.equal(shape.cap.points[i].x,face.points[i].x);assert.equal(shape.cap.points[i].z,face.points[i].z);assert.deepEqual(shape.sides[i].points.slice(0,2),[face.points[i],face.points[(i+1)%face.points.length]]);}
});

test('point movement normalizes only incident faces in a large scene',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),faces=Array.from({length:500},(_,i)=>({id:'wall-'+i,points:[p(i*3,0,0),p(i*3+2,0,0),p(i*3+2,0,3),p(i*3,0,3)]})),source=faces[0].points[3],normalize=K.normalizeFace;let calls=0;
 K.normalizeFace=(...args)=>{calls++;return normalize(...args);};
 try{const result=G.slideLines(faces,[[source,source]],p(0,0,-1),.0254);assert.equal(calls,1);assert.deepEqual(result.affected,['wall-0']);assert.equal(result.faces[0].points[3].z,3-.0254);for(let i=1;i<faces.length;i++)assert.deepEqual(result.faces[i].points,faces[i].points);}
 finally{K.normalizeFace=normalize;}
});

test('edge deletion does not adopt unrelated closed wires or a path on another plane',()=>{
 const face={id:'door',feature:{type:'door'},points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]},ring=[p(1,0,1),p(2,0,1),p(2,0,2),p(1,0,2)],lines=ring.map((p,i)=>[p,ring[(i+1)%ring.length]]);lines.push([p(0,1,4),p(2,1,5)],[p(2,1,5),p(4,1,4)]);const result=G.removeFaceEdges([face],[[face.points[2],face.points[3]]],{lines});assert.deepEqual(result.removed,['door']);assert.equal(result.merged.length,0);
});

test('importing a spline bounded face preserves definitions instead of sampled editable edges',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry'),q=(x,y)=>({x,y,z:0}),c={...K.splineThrough([q(1,3),q(3,3)],[q(2,4)],{x:0,y:0,z:1}),id:'arch'},f=K.archFaces([{id:'opening',points:[q(1,1),q(3,1),q(3,3),q(1,3)],holes:[]}],c).faces[0],d={origin:q(0,0),u:{x:1,y:0},faces:[{id:'wall',points:[q(0,0),q(5,0),q(5,5),q(0,5)]}]};S.ensure(d);G.importDraft(d,[f.points],f.curves);assert.equal(d.sketch.curves.length,1);assert.equal(d.sketch.edges.filter(e=>e.curveId).length,2);assert.equal(d.sketch.curves[0].controls.length,3);assert.ok(d.faces.some(f=>f.curves?.length));assert.ok(d.sketch.nodes.length<12,'render samples must not become persistent anchors');
});
