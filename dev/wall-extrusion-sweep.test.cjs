const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z)=>({x,y,z}),front={id:'front',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]};
const side={id:'left',points:[p(0,0,0),p(0,2,0),p(0,2,4),p(0,0,4)]};
test('extruding a slanted edge over pitched ground tessellates returns without gaps or moving the source',()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),input=require('./fixtures/extrusion-pitched-base-slanted-edge.json'),before=JSON.stringify(input),engine=M.createExtrusion({...input,supports:[input.face]});
 for(const amount of [-.3,.3,1]){const r=engine.preview(amount),faces=[input.face,r.cap,...r.sides];assert.ok(r.sides.some(f=>f.id.includes('-facet-')));faces.forEach(f=>assert.doesNotThrow(()=>K.validateFace(f)));
  // The ground outline has no return: the base update owns it (open there by one face).
  const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),ground=q=>[...input.base.faces,...r.base.faces].some(f=>{const pl=G.plane(f.points);return G.contains(f,q)&&Math.abs(q.z-pl.dx*q.x-pl.dy*q.y-pl.k)<.002;});
  const counts=new Map(),ends=new Map();for(const f of faces)for(let i=0;i<f.points.length;i++){const a=f.points[i],b=f.points[(i+1)%f.points.length],key=W.edgeKey(a,b);counts.set(key,(counts.get(key)||0)+1);ends.set(key,[a,b]);}
  assert.ok([...counts].every(([key,n])=>n===2||n===1&&ends.get(key).every(ground)),'every boundary and triangulation seam above the ground is sealed');assert.ok(r.sides.every(f=>!f.points.every(ground)),'no return lies on the ground');
  const n=W.normal(input.face.points);r.cap.points.forEach((q,i)=>{const p=input.face.points[i];assert.ok(Math.hypot(q.x-p.x-n.x*amount,q.y-p.y-n.y*amount)<1e-8);});assert.equal(JSON.stringify(input),before);assert.deepEqual(engine.preview(amount),r);
 }
});
function run(amount,neighbors=[side]){const e=W.extrude(front,-amount,{supports:neighbors});return {...W.trimExtrusion(e.sides,neighbors),cap:e.cap};}
test('inward extrusion shortens a side wall instead of overlapping it',()=>{
 const before=JSON.stringify(side),r=run(1);assert.equal(r.sides.length,0);assert.equal(r.replacements.length,1);
 assert.equal(r.replacements[0].pieces.length,1);const ps=r.replacements[0].pieces[0].points;
 assert.ok(ps.every(p=>p.y>=1-1e-7&&p.y<=2+1e-7));assert.ok(ps.every(p=>p.x===0));assert.equal(JSON.stringify(side),before);
});
test('extruding past the next corner consumes the side and retains only the extension',()=>{
 const r=run(3);assert.equal(r.replacements[0].pieces.length,0);assert.equal(r.sides.length,1);assert.ok(r.sides[0].points.every(p=>p.y>=2-1e-7&&p.y<=3+1e-7));
 const exact=run(2);assert.equal(exact.sides.length,0);assert.equal(exact.replacements[0].pieces.length,0);
});
test('outward extrusion extends the side while disconnected parallel walls remain unchanged',()=>{
 const outward=run(-1);assert.equal(outward.replacements.length,1);assert.equal(outward.sides.length,0);assert.ok(outward.replacements[0].pieces[0].points.some(p=>p.y===-1));assert.ok(outward.replacements[0].pieces[0].points.some(p=>p.y===2));
 const other={...side,id:'offset',points:side.points.map(p=>({...p,x:.1}))};const r=run(1,[side,other]);assert.deepEqual(r.replacements.map(x=>x.face.id),['left']);
});
test('partial shared edge cuts only the swept portion of a taller side',()=>{
 const tall={...side,points:side.points.map(p=>({...p,z:p.z*2}))};const r=run(1,[tall]);assert.equal(r.sides.length,0);assert.equal(r.replacements[0].pieces.length,1);
 const ps=r.replacements[0].pieces[0].points;assert.ok(ps.some(p=>p.y===0&&p.z===8));assert.ok(ps.some(p=>Math.abs(p.y-1)<1e-7&&Math.abs(p.z-4)<1e-7));
});

test('sweep subtraction works on rotated faces and preserves holes in the surviving side',()=>{
 const rotate=p=>({x:p.x,y:p.y*.8-p.z*.6,z:p.y*.6+p.z*.8});
 const hole=[p(0,1.3,1),p(0,1.7,1),p(0,1.7,2),p(0,1.3,2)];
 const target={...side,points:side.points.map(rotate),holes:[hole.map(rotate)]};
 const source={...front,points:front.points.map(rotate)};
 const extrusion=W.extrude(source,-1,{supports:[target]}),r=W.trimExtrusion(extrusion.sides,[target]);
 assert.equal(r.sides.length,0);assert.equal(r.replacements[0].pieces.length,1);assert.equal(r.replacements[0].pieces[0].holes.length,1);
});

