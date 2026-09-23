const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('./roof-generation-fixture.cjs'),fixture=require('./fixtures/layered-turrets-roof.json');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),B=require('../public/measure/internal/editor_scripts/base_geometry'),C=require('../public/measure/internal/editor_scripts/wall_chimneys');
const upper=new Set([10,11,12,13,14,15,16,17,18,21,22,23,24,25,26,38,39]);
test('captured house front eave has one editable top edge despite roof mesh noise',()=>{
 const r=build(fixture,18),before=JSON.stringify(r.composed),geo=G.topology(r.composed);
 const face=geo.faces.find(f=>f.mergeGroup?.includes('envelope-0-18-'));
 assert.ok(face,'front wall beside the turret');assert.equal(face.pointIndices.length,4,'no roof triangulation stations on the editable boundary');
 const top=face.boundary.filter(e=>e.every(i=>geo.points[i].z>66));assert.equal(top.length,1);
 assert.ok(Math.hypot(...['x','y','z'].map(k=>geo.points[top[0][1]][k]-geo.points[top[0][0]][k]))>7.6,'entire front top is one line');
 assert.equal(face.triangles.length,2,'the filled surface uses the same canonical outline');assert.equal(JSON.stringify(r.composed),before);
});
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
 const clearance=Math.max(...r.state.sources.filter(s=>s.kind==='flashing'&&[36,37].includes(s.parentId)).flatMap(s=>[s.a,s.b]).map(p=>Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)));
 for(const wall of walls)for(const p of wall.bottom)assert.ok(Math.abs(Math.abs((p.x-a.x)*u.y-(p.y-a.y)*u.x)-Math.max(soffit*G.INCH,clearance))<.02001,'main wall respects selected setback and lower-layer clearance');
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
 const r=build(f);assert.equal(r.open.length,0);assert.ok(!r.composed.some(w=>upper.has(w.sourceRoofId)&&w.bottom.some(p=>p.z<66)));chimneyJunctions(r);const shallow=build(f,18);lowerLayerClearance(shallow);assert.equal(shallow.open.length,0);
});

for(const soffit of [12,18,24])test(`chimney caps stay exposed and meet masonry with ${soffit} inch main soffits`,()=>chimneyJunctions(build(fixture,soffit),soffit));

function lowerLayerClearance(r){
 for(const cap of r.state.roof.faces.filter(f=>[34,35,36,37].includes(f.id))){
  const plane=G.plane(cap.points);
  for(const wall of r.composed.filter(w=>!w.chimney)){
   const [a,b]=wall.top,ts=G.splitParameters(a,b,[cap]);
   for(let i=1;i<ts.length;i++){
    const t=(ts[i-1]+ts[i])/2,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};
    if(!G.contains(cap,p)||cap.points.some((q,j)=>G.onEdge(p,q,cap.points[(j+1)%cap.points.length],.002)))continue;
    assert.ok(p.z<=plane.dx*p.x+plane.dy*p.y+plane.k+.002,`wall ${wall.id} buries lower roof ${cap.id}`);
   }
  }
 }
}
for(const soffit of [0,6,12,18,24,30])test(`lower layers constrain wall clearance at ${soffit} inch soffits`,()=>lowerLayerClearance(build(fixture,soffit)));

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

