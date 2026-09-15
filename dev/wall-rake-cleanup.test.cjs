const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../public/measure/internal/editor_scripts/wall_rake_cleanup.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const D=require('../public/measure/internal/editor_scripts/wall_gaps.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
const captured=require('./fixtures/complex-roof-corner.json');
const copy=v=>structuredClone(v),p=(x,y,z=0)=>({x,y,z}),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
function example(width=.3,depth=.1){
 const outline=[p(-4,0),p(0,0),p(0,-depth),p(width,-depth),p(width,4),p(-4,4)];
 const walls=outline.map((a,i)=>({id:'w'+i,sourceId:'s'+i,kind:'perimeter',sourceRoofId:i===0?'main':'return',type:[1,3].includes(i)?'rake':'eave',bottom:[a,outline[(i+1)%outline.length]],top:[a,outline[(i+1)%outline.length]].map(a=>({...a,z:4+a.y*.1}))}));
 const sources=walls.map(w=>({id:w.sourceId,type:w.type,setback:.5,a:w.top[0],b:w.top[1],originalA:{...w.top[0],x:w.top[0].x+.5}}));
 return {walls,sources,ground:0,base:{source:'Wall perimeter',faces:[{id:'floor',material:'default',points:outline}]}};
}
test('a nested rake return straightens to the outer rake and shares one top/bottom column',()=>{
 const s=example(),before=copy(s),r=R.cleanup(s.walls,s.sources,s.ground);
 assert.equal(r.report.paths.length,1);assert.equal(r.walls.length,4);assert.equal(D.detect(r.walls,0).length,0);
 const a=r.walls.find(w=>w.id==='w0'),d=r.walls.find(w=>w.id==='w3');
 near(a.bottom[1].x,.3);near(a.bottom[1].y,0);assert.deepEqual(a.bottom[1],d.bottom[0]);assert.deepEqual(a.top[1],d.top[0]);
 assert.deepEqual(s,before);assert.deepEqual(R.cleanup(r.walls,s.sources,0).walls,r.walls,'repeated cleanup is stable');
 const base=R.foundation(s.base,r.report);near(Math.abs(require('../public/measure/internal/editor_scripts/exterior_geometry.js').area(base.faces[0])),17.2);
 assert.equal(base.faces[0].material,'default');assert.ok(base.faces[0].points.every(p=>p.y>=-1e-5));
});
test('zero soffit, large returns, non-rakes, outward nested rakes and protected walls remain unchanged',()=>{
 for(const scenario of ['no soffit','wide','deep','not rake','outside','protected','branch']){
  const s=example(scenario==='wide'?.8:.3,scenario==='deep'?.8:.1);
  if(scenario==='no soffit')s.sources.forEach(s=>s.setback=0);
  if(scenario==='not rake')s.sources[1].type='eave';
  if(scenario==='outside')s.sources[3].originalA.x-=1;
  if(scenario==='branch')s.walls.push({id:'branch',kind:'perimeter',bottom:[p(0,0),p(0,2)],top:[p(0,0,4),p(0,2,4)]});
  const r=R.cleanup(s.walls,s.sources,0,scenario==='protected'?['w0']:[]);
  assert.equal(r.report.paths.length,0,scenario);assert.deepEqual(r.walls,s.walls,scenario);
  if(scenario==='protected')assert.equal(r.report.skippedEdited,1);
 }
});
test('foundation cleanup removes obsolete generated corners but preserves independent drawing points',()=>{
 const s=example(),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
 S.ensure(s.base);const point=S.add(s.base,p(-1,2));const r=R.cleanup(s.walls,s.sources,0),base=R.foundation(s.base,r.report);
 assert.ok(base.sketch.nodes.some(n=>n.id===point&&n.x===-1&&n.y===2));
 assert.ok(base.sketch.nodes.every(n=>n.y>=-1e-5));
 assert.ok(!base.sketch.nodes.some(n=>Math.hypot(n.x,n.y)<1e-5),'old intermediate corner does not remain as a generated point');
});
test('oblique and rotated wall planes use their geometric intersection on sloped ground',()=>{
 const s=example(),transform=p=>({x:12+(p.x+.25*p.y)*Math.cos(.73)-p.y*Math.sin(.73),y:-5+(p.x+.25*p.y)*Math.sin(.73)+p.y*Math.cos(.73),z:p.z+.03*p.x+.02*p.y});
 s.walls.forEach(w=>{w.bottom=w.bottom.map(transform);w.top=w.top.map(transform);});s.sources.forEach(s=>{s.a=transform(s.a);s.b=transform(s.b);s.originalA=transform(s.originalA);});
 const points=[p(-8,-8),p(8,-8),p(8,8),p(-8,8)].map(transform),ground={points,faces:[[0,1,2],[0,2,3]]};
 const r=R.cleanup(s.walls,s.sources,ground);assert.equal(r.report.paths.length,1);assert.equal(D.detect(r.walls,ground).length,0);
 const expected=transform(p(.3,0));for(const key of ['x','y','z'])near(r.report.paths[0].intersection[key],expected[key]);
});
test('the captured corner removes the small rake/eave return and flashing while keeping chimney and roof',()=>{
 const state=copy(captured),before=JSON.stringify(state.roof),sources=G.buildSources(state.roof,state.options).sources;
 const run=ground=>G.mergeCoplanar(D.repair(G.deduplicate(G.extrude(state.roof,sources,ground).walls,state.options.tolerance).walls,ground).walls).walls;
 state.base=B.fromRoof(state.roof,state.ground,run(state.ground));state.wallEdits={};state.chimneys=C.detect(state.roof);C.syncFoundation(state);C.syncVolumes(state);
 const walls=run(B.terrain(state.base)),r=R.cleanup(walls,sources,B.terrain(state.base));
 assert.equal(r.report.paths.length,1);assert.equal(r.report.paths[0].extendedSource,'R17.1');assert.ok(r.report.paths[0].rakeSource.startsWith('R10.'));
 for(const id of ['R21.0','R22.0','R23','R24'])assert.ok(!r.walls.some(w=>w.sourceId===id),`${id} no longer builds a return`);
 state.base=R.foundation(state.base,r.report);const composed=C.compose(r.walls,state);
 assert.equal(D.detect(composed,state.ground).length,0);assert.equal(G.topology(composed).faces.length,10);assert.equal(composed.filter(w=>w.chimney).length,3);
 assert.equal(JSON.stringify(state.roof),before);assert.ok(state.base.chimneyFoundationParts.length);
 const corrected=r.report.setbackCorrections;assert.equal(corrected.length,1);near(corrected[0].before,.2177728570388219);near(corrected[0].after,18*G.INCH);
 for(const w of r.walls.filter(w=>/^R(17|18)\./.test(w.sourceId))){
  const source=sources.find(s=>s.id===w.sourceId),a=source.originalA,b=source.originalB,dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  for(const p of w.bottom)near(Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/len,18*G.INCH);
 }
 const back=r.walls.find(w=>w.rakeCleanup),corner=back.bottom.find(p=>Math.hypot(p.x-r.report.paths[0].finalIntersection.x,p.y-r.report.paths[0].finalIntersection.y)<1e-5);
 assert.ok(C.buildingBase(state).some(f=>f.points.some(p=>Math.hypot(p.x-corner.x,p.y-corner.y)<1e-5)),'foundation reaches the new wall intersection');
 // Surviving evidence on the other half of a gable must govern both halves,
 // including when it confirms the old distance instead of changing it.
 const other=sources.find(s=>s.id==='R18.0'),dx=other.originalB.x-other.originalA.x,dy=other.originalB.y-other.originalA.y,len=Math.hypot(dx,dy),n={x:-dy/len,y:dx/len};
 if((other.a.x-other.originalA.x)*n.x+(other.a.y-other.originalA.y)*n.y<0){n.x*=-1;n.y*=-1;}
 for(const setback of [other.setback,.6096]){
  const flashing={id:'surviving-flashing',kind:'flashing',parentId:'other-roof',a:{...other.originalA,x:other.originalA.x+n.x*setback,y:other.originalA.y+n.y*setback,z:150},b:{...other.originalB,x:other.originalB.x+n.x*setback,y:other.originalB.y+n.y*setback,z:150}};
  const next=R.cleanup(walls,[...sources,flashing],state.ground);
  for(const w of next.walls.filter(w=>/^R(17|18)\./.test(w.sourceId)))for(const p of w.bottom)near(Math.abs((p.x-other.originalA.x)*dy-(p.y-other.originalA.y)*dx)/len,setback);
 }
});
