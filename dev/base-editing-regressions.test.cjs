// Regressions from the 2026-10-16 full-house audit: base sketch editing, holes,
// raised sections, Reground and curved-base performance.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const R='../public/measure/internal/editor_scripts/';
const S=require(R+'base_sketch_geometry.js'),B=require(R+'base_geometry.js'),K=require(R+'exterior_geometry.js'),G=require(R+'wall_geometry.js'),W=require(R+'wall_solid_geometry.js'),T=require(R+'ground_geometry.js'),F=require(R+'wall_base_binding.js'),Steps=require(R+'wall_steps.js');
const p=(x,y,z=0)=>({x,y,z}),copy=v=>JSON.parse(JSON.stringify(v));
const square=(z=()=>0,size=10)=>({faces:[{id:'base',points:[[0,0],[size,0],[size,size],[0,size]].map(([x,y])=>p(x,y,z(x,y)))}]});
const area=b=>b.faces.reduce((s,f)=>s+K.area({points:f.points}),0);
const inside=(q,ring)=>{let c=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>q.y)!==(b.y>q.y)&&q.x<(b.x-a.x)*(q.y-a.y)/(b.y-a.y)+a.x)c=!c;}return c;};
const covering=(b,q)=>b.faces.filter(f=>inside(q,f.points));
const onOwnPlane=b=>b.faces.every(f=>{const pl=G.plane(f.points);return pl&&f.points.every(q=>Math.abs(q.z-pl.dx*q.x-pl.dy*q.y-pl.k)<1e-7);});
const loop=(b,points)=>{const ids=points.map(q=>S.add(b,q));S.connect(b,[...ids,ids[0]]);return ids;};
const fixedAt=(b,x,y)=>b.sketch.nodes.filter(n=>Math.abs(n.x-x)<1e-9&&Math.abs(n.y-y)<1e-9);

// #11
test('dragging a divider bend in plan keeps it on a sloped base and both faces survive',()=>{
 for(const grade of [0,.02,.1]){const z=(x,y)=>grade*x+.01*grade*y,b=square(z);
  const m=S.add(b,p(5,5,z(5,5))),a=S.add(b,p(5,0,z(5,0))),c=S.add(b,p(5,10,z(5,10)));S.connect(b,[a,m,c]);
  S.move(b,[m],{x:1,y:0});const n=b.sketch.nodes.find(n=>n.id===m);
  assert.equal(b.faces.length,2,`grade ${grade}`);assert.equal(n.x,6);assert.ok(Math.abs(n.z-z(6,5))<1e-9,'the dragged point is lifted onto its face');
  assert.ok(b.faces.every(f=>f.points.some(q=>q.nodeId===m)));assert.ok(Math.abs(area(b)-100)<1e-9);assert.ok(onOwnPlane(b));
 }
});
test('a point on the fold between two pitched faces slides along the fold',()=>{
 const b={faces:[{id:'flat',points:[p(0,0),p(5,0),p(5,10),p(0,10)]},{id:'pitch',points:[p(5,0),p(10,0,1),p(10,10,1),p(5,10)]}]};S.rebind(b,b);
 S.add(b,p(5,5));S.resolve(b);S.rebind(b,b);const id=fixedAt(b,5,5)[0].id;
 S.move(b,[id],{x:1,y:1});const n=b.sketch.nodes.find(n=>n.id===id);
 assert.deepEqual([n.x,n.y,n.z],[5,6,0]);assert.equal(b.faces.length,2);assert.ok(Math.abs(area(b)-100)<1e-9);assert.ok(onOwnPlane(b));
});
test('a free anchor dragged onto another face takes that face plane',()=>{
 const b={faces:[{id:'low',points:[p(0,0),p(5,0),p(5,10),p(0,10)]},{id:'high',points:[p(5,0,2),p(10,0,2),p(10,10,2),p(5,10,2)]}]};S.rebind(b,b);
 const a=S.add(b,p(2,2));S.resolve(b);S.move(b,[a],{x:5,y:0});const n=b.sketch.nodes.find(n=>n.id===a);assert.deepEqual([n.x,n.y,n.z],[7,2,2]);
});