function roofMesh(roof){const K=require('../public/measure/internal/editor_scripts/exterior_geometry');return roof.faces.flatMap(f=>{const mesh=K.triangles(f.points,f.holes||[]);return mesh.triangles.map(ids=>({points:ids.map(i=>mesh.points[i])}));}).map(f=>({...f,plane:G.plane(f.points)}));}
for(const soffit of [18,24])test(`canonical generated walls stay within measured roof tolerance at ${soffit} inches`,()=>{
 const r=build(fixture,soffit),mesh=roofMesh(r.state.roof);
 for(const w of r.composed.filter(w=>!w.chimney))for(const t of [0,.25,.5,.75,1]){
  const a=w.top[0],b=w.top[1],p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t},heights=mesh.filter(f=>G.contains(f,p)).map(f=>f.plane.dx*p.x+f.plane.dy*p.y+f.plane.k);
  if(heights.length)assert.ok(p.z<=Math.max(...heights)+.05,'canonical wall stays within five-centimetre survey tolerance: '+w.id);
 }
});
for(const soffit of [18,24])test(`measured chimney flashing and the main wall do not overlap at ${soffit} inches`,()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=build(fixture,soffit),walls=r.composed.filter(w=>!w.chimney),ring=w=>[w.bottom[0],w.bottom[1],w.top[1],w.top[0]];
 for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++){
  const a=walls[i],b=walls[j],frame=K.frame({points:ring(a)});if(!frame||ring(b).some(p=>Math.abs(K.local(frame,p).z)>.02))continue;
  const overlap=K.intersection([{points:ring(a).map(p=>K.local(frame,p))}],[{points:ring(b).map(p=>K.local(frame,p))}]).reduce((sum,f)=>sum+K.area(f),0);
  assert.ok(overlap<.005,'parallel wall overlap: '+a.id+' / '+b.id);
 }
});
for(const soffit of [18,24])test(`both chimney sides remain continuous above lower caps at ${soffit} inches`,()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=build(fixture,soffit),defs=C.definitions(r.state),geo=G.topology(r.composed),faces=[...geo.faces.filter(f=>f.chimney).flatMap(f=>f.triangles.map(ids=>({...f,points:ids.map(i=>geo.points[i])}))),...r.state.wallEdits.$surfaces.filter(f=>f.chimney&&!f.chimney.cap)];
 for(const index of [130,131,139,140])for(const fraction of [.2,.5,.8]){
  const edge=r.state.roof.connections[index],a=r.state.roof.points[edge.startIdx],b=r.state.roof.points[edge.endIdx],sample={x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction,z:a.z+(b.z-a.z)*fraction};let closest;
  for(const c of defs)for(let i=0;i<c.points.length;i++){
   const p=c.points[i],q=c.points[(i+1)%c.points.length],dx=q.x-p.x,dy=q.y-p.y,l2=dx*dx+dy*dy,t=((sample.x-p.x)*dx+(sample.y-p.y)*dy)/l2;if(t<0||t>1)continue;
   const hit={x:p.x+t*dx,y:p.y+t*dy,z:sample.z},distance=Math.hypot(hit.x-sample.x,hit.y-sample.y);if(!closest||distance<closest.distance)closest={hit,distance,c};
  }
  assert.ok(closest.distance<.002);
  const ceiling=index<139?66.3:69.2;
  for(const z of [sample.z+.03,66,(66+ceiling)/2,ceiling]){
   const p={...closest.hit,z};assert.ok(faces.some(f=>{if(f.chimney.id!==closest.c.id)return false;const frame=K.frame(f);if(!frame)return false;const local=K.local(frame,p);return Math.abs(local.z)<.002&&G.contains({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))},local);}),`missing chimney shell above cap ${index} at ${fraction}, ${z}`);
  }
 }
});

test('lower-layer clearance leaves unrelated eaves at the selected soffit',()=>{
 const r=build(fixture,18),plain=r.state.sources.filter(s=>s.kind==='perimeter'&&!s.clearanceRoofIds);
 assert.ok(plain.length>20);
 assert.ok(plain.every(s=>s.setback<=18*G.INCH+1e-6));
 const deeper=build(fixture,30).state.sources.filter(s=>s.clearanceRoofIds);
 assert.ok(deeper.length>=4);assert.ok(deeper.every(s=>s.setback>=s.contactSetback-.002));
});

test('clearance requires an overlapping lower layer reaching the same eave',()=>{
 const source=(x=4,y=0,z=3)=>{
  const points=[{x:0,y:0,z:10},{x:10,y:0,z:10},{x:10,y:10,z:10},{x:0,y:10,z:10},
   {x,y,z},{x:x+2,y,z},{x:x+2,y:y+.6,z:z+1},{x,y:y+.6,z:z+1}];
  const roof={points,faces:[{id:0,points:points.slice(0,4)},{id:1,points:points.slice(4)}],connections:[{type:'eave',startIdx:0,endIdx:1},{type:'head_wall',startIdx:6,endIdx:7}]};
  return G.buildSources(roof,{soffit:18,roofContacts:true}).sources.find(s=>s.id.startsWith('R1'));
 };
 assert.ok(Math.abs(source().setback-.6)<1e-6);
 assert.deepEqual(source().clearanceRoofIds,[1]);
 for(const s of [source(4,1),source(11,0),source(4,0,12)]){
  assert.ok(Math.abs(s.setback-18*G.INCH)<1e-6);
  assert.equal(s.clearanceRoofIds,undefined);
 }
});

