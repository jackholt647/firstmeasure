const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../public/measure/internal/editor_scripts/wall_gaps.js');
const p=(x,y,z)=>({x,y,z});
const wall=(id,a,b,lo,hi)=>({id,sourceId:id,kind:'perimeter',bottom:[p(...a,lo),p(...b,lo)],top:[p(...a,hi),p(...b,hi)]});
test('orphan check isolates the lower interval when the upper wall already joins',()=>{
    const walls=[wall('a',[0,0],[4,0],0,6),wall('b',[4,0],[4,4],3,6)];
    const gaps=D.detect(walls),at=gaps.filter(g=>g.bottom.x===4&&g.bottom.y===0);
    assert.equal(at.length,1);assert.equal(at[0].bottom.z,0);assert.equal(at[0].top.z,3);
});
test('T junctions and collinear continuations are joined; duplicate faces do not hide orphan ends',()=>{
    const a=wall('a',[0,0],[4,0],0,6),b=wall('b',[2,0],[2,3],0,6);
    assert.ok(!D.detect([a,b]).some(g=>g.bottom.x===2&&g.bottom.y===0));
    assert.ok(!D.detect([a,wall('c',[4,0],[7,0],0,6)]).some(g=>g.bottom.x===4&&g.bottom.y===0));
    assert.equal(D.detect([a,{...a,id:'duplicate'}]).length,2);
});
const corner=()=>[wall('left',[-2,0],[0,0],0,5),wall('right',[2,2],[2,4],0,5),wall('upper-a',[0,0],[2,0],3,5),wall('upper-b',[2,0],[2,2],3,5)];
test('gap repair follows an L-shaped existing yellow path, not the diagonal between orphans',()=>{
    const walls=corner(),before=JSON.stringify(walls),r=D.repair(walls,0);
    assert.equal(r.paths.length,1);assert.equal(r.paths[0].length,4);
    assert.equal(r.added.length,2);assert.equal(r.gaps.length,2);
    assert.ok(r.paths[0].points.some(p=>p.x===2&&p.y===0));
    for(const w of r.added){assert.ok(w.bottom[0].x===w.bottom[1].x||w.bottom[0].y===w.bottom[1].y);assert.ok(w.top.every(p=>p.z===3));}
    assert.equal(JSON.stringify(walls),before);assert.equal(D.repair(r.walls,0).added.length,0);
});
test('without an existing overhead path the two orphan edges remain highlighted',()=>{
    const walls=corner().slice(0,2),r=D.repair(walls,0);
    assert.equal(r.added.length,0);assert.equal(r.gaps.length,4);
});
test('repair splits projected crossings even when neither yellow edge ends at the junction',()=>{
    const walls=corner();walls[2]=wall('upper-a',[0,0],[3,0],3,5);walls[3]=wall('upper-b',[2,-1],[2,2],3,5);
    const r=D.repair(walls,0);assert.ok(r.paths.length>0);assert.ok(r.paths.some(path=>path.points.some(p=>p.x===2&&p.y===0)));
});
test('saved roof gap paths close both lower gaps despite imprecise overhead overlap',()=>{
    const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),c=require('./fixtures/wall_gap_case.json');
    const a=G.buildSources(c.roof,c.options),b=G.extrude(c.roof,a.sources,c.ground||c.options.ground),walls=G.deduplicate(b.walls,c.options.tolerance).walls;
    const r=D.repair(walls,c.ground||c.options.ground);
    assert.equal(r.before.length,4);assert.equal(r.gaps.length,0);assert.equal(r.paths.length,2);
    assert.ok(!r.before.some(g=>g.wallIndices.some(i=>walls[i].sourceId==='R13.0')),'upper corner strip must not create a ground-contact orphan or repair path');
    assert.ok(r.added.every(w=>w.kind==='gap-repair'));
    assert.equal(D.repair(walls,c.ground||c.options.ground,{pathSnap:.02}).gaps.length,0,'measured boundary heights also close the gap with strict matching');
    assert.equal(D.repair(r.walls,c.ground||c.options.ground).added.length,0);
});

