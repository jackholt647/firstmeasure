const test=require('node:test'),assert=require('node:assert/strict');
const root='../public/measure/internal/editor_scripts/',G=require(root+'wall_geometry'),R=require(root+'wall_rake_cleanup'),D=require(root+'wall_gaps'),B=require(root+'base_geometry'),C=require(root+'wall_chimneys'),A=require(root+'wall_chimney_cleanup');
const captured=require('./fixtures/complex-roof-corner.json');
function build(options={soffit:'auto',defaultSoffitInches:18},roof=captured.roof){
 const state=structuredClone(captured);state.roof=structuredClone(roof);state.options={...state.options,...options};
 const sources=G.buildSources(state.roof,state.options).sources,run=ground=>G.mergeCoplanar(D.repair(G.deduplicate(G.extrude(state.roof,sources,ground).walls,state.options.tolerance).walls,ground).walls).walls;
 state.base=B.fromRoof(state.roof,state.ground,R.cleanup(run(state.ground),sources,state.ground).walls,.4572);state.wallEdits={};state.chimneys=C.detect(state.roof);C.syncFoundation(state);C.syncVolumes(state);
 const walls=run(B.terrain(state.base)),clean=R.cleanup(walls,sources,B.terrain(state.base));state.base=R.foundation(state.base,clean.report);
 const aligned=A.cleanup(clean.walls,sources,C.definitions(state),B.terrain(state.base));state.base=A.foundation(state.base,aligned.report);
 const composed=A.compose(C.compose(aligned.walls,state),aligned.report);return {state,sources,walls,clean,composed};
}
test('the longer soffit controls only the overlap, while the exposed rake and chimney corner stay put',()=>{
 const original=JSON.stringify(captured),r=build(),upper=r.sources.filter(s=>s.id.startsWith('R4.')),aligned=r.sources.filter(s=>s.soffitAlignment?.sourceId==='R4');
 assert.ok(upper.length);assert.ok(aligned.length);
 for(const s of upper)assert.equal(s.setback,.4572,'the long left run keeps its 18-inch soffit');
 const anchor=upper[0],u={x:anchor.b.x-anchor.a.x,y:anchor.b.y-anchor.a.y};
 for(const s of aligned)for(const p of [s.a,s.b])assert.ok(Math.abs((p.x-anchor.a.x)*u.y-(p.y-anchor.a.y)*u.x)/Math.hypot(u.x,u.y)<1e-6,'the overlapping lower section shares the long wall plane');
 const exposed=r.sources.filter(s=>s.id.startsWith('R7.')&&!s.soffitAlignment&&!s.envelopeReturn);
 assert.ok(exposed.length);for(const s of exposed)assert.equal(s.setback,.4572);
 assert.ok(exposed.some(s=>Math.hypot(s.b.x-7.4618917554,s.b.y-.3970772226)<1e-6),'the far ridge endpoint stays in place');
 assert.ok(r.sources.some(s=>s.envelopeReturn),'the transition at the overlap has a closing wall');
 assert.ok(!r.sources.some(s=>s.id.startsWith('R3.')),'buried lower eave cannot generate a notch');
 assert.equal(r.clean.report.paths.filter(p=>p.crossed).length,1);
 for(const prefix of ['R21.','R22.'])assert.ok(!r.composed.some(w=>w.sourceId.startsWith(prefix)),'nested return removed');
 assert.equal(D.detect(r.composed,r.state.ground).length,0,'complete walls including chimney close against the foundation');
 assert.ok(r.composed.every(w=>[...w.bottom,...w.top].every(p=>[p.x,p.y,p.z].every(Number.isFinite))));
 assert.equal(JSON.stringify(captured),original);
 const again=R.cleanup(r.clean.walls,r.sources,B.terrain(r.state.base));assert.equal(again.report.paths.length,0,'cleanup is stable');
});
test('an edited wall in the crossed-return transaction prevents cleanup of that corner',()=>{
 const r=build(),path=r.clean.report.paths.find(p=>p.crossed);assert.ok(path);
 const blocked=R.cleanup(r.walls,r.sources,B.terrain(r.state.base),path.removedIds);assert.ok(!blocked.report.paths.some(p=>p.crossed));assert.ok(blocked.report.skippedEdited>0);
});
test('overlap resolution is independent of roof-face order and zero-soffit keeps exact edges',()=>{
 const roof={...captured.roof,faces:captured.roof.faces.map((f,i)=>({...f,id:f.id??i}))},a=build({},roof),b=build({},{...roof,faces:[...roof.faces].reverse()});
 const signature=r=>r.sources.map(s=>({id:s.id,a:s.a,b:s.b,setback:s.setback}));assert.deepEqual(signature(a),signature(b));
 const zero=G.buildSources(roof,{soffit:0});assert.ok(zero.sources.every(s=>!s.outerEnvelope));
});