for(const soffit of [18,24])test(`selecting or materializing a lower wall preserves chimney exposure at ${soffit} inches`,()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=build(fixture,soffit),initial=C.compose(r.aligned.walls,r.state).filter(w=>w.chimney),w=r.composed.find(w=>w.sourceId==='R134.0'),points=[...w.bottom,w.top[1],w.top[0]],frame=K.frame({points});
 const initialEdits=structuredClone(r.state.wallEdits);
 for(const materialized of [false,true]){
  r.state.wallEdits=structuredClone(initialEdits);
  r.state.wallEdits.$drafts={selected:{frame,members:[w.id],faces:[{points:points.map(p=>K.local(frame,p)),...(materialized?{solidId:'converted'}:{})}]}};
  if(materialized)r.state.wallEdits.$surfaces.push({id:'converted',points});
  const current=C.compose(r.aligned.walls,r.state).filter(w=>w.chimney);
  assert.deepEqual(current,initial,'selection and equivalent editable geometry cannot change chimney panels');
  for(const wall of current){const face={...wall,points:[...wall.bottom,wall.top[1],wall.top[0]]};assert.deepEqual(C.visibleParts(face,r.state),[face],'rendering cannot clip the repaired panel a second time');}
  r.state=JSON.parse(JSON.stringify(r.state));assert.deepEqual(C.compose(r.aligned.walls,r.state).filter(w=>w.chimney),initial,'reload retains exposure');
 }
});

for(const roofId of [34,35,36,37])test(`saved house lower roof ${roofId} constrains side-then-front extrusion under the upper layer`,()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=build(fixture,18),roof=C.roofWithOpenings(r.state),scene=r.composed.map(w=>({...w,points:[...w.bottom,w.top[1],w.top[0]],holes:[]}));
 const sources=r.state.sources.filter(s=>s.parentId===roofId),sideSource=sources.find(s=>s.type==='rake'),frontSource=sources.find(s=>s.type==='eave'),side=scene.find(f=>f.sourceId===sideSource.id),front=scene.find(f=>f.sourceId===frontSource.id),plane=G.plane(r.state.roof.faces.find(f=>f.id===roofId).points);
 const first=M.createExtrusion({face:side,scene,roof}).preview(sideSource.setback+.008),next=first.replacements.find(r=>r.face.id===front.id)?.pieces[0];assert.ok(next,'the first extrusion extends its front neighbor');
 const result=M.createExtrusion({face:next,scene:[first.cap,...first.sides],roof}).preview(frontSource.setback-.002);
 for(const face of [result.cap,...result.sides,...result.replacements.flatMap(r=>r.pieces)]){K.validateFace(face);for(const p of [...face.points,...(face.retainedPoints||[])])assert.ok(p.z<=plane.dx*p.x+plane.dy*p.y+plane.k+.00001,'lower roof bounds every shared edge after both edits');}
});

// Exercise the mouse snap path, including the height fit performed before the
// first roof cut. Typed distances alone missed the exact boundary regression.
for(const roofId of [34,35,36,37])test(`snapped side then front extrusion keeps lower roof ${roofId} boundary closed`,()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),M=require('../public/measure/internal/editor_scripts/exterior_model'),K=require('../public/measure/internal/editor_scripts/exterior_geometry');
 const vm=require('node:vm'),fs=require('node:fs'),ctx={WallGeometry:G};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const r=build(fixture,18),roof=C.roofWithOpenings(r.state),scene=r.composed.map(w=>({...w,points:[...w.bottom,w.top[1],w.top[0]],holes:[]})),sources=r.state.sources.filter(s=>s.parentId===roofId),ss=sources.find(s=>s.type==='rake'),front=scene.find(f=>f.sourceId===sources.find(s=>s.type==='eave').id),side=scene.find(f=>f.sourceId===ss.id);
 const n=W.normal(side.points),u={x:n.y,y:-n.x},ts=side.points.map(p=>p.x*u.x+p.y*u.y),ends=[Math.min(...ts),Math.max(...ts)].map(t=>side.points.filter((p,i)=>Math.abs(ts[i]-t)<1e-5).sort((a,b)=>b.z-a.z)[0]),bottom=ends.map(p=>({...p,z:Math.min(...side.points.map(q=>q.z))})),snap=ctx.findWallRoofSnap({bottom,top:ends},ss.setback,roof,.1,{fitSurface:true});
 const fit=(cap,sides)=>{const [a,b]=snap.edge,dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy,ids=side.points.map((p,i)=>side.points.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<1e-5&&q.z>p.z+1e-5)?-1:i).filter(i=>i>=0),moves=ids.map(i=>({from:{...cap.points[i]},z:a.z+((cap.points[i].x-a.x)*dx+(cap.points[i].y-a.y)*dy)/l2*(b.z-a.z)}));for(const f of [cap,...sides])for(const p of f.points){const m=moves.find(m=>W.vertexKey(m.from)===W.vertexKey(p));if(m)p.z=m.z;}return moves;};
 const first=M.createExtrusion({face:side,scene,roof}).preview(snap.amount,{fit}),next=first.replacements.find(r=>r.face.id===front.id)?.pieces[0],plane=G.plane(r.state.roof.faces.find(f=>f.id===roofId).points);
 const result=M.createExtrusion({face:next,scene:[first.cap,...first.sides],roof}).preview(.14),ps=[result.cap,...result.sides,...result.replacements.flatMap(r=>r.pieces)].flatMap(f=>[...f.points,...(f.retainedPoints||[])]);
 assert.ok(snap,'the measured rake is selected by the real roof snap resolver');
 for(const p of ps)assert.ok(p.z<=plane.dx*p.x+plane.dy*p.y+plane.k+K.CONTACT,'no shared corner or return protrudes above the contacted lower roof');
 for(const f of [result.cap,...result.sides,...result.replacements.flatMap(r=>r.pieces)])K.validateFace(f);
});


