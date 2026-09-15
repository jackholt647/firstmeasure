const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
function fixture(withSketch=false){
 const els=new Map(),listeners={},el=()=>({value:'point',dataset:{},style:{},setAttribute(){},appendChild(){},getScreenCTM(){return {};}});
 const document={getElementById:id=>{if(!els.has(id))els.set(id,el());return els.get(id);},createElement:el};
 const state={base:{visible:true,centers:true,faces:[{id:'f',points:[{x:0,y:0,z:0},{x:100,y:0,z:0},{x:100,y:100,z:0},{x:0,y:100,z:0}]}]}};
 let changes=0,layer='base';const ctx={ExteriorGeometry:require('../public/measure/internal/editor_scripts/exterior_geometry.js'),WallSolidGeometry:require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),WallSteps:require('../public/measure/internal/editor_scripts/wall_steps.js'),WallAxisCuts:require('../public/measure/internal/editor_scripts/wall_axis_cuts.js'),document,WallBaseBinding:require('../public/measure/internal/editor_scripts/wall_base_binding.js'),BaseGeometry:B,WallGeometry:G,DOMPoint:class{constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}},addEventListener:(k,fn)=>listeners[k]=fn};ctx.window=ctx;
 vm.createContext(ctx);if(withSketch){ctx.BaseSketchGeometry=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);}vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_editor.js','utf8'),ctx);
 const editor=ctx.createBaseEditor({state:()=>state,ensure:()=>true,enabled:()=>true,id:()=>1,layer:()=>layer,setLayer:x=>layer=x,pickVisible(){},toPixel:p=>p,position:(e,v,z)=>({x:e.clientX,y:e.clientY,z}),changed:()=>changes++,redraw(){}});
 editor.setup(el());editor.render();
 const e=(x,y,shiftKey=false)=>({clientX:x,clientY:y,button:0,buttons:1,shiftKey,target:{closest:s=>s==='#viewport'},preventDefault(){},stopImmediatePropagation(){}});
 const click=(x,y,shift=false)=>{editor.down(e(x,y,shift));listeners.pointerup(e(x,y));};
 const key=key=>editor.keyDown({key,preventDefault(){},stopImmediatePropagation(){}});
 return {ctx,editor,state,listeners,e,click,key,els,changes:()=>changes};
}
test('selected boundary points connect into two separately editable faces',()=>{
 const f=fixture();f.click(0,0);f.click(100,100,true);f.key('c');
 assert.equal(f.state.base.faces.length,2);assert.equal(f.changes(),1);
 f.els.get('base-undo').onclick();assert.equal(f.state.base.faces.length,1);
});
test('M translates the selected face and Escape restores an unfinished drag',()=>{
 const f=fixture();f.click(50,50);f.key('m');f.listeners.pointermove(f.e(50,0));assert.equal(f.changes(),0);f.click(50,0);
 assert.ok(f.state.base.faces[0].points.every(p=>p.z===1.5));
 f.key('m');f.listeners.pointermove(f.e(50,-50));f.key('escape');
 assert.ok(f.state.base.faces[0].points.every(p=>p.z===1.5));
});
test('Y direction snaps to 45 degrees, keeps the pivot fixed, and H flattens the face',()=>{
 const f=fixture();f.click(50,50);f.key('y');f.click(80,79);f.listeners.pointermove(f.e(80,29));assert.equal(f.changes(),0);f.click(80,29);
 const plane=G.plane(f.state.base.faces[0].points);assert.ok(Math.abs(plane.dx-plane.dy)<1e-8);
 assert.ok(Math.abs(plane.dx*50+plane.dy*50+plane.k)<1e-8);
 f.key('h');assert.ok(f.state.base.faces[0].points.every(p=>Math.abs(p.z)<1e-8));
});
test('N draws a multi-segment cut between boundary points',()=>{
 const f=fixture();f.click(50,50);f.key('n');f.click(50,0);f.click(30,50);f.click(50,100);f.key('enter');
 assert.equal(f.state.base.faces.length,2);
});
test('rectangle selection selects boundary points and Shift extends it without moving geometry',()=>{
 const f=fixture(),before=JSON.stringify(f.state.base);
 f.editor.down(f.e(-10,-10));f.listeners.pointermove(f.e(10,10));f.listeners.pointerup(f.e(10,10));
 assert.match(f.els.get('base-status').textContent,/1 selected points/);
 f.editor.down(f.e(90,90,true));f.listeners.pointermove(f.e(110,110,true));f.listeners.pointerup(f.e(110,110,true));
 assert.match(f.els.get('base-status').textContent,/2 selected points/);
 assert.equal(JSON.stringify(f.state.base),before);f.key('c');assert.equal(f.state.base.faces.length,2);
});
test('pitch mouse-up does not commit; cancellation rolls back the live preview',()=>{
 const f=fixture();f.click(50,50);const before=JSON.stringify(f.state.base);
 f.key('y');f.click(80,50);f.listeners.pointermove(f.e(80,0));f.listeners.pointerup(f.e(80,0));
 assert.notEqual(JSON.stringify(f.state.base),before);assert.equal(f.changes(),0);
 f.key('escape');assert.equal(JSON.stringify(f.state.base),before);
});
test('pitch circle follows the tilted face and retains its center',()=>{
 const f=fixture();f.click(50,50);f.key('y');f.click(80,50);f.listeners.pointermove(f.e(80,0));
 const lines=[];
 f.editor.draw2D({},(tag,attrs)=>{if(tag==='polyline')lines.push(attrs.points);return {};},1);
 const ps=lines[0].split(' ').map(s=>s.split(',').map(Number));
 assert.deepEqual(ps[0],[50,50]);
 assert.ok(ps[1][0]<80,'tilted circle projects to a narrower ellipse');
 f.click(80,0);assert.equal(f.changes(),1);
});
test('multi-face H cycles original planes, shared horizontal, and wraps without accumulating deformation',()=>{
 const f=fixture();
 f.state.base.faces[0].points.forEach(p=>p.z=.1*p.x);
 f.state.base.faces.push({id:'g',points:[{x:120,y:0,z:20},{x:220,y:0,z:20},{x:220,y:100,z:40},{x:120,y:100,z:40}]});
 const original=JSON.stringify(f.state.base),planes=f.state.base.faces.map(face=>G.plane(face.points));
 f.els.get('base-selection').value='face';f.click(50,50);f.click(170,50,true);
 assert.match(f.els.get('base-status').textContent,/2 faces selected/);
 const check=plane=>{for(const face of f.state.base.faces)for(const p of face.points)assert.ok(Math.abs(p.z-(plane.dx*p.x+plane.dy*p.y+plane.k))<1e-8);};
 f.key('h');check(planes[0]);assert.match(f.els.get('base-status').textContent,/Coplanar to f/);
 f.key('h');check(planes[1]);assert.match(f.els.get('base-status').textContent,/Coplanar to g/);
 f.key('h');check({dx:0,dy:0,k:17.5});
 f.key('h');check(planes[0]);
 f.editor.keyDown({key:'z',ctrlKey:true,preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(JSON.stringify(f.state.base),original,'one undo restores the pre-cycle geometry');
});
test('single-face H flattens and is undoable; face rectangle selection supports additive selection',()=>{
 const f=fixture();f.state.base.faces[0].points.forEach(p=>p.z=p.x*.1);
 const original=JSON.stringify(f.state.base);f.click(50,50);f.key('h');
 assert.ok(f.state.base.faces[0].points.every(p=>p.z===5));
 f.editor.keyDown({key:'z',ctrlKey:true,preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(JSON.stringify(f.state.base),original);
 f.state.base.faces.push({id:'g',points:[{x:120,y:0,z:20},{x:220,y:0,z:20},{x:220,y:100,z:20},{x:120,y:100,z:20}]});
 f.els.get('base-selection').value='face';
 f.editor.down(f.e(-10,-10));f.listeners.pointermove(f.e(110,110));f.listeners.pointerup(f.e(110,110));
 f.editor.down(f.e(115,-10,true));f.listeners.pointermove(f.e(225,110));f.listeners.pointerup(f.e(225,110));
 assert.match(f.els.get('base-status').textContent,/2 faces selected/);
 f.key('h');for(const face of f.state.base.faces)for(const p of face.points)assert.ok(Math.abs(p.z-p.x*.1)<1e-8);
});
test('grade readout follows live pitch in percent and degrees and resets on cancel',()=>{
 const f=fixture();f.click(50,50);f.key('y');f.click(80,50);
 f.listeners.pointermove(f.e(80,0));
 assert.equal(f.els.get('base-grade-readout').textContent,'Face grade: 5.0% · 2.9°');
 f.key('escape');
 assert.equal(f.els.get('base-grade-readout').textContent,'Face grade: 0.0% · 0.0°');
});
test('sketch double-click/N create editable points, C/U connect, line Delete merges, and undo restores',()=>{
 const f=fixture(true);
 f.editor.doubleClick(f.e(50,0));
 f.key('n');f.listeners.pointermove(f.e(50,100));f.click(50,100);
 assert.equal(f.state.base.sketch.nodes.filter(n=>n.x===50).length,2);
 f.click(50,0);f.click(50,100,true);f.key('u');
 assert.equal(f.state.base.faces.length,2);
 f.els.get('base-selection').value='line';f.els.get('base-selection').onchange();
 f.click(50,25);f.key('delete');assert.equal(f.state.base.faces.length,1);
 f.editor.keyDown({key:'z',ctrlKey:true,preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(f.state.base.faces.length,2);
});
test('sketch fixed points and lines can be selected but not moved or deleted',()=>{
 const f=fixture(true);f.editor.down(f.e(0,0));f.listeners.pointermove(f.e(20,20));f.listeners.pointerup(f.e(20,20));f.key('delete');
 assert.equal(f.state.base.sketch.nodes.filter(n=>n.fixed).length,4);
 assert.ok(f.state.base.sketch.nodes.some(n=>n.x===0&&n.y===0));
 f.els.get('base-selection').value='line';f.els.get('base-selection').onchange();f.click(25,0);f.key('delete');
 assert.equal(f.state.base.sketch.edges.filter(e=>e.fixed).length,4);
});
test('user point dragging and deletion preserve the fixed outline',()=>{
 const f=fixture(true);f.editor.doubleClick(f.e(30,30));
 f.editor.down(f.e(30,30));f.listeners.pointermove(f.e(40,40));f.listeners.pointerup(f.e(40,40));
 const n=f.state.base.sketch.nodes.find(n=>!n.fixed);assert.equal(n.x,40);assert.equal(n.y,40);
 f.key('delete');assert.equal(f.state.base.sketch.nodes.filter(n=>!n.fixed).length,0);
 assert.equal(f.state.base.faces.length,1);
});

test('rebuild foundation button fits grade, clears old edits and cuts, and Undo restores them',()=>{
 const f=fixture(true);f.state.ground={points:[{x:-1,y:-1,z:.8},{x:101,y:-1,z:11},{x:101,y:101,z:21.2},{x:-1,y:101,z:11}],faces:[[0,1,2],[0,2,3]]};
 f.click(0,0);f.click(100,100,true);f.key('c');f.state.wallEdits={$baseCuts:[{points:[{x:10,y:10,z:0},{x:20,y:10,z:0},{x:10,y:20,z:0}]}]};
 const before=JSON.stringify(f.state.base),cuts=JSON.stringify(f.state.wallEdits.$baseCuts);f.els.get('base-rebuild-grade').onclick();
 assert.equal(f.state.base.faces.length,1);assert.equal(f.state.base.sketch,undefined);assert.equal(f.state.wallEdits.$baseCuts,undefined);assert.ok(f.state.base.faces[0].points.every(p=>Math.abs(p.z-(1+.1*p.x+.1*p.y))<1e-7));
 f.els.get('base-undo').onclick();assert.equal(JSON.stringify(f.state.base),before);assert.equal(JSON.stringify(f.state.wallEdits.$baseCuts),cuts);
});

test('base height changes step an edited wall and undo restores both graphs without losing later wall edits',()=>{
 const f=fixture();f.state.base.faces=[{id:'left',points:[{x:0,y:0,z:0},{x:50,y:0,z:0},{x:50,y:100,z:0},{x:0,y:100,z:0}]},{id:'right',points:[{x:50,y:0,z:0},{x:100,y:0,z:0},{x:100,y:100,z:0},{x:50,y:100,z:0}]}];f.state.wallEdits={$surfaces:[{id:'wall',points:[{x:0,y:0,z:0},{x:100,y:0,z:0},{x:100,y:0,z:10},{x:0,y:0,z:10}]}]};f.click(25,50);const before=JSON.stringify(f.state);f.key('m');f.listeners.pointermove(f.e(25,0));f.click(25,0);const ps=f.state.wallEdits.$surfaces[0].points;assert.ok(ps.some(p=>p.x===50&&p.z===1.5));assert.ok(ps.some(p=>p.x===50&&p.z===0));f.state.wallEdits.manualNote='keep';f.els.get('base-visible').onclick();assert.equal(f.state.wallEdits.manualNote,'keep','Visibility must not replay an old wall snapshot');f.els.get('base-undo').onclick();assert.equal(JSON.stringify(f.state),before);
});
test('base M height snaps exactly to an existing plane and cancellation restores the original elevation',()=>{const f=fixture();f.state.base.faces=[{id:'left',points:[{x:0,y:0,z:0},{x:50,y:0,z:0},{x:50,y:100,z:0},{x:0,y:100,z:0}]},{id:'right',points:[{x:50,y:0,z:1},{x:100,y:0,z:1},{x:100,y:100,z:1},{x:50,y:100,z:1}]}];f.click(25,50);f.key('m');f.listeners.pointermove(f.e(25,18));assert.ok(f.state.base.faces[0].points.every(p=>p.z===1));assert.match(f.els.get('base-status').textContent,/snap/);f.key('Escape');assert.ok(f.state.base.faces[0].points.every(p=>p.z===0));});

test('S previews base terraces with attached walls, increments, cancels and commits one undoable edit',()=>{
 const f=fixture(true);f.state.base.faces[0].points.forEach(p=>p.z=p.x*.02);f.state.wallEdits={$surfaces:[{id:'wall',points:[{x:0,y:0,z:0},{x:100,y:0,z:2},{x:100,y:0,z:5},{x:0,y:0,z:5}]}]};f.els.get('base-selection').value='face';f.click(50,50);const before=JSON.stringify(f.state);
 f.key('s');assert.equal(f.state.base.faces.length,2);f.key('s');assert.equal(f.state.base.faces.length,3);assert.ok(f.state.wallEdits.$surfaces[0].points.length>4);f.key('escape');assert.equal(JSON.stringify(f.state),before);
 f.key('s');assert.equal(f.state.base.faces.length,2);f.listeners.pointermove(f.e(30,50));f.key('enter');assert.equal(f.changes(),1);assert.equal(f.state.base.faces.length,2);f.els.get('base-undo').onclick();assert.equal(JSON.stringify(f.state),before);
});
test('Y direction uses the rotated foundation axis instead of the nearby world 45-degree axis',()=>{
 const f=fixture(),angle=42.815*Math.PI/180;
 f.state.base.faces[0].points=f.state.base.faces[0].points.map(p=>{const x=p.x-50,y=p.y-50;return {...p,x:50+x*Math.cos(angle)-y*Math.sin(angle),y:50+x*Math.sin(angle)+y*Math.cos(angle)};});
 f.click(50,50);f.key('y');f.click(80,80);f.editor.distanceInput().set(16);f.click(80,80);
 const plane=G.plane(f.state.base.faces[0].points);assert.ok(Math.abs(Math.atan2(plane.dy,plane.dx)-angle)<1e-8);
 assert.ok(Math.abs(Math.hypot(plane.dx,plane.dy)-Math.tan(16*Math.PI/180))<1e-8);
});

test('base rendering and picking expose only controls on an inherited bottom fillet curve',()=>{
 const f=fixture(true),K=f.ctx.ExteriorGeometry,W=f.ctx.WallSolidGeometry,S=f.ctx.BaseSketchGeometry,p=(x,y,z=0)=>({x,y,z}),a=p(0,0),b=p(100,0),c=p(100,100),d=p(0,100),e=p(0,0,100),g=p(100,0,100),h=p(100,100,100),i=p(0,100,100),scene=[[a,b,g,e],[b,c,h,g],[c,d,i,h],[d,a,e,i],[a,d,c,b],[e,g,h,i]].map((points,index)=>({id:'cube-'+index,points})),result=W.fillet(scene,{edges:[[a,e]]},20),baseFace=result.faces.find(s=>s.id==='cube-4');f.state.base={visible:true,faces:[{...baseFace,id:'f'}]};f.state.wallEdits={$surfaces:K.compactSurfaces(result.faces.filter(s=>s.id!=='cube-4'))};f.state.wallCenters=false;
 const shapes=[];f.editor.draw2D({},(type,attrs)=>shapes.push({type,attrs}),1);assert.equal(f.state.base.sketch.nodes.length,5);const markers=shapes.filter(s=>['circle','rect'].includes(s.type));assert.equal(markers.length,10,'Two layers may mark each real control, but never intermediate samples');assert.ok(shapes.some(s=>s.type==='path'&&s.attrs.d?.startsWith('M ')));
 const sample=baseFace.points.find(p=>S.isCurveSample(f.state.base,p));assert.ok(sample);f.click(sample.x,sample.y);const selected=f.editor.singlePoint();assert.ok(!selected||!S.isCurveSample(f.state.base,selected),'Clicking an evaluation sample can only select a nearby real control');
 class Geometry{setAttribute(){return this;}setIndex(){return this;}setFromPoints(points){this.points=points;return this;}}
 class Material{constructor(o){Object.assign(this,o);}}class Object3D{constructor(geometry,material){Object.assign(this,{geometry,material,userData:{}});}}
 f.ctx.THREE={BufferGeometry:Geometry,Float32BufferAttribute:class{},Mesh:Object3D,Line:Object3D,LineSegments:Object3D,Points:Object3D,MeshBasicMaterial:Material,LineBasicMaterial:Material,PointsMaterial:Material};const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const pointMarkers=objects.filter(o=>o.material.size).flatMap(o=>o.geometry.points||[]);assert.ok(pointMarkers.length<=10);assert.ok(pointMarkers.every(p=>!S.isCurveSample(f.state.base,p)));
});

test('base editor keeps a placed curve after inserting an independent point and connecting a wall edge',()=>{
 const f=fixture(true),S=f.ctx.BaseSketchGeometry;f.ctx.isFreeMove=true;f.editor.doubleClick(f.e(80,50));f.listeners.pointermove(f.e(80,50));f.ctx.isFreeMove=false;f.key('s');f.click(50,50);f.listeners.pointermove(f.e(50,80));f.click(50,80);
 assert.equal(f.state.base.sketch.curves?.length,1);assert.equal(f.state.base.sketch.edges.filter(e=>e.curveId).length,1);
 const curve=JSON.stringify(f.state.base.sketch.curves[0]);f.editor.doubleClick(f.e(30,30));assert.equal(JSON.stringify(f.state.base.sketch.curves[0]),curve);assert.equal(f.state.base.sketch.edges.filter(e=>e.curveId).length,1);
 f.key('n');f.click(0,30);assert.equal(JSON.stringify(f.state.base.sketch.curves[0]),curve);assert.equal(f.state.base.sketch.edges.filter(e=>e.curveId).length,1);assert.ok(S.curveEdges(f.state.base.sketch).filter(e=>e.curveId).length>4);
});

test('selecting a base edge does not silently disable point picking',()=>{
 const f=fixture(true),points=f.state.base.faces[0].points;
 f.editor.selectEntities([],[[points[0],points[1]]],false);
 assert.equal(f.els.get('base-selection').value,'point');
 f.click(0,0);assert.ok(f.editor.singlePoint());
});