test('only a nearby overlapping exterior run can override an inset; separate and deliberate large steps survive',()=>{
 const rect=(x0,x1,y0,y1,z)=>[{x:x0,y:y0,z},{x:x1,y:y0,z},{x:x1,y:y1,z},{x:x0,y:y1,z}];
 for(const scenario of ['nearby','large step','separate wing','opposite side','short return','higher layer']){
  const upper=rect(0,8,0,4,5),lower=rect(scenario==='separate wing'?20:2,scenario==='separate wing'?25:scenario==='short return'?2.2:7,scenario==='large step'?-.6:-.2,scenario==='opposite side'?-3:3,scenario==='higher layer'?6:4),roof={points:[...upper,...lower],faces:[{points:upper},{points:lower}],connections:[{startIdx:0,endIdx:1,type:'eave'},{startIdx:4,endIdx:5,type:'eave'}]},before=JSON.stringify(roof);
  const source=G.buildSources(roof,{soffit:18}).sources.find(s=>s.id.startsWith('R1.'));assert.ok(source,scenario);
  if(scenario==='nearby'){assert.ok(source.outerEnvelope);assert.equal(source.setback,.4572);const aligned=G.buildSources(roof,{soffit:18}).sources.filter(s=>s.soffitAlignment?.sourceId==='R1');assert.ok(aligned.length);for(const s of aligned)for(const p of [s.a,s.b])assert.ok(Math.abs(p.y-.4572)<1e-8);}else{assert.ok(!source.outerEnvelope,scenario);assert.equal(source.setback,.4572);}
  assert.equal(JSON.stringify(roof),before);
 }
});


test('a partial overlap stops at the dominant miter and leaves the exposed short run at its own setback',()=>{
 const rect=(x0,x1,y0,y1,z)=>[{x:x0,y:y0,z},{x:x1,y:y0,z},{x:x1,y:y1,z},{x:x0,y:y1,z}];
 const upper=rect(0,8,0,4,5),lower=rect(6,11,-.2,3,4),roof={points:[...upper,...lower],faces:[{points:upper},{points:lower}],connections:[{startIdx:0,endIdx:1,type:'eave'},{startIdx:1,endIdx:2,type:'rake'},{startIdx:4,endIdx:5,type:'eave'}]};
 const sources=G.buildSources(roof,{soffit:18}).sources,aligned=sources.filter(s=>s.soffitAlignment),exposed=sources.filter(s=>s.id.startsWith('R3.')&&!s.soffitAlignment&&!s.envelopeReturn),returns=sources.filter(s=>s.envelopeReturn);
 assert.ok(aligned.length);assert.ok(exposed.length);assert.equal(returns.length,1);
 for(const s of aligned)for(const p of [s.a,s.b]){assert.ok(p.x<=8-.4572+1e-6);assert.ok(Math.abs(p.y-.4572)<1e-6);}
 for(const s of exposed)for(const p of [s.a,s.b]){assert.ok(p.x>=8-.4572-1e-6);assert.ok(Math.abs(p.y-(.4572-.2))<1e-6);}
 for(const p of [returns[0].a,returns[0].b])assert.ok(Math.abs(p.x-(8-.4572))<1e-6,'transition follows the real corner plane');
 const longerLower={...roof,points:roof.points.map((p,i)=>i===5||i===6?{...p,x:17}:p)};longerLower.faces=[roof.faces[0],{points:longerLower.points.slice(4)}];
 const resolved=G.buildSources(longerLower,{soffit:18}).sources;
 assert.ok(resolved.some(s=>s.soffitAlignment),'the deeper soffit wins even when the lower eave is longer');
 assert.ok(resolved.filter(s=>s.id.startsWith('R1.')).every(s=>Math.abs(s.setback-.4572)<1e-6));
 for(const s of resolved.filter(s=>s.soffitAlignment))for(const p of [s.a,s.b])assert.ok(Math.abs(p.y-.4572)<1e-6);
 for(const s of resolved.filter(s=>s.id.startsWith('R3.')&&!s.soffitAlignment&&!s.envelopeReturn))assert.equal(s.setback,.4572,'exposed eave retains its own setback');
});

test('overlap alignment and its closing returns rotate with the roof instead of using world axes',()=>{
 const angle=.71,c=Math.cos(angle),s=Math.sin(angle),transform=p=>({x:c*p.x-s*p.y+30,y:s*p.x+c*p.y-15,z:p.z}),roof=structuredClone(captured.roof);
 roof.points=roof.points.map(transform);roof.faces=roof.faces.map(f=>({...f,points:f.points.map(transform),holes:(f.holes||[]).map(h=>h.map(transform))}));
 const baseline=G.buildSources(captured.roof,{soffit:18}).sources,rotated=G.buildSources(roof,{soffit:18}).sources;
 assert.equal(rotated.length,baseline.length);
 for(const a of baseline){const b=rotated.find(b=>b.id===a.id);assert.ok(b,a.id);for(const key of ['a','b']){const p=transform(a[key]);assert.ok(Math.hypot(p.x-b[key].x,p.y-b[key].y,p.z-b[key].z)<1e-6,a.id);}}
});
