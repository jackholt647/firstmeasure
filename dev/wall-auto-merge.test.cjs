const test=require('node:test'),assert=require('node:assert/strict'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const w=(id,x0,x1,z0,z1,y=0)=>({id,sourceId:id,kind:'perimeter',bottom:[{x:x0,y,z:z0},{x:x1,y,z:z0}],top:[{x:x0,y,z:z1},{x:x1,y,z:z1}]});
test('coplanar pass merges stepped outlines across kinds and removes internal edges',()=>{
 const walls=[w('a',0,2,0,4),{...w('b',2,4,0,2),kind:'gap-repair'},w('c',2,4,2,3)],before=JSON.stringify(walls),r=G.mergeCoplanar(walls),geo=G.topology(r.walls);
 assert.equal(r.removed,2);assert.equal(geo.faces.length,1);assert.equal(geo.faces[0].area,14);assert.equal(JSON.stringify(walls),before);assert.equal(G.topology(G.mergeCoplanar(r.walls).walls).faces.length,1);
});
test('coplanar pass preserves disconnected faces, point contacts, offsets and protected edits',()=>{
 const a=w('a',0,2,0,2);for(const b of [w('b',3,4,0,2),w('b',2,4,2,4),w('b',2,4,0,2,.02)])assert.equal(G.mergeCoplanar([a,b]).removed,0);
 assert.equal(G.mergeCoplanar([a,w('b',2,4,0,2)],['a']).removed,0);
});
test('merged wall retains a complete opening and correct filled area',()=>{
 const walls=[w('a',0,1,0,4),w('b',3,4,0,4),w('c',1,3,0,1),w('d',1,3,3,4)],r=G.mergeCoplanar(walls),geo=G.topology(r.walls);
 assert.equal(r.removed,3);assert.equal(geo.faces.length,1);assert.equal(geo.faces[0].area,12);
 for(const [x,z] of [[1,1],[3,1],[3,3],[1,3]])assert.ok(geo.connections.some(e=>[e.startIdx,e.endIdx].some(i=>geo.points[i].x===x&&geo.points[i].z===z)));
});

test('flashing alignment requires roof provenance, endpoint contact and bounded drift',()=>{
 const target={...w('target',0,5,0,3),sourceRoofId:1};
 const flashing={...w('flashing',4,5,2,3,.007),kind:'flashing',sourceRoofId:2,targetId:1};
 const next={...w('next',5,9,0,3,.007),sourceRoofId:2};
 next.bottom[1].y=next.top[1].y=.02;
 const aligned=G.deduplicate([target,flashing,next]).walls.find(w=>w.id==='next');
 assert.ok([...aligned.bottom,...aligned.top].every(p=>Math.abs(p.y)<1e-8));
 for(const variant of ['wrong roof','no contact','large offset']){
  const other=structuredClone(next);
  if(variant==='wrong roof')other.sourceRoofId=3;
  if(variant==='no contact')for(const p of [...other.top,...other.bottom])p.x+=1;
  if(variant==='large offset')other.top[1].y=other.bottom[1].y=.04;
  const before=JSON.stringify(other),after=G.deduplicate([target,flashing,other]).walls.find(w=>w.id==='next');
  assert.deepEqual(after.bottom[1],other.bottom[1],variant);assert.deepEqual(after.top[1],other.top[1],variant);assert.equal(JSON.stringify(other),before);
 }
});

test('only sub-5mm tapered flashing tips collapse, not intentional wall corners',()=>{
 for(const [kind,tip,collapse]of [['flashing',.004,true],['flashing',.02,false],['perimeter',.004,false]]){
  const wall={...w('taper',0,2,2,3),kind};wall.top[1].z=2+tip;
  const result=G.deduplicate([wall]).walls[0];assert.ok(result);
  assert.equal(result.top[1].z,collapse?2:2+tip);assert.equal(wall.top[1].z,2+tip);
 }
});
