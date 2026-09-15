const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const p=(x,y,z)=>({x,y,z});
const face=(z,dx=0,dy=0)=>({points:[[-20,-20],[20,-20],[20,20],[-20,20]].map(([x,y])=>p(x,y,z+dx*x+dy*y))});
const wall=(id,a,b)=>({id,sourceId:id,kind:'perimeter',targetId:'ground',bottom:[a,b].map(([x,y])=>p(x,y,.1*x+.2*y)),top:[a,b].map(([x,y])=>p(x,y,6+.2*x+.4*y))});
function fixture(options={}){
 const listeners={},state={base:{faces:[face(0,.1,.2)]},roof:{faces:[face(6,.2,.4)]},wallEdits:{}};
 const walls=[wall('moving',[0,0],[4,0]),wall('left',[0,0],[0,-3]),wall('return',[4,0],[4,1]),wall('target',[4,1],[8,1])];
 const ctx={WallGeometry:G,addEventListener:(k,fn)=>listeners[k]=fn,document:{getElementById:()=>({getScreenCTM:()=>({})})},DOMPoint:class {constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}}};ctx.window=ctx;vm.createContext(ctx);if(options.drafts){ctx.BaseGeometry=require('../public/measure/internal/editor_scripts/base_geometry.js');ctx.BaseSketchGeometry=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');ctx.WallSolidGeometry=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_face_draft.js','utf8'),ctx);const create=ctx.createWallFaceDraft;ctx.createWallFaceDraft=host=>{const d=create(host);return {...d,beginFace:()=>false,down:()=>false,key:()=>false};};}vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 let editor,message='';const host={roofVisible:()=>options.roofVisible===true,state:()=>state,enabled:()=>true,visible:()=>true,layer:()=>'walls',walls:()=>editor.apply(walls),toPixel:p=>({x:p.x*100,y:p.y*100,z:p.z}),floorHeight:p=>.1*p.x+.2*p.y,redraw(){options.redraw?.(state);},changed(){options.redraw?.(state);},message:s=>message=s};editor=ctx.createWallEditor(host);
 const event=(x,y)=>({button:0,clientX:x,clientY:y,target:{closest:s=>s==='#viewport'},stopImmediatePropagation(){},preventDefault(){}});
 const key=k=>editor.keyDown({...event(0,0),key:k,ctrlKey:k==='z'});
 return {ctx,state,walls,editor,listeners,event,key,message:()=>message};
}
test('wall plane move slides corners on perpendicular and angled neighbors and follows existing wall-edge slopes',()=>{
 const f=fixture();f.walls[1]=wall('left',[0,0],[-3,-3]);const original=JSON.stringify(f.walls);
 const moved=f.ctx.moveWallPlane(f.walls,'moving',.5,f.state),w=moved.find(w=>w.id==='moving');
 assert.equal(w.bottom[0].x,.5);assert.equal(w.bottom[0].y,.5);assert.equal(w.bottom[1].x,4);
 assert.ok(Math.abs(w.bottom[0].z-.15)<1e-9);assert.ok(Math.abs(w.top[0].z-6.3)<1e-9);
 const left=moved.find(w=>w.id==='left');assert.equal(left.bottom[0].x,left.bottom[0].y);assert.equal(left.bottom[1].x,-3);assert.equal(JSON.stringify(f.walls),original);
});
test('M previews immediately, snaps with dotted merge seams, F disables snap, click commits and undo restores',()=>{
 const f=fixture(),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,95));
 assert.match(f.message(),/Coplanar snap: target/);assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1);assert.equal(f.state.wallEdits.$merges.length,1);
 f.key('f');assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,.95);assert.equal(f.state.wallEdits.$merges,undefined);
 f.key('f');assert.equal(f.editor.apply(f.walls).find(w=>w.id==='target').bottom[0].y,1);f.listeners.pointerup(e(200,95));assert.equal(f.editor.busy(),true);
 f.editor.down(e(200,95));assert.equal(f.editor.busy(),false);assert.equal(G.topology(f.editor.apply(f.walls)).faces.length,2);
 f.key('z');assert.equal(JSON.stringify(f.state.wallEdits),'{}');
 f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,40));f.key('escape');assert.equal(JSON.stringify(f.state.wallEdits),'{}');
});
test('merged stepped face retains its outline and area while shared edge disappears',()=>{
 const a=wall('a',[0,0],[4,0]),b=wall('b',[4,0],[6,0]);a.bottom=a.bottom.map(p=>({...p,z:0}));b.bottom=b.bottom.map(p=>({...p,z:0}));a.top=a.top.map(p=>({...p,z:6}));b.top=b.top.map(p=>({...p,z:3}));a.mergeGroup=b.mergeGroup='a|b';
 const t=G.topology([a,b]);assert.equal(t.faces.length,1);assert.equal(t.faces[0].area,30);
 assert.ok(!t.connections.some(e=>{const a=t.points[e.startIdx],b=t.points[e.endIdx];return a.x===4&&b.x===4&&Math.min(a.z,b.z)<3;}));
 assert.ok(t.connections.some(e=>{const a=t.points[e.startIdx],b=t.points[e.endIdx];return a.x===4&&b.x===4&&Math.min(a.z,b.z)===3;}));
});

