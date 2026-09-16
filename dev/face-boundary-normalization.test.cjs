const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const M=require('../public/measure/internal/editor_scripts/exterior_model.js');
const p=(x,y,z=0)=>({x,y,z});
const area=f=>{const frame=K.frame(f);return K.area({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))});};
const spike=()=>({id:'wall',material:'siding',points:[p(0,0),p(4,0),p(4,4),p(0,4),p(0,1),p(-1,1),p(0,1)]});

test('line moved onto its neighbor rebuilds its face before classification and deletion',()=>{
 const face={id:'wall',material:'siding',points:[p(0,0),p(4,0),p(4,4),p(0,4),p(0,2),p(-1,2),p(-1,1),p(0,1)]};
 const before=JSON.stringify(face),result=W.slideLines([face],[[p(0,2),p(-1,2)]],p(0,1),-1),clean=result.faces[0];
 assert.equal(JSON.stringify(face),before);assert.equal(area(clean),16);
 assert.ok(clean.points.every(p=>p.x>=0));assert.equal(clean.material,'siding');
 assert.equal(W.structuralPoint(p(-1,1),[clean]),false);
 assert.equal(W.structuralPoint(p(0,1),[clean]),false);
 const edits={$surfaces:[clean]};W.deleteSurfaceElements(edits,[W.vertexKey(p(-1,1)),W.vertexKey(p(0,1))]);
 assert.ok(!clean.deleted);assert.equal(area(clean),16);K.validateFace(clean);
});

test('deletion rechecks legacy folded boundaries even without a preceding move',()=>{
 const f=spike(),edits={$surfaces:[f]};
 assert.equal(W.structuralIndex([f]).point(p(-1,1)),false);
 W.deleteSurfaceElements(edits,[W.vertexKey(p(-1,1))]);
 assert.ok(!f.deleted);assert.equal(area(f),16);assert.ok(f.points.every(p=>p.x>=0));
 W.deleteSurfaceElements(edits,[W.vertexKey(p(4,4))]);assert.equal(f.deleted,true,'real corners still define area');
});

test('partially retraced segments normalize on a tilted plane and preserve holes and ownership',()=>{
 const map=q=>p(q.x,100+q.y*.8,200+q.y*.6),f=spike();
 f.points.splice(-1,1,p(-.5,1),p(0,1));f.holes=[[p(1,1),p(2,1),p(2,2),p(1,2)]];
 f.points=f.points.map(map);f.holes=f.holes.map(r=>r.map(map));f.joinedChimneys=['existing'];
 const clean=K.normalizeFace(f);assert.ok(Math.abs(area(clean)-15)<1e-8);assert.equal(clean.holes.length,1);
 assert.deepEqual(clean.joinedChimneys,['existing']);assert.ok(clean.points.every(p=>p.x>=0));
 assert.equal(K.pointRemovalChangesRegion(clean,[K.pointKey(map(p(1,1)))]),true,'hole corner changes the filled shape');
});

test('shared commit boundary cleans changed solids and draft regions, including save/reload',()=>{
 const solid=spike(),draft=spike();draft.points.forEach((p,i)=>p.nodeId='p'+i);
 const edits={$surfaces:[solid],$drafts:{wall:{faces:[draft]}}};
 M.validateEdits(edits,{});assert.ok(solid.points.every(p=>p.x>=0));assert.ok(draft.points.every(p=>p.x>=0));
 assert.ok(draft.points.every(p=>p.nodeId));
 const reload=JSON.parse(JSON.stringify(edits));M.validateEdits(reload,{});
 assert.equal(area(reload.$surfaces[0]),16);assert.equal(area(reload.$drafts.wall.faces[0]),16);
});

test('shared borders remain one incidence edge with both owning faces',()=>{
 const faces=[{id:'left',points:[p(0,0),p(2,0),p(2,2),p(0,2)]},{id:'right',points:[p(2,0),p(4,0),p(4,2),p(2,2)]}].map(f=>K.normalizeFace(f));
 const graph=K.topology(faces);assert.equal([...graph.edges.values()].filter(e=>e.faces.size===2).length,1);
 assert.equal(faces.length,2);assert.equal(faces.reduce((sum,f)=>sum+area(f),0),8);
});

test('failed collapsed line moves leave the source geometry intact',()=>{
 const f={id:'wall',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},before=JSON.stringify(f);
 assert.throws(()=>W.slideLines([f],[[p(0,4),p(4,4)]],p(0,1),-4));
 assert.equal(JSON.stringify(f),before);
});

test('equal total area does not make a boundary-changing deletion safe',()=>{
 const f={id:'equal-area',points:[p(0,0),p(2,-1),p(4,0),p(4,4),p(2,3),p(0,4)]};
 assert.equal(area(f),16);
 assert.equal(K.pointRemovalChangesRegion(f,[K.pointKey(p(2,-1)),K.pointKey(p(2,3))]),true);
 const edits={$surfaces:[f]};W.deleteSurfaceElements(edits,[W.vertexKey(p(2,-1)),W.vertexKey(p(2,3))]);assert.equal(f.deleted,true);
});

test('normalization preserves every area component when a touching boundary separates',()=>{
 const f={id:'touching',material:'siding',points:[p(0,0),p(2,0),p(2,2),p(4,2),p(4,4),p(2,4),p(2,2),p(0,2)]};
 const edits={$surfaces:[f]};M.validateEdits(edits,{});
 assert.equal(edits.$surfaces.length,2);assert.equal(edits.$surfaces.reduce((sum,f)=>sum+area(f),0),8);
 assert.equal(new Set(edits.$surfaces.map(f=>f.id)).size,2);
 for(const face of edits.$surfaces){K.validateFace(face);assert.equal(face.material,'siding');}
});