// #12
test('raising a divider point is refused, never dropped, and leaves the base unchanged',()=>{
 const b=square(),a=S.add(b,p(5,0)),m=S.add(b,p(5,5)),c=S.add(b,p(5,10));S.connect(b,[a,m,c]);const before=JSON.stringify(b);
 assert.throws(()=>S.move(b,[m],{z:1}),/would bend base face/);assert.equal(JSON.stringify(b),before);
 assert.throws(()=>S.setHeights(b,new Map([[m,1]])),/would bend/);assert.equal(JSON.stringify(b),before);
});
test('raising every point of an enclosed section raises it as a step and survives later edits',()=>{
 const b=square(),ids=loop(b,[p(3,3),p(7,3),p(7,7),p(3,7)]);S.rebind(b,b);
 S.move(b,ids,{z:1});const pad=covering(b,{x:5,y:5});assert.equal(pad.length,1);assert.ok(pad[0].points.every(q=>q.z===1));
 assert.ok(Math.abs(area(b)-100)<1e-9);assert.equal(fixedAt(b,3,3).length,2,'the step keeps a vertex at each height');
 S.rebind(b,b);S.add(b,p(9,9));S.resolve(b);assert.equal(covering(b,{x:5,y:5}).length,1);assert.ok(Math.abs(area(b)-100)<1e-9);assert.ok(onOwnPlane(b));
});
test('setHeights tilts a section whose new corner heights stay planar and moves free anchors as drawn',()=>{
 const b=square(),ids=loop(b,[p(3,3),p(7,3),p(7,7),p(3,7)]),free=S.add(b,p(1,1));S.resolve(b);
 S.setHeights(b,new Map([[ids[0],0],[ids[1],0],[ids[2],1],[ids[3],1],[free,.5]]));
 const pad=covering(b,{x:5,y:5})[0],pl=G.plane(pad.points);assert.ok(Math.abs(pl.dy-.25)<1e-9);assert.ok(onOwnPlane(b));
 const anchor=b.sketch.nodes.find(n=>n.id===free);assert.equal(anchor.z,.5);assert.ok(anchor.userDraftPoint);
});
test('sketch editor M on a divider point shows the refusal and commits nothing; H levels a section',()=>{
 let base=square(),commits=[],message='';const a=S.add(base,p(2,0)),m=S.add(base,p(2,2)),c=S.add(base,p(2,10));S.connect(base,[a,m,c]);
 const ctx={BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const e=y=>({clientX:200,clientY:y,button:0,buttons:0}),editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),mouse:()=>({e:e(200),v:'3d'}),commit:b=>commits.push(b),restore:b=>base=b,message:t=>message=t,redraw(){},isCenter:()=>false});
 const before=JSON.stringify(base);editor.selectEntities([p(2,2)],[]);editor.keyDown({key:'m'});editor.move(e(150),'3d');assert.match(message,/would bend/);editor.down(e(150),'3d');
 assert.equal(commits.length,0);assert.equal(JSON.stringify(base),before);
 const u=S.add(base,p(6,6)),w=S.add(base,p(8,8));S.connect(base,[u,w]);S.setHeights(base,new Map([[w,1]]));editor.selectEntities([p(6,6),p(8,8,1)],[]);
 editor.keyDown({key:'h'});assert.equal(commits.length,1);for(const id of [u,w])assert.equal(base.sketch.nodes.find(n=>n.id===id).z,.5,'H levels the drawn points to their average height');
});

// #13
test('deleting the fold between faces on different planes is refused instead of deleting both',()=>{
 for(const extra of [false,true]){const b={faces:[{id:'flat',points:[p(0,0),p(5,0),p(5,10),p(0,10)]},{id:'pitch',points:[p(5,0),p(10,0,1),p(10,10,1),p(5,10)]},...(extra?[{id:'other',points:[p(-5,0),p(0,0),p(0,10),p(-5,10)]}]:[])]};
  S.rebind(b,b);const nodes=new Map(b.sketch.nodes.map(n=>[n.id,n])),seam=b.sketch.edges.filter(e=>nodes.get(e.a).x===5&&nodes.get(e.b).x===5),before=JSON.stringify(b);
  assert.throws(()=>S.remove(b,[],seam.map(e=>e.id)),/fold between base faces/);assert.equal(JSON.stringify(b),before);
 }
 const b=square(),a=S.add(b,p(5,0)),c=S.add(b,p(5,10));S.connect(b,[a,c]);S.remove(b,[],b.sketch.edges.filter(e=>!e.fixed).map(e=>e.id));assert.equal(b.faces.length,1,'a coplanar divider still merges');
});

