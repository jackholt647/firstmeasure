const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('./roof-generation-fixture.cjs');
const fixture=require('./fixtures/canopy-junction-roof.json');
const G=require('../public/measure/internal/editor_scripts/wall_geometry');
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function rotated(angle){
 const f=structuredClone(fixture),c=Math.cos(angle),s=Math.sin(angle),point=p=>({...p,x:c*p.x-s*p.y,y:s*p.x+c*p.y});
 f.roof.points=f.roof.points.map(point);for(const face of f.roof.faces){face.points=face.points.map(point);face.holes=(face.holes||[]).map(r=>r.map(point));}
 f.ground.points=f.ground.points.map(point);f.ground.plane=G.plane(f.ground.points);
 // Let the same production detection infer the rotated chimney geometry.
 delete f.chimneys;return f;
}
for(const angle of [0,.71,2.1])test(`captured canopy junction follows one measured back edge and closes both upper-wall ends at rotation ${angle}`,()=>{
 const f=rotated(angle),before=JSON.stringify(f),r=build(f),awning=f.roof.faces.find(f=>f.id===21),[a,b]=[awning.points[3],awning.points[2]];
 const walls=r.composed.filter(w=>w.sourceRoofId===15&&w.targetId===21);
 assert.ok(walls.length,'main wall above the narrow awning exists');
 for(const w of walls)for(const p of [...w.top,...w.bottom])assert.ok(G.onEdge(p,a,b,.00001),'all fragments share the actual awning back edge, without independent midpoint offsets');
 for(const p of [a,b]){
  const endpoints=walls.flatMap(w=>w.bottom),gap=Math.min(...endpoints.map(q=>distance(p,q)));
  assert.ok(gap<.00001,`upper wall reaches the measured corner, gap ${gap}`);
 }
 const main=r.state.sources.find(s=>s.originalA&&s.boundaryContactRoofIds?.includes(21)&&s.parentId===15);
 assert.ok(main,'the unlabelled lower back edge supplies the upper wall contact');
 assert.ok(!r.composed.some(w=>w.sourceRoofId===15&&w.targetId===2&&w.id.includes('upper-contact')),'the upper wall does not jump forward onto a different lower roof at its end');
 assert.ok(!r.composed.some(w=>w.sourceId?.split('.')[0]===main.id.split('.')[0]&&String(w.targetId).startsWith('ground')&&distance(...w.bottom)<.5),'no narrow full-height front return from the combined-roof miter');
 assert.equal(r.open.length,0,'ground perimeter remains closed');
 assert.equal(JSON.stringify(f),before,'generation never mutates input roof or grade');
});
