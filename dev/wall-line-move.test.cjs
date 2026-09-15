const test=require('node:test'),assert=require('node:assert/strict'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z=0)=>({x,y,z});
test('line slide preserves a tilted face plane and shared endpoints without new faces',()=>{
 const rotate=p=>({x:p.x,y:p.y*.8,z:p.y*.6}),pair=[p(0,1),p(4,1)].map(rotate),faces=[{id:'a',points:[p(0,0),p(4,0),p(4,1),p(0,1)].map(rotate)},{id:'b',points:[p(0,1),p(4,1),p(4,4),p(0,4)].map(rotate)}],before=JSON.stringify(faces);
 const r=W.slideLines(faces,[pair],{x:0,y:.8,z:.6},.7);assert.equal(r.faces.length,2);for(const f of r.faces)for(const q of r.pairs[0])assert.ok(f.points.some(p=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-9));assert.equal(JSON.stringify(faces),before);
});
test('invalid line move rejects the preview instead of detaching adjacent faces',()=>{
 const faces=[{id:'front',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]},{id:'side',points:[p(4,0,0),p(4,3,0),p(4,3,4),p(4,0,4)]}];
 const before=JSON.stringify(faces);assert.throws(()=>W.slideLines(faces,[[p(0,0,4),p(4,0,4)]],{x:0,y:0,z:1},-4));assert.equal(JSON.stringify(faces),before);
});