// #14
test('an enclosed raised section leaves no ghost copy at its old height',()=>{
 for(const slitFirst of [false,true]){const b=square();let ids;
  if(slitFirst){ids=[p(3,3),p(7,3),p(7,7),p(3,7)].map(q=>S.add(b,q));S.connect(b,[S.add(b,p(3,0)),ids[0]]);S.connect(b,[...ids,ids[0]]);}else{ids=loop(b,[p(3,3),p(7,3),p(7,7),p(3,7)]);S.connect(b,[S.add(b,p(3,0)),ids[0]]);}
  S.rebind(b,b);const before=copy(b),pad=b.faces.find(f=>Math.abs(K.area({points:f.points})-16)<1e-6);pad.points.forEach(q=>q.z+=1);S.rebind(before,b);S.rebind(b,b);
  S.add(b,p(9,9));S.resolve(b);assert.ok(Math.abs(area(b)-100)<1e-9,`slit first ${slitFirst}`);assert.deepEqual(covering(b,{x:5,y:5}).map(f=>f.points[0].z),[1]);
 }
});
test('a legacy overlapping raised section is repaired on the next edit',()=>{
 const b={faces:[{id:'outer',points:[p(0,0),p(10,0),p(10,10),p(0,10)]},{id:'pad',points:[p(3,3,1),p(7,3,1),p(7,7,1),p(3,7,1)]}]};S.rebind(b,b);
 const ids=[p(3,3),p(7,3),p(7,7),p(3,7)].map(q=>S.add(b,q));b.sketch.edges.push(...ids.map((a,i)=>({id:'legacy-'+i,a,b:ids[(i+1)%4],fixed:false,userConnection:true})));
 S.resolve(b);assert.ok(Math.abs(area(b)-100)<1e-9);assert.deepEqual(covering(b,{x:5,y:5}).map(f=>f.id),['pad']);assert.equal(covering(b,{x:1,y:1}).length,1);
});