test('lower-section sweep preserves area continuously across narrow remaining strips',()=>{
 const lower={...front,points:front.points.map(p=>({...p,z:p.z/2}))};
 const area=f=>{const frame=W.faceFrame(f),ring=f.points.map(p=>W.inFrame(frame,p));return Math.abs(ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p.x*q.y-p.y*q.x;},0)/2);};
 for(const amount of [.0001,.0049,.0051,.0099,.0101,.0199,.0201,.23333,.99999,1.9801,1.99,1.995,1.9999,2,2.0001,2.01]){
  const e=W.extrude(lower,-amount,{supports:[side]}),r=(()=>{try{return W.trimExtrusion(e.sides,[side]);}catch(e){e.message+=` at ${amount}`;throw e;}})();
  assert.equal(r.replacements.length,1);const remaining=r.replacements[0].pieces.reduce((s,p)=>s+area(p),0),returns=r.sides.reduce((s,p)=>s+area(p),0);
  assert.ok(Math.abs(remaining-(8-2*Math.min(2,amount)))<1e-6,`lost side area at ${amount}: ${remaining}`);
  assert.ok(Math.abs(returns-2*Math.max(0,amount-2))<1e-6,`extra return at ${amount}`);
 }
});

test('sloped-base extrusion fits its bottom before clipping, so no old corner tip remains',()=>{
 const {face,cut}=require('./fixtures/extrusion-sloped-base-wedge.json'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),before=JSON.stringify(face),origin=cut.points[0];
 const length=Math.hypot(cut.points[3].x-origin.x,cut.points[3].y-origin.y),n={x:(cut.points[3].x-origin.x)/length,y:(cut.points[3].y-origin.y)/length},u={x:-n.y,y:n.x};
 const slope=(face.points[0].z-origin.z)/Math.hypot(face.points[0].x-origin.x,face.points[0].y-origin.y),at=(x,y)=>({x:origin.x+u.x*x+n.x*y,y:origin.y+u.y*x+n.y*y,z:origin.z+slope*y});
 const base={faces:[{id:'base',points:[at(0,0),at(2,0),at(2,10),at(0,10)]}]},source={id:'selected',points:[at(0,0),at(2,0),{...at(2,0),z:cut.points[1].z},cut.points[1]]};
 const result=M.createExtrusion({face:source,scene:[face],base}).preview(length),next=result.replacements.find(r=>r.face.id===face.id).pieces[0],tip=face.points[1];
 assert.ok(!next.points.some(p=>Math.hypot(p.x-tip.x,p.y-tip.y,p.z-tip.z)<1e-5));
 assert.ok(Math.abs(result.cap.points[0].z-at(0,length).z)<1e-8);assert.equal(next.points.length,6);assert.equal(JSON.stringify(face),before);
});
test('polygon operations preserve real narrow returns and shallow slopes without tip heuristics',()=>{
 for(const points of [[{x:0,y:0,z:0},{x:5,y:0,z:.02},{x:5,y:0,z:4},{x:0,y:0,z:4}], [{x:0,y:0,z:0},{x:5,y:0,z:0},{x:4,y:0,z:.2},{x:4,y:0,z:4},{x:0,y:0,z:4}]]){const f={points},before=JSON.stringify(f),r=W.trimExtrusion([],[f]);assert.equal(r.replacements.length,0);assert.equal(JSON.stringify(f),before);}
});

test('an extended coplanar side loses its seam but retains the old divider endpoints',()=>{
 const r=run(-1),f=r.replacements[0].pieces[0],wire=W.surfaceWire({$surfaces:[f]});
 assert.equal(r.sides.length,0);assert.equal(f.points.length,4);
 assert.ok(wire.nodes.some(p=>p.y===0&&p.z===0));assert.ok(wire.nodes.some(p=>p.y===0&&p.z===4));
 const node=id=>wire.nodes.find(n=>n.id===id);assert.ok(!wire.edges.some(e=>node(e.a).y===0&&node(e.b).y===0));
});
test('sweep keeps construction points on surviving neighbor material only',()=>{
 const target={...side,retainedPoints:[p(0,1.5,3),p(0,.5,1)]},lower={...front,points:front.points.map(p=>({...p,z:p.z/2}))};
 const r=W.trimExtrusion(W.extrude(lower,-1,{supports:[target]}).sides,[target]),points=r.replacements.flatMap(r=>r.pieces.flatMap(f=>f.retainedPoints||[]));
 assert.ok(points.some(p=>p.y===1.5&&p.z===3));assert.ok(!points.some(p=>p.y===.5&&p.z===1));
});
test('attached lengths use full 3D distance and ignore unrelated walls',()=>{
 const cap={id:'cap',points:[p(0,1,1),p(4,1,1),p(4,1,4),p(0,1,4)]},returnFace={points:[p(0,0,0),p(0,1,1),p(0,1,4),p(0,0,4)]};
 const result=W.attachedLengths(cap,[cap,returnFace,{points:front.points.map(p=>({...p,x:p.x+100}))}]);assert.equal(result.length,2);assert.ok(result.some(e=>Math.abs(e.length-Math.sqrt(2))<1e-9));
});

