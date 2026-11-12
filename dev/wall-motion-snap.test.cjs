const test=require('node:test'),assert=require('node:assert/strict'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),dir=p(0,1),screen=p=>({x:p.x*100,y:p.y*100});
test('motion snaps to a perpendicular wall corner from either side of the target',()=>{
 const c=require('./fixtures/move-gap-snap.json'),cap=c.faces.find(f=>f.id===c.sourceId),n=W.normal(cap.points);
 assert.equal(W.containedSnap(cap,-1.1,c.faces),null);
 for(const amount of [-1.08,-1.16]){const s=W.motionSnap(cap.points,[],n,amount,c.faces);assert.ok(s);assert.equal(s.kind,'Point');assert.ok(Math.abs(s.amount+1.1228114463963754)<1e-6);}
});
test('motion snaps a moving vertex to a finite oblique edge and rejects its extension',()=>{
 const opts={edges:[[p(-1,1),p(1,3)]],screen,radius:12};
 const hit=W.motionSnap([p(0,0)],[],dir,1.95,[],opts);assert.equal(hit.kind,'Edge');assert.equal(hit.amount,2);
 assert.equal(W.motionSnap([p(3,0)],[],dir,5,[],opts),null);
});
test('motion snaps an edge interior to retained and standalone points',()=>{
 const hit=W.motionSnap([p(-2,0),p(2,0)],[[p(-2,0),p(2,0)]],dir,1.96,[],{points:[p(.4,2)],screen,radius:12});assert.equal(hit.kind,'Point');assert.equal(hit.amount,2);
});
test('face intersections respect holes and do not snap to invisible or distant projected geometry',()=>{
 const face={points:[p(-2,2,-2),p(2,2,-2),p(2,2,2),p(-2,2,2)],holes:[[p(-1,2,-1),p(1,2,-1),p(1,2,1),p(-1,2,1)]]};
 assert.equal(W.motionSnap([p(0,0)],[],dir,1.98,[face]),null);
 assert.equal(W.motionSnap([p(1.5,0)],[],dir,1.98,[face]).kind,'Face');
 assert.equal(W.motionSnap([p(0,0)],[],dir,1,[],{points:[p(0,100)],screen:()=>({x:0,y:0}),radius:12,minPixelsPerMeter:33.33}),null);
 assert.equal(W.motionSnap([p(0,0)],[],dir,1.98,[],{points:[p(0,2)],screen:()=>({x:NaN,y:0}),radius:12}),null);
});
test('selected lines do not snap to each others old positions',()=>{
 const edges=[[p(-1,0),p(1,0)],[p(-1,2),p(1,2)]],opts={points:edges.flat(),edges,excludeMoving:true};
 assert.equal(W.motionSnap(edges.flat(),edges,dir,1.98,[],opts),null);
});
test('height snap aligns disconnected points and horizontal planes while preserving the movement axis',()=>{
 const points=[p(0,0,1),p(4,0,1)],edges=[points],direction=p(0,0,1),remote={points:[p(20,20,2),p(24,20,2),p(24,24,2),p(20,24,2)]};
 const snap=W.motionSnap(points,edges,direction,.96,[remote]);assert.equal(snap.kind,'Height');assert.equal(snap.amount,1);assert.equal(snap.target.z,2);assert.equal(snap.target.y,0);
 const tilted=W.motionSnap([p(0,0,1)],[],p(0,.8,.6),1.63,[],{heightPoints:[p(90,90,2)]});assert.equal(tilted.kind,'Height');assert.ok(Math.abs(tilted.amount-1/.6)<1e-9);
 assert.equal(W.motionSnap(points,edges,direction,.7,[remote]),null);
});

test('prepared extrusion snaps re-evaluate distance for each position and camera direction',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),point={x:0,y:0,z:0},direction={x:1,y:0,z:0},options={points:[{x:1,y:0,z:0},{x:2,y:0,z:0}],radius:12,minPixelsPerMeter:20},candidates=W.motionSnapCandidates([point],[],direction,[],options);
 for(const sign of [-1,1])for(const amount of [.95,1.5,1.99]){const screen=p=>({x:p.x*100*sign,y:p.z*100});assert.deepEqual(W.motionSnap([point],[],direction,amount,[],{...options,screen,candidates}),W.motionSnap([point],[],direction,amount,[],{...options,screen}));}
});