// #37
test('a closed loop inside a face is a hole: the surround is split into simple pieces covering it once',()=>{
 const z=(x,y)=>.1*x+.02*y,cases=[
  {name:'flat',b:square(),loops:[[p(3,3),p(6,3),p(6,6),p(3,6)]],total:100,probes:[[4.5,4.5],[1,1],[8,8]]},
  {name:'sloped',b:square(z),loops:[[[3,3],[6,3],[6,6],[3,6]].map(([x,y])=>p(x,y,z(x,y)))],total:100,probes:[[4.5,4.5],[1,1]]},
  {name:'two holes',b:{faces:[{id:'b',points:[p(0,0),p(20,0),p(20,10),p(0,10)]}]},loops:[[p(2,2),p(5,2),p(5,5),p(2,5)],[p(12,4),p(16,4),p(16,8),p(12,8)]],total:200,probes:[[3,3],[14,6],[9,9]]},
  {name:'L shape',b:{faces:[{id:'L',points:[p(0,0),p(10,0),p(10,4),p(4,4),p(4,10),p(0,10)]}]},loops:[[p(1,1),p(3,1),p(3,3),p(1,3)]],total:64,probes:[[2,2],[8,2],[2,8]]},
  {name:'nested island',b:square(),loops:[[p(2,2),p(8,2),p(8,8),p(2,8)],[p(4,4),p(6,4),p(6,6),p(4,6)]],total:100,probes:[[5,5],[3,3],[1,1]]},
 ];
 for(const c of cases){for(const l of c.loops)loop(c.b,l);for(const pass of [0,1]){
  assert.ok(Math.abs(area(c.b)-c.total)<1e-9,c.name);for(const [x,y] of c.probes)assert.equal(covering(c.b,{x,y}).length,1,`${c.name} (${x},${y})`);
  assert.ok(c.b.faces.every(f=>!f.holes?.length));assert.ok(onOwnPlane(c.b));S.rebind(c.b,c.b);S.resolve(c.b);}}
});
test('hole cuts are derived: they cannot be deleted directly and leave with their hole',()=>{
 const b={faces:[{id:'b',points:[p(0,0),p(20,0),p(20,10),p(0,10)]}]},first=loop(b,[p(2,2),p(5,2),p(5,5),p(2,5)]);loop(b,[p(12,4),p(16,4),p(16,8),p(12,8)]);S.rebind(b,b);
 const cut=b.sketch.edges.find(e=>e.holeCut),before=JSON.stringify(b);assert.ok(cut);assert.throws(()=>S.remove(b,[],[cut.id]),/enclosed region/);assert.equal(JSON.stringify(b),before);
 const corners=new Set([[2,2],[5,2],[5,5],[2,5]].flatMap(([x,y])=>fixedAt(b,x,y).map(n=>n.id)));
 S.remove(b,[],b.sketch.edges.filter(e=>!e.holeCut&&corners.has(e.a)&&corners.has(e.b)).map(e=>e.id));
 assert.equal(b.sketch.edges.filter(e=>e.holeCut).length,2,'only the remaining hole keeps its cuts');assert.ok(Math.abs(area(b)-200)<1e-9);
 const degree=id=>b.sketch.edges.filter(e=>e.a===id||e.b===id).length;assert.ok(b.sketch.edges.filter(e=>!e.fixed).every(e=>degree(e.a)>1&&degree(e.b)>1),'no dangling cut remains');
 assert.ok(first.length);
});
test('a closed curve inside a face cuts its surround through real curve points',()=>{
 const b=square(),curve={type:'ellipse',center:p(5,5),u:p(1,0),v:p(0,1),radiusX:2,radiusY:2,sweep:2*Math.PI};S.addCurve(b,curve);
 assert.equal(b.faces.length,3);assert.ok(Math.abs(area(b)-100)<1e-6);assert.equal(covering(b,{x:5,y:5}).length,1);
 const cuts=b.sketch.edges.filter(e=>e.holeCut),ids=new Set(b.sketch.nodes.map(n=>n.id));assert.equal(cuts.length,2);assert.ok(cuts.every(e=>ids.has(e.a)&&ids.has(e.b)),'cut ends are persistent nodes');
 const saved=copy(b);S.rebind(saved,saved);S.resolve(saved);assert.ok(Math.abs(area(saved)-100)<1e-6);assert.equal(saved.faces.length,3);
});
test('a region enclosed only by wall boundary that no face covered stays open',()=>{
 const O=[p(0,0),p(20,0),p(20,20),p(0,20)],I=[p(6,6),p(14,6),p(14,14),p(6,14)],b={faces:[0,1,2,3].map(i=>({id:'b'+i,points:[O[i],O[(i+1)%4],I[(i+1)%4],I[i]]}))};
 S.ensure(b);S.connect(b,[S.add(b,p(2,0)),S.add(b,p(2,20))]);assert.ok(Math.abs(area(b)-336)<1e-9);assert.equal(covering(b,{x:10,y:10}).length,0);
});