for(const supports of [undefined,[],[side]])test(`face sweep closes every boundary even without neighboring support (${supports?.length??'default'})`,()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js'),face={...front,holes:[[p(1,0,1),p(2,0,1),p(2,0,2),p(1,0,2)]]};
 for(const amount of [-1,1]){const result=M.createExtrusion({face,scene:[face],supports}).preview(amount);
  const returns=result.sides;for(const ring of [face.points,...face.holes])for(let i=0;i<ring.length;i++)assert.ok(W.sharedIntervals(ring[i],ring[(i+1)%ring.length],returns).reduce((sum,[a,b])=>sum+b-a,0)>.99999,'each original outer and hole edge has a complete return');
 }
});

for(const amount of [-.3,.3])test(`oblique edge extrusion keeps its neighbor planar and fills the sweep once (${amount})`,()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),a=p(0,0,2),b=p(4,0,2),top={id:'top',points:[a,b,p(4,3,2),p(0,3,2)]},side={id:'side',points:[b,a,p(0,-.35,0),p(4,-.35,0)]},before=JSON.stringify([top,side]),r=W.slideLines([top,side],[[a,b]],p(0,1,0),amount,{preserveConnections:true});
 assert.equal(JSON.stringify([top,side]),before,'immutable source');assert.deepEqual(r.faces.find(f=>f.id==='side').points,side.points,'neighbor is not bent');
 r.faces.forEach(K.validateFace);const horizontal=r.faces.filter(f=>f.points.every(p=>Math.abs(p.z-2)<1e-8));assert.ok(Math.abs(horizontal.reduce((sum,f)=>sum+K.area(f),0)-(12+Math.max(0,-amount)*4))<1e-6,'sweep has no holes or overlapping duplicate area');assert.equal(new Set(r.faces.map(f=>f.id)).size,r.faces.length);
});

// A wall region standing on the base, pushed into the building (project fullhouse_ce52...: a 0.24 mm
// sliver region left along the region's bottom edge was a support, so the bottom got a floor and the
// top, which no face shares, got no ceiling).
for(const sliver of [false,true])test(`a recess pushed into a wall from the base gets a ceiling, no floor, and pulls the base back (${sliver?'with':'without'} a sliver sharing its bottom)`,()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
 const region={id:'region',points:[p(1,0,0),p(3,0,0),p(3,0,3),p(1,0,3)]},left={id:'left',points:[p(-1,0,0),p(1,0,0),p(1,0,3),p(-1,0,3)]},right={id:'right',points:[p(3,0,0),p(5,0,0),p(5,0,3),p(3,0,3)]};
 const base={faces:[{id:'base',points:[p(-1,0,0),p(5,0,0),p(5,6,0),p(-1,6,0)]}]},scene=[region,left,right,...(sliver?[{id:'sliver',points:[p(3,0,0),p(1,0,0),p(.9,0,-.0002)]}]:[])];
 const r=M.createExtrusion({face:region,scene,supports:scene.filter(f=>f!==region),base}).preview(-1),faces=[r.cap,...r.sides];faces.forEach(K.validateFace);
 assert.ok(r.cap.points.every(q=>Math.abs(q.y-1)<1e-9),'the back wall is one metre in');
 assert.ok(!r.sides.some(f=>f.points.every(q=>Math.abs(q.z)<1e-6)),'no floor on the ground');
 const ceiling=r.sides.filter(f=>f.points.every(q=>Math.abs(q.z-3)<1e-9));assert.equal(ceiling.length,1,'one ceiling at the top edge');assert.ok(Math.abs(K.area(ceiling[0])-2)<1e-9);
 for(const x of [1,3])assert.ok(r.sides.some(f=>f.points.every(q=>Math.abs(q.x-x)<1e-9)),'a side wall at x='+x);
 const area=r.base.faces.reduce((s,f)=>s+K.area(f),0);assert.ok(Math.abs(area-(36-2))<1e-6,'the base loses the recess footprint');
 assert.ok(!r.base.faces.some(f=>G.contains(f,p(2,.5,0))),'the base is pulled back under the recess');assert.ok(r.base.faces.some(f=>G.contains(f,p(2,1.5,0))));
 for(const q of r.cap.points.filter(q=>q.z===0))assert.ok(r.base.faces.some(f=>W.sharedIntervals(...r.cap.points.filter(q=>q.z===0),[f]).length),'the back wall stands on the moved base edge');
});
// A door at the wall base with no base below keeps its open threshold, and a sticker keeps only supported returns.
test('a hosted door region keeps an open threshold without a base, and a sticker still sweeps only along its host',()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js');
 const door={id:'door',points:[p(1,0,0),p(3,0,0),p(3,0,2),p(1,0,2)]},wall={id:'wall',points:[p(0,0,0),p(1,0,0),p(1,0,2),p(3,0,2),p(3,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]};
 const r=M.createExtrusion({face:door,scene:[door,wall]}).preview(-.5);assert.equal(r.sides.length,3);assert.ok(!r.sides.some(f=>f.points.every(q=>Math.abs(q.z)<1e-9)));
 const sticker={...door,feature:{type:'garage'}},s=M.createExtrusion({face:sticker,scene:[sticker]}).preview(-.5);assert.equal(s.sides.length,0);
});
