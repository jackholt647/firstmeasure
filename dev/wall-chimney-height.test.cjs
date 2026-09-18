const test=require('node:test'),assert=require('node:assert/strict');
const root='../public/measure/internal/editor_scripts/',C=require(root+'wall_chimneys'),G=require(root+'wall_geometry');
const p=(x,y,z=10)=>({x,y,z});
function fixture(edge=0,extra={}){
 const points=[p(0,-.75),p(-.6,-.75),p(-.6,.75),p(0,.75)];
 const roof={points,connections:points.slice(1).map((_,i)=>({startIdx:i,endIdx:i+1,type:'chimney_edge'})),faces:[{points:[p(-4,-3),p(0,-3),p(0,3),p(-4,3)]}]};
 return {roof,options:{sampleHeight:q=>10+(q.x<edge?1:0),resolution:.05,...extra}};
}
function detect(edge,extra){const f=fixture(edge,extra);return C.detect(f.roof,f.options).items[0];}
test('height drop at the roof edge or within two pixels closes the notch at the crossing',()=>{
 for(const edge of [0,-.05,.05]){const c=detect(edge);assert.equal(c.extension.distance,0);assert.equal(c.extension.snappedToRoof,true);assert.equal(Math.max(...c.points.map(p=>p.x)),0);}
});
test('a measured chimney beyond the roof can be shorter or longer than the mirrored guess',()=>{
 for(const edge of [.35,1.2]){const c=detect(edge);assert.ok(Math.abs(c.extension.distance-edge)<.06);assert.equal(c.extension.snappedToRoof,false);assert.ok(Math.abs(Math.max(...c.points.map(p=>p.x))-edge)<.06);}
});
test('isolated low pixels and a contaminated side strip do not pick a spurious edge',()=>{
 const c=detect(.4,{sampleHeight:q=>q.y>.3?null:10+(q.x<.4&&!(q.x>.1&&q.x<.14)?1:0)});
 assert.ok(Math.abs(c.extension.distance-.4)<.06);assert.ok(c.extension.rays>=3);
});
test('pitched roofs and rotated or reversed measured outlines retain the same extension',()=>{
 const f=fixture(.45),angle=.71,rotate=p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z}),unrotate=p=>({x:p.x*Math.cos(angle)+p.y*Math.sin(angle),y:-p.x*Math.sin(angle)+p.y*Math.cos(angle)});
 for(const p of [...f.roof.points,...f.roof.faces[0].points])p.z+=p.x*.5+p.y*.2;
 const sampler=q=>10+q.x*.5+q.y*.2+(q.x<.45?1:0);
 const original=C.detect(f.roof,{...f.options,sampleHeight:sampler}).items[0];
 f.roof.points=f.roof.points.map(rotate);f.roof.faces[0].points=f.roof.faces[0].points.map(rotate);f.roof.connections.reverse();
 const rotated=C.detect(f.roof,{...f.options,sampleHeight:q=>sampler(unrotate(q))}).items[0];
 assert.ok(Math.abs(rotated.extension.distance-original.extension.distance)<1e-8);
});
test('missing, coarse, flat, unbounded, and inconsistent height evidence retain the fallback',()=>{
 const samplers=[()=>null,()=>NaN,()=>-9999,()=>10,()=>11,q=>q.x>.15?null:11,q=>10+(q.x<(q.y<-.2?.1:q.y<.2?.6:1.1)?1:0)];
 for(const sampleHeight of samplers){const f=fixture(0,{sampleHeight});assert.deepEqual(C.detect(f.roof,f.options),C.detect(f.roof));}
 const f=fixture(0,{resolution:.5});assert.deepEqual(C.detect(f.roof,f.options),C.detect(f.roof));
});
test('closed measured footprints never sample or change, and the source roof stays immutable',()=>{
 const f=fixture();f.roof.connections.push({startIdx:3,endIdx:0,type:'chimney_front'});const before=JSON.stringify(f.roof);
 assert.deepEqual(C.detect(f.roof,{resolution:.05,sampleHeight:()=>{throw Error('must not sample');}}),C.detect(f.roof));assert.equal(JSON.stringify(f.roof),before);
 const open=fixture(),saved=JSON.stringify(open.roof);C.detect(open.roof,open.options);assert.equal(JSON.stringify(open.roof),saved);
});
test('raster sampling honors projection, image bounds, nodata and the saved origin',()=>{
 const ctx={width:5,height:5,mpp:1,lat:0,lng:0},data=Array.from({length:25},(_,i)=>i),s=C.heightSampler(data,ctx);
 assert.equal(s({x:0,y:0}),18);assert.equal(s({x:20,y:0}),null);assert.equal(s({x:0,y:-20}),null);
 data[18]=-9999;assert.equal(s({x:0,y:0}),null);data[18]=null;assert.equal(s({x:0,y:0}),null);
 assert.equal(C.heightSampler(data,ctx,{...ctx,lng:1/111132})({x:0,y:0}),19);
 assert.equal(C.heightSampler([],ctx),null);assert.equal(C.heightSampler(data,{...ctx,mpp:0}),null);
});