// #8
test('Reground keeps faces, finishes, stickers, drawing and cuts and fits them to the grade',()=>{
 const roof={faces:[{id:0,points:[p(0,0,5),p(10,0,5),p(10,10,8),p(0,10,8)]}]},grade=T.reference({points:[p(-3,-3,1),p(13,-3,1.32),p(13,13,1.32),p(-3,13,1)],source:'DSM'},roof),at=q=>grade.plane.dx*q.x+grade.plane.dy*q.y+grade.plane.k;
 const b=square(),a=S.add(b,p(5,0)),c=S.add(b,p(5,10));S.connect(b,[a,c]);const anchor=S.add(b,p(2,2));S.addCurve(b,{type:'ellipse',center:p(7.5,5),u:p(1,0),v:p(0,1),radiusX:1,radiusY:1,sweep:Math.PI});
 S.rebind(b,b);const right=b.faces.find(f=>f.points.every(q=>q.x>=5));right.material='brick';right.feature={kind:'door'};const ids=b.faces.map(f=>f.id).sort();
 const plan=B.reground(b,grade),next=plan.base;assert.deepEqual(plan.lost,[]);
 assert.deepEqual(next.faces.map(f=>f.id).sort(),ids);const kept=next.faces.find(f=>f.id===right.id);assert.equal(kept.material,'brick');assert.deepEqual(kept.feature,{kind:'door'});
 assert.ok(next.faces.every(f=>f.points.every(q=>Math.abs(q.z-at(q))<1e-7)));assert.ok(next.sketch.nodes.every(n=>Math.abs(n.z-at(n))<1e-7));
 assert.ok(next.sketch.nodes.some(n=>n.id===anchor&&n.userDraftPoint));assert.ok(next.sketch.edges.some(e=>!e.fixed&&!e.curveId));assert.equal(next.sketch.curves.length,1);
 assert.ok(K.curveSamples(next.sketch.curves[0]).every(q=>Math.abs(q.z-at(q))<1e-7),'curves follow the grade');assert.equal(b.faces[0].points[0].z,0,'input unchanged');
 const cuts=[{faceIds:[right.id],points:[p(6,1),p(7,1),p(7,2)]},{points:[p(1,1),p(2,1),p(2,2)]}];assert.deepEqual(B.followCuts(cuts,next),cuts);
});
test('Reground divides a face that spans grade planes and keeps cuts on every piece',()=>{
 const b={faces:[{id:'f',material:'brick',points:[p(0,0,50),p(4,0,50),p(4,4,50),p(0,4,50)]}]},grade={points:[p(0,0,0),p(2,0,0),p(2,4,0),p(0,4,0),p(4,0,2),p(4,4,2)],faces:[[0,1,2,3],[1,4,5,2]]};
 const next=B.fitGrade(b,grade);assert.equal(next.faces.length,2);assert.ok(next.faces.every(f=>f.material==='brick'));assert.deepEqual(next.faces.map(f=>f.id).sort(),['f','f~grade-1']);
 assert.deepEqual(B.followCuts([{faceIds:['f'],points:[]}],next)[0].faceIds.sort(),['f','f~grade-1']);
});
test('Reground rebuilds a step pattern on a sloped grade and reports one a flat grade cannot carry',()=>{
 const sloped={faces:[{id:'base',points:[p(0,0),p(12,0,3),p(12,8,3),p(0,8)]}]},stepped=Steps.basePattern(sloped,'base',2,.4).base,count=stepped.faces.length;
 const roof={faces:[{id:0,points:[p(0,0,5),p(12,0,5),p(12,8,5),p(0,8,5)]}]},slope=T.reference({points:[p(-3,-3,9),p(15,-3,13.5),p(15,11,13.5),p(-3,11,9)],source:'DSM'},roof);
 const plan=B.reground(stepped,slope);assert.deepEqual(plan.lost,[]);assert.equal(plan.base.faces.length,count);assert.ok(plan.base.faces.every(f=>f.baseStepId&&f.points.every(q=>q.z===f.points[0].z)),'treads stay horizontal');
 assert.ok(Math.abs(area(plan.base)-96)<1e-6);const heights=[...new Set(plan.base.faces.map(f=>+f.points[0].z.toFixed(6)))];assert.equal(heights.length,count);assert.ok(Math.min(...heights)>9);
 const flat=B.reground(stepped,T.reference({points:[],source:'Flat'},roof));assert.equal(flat.lost.length,1);assert.match(flat.lost[0].message,/Pitch the base first/);assert.equal(flat.base.stepPatterns,undefined);assert.ok(flat.base.faces.every(f=>!f.baseStepId));
});
test('the Reground button warns before removing a step pattern and Cancel keeps the base',()=>{
 const els=new Map(),el=()=>({value:'point',dataset:{},style:{},setAttribute(){},appendChild(){},getScreenCTM(){return {};}}),document={getElementById:id=>{if(!els.has(id))els.set(id,el());return els.get(id);},createElement:el};
 const sloped={faces:[{id:'base',points:[p(0,0),p(12,0,3),p(12,8,3),p(0,8)]}]},state={base:{visible:true,...Steps.basePattern(sloped,'base',2,.4).base},roof:{faces:[{id:0,points:[p(0,0,5),p(12,0,5),p(12,8,5),p(0,8,5)]}]}};state.ground=T.reference({points:[],source:'Flat'},state.roof);
 let asked='';const ctx={ExteriorGeometry:K,WallSolidGeometry:W,WallSteps:Steps,WallBaseBinding:F,BaseSketchGeometry:S,BaseGeometry:B,WallGeometry:G,document,confirm:m=>{asked=m;return false;},DOMPoint:class{constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}},addEventListener(){}};ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_editor.js','utf8'),ctx);
 const editor=ctx.createBaseEditor({state:()=>state,ensure:()=>true,enabled:()=>true,id:()=>1,layer:()=>'base',setLayer(){},pickVisible(){},toPixel:q=>q,position:(e,v,z)=>({x:e.clientX,y:e.clientY,z}),changed(){},redraw(){}});editor.setup(el());editor.render();
 const before=JSON.stringify(state.base);els.get('base-rebuild-grade').onclick();assert.match(asked,/step pattern cannot be kept/);assert.equal(JSON.stringify(state.base),before);
 ctx.confirm=()=>true;els.get('base-rebuild-grade').onclick();assert.equal(state.base.stepPatterns,undefined);assert.ok(Math.abs(area(state.base)-96)<1e-6);
});
test('Reground fits a base that extends past the drawn grade tile and keeps a courtyard open',()=>{
 const roof={faces:[{id:0,points:[p(0,0,5),p(10,0,5),p(10,10,8),p(0,10,8)]}]},grade=T.reference({points:[],source:'Flat'},roof);
 const wide={faces:[{id:'b',points:[p(0,0),p(14,0),p(14,10),p(0,10)]}]};assert.ok(Math.abs(area(B.fitGrade(wide,grade))-140)<1e-9);
 const O=[p(0,0),p(20,0),p(20,20),p(0,20)],I=[p(6,6),p(14,6),p(14,14),p(6,14)],court={faces:[0,1,2,3].map(i=>({id:'b'+i,points:[O[i],O[(i+1)%4],I[(i+1)%4],I[i]]}))};
 const next=B.fitGrade(court,grade);assert.equal(next.faces.length,4);assert.ok(Math.abs(area(next)-336)<1e-9);
});

