const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('manual wall offsets retain base attachment after base elevation changes',()=>{
 const ctx={addEventListener(){}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 let floor=2;const state={wallEdits:{w:{0:{x:.1,z:10},2:{z:1}}}};
 const editor=ctx.createWallEditor({state:()=>state,floorHeight:()=>floor});
 const wall={id:'w',targetId:'ground:0',bottom:[{x:0,y:0,z:0},{x:4,y:0,z:0}],top:[{x:0,y:0,z:8},{x:4,y:0,z:8}]};
 let result=editor.apply([wall])[0];assert.equal(result.bottom[0].z,2);assert.equal(result.top[0].z,9);
 floor=3;result=editor.apply([wall])[0];assert.equal(result.bottom[0].z,3);assert.equal(wall.bottom[0].z,0);
});

test('projected wall edges pick ahead of the base with an eight-pixel tolerance and respect visibility',()=>{
 let visible=true,layer='base',redraws=0;
 const ctx={addEventListener(){},document:{getElementById:()=>({getScreenCTM:()=>({})})},DOMPoint:class {constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}}};ctx.window=ctx;
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const wall={id:'wall',bottom:[{x:0,y:0,z:0},{x:100,y:0,z:0}],top:[{x:0,y:0,z:8},{x:100,y:0,z:8}]};
 const editor=ctx.createWallEditor({enabled:()=>true,visible:()=>visible,layer:()=>layer,setLayer:value=>layer=value,walls:()=>[wall],toPixel:p=>p,redraw:()=>redraws++});
 const event=y=>({clientX:50,clientY:y,target:{closest:s=>s==='#viewport'}});
 assert.equal(editor.pick(event(7)),true);assert.equal(layer,'walls');assert.equal(redraws,1);
 assert.equal(editor.hit(event(9)),null);
 visible=false;assert.equal(editor.pick(event(0)),false);
});

test('selecting a wall center does not drag the wall; reset position preserves height offsets',()=>{
 const listeners={};let state={wallEdits:{wall:{0:{x:.1,y:.08,z:.2},2:{x:.1,y:.08,z:.3}}}},changes=0;
 const ctx={addEventListener:(key,fn)=>listeners[key]=fn,document:{getElementById:()=>({getScreenCTM:()=>({})})},DOMPoint:class {constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}}};ctx.window=ctx;
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const wall={id:'wall',bottom:[{x:0,y:0,z:0},{x:100,y:0,z:0}],top:[{x:0,y:0,z:8},{x:100,y:0,z:8}]};
 const editor=ctx.createWallEditor({state:()=>state,enabled:()=>true,visible:()=>true,layer:()=>'walls',walls:()=>[wall],toPixel:p=>p,position:e=>({x:e.clientX,y:e.clientY}),redraw(){},changed:()=>changes++});
 const event=(x,y)=>({button:0,clientX:x,clientY:y,target:{closest:s=>s==='#viewport'},stopImmediatePropagation(){},preventDefault(){}});
 const before=JSON.stringify(state);assert.equal(editor.down(event(50,0)),true);
 listeners.pointermove(event(60,8));listeners.pointerup(event(60,8));assert.equal(JSON.stringify(state),before);
 assert.equal(editor.resetPosition(),true);assert.equal(changes,1);
 assert.deepEqual(state.wallEdits.wall,{0:{z:.2},2:{z:.3}});
 editor.keyDown({...event(0,0),key:'z',ctrlKey:true});assert.equal(JSON.stringify(state),before);
});
test('wall redo restores committed geometry and a new edit clears the redo branch',()=>{
 let draftHost;const ctx={addEventListener(){},createWallFaceDraft:h=>{draftHost=h;return {key:()=>false,busy:()=>false,clear(){}};}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const state={wallEdits:{}},editor=ctx.createWallEditor({state:()=>state,enabled:()=>true,visible:()=>true,layer:()=>'walls',walls:()=>[],changed(){},redraw(){}});
 const key=(key,shiftKey=false)=>editor.keyDown({key,ctrlKey:true,shiftKey,stopImmediatePropagation(){},preventDefault(){}});
 const geometry={$surfaces:[{id:'extruded',feature:{type:'window',preset:0,axis:{x:1,y:0,z:0}},points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:1}]}]};state.wallEdits=structuredClone(geometry);draftHost.commit({});
 key('z');assert.equal(JSON.stringify(state.wallEdits),'{}');key('y');assert.equal(JSON.stringify(state.wallEdits),JSON.stringify(geometry));
 key('z');key('z',true);assert.equal(JSON.stringify(state.wallEdits),JSON.stringify(geometry));
 key('z');state.wallEdits={newEdit:true};draftHost.commit({});key('y');assert.equal(state.wallEdits.newEdit,true);
});
test('hidden walls cannot intercept base double-clicks through an old wall selection',()=>{
 let calls=0;const ctx={addEventListener(){},createWallFaceDraft:()=>({doubleClick(){calls++;return true;}})};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const editor=ctx.createWallEditor({enabled:()=>true,visible:()=>false,layer:()=>'base'});assert.equal(editor.doubleClick({}),false);assert.equal(calls,0);
});