const captured=require('./fixtures/stepped-eave-chimney.json'),crop=require('./fixtures/chimney-height-crop.json');
const sampleHeight=p=>{const x=Math.round((p.x-crop.x0)/crop.mpp),y=Math.round((p.y-crop.y0)/crop.mpp);return x>=0&&y>=0&&x<crop.width&&y<crop.height?crop.data[y*crop.width+x]:null;};
test('saved house height map reduces the 26-inch mirrored extension to its measured edge',()=>{
 const before=JSON.stringify(captured),c=C.detect(captured.roof,{sampleHeight,resolution:crop.mpp}).items[0];
 assert.equal(c.extension.rays,5);assert.ok(c.extension.distance>.3&&c.extension.distance<.43);assert.equal(c.extension.snappedToRoof,false);
 assert.equal(JSON.stringify(captured),before);const restored=C.definitions({chimneys:JSON.parse(JSON.stringify({items:[c]}))})[0];assert.deepEqual(restored.extension,c.extension);restored.points.forEach((p,i)=>assert.ok(Math.hypot(p.x-c.points[i].x,p.y-c.points[i].y)<1e-10));
});
for(const soffit of [12,18,24,'auto'])test(`measured chimney preserves a closed foundation and walls with ${soffit} soffit`,()=>{
 const B=require(root+'base_geometry'),R=require(root+'wall_rake_cleanup'),D=require(root+'wall_gaps'),A=require(root+'wall_chimney_cleanup');
 const state=structuredClone(captured);state.options={...state.options,soffit,defaultSoffitInches:18};state.sources=G.buildSources(state.roof,state.options).sources;state.wallEdits={};state.chimneys=C.detect(state.roof,{sampleHeight,resolution:crop.mpp});
 const run=ground=>G.mergeCoplanar(D.repair(G.deduplicate(G.extrude(state.roof,state.sources,ground).walls,state.options.tolerance).walls,ground).walls).walls;
 const pre=R.cleanup(run(state.ground),state.sources,state.ground);
 state.base=B.fromRoof(state.roof,state.ground,pre.walls,(soffit==='auto'?18:soffit)*G.INCH,state.chimneys);C.syncFoundation(state);C.syncVolumes(state);
 const clean=R.cleanup(run(B.terrain(state.base)),state.sources,B.terrain(state.base));state.base=R.foundation(state.base,clean.report);
 const aligned=A.cleanup(clean.walls,state.sources,C.definitions(state),B.terrain(state.base));state.base=A.foundation(state.base,aligned.report);
 const composed=A.compose(C.compose(aligned.walls,state),aligned.report);
 assert.equal(state.base.source,'Wall perimeter');assert.equal(D.detect(composed,state.ground).length,0);assert.ok(composed.some(w=>w.chimney));
 assert.ok(composed.every(w=>[...w.bottom,...w.top].every(p=>[p.x,p.y,p.z].every(Number.isFinite))));
});