test('a merged face moves as one plane on the next gesture and survives serialization',()=>{
 const f=fixture(),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,100));f.editor.down(e(200,100));
 f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));
 const original=f.editor.apply(f.walls),changed=f.ctx.moveWallPlane(original,'moving',.5,f.state);
 for(const id of ['moving','target'])assert.ok(changed.find(w=>w.id===id).bottom.every(p=>Math.abs(p.y-1.5)<1e-9));
});

test('snap is traversable, returning to snap is placeable, and a second saved move keeps all shared corners',()=>{
 const f=fixture(),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');
 f.listeners.pointermove(e(200,95));assert.match(f.message(),/Coplanar snap/);
 f.listeners.pointermove(e(200,140));assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1.4);assert.ok(!f.state.wallEdits.$merges);
 f.editor.down(e(200,140));f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));
 const prior=JSON.stringify(f.editor.apply(f.walls));
 f.editor.pick(e(200,140));f.listeners.pointermove(e(200,140));f.key('m');assert.equal(JSON.stringify(f.editor.apply(f.walls)),prior);
 f.listeners.pointermove(e(200,180));f.editor.down(e(200,180));
 const ws=f.editor.apply(f.walls),moving=ws.find(w=>w.id==='moving'),left=ws.find(w=>w.id==='left'),right=ws.find(w=>w.id==='return');
 assert.ok(Math.abs(moving.bottom[0].y-1.8)<1e-9);assert.equal(left.bottom[0].y,moving.bottom[0].y);assert.equal(right.bottom[0].y,moving.bottom[1].y);assert.equal(right.bottom[1].y,1);
 assert.ok(Math.abs(moving.top[0].z-6.72)<1e-9);
 f.key('z');assert.equal(JSON.stringify(f.editor.apply(f.walls)),prior);
});
test('right/middle camera navigation passes through without changing preview and resumes without jumping',()=>{
 const f=fixture(),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,40));
 const before=JSON.stringify(f.state.wallEdits);
 for(const button of [1,2]){
  const nav={...e(700,700),button,buttons:button===1?4:2,preventDefault(){throw Error('Navigation blocked');},stopImmediatePropagation(){throw Error('Navigation blocked');}};
  f.listeners.pointerdown(nav);f.listeners.pointermove(nav);f.listeners.pointerup({...nav,buttons:0});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.ok(f.editor.busy());
  f.listeners.pointermove(e(700,700));assert.equal(JSON.stringify(f.state.wallEdits),before);
 }
 f.listeners.pointermove(e(700,720));assert.ok(Math.abs(f.editor.apply(f.walls)[0].bottom[0].y-.6)<1e-9);
 f.editor.down(e(700,720));assert.ok(!f.editor.busy());
});

