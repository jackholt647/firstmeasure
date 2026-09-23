const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
test('2D base point creation snaps to visible line centers and obeys the toggle',()=>{
 for(const enabled of [true,false]){
  const base={faces:[{id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]},ctx={BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
  const editor=ctx.createBaseSketchEditor({base:()=>base,lineCenters:()=>enabled,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:e=>({x:e.clientX/100,y:e.clientY/100,z:0}),screen:p=>({x:p.x*100,y:p.y*100}),commit(){},restore:b=>Object.assign(base,b),message(){},redraw(){},isCenter:()=>false});
  editor.doubleClick({clientX:194,clientY:3,button:0},'2d');assert.ok(base.sketch.nodes.some(p=>Math.abs(p.x-(enabled?2:1.94))<1e-6&&p.y===0));
 }
});
test('3D base drawing snaps onto edges and connects a pitched face into separately editable pieces',()=>{
 const base={faces:[{id:'base',points:[{x:0,y:0,z:0},{x:10,y:0,z:5},{x:10,y:10,z:5},{x:0,y:10,z:0}]}]};let message='';
 const ctx={WallAxisCuts:require('../public/measure/internal/editor_scripts/wall_axis_cuts.js'),BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100+.5*z,y:e.clientY/100,z}),screen:p=>({x:(p.x-.5*p.z)*100,y:p.y*100}),commit(){},restore:b=>Object.assign(base,b),message:m=>message=m,redraw(){},isCenter:()=>false});
 const e=(x,y,shiftKey=false)=>({clientX:x,clientY:y,shiftKey,button:0});
 editor.doubleClick(e(300,400),'3d');const inner=base.sketch.nodes.find(p=>!p.fixed);assert.ok(Math.abs(inner.x-4)<1e-8);assert.ok(Math.abs(inner.z-2)<1e-8);
 editor.doubleClick(e(300,3),'3d');editor.doubleClick(e(300,997),'3d');const edgeNodes=base.sketch.nodes.filter(p=>Math.abs(p.x-4)<1e-8&&[0,10].includes(p.y));assert.equal(edgeNodes.length,2);
 editor.down(e(300,0,true),'3d');editor.up();editor.keyDown({key:'c'});assert.equal(base.faces.length,2,message);
 editor.down(e(300,400),'3d');assert.equal(editor.busy(),true);editor.cancel();assert.equal(editor.busy(),false);
});

