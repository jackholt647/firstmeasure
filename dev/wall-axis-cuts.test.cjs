const test=require('node:test'),assert=require('node:assert/strict'),A=require('../public/measure/internal/editor_scripts/wall_axis_cuts.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');const p=(x,y,z=0)=>({x,y,z}),face={points:[p(0,0),p(4,0),p(4,4),p(0,4)]};
test('axis rays stop at the next line and reuse close existing boundary points',()=>{const node={...p(4,2.000004),id:'existing'},targets=A.targets(face,p(0,2),p(1,0),[],[node]);assert.equal(targets.length,1);assert.equal(targets[0].id,'existing');assert.equal(A.targets(face,p(0,2),p(1,0),[[p(2,0),p(2,4)]],[])[0].x,2);assert.equal(A.targets(face,p(0,0),p(0,1)).length,0,'No duplicate along an existing boundary');});
test('vertical wall cuts are exact in either direction and stop at openings',()=>{const wall={points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)],holes:[[p(1,0,1),p(3,0,1),p(3,0,3),p(1,0,3)]]};assert.deepEqual(A.wall(wall,p(2,0,0),'v'),[p(2,0,1)]);assert.deepEqual(A.wall(wall,p(2,0,4),'v'),[p(2,0,3)]);});
test('pitched-base perpendicular cuts remain in-plane and orthogonal to the source edge',()=>{const ps=[p(0,0,0),p(4,0,2),p(4,4,2),p(0,4,0)],frame=W.faceFrame({points:ps}),f={points:ps.map(p=>W.inFrame(frame,p))},start=W.inFrame(frame,p(2,0,1)),direction=A.perpendicular(f,start),target=A.targets(f,start,direction)[0],q=W.fromFrame(frame,target);assert.ok(Math.abs(q.z-q.x*.5)<1e-7);assert.ok(Math.abs(q.x-2)<1e-7);assert.ok(Math.abs(q.y-4)<1e-7);});


test('horizontal cuts fit below shallow slopes without snapping back onto the top edge',()=>{
 for(const rise of [.04,.004])for(const sign of [-1,1]){
  const start=p(0,2),f={points:[p(0,0),p(sign*4,0),p(sign*4,2+rise),start]};
  const hit=A.targets(f,start,p(1,0),[],f.points);
  assert.equal(hit.length,1);assert.ok(Math.abs(hit[0].x-sign*4)<1e-8);assert.equal(hit[0].y,2,'Keep the cut level instead of reusing the higher corner');
 }
 const flat={points:[p(0,0),p(4,0),p(4,2),p(0,2)]};assert.equal(A.targets(flat,p(0,2),p(1,0)).length,0,'Do not duplicate an actually horizontal boundary');
});

test('shallow-slope H stops at the first divider and does not jump across exterior space',()=>{
 const f={points:[p(0,0),p(4,0),p(4,2.004),p(0,2)]},hit=A.targets(f,p(0,2),p(1,0),[[p(2,0),p(2,2.002)]])[0];
 assert.deepEqual(hit,p(2,2));
 const notched={points:[p(0,0),p(4,0),p(4,4),p(2,4),p(2,2),p(1,2),p(1,4),p(0,4)]};
 assert.equal(A.targets(notched,p(1,3),p(1,0)).some(q=>q.x>1),false,'A ray pointing out of a concave face must not reach its far side');
});
