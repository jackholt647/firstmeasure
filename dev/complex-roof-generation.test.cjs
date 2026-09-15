const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),D=require('../public/measure/internal/editor_scripts/wall_gaps.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
const input=require('./fixtures/complex-roof-corner.json');
function build(){const state=structuredClone(input),sources=G.buildSources(state.roof,state.options).sources;
 const run=ground=>D.repair(G.deduplicate(G.extrude(state.roof,sources,ground).walls,state.options.tolerance).walls,ground).walls;
 const initial=run(state.ground);state.base=B.fromRoof(state.roof,state.ground,initial);state.chimneys=C.detect(state.roof);state.wallEdits={};C.syncFoundation(state);C.syncVolumes(state);
 const walls=G.mergeCoplanar(run(B.terrain(state.base))).walls;return {state,sources,walls,composed:C.compose(walls,state)};
}
test('captured intricate roof produces a closed wall footprint and exposed chimney without modifying the roof',()=>{
 const before=JSON.stringify(input),{state,composed}=build();assert.equal(state.base.source,'Wall perimeter');assert.equal(D.detect(composed,state.ground).length,0);
 const sides=composed.filter(w=>w.chimney);assert.equal(new Set(sides.map(w=>w.chimney.side)).size,3);
 for(const w of sides){const upper=state.wallEdits.$surfaces.find(f=>f.chimney?.volume&&f.chimney.side===w.chimney.side);
  for(const p of w.top)assert.ok(upper.points.some((a,i)=>{const b=upper.points[(i+1)%upper.points.length],dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz,t=l2?((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2:0;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy,p.z-a.z-t*dz)<1e-5;}),'upper and lower chimney share their roof contact');
 }
 assert.equal(JSON.stringify(input),before);
});
test('collinear back gable rakes share an inferred setback and merge into one wall plane',()=>{
 const {sources,walls,composed}=build(),rakes=sources.filter(s=>/^R(17|18)\./.test(s.id));assert.ok(rakes.length>=2);assert.equal(new Set(rakes.map(s=>s.setback)).size,1);
 const back=walls.filter(w=>/^R(17|18)\./.test(w.sourceId));assert.equal(new Set(back.map(w=>w.mergeGroup)).size,1);assert.ok(back[0].mergeGroup);
 const topology=G.topology(composed);assert.equal(topology.faces.filter(f=>f.mergeGroup===back[0].mergeGroup).length,1);
 assert.equal(new Set(walls.map(w=>w.id)).size,walls.length,'deduplication fragments must have distinct IDs');
});
test('a chimney roof opening does not interrupt the supporting wall run before chimney composition',()=>{
 const {sources}=build(),pieces=sources.filter(s=>s.id.startsWith('R10.'));assert.ok(pieces.length);
 const a=pieces[0].a,b=pieces.at(-1).b,distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);assert.ok(Math.abs(pieces.reduce((sum,p)=>sum+distance(p.a,p.b),0)-distance(a,b))<1e-6);
});
test('millimetre flashing drift does not generate vertical strips beside the captured chimney',()=>{
 const {walls,composed}=build(),back=walls.find(w=>w.sourceId==='R23'),group=back.mergeGroup;
 assert.ok(group);
 for(const id of ['R17.1','R18.0','gap-fill-1.0','gap-fill-1.1'])assert.ok(walls.some(w=>w.sourceId===id&&w.mergeGroup===group),`${id} joins the back wall`);
 const geo=G.topology(composed),face=geo.faces.find(f=>f.mergeGroup===group);
 const columns=face.boundary.filter(([i,j])=>{const a=geo.points[i],b=geo.points[j];return Math.hypot(a.x-b.x,a.y-b.y)<1e-5&&Math.abs(a.z-b.z)>1;});
 assert.equal(columns.length,2,'only the outer wall corners have full-height boundaries');
 assert.ok(!walls.some(w=>w.sourceId==='R17.0'),'no skinny ledge remains above the flashing');
 const cornerReturn=walls.find(w=>w.sourceId==='R22.0');
 const length=Math.hypot(cornerReturn.bottom[1].x-cornerReturn.bottom[0].x,cornerReturn.bottom[1].y-cornerReturn.bottom[0].y);
 assert.ok(length>.055&&length<.065,'the real six-centimetre roof return is retained');
});
test('short flashing extends along its existing line to close inset wall returns only at matching heights',()=>{
 const p=(x,y,z)=>({x,y,z}),wall=(id,a,b,lo,hi,kind='perimeter')=>({id,sourceId:id,kind,bottom:[p(...a,lo),p(...b,lo)],top:[p(...a,hi),p(...b,hi)]});
 const make=()=>[wall('left',[-4,0],[0,0],0,3),wall('right',[.35,0],[.35,4],0,3),wall('flashing',[-.05,0],[.1,0],3,4,'flashing')];
 const before=make(),result=D.repair(before,0);assert.ok(result.added.length);assert.ok(!result.gaps.some(g=>Math.hypot(g.bottom.x,g.bottom.y)<.01||Math.hypot(g.bottom.x-.35,g.bottom.y)<.01));
 const floating=make();floating[2].bottom.forEach(p=>p.z+=.5);assert.equal(D.repair(floating,0).added.length,0);
 const remote=make();remote[2].bottom.forEach(p=>p.y+=.1);remote[2].top.forEach(p=>p.y+=.1);assert.equal(D.repair(remote,0).added.length,0);
});