// #65 #68 #69
test('generated bases leave open courtyards open, from the roof footprint or from nested wall loops',()=>{
 const O=[p(0,0,5),p(20,0,5),p(20,20,5),p(0,20,5)],I=[p(6,6,7),p(14,6,7),p(14,14,7),p(6,14,7)],roof={points:[...O,...I],connections:[],faces:[0,1,2,3].map(i=>({id:i,points:[O[i],O[(i+1)%4],I[(i+1)%4],I[i]]}))},grade=T.reference({points:[],source:'Flat'},roof);
 for(const [setback,expected] of [[0,336],[.3,19.4*19.4-8.6*8.6]]){const b=B.fromRoof(roof,grade,[],setback,{items:[]});assert.ok(Math.abs(area(b)-expected)<1e-6,`setback ${setback}`);assert.equal(covering(b,{x:10,y:10}).length,0);assert.ok(b.faces.every(f=>covering(b,B.center({points:K.triangles(f.points).triangles[0].map(i=>f.points[i])})).length===1));}
 const w=(a,c,id)=>({id,bottom:[p(...a),p(...c)],top:[p(...a,3),p(...c,3)]}),walls=[w([0,0],[20,0],'s'),w([20,0],[20,20],'e'),w([20,20],[0,20],'n'),w([0,20],[0,0],'w'),w([6,6],[14,6],'cs'),w([14,6],[14,14],'ce'),w([14,14],[6,14],'cn'),w([6,14],[6,6],'cw')];
 const traced=B.fromRoof(roof,{points:[p(-5,-5),p(25,-5),p(25,25),p(-5,25)],faces:[[0,1,2],[0,2,3]]},walls,0,{items:[]});assert.equal(traced.source,'Wall perimeter');assert.ok(Math.abs(area(traced)-336)<1e-9);assert.equal(covering(traced,{x:10,y:10}).length,0);
 S.ensure(traced);S.rebind(traced,traced);S.remove(traced,[],traced.sketch.edges.filter(e=>!e.fixed).map(e=>e.id));assert.ok(Math.abs(area(traced)-336)<1e-9,'deleting the generated cuts does not fill the courtyard');assert.equal(covering(traced,{x:10,y:10}).length,0);
});
test('a roof sliver or a zero-length eave does not block base generation',()=>{
 const sliver={points:[],connections:[],faces:[{id:0,points:[p(0,0,5),p(10,0,5),p(10,10,5),p(0,10,5)]},{id:1,points:[p(12,0,5),p(12.03,0,5),p(12,.03,5)]}]},grade=T.reference({points:[],source:'Flat'},sliver);
 for(const [setback,sources] of [[0,null],[0,[]],[.3,null]])assert.equal(B.fromRoof(sliver,grade,[],setback,{items:[]},sources).faces.length,1);
 const pts=[p(0,0,5),p(10,0,5),p(10,1,5),p(0,1,5)],conns=[{startIdx:0,endIdx:1,type:'eave'},{startIdx:1,endIdx:2,type:'rake'},{startIdx:2,endIdx:3,type:'eave'},{startIdx:3,endIdx:0,type:'rake'}],walkway={points:pts,connections:conns,faces:[{id:0,points:pts}]};
 const clean=B.fromRoof(walkway,grade,[],.6,{items:[]}),repeated=B.fromRoof({...walkway,connections:[...conns,{startIdx:1,endIdx:1,type:'eave'}]},grade,[],.6,{items:[]});assert.deepEqual(repeated.faces,clean.faces);
});