function sharedBaseFixture(){
 let base={faces:[{id:'left',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]},{id:'right',points:[{x:4,y:0,z:0},{x:8,y:0,z:2},{x:8,y:4,z:2},{x:4,y:4,z:0}]}]},message='',commits=[];const references=[{x:0,y:2,z:0},{x:0,y:3,z:2},{x:4,y:2,z:0}];
 const ctx={WallAxisCuts:require('../public/measure/internal/editor_scripts/wall_axis_cuts.js'),BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',referencePoints:()=>references,faceAt:()=>base.faces.find(f=>f.id==='right')||base.faces.at(-1),position:(e,v,z)=>({x:e.clientX/100-.2*z,y:e.clientY/100,z}),screen:p=>({x:(p.x+.2*p.z)*100,y:p.y*100}),commit:b=>commits.push(b),restore:b=>base=b,message:m=>message=m,redraw(){},isCenter:()=>false});
 editor.setFace(base.faces[0]);const e=(x,y,ctrlKey=false)=>({clientX:x*100,clientY:y*100,button:0,ctrlKey});return {editor,e,base:()=>base,message:()=>message,commits};
}
test('base pseudo-selection mounts shared wall points and N splits the selected base despite another hit face',()=>{
 const f=sharedBaseFixture();assert.equal(f.editor.canHit(f.e(0,2),'3d'),true);f.editor.down(f.e(0,2),'3d');f.editor.up();const before=JSON.stringify(f.base());f.editor.keyDown({key:'n'});assert.equal(JSON.stringify(f.base()),before,'N waits for an endpoint');f.editor.move(f.e(4,2),'3d');f.editor.down(f.e(4,2),'3d');f.editor.up();assert.equal(f.base().faces.length,3,f.message());const shared=f.base().sketch.nodes.filter(n=>[0,4].includes(n.x)&&n.y===2);assert.equal(shared.length,2);assert.ok(shared.every(n=>n.z===0));assert.ok(f.base().faces.some(face=>face.points.some(p=>p.x===8&&p.z===2)));
});
test('Shift-selected wall/base points connect with C and upper step points stay off the base',()=>{
 const f=sharedBaseFixture();assert.equal(f.editor.canHit(f.e(.4,3),'3d'),false);f.editor.down(f.e(0,2),'3d');f.editor.up();f.editor.down({...f.e(4,2),shiftKey:true},'3d');f.editor.up();f.editor.keyDown({key:'c'});assert.equal(f.base().faces.length,3,f.message());assert.ok(!f.base().sketch.nodes.some(n=>n.x===0&&n.y===3));
});
test('base line previews cancel and exterior endpoints stay on the selected supporting plane',()=>{
 const f=sharedBaseFixture();f.editor.down(f.e(0,2),'3d');f.editor.up();const before=JSON.stringify(f.base());
 f.editor.keyDown({key:'n'});f.editor.move(f.e(7,2),'3d');f.editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(f.base()),before);
 f.editor.keyDown({key:'n'});f.editor.down(f.e(7,2),'3d');assert.equal(f.editor.busy(),false);
 assert.ok(f.base().sketch.nodes.some(n=>n.x===7&&n.y===2&&n.z===0));
 assert.ok(f.base().faces.find(f=>f.id==='right').points.some(p=>p.z===2));
 S.rebind(f.base(),f.base());assert.equal(f.editor.canPick(f.e(7,2),'3d'),true);
});

test('H cycles perpendicular cuts across pitched base candidates and reuses an existing far endpoint',()=>{const f=sharedBaseFixture();f.editor.down(f.e(0,2),'3d');f.editor.up();const original=JSON.stringify(f.base());f.editor.keyDown({key:'h'});assert.equal(f.base().faces.length,3,f.message());assert.equal(f.base().sketch.nodes.filter(n=>n.x===4&&n.y===2).length,1);f.editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(f.base()),original);f.editor.keyDown({key:'h'});f.editor.down(f.e(2,2),'3d');assert.equal(f.editor.busy(),false);});
test('right and middle navigation passes through a pending base N without placing or canceling it',()=>{const f=sharedBaseFixture();f.editor.down(f.e(0,2),'3d');f.editor.up();f.editor.keyDown({key:'n'});const before=JSON.stringify(f.base());for(const buttons of [2,4]){assert.equal(f.editor.move({...f.e(2,3),buttons},'3d'),false);f.editor.up({...f.e(2,3),button:buttons===2?2:1});assert.equal(f.editor.busy(),true);assert.equal(JSON.stringify(f.base()),before);}f.editor.down(f.e(4,2),'3d');assert.equal(f.base().faces.length,3,f.message());});

test('H on a point between two pitched base faces cycles each side and both without duplicates',()=>{const f=sharedBaseFixture();f.editor.down(f.e(4,2),'3d');f.editor.up();const before=JSON.stringify(f.base());for(const count of [3,3,4,3]){f.editor.keyDown({key:'h'});assert.equal(f.base().faces.length,count,f.message());}f.editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(f.base()),before);});

test('shared picker base line selection supports Shift addition and Control subtraction',()=>{
 const f=sharedBaseFixture(),base=f.base(),pair1=[base.faces[0].points[0],base.faces[0].points[1]],pair2=[base.faces[0].points[1],base.faces[0].points[2]];
 f.editor.selectEntities([], [pair1]);assert.equal(f.editor.chamferSelection().edges.length,1);
 f.editor.selectEntities([], [pair2],true);assert.equal(f.editor.chamferSelection().edges.length,2);
 f.editor.selectEntities([], [pair1],true);assert.equal(f.editor.chamferSelection().edges.length,2);
 f.editor.selectEntities([], [pair1],true,true);assert.equal(f.editor.chamferSelection().edges.length,1);
});

