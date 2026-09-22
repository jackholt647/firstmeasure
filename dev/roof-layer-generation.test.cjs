const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('./roof-generation-fixture.cjs'),fixture=require('./fixtures/layered-turrets-roof.json');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),B=require('../public/measure/internal/editor_scripts/base_geometry'),C=require('../public/measure/internal/editor_scripts/wall_chimneys');
const upper=new Set([10,11,12,13,14,15,16,17,18,21,22,23,24,25,26,38,39]);
function chimneyJunctions(r,soffit=24){
 const roof=r.state.roof;
 // These four independent caps are attached to the two exterior chimneys.
 // Their front support must end at masonry even if the contact is also a rake.
 for(const [id,index] of [[34,130],[35,131],[36,139],[37,140]]){
  const edge=roof.connections[index],a=roof.points[edge.startIdx],b=roof.points[edge.endIdx];
  const supports=r.composed.filter(w=>w.sourceRoofId===id&&w.kind==='perimeter');
  assert.ok(supports.some(w=>w.bottom.some(p=>G.onEdge(p,a,b,.005))),'lower support meets chimney without an inset side gap: '+id);
 }
 const edge=roof.connections[104],a=roof.points[edge.startIdx],b=roof.points[edge.endIdx],length=Math.hypot(b.x-a.x,b.y-a.y),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length};
 const walls=r.composed.filter(w=>w.kind==='perimeter'&&w.top.every(p=>p.z>69)&&w.bottom.every(p=>p.z<64.01)&&Math.abs((w.bottom[1].x-w.bottom[0].x)*u.y-(w.bottom[1].y-w.bottom[0].y)*u.x)<.002);
 assert.ok(walls.length,'main upper eave has a supporting wall');
 for(const wall of walls)for(const p of wall.bottom)assert.ok(Math.abs(Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)-soffit*G.INCH)<.002,'small lower caps cannot pull the entire upper wall forward');
}
for(const soffit of [0,12,18,24,'auto'])test(`layered turrets: closed exterior and exposed chimney supports at ${soffit} inches`,()=>{
 const before=JSON.stringify(fixture),r=build(fixture,soffit);
 assert.equal(r.open.length,0,'all ground-reaching wall junctions close, including chimney contacts');
 assert.ok(!r.extruded.warnings.some(w=>w.includes('outside the ground')));
 assert.ok(!r.composed.some(w=>upper.has(w.sourceRoofId)&&w.bottom.some(p=>p.z<66)),'roof-mounted turrets and interior details never produce ground shafts');
 for(const id of (soffit===0?[34,35]:[34,35,36,37]))assert.ok(r.composed.some(w=>w.sourceRoofId===id&&w.kind==='perimeter'&&w.bottom.every(p=>Math.abs(p.z-64)<.002)),'each small lower roof retains its supporting wall: '+id);
 for(const id of ['roof-chimney-29-30-31','roof-chimney-101-102-103'])assert.ok(r.composed.some(w=>w.chimney?.id===id&&w.bottom.every(p=>Math.abs(p.z-64)<.002)),'exterior chimney reaches grade');
 assert.ok(!r.composed.some(w=>w.chimney?.id==='roof-chimney-93-94-95-98-99'),'interior chimney stops at roof entry');
 assert.ok(r.composed.every(w=>[...w.bottom,...w.top].every(p=>[p.x,p.y,p.z].every(Number.isFinite))));
 assert.equal(new Set(r.composed.map(w=>w.id)).size,r.composed.length,'stable unique panel IDs');
 assert.equal(JSON.stringify(fixture),before,'generation does not modify captured roof or saved chimney inputs');
});
test('narrow roof layers reduce soffits while preserving at least a one-foot wall body',()=>{
 const r=build(fixture),layers=G.roofLayers(fixture.roof);
 for(const id of [34,35,36,37]){
  const layer=layers.get(id),setback=G.layerSetback(layer,24*G.INCH),ps=layer.flatMap(f=>f.points);
  assert.ok(setback>0&&setback<24*G.INCH);
  for(const f of layer)for(let i=0;i<f.points.length;i++){
   const a=f.points[i],b=f.points[(i+1)%f.points.length],len=Math.hypot(b.x-a.x,b.y-a.y),values=ps.map(p=>((p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x))/len);
   assert.ok(Math.max(...values)-Math.min(...values)-2*setback>=12*G.INCH-1e-6);
  }
  assert.ok(r.state.sources.filter(s=>s.parentId===id&&s.kind==='perimeter').every(s=>s.setback<=setback+1e-6));
 }
});
for(const angle of [.71,2.1])test(`layer classification and foundation closure survive rotation ${angle}`,()=>{
 const f=structuredClone(fixture),c=Math.cos(angle),s=Math.sin(angle),point=p=>({...p,x:c*p.x-s*p.y+20,y:s*p.x+c*p.y-10});
 f.roof.points=f.roof.points.map(point);for(const face of f.roof.faces){face.points=face.points.map(point);face.holes=(face.holes||[]).map(r=>r.map(point));}f.roof.faces.reverse();
 f.ground.points=f.ground.points.map(point);f.ground.plane=G.plane(f.ground.points);
 for(const chimney of f.chimneys.items){chimney.points=chimney.points.map(point);const r=chimney.roofCrossing;if(r){r.a=point(r.a);r.b=point(r.b);const n=r.outward;r.outward={x:c*n.x-s*n.y,y:s*n.x+c*n.y};const p=r.plane,dx=c*p.dx-s*p.dy,dy=s*p.dx+c*p.dy;r.plane={dx,dy,k:p.k-dx*20+dy*10};}}
 const r=build(f);assert.equal(r.open.length,0);assert.ok(!r.composed.some(w=>upper.has(w.sourceRoofId)&&w.bottom.some(p=>p.z<66)));chimneyJunctions(r);
});

