// A wall that leans by a hair (its top is offset 0.2 mm from its bottom) stays on its own plane when a pitched base
// moves its bottom corners. Moving them straight up left it off-plane, so every render threw after the pitch was
// placed and the editor showed the pre-placement preview frozen. Data from project fullhouse_ce52c5ebb595e2c7461e102f8478e89c.
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),F=require('../public/measure/internal/editor_scripts/wall_base_binding.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const fixture=require('./fixtures/base-pitch-lean.json'),copy=v=>JSON.parse(JSON.stringify(v));
const pitched=(deg,angle)=>{const next=copy(fixture.base),f=next.faces[0];Object.assign(f,B.transform(copy(f),'pitch',Math.tan(deg*Math.PI/180),{x:Math.cos(angle*Math.PI/180),y:Math.sin(angle*Math.PI/180)},B.center(f)));return next;};
test('a pitched base keeps a slightly leaning attached wall planar and on the base',()=>{
 for(const deg of [4,5.7,8,10])for(const angle of [0,45,90,180,225,270]){const after=pitched(deg,angle),wall=F.face(copy(fixture.surface),fixture.base,after),plane=G.plane(after.faces[0].points);
  assert.notEqual(wall,fixture.surface);assert.doesNotThrow(()=>K.normalizeFaces(copy(wall)),deg+'deg at '+angle);
  for(const p of wall.points.filter(p=>p.z<65))assert.ok(Math.abs(plane.dx*p.x+plane.dy*p.y+plane.k-p.z)<1e-4,'bottom stays on the base');
  for(const p of wall.points)assert.ok(Math.min(...fixture.surface.points.map(q=>Math.hypot(q.x-p.x,q.y-p.y)))<1e-4,'moves only by the lean');}
});