test('saved corner links survive changed vertical overlap and empty PHP arrays preserve edit keys',()=>{
 const f=fixture(),e=f.event;f.state.wallEdits=[];f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,40));f.editor.down(e(200,40));
 f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));assert.ok(f.state.wallEdits.left);assert.ok(f.state.wallEdits.$joints.length);
 const ws=f.editor.apply(f.walls),left=ws.find(w=>w.id==='left');left.bottom[0].z=20;left.top[0].z=25;
 const result=f.ctx.moveWallPlane(ws,'moving',.2,f.state);assert.ok(Math.abs(result.find(w=>w.id==='left').bottom[0].y-.6)<1e-9);
});
test('click commits the visible valid snap even if a later attempted position is invalid',()=>{
 const f=fixture(),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,95));
 const preview=JSON.stringify(f.state.wallEdits),move=f.ctx.moveWallPlane;f.ctx.moveWallPlane=()=>{throw Error('Invalid next position');};f.listeners.pointermove(e(200,400));assert.equal(JSON.stringify(f.state.wallEdits),preview);
 f.editor.down(e(200,400));assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.state.wallEdits),preview);f.ctx.moveWallPlane=move;
});

test('unconnected ends keep their heights regardless of roof surfaces on successive moves',()=>{
 const f=fixture();f.walls.splice(1);f.walls[0].top=f.walls[0].top.map(p=>({...p,z:6}));
 f.state.roof.faces=[{id:'flat',...face(6)},{id:'slope',...face(6,0,.5)}];f.state.sources=[{id:'moving',parentId:'slope'}];
 const original=JSON.stringify(f.state.roof),first=f.ctx.moveWallPlane(f.walls,'moving',.4,f.state);
 assert.ok(first[0].top.every(p=>Math.abs(p.z-6)<1e-9));
 const second=f.ctx.moveWallPlane(first,'moving',.4,JSON.parse(JSON.stringify(f.state)));
 assert.ok(second[0].top.every(p=>Math.abs(p.z-6)<1e-9));assert.equal(JSON.stringify(f.state.roof),original);
 // Face ordering cannot change the result at a shared edge.
 f.state.roof.faces.reverse();assert.equal(JSON.stringify(f.ctx.moveWallPlane(f.walls,'moving',.4,f.state)),JSON.stringify(first));
});
test('merged walls render one area-weighted center including unequal-height stepped sections',()=>{
 const f=fixture(),a=wall('a',[0,0],[4,0]),b=wall('b',[4,0],[6,0]);
 a.bottom=a.bottom.map(p=>({...p,z:0}));b.bottom=b.bottom.map(p=>({...p,z:0}));a.top=a.top.map(p=>({...p,z:6}));b.top=b.top.map(p=>({...p,z:3}));
 f.walls.splice(0,f.walls.length,a,b);f.state.wallEdits={$merges:[['a','b']]};
 const centers=f.ctx.wallFaceCenters(f.editor.apply(f.walls));assert.equal(centers.length,1);
 assert.ok(Math.abs(centers[0].point.x-2.6)<1e-9);assert.ok(Math.abs(centers[0].point.z-2.7)<1e-9);
 const handles=[];f.editor.draw2D({},(tag,attrs)=>{if(attrs['data-wall-id'])handles.push(attrs);},1);
 assert.equal(handles.length,1);assert.ok(Math.abs(handles[0].cx-260)<1e-9);
});

test('flat connected wall edges override roof/base slopes in preview and after saving',()=>{
 const f=fixture(),e=f.event;for(const w of f.walls){for(const p of w.bottom)p.z=2;for(const p of w.top)p.z=8;}
 f.state.roof.faces=[face(20,4,6)];f.state.base.faces=[face(-10,2,3)];
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,40));
 for(const w of f.editor.apply(f.walls)){assert.ok(w.bottom.every(p=>p.z===2));assert.ok(w.top.every(p=>p.z===8));}
 f.editor.down(e(200,40));f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));
 assert.ok(f.editor.apply(f.walls).find(w=>w.id==='moving').bottom.every(p=>p.z===2));
 f.editor.pick(e(200,40));f.listeners.pointermove(e(200,40));f.key('m');f.listeners.pointermove(e(200,60));
 const moved=f.editor.apply(f.walls).find(w=>w.id==='moving');assert.ok(moved.bottom.every(p=>p.z===2));assert.ok(moved.top.every(p=>p.z===8));
});

