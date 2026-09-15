const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const B=require('../public/measure/internal/editor_scripts/base_geometry.js');
const D=require('../public/measure/internal/editor_scripts/wall_gaps.js');
const fixture=require('./fixtures/narrow-roof-foundation.json');
const repair=sources=>D.repair(G.deduplicate(G.extrude(fixture.roof,sources,fixture.ground).walls,fixture.options.tolerance).walls,fixture.ground).walls;
test('narrow roof uses independent flashing for setback and retains the short eave',()=>{
 const before=JSON.stringify(fixture),r=G.buildSources(fixture.roof,fixture.options);
 const eave=r.sources.find(s=>s.id.startsWith('R7.'));
 assert.ok(eave);assert.ok(Math.hypot(eave.a.x-eave.b.x,eave.a.y-eave.b.y)>.5);
 const base=B.fromRoof(fixture.roof,fixture.ground,repair(r.sources));
 assert.equal(base.source,'Wall perimeter');
 const extruded=G.extrude(fixture.roof,r.sources,B.terrain(base));
 assert.equal(extruded.warnings.length,0);assert.equal(extruded.walls.length,17);
 for(const source of r.sources.filter(s=>s.kind==='perimeter'))assert.ok(extruded.walls.some(w=>w.sourceId===source.id));
 assert.equal(JSON.stringify(fixture),before);
});
test('incomplete legacy triangle upgrades without replacing an edited foundation',()=>{
 const old=repair(G.buildSources(fixture.roof,fixture.options).sources);
 const next=B.repairInitial(fixture.legacyBase,fixture.roof,fixture.ground,old);
 assert.notEqual(next,fixture.legacyBase);assert.equal(next.source,'Wall perimeter');
 assert.equal(G.extrude(fixture.roof,G.buildSources(fixture.roof,fixture.options).sources,B.terrain(next)).warnings.length,0);
 const edited=structuredClone(fixture.legacyBase);edited.faces[0].points[0].z+=1;
 assert.equal(B.repairInitial(edited,fixture.roof,fixture.ground,old),edited);
 const drawn=structuredClone(fixture.legacyBase);drawn.sketch.nodes.push({id:'user',fixed:false,x:7,y:0,z:158});
 assert.equal(B.repairInitial(drawn,fixture.roof,fixture.ground,old),drawn);
});

test('sloping measured roof boundary dedupes against flashing without a fitted-plane wedge',()=>{
 for(const angle of [0,.37,Math.PI/2]){
  const c=structuredClone(fixture),rotate=p=>{const x=p.x,y=p.y;p.x=x*Math.cos(angle)-y*Math.sin(angle);p.y=x*Math.sin(angle)+y*Math.cos(angle);};
  c.roof.points.forEach(rotate);c.roof.faces.forEach(f=>f.points.forEach(rotate));c.ground.points.forEach(rotate);
  const before=JSON.stringify(c.roof),sources=G.buildSources(c.roof,c.options).sources;
  const extruded=G.extrude(c.roof,sources,c.ground).walls,flashing=extruded.find(w=>w.id==='R13:0');
  const touching=extruded.find(w=>w.id==='R8.1:0');assert.ok(touching);assert.ok(flashing);
  for(const p of touching.bottom){
   const [a,b]=flashing.bottom,dx=b.x-a.x,dy=b.y-a.y,t=((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy);
   assert.ok(Math.abs(p.z-(a.z+(b.z-a.z)*t))<1e-6);
  }
  const result=G.deduplicate(extruded,c.options.tolerance);
  assert.ok(!result.walls.some(w=>w.id==='R8.1:0'),'no residual wedge under the flashing');
  assert.ok(result.walls.some(w=>w.id==='R13:0'));assert.ok(result.walls.some(w=>w.id==='R8.0:0'));
  assert.equal(JSON.stringify(c.roof),before);
 }
});

test('Close gaps joins the narrow break in one sloping source below floating flashing',()=>{
 const c=fixture,sources=G.buildSources(c.roof,c.options).sources;
 const walls=G.deduplicate(G.extrude(c.roof,sources,c.ground).walls,c.options.tolerance).walls,before=JSON.stringify(walls);
 const left=walls.find(w=>w.sourceId==='R12.0'),right=walls.find(w=>w.sourceId==='R12.2');
 assert.ok(Math.hypot(left.bottom[1].x-right.bottom[0].x,left.bottom[1].y-right.bottom[0].y)>.03);
 const result=D.repair(walls,c.ground),a=result.walls.find(w=>w.sourceId==='R12.0'),b=result.walls.find(w=>w.sourceId==='R12.2');
 assert.deepEqual(a.bottom[1],b.bottom[0]);assert.deepEqual(a.top[1],b.top[0]);
 assert.ok(!result.gaps.some(g=>Math.hypot(g.bottom.x-a.bottom[1].x,g.bottom.y-a.bottom[1].y)<.05));
 assert.equal(JSON.stringify(walls),before);
 assert.deepEqual(result.walls.find(w=>w.sourceId==='R14'),walls.find(w=>w.sourceId==='R14'));
});
test('tiny source-break repair preserves distinct sources, larger openings and height steps',()=>{
 const wall=(id,x0,x1,z=3)=>({id,sourceId:id,kind:'perimeter',bottom:[{x:x0,y:0,z:0},{x:x1,y:0,z:0}],top:[{x:x0,y:0,z},{x:x1,y:0,z}]});
 for(const pair of [[wall('R1.0',0,1),wall('R2.0',1.03,2)],[wall('R1.0',0,1),wall('R1.2',1.1,2)],[wall('R1.0',0,1),wall('R1.2',1.03,2,4)]]){
  const r=D.repair(pair,0);assert.deepEqual(r.walls,pair);
 }
});
