const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
function fixture(options={}){const listeners={},state=options.state||{wallEdits:{}},w={id:'w',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:4},{x:4,y:0,z:4}]};let history=[],message='';const frames=new Map();let frameId=0;const ctx={console,performance,getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),camera:{position:{x:0,y:-10,z:2}},requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id),ExteriorGeometry:require('../public/measure/internal/editor_scripts/exterior_geometry.js'),ExteriorModel:require('../public/measure/internal/editor_scripts/exterior_model.js'),WallAxisCuts:require('../public/measure/internal/editor_scripts/wall_axis_cuts.js'),WallTrim:require('../public/measure/internal/editor_scripts/wall_trim.js'),WallSteps:require('../public/measure/internal/editor_scripts/wall_steps.js'),WallFeatures:require('../public/measure/internal/editor_scripts/wall_features.js'),WallSolidGeometry:require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),BaseGeometry:B,BaseSketchGeometry:S,WallGeometry:G,addEventListener:(k,f)=>listeners[k]=e=>{f(e);for(const [id,frame]of [...frames]){frames.delete(id);frame(performance.now());}}};Object.assign(ctx,options.globals||{});ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_face_draft.js','utf8'),ctx);
 if(options.lengthMarker)ctx.wallLengthMarker=options.lengthMarker;if(options.centerMarker)ctx.wallCurveCenterMarker=options.centerMarker;const editor=ctx.createWallFaceDraft({pickVisible:options.pickVisible,pickSoffitVisible:options.pickSoffitVisible,pickLineVisible:options.pickLineVisible,state:()=>options.getState?options.getState():state,selectBaseEntities:options.selectBaseEntities,featureHost:options.featureHost,hit:options.hit,toPixel:p=>p,roof:()=>options.roof,walls:()=>options.getWalls?options.getWalls():options.walls||[w],active:()=>options.active!==false,selected:()=>options.selected===null?null:options.selectedId||'w',select:options.select||(()=>{}),screen:options.screen||(p=>({x:p.x*100,y:p.z*100})),projectPoint:options.projectPoint||((d,e)=>d.frame?ctx.WallSolidGeometry.inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):{x:e.clientX/100,y:e.clientY/100,z:0}),commit:b=>history.push(b),redraw(){},message:s=>message=s});
 const e=(x,y,shiftKey=false)=>({clientX:x*100,clientY:y*100,button:0,buttons:1,shiftKey,target:{closest:s=>s==='#three-view-wrapper'},stopImmediatePropagation(){},preventDefault(){}});return {editor,state,w,e,listeners,history,normalize:()=>ctx.normalizeWallDraftOwnership(state.wallEdits),clipboard:()=>ctx.exteriorGeometryClipboard,message:()=>message,d:()=>state.wallEdits.$drafts.w};}
function planeSelection(f,points){const s=f.editor.selectionSnapshot();s.workingPlane.selection=points;f.editor.restoreSelection(s);}

test('line centers display virtual midpoints and toggle point-placement snapping',()=>{
 for(const enabled of [undefined,false,true]){
  const f=fixture({globals:renderGlobals()});if(enabled!==undefined)f.state.lineCenters=enabled;
  const before=JSON.stringify(f.state),objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);
  const markers=objects.filter(o=>o.userData?.lineCenters);assert.equal(markers.length,enabled===false?0:1);
  if(markers.length){assert.equal(markers[0].geometry.points.length,4);assert.ok(markers[0].geometry.points.some(p=>p.x===2&&p.z===4));}
  assert.equal(JSON.stringify(f.state),before,'midpoints are display references, not inserted geometry');
  f.editor.doubleClick(f.e(1.94,4.03),f.w);const p=f.editor.pointSelection()[0];
  assert.ok(Math.abs(p.x-(enabled===false?1.94:2))<1e-6);assert.equal(p.z,4);
 }
});

test('drawing-plane midpoint snapping respects the line center toggle',()=>{
 for(const enabled of [true,false]){
  const p=(x,z)=>({x,y:0,z}),face={id:'face',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},f=fixture({state:{lineCenters:enabled,wallEdits:{$surfaces:[face]}},walls:[],selected:null});
  f.editor.togglePlane(face);f.editor.doubleClick(f.e(1.94,4.03));
  const point=f.editor.pointSelection()[0];assert.ok(Math.abs(point.x-(enabled?2:1.94))<1e-6);assert.equal(point.z,4);
 }
});

test('repeated M never commits or rebases point moves before placement',()=>{
 for(const z of [2,4]){
  const f=fixture({globals:{isFreeMove:true}});f.editor.doubleClick(f.e(2,z),f.w);f.listeners.pointermove(f.e(2,z));const before=JSON.stringify(f.state.wallEdits),count=f.history.length;
  f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.4,z));assert.notEqual(JSON.stringify(f.state.wallEdits),before,f.message());
  for(let i=0;i<3;i++){const preview=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m',repeat:i===2});assert.equal(JSON.stringify(f.state.wallEdits),preview);assert.equal(f.history.length,count);}
  f.listeners.pointermove(f.e(2.7,z));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,count);
  f.listeners.pointermove(f.e(2,z));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.4,z));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.7,z));f.editor.down(f.e(2.7,z));assert.equal(f.history.length,count+1);assert.equal(JSON.stringify(f.history.at(-1)),before);
 }
});

test('Q keeps the selected draft point when the host wall has a colliding local point ID',()=>{
 const p=(x,z)=>({x,y:0,z}),walls=[{id:'left',bottom:[p(0,0),p(4,0)],top:[p(0,4),p(4,4)]},{id:'right',bottom:[p(6,0),p(10,0)],top:[p(6,4),p(10,4)]}],f=fixture({walls,selectedId:'left',globals:{isFreeMove:true},projectPoint:(d,e)=>({x:e.clientX/100-d.origin.x,y:e.clientY/100,z:0})});
 f.editor.doubleClick(f.e(2,4),walls[0]);f.editor.doubleClick(f.e(8,4),walls[1]);
 const drafts=f.state.wallEdits.$drafts,right=drafts.right,id=right.sketch.nodes.find(p=>p.x===2&&p.y===4).id;
 assert.ok(drafts.left.sketch.nodes.some(p=>p.id===id),'draft-local IDs collide');
 f.editor.restoreSelection({activeDraftKey:'left',draftSelection:{right:[id]},picked:[id]});
 assert.equal(f.editor.pointSelection()[0].x,8);
 f.editor.key({key:'q'});assert.equal(f.editor.interaction(),'Draw rectangle',f.message());
 assert.equal(f.editor.pointSelection().length,1);assert.equal(f.editor.pointSelection()[0].x,8);
 f.editor.down(f.e(9,2));f.editor.down(f.e(9,2));
 assert.ok(right.sketch.nodes.some(n=>n.x===3&&n.y===2),f.message());
 assert.ok(!drafts.left.sketch.nodes.some(n=>n.y===2));
});

test('multiple selected boundary points nudge together repeatedly in one undo operation',()=>{
 const f=fixture();for(const x of [1,2,3])f.editor.doubleClick(f.e(x,4),f.w);
 const ids=f.d().sketch.nodes.filter(n=>[1,2,3].includes(n.x)&&n.y===4).map(n=>n.id);
 f.editor.restoreSelection({activeDraftKey:'w',draftSelection:{w:ids},picked:ids});
 const before=JSON.stringify(f.state.wallEdits),count=f.history.length;
 for(let i=1;i<=2;i++){
  f.editor.key({key:'ArrowLeft'});assert.equal(f.history.length,count+i,f.message());
  const points=f.editor.pointSelection().sort((a,b)=>a.x-b.x);assert.equal(points.length,3);
  points.forEach((p,j)=>{assert.ok(Math.abs(p.x-(j+1-i*.0254))<1e-6,f.message());assert.equal(p.z,4);});
 }
 assert.equal(JSON.stringify(f.history[count]),before);
});

test('two selected points nudge along their own sloped lines across different faces',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(1,4.25),p(7,3.75)],state={wallEdits:{$surfaces:[{id:'a',points:[p(0,0),p(4,0),p(4,5),p(0,4)],retainedPoints:[points[0]]},{id:'b',points:[p(6,0),p(10,0),p(10,3),p(6,4)],retainedPoints:[points[1]]}]}},W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),f=fixture({state,walls:[],selected:null});
 f.editor.restoreSelection({solidPoints:points.map(W.vertexKey)});f.editor.key({key:'ArrowLeft'});
 assert.equal(f.history.length,1,f.message());const moved=f.editor.pointSelection().sort((a,b)=>a.x-b.x);assert.equal(moved.length,2);
 for(let i=0;i<2;i++){assert.ok(moved[i].x<points[i].x);assert.ok(Math.abs(Math.hypot(moved[i].x-points[i].x,moved[i].z-points[i].z)-.0254)<1e-6);}
 assert.ok(moved[0].z<points[0].z);assert.ok(moved[1].z>points[1].z);
});

test('two selected points stay selected across separate draft owners after repeated nudges',()=>{
 const p=(x,z)=>({x,y:0,z}),walls=[{id:'w',bottom:[p(0,0),p(4,0)],top:[p(0,4),p(4,4)]},{id:'right',bottom:[p(6,0),p(10,0)],top:[p(6,4),p(10,4)]}],f=fixture({walls,projectPoint:(d,e)=>({x:e.clientX/100-d.origin.x,y:e.clientY/100,z:0})});
 for(const [i,w]of walls.entries()){f.editor.doubleClick(f.e(1+i*6,2),w);f.editor.key({key:'n'});f.editor.down(f.e(3+i*6,2));f.editor.key({key:'Escape'});}
 const drafts=f.state.wallEdits.$drafts,selection=Object.fromEntries(Object.entries(drafts).map(([key,d])=>[key,[d.sketch.nodes.find(n=>n.x===1&&n.y===2).id]]));
 f.editor.restoreSelection({activeDraftKey:'w',picked:selection.w,draftSelection:selection});const count=f.history.length;
 for(let i=1;i<=2;i++){f.editor.key({key:'ArrowRight'});assert.equal(f.history.length,count+i,f.message());const selected=f.editor.pointSelection().sort((a,b)=>a.x-b.x);assert.equal(selected.length,2);selected.forEach((p,j)=>assert.ok(Math.abs(p.x-(1+j*6+i*.0254))<1e-6));}
});

test('multiple selected curve endpoints nudge without flattening the analytic curves',()=>{
 const f=circleDraftFixture(),d=f.d(),ids=d.sketch.nodes.filter(n=>!n.fixed&&((Math.abs(n.x-3)<1e-6&&Math.abs(n.y-2)<1e-6)||(Math.abs(n.x-2)<1e-6&&Math.abs(n.y-3)<1e-6))).map(n=>n.id);
 assert.equal(ids.length,2);f.editor.restoreSelection({activeDraftKey:'w',draftSelection:{w:ids},picked:ids});const count=f.history.length;
 f.editor.key({key:'ArrowDown'});assert.equal(f.history.length,count+1,f.message());assert.equal(f.editor.pointSelection().length,2);assert.equal(f.d().sketch.curves.length,4);assert.ok(!f.state.wallEdits.$surfaces?.length);
});

test('clicking a generated chimney-support face creates a draft without reopening masonry',()=>{
 const C=require('../public/measure/internal/editor_scripts/wall_chimneys'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18),wall=r.composed.find(w=>w.sourceId==='R134.0'),frame=K.frame({points:[...wall.bottom,wall.top[1],wall.top[0]]}),before=C.compose(r.aligned.walls,r.state).filter(w=>w.chimney);
 const f=fixture({state:r.state,walls:r.composed,selectedId:wall.id,globals:{WallChimneys:C},screen:p=>{const q=K.local(frame,p);return {x:q.x*100,y:q.y*100};},projectPoint:(d,e)=>{const p=K.world(frame,{x:e.clientX/100,y:e.clientY/100,z:0});return {x:(p.x-d.origin.x)*d.u.x+(p.y-d.origin.y)*d.u.y,y:p.z,z:0};}}),center=[...wall.bottom,...wall.top].reduce((a,p)=>({x:a.x+p.x/4,y:a.y+p.y/4,z:a.z+p.z/4}),{x:0,y:0,z:0}),q=K.local(frame,center),event=f.e(q.x,q.y);
 f.editor.down(event,true);f.listeners.pointerup(event);assert.ok(r.state.wallEdits.$drafts,f.message());assert.equal(Object.keys(r.state.wallEdits.$drafts).length,1);assert.equal(f.history.length,0);assert.ok(f.editor.selectionSnapshot().selectedRegion,'the face was actually selected');
 assert.deepEqual(C.compose(r.aligned.walls,r.state).filter(w=>w.chimney),before);
});
test('plane parallel, face creation and subtraction operate in local plane coordinates',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(6,0),p(9,0),p(6,2),p(7,3)],state={wallEdits:{$loose:{points,edges:[points.slice(0,2),points.slice(2)]}}},f=fixture({state,globals:{isFreeMove:true},screen:p=>({x:p.x*100,y:-p.z*100})});f.editor.key({key:'p'});planeSelection(f,points);f.listeners.pointermove(f.e(8,2));f.editor.key({key:'l'});const moved=f.editor.pointSelection();assert.ok(Math.abs(moved[2].z-moved[3].z)<1e-9);assert.ok(Math.abs(Math.hypot(moved[2].x-moved[3].x,moved[2].z-moved[3].z)-Math.SQRT2)<1e-9);assert.equal(f.history.length,1);
 const outer=[p(10,0),p(14,0),p(14,4),p(10,4)];planeSelection(f,outer);f.editor.key({key:'v'});assert.ok(state.wallEdits.$surfaces.some(f=>f.id.startsWith('filled-face')));planeSelection(f,[p(11,1),p(13,1),p(13,3),p(11,3)]);f.editor.key({key:'b'});const cut=state.wallEdits.$surfaces.find(f=>f.id.startsWith('plane-cut'));assert.ok(cut,JSON.stringify(state.wallEdits));assert.equal(cut.holes.length,1);const frame=require('../public/measure/internal/editor_scripts/exterior_geometry.js').frame(cut);assert.equal(require('../public/measure/internal/editor_scripts/exterior_geometry.js').area({points:cut.points.map(p=>require('../public/measure/internal/editor_scripts/exterior_geometry.js').local(frame,p)),holes:cut.holes.map(r=>r.map(p=>require('../public/measure/internal/editor_scripts/exterior_geometry.js').local(frame,p)))}),12);
});
test('near-plane point snapping retains the existing vertex without an almost coincident duplicate',()=>{
 const point={x:6,y:.015,z:1},state={wallEdits:{$loose:{points:[point],edges:[]}}},f=fixture({state});f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,1));assert.equal(state.wallEdits.$loose.points.length,1);assert.ok(Math.abs(f.editor.pointSelection()[0].y-.015)<1e-8);f.editor.key({key:'m'});f.listeners.pointermove(f.e(7,2));f.editor.key({key:'Escape'});assert.equal(state.wallEdits.$loose.points.length,1);
});
test('moving near-plane geometry snaps in plane without drifting along its normal',()=>{
 const point={x:6,y:.015,z:1},target={x:8,y:0,z:2},state={wallEdits:{$loose:{points:[point,target],edges:[]}}},f=fixture({state});f.editor.key({key:'p'});planeSelection(f,[point]);f.listeners.pointermove(f.e(6,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(7.95,1.95));f.editor.down(f.e(7.95,1.95));const result=f.editor.pointSelection()[0];assert.ok(Math.abs(result.x-8)<1e-8&&Math.abs(result.z-2)<1e-8,f.message());assert.ok(Math.abs(result.y-.015)<1e-8);
});
test('plane curves remain analytic through move, copy, paste, delete and reload',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),f=fixture({globals:{isFreeMove:true}});f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,0));f.editor.key({key:'s'});f.editor.down(f.e(7,0));f.listeners.pointermove(f.e(7,1));f.editor.down(f.e(7,1));
 let d=Object.values(f.state.wallEdits.$drafts).find(d=>d.constructionPlane);planeSelection(f,d.sketch.nodes.map(p=>K.world(d.frame,p)));f.listeners.pointermove(f.e(7,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(9,2));f.editor.down(f.e(9,2));d=Object.values(f.state.wallEdits.$drafts).find(d=>d.constructionPlane);assert.equal(d.sketch.curves.length,1);assert.ok(d.sketch.nodes.every(p=>K.world(d.frame,p).x>=8));assert.ok(!f.state.wallEdits.$loose.points.some(p=>p.x===6&&p.z===0),'no ghost loose endpoint after moving');
 f.editor.key({key:'c',ctrlKey:true});assert.equal(f.clipboard().curves.length,1);f.editor.key({key:'v',ctrlKey:true});f.listeners.pointermove(f.e(12,5));f.editor.down(f.e(12,5));let curves=Object.values(f.state.wallEdits.$drafts).filter(d=>d.constructionPlane);assert.equal(curves.length,2,f.message());assert.equal(curves[1].sketch.curves.length,1);f.editor.key({key:'Delete'});assert.equal(f.editor.pointSelection().length,0,f.message());curves=Object.values(f.state.wallEdits.$drafts).filter(d=>d.constructionPlane);assert.equal(curves.flatMap(d=>d.sketch.curves).length,1,f.message());assert.equal(Object.values(JSON.parse(JSON.stringify(f.state)).wallEdits.$drafts).flatMap(d=>d.sketch.curves||[]).length,1);
});
test('plane face selection deletes only that face and Shift-selected lines delete together',()=>{
 const p=(x,z)=>({x,y:0,z}),a={id:'left',points:[p(0,0),p(2,0),p(2,2),p(0,2)]},b={id:'right',points:[p(2,0),p(4,0),p(4,2),p(2,2)]};let mode='face';const state={wallEdits:{$surfaces:[a,b],$loose:{points:[p(6,0),p(8,0),p(6,2),p(8,2)],edges:[[p(6,0),p(8,0)],[p(6,2),p(8,2)]]}}},f=fixture({state,walls:[],selected:null,globals:{document:{getElementById:id=>id==='base-selection'?{value:mode}:null}}});f.editor.togglePlane(a);f.editor.down(f.e(1,1));f.listeners.pointerup(f.e(1,1));assert.equal(f.editor.pointSelection().length,4);f.editor.key({key:'Delete'});assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='left').deleted);assert.ok(!state.wallEdits.$surfaces.find(f=>f.id==='right').deleted);assert.equal(state.wallEdits.$surfaces.find(f=>f.id==='right').points.length,4);
 mode='line';f.editor.down(f.e(7,0));f.listeners.pointerup(f.e(7,0));f.editor.down(f.e(7,2,true));f.listeners.pointerup(f.e(7,2,true));assert.equal(f.editor.pointSelection().length,4);assert.equal(f.editor.selectionSnapshot().workingPlane.selectedLines.length,2);f.editor.key({key:'Delete'});assert.equal(f.editor.pointSelection().length,0);const removed=state.wallEdits.$removedSurfaceEdges;assert.ok(removed.length>=2);
});
test('3D C connects all selected pairs across spatial owners without flattening them',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),points=[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:0,y:2,z:0},{x:0,y:0,z:2}],state={wallEdits:{$loose:{points,edges:[]}}},f=fixture({state,walls:[],selected:null});
 f.editor.restoreSelection({solidPoints:points.map(W.vertexKey)});f.editor.key({key:'c'});assert.equal(state.wallEdits.$loose.edges.length,6);assert.equal(f.history.length,1);assert.deepEqual(JSON.parse(JSON.stringify(state.wallEdits.$loose.points)),points);
 f.editor.key({key:'c'});assert.equal(state.wallEdits.$loose.edges.length,6);const saved=JSON.parse(JSON.stringify(state));assert.equal(fixture({state:saved,walls:[],selected:null}).state.wallEdits.$loose.edges.length,6);
});
test('P fits all selected line endpoints and rejects skew or noncoplanar selections',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y,z)=>({x,y,z}),points=[p(0,0,0),p(2,0,2),p(0,2,2),p(2,2,4)],f=fixture({walls:[],selected:null});
 f.editor.restoreSelection({lineSelection:[{pair:points.slice(0,2)},{pair:points.slice(2)}]});f.editor.key({key:'p'});assert.equal(f.editor.planeView().rotating,false);assert.ok(points.every(p=>Math.abs(K.local(f.editor.planeView().frame,p).z)<1e-8));f.editor.key({key:'p'});
 f.editor.togglePlane({axisPoints:[...points,p(1,1,3)]});assert.equal(f.editor.planeActive(),false);assert.match(f.message(),/one plane/);
 f.editor.togglePlane({axisPoints:[p(0,0,0),p(1,0,1),p(2,0,2)]});assert.equal(f.editor.planeView().rotating,true);
});
test('single point plane takes two independent rotations and leaves the model unchanged',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),f=fixture({walls:[],selected:null}),origin={x:2,y:3,z:4},before=JSON.stringify(f.state);f.editor.togglePlane({axisPoints:[origin]});f.editor.distanceInput().set(30);const first=JSON.parse(JSON.stringify(f.editor.planeView().frame));f.editor.planeDown(f.e(2,4));assert.equal(f.editor.planeView().rotating,true);assert.match(f.message(),/2\/2/);assert.deepEqual(JSON.parse(JSON.stringify(f.editor.planeView().frame.n)),first.n,'stage two starts at the confirmed orientation');assert.match(f.message(),/about X/);f.editor.key({key:'p'});assert.match(f.message(),/about Y/);f.editor.distanceInput().set(25);f.editor.key({key:'Enter'});const frame=f.editor.planeView().frame;assert.equal(f.editor.planeView().rotating,false);assert.equal(f.editor.pointSelection().length,1);assert.ok(Math.abs(K.local(frame,origin).z)<1e-9);assert.notDeepEqual(frame.n,first.n);assert.equal(JSON.stringify(f.state),before);
});
test('confirming rotation refreshes near-plane points on both sides and excludes crossing lines',()=>{
 const p=(x,y,z)=>({x,y,z}),points=[p(-3,.015,1),p(-1,.015,1),p(1,-.015,1),p(3,-.015,1),p(1,.2,3),p(3,-.2,3)],state={wallEdits:{$loose:{points,edges:[[points[0],points[1]],[points[2],points[3]],[points[4],points[5]]]}}},f=fixture({state,walls:[],selected:null,pickVisible:()=>false,screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.togglePlane({axisPoints:[p(0,0,0),p(0,0,4)]});f.editor.distanceInput().set(0);f.editor.planeDown(f.e(0,0));f.editor.key({key:'a',ctrlKey:true});assert.equal(f.editor.pointSelection().length,4);
 f.editor.down(f.e(2,3));f.listeners.pointerup(f.e(2,3));assert.equal(f.editor.pointSelection().length,0,'a line crossing the plane is not selectable');
 f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));assert.equal(f.editor.pointSelection().length,2,'a fully near-plane line is editable through occlusion');
});
test('E toggles along-wall and perpendicular extrusion from the unchanged source with typed distances',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(0,0),p(4,0),p(4,4),p(0,4)],state={wallEdits:{$surfaces:[{id:'wall',material:'brick',points}]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true},screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),before=JSON.stringify(state.wallEdits);
 f.editor.restoreSelection({lineSelection:[{pair:points.slice(2)}]});f.listeners.pointermove(f.e(2,4));f.editor.key({key:'e'});f.editor.distanceInput().set(.5);assert.ok(state.wallEdits.$surfaces[0].points.some(p=>p.z===4.5));
 f.editor.key({key:'e'});assert.match(f.message(),/Perpendicular/);f.editor.key({key:'e',repeat:true});f.listeners.pointermove(f.e(1.5,4));assert.ok(state.wallEdits.$surfaces.some(f=>f.id.startsWith('line-extrude')&&f.points.some(p=>Math.abs(Math.abs(p.y)-.5)<1e-8)));f.editor.distanceInput().set(.75);const extension=state.wallEdits.$surfaces.find(f=>f.id.startsWith('line-extrude'));assert.ok(extension,f.message());assert.ok(extension.points.every(p=>p.z===4));assert.ok(extension.points.some(p=>Math.abs(p.y)===.75));assert.equal(extension.material,'brick');assert.deepEqual(JSON.parse(JSON.stringify(state.wallEdits.$surfaces[0].points)),points);
 f.editor.key({key:'e'});f.editor.distanceInput().set(.25);assert.ok(!state.wallEdits.$surfaces.some(f=>f.id.startsWith('line-extrude')));assert.ok(state.wallEdits.$surfaces[0].points.some(p=>p.z===4.25));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.key({key:'e'});f.editor.key({key:'e'});f.editor.distanceInput().set(-.5);f.editor.down(f.e(2,4));assert.equal(f.history.length,1);assert.ok(state.wallEdits.$surfaces.some(f=>f.id.startsWith('line-extrude')));
});
test('plane single points and lines move, nudge repeatedly, copy, paste beyond the wall and delete',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(6,1),p(8,1)],state={wallEdits:{$loose:{points,edges:[[...points]]}}},f=fixture({state,globals:{isFreeMove:true},screen:p=>({x:p.x*100,y:-p.z*100})});f.editor.key({key:'p'});planeSelection(f,points);f.listeners.pointermove(f.e(7,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(9,2));f.editor.down(f.e(9,2));assert.ok(f.editor.pointSelection().every(p=>p.z===2));assert.equal(f.history.length,1);
 const moved=JSON.parse(JSON.stringify(f.editor.pointSelection()));f.editor.key({key:'ArrowRight'});f.editor.key({key:'ArrowRight',repeat:true});assert.ok(Math.abs(f.editor.pointSelection()[0].x-moved[0].x-2*.0254)<1e-8);assert.ok(f.editor.pointSelection().every(p=>p.y===0));
 f.editor.key({key:'c',ctrlKey:true});assert.equal(f.clipboard().points.length,2);assert.equal(f.clipboard().edges.length,1);f.editor.key({key:'v',ctrlKey:true});f.listeners.pointermove(f.e(20,10));f.editor.planeDown(f.e(20,10));assert.equal(f.editor.busy(),false,f.message());assert.ok(f.editor.pointSelection().every(p=>p.x>18&&p.z===10));const saved=JSON.stringify(state.wallEdits);f.editor.key({key:'m'});f.listeners.pointermove(f.e(30,20));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),saved);
 planeSelection(f,[f.editor.pointSelection()[0]]);f.editor.key({key:'ArrowUp'});assert.equal(f.editor.pointSelection().length,1);assert.ok(Math.abs(f.editor.pointSelection()[0].z-10-.0254)<1e-8);f.editor.key({key:'Delete'});assert.equal(f.editor.pointSelection().length,0);assert.equal(f.editor.planeActive(),true);
});
test('plane nudges use upright view directions regardless of first edge and camera side',()=>{
 for(const order of [[0,1,2,3],[1,2,3,0],[3,2,1,0]])for(const side of [1,-1]){
  const p=(x,z)=>({x,y:0,z}),ring=[p(0,0),p(4,0),p(4,4),p(0,4)],face={id:'face',points:order.map(i=>ring[i])},points=[p(1,1),p(2,1)],state={wallEdits:{$surfaces:[face],$loose:{points,edges:[[...points]]}}};
  const f=fixture({state,walls:[],selected:null,screen:p=>({x:side*p.x*100,y:-p.z*100})});f.editor.togglePlane(face);planeSelection(f,points);
  for(const [key,dx,dz] of [['ArrowUp',0,1],['ArrowRight',side,0],['ArrowLeft',-side,0],['ArrowDown',0,-1]]){
   const before=JSON.parse(JSON.stringify(f.editor.pointSelection()));f.editor.key({key});const after=f.editor.pointSelection();assert.equal(after.length,2);
   for(let i=0;i<2;i++){assert.ok(Math.abs(after[i].x-before[i].x-dx*.0254)<1e-8,key);assert.ok(Math.abs(after[i].z-before[i].z-dz*.0254)<1e-8,key);assert.equal(after[i].y,0);}
  }
 }
});

test('plane rotation, flip, resize and typed movement preserve a tilted plane',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,y)=>({x,y,z:x+y}),face={id:'tilted',points:[p(0,0),p(2,0),p(2,2),p(0,2)]},frame=K.frame(face),state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true},screen:p=>{const q=K.local(frame,p);return {x:q.x*100,y:q.y*100};},projectPoint:(d,e)=>K.local(d.frame,K.world(frame,{x:e.clientX/100,y:e.clientY/100,z:0}))});f.editor.togglePlane(face);planeSelection(f,face.points);f.listeners.pointermove(f.e(1,1));const before=JSON.stringify(state.wallEdits);
 for(const key of ['r','t','y']){f.editor.key({key});if(key==='r')f.editor.distanceInput().set(30);else f.listeners.pointermove(f.e(1.5,1));assert.ok(state.wallEdits.$surfaces[0].points.every(p=>Math.abs(K.local(frame,p).z)<1e-7),key);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before,key);}
 f.editor.key({key:'m'});f.editor.distanceInput().set(1);f.editor.key({key:'Enter'});assert.equal(f.history.length,1);assert.ok(f.editor.pointSelection().every(p=>Math.abs(K.local(frame,p).z)<1e-7));assert.ok(Math.abs(Math.hypot(...['x','y','z'].map(k=>f.editor.pointSelection()[0][k]-face.points[0][k]))-1)<1e-7);
});
test('edge insertion snaps, boundary points are locked, and C subdivides the vertical face',()=>{const f=fixture();f.editor.doubleClick(f.e(2,.02),f.w);assert.equal(f.message(),'Midpoint');assert.ok(f.d().sketch.nodes.find(n=>n.x===2&&n.y===0).fixed);f.editor.doubleClick(f.e(2,3.98),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});assert.equal(f.d().faces.length,2);assert.ok(f.d().faces.every(face=>!face.opening));f.editor.key({key:'m'});assert.match(f.message(),/locked/);});
test('N draws a closed opening, preserves its hole metadata and interior M cancels cleanly',()=>{const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}assert.equal(f.d().faces.filter(f=>f.opening).length,1,f.message());assert.equal(f.d().faces.find(f=>!f.opening).holes.length,1);
 const before=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(f.e(1,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.2,1.2));assert.notEqual(JSON.stringify(f.state.wallEdits),before);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.deepEqual(JSON.parse(JSON.stringify(f.d())).faces.filter(f=>f.opening).length,1);});

test('draft points follow a translated wall plane and fixed boundary follows resized endpoints',()=>{const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);const before=JSON.parse(JSON.stringify(f.w)),next=JSON.parse(JSON.stringify(f.w));for(const edge of ['bottom','top']){next[edge][0].y=1;next[edge][1].y=1;next[edge][1].x=5;}f.editor.reflow([before],[next],f.state.wallEdits);assert.equal(f.d().origin.y,1);assert.ok(f.d().sketch.nodes.some(n=>n.fixed&&n.x===5));assert.ok(f.d().sketch.nodes.some(n=>!n.fixed&&Math.abs(n.x-2)<1e-8&&Math.abs(n.y-2)<1e-8));});

test('Q from two points creates an opening that E extrudes into a capped box and Escape restores',()=>{const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);f.editor.doubleClick(f.e(3,1),f.w);f.editor.down(f.e(1,1,true));f.listeners.pointerup(f.e(1,1,true));f.editor.key({key:'q'});f.listeners.pointermove(f.e(2,3));f.editor.down(f.e(2,3));f.listeners.pointerup(f.e(2,3));const opening=f.d().faces.find(f=>f.opening);assert.ok(opening);f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,1.5));assert.equal(f.state.wallEdits.$surfaces.length,5);assert.ok(f.d().faces.find(f=>f.id===opening.id).solidId);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);});

test('region selection is transient and an old saved selection is ignored after reload',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));
 assert.equal(f.d().selectedFace,undefined);
 f.d().selectedFace=f.d().faces[0].id;
 const reloaded=fixture({state:JSON.parse(JSON.stringify(f.state))});reloaded.listeners.pointermove(reloaded.e(1,2));
 assert.equal(reloaded.editor.key({key:'m'}),false);assert.equal(reloaded.editor.busy(),false);
});
test('draft extrusion reverses with the camera and reanchors after navigation',()=>{
 for(const sign of [-1,1]){let cameraSign=sign;const f=fixture({screen:p=>({x:100*(p.x+cameraSign*p.y),y:p.z*100})});
 f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(1,2));f.editor.key({key:'e'});
 f.listeners.pointermove(f.e(2,2));const cap=f.state.wallEdits.$surfaces[0];assert.equal(cap.points[0].y,sign);
 f.listeners.pointermove({...f.e(3,2),buttons:2});cameraSign=-sign;f.listeners.pointermove(f.e(3,2));
 assert.equal(f.state.wallEdits.$surfaces[0].points[0].y,sign);
 f.listeners.pointermove(f.e(4,2));assert.equal(f.state.wallEdits.$surfaces,undefined);
 f.editor.key({key:'escape'});assert.equal(f.state.wallEdits.$surfaces,undefined);
 }
});
function renderGlobals(){
 class BufferGeometry{setFromPoints(points){this.points=points;return this;}setIndex(){return this;}setAttribute(name,value){(this.attributes||={})[name]=value;return this;}}
 class Material{constructor(args){Object.assign(this,args);}}
 class Mesh{constructor(g,m){this.geometry=g;this.material=m;this.userData={};}updateMatrixWorld(){}computeLineDistances(){}}
 class Vector2{constructor(x,y){this.x=x;this.y=y;}}
 class Raycaster{setFromCamera(){}intersectObjects(ms){return ms.length?[{object:ms[0]}]:[];}}
 return {getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),THREE:{Float32BufferAttribute:class{constructor(array,itemSize){Object.assign(this,{array,itemSize});}},BufferGeometry,Mesh,Line:Mesh,Points:Mesh,MeshBasicMaterial:Material,LineBasicMaterial:Material,LineDashedMaterial:Material,PointsMaterial:Material,Vector2,Raycaster,ShapeUtils:{triangulateShape:()=>[[0,1,2]]}},renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:400})}},camera:{position:{x:0,y:-10,z:2}}};
}
test('wall draft rendering supports first entry with no model, followed by generated walls',()=>{
 let current=null;const f=fixture({globals:renderGlobals(),getState:()=>current,getWalls:()=>current?[f.w]:[]});
 const objects=[],group={add:o=>objects.push(o)};
 assert.doesNotThrow(()=>f.editor.draw3D(group,p=>p));assert.equal(objects.length,0);
 current=f.state;f.editor.doubleClick(f.e(2,2),f.w);f.editor.draw3D(group,p=>p);
 assert.ok(objects.some(o=>o.geometry),'newly generated geometry must render after empty entry');
});
test('edited wall stays visible and selectable when a base rebuild removes its roof source',()=>{
 let raw;const f=fixture({globals:renderGlobals(),getWalls:()=>raw||[f.w]});
 f.editor.doubleClick(f.e(2,2),f.w);f.editor.clear();raw=[];
 const objects=[],draw=()=>{objects.length=0;f.editor.draw3D({add:o=>objects.push(o)},p=>p);return objects.filter(o=>Object.hasOwn(o.material,'side'));};
 assert.equal(draw().length,1);assert.equal(draw()[0].userData.draftKey,'w');assert.ok(f.editor.canBox());
 f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));assert.ok(f.editor.featureSelection()?.f,'Recovered wall must still be selectable');
 f.d().faces[0].solidId='already-extruded';assert.equal(draw().length,0,'Consumed face must not return');
 delete f.d().faces[0].solidId;f.d().deletedFaces=f.d().faces.map(face=>face.points.map(p=>p.nodeId).sort().join('|'));assert.equal(draw().length,0,'Explicit deletion must remain effective');
});
test('selected orange opening retains its base hue and gets a white outline',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}
 const objects=[],group={add:o=>objects.push(o)};f.editor.draw3D(group,p=>p);assert.ok(objects.some(o=>o.material.color==='#ff962f'));
 f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));objects.length=0;f.editor.draw3D(group,p=>p);assert.ok(objects.some(o=>o.material.color==='#ff962f'&&o.userData.exteriorSelected));assert.ok(objects.some(o=>o.material.color==='#fff'));
});
test('horizontal recess floor disappears only below base, cuts an opening, and cancel/commit preserve undo',()=>{
 const floor={id:'floor',points:[{x:1,y:1,z:2},{x:3,y:1,z:2},{x:3,y:3,z:2},{x:1,y:3,z:2}]};
 const state={wallEdits:{$surfaces:[floor]},base:{faces:[{id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]}};
 const f=fixture({state,globals:renderGlobals(),screen:p=>({x:p.x*100,y:-p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(state.wallEdits);
 f.editor.key({key:'m'});f.listeners.pointermove(f.e(2,3.95));assert.ok(state.wallEdits.$surfaces.some(f=>f.id==='floor'));f.listeners.pointermove(f.e(2,4));assert.ok(state.wallEdits.$surfaces.some(f=>f.id==='floor'));f.listeners.pointermove(f.e(2,4.1));assert.equal(state.wallEdits.$surfaces.find(f=>f.id==='floor').points[0].z,0);f.listeners.pointermove(f.e(2,4.2));assert.equal(state.wallEdits.$surfaces.some(f=>f.id==='floor'),false);assert.ok(state.wallEdits.$baseCuts.length>0);assert.ok(state.wallEdits.$baseCuts[0].points.every(p=>p.z===0));assert.match(f.message(),/Entire face below base/);
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2,4.2));f.editor.down(f.e(2,4.2));f.listeners.pointerup(f.e(2,4));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.ok(state.wallEdits.$baseCuts.length>0);
});

test('point-only box selection works in both views, with Shift addition and no face extrusion',()=>{
 for(const view of ['3d','2d']){const f=fixture(),event=(x,y,shift=false)=>({...f.e(x,y,shift),target:{closest:s=>s===(view==='3d'?'#three-view-wrapper':'#viewport')}});
 f.editor.doubleClick(f.e(1,1),f.w);f.editor.doubleClick(f.e(3,1),f.w);f.editor.doubleClick(f.e(2,3),f.w);
 f.editor.down(event(.7,.7));f.listeners.pointermove(event(3.3,1.3));f.listeners.pointerup(event(3.3,1.3));
 f.editor.key({key:'u'});const interior=()=>f.d().sketch.edges.filter(e=>!e.fixed);assert.equal(interior().length,1);
 f.editor.down(event(1.7,2.7,true));f.listeners.pointermove(event(2.3,3.3,true));f.listeners.pointerup(event(2.3,3.3,true));
 f.editor.key({key:'u'});assert.equal(interior().length,2);
 }
});
test('Y scales and R rotates selected editable points in the face plane, click commits and Escape restores',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,2),f.w);f.editor.doubleClick(f.e(3,2),f.w);f.editor.down(f.e(1,2,true));f.listeners.pointerup(f.e(1,2,true));
 f.listeners.pointermove(f.e(3,2));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'y'});f.listeners.pointermove(f.e(3.5,2));
 assert.ok(f.d().sketch.nodes.some(n=>!n.fixed&&Math.abs(n.x-.5)<1e-8));f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(3,2));f.editor.key({key:'r'});f.listeners.pointermove(f.e(2.01,3));
 assert.ok(f.d().sketch.nodes.filter(n=>!n.fixed).every(n=>Math.abs(n.x-2)<1e-8));assert.match(f.message(),/90.0/);
 f.editor.down(f.e(2,3));f.listeners.pointerup(f.e(2,3));assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.history.at(-1)),before);
});
test('F disables point, midpoint and inference snapping while drawing',()=>{
 const f=fixture({globals:{isFreeMove:true}});f.editor.doubleClick(f.e(2,.06),f.w);const n=f.d().sketch.nodes.find(n=>!n.fixed);assert.ok(n);assert.equal(n.y,.06);
});

test('face selection waits for release and a marquee never selects its starting face, even when dragged back',()=>{
 const f=fixture({globals:renderGlobals()}),objects=[],group={add:o=>objects.push(o)},chosen=()=>{objects.length=0;f.editor.draw3D(group,p=>p);return objects.some(o=>o.userData.exteriorSelected);};
 f.editor.doubleClick(f.e(2,2),f.w);f.editor.down(f.e(1,2));assert.equal(chosen(),false);
 f.listeners.pointerup(f.e(1,2));assert.equal(chosen(),true);f.editor.clear();
 f.editor.beginFace(f.e(1,2),f.w);assert.equal(chosen(),false);f.listeners.pointermove(f.e(3,3));assert.equal(chosen(),false);f.listeners.pointermove(f.e(1,2));f.listeners.pointerup(f.e(1,2));assert.equal(chosen(),false);
 f.editor.beginFace(f.e(1,2),f.w);f.listeners.pointercancel(f.e(1,2));f.listeners.pointerup(f.e(1,2));assert.equal(chosen(),false);
});
test('Q double-click at the opposite corner makes an axis-aligned rectangle and consumes the trailing dblclick',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'q'});
 f.editor.down(f.e(3,3));f.listeners.pointerup(f.e(3,3));assert.equal(f.editor.busy(),true);
 f.editor.down(f.e(3,3));f.listeners.pointerup(f.e(3,3));f.editor.doubleClick(f.e(3,3),f.w);
 assert.equal(f.editor.busy(),false);assert.equal(f.d().sketch.nodes.filter(n=>!n.fixed).length,4);assert.equal(f.d().faces.filter(f=>f.opening).length,1);
 for(const edge of f.d().sketch.edges.filter(e=>!e.fixed)){const a=f.d().sketch.nodes.find(n=>n.id===edge.a),b=f.d().sketch.nodes.find(n=>n.id===edge.b);assert.ok(Math.abs(a.x-b.x)<1e-8||Math.abs(a.y-b.y)<1e-8);}
});
test('Q single-click keeps its third-point rotation step',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'q'});f.editor.down(f.e(3,3));f.listeners.pointerup(f.e(3,3));assert.equal(f.d().sketch.edges.filter(e=>!e.fixed).length,0);
 f.listeners.pointermove(f.e(3.4,2));f.editor.down(f.e(3.4,2));f.listeners.pointerup(f.e(3.4,2));assert.equal(f.editor.busy(),false);assert.equal(f.d().faces.filter(f=>f.opening).length,1);
 assert.ok(f.d().sketch.edges.filter(e=>!e.fixed).some(e=>{const a=f.d().sketch.nodes.find(n=>n.id===e.a),b=f.d().sketch.nodes.find(n=>n.id===e.b);return Math.abs(a.x-b.x)>.01&&Math.abs(a.y-b.y)>.01;}));
});

test('Delete removes a selected saved recess face while keeping clickable points, and Shift+F restores it',()=>{
 const cap={id:'saved-indent',points:[{x:1,y:0,z:1},{x:3,y:0,z:1},{x:3,y:0,z:3},{x:1,y:0,z:3}]},state={wallEdits:{$surfaces:[cap]}},f=fixture({state,globals:renderGlobals()}),group={add(){}};
 f.editor.draw3D(group,p=>p);f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.editor.key({key:'Delete'});assert.equal(state.wallEdits.$surfaces[0].deleted,true);assert.equal(state.wallEdits.$surfaces[0].points.length,4);assert.equal(f.history.length,1);
 f.editor.draw3D(group,p=>p);for(const [i,p]of cap.points.entries()){f.editor.down(f.e(p.x,p.z,i>0));f.listeners.pointerup(f.e(p.x,p.z,i>0));}f.editor.key({key:'f',shiftKey:true});assert.equal(state.wallEdits.$surfaces[0].deleted,false);assert.equal(f.history.length,2);
 f.editor.down(f.e(1,1));f.listeners.pointerup(f.e(1,1));f.editor.key({key:'Delete'});assert.equal(state.wallEdits.$surfaces[0].deleted,true);assert.equal(state.wallEdits.$removedSurfacePoints.length,1);
});
test('draft face deletion retains its graph and persists, Shift+F restores it from its boundary points',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));const points=JSON.stringify(f.d().sketch),ids=f.d().faces[0].points.map(p=>p.nodeId);f.editor.key({key:'Delete'});assert.equal(f.d().deletedFaces.length,1);assert.equal(JSON.stringify(f.d().sketch),points);
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});for(const [i,id]of ids.entries()){const p=loaded.d().sketch.nodes.find(n=>n.id===id);loaded.editor.down(loaded.e(p.x,p.y,i>0));loaded.listeners.pointerup(loaded.e(p.x,p.y,i>0));}loaded.editor.key({key:'f',shiftKey:true});assert.equal(loaded.d().deletedFaces.length,0);
});

test('blank-space box selects recess points without any highlighted face, and Delete uses that selection',()=>{
 const state={wallEdits:{$surfaces:[{id:'left',points:[{x:1,y:0,z:1},{x:2,y:0,z:1},{x:2,y:0,z:2},{x:1,y:0,z:2}]},{id:'right',points:[{x:5,y:0,z:1},{x:6,y:0,z:1},{x:6,y:0,z:2},{x:5,y:0,z:2}]}]}},f=fixture({state,selected:null});
 f.editor.down(f.e(.8,.8));f.listeners.pointermove(f.e(6.2,2.2));f.listeners.pointerup(f.e(6.2,2.2));assert.equal(f.message(),'8 points selected');f.editor.key({key:'Delete'});assert.ok(state.wallEdits.$surfaces.every(f=>f.deleted));assert.equal(state.wallEdits.$removedSurfacePoints.length,8);
});
test('box selection includes multiple wall drafts and works before the walls layer becomes active',()=>{
 const wall=(id,x)=>({id,bottom:[{x,y:0,z:1},{x:x+1,y:0,z:1}],top:[{x,y:0,z:2},{x:x+1,y:0,z:2}]}),walls=[wall('a',1),wall('b',4)],f=fixture({walls,active:false,selected:null});
 f.editor.beginFace(f.e(1.5,1.5),walls[0]);f.listeners.pointermove(f.e(5.3,2.3));f.listeners.pointerup(f.e(5.3,2.3));assert.equal(f.message(),'3 points selected');
 f.editor.down(f.e(.7,.7));f.listeners.pointermove(f.e(5.3,2.3));f.listeners.pointerup(f.e(5.3,2.3));assert.equal(f.message(),'8 points selected');
});

test('a drafted door at the wall base has three returns and moving a saved return updates the opening without new faces',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(1,0),f.w);for(const [x,y]of [[3,0],[3,2],[1,2],[1,0]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}
 f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));
 assert.equal(f.state.wallEdits.$surfaces.length,4);assert.equal(f.state.wallEdits.$surfaces.filter(f=>f.points.every(p=>p.z===0)).length,0);
 const side=f.state.wallEdits.$surfaces.find(s=>s.points.every(p=>Math.abs(p.x-1)<1e-8));assert.ok(side);f.state.wallEdits.$surfaces=[side,...f.state.wallEdits.$surfaces.filter(s=>s!==side)];
 f.editor.clear();f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(.75,1));f.listeners.pointerup(f.e(.75,1));f.listeners.pointermove(f.e(.75,1));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m'});f.listeners.pointermove(f.e(.95,1));
 assert.equal(f.state.wallEdits.$surfaces.length,4);const moved=f.state.wallEdits.$surfaces.find(s=>s.id===side.id);assert.ok(moved.points.every(p=>Math.abs(p.x-1.2)<1e-8));assert.ok(f.d().sketch.nodes.some(n=>Math.abs(n.x-1.2)<1e-8&&Math.abs(n.y-2)<1e-8));
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(.75,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(.95,1));f.editor.down(f.e(.95,1));f.listeners.pointerup(f.e(.95,1));assert.equal(f.state.wallEdits.$surfaces.length,4);assert.equal(JSON.stringify(f.history.at(-1)),before);
});

test('moving a contained face onto a larger generated face produces an orange deduped draft, with cancel and undo',()=>{
 const small={id:'small',points:[{x:1,y:-1,z:1},{x:2,y:-1,z:1},{x:2,y:-1,z:2},{x:1,y:-1,z:2}]},large={id:'large',points:[{x:0,y:0,z:0},{x:6,y:0,z:0},{x:6,y:0,z:6},{x:0,y:0,z:6}]},state={wallEdits:{$surfaces:[small,large]}},f=fixture({state,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(.5,1.5));f.listeners.pointerup(f.e(.5,1.5));f.listeners.pointermove(f.e(.5,1.5));const before=JSON.stringify(state.wallEdits);
 f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.45,1.5));assert.equal(state.wallEdits.$surfaces.some(s=>s.id==='small'),false);assert.equal(state.wallEdits.$surfaces.find(s=>s.id==='large').drafted,true);const d=state.wallEdits.$drafts['solid:large'];assert.equal(d.faces.filter(f=>f.opening).length,1);assert.equal(d.sketch.nodes.length,8);assert.equal(d.sketch.edges.length,8);assert.match(f.message(),/Contained coplanar/);
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.listeners.pointermove(f.e(.5,1.5));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.45,1.5));f.editor.down(f.e(1.45,1.5));f.listeners.pointerup(f.e(1.45,1.5));assert.equal(JSON.stringify(f.history.at(-1)),before);
 const loaded=fixture({state:JSON.parse(JSON.stringify(state)),globals:renderGlobals()}),objects=[];loaded.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.color==='#ff962f'));
});

 test('a generated wall contained by another transfers internal geometry and hides its former boundary',()=>{
 const wall=(id,x,y,z,size)=>({id,bottom:[{x,y,z},{x:x+size,y,z}],top:[{x,y,z:z+size},{x:x+size,y,z:z+size}]}),small=wall('w',1,-1,1,1),large=wall('large',0,0,0,6),f=fixture({walls:[small,large]});
 f.editor.doubleClick(f.e(.5,1.5),small);const moved=JSON.parse(JSON.stringify(small));for(const edge of ['bottom','top'])for(const p of moved[edge])p.y=0;
 f.editor.reflow([small,large],[moved],f.state.wallEdits);assert.equal(f.editor.mergeWallContained([moved,large],'w'),true);
 const drafts=f.state.wallEdits.$drafts;assert.equal(drafts.w.mergedInto,'large');assert.equal(drafts.w.deletedFaces.length,drafts.w.faces.length);assert.equal(drafts.large.faces.filter(f=>f.opening).length,1);assert.ok(drafts.large.sketch.nodes.length>=9);
 });

 test('an extruded vertical wall snaps its top to a visible roof edge while its bottom stays fixed',()=>{
 const face={id:'wall',points:[{x:1,y:-1,z:1},{x:2,y:-1,z:1},{x:2,y:-1,z:2},{x:1,y:-1,z:2}]},state={wallEdits:{$surfaces:[face]}},roof={points:[{x:0,y:0,z:3},{x:4,y:0,z:4}],connections:[{startIdx:0,endIdx:1}]},f=fixture({state,roof,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(.5,1.5));f.listeners.pointerup(f.e(.5,1.5));f.listeners.pointermove(f.e(.5,1.5));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.45,1.5));
 const cap=state.wallEdits.$surfaces[0];assert.ok(cap.points.every(p=>p.y===0));assert.equal(cap.points[0].z,1);assert.equal(cap.points[1].z,1);assert.equal(cap.points[2].z,3.5);assert.equal(cap.points[3].z,3.25);assert.match(f.message(),/Roof edge snap/);
 f.editor.down(f.e(1.45,1.5));f.listeners.pointerup(f.e(1.45,1.5));assert.equal(JSON.parse(JSON.stringify(state)).wallEdits.$surfaces[0].points[2].z,3.5);
 });

 test('deleting a divider corner deletes its dependent faces instead of silently healing them',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,0),f.w);f.editor.doubleClick(f.e(1,4),f.w);f.editor.down(f.e(1,0,true));f.listeners.pointerup(f.e(1,0,true));f.editor.key({key:'u'});assert.equal(f.d().faces.length,2);
 f.editor.key({key:'Delete'});assert.equal(liveDraftFaces(f.d()).length,0);assert.ok(f.d().removedPoints.length>=2);
 f.editor.down(f.e(0,0));f.listeners.pointerup(f.e(0,0));f.editor.key({key:'Delete'});assert.equal(liveDraftFaces(f.d()).length,0);
 });
 test('a door cap snaps into its opening and deleting its corners removes the dependent geometry',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(1,0),f.w);for(const [x,y]of [[3,0],[3,2],[1,2],[1,0]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}
 f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));assert.equal(f.state.wallEdits.$surfaces.length,4);
 f.editor.clear();f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));f.listeners.pointermove(f.e(1.5,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.97,1));assert.match(f.message(),/Contained coplanar/);assert.equal(f.state.wallEdits.$surfaces.length,0);assert.ok(f.d().faces.every(f=>!f.solidId));f.editor.down(f.e(1.97,1));f.listeners.pointerup(f.e(1.97,1));
 f.editor.down(f.e(.8,-.2));f.listeners.pointermove(f.e(3.2,2.2));f.listeners.pointerup(f.e(3.2,2.2));f.editor.key({key:'Delete'});assert.equal(liveDraftFaces(f.d()).length,0);assert.ok(f.d().removedPoints.length>=2);
 });

 test('deleting an extrusion and its required wire corners does not resurrect its parent face',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(1,0),f.w);for(const [x,y]of [[3,0],[3,2],[1,2],[1,0]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));
 f.editor.clear();f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));f.editor.key({key:'Delete'});assert.ok(f.state.wallEdits.$surfaces[0].deleted);
 f.editor.down(f.e(.3,-.2));f.listeners.pointermove(f.e(3.2,2.2));f.listeners.pointerup(f.e(3.2,2.2));f.editor.key({key:'Delete'});assert.equal(liveDraftFaces(f.d()).length,0);assert.ok(f.d().removedPoints.length>=2);assert.ok(f.d().removedPoints.length>0);
 const reloaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.equal(liveDraftFaces(reloaded.d()).length,0);
 });

 test('deleting a locked wall corner deletes its attached face and removes its selectable wire across reload',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);f.editor.down(f.e(0,0));f.listeners.pointerup(f.e(0,0));f.editor.key({key:'Delete'});
 const d=f.d(),corner=d.sketch.nodes.find(p=>p.x===0&&p.y===0);assert.ok(d.removedPoints.includes(corner.id));assert.ok(d.deletedFaces.includes(d.faces[0].points.map(p=>p.nodeId).sort().join('|')));
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()}),objects=[];loaded.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(!objects.some(o=>o.material.color==='#ffd84d'&&o.material.opacity===.3));
 assert.equal(f.history.at(-1).$drafts.w.removedPoints,undefined);
 });
 test('a door on a merged generated surface has no bottom return from its hidden original surface',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),large={id:'large',drafted:true,points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]},frame=W.faceFrame(large),d={frame,solidHost:'large',members:[],faces:[{id:'outer',points:large.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);W.importDraft(d,[[{x:1,y:0,z:0},{x:3,y:0,z:0},{x:3,y:2,z:0},{x:1,y:2,z:0}]]);
 const state={wallEdits:{$surfaces:[large],$drafts:{'solid:large':d}}},f=fixture({state,walls:[],globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));
 const created=state.wallEdits.$surfaces.filter(f=>!f.drafted);assert.equal(created.length,4,f.message());assert.equal(created.filter(f=>f.points.every(p=>Math.abs(p.z)<1e-8)).length,0);
 });

 test('moving a door return onto the parent corner keeps the original opening consumed',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(1,0),f.w);for(const [x,y]of [[3,0],[3,2],[1,2],[1,0]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));
 const side=f.state.wallEdits.$surfaces.find(s=>s.points.every(p=>Math.abs(p.x-1)<1e-8));f.state.wallEdits.$surfaces=[side,...f.state.wallEdits.$surfaces.filter(s=>s!==side)];f.editor.clear();f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(.75,1));f.listeners.pointerup(f.e(.75,1));f.listeners.pointermove(f.e(.75,1));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m'});f.listeners.pointermove(f.e(-.25,1));
 const region=f.d().faces.find(face=>G.contains(face,{x:1,y:1}));assert.ok(region);assert.ok(region.solidId,'The source opening must not become a new filled wall at the corner');assert.equal(f.state.wallEdits.$surfaces.length,4);
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(.75,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(-.25,1));f.editor.down(f.e(-.25,1));f.listeners.pointerup(f.e(-.25,1));assert.equal(JSON.stringify(f.history.at(-1)),before);
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.ok(loaded.d().faces.find(face=>G.contains(face,{x:1,y:1})).solidId);
 });

 test('a surviving recess face snaps to an adjacent wall after the original opposite face is deleted',()=>{
 const face=(id,y,z0,z1)=>({id,points:[{x:1,y,z:z0},{x:3,y,z:z0},{x:3,y,z:z1},{x:1,y,z:z1}]}),cap=face('cap',-1,0,2),deletedFace={...face('deleted',0,0,2),deleted:true},target=face('upper',0,2,4),state={wallEdits:{$surfaces:[cap,deletedFace,target]}},f=fixture({state,walls:[],globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));f.listeners.pointermove(f.e(1.5,1));const before=JSON.stringify(state.wallEdits);f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.45,1));assert.match(f.message(),/Coplanar snap/);const preview=[];f.editor.draw3D({add:o=>preview.push(o)},p=>p);assert.ok(preview.some(o=>o.material.dashSize===.12),'Shared seams must be dashed during the snap preview');assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='cap').points.every(p=>p.y===0));assert.equal(state.wallEdits.$surfaces.length,3);assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='deleted').deleted);
 f.listeners.pointermove(f.e(2.9,1));assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='cap').points.every(p=>Math.abs(p.y-.4)<1e-8));f.editor.key({key:'escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.listeners.pointermove(f.e(1.5,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.45,1));f.editor.down(f.e(2.45,1));f.listeners.pointerup(f.e(2.45,1));assert.equal(JSON.stringify(f.history.at(-1)),before);assert.ok(JSON.parse(JSON.stringify(state)).wallEdits.$surfaces.find(f=>f.id==='cap').points.every(p=>p.y===0));
 });

 test('returning a recess to a deleted source corner recreates the wall face instead of inheriting deletion',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(0,0),f.w);for(const [x,y]of [[3,0],[3,2],[0,2],[0,0]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,1));f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));
 f.editor.clear();const corner=f.d().sketch.nodes.find(n=>n.x===0&&n.y===0);f.d().removedPoints=[corner.id];f.d().deletedFaces=f.d().faces.filter(face=>face.points.some(p=>p.nodeId===corner.id)).map(face=>face.points.map(p=>p.nodeId).sort().join('|'));
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));f.listeners.pointermove(f.e(1.5,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.97,1));assert.match(f.message(),/coplanar/i);
 const restored=f.d().faces.find(face=>G.contains(face,{x:1,y:1}));assert.ok(restored);assert.ok(!restored.points.some(p=>f.d().removedPoints.includes(p.nodeId)),'New wall must not reuse deleted-point masks');assert.ok(!f.d().deletedFaces.includes(restored.points.map(p=>p.nodeId).sort().join('|')));f.editor.down(f.e(1.97,1));f.listeners.pointerup(f.e(1.97,1));const loaded=fixture({state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()}),objects=[];loaded.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.color==='#ffd84d'&&o.material.opacity===.3));
 });

 test('3D point colors use geometry rather than creation flags',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(2,0),f.w);f.editor.clear();const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const points=objects.filter(o=>o.material.size===8);assert.equal(points.filter(o=>o.material.color==='#e7ad52').length,4);assert.equal(points.filter(o=>o.material.color==='#6ce4ed').length,1);
 const state={wallEdits:{$surfaces:[{id:'new',points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:0,z:2},{x:0,y:0,z:2}]}]}},solid=fixture({state,globals:renderGlobals(),walls:[]}),render=[];solid.editor.draw3D({add:o=>render.push(o)},p=>p);assert.equal(render.filter(o=>o.material.size===8&&o.material.color==='#e7ad52').length,4);
 });

 test('M moves the sole remaining face of a merged draft without extruding new returns',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),surface={id:'merged',drafted:true,points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]},frame=W.faceFrame(surface),d={frame,solidHost:surface.id,members:[],faces:[{id:'remaining',points:surface.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);const state={wallEdits:{$surfaces:[surface],$drafts:{'solid:merged':d}}},f=fixture({state,walls:[],globals:renderGlobals(),screen:p=>({x:(p.x+p.y*.5)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(state.wallEdits);assert.equal(f.editor.key({key:'m'}),true);assert.equal(f.editor.busy(),true);f.listeners.pointermove(f.e(1.5,2));let moved=state.wallEdits.$surfaces.filter(s=>!s.drafted);assert.equal(moved.length,1);assert.ok(moved[0].points.every(p=>p.y===-1));f.editor.key({key:'escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.5,2));f.editor.down(f.e(1.5,2));f.listeners.pointerup(f.e(1.5,2));assert.equal(JSON.stringify(f.history.at(-1)),before);assert.equal(JSON.parse(JSON.stringify(state)).wallEdits.$surfaces.filter(s=>!s.drafted).length,1);
 });

 test('reflow follows actual boundary geometry even when merged corners have editable flags',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);for(const n of f.d().sketch.nodes)n.fixed=false;
 const next=JSON.parse(JSON.stringify(f.w));for(const edge of ['bottom','top']){next[edge][0].x=5;next[edge][1].x=7;}
 f.editor.reflow([f.w],[next],f.state.wallEdits);const corners=f.d().faces.flatMap(f=>f.points);assert.ok(corners.some(p=>p.x===5));assert.ok(corners.some(p=>p.x===7));assert.ok(corners.every(p=>p.x>=5&&p.x<=7));
 });
 test('a collapsed neighboring wall draft does not block a move with a closed-face error',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);const next=JSON.parse(JSON.stringify(f.w));next.bottom[1]={...next.bottom[0]};next.top[1]={...next.top[0]};assert.doesNotThrow(()=>f.editor.reflow([f.w],[next],f.state.wallEdits));assert.equal(f.d().faces.length,0);
 });

 test('a near-collapsed return inside numerical snap tolerance does not reject the entire preview',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);const next=JSON.parse(JSON.stringify(f.w));next.bottom[1].x=next.bottom[0].x+.00001;next.top[1].x=next.top[0].x+.00001;assert.doesNotThrow(()=>f.editor.reflow([f.w],[next],f.state.wallEdits));assert.equal(f.d().faces.length,0);
 });

 test('a moved draft repairs a stale open perimeter left by a previous corner merge',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);const ids=f.d().sketch.nodes.map(n=>n.id);f.d().sketch.edges.pop();const next=JSON.parse(JSON.stringify(f.w));for(const edge of ['bottom','top'])next[edge][1].x=3;
 assert.doesNotThrow(()=>f.editor.reflow([f.w],[next],f.state.wallEdits));assert.equal(f.d().faces.length,1);assert.ok(f.d().faces[0].points.some(p=>p.x===3));assert.ok(ids.every(id=>f.d().sketch.nodes.some(n=>n.id===id)));
 });

test('3D boundary line requires a full click, deletes its face and retains endpoints with undo',()=>{
 const f=fixture(),e=f.e(2,0);f.editor.down(e);assert.equal(f.editor.key({key:'delete'}),false);assert.equal(f.state.wallEdits.$drafts,undefined);
 f.editor.down(e);f.listeners.pointerup(e);assert.equal(f.message(),'1 lines selected');f.editor.key({key:'delete'});
 assert.equal(f.d().deletedFaces.length,1,f.message());assert.equal(f.d().sketch.nodes.length,4);assert.equal(f.d().sketch.edges.length,3);assert.equal(f.history.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(f.history[0])),{});const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.equal(loaded.d().sketch.edges.length,3);assert.equal(loaded.d().deletedFaces.length,1);
});
test('Shift adds and Control removes 3D segments on different walls',()=>{
 const wall=(id,x)=>({id,bottom:[{x,y:0,z:0},{x:x+4,y:0,z:0}],top:[{x,y:0,z:4},{x:x+4,y:0,z:4}]}),f=fixture({walls:[wall('a',0),wall('b',6)]});
 const click=(x,shiftKey=false,ctrlKey=false)=>{const e={...f.e(x,0,shiftKey),ctrlKey};f.editor.down(e);f.listeners.pointerup(e);};
 click(2);click(8,true);assert.equal(f.message(),'2 lines selected');click(8,false,true);assert.equal(f.message(),'1 lines selected');click(8,true);f.editor.key({key:'delete'});
 for(const d of Object.values(f.state.wallEdits.$drafts)){assert.equal(d.sketch.nodes.length,4);assert.equal(d.sketch.edges.length,3);assert.equal(d.deletedFaces.length,1);}assert.equal(f.history.length,1);
});
test('deleting a draft divider merges both regions and preserves its points',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);f.editor.doubleClick(f.e(2,4),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});assert.equal(f.d().faces.length,2);
 const count=f.d().sketch.nodes.length;f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.editor.key({key:'delete'});
 assert.equal(f.d().sketch.nodes.length,count);assert.equal(f.d().deletedFaces.length,2);const merged=f.state.wallEdits.$surfaces.filter(s=>!s.deleted);assert.equal(merged.length,1,f.message());assert.ok(merged[0].points.every(p=>p.y===0));assert.equal(Math.max(...merged[0].points.map(p=>p.x)),4);
 const graph=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js').surfaceWire(f.state.wallEdits);assert.ok(!graph.edges.some(e=>e.a.startsWith('2.000000,')&&e.b.startsWith('2.000000,')));
});
test('3D line picking leaves point marquee and 2D face selection intact',()=>{
 const f=fixture();f.editor.down(f.e(2,0));f.listeners.pointermove(f.e(5,5));f.listeners.pointerup(f.e(5,5));assert.match(f.message(),/points selected/);
 const e={...f.e(2,0),target:{closest:s=>s==='#viewport'}};f.editor.down(e);f.listeners.pointerup(e);assert.notEqual(f.message(),'1 lines selected');
});
test('deleting standalone shared coplanar line retains vertices and merges the faces',()=>{
 const wall=(id,x0,x1)=>({id,points:[{x:x0,y:0,z:0},{x:x1,y:0,z:0},{x:x1,y:0,z:4},{x:x0,y:0,z:4}]}),f=fixture({walls:[],state:{wallEdits:{$surfaces:[wall('a',0,2),wall('b',2,4)]}}});
 f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.editor.key({key:'delete'});assert.equal(f.state.wallEdits.$surfaces.filter(s=>!s.deleted).length,1,f.message());
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),wire=W.surfaceWire(f.state.wallEdits);assert.equal(wire.nodes.length,6);assert.ok(!wire.edges.some(e=>e.id===W.edgeKey({x:2,y:0,z:0},{x:2,y:0,z:4})));
});

test('retained wire uses live drafted support for colors and deleting a moved corner removes its face',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(2,0),f.w);const d=f.d(),corner=d.sketch.nodes.find(n=>n.x===2&&n.y===0);corner.y=1;corner.fixed=false;
 for(const face of d.faces)for(const p of face.points)if(p.nodeId===corner.id)p.y=1;
 d.sketch.edges=d.sketch.edges.flatMap(e=>{const a=d.sketch.nodes.find(n=>n.id===e.a),b=d.sketch.nodes.find(n=>n.id===e.b);return a.y===0&&b.y===0?[{...e,b:corner.id},{...e,id:e.id+'b',a:corner.id}]:[e];});
 for(const e of d.sketch.edges)e.fixed=false;
 f.state.wallEdits.$surfaces=[{id:'old-wire',deleted:true,points:d.faces[0].points.map(p=>({x:p.x,y:0,z:p.y}))}];f.editor.clear();
 const rendered=[];f.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.equal(rendered.filter(o=>o.material.color==='#6ce4ed').length,0,'Live face corners and boundary lines must be orange, including the retained wire overlay');
 const before=JSON.stringify(f.state.wallEdits);f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.editor.key({key:'Delete'});
 assert.ok(f.d().removedPoints.includes(corner.id),f.message());assert.ok(f.d().deletedFaces.length);assert.equal(JSON.stringify(f.history.at(-1)),before);
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.ok(loaded.d().removedPoints.includes(corner.id));
});
test('deleting a loose point on discarded source geometry does not rebuild an open face',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);const d=f.d(),point=d.sketch.nodes.find(n=>n.x===2&&n.y===0);d.deletedFaces=d.faces.map(face=>face.points.map(p=>p.nodeId).sort().join('|'));d.sketch.edges.pop();
 f.state.wallEdits.$surfaces=[{id:'retained',deleted:true,points:d.faces[0].points.map(p=>({x:p.x,y:0,z:p.y}))}];f.editor.clear();f.editor.down(f.e(2,0));f.listeners.pointerup(f.e(2,0));const count=f.history.length;f.editor.key({key:'Delete'});
 assert.equal(f.history.length,count+1,f.message());assert.ok(f.d().removedPoints.includes(point.id));assert.equal(f.d().deletedFaces.length,1);
});

test('deleting a drafted host corner removes only its incident region, not the neighboring region',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),host={id:'host',drafted:true,points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]},frame=W.faceFrame(host),d={frame,solidHost:'host',members:[],faces:[{id:'region',points:host.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);const a=S.add(d,{x:2,y:0,z:0}),b=S.add(d,{x:2,y:4,z:0});S.connect(d,[a,b]);
 const f=fixture({state:{wallEdits:{$surfaces:[host],$drafts:{host:d}}},walls:[],globals:renderGlobals()});f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1,1));f.listeners.pointerup(f.e(1,1));f.editor.down(f.e(0,0));f.listeners.pointerup(f.e(0,0));f.editor.key({key:'Delete'});
 assert.ok(!host.deleted);assert.equal(d.deletedFaces.length,1,f.message());assert.equal(d.faces.length,2);assert.ok(d.removedPoints.length);
});

test('an extruded recess rim remains structural when its supporting wall uses a hole ring',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.clear();
 let rendered=[];f.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.ok(rendered.some(o=>o.material.color==='#6ce4ed'),'A flat internal drawing is initially nonstructural');
 const opening=f.d().faces.find(face=>face.opening);opening.solidId='extruded-cap';
 rendered=[];f.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.equal(rendered.filter(o=>o.material.color==='#6ce4ed').length,0,'The remaining wall depends on all four recess corners and rim edges even without a return face');
});

test('Q placement uses the opposite corner snap rather than only the cursor location',()=>{
 const f=fixture();for(const [x,y]of [[1,1],[3,1],[3,3]])f.editor.doubleClick(f.e(x,y),f.w);
 f.editor.down(f.e(1,1));f.listeners.pointerup(f.e(1,1));f.editor.down(f.e(3,1,true));f.listeners.pointerup(f.e(3,1,true));f.editor.key({key:'q'});
 f.listeners.pointermove(f.e(2,2.88));assert.match(f.message(),/Quadrilateral/);f.editor.down(f.e(2,2.88));f.listeners.pointerup(f.e(2,2.88));
 const opening=f.d().faces.find(face=>face.opening);assert.ok(opening,f.message());assert.ok(opening.points.every(p=>Math.abs(p.y-1)<1e-6||Math.abs(p.y-3)<1e-6));assert.ok(opening.points.some(p=>Math.abs(p.x-1)<1e-6&&Math.abs(p.y-3)<1e-6));
});

test('E extrudes a divided region; M instead moves its shared neighbors, with preview cancel and undo',()=>{
 const f=fixture({screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 for(const x of [1,3]){f.editor.doubleClick(f.e(x,0),f.w);f.editor.doubleClick(f.e(x,4),f.w);f.editor.down(f.e(x,0,true));f.listeners.pointerup(f.e(x,0,true));f.editor.key({key:'u'});}
 assert.equal(f.d().faces.length,3);f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.5,2));let surfaces=f.state.wallEdits.$surfaces;assert.equal(surfaces.filter(s=>!s.deleted&&!s.drafted).length,3,f.message());assert.ok(surfaces.every(s=>!s.id.includes('-side-')));assert.equal(f.d().faces.filter(r=>r.solidId).length,3);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(2,2));f.editor.key({key:'e'});f.listeners.pointermove(f.e(1.5,2));assert.equal(f.state.wallEdits.$surfaces.filter(s=>s.id.includes('-side-')).length,2);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.5,2));const preview=JSON.stringify(f.state.wallEdits);f.editor.down(f.e(1.5,2));assert.equal(JSON.stringify(f.state.wallEdits),preview);assert.equal(JSON.stringify(f.history.at(-1)),before);
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.equal(loaded.state.wallEdits.$surfaces.length,3);
});

test('moving a snapped region hides leftover source intersection points and restores them on cancel',()=>{
 const f=fixture({globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(2,2),f.w);const d=f.d();
 // The import/intersection pass can leave construction nodes not used in a
 // resolved ring, even though they belong to that ring's boundary.
 d.sketch.nodes.push({id:'snap-intersection',x:2,y:0,z:0,fixed:false});f.editor.clear();f.editor.down(f.e(1.5,2));f.listeners.pointerup(f.e(1.5,2));f.listeners.pointermove(f.e(1.5,2));const before=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'m'});f.listeners.pointermove(f.e(1,2));let rendered=[];f.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.equal(rendered.filter(o=>o.material.size===8&&o.material.color==='#6ce4ed'&&o.geometry.points.some(p=>Math.abs(p.y)<1e-6)).length,0,'Old source-only points must not be drawn');
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);rendered=[];f.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.ok(rendered.some(o=>o.material.size===8&&o.material.color==='#6ce4ed'));
 f.listeners.pointermove(f.e(1.5,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1,2));f.editor.down(f.e(1,2));const loaded=fixture({state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()});rendered=[];loaded.editor.draw3D({add:o=>rendered.push(o)},p=>p);assert.equal(rendered.filter(o=>o.material.size===8&&o.material.color==='#6ce4ed'&&o.geometry.points.some(p=>Math.abs(p.y)<1e-6)).length,0);
});

test('E sweeps existing side walls in preview, with cancel, placement, undo and reload',()=>{
 const front={id:'w',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:4},{x:4,y:0,z:4}]};
 const left={id:'left',bottom:[{x:0,y:0,z:0},{x:0,y:2,z:0}],top:[{x:0,y:0,z:4},{x:0,y:2,z:4}]};
 const f=fixture({walls:[front,left],screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(2,2),front);f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));f.listeners.pointermove(f.e(1,2));
 const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,2));
 let sides=f.state.wallEdits.$surfaces.filter(s=>s.id.startsWith('swept-'));assert.equal(sides.length,1,f.message());assert.ok(sides[0].points.every(p=>p.y>=1-1e-7));
 assert.ok(f.state.wallEdits.$drafts.left.faces.every(r=>r.solidId));
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(1,2));f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,2));const preview=JSON.stringify(f.state.wallEdits);f.editor.down(f.e(2,2));assert.equal(JSON.stringify(f.state.wallEdits),preview);assert.equal(JSON.stringify(f.history.at(-1)),before);
 const loaded=fixture({walls:[front,left],state:JSON.parse(JSON.stringify(f.state))});assert.equal(JSON.stringify(loaded.state.wallEdits),preview);
});

test('near-edge double click and N attach to opposite boundaries and split the face',()=>{
 const f=fixture();f.editor.doubleClick(f.e(.04,1.37),f.w);
 const start=f.d().sketch.nodes.find(p=>Math.abs(p.y-1.37)<1e-7);assert.equal(start.x,0);assert.equal(start.fixed,true);
 f.editor.key({key:'n'});f.listeners.pointermove(f.e(4.04,1.39));f.editor.down(f.e(4.04,1.39));
 assert.equal(f.d().faces.length,2,f.message());const end=f.d().sketch.nodes.find(p=>Math.abs(p.y-start.y)<1e-7&&p.x>3);assert.equal(end.x,4);assert.equal(end.fixed,true);
 assert.ok(f.d().faces.every(face=>face.points.some(p=>p.nodeId===start.id)&&face.points.some(p=>p.nodeId===end.id)));
});
test('failed N placement leaves drawing active so another click can finish it',()=>{
 let fail=true;const f=fixture({globals:{BaseSketchGeometry:{...S,add(...args){if(fail)throw Error('Invalid test placement');return S.add(...args);}}}});fail=false;f.editor.doubleClick(f.e(0,1.37),f.w);f.editor.key({key:'n'});fail=true;f.editor.down(f.e(6,1.37));assert.equal(f.editor.busy(),true);
 fail=false;f.editor.down(f.e(4,1.37));assert.equal(f.d().faces.length,2,f.message());assert.equal(f.editor.busy(),false);
});

test('consumed extrusion sketch hides interior orphan segments, not just its perimeter',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);
 const d=f.d(),a={id:'orphan-a',x:1,y:1,z:0},b={id:'orphan-b',x:3,y:1,z:0};d.sketch.nodes.push(a,b);
 d.sketch.edges.push({id:'old-interior',a:a.id,b:b.id,fixed:false});d.faces.forEach(r=>r.solidId='swept-face');
 const lines=[];f.editor.draw2D(null,(tag,attrs)=>{if(tag==='line')lines.push(attrs);},1);
 assert.equal(lines.length,0,'source wire inside consumed geometry must not render');
});

test('drafting on an automatically merged ring keeps the existing opening',()=>{
 const w=(id,x0,x1,z0,z1)=>({id,bottom:[{x:x0,y:0,z:z0},{x:x1,y:0,z:z0}],top:[{x:x0,y:0,z:z1},{x:x1,y:0,z:z1}]});
 const walls=G.mergeCoplanar([w('w',0,1,0,4),w('b',3,4,0,4),w('c',1,3,0,1),w('d',1,3,3,4)]).walls;
 const f=fixture({walls});f.editor.doubleClick(f.e(.5,2),walls[0]);const d=f.state.wallEdits.$drafts[walls[0].mergeGroup];assert.ok(d);assert.equal(d.faces.filter(f=>f.boundaryHole).length,1);assert.equal(d.faces.find(f=>!f.boundaryHole).holes.length,1);
});

test('shared-edge double click keeps the explicitly selected drawing face',()=>{
 const f=fixture();f.editor.beginFace(f.e(1,2),f.w);f.listeners.pointerup(f.e(1,2));
 const other={id:'perpendicular',bottom:[{x:0,y:0,z:0},{x:0,y:3,z:0}],top:[{x:0,y:0,z:4},{x:0,y:3,z:4}]};
 assert.equal(f.editor.holdBoundary(f.e(.02,1.3)),true);f.editor.doubleClick(f.e(.02,1.3),other);
 assert.equal(f.state.wallEdits.$drafts.perpendicular,undefined);assert.ok(f.d().sketch.nodes.some(n=>n.x===0&&Math.abs(n.y-1.3)<1e-6));
 assert.equal(f.editor.holdBoundary(f.e(1,1.3)),false);
});
test('saved empty merged draft rebuilds and retains its center after point insertion and deselection',()=>{
 const c=require('./fixtures/merged-wall-empty-draft.json'),key=c.walls[0].mergeGroup;
 const f=fixture({walls:c.walls,state:{wallEdits:{$drafts:{[key]:structuredClone(c.draft)}}},globals:renderGlobals()});
 let objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);let d=f.state.wallEdits.$drafts[key];assert.equal(d.faces.length,1);assert.ok(d.sketch.nodes.length>0);assert.equal(objects.filter(o=>o.userData?.faceCenter).length,1);
 f.editor.doubleClick(f.e(0,160),c.walls[0]);f.editor.clear();objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.equal(objects.filter(o=>o.userData?.faceCenter).length,1);assert.ok(objects.some(o=>o.material.opacity===.3));
 f.state.wallCenters=false;objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.equal(objects.filter(o=>o.userData?.faceCenter).length,0);assert.ok(objects.some(o=>o.material.opacity===.3));
});
test('existing shared point selection keeps the chosen plane through the early surface picker',()=>{
 const f=fixture();f.editor.doubleClick(f.e(0,1.3),f.w);f.editor.clear();
 f.editor.beginFace(f.e(1,2),f.w);f.listeners.pointerup(f.e(1,2));
 assert.equal(f.editor.pickSolid(f.e(0,1.3)),true);f.listeners.pointerup(f.e(0,1.3));
 f.editor.key({key:'n'});f.editor.down(f.e(4,1.3));
 assert.equal(f.d().faces.length,2,f.message());
});
test('merged wall initialization preserves former divider endpoints for resplitting',()=>{
 const w=(id,a,b)=>({id,bottom:[{x:a,y:0,z:0},{x:b,y:0,z:0}],top:[{x:a,y:0,z:4},{x:b,y:0,z:4}]});
 const walls=G.mergeCoplanar([w('w',0,2),w('other',2,4)]).walls,f=fixture({walls});
 f.editor.beginFace(f.e(1,2),walls[0]);f.listeners.pointerup(f.e(1,2));const d=f.state.wallEdits.$drafts[walls[0].mergeGroup];
 assert.equal(d.faces.length,1);assert.ok(d.sketch.nodes.some(p=>p.x===2&&p.y===0));assert.ok(d.sketch.nodes.some(p=>p.x===2&&p.y===4));
 f.editor.pickSolid(f.e(2,0));f.listeners.pointerup(f.e(2,0));f.editor.key({key:'n'});f.editor.down(f.e(2,4));assert.equal(d.faces.length,2,f.message());
});
test('a shared point owned only by the perpendicular face mounts on the selected face',()=>{
 const f=fixture();f.editor.beginFace(f.e(1,2),f.w);f.listeners.pointerup(f.e(1,2));
 f.state.wallEdits.$surfaces=[{id:'other-plane',points:[{x:0,y:0,z:1.3},{x:0,y:2,z:1.3},{x:0,y:2,z:3},{x:0,y:0,z:3}]}];
 assert.equal(f.editor.pickSolid(f.e(0,1.3)),true);f.listeners.pointerup(f.e(0,1.3));assert.ok(f.d().sketch.nodes.some(n=>n.x===0&&n.y===1.3));
 f.editor.key({key:'n'});f.editor.down(f.e(4,1.3));assert.equal(f.d().faces.length,2,f.message());assert.equal(f.state.wallEdits.$surfaces[0].drafted,undefined);
});
test('selecting a generated surface then its retained point draws on that surface',()=>{
 const cap={id:'cap',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],retainedPoints:[{x:0,y:0,z:1.3}]};
 const f=fixture({state:{wallEdits:{$surfaces:[cap]}},globals:renderGlobals()});f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,2));f.listeners.pointerup(f.e(2,2));
 f.editor.pickSolid(f.e(0,1.3));f.listeners.pointerup(f.e(0,1.3));f.editor.key({key:'n'});f.editor.down(f.e(4,1.3));
 assert.equal(f.state.wallEdits.$drafts['solid:cap'].faces.length,2,f.message());
});
test('extrusion repairs and preserves legacy split points on an unrelated merged wall',()=>{
 const segment=(id,x0,x1)=>({id,mergeGroup:'remote',bottom:[{x:x0,y:0,z:0},{x:x1,y:0,z:0}],top:[{x:x0,y:0,z:4},{x:x1,y:0,z:4}]});
 const f=fixture({screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 const remote={origin:{x:10,y:0,z:0},u:{x:1,y:0},members:['a','b'],faces:[{id:'legacy',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]};S.ensure(remote);
 const loaded=fixture({walls:[f.w,segment('a',10,12),segment('b',12,14)],state:{wallEdits:{$drafts:{remote}}},screen:p=>({x:(p.x+p.y)*100,y:p.z*100}),globals:renderGlobals()});
 loaded.editor.beginFace(loaded.e(1,2),f.w);loaded.listeners.pointerup(loaded.e(1,2));loaded.listeners.pointermove(loaded.e(1,2));loaded.editor.key({key:'e'});loaded.listeners.pointermove(loaded.e(2,2));
 const points=()=>loaded.state.wallEdits.$drafts.remote.sketch.nodes;assert.ok(points().some(n=>n.x===2&&n.y===0));assert.ok(points().some(n=>n.x===2&&n.y===4));
 loaded.editor.down(loaded.e(2,2));const saved=JSON.stringify(loaded.state);const reload=fixture({walls:[f.w,segment('a',10,12),segment('b',12,14)],state:JSON.parse(saved),globals:renderGlobals()});reload.editor.draw3D({add(){}},p=>p);
 assert.equal(JSON.stringify(reload.state),saved);assert.equal(reload.state.wallEdits.$drafts.remote.faces.length,1);
});
test('live extrusion edge labels default on, toggle off, and disappear after placement',()=>{
 const globals=renderGlobals();globals.THREE.CanvasTexture=class{};globals.THREE.SpriteMaterial=class{constructor(o){Object.assign(this,o);}};globals.THREE.Sprite=class{constructor(m){this.material=m;this.userData={};this.position={copy(){}};this.scale={set(){}};}};
 globals.document={getElementById:()=>null,createElement:()=>({getContext:()=>({fillRect(){},strokeRect(){},strokeText(){},fillText(){}})})};
 const f=fixture({globals,screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});f.editor.beginFace(f.e(1,2),f.w);f.listeners.pointerup(f.e(1,2));f.listeners.pointermove(f.e(1,2));f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,2));
 const labels=()=>{const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);return objects.filter(o=>o.userData.wallLength);};assert.ok(labels().length);assert.ok(labels().every(o=>o.userData.wallLength>0));
 f.state.wallLengths=false;assert.equal(labels().length,0);f.state.wallLengths=true;f.editor.down(f.e(2,2));assert.equal(labels().length,0);
});
test('saved connected drafted recess M keeps its top return attached',()=>{
 const saved=structuredClone(require('./fixtures/connected-move-editor.json')),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),id='region-R13:0|R8.0:0|gap-fill-1.0:0-base-face-17',key='solid:'+id,cap=saved.wallEdits.$surfaces.find(f=>f.id===id),frame=W.faceFrame(cap);
 cap.drafted=true;const d={frame,solidHost:id,members:[],faces:[{id:'selected',points:cap.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);saved.wallEdits.$drafts[key]=d;
 const globals=renderGlobals();globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){const m=ms.find(m=>m.userData.draftKey===key);return m?[{object:m}]:[];}};
 const f=fixture({state:{wallEdits:saved.wallEdits},walls:saved.walls,globals,projectPoint:d=>W.inFrame(d.frame,cap.points.reduce((a,p)=>({x:a.x+p.x/cap.points.length,y:a.y+p.y/cap.points.length,z:a.z+p.z/cap.points.length}),{x:0,y:0,z:0})),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,.6));f.listeners.pointerup(f.e(2,.6));f.listeners.pointermove(f.e(2,.6));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m'});
 const check=()=>{const moved=f.state.wallEdits.$surfaces.find(f=>f.id==='region-'+key+'-selected'),top=f.state.wallEdits.$surfaces.find(f=>f.id.includes('side-0-3-0'));
 assert.ok(moved,f.message());for(const corner of [moved.points[3],moved.points[4]])assert.ok(top.points.some(p=>Math.hypot(p.x-corner.x,p.y-corner.y,p.z-corner.z)<1e-5),'Both shared top corners must move with the cap');};
 for(const x of [1.2,1.6,2.2]){f.listeners.pointermove(f.e(x,.6));check();}
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(2,.6));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.2,.6));check();f.editor.down(f.e(1.2,.6));check();
 const savedAfter=JSON.stringify(f.state);const reloaded=fixture({state:JSON.parse(savedAfter),walls:saved.walls,globals:renderGlobals()});reloaded.editor.draw3D({add(){}},p=>p);for(const f0 of f.state.wallEdits.$surfaces.filter(s=>s.id.includes('side-0-3-0')||s.id==='region-'+key+'-selected'))assert.equal(JSON.stringify(reloaded.state.wallEdits.$surfaces.find(s=>s.id===f0.id)?.points),JSON.stringify(f0.points));
});
test('clicking near a selected face edge selects only the line and M slides its shared divider',()=>{
 const f=fixture({globals:renderGlobals(),projectPoint:(d,e)=>d.frame?require('../public/measure/internal/editor_scripts/wall_solid_geometry.js').inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):({x:e.clientX/100,y:e.clientY/100,z:0})});f.editor.doubleClick(f.e(0,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(4,1));f.listeners.pointerup(f.e(4,1));
 f.editor.beginFace(f.e(2,.5),f.w);f.listeners.pointerup(f.e(2,.5));assert.equal(f.editor.pickSolid(f.e(2,1.06)),true);f.listeners.pointerup(f.e(2,1.06));assert.equal(f.message(),'1 lines selected');
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.color==='#fff'&&o.material.depthTest===false&&o.renderOrder===1000));
 f.listeners.pointermove(f.e(2,1));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m'});assert.equal(f.editor.busy(),true);f.listeners.pointermove(f.e(2,1.5));
 const regions=f.d().faces;assert.equal(regions.length,2,f.message());assert.ok(regions.every(s=>s.points.filter(p=>Math.abs(p.y-1.5)<1e-6).length===2));assert.ok(!f.state.wallEdits.$surfaces?.length,'Planar edits stay in their owning sketch');
 f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.listeners.pointermove(f.e(2,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2,1.8));f.editor.down(f.e(2,1.8));assert.equal(f.editor.busy(),false);assert.ok(f.d().faces.every(s=>s.points.some(p=>Math.abs(p.y-1.8)<1e-6)));
});
test('M slides an interior construction line without replacing its supporting face',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),f=fixture({projectPoint:(d,e)=>d.frame?W.inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):({x:e.clientX/100,y:e.clientY/100,z:0})});
 f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(3,1));f.listeners.pointerup(f.e(3,1));f.editor.pickSolid(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2,2));f.editor.down(f.e(2,2));
 assert.equal(f.d().faces.length,1);assert.equal(f.d().faces[0].solidId,undefined);assert.ok(f.d().sketch.nodes.some(p=>Math.abs(p.x-1)<1e-6&&Math.abs(p.y-2)<1e-6),f.message());assert.ok(f.d().sketch.nodes.some(p=>Math.abs(p.x-3)<1e-6&&Math.abs(p.y-2)<1e-6));
});
test('saved gap snaps and places M and E against perpendicular wall corners',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
 for(const mode of ['m','e'])for(const drafted of [false,true]){
 const saved=structuredClone(require('./fixtures/move-gap-snap.json')),globals=renderGlobals(),key='solid:'+saved.sourceId;let resultId=saved.sourceId;if(drafted){const cap=saved.wallEdits.$surfaces.find(s=>s.id===saved.sourceId),frame=W.faceFrame(cap),d={frame,solidHost:cap.id,members:[],faces:[{id:'selected',points:cap.points.map(p=>W.inFrame(frame,p))}]};S.ensure(d);saved.wallEdits.$drafts[key]=d;cap.drafted=true;resultId='region-'+key+'-selected';}globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){const m=ms.find(m=>drafted?m.userData.draftKey===key:m.userData.solidId===saved.sourceId);return m?[{object:m}]:[];}};
 const f=fixture({state:{wallEdits:saved.wallEdits},walls:saved.walls,globals,projectPoint:d=>B.center(d.faces[0]),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(20,20));f.listeners.pointerup(f.e(20,20));f.listeners.pointermove(f.e(20,20));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:mode});
 for(const x of [21.55,21.64,21.55]){f.listeners.pointermove(f.e(x,20));assert.match(f.message(),/snap/i);const cap=f.state.wallEdits.$surfaces.find(s=>s.id===resultId);assert.ok(cap.points.some(p=>Math.hypot(p.x-saved.target.x,p.y-saved.target.y,p.z-saved.target.z)<1e-5),f.message());}
 f.editor.down(f.e(21.55,20));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,1);assert.notEqual(JSON.stringify(f.state.wallEdits),before);
 }
});
test('line M snaps to a retained edge point with a yellow cue and commits the exact preview',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),f=fixture({globals:renderGlobals(),projectPoint:(d,e)=>d.frame?W.inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):({x:e.clientX/100,y:e.clientY/100,z:0})});
 f.editor.doubleClick(f.e(0,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(4,1));f.listeners.pointerup(f.e(4,1));f.editor.doubleClick(f.e(0,2),f.w);f.editor.clear();
 f.editor.pickSolid(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2,1.96));assert.match(f.message(),/Point snap/);
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material?.color==='#FFD700'));assert.ok(f.d().faces.every(s=>s.points.some(p=>Math.abs(p.y-2)<1e-6)));
 const preview=JSON.stringify(f.state.wallEdits);f.editor.down(f.e(2,1.96));assert.equal(JSON.stringify(f.state.wallEdits),preview);assert.equal(f.editor.busy(),false);
});
test('window labeling, size cycling, nudging and metadata survive resolve and reload',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[2,1],[2,2],[1,2],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}f.editor.down(f.e(1.5,1.5));f.listeners.pointerup(f.e(1.5,1.5));
 const selected=()=>f.d().faces.find(f=>f.feature),before=f.d().faces.find(f=>f.opening).points.map(p=>({...p}));f.editor.key({key:'w',ctrlKey:true});assert.equal(selected().feature.type,'window');assert.equal(JSON.stringify(selected().points),JSON.stringify(before));
 f.editor.key({key:'w',ctrlKey:true});assert.equal(selected().feature.preset,0,f.message());const F=require('../public/measure/internal/editor_scripts/wall_features.js'),b=F.bounds(selected().points);assert.ok(Math.abs(b.right-b.left-3*F.FT)<1e-8);
 f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(F.bounds(selected().points).left-b.left-F.FT/12)<1e-8,f.message());S.resolve(f.d());assert.equal(selected().feature.type,'window');const restored=fixture({state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()});restored.editor.draw3D({add(){}},p=>p);assert.equal(restored.d().faces.find(f=>f.feature).feature.type,'window');
});
test('library placement creates editable geometry and cancellation leaves no sticker',()=>{
 let f;f=fixture({featureHost:()=>{const d=f.d();return {d,f:d.faces[0],points:d.faces[0].points.map(p=>({x:p.x,y:0,z:p.y}))};},globals:renderGlobals(),projectPoint:(d,e)=>d.frame?require('../public/measure/internal/editor_scripts/wall_solid_geometry.js').inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):({x:e.clientX/100,y:e.clientY/100,z:0})});f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));const before=JSON.stringify(f.state.wallEdits);f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));f.editor.down(f.e(2,2));assert.ok(f.d().faces.some(f=>f.feature?.type==='window'),f.message());assert.equal(f.editor.busy(),false);assert.ok(f.d().sketch.edges.some(e=>!e.fixed));
});
function stickerFixture(type='window',point=[2,2],options={}){let f;const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');f=fixture({...options,featureHost:()=>{const d=f.d();return {d,f:d.faces[0],points:d.faces[0].points.map(p=>({x:p.x,y:0,z:p.y}))};},globals:renderGlobals(),projectPoint:(d,e)=>d.frame?W.inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):({x:e.clientX/100,y:e.clientY/100,z:0})});f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));f.editor.featureCommand(type,0,true);f.listeners.pointermove(f.e(...point));f.editor.down(f.e(...point));return f;}
test('door resizing keeps its floor anchor and corner with boundary split points intact',()=>{const F=require('../public/measure/internal/editor_scripts/wall_features.js'),f=stickerFixture('door',[.4572,1.04]);let door=()=>f.d().faces.find(f=>f.feature);assert.ok(door(),f.message());assert.ok(Math.abs(F.bounds(door().points).bottom)<1e-8);assert.ok(Math.abs(F.bounds(door().points).left)<1e-8);f.editor.key({key:'d',ctrlKey:true});assert.equal(door().feature.preset,1,f.message());assert.ok(Math.abs(F.bounds(door().points).bottom)<1e-8);assert.ok(Math.abs(F.bounds(door().points).left)<1e-8);assert.ok(f.d().faces.length>1);});
test('vent cycles rectangle square circle and back without losing the host face',()=>{const f=stickerFixture('vent');for(const index of [1,2,0]){f.editor.featureCommand('vent',index);const vent=f.d().faces.find(f=>f.feature);assert.equal(vent?.feature.preset,index,f.message());assert.ok(index===2?vent.points.length===48:vent.points.length>=4);assert.ok(f.d().faces.some(f=>!f.feature));}});
test('feature edge nudge stretches the selected edge, and invalid resize is atomic',()=>{const F=require('../public/measure/internal/editor_scripts/wall_features.js'),f=stickerFixture(),feature=()=>f.d().faces.find(f=>f.feature),b=F.bounds(feature().points);f.editor.pickSolid(f.e(b.right,(b.top+b.bottom)/2));f.listeners.pointerup(f.e(b.right,(b.top+b.bottom)/2));f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(F.bounds(feature().points).right-b.right-F.FT/12)<1e-8,f.message());assert.ok(Math.abs(F.bounds(feature().points).left-b.left)<1e-8);const before=JSON.stringify(f.state.wallEdits);f.editor.featureCommand('garage',0);assert.equal(JSON.stringify(f.state.wallEdits),before,f.message());});
test('arrow nudge moves an unlabeled internal face and shared divider without creating returns',()=>{const f=stickerFixture();f.editor.featureCommand('none');const before=f.d().faces.find(f=>f.opening).points[0].x;f.editor.key({key:'ArrowRight'});assert.ok(f.d().faces.find(f=>f.opening).points[0].x>before);assert.equal(f.state.wallEdits.$surfaces,undefined);});
test('arrow keys slide an unlabeled shared divider and preserve both adjoining faces',()=>{let cameraReady=false;const f=fixture({screen:p=>({x:p.x*100,y:p.z*100*(cameraReady?-1:1)})});f.editor.doubleClick(f.e(0,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(4,1));f.listeners.pointerup(f.e(4,1));f.editor.pickSolid(f.e(2,1));f.listeners.pointerup(f.e(2,1));cameraReady=true;f.editor.key({key:'ArrowUp',shiftKey:true});assert.equal(f.d().faces.length,2,f.message());assert.ok(f.d().faces.every(face=>face.points.some(p=>Math.abs(p.y-1-.1524)<1e-7)),f.message());});
test('all line lengths exclude feature boundaries and feature dimensions toggle separately',()=>{const f=stickerFixture(),paint=[];const globals=renderGlobals();globals.THREE.CanvasTexture=class{};globals.THREE.SpriteMaterial=class{constructor(o){Object.assign(this,o);}};globals.THREE.Sprite=class{constructor(m){this.material=m;this.userData={};this.position={copy(){}};this.scale={set(){}};}};globals.document={getElementById:()=>null,createElement:()=>({getContext:()=>({strokeText(){},fillText:t=>paint.push(t)})})};const state=JSON.parse(JSON.stringify(f.state));state.lineLengthMode='all';const r=fixture({state,globals});r.editor.draw3D({add(){}},p=>p);assert.equal(paint.filter(t=>t.includes('×')).length,1);const featureText=paint.find(t=>t.includes('×'));assert.ok(featureText.includes('3 × 4'));assert.ok(paint.some(t=>!t.includes('×')));state.lineLengthMode='off';paint.length=0;const sprites=[];r.editor.draw3D({add:o=>{if(o instanceof globals.THREE.Sprite)sprites.push(o);}},p=>p);assert.equal(sprites.length,1);assert.deepEqual(paint,[],'unchanged dimensions reuse their text texture');state.featureDimensions=false;sprites.length=0;r.editor.draw3D({add:o=>{if(o instanceof globals.THREE.Sprite)sprites.push(o);}},p=>p);assert.equal(sprites.length,0);});

function stepFixture(thin=false){const w={id:'w',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:1}],top:[{x:0,y:0,z:thin?.05:4},{x:4,y:0,z:thin?1.05:4}]};const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),f=fixture({walls:[w],projectPoint:(d,e)=>d.frame?W.inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):{x:e.clientX/100,y:e.clientY/100,z:0}});return {...f,w};}
function selectStepLine(f,x=2,z=.5){f.editor.down(f.e(x,z));f.listeners.pointerup(f.e(x,z));}
test('S previews from one step through twelve, shifts the anchor, cancels and resets without ghost geometry',()=>{const f=stepFixture();selectStepLine(f);const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'s'});assert.equal(f.editor.busy(),true);assert.match(f.message(),/^1 step/);assert.equal(f.state.wallEdits.$surfaces.length,1);for(let i=2;i<=12;i++)f.editor.key({key:'s'});assert.match(f.message(),/^12 steps/);f.editor.key({key:'s',repeat:true});assert.match(f.message(),/^12 steps/);const cap=f.state.wallEdits.$surfaces[0],risers=cap.points.filter((p,i)=>{const q=cap.points[(i+1)%cap.points.length];return Math.abs(p.x-q.x)<1e-6&&Math.abs(Math.abs(p.z-q.z)-1/12)<1e-6;});assert.equal(risers.length,12);f.listeners.pointermove(f.e(1.48,.37));assert.match(f.message(),/^12 steps/);assert.equal(f.state.wallEdits.$surfaces.length,1);assert.equal(f.history.length,0);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);f.editor.key({key:'s'});assert.match(f.message(),/^1 step/);f.editor.down(f.e(1.48,.37));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);});
test('invalid step previews cannot be placed, and Ctrl-Z cancels them atomically',()=>{const f=stepFixture(true);selectStepLine(f,.4,.1);const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'s'});assert.match(f.message(),/cross another edge/);f.editor.down(f.e(.4,.1));assert.equal(f.history.length,0);assert.equal(f.editor.busy(),true);f.editor.key({key:'z',ctrlKey:true});assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.state.wallEdits),before);});
test('stepping a free construction segment replaces its wire while keeping its endpoints and face',()=>{const f=fixture({projectPoint:(d,e)=>d.frame?require('../public/measure/internal/editor_scripts/wall_solid_geometry.js').inFrame(d.frame,{x:e.clientX/100,y:0,z:e.clientY/100}):{x:e.clientX/100,y:e.clientY/100,z:0}});f.editor.doubleClick(f.e(.5,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(3.5,3));f.listeners.pointerup(f.e(3.5,3));const endpoints=f.d().sketch.nodes.filter(n=>!n.fixed).map(n=>n.id);selectStepLine(f,2,2);f.editor.key({key:'s'});assert.match(f.message(),/^1 step/);assert.equal(f.state.wallEdits.$surfaces.length,0);const lines=f.d().sketch.edges.filter(e=>!e.fixed);assert.equal(lines.length,3);assert.ok(endpoints.every(id=>f.d().sketch.nodes.some(n=>n.id===id)));for(const edge of lines){const a=f.d().sketch.nodes.find(n=>n.id===edge.a),b=f.d().sketch.nodes.find(n=>n.id===edge.b);assert.ok(Math.abs(a.x-b.x)<1e-6||Math.abs(a.y-b.y)<1e-6);}assert.equal(f.d().faces.length,1);});
test('stepping preserves the original base and retained split points on unrelated faces',()=>{const f=stepFixture();f.state.base={faces:[{id:'floor',points:[{x:0,y:0,z:0},{x:4,y:0,z:1},{x:4,y:4,z:1},{x:0,y:4,z:0}]}]};const base=JSON.stringify(f.state.base);selectStepLine(f);f.editor.key({key:'s'});f.editor.key({key:'s'});assert.equal(JSON.stringify(f.state.base),base);assert.ok(f.state.wallEdits.$surfaces[0].retainedPoints.length>=4);});

test('face nudges follow a changed camera side without reselecting or changing step size',()=>{
 for(const labeled of [true,false]){let side=1;const f=stickerFixture('window',[2,2],{screen:p=>({x:side*p.x*100,y:-p.z*100})});if(!labeled)f.editor.featureCommand('none');
 const center=()=>B.center(f.d().faces.find(face=>labeled?face.feature:face.opening)),start=center();
 f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(center().x-start.x-.0254)<1e-7);
 side=-1;f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(center().x-start.x)<1e-7,'Right reverses world direction from the back');
 f.editor.key({key:'ArrowLeft',shiftKey:true});assert.ok(Math.abs(center().x-start.x-.1524)<1e-7);
 f.editor.key({key:'ArrowUp',altKey:true});assert.ok(Math.abs(center().y-start.y-.00635)<1e-7);
 f.editor.key({key:'ArrowDown',altKey:true});assert.ok(Math.abs(center().y-start.y)<1e-7);
 assert.equal(f.state.wallEdits.$surfaces,undefined);assert.equal(f.d().faces.length,2);
 }
});
test('selected feature edge nudges toward camera-right from either side and keeps the opposite edge fixed',()=>{
 let side=1;const f=stickerFixture('window',[2,2],{screen:p=>({x:side*p.x*100,y:p.z*100})}),F=require('../public/measure/internal/editor_scripts/wall_features.js'),bounds=()=>F.bounds(f.d().faces.find(face=>face.feature).points),initial=bounds();
 f.editor.pickSolid(f.e(initial.right,(initial.top+initial.bottom)/2));f.listeners.pointerup(f.e(initial.right,(initial.top+initial.bottom)/2));
 f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(bounds().right-initial.right-.0254)<1e-7);
 side=-1;f.editor.key({key:'ArrowRight'});assert.ok(Math.abs(bounds().right-initial.right)<1e-7);assert.equal(bounds().left,initial.left);
 assert.equal(f.d().faces.length,2);assert.equal(f.d().faces.find(face=>face.feature).feature.type,'window');
});

test('contained face M cycles four modes from one snapshot, cancels and restarts on the face',()=>{
 const f=stickerFixture(),start=JSON.stringify(f.state.wallEdits),F=require('../public/measure/internal/editor_scripts/wall_features.js'),bounds=()=>F.bounds(f.d().faces.find(f=>f.feature).points),original=bounds();
 f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);f.editor.key({key:'m'});assert.match(f.message(),/^Left\/Right/);f.editor.key({key:'m',repeat:true});assert.match(f.message(),/^Left\/Right/);
 f.listeners.pointermove(f.e(2.4,2.3));assert.ok(Math.abs(bounds().left-original.left-.4)<1e-6,f.message());assert.equal(bounds().bottom,original.bottom);assert.equal(f.state.wallEdits.$surfaces,undefined);
 f.editor.key({key:'m'});assert.match(f.message(),/^Up\/Down/);assert.equal(bounds().left,original.left);f.listeners.pointermove(f.e(2.8,2.6));assert.equal(bounds().left,original.left);assert.ok(Math.abs(bounds().bottom-original.bottom-.3)<1e-6,f.message());
 f.editor.key({key:'m'});assert.match(f.message(),/^In\/Out/);f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);f.listeners.pointermove(f.e(3.1,2.8));assert.ok(Math.abs(bounds().left-original.left-.3)<1e-6,f.message());assert.ok(Math.abs(bounds().bottom-original.bottom-.2)<1e-6);
 f.editor.key({key:'m'});assert.match(f.message(),/^Left\/Right/);assert.equal(bounds().left,original.left);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),start);f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);
});
test('contained face slide clamps fast overshoot and commits once',()=>{
 const f=stickerFixture(),before=JSON.stringify(f.state.wallEdits),history=f.history.length,nodes=f.d().sketch.nodes.filter(n=>n.fixed).map(n=>JSON.stringify(n));f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);f.editor.key({key:'m'});f.listeners.pointermove(f.e(90,2));assert.match(f.message(),/^Left\/Right/);const face=f.d().faces.find(f=>f.feature);assert.ok(Math.abs(Math.max(...face.points.map(p=>p.x))-4)<1e-6);assert.equal(f.history.length,history);
 f.editor.down(f.e(90,2));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,history+1);assert.equal(JSON.stringify(f.history.at(-1)),before);assert.ok(nodes.every(n=>f.d().sketch.nodes.some(p=>JSON.stringify(p)===n)));assert.equal(f.state.wallEdits.$surfaces,undefined);
});
test('free face move keeps moving vertically at the left bound and Escape restores it',()=>{
 const f=stickerFixture(),before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);const box=()=>{const p=f.d().faces.find(f=>f.feature).points;return {left:Math.min(...p.map(p=>p.x)),bottom:Math.min(...p.map(p=>p.y))};};f.listeners.pointermove(f.e(-90,2));const a=box();assert.ok(Math.abs(a.left)<1e-6,f.message());f.listeners.pointermove(f.e(-100,2.5));const b=box();assert.ok(Math.abs(b.left)<1e-6);assert.ok(Math.abs(b.bottom-a.bottom-.5)<1e-6,f.message());f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});
test('untyped contained faces use the same M cycle and E remains extrusion',()=>{const f=stickerFixture('window',[2,2],{screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});f.editor.featureCommand('none');f.editor.key({key:'m'});assert.match(f.message(),/^In\/Out/);f.editor.key({key:'m'});assert.match(f.message(),/^Left\/Right/);f.editor.key({key:'Escape'});f.editor.key({key:'e'});f.listeners.pointermove(f.e(2.3,2));assert.ok(f.state.wallEdits.$surfaces.length>0);assert.match(f.message(),/Extrusion/);});

test('H previews either side of a shared divider, both, then wraps without extra history',()=>{const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);f.editor.key({key:'n'});f.editor.down(f.e(2,4));f.listeners.pointerup(f.e(2,4));f.editor.doubleClick(f.e(2,2),f.w);const before=JSON.stringify(f.state.wallEdits),history=f.history.length;for(const count of [3,3,4,3]){f.editor.key({key:'h'});assert.equal(f.d().faces.length,count,f.message());}assert.equal(f.history.length,history);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);f.editor.key({key:'h'});f.editor.down(f.e(3,2));f.listeners.pointerup(f.e(3,2));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,history+1);assert.equal(f.d().faces.length,3);});
test('V previews above and below a horizontal divider, then both',()=>{const f=fixture();f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'n'});f.editor.down(f.e(4,2));f.listeners.pointerup(f.e(4,2));f.editor.doubleClick(f.e(2,2),f.w);for(const count of [3,3,4]){f.editor.key({key:'v'});assert.equal(f.d().faces.length,count,f.message());}assert.ok(f.d().sketch.nodes.some(n=>n.x===2&&n.y===0));assert.ok(f.d().sketch.nodes.some(n=>n.x===2&&n.y===4));});
test('right and middle pointer moves leave a pending wall line and camera events untouched',()=>{const f=fixture();f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'n'});const before=JSON.stringify(f.state.wallEdits);for(const buttons of [2,4]){let stopped=false;f.listeners.pointermove({...f.e(2,3),buttons,preventDefault(){stopped=true;},stopImmediatePropagation(){stopped=true;}});assert.equal(stopped,false);f.listeners.pointerup({...f.e(2,3),button:buttons===2?2:1});assert.equal(f.editor.busy(),true);assert.equal(JSON.stringify(f.state.wallEdits),before);}f.editor.down(f.e(4,2));assert.equal(f.d().faces.length,2);});

test('V from a point on an edited standalone wall uses that surface and cancels atomically',()=>{const surface={id:'moved-wall',points:[{x:0,y:2,z:0},{x:4,y:2,z:0},{x:4,y:2,z:4},{x:0,y:2,z:4}]},f=fixture({walls:[],state:{wallEdits:{$surfaces:[surface]}}}),before=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.cutFromPoint({x:2,y:2,z:0},'v'),true);assert.equal(f.state.wallEdits.$drafts['solid:moved-wall'].faces.length,2,f.message());assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);});

 test('saved lower split wall produces an extrusion cap in both directions',()=>{
 const saved=JSON.parse(fs.readFileSync('dev/fixtures/saved_extrusion.json','utf8')),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
 for(const delta of [-.5,.5]){
  const state=JSON.parse(JSON.stringify(saved)),walls=C.compose(state.walls,state),w=walls.find(w=>w.id==='R8.0:0');
  const f=fixture({state,walls,selectedId:w.id,globals:{...renderGlobals(),WallChimneys:C},screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
  const d=state.wallEdits.$drafts[w.id],r=d.faces.reduce((a,b)=>B.center(a).y<B.center(b).y?a:b),p=B.center(r);
  f.editor.beginFace(f.e(p.x,p.y),w);f.listeners.pointerup(f.e(p.x,p.y));f.listeners.pointermove(f.e(p.x,p.y));
  const before=JSON.stringify(state.wallEdits);f.editor.key({key:'e'});f.listeners.pointermove(f.e(p.x+delta,p.y));
  assert.ok(state.wallEdits.$surfaces?.length,f.message());
  f.editor.draw3D({add(){}},p=>p);
  f.editor.key({key:'escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 }
 });

test('draft rendering composes walls once per frame and refreshes the snapshot on the next frame',()=>{
 let calls=0;const w={id:'w',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:4},{x:4,y:0,z:4}]},f=fixture({globals:renderGlobals(),getWalls:()=>{calls++;return [w];}});
 f.editor.doubleClick(f.e(2,2),w);calls=0;f.editor.draw3D({add(){}},p=>p);assert.equal(calls,1);
 calls=0;f.editor.draw3D({add(){}},p=>p);assert.equal(calls,1);
});

function liveDraftFaces(d){return d.faces.filter(f=>!f.boundaryHole&&!f.solidId&&!(d.deletedFaces||[]).includes(f.points.map(p=>p.nodeId).sort().join('|'))&&!f.points.some(p=>(d.removedPoints||[]).includes(p.nodeId)));}
test('M moves a contained window out with connecting returns and Escape restores its exact opening',()=>{
 const f=stickerFixture('window',[2,2],{screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),before=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);for(let i=0;i<3;i++)f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.3,2));
 const surfaces=f.state.wallEdits.$surfaces||[];assert.ok(surfaces.length>=5,f.message());
 for(const face of surfaces)require('../public/measure/internal/editor_scripts/exterior_geometry.js').validateFace(face);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});
test('outer viewport click dispatch preserves additive Shift-selected lines',()=>{
 const wall=(id,x)=>({id,bottom:[{x,y:0,z:0},{x:x+4,y:0,z:0}],top:[{x,y:0,z:4},{x:x+4,y:0,z:4}]}),f=fixture({walls:[wall('a',0),wall('b',6)]});
 const click=(x,shift=false)=>{const e=f.e(x,0,shift);assert.equal(f.editor.startBox(e,()=>{f.editor.down(e);f.editor.finishPointer(e);}),true);f.listeners.pointerup(e);};
 click(2);click(8,true);assert.equal(f.message(),'2 lines selected');click(8,true);assert.equal(f.message(),'2 lines selected');click(8);assert.equal(f.message(),'1 lines selected');
});

 test('wheel resizes live line steps without changing count and Escape restores original geometry',()=>{const f=stepFixture();selectStepLine(f);const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'s'});f.editor.key({key:'s'});f.editor.key({key:'s'});const initial=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.stepWheel({...f.e(2,.5),ctrlKey:true,deltaY:100}),true);assert.match(f.message(),/^3 steps/);assert.notEqual(JSON.stringify(f.state.wallEdits),initial);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.editor.stepWheel({...f.e(2,.5),ctrlKey:true,deltaY:100}),false);});

test('a reselected boundary point nudges along its line repeatedly without losing the supporting face',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);const original=JSON.stringify(f.state.wallEdits);f.editor.key({key:'ArrowRight'});assert.equal(f.history.length,2,f.message());let surfaces=f.state.wallEdits.$surfaces;assert.ok(surfaces.some(s=>s.points.some(p=>Math.abs(p.x-2-.0254)<1e-6)),f.message());
 f.editor.clear();f.editor.down(f.e(2+.0254,0));f.listeners.pointerup(f.e(2+.0254,0));f.editor.key({key:'ArrowRight'});assert.equal(f.history.length,3,f.message());assert.ok(f.state.wallEdits.$surfaces.some(s=>!s.drafted&&s.points.some(p=>Math.abs(p.x-2-.0508)<1e-6)),f.message());assert.equal(JSON.stringify(f.history[1]),original);
});

test('line nudging resolves the live replacement instead of its consumed source face',()=>{const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);f.editor.key({key:'ArrowRight'});f.editor.clear();f.editor.pickSolid(f.e(4,2));f.listeners.pointerup(f.e(4,2));const before=f.history.length;f.editor.key({key:'ArrowLeft'});assert.equal(f.history.length,before+1,f.message());const d=Object.values(f.state.wallEdits.$drafts).find(d=>d.solidHost);assert.ok(d);assert.ok(d.faces[0].points.length>=4);f.editor.key({key:'ArrowLeft'});assert.equal(f.history.length,before+2,f.message());});
test('standalone line endpoints and a retained midpoint nudge without requiring face corner ownership',()=>{const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(3,1));f.listeners.pointerup(f.e(3,1));f.editor.doubleClick(f.e(2,1),f.w);f.editor.pickSolid(f.e(1.5,1));f.listeners.pointerup(f.e(1.5,1));const before=f.history.length;f.editor.key({key:'ArrowLeft'});assert.equal(f.history.length,before+1,f.message());assert.ok(f.d().sketch.nodes.some(n=>Math.abs(n.x-(1-.0254))<1e-6&&n.y===1));assert.equal(f.d().faces.length,1);});

test('chimney display conversion cannot resurrect deleted wall faces or removed load-bearing corners',()=>{const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),f=fixture({globals:{...renderGlobals(),WallChimneys:C}});f.editor.doubleClick(f.e(2,2),f.w);f.state.chimneys={items:[{id:'remote',points:[{x:20,y:20,z:5},{x:22,y:20,z:5},{x:22,y:22,z:5},{x:20,y:22,z:5}]}]};const d=f.d(),objects=[],group={add:o=>objects.push(o)},meshes=()=>objects.filter(o=>Object.hasOwn(o.material,'side'));f.editor.draw3D(group,p=>p);assert.equal(meshes().length,1);const before=JSON.stringify(f.state);d.deletedFaces=d.faces.map(f=>f.points.map(p=>p.nodeId).sort().join('|'));objects.length=0;f.editor.draw3D(group,p=>p);assert.equal(meshes().length,0,'Deleted source face must not render after clipping');d.deletedFaces=[];d.removedPoints=[d.faces[0].points[0].nodeId];objects.length=0;f.editor.draw3D(group,p=>p);assert.equal(meshes().length,0,'A removed defining corner must suppress the face');const reload=fixture({state:JSON.parse(JSON.stringify(f.state)),globals:{...renderGlobals(),WallChimneys:C}});objects.length=0;reload.editor.draw3D(group,p=>p);assert.equal(meshes().length,0);assert.notEqual(JSON.stringify(f.state),before);});

test('Q accepts a selected edited-surface point and Escape restores conversion',()=>{const f=fixture({globals:renderGlobals()});f.state.wallEdits={$surfaces:[{id:'edited',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]}]};f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(0,0));f.listeners.pointerup(f.e(0,0));const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'q'});assert.equal(f.editor.interaction(),'Draw rectangle',f.message());f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);});
test('failed Q placement keeps the tool and prevents the trailing double-click inserting a stray point',()=>{let fail=false;const f=fixture({globals:{BaseSketchGeometry:{...S,add(...args){if(fail)throw Error('Invalid test placement');return S.add(...args);}}}});f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'q'});const before=JSON.stringify(f.state.wallEdits);fail=true;f.editor.down(f.e(5,3));f.editor.down(f.e(5,3));f.editor.doubleClick(f.e(5,3),f.w);assert.equal(f.editor.interaction(),'Draw rectangle');assert.equal(JSON.stringify(f.state.wallEdits),before);fail=false;f.editor.down(f.e(3,3));f.editor.down(f.e(3,3));assert.equal(f.editor.busy(),false,f.message());assert.ok(f.d().faces.some(f=>f.opening));});
test('double-click ends a horizontal cut cycle and inserts a point into the new line',()=>{const f=fixture();f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'h'});assert.equal(f.editor.interaction(),'H/V cut');f.editor.doubleClick(f.e(2,2),f.w);assert.equal(f.editor.busy(),false,f.message());assert.ok(f.d().sketch.nodes.some(n=>Math.abs(n.x-2)<1e-6&&Math.abs(n.y-2)<1e-6));assert.equal(f.d().faces.length,2);f.editor.key({key:'q'});assert.equal(f.editor.interaction(),'Draw rectangle',f.message());});
test('sticker shortcuts convert selected stickers; plain D remains the door shortcut',()=>{const f=stickerFixture();const original=JSON.stringify(f.d().faces.find(f=>f.feature).points);for(const key of ['d','g','w']){f.editor.key({key});assert.equal(f.editor.busy(),false);const sticker=f.d().faces.find(f=>f.feature);assert.equal(sticker.feature.type,{d:'door',g:'garage',w:'window'}[key]);assert.equal(JSON.stringify(sticker.points),original);assert.equal(sticker.feature.preset,null);}f.editor.key({key:'w'});assert.ok(f.d().faces.some(f=>f.feature?.type==='window'&&f.feature.preset===0),f.message());});


test('typed face distances are positive into the base and negative out on opposite walls',()=>{
 for(const side of [-1,1]){
  const f=fixture({state:{wallEdits:{},base:{faces:[{points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4*side,z:0},{x:0,y:4*side,z:0}]}]}},screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
  f.editor.doubleClick(f.e(1,1),f.w);f.editor.key({key:'q'});f.editor.down(f.e(3,3));f.editor.down(f.e(3,3));
  f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));f.editor.key({key:'e'});
  const input=f.editor.distanceInput();assert.ok(input);input.set(.6096);
  let cap=f.state.wallEdits.$surfaces.find(s=>s.points.every(p=>Math.abs(p.y-side*.6096)<1e-7));assert.ok(cap,f.message());assert.equal(f.editor.distanceInput().amount,.6096);
  input.set(-.6096);cap=f.state.wallEdits.$surfaces.find(s=>s.points.every(p=>Math.abs(p.y+side*.6096)<1e-7));assert.ok(cap,f.message());assert.equal(f.editor.distanceInput().amount,-.6096);
 }
});

test('inserting a point after extrusion does not resurrect the consumed source face',()=>{
 const f=fixture({screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'h'});f.editor.down(f.e(2,2));
 f.editor.down(f.e(2,1));f.listeners.pointerup(f.e(2,1));f.listeners.pointermove(f.e(2,1));f.editor.key({key:'e'});f.editor.distanceInput().set(.5);f.editor.down(f.e(2,1));
 const consumed=f.d().faces.find(r=>r.solidId);assert.ok(consumed);const solidId=consumed.solidId,cap=JSON.stringify(f.state.wallEdits.$surfaces);
 f.editor.doubleClick(f.e(2,4),f.w);
 assert.ok(f.d().faces.some(r=>r.solidId===solidId),'Point insertion resurrected the original face');assert.equal(JSON.stringify(f.state.wallEdits.$surfaces),cap);
 f.editor.doubleClick(f.e(2,2),f.w);
 assert.ok(f.d().faces.some(r=>r.solidId===solidId),'Splitting the shared edge resurrected the original face');
});

test('V then H keeps the first cut and starts horizontal from the same point',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,2),f.w);f.editor.key({key:'v'});const vertical=JSON.stringify(f.state.wallEdits),history=f.history.length;
 f.editor.key({key:'h'});assert.match(f.message(),/Horizontal cut/);assert.equal(f.editor.interaction(),'H/V cut');assert.equal(f.history.length,history+1);assert.notEqual(JSON.stringify(f.state.wallEdits),vertical);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),vertical);
});
test('first face click after H both commits the cut and selects the face for extrusion',()=>{
 const f=fixture();f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'h'});f.editor.down(f.e(2,3));f.listeners.pointerup(f.e(2,3));assert.equal(f.editor.busy(),false);
 f.listeners.pointermove(f.e(2,3));f.editor.key({key:'e'});assert.equal(f.editor.interaction(),'Extrude face',f.message());
});

test('material paint persists on individual split faces and survives point insertion and undo',()=>{
 let f;f=fixture({globals:{ExteriorMaterials:{siding:{label:'Siding'},brick:{label:'Brick'}}},featureHost:()=>{const d=f.state.wallEdits.$drafts?.w;if(!d)return null;return {d,f:d.faces.find(r=>r.points.every(p=>p.y>=2)),points:[]};}});
 f.editor.doubleClick(f.e(0,2),f.w);f.editor.key({key:'h'});f.editor.finishAxisCut();const before=JSON.stringify(f.state.wallEdits);f.editor.materialCommand('brick');f.editor.down(f.e(2,3));assert.equal(f.editor.interaction(),'Paint material');assert.equal(f.d().faces.filter(r=>r.material==='brick').length,1);f.editor.key({key:'Escape'});f.editor.doubleClick(f.e(2,4),f.w);assert.equal(f.d().faces.filter(r=>r.material==='brick').length,1);assert.equal(f.d().faces.filter(r=>!r.material).length,1);assert.equal(f.history[f.history.length-2].$drafts.w.faces.some(r=>r.material),false);
});


test('V splits an overhanging triangular tip without leaving the unsplit solid over it',()=>{
 const p=(x,z)=>({x,y:0,z}),surface={id:'overhang',material:'brick',points:[p(0,2),p(4,4),p(4,0),p(1,0),p(1,2)]};
 const f=fixture({state:{wallEdits:{$surfaces:[surface]}},walls:[],selected:null,globals:renderGlobals()});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));
 const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'v'});
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js');
 const check=()=>{const faces=M.collect(f.state);assert.equal(faces.length,2,'The old solid must be replaced by the two cut regions');assert.ok(faces.some(f=>f.points.length===3));assert.ok(faces.every(f=>f.material==='brick'));assert.ok(f.state.wallEdits.$surfaces[0].drafted);};
 check();f.editor.key({key:'v'});check();f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.editor.cutFromPoint(p(1,2),'v');f.editor.finishAxisCut();check();assert.equal(JSON.stringify(f.history.at(-1)),before);
});


test('box-selected shared corner counts once and V works across near-coincident surface records',()=>{
 const p=(x,z,y=0)=>({x,y,z}),f=fixture({selected:null,walls:[],state:{wallEdits:{$surfaces:[
  {id:'overhang',points:[p(0,2),p(4,4),p(4,0),p(1,0),p(1,2)]},
  {id:'return',points:[p(1.0000006,2),p(1.0000006,0),p(1.0000006,0,1),p(1.0000006,2,1)]}
 ]}},screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.startBox(f.e(.9,1.9));f.listeners.pointermove(f.e(1.1,2.1));f.listeners.pointerup(f.e(1.1,2.1));
 assert.equal(f.message(),'1 point selected');const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'v'});
 assert.equal(f.editor.interaction(),'H/V cut',f.message());assert.ok(f.state.wallEdits.$drafts['solid:overhang'].faces.some(r=>r.points.length===3));
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('marquee points overlapping on screen at different depths remain distinct for H/V',()=>{
 const p=(x,z,y)=>({x,y,z}),f=fixture({selected:null,walls:[],state:{wallEdits:{$surfaces:[0,1].map(y=>({id:'wall-'+y,points:[p(0,0,y),p(4,0,y),p(4,4,y),p(0,4,y)]}))}}});
 f.editor.startBox(f.e(-.1,-.1));f.listeners.pointermove(f.e(.1,.1));f.listeners.pointerup(f.e(.1,.1));
 assert.equal(f.message(),'2 points selected');const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'v'});
 assert.match(f.message(),/No vertical cuts fit/);assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('H from the top of a vertical edge splits a shallow sloped wall into two faces',()=>{
 const p=(x,z)=>({x,y:0,z}),f=fixture({walls:[],selected:null,globals:renderGlobals(),state:{wallEdits:{$surfaces:[{id:'shallow',points:[p(0,0),p(4,0),p(4,2.004),p(0,2)]}]}}});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(0,2));f.listeners.pointerup(f.e(0,2));const before=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'h'});assert.equal(f.editor.interaction(),'H/V cut',f.message());
 const faces=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state);assert.equal(faces.length,2);assert.ok(faces.some(f=>f.points.length===3));
 const triangle=faces.find(f=>f.points.length===3);assert.ok(triangle.points.some(p=>Math.abs(p.x-4)<1e-8&&Math.abs(p.z-2)<1e-8));
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('point extrusion snaps to remote heights, F disables snapping, and typed distances win',()=>{
 const f=fixture({globals:{isFreeMove:false},state:{wallEdits:{},roof:{points:[{x:20,y:20,z:2}]}}});
 const e=f.e(0,2.06);f.editor.beginEntity('extrude',{point:{x:0,y:0,z:4},event:e});
 assert.match(f.message(),/Height snap/);assert.equal(f.editor.distanceInput().amount,2);
 f.editor.key({key:'f'});assert.ok(Math.abs(f.editor.distanceInput().amount-1.94)<1e-8);assert.doesNotMatch(f.message(),/snap/);
 f.editor.key({key:'f'});assert.equal(f.editor.distanceInput().amount,2);
 f.listeners.pointermove(e);f.editor.distanceInput().set(1.97);assert.equal(f.editor.distanceInput().amount,1.97);assert.doesNotMatch(f.message(),/snap/);
 f.editor.distanceInput().set(null);assert.equal(f.editor.distanceInput().amount,2);
 f.editor.down(e);const d=f.state.wallEdits.$drafts.w;assert.ok(d.sketch.nodes.some(p=>p.x===0&&p.y===2));
});

test('line extrusion already supports remote height snapping and F toggles it during the gesture',()=>{
 const f=fixture({globals:{isFreeMove:false},state:{wallEdits:{},roof:{points:[{x:20,y:20,z:2}]}}}),e=f.e(2,2.06);
 f.editor.beginEntity('extrude',{pair:[{x:0,y:0,z:0},{x:4,y:0,z:0}],event:e});
 assert.match(f.message(),/Height snap/);assert.equal(f.editor.distanceInput().amount,2);
 f.editor.key({key:'f'});assert.ok(Math.abs(f.editor.distanceInput().amount-2.06)<1e-8);
 f.editor.key({key:'f'});assert.equal(f.editor.distanceInput().amount,2);
 f.listeners.pointermove(e);f.editor.distanceInput().set(2.03);assert.equal(f.editor.distanceInput().amount,2.03);
});


test('H ignores stale retained anchors on an adjoining extruded face without losing valid anchors',()=>{
 const p=(x,y,z)=>({x,y,z}),f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:[
  {id:'shallow',points:[p(0,0,0),p(4,0,0),p(4,0,2.032),p(0,0,2)]},
  {id:'return',points:[p(0,0,0),p(0,1,0),p(0,1,2),p(0,0,2)],retainedPoints:[p(0,.5,2.2),p(.2,.5,1),p(0,.5,1)]}
 ]}}});
 const before=JSON.stringify(f.state.wallEdits);f.editor.cutFromPoint(p(0,0,2),'h');assert.equal(f.editor.interaction(),'H/V cut',f.message());
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),d=f.state.wallEdits.$drafts['solid:return'],anchors=d.sketch.nodes.map(p=>W.fromFrame(d.frame,p));
 assert.ok(anchors.some(p=>Math.abs(p.y-.5)<1e-7&&Math.abs(p.z-1)<1e-7));assert.ok(anchors.every(p=>p.z<=2&&Math.abs(p.x)<1e-7));
 assert.equal(f.state.wallEdits.$drafts['solid:shallow'].faces.length,2);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});
test('face E follows the roof continuously with typed distances, cancels exactly, and commits the trimmed result',()=>{
 const p=(x,y,z)=>({x,y,z}),face={id:'roof-wall',material:'brick',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(0,0,3)]},roof={faces:[{points:[p(-1,1,4),p(5,1,4),p(5,-2,1),p(-1,-2,1)]}],points:[],connections:[]},state={wallEdits:{$surfaces:[face]}},before=JSON.stringify(state.wallEdits),f=fixture({state,roof,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 const start=()=>{f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(2,1.5));f.listeners.pointerup(f.e(2,1.5));f.listeners.pointermove(f.e(2,1.5));f.editor.key({key:'e'});assert.ok(f.editor.distanceInput(),f.message());};
 start();f.editor.distanceInput().set(-1);let cap=state.wallEdits.$surfaces.find(f=>f.id==='roof-wall');assert.ok(cap.points.every(p=>Math.abs(p.y+1)<1e-5));assert.ok(Math.abs(Math.max(...cap.points.map(p=>p.z))-2)<1e-5,f.message());f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 start();f.editor.distanceInput().set(-1);f.editor.down(f.e(1,1));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);f.editor.clear();f.editor.draw3D({add(){}},p=>p);assert.ok(state.wallEdits.$surfaces.some(f=>f.id==='roof-wall'&&!f.deleted&&f.points.every(p=>p.z<=2+1e-5)));
});
test('freehand E snaps a thin strip to the roof edge even when its cap tapers away',()=>{
 const p=(x,y,z)=>({x,y,z}),face={id:'roof-strip',points:[p(0,0,2),p(4,0,2),p(4,0,3),p(0,0,3)]},roof={faces:[{points:[p(-1,1,4),p(5,1,4),p(5,-1,2),p(-1,-1,2)]}],points:[p(-1,-1,2),p(5,-1,2)],connections:[{startIdx:0,endIdx:1}]},state={wallEdits:{$surfaces:[face]}},f=fixture({state,roof,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.3,2.4));f.listeners.pointerup(f.e(1.3,2.4));f.listeners.pointermove(f.e(1.3,2.4));f.editor.key({key:'e'});f.listeners.pointermove(f.e(.35,2.4));assert.match(f.message(),/Roof edge snap/);assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='roof-strip').deleted);assert.ok(!state.wallEdits.$surfaces.some(f=>f.roofContact&&!f.deleted));f.editor.down(f.e(.35,2.4));assert.equal(f.history.length,1);
});
function chamferCube(){const p=(x,y,z)=>({x,y,z}),a=p(0,0,0),b=p(4,0,0),c=p(4,4,0),d=p(0,4,0),e=p(0,0,4),f=p(4,0,4),g=p(4,4,4),h=p(0,4,4);return {a,b,c,d,e,f,g,h,faces:[[a,b,f,e],[b,c,g,f],[c,d,h,g],[d,a,e,h],[a,d,c,b],[e,f,g,h]].map((points,i)=>({id:'cube-'+i,points}))};}
test('chamfer preview supports fine wheel angles, typed depth, commit, and exact cancellation',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()}),before=JSON.stringify(state.wallEdits);
 f.editor.chamferCommand({edges:[[c.a,c.e],[c.a,c.b]],event:f.e(1,1)});assert.equal(f.editor.interaction(),'Chamfer',f.message());f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$surfaces.some(f=>f.chamfer));f.editor.stepWheel({...f.e(1,1),ctrlKey:true,deltaY:-100,deltaMode:0});assert.match(f.message(),/46.0° \/ 44.0°/);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.chamferCommand({points:[c.a],event:f.e(1,1)});f.editor.distanceInput().set(.2);f.editor.stepWheel({...f.e(1,1),ctrlKey:true,deltaY:-100,deltaMode:0});const tilted=JSON.stringify(state.wallEdits);f.listeners.pointermove(f.e(1.5,1));assert.notEqual(JSON.stringify(state.wallEdits),tilted);f.editor.down(f.e(1.5,1));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});
test('wall corner chamfer updates its attached foundation without leaving old sketch anchors',()=>{
 const c=chamferCube(),baseFace={...c.faces[4],id:'base'},state={base:{faces:[baseFace]},wallEdits:{$surfaces:c.faces.filter((_,i)=>i!==4)}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()});
 f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)});f.editor.distanceInput().set(.2);assert.equal(state.wallEdits.$base.faces[0].points.length,5,f.message());assert.ok(!state.wallEdits.$base.sketch.nodes.some(p=>Math.hypot(p.x,p.y)<1e-5));
});
test('switching an unconfirmed face move to E records the move before opening a fresh extrusion',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),before=JSON.stringify(state.wallEdits);
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.2,1.3));f.listeners.pointerup(f.e(1.2,1.3));f.listeners.pointermove(f.e(1.2,1.3));f.editor.key({key:'m'});f.editor.distanceInput().set(.2);const moved=JSON.stringify(state.wallEdits);assert.notEqual(moved,before);f.editor.key({key:'e'});assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(f.editor.interaction(),'Extrude face');f.editor.distanceInput().set(.1);f.editor.down(f.e(1.2,1.3));assert.equal(f.history.length,2);assert.equal(JSON.stringify(f.history[1]),moved);
});
test('switching a chamfer to a face move commits once and cancelling the move preserves the chamfer',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)});f.editor.distanceInput().set(.2);const bevel=JSON.stringify(state.wallEdits);f.editor.key({key:'m'});assert.equal(f.history.length,1);assert.equal(f.editor.interaction(),'Move face',f.message());f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),bevel);
});

test('extruded interior regions do not split selection of an untouched outside edge',()=>{
 const highlighted=[],f=fixture({globals:{...renderGlobals(),wallSelectedLine:(group,vector,pair)=>highlighted.push(pair)}});
 f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}
 f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,1.5));f.editor.down(f.e(2,1.5));f.listeners.pointerup(f.e(2,1.5));
 for(const z of [.5,2,3.5]){assert.equal(f.editor.pickLine3D(f.e(0,z)),true);f.listeners.pointerup(f.e(0,z));highlighted.length=0;f.editor.draw3D({add(o){if(o.renderOrder===1000)highlighted.push(o.geometry.points);}},p=>p);assert.equal(highlighted.length,1);assert.deepEqual(Array.from(highlighted[0],p=>p.z).sort((a,b)=>a-b),[0,4]);}
});

test('oversized chamfer stays live, commits fitted geometry, and cancels exactly',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()}),before=JSON.stringify(state.wallEdits);
 f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)});f.editor.distanceInput().set(50);assert.match(f.message(),/limit reached/);assert.ok(state.wallEdits.$surfaces.some(f=>f.chamfer));const fitted=JSON.stringify(state.wallEdits);
 f.editor.distanceInput().set(.1);assert.doesNotMatch(f.message(),/limit reached/);assert.notEqual(JSON.stringify(state.wallEdits),fitted);
 f.editor.distanceInput().set(50);assert.equal(JSON.stringify(state.wallEdits),fitted);assert.equal(f.editor.finishToolForSwitch(),true);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 const second=fixture({state:{wallEdits:{$surfaces:c.faces}},walls:[],selected:null,globals:renderGlobals()});const original=JSON.stringify(second.state.wallEdits);second.editor.chamferCommand({edges:[[c.a,c.e]],event:second.e(1,1)});second.editor.distanceInput().set(50);second.editor.key({key:'Escape'});assert.equal(JSON.stringify(second.state.wallEdits),original);assert.equal(second.history.length,0);
});

test('horizontal base chamfer removes the old three-way endpoints from faces and base sketch',()=>{
 const c=chamferCube(),baseFace={...c.faces[4],id:'base'},state={base:{faces:[baseFace]},wallEdits:{$surfaces:c.faces.filter((_,i)=>i!==4)}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()});
 f.editor.chamferCommand({edges:[[c.a,c.b]],event:f.e(1,1)});f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$base,f.message());
 const points=[...state.wallEdits.$surfaces.flatMap(f=>[...f.points,...(f.retainedPoints||[])]),...state.wallEdits.$base.faces.flatMap(f=>f.points),...state.wallEdits.$base.sketch.nodes];for(const end of [c.a,c.b])assert.ok(!points.some(p=>Math.hypot(p.x-end.x,p.y-end.y,p.z-end.z)<1e-5),'Old end corner remains');
});

test('every saved-house boundary line enters the actual chamfer tool and yields a preview',()=>{
 const faces=require('./fixtures/chamfer-house.json').faces,edges=new Map();for(const face of faces)for(const ring of [face.points,...(face.holes||[])])for(let i=0;i<ring.length;i++)edges.set([ring[i],ring[(i+1)%ring.length]].map(p=>[p.x,p.y,p.z].map(v=>v.toFixed(5)).join(',')).sort().join('|'),[ring[i],ring[(i+1)%ring.length]]);
 for(const edge of edges.values()){const state={wallEdits:{$surfaces:JSON.parse(JSON.stringify(faces)).map(f=>({...f,draft:false}))}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()});f.editor.chamferCommand({edges:[edge],event:f.e(1,1)});assert.equal(f.editor.interaction(),'Chamfer',f.message());f.editor.distanceInput().set(.05);assert.ok(state.wallEdits.$surfaces.some(f=>f.chamfer),f.message());assert.doesNotMatch(f.message(),/rejected|exactly two|Construction/);f.editor.key({key:'Escape'});}
});

test('cyan base sketch lines are pickable through the shared 3D line picker in point mode',()=>{
 const base={faces:[{id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]}]},a=S.add(base,{x:0,y:2,z:0}),b=S.add(base,{x:4,y:2,z:0});S.connect(base,[a,b]);const calls=[],f=fixture({state:{base,wallEdits:{}},walls:[],selected:null,screen:p=>({x:p.x*100,y:p.y*100}),selectBaseEntities:(ps,pairs,add)=>calls.push({ps,pairs,add})});
 for(const shift of [false,true]){assert.equal(f.editor.pickLine3D(f.e(2,2,shift)),true);f.listeners.pointerup(f.e(2,2,shift));assert.equal(calls.at(-1).add,shift);const pair=calls.at(-1).pairs[0];assert.ok(pair.every(p=>p.y===2&&p.z===0));assert.deepEqual(Array.from(pair,p=>p.x).sort(),[0,4]);}
 base.visible=false;assert.equal(f.editor.pickLine3D(f.e(2,2)),false);
});

test('chamfer binds a wall bottom and nearly coincident foundation boundary as one edge',()=>{
 const c=chamferCube(),base={faces:[{...c.faces[4],id:'base',points:c.faces[4].points.map(p=>({...p,z:p.z-.0005}))}]},state={base,wallEdits:{$surfaces:c.faces.filter((_,i)=>i!==4)}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()}),before=JSON.stringify(state);
 f.editor.chamferCommand({edges:[[c.a,c.b]],event:f.e(1,1)});f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$base,f.message());
 const points=[...state.wallEdits.$surfaces.flatMap(f=>f.points),...state.wallEdits.$base.sketch.nodes];assert.ok(!points.some(p=>Math.abs(p.y)<1e-5&&Math.abs(p.z)<.002),'Old wall or base baseline survived');
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state),before);
});

test('fresh generated wall corner is clickable without a face ray or an existing draft',()=>{
 const f=fixture({selected:null});
 assert.equal(f.editor.pickVisiblePoint(f.e(0,4)),true);f.listeners.pointerup(f.e(0,4));
 assert.equal(f.message(),'1 point selected');assert.ok(f.d());
 assert.equal(f.d().sketch.nodes.filter(n=>n.x===0&&n.y===4).length,1);
});
test('base marquee reads actual shared nodes without projecting them onto another overlapping plane',()=>{
 const p=(x,y,z)=>({x,y,z}),base={faces:[{id:'slope',points:[p(0,0,0),p(4,0,0),p(4,4,4),p(0,4,4)]},{id:'upper',points:[p(0,0,2),p(4,0,2),p(4,4,2),p(0,4,2)]}]};
 S.ensure(base);const before=JSON.stringify(base);
 const f=fixture({selected:null,walls:[],state:{base,wallEdits:{}},screen:p=>({x:p.x*100,y:p.z*100})});
 f.editor.startBox(f.e(-.1,1.9));f.listeners.pointermove(f.e(.1,2.1));f.listeners.pointerup(f.e(.1,2.1));
 assert.equal(f.message(),'2 points selected');assert.equal(JSON.stringify(base),before);
});

test('chamfer trims both generated wall owners despite plane-fit rounding and removes the original corner',()=>{
 const c=require('./fixtures/base-rebuild-chimney.json'),base=B.fromRoof(c.roof,c.ground,c.walls),walls=G.mergeCoplanar(c.walls).walls;
 const f=fixture({walls,selected:null,state:{base,roof:c.roof,wallEdits:{}}}),w=walls.find(w=>w.id==='R1.0:0'),pair=[w.bottom[0],w.top[0]],before=JSON.stringify(f.state.wallEdits);
 f.editor.chamferCommand({pair,event:f.e(0,0)});f.editor.distanceInput().set(1.1);
 const edits=f.state.wallEdits;
 for(const id of ['R1.0:0','R2.0:0']){const d=Object.values(edits.$drafts).find(d=>d.members.includes(id));assert.ok(d.faces.every(r=>r.solidId),'both original regions must be consumed');}
 const points=[...edits.$surfaces.flatMap(r=>[...r.points,...(r.retainedPoints||[])]),...edits.$base.faces.flatMap(r=>r.points)];
 for(const old of pair)assert.ok(points.every(p=>Math.hypot(p.x-old.x,p.y-old.y,p.z-old.z)>.001),'original corner must not survive as surface or retained point');
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('generated roof corner point chamfer consumes the old walls and removes retained corner connections',()=>{
 const c=require('./fixtures/base-rebuild-chimney.json'),base=B.fromRoof(c.roof,c.ground,c.walls),walls=G.mergeCoplanar(c.walls).walls,f=fixture({walls,selected:null,state:{base,roof:c.roof,wallEdits:{}}}),point=walls.find(w=>w.id==='R1.0:0').top[0],before=JSON.stringify(f.state.wallEdits);
 f.editor.chamferCommand({point,event:f.e(0,0)});assert.ok(f.editor.distanceInput(),f.message());f.editor.distanceInput().set(.5);
 const edits=f.state.wallEdits;assert.ok(edits.$surfaces.some(f=>f.chamfer));
 for(const id of ['R1.0:0','R2.0:0'])assert.ok(Object.values(edits.$drafts).find(d=>d.members.includes(id)).faces.every(f=>f.solidId),'original owner consumed');
 for(const f of edits.$surfaces)for(const p of [...f.points,...(f.retainedPoints||[])])assert.ok(Math.hypot(p.x-point.x,p.y-point.y,p.z-point.z)>.001,'old corner removed');
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('manual bulk merge consumes original face records and is one undo transaction',()=>{
 const p=(x,z)=>({x,y:0,z}),state={wallEdits:{$surfaces:[{id:'a',points:[p(0,0),p(1,0),p(1,2),p(0,2)]},{id:'b',points:[p(1,0),p(2,0),p(2,2),p(1,2)]}]}},before=JSON.stringify(state.wallEdits),f=fixture({state,walls:[],selected:null});
 assert.equal(f.editor.mergeAll(),true,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(state.wallEdits.$surfaces.length,1);assert.equal(f.editor.mergeAll(),false);assert.equal(f.history.length,1);
});

test('geometry clipboard previews, cycles mounts, cancels exactly and places in one undo transaction',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},side={id:'side',points:[p(0,-5,-5),p(0,5,-5),p(0,5,5),p(0,-5,5)]},cap={id:'cap',points:[p(0,0,0),p(1,0,0),p(1,1,1),p(0,1,1)],material:'brick'},state={wallEdits:{$surfaces:[back,side,cap]}},f=fixture({state,walls:[],selected:null,featureHost:()=>({solid:back,points:back.points})}),before=JSON.stringify(state.wallEdits);
 f.editor.clipboardCommand('copy',{points:cap.points});assert.match(f.message(),/1 faces/);assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));assert.match(f.message(),/Mount 1 \/ 2/);f.editor.stepWheel({...f.e(2,2),ctrlKey:true,deltaY:120});assert.match(f.message(),/Mount 2 \/ 2/);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));f.editor.down(f.e(2,2));assert.equal(f.editor.interaction(),null,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.ok(state.wallEdits.$surfaces.some(f=>f.id.startsWith('paste-')&&f.material==='brick'));
});


test('double-click opens the interior of a pasted surface for point editing in one undo item',()=>{
 const p=(x,z)=>({x,y:0,z}),surface={id:'paste-123-0',material:'brick',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},state={wallEdits:{$surfaces:[surface]}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()});
 f.editor.draw3D({add(){}},p=>p);
 for(let i=0;i<2;i++){f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));}
 const before=JSON.stringify(state.wallEdits);
 assert.equal(f.editor.doubleClick(f.e(1,2)),true,f.message());
 const d=state.wallEdits.$drafts['solid:'+surface.id];
 assert.ok(d,'pasted face must become editable');
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
 assert.ok(d.sketch.nodes.some(n=>{const q=W.fromFrame(d.frame,n);return Math.hypot(q.x-1,q.y,q.z-2)<1e-6&&n.userDraftPoint;}));
 assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(d.faces[0].material,'brick');assert.equal(f.editor.busy(),false);
});

test('double-click switches from an old surface plane to the wall under the cursor',()=>{
 const p=(x,z)=>({x,y:0,z}),surface={id:'paste-old',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},state={wallEdits:{$surfaces:[surface]}};
 let target={solid:surface,points:surface.points};const f=fixture({state,featureHost:()=>target});
 assert.equal(f.editor.doubleClick(f.e(1,2)),true);
 const old=JSON.stringify(state.wallEdits.$drafts['solid:paste-old']);target=null;
 assert.equal(f.editor.doubleClick(f.e(3,2),f.w),true,f.message());
 assert.ok(f.d().sketch.nodes.some(n=>n.userDraftPoint&&n.x===3&&n.y===2));
 assert.equal(JSON.stringify(state.wallEdits.$drafts['solid:paste-old']),old);
});


test('complex geometry move rotate flip share one cancellable session and one commit',()=>{
 const points=[{x:1,y:0,z:1},{x:3,y:0,z:1},{x:3,y:0,z:2},{x:1,y:0,z:2}],surface={id:'piece',points,material:'brick'},state={wallEdits:{$surfaces:[surface]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(1,1));assert.ok(f.editor.geometryCommand('m',{points}));f.listeners.pointermove(f.e(2,2));
 const moved=JSON.stringify(state.wallEdits.$surfaces);assert.notEqual(moved,JSON.stringify([surface]));assert.equal(f.history.length,0);
 f.editor.key({key:'r'});assert.equal(JSON.stringify(state.wallEdits.$surfaces),moved,'switch must retain moved position');f.listeners.pointermove(f.e(4,2));
 const rotated=JSON.stringify(state.wallEdits.$surfaces);assert.notEqual(rotated,moved);f.editor.key({key:'t'});assert.equal(f.history.length,0);f.editor.key({key:'v'});f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.geometryCommand('m',{points});f.listeners.pointermove(f.e(5,2));f.editor.key({key:'r'});f.listeners.pointermove(f.e(5,3));f.editor.down(f.e(5,3));assert.equal(f.history.length,1,f.message());assert.equal(JSON.stringify(f.history[0]),before);assert.equal(state.wallEdits.$surfaces.length,1);assert.equal(f.editor.busy(),false);
});

test('rotating a paste freezes its destination and switching to move preserves orientation until placement',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-10,0,-10),p(10,0,-10),p(10,0,10),p(-10,0,10)]},cap={id:'cap',points:[p(0,0,0),p(2,0,0),p(2,1,1),p(0,1,1)],material:'brick'},state={wallEdits:{$surfaces:[back,cap]}},f=fixture({state,walls:[],selected:null,featureHost:()=>({solid:back,points:back.points})}),before=JSON.stringify(state.wallEdits);
 f.editor.clipboardCommand('copy',{points:cap.points});f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));f.editor.key({key:'r'});f.listeners.pointermove(f.e(4,3));f.editor.key({key:'t'});f.editor.key({key:'v'});f.editor.key({key:'m'});f.listeners.pointermove(f.e(3,3));assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));f.editor.key({key:'r'});f.listeners.pointermove(f.e(4,3));f.editor.down(f.e(4,3));assert.equal(f.history.length,1,f.message());const pasted=state.wallEdits.$surfaces.find(f=>f.id.startsWith('paste-'));assert.ok(pasted);assert.equal(pasted.material,'brick');
 const center=pasted.points.reduce((a,p)=>({x:a.x+p.x/4,z:a.z+p.z/4}),{x:0,z:0});assert.ok(Math.abs(center.x-2)<1e-6,'rotation must not chase the cursor onto a different location');assert.ok(Math.abs(center.z-2.5)<1e-6);
});


test('repeating M and R cycles candidate planes without moving geometry or creating history',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},side={id:'side',points:[p(0,-5,-5),p(0,5,-5),p(0,5,5),p(0,-5,5)]},cap={id:'cap',points:[p(0,0,0),p(1,0,0),p(1,1,1),p(0,1,1)]},state={wallEdits:{$surfaces:[back,side,cap]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(2,2));f.editor.geometryCommand('m',{points:cap.points});assert.match(f.message(),/Plane 1 \/ 2/);f.editor.key({key:'m'});assert.match(f.message(),/Plane 2 \/ 2/);assert.equal(JSON.stringify(state.wallEdits),before);f.editor.key({key:'r'});f.editor.key({key:'r'});assert.match(f.message(),/Plane 1 \/ 2/);assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);f.editor.key({key:'Escape'});
});

test('marquee point selection starts the new plane move through the M shortcut',()=>{
 const p=(x,z)=>({x,y:0,z}),surface={id:'piece',points:[p(1,1),p(3,1),p(3,2),p(1,2)]},state={wallEdits:{$surfaces:[surface]}},f=fixture({state,walls:[],selected:null});
 f.editor.startBox(f.e(.5,.5));f.listeners.pointermove(f.e(3.5,2.5));f.listeners.pointerup(f.e(3.5,2.5));assert.match(f.message(),/4 points selected/);f.editor.key({key:'m'});assert.equal(f.editor.interaction(),'Transform geometry');f.listeners.pointermove(f.e(4.5,2.5));assert.ok(state.wallEdits.$surfaces[0].points.some(p=>p.x>3));f.editor.down(f.e(4.5,2.5));assert.equal(f.history.length,1);
});

test('paste rotate to move switch can commit immediately without jumping to the rotation cursor',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-10,0,-10),p(10,0,-10),p(10,0,10),p(-10,0,10)]},cap={id:'cap',points:[p(0,0,0),p(2,0,0),p(2,1,1),p(0,1,1)]},state={wallEdits:{$surfaces:[back,cap]}},f=fixture({state,walls:[],selected:null,featureHost:()=>({solid:back,points:back.points})});
 f.editor.clipboardCommand('copy',{points:cap.points});f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));f.editor.key({key:'r'});f.listeners.pointermove(f.e(6,4));f.editor.key({key:'m'});f.editor.down(f.e(6,4));const result=state.wallEdits.$surfaces.find(f=>f.id.startsWith('paste-'));assert.ok(result,f.message());assert.ok(Math.abs(result.points.reduce((s,p)=>s+p.x/4,0)-2)<1e-6);assert.equal(f.history.length,1);
});


test('shared line move locks both drag directions to one face and M cycles without committing',()=>{
 const p=(x,y,z)=>({x,y,z}),a=p(0,0,0),b=p(4,0,0),upper={id:'upper',points:[a,b,p(4,0,4),p(0,0,4)]},lower={id:'lower',points:[b,a,p(0,3,-3),p(4,3,-3)]},state={wallEdits:{$surfaces:[upper,lower]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true}}),before=JSON.stringify(state.wallEdits);
 f.editor.beginEntity('move',{pair:[a,b],event:f.e(1,0)});assert.equal(f.editor.interaction(),'Move line');assert.match(f.message(),/Face 1 \/ 2/);
 f.listeners.pointermove(f.e(1,.5));let top=state.wallEdits.$surfaces.find(f=>f.id==='upper');assert.ok(top.points.slice(0,2).every(p=>Math.abs(p.y)<1e-8&&p.z>.1));
 f.listeners.pointermove(f.e(1,-.5));top=state.wallEdits.$surfaces.find(f=>f.id==='upper');assert.ok(top.points.slice(0,2).every(p=>Math.abs(p.y)<1e-8&&p.z<-.1),'negative motion must remain on upper face plane');
 const moved=JSON.stringify(state.wallEdits);f.editor.key({key:'m'});assert.match(f.message(),/Face 2 \/ 2/);assert.notEqual(JSON.stringify(state.wallEdits),moved,'cycling must recompute from the original edge');assert.equal(f.history.length,0);
 f.listeners.pointermove(f.e(1,-.8));top=state.wallEdits.$surfaces.find(f=>f.id==='upper');assert.ok(top.points.slice(0,2).some(p=>Math.abs(p.y)>.05),'second face allows motion in its sloping plane');
 f.editor.key({key:'m'});assert.match(f.message(),/Face 1 \/ 2/);f.listeners.pointermove(f.e(1,-1));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.beginEntity('move',{pair:[a,b],event:f.e(1,0)});f.listeners.pointermove(f.e(1,.5));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1,.8));f.editor.down(f.e(1,.8));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

test('multiple segments of one shared border use face cycling rather than complex geometry movement',()=>{
 const p=(x,y,z)=>({x,y,z}),a=p(0,0,0),mid=p(2,0,0),b=p(4,0,0),state={wallEdits:{$surfaces:[{id:'up',points:[a,mid,b,p(4,0,4),p(0,0,4)]},{id:'down',points:[b,mid,a,p(0,3,-3),p(4,3,-3)]}]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true},screen:p=>({x:p.x*100,y:p.y*100+p.z*100})});
 f.editor.pickLine3D(f.e(1,0));f.listeners.pointerup(f.e(1,0));f.editor.pickLine3D(f.e(3,0,true));f.listeners.pointerup(f.e(3,0,true));f.listeners.pointermove(f.e(3,0));f.editor.key({key:'m'});assert.equal(f.editor.interaction(),'Move line');f.listeners.pointermove(f.e(3,.5));assert.ok(state.wallEdits.$surfaces[0].points.slice(0,3).every(p=>Math.abs(p.z-.5)<1e-8),f.message()+' '+JSON.stringify(state.wallEdits.$surfaces[0].points));f.editor.key({key:'m'});assert.match(f.message(),/Face 2 \/ 2/);f.editor.down(f.e(3,.5));assert.equal(f.history.length,1);
});


test('resize starts on all axes, accumulates axis changes, and wheel options require Control',()=>{
 const p=(x,y,z)=>({x,y,z}),points=[p(0,0,0),p(2,0,0),p(2,1,2),p(0,1,2)],state={wallEdits:{$surfaces:[{id:'piece',points}]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true}}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(3,3));f.editor.geometryCommand('y',{points});assert.match(f.message(),/Resize ALL/);f.listeners.pointermove(f.e(3+Math.log(2)*1.6,3));let shape=state.wallEdits.$surfaces[0].points;const width=()=>Math.max(...shape.map(p=>p.x))-Math.min(...shape.map(p=>p.x));assert.ok(Math.abs(width()-4)<1e-8);
 const all=JSON.stringify(state.wallEdits);assert.equal(f.editor.stepWheel({...f.e(4,3),deltaY:100}),false);assert.equal(JSON.stringify(state.wallEdits),all);
 assert.equal(f.editor.stepWheel({...f.e(4,3),ctrlKey:true,deltaY:100}),true);assert.match(f.message(),/Resize X/);f.editor.stepWheel({...f.e(4,3),ctrlKey:true,deltaY:100});assert.match(f.message(),/Resize Y/);assert.equal(JSON.stringify(state.wallEdits),all);
 f.listeners.pointermove(f.e(3,3));shape=state.wallEdits.$surfaces[0].points;assert.ok(Math.abs(width()-4)<1e-8,'height scaling retains earlier width scaling');f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
});

test('rotation catches nearby 45 degree increments when snapping is enabled',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(1,1),p(3,1),p(3,2),p(1,2)],state={wallEdits:{$surfaces:[{id:'piece',points}]}},f=fixture({state,walls:[],selected:null});
 f.listeners.pointermove(f.e(3,1.5));f.editor.geometryCommand('r',{points});const a=43*Math.PI/180;f.listeners.pointermove(f.e(2+Math.cos(a),1.5+Math.sin(a)));const moved=state.wallEdits.$surfaces[0].points[0],c=Math.SQRT1_2;assert.ok(Math.abs(moved.x-(2-c+.5*c))<1e-8);assert.ok(Math.abs(moved.z-(1.5-c-.5*c))<1e-8);
});


test('rendered near-vertical surface can enter both move and extrusion without projection cancellation',()=>{
 for(const key of ['m','e']){const p=(x,y,z)=>({x,y,z}),face={id:'rounded-wall',points:[p(1,2,1),p(3,2,1),p(3,2.000003,3),p(1,1.999999,3)]},base={faces:[{id:'base',points:[p(0,0,0),p(6,0,0),p(6,6,0),p(0,6,0)]}]},f=fixture({state:{wallEdits:{$surfaces:[face]},base},walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(4,2));f.listeners.pointerup(f.e(4,2));f.listeners.pointermove(f.e(4,2));f.editor.key({key});f.listeners.pointermove(f.e(3.9,2));assert.ok(f.editor.busy(),f.message());assert.doesNotMatch(f.message(),/valid planar region|Preview canceled/);f.editor.key({key:'Escape'});
 }
});

test('resize axis widget highlights and switches axes without committing the preview',()=>{
 const panels=[];function element(tag){return {tag,style:{},dataset:{},attributes:{},children:[],setAttribute(k,v){this.attributes[k]=v;},appendChild(e){this.children.push(e);},addEventListener(){},querySelectorAll(){return this.children.filter(e=>e.tag==='button');},remove(){this.removed=true;}};}
 const document={body:{appendChild(e){panels.push(e);}},createElement:element,getElementById:id=>id==='three-view-wrapper'?{getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:800,width:1000,height:800})}:null},points=[{x:1,y:0,z:1},{x:3,y:0,z:1},{x:3,y:0,z:2},{x:1,y:0,z:2}],f=fixture({state:{wallEdits:{$surfaces:[{id:'piece',points}]}},walls:[],selected:null,globals:{document}});
 f.listeners.pointermove(f.e(3,3));f.editor.geometryCommand('y',{points});const hud=panels[0];assert.ok(hud);assert.equal(hud.children.find(b=>b.dataset.axis==='all').attributes['aria-pressed'],'true');hud.children.find(b=>b.dataset.axis==='z').onclick({preventDefault(){},stopPropagation(){}});assert.match(f.message(),/Resize Z/);assert.equal(hud.children.find(b=>b.dataset.axis==='z').attributes['aria-pressed'],'true');assert.equal(f.history.length,0);f.listeners.pointermove(f.e(3.1,3));assert.ok(Number.isFinite(parseFloat(hud.style.left)));f.editor.key({key:'Escape'});f.listeners.pointermove(f.e(3,3));assert.equal(hud.removed,true);
});


test('hidden points and lines cannot steal a front-face click in either display mode',()=>{
 for(const translucent of [true,false]){const p=(x,y,z)=>({x,y,z}),front={id:'front',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]},rear={id:'rear',points:[p(2,2,2),p(3,2,2),p(3,2,3),p(2,2,3)]},f=fixture({state:{translucent,wallEdits:{$surfaces:[front,rear]}},walls:[],selected:null,globals:renderGlobals(),pickVisible:p=>p.y===0,pickLineVisible:pair=>pair.every(p=>p.y===0)});
 f.editor.draw3D({add(){}},p=>p);assert.equal(f.editor.pickVisiblePoint(f.e(2,2)),false);assert.equal(f.editor.pickLine3D(f.e(2.5,2)),false);assert.equal(f.editor.pickSolid(f.e(2,2)),true);f.listeners.pointerup(f.e(2,2));assert.equal(f.editor.featureSelection().solid.id,'front');
 }
});

test('marquee selects through translucent walls but only visible points through opaque walls',()=>{
 for(const translucent of [true,false]){const points=[{x:1,y:0,z:1},{x:3,y:0,z:1},{x:3,y:0,z:3},{x:1,y:0,z:3}],f=fixture({state:{translucent,wallEdits:{$surfaces:[{id:'front',points},{id:'rear',points:points.map(p=>({...p,y:2}))}]}},walls:[],selected:null,pickVisible:p=>p.y===0});
 f.editor.startBox(f.e(0,0));f.listeners.pointermove(f.e(4,4));f.listeners.pointerup(f.e(4,4));assert.match(f.message(),new RegExp('^'+(translucent?8:4)+' points selected'));
 }
});

test('paste stays on its mounting plane after the cursor leaves the face',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},cap={id:'cap',points:[p(0,0,0),p(2,0,0),p(2,1,1),p(0,1,1)],material:'brick'},state={wallEdits:{$surfaces:[back,cap]}};let over=true;const f=fixture({state,walls:[],selected:null,featureHost:()=>over?({solid:back,points:back.points}):null}),before=JSON.stringify(state.wallEdits);
 f.editor.clipboardCommand('copy',{points:cap.points});f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));over=false;f.listeners.pointermove(f.e(-90,2));assert.match(f.message(),/Click to place/);f.listeners.pointermove(f.e(-100,3));assert.match(f.message(),/Click to place/);f.editor.down(f.e(-100,3));assert.equal(f.history.length,1,f.message());assert.equal(JSON.stringify(f.history[0]),before);const result=state.wallEdits.$surfaces.find(f=>f.id.startsWith('paste-'));assert.ok(result);assert.ok(Math.abs(Math.min(...result.points.map(p=>p.x))+5)<1e-6);assert.ok(Math.abs(Math.min(...result.points.map(p=>p.z))-3)<1e-6);
});
test('complex geometry move bounds contacts while the other coordinate remains responsive',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},cap={id:'cap',points:[p(0,0,0),p(2,0,0),p(2,1,1),p(0,1,1)]},state={wallEdits:{$surfaces:[back,cap]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(1,1));f.editor.geometryCommand('m',{points:cap.points});f.listeners.pointermove(f.e(-90,1));const shape=()=>state.wallEdits.$surfaces.find(f=>f.id==='cap').points;assert.ok(Math.abs(Math.min(...shape().map(p=>p.x))+5)<1e-6,f.message());const z=Math.min(...shape().map(p=>p.z));f.listeners.pointermove(f.e(-100,2));assert.ok(Math.abs(Math.min(...shape().map(p=>p.x))+5)<1e-6);assert.ok(Math.abs(Math.min(...shape().map(p=>p.z))-z-1)<1e-6,f.message());f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

test('group move clamps against connected wall faces even when mount footprint is an opening',()=>{
 const p=(x,y,z)=>({x,y,z}),a=p(1,0,1),b=p(2,0,1),c=p(2,0,2),d=p(1,0,2),A=p(1,1,1),B=p(2,1,1),C=p(2,1,2),D=p(1,1,2),face=(id,points)=>({id,points});
 const surfaces=[face('left',[p(0,0,0),a,d,p(0,0,4)]),face('bottom',[p(0,0,0),p(4,0,0),b,a]),face('right',[p(4,0,0),p(4,0,4),c,b]),face('top',[p(0,0,4),d,c,p(4,0,4)]),face('cap',[A,B,C,D]),face('returnL',[a,A,D,d]),face('returnB',[a,b,B,A]),face('returnR',[b,c,C,B]),face('returnT',[d,D,C,c])],state={wallEdits:{$surfaces:surfaces}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(1,1));assert.equal(f.editor.geometryCommand('m',{points:[a,b,c,d,A,B,C,D]}),true);f.listeners.pointermove(f.e(-90,1));assert.doesNotMatch(f.message(),/Adjust the preview|valid planar|canceled/i);const shape=()=>state.wallEdits.$surfaces.find(f=>f.id==='cap').points;const x=Math.min(...shape().map(p=>p.x)),z=Math.min(...shape().map(p=>p.z));assert.ok(x<.01&&x>-.01,f.message());f.listeners.pointermove(f.e(-100,1.25));assert.doesNotMatch(f.message(),/Adjust the preview|valid planar|canceled/i);assert.ok(Math.min(...shape().map(p=>p.z))>z+.2);assert.ok(Math.abs(Math.min(...shape().map(p=>p.x))-x)<.01);assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);f.listeners.pointermove(f.e(1,1));f.editor.geometryCommand('m',{points:[a,b,c,d,A,B,C,D]});f.listeners.pointermove(f.e(-100,1.25));f.editor.down(f.e(-100,1.25));assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

test('repeated flip keeps the chosen mounting plane and alternates axes without accumulating',()=>{
 const p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},side={id:'side',points:[p(0,-5,-5),p(0,5,-5),p(0,5,5),p(0,-5,5)]},cap={id:'cap',points:[p(0,0,0),p(1,0,0),p(1,1,1),p(0,1,1)]},state={wallEdits:{$surfaces:[back,side,cap]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.listeners.pointermove(f.e(2,2));f.editor.geometryCommand('f',{points:cap.points});const first=JSON.stringify(state.wallEdits);assert.match(f.message(),/Plane 1 \/ 2/);f.editor.key({key:'t'});assert.match(f.message(),/Plane 1 \/ 2/);assert.notEqual(JSON.stringify(state.wallEdits),first);f.editor.key({key:'t'});const restored=state.wallEdits.$surfaces.find(f=>f.id==='cap');assert.equal(JSON.stringify(restored.points),JSON.stringify(cap.points));f.editor.key({key:'t'});assert.equal(JSON.stringify(state.wallEdits),first);const unchanged=JSON.stringify(state.wallEdits);f.editor.key({key:'f'});assert.equal(JSON.stringify(state.wallEdits),unchanged);assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

test('an analytic base region extrudes to curved walls and Escape restores the base',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),curve={type:'ellipse',center:{x:2,y:2,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:1,radiusY:1,sweep:Math.PI},face={id:'region',points:K.curveSamples(curve),curves:[curve]},f=fixture({walls:[],selected:null,screen:p=>({x:(p.x+p.z)*100,y:p.y*100})}),before=JSON.stringify(f.state.wallEdits);
 assert.equal(f.editor.extrudeFace({face,event:f.e(2,2)}),true);f.listeners.pointermove(f.e(3,2));assert.ok(f.state.wallEdits.$surfaces.some(f=>f.curvedSurface),f.message());assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('wall edge fillet uses live chamfer controls and one cancellable undo transaction',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),before=JSON.stringify(state.wallEdits);f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)},true);assert.equal(f.editor.interaction(),'Fillet');f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$surfaces.some(f=>f.curvedSurface),f.message());assert.equal(f.history.length,0);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)},true);f.editor.distanceInput().set(.2);f.editor.down(f.e(1,1));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

function interiorDrawingFixture(){const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}for(const x of [1.6,2.4]){f.editor.doubleClick(f.e(x,1),f.w);f.editor.key({key:'n'});f.editor.down(f.e(x,3));f.listeners.pointerup(f.e(x,3));}return f;}
test('deleting all points of a subdivided interior drawing preserves the supporting wall',()=>{
 const f=interiorDrawingFixture(),before=JSON.stringify(f.state.wallEdits),history=f.history.length;f.editor.startBox(f.e(.8,.8));f.listeners.pointermove(f.e(3.2,3.2));f.listeners.pointerup(f.e(3.2,3.2));f.editor.key({key:'Delete'});const live=liveDraftFaces(f.d());assert.equal(live.length,1,f.message());assert.equal(live[0].holes.length,0);assert.equal(Math.abs(require('../public/measure/internal/editor_scripts/exterior_geometry.js').area(live[0])),16);assert.equal(f.history.length,history+1);assert.equal(JSON.stringify(f.history.at(-1)),before);assert.equal(liveDraftFaces(fixture({state:JSON.parse(JSON.stringify(f.state))}).d()).length,1);
});
test('deleting an interior drawing edge preserves the surrounding wall',()=>{
 const f=interiorDrawingFixture();f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));assert.match(f.message(),/1 lines selected/);f.editor.key({key:'Delete'});const scene=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state,[f.w]),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');const area=scene.reduce((sum,face)=>{const fr=K.frame(face);return sum+K.area({points:face.points.map(p=>K.local(fr,p)),holes:(face.holes||[]).map(r=>r.map(p=>K.local(fr,p)))});},0);assert.ok(Math.abs(area-16)<1e-5,JSON.stringify(scene));
});

test('interior point deletion also heals drawings previously converted by an edge merge',()=>{
 const f=interiorDrawingFixture();f.editor.down(f.e(1,2));f.listeners.pointerup(f.e(1,2));f.editor.key({key:'Delete'});f.editor.startBox(f.e(.8,.8));f.listeners.pointermove(f.e(3.2,3.2));f.listeners.pointerup(f.e(3.2,3.2));f.editor.key({key:'Delete'});const scene=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state,[f.w]),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');const area=scene.reduce((sum,f)=>{const fr=K.frame(f);return sum+K.area({points:f.points.map(p=>K.local(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(fr,p)))});},0);assert.ok(Math.abs(area-16)<1e-5,'Remaining wall area '+area);
});

test('S draws an arc from a 3D wall corner while C remains chamfer',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(0,0),f.w);f.listeners.pointermove(f.e(0,0));const before=JSON.stringify(f.state.wallEdits),count=f.history.length;
 assert.equal(f.editor.key({key:'s'}),true);assert.equal(f.editor.interaction(),'Draw curve');f.editor.down(f.e(1,0));f.listeners.pointermove(f.e(1,1));assert.match(f.message(),/Circle/);
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.color==='#FFD700'));
 f.editor.down(f.e(1,1));assert.equal(f.d().sketch.curves.length,1);assert.equal(f.history.length,count+1);
 f.editor.key({key:'s'});f.editor.key({key:'Escape'});assert.equal(f.d().sketch.curves.length,1);
});
test('R rounds a selected three-edge point with cancel and a single undo entry',()=>{
 const c=chamferCube(),state={wallEdits:{$surfaces:c.faces}},f=fixture({state,walls:[],selected:null,screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),before=JSON.stringify(state.wallEdits);
 f.editor.pickSolid(f.e(0,0),true);f.listeners.pointerup(f.e(0,0));f.listeners.pointermove(f.e(0,0));assert.equal(f.editor.key({key:'r'}),true);assert.equal(f.editor.interaction(),'Fillet');f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$surfaces.some(f=>f.curvedSurface?.type==='quadric-corner'),f.message());f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.chamferCommand({points:[c.a],event:f.e(0,0)},true);f.editor.distanceInput().set(.2);f.editor.down(f.e(0,0));assert.equal(f.history.length,1);
});

test('S converts a generated surface corner for drafting and Escape restores the original surface',()=>{
 const f=fixture({walls:[],selected:null}),face={id:'wall',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]};f.state.wallEdits={$surfaces:[face]};
 f.editor.pickSolid(f.e(0,0),true);f.listeners.pointerup(f.e(0,0));f.listeners.pointermove(f.e(0,0));const before=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.key({key:'s'}),true);assert.equal(f.editor.interaction(),'Draw curve');f.editor.down(f.e(1,0));f.listeners.pointermove(f.e(1,1));assert.match(f.message(),/Circle/);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,0);
});

test('curved wall is one rendered selectable material surface and moves analytically',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),curve={type:'ellipse',center:{x:2,y:2,z:0},u:{x:1,y:0,z:0},v:{x:0,y:1,z:0},radiusX:1,radiusY:1,sweep:Math.PI},source={id:'arc',points:K.curveSamples(curve),curves:[curve]},face=W.extrude(source,3).sides.find(f=>f.curvedSurface),state={wallEdits:{$surfaces:[face]}},globals=renderGlobals();globals.ExteriorMaterials={brick:{label:'Brick',color:'#b44'}};const f=fixture({state,walls:[],selected:null,globals}),objects=[];
 f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.equal(objects.filter(o=>o.userData.curvedSurface).length,1);assert.equal(objects.filter(o=>o.material.size===8).length,4);
 f.editor.materialCommand('brick');f.editor.down(f.e(20,20));assert.equal(state.wallEdits.$surfaces.length,1);assert.equal(state.wallEdits.$surfaces[0].material,'brick');f.editor.key({key:'Escape'});
 f.editor.pickSolid(f.e(20,20));f.listeners.pointerup(f.e(20,20));f.listeners.pointermove(f.e(20,20));const before=JSON.stringify(state.wallEdits);f.editor.key({key:'m'});assert.equal(f.editor.interaction(),'Transform geometry');f.listeners.pointermove(f.e(21,20));assert.notEqual(JSON.stringify(state.wallEdits),before);assert.equal(state.wallEdits.$surfaces.length,1);assert.equal(state.wallEdits.$surfaces[0].curvedSurface.logical,true);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

test('an arc selects as one curve and M translates its equation with cancellable preview',()=>{
 const f=fixture();f.editor.doubleClick(f.e(3,2),f.w);f.listeners.pointermove(f.e(3,2));f.editor.key({key:'s'});f.editor.down(f.e(2,2));f.listeners.pointermove(f.e(2,3));f.editor.down(f.e(2,3));f.editor.clear();const before=JSON.stringify(f.state.wallEdits),q=2+Math.SQRT1_2;f.editor.pickLine3D(f.e(q,q));f.listeners.pointerup(f.e(q,q));assert.match(f.message(),/1 curve selected/);f.editor.key({key:'m'});f.listeners.pointermove(f.e(q+.2,q));assert.ok(Math.abs(f.d().sketch.curves[0].center.x-2.2)<.00001);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('fillet binds the bottom arc to the base as one curve with only endpoint controls',()=>{
 const c=chamferCube(),state={base:{faces:[{...c.faces[4],id:'base'}]},wallEdits:{$surfaces:c.faces.filter((_,i)=>i!==4)}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()}),before=JSON.stringify(state.wallEdits);
 f.editor.chamferCommand({edges:[[c.a,c.e]],event:f.e(1,1)},true);f.editor.distanceInput().set(.8);const base=state.wallEdits.$base;assert.ok(base.faces[0].points.length>10,f.message());assert.equal(base.sketch.curves.length,1);assert.equal(base.sketch.edges.filter(e=>e.curveId).length,1,JSON.stringify(base.sketch.edges.filter(e=>e.curveId)));assert.equal(base.sketch.nodes.length,5);assert.ok(base.faces[0].points.filter(p=>S.isCurveSample(base,p)).length>5);f.editor.down(f.e(1,1));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 const loaded=JSON.parse(JSON.stringify(state.wallEdits));assert.equal(S.syncSurfaceBoundaries(loaded.$base,loaded.$surfaces),false);assert.equal(loaded.$base.sketch.nodes.length,5);
 const legacy=JSON.parse(JSON.stringify(base));delete legacy.faces[0].curves;delete legacy.sketch;S.ensure(legacy);assert.ok(legacy.sketch.nodes.length>10);assert.equal(S.syncSurfaceBoundaries(legacy,loaded.$surfaces),true);assert.equal(legacy.sketch.nodes.length,5);assert.equal(legacy.sketch.edges.filter(e=>e.curveId).length,1);
});


test('E on a filleted wall previews a connected curved sweep and restores the whole edit on Escape',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),c=chamferCube(),faces=K.compactSurfaces(W.fillet(c.faces,{edges:[[c.a,c.e]]},.4).faces),face=faces.find(f=>f.curvedSurface),base={faces:faces.filter(f=>f.id==='cube-4')},state={base,wallEdits:{$surfaces:[face,...faces.filter(f=>f!==face&&f.id!=='cube-4')]}},f=fixture({state,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(20,20));f.listeners.pointerup(f.e(20,20));f.listeners.pointermove(f.e(20,20));const before=JSON.stringify(state.wallEdits);assert.equal(f.editor.key({key:'e'}),true);assert.equal(f.editor.interaction(),'Extrude face');
 f.editor.distanceInput().set(.3);assert.match(f.message(),/Extrusion:/);assert.ok(state.wallEdits.$surfaces.find(x=>x.id===face.id).curvedSurface.logical);assert.ok(state.wallEdits.$surfaces.filter(x=>x.curvedSurface).length>=3);assert.ok(state.wallEdits.$base.sketch.curves.length);assert.equal(f.history.length,0);
 const mesh=K.surfaceMesh(state.wallEdits.$surfaces.find(x=>x.id===face.id));assert.ok(mesh.positions.every(K.finite3));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.key({key:'e'});f.editor.distanceInput().set(-.3);assert.match(f.message(),/Extrusion:/);f.editor.down(f.e(20,20));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);const saved=JSON.parse(JSON.stringify(state.wallEdits));assert.ok(saved.$surfaces.filter(f=>f.curvedSurface).every(f=>f.curvedSurface.logical));
});

test('roof corner R shows live curved geometry on mouse movement and supports cancel and undo',()=>{
 const input=require('./fixtures/point-fillet-roof-contact.json'),state={wallEdits:{$surfaces:JSON.parse(JSON.stringify(input.scene.filter(f=>!f.chamferSupportOnly)))},roof:{faces:input.scene.filter(f=>f.chamferSupportOnly)}},f=fixture({state,walls:[],selected:null,screen:p=>({x:(p.x+p.y)*100,y:-p.z*100})}),before=JSON.stringify(state.wallEdits);
 const start=()=>f.editor.chamferCommand({point:input.point,event:f.e(0,0)},true);
 start();assert.equal(f.editor.interaction(),'Fillet',f.message());
 f.listeners.pointermove(f.e(0,-.05));
 assert.ok(state.wallEdits.$surfaces.some(f=>f.curvedSurface?.logical),f.message());
 const first=JSON.stringify(state.wallEdits);f.listeners.pointermove(f.e(0,-.1));assert.notEqual(JSON.stringify(state.wallEdits),first);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 start();f.editor.distanceInput().set(.2);assert.ok(state.wallEdits.$surfaces.some(f=>f.curvedSurface?.type==='quadric-corner'),f.message());
 f.editor.down(f.e(0,0));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

test('wall curve center cue is rendered in 3D before and after choosing an oblique center',()=>{
 const markers=[],f=fixture({globals:renderGlobals(),centerMarker:(group,vector,p)=>markers.push(p)});
 f.editor.doubleClick(f.e(1,1),f.w);f.listeners.pointermove(f.e(1,1));f.editor.key({key:'s'});f.listeners.pointermove(f.e(2,2));
 f.editor.draw3D({add(){}},p=>p);assert.ok(markers.some(p=>Math.abs(p.x-2)<1e-8&&Math.abs(p.z-2)<1e-8));
 f.editor.down(f.e(2,2));f.listeners.pointermove(f.e(3,1));markers.length=0;f.editor.draw3D({add(){}},p=>p);assert.equal(markers.length,1);assert.ok(Math.abs(markers[0].x-2)<1e-8&&Math.abs(markers[0].z-2)<1e-8);
 f.editor.down(f.e(3,1));const c=f.d().sketch.curves[0];assert.ok(c);assert.ok(Math.abs(c.radiusX-c.radiusY)<1e-8);assert.ok(f.d().sketch.nodes.some(n=>n.id===c.centerId&&Math.abs(n.x-2)<1e-8&&Math.abs(n.y-2)<1e-8));
 f.editor.clear();markers.length=0;f.editor.draw3D({add(){}},p=>p);assert.equal(markers.length,0);
});

test('Shift-click chains wall quarters around one center with individual commits and visible snap sources',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),f=fixture({globals:renderGlobals()});f.editor.doubleClick(f.e(3,2),f.w);f.listeners.pointermove(f.e(3,2));f.editor.key({key:'s'});f.editor.down(f.e(2,2));const before=JSON.stringify(f.state.wallEdits),history=f.history.length;
 for(const [x,y] of [[2,3],[1,2],[2,1],[3,2]]){f.listeners.pointermove(f.e(x+.015,y+.015));const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.userData.curveSnapGuide==='radius-circle'||o.userData.curveSnapGuide==='point-target'));f.editor.down(f.e(x,y,true));assert.equal(f.editor.interaction(),'Draw curve');}
 const d=f.d(),curves=d.sketch.curves;assert.equal(curves.length,4);assert.equal(f.history.length,history+4);assert.equal(new Set(curves.map(c=>c.centerId)).size,1);assert.equal(d.sketch.nodes.filter(n=>n.curveCenter).length,1);
 for(let i=0;i<4;i++){const c=curves[i],end=K.curvePoint(c,1),next=K.curvePoint(curves[(i+1)%4],0);assert.ok(Math.abs(c.sweep-Math.PI/2)<1e-8);assert.ok(Math.hypot(end.x-next.x,end.y-next.y)<1e-8);assert.equal(c.radiusX,c.radiusY);}
 const placed=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(f.e(2,3));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),placed);assert.notEqual(placed,before);assert.equal(f.editor.busy(),false);
});


function circleDraftFixture(){
 const f=fixture();f.editor.doubleClick(f.e(3,2),f.w);const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 for(let i=0;i<4;i++){const a=i*Math.PI/2;S.addCurve(f.d(),{type:'ellipse',center:{x:2,y:2,z:0},u:{x:Math.cos(a),y:Math.sin(a),z:0},v:{x:-Math.sin(a),y:Math.cos(a),z:0},radiusX:1,radiusY:1,sweep:Math.PI/2});}
 return f;
}
test('rotating a drawn circle edits its analytic controls without converting the wall to sampled surfaces',()=>{
 const f=circleDraftFixture(),before=JSON.stringify(f.state.wallEdits),count=f.d().sketch.nodes.length,points=f.d().sketch.nodes.filter(n=>!n.fixed).map(n=>({x:n.x,y:0,z:n.y}));
 f.listeners.pointermove(f.e(3,2));f.editor.geometryCommand('r',{points});f.listeners.pointermove(f.e(2+Math.SQRT1_2,2+Math.SQRT1_2));
 assert.doesNotMatch(f.message(),/invalid|Adjust the preview/i);assert.equal(f.d().sketch.nodes.length,count);assert.equal(f.d().sketch.curves.length,4);assert.ok(!f.state.wallEdits.$surfaces?.length,'rotation must keep the host draft and its analytic arcs');
 const start=require('../public/measure/internal/editor_scripts/exterior_geometry.js').curvePoint(f.d().sketch.curves[0],0);assert.ok(Math.abs(start.x-(2+Math.SQRT1_2))<1e-6);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});
test('nudging a circle control keeps the two adjoining arcs analytic and the shared endpoint attached',()=>{
 const f=circleDraftFixture(),count=f.d().sketch.nodes.length;f.editor.down(f.e(3,2));f.listeners.pointerup(f.e(3,2));const before=f.history.length;
 f.editor.key({key:'ArrowDown'});assert.equal(f.history.length,before+1,f.message());assert.ok(!f.state.wallEdits.$surfaces?.length,'endpoint nudge must not polygonize the host wall');assert.ok(f.d().sketch.nodes.length<=count+2);assert.equal(f.d().sketch.curves.length,4);
 for(const e of f.d().sketch.edges.filter(e=>e.curveId)){const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),c=f.d().sketch.curves.find(c=>c.id===e.curveId);for(const [id,t]of [[e.a,e.curveRange[0]],[e.b,e.curveRange[1]]]){const n=f.d().sketch.nodes.find(n=>n.id===id),p=K.curvePoint(c,t);assert.ok(Math.hypot(n.x-p.x,n.y-p.y)<1e-7);}}
});


test('repeated curve nudges and rotation commits do not accumulate sampled control points',()=>{
 const f=circleDraftFixture();f.editor.down(f.e(3,2));f.listeners.pointerup(f.e(3,2));const count=f.d().sketch.nodes.length;
 for(let i=0;i<30;i++)f.editor.key({key:i<15?'ArrowDown':'ArrowUp',altKey:true});
 assert.ok(f.d().sketch.nodes.length<=count+2);assert.equal(f.d().sketch.edges.filter(e=>e.curveId).length,4);assert.ok(!f.state.wallEdits.$surfaces?.length);
 const points=f.d().sketch.nodes.filter(n=>!n.fixed).map(n=>({x:n.x,y:0,z:n.y}));f.listeners.pointermove(f.e(3,2));f.editor.geometryCommand('r',{points});f.listeners.pointermove(f.e(2.7,2.7));f.editor.down(f.e(2.7,2.7));assert.equal(f.editor.busy(),false,f.message());
 const placed=JSON.stringify(f.state.wallEdits);f.editor.key({key:'r'});assert.equal(f.editor.busy(),true,'placed curve controls remain selected for another rotation');f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),placed);
});


test('T previews planar trim, cycles from the original geometry, cancels and commits one undo item',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,0),f.w);f.editor.doubleClick(f.e(2,4),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});f.editor.clear();
 assert.ok(f.editor.pickLine3D(f.e(2,2)));f.listeners.pointerup(f.e(2,2));const original=JSON.stringify(f.state.wallEdits),count=f.history.length;
 f.editor.key({key:'t'});assert.equal(f.editor.interaction(),'trim');assert.match(f.message(),/Trim 0.50 ft/);assert.equal(f.state.wallEdits.$surfaces.filter(s=>s.trim).length,1);
 const first=f.state.wallEdits.$surfaces.find(s=>s.trim).points.map(p=>p.x);f.editor.key({key:'t'});assert.equal(f.state.wallEdits.$surfaces.filter(s=>s.trim).length,1);assert.notDeepEqual(f.state.wallEdits.$surfaces.find(s=>s.trim).points.map(p=>p.x),first);
 f.editor.key({key:'t'});assert.equal(f.state.wallEdits.$surfaces.filter(s=>s.trim).length,2);f.listeners.pointermove(f.e(3,3));assert.equal(f.editor.interaction(),'trim');
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),original);assert.equal(f.history.length,count);
 f.editor.key({key:'t'});f.editor.distanceInput().set(.3048);f.editor.down(f.e(3,3));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,count+1);assert.equal(JSON.stringify(f.history.at(-1)),original);assert.ok(f.state.wallEdits.$surfaces.every(s=>s.points.every(p=>p.y===0)));
});
test('color paint preserves the material type and follows face subdivision',()=>{
 let target;const f=fixture({globals:{ExteriorMaterials:{siding:{label:'Horizontal siding'}}},featureHost:()=>target});f.editor.doubleClick(f.e(2,2),f.w);target={d:f.d(),f:f.d().faces[0]};target.f.material='siding';f.editor.colorCommand('#f5f3ef');f.editor.down(f.e(1,1));assert.equal(target.f.material,'siding');assert.equal(target.f.finishColor,'#f5f3ef');assert.equal(f.history.length,2);f.editor.key({key:'Escape'});
 const d=f.d(),a=S.add(d,{x:2,y:0,z:0}),b=S.add(d,{x:2,y:4,z:0});S.connect(d,[a,b]);assert.equal(d.faces.length,2);assert.ok(d.faces.every(f=>f.material==='siding'&&f.finishColor==='#f5f3ef'));
});


test('textured faces stay selectable and selected material/color changes apply directly with undo',()=>{
 const globals=renderGlobals();globals.ExteriorMaterials={siding:{label:'Horizontal siding'},brick:{label:'Brick'}};
 const face={id:'paint-me',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],holes:[],material:'siding'},state={displayMode:'textured',translucent:false,wallEdits:{$surfaces:[face]}},f=fixture({state,globals,pickVisible:()=>false,pickLineVisible:()=>false});
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(f.editor.pickSolid(f.e(2,2)));f.listeners.pointerup(f.e(2,2));
 objects.length=0;f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.userData.exteriorSelected));
 const before=JSON.stringify(state.wallEdits);assert.equal(f.editor.materialCommand('brick'),true);assert.equal(state.wallEdits.$surfaces[0].material,'brick');assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.history[0]),before);
 f.editor.colorCommand('#53758a');assert.equal(state.wallEdits.$surfaces[0].finishColor,'#53758a');assert.equal(state.wallEdits.$surfaces[0].material,'brick');assert.equal(f.history.length,2);assert.equal(f.editor.activeMaterial(),'brick');
});


test('Auto trim applies only outward corners as one undo operation and repeating it is a no-op',()=>{
 const outline=[[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]],walls=outline.map(([x,y],i)=>{const [xx,yy]=outline[(i+1)%outline.length];return {id:'wall-'+i,bottom:[{x,y,z:0},{x:xx,y:yy,z:0}],top:[{x,y,z:3},{x:xx,y:yy,z:3}]};}),f=fixture({walls});
 const before=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.autoTrim(),true,f.message());assert.match(f.message(),/5 corner runs/);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.ok(f.state.wallEdits.$surfaces.some(f=>f.trim));assert.equal(f.editor.busy(),false);
 const after=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.autoTrim(),false);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.state.wallEdits),after);
});


test('T on a saved trim face removes it, selects its source, then reapplies above/below/centered',()=>{
 const Trim=require('../public/measure/internal/editor_scripts/wall_trim.js'),face={id:'host',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],material:'siding'},pair=[{x:0,y:0,z:2},{x:4,y:0,z:2}],pieces=Trim.partition([face],[pair]).replacements[0].pieces.sort((a,b)=>Number(!!b.trim)-Number(!!a.trim));
 const state={displayMode:'textured',wallEdits:{$surfaces:JSON.parse(JSON.stringify(pieces))}},f=fixture({state,globals:renderGlobals(),pickVisible:()=>false,pickLineVisible:()=>false});f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,2.05));f.listeners.pointerup(f.e(2,2.05));
 f.editor.key({key:'t'});assert.match(f.message(),/Trim removed/);assert.equal(f.history.length,1);assert.ok(!state.wallEdits.$surfaces.some(f=>f.trim));
 f.editor.key({key:'t'});assert.equal(f.editor.busy(),true);let trim=state.wallEdits.$surfaces.filter(f=>f.trim);assert.ok(trim.every(f=>f.points.every(p=>p.z>=2&&p.z<=2.152401)));
 f.editor.key({key:'t'});trim=state.wallEdits.$surfaces.filter(f=>f.trim);assert.ok(trim.every(f=>f.points.every(p=>p.z<=2&&p.z>=1.847599)));
 f.editor.key({key:'t'});trim=state.wallEdits.$surfaces.filter(f=>f.trim);assert.ok(trim.every(f=>f.points.every(p=>p.z>=1.923799&&p.z<=2.076201)));f.editor.key({key:'Enter'});assert.equal(f.history.length,2);
});

test('3D Delete merges a chimney draft with the adjoining house draft into a complete saved face',()=>{
 const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),points=[p(8,0,5),p(12,0,5),p(12,2,5),p(8,2,5)],roof={points,connections:points.map((_,i)=>({startIdx:i,endIdx:(i+1)%4,type:['chimney_back','chimney_edge','chimney_front','chimney_edge'][i]})),faces:[]},chimneys=C.detect(roof),id=chimneys.items[0].id;
 const wall=(id,x0,x1,chimney)=>({id,chimney,bottom:[p(x0,0,0),p(x1,0,0)],top:[p(x0,0,5),p(x1,0,5)]}),walls=[wall('house',0,8),wall('chimney',8,12,{id,side:0})],state={wallEdits:{},chimneys,roof,base:{faces:[{points:[p(0,0,0),p(10,0,0),p(10,10,0),p(0,10,0)]}]}},f=fixture({state,walls,selectedId:'house',globals:{WallChimneys:C}});
 const before=JSON.stringify(state.wallEdits);f.editor.down(f.e(8,2));f.listeners.pointerup(f.e(8,2));assert.equal(f.message(),'1 lines selected');f.editor.key({key:'delete'});assert.equal(f.history.length,1);
 const merged=state.wallEdits.$surfaces.find(f=>!f.deleted);assert.ok(merged);assert.deepEqual([...merged.joinedChimneys],[id]);const visible=C.visibleParts(merged,JSON.parse(JSON.stringify(state)));assert.equal(visible.length,1);assert.equal(visible[0].points.length,4);assert.equal(Math.max(...visible[0].points.map(p=>p.x)),12);assert.equal(Math.min(...visible[0].points.map(p=>p.x)),0);assert.equal(W.surfaceWire({$surfaces:visible}).edges.length,4);assert.equal(JSON.stringify(f.history[0]),before);
});

test('solid line-selection Delete merges adjacent edited faces instead of invalidating both',()=>{
 const p=(x,z)=>({x,y:0,z}),left={id:'left',points:[p(0,0),p(4,0),p(4,4),p(0,4)],holes:[]},right={id:'right',points:[p(4,0),p(8,0),p(8,4),p(4,4)],holes:[]},state={wallEdits:{$surfaces:[left,right]}},f=fixture({state,walls:[],selected:null,globals:{document:{getElementById:id=>id==='base-selection'?{value:'line'}:null}}});
 const before=JSON.stringify(state.wallEdits),e=f.e(4,2);assert.equal(f.editor.pickSolid(e,true),true);f.listeners.pointerup(e);f.editor.key({key:'Delete'});
 const live=state.wallEdits.$surfaces.filter(f=>!f.deleted);assert.equal(live.length,1);assert.equal(live[0].points.length,4);assert.equal(Math.max(...live[0].points.map(p=>p.x)),8);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

test('Delete on the saved overlapping chimney seam keeps both the union and its exposed upper boundary',()=>{
 const input=JSON.parse(JSON.stringify(require('./fixtures/chimney-overlapping-wall.json'))),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),frame=W.faceFrame(input.faces[0]),state={wallEdits:{$surfaces:input.faces}},f=fixture({state,walls:[],selected:null,screen:p=>{const q=W.inFrame(frame,p);return {x:q.x*100,y:q.y*100};},globals:{document:{getElementById:id=>id==='base-selection'?{value:'line'}:null}}});
 const [a,b]=input.pair,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2},q=W.inFrame(frame,mid),e=f.e(q.x,q.y);assert.equal(f.editor.pickSolid(e,true),true);f.listeners.pointerup(e);f.editor.key({key:'Delete'});
 const live=state.wallEdits.$surfaces.filter(f=>!f.deleted),merged=live.find(f=>f.id.startsWith('line-merge-'));assert.ok(merged);assert.equal(live.length,2);assert.ok(live.some(f=>f.id===input.faces[2].id));assert.equal(f.history.length,1);assert.ok(!state.wallEdits.$removedSurfaceEdges.includes(W.edgeKey(a,b)),'do not erase the entire roof-crossing edge');assert.ok(W.sharedIntervals(a,b,[merged]).length);
});

test('V fills selected coplanar points without adding unselected nodes and supports undo',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3]])f.editor.doubleClick(f.e(x,y),f.w);
 const chosen=f.d().sketch.nodes.filter(n=>!n.fixed),points=chosen.map(n=>({x:n.x,y:0,z:n.y})),before=JSON.stringify(f.state.wallEdits);assert.equal(points.length,4);points.forEach((p,i)=>{const e=f.e(p.x,p.z,i>0);f.editor.down(e);f.listeners.pointerup(e);});f.editor.key({key:'v'});const face=f.state.wallEdits.$surfaces.at(-1);assert.equal(face.points.length,4);assert.equal(face.holes.length,0);assert.equal(f.history.at(-1)&&JSON.stringify(f.history.at(-1)),before);
 const old=JSON.stringify(f.state.wallEdits);f.editor.createSelectedFace({points:[...points.slice(0,3),{x:1,y:.1,z:3}]});assert.equal(JSON.stringify(f.state.wallEdits),old);assert.match(f.message(),/one plane/);
});
test('deleting a corner shared by filled coplanar regions heals their union rather than deleting it',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),p=(x,z)=>({x,y:0,z}),faces=[{id:'wall',points:[p(0,0),p(4,0),p(4,4),p(2,3),p(0,4)]},{id:'patch',material:'default',points:[p(0,4),p(2,3),p(4,4)]}],state={wallEdits:{$surfaces:faces}},f=fixture({state,walls:[],selected:null});
 const e=f.e(2,3);f.editor.pickSolid(e,true);f.listeners.pointerup(e);f.editor.key({key:'Delete'});const live=state.wallEdits.$surfaces.filter(f=>!f.deleted);assert.equal(live.length,1);K.validateFace(live[0]);assert.equal(live[0].points.length,4);assert.ok(!live[0].points.some(p=>p.x===2&&p.z===3));
});

test('deleting an outer boundary point shared by two coplanar faces merges and simplifies their perimeter',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,z)=>({x,y:0,z}),faces=[{id:'a',points:[p(0,0),p(2,0),p(2,4),p(0,4)]},{id:'b',points:[p(2,0),p(4,0),p(4,4),p(2,4)]}],f=fixture({state:{wallEdits:{$surfaces:faces}},walls:[],selected:null}),e=f.e(2,0);f.editor.pickSolid(e,true);f.listeners.pointerup(e);f.editor.key({key:'Delete'});const live=f.state.wallEdits.$surfaces.filter(f=>!f.deleted);assert.equal(live.length,1);assert.equal(live[0].points.length,4);assert.equal(W.surfaceWire({$surfaces:live}).edges.length,4);
});

test('a completed rectangle suppresses its trailing click and selects points only',()=>{
 const f=fixture();let clicks=0;
 f.editor.startBox(f.e(-.1,-.1),()=>{clicks++;f.editor.down(f.e(2,2));});
 f.listeners.pointermove(f.e(4.1,4.1));f.listeners.pointerup(f.e(4.1,4.1));
 assert.equal(clicks,0);assert.equal(f.message(),'4 points selected');
 assert.equal(f.editor.featureSelection(),null);assert.equal(f.editor.consumeSelectionClick(),true);
 f.editor.startBox(f.e(2,2),()=>clicks++);f.listeners.pointerup(f.e(2,2));
 assert.equal(clicks,1);assert.equal(f.editor.consumeSelectionClick(),false);
});

test('surface picking gives a visible endpoint priority over its supporting edge',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.draw3D({add(){}},p=>p);
 assert.equal(f.editor.pickSolid(f.e(.04,.04)),true);f.listeners.pointerup(f.e(.04,.04));
 assert.equal(f.message(),'1 point selected');assert.equal(f.editor.featureSelection(),null);
 assert.equal(f.editor.pickLine3D(f.e(2,0)),true);f.listeners.pointerup(f.e(2,0));
 assert.equal(f.message(),'1 lines selected');
 assert.equal(f.editor.pickSolid(f.e(.04,.04)),true);f.listeners.pointerup(f.e(.04,.04));
 assert.equal(f.message(),'1 point selected');
});

test('Control-click and Control-rectangle subtract points; Shift adds without toggling',()=>{
 const f=fixture();f.editor.startBox(f.e(-.1,-.1));f.listeners.pointerup(f.e(4.1,4.1));assert.equal(f.message(),'4 points selected');
 const click=(x,y,mods)=>{const e={...f.e(x,y),...mods};f.editor.pickVisiblePoint(e);f.listeners.pointerup(e);};
 click(0,0,{ctrlKey:true});assert.equal(f.message(),'3 points selected');
 click(0,0,{ctrlKey:true});assert.equal(f.message(),'3 points selected');
 click(0,0,{shiftKey:true});click(0,0,{shiftKey:true});assert.equal(f.message(),'4 points selected');
 f.editor.startBox({...f.e(-.1,-.1),ctrlKey:true});f.listeners.pointerup(f.e(.1,4.1));assert.equal(f.message(),'2 points selected');
});

test('V uses all Shift-selected points across coplanar draft owners',()=>{
 const wall=(id,x)=>({id,bottom:[{x,y:0,z:0},{x:x+2,y:0,z:0}],top:[{x,y:0,z:4},{x:x+2,y:0,z:4}]}),f=fixture({walls:[wall('a',0),wall('b',2)],selectedId:'a'});
 for(const [i,[x,y]]of [[0,0],[2,0],[4,0],[4,4],[2,4],[0,4]].entries()){const e=f.e(x,y,i>0);f.editor.pickVisiblePoint(e);f.listeners.pointerup(e);}
 assert.equal(f.message(),'6 points selected');f.editor.key({key:'v'});
 const face=f.state.wallEdits.$surfaces?.find(f=>f.id.startsWith('filled-face'));
 assert.equal(face?.points.length,6,f.message());
});

test('point picking an edited surface activates walls and removes face selection before V',()=>{
 let selectedLayer='base';const points=[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:[{id:'surface',points}]}},globals:renderGlobals(),select:()=>selectedLayer='walls'});
 f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,2));f.listeners.pointerup(f.e(2,2));assert.ok(f.editor.featureSelection());
 for(const [i,p]of points.entries()){const e=f.e(p.x,p.z,i>0);f.editor.pickVisiblePoint(e);f.listeners.pointerup(e);assert.equal(f.editor.featureSelection(),null);}
 assert.equal(selectedLayer,'walls');assert.equal(f.editor.pointSelection().length,4);
 f.editor.key({key:'v'});assert.match(f.message(),/Face created from 4/);
 assert.equal(f.state.wallEdits.$surfaces.filter(f=>!f.deleted&&!f.drafted).length,1);
});

test('duplicate boundary deletion removes the face and V closes it again from all four points',()=>{
 const points=[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:['a','b'].map(id=>({id,points:structuredClone(points)}))}},globals:renderGlobals()});
 f.editor.pickLine3D(f.e(0,2));f.listeners.pointerup(f.e(0,2));f.editor.key({key:'Delete'});
 assert.equal(f.state.wallEdits.$surfaces.filter(f=>!f.deleted&&!f.drafted).length,0);
 f.editor.startBox(f.e(-.1,-.1));f.listeners.pointerup(f.e(4.1,4.1));assert.equal(f.editor.pointSelection().length,4);assert.equal(f.editor.featureSelection(),null);
 f.editor.key({key:'v'});const live=f.state.wallEdits.$surfaces.filter(f=>!f.deleted&&!f.drafted);assert.equal(live.length,1);assert.equal(live[0].points.length,4);
});

test('captured seven-point wall keeps every selected anchor when filled',()=>{
 const face=require('./fixtures/seven-point-filled-wall.json'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),frame=W.faceFrame(face);
 const f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:[structuredClone(face)]}},screen:p=>{const q=W.inFrame(frame,p);return {x:q.x*100,y:q.y*100};}});
 f.editor.startBox(f.e(-100,-100));f.listeners.pointerup(f.e(100,100));assert.equal(f.editor.pointSelection().length,7);
 f.editor.key({key:'v'});const live=f.state.wallEdits.$surfaces.filter(f=>!f.deleted&&!f.drafted);assert.equal(live.length,1);assert.equal(live[0].points.length,7);
});


test('saved merged chimney corner selects one point after roof-contact repair',()=>{
 const input=require('./fixtures/merged-chimney-roof-contact.json'),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
 const select=state=>{const f=fixture({state,walls:[],selected:null,globals:{WallChimneys:C}});f.editor.startBox(f.e(8.45,162.52));f.listeners.pointerup(f.e(8.54,162.62));return f.editor.pointSelection();};
 const state=structuredClone(input);assert.equal(select(state).length,2);
 C.alignRoofContacts(state);assert.equal(select(state).length,1);
 const reloaded=JSON.parse(JSON.stringify(state));C.syncVolumes(reloaded);assert.equal(select(reloaded).length,1);
});


test('V creates a visible four-point patch inside a chimney cutout, with selectable edges after reload',()=>{
 const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),state=structuredClone(require('./fixtures/merged-chimney-roof-contact.json'));
 const c=C.definitions(state)[0],a=c.points[2],b=c.points[3],points=[{...a,z:161},{...b,z:161},{...b,z:162},{...a,z:162}];
 assert.equal(C.visibleParts({points},state).length,0,'reproduces the hidden patch without an explicit fill');
 const f=fixture({state,walls:[],selected:null,globals:{...renderGlobals(),WallChimneys:C}});f.editor.createSelectedFace({points});
 assert.match(f.message(),/Face created from 4/);const face=state.wallEdits.$surfaces.find(f=>f.id.startsWith('filled-face-'));
 assert.ok(face);assert.equal(face.points.length,4);assert.deepEqual(C.visibleParts(face,state),[face]);const rendered=[];f.editor.draw3D({add(mesh){rendered.push(mesh);}},p=>p);assert.ok(rendered.some(mesh=>mesh.userData?.solidId===face.id),'renderer emits the filled face mesh');
 for(let i=0;i<4;i++){const a=face.points[i],b=face.points[(i+1)%4];assert.deepEqual(C.visibleSegments(a,b,state,face.chimney,face.joinedChimneys),[[a,b]]);}
 const reloaded=JSON.parse(JSON.stringify(state));C.syncVolumes(reloaded);const saved=reloaded.wallEdits.$surfaces.find(s=>s.id===face.id);assert.deepEqual(C.visibleParts(saved,reloaded),[saved]);
 assert.ok(f.history.length,'fill remains undoable');
});


test('selecting either source of a shared chimney plane preserves the complete face after deselect and reload',()=>{
 const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 const p=(x,y,z)=>({x,y,z}),walls=[{id:'wall',sourceId:'wall',mergeGroup:'joined',bottom:[p(0,0,0),p(2,0,0)],top:[p(0,0,3),p(2,0,3)]},{id:'chimney',sourceId:'c',mergeGroup:'joined',chimney:{id:'c',side:0},bottom:[p(2,0,0),p(3,0,0)],top:[p(2,0,3),p(3,0,3)]}];
 for(const chosen of walls){
  const state={chimneys:{items:[{id:'c',points:[p(2,0,3),p(3,0,3),p(3,1,3),p(2,1,3)]}]},wallEdits:{}};
  const f=fixture({state,walls,selectedId:chosen.id,globals:{...renderGlobals(),WallChimneys:C}});
  const before=JSON.stringify(walls);f.editor.beginFace(f.e(.5,1),chosen);f.listeners.pointerup(f.e(.5,1));
  const d=state.wallEdits.$drafts.joined;assert.equal(d.chimney,undefined);assert.deepEqual([...d.joinedChimneys],['c']);
  assert.equal(d.faces.length,1);assert.equal(K.area(d.faces[0]),9);assert.equal(f.history.length,0);
  const draw=editor=>{const objects=[];editor.draw3D({add:o=>objects.push(o)},p=>p);return objects.filter(o=>Object.hasOwn(o.material,'side'));};
  const selected=draw(f.editor);assert.equal(selected.length,1);assert.equal(K.area({points:selected[0].geometry.points.map(p=>({x:p.x,y:p.z}))}),9);
  f.editor.clear();const deselected=draw(f.editor);assert.equal(deselected.length,1);assert.deepEqual(deselected[0].geometry.points,selected[0].geometry.points);
  const reload=fixture({state:JSON.parse(JSON.stringify(state)),walls,selectedId:chosen.id,globals:{...renderGlobals(),WallChimneys:C}});assert.equal(draw(reload.editor).length,1);
  assert.equal(JSON.stringify(walls),before);
 }
});

test('legacy merged wall extrusion has no selectable or rendered source outline after ownership repair',()=>{
 const state=JSON.parse(fs.readFileSync('dev/fixtures/merged-wall-extrusion-wire.json','utf8')),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
 const before=JSON.stringify(state),oldDraft=Object.values(state.wallEdits.$drafts).find(d=>!d.frame),oldCorners=oldDraft.faces.flatMap(f=>f.points).filter(p=>Math.abs(p.y-157.69)<1e-5).map(p=>({x:oldDraft.origin.x+oldDraft.u.x*p.x,y:oldDraft.origin.y+oldDraft.u.y*p.x,z:p.y}));
 const original=fixture({state:JSON.parse(before),walls:[],selected:null,globals:renderGlobals()}),oldObjects=[];original.editor.draw3D({add:o=>oldObjects.push(o)},p=>p);assert.ok(oldObjects.some(o=>o.material.color==='#6ce4ed'&&o.geometry.points.some(p=>oldCorners.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-5))),'Fixture reproduces the retained source outline');
 assert.equal(W.adoptMergedFaceSources(state.wallEdits),true);
 assert.ok(oldDraft.faces.every(f=>f.solidId==='line-merge-0'));
 const repaired=JSON.stringify(state);assert.equal(W.adoptMergedFaceSources(state.wallEdits),false);assert.equal(JSON.stringify(state),repaired);
 for(const loaded of [state,JSON.parse(repaired)]){
  const f=fixture({state:loaded,walls:[],selected:null,globals:renderGlobals()}),objects=[];
  f.editor.draw3D({add:o=>objects.push(o)},p=>p);
  assert.ok(!objects.some(o=>o.geometry.points.some(p=>oldCorners.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-5))),'Obsolete bottom corners and lines must not render');
  const beforeClick=JSON.stringify(loaded);assert.equal(f.editor.pickVisiblePoint(f.e(oldCorners[0].x,oldCorners[0].z)),false);assert.equal(JSON.stringify(loaded),beforeClick);
 }
 assert.notEqual(repaired,before);
});

test('merging a seam then extruding consumes both draft and surface outlines with cancel and undo',()=>{
 for(const drafted of [false,true]){
  const f=fixture({walls:drafted?undefined:[],state:{wallEdits:drafted?{}:{$surfaces:[{id:'a',points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:0,z:4},{x:0,y:0,z:4}]},{id:'b',points:[{x:2,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:2,y:0,z:4}]}]}},globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
  if(drafted){f.editor.doubleClick(f.e(2,0),f.w);f.editor.doubleClick(f.e(2,4),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});}
  f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));const preMerge=JSON.stringify(f.state.wallEdits);f.editor.key({key:'Delete'});
  const merged=f.state.wallEdits.$surfaces.find(s=>!s.deleted);assert.equal(merged.mergedSources.length,2);
  if(drafted)assert.ok(f.d().faces.every(r=>r.solidId===merged.id));else assert.ok(f.state.wallEdits.$surfaces.filter(s=>s.deleted).every(s=>s.replacedBy===merged.id));
  assert.equal(JSON.stringify(f.history.at(-1)),preMerge);
  const draw=()=>{const os=[];f.editor.draw3D({add:o=>os.push(o)},p=>p);return os;};
  draw();f.editor.pickSolid(f.e(1,2));f.listeners.pointerup(f.e(1,2));f.listeners.pointermove(f.e(1,2));const before=JSON.stringify(f.state.wallEdits);
  f.editor.key({key:'e'});f.listeners.pointermove(f.e(2,2));assert.match(f.message(),/Extrusion/);
  assert.ok(!draw().some(o=>o.material.color==='#6ce4ed'&&o.geometry.points.some(p=>Math.abs(p.y)<1e-6)),'Replaced source outlines must not remain as loose wire');
  f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
  f.editor.key({key:'e'});f.listeners.pointermove(f.e(3,2));f.editor.down(f.e(3,2));assert.equal(JSON.stringify(f.history.at(-1)),before);
 }
});

test('editor indent preserves the distant chimney join and untouched drafts through commit and reload',()=>{
 const state=JSON.parse(fs.readFileSync('dev/fixtures/remote-indent-chimney.json','utf8')),C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 for(const d of Object.values(state.wallEdits.$drafts))for(const f of d.faces)if(f.solidId?.startsWith('swept-')||f.solidId?.startsWith('region-R20'))delete f.solidId;
 state.wallEdits.$surfaces=state.wallEdits.$surfaces.filter(f=>!f.id.startsWith('swept-')&&!f.id.startsWith('region-R20'));delete state.wallEdits.$base;
 const key='R20.0:0',d=state.wallEdits.$drafts[key],world=p=>({x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y}),w={id:key,bottom:[world({x:0,y:157.69}),world({x:14.019044,y:157.69})],top:[world({x:0,y:162.382054}),world({x:14.019044,y:162.382054})]},f=fixture({state,walls:[w],selectedId:key,globals:{...renderGlobals(),WallChimneys:C},projectPoint:(d,e)=>({x:e.clientX/100,y:e.clientY/100,z:0})});
 f.editor.beginFace(f.e(7,158.5),w);f.listeners.pointerup(f.e(7,158.5));f.listeners.pointermove(f.e(7,158.5));const before=JSON.stringify(state.wallEdits);
 f.editor.key({key:'e'});f.editor.distanceInput().set(.9144);assert.match(f.message(),/Extrusion/);
 const verify=()=>{const surface=state.wallEdits.$surfaces.find(s=>s.draftKey?.startsWith('R17.1:0'));assert.ok(surface,f.message());assert.deepEqual([...surface.joinedChimneys],['roof-chimney-11-12-13-14']);const frame=W.faceFrame(surface),area=f=>K.area({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))});assert.ok(Math.abs(C.visibleParts(surface,state).reduce((s,p)=>s+area(p),0)-area(surface))<1e-7);};
 verify();f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.key({key:'e'});f.editor.distanceInput().set(.9144);f.editor.down(f.e(7,158.5));verify();assert.equal(JSON.stringify(f.history.at(-1)),before);
 const old=JSON.parse(before);for(const [key,d]of Object.entries(old.$drafts)){if(key==='R20.0:0'||key.startsWith('R17.1:0')||key.startsWith('R1.0:0'))continue;assert.equal(JSON.stringify(state.wallEdits.$drafts[key]),JSON.stringify(d),'Unrelated draft '+key+' changed');}
 const loaded=JSON.parse(JSON.stringify(state));assert.equal(require('../public/measure/internal/editor_scripts/exterior_model.js').restoreDraftFaceOwnership(loaded.wallEdits),false,'New operations must not need repair on reload');
});


test('sticker edge snaps to neighbor height, releases contact, and typed dimensions cross the opposite edge',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,z)=>({x,y:0,z}),window=(id,x,z)=>({id,feature:{type:'window',shape:'rectangle',axis:{x:1,y:0,z:0}},points:[p(x,z),p(x+1,z),p(x+1,z+1),p(x,z+1)]});
 const stickers=[window('moving',0,2),window('below',0,0),window('beside',2,2.5)],host={id:'host',points:[p(-5,-5),p(5,-5),p(5,8),p(-5,8)],holes:stickers.map(f=>f.points)},state={wallEdits:{$surfaces:[host,...stickers]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits);
 f.editor.beginEntity('move',{pair:[p(0,2),p(1,2)],event:f.e(.5,2)});
 const moving=()=>state.wallEdits.$surfaces.find(s=>s.id==='moving');
 f.listeners.pointermove(f.e(.5,2.47));assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-2.5)<1e-8),f.message());
 f.listeners.pointermove(f.e(.5,1.04));assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-1)<1e-8),f.message());
 f.listeners.pointermove(f.e(.5,1.5));assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-1.5)<1e-8),f.message());
 // Preview normalization may convert a live surface to a draft; never feed that back into the gesture baseline.
 state.wallEdits.$surfaces.find(f=>f.id==='below').drafted=true;
 f.listeners.pointermove(f.e(.5,1.6));assert.equal(state.wallEdits.$surfaces.find(f=>f.id==='below').drafted,undefined);
 f.listeners.pointermove(f.e(.5,3));assert.equal(moving().points.length,4,'collapse retains last valid geometry');
 f.listeners.pointermove(f.e(.5,2.2));assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-2.2)<1e-8),f.message());
 const input=f.editor.distanceInput();assert.equal(input.label,'Height');input.set(4*.3048);assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-(3-4*.3048))<1e-8));
 input.set(-4*.3048);assert.ok(moving().points.slice(0,2).every(p=>Math.abs(p.z-(3+4*.3048))<1e-8));
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.beginEntity('move',{pair:[p(1,2),p(1,3)],event:f.e(1,2.5)});const width=f.editor.distanceInput();assert.equal(width.label,'Width');width.set(4*.3048);assert.ok(moving().points.slice(1,3).every(p=>Math.abs(p.x-4*.3048)<1e-8));width.set(-4*.3048);assert.ok(moving().points.slice(1,3).every(p=>Math.abs(p.x+4*.3048)<1e-8));f.editor.down(f.e(1,2.5));assert.equal(f.history.length,1);
});

test('Shift selects multiple solid faces; Control subtracts and finish changes share one undo',()=>{
 const globals=renderGlobals();let hit=0;globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){return ms[hit]?[{object:ms[hit]}]:[];}};globals.ExteriorMaterials={brick:{label:'Brick'}};
 const p=(x,z)=>({x,y:0,z}),state={displayMode:'textured',wallEdits:{$surfaces:[0,5,10].map((x,i)=>({id:'face'+i,points:[p(x,0),p(x+4,0),p(x+4,4),p(x,4)],material:'siding'}))}},f=fixture({state,walls:[],selected:null,globals});
 const click=(i,mods={})=>{hit=i;f.editor.draw3D({add(){}},p=>p);const e={...f.e(i*5+2,2),...mods};assert.ok(f.editor.pickSolid(e));f.listeners.pointerup(e);};
 click(0);click(1,{shiftKey:true});click(2,{shiftKey:true});click(1,{ctrlKey:true});
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.equal(objects.filter(o=>o.userData.exteriorSelected).length,2);
 const before=JSON.stringify(state.wallEdits);f.editor.materialCommand('brick');assert.deepEqual(state.wallEdits.$surfaces.map(f=>f.material),['brick','siding','brick']);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 f.editor.colorCommand('#123456');assert.deepEqual(state.wallEdits.$surfaces.map(f=>f.finishColor),['#123456',undefined,'#123456']);
 click(0,{ctrlKey:true});click(2,{ctrlKey:true});const after=JSON.stringify(state.wallEdits);f.editor.materialCommand('brick');assert.equal(JSON.stringify(state.wallEdits),after);assert.equal(f.editor.interaction(),'Paint material');
});


test('draft sticker resize recovers after contact and collapse without consuming the neighbor',()=>{
 const f=stickerFixture('window',[1,2.7]);f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(1,1));f.editor.down(f.e(1,1));
 const features=f.d().faces.filter(f=>f.feature).sort((a,b)=>B.center(b).y-B.center(a).y);assert.equal(features.length,2,f.message());const upper=features[0],lower=features[1],bottom=Math.min(...upper.points.map(p=>p.y)),top=Math.max(...upper.points.map(p=>p.y)),target=Math.max(...lower.points.map(p=>p.y)),pair=upper.points.filter(p=>Math.abs(p.y-bottom)<1e-6).map(p=>({x:p.x,y:0,z:p.y})),before=JSON.stringify(f.state.wallEdits);
 f.editor.beginEntity('move',{pair,event:f.e(1,bottom)});assert.equal(f.editor.interaction(),'Move line');
 for(const z of [target+.02,target+.3,top,top-.3,target+.4]){f.listeners.pointermove(f.e(1,z));f.editor.draw3D({add(){}},p=>p);const surfaces=f.state.wallEdits.$surfaces||[];const moved=surfaces.find(f=>f.feature&&f.points.some(p=>Math.abs(p.z-top)<1e-6));assert.ok(moved&&moved.points.length===4,f.message());if(z!==top)assert.ok(moved.points.some(p=>Math.abs(p.z-(z===target+.02?target:z))<1e-6),f.message());const originals=f.d().faces.filter(f=>f.feature&&!f.solidId);assert.ok(originals.some(f=>Math.abs(B.center(f).y-B.center(lower).y)<1e-6)||surfaces.some(f=>f.feature&&f.points.some(p=>Math.abs(p.z-Math.min(...lower.points.map(p=>p.y)))<1e-6)),'Neighbor survives every preview');}
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('Shift and Control select draft regions for a shared finish update',()=>{
 const f=fixture({globals:{ExteriorMaterials:{brick:{label:'Brick'}}}});f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));const d=f.d(),a=S.add(d,{x:2,y:0,z:0}),b=S.add(d,{x:2,y:4,z:0});S.connect(d,[a,b]);
 const click=(x,mods={})=>{const e={...f.e(x,2),...mods};f.editor.down(e);f.listeners.pointerup(e);};click(1);click(3,{shiftKey:true});f.editor.materialCommand('brick');assert.ok(d.faces.every(f=>f.material==='brick'));click(1,{ctrlKey:true});f.editor.colorCommand('#123456');assert.equal(f.d().faces.filter(f=>f.finishColor==='#123456').length,1,f.message()+JSON.stringify(f.d().faces));
});


test('typing on a selected sticker sets final height and repeated input does not accumulate',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js');
 for(const type of ['window','door']){
  const f=stickerFixture(type,[2,1.6]),feature=f.d().faces.find(f=>f.feature),points=feature.points.map(p=>({x:p.x,y:0,z:p.y})),original=F.dimensions(points,feature.feature),floor=Math.min(...points.map(p=>p.z)),before=JSON.stringify(f.state.wallEdits);
  const input=f.editor.distanceInput();assert.equal(input.label,'Height');assert.ok(Math.abs(input.amount-original.height*F.FT)<1e-8);
  input.set(6*F.FT);const token=f.editor.distanceInput().token;assert.equal(token,input.token,'keep the typed buffer through tool activation');
  const size=()=>{const face=f.state.wallEdits.$surfaces.find(f=>f.feature);return F.dimensions(face.points,face.feature);};
  assert.ok(Math.abs(size().height-6)<1e-8,f.message());assert.ok(Math.abs(size().width-original.width)<1e-8);
  f.editor.distanceInput().set(5*F.FT);assert.ok(Math.abs(size().height-5)<1e-8);
  const face=f.state.wallEdits.$surfaces.find(f=>f.feature);assert.ok(Math.abs(Math.min(...face.points.map(p=>p.z))-floor)<1e-8);
  f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 }
});


test('M cycling on either sticker edge keeps positive typed heights on the original side',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js');
 for(const side of ['top','bottom'])for(const cycles of [0,1,2,3]){
  const f=stickerFixture('window',[2,2]),feature=f.d().faces.find(f=>f.feature),ys=feature.points.map(p=>p.y),edgeY=side==='top'?Math.max(...ys):Math.min(...ys),fixedY=side==='top'?Math.min(...ys):Math.max(...ys),before=JSON.stringify(f.state.wallEdits);
  f.editor.pickLine3D(f.e(2,edgeY));f.listeners.pointerup(f.e(2,edgeY));f.listeners.pointermove(f.e(2,edgeY));f.editor.key({key:'m'});
  for(let i=0;i<cycles;i++)f.editor.key({key:'m'});
  const input=f.editor.distanceInput();assert.equal(input.label,'Height',side+' '+cycles+' '+f.message());input.set(6*F.FT);
  const face=f.state.wallEdits.$surfaces.find(f=>f.feature),dimensions=F.dimensions(face.points,face.feature);assert.ok(Math.abs(dimensions.height-6)<1e-8,side+' '+cycles+' '+f.message());
  assert.ok(face.points.some(p=>Math.abs(p.z-fixedY)<1e-8));assert.ok(face.points.every(p=>side==='top'?p.z>=fixedY-1e-8:p.z<=fixedY+1e-8));
  f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 }
});


test('copying a selected draft sticker includes its geometry without selecting points',()=>{
 const f=stickerFixture(),before=JSON.stringify(f.state.wallEdits),feature=f.d().faces.find(f=>f.feature);
 assert.equal(f.editor.pointSelection().length,0);f.editor.clipboardCommand('copy');const clip=f.clipboard();assert.ok(clip,f.message());
 assert.equal(clip.faces.length,1);assert.equal(clip.points.length,feature.points.length);assert.equal(clip.edges.length,feature.points.length);assert.equal(clip.faces[0].feature.type,'window');assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,1);
});

test('copying a sticker group retains spacing and supports the existing paste transformations',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,z)=>({x,y:0,z}),globals=renderGlobals();let hit=0;
 globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){return ms[hit]?[{object:ms[hit]}]:[];}};
 const stickers=[0,3].map((x,i)=>({id:'sticker'+i,feature:{type:i?'door':'window',axis:p(1,0)},material:'brick',points:[p(x,1),p(x+1,1),p(x+1,2),p(x,2)]})),host={id:'host',points:[p(-10,-10),p(20,-10),p(20,20),p(-10,20)]},state={displayMode:'textured',wallEdits:{$surfaces:[...stickers,host]}},f=fixture({state,walls:[],selected:null,globals,featureHost:()=>({solid:host,points:host.points})});
 const click=(i,mods={})=>{hit=i;f.editor.draw3D({add(){}},p=>p);const e={...f.e(i*3+.5,1.5),...mods};f.editor.pickSolid(e);f.listeners.pointerup(e);};
 click(0);click(1,{shiftKey:true});click(2,{shiftKey:true});const before=JSON.stringify(state.wallEdits);f.editor.key({key:'c',ctrlKey:true});const clip=f.clipboard();assert.ok(clip,f.message());assert.equal(clip.faces.length,2,'ordinary host face is not included');assert.equal(clip.points.length,8);assert.equal(clip.edges.length,8);assert.equal(JSON.stringify(state.wallEdits),before);
 const center=f=>f.points.reduce((v,p)=>v+p.x/f.points.length,0);assert.equal(center(clip.faces[1])-center(clip.faces[0]),3);
 const equivalent=W.copyGeometry(stickers,stickers.flatMap(f=>f.points));assert.deepEqual(clip.points,equivalent.points);assert.equal(clip.faces[0].feature.type,'window');assert.equal(clip.faces[1].feature.type,'door');
 f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(8,6));assert.equal(f.editor.interaction(),'Paste geometry');
 for(const key of ['r','t','y','m']){f.editor.key({key});f.listeners.pointermove(f.e(8,6));assert.equal(f.editor.interaction(),'Paste geometry');}
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 click(0,{ctrlKey:true});f.editor.clipboardCommand('copy');assert.equal(f.clipboard().faces.length,1);assert.equal(f.clipboard().faces[0].feature.type,'door');
});

test('M moves both selected contained stickers on their face and cancels or commits the whole group',()=>{
 for(const reverse of [false,true]){
  const f=stickerFixture('window',[1,2.7]);f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(1,1));f.editor.down(f.e(1,1));
  const centers=f.d().faces.filter(s=>s.feature).map(s=>B.center(s));assert.equal(centers.length,2);if(reverse)centers.reverse();
  for(const [i,p] of centers.entries()){const e=f.e(p.x,p.y,i>0);f.editor.down(e);f.listeners.pointerup(e);}
  assert.equal(f.message(),'2 faces selected');const before=JSON.stringify(f.state.wallEdits),history=f.history.length;
  const original=f.d().faces.filter(s=>s.feature).map(s=>s.points.map(p=>({x:p.x,y:0,z:p.y})));
  const start=centers[1];f.listeners.pointermove(f.e(start.x,start.y));f.editor.key({key:'m'});
  assert.equal(f.editor.interaction(),'Transform geometry');assert.match(f.message(),/Free on face/);
  f.listeners.pointermove(f.e(start.x+.4,start.y));
  const moved=f.state.wallEdits.$surfaces.filter(s=>s.feature&&!s.deleted&&!s.drafted);assert.equal(moved.length,2,f.message());
  for(const [i,face] of moved.entries())for(const [j,p] of face.points.entries()){assert.ok(Math.abs(p.x-original[i][j].x-.4)<1e-8,f.message());assert.equal(p.z,original[i][j].z);assert.equal(p.y,0);}
  f.editor.key({key:'m'});assert.match(f.message(),/Left\/Right/);f.editor.key({key:'m'});assert.match(f.message(),/Up\/Down/);
  f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,history);
  f.editor.key({key:'m'});f.listeners.pointermove(f.e(start.x+.8,start.y));f.editor.key({key:'Enter'});assert.equal(f.history.length,history+1);assert.equal(f.editor.busy(),false);
  const committed=f.state.wallEdits.$surfaces.filter(s=>!s.deleted&&!s.drafted);assert.equal(committed.filter(s=>s.feature).length,2);assert.ok(committed.every(s=>s.points.every(p=>p.y===0)),'movement creates no extrusion sides');
 }
});

test('an ordinary selected face still cannot be copied without point selection',()=>{
 const f=fixture();f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));f.editor.clipboardCommand('copy');assert.equal(f.clipboard(),undefined);assert.equal(f.editor.pointSelection().length,0);
});


test('rendered sticker face selection does not require a second plane projection',()=>{
 let miss=false;const globals=renderGlobals(),f=fixture({globals,projectPoint:(d,e)=>miss?null:{x:e.clientX/100,y:e.clientY/100,z:0}});
 f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));const d=f.d();d.faces[0].feature={type:'window'};
 f.editor.clear();f.editor.draw3D({add(){}},p=>p);miss=true;
 for(let i=0;i<3;i++){assert.ok(f.editor.pickSolid(f.e(2,2)));assert.equal(f.editor.interaction(),null,'a press is not yet a rectangle drag');f.listeners.pointerup(f.e(2,2));assert.equal(f.editor.featureSelection()?.f.id,d.faces[0].id);}
 assert.equal(f.history.length,0);
});

test('rectangle selection status begins only after crossing the drag threshold',()=>{
 const f=fixture();let clicks=0;f.editor.startBox(f.e(1,1),()=>clicks++);assert.equal(f.editor.interaction(),null);f.listeners.pointermove(f.e(1.01,1.01));assert.equal(f.editor.interaction(),null);f.listeners.pointerup(f.e(1.01,1.01));assert.equal(clicks,1);
 f.editor.startBox(f.e(1,1));f.listeners.pointermove(f.e(2,2));assert.equal(f.editor.interaction(),'Rectangle selection');f.listeners.pointerup(f.e(2,2));assert.equal(f.editor.interaction(),null);
});

test('selected material, sticker and chimney solid faces show fill, outline and selection count',()=>{
 for(const extra of [{material:'siding',finishColor:'#557799'},{feature:{type:'window',axis:{x:1,y:0,z:0}}},{chimney:true}]){
  const points=[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],face={id:'front',points,...extra};
  const f=fixture({state:{wallEdits:{$surfaces:[face]}},walls:[],selected:null,globals:{...renderGlobals(),WallChimneys:{COLOR:'#997766',visibleParts:f=>[f]}}}),objects=[],draw=()=>{objects.length=0;f.editor.draw3D({add:o=>objects.push(o)},p=>p);};
  draw();const baseColor=objects.find(o=>o.userData.solidId==='front').material.color;const click=f.e(2,2);assert.ok(f.editor.pickSolid(click));f.listeners.pointerup(click);draw();
  assert.equal(objects.find(o=>o.userData.solidId==='front').material.color,baseColor);assert.equal(objects.find(o=>o.userData.solidId==='front').userData.exteriorSelected,true);
  const outline=objects.find(o=>o.userData.exteriorSelection);assert.ok(outline);assert.equal(outline.geometry.points.length,5);assert.equal(outline.material.depthTest,false);
  assert.equal(f.message(),'1 face selected');assert.equal(f.editor.featureSelection().solid.id,'front');
  f.editor.clear();draw();assert.equal(objects.some(o=>o.userData.exteriorSelection),false);
 }
});

test('sticker face and four corners nudge repeatedly on the host plane with exact keyboard steps',()=>{
 for(const selectPoints of [false,true]){
  const p=(x,z)=>({x,y:0,z}),points=[p(1,1),p(3,1),p(3,3),p(1,3)],host={id:'host',points:[p(0,0),p(8,0),p(8,8),p(0,8)],holes:[points]},sticker={id:'window',points,feature:{type:'window',axis:p(1,0)}};
  const f=fixture({state:{wallEdits:{$surfaces:[sticker,host]}},walls:[],selected:null,globals:renderGlobals()});
  f.editor.draw3D({add(){}},p=>p);
  if(selectPoints){f.editor.startBox(f.e(.5,.5));f.listeners.pointermove(f.e(3.5,3.5));f.listeners.pointerup(f.e(3.5,3.5));assert.equal(f.editor.pointSelection().length,4);}
  else{f.editor.pickSolid(f.e(2,2));f.listeners.pointerup(f.e(2,2));}
  for(const event of [{key:'ArrowRight'},{key:'ArrowRight'},{key:'ArrowUp',shiftKey:true},{key:'ArrowDown',altKey:true}])assert.equal(f.editor.key(event),true);
  const moved=f.state.wallEdits.$surfaces.find(s=>s.feature),inch=.3048/12;
  assert.ok(moved,f.message());assert.ok(Math.abs(moved.points[0].x-1-2*inch)<1e-8,f.message());assert.ok(Math.abs(moved.points[0].z-1+5.75*inch)<1e-8);assert.ok(moved.points.every(p=>p.y===0));assert.equal(f.history.length,4);assert.equal(f.editor.busy(),false);
  assert.deepEqual(f.state.wallEdits.$surfaces.find(s=>s.id==='host').points,host.points);
 }
});

test('selecting a sticker face starts plane movement with M and supports repeated M and cancel',()=>{
 const p=(x,z)=>({x,y:0,z}),face={id:'window',points:[p(1,1),p(3,1),p(3,3),p(1,3)],feature:{type:'window',axis:p(1,0)}};
 const f=fixture({state:{wallEdits:{$surfaces:[face]}},walls:[],selected:null,globals:renderGlobals()});
 f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'m'});assert.equal(f.editor.interaction(),'Transform geometry');assert.match(f.message(),/Free on face/);
 f.listeners.pointermove(f.e(2.5,2));assert.ok(f.state.wallEdits.$surfaces[0].points.every(p=>p.y===0));assert.notEqual(JSON.stringify(f.state.wallEdits),before);
 f.editor.key({key:'m'});assert.match(f.message(),/Left\/Right/);const horizontalStart={...f.state.wallEdits.$surfaces[0].points[0]};f.listeners.pointermove(f.e(3,2.5));assert.equal(f.state.wallEdits.$surfaces[0].points[0].z,horizontalStart.z);assert.ok(f.state.wallEdits.$surfaces[0].points[0].x>horizontalStart.x);
 f.editor.key({key:'m'});assert.match(f.message(),/Up\/Down/);const verticalStart={...f.state.wallEdits.$surfaces[0].points[0]};f.listeners.pointermove(f.e(3.5,3));assert.equal(f.state.wallEdits.$surfaces[0].points[0].x,verticalStart.x);assert.notEqual(f.state.wallEdits.$surfaces[0].points[0].z,verticalStart.z);
 f.editor.key({key:'m'});assert.match(f.message(),/In\/Out/);f.listeners.pointermove(f.e(3.5,3.4));assert.ok(f.state.wallEdits.$surfaces[0].points.some(p=>Math.abs(p.y)>1e-6),f.message());f.editor.key({key:'m'});assert.match(f.message(),/Free on face/);assert.equal(f.editor.busy(),true);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,0);
});

test('copied sticker preview draws horizontal alignment lines across the window gap and clears on cancel',()=>{
 const p=(x,z)=>({x,y:0,z}),windowFace={id:'window',feature:{type:'window',axis:p(1,0)},points:[p(0,2),p(1,2),p(1,3),p(0,3)]},host={id:'host',points:[p(-10,-10),p(10,-10),p(10,10),p(-10,10)]};
 const f=fixture({state:{wallEdits:{$surfaces:[windowFace,host]}},walls:[],selected:null,globals:renderGlobals(),featureHost:()=>({solid:host,points:host.points})}),objects=[],draw=()=>{objects.length=0;f.editor.draw3D({add:o=>objects.push(o)},p=>p);};
 draw();f.editor.pickSolid(f.e(.5,2.5));f.listeners.pointerup(f.e(.5,2.5));f.editor.clipboardCommand('copy');f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(4,2.56));draw();
 const guides=objects.filter(o=>o.userData.alignmentGuide);assert.equal(guides.length,2,f.message());
 for(const guide of guides){const [a,b]=guide.geometry.points;assert.ok(Math.abs(a.z-b.z)<1e-8);assert.ok(Math.abs(a.x-b.x)>1);assert.equal(guide.material.depthTest,false);assert.equal(guide.material.color,'#FFD700');}
 f.editor.key({key:'Escape'});draw();assert.equal(objects.some(o=>o.userData.alignmentGuide),false);assert.equal(f.history.length,0);
});

test('moving a different-size sticker snaps its bottom to another window and draws a solid bright guide',()=>{
 const p=(x,z)=>({x,y:0,z}),moving={id:'moving',feature:{type:'window',axis:p(1,0)},points:[p(4,2.4),p(6,2.4),p(6,3.9),p(4,3.9)]},other={id:'other',feature:{type:'window'},points:[p(0,2),p(1,2),p(1,3),p(0,3)]},host={id:'host',points:[p(-10,-10),p(10,-10),p(10,10),p(-10,10)]};
 const f=fixture({state:{wallEdits:{$surfaces:[moving,other,host]}},walls:[],selected:null,globals:renderGlobals()}),objects=[],draw=()=>{objects.length=0;f.editor.draw3D({add:o=>objects.push(o)},p=>p);};
 draw();f.editor.pickSolid(f.e(5,3));f.listeners.pointerup(f.e(5,3));f.editor.key({key:'m'});f.listeners.pointermove(f.e(5,2.65));draw();
 const face=f.state.wallEdits.$surfaces.find(s=>s.id==='moving');assert.ok(Math.abs(Math.min(...face.points.map(p=>p.z))-2)<1e-8,f.message());
 const guide=objects.find(o=>o.userData.alignmentGuide&&o.geometry.points.every(p=>Math.abs(p.z-2)<1e-8));assert.ok(guide);assert.equal(guide.material.color,'#FFD700');assert.equal(guide.material.dashSize,undefined);assert.equal(guide.material.depthTest,false);
 f.editor.key({key:'Escape'});draw();assert.equal(objects.some(o=>o.userData.alignmentGuide),false);
});


test('P drawing plane extends a wall beyond its bounds and keeps geometry when toggled off',()=>{
 const f=fixture(),before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'p'});
 assert.equal(f.editor.planeActive(),true);assert.equal(JSON.stringify(f.state.wallEdits),before);
 for(const [x,z]of [[4,0],[6,0],[6,4],[4,4]])planeStep(f,x,z);
 const faces=f.state.wallEdits.$surfaces;assert.equal(faces.length,1);
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),face=faces[0],frame=K.frame(face);
 assert.ok(Math.abs(K.area({points:face.points.map(p=>K.local(frame,p)),holes:[]})-8)<1e-8);
 assert.ok(face.points.every(p=>p.y===0&&p.x>=4));const saved=JSON.stringify(f.state.wallEdits);
 f.editor.key({key:'p'});assert.equal(f.editor.planeActive(),false);assert.equal(JSON.stringify(f.state.wallEdits),saved);
 const loaded=fixture({state:JSON.parse(JSON.stringify(f.state))});assert.equal(loaded.state.wallEdits.$surfaces.length,1);assert.equal(loaded.editor.planeActive(),false);
 assert.ok(f.history.length>=4);
});

test('plane drawing creates detached closed faces and retains unfinished lines',()=>{
 const f=fixture();f.editor.key({key:'p'});
 for(const [x,z]of [[6,0],[8,0],[8,2],[6,2],[6,0]])planeStep(f,x,z);
 assert.equal(f.state.wallEdits.$surfaces.length,1);f.editor.key({key:'n'});
 f.editor.doubleClick(f.e(10,1));planeStep(f,12,1);f.editor.key({key:'p'});
 assert.ok(f.state.wallEdits.$loose.edges.some(pair=>pair.every(p=>p.z===1)&&pair.some(p=>p.x===12)));
 assert.equal(f.state.wallEdits.$surfaces.length,1);
});

test('plane snaps to other coplanar model geometry but ignores off-plane points',()=>{
 const f=fixture({state:{wallEdits:{$loose:{points:[{x:6,y:0,z:2},{x:7,y:1,z:2}],edges:[]}}}});
 f.editor.key({key:'p'});f.editor.doubleClick(f.e(6.03,2.02));
 assert.ok(f.state.wallEdits.$loose.points.some(p=>p.x===6&&p.y===0&&p.z===2));
 assert.ok(!f.state.wallEdits.$loose.points.some(p=>p.x===6.03));
 f.editor.doubleClick(f.e(7.03,2.02));
 assert.ok(f.state.wallEdits.$loose.points.some(p=>Math.abs(p.x-7.03)<1e-8&&p.y===0));
});

test('working plane renders as a transient guide and repeated P does not flicker',()=>{
 const f=fixture({globals:renderGlobals()}),objects=[];f.editor.key({key:'p'});f.editor.key({key:'p',repeat:true});
 f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.userData.workingPlane));
 assert.equal(f.state.wallEdits.$surfaces,undefined);f.editor.key({key:'p'});objects.length=0;
 f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(!objects.some(o=>o.userData.workingPlane));
});

test('P requires a planar face and cannot adopt a curved surface',()=>{
 const f=fixture({selected:null,walls:[]});f.editor.key({key:'p'});assert.equal(f.editor.planeActive(),false);assert.match(f.message(),/Select a flat face/);
 f.editor.togglePlane({points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:1}],curvedSurface:{logical:true}});assert.equal(f.editor.planeActive(),false);
});

test('Keep Size assigns a type to all selected unequal solid faces in one undo',()=>{
 const globals=renderGlobals();let hit=0;globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){return ms[hit]?[{object:ms[hit]}]:[];}};
 const p=(x,z)=>({x,y:0,z}),state={wallEdits:{$surfaces:[0,5,10].map((x,i)=>({id:'face'+i,points:[p(x,0),p(x+i+1,0),p(x+i+1,i+2),p(x,i+2)],material:'siding',...(i===2?{feature:{type:'window',shape:'rectangle',axis:p(1,0)}}:{})}))}},f=fixture({state,walls:[],selected:null,globals});
 const click=(i,mods={})=>{hit=i;f.editor.draw3D({add(){}},p=>p);const e={...f.e(i*5+.5,1),...mods};assert.ok(f.editor.pickSolid(e));f.listeners.pointerup(e);};
 click(0);click(1,{shiftKey:true});click(2,{shiftKey:true});click(1,{ctrlKey:true});
 const before=JSON.stringify(state.wallEdits),geometry=state.wallEdits.$surfaces.map(s=>JSON.stringify(s.points));
 assert.ok(f.editor.featureCommand('door',null));assert.deepEqual(state.wallEdits.$surfaces.map(s=>s.feature?.type),['door',undefined,'door']);assert.deepEqual(state.wallEdits.$surfaces.map(s=>JSON.stringify(s.points)),geometry);assert.ok(state.wallEdits.$surfaces.every(s=>s.material==='siding'));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 f.editor.featureCommand('vent',null);assert.deepEqual(state.wallEdits.$surfaces.map(s=>s.feature?.type),['vent',undefined,'vent']);assert.deepEqual(state.wallEdits.$surfaces.map(s=>JSON.stringify(s.points)),geometry);
 f.editor.featureCommand('none',null);assert.ok(state.wallEdits.$surfaces.every(s=>!s.feature));assert.equal(f.history.length,3);
});

test('Keep Size preserves separate draft face dimensions and their selection',()=>{
 const f=fixture();f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));const d=f.d(),a=S.add(d,{x:1,y:0,z:0}),b=S.add(d,{x:1,y:4,z:0});S.connect(d,[a,b]);
 for(const [i,x]of [.5,2.5].entries()){const e=f.e(x,2,i>0);f.editor.down(e);f.listeners.pointerup(e);}
 const before=JSON.stringify(f.state.wallEdits),geometry=JSON.stringify(d.faces.map(s=>s.points));assert.equal(d.faces.length,2);
 f.editor.featureCommand('window',null);assert.ok(f.d().faces.every(s=>s.feature?.type==='window'));assert.equal(JSON.stringify(f.d().faces.map(s=>s.points)),geometry);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 f.editor.featureCommand('door',null);assert.ok(f.d().faces.every(s=>s.feature?.type==='door'));assert.equal(JSON.stringify(f.d().faces.map(s=>s.points)),geometry);assert.equal(f.history.length,2);
});

test('closing a loop on the working plane partitions an existing face without duplicate area',()=>{
 const f=fixture();f.editor.key({key:'p'});
 for(const [x,z]of [[1,1],[3,1],[3,3],[1,3],[1,1]])planeStep(f,x,z);
 const faces=f.state.wallEdits.$surfaces.filter(f=>!f.deleted),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 assert.equal(faces.length,2);assert.ok(f.d().faces.every(f=>f.solidId));
 const areas=faces.map(f=>{const frame=K.frame(f);return K.area({points:f.points.map(p=>K.local(frame,p)),holes:f.holes.map(r=>r.map(p=>K.local(frame,p)))});});
 assert.deepEqual(areas.sort((a,b)=>a-b),[4,12]);
});

test('drawing on a tilted face plane keeps new geometry on that exact plane',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),source={id:'tilted',points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:2,z:2},{x:0,y:2,z:2}]},frame=K.frame(source);
 const f=fixture({selected:null,walls:[],state:{wallEdits:{$surfaces:[source]}},projectPoint:(d,e)=>({x:e.clientX/100,y:e.clientY/100,z:0}),screen:p=>{const q=K.local(frame,p);return {x:q.x*100,y:q.y*100};}});
 f.editor.togglePlane(source);for(const [x,y]of [[6,6],[8,6],[8,8],[6,8],[6,6]])planeStep(f,x,y);
 const created=f.state.wallEdits.$surfaces.find(f=>f.id!=='tilted');assert.ok(created);
 assert.ok(created.points.every(p=>Math.abs(K.local(frame,p).z)<1e-8));
});


test('plane drawing on a horizontal base partitions covered area without adding overlapping wall faces',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),source={id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:4,z:0},{x:0,y:4,z:0}]};
 const f=fixture({selected:null,walls:[],state:{base:{faces:[source]},wallEdits:{}},projectPoint:(d,e)=>({x:e.clientX/100,y:e.clientY/100,z:0}),screen:p=>({x:p.x*100,y:p.y*100})});
 f.editor.togglePlane(source);for(const [x,y]of [[1,1],[3,1],[3,3],[1,3],[1,1]])planeStep(f,x,y);
 assert.ok(f.state.wallEdits.$base?.faces.length>1,f.message());assert.equal(f.state.wallEdits.$surfaces.length,0);
 assert.ok(Math.abs(f.state.wallEdits.$base.faces.reduce((sum,f)=>sum+K.area(f),0)-16)<1e-8);
 assert.ok(f.state.wallEdits.$base.faces.every(f=>!f.holes?.length));
});

function planeStep(f,x,y){if(!f.editor.pointSelection().length)f.editor.doubleClick(f.e(x,y));else{f.editor.key({key:'n'});f.editor.down(f.e(x,y));}}

test('plane selection passes through off-plane geometry and C connects every pair in one commit',()=>{
 const f=fixture({pickVisible:()=>false,state:{wallEdits:{$loose:{points:[{x:6,y:1,z:0}],edges:[]}}}});f.editor.key({key:'p'});
 const click=(x,y,shift=false)=>{const e=f.e(x,y,shift);f.editor.down(e);f.listeners.pointerup(e);};
 const before=JSON.stringify(f.state.wallEdits);click(10,10);assert.equal(JSON.stringify(f.state.wallEdits),before);
 for(const [x,y]of [[6,0],[8,0],[8,2],[6,2]])f.editor.doubleClick(f.e(x,y));
 click(6,0);click(8,0,true);click(8,2,true);click(6,2,true);assert.equal(f.editor.pointSelection().length,4);assert.ok(f.editor.pointSelection().every(p=>p.y===0));
 const h=f.history.length;f.editor.key({key:'c'});assert.equal(f.history.length,h+1);
 assert.equal(f.state.wallEdits.$surfaces.length,4,'both diagonals partition the square');assert.equal(f.state.wallEdits.$loose.edges.length,6);click(6,2);click(6,0,true);f.editor.key({key:'c'});assert.equal(f.state.wallEdits.$surfaces.length,4);
});

test('plane rectangular selection filters points and N connects every selected point',()=>{
 const f=fixture({state:{wallEdits:{$loose:{points:[{x:6,y:0,z:0},{x:8,y:0,z:0},{x:7,y:1,z:0}],edges:[]}}}});f.editor.key({key:'p'});
 f.editor.down(f.e(5,-1));f.listeners.pointerup(f.e(9,1));assert.equal(f.editor.pointSelection().length,2);
 const h=f.history.length;f.editor.key({key:'n'});f.editor.down(f.e(7,3));assert.equal(f.history.length,h+1);assert.equal(f.state.wallEdits.$loose.edges.length,2);assert.equal(f.editor.pointSelection().length,1);
 f.editor.setPlaneDisplay('hidden');assert.equal(f.editor.planeView().display,'hidden');f.editor.setPlaneDisplay('normal');assert.equal(f.editor.planeView().display,'normal');
 const saved=JSON.stringify(f.state.wallEdits);f.editor.key({key:'p'});assert.equal(JSON.stringify(f.state.wallEdits),saved);
});

test('plane Q supports one corner rotation and two-point edges outside the original face',()=>{
 const f=fixture();f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,0));f.editor.key({key:'q'});f.editor.down(f.e(8,2));f.editor.doubleClick(f.e(8,2));
 assert.equal(f.state.wallEdits.$surfaces.length,1,f.message());assert.equal(f.state.wallEdits.$surfaces[0].points.length,4);
 f.editor.doubleClick(f.e(10,0));f.editor.doubleClick(f.e(12,0));const e=f.e(10,0,true);f.editor.down(e);f.listeners.pointerup(e);f.editor.key({key:'q'});f.editor.down(f.e(12,2));
 assert.equal(f.state.wallEdits.$surfaces.length,2,f.message());
 const before=JSON.stringify(f.state.wallEdits);f.editor.doubleClick(f.e(15,0));const created=JSON.stringify(f.state.wallEdits);f.editor.key({key:'q'});f.listeners.pointermove(f.e(17,2));f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),created);assert.notEqual(created,before);
});

test('plane S persists an analytic arc outside the source face and C closes its region',()=>{
 const f=fixture();f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,0));f.editor.key({key:'s'});f.editor.down(f.e(7,0));f.listeners.pointermove(f.e(7,1));f.editor.down(f.e(7,1));
 const d=Object.values(f.state.wallEdits.$drafts||{}).find(d=>d.constructionPlane);assert.ok(d,f.message());assert.equal(d.sketch.curves.length,1);assert.equal(d.sketch.edges.length,1);assert.equal(d.sketch.nodes.length,3);
 const e=f.e(6,0,true);f.editor.down(e);f.listeners.pointerup(e);f.editor.key({key:'c'});assert.equal(f.state.wallEdits.$surfaces.length,1,f.message());assert.equal(f.state.wallEdits.$surfaces[0].curves.length,1);
 const saved=JSON.stringify(f.state.wallEdits);f.editor.key({key:'s'});f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),saved);f.editor.key({key:'p'});assert.equal(JSON.stringify(f.state.wallEdits),saved);
});

test('plane grid stays visible while snap previews appear only during placement',()=>{
 const f=fixture({globals:renderGlobals()});f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,0));
 const draw=()=>{const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);return objects.filter(o=>o.userData.planeGuide);};
 f.listeners.pointermove(f.e(8,0));assert.ok(draw().some(o=>o.material.color==='#31606b'));assert.ok(!draw().some(o=>o.material.color==='#FFD700'));
 f.editor.key({key:'n'});f.listeners.pointermove(f.e(8,0));assert.ok(draw().some(o=>o.material.color==='#FFD700'));assert.ok(draw().some(o=>o.material.color==='#31606b'));
 f.editor.key({key:'escape'});f.listeners.pointermove(f.e(9,0));assert.ok(draw().some(o=>o.material.color==='#31606b'));assert.ok(!draw().some(o=>o.material.color==='#FFD700'));
});

test('plane entry accepts the base editor face wrapper for a sloped base',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),face={id:'base',points:[{x:0,y:0,z:0},{x:4,y:0,z:2},{x:4,y:4,z:2},{x:0,y:4,z:0}]},f=fixture({selected:null,walls:[]});
 f.editor.togglePlane({face,event:f.e(2,2)});assert.equal(f.editor.planeActive(),true);assert.ok(face.points.every(p=>Math.abs(K.local(f.editor.planeView().frame,p).z)<1e-8));
});

test('plane S completes a full circle as a face and Shift continues arcs with independent undo',()=>{
 const f=fixture();f.editor.key({key:'p'});f.editor.doubleClick(f.e(6,0));f.editor.key({key:'s'});f.editor.down(f.e(7,0));
 for(const p of [[7,1],[8,0],[7,-1],[6,0]])f.listeners.pointermove(f.e(...p));
 f.editor.down(f.e(6,0));assert.equal(f.state.wallEdits.$surfaces.length,1,f.message());assert.equal(f.state.wallEdits.$surfaces[0].curves.length,1);
 f.editor.doubleClick(f.e(10,0));f.editor.key({key:'s'});f.editor.down(f.e(11,0));f.editor.down(f.e(11,1,true));const before=JSON.stringify(f.state.wallEdits),history=f.history.length;f.listeners.pointermove(f.e(12,0));f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,history);
});


test('selection snapshots restore editable draft points after a committed move and model rollback',()=>{
 const f=fixture();f.editor.doubleClick(f.e(1,1),f.w);f.editor.doubleClick(f.e(3,1),f.w);f.editor.down(f.e(1,1,true));f.listeners.pointerup(f.e(1,1,true));
 const clone=v=>JSON.parse(JSON.stringify(v)),selection=clone(f.editor.selectionSnapshot()),before=clone(f.state.wallEdits);assert.equal(selection.picked.length,2);
 f.listeners.pointermove(f.e(1,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.2,1.2));f.editor.down(f.e(1.2,1.2));f.listeners.pointerup(f.e(1.2,1.2));assert.notDeepEqual(clone(f.state.wallEdits),before);
 f.editor.clear();f.state.wallEdits=clone(before);f.editor.restoreSelection(selection);assert.deepEqual(clone(f.editor.selectionSnapshot()),selection);
 f.listeners.pointermove(f.e(1,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.3,1.3));assert.notDeepEqual(clone(f.state.wallEdits),before,'restored selection is usable by the next move');f.editor.key({key:'escape'});
});


test('Auto wall trim uses the chosen six or eight inch width',()=>{
 for(const inches of [6,8]){const walls=[{id:'front',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:3},{x:4,y:0,z:3}]},{id:'side',bottom:[{x:4,y:0,z:0},{x:4,y:4,z:0}],top:[{x:4,y:0,z:3},{x:4,y:4,z:3}]}],f=fixture({walls});assert.equal(f.editor.autoTrim(inches*.0254),true,f.message());const trims=f.state.wallEdits.$surfaces.filter(f=>f.trim);assert.ok(trims.length);for(const face of trims)assert.ok(Math.abs(face.trimData.layers.at(-1).width-inches*.0254)<1e-9);assert.equal(f.history.length,1);}
});


test('G places a full-height garage from a low pointer on a seven-foot wall',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js');let f;f=fixture({featureHost:()=>{const d=f.d();return {d,f:d.faces[0],points:d.faces[0].points.map(p=>({x:p.x,y:0,z:p.y}))};}});
 f.w.bottom=[{x:0,y:0,z:0},{x:20*F.FT,y:0,z:0}];f.w.top=f.w.bottom.map(p=>({...p,z:7*F.FT}));f.editor.beginFace(f.e(3,1),f.w);f.listeners.pointerup(f.e(3,1));const before=JSON.stringify(f.state.wallEdits);
 assert.equal(f.editor.key({key:'g'}),true);assert.equal(f.editor.featurePlacement().index,2);f.listeners.pointermove(f.e(10*F.FT,.1));assert.match(f.message(),/Garage door.*click to place/);assert.equal(JSON.stringify(f.state.wallEdits),before,'preview must not change geometry');f.editor.down(f.e(10*F.FT,.1));const door=f.d().faces.find(f=>f.feature?.type==='garage');assert.ok(door,f.message());const b=F.bounds(door.points);assert.ok(Math.abs(b.bottom)<1e-8);assert.ok(Math.abs(b.top-7*F.FT)<1e-8);assert.ok(Math.abs(b.right-b.left-8*F.FT)<1e-8);assert.equal(f.history.length,1);assert.equal(f.editor.busy(),false);
});

test('marquee redraw does not rebuild selected geometry for every face or material query',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');let builds=0;
 const p=(x,z)=>({x,y:0,z}),faces=Array.from({length:30},(_,i)=>({id:'face'+i,points:[p(i*2,0),p(i*2+1,0),p(i*2+1,1),p(i*2,1)]}));
 const f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:faces}},globals:{...renderGlobals(),WallSolidGeometry:{...W,surfaceWire(edits){builds++;return W.surfaceWire(edits);}}}});
 f.editor.startBox(f.e(-1,-1));f.listeners.pointermove(f.e(65,2));f.listeners.pointerup(f.e(65,2));assert.match(f.message(),/120 points selected/);
 builds=0;for(let i=0;i<5;i++)f.editor.activeMaterial();assert.equal(builds,0,'material UI must not resolve points when no face is selected');
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(builds<=3,'a redraw must not rebuild the wire graph per face');assert.equal(objects.filter(o=>o.userData.solidId).length,30);
 builds=0;const subtract={...f.e(-1,-1),ctrlKey:true};f.editor.startBox(subtract);f.listeners.pointermove(f.e(65,2));f.listeners.pointerup(f.e(65,2));assert.match(f.message(),/0 points selected/);assert.ok(builds<=3,'subtraction builds a lookup once, not once per selected point');
});

test('marquee only performs visibility tests on points inside its screen bounds',()=>{
 let checks=0;const p=(x,z)=>({x,y:0,z}),f=fixture({walls:[],selected:null,state:{translucent:false,wallEdits:{$surfaces:[{id:'outside',points:[p(10,10),p(11,10),p(11,11),p(10,11)]}]}},pickVisible:()=>{checks++;return true;}});
 f.editor.startBox(f.e(0,0));f.listeners.pointermove(f.e(2,2));f.listeners.pointerup(f.e(2,2));assert.equal(checks,0);assert.match(f.message(),/0 points selected/);
});

test('M moves a single-face outer wall edge inward and outward on its supporting plane',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(0,0),p(4,0),p(4,4),p(0,4)],state={wallEdits:{$surfaces:[{id:'wall',points}]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true}}),before=JSON.stringify(state.wallEdits);
 f.editor.pickLine3D(f.e(4,2));f.listeners.pointerup(f.e(4,2));f.listeners.pointermove(f.e(4,2));f.editor.key({key:'m'});assert.equal(f.editor.interaction(),'Move line');
 const right=()=>state.wallEdits.$surfaces.find(f=>f.id==='wall').points.slice(1,3);
 f.listeners.pointermove(f.e(3,2));assert.ok(right().every(p=>Math.abs(p.x-3)<1e-8),f.message());
 f.listeners.pointermove(f.e(5,2));assert.ok(right().every(p=>Math.abs(p.x-5)<1e-8&&p.y===0),f.message());
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.beginEntity('move',{pair:[points[1],points[2]],event:f.e(4,2)});f.listeners.pointermove(f.e(5,2));f.editor.down(f.e(5,2));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.ok(right().every(p=>Math.abs(p.x-5)<1e-8));
});

test('axis plane rotation accepts exact angles, locks a line axis and confirms before drawing',()=>{
 const f=fixture({walls:[],selected:null}),points=[{x:1,y:2,z:0},{x:1,y:2,z:4}],before=JSON.stringify(f.state);
 f.editor.togglePlane({axisPoints:points});assert.equal(f.editor.interaction(),'Rotate drawing plane');const input=f.editor.distanceInput();assert.equal(input.unit,'degrees');input.set(9);
 let frame=f.editor.planeView().frame;assert.ok(Math.abs(frame.v.x-Math.cos(9*Math.PI/180))<1e-9);assert.ok(Math.abs(frame.v.y-Math.sin(9*Math.PI/180))<1e-9);
 f.editor.togglePlane();assert.equal(f.editor.distanceInput().amount,9,'P cannot change a line axis');assert.equal(JSON.stringify(f.state),before);
 f.editor.planeDown(f.e(1,2));assert.equal(f.editor.interaction(),'Drawing plane');assert.equal(f.editor.busy(),false);f.editor.togglePlane();assert.equal(f.editor.planeActive(),false);
});
test('one point cycles vertical and horizontal axes and Escape cancels without geometry',()=>{
 const f=fixture({walls:[],selected:null}),before=JSON.stringify(f.state);f.editor.togglePlane({axisPoints:[{x:0,y:0,z:0}]});
 for(const axis of [{x:0,y:0,z:1},{x:1,y:0,z:0},{x:0,y:1,z:0}]){assert.deepEqual(JSON.parse(JSON.stringify(f.editor.planeView().frame.u)),axis);f.editor.togglePlane();}
 f.editor.key({key:'Escape'});assert.equal(f.editor.planeActive(),false);assert.equal(JSON.stringify(f.state),before);
});
test('plane pointer rotation snaps to an incident nine-degree wall and world forty-five degrees',()=>{
 const a=9*Math.PI/180,p=(r,z)=>({x:r*Math.cos(a),y:r*Math.sin(a),z}),f=fixture({walls:[],selected:null,state:{wallEdits:{$surfaces:[{id:'nine',points:[p(0,0),p(4,0),p(4,4),p(0,4)]}]}},screen:p=>({x:p.x*100,y:p.y*100})});
 f.editor.togglePlane({axisPoints:[p(0,0)]});const move=deg=>f.listeners.pointermove(f.e(1.5*Math.cos(deg*Math.PI/180),1.5*Math.sin(deg*Math.PI/180)));
 move(10);assert.ok(Math.abs(f.editor.distanceInput().amount-9)<1e-7,f.message());move(44);assert.equal(f.editor.distanceInput().amount,45);f.editor.distanceInput().set(9.125);move(90);assert.equal(f.editor.distanceInput().amount,9.125);
});

test('drawing a horizontal divider through a placed window creates two typed regions',()=>{
 const f=stickerFixture(),window=f.d().faces.find(f=>f.feature),left=Math.min(...window.points.map(p=>p.x)),right=Math.max(...window.points.map(p=>p.x)),mid=(Math.min(...window.points.map(p=>p.y))+Math.max(...window.points.map(p=>p.y)))/2;
 f.editor.doubleClick(f.e(left,mid),f.w);f.editor.key({key:'n'});f.editor.down(f.e(right,mid));f.listeners.pointerup(f.e(right,mid));
 const children=f.d().faces.filter(f=>f.feature);assert.equal(children.length,2,JSON.stringify(f.d().faces));assert.ok(children.every(f=>f.feature.type==='window'));
});

test('a standalone window boundary uses the same typed draft and deleting its divider preserves the window',()=>{
 const p=(x,z)=>({x,y:0,z}),state={wallEdits:{$surfaces:[{id:'window',feature:{type:'window',preset:0,axis:p(1,0)},points:[p(0,0),p(3,0),p(3,6),p(0,6)]}]}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()}),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
 f.editor.restoreSelection({preferredSolid:'window',selectedSolid:'window'});f.editor.doubleClick(f.e(0,2));f.editor.key({key:'n'});f.editor.down(f.e(3,2));f.listeners.pointerup(f.e(3,2));
 let faces=M.collect(state);assert.equal(faces.length,2);assert.ok(faces.every(f=>f.feature?.type==='window'));
 f.editor.clear();f.editor.draw3D({add(){}},p=>p);assert.ok(f.editor.pickLine3D(f.e(1.5,2)));f.listeners.pointerup(f.e(1.5,2));f.editor.key({key:'Delete'});
 faces=M.collect(state);assert.equal(faces.length,1,f.message());assert.equal(faces[0].feature?.type,'window');
});

test('an extruded window-edge point supports N and V on the window rather than the wall behind it',()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model.js'),p=(x,z)=>({x,y:0,z});
 for(const key of ['n','v']){const state={wallEdits:{$surfaces:[{id:'wall',points:[p(-1,-1),p(4,-1),p(4,4),p(-1,4)]},{id:'window',feature:{type:'window'},points:[p(0,0),p(3,0),p(3,3),p(0,3)]}]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true}});
 f.editor.beginEntity('extrude',{point:p(0,3),event:f.e(0,3)});f.listeners.pointermove(f.e(1.5,3));f.editor.down(f.e(1.5,3));assert.equal(f.editor.busy(),false,f.message());
 f.editor.key({key});assert.equal(f.editor.busy(),true,f.message());f.editor.down(f.e(1.5,0));
 const windows=M.collect(state).filter(f=>f.feature?.type==='window');assert.equal(windows.length,2,key+': '+f.message());assert.ok(windows.every(f=>Math.max(...f.points.map(p=>p.x))-Math.min(...f.points.map(p=>p.x))<=1.5001));
 }
});

test('sticker placement includes loose coplanar point guides and excludes points behind the wall',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),host={id:'wall',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]};let targets;
 const state={wallEdits:{$surfaces:[host],$loose:{points:[{x:1,y:0,z:0},{x:1.06,y:1,z:0}],edges:[]}}},f=fixture({state,walls:[],selected:null,featureHost:()=>({solid:host,points:host.points}),globals:{WallFeatures:{...F,placeGroup(...args){targets=args[1];return F.placeGroup(...args);}}}});
 f.editor.featureCommand('garage',2,true);f.listeners.pointermove(f.e(2.25,1));assert.ok(targets.some(r=>r.length===1&&Math.abs(r[0].x-1)<1e-8));assert.ok(!targets.some(r=>r.length===1&&Math.abs(r[0].x-1.06)<1e-8));
});

test('moving a sticker carries its original draft corner nodes instead of leaving snapped anchors',()=>{
 const f=stickerFixture(),d=f.d(),face=d.faces.find(f=>f.feature),corner={...face.points[0]},before=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.3,2.2));
 const node=f.d().sketch.nodes.find(n=>n.id===corner.nodeId);assert.ok(Math.hypot(node.x-corner.x,node.y-corner.y)>.1,f.message());
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('typing in mounted sticker Free mode locks horizontally and preserves the input session',()=>{
 const f=stickerFixture(),before=JSON.stringify(f.state.wallEdits),center=()=>B.center(f.d().faces.find(f=>f.feature)),start=center();
 f.editor.key({key:'m'});const input=f.editor.distanceInput();input.set(.3);
 assert.match(f.message(),/^Left\/Right/);assert.equal(f.editor.distanceInput().token,input.token);assert.equal(f.editor.distanceInput().axis,input.axis);
 input.set(.35);assert.ok(Math.abs(center().x-start.x-.35)<1e-8);assert.equal(center().y,start.y);
 f.editor.key({key:'m'});assert.match(f.message(),/^Up\/Down/);f.editor.distanceInput().set(.2);assert.ok(Math.abs(Math.abs(center().y-start.y)-.2)<1e-8);assert.equal(center().x,start.x);
 f.editor.key({key:'m'});assert.match(f.message(),/^In\/Out/);f.editor.key({key:'m'});assert.match(f.message(),/^Free on face/);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('one or multiple solid stickers share four move modes and accept exact distances',()=>{
 for(const count of [1,2]){
  const p=(x,z)=>({x,y:0,z}),faces=Array.from({length:count},(_,i)=>({id:'window'+i,points:[p(1+4*i,1),p(3+4*i,1),p(3+4*i,3),p(1+4*i,3)],feature:{type:'window',axis:p(1,0)}}));
  const f=fixture({state:{wallEdits:{$surfaces:faces}},walls:[],selected:null,globals:renderGlobals()});f.editor.draw3D({add(){}},p=>p);
  for(let i=0;i<count;i++){const e=f.e(2+4*i,2,i>0);f.editor.pickSolid(e);f.listeners.pointerup(e);}
  f.listeners.pointermove(f.e(2,2));const before=JSON.stringify(f.state.wallEdits);f.editor.geometryCommand('m',{points:faces.flatMap(f=>f.points)});assert.match(f.message(),/Free on face/);
  const input=f.editor.distanceInput();assert.ok(input);input.set(.3);assert.match(f.message(),/Left\/Right/);assert.equal(f.editor.distanceInput().token,input.token);input.set(.35);
  for(let i=0;i<count;i++){const point=f.state.wallEdits.$surfaces.find(s=>s.id===faces[i].id).points[0];assert.ok(Math.abs(point.x-(1+4*i)-.35)<1e-8,f.message()+' '+JSON.stringify(point));assert.equal(point.z,1);}
  f.editor.key({key:'m'});assert.match(f.message(),/Up\/Down/);assert.equal(JSON.stringify(f.state.wallEdits),before,'switching modes discards the horizontal preview');f.editor.distanceInput().set(.2);
  for(let i=0;i<count;i++){const face=f.state.wallEdits.$surfaces[i];assert.ok(Math.abs(Math.abs(face.points[0].z-1)-.2)<1e-8);assert.equal(face.points[0].x,1+4*i);}
  f.editor.key({key:'m'});assert.match(f.message(),/In\/Out/);assert.equal(JSON.stringify(f.state.wallEdits),before,'switching modes discards the vertical preview');f.editor.distanceInput().set(.15);
  for(const face of f.state.wallEdits.$surfaces)assert.ok(Math.abs(Math.abs(face.points[0].y)-.15)<1e-8,f.message());
  f.editor.key({key:'m'});assert.match(f.message(),/Free on face/);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
 }
});

test('moving a mounted sticker carries a coincident loose anchor and cancel restores it',()=>{
 const f=stickerFixture(),corner=f.d().faces.find(f=>f.feature).points[0];f.state.wallEdits.$loose={points:[{x:corner.x,y:0,z:corner.y}],edges:[]};const before=JSON.stringify(f.state.wallEdits);
 f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.editor.distanceInput().set(.3);
 const anchor=f.state.wallEdits.$loose.points[0];assert.ok(Math.abs(anchor.x-corner.x-.3)<1e-8);assert.equal(anchor.z,corner.y);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('moving a drafted host wall carries its interior window and Escape restores both',()=>{
 const f=stickerFixture(),before=JSON.stringify(f.state.wallEdits);f.editor.beginFace(f.e(.5,2),f.w);f.listeners.pointerup(f.e(.5,2));f.listeners.pointermove(f.e(.5,2));f.editor.key({key:'m'});f.editor.distanceInput().set(.3);
 const windows=(f.state.wallEdits.$surfaces||[]).filter(s=>s.feature?.type==='window');assert.ok(windows.length,f.message());assert.ok(windows.some(s=>s.points.every(p=>Math.abs(Math.abs(p.y)-.3)<1e-7)),f.message());
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});


test('moving a sticker aligns to an inset garage edge and a perpendicular window height',()=>{
 const p=(x,y,z)=>({x,y,z}),moving={id:'moving',feature:{type:'window'},points:[p(1,0,1),p(2,0,1),p(2,0,2),p(1,0,2)]},garage={id:'garage',feature:{type:'garage'},points:[p(3,.4,0),p(5,.4,0),p(5,.4,3),p(3,.4,3)]},side={id:'side',feature:{type:'window'},points:[p(8,1,2.5),p(8,3,2.5),p(8,3,4),p(8,1,4)]};
 const f=fixture({state:{wallEdits:{$surfaces:[moving,garage,side]}},walls:[],selected:null,globals:renderGlobals()});f.listeners.pointermove(f.e(1.5,1.5));f.editor.geometryCommand('m',{points:moving.points});f.listeners.pointermove(f.e(3.56,2.06));
 const face=f.state.wallEdits.$surfaces.find(s=>s.id==='moving');assert.ok(Math.abs(face.points[0].x-3)<1e-8,f.message());assert.ok(Math.abs(face.points[2].z-2.5)<1e-8,f.message());assert.ok(face.points.every(p=>p.y===0));
});

test('sticker placement receives cross-wall height targets and inset width targets',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),p=(x,y,z)=>({x,y,z}),host={id:'host',points:[p(0,0,0),p(8,0,0),p(8,0,6),p(0,0,6)]},side={id:'side',feature:{type:'window'},points:[p(8,1,2),p(8,2,2),p(8,2,4),p(8,1,4)]},garage={id:'garage',feature:{type:'garage'},points:[p(3,.4,0),p(5,.4,0),p(5,.4,3),p(3,.4,3)]};let targets;
 const f=fixture({state:{wallEdits:{$surfaces:[host,side,garage]}},walls:[],selected:null,featureHost:()=>({solid:host,points:host.points}),globals:{WallFeatures:{...F,placeGroup(...args){targets=args[1];return F.placeGroup(...args);}}}});
 f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));assert.ok(targets.some(r=>r[0].alignmentAxes?.length===1&&r[0].y===4));assert.ok(targets.some(r=>r[0].alignmentAxes?.length===2&&r[0].x===3));
});


test('paste preview uses sticker references around a corner and draws guides to their real positions',()=>{
 const p=(x,y,z)=>({x,y,z}),sticker={id:'window',feature:{type:'window'},points:[p(0,0,2),p(1,0,2),p(1,0,3),p(0,0,3)]},host={id:'nextWall',points:[p(5,-5,0),p(5,5,0),p(5,5,6),p(5,-5,6)]},W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
 const labels=[];const f=fixture({state:{wallEdits:{$surfaces:[sticker,host]}},walls:[],selected:null,globals:renderGlobals(),lengthMarker:(group,vector,options)=>labels.push(options.text),featureHost:()=>({solid:host,points:host.points}),projectPoint:(d,e)=>W.inFrame(d.frame,{x:5,y:e.clientX/100,z:e.clientY/100}),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),objects=[];
 f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(.5,2.5));f.listeners.pointerup(f.e(.5,2.5));f.editor.clipboardCommand('copy');f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(1,2.56));f.editor.draw3D({add:o=>objects.push(o)},p=>p);
 const guides=objects.filter(o=>o.userData.alignmentGuide);assert.ok(guides.length,f.message());assert.ok(guides.some(g=>g.geometry.points.some(p=>(p.x===0||p.x===1)&&p.y===0&&(p.z===2||p.z===3))),f.message());
 const F=require('../public/measure/internal/editor_scripts/wall_features.js');assert.ok(labels.includes(F.label(sticker.points,sticker.feature)),'copied custom dimensions are visible');assert.ok(objects.some(o=>o.material?.color===F.defs.get('window').color&&o.material.opacity===.7),'copied preview uses the same sticker fill');
 f.editor.key({key:'Escape'});assert.equal(f.history.length,0);
});


test('new and pasted doors choose the nearest wall across generated and edited face collections',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),wall={id:'w',bottom:[p(0,0,0),p(4,0,0)],top:[p(0,0,7*.3048),p(4,0,7*.3048)]};
 for(const paste of [false,true])for(const depth of [4,-2]){
  const edited={id:'edited',points:[p(0,depth,0),p(4,depth,0),p(4,depth,3),p(0,depth,3)]},door={id:'door',feature:{type:'door'},points:[p(0,0,0),p(.9144,0,0),p(.9144,0,2.032),p(0,0,2.032)]},globals=renderGlobals();globals.THREE.Raycaster=class{constructor(){this.ray={origin:p(2,-10,.05)};}setFromCamera(){}intersectObjects(ms){const m=ms.find(m=>m.userData.solidId==='edited');return m?[{object:m}]:[];}};globals.exteriorGeometryClipboard=W.copyGeometry([door],door.points);
  const f=fixture({state:{wallEdits:{$surfaces:[edited]}},walls:[wall],hit:()=>wall,globals});f.editor.draw3D({add(){}},p=>p);f.listeners.pointermove(f.e(2,.05));if(paste)f.editor.clipboardCommand('paste');else f.editor.featureCommand('door',0,true);f.listeners.pointermove(f.e(2,.05));const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);
  const preview=objects.find(o=>o.material?.opacity===.7&&!o.userData?.lineCenters);assert.ok(preview,f.message());assert.ok(preview.geometry.points.every(p=>Math.abs(p.y-(depth<0?depth:0))<1e-7),'closest visible supporting plane wins');assert.ok(Math.abs(Math.min(...preview.geometry.points.map(p=>p.z)))<1e-8,'low pointer places the door on the actual floor');assert.equal(f.history.length,0);f.editor.key({key:'Escape'});
 }
});


test('free-mode door placement projects onto the supporting wall through a rendered sticker cutout',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z});
 for(const paste of [false,true])for(const pointerHeight of [.02,.2,.8]){
  const front={id:'front',points:[p(0,0,0),p(4,0,0),p(4,0,2.1336),p(0,0,2.1336)]},door={id:'existing',feature:{type:'door'},points:[p(1,0,0),p(3,0,0),p(3,0,2.032),p(1,0,2.032)]},rear={id:'w',bottom:[p(0,4,0),p(4,4,0)],top:[p(0,4,5),p(4,4,5)]},globals=renderGlobals();
  globals.isFreeMove=true;globals.exteriorGeometryClipboard=W.copyGeometry([door],door.points);
  globals.THREE.Raycaster=class{constructor(){this.ray={origin:p(2,-10,-10)};}setFromCamera(){}intersectObjects(ms){const m=ms.find(m=>m.userData.solidId==='existing');return m?[{object:m}]:[];}};
  const f=fixture({state:{wallEdits:{$surfaces:[front,door]}},walls:[rear],hit:()=>rear,globals,projectPoint:(d,e)=>{const y=d.frame?.origin.y??d.origin.y,z=e.clientY/100+y;return d.frame?W.inFrame(d.frame,p(e.clientX/100,y,z)):{x:e.clientX/100,y:z,z:0};}});
  f.editor.draw3D({add(){}},p=>p);f.listeners.pointermove(f.e(2,pointerHeight));if(paste)f.editor.clipboardCommand('paste');else f.editor.featureCommand('door',0,true);f.listeners.pointermove(f.e(2,pointerHeight));const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);
  const preview=objects.find(o=>o.material?.opacity===.7&&!o.userData?.lineCenters);assert.ok(preview,f.message());assert.ok(preview.geometry.points.every(p=>Math.abs(p.y)<1e-8),'cursor stays on front supporting plane');assert.ok(Math.abs(Math.min(...preview.geometry.points.map(p=>p.z)))<1e-8,'unsnapped low cursor fits to front floor');assert.equal(f.history.length,0);f.editor.key({key:'Escape'});
 }
});


test('trim auto selections are additive, editable, geometry-free and apply selected width/color once',()=>{
 const outline=[[0,0],[4,0],[4,4],[0,4]],walls=outline.map(([x,y],i)=>{const [xx,yy]=outline[(i+1)%4];return {id:'side'+i,bottom:[{x,y,z:0},{x:xx,y:yy,z:0}],top:[{x,y,z:3},{x:xx,y:yy,z:3}]};});
 const state={wallEdits:{},base:{faces:[{id:'base',points:outline.map(([x,y])=>({x,y,z:0}))}]}},f=fixture({state,walls,selected:null}),before=JSON.stringify(state.wallEdits);
 f.editor.selectTrimEdges('walls');assert.equal(f.editor.selectionSnapshot().lineSelection.length,4);assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.selectTrimEdges('ground');assert.equal(f.editor.selectionSnapshot().lineSelection.length,8);f.editor.selectTrimEdges('ground');assert.equal(f.editor.selectionSnapshot().lineSelection.length,8);
 // The ground edge stays in wall selection so Ctrl-click can subtract it.
 const e={...f.e(2,0),ctrlKey:true};f.editor.pickLine3D(e);f.listeners.pointerup(e);assert.equal(f.editor.selectionSnapshot().lineSelection.length,7);
 assert.equal(f.editor.applyTrim(8*.0254,'#aabbcc'),true,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(f.editor.busy(),false);
 const trims=state.wallEdits.$surfaces.filter(f=>f.trim);assert.ok(trims.length);assert.ok(trims.every(f=>f.finishColor==='#aabbcc'&&Math.abs(f.trimData.layers.at(-1).width-8*.0254)<1e-10));
});
test('horizontal T keeps above/below/centered cycling with a return face on the divider',()=>{
 const p=(x,y,z)=>({x,y,z}),state={wallEdits:{$surfaces:[{id:'lower',points:[p(0,0,0),p(4,0,0),p(4,0,2),p(0,0,2)]},{id:'upper',points:[p(0,0,2),p(4,0,2),p(4,0,4),p(0,0,4)]},{id:'return',points:[p(0,0,2),p(4,0,2),p(4,1,2),p(0,1,2)]}]}},f=fixture({state,walls:[],selected:null});
 f.editor.restoreSelection({lineSelection:[{id:'source',pair:[p(0,0,2),p(4,0,2)]}]});const before=JSON.stringify(state.wallEdits);
 for(let v=0;v<3;v++){f.editor.key({key:'t'});assert.equal(f.editor.busy(),true);const zs=state.wallEdits.$surfaces.filter(s=>s.trim&&s.points.every(p=>p.y===0)).flatMap(s=>s.points.map(p=>p.z));assert.ok(Math.abs(Math.min(...zs)-(v===0?2:v===1?1.8476:1.9238))<1e-6,f.message());assert.ok(Math.abs(Math.max(...zs)-(v===0?2.1524:v===1?2:2.0762))<1e-6);}
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
});

test('E extrudes perpendicular selected faces and stickers by a shared typed distance, cancels and commits once',()=>{
 const p=(x,y,z)=>({x,y,z}),front={id:'front',points:[p(1,0,1),p(3,0,1),p(3,0,3),p(1,0,3)],holes:[],feature:{type:'window',preset:1}},right={id:'right',points:[p(8,1,1),p(8,3,1),p(8,3,3),p(8,1,3)],holes:[],feature:{type:'door',preset:2}},base={faces:[{id:'base',points:[p(0,0,0),p(8,0,0),p(8,8,0),p(0,8,0)],holes:[]}]},state={base,wallEdits:{$surfaces:[front,right]}},f=fixture({state,walls:[],selected:null,screen:p=>({x:100*(p.x-p.y),y:100*(p.z+.2*p.y)})}),selection={selectedSolid:'right',faceSelection:[{solid:'front'},{solid:'right'}]};
 f.editor.restoreSelection(selection);f.listeners.pointermove(f.e(8,2));const before=JSON.stringify(state.wallEdits);assert.equal(f.editor.key({key:'e'}),true);assert.match(f.editor.interaction(),/selected faces/);
 const input=f.editor.distanceInput();assert.ok(input);input.set(.6096);assert.equal(f.history.length,0);const surfaces=state.wallEdits.$surfaces;
 assert.ok(surfaces.find(f=>f.id==='front').points.every(p=>Math.abs(p.y+.6096)<1e-8));assert.ok(surfaces.find(f=>f.id==='right').points.every(p=>Math.abs(p.x-8.6096)<1e-8));assert.equal(surfaces.find(f=>f.id==='right').feature.type,'door');assert.equal(f.editor.selectionSnapshot().faceSelection.length,2);
 const validPreview=JSON.stringify(state.wallEdits);input.set(Infinity);assert.equal(JSON.stringify(state.wallEdits),validPreview);f.editor.down(f.e(9,2));assert.equal(f.history.length,0,'An invalid member must block the whole commit');assert.equal(f.editor.busy(),true);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.deepEqual(JSON.parse(JSON.stringify(f.editor.selectionSnapshot().faceSelection)),selection.faceSelection);
 f.editor.key({key:'e'});f.listeners.pointermove(f.e(9,2));assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='front').points.every(p=>Math.abs(p.y+1)<1e-8),f.message());
 f.editor.distanceInput().set(.6096);f.editor.down(f.e(9,2));assert.equal(f.editor.busy(),false);assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(f.editor.selectionSnapshot().faceSelection.length,2);
 f.editor.key({key:'e'});f.editor.distanceInput().set(.3048);f.editor.key({key:'Enter'});assert.equal(f.history.length,2);assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='right').points.every(p=>Math.abs(p.x-8.9144)<1e-8));
});

test('E consumes every selected draft region and a zero preview restores all original ownership',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,.02),f.w);f.editor.doubleClick(f.e(2,3.98),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});
 const refs=f.d().faces.map(face=>({draft:'w',face:face.id}));f.editor.restoreSelection({activeDraftKey:'w',selectedRegion:refs.at(-1),faceSelection:refs});f.listeners.pointermove(f.e(3,2));const before=JSON.stringify(f.state.wallEdits);
 const historyCount=f.history.length;f.editor.key({key:'e'});f.editor.distanceInput().set(.5);assert.equal(f.d().faces.filter(f=>f.solidId).length,2,f.message());assert.equal(f.editor.selectionSnapshot().faceSelection.length,2);
 f.editor.distanceInput().set(0);assert.equal(JSON.stringify(f.state.wallEdits),before);f.editor.key({key:'Enter'});assert.equal(f.history.length,historyCount);assert.equal(f.editor.selectionSnapshot().faceSelection.length,2);
});

test('E infers multiple complete sticker faces from rectangle-selected vertices',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,z)=>({x,y:0,z}),faces=[{id:'a',points:[p(0,0),p(1,0),p(1,1),p(0,1)],feature:{type:'window'}},{id:'b',points:[p(3,0),p(4,0),p(4,1),p(3,1)],feature:{type:'garage'}}],state={wallEdits:{$surfaces:faces}},f=fixture({state,walls:[],selected:null});
 f.editor.startBox(f.e(-1,-1));f.listeners.pointermove(f.e(5,2));f.listeners.pointerup(f.e(5,2));const selection=JSON.stringify(f.editor.selectionSnapshot()),before=JSON.stringify(state.wallEdits);
 assert.equal(f.editor.pointSelection().length,8);f.editor.key({key:'e'});assert.ok(f.editor.distanceInput());f.editor.distanceInput().set(.6096);assert.equal(f.editor.pointSelection().length,0);assert.equal(f.editor.selectionSnapshot().faceSelection.length,2);assert.ok(state.wallEdits.$surfaces.every(face=>face.points.every(p=>Math.abs(p.y+.6096)<1e-8)),f.message());
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(JSON.stringify(f.editor.selectionSnapshot()),selection);
});

test('opening trim bulk selection updates only selected windows without duplicating geometry',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),p=(x,z)=>({x,y:0,z}),rect=x=>[p(x,1),p(x+1,1),p(x+1,2),p(x,2)],a={id:'a',points:rect(0),feature:F.setTrim({type:'window'},2,'#112233')},b={id:'b',points:rect(2),feature:{type:'window'}},door={id:'d',points:rect(4),feature:{type:'door'}},state={wallEdits:{$surfaces:[a,b,door]}},f=fixture({state,walls:[],selected:null});
 f.editor.selectOpeningTrim('window');assert.equal(f.editor.openingTrimItems('window').filter(i=>i.selected).length,2);
 f.editor.selectOpeningTrim('window','solid:a',false);f.editor.applyOpeningTrim('window',4,'#abcdef');assert.equal(a.feature.trim.width,2*.0254);assert.equal(b.feature.trim.width,4*.0254);assert.equal(door.feature.trim,undefined);assert.equal(state.wallEdits.$surfaces.length,3);
 f.editor.selectOpeningTrim('window');f.editor.applyOpeningTrim('window',6,'#ffffff');assert.equal(state.wallEdits.$surfaces.find(s=>s.id==='a').feature.trim.width,6*.0254);assert.equal(state.wallEdits.$surfaces.length,3);assert.equal(f.history.length,2);
 const saved=JSON.parse(JSON.stringify(state)),reloaded=fixture({state:saved,walls:[],selected:null});assert.ok(Math.abs(reloaded.editor.openingTrimItems('window')[0].width-6)<1e-8);
 f.editor.applyOpeningTrim('window',0,'#ffffff');assert.ok(state.wallEdits.$surfaces.filter(s=>s.feature.type==='window').every(s=>!s.feature.trim));
});
test('T cycles placement trim without placing the window, and commits the selected trim once',()=>{
 const p=(x,z)=>({x,y:0,z}),host={id:'host',points:[p(0,0),p(5,0),p(5,5),p(0,5)]},f=fixture({state:{wallEdits:{$surfaces:[host]}},walls:[],selected:null,featureHost:()=>({solid:host,points:host.points})});
 f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));
 for(const width of [2,3,4,6,0,2]){assert.equal(f.editor.key({key:'t'}),true);assert.equal(f.editor.featurePlacement().trimInches,width);assert.equal(f.history.length,0);}
 f.editor.down(f.e(2,2));const faces=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state),window=faces.find(f=>f.feature?.type==='window');assert.ok(window,f.message());assert.equal(window.feature.trim.width,.0508);assert.equal(f.history.length,1);
});
const divideFixture=()=>{const ft=.3048,face={id:'divide-window',points:[{x:1,y:0,z:1},{x:1+4*ft,y:0,z:1},{x:1+4*ft,y:0,z:1+7*ft},{x:1,y:0,z:1+7*ft}],holes:[],feature:{type:'window',axis:{x:1,y:0,z:0}}};const f=fixture({state:{wallEdits:{$surfaces:[face]}},screen:p=>({x:p.x*100,y:-p.z*100}),globals:renderGlobals()});f.editor.restoreSelection({selectedSolid:face.id});f.listeners.pointermove(f.e(1.5,2));return f;};
test('L previews and toggles without mutation, accepts exact distances, commits once and cancels cleanly',()=>{
 const f=divideFixture(),before=JSON.stringify(f.state.wallEdits);assert.equal(f.editor.key({key:'l'}),true);assert.equal(f.editor.interaction(),'Divide window / door');assert.equal(f.editor.distanceInput().label,'Divide from top');
 f.editor.distanceInput().set(5*.3048);assert.equal(JSON.stringify(f.state.wallEdits),before);const markers=[];f.editor.draw3D({add(){}},p=>p);assert.equal(f.history.length,0);
 f.editor.key({key:'l'});assert.equal(f.editor.distanceInput().label,'Divide from left');f.editor.distanceInput().set(2*.3048);f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.editor.selectionSnapshot().selectedSolid,'divide-window');
 f.editor.key({key:'l'});f.editor.distanceInput().set(5*.3048);f.editor.down(f.e(2,2));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(f.state.wallEdits.$surfaces.length,2);assert.deepEqual(f.state.wallEdits.$surfaces.map(s=>Math.round((Math.max(...s.points.map(p=>p.z))-Math.min(...s.points.map(p=>p.z)))/.3048)).sort(),[2,5]);
});
test('L crosses existing sections and deleting one dashed segment leaves three sections, including in textured mode',()=>{
 const f=divideFixture(),F=require('../public/measure/internal/editor_scripts/wall_features.js');f.editor.key({key:'l'});f.editor.distanceInput().set(5*.3048);f.editor.key({key:'enter'});
 f.editor.key({key:'l'});assert.equal(f.editor.distanceInput().label,'Divide from left','the selected short, wide section defaults to a vertical divide across the whole window');f.editor.distanceInput().set(2*.3048);f.editor.key({key:'enter'});assert.equal(f.state.wallEdits.$surfaces.length,4);
 const segments=F.divisionSegments(f.state.wallEdits.$surfaces),line=segments.find(s=>Math.abs(s.pair[0].x-s.pair[1].x)<1e-6&&Math.max(...s.pair.map(p=>p.z))<1+2.01*.3048);assert.ok(line);
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.dashSize&&o.userData.exteriorDivider),'committed dividers render dashed');
 f.state.displayMode='textured';const mid={x:(line.pair[0].x+line.pair[1].x)/2,z:(line.pair[0].z+line.pair[1].z)/2},event=f.e(mid.x,-mid.z);assert.equal(f.editor.pickLine3D(event),true,'textured mode can pick a divider');f.listeners.pointerup(event);f.editor.key({key:'Delete'});assert.equal(f.state.wallEdits.$surfaces.length,3);assert.ok(f.state.wallEdits.$surfaces.every(s=>s.feature.type==='window'));assert.equal(f.history.length,3);
});
test('dividing a drafted opening consumes its source, and undo restores the entire original window',()=>{
 const f=stickerFixture(),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'l'});f.editor.distanceInput().set(.5);f.editor.key({key:'enter'});const features=M.collect(f.state).filter(s=>s.feature);assert.equal(features.length,2);assert.ok(f.d().faces.find(s=>s.feature).solidId);assert.equal(JSON.stringify(f.history.at(-1)),before);
 const selection=f.editor.selectionSnapshot();f.state.wallEdits=JSON.parse(JSON.stringify(f.history.at(-1)));f.editor.clear();assert.equal(M.collect(f.state).filter(s=>s.feature).length,1);
});
test('pasting selected sections on another wall preserves their relationship with a new group identity',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),p=(x,y,z)=>({x,y,z}),back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]},opening={id:'original',points:[p(-3,0,0),p(-1,0,0),p(-1,0,2),p(-3,0,2)],feature:{type:'window'},holes:[]},sections=F.divideSticker([opening],'horizontal',1).faces,state={wallEdits:{$surfaces:[back,...sections]}},f=fixture({state,walls:[],selected:null,featureHost:()=>({solid:back,points:back.points})});
 f.editor.restoreSelection({selectedSolid:sections[1].id,faceSelection:sections.map(f=>({solid:f.id}))});f.editor.clipboardCommand('copy');assert.equal(f.clipboard().faces.length,2);f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(2,2));f.editor.down(f.e(2,2));assert.equal(f.editor.busy(),false,f.message());
 const features=M.collect(state).filter(s=>s.feature),groups=new Set(features.map(s=>s.feature.divisionGroup));assert.equal(features.length,4);assert.equal(groups.size,2);for(const id of groups)assert.equal(features.filter(s=>s.feature.divisionGroup===id).length,2);
});

test('redraw reuse agrees with uncached rendering after move, cancellation and in-place edits',()=>{
 const make=disabled=>fixture({globals:{...renderGlobals(),EXTERIOR_DISABLE_RENDER_CACHE:disabled}}),a=make(false),b=make(true);
 const capture=f=>{const svg=[],objects=[];f.editor.draw2D({},(tag,attrs)=>{svg.push([tag,attrs]);return {};},1);f.editor.draw3D({add:o=>objects.push({points:o.geometry?.points,material:o.material,userData:o.userData,renderOrder:o.renderOrder})},p=>p);return JSON.parse(JSON.stringify({svg,objects,state:f.state}));};
 for(const f of [a,b]){f.editor.doubleClick(f.e(1,1),f.w);for(const [x,y]of [[3,1],[3,3],[1,3],[1,1]]){f.editor.key({key:'n'});f.editor.down(f.e(x,y));f.listeners.pointerup(f.e(x,y));}}
 assert.deepEqual(capture(a),capture(b));assert.deepEqual(capture(a),capture(b));
 for(const f of [a,b]){f.listeners.pointermove(f.e(1,1));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.2,1.2));}
 assert.deepEqual(capture(a),capture(b));
 for(const f of [a,b])f.editor.key({key:'escape'});
 assert.deepEqual(capture(a),capture(b));
 for(const f of [a,b]){f.d().removedPoints=[f.d().sketch.nodes.find(n=>!n.fixed).id];f.d().faces[0].finishColor='#123456';}
 assert.deepEqual(capture(a),capture(b));
});


test('one-sided and centered trim remain distinct when wall material colors are disabled',()=>{
 const state={materialColors:false,finishDefaults:{trimColor:'#f5f3ef'},wallEdits:{$surfaces:[{id:'below',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:2},{x:0,y:0,z:2}]},{id:'above',points:[{x:0,y:0,z:2},{x:4,y:0,z:2},{x:4,y:0,z:4},{x:0,y:0,z:4}]}]}},f=fixture({state,walls:[],globals:renderGlobals()}),pair=[{x:0,y:0,z:2},{x:4,y:0,z:2}];
 f.editor.restoreSelection({lineSelection:[{id:'divider',pair}]});
 for(let variant=0;variant<3;variant++){
  f.editor.key({key:'t'});const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);
  const trimIds=new Set(state.wallEdits.$surfaces.filter(s=>s.trim).map(s=>s.id)),trimMeshes=objects.filter(o=>trimIds.has(o.userData?.solidId));
  assert.equal(trimMeshes.length,variant===2?2:1);
  assert.ok(trimMeshes.every(o=>o.material.color==='#f5f3ef'),'trim must retain its contrasting finish in every variant');
  assert.ok(objects.some(o=>o.userData?.solidId&&!trimIds.has(o.userData.solidId)&&o.material.color==='#ffd84d'),'uncolored walls keep their drafting color');
 }
 f.editor.key({key:'Enter'});assert.equal(f.history.length,1);
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.ok(objects.some(o=>o.material.color==='#f5f3ef'),'placed trim remains visible');
});

test('trim selection distinguishes trimmed ground and removal is one undoable edit',()=>{
 const outline=[[0,0],[4,0],[4,4],[0,4]],walls=outline.map(([x,y],i)=>{const [xx,yy]=outline[(i+1)%4];return {id:'side'+i,bottom:[{x,y,z:0},{x:xx,y:yy,z:0}],top:[{x,y,z:3},{x:xx,y:yy,z:3}]};});
 const state={wallEdits:{},base:{faces:[{id:'base',points:outline.map(([x,y])=>({x,y,z:0}))}]}},f=fixture({state,walls,selected:null});
 f.editor.selectTrimEdges('ground');assert.equal(f.editor.applyTrim(.2),true,f.message());const trimmed=JSON.stringify(state.wallEdits);
 f.editor.selectTrimEdges('ground-untrimmed');assert.equal(f.editor.selectionSnapshot().lineSelection.length,0);
 f.editor.selectTrimEdges('ground');assert.equal(f.editor.selectionSnapshot().lineSelection.length,4);
 assert.equal(f.editor.removeTrim(),true,f.message());assert.equal(f.history.length,2);assert.equal(JSON.stringify(f.history[1]),trimmed);assert.ok(state.wallEdits.$surfaces.every(f=>!f.trim));
});

test('face extrusion carries saved trim, cancels without drift, and static trim persists unchanged',()=>{
 for(const keepTrimStatic of [false,true]){
  const wall={id:'follow-wall',points:[{x:.2,y:0,z:0},{x:3.8,y:0,z:0},{x:3.8,y:0,z:4},{x:.2,y:0,z:4}],holes:[]},trim={id:'follow-trim',trim:true,material:'trim-wood',points:[{x:0,y:0,z:0},{x:.2,y:0,z:0},{x:.2,y:0,z:4},{x:0,y:0,z:4}],holes:[]},f=fixture({state:{keepTrimStatic,wallEdits:{$surfaces:[wall,trim]}},walls:[],selected:null}),before=JSON.stringify(f.state.wallEdits);
  f.editor.restoreSelection({selectedSolid:wall.id});f.listeners.pointermove(f.e(2,2));f.editor.key({key:'e'});assert.ok(f.editor.distanceInput(),f.message());f.editor.distanceInput().set(.3);
  let moved=f.state.wallEdits.$surfaces.find(s=>s.trim);assert.ok(moved,f.message());assert.ok(moved.points.every(p=>Math.abs(p.y-(keepTrimStatic?0:.3))<1e-8),JSON.stringify({keepTrimStatic,moved,surfaces:f.state.wallEdits.$surfaces}));
  f.editor.key({key:'escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
  f.editor.restoreSelection({selectedSolid:wall.id});f.editor.key({key:'e'});f.editor.distanceInput().set(.3);f.editor.down(f.e(2,2));assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);moved=f.state.wallEdits.$surfaces.find(s=>s.trim);assert.ok(moved.points.every(p=>Math.abs(p.y-(keepTrimStatic?0:.3))<1e-8));
 }
});

test('M follows a sloped roof continuously and keeps connected walls without extrusion returns',()=>{
 const p=(x,y,z)=>({x,y,z}),face={id:'moving-roof-wall',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(0,0,3)]},neighbor={id:'neighbor',points:[p(0,0,0),p(0,2,0),p(0,2,3),p(0,0,3)]},roof={faces:[{points:[p(-1,1,4),p(5,1,4),p(5,-2,1),p(-1,-2,1)]}],points:[],connections:[]},state={wallEdits:{$surfaces:[face,neighbor]}},before=JSON.stringify(state.wallEdits),f=fixture({state,roof,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})});
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(1.3,1.5));f.listeners.pointerup(f.e(1.3,1.5));f.listeners.pointermove(f.e(1.3,1.5));f.editor.key({key:'m'});f.editor.distanceInput().set(-1);
 const cap=state.wallEdits.$surfaces.find(f=>f.id===face.id);assert.ok(cap.points.every(p=>Math.abs(p.y+1)<1e-5),JSON.stringify({points:cap.points,message:f.message()}));assert.ok(Math.abs(Math.max(...cap.points.map(p=>p.z))-2)<1e-5,f.message());assert.equal(state.wallEdits.$surfaces.filter(f=>!f.deleted).length,2,'move must not add sweep returns');assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='neighbor').points.some(p=>Math.abs(p.y+1)<1e-5&&Math.abs(p.z-2)<1e-5),'neighbor shares the lowered top corner');f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

for(const key of ['m','e'])test(`${key.toUpperCase()} snaps the saved inside corner to the finite eave without rejecting its longer wall`,()=>{
 const input=structuredClone(require('./fixtures/roof-inner-corner.json')),face=input.walls[0],state={wallEdits:{$surfaces:[face]}},before=JSON.stringify(state.wallEdits),f=fixture({state,roof:input.roof,walls:[],selected:null,globals:renderGlobals(),screen:p=>({x:(p.x+p.y)*100,y:p.z*100})}),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),n=W.normal(face.points);
 f.editor.draw3D({add(){}},p=>p);f.editor.down(f.e(10,10));f.listeners.pointerup(f.e(10,10));f.listeners.pointermove(f.e(10,10));f.editor.key({key});f.listeners.pointermove(f.e(10+(n.x+n.y)*(.4572-.04),10));assert.match(f.message(),/Roof edge snap/);
 const cap=state.wallEdits.$surfaces.find(p=>p.id===face.id);assert.ok(cap.points.filter(p=>p.z>164).some(p=>Math.abs(p.z-164.49600219726562)<.00001),'cap reaches measured eave');f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

test('shared wall bottom selects the wall for Delete and M while preserving its base',()=>{
 for(const action of ['Delete','m']){
  const p=(x,y,z)=>({x,y,z}),wall={id:'wall',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]},base={faces:[{id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]}]};
  const calls=[],state={base,wallEdits:{$surfaces:[wall]}},f=fixture({state,walls:[],selected:null,selectBaseEntities:(...a)=>calls.push(a),globals:{isFreeMove:true}}),before=JSON.stringify(state.wallEdits);
  f.editor.pickLine3D(f.e(2,0));f.listeners.pointerup(f.e(2,0));assert.equal(calls.length,0,'wall boundary takes priority over base');
  const baseBefore=JSON.stringify(base);f.editor.key({key:action});
  if(action==='Delete'){assert.ok(state.wallEdits.$surfaces[0].deleted);assert.equal(f.history.length,1);f.editor.pickLine3D(f.e(2,0));f.listeners.pointerup(f.e(2,0));assert.equal(calls.length,1,'remaining edge belongs to base');}
  else{assert.equal(f.editor.interaction(),'Move line');f.listeners.pointermove(f.e(2,1));assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='wall').points.slice(0,2).every(p=>p.z===1),f.message());assert.ok(!state.wallEdits.$base);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);}
  assert.equal(JSON.stringify(base),baseBefore);
 }
});
test('three selected wall bottoms lift together without moving or warping the base',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),p=(x,y,z)=>({x,y,z}),ring=[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)],faces=ring.slice(0,3).map((a,i)=>({id:'wall'+i,points:[a,ring[i+1],{...ring[i+1],z:3},{...a,z:3}]})),state={base:{faces:[{id:'base',points:ring}]},wallEdits:{$surfaces:faces}};
 const screen=p=>({x:(p.x+.3*p.y)*100,y:(p.z+.2*p.y)*100});
 const f=fixture({state,walls:[],selected:null,screen,selectBaseEntities:()=>assert.fail('wall routed to base'),globals:{isFreeMove:true},projectPoint:(d,e)=>{const a={x:e.clientX/100,y:0,z:e.clientY/100},v={x:-.3,y:1,z:-.2},n=d.frame.n,o=d.frame.origin,t=((o.x-a.x)*n.x+(o.y-a.y)*n.y+(o.z-a.z)*n.z)/(v.x*n.x+v.y*n.y+v.z*n.z);return W.inFrame(d.frame,{x:a.x+t*v.x,y:t,z:a.z+t*v.z});}});
 for(let i=0;i<3;i++){const q=screen({x:(ring[i].x+ring[i+1].x)/2,y:(ring[i].y+ring[i+1].y)/2,z:0}),e=f.e(q.x/100,q.y/100,i>0);f.editor.pickLine3D(e);f.listeners.pointerup(e);}
 const before=JSON.stringify(state.wallEdits),baseBefore=JSON.stringify(state.base);f.editor.key({key:'m'});
 let success=false;for(let i=0;i<4;i++){if(i)f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.6,1.8));const live=state.wallEdits.$surfaces.filter(f=>!f.deleted);if(live.length===3&&live.every(f=>f.points.slice(0,2).every(p=>p.z>.01))){success=true;break;}}
 assert.ok(success,f.message());assert.ok(!state.wallEdits.$base);assert.equal(JSON.stringify(state.base),baseBefore);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
});

for(const mode of ['m','e'])test(`${mode.toUpperCase()} moves three wall edges by typed feet with offset labels and preserved base`,()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),p=(x,y,z)=>({x,y,z}),ring=[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)],faces=ring.slice(0,3).map((a,i)=>({id:'wall'+i,points:[a,ring[i+1],{...ring[i+1],z:3},{...a,z:3}]}));
 faces.push({id:'front',points:[p(-3,0,0),ring[0],p(0,0,3),p(-3,0,3)]});
 const state={base:{faces:[{id:'base',points:ring}]},wallEdits:{$surfaces:faces}},before=JSON.stringify(state.wallEdits),baseBefore=JSON.stringify(state.base),markers=[];
 const f=fixture({state,walls:[],selected:null,globals:{...renderGlobals(),isFreeMove:true},lengthMarker:(g,v,e)=>markers.push(e)});
 const selection={lineSelection:ring.slice(0,3).map((a,i)=>({id:'edge'+i,pair:[a,ring[i+1]]}))};
 const begin=()=>{f.editor.restoreSelection(selection);f.listeners.pointermove(f.e(2,0));assert.equal(f.editor.key({key:mode}),true);assert.equal(f.editor.interaction(),mode==='e'?'Extrude lines':'Move line');};
 begin();assert.ok(f.editor.distanceInput());
 // Exercise the real keyboard input owner, whose default unit is feet.
 const ctx={window:{},document:{getElementById:()=>null}};vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_distance_input.js','utf8'),ctx);
 ctx.window.ExteriorDistanceInput.key({key:'2',preventDefault(){},stopImmediatePropagation(){}},f.editor.distanceInput());
 assert.equal(f.editor.distanceInput().amount,.6096);
 for(const wall of state.wallEdits.$surfaces.filter(f=>f.id.startsWith('wall')))assert.ok(wall.points.slice(0,2).every(p=>Math.abs(p.z-.6096)<1e-8),f.message());
 const front=state.wallEdits.$surfaces.find(f=>f.id==='front');
 if(mode==='e'){assert.ok(front.points.some(p=>p.x===0&&p.z===0),'front bottom corner stays in place');assert.ok(front.points.some(p=>p.x===0&&p.z===.6096),'new step connection reaches lifted wall');assert.ok(front.points.some((p,i)=>p.x===-3&&p.z===0&&front.points[(i+1)%front.points.length].z===0),'front bottom stays horizontal');}
 else assert.ok(!front.points.some(p=>p.x===0&&p.z===0),'M retains ordinary vertex movement');
 f.editor.draw3D({add(){}},p=>p);assert.ok(markers.filter(e=>Math.abs(e.length-.6096)<1e-8).length>=3,'each moved edge shows displacement');
 assert.equal(JSON.stringify(state.base),baseBefore);assert.ok(!state.wallEdits.$base);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 begin();f.editor.distanceInput().set(.6096);const placed=JSON.stringify(state.wallEdits.$surfaces);f.editor.key({key:'Enter'});assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);assert.equal(JSON.stringify(state.wallEdits.$surfaces),placed);assert.equal(JSON.stringify(state.wallEdits.$base.faces),JSON.stringify(state.base.faces));
});

for(const amount of [-.6096,.6096])test(`edge extrusion ${amount} preserves unselected draft and loose edges`,()=>{
 const p=(x,y,z)=>({x,y,z}),side={id:'side',points:[p(4,0,0),p(4,4,0),p(4,4,3),p(4,0,3)]},front={id:'front',bottom:[p(0,0,0),p(4,0,0)],top:[p(0,0,3),p(4,0,3)]};
 const loose=[p(-10,0,0),p(4,0,0)],state={wallEdits:{$surfaces:[side],$loose:{points:[],edges:[loose]}}},f=fixture({state,walls:[front],selectedId:'front',globals:{isFreeMove:true}});
 f.editor.doubleClick(f.e(2,1),front);f.editor.key({key:'Escape'});f.history.length=0;
 const drafts=state.wallEdits.$drafts,source=Object.values(drafts)[0],nodes=JSON.stringify(source.sketch.nodes),before=JSON.stringify(state.wallEdits);
 const selection={lineSelection:[{id:'bottom',pair:side.points.slice(0,2)}]};
 const begin=()=>{f.editor.restoreSelection(selection);f.listeners.pointermove(f.e(4,0));f.editor.key({key:'e'});f.editor.distanceInput().set(amount);};
 begin();assert.equal(f.editor.distanceInput().amount,amount,f.message());
 assert.equal(JSON.stringify(Object.values(state.wallEdits.$drafts)[0].sketch.nodes),nodes,'original sketch must not get diagonalized');
 assert.equal(JSON.stringify(state.wallEdits.$loose.edges[0]),JSON.stringify(loose),'unselected loose line stays fixed');
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),surfaces=state.wallEdits.$surfaces.filter(s=>!s.deleted),connections=[...surfaces,...state.wallEdits.$loose.edges.map(points=>({points}))];
 for(const from of side.points.slice(0,2)){const to={...from,z:amount};assert.ok(W.sharedIntervals(from,to,connections).reduce((sum,[a,b])=>sum+b-a,0)>.99999,'new endpoint connects to its original endpoint');}
 for(const edge of state.wallEdits.$loose.edges.slice(1))assert.ok(edge[0].x===edge[1].x&&edge[0].y===edge[1].y,'only local vertical connectors may be added');
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 begin();f.editor.key({key:'Enter'});assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

for(const type of ['window','door'])test(`T cycles placed ${type} trim without changing sticker geometry`,()=>{
 const p=(x,z)=>({x,y:0,z}),face={id:'opening',points:[p(1,1),p(2,1),p(2,3),p(1,3)],feature:{type}},state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null}),points=JSON.stringify(face.points);
 f.editor.restoreSelection({selectedSolid:face.id});
 for(const width of [2,3,4,6,0]){const before=JSON.stringify(state.wallEdits);assert.equal(f.editor.key({key:'t'}),true);assert.ok(Math.abs((state.wallEdits.$surfaces[0].feature.trim?.width||0)-width*.0254)<1e-8);assert.equal(JSON.stringify(state.wallEdits.$surfaces[0].points),points);assert.equal(JSON.stringify(f.history.at(-1)),before);assert.equal(f.editor.busy(),false);}
 assert.equal(f.history.length,5);
});
for(const type of ['window','door'])test(`${type} placement ignores trim width and nearby trim snap targets`,()=>{
 const p=(x,z)=>({x,y:0,z}),host={id:'host',points:[p(0,0),p(6,0),p(6,6),p(0,6)]},out=[];
 for(const trim of [false,true])for(const cycles of [0,1,4]){
  const surfaces=[structuredClone(host)];if(trim)for(let i=0;i<12;i++)surfaces.push({id:'trim'+i,trim:true,points:[p(2.4+i*.013,0),p(2.41+i*.013,0),p(2.41+i*.013,6),p(2.4+i*.013,6)]});
  const f=fixture({state:{wallEdits:{$surfaces:surfaces}},walls:[],selected:null,featureHost:()=>({solid:surfaces[0],points:surfaces[0].points})});
  f.editor.featureCommand(type,0,true);f.listeners.pointermove(f.e(3,3));for(let i=0;i<cycles;i++)f.editor.key({key:'t'});f.editor.down(f.e(3,3));
  const face=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state).find(f=>f.feature?.type===type);assert.ok(face,f.message());out.push(JSON.stringify(face.points.map(({x,y,z})=>({x,y,z}))));
  const before=JSON.stringify(face.points);f.editor.key({key:'t'});const after=require('../public/measure/internal/editor_scripts/exterior_model.js').collect(f.state).find(f=>f.feature?.type===type);assert.equal(JSON.stringify(after.points),before);assert.ok(after.feature.trim||cycles===4,'T works immediately after placing a drafted sticker');
 }
 assert.ok(out.every(points=>points===out[0]),'all trim variants place the same opening at the same center: '+JSON.stringify(out));
});

test('V from a window corner passes through trim without cutting or importing the trim',()=>{
 const p=(x,z)=>({x,y:0,z}),opening=[p(1,1),p(2,1),p(2,3),p(1,3)],wall={id:'host',points:[p(0,0),p(4,0),p(4,5),p(0,5)],holes:[opening]},window={id:'window',points:opening,feature:{type:'window',trim:{width:.1524,color:'#fff'}}},F=require('../public/measure/internal/editor_scripts/wall_features'),trims=F.trimFaces(opening,window.feature).map((f,i)=>({...f,id:'trim'+i,trim:true}));
 const state={wallEdits:{$surfaces:[wall,window,...trims]}},f=fixture({state,walls:[],selected:null}),before=JSON.stringify(state.wallEdits),trimBefore=JSON.stringify(trims);
 f.editor.cutFromPoint(opening[3],'v');assert.equal(f.editor.interaction(),'H/V cut',f.message());
 let reachesRoof=false;
 assert.ok(Object.values(state.wallEdits.$drafts||{}).some(d=>d.sketch.nodes.some(n=>Math.abs(n.x-1)<1e-6&&Math.abs(n.y-5)<1e-6)),'first V reaches the outer wall boundary');
 for(let i=0;i<4;i++){
  const drafts=state.wallEdits.$drafts||{};assert.ok(!Object.keys(drafts).some(key=>key.startsWith('solid:trim')),'trim is never a candidate cutting plane');
  reachesRoof ||=Object.values(drafts).some(d=>d.sketch.nodes.some(n=>Math.abs(n.x-1)<1e-6&&Math.abs(n.y-5)<1e-6));
  assert.equal(JSON.stringify(state.wallEdits.$surfaces.filter(f=>f.trim)),trimBefore,'trim geometry is unchanged');
  f.editor.key({key:'v'});
 }
 assert.ok(reachesRoof,'wall cut reaches the roof beyond the top trim');f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 f.editor.cutFromPoint(opening[3],'v');f.editor.finishAxisCut();assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

test('saved base-to-window cut splits bridged wall regions and commits without trapping selection',()=>{
 const input=structuredClone(require('./fixtures/vertical-cut-window-bridge.json')),state=input.state,before=JSON.stringify(state.wallEdits),f=fixture({state,walls:[],selected:null}),M=require('../public/measure/internal/editor_scripts/exterior_model');
 f.editor.cutFromPoint(input.point,'v');assert.equal(f.editor.busy(),true,f.message());assert.doesNotThrow(()=>M.validateEdits(structuredClone(state.wallEdits),JSON.parse(before)));
 const faces=Object.values(state.wallEdits.$drafts).flatMap(d=>d.faces);assert.ok(faces.some(f=>f.id.includes('~region-')),'both pieces of the split wall survive');assert.ok(faces.flatMap(f=>[f.points,...(f.holes||[])].flat()).every(p=>p.nodeId),'split boundaries retain sketch IDs');
 f.editor.down(f.e(input.point.x,input.point.z+.2));f.listeners.pointerup(f.e(input.point.x,input.point.z+.2));assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 assert.equal(f.editor.pickLine3D(f.e(input.point.x,input.point.z+.2)),true,'new line is selectable');const committed=JSON.stringify(state.wallEdits);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),committed);
});
test('unexpected axis cut commit rejection releases controls and restores the prior geometry',()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_model');let reject=false;const f=fixture({globals:{ExteriorModel:{...M,validateEdits(...args){if(reject)throw Error('Rejected test commit');return M.validateEdits(...args);}}}}),before=JSON.stringify(f.state.wallEdits);
 f.editor.cutFromPoint({x:2,y:0,z:0},'v');assert.equal(f.editor.busy(),true);reject=true;assert.doesNotThrow(()=>f.editor.finishAxisCut());assert.equal(f.editor.busy(),false);assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,0);assert.match(f.message(),/Rejected test commit/);
});

test('moving a sticker carries collinear sketch anchors omitted from its resolved face',()=>{
 const f=stickerFixture(),d=f.d(),face=d.faces.find(f=>f.feature),a=face.points[0],b=face.points[1],anchor={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:0};
 const id=S.add(d,anchor,.0001),before=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(f.e(2,2));f.editor.key({key:'m'});f.editor.distanceInput().set(.3);
 const n=f.d().sketch.nodes.find(n=>n.id===id);assert.ok(Math.abs(n.x-anchor.x-.3)<1e-7,f.message());assert.ok(Math.abs(n.y-anchor.y)<1e-7);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});
test('deleting a trimmed sticker removes its outline and corners and fills its host hole',()=>{
 const f=stickerFixture();f.editor.key({key:'t'});const before=JSON.stringify(f.state.wallEdits),ids=f.d().faces.find(f=>f.feature).points.map(p=>p.nodeId);
 f.editor.key({key:'Delete'});assert.ok(!f.d().faces.some(f=>f.feature));assert.ok(!f.d().sketch.nodes.some(n=>ids.includes(n.id)));assert.ok(!f.d().sketch.edges.some(e=>ids.includes(e.a)||ids.includes(e.b)));assert.equal(f.d().faces.length,1);assert.equal(f.d().faces[0].holes.length,0);assert.equal(JSON.stringify(f.history.at(-1)),before);
});
test('deleting a sticker keeps a deliberate wall cut attached to its former corner',()=>{
 const f=stickerFixture(),d=f.d(),face=d.faces.find(f=>f.feature),corner=face.points[0],floor=S.add(d,{x:corner.x,y:0,z:0},.0001);S.connect(d,[floor,corner.nodeId]);const edge=d.sketch.edges.find(e=>[e.a,e.b].includes(floor)&&[e.a,e.b].includes(corner.nodeId));
 f.editor.down(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.editor.key({key:'Delete'});assert.ok(f.d().sketch.edges.some(e=>e.id===edge.id));assert.ok(f.d().sketch.nodes.some(n=>n.id===corner.nodeId));assert.ok(!f.d().faces.some(f=>f.feature));
});
test('deleting a solid sticker also removes the matching host opening',()=>{
 const p=(x,z)=>({x,y:0,z}),points=[p(1,1),p(3,1),p(3,3),p(1,3)],sticker={id:'window',points,feature:{type:'window'}},host={id:'host',points:[p(0,0),p(4,0),p(4,4),p(0,4)],holes:[points]};
 const f=fixture({state:{wallEdits:{$surfaces:[sticker,host]}},walls:[],selected:null,globals:renderGlobals()});f.editor.draw3D({add(){}},p=>p);f.editor.pickSolid(f.e(2,2));f.listeners.pointerup(f.e(2,2));f.editor.key({key:'Delete'});assert.ok(!f.state.wallEdits.$surfaces.some(f=>f.id===sticker.id));assert.equal(host.holes.length,0);const wire=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js').surfaceWire(f.state.wallEdits);assert.equal(wire.nodes.length,4);assert.equal(wire.edges.length,4);
});

test('saved windows with attached cuts move all their anchors and delete cleanly as a group',()=>{
 const saved=JSON.parse(fs.readFileSync('dev/fixtures/sticker-attached-cuts.json','utf8')),d=saved.draft,key='saved',frame=d.frame,K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),globals=renderGlobals();let wanted;
 globals.THREE.Raycaster=class{setFromCamera(){}intersectObjects(ms){return ms.filter(m=>m.userData.regionId===wanted).map(object=>({object}));}};
 const state={wallEdits:{$drafts:{[key]:d},$surfaces:[saved.surface]}},f=fixture({state,walls:[],selected:null,globals,screen:p=>{const q=K.local(frame,p);return {x:q.x*100,y:q.y*100};},projectPoint:(plane,e)=>K.local(plane.frame,K.world(frame,{x:e.clientX/100,y:e.clientY/100,z:0}))});
 const windows=d.faces.filter(f=>f.feature),centers=windows.map(B.center),before=JSON.stringify(state.wallEdits);
 const select=(i,add=false)=>{wanted=windows[i].id;f.editor.draw3D({add(){}},p=>p);const p=centers[i],e=f.e(p.x,p.y,add);f.editor.pickSolid(e);f.listeners.pointerup(e);f.listeners.pointermove(e);};
 select(1);f.editor.key({key:'m'});f.editor.distanceInput().set(.3);const moved=state.wallEdits.$drafts[key].faces.find(f=>f.id===windows[1].id);
 for(const p of moved.points){const n=state.wallEdits.$drafts[key].sketch.nodes.find(n=>n.id===p.nodeId);assert.ok(Math.hypot(n.x-p.x,n.y-p.y)<1e-8);}
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);
 select(0);select(1,true);f.editor.key({key:'Delete'});const after=state.wallEdits.$drafts[key];assert.equal(after.faces.filter(f=>f.feature).length,0);assert.equal(after.sketch.edges.filter(e=>!e.fixed).length,2,'both deliberate vertical cuts remain, all window outlines are removed');assert.equal(JSON.stringify(f.history.at(-1)),before);
});

for(const axis of ['v','h'])test(`${axis.toUpperCase()} cuts from every selected point, cancels together and commits one undo`,()=>{
 const f=fixture();f.editor.beginFace(f.e(2,2),f.w);f.listeners.pointerup(f.e(2,2));const d=f.d(),sources=[{x:1,y:1,z:0},{x:3,y:3,z:0}],ids=sources.map(p=>S.add(d,p,.0001));
 f.editor.restoreSelection({activeDraftKey:'w',preferredDraft:'w',picked:ids,draftSelection:{w:ids}});const before=JSON.stringify(f.state.wallEdits),history=f.history.length;
 const check=()=>{const d=f.d();for(const p of sources){const edges=d.sketch.edges.filter(e=>!e.fixed).map(e=>[e.a,e.b].map(id=>d.sketch.nodes.find(n=>n.id===id)));assert.ok(edges.some(pair=>pair.some(n=>Math.hypot(n.x-p.x,n.y-p.y)<1e-7)&&Math.abs(axis==='v'?pair[0].x-pair[1].x:pair[0].y-pair[1].y)<1e-7),f.message());}};
 f.editor.key({key:axis});assert.equal(f.editor.interaction(),'H/V cut');check();assert.equal(f.history.length,history);f.editor.key({key:axis});check();f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.editor.pointSelection().length,2);
 f.editor.key({key:axis});check();f.editor.finishAxisCut();assert.equal(f.editor.busy(),false);assert.equal(f.history.length,history+1);assert.equal(JSON.stringify(f.history.at(-1)),before);
});
test('multi-point V works across separately selected wall drafts',()=>{
 const a={id:'a',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:4},{x:4,y:0,z:4}]},b={id:'b',bottom:[{x:4,y:0,z:0},{x:4,y:4,z:0}],top:[{x:4,y:0,z:4},{x:4,y:4,z:4}]},f=fixture({walls:[a,b],selected:null});
 f.editor.beginFace(f.e(2,2),a);f.listeners.pointerup(f.e(2,2));f.editor.beginFace(f.e(2,2),b);f.listeners.pointerup(f.e(2,2));const drafts=f.state.wallEdits.$drafts,groups={};for(const key of ['a','b'])groups[key]=[S.add(drafts[key],{x:2,y:1,z:0},.0001)];
 f.editor.restoreSelection({activeDraftKey:'a',picked:groups.a,draftSelection:groups});f.editor.key({key:'v'});assert.equal(f.editor.interaction(),'H/V cut',f.message());for(const d of Object.values(f.state.wallEdits.$drafts))assert.ok(d.sketch.edges.some(e=>!e.fixed));f.editor.finishAxisCut();assert.equal(f.editor.busy(),false);
});

test('batch H cuts the base from two selected perimeter points in one transaction',()=>{
 const p=(x,y)=>({x,y,z:0}),base={faces:[{id:'base',points:[p(0,0),p(4,0),p(4,4),p(0,4)]}]},f=fixture({state:{base,wallEdits:{}},walls:[],selected:null});const before=JSON.stringify(f.state.wallEdits);
 f.editor.cutFromPoints([p(1,0),p(3,0)],'h','base');assert.equal(f.editor.interaction(),'H/V cut',f.message());assert.equal(f.state.wallEdits.$base.faces.length,3);f.editor.finishAxisCut();assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
});

for(const count of [1,2])test(`copied ${count} sticker group shares placement snapping and T trim before and after placement`,()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),p=(x,z)=>({x,y:0,z}),stickers=Array.from({length:count},(_,i)=>({id:'window-'+i,points:[p(1+2*i,1),p(2+2*i,1),p(2+2*i,2.5),p(1+2*i,2.5)],feature:{type:'window',shape:'custom',axis:p(1,0)}})),host={id:'host',points:[p(0,0),p(12,0),p(12,6),p(0,6)]};let calls=[];
 const globals={...renderGlobals(),WallFeatures:{...F,placeGroup(...args){const result=F.placeGroup(...args);calls.push({shapes:args[0],targets:args[1],result});return result;}}},f=fixture({state:{wallEdits:{$surfaces:[...stickers,host],$loose:{points:[p(8,0)],edges:[]}}},walls:[],selected:null,globals,featureHost:()=>({solid:host,points:host.points})});
 f.editor.clipboardCommand('copy',{points:stickers.flatMap(f=>f.points)});const clipboard=JSON.stringify(f.clipboard()),before=JSON.stringify(f.state.wallEdits);f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(8.46,3.05));assert.equal(calls.at(-1).shapes.length,count);assert.ok(calls.at(-1).targets.some(r=>r.length===1&&Math.abs(r[0].x-8)<1e-8),'same intentional point guides as sticker tool');
 const geometry=JSON.stringify(calls.at(-1).result);f.editor.key({key:'t'});f.editor.key({key:'t'});assert.equal(JSON.stringify(calls.at(-1).result),geometry,'T does not rotate or translate copied stickers');assert.equal(JSON.stringify(f.clipboard()),clipboard);assert.equal(JSON.stringify(f.state.wallEdits),before);
 f.editor.key({key:'Enter'});assert.equal(f.editor.busy(),false,f.message());const placed=M.collect(f.state).filter(s=>s.feature&&!stickers.some(o=>o.id===s.id));assert.equal(placed.length,count);assert.ok(placed.some(s=>s.points.some(p=>Math.abs(p.x-8)<1e-8)),'group snaps a sticker edge to the loose point guide');assert.ok(placed.every(s=>Math.abs(s.feature.trim.width-3*.0254)<1e-8));for(const s of placed){const b=F.dimensions(s.points,s.feature).bounds;assert.ok(Math.abs(b.right-b.left-1)<1e-8);assert.ok(Math.abs(b.top-b.bottom-1.5)<1e-8);}
 if(count===2){const centers=placed.map(s=>s.points.reduce((sum,p)=>sum+p.x/4,0)).sort();assert.ok(Math.abs(centers[1]-centers[0]-2)<1e-8);}
 assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);f.editor.key({key:'t'});assert.ok(M.collect(f.state).filter(s=>s.feature&&!stickers.some(o=>o.id===s.id)).every(s=>Math.abs(s.feature.trim.width-4*.0254)<1e-8),'placed group remains selected for T');
});
test('fresh and copied sticker placement share the same snap solver and copied cancellation restores everything',()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),p=(x,z)=>({x,y:0,z}),host={id:'host',points:[p(0,0),p(8,0),p(8,6),p(0,6)]};let groups=0;
 const f=fixture({state:{wallEdits:{$surfaces:[host]}},walls:[],selected:null,globals:{...renderGlobals(),WallFeatures:{...F,placeGroup(...args){groups++;return F.placeGroup(...args);}}},featureHost:()=>({solid:host,points:host.points})});
 f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));assert.ok(groups);f.editor.down(f.e(2,2));f.editor.clipboardCommand('copy');const before=JSON.stringify(f.state.wallEdits),history=f.history.length;groups=0;f.editor.clipboardCommand('paste');f.listeners.pointermove(f.e(5,2));assert.ok(groups);f.editor.key({key:'t'});f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,history);
});

for(const count of [1,2])test(`copying ${count} selected windows excludes coincident wall patches and keeps cross-wall sticker snapping`,()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),p=(x,z)=>({x,y:0,z}),windows=Array.from({length:count},(_,i)=>({id:'selected-'+i,points:[p(1+2*i,1),p(2+2*i,1),p(2+2*i,2.5),p(1+2*i,2.5)],feature:{type:'window'}})),patches=windows.flatMap((w,i)=>[{id:'patch-'+i,points:w.points},{id:'triangle-'+i,points:w.points.slice(0,3)}]),other={id:'around-corner',feature:{type:'window'},points:[{x:20,y:1,z:3.3},{x:20,y:2,z:3.3},{x:20,y:2,z:4.3},{x:20,y:1,z:4.3}]},host={id:'host',points:[p(0,0),p(12,0),p(12,6),p(0,6)]};let result;
 const f=fixture({state:{wallEdits:{$surfaces:[...windows,...patches,other,host]}},walls:[],selected:null,globals:{...renderGlobals(),WallFeatures:{...F,placeGroup(...args){result=F.placeGroup(...args);return result;}}},featureHost:()=>({solid:host,points:host.points})});
 f.editor.restoreSelection({selectedSolid:windows[0].id,faceSelection:windows.map(w=>({solid:w.id}))});f.editor.key({key:'c',ctrlKey:true});const clip=f.clipboard();assert.equal(clip.faces.length,count,'unselected wall patches are not copied');assert.ok(clip.faces.every(f=>f.feature));assert.equal(clip.edges.length,4*count,'no diagonal from an unselected wall triangle');
 f.editor.key({key:'v',ctrlKey:true});f.listeners.pointermove(f.e(8,3.61));assert.equal(result?.length,count,f.message());assert.ok(result.every(r=>Math.abs(Math.max(...r.map(p=>p.y))-4.3)<1e-7),'tops align with window on perpendicular wall');const before=JSON.stringify(result);f.editor.key({key:'t'});assert.equal(JSON.stringify(result),before,'trim preserves aligned placement');f.editor.key({key:'Escape'});
});

for(const draft of [false,true])test(`T trims a recessed garage ${draft?'draft':'solid'} without flipping or moving it`,()=>{
 const F=require('../public/measure/internal/editor_scripts/wall_features.js'),p=(x,z)=>({x,y:.1524,z}),door={id:'garage',points:[p(0,0),p(16*F.FT,0),p(16*F.FT,7*F.FT),p(0,7*F.FT)],feature:{type:'garage'}},state={wallEdits:{$surfaces:[door]}};
 if(draft){const saved=structuredClone(require('./fixtures/sticker-attached-cuts.json'));saved.draft.faces.find(f=>f.feature).feature={type:'garage'};state.wallEdits={$drafts:{saved:saved.draft},$surfaces:[saved.surface]};}
 const f=fixture({state,walls:[],selected:null,globals:renderGlobals()});
 f.editor.selectOpeningTrim('garage');if(draft)f.editor.applyOpeningTrim('garage',0);f.listeners.pointermove(f.e(2,1));const snapshot=()=>JSON.stringify(f.state.wallEdits,(key,value)=>key==='drafted'?undefined:value),before=snapshot(),points=JSON.stringify(f.editor.openingTrimItems('garage')[0].points);
 for(const inches of [2,3,4,6,0]){assert.equal(f.editor.key({key:'t'}),true);assert.equal(f.editor.busy(),false,'T never enters Flip');const item=f.editor.openingTrimItems('garage')[0];assert.equal(JSON.stringify(item.points),points);assert.ok(Math.abs((item.f.feature.trim?.width||0)-inches*.0254)<1e-8);}
 assert.deepEqual(JSON.parse(snapshot()),JSON.parse(before),'full cycle changes no geometry');
});


test('Shift-click on empty space preserves selected lines and points',()=>{
 const f=fixture({selected:null}),pair=[f.w.top[0],f.w.top[1]];
 f.editor.restoreSelection({lineSelection:[{id:'top',pair}]});
 f.editor.down(f.e(30,30,true));f.listeners.pointerup(f.e(30,30,true));
 assert.equal(f.editor.selectionSnapshot().lineSelection.length,1);
 f.editor.restoreSelection({solidPoints:[require('../public/measure/internal/editor_scripts/wall_solid_geometry').vertexKey(pair[0])]});
 f.editor.down(f.e(30,30,true));f.listeners.pointerup(f.e(30,30,true));
 assert.equal(f.editor.selectionSnapshot().solidPoints.length,1);
});

test('resoffit commits one local edit with attached base, persists and can restore its undo snapshot',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),p=(x,y,z)=>({x,y,z}),roof={faces:[{id:0,points:[p(-2,-2,5),p(8,-2,5),p(8,8,5),p(-2,8,5)]}]};
 const wall=(id,a,b)=>({id,points:[p(...a,0),p(...b,0),p(...b,5),p(...a,5)]});
 const state={roof,sources:[{id:'fixture-eave',kind:'perimeter',type:'eave',parentId:0,originalA:p(0,0,5),originalB:p(4,0,5),a:p(0,.6096,5),b:p(4,.6096,5),setback:.6096,sourcePlane:{dx:0,dy:0,k:5}}],base:{faces:[{id:'base',points:[p(0,.6096,0),p(4,.6096,0),p(4,3,0),p(0,3,0)]}]},wallEdits:{$surfaces:[wall('front',[0,.6096],[4,.6096]),wall('left',[0,3],[0,.6096]),wall('right',[4,.6096],[4,3])]}};
 const f=fixture({state,walls:[],selected:null,globals:{WallResoffit:R}}),before=JSON.stringify(state.wallEdits);
 f.editor.restoreSelection({lineSelection:[{pair:state.wallEdits.$surfaces[0].points.slice(2)}]});assert.equal(f.editor.resoffit(.1524),true,f.message());assert.equal(f.history.length,1);
 assert.ok(state.wallEdits.$surfaces.find(f=>f.id==='front').points.every(p=>Math.abs(p.y-.1524)<1e-8));assert.ok(state.wallEdits.$base.faces[0].points.some(p=>Math.abs(p.y-.1524)<1e-8));
 const saved=JSON.parse(JSON.stringify(state)),reloaded=fixture({state:saved,walls:[],selected:null,globals:{WallResoffit:R}});assert.ok(reloaded.editor.soffitEdges().some(c=>Math.abs(c.inset-.1524)<1e-8));
 state.wallEdits=f.history.pop();assert.equal(JSON.stringify(state.wallEdits),before);
});

test('resoffit uses the merged turret wall rather than inverting a tiny source fragment',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18),wall=r.composed.find(w=>w.id==='R49:0');
 const f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}});f.editor.restoreSelection({lineSelection:[{pair:wall.top}]});
 assert.equal(f.editor.resoffit(.1524),true,f.message());assert.equal(f.history.length,1);
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry');for(const line of f.editor.selectionSnapshot().lineSelection)assert.ok(f.editor.soffitEdges().some(c=>W.sharedIntervals(...line.pair,[{points:c.pair}]).length),'selection stays on actual projected edges');
 assert.equal(f.editor.resoffit(.1524),true,f.message());assert.equal(f.editor.selectionSnapshot().lineSelection.length,1);
});


test('Resoffit picks roof-contact lines despite near-surface occlusion and adds multiple without Shift',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),p=(x,y,z)=>({x,y,z}),wall={id:'w',bottom:[p(0,0,0),p(4,0,0)],top:[p(0,0,4),p(4,0,4)]},roof={faces:[{id:0,points:[p(-1,-1,4),p(8,-1,4),p(8,4,4),p(-1,4,4)]}]};
 const state={roof,sources:[{id:'fixture-eave',kind:'perimeter',type:'eave',parentId:0,originalA:p(0,-.6,4),originalB:p(4,-.6,4),a:wall.top[0],b:wall.top[1],setback:.6,sourcePlane:{dx:0,dy:0,k:4}}],wallEdits:{}};
 const f=fixture({state,walls:[wall],selected:null,globals:{WallResoffit:R},pickLineVisible:()=>false,pickSoffitVisible:()=>true});
 f.editor.setResoffitMode(true);f.editor.restoreSelection({lineSelection:[{id:'other',pair:[p(6,0,4),p(8,0,4)]}]});
 assert.equal(f.editor.pickLine3D(f.e(2,4)),true);f.listeners.pointerup(f.e(2,4));assert.equal(f.editor.selectionSnapshot().lineSelection.length,2);
 assert.equal(f.editor.pickLine3D(f.e(2,4)),true);f.listeners.pointerup(f.e(2,4));assert.equal(f.editor.selectionSnapshot().lineSelection.length,1);
 assert.equal(f.editor.pickLine3D(f.e(2,0)),false,'base edges are excluded');
});


for(const source of ['R134.0','R23.0'])test(`resoffit preserves surveyed junctions and clips intermediate roof vertices at ${source}`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18);
 const f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}}),line=f.editor.soffitEdges().find(c=>c.source.id===source);assert.ok(line);
 f.editor.restoreSelection({lineSelection:[{pair:line.pair}]});assert.equal(f.editor.resoffit(.1524),true,f.message());assert.equal(f.history.length,1);
});

test('the reconciled lower-tower junction remains editable with Resoffit',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18);
 const f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}}),line=f.editor.soffitEdges().find(c=>c.source.id==='R112.0'),before=JSON.stringify(r.state.wallEdits);
 f.editor.restoreSelection({lineSelection:[{pair:line.pair}]});assert.equal(f.editor.resoffit(.1524),true,f.message());assert.equal(f.history.length,1);assert.equal(JSON.stringify(f.history[0]),before);
 const contacts=f.editor.soffitEdges().filter(c=>c.source.id===line.source.id);assert.ok(contacts.length);assert.ok(contacts.every(c=>Math.abs(c.inset-.1524)<.002));
});


test('roof-contact highlights use screen coordinates and render above the roof only when visible',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),p=(x,y,z)=>({x,y,z}),pair=[p(0,0,4),p(4,0,4)],seen=[],segments=[];
 const state={wallEdits:{},roof:{faces:[{id:0,points:[p(-1,-1,4),p(5,-1,4),p(5,2,4),p(-1,2,4)]}]},sources:[{id:'s',kind:'perimeter',type:'eave',parentId:0,originalA:p(0,-.6,4),originalB:p(4,-.6,4),a:pair[0],b:pair[1],setback:.6,sourcePlane:{dx:0,dy:0,k:4}}]};
 const f=fixture({state,selected:null,globals:{...renderGlobals(),WallResoffit:R},pickSoffitVisible:(pair,e)=>{seen.push(e);return true;}});
 f.editor.draw3D({add:o=>segments.push(o.material)},p=>p);
 assert.ok(seen.length);assert.ok(seen.every(e=>Number.isFinite(e.clientX)&&Number.isFinite(e.clientY)));assert.ok(segments.some(s=>s.color===R.COLOR&&s.depthTest===false));
});

for(const solid of [false,true])test(`Shift line miss over ${solid?'materialized':'draft'} face retains the lines`,()=>{
 const globals=renderGlobals(),f=fixture({globals}),pair=f.w.top;
 if(solid){f.state.wallEdits.$surfaces=[{id:'panel',points:[...f.w.bottom,f.w.top[1],f.w.top[0]]}];f.editor.draw3D({add(){}},p=>p);}else f.editor.down(f.e(2,2),true);
 f.editor.restoreSelection({lineSelection:[{id:'top',pair}]});
 const before=JSON.stringify(f.editor.selectionSnapshot());f.editor.down(f.e(2,2,true));f.listeners.pointerup(f.e(2,2,true));
 assert.equal(JSON.stringify(f.editor.selectionSnapshot()),before);
});
test('Shift empty rectangle with click jitter preserves line selection',()=>{
 const f=fixture({selected:null}),pair=f.w.top;f.editor.restoreSelection({lineSelection:[{id:'top',pair}]});
 const before=JSON.stringify(f.editor.selectionSnapshot());f.editor.startBox(f.e(30,30,true),()=>{});f.listeners.pointerup(f.e(30.06,30.06,true));
 assert.equal(JSON.stringify(f.editor.selectionSnapshot()),before);
});

test('Shift adds multiple edges and preserves them on face, endpoint and empty misses',()=>{
 const f=fixture(),click=(x,y)=>{const e=f.e(x,y,true);f.editor.down(e);f.listeners.pointerup(e);};
 click(2,4);click(0,2);assert.equal(f.editor.selectionSnapshot().lineSelection.length,2);
 for(const [x,y]of [[2,2],[4,4],[30,30]]){const before=JSON.stringify(f.editor.selectionSnapshot());click(x,y);assert.equal(JSON.stringify(f.editor.selectionSnapshot()),before);}
});
test('Shift rectangle adds contained lines without dropping previously selected lines',()=>{
 const f=fixture({selected:null});f.editor.restoreSelection({lineSelection:[{id:'existing',pair:[{x:8,y:0,z:0},{x:9,y:0,z:0}]}]});
 f.editor.startBox(f.e(-.2,3.8,true),()=>{});f.listeners.pointerup(f.e(4.2,4.2,true));
 const lines=f.editor.selectionSnapshot().lineSelection;assert.equal(lines.length,2);assert.equal(lines[0].id,'existing');assert.ok(lines[1].pair.every(p=>p.z===4));
});


for(const source of ['R37.0','R38.0','R43.0','R44.0','R46.1','R57.0','R58.0','R63.0','R64.0','R66.1','R77.0','R78.0','R83.0','R84.0','R86.1'])test(`turret Resoffit reconciles ${source} independently, repeatedly and after reload`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18);
 let f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}});
 const before=f.editor.soffitEdges(),line=before.find(c=>c.source.id===source);assert.ok(line);
 f.editor.restoreSelection({lineSelection:[{pair:line.pair}]});
 for(const depth of [.6096,.1524,0,.3048]){
  const snapshot=JSON.stringify(r.state.wallEdits);assert.equal(f.editor.resoffit(depth),true,`${depth}: ${f.message()}`);
  const selection=f.editor.selectionSnapshot();assert.ok(selection.lineSelection.length,'selected contact survives topology changes');
  for(const face of (r.state.wallEdits.$surfaces||[]).filter(f=>!f.deleted))K.validateFace(face);
  for(const face of (r.state.wallEdits.$base?.faces||[]).filter(f=>!f.deleted))K.validateFace(face);
  const after=f.editor.soffitEdges(),selected=after.filter(c=>c.source.id===source);assert.ok(selected.length);
  assert.ok(selected.every(c=>Math.abs(c.inset-depth)<.002),'requested depth is absolute');
  for(const c of after.filter(c=>c.source.id!==source)){const old=before.find(o=>o.source.id===c.source.id);if(old)assert.ok(Math.abs(old.inset-c.inset)<.003,`neighbor ${c.source.id} retains its plane`);}
  const undo=f.history.at(-1);assert.equal(JSON.stringify(undo),snapshot,'one complete undo snapshot');
  const persisted=JSON.parse(JSON.stringify(r.state.wallEdits));r.state.wallEdits=persisted;
  f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}});f.editor.restoreSelection(selection);
 }
});

test('mixed and combined turret depths retain shared corners and exact selections',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18),f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}});
 const ids=['R37.0','R38.0','R43.0','R44.0','R46.1'];
 for(const [selected,depth]of [[ids,.6096],[['R37.0'],.1524],[['R38.0','R44.0'],.3048],[ids,0],[ids,.6096]]){
  const lines=f.editor.soffitEdges().filter(c=>selected.includes(c.source.id));assert.ok(lines.length>=selected.length);
  f.editor.restoreSelection({lineSelection:lines.map(c=>({pair:c.pair}))});assert.equal(f.editor.resoffit(depth),true,f.message());
  for(const face of r.state.wallEdits.$surfaces.filter(f=>!f.deleted))K.validateFace(face);
  assert.ok(f.editor.soffitEdges().filter(c=>selected.includes(c.source.id)).every(c=>Math.abs(c.inset-depth)<.002));
 }
});


for(const source of ['R37.0','R46.1','R57.0','R66.1','R77.0','R86.1'])test(`deep turret Resoffit ${source} consumes its short return without reversing it`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18),f=fixture({state:r.state,walls:r.composed,selected:null,globals:{WallResoffit:R}}),line=f.editor.soffitEdges().find(c=>c.source.id===source);
 f.editor.restoreSelection({lineSelection:[{pair:line.pair}]});assert.equal(f.editor.resoffit(.9144),true,f.message());
 const contacts=f.editor.soffitEdges().filter(c=>c.source.id===source);assert.ok(contacts.length);assert.ok(contacts.every(c=>Math.abs(c.inset-.9144)<.002));
 assert.ok(r.state.wallEdits.$surfaces.some(f=>f.deleted),'consumed face is removed');
 for(const face of r.state.wallEdits.$surfaces.filter(f=>!f.deleted))K.validateFace(face);
});
// Use the same minimum wall span as wall_editor.apply before building drafts.
for(const initial of [18,24])for(const roofId of [34,35,36,37])test(`zero Resoffit reconciles chimney cap ${roofId} from ${initial} inches and survives repeated edits`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),initial),walls=r.composed.filter(w=>Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)>.005);
 let f=fixture({state:r.state,walls,selected:null,globals:{WallResoffit:R}});
 for(const depth of [0,0,.1524,0]){
  const lines=f.editor.soffitEdges().filter(c=>c.source.parentId===roofId);assert.ok(lines.length>=2,'both roof-contact sides remain selectable');
  f.editor.restoreSelection({lineSelection:lines.map(c=>({pair:c.pair}))});const before=JSON.stringify(r.state.wallEdits);
  assert.equal(f.editor.resoffit(depth),true,f.message());assert.equal(JSON.stringify(f.history.at(-1)),before,'one complete undo snapshot');
  const selected=f.editor.soffitEdges().filter(c=>c.source.parentId===roofId);assert.ok(selected.length>=2);assert.ok(selected.every(c=>Math.abs(c.inset-depth)<.002),'zero is a real absolute depth');
  for(const face of r.state.wallEdits.$surfaces.filter(f=>!f.deleted))K.validateFace(face);
  for(const face of r.state.wallEdits.$base.faces.filter(f=>!f.deleted))K.validateFace(face);
  const selection=f.editor.selectionSnapshot();assert.ok(selection.lineSelection.length>=2);
  r.state.wallEdits=JSON.parse(JSON.stringify(r.state.wallEdits));f=fixture({state:r.state,walls,selected:null,globals:{WallResoffit:R}});f.editor.restoreSelection(selection);
 }
});

test('selection reuses derived roof contacts and invalidates them after in-place geometry changes and undo',()=>{
 const p=(x,y,z)=>({x,y,z});let calls=0;
 const state={wallEdits:{},roof:{faces:[]}},walls=[{id:'w',bottom:[p(0,0,0),p(4,0,0)],top:[p(0,0,4),p(4,0,4)]}];
 const f=fixture({state,walls,selected:null,globals:{WallResoffit:{candidates:()=>{calls++;return [{id:'contact',pair:walls[0].top}];}}}});
 f.editor.setResoffitMode(true);
 const click=z=>{const e=f.e(2,z);assert.equal(f.editor.pickLine3D(e),true);f.listeners.pointerup(e);};
 click(4);click(4);assert.equal(calls,1,'selection changes reuse contacts');
 walls[0].top.forEach(p=>p.z=5);click(5);assert.equal(calls,2,'in-place wall changes invalidate');
 walls[0].top.forEach(p=>p.z=4);click(4);assert.equal(calls,3,'undo invalidates');
 state.roof.faces.push({id:2});click(4);assert.equal(calls,4,'roof changes invalidate');
});

for(const resoffit of [true,false])test(`Displayed merged contact is selectable with Resoffit ${resoffit} when the sketch lacks that exact edge`,()=>{
 const pair=[{x:1,y:0,z:3},{x:3,y:0,z:3}];
 const f=fixture({state:{wallEdits:{},roof:{faces:[]}},selected:null,pickLineVisible:()=>false,pickSoffitVisible:()=>true,globals:{WallResoffit:{candidates:()=>[{id:'merged-contact',pair}]}}});
 f.editor.setResoffitMode(resoffit);const e=f.e(2,3);assert.equal(f.editor.pickLine3D(e),true);f.listeners.pointerup(e);
 assert.equal(f.editor.selectionSnapshot().lineSelection[0].id,'merged-contact');
});

test('rectangle line visibility is evaluated at its line, not the release corner',()=>{
 const seen=[],f=fixture({selected:null,pickLineVisible:(pair,e)=>{seen.push(e);return e.clientX===200&&e.clientY===400;}});
 f.editor.restoreSelection({lineSelection:[{id:'existing',pair:[{x:8,y:0,z:0},{x:9,y:0,z:0}]}]});
 f.editor.startBox(f.e(-.2,3.8,true),()=>{});f.listeners.pointerup(f.e(4.2,4.2,true));
 assert.equal(f.editor.selectionSnapshot().lineSelection.length,2);assert.ok(seen.length);
});

for(const initial of [18,24])test(`turret Resoffit consumes old sketch boundaries from ${initial} inches without ghost lines or points`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),C=require('../public/measure/internal/editor_scripts/wall_chimneys'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),initial);
 const walls=r.composed.filter(w=>Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)>.005),globals={...renderGlobals(),WallResoffit:R,WallChimneys:C};
 const manual=[{x:1000,y:1000,z:0},{x:1001,y:1000,z:1}];r.state.wallEdits ||= {};r.state.wallEdits.$loose={points:manual,edges:[manual]};
 let f=fixture({state:r.state,walls,selected:null,globals});
 const cyan=()=>{const result=[];f.editor.draw3D({add:o=>{if(o.material?.color==='#6ce4ed')result.push(...o.geometry.points);}},p=>p);return result;};
 f.editor.startBox(f.e(-500,-500),()=>{});f.listeners.pointerup(f.e(-499,-499));
 const baseline=new Set(cyan().map(p=>[p.x,p.y,p.z].map(v=>v.toFixed(5)).join(',')));
 const check=()=>{const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),points=cyan();assert.ok(points.length,'manual loose edge remains');
  const surfaces=(r.state.wallEdits.$surfaces||[]).filter(f=>!f.deleted&&!f.drafted);
  const supported=p=>surfaces.some(f=>{const frame=K.frame(f),q=K.local(frame,p);return Math.abs(q.z)<K.CONTACT&&G.contains({points:f.points.map(p=>K.local(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>K.local(frame,p)))},q);});
  assert.ok(points.every(p=>baseline.has([p.x,p.y,p.z].map(v=>v.toFixed(5)).join(','))||supported(p)),'retained points stay on actual replacement faces');
  f.editor.draw3D({add:o=>{if(o.material?.color==='#6ce4ed'&&o.geometry.points.length===2)assert.ok(o.geometry.points.every(p=>p.x>=1000),'no leftover source edges: '+JSON.stringify(o.geometry.points));}},p=>p);
 };
 check();
 for(const depth of [.1524,.6096,.1524]){
  const contacts=f.editor.soffitEdges().filter(c=>['R37.0','R38.0','R43.0','R44.0','R46.1'].includes(c.source.id));assert.ok(contacts.length>=5);
  f.editor.restoreSelection({lineSelection:contacts.map(c=>({pair:c.pair}))});const before=JSON.stringify(r.state.wallEdits);
  assert.equal(f.editor.resoffit(depth),true,f.message());assert.equal(JSON.stringify(f.history.at(-1)),before);check();
  const saved=JSON.parse(JSON.stringify(r.state));f=fixture({state:saved,walls,selected:null,globals});f.normalize();r.state=saved;check();
  assert.deepEqual(JSON.parse(JSON.stringify(saved.wallEdits.$loose.edges)),[manual],'unrelated manually drawn geometry survives');
 }
});

test('reload repairs stale consumed Resoffit masks without moving replacement faces',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),C=require('../public/measure/internal/editor_scripts/wall_chimneys'),r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),24),walls=r.composed.filter(w=>Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)>.005),globals={...renderGlobals(),WallResoffit:R,WallChimneys:C};
 let f=fixture({state:r.state,walls,selected:null,globals});
 f.editor.startBox(f.e(-500,-500),()=>{});f.listeners.pointerup(f.e(-499,-499));
 const old=JSON.parse(JSON.stringify(r.state.wallEdits.$drafts));
 f.editor.restoreSelection({lineSelection:f.editor.soffitEdges().filter(c=>['R37.0','R38.0','R43.0','R44.0','R46.1'].includes(c.source.id)).map(c=>({pair:c.pair}))});assert.equal(f.editor.resoffit(.1524),true,f.message());
 for(const [key,d]of Object.entries(r.state.wallEdits.$drafts))for(const face of d.faces)if(face.solidId?.startsWith('line-move-')){const source=old[key].faces.find(o=>o.id===face.id);face.points=source.points;face.holes=source.holes;}
 const saved=JSON.parse(JSON.stringify(r.state));f=fixture({state:saved,walls,selected:null,globals});
 const ghosts=()=>{let count=0;f.editor.draw3D({add:o=>{if(o.material?.color==='#6ce4ed')count++;}},p=>p);return count;};
 const stale=ghosts();assert.ok(stale>0,'old persisted bookkeeping reproduces the visible leftovers');const surfaces=JSON.stringify(saved.wallEdits.$surfaces);
 f.normalize();assert.ok(ghosts()<stale,'stale source wire is removed');const lines=[];f.editor.draw3D({add:o=>{if(o.material?.color==='#6ce4ed'&&o.geometry.points.length===2)lines.push(o);}},p=>p);assert.equal(lines.length,0);assert.equal(JSON.stringify(saved.wallEdits.$surfaces),surfaces,'only source masks change');
 const repaired=JSON.stringify(saved.wallEdits);f.normalize();assert.equal(JSON.stringify(saved.wallEdits),repaired,'repair is idempotent');
});


test('Q crosses the top and side of a wall without discarding existing draft points',()=>{
 const f=fixture({globals:{isFreeMove:true}});f.editor.doubleClick(f.e(2,4),f.w);
 f.editor.doubleClick(f.e(1,1),f.w);const original=JSON.parse(JSON.stringify(f.d().sketch.nodes));
 f.editor.key({key:'q'});f.editor.down(f.e(5,5));f.editor.down(f.e(5,5));
 assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,3);
 for(const n of original)assert.ok(f.d().sketch.nodes.some(p=>p.id===n.id&&p.x===n.x&&p.y===n.y),'preserve existing point');
 assert.ok(f.d().faces.some(face=>face.points.some(p=>p.x===5&&p.y===5)),'extend face beyond original bounds');
 assert.ok(f.d().faces.some(face=>G.contains(face,{x:4.5,y:4.5})&&!face.opening),'exterior region is wall material');
});


test('generated collinear wall subdivisions do not become sketch anchors, while drawn points persist',()=>{
 const walls=G.mergeCoplanar(Array.from({length:7},(_,i)=>({id:i?'part-'+i:'w',sourceId:'R1',kind:'perimeter',bottom:[{x:i,y:0,z:0},{x:i+1,y:0,z:0}],top:[{x:i,y:0,z:4},{x:i+1,y:0,z:4}]}))).walls;
 const f=fixture({walls});f.editor.pickLine3D(f.e(3.5,4));f.listeners.pointerup(f.e(3.5,4));const pair=f.editor.selectionSnapshot().lineSelection[0].pair;assert.equal(Math.abs(pair[1].x-pair[0].x),7,'select the full displayed edge');f.editor.beginFace(f.e(.5,2),walls[0]);f.listeners.pointerup(f.e(.5,2));
 const d=f.state.wallEdits.$drafts[walls[0].mergeGroup];assert.equal(d.sketch.nodes.length,4);
 f.editor.doubleClick(f.e(2,4),walls[0]);assert.ok(d.sketch.nodes.some(n=>n.x===2&&n.y===4&&n.userDraftPoint));
 const loaded=fixture({walls,state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()});loaded.editor.draw3D({add(){}},p=>p);
 assert.equal(loaded.state.wallEdits.$drafts[walls[0].mergeGroup].sketch.nodes.length,5);
});

test('survey-noise roof stations form one selectable edge and do not return when editing',()=>{
 const heights=[4,3.98,3.975,4.002,3.99,4.01,4.005,4];
 const walls=G.mergeCoplanar(Array.from({length:7},(_,i)=>({id:i?'part-'+i:'w',sourceId:'R1',kind:'perimeter',bottom:[{x:i,y:0,z:0},{x:i+1,y:0,z:0}],top:[{x:i,y:0,z:heights[i]},{x:i+1,y:0,z:heights[i+1]}]}))).walls;
 const before=JSON.stringify(walls),geo=G.topology(walls);assert.equal(geo.faces[0].pointIndices.length,4);assert.equal(geo.faces[0].triangles.length,2,'mesh comes from the canonical outline');assert.ok(walls.every(w=>w.top.every(p=>Math.abs(p.z-4)<1e-9)),'actual source walls must be straight too');assert.ok(geo.points.every(p=>Math.abs(p.z)<1e-9||Math.abs(p.z-4)<1e-9),'filled triangles cannot keep the old ragged edge');assert.equal(JSON.stringify(walls),before);
 const f=fixture({walls});f.editor.pickLine3D(f.e(3.5,4));f.listeners.pointerup(f.e(3.5,4));const pair=f.editor.selectionSnapshot().lineSelection[0].pair;assert.equal(Math.abs(pair[1].x-pair[0].x),7);
 f.editor.beginFace(f.e(.5,2),walls[0]);f.listeners.pointerup(f.e(.5,2));const d=f.state.wallEdits.$drafts[walls[0].mergeGroup];assert.equal(d.sketch.nodes.length,4);
 f.editor.doubleClick(f.e(2,4),walls[0]);assert.ok(d.sketch.nodes.some(n=>n.x===2&&n.y===4&&n.userDraftPoint));
 const loaded=fixture({walls,state:JSON.parse(JSON.stringify(f.state)),globals:renderGlobals()});loaded.editor.draw3D({add(){}},p=>p);assert.equal(loaded.state.wallEdits.$drafts[walls[0].mergeGroup].sketch.nodes.length,5);
});

for(const setback of [18,24])test(`captured front wall uses the same edge for its outline, soffit highlight and picking at ${setback} inches`,()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry');
 const r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),setback),walls=r.composed.filter(w=>Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y)>.005),geo=G.topology(walls),front=geo.faces.find(f=>f.mergeGroup?.includes('envelope-0-18-'));
 const edge=front.boundary.map(ids=>ids.map(i=>geo.points[i])).find(pair=>pair.every(p=>p.z>66)&&Math.hypot(...['x','y','z'].map(k=>pair[1][k]-pair[0][k]))>7.5);assert.ok(edge);
 const drawn=[],f=fixture({walls,state:r.state,selected:null,globals:{...renderGlobals(),WallResoffit:R,WallChimneys:require('../public/measure/internal/editor_scripts/wall_chimneys')}});
 const before=JSON.stringify(r.state),key=W.edgeKey(...edge),contacts=f.editor.soffitEdges().filter(c=>W.edgeKey(...c.pair)===key);assert.equal(contacts.length,1,'one full-length red edge, not subdivided contacts');
 f.editor.draw3D({add:o=>{if(o.material?.color===R.COLOR)drawn.push(o.geometry.points);}},p=>p);assert.equal(drawn.filter(pair=>W.edgeKey(...pair)===key).length,1);assert.equal(JSON.stringify(r.state),before,'drawing does not duplicate or modify wall geometry');
 f.editor.setResoffitMode(true);const mid={x:(edge[0].x+edge[1].x)/2,z:(edge[0].z+edge[1].z)/2};assert.equal(f.editor.pickLine3D(f.e(mid.x,mid.z)),true);f.listeners.pointerup(f.e(mid.x,mid.z));
 assert.equal(W.edgeKey(...f.editor.selectionSnapshot().lineSelection[0].pair),key);
 assert.equal(f.editor.resoffit(.3048),true,f.message());
});

test('captured house front wall stays a four-corner outline when selected',()=>{
 const r=require('./roof-generation-fixture.cjs').build(require('./fixtures/layered-turrets-roof.json'),18),walls=r.composed;
 const wall=walls.find(w=>w.mergeGroup?.includes('envelope-0-18-')),f=fixture({walls,state:r.state,globals:{WallChimneys:require('../public/measure/internal/editor_scripts/wall_chimneys')}});assert.ok(wall);
 f.editor.beginFace(f.e(0,65),wall);f.listeners.pointerup(f.e(0,65));
 const d=f.state.wallEdits.$drafts[wall.mergeGroup];assert.ok(d);assert.equal(d.sketch.nodes.length,4);
});

test('point drawing continues outside the active wall plane outline',()=>{
 const f=fixture({globals:{isFreeMove:true}});f.editor.doubleClick(f.e(1,1),f.w);f.editor.doubleClick(f.e(5,6));
 assert.ok(f.d().sketch.nodes.some(p=>p.x===5&&p.y===6),f.message());
});


test('wall arc can sweep outside the original wall outline',()=>{
 const f=fixture({globals:{isFreeMove:true}});f.editor.doubleClick(f.e(4,2),f.w);f.editor.key({key:'s'});
 f.editor.down(f.e(3,2));f.listeners.pointermove(f.e(3,5));f.editor.down(f.e(3,5));
 assert.equal(f.editor.busy(),false,f.message());assert.equal(f.d().sketch.curves.length,1);
 assert.ok(S.curveEdges(f.d().sketch).some(e=>e.start.y>4||e.end.y>4));
});


function slopedBoundaryQuad(){
 const w={id:'w',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:4.04},{x:4,y:0,z:4}]};
 const f=fixture({walls:[w],globals:{isFreeMove:true}});f.editor.doubleClick(f.e(1,4.03),w);f.editor.key({key:'q'});f.editor.down(f.e(3,0));f.editor.down(f.e(3,0));
 f.editor.pickSolid(f.e(3,2));f.listeners.pointerup(f.e(3,2));return f;
}
function assertQuadDivider(f,x){
 const d=f.d(),pair=f.editor.selectionSnapshot().lineSelection[0].pair;
 assert.ok(pair.every(p=>Math.abs(p.x-x)<1e-7),f.message());
 assert.ok(d.faces.filter(f=>!f.solidId).some(f=>f.points.some((p,i)=>{const q=f.points[(i+1)%f.points.length];return Math.abs(p.x-x)<1e-7&&Math.abs(q.x-x)<1e-7&&Math.abs(p.y-q.y)>3.9;})),'Displayed divider has both moved endpoints');
 const nodes=new Map(d.sketch.nodes.map(n=>[n.id,n]));
 assert.ok(!d.sketch.edges.some(e=>{const a=nodes.get(e.a),b=nodes.get(e.b);return Math.abs(a.y-b.y)>3.9&&Math.abs(a.x-b.x)>1e-7;}),'No diagonal source edge remains');
 assert.equal(new Set(d.sketch.edges.map(e=>[e.a,e.b].sort().join('|'))).size,d.sketch.edges.length,'No duplicate sketch edges');
 assert.equal(d.faces.length,4,'No extra face is spawned');
 assert.ok(!f.state.wallEdits.$surfaces?.length,'Ordinary planar edits keep one owner');
}
test('sloped boundary Q divider nudges both ways before M without clipping or diagonal remnants',()=>{
 const f=slopedBoundaryQuad();let x=3;
 for(const key of ['ArrowRight','ArrowLeft','ArrowLeft','ArrowRight']){assert.equal(f.editor.key({key}),true);x+=key==='ArrowRight'?.0254:-.0254;assertQuadDivider(f,x);}
 assert.equal(f.history.length,6);
});
test('sloped Q mouse and keyboard movement agree, cancel restores state and selection, and reload can move again',()=>{
 const f=slopedBoundaryQuad(),before=JSON.stringify(f.state.wallEdits),selection=JSON.stringify(f.editor.selectionSnapshot().lineSelection);
 f.listeners.pointermove(f.e(3,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.8,2));assertQuadDivider(f,2.8);
 f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(JSON.stringify(f.editor.selectionSnapshot().lineSelection),selection);
 f.editor.key({key:'m'});f.editor.key({key:'ArrowLeft'});assert.equal(f.editor.busy(),false);assertQuadDivider(f,2.9746);assert.equal(JSON.stringify(f.history.at(-1)),before);
 const moved=JSON.stringify(f.state.wallEdits),g=fixture({state:JSON.parse(JSON.stringify(f.state)),walls:[{...f.w,top:[{x:0,y:0,z:4.04},{x:4,y:0,z:4}]}],globals:{isFreeMove:true}});
 g.editor.restoreSelection(f.editor.selectionSnapshot());g.editor.key({key:'ArrowRight'});assertQuadDivider(g,3);assert.equal(JSON.stringify(g.history.at(-1)),moved);
});
test('sloped Q repeated mixed mouse and keyboard edits do not accumulate points, lines, or faces',()=>{
 const f=slopedBoundaryQuad();f.editor.key({key:'ArrowLeft'});const counts=()=>[f.d().sketch.nodes.length,f.d().sketch.edges.length,f.d().faces.length],initial=counts();let x=2.9746;
 for(let i=0;i<20;i++){
  if(i%2){f.listeners.pointermove(f.e(x,2));f.editor.key({key:'m'});const next=x+.0254;f.listeners.pointermove(f.e(next,2));f.editor.down(f.e(next,2));x=next;}
  else{f.editor.key({key:'ArrowLeft'});x-=.0254;}
  assertQuadDivider(f,x);assert.deepEqual(counts(),initial);
 }
});
test('ordinary outer boundary lines can nudge beyond the old wall outline',()=>{
 const f=fixture();f.editor.doubleClick(f.e(2,4),f.w);f.editor.pickSolid(f.e(4,2));f.listeners.pointerup(f.e(4,2));f.editor.key({key:'ArrowRight'});
 assert.ok(f.d().faces.some(r=>r.points.some(p=>p.x>4)),f.message());assert.ok(f.d().sketch.outlines.flat().some(p=>p.x>4));
});

test('moving a planar line away then back creates no undo entry or normalized ghost geometry',()=>{
 const f=slopedBoundaryQuad(),before=JSON.stringify(f.state.wallEdits),count=f.history.length;
 f.listeners.pointermove(f.e(3,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(2.8,2));f.listeners.pointermove(f.e(3,2));f.editor.down(f.e(3,2));
 assert.equal(f.history.length,count);assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.editor.busy(),false);
});

test('horizontal divider movement follows a changing roof and sloping floor profile through a corner',()=>{
 const walls=[{id:'w',sourceId:'a',kind:'perimeter',bottom:[{x:0,y:0,z:0},{x:2,y:0,z:.2}],top:[{x:0,y:0,z:4},{x:2,y:0,z:5}]},{id:'b',sourceId:'b',kind:'perimeter',bottom:[{x:2,y:0,z:.2},{x:4,y:0,z:.4}],top:[{x:2,y:0,z:5},{x:4,y:0,z:3}]}];
 const merged=G.mergeCoplanar(walls).walls,f=fixture({walls:merged,globals:{isFreeMove:true}});
 f.editor.doubleClick(f.e(1,.1),merged[0]);f.editor.key({key:'n'});f.editor.down(f.e(1,4.5));f.listeners.pointerup(f.e(1,4.5));f.editor.pickLine3D(f.e(1,2));f.listeners.pointerup(f.e(1,2));
 let x=1;for(let i=0;i<10;i++){f.editor.key({key:'ArrowRight',shiftKey:true});x+=.1524;const pair=f.editor.selectionSnapshot().lineSelection[0].pair,top=x<=2?4+.5*x:7-x;assert.ok(pair.every(p=>Math.abs(p.x-x)<1e-6));assert.ok(Math.abs(Math.max(...pair.map(p=>p.z))-top)<1e-6,f.message());assert.ok(Math.abs(Math.min(...pair.map(p=>p.z))-.1*x)<1e-6);}
 const before=JSON.stringify(f.state.wallEdits);f.listeners.pointermove(f.e(x,2));f.editor.key({key:'m'});f.listeners.pointermove(f.e(1.5,2));const pair=f.editor.selectionSnapshot().lineSelection[0].pair;assert.ok(Math.abs(Math.max(...pair.map(p=>p.z))-4.75)<1e-6);assert.ok(Math.abs(Math.min(...pair.map(p=>p.z))-.15)<1e-6);f.editor.key({key:'Escape'});assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('A arches a window edge through clicked points and commits one edit with no old chord',()=>{
 const p=(x,z)=>({x,y:0,z}),windowFace={id:'window',points:[p(1,1),p(3,1),p(3,3),p(1,3)],holes:[],feature:{type:'window',preset:0}},state={wallEdits:{$surfaces:[windowFace]}},f=fixture({state,globals:{isFreeMove:true}}),pair=[p(1,3),p(3,3)];
 f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,3));const before=JSON.stringify(state.wallEdits);f.editor.key({key:'a'});assert.equal(f.editor.busy(),true,f.message());
 f.listeners.pointermove(f.e(2,3.7));f.editor.down(f.e(2,3.7));assert.equal(f.history.length,0);f.editor.key({key:'Enter'});assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,1);const face=state.wallEdits.$surfaces.find(f=>f.id==='window');assert.equal(face.feature.shape,'custom');assert.equal(face.curves[0].type,'spline');assert.ok(face.points.some(p=>Math.abs(p.x-2)<1e-8&&Math.abs(p.z-3.7)<1e-8));assert.ok(!face.points.some((p,i)=>Math.abs(p.x-face.points[(i+1)%face.points.length].x)>1.9&&p.z===3&&face.points[(i+1)%face.points.length].z===3));assert.equal(JSON.stringify(f.history[0]),before);
});
for(const finish of ['a','double'])test('arch '+finish+' finishes multiple points; Escape restores all geometry',()=>{
 const p=(x,z)=>({x,y:0,z}),state={wallEdits:{$surfaces:[{id:'panel',points:[p(0,0),p(4,0),p(4,3),p(0,3)],holes:[]}]}},f=fixture({state,globals:{isFreeMove:true}}),pair=[p(0,3),p(4,3)],before=JSON.stringify(state.wallEdits);
 f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,3));f.editor.key({key:'a'});f.editor.down(f.e(.8,3.5));f.editor.key({key:'Escape'});assert.equal(JSON.stringify(state.wallEdits),before);assert.equal(f.history.length,0);
 f.editor.key({key:'a'});f.editor.down(f.e(.8,3.5));f.editor.down(f.e(3.2,3.5));if(finish==='a')f.editor.key({key:'a'});else{f.editor.down(f.e(3.2,3.5));f.editor.doubleClick(f.e(3.2,3.5));}assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,1);assert.equal(state.wallEdits.$surfaces[0].curves[0].controls.length,4);
});
test('arching a generated face rewrites its editable draft boundary instead of leaving a straight support line',()=>{
 const f=fixture({globals:{isFreeMove:true}}),pair=[{x:0,y:0,z:4},{x:4,y:0,z:4}];f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,4));f.editor.key({key:'a'});f.editor.down(f.e(2,5));f.editor.key({key:'Enter'});assert.equal(f.editor.busy(),false,f.message());assert.equal(f.history.length,1);const d=Object.values(f.state.wallEdits.$drafts)[0];assert.ok(d.faces[0].points.some(p=>p.y===5));assert.equal(d.sketch.curves.length,1);assert.ok(!S.curveEdges(d.sketch).some(e=>e.start.y===4&&e.end.y===4&&Math.abs(e.start.x-e.end.x)>3.9));
});

test('drawing-plane A replaces a loose straight segment with a persisted spline',()=>{
 const p=(x,z)=>({x,y:0,z}),pair=[p(1,2),p(3,2)],state={wallEdits:{$loose:{points:pair,edges:[pair]}}},f=fixture({state,globals:{isFreeMove:true}});f.editor.key({key:'p'});const snapshot=f.editor.selectionSnapshot();snapshot.workingPlane.selectedLines=[pair];snapshot.workingPlane.selection=pair;f.editor.restoreSelection(snapshot);f.listeners.pointermove(f.e(2,2));f.editor.key({key:'a'});f.editor.planeDown(f.e(2,3));f.editor.key({key:'Enter'});assert.equal(f.editor.busy(),false,f.message());assert.equal(state.wallEdits.$loose.edges.length,0);assert.ok(Object.values(state.wallEdits.$drafts).some(d=>d.sketch.curves?.some(c=>c.type==='spline')));assert.equal(f.history.length,1);
});
test('finishing A with only on-line points does not manufacture geometry or history',()=>{
 const f=fixture({globals:{isFreeMove:true}}),pair=[{x:0,y:0,z:4},{x:4,y:0,z:4}],before=JSON.stringify(f.state.wallEdits);f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,4));f.editor.key({key:'a'});f.editor.down(f.e(2,4));f.editor.key({key:'Enter'});assert.equal(JSON.stringify(f.state.wallEdits),before);assert.equal(f.history.length,0);
});

test('nudging a solid curve endpoint moves its definition and retains selection',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),p=(x,z)=>({x,y:0,z});
 const c={id:'arc',type:'ellipse',center:p(1,1),u:p(-1,0),v:p(0,1),radiusX:1,radiusY:1,sweep:Math.PI/2},source=K.curvePoint(c,0),face={id:'curved-wall',curves:[c],points:[p(0,0),...K.curveSamples(c),p(2,2),p(2,0)]};
 const f=fixture({state:{wallEdits:{$surfaces:[face]}},walls:[],selected:null,screen:p=>({x:p.x*100,y:-p.z*100})});
 f.editor.restoreSelection({solidPoints:[W.vertexKey(source)]});assert.equal(f.editor.pointSelection().length,1);
 for(let i=1;i<=3;i++){f.editor.key({key:'ArrowDown'});const selected=f.editor.pointSelection();assert.equal(selected.length,1,f.message());assert.ok(Math.abs(selected[0].z-(1-i*.0254))<1e-7,JSON.stringify(selected));const live=f.state.wallEdits.$surfaces.filter(f=>!f.deleted&&!f.drafted);assert.ok(live.some(f=>f.curves?.some(c=>Math.abs(K.curvePoint(c,0).z-selected[0].z)<1e-7)),'analytic endpoint follows selection');}
});

test('fixed curve endpoints remain selected after nudging their analytic boundary',()=>{
 const f=circleDraftFixture(),n=f.d().sketch.nodes.find(n=>Math.abs(n.x-3)<1e-7&&Math.abs(n.y-2)<1e-7);n.fixed=true;
 f.editor.restoreSelection({activeDraftKey:'w',draftSelection:{w:[n.id]},picked:[n.id]});const before=f.editor.pointSelection()[0];
 f.editor.key({key:'ArrowDown'});const after=f.editor.pointSelection();assert.equal(after.length,1,f.message());assert.ok(Math.hypot(after[0].x-before.x,after[0].z-before.z)>.02,'fixed means boundary ownership, not an immovable curve control');
});

test('queued point preview moves the marker without rebuilding or changing geometry',()=>{
 const globals=renderGlobals(),f=fixture({globals,screen:p=>({x:p.x*100,y:-p.z*100})});f.editor.doubleClick(f.e(2,4),f.w);const before=JSON.stringify(f.state.wallEdits),pending={key:'ArrowRight',nudgeCount:2};
 let objects=[];f.editor.drawNudgePreview({add:o=>objects.push(o)},p=>p,pending);assert.ok(Math.abs(objects[0].geometry.points[0].x-(2+.0508))<1e-7);
 pending.nudgeCount=8;objects=[];f.editor.drawNudgePreview({add:o=>objects.push(o)},p=>p,pending);assert.ok(Math.abs(objects[0].geometry.points[0].x-(2+.2032))<1e-7);assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('plane guide stays upright when the supporting frame starts on a diagonal',()=>{
 const p=(x,z)=>({x,y:0,z}),face={points:[p(1,3),p(0,2),p(0,0),p(2,0),p(2,2)]},f=fixture({globals:renderGlobals(),walls:[],selected:null});f.editor.togglePlane(face);const before=JSON.stringify(f.editor.selectionSnapshot()),objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);
 const grid=objects.filter(o=>o.material.color==='#31606b');assert.ok(grid.length>10);for(const o of grid){const [a,b]=o.geometry.points;assert.ok(Math.abs(a.x-b.x)<1e-8||Math.abs(a.z-b.z)<1e-8,'grid is level or vertical');assert.equal(a.y,0);assert.equal(b.y,0);}assert.equal(JSON.stringify(f.editor.selectionSnapshot()),before,'rendering does not rotate drawing coordinates');
});

test('plane line selection renders an edge highlight distinct from two selected endpoints',()=>{
 const p=(x,z)=>({x,y:0,z}),left=[p(0,2),p(1,3)],right=[p(1,3),p(2,2)],face={id:'gable',points:[...left,right[1],p(2,0),p(0,0)]},f=fixture({globals:renderGlobals(),state:{wallEdits:{$surfaces:[face]}},walls:[],selected:null});f.editor.togglePlane(face);f.editor.planeDown(f.e(.5,2.5));f.listeners.pointerup(f.e(.5,2.5));
 assert.equal(f.editor.selectionSnapshot().workingPlane.selectedLines.length,1);let objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);let selected=objects.filter(o=>o.userData.exteriorSelection&&o.userData.planeGuide);assert.equal(selected.length,1);assert.deepEqual(JSON.parse(JSON.stringify(selected[0].geometry.points)),left);assert.equal(selected[0].material.depthTest,false);
 const snapshot=f.editor.selectionSnapshot();snapshot.workingPlane.selectedLines=[];snapshot.workingPlane.selection=left;f.editor.restoreSelection(snapshot);objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);assert.equal(objects.filter(o=>o.userData.exteriorSelection&&o.userData.planeGuide).length,0,'selecting the endpoints alone does not highlight the line');
});

test('entering a spline face plane clears its face highlight and exposes only original controls',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),p=(x,z)=>({x,y:0,z}),c={...K.splineThrough([p(1,3),p(3,3)],[p(2,3.8)],p(0,1)),id:'arch'},face=K.archFaces([{id:'window',points:[p(1,1),p(3,1),p(3,3),p(1,3)],holes:[],feature:{type:'window'}}],c).faces[0],state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null,globals:renderGlobals()});
 f.editor.restoreSelection({selectedSolid:'window',faceSelection:[{solid:'window'}]});const before=JSON.stringify(state.wallEdits);f.editor.key({key:'p'});const selection=f.editor.selectionSnapshot();assert.equal(selection.selectedSolid,null);assert.equal(selection.faceSelection.length,0);assert.equal(selection.workingPlane.selection.length,0);assert.equal(JSON.stringify(state.wallEdits),before);
 const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const markers=objects.filter(o=>o.userData.planeGuide&&o.material.color==='#70ddeb'&&o.material.size===5);assert.equal(markers.length,1);assert.equal(markers[0].geometry.points.length,5,'two lower corners and three spline controls');
});

test('copying explicitly selected loose lines outside plane mode retains edges through paste',()=>{
 const p=(x,z)=>({x,y:0,z}),a=p(1,1),b=p(2,2),c=p(3,1),state={wallEdits:{$loose:{points:[a,b,c],edges:[[a,b],[b,c]]}}},f=fixture({state,globals:{isFreeMove:true},featureHost:()=>({points:[p(0,0),p(4,0),p(4,4),p(0,4)],solid:{id:'host'}})});f.editor.restoreSelection({lineSelection:[{pair:[a,b]},{pair:[b,c]}]});f.editor.clipboardCommand('copy');assert.equal(f.clipboard().edges.length,2,f.message());assert.equal(f.clipboard().points.length,3);f.listeners.pointermove(f.e(2,2));f.editor.clipboardCommand('paste');f.editor.down(f.e(2,2));assert.match(f.message(),/pasted/);assert.equal(state.wallEdits.$loose.edges.length,4);
});

test('generated arched wall retains its spline controls in plane mode',()=>{
 const f=fixture({globals:{...renderGlobals(),isFreeMove:true}}),pair=[{x:0,y:0,z:4},{x:4,y:0,z:4}];f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,4));f.editor.key({key:'a'});f.editor.down(f.e(2,5));f.editor.key({key:'Enter'});const [key,d]=Object.entries(f.state.wallEdits.$drafts)[0];f.editor.restoreSelection({selectedRegion:{draft:key,face:d.faces[0].id}});const before=JSON.stringify(f.state.wallEdits);f.editor.key({key:'p'});assert.equal(f.editor.pointSelection().length,0);const objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const markers=objects.filter(o=>o.userData.planeGuide&&o.material.color==='#70ddeb'&&o.material.size===5);assert.equal(markers[0].geometry.points.length,5);assert.equal(JSON.stringify(f.state.wallEdits),before);
});

test('moving a spline control in plane mode reshapes the original curve',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),p=(x,z)=>({x,y:0,z}),c={...K.splineThrough([p(1,3),p(3,3)],[p(2,3.8)],{x:0,y:1,z:0}),id:'arch'},face=K.archFaces([{id:'window',points:[p(1,1),p(3,1),p(3,3),p(1,3)],holes:[]}],c).faces[0],state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null,globals:{isFreeMove:true},screen:p=>({x:p.x*100,y:-p.z*100})});f.editor.togglePlane(face);planeSelection(f,[p(2,3.8)]);f.editor.key({key:'ArrowUp'});const next=state.wallEdits.$surfaces.find(f=>!f.deleted&&!f.drafted&&f.curves?.length);assert.ok(Math.abs(next.curves[0].controls[1].z-3.8254)<1e-7,f.message());assert.equal(next.curves[0].controls.length,3);assert.ok(next.points.some(p=>Math.abs(p.z-3.8254)<1e-7));
});

test('plane movement edits a generated spline control without replacing its draft',()=>{
 const f=fixture({globals:{isFreeMove:true},screen:p=>({x:p.x*100,y:-p.z*100})}),pair=[{x:0,y:0,z:4},{x:4,y:0,z:4}];f.editor.restoreSelection({lineSelection:[{pair}]});f.listeners.pointermove(f.e(2,4));f.editor.key({key:'a'});f.editor.down(f.e(2,5));f.editor.key({key:'Enter'});const [key,d]=Object.entries(f.state.wallEdits.$drafts)[0];f.editor.restoreSelection({selectedRegion:{draft:key,face:d.faces[0].id}});f.editor.key({key:'p'});planeSelection(f,[{x:2,y:0,z:5}]);f.editor.key({key:'ArrowRight'});const next=f.state.wallEdits.$drafts[key];assert.ok(Math.abs(next.sketch.curves[0].controls[1].x-2.0254)<1e-7,f.message());assert.equal(next.sketch.curves[0].controls.length,3);assert.ok(!f.state.wallEdits.$surfaces?.length);assert.ok(next.faces.some(f=>f.points.some(p=>Math.abs(p.x-2.0254)<1e-7&&Math.abs(p.y-5)<1e-7)));
});

test('plane spline picking selects original controls and copies an analytic curve',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),p=(x,z)=>({x,y:0,z}),c={...K.splineThrough([p(1,3),p(3,3)],[p(2,3.8)],{x:0,y:1,z:0}),id:'arch'},face=K.archFaces([{id:'panel',points:[p(1,1),p(3,1),p(3,3),p(1,3)],holes:[]}],c).faces[0],state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null,globals:{...renderGlobals(),isFreeMove:true}});f.editor.togglePlane(face);const hit=K.curvePoint(c,.25);f.editor.down(f.e(hit.x,hit.z));f.listeners.pointerup(f.e(hit.x,hit.z));assert.equal(f.editor.pointSelection().length,3);f.editor.clipboardCommand('copy');assert.equal(f.clipboard().curves.length,1);assert.equal(f.clipboard().edges.length,0);assert.equal(f.clipboard().points.length,3);f.editor.clipboardCommand('paste');const beforePreview=JSON.stringify(state.wallEdits),objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const previewLines=objects.filter(o=>o.material.color==='#8ce9ff'&&o.material.size===undefined&&o.geometry.points?.length===2);assert.ok(previewLines.length>5,'analytic spline is visible during paste preview');assert.ok(previewLines.every(o=>o.material.depthTest===false));assert.equal(JSON.stringify(state.wallEdits),beforePreview,'preview does not mutate model geometry');f.editor.down(f.e(2,2));assert.match(f.message(),/pasted/);const draft=Object.values(state.wallEdits.$drafts).find(d=>d.constructionPlane);assert.equal(draft.sketch.curves[0].controls.length,3);assert.equal(draft.sketch.nodes.filter(n=>n.userDraftPoint).length,3);
});

test('a selected spline copies and pastes outside plane mode without loose sample edges',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),p=(x,z)=>({x,y:0,z}),c={...K.splineThrough([p(1,3),p(3,3)],[p(2,3.8)],{x:0,y:1,z:0}),id:'arch'},face=K.archFaces([{id:'panel',points:[p(1,1),p(3,1),p(3,3),p(1,3)],holes:[]}],c).faces[0],state={wallEdits:{$surfaces:[face]}},f=fixture({state,walls:[],selected:null,globals:{...renderGlobals(),isFreeMove:true},featureHost:()=>({points:[p(0,0),p(6,0),p(6,6),p(0,6)],solid:{id:'host'}})}),samples=K.curveSamples(c),pairs=samples.slice(1).map((p,i)=>[samples[i],p]);f.editor.restoreSelection({lineSelection:[{pair:pairs[0],pairs}]});f.editor.clipboardCommand('copy');assert.equal(f.clipboard().curves.length,1);assert.equal(f.clipboard().edges.length,0);f.listeners.pointermove(f.e(2,2));f.editor.clipboardCommand('paste');f.editor.key({key:'t'});const beforePreview=JSON.stringify(state.wallEdits),objects=[];f.editor.draw3D({add:o=>objects.push(o)},p=>p);const previewLines=objects.filter(o=>o.material.color==='#8ce9ff'&&o.material.size===undefined&&o.geometry.points?.length===2);assert.ok(previewLines.length>5,'analytic spline is visible during paste preview');assert.ok(previewLines.every(o=>o.material.depthTest===false));assert.equal(JSON.stringify(state.wallEdits),beforePreview,'preview does not mutate model geometry');f.editor.down(f.e(2,2));assert.match(f.message(),/pasted/);const d=Object.values(state.wallEdits.$drafts).find(d=>d.constructionPlane);assert.equal(d.sketch.curves[0].controls.length,3);assert.equal(state.wallEdits.$loose.edges.length,0);
});

for(const plane of [false,true])for(const replacement of [false,true])test(`deleting a door edge preserves its wire and rebuilds a closed pasted curve (${plane?'plane':'wall'}, ${replacement?'closed':'open'})`,()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry'),p=(x,z)=>({x,y:0,z}),a=p(2,4),b=p(3,3),left={...K.splineThrough([p(1,3),a],[p(1.2,3.6)],{x:0,y:1,z:0}),id:'left'},right={...K.splineThrough([a,b],[p(2.8,3.6)],{x:0,y:1,z:0}),id:'right'},door=K.archFaces([{id:'door',feature:{type:'door'},points:[p(1,0),p(3,0),b,a,p(1,3)],holes:[]}],left).faces[0],wall={id:'wall',points:[p(0,0),p(4,0),p(4,5),p(0,5)],holes:[]},state={wallEdits:{$surfaces:[wall,door]}},f=fixture({state,walls:[],selected:null});
 if(replacement){const frame=K.frame(door),d={constructionPlane:true,frame,members:[],faces:[],sketch:{version:2,next:0,nodes:[],edges:[],outlines:[]}};S.addCurve(d,K.mapCurve(right,p=>K.local(frame,p)));state.wallEdits.$drafts={copied:d};}
 if(plane){f.editor.togglePlane(door);const snap=f.editor.selectionSnapshot();snap.workingPlane.selection=[a,b];snap.workingPlane.selectedLines=[[a,b]];f.editor.restoreSelection(snap);}else f.editor.restoreSelection({lineSelection:[{pair:[a,b]}]});
 const before=JSON.stringify(state.wallEdits);f.editor.key({key:'Delete'});assert.equal(f.history.length,1,f.message());assert.equal(JSON.stringify(f.history[0]),before);assert.ok(!state.wallEdits.$surfaces.find(f=>f.id==='wall').deleted,'supporting wall is not consumed');
 const loaded=JSON.parse(JSON.stringify(state.wallEdits)),wire=W.surfaceWire(loaded),byId=new Map(wire.nodes.map(n=>[n.id,n])),lines=wire.edges.map(e=>({points:[byId.get(e.a),byId.get(e.b)]}));
 assert.equal(W.sharedIntervals(a,b,lines).length,0,'only the selected diagonal disappears');for(const pair of [[p(1,0),p(3,0)],[p(1,0),p(1,3)],[p(3,0),b]])assert.ok(W.sharedIntervals(...pair,lines).length,'other door edges survive');
 const live=loaded.$surfaces.filter(f=>f.feature&&!f.deleted&&!f.drafted);if(replacement){assert.equal(live.length,1);assert.equal(live[0].feature.type,'door');assert.equal(live[0].curves.length,2);assert.ok(K.curveSamples(right).slice(1).every((p,i)=>W.sharedIntervals(K.curveSamples(right)[i],p,[live[0]]).length),'new face follows copied spline');}else{assert.equal(live.length,0);assert.ok(wire.edges.some(e=>e.curve),'surviving spline stays analytic');}
});