test('initially joined coplanar faces detach without snapping, including small moves and saved joints',()=>{
 const f=fixture(),e=f.event;f.walls.splice(1,f.walls.length,wall('sibling',[4,0],[8,0]));f.state.wallEdits={$joints:[[{id:'moving',end:1},{id:'sibling',end:0}]]};
 const sibling=JSON.stringify(f.walls[1]);f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,3));
 assert.ok(Math.abs(f.editor.apply(f.walls)[0].bottom[0].y-.03)<1e-9);assert.doesNotMatch(f.message(),/snap:/);assert.equal(JSON.stringify(f.editor.apply(f.walls)[1]),sibling);
 f.listeners.pointermove(e(200,50));f.listeners.pointermove(e(200,2));assert.ok(Math.abs(f.editor.apply(f.walls)[0].bottom[0].y-.02)<1e-9);
 f.editor.down(e(200,2));assert.equal(f.state.wallEdits.$joints.length,0);f.key('z');assert.equal(f.state.wallEdits.$joints.length,1);
});
test('disconnected coplanar faces still snap and connected coplanar chains are excluded together',()=>{
 const f=fixture(),e=f.event;f.walls.splice(1,f.walls.length,wall('sibling',[4,0],[8,0]),wall('next',[8,0],[10,0]),wall('separate',[12,0],[16,0]));
 assert.deepEqual(Array.from(f.ctx.connectedWallPlane(f.walls,'moving')),['moving','sibling','next']);
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,3));assert.match(f.message(),/Coplanar snap: separate/);
});