// #66
test('raising the base above an attached wall top is refused for edited and generated walls',()=>{
 const before={faces:[{id:'base',points:[p(0,0),p(8,0),p(8,4),p(0,4)]}]},after=copy(before);after.faces[0].points.forEach(q=>q.z=5);
 assert.throws(()=>F.face({id:'front',points:[p(0,0),p(8,0),p(8,0,4),p(0,0,4)]},before,after),/above the top/);
 const generated={id:'g',bottom:[p(0,0),p(8,0)],top:[p(0,0,4),p(8,0,4)]};assert.throws(()=>F.check([generated],before,after),/above the top of wall g/);
 const lower=copy(before);lower.faces[0].points.forEach(q=>q.z=1);assert.doesNotThrow(()=>F.check([generated],before,lower));
});

// #70
test('upgrading a version 1 sketch keeps anchors on stepped faces, exterior anchors and lines across a step',()=>{
 const n=(id,x,y,z,fixed=false)=>({id,x,y,z,fixed}),b={faces:[{id:'A',points:[{...p(0,0),nodeId:'p0'},{...p(5,0),nodeId:'p1'},{...p(5,10),nodeId:'p2'},{...p(0,10),nodeId:'p3'}]},{id:'B',points:[{...p(5,0,1),nodeId:'p1'},{...p(10,0,1),nodeId:'p4'},{...p(10,10,1),nodeId:'p5'},{...p(5,10,1),nodeId:'p2'}]}],
  sketch:{version:1,next:20,nodes:[n('p0',0,0,0,true),n('p1',5,0,0,true),n('p2',5,10,0,true),n('p3',0,10,0,true),n('p4',10,0,1,true),n('p5',10,10,1,true),n('p10',2,2,0),n('p11',2,8,0),n('p12',7,5,1),n('p13',12,5,0)],
  edges:[{id:'e0',a:'p0',b:'p1',fixed:true},{id:'e1',a:'p1',b:'p2',fixed:false},{id:'e2',a:'p2',b:'p3',fixed:true},{id:'e3',a:'p3',b:'p0',fixed:true},{id:'e4',a:'p1',b:'p4',fixed:true},{id:'e5',a:'p4',b:'p5',fixed:true},{id:'e6',a:'p5',b:'p2',fixed:true},{id:'e10',a:'p10',b:'p11',fixed:false},{id:'e11',a:'p11',b:'p12',fixed:false}],outlines:[]}};
 const faces=JSON.stringify(b.faces.map(f=>f.points.map(q=>[q.x,q.y,q.z])));assert.equal(S.upgrade(b),true);const s=b.sketch,N=new Map(s.nodes.map(n=>[n.id,n]));
 assert.equal(s.version,2);assert.equal(JSON.stringify(b.faces.map(f=>f.points.map(q=>[q.x,q.y,q.z]))),faces);
 for(const [x,y,z] of [[2,2,0],[2,8,0],[7,5,1],[12,5,0]])assert.ok(s.nodes.some(n=>n.x===x&&n.y===y&&n.z===z&&n.userDraftPoint),`anchor ${x},${y},${z}`);
 const lines=s.edges.filter(e=>!e.fixed).map(e=>[N.get(e.a),N.get(e.b)]).map(([a,c])=>[a.x,a.y,a.z,+c.x.toFixed(6),+c.y.toFixed(6),c.z].join(','));
 assert.ok(lines.includes('2,8,0,5,6.2,0')&&lines.includes('5,6.2,1,7,5,1'),'the crossing line is lifted onto each face: '+lines.join(' '));
});

