const test=require('node:test'),assert=require('node:assert/strict');
const root='../public/measure/internal/editor_scripts/',G=require(root+'wall_geometry'),R=require(root+'wall_rake_cleanup'),D=require(root+'wall_gaps'),B=require(root+'base_geometry'),C=require(root+'wall_chimneys'),A=require(root+'wall_chimney_cleanup');
const captured=require('./fixtures/stepped-eave-chimney.json');
function build(soffit=24,fixture=captured){
 const state=structuredClone(fixture);state.options={...state.options,soffit,defaultSoffitInches:18};state.sources=G.buildSources(state.roof,state.options).sources;state.wallEdits={};
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

for(const size of [12,18,24,'auto'])test(`the middle rake keeps the deeper soffit with ${size}, even beside a longer eave`,()=>{
 const r=build(size),setback=(size==='auto'?18:size)*G.INCH;
 const upper=r.sources.filter(s=>s.id.startsWith('R11.')),middle=r.sources.filter(s=>s.id.startsWith('R12.'));
 assert.ok(upper.length&&middle.length);
 for(const s of [...upper,...middle])assert.ok(Math.abs(s.setback-setback)<1e-7,'the middle rake must not lose soffit depth to the lower eave');
 const anchor=upper[0],u={x:anchor.b.x-anchor.a.x,y:anchor.b.y-anchor.a.y},length=Math.hypot(u.x,u.y);
 for(const w of r.composed.filter(w=>w.sourceId?.startsWith('R12.')&&!w.soffitReturn))for(const p of w.bottom)assert.ok(Math.abs((p.x-anchor.a.x)*u.y-(p.y-anchor.a.y)*u.x)/length<.002,'middle wall lines up with the upper rake across the chimney');
 for(const s of r.sources.filter(s=>s.kind==='perimeter'&&!s.envelopeReturn))assert.ok(s.setback>=setback-1e-7,'alignment only preserves or increases the selected overhang');
 assert.ok(r.pre.report.paths.some(p=>p.parallelReturn),'the clipped transition closes after choosing the deeper wall plane');
 assert.equal(D.detect(r.composed,r.state.ground).length,0);assert.equal(r.state.base.source,'Wall perimeter');
 const again=R.cleanup(r.clean.walls,r.sources,B.terrain(r.state.base));assert.equal(again.report.paths.length,0,'cleanup does not move the corner a second time');
});

test('hidden roof-return evidence closes the deeper inset without crossing protected edits',()=>{
 const r=build(18),path=r.pre.report.paths.find(p=>p.parallelReturn);assert.ok(path);
 assert.ok(r.sources.some(s=>s.outerEnvelope?.returnGuides?.length));
 const protectedResult=R.cleanup(r.raw,r.sources,r.state.ground,path.removedIds);assert.ok(!protectedResult.report.paths.some(p=>p.parallelReturn));assert.ok(protectedResult.report.skippedEdited>0);
 const noEvidence=r.sources.filter(s=>s.kind!=='flashing').map(s=>({...s,outerEnvelope:s.outerEnvelope?{...s.outerEnvelope,returnGuides:[]}:undefined}));
 assert.ok(!R.cleanup(r.raw,noEvidence,r.state.ground).report.paths.some(p=>p.parallelReturn));
});

test('the deeper-soffit transition is stable under rotation and roof-face ordering',()=>{
 const angle=.71,c=Math.cos(angle),s=Math.sin(angle),transform=p=>({...p,x:c*p.x-s*p.y+20,y:s*p.x+c*p.y-10}),rotated=structuredClone(captured);
 rotated.roof.points=rotated.roof.points.map(transform);rotated.roof.faces=rotated.roof.faces.map(f=>({...f,points:f.points.map(transform),holes:(f.holes||[]).map(r=>r.map(transform))})).reverse();
 rotated.ground.points=rotated.ground.points.map(transform);rotated.ground.plane=G.plane(rotated.ground.points);
 const a=build(18),b=build(18,rotated);assert.equal(b.state.base.source,'Wall perimeter');assert.equal(D.detect(b.composed,b.state.ground).length,0);
 assert.equal(b.composed.length,a.composed.length);
 for(const w of a.composed){const q=b.composed.find(q=>q.id===w.id);assert.ok(q,w.id);for(const edge of ['bottom','top'])for(let i=0;i<2;i++){const p=transform(w[edge][i]),v=q[edge][i];assert.ok(Math.hypot(p.x-v.x,p.y-v.y,p.z-v.z)<1e-5,w.id);}}
});

for(const angle of [0,.71,2.1])test(`nearby wall corners retain their repaired strip after foundation tracing at ${angle}`,()=>{
 const f=structuredClone(require('./fixtures/nearby-wall-corners.json')),rotate=p=>{const x=p.x,y=p.y;p.x=x*Math.cos(angle)-y*Math.sin(angle);p.y=x*Math.sin(angle)+y*Math.cos(angle);};
 f.roof.points.forEach(rotate);f.roof.faces.forEach(face=>face.points.forEach(rotate));f.ground.points.forEach(rotate);
 const before=JSON.stringify(f),r=build('auto',f);assert.equal(r.state.base.source,'Wall perimeter');assert.ok(r.raw.some(w=>w.kind==='gap-repair'));assert.ok(r.composed.some(w=>w.kind==='gap-repair'),'the repaired wall survives the base-bound generation');assert.equal(D.detect(r.composed,f.ground).length,0);assert.equal(JSON.stringify(f),before);
 for(const w of r.raw.filter(w=>w.kind==='gap-repair'))for(const p of [...w.bottom,{x:(w.bottom[0].x+w.bottom[1].x)/2,y:(w.bottom[0].y+w.bottom[1].y)/2}])assert.ok(C.buildingBase(r.state).some(face=>G.contains(face,p)),'base covers the actual repaired wall, not a snapped approximation');
});
