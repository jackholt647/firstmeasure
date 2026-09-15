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