test('an extrusion snaps to the points of an edge its corner rides along',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),near=(a,b)=>Math.abs(a-b)<1e-9;
 // A line pushed sideways: its end sits on an oblique edge and follows it, so the end reaches that edge's far point
 // when the moved line passes through it, beyond the line's own length.
 const line=[p(0,0,0),p(2,0,0)],rail=[p(2,0,0),p(3,2,0)],found=W.motionSnapCandidates(line,[line],p(0,1,0),[],{edges:[rail],points:rail,excludeMoving:true});
 const hit=found.find(c=>c.kind==='Point'&&near(c.amount,2));assert.ok(hit,JSON.stringify(found.map(c=>[c.kind,c.amount])));assert.deepEqual(hit.target,p(3,2,0));
 const snap=W.motionSnap(line,[line],p(0,1,0),1.95,[],{candidates:found,radius:.15});assert.ok(snap&&near(snap.amount,2));
 // A face pushed along its normal: the same, with the moved plane.
 const ring=[p(0,0,0),p(2,0,0),p(2,0,2),p(0,0,2)],edges=ring.map((a,i)=>[a,ring[(i+1)%4]]),slope=[p(2,0,0),p(3,1.5,0)];
 const face=W.motionSnapCandidates(ring,edges,p(0,1,0),[],{edges:[slope],points:slope,excludeMoving:true});
 assert.ok(face.some(c=>c.kind==='Point'&&near(c.amount,1.5)&&c.target.x===3),JSON.stringify(face.map(c=>[c.kind,c.amount])));
 // An edge that only crosses near the line, without holding its end, adds nothing.
 const apart=[p(5,0,0),p(6,2,0)];assert.ok(!W.motionSnapCandidates(line,[line],p(0,1,0),[],{edges:[apart],excludeMoving:true}).some(c=>c.kind==='Point'&&near(c.amount,2)));
});

test('a line pushed along an edge that is a hair off square still snaps to a point on that edge, and lands on it',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z});
 // Measured from a real house: the wall the line is pushed along leaves the exact push direction by 0.13 mm in 7 m.
 const a=p(0,0,3),b=p(0,2,4),q=p(7,.00013,3),far=p(15,.00028,3),dir=p(1,0,0);
 const found=W.motionSnapCandidates([a,b],[[a,b]],dir,[],{points:[q,far],edges:[[a,q],[q,far]],excludeMoving:true}),hit=found.find(c=>c.kind==='Point'&&Math.abs(c.amount-7)<1e-3);
 assert.ok(hit,JSON.stringify(found.map(c=>[c.kind,c.amount])));assert.deepEqual(hit.target,q);
 // The exact way there: pushed by `shift`, the line's end is the point itself, not a twin 0.13 mm beside it.
 assert.deepEqual({x:a.x+hit.shift.x,y:a.y+hit.shift.y,z:a.z+hit.shift.z},q);
 assert.ok(W.motionSnap([a,b],[[a,b]],dir,6.9,[],{candidates:found,radius:.15})?.shift);
 // A point well off the edge's line is not a target: half a degree is the limit.
 const off=p(7,.2,3);assert.ok(!W.motionSnapCandidates([a,b],[[a,b]],dir,[],{points:[off],edges:[[a,p(7,0,3)]],excludeMoving:true}).some(c=>c.target===off));
 // Exactly on the push line there is nothing to correct: no shift.
 const exact=W.motionSnapCandidates([a,b],[[a,b]],dir,[],{points:[p(7,0,3)],edges:[[a,p(7,0,3)]],excludeMoving:true}).filter(c=>c.kind==='Point'&&Math.abs(c.amount-7)<1e-9);
 assert.ok(exact.length&&exact.every(c=>!c.shift));
});