// #124
test('curve sample tests built once per pass agree with the per-point test',()=>{
 const b={faces:[{id:'base',points:[p(0,0),p(12,0),p(12,10),p(0,10)]}]};S.connect(b,[S.add(b,p(6,0)),S.add(b,p(6,10))]);
 S.addCurve(b,{type:'arc',center:p(6,0),u:p(1,0),v:p(0,1),radiusX:6,radiusY:4,sweep:Math.PI});S.addCurve(b,{type:'arc',center:p(6,10),u:p(1,0),v:p(0,-1),radiusX:6,radiusY:3,sweep:Math.PI});
 const test=S.curveSampleTest(b),points=[...b.faces.flatMap(f=>f.points),...b.sketch.nodes,...Array.from({length:400},(_,i)=>p((i*7.31)%12,(i*3.17)%10))];
 let samples=0;for(const q of points){const expected=S.isCurveSample(b,q);assert.equal(test(q),expected);samples+=expected;}assert.ok(samples>50);
 assert.equal(S.curveSampleTest(square())(p(1,1)),false);
});
test('base and sketch editors read the base a bounded number of times per draw',()=>{
 const b={faces:[{id:'base',points:[p(0,0),p(12,0),p(12,10),p(0,10)]}]};S.connect(b,[S.add(b,p(6,0)),S.add(b,p(6,10))]);for(let k=0;k<3;k++)S.addCurve(b,{type:'arc',center:p(6,10),u:p(1,0),v:p(0,-1),radiusX:6,radiusY:2+k,sweep:Math.PI});
 let reads=0,tests=0;const counted={...S,isCurveSample:(...a)=>{tests++;return S.isCurveSample(...a);}},ctx={BaseSketchGeometry:counted,ExteriorGeometry:K,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>{reads++;return b;},active:()=>true,mode:()=>'point',faceAt:()=>b.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:q=>({x:q.x*100,y:q.y*100}),toPixel:q=>q,commit(){},restore(){},message(){},redraw(){},isCenter:()=>false});
 editor.setFace(b.faces[0]);editor.draw2D({},()=>{},1);assert.ok(reads<=4,`draw2D read the base ${reads} times`);reads=0;editor.canPick({clientX:300,clientY:300},'2d');assert.ok(reads<=4,`picking read the base ${reads} times`);assert.equal(tests,0,'the per-point curve test is not used per point');
});
test('the foundation outline is reused when only heights change and matches a fresh union',()=>{
 const rings=[[p(0,0),p(5,0),p(5,5),p(0,5)],[p(5,0),p(9,0,1),p(9,5,1),p(5,5)]],first=B.boundary(rings),raised=B.boundary(rings.map(r=>r.map(q=>({...q,z:q.z+3}))));
 assert.deepEqual(raised,first);assert.deepEqual(first,K.union(rings.map(points=>({points}))).map(f=>f.points));first[0][0].x=99;assert.notEqual(B.boundary(rings)[0][0].x,99,'callers get their own copy');
});