test('a horizontal subdivision sharing its top/bottom edge is also excluded from snapping',()=>{
 const f=fixture(),e=f.event,upper=wall('upper',[0,0],[4,0]);upper.bottom=JSON.parse(JSON.stringify(f.walls[0].top));upper.top=upper.bottom.map(p=>({...p,z:p.z+2}));f.walls.splice(1,f.walls.length,upper);
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,3));assert.ok(Math.abs(f.editor.apply(f.walls)[0].bottom[0].y-.03)<1e-9);assert.doesNotMatch(f.message(),/Coplanar snap/);
});

 test('visible roof edge snaps wall position and sloping top in preview, persistence, cancel and undo',()=>{
 const f=fixture({roofVisible:true}),e=f.event;f.state.roof={points:[p(-2,2,8),p(7,2,12.5)],connections:[{startIdx:0,endIdx:1}]};
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,195));
 const moved=f.editor.apply(f.walls)[0];assert.equal(moved.bottom[0].y,2);assert.equal(moved.top[0].z,9);assert.equal(moved.top[1].z,11);assert.match(f.message(),/Roof edge snap/);
 assert.equal(f.editor.apply(f.walls).find(w=>w.id==='left').top[0].z,9);
 f.key('f');assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1.95);assert.notEqual(f.editor.apply(f.walls)[0].top[0].z,9);f.key('f');
 f.listeners.pointermove(e(200,240));assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,2.4);f.listeners.pointermove(e(200,195));f.key('escape');assert.equal(JSON.stringify(f.state.wallEdits),'{}');
 f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,195));f.editor.down(e(200,195));f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));assert.equal(f.editor.apply(f.walls)[0].top[1].z,11);f.key('z');assert.equal(JSON.stringify(f.state.wallEdits),'{}');
 });
 test('roof edge bounding ignores visibility and only the advanced setting disables it',()=>{
 for(const visible of [false,true])for(const bound of [false,true]){const f=fixture({roofVisible:visible}),e=f.event;f.state.boundExtrusionToRoof=bound;f.state.roof={points:[p(1,2,9),p(3,2,9)],connections:[{startIdx:0,endIdx:1}]};f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,195));assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,bound?2:1.95);if(bound){assert.match(f.message(),/Roof edge snap/);assert.ok(f.editor.apply(f.walls)[0].top.every(p=>p.z===9));}else assert.doesNotMatch(f.message(),/Roof edge snap/);}
 });

 test('normal coplanar snapping runs the real draft reflow and containment code at a collapsed return',()=>{
 const f=fixture({drafts:true}),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,80));f.listeners.pointermove(e(200,95));assert.match(f.message(),/Coplanar snap/);assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1);f.listeners.pointermove(e(200,140));assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1.4);
 });

 test('perimeter moves preview and save the base footprint in the same undo transaction',()=>{
 const f=fixture({drafts:true}),e=f.event;f.state.base={visible:true,faces:[{id:'base',points:[p(0,0,0),p(4,0,.4),p(4,4,1.2),p(0,4,.8)]}]};const original=JSON.stringify(f.state.base);
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,50));assert.equal(f.state.wallEdits.$base.faces[0].points[0].y,.5);assert.equal(JSON.stringify(f.state.base),original);f.key('escape');assert.equal(f.state.wallEdits.$base,undefined);
 f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,50));f.editor.down(e(200,50));assert.equal(JSON.parse(JSON.stringify(f.state.wallEdits)).$base.faces[0].points[1].y,.5);f.key('z');assert.equal(f.state.wallEdits.$base,undefined);assert.equal(JSON.stringify(f.state.base),original);
 });

 test('tiny coplanar fragments of the same generated roof edge move with the parent without new bridges',()=>{
 const f=fixture({drafts:true}),e=f.event,main=wall('main',[0,0],[4,0]),tiny=wall('tiny',[4,0],[4.02,0]);main.sourceId='R28.0';tiny.sourceId='R28.1';f.walls.splice(0,f.walls.length,main,tiny);
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,50));const moved=f.editor.apply(f.walls);assert.ok(moved.every(w=>w.bottom.every(p=>Math.abs(p.y-.5)<1e-9)));assert.deepEqual(JSON.parse(JSON.stringify(f.state.wallEdits.$merges)),[['main','tiny']]);assert.equal(f.state.wallEdits.$surfaces.length,0);
 f.editor.down(e(200,50));f.state.wallEdits=JSON.parse(JSON.stringify(f.state.wallEdits));f.listeners.pointermove(e(200,50));f.key('m');f.listeners.pointermove(e(200,80));assert.ok(f.editor.apply(f.walls).every(w=>w.bottom.every(p=>Math.abs(p.y-.8)<1e-9)));f.key('escape');assert.ok(f.editor.apply(f.walls).every(w=>w.bottom.every(p=>Math.abs(p.y-.5)<1e-9)));f.key('z');assert.equal(JSON.stringify(f.state.wallEdits),'{}');
 });
 test('generated fragment grouping preserves perpendicular returns, other sources, and normal split faces',()=>{
 const main=wall('main',[0,0],[4,0]);main.sourceId='R28.0';const tiny=wall('tiny',[4,0],[4.02,0]);tiny.sourceId='R28.1';const perpendicular=wall('return',[4,0],[4,.02]);perpendicular.sourceId='R28.2';const other=wall('other',[0,0],[-.02,0]);other.sourceId='R29.0';const large=wall('large',[4.02,0],[5,0]);large.sourceId='R28.3';assert.deepEqual(G.generatedMoveGroup([main,tiny,perpendicular,other,large],'main'),['main','tiny']);
 });

 test('a successfully triangulated snap preview is the exact wall/base state committed on click',()=>{
 const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),f=fixture({drafts:true,redraw:s=>B.terrain(s.wallEdits.$base||s.base)}),e=f.event;f.state.base={faces:[{id:'base',points:[[0,0],[4,0],[4,1],[8,1],[8,4],[0,4]].map(([x,y])=>p(x,y,.1*x+.2*y))}]};
 f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,80));f.listeners.pointermove(e(200,95));assert.match(f.message(),/Coplanar snap/);const preview=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,1);f.editor.down(e(200,95));assert.equal(JSON.stringify(f.state.wallEdits),preview);assert.equal(f.state.wallEdits.$base.faces[0].points[0].y,1);
 });
 test('a rendering failure cannot leave a snapped gesture paired with the previous geometry',()=>{
 const f=fixture({redraw:s=>{if(s.wallEdits.$merges)throw Error('Injected render failure');}}),e=f.event;f.editor.pick(e(200,0));f.listeners.pointermove(e(200,0));f.key('m');f.listeners.pointermove(e(200,80));const valid=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(e(200,95));assert.match(f.message(),/Injected render failure/);assert.equal(JSON.stringify(f.state.wallEdits),valid);f.editor.down(e(200,95));assert.equal(JSON.stringify(f.state.wallEdits),valid);assert.equal(f.editor.apply(f.walls)[0].bottom[0].y,.8);
 });