function finiteTowerJunctions(r,soffit){
 const limits=[];
 for(const [flashingId,eaveId]of [['R128','R112'],['R130','R115']]){
  const flashing=r.state.sources.find(s=>s.id===flashingId),source=r.state.sources.find(s=>s.id.startsWith(eaveId+'.'));assert.ok(flashing&&source);
  const a=source.originalA,b=source.originalB,len=Math.hypot(b.x-a.x,b.y-a.y),n={x:-(b.y-a.y)/len,y:(b.x-a.x)/len};
  if((source.a.x-a.x)*n.x+(source.a.y-a.y)*n.y<0){n.x=-n.x;n.y=-n.y;}
  const limit=(flashing.a.x-a.x)*n.x+(flashing.a.y-a.y)*n.y;limits.push(limit);
  assert.ok(Math.abs(source.setback-Math.min(soffit*G.INCH,limit))<.002,'adjoining setback stops at the finite lower roof end');
  assert.ok(r.state.base.faces.some(f=>f.points.some((p,i)=>{const q=f.points[(i+1)%f.points.length],dx=flashing.b.x-flashing.a.x,dy=flashing.b.y-flashing.a.y,l=Math.hypot(dx,dy),ts=[p,q].map(p=>((p.x-flashing.a.x)*dx+(p.y-flashing.a.y)*dy)/l).sort((a,b)=>a-b);return [p,q].every(p=>Math.abs((p.x-flashing.a.x)*dy-(p.y-flashing.a.y)*dx)/l<.005)&&Math.min(l,ts[1])-Math.max(0,ts[0])>=(soffit===0?-.005:.005);})),'supporting wall meets the measured roof junction on one plane');
  const walls=r.composed.filter(w=>w.sourceId===flashingId);assert.ok(walls.length,'measured roof-to-wall contact is retained');
 }
 for(const w of r.composed.filter(w=>w.kind==='flashing'&&[19,20].includes(w.targetId)))for(const p of [...w.top,...w.bottom])assert.ok(r.state.base.faces.some(f=>G.contains(f,p)),'no unsupported flashing wing: '+w.id);
 for(const id of ['R113','R114']){const s=r.state.sources.find(s=>s.id.startsWith(id+'.'));assert.ok(s);assert.ok(Math.abs(s.setback-G.layerSetback(G.roofLayers(r.state.roof).get(s.parentId),soffit*G.INCH))<.002,'unconstrained front soffits retain the chosen depth');}
 assert.equal(r.open.length,0,'junctions stay closed down to the foundation');
}
for(const soffit of [0,6,12,18,24,36])test(`finite roof-end planes reconcile both tower sides at ${soffit} inches`,()=>finiteTowerJunctions(build(fixture,soffit),soffit));

test('finite tower contacts do not depend on compass direction or face ordering',()=>{
 const f=structuredClone(fixture),angle=.71,c=Math.cos(angle),s=Math.sin(angle),point=p=>({...p,x:c*p.x-s*p.y+20,y:s*p.x+c*p.y-10});
 f.roof.points=f.roof.points.map(point);for(const face of f.roof.faces){face.points=face.points.map(point);face.holes=(face.holes||[]).map(r=>r.map(point));}f.roof.faces.reverse();f.ground.points=f.ground.points.map(point);f.ground.plane=G.plane(f.ground.points);delete f.chimneys;
 finiteTowerJunctions(build(f,24),24);
});
