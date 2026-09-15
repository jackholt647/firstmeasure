const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const saved=require('./fixtures/inward-trim-area.json');
test('saved split front wall trims continuously across inward and outward depths',()=>{
 const before=JSON.stringify(saved),n=W.normal(saved.face.points);
 for(let step=-400;step<=400;step++){
  if(!step)continue;
  const amount=step*.01,extrusion=W.extrude(saved.face,amount,{supports:saved.neighbors});
  const result=W.trimExtrusion(extrusion.sides,saved.neighbors);
  assert.ok(result.replacements.length>=1,`adjoining wall must be trimmed at ${amount}`);
  assert.ok(result.replacements[0].pieces.length>0,`adjoining wall must survive at ${amount}`);
  for(const f of [...result.sides,...result.replacements.flatMap(r=>r.pieces)]){
   assert.ok(f.points.length>=3);assert.ok(W.normal(f.points));
   assert.ok(f.points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));
  }
  extrusion.cap.points.forEach((p,i)=>assert.ok(Math.hypot(p.x-saved.face.points[i].x-n.x*amount,p.y-saved.face.points[i].y-n.y*amount,p.z-saved.face.points[i].z-n.z*amount)<1e-10));
 }
 assert.equal(JSON.stringify(saved),before,'preview must not mutate saved geometry');
});
test('planar union keeps point-touching regions as two complete faces',()=>{
 const p=(x,y)=>({x,y,z:0}),r=W.unionPlanar([[p(0,0),p(1,0),p(1,1),p(0,1)],[p(1,1),p(2,1),p(2,2),p(1,2)]]);
 assert.equal(r.length,2);assert.ok(r.every(f=>f.points.length===4));
});
