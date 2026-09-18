const test=require('node:test'),assert=require('node:assert/strict');
const root='../public/measure/internal/editor_scripts/',G=require(root+'wall_geometry'),R=require(root+'wall_rake_cleanup'),D=require(root+'wall_gaps'),B=require(root+'base_geometry'),C=require(root+'wall_chimneys'),A=require(root+'wall_chimney_cleanup');
const captured=require('./fixtures/stepped-eave-chimney.json');
function build(soffit=24){
 const state=structuredClone(captured);state.options={...state.options,soffit,defaultSoffitInches:18};state.sources=G.buildSources(state.roof,state.options).sources;state.wallEdits={};
 const run=ground=>G.mergeCoplanar(D.repair(G.deduplicate(G.extrude(state.roof,state.sources,ground).walls,state.options.tolerance).walls,ground).walls).walls;
 const raw=run(state.ground),pre=R.cleanup(raw,state.sources,state.ground);
 state.base=B.fromRoof(state.roof,state.ground,pre.walls,(soffit==='auto'?18:soffit)*G.INCH);state.chimneys=C.detect(state.roof);C.syncFoundation(state);C.syncVolumes(state);
 const walls=run(B.terrain(state.base)),clean=R.cleanup(walls,state.sources,B.terrain(state.base));state.base=R.foundation(state.base,clean.report);
 const aligned=A.cleanup(clean.walls,state.sources,C.definitions(state),B.terrain(state.base));state.base=A.foundation(state.base,aligned.report);
 const composed=A.compose(C.compose(aligned.walls,state),aligned.report);return {state,sources:state.sources,walls,raw,pre,clean,composed};
}
test('a collapsed soffit return closes before tracing the base and chimney walls',()=>{
 const before=JSON.stringify(captured),r=build();assert.equal(r.state.base.source,'Wall perimeter');
 assert.equal(r.pre.report.paths.filter(p=>p.parallelReturn).length,1);
 assert.equal(D.detect(r.composed,r.state.ground).length,0,'no open ground-reaching edges, including both chimney corners');
 assert.equal(r.state.chimneys.items.length,1);assert.ok(r.composed.some(w=>w.chimney),'chimney remains part of the exterior');
 const roofEdge=r.state.roof.connections[0],a=r.state.roof.points[roofEdge.startIdx],b=r.state.roof.points[roofEdge.endIdx],len=Math.hypot(a.x-b.x,a.y-b.y);
 const basePoints=C.buildingBase(r.state).flatMap(f=>f.points),distance=p=>Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))/len;
 assert.ok(Math.min(...basePoints.map(distance))>=24*G.INCH-.002,'foundation respects 24 inches instead of following the eave');
 assert.equal(JSON.stringify(captured),before);assert.ok(r.composed.every(w=>[...w.top,...w.bottom].every(p=>[p.x,p.y,p.z].every(Number.isFinite))));
 assert.equal(R.cleanup(r.clean.walls,r.sources,B.terrain(r.state.base)).report.paths.length,0,'regeneration is stable');
});
test('collapsed-return cleanup requires measured flashing evidence and respects edited walls',()=>{
 const r=build(),path=r.pre.report.paths.find(p=>p.parallelReturn);assert.ok(path);
 const blocked=R.cleanup(r.raw,r.sources,r.state.ground,path.removedIds);
 assert.ok(!blocked.report.paths.some(p=>p.parallelReturn));assert.ok(blocked.report.skippedEdited>0);
 const noGuide=R.cleanup(r.raw,r.sources.filter(s=>s.kind!=='flashing'),r.state.ground);
 assert.ok(!noGuide.report.paths.some(p=>p.parallelReturn),'nearby unconnected wings are not joined without source evidence');
 const noSoffit=R.cleanup(r.raw,r.sources.map(s=>({...s,setback:0})),r.state.ground);
 assert.ok(!noSoffit.report.paths.some(p=>p.parallelReturn));
});

for(const size of [12,18,'auto'])test(`chimney-covered stepped roof closes with ${size} soffit`,()=>{
 const r=build(size);assert.equal(r.state.base.source,'Wall perimeter');assert.equal(D.detect(r.composed,r.state.ground).length,0);
 assert.equal(r.state.chimneys.items.length,1);
});