for(const view of ['2d','3d'])test('S draws a center-defined arc in '+view+' with live sweep, radius snap and one undo item',()=>{
 let base={faces:[{id:'b',points:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}]}]},message='',commits=[];const ctx={ExteriorGeometry:require('../public/measure/internal/editor_scripts/exterior_geometry.js'),BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),commit:b=>commits.push(b),restore:b=>base=b,message:m=>message=m,redraw(){},isCenter:()=>false});const e=(x,y)=>({clientX:x*100,clientY:y*100,button:0,buttons:0});editor.doubleClick(e(7,5),view);const before=JSON.stringify(base),count=commits.length;editor.keyDown({key:'s'});assert.equal(editor.interaction(),'Draw curve');editor.down(e(5,5),view);editor.move(e(5,7.01),view);assert.match(message,/Circle/);assert.equal(JSON.stringify(base),before);editor.down(e(5,7.01),view);assert.equal(commits.length,count+1);assert.equal(base.sketch.curves.length,1);assert.ok(Math.abs(base.sketch.curves[0].sweep-Math.PI/2)<1e-8,JSON.stringify(base.sketch.curves[0]));assert.equal(base.sketch.curves[0].radiusY,2);editor.keyDown({key:'s'});editor.down(e(5,5),view);editor.keyDown({key:'Escape'});assert.equal(base.sketch.curves.length,1);
});

test('successive 2D arcs reuse a visible unconnected center and snap to earlier radii',()=>{
 let base={faces:[{id:'b',points:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}]}]},commits=[];const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),ctx={ExteriorGeometry:K,BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),toPixel:p=>({x:p.x*100,y:p.y*100}),commit:b=>commits.push(b),restore:b=>base=b,message(){},redraw(){},isCenter:()=>false}),e=(x,y)=>({clientX:x*100,clientY:y*100,button:0,buttons:0});
 editor.doubleClick(e(7,5),'2d');editor.keyDown({key:'s'});editor.move(e(5,5),'2d');const marks=[];editor.draw2D({},(tag,attrs)=>marks.push({tag,attrs}),1);assert.ok(marks.some(m=>m.tag==='circle'&&m.attrs.r===8&&m.attrs.fill==='none'));
 editor.down(e(5,5),'2d');editor.down(e(5,8),'2d');const first=base.sketch.curves[0],center=base.sketch.nodes.find(n=>n.id===first.centerId);assert.deepEqual([center.x,center.y],[5,5]);assert.ok(center.curveCenter);assert.ok(!base.sketch.edges.some(e=>e.a===center.id||e.b===center.id));
 base=JSON.parse(JSON.stringify(base));editor.keyDown({key:'s'});editor.down(e(5.04,5.03),'2d');editor.down(e(3.02,5.02),'2d');const second=base.sketch.curves[1];assert.equal(second.centerId,first.centerId);const end=K.curvePoint(second,1);assert.ok(Math.hypot(end.x-3,end.y-5)<1e-8);assert.equal(base.sketch.nodes.filter(n=>n.curveCenter).length,1);
 const before=JSON.stringify(base),count=commits.length;editor.keyDown({key:'s'});editor.down(e(4,4),'2d');editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(base),before);assert.equal(commits.length,count);
});