test('cross-layer surface picking uses camera distance and ignores markers and hidden ancestors',()=>{
 const ctx={addEventListener(){},camera:{},renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}},THREE:{Vector2:class{},Raycaster:class{setFromCamera(){}intersectObjects(objects){return objects.map(object=>({object,distance:object.distance}));}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const mesh=(layer,distance)=>({isMesh:true,userData:{pickLayer:layer},distance,updateMatrixWorld(){}}),wall=mesh('walls',2),base=mesh('base',4),grade=mesh('grade',6),hidden=mesh('grade',.1),marker={...mesh('base',.01),isMesh:false};hidden.parent={visible:false};const group={traverse:fn=>[grade,base,hidden,marker,wall].forEach(fn)},e={clientX:50,clientY:50,target:{closest:()=>true}};
 assert.equal(ctx.wallNearestSurface(group,e).layer,'walls');base.distance=1;assert.equal(ctx.wallNearestSurface(group,e).layer,'base');grade.distance=.5;assert.equal(ctx.wallNearestSurface(group,e).layer,'grade');grade.visible=false;assert.equal(ctx.wallNearestSurface(group,e).layer,'base');
});


test('point depth gate uses camera-ray distance, permits surface contact and ignores transparency',()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new V(this.x,this.y,this.z);}project(){return new V(this.x,this.y,0);}sub(p){this.x-=p.x;this.y-=p.y;this.z-=p.z;return this;}dot(p){return this.x*p.x+this.y*p.y+this.z*p.z;}length(){return Math.hypot(this.x,this.y,this.z);}}
 const ctx={camera:{},renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}},THREE:{Vector2:V,Raycaster:class{constructor(){this.ray={origin:new V(0,0,0),direction:new V(0,0,1)};}setFromCamera(){}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);ctx.wallNearestSurface=()=>({distance:5});
 assert.equal(ctx.wallPointPickVisible({},new V(0,0,6)),false);assert.equal(ctx.wallPointPickVisible({},new V(0,0,4)),true);assert.equal(ctx.wallPointPickVisible({},new V(0,0,5.000001)),true);ctx.wallNearestSurface=()=>null;assert.equal(ctx.wallPointPickVisible({},new V(0,0,6)),true);
});

test('roof faces allow face and point selection through them while editable trim still occludes',()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new V(this.x,this.y,this.z);}project(){return new V(0,0,0);}sub(p){this.x-=p.x;this.y-=p.y;this.z-=p.z;return this;}dot(p){return this.x*p.x+this.y*p.y+this.z*p.z;}length(){return Math.hypot(this.x,this.y,this.z);}}
 const ctx={camera:{},renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}},THREE:{Vector2:V,Raycaster:class{constructor(){this.ray={origin:new V(),direction:new V(0,0,1)};}setFromCamera(){}intersectObjects(objects){return objects.map(object=>({object,distance:object.distance}));}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const mesh=(layer,distance)=>({isMesh:true,userData:{pickLayer:layer},distance,updateMatrixWorld(){}}),roof=mesh('roof',1),wall=mesh('walls',3),base=mesh('base',5),trim=mesh('roof',2);trim.userData.roofTrimId='fascia';trim.visible=false;
 const group={traverse:fn=>[roof,wall,base,trim].forEach(fn)},e={clientX:50,clientY:50,target:{closest:()=>true}};
 for(const transparent of [true,false]){roof.material={transparent};assert.equal(ctx.wallNearestSurface(group,e).object,wall);assert.equal(ctx.wallPointPickVisible(group,new V(0,0,3)),true);assert.equal(ctx.wallPointPickVisible(group,new V(0,0,5)),false);wall.visible=false;assert.equal(ctx.wallNearestSurface(group,e).object,base);assert.equal(ctx.wallPointPickVisible(group,new V(0,0,5)),true);wall.visible=true;}
 trim.visible=true;assert.equal(ctx.wallNearestSurface(group,e).object,trim);assert.equal(ctx.wallPointPickVisible(group,new V(0,0,3)),false);
});