test('guide matching tolerates freehand offset but does not accept a remote guide or change ground contact',()=>{
    const make=offset=>[wall('left',[-2,0],[0,0],0,5),wall('right',[2,0],[4,0],0,5),wall('guide',[-.1,offset],[2.1,offset],3,5)];
    const walls=make(.04),before=JSON.stringify(walls),r=D.repair(walls,0);
    assert.equal(r.paths.length,1);assert.equal(r.gaps.length,2);
    assert.ok(r.added.every(w=>w.bottom.every(p=>p.y===0)),'new walls must meet the actual open ends');
    assert.equal(JSON.stringify(walls),before);
    assert.equal(D.repair(make(.08),0).added.length,0,'guide outside matching tolerance must remain disconnected');
    const raised=walls.map(w=>({...w,bottom:w.bottom.map(p=>({...p,z:p.z+.04})),top:w.top.map(p=>({...p,z:p.z+.04}))}));
    assert.equal(D.repair(raised,0).before.length,0);
});
test('floating roof-layer edges are neither orphan candidates nor repair endpoints',()=>{
    const walls=corner().map(w=>({...w,bottom:w.bottom.map(p=>({...p,z:p.z+2})),top:w.top.map(p=>({...p,z:p.z+2}))}));
    assert.equal(D.detect(walls,0).length,0);
    const r=D.repair(walls,0);assert.equal(r.before.length,0);assert.equal(r.added.length,0);assert.equal(r.paths.length,0);
});
test('an upper open interval is ignored even when the same column has a closed ground-level wall',()=>{
    const a=wall('a',[0,0],[4,0],0,6),b=wall('b',[4,0],[4,4],0,3);
    assert.ok(!D.detect([a,b],0).some(g=>g.bottom.x===4&&g.bottom.y===0));
});
test('ground contact uses the local sloped mesh and excludes terrain outside its footprint',()=>{
    const T=require('../public/measure/internal/editor_scripts/ground_geometry.js');
    const ground=T.fromPlane({x0:-1,x1:5,y0:-1,y1:1},{dx:.5,dy:0,k:2});
    const w={...wall('slope',[0,0],[4,0],0,8),bottom:[p(0,0,2),p(4,0,4)]};
    assert.equal(D.detect([w],ground).length,2);assert.equal(D.detect([w],0).length,0);
    const outside=wall('outside',[10,0],[12,0],7,9);assert.equal(D.detect([outside],ground).length,0);
});
test('ground contact tolerates small numeric discrepancies, not suspended wall edges',()=>{
    assert.equal(D.detect([wall('near',[0,0],[4,0],.015,5)],0).length,2);
    assert.equal(D.detect([wall('above',[0,0],[4,0],.05,5)],0).length,0);
});

test('Close gaps removes a tiny corner face by intersecting its neighboring wall planes',()=>{
 const walls=[wall('a',[0,0],[3.98,0],0,3),wall('sliver',[3.98,0],[4,.02],0,3),wall('b',[4,.02],[4,4],0,3)],before=JSON.stringify(walls);
 const result=D.repair(walls,0);assert.deepEqual(result.sliversRemoved,['sliver']);assert.equal(result.walls.length,2);assert.ok(Math.hypot(result.walls[0].bottom[1].x-4,result.walls[0].bottom[1].y)<1e-8);assert.deepEqual(result.walls[1].bottom[0],result.walls[0].bottom[1]);assert.ok(!result.gaps.some(g=>g.bottom.x===4&&g.bottom.y===0));assert.equal(JSON.stringify(walls),before);
 assert.equal(D.repair(result.walls,0).sliversRemoved.length,0);
});
test('sliver cleanup preserves real returns, height transitions, and ambiguous junctions',()=>{
 const make=()=>[wall('a',[0,0],[3.98,0],0,3),wall('sliver',[3.98,0],[4,.02],0,3),wall('b',[4,.02],[4,4],0,3)];
 const wide=[wall('a',[0,0],[3.8,0],0,3),wall('return',[3.8,0],[4,.2],0,3),wall('b',[4,.2],[4,4],0,3)];assert.equal(D.cleanSlivers(wide).removed.length,0);
 const branch=make();branch.push(wall('branch',[3.98,0],[3.98,-3],0,3));assert.equal(D.cleanSlivers(branch).removed.length,0);
 const step=make();step[2].top[0].z=4;assert.equal(D.cleanSlivers(step).removed.length,0);
});

test('saved roof corners with centimeter top-height mismatch collapse without leaving a narrow face',()=>{
 for(const walls of require('./fixtures/sliver-corners.json')){const result=D.cleanSlivers(walls,.2);assert.deepEqual(result.removed,['sliver']);assert.equal(result.walls.length,2);const [a,b]=result.walls;assert.ok(a.bottom.some((p,i)=>b.bottom.some((q,j)=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-8&&Math.abs(a.top[i].z-b.top[j].z)<1e-8)));}
});