for(const soffit of [12,18,24])test(`chimney caps stay exposed and meet masonry with ${soffit} inch main soffits`,()=>chimneyJunctions(build(fixture,soffit),soffit));

test('duplicate chimney contacts override free rake edges only on the same 3D layer',()=>{
 const roof={points:[{x:0,y:0,z:2},{x:1,y:0,z:3},{x:1,y:0,z:3},{x:0,y:0,z:2}],connections:[{type:'chimney_edge',startIdx:0,endIdx:1}]};
 assert.equal(G.chimneyContact(roof,roof.points[2],roof.points[3]),true,'reversed and duplicated vertices still describe attached masonry');
 assert.equal(G.chimneyContact(roof,...roof.points.slice(0,2).map(p=>({...p,z:p.z+1}))),false,'a collinear edge one level higher remains free');
 assert.equal(G.chimneyContact(roof,{x:-1,y:0,z:1},roof.points[1]),false,'partial contact cannot suppress the unconnected overhang');
 const r=build(fixture);assert.ok(!r.state.sources.some(s=>/^R(138|147)(\.|$)/.test(s.id)),'duplicate rakes cannot generate soffits or wall sources through masonry');
});
test('height-map-free chimney inference also generates a closed exterior',()=>{const f=structuredClone(fixture);delete f.chimneys;assert.equal(build(f).open.length,0);});
test('saved or edited foundation elevations are not replaced by automatic envelope reconciliation',()=>{
 const r=build(fixture),base=structuredClone(r.state.base);for(const f of base.faces)for(const p of f.points)p.z+=1;
 assert.equal(B.usesRoofEnvelope(base,r.state.ground),false);assert.equal(B.reconcileRoofWalls(r.composed,r.state.roof,r.state.sources,base,r.state.ground),r.composed);
});
test('regeneration is deterministic and does not reintroduce secondary turret shafts',()=>{
 const a=build(fixture),b=build(JSON.parse(JSON.stringify(fixture)));assert.deepEqual(a.composed,b.composed);assert.deepEqual(C.buildingBase(a.state),C.buildingBase(b.state));
});