for(const view of ['2d','3d'])test('Shift-click chains base curves with one shared center and leaves placed arcs on Escape in '+view,()=>{
 let base={faces:[{id:'b',points:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:10,z:0},{x:0,y:10,z:0}]}]},commits=[];const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),ctx={ExteriorGeometry:K,BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),toPixel:p=>({x:p.x*100,y:p.y*100}),commit:b=>commits.push(b),restore:b=>base=b,message(){},redraw(){},isCenter:()=>false}),e=(x,y,shiftKey=false)=>({clientX:x*100,clientY:y*100,button:0,buttons:0,shiftKey});
 editor.doubleClick(e(7,5),view);editor.keyDown({key:'s'});editor.down(e(5,5),view);editor.move(e(5.01,7.02),view);const marks=[];editor.draw2D({},(tag,attrs)=>marks.push({tag,attrs}),1);assert.ok(marks.some(m=>m.attrs['data-curve-guide']==='radius-circle'));assert.ok(marks.some(m=>m.attrs['data-curve-guide']==='radius-source'));
 editor.down(e(5,7,true),view);const first=JSON.stringify(base);assert.equal(editor.interaction(),'Draw curve');editor.down(e(3,5,true),view);assert.equal(base.sketch.curves.length,2);assert.equal(base.sketch.curves[0].centerId,base.sketch.curves[1].centerId);assert.equal(JSON.stringify(commits.at(-1)),first);const placed=JSON.stringify(base);editor.move(e(5,3),view);editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(base),placed);assert.equal(editor.busy(),false);
 editor.keyDown({key:'s'});editor.down(e(5,5),view);editor.down(e(5,3),view);assert.equal(base.sketch.curves.length,3);assert.equal(editor.busy(),false);
});


test('base drawings remain rendered when another layer is active and snapping follows the arc',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');let base={faces:[{id:'base',points:[[0,0],[10,0],[10,10],[0,10]].map(([x,y])=>({x,y,z:0}))}]},active=true;
 S.addCurve(base,{type:'ellipse',center:{x:5,y:5,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:3,radiusY:3,sweep:Math.PI});S.rebind(base,base);
 const ctx={ExteriorGeometry:K,BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>active,mode:()=>'point',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),toPixel:p=>({x:p.x*100,y:p.y*100}),commit(){S.rebind(base,base);},restore:b=>base=b,message(){},redraw(){},isCenter:()=>false});
 active=false;const marks=[];editor.draw2D({},(tag,attrs)=>marks.push({tag,attrs}),1);assert.ok(marks.some(m=>m.tag==='path'),'persistent base curve stays visible while editing walls');
 active=true;editor.doubleClick({clientX:500,clientY:792,button:0},'2d');const point=editor.singlePoint();assert.ok(Math.hypot(point.x-5,point.y-8)<.005,'snap to the curved edge, not its invisible chord: '+JSON.stringify(point));
});

test('base line arch captures A, supports multiple points, and replaces the graph boundary',()=>{
 let base={faces:[{id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]},message='',commits=[];
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),ctx={BaseSketchGeometry:S,WallGeometry:G,WallSolidGeometry:W,ExteriorGeometry:K,isFreeMove:true};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/base_sketch_editor.js','utf8'),ctx);
 const editor=ctx.createBaseSketchEditor({base:()=>base,active:()=>true,mode:()=>'line',faceAt:()=>base.faces[0],position:(e,v,z)=>({x:e.clientX/100,y:e.clientY/100,z}),screen:p=>({x:p.x*100,y:p.y*100}),commit:b=>commits.push(b),restore:b=>base=b,message:m=>message=m,redraw(){},isCenter:()=>false}),e=(x,y)=>({clientX:x*100,clientY:y*100,button:0,buttons:0});
 editor.down(e(2,4),'2d');editor.up();const before=JSON.stringify(base);editor.keyDown({key:'a'});editor.move(e(2,5),'2d');editor.down(e(2,5),'2d');editor.keyDown({key:'Escape'});assert.equal(JSON.stringify(base),before);assert.equal(commits.length,0);
 editor.keyDown({key:'a'});editor.down(e(2,5),'2d');editor.keyDown({key:'Enter'});assert.equal(editor.busy(),false,message);assert.equal(commits.length,1);assert.ok(base.faces[0].points.some(p=>p.y===5));assert.equal(base.sketch.curves[0].type,'spline');assert.ok(!S.curveEdges(base.sketch).some(e=>e.start.y===4&&e.end.y===4&&Math.abs(e.start.x-e.end.x)>3.9));
});
