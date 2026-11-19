// FM-566: wall mode shows the walls' own copy of the roof, so a roof edit made there is unseen. The roof's
// window key handler in scene_3d.js runs before wall mode's: in wall mode, Ctrl+A must not select the roof
// points and M (wall Move) must not start a vertical drag of them, or the saved roof sinks below the walls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8');
function block(start){const at=source.indexOf(start);assert.ok(at>=0,start);let i=source.indexOf('{',at),depth=1;for(i++;depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}return source.slice(at,i);}
const keyHandler=block("window.addEventListener('keydown', function(e) {").replace(/^window\.addEventListener\('keydown', /,'handleKey=');
const mouseMove=block('function onMouseMove3D(');
function editor(wallMode){
 const points=[{x:10,y:10,z:100,layer:1},{x:20,y:10,z:101,layer:1},{x:20,y:20,z:102,layer:1}],saves=[];
 const ctx={WallMode:{enabled:wallMode},document:{activeElement:{tagName:'BODY'},body:{style:{}},getElementById:()=>null},activeGeometry:{points,connections:[]},selectionMode:'POINT',layerVisibility:{1:true},
  selectedPoints:new Set(),selectedLines:new Set(),selectedFaceSignatures:new Set(),activeController3D:true,interactState3D:'IDLE',zMoveOriginals:new Map(),moveStartY_3D:0,zResizeState:{active:false,originals:new Map()},isSelecting3D:false,isFreeMove:false,layerData:{},
  save2DState:()=>saves.push(points.map(p=>p.z)),renderGeometry2D(){},renderGeometry3D(){},updateFaceSelectionVisualsOnly3D(){},renderFinalPass(){},updateSnapGuides(){},isPointFacetLocked:()=>false,triggerLiveUpdate(){},
  renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0})}},last3DMouseClientY:0};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(keyHandler+';\n'+mouseMove,ctx);
 const key=(k,mod=false)=>{const e={key:k,ctrlKey:mod,metaKey:false,shiftKey:false,altKey:false,repeat:false,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){},stopImmediatePropagation(){}};ctx.handleKey(e);return e;};
 const drag=dy=>{ctx.onMouseMove3D({clientX:50,clientY:200});ctx.onMouseMove3D({clientX:50,clientY:200+dy});};
 return {ctx,points,saves,key,drag};
}
test('in wall mode Ctrl+A and M leave the roof drawing alone',()=>{
 const e=editor(true),zs=e.points.map(p=>p.z);
 assert.equal(e.key('a',true).prevented,true,'Ctrl+A still does not select the page');
 assert.equal(e.ctx.selectedPoints.size,0,'Ctrl+A selected roof points');
 e.ctx.selectedPoints=new Set(e.points);
 e.key('m');assert.equal(e.ctx.interactState3D,'IDLE','M started a roof height drag');assert.equal(e.saves.length,0);
 e.ctx.interactState3D='MOVING';e.ctx.moveStartY_3D=-9999;e.drag(-16);
 assert.deepEqual(e.points.map(p=>p.z),zs,'a roof height drag ran in wall mode');
 e.ctx.interactState3D='RESIZING_Z';e.ctx.zResizeState={active:true,startMouseY:200,anchorZ:100,originals:new Map(e.points.map(p=>[p,p.z]))};e.drag(-40);
 assert.deepEqual(e.points.map(p=>p.z),zs,'a roof height resize ran in wall mode');
});
test('in roof mode Ctrl+A then M still moves every roof point up and down',()=>{
 const e=editor(false);
 e.key('a',true);assert.equal(e.ctx.selectedPoints.size,3);
 e.key('m');assert.equal(e.ctx.interactState3D,'MOVING');assert.equal(e.saves.length,1);
 e.drag(-16);
 assert.deepEqual(e.points.map(p=>+(p.z).toFixed(2)),[100.32,101.32,102.32]);
});
