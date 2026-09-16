const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js');

// Exercise the actual UI handlers and persistence without imagery or a WebGL context.
function fixture(withBase=false,editors={}){
    const elements=new Map(),listeners={},storage=new Map(),timers=new Map();let timerId=0;
    const el=(id='')=>({id,hidden:false,disabled:false,value:'',textContent:'',dataset:{},style:{},
        classList:{toggle(){},add(){},remove(){}},setAttribute(){},addEventListener(){},
        prepend(...children){children.forEach(c=>this.appendChild(c));},append(...children){children.forEach(c=>this.appendChild(c));},querySelector(){return null;},appendChild(child){if(child.id)elements.set(child.id,child);},remove(){elements.delete(this.id);},
        querySelectorAll(selector){return selector==='[data-stage]'?stages:selector==='[data-soffit]'?soffits:[];}});
    const stages=[1,2,3,4,5,6,7].map(n=>({...el(),dataset:{stage:String(n)}}));
    const soffits=['auto','12','18','24'].map(n=>({...el(),dataset:{soffit:n}}));
    const document={readyState:'loading',head:el(),body:el(),createElement:()=>el(),
        addEventListener:(name,fn)=>listeners[name]=fn,querySelectorAll:()=>[],
        getElementById(id){if(id==='geoSvg'||id==='measurement-panel')return elements.get(id)||null;if(!elements.has(id))elements.set(id,el(id));return elements.get(id);}};
    const points=[{x:0,y:0,z:8},{x:10,y:0,z:8},{x:10,y:10,z:8},{x:0,y:10,z:8}];
    const ctx={setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){},document,location:{origin:'http://wall-test'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
        activeGeometry:{points,connections:[{start:points[0],end:points[1],type:'unknown'}],manualFaces:[{points}]},
        imageWidth:10,imageHeight:10,mapCenterLat:0,mapCenterLng:0,dsmMin:0,viewRotation:0,currentZoom:1,
        selectedPoints:new Set(),selectedLines:new Set(),tempPoint:null,layerData:{},isMeasurementMode:false,
        addEventListener:(name,fn)=>listeners['window:'+name]=fn,currentProjectId:'fixture',getMetersPerPx:()=>1,WallGeometry:G,WallChimneyCleanup:require('../public/measure/internal/editor_scripts/wall_chimney_cleanup.js'),WallRakeCleanup:require('../public/measure/internal/editor_scripts/wall_rake_cleanup.js'),WallChimneys:require('../public/measure/internal/editor_scripts/wall_chimneys.js'),WallGaps:require('../public/measure/internal/editor_scripts/wall_gaps.js'),GroundGeometry:require('../public/measure/internal/editor_scripts/ground_geometry.js')};
    if(withBase)ctx.BaseGeometry=require('../public/measure/internal/editor_scripts/base_geometry.js'); ctx.window=ctx;ctx.exitMeasurementMode=()=>{ctx.isMeasurementMode=false;elements.get('measurement-panel')?.remove();};
    ctx.EditorHistory=require('../public/measure/internal/editor_scripts/editor_history.js');
    Object.assign(ctx,editors);vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../public/measure/internal/editor_scripts/ground_editor.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(require.resolve('../public/measure/internal/editor_scripts/wall_mode.js'),'utf8'),ctx);
    listeners.DOMContentLoaded();ctx.WallMode.restore('fixture',{});
    return {ctx,elements,stages,soffits,el,listeners,flushTimers(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('roof/wall preference survives before walls exist and is isolated per project',()=>{
 const {ctx}=fixture();ctx.WallMode.setEnabled(true);
 assert.equal(ctx.WallMode.serialize(),null);
 const saved=ctx.WallMode.serializeView();assert.equal(saved.enabled,true);
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{});assert.equal(ctx.WallMode.enabled,true);
 ctx.WallMode.beforeProjectLoad();ctx.currentProjectId='other';ctx.WallMode.restore('other',{});assert.equal(ctx.WallMode.enabled,false);
 ctx.WallMode.restore('other',{exteriorsView:saved});assert.equal(ctx.WallMode.enabled,true);
 ctx.WallMode.setEnabled(false);ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('other',{exteriorsView:saved});assert.equal(ctx.WallMode.enabled,false,'newer local preference wins');
});
test('saved generated walls retain mode, including legacy metadata without a view preference',()=>{
 const {ctx,soffits}=fixture();ctx.WallMode.setEnabled(true);soffits[1].onclick();const walls=ctx.WallMode.serialize(),view=ctx.WallMode.serializeView();
 const fresh=fixture().ctx;fresh.WallMode.restore('fixture',{exteriorsWalls:walls,exteriorsView:view});assert.equal(fresh.WallMode.enabled,true);
 const legacy=fixture().ctx;legacy.WallMode.restore('fixture',{exteriorsWalls:walls});assert.equal(legacy.WallMode.enabled,true);
});
test('wall history exceeds both old limits, survives saved cursors, and reaches before first generation',()=>{
 const H=require('../public/measure/internal/editor_scripts/editor_history.js');
 const make=()=>{let host;const f=fixture(true,{createWallEditor:h=>{host=h;return {leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false,busy:()=>false};}});f.ctx.activeGeometry.connections[0].type='eave';return {...f,get host(){return host;},key:k=>f.listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}})};};
 const f=make();f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 for(let i=1;i<=550;i++){f.host.recordHistory(JSON.parse(JSON.stringify(f.host.state().wallEdits||{})));f.host.state().wallEdits={value:i};f.host.changed();}
 for(let i=0;i<20;i++)f.key('z');assert.equal(f.host.state().wallEdits.value,530);
 const state=f.ctx.WallMode.serialize(),history=H.unpack(H.pack(f.ctx.WallMode.serializeHistory())),fresh=make();fresh.ctx.WallMode.restore('fixture',{exteriorsWalls:state},history);
 fresh.key('y');assert.equal(fresh.host.state().wallEdits.value,531);
 for(let i=0;i<531;i++)fresh.key('z');assert.equal(fresh.host.state().wallEdits.value,undefined);
 fresh.key('z');assert.equal(fresh.ctx.WallMode.serialize(),null);fresh.key('y');assert.ok(fresh.ctx.WallMode.serialize().base);
 fresh.host.recordHistory({});fresh.host.state().wallEdits={value:'new branch'};fresh.host.changed();assert.equal(fresh.ctx.WallMode.serializeHistory().redo.length,0);
});
test('wall undo queues cannot change empty geometry branches in a decoded saved history',()=>{
 const H=require('../public/measure/internal/editor_scripts/editor_history.js');
 const f=fixture(true);f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 const state=f.ctx.WallMode.serialize(),history=H.unpack(H.pack(f.ctx.WallMode.serializeHistory())),before=JSON.stringify(history);
 const fresh=fixture(true);fresh.ctx.WallMode.restore('fixture',{exteriorsWalls:state},history);
 const key=k=>fresh.listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});
 key('z');assert.equal(fresh.ctx.WallMode.serialize(),null);key('y');assert.ok(fresh.ctx.WallMode.serialize().base);
 assert.equal(JSON.stringify(history),before);
});
test('wall entry closes line selection; corrected types rebuild; reset and reload discard old passes',()=>{
    const {ctx,elements,stages,soffits,el}=fixture();
    elements.set('measurement-panel',el('measurement-panel'));ctx.isMeasurementMode=true;
    ctx.WallMode.setEnabled(true);
    assert.equal(ctx.isMeasurementMode,false);assert.equal(elements.has('measurement-panel'),false);
    soffits[1].onclick();stages[2].onclick();
    assert.equal(ctx.WallMode.serialize().sources.length,0);
    ctx.WallMode.setEnabled(false);ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);
    let saved=ctx.WallMode.serialize();assert.equal(saved.sources.length,1);assert.equal(saved.stage,7);assert.ok(saved.extruded.length);
    stages[2].onclick();const old=ctx.WallMode.serialize();assert.equal(old.geometry.points.length,4);
    elements.get('wall-rebuild').onclick();saved=ctx.WallMode.serialize();
    assert.equal(saved.stage,7);assert.ok(saved.extruded.length);assert.ok(saved.deduplicated.length);
    assert.ok(saved.geometry.points.length>0);assert.equal(ctx.activeGeometry.points.length,4);
    ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...old,savedAt:1}});
    assert.equal(ctx.WallMode.serialize().stage,7);assert.ok(ctx.WallMode.serialize().extruded.length);
    // Even an in-place line change followed directly by a stage click refreshes sources.
    ctx.activeGeometry.connections[0].type='unknown';stages[1].onclick();
    assert.equal(ctx.WallMode.serialize().sources.length,0);assert.equal(ctx.WallMode.serialize().geometry.points.length,0);
});
test('flat grade switching survives roof reset/save/load and never mutates roof points',()=>{
    const {ctx,elements,stages,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();
    const roofBefore=JSON.stringify(ctx.activeGeometry);stages[1].onclick();
    elements.get('ground-flat-z').value='2';elements.get('ground-flat').onclick();
    const saved=ctx.WallMode.serialize();assert.equal(saved.ground.points[0].z,2);assert.equal(saved.ground.faces.length,2);
    assert.ok(saved.extruded.some(w=>w.bottom.some(p=>p.z>0)));
    elements.get('wall-rebuild').onclick();assert.equal(ctx.WallMode.serialize().ground.points[0].z,2);
    ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...saved,savedAt:Date.now()+1000}});
    assert.equal(ctx.WallMode.serialize().ground.points[0].z,2);assert.equal(JSON.stringify(ctx.activeGeometry),roofBefore);
    elements.get('ground-visible').onclick();assert.equal(ctx.WallMode.serialize().ground.visible,false);
});
test('old cached construction upgrades on load and gap stage survives save/load',()=>{
    const {ctx,stages,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();stages[3].onclick();
    const saved=ctx.WallMode.serialize();assert.equal(saved.stage,4);assert.ok(saved.gapRepaired.length);
    ctx.WallMode.beforeProjectLoad();const stale={...saved,engineVersion:'gap-paths-2-ground',sources:[...saved.sources,{id:'R40-return-b',kind:'return'}],gapRepaired:[],deduplicated:[],extruded:[],savedAt:Date.now()+10000};
    ctx.WallMode.restore('fixture',{exteriorsWalls:stale});
    const upgraded=ctx.WallMode.serialize();assert.equal(upgraded.engineVersion,'exterior-kernel-2');assert.equal(upgraded.stage,4);assert.ok(upgraded.gapRepaired.length);
    assert.deepEqual(upgraded.ground,saved.ground);
    assert.ok(!upgraded.sources.some(s=>s.kind==='return'));
});
test('wall mode hides comparison surfaces once and respects subsequent image toggles',()=>{
    const {ctx}=fixture();
    ctx.googleTileState={surfaceVisible:true};
    ctx.mesh={visible:true};ctx.googleTileGeospatialRoot={visible:false};
    ctx.toggle3DImage=value=>{ctx.googleTileState.surfaceVisible=value;ctx.mesh.visible=value;};
    ctx.WallMode.setEnabled(true);
    assert.equal(ctx.mesh.visible,false);
    ctx.toggle3DImage(true);
    ctx.WallMode.syncVisibility();ctx.WallMode.syncVisibility();
    assert.equal(ctx.mesh.visible,true);
    ctx.WallMode.setEnabled(false);
    assert.equal(ctx.mesh.visible,true);
    ctx.WallMode.setEnabled(true);
    assert.equal(ctx.mesh.visible,false);
    ctx.WallMode.setEnabled(false);
    ctx.toggle3DImage(false);
    ctx.WallMode.setEnabled(true);ctx.toggle3DImage(true);ctx.WallMode.setEnabled(false);
    assert.equal(ctx.mesh.visible,false,'roof mode retains its original surface setting');
});
test('3D comparison controls receive mouse and keyboard events while roof canvas editing stays blocked',()=>{
    const {ctx,listeners}=fixture();ctx.WallMode.setEnabled(true);
    for(const control of ['.enh-control-panel','.controls-3d-actions']){
        for(const type of ['pointerdown','mousedown','click','dblclick','keydown']){
            let blocked=false;
            const e={button:0,key:' ',target:{closest:selector=>selector.split(',').some(s=>[control,'#three-view-wrapper'].includes(s))},
                stopImmediatePropagation(){blocked=true;},preventDefault(){blocked=true;}};
            listeners['window:'+type](e);
            assert.equal(blocked,false,control+' '+type);
        }
    }
    let blocked=false;
    listeners['window:pointerdown']({button:0,target:{closest:selector=>selector.split(',').includes('#three-view-wrapper')},
        stopImmediatePropagation(){blocked=true;},preventDefault(){}});
    assert.equal(blocked,true);
});
test('base sections survive save/load, while explicit roof regeneration replaces the edited base',()=>{
 const {ctx,soffits,stages,elements}=fixture(true),B=ctx.BaseGeometry;
 ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();stages[1].onclick();
 const saved=ctx.WallMode.serialize(),originalGrade=JSON.stringify(saved.ground),f=saved.base.faces[0];
 saved.base.faces=[B.transform(f,'move',2)];saved.savedAt=Date.now()+20000;
 delete saved.extruded;delete saved.deduplicated;delete saved.gapRepaired;
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:JSON.parse(JSON.stringify(saved))});
 const next=ctx.WallMode.serialize();assert.equal(JSON.stringify(next.base),JSON.stringify(saved.base));
 assert.equal(JSON.stringify(next.ground),originalGrade);
 assert.ok(next.extruded.every(w=>w.bottom.every(p=>p.z>=2)));
 elements.get('wall-rebuild').onclick();assert.notEqual(JSON.stringify(ctx.WallMode.serialize().base),JSON.stringify(saved.base));assert.equal(JSON.stringify(ctx.WallMode.serialize().ground),originalGrade);assert.ok(ctx.WallMode.serialize().base.faces.every(f=>f.points.every(p=>p.z<2)));
});

 test('a failed 3D rebuild keeps the previous complete preview group attached',()=>{
 const {ctx}=fixture();class Group{constructor(){this.children=[];this.parent=null;}add(c){c.parent=this;this.children.push(c);}remove(c){this.children=this.children.filter(v=>v!==c);c.parent=null;}}const scene=new Group();ctx.scene=scene;ctx.getVector3=p=>p;ctx.THREE={Group,BufferGeometry:class{constructor(){throw Error('Injected triangulation failure');}}};let disposed=[];ctx.disposeObject3D=g=>disposed.push(g);ctx.WallMode.render3D();const previous=scene.children[0];previous.add({name:'existing wall geometry'});assert.throws(()=>ctx.WallMode.setEnabled(true),/Injected triangulation failure/);assert.equal(scene.children.length,1);assert.equal(scene.children[0],previous);assert.equal(previous.children[0].name,'existing wall geometry');assert.ok(!disposed.includes(previous));
 });

test('USGS applies a single reference quad directly and a late response does not override Flat',async()=>{
 for(const supersede of [false,true]){
  const {ctx,elements,soffits}=fixture(true);ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();const base=JSON.stringify(ctx.WallMode.serialize().base);
  ctx.URLSearchParams=URLSearchParams;ctx.AbortSignal=AbortSignal;let resume;const gate=new Promise(r=>resume=r);ctx.fetch=async url=>{await gate;const q=new URL(url).searchParams;return {ok:true,json:async()=>({value:100+Number(q.get('x'))*1000,resolution:10})};};
  elements.get('ground-usgs').onclick();if(supersede){elements.get('ground-flat-z').value='3';elements.get('ground-flat').onclick();}resume();await new Promise(r=>setImmediate(r));
  const saved=ctx.WallMode.serialize();assert.equal(saved.ground.points.length,4);assert.equal(saved.ground.source,supersede?'Flat':'USGS');assert.equal(JSON.stringify(saved.base),base);assert.ok(saved.groundCandidates.usgs);
  elements.get('ground-usgs').onclick();assert.equal(ctx.WallMode.serialize().ground.source,'USGS');
 }
});

test('loading the narrow-house legacy base repairs its footprint and extrusion cache',()=>{
 const {ctx}=fixture(true),c=require('./fixtures/narrow-roof-foundation.json');
 ctx.WallMode.restore('fixture',{exteriorsWalls:{schemaVersion:1,engineVersion:'base-faces-2-corner-tails',context:{lat:0,lng:0,width:10,height:10,mpp:1},roof:c.roof,options:c.options,ground:c.ground,base:c.legacyBase,sources:c.legacySources,stage:2,savedAt:1}});
 const result=ctx.WallMode.serialize();assert.equal(result.base.source,'Wall perimeter');assert.equal(result.extruded.length,17);assert.equal(result.extrusionWarnings.length,0);
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:result});
 assert.deepEqual(ctx.WallMode.serialize().base,result.base);
});

test('fifth generation stage merges, persists and resets independently of close gaps',()=>{
 const {ctx,stages,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();stages[4].onclick();
 const saved=ctx.WallMode.serialize();assert.equal(saved.stage,5);assert.ok(saved.mergedWalls);assert.ok(saved.mergeReport);
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...saved,savedAt:Date.now()+10000}});assert.equal(ctx.WallMode.serialize().stage,5);
 stages[3].onclick();assert.equal(ctx.WallMode.serialize().stage,4);
});

test('wall face center visibility toggles independently and survives reload',()=>{
 const {ctx,elements,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();elements.get('wall-centers-toggle').onclick();
 const saved=ctx.WallMode.serialize();assert.equal(saved.wallCenters,false);ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...saved,savedAt:Date.now()+10000}});assert.equal(ctx.WallMode.serialize().wallCenters,false);
});
test('live edge length visibility defaults on and persists independently',()=>{
 const {ctx,elements,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[1].onclick();assert.notEqual(ctx.WallMode.serialize().wallLengths,false);elements.get('wall-lengths-toggle').onchange({target:{value:'all'}});assert.equal(ctx.WallMode.serialize().lineLengthMode,'all');elements.get('wall-lengths-toggle').onchange({target:{value:'off'}});
 const saved=ctx.WallMode.serialize();assert.equal(saved.wallLengths,false);ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...saved,savedAt:Date.now()+10000}});assert.equal(ctx.WallMode.serialize().wallLengths,false);
});
test('base owns clicks and double-clicks when selected, including with hidden walls',()=>{
 const calls=[];let busy=false,hit=true;
 const base={cancelPointerGesture(){},setup(){},render(){},draw2D(){},draw3D(){},clearSelection(){},busy:()=>busy,canHit:()=>hit,down:()=>{calls.push('base-down');return true;},doubleClick:()=>{calls.push('base-double');return true;},keyDown:()=>{calls.push('base-key');return true;}};
 const wall={cancelPointerGesture(){},apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,pickSurface:()=>{calls.push('wall-pick');return true;},doubleClick:()=>{calls.push('wall-double');return true;},keyDown:()=>{calls.push('wall-key');return true;}};
 const f=fixture(true,{createBaseEditor:()=>base,createWallEditor:()=>wall});f.ctx.WallMode.setEnabled(true);
 const e={button:0,key:'n',target:{closest:s=>s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 f.listeners['window:pointerdown'](e);f.listeners['window:dblclick'](e);f.listeners['window:keydown'](e);assert.deepEqual(calls,['base-down','base-double','base-key']);
 calls.length=0;f.elements.get('wall-visible').onclick();busy=true;hit=false;f.listeners['window:pointerdown'](e);assert.deepEqual(calls,['base-down']);
});

test('chimney volumes are introduced after extrusion and retain provenance in project saves',()=>{
 const f=fixture(true),ps=f.ctx.activeGeometry.points,added=[{x:8,y:4,z:8},{x:12,y:4,z:8},{x:12,y:6,z:8},{x:8,y:6,z:8}];f.ctx.activeGeometry.points=[...ps,...added];
 f.ctx.activeGeometry.connections.push(...added.map((start,i)=>({start,end:added[(i+1)%4],type:'chimney_edge'})));
 f.soffits[1].onclick();f.stages[4].onclick();let saved=f.ctx.WallMode.serialize();assert.equal(saved.chimneys.items.length,1);assert.equal(saved.wallEdits.$surfaces.filter(f=>f.chimney?.volume).length,5);
 const before=JSON.stringify(saved.chimneys);f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});saved=f.ctx.WallMode.serialize();assert.equal(JSON.stringify(saved.chimneys),before);assert.equal(saved.wallEdits.$surfaces.filter(f=>f.chimney?.volume).length,5);
});

test('Auto-step button dispatches repeated increments without persisting a transient preview',()=>{
 let calls=0;const wall={cancelPointerGesture(){},apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,stepCommand(){throw Error('Base stepping must not switch to walls');}},base={setup(){},render(){},draw2D(){},draw3D(){},clearSelection(){},busy:()=>false,stepCommand(){calls++;}};
 const f=fixture(true,{createBaseEditor:()=>base,createWallEditor:()=>wall});f.ctx.WallMode.setEnabled(true);
 f.elements.get('wall-step').onclick();const saved=JSON.stringify(f.ctx.WallMode.serialize());f.elements.get('wall-step').onclick();
 assert.equal(calls,2);assert.equal(JSON.stringify(f.ctx.WallMode.serialize()),saved);
});

test('nearest rendered surface overrides the previously active layer while placement tools keep their clicks',()=>{
 const calls=[];let layer='walls',busy=false;
 const base={cancelPointerGesture(){},setup(){},render(){},draw2D(){},draw3D(){},clearSelection(){},busy:()=>busy,canHit:()=>true,down:()=>{calls.push('base');return true;}};
 const wall={cancelPointerGesture(){},apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,down:()=>{calls.push('walls');return true;}};
 const f=fixture(true,{createBaseEditor:()=>base,createWallEditor:()=>wall,wallNearestSurface:()=>({layer,object:{userData:{}}})});f.ctx.WallMode.setEnabled(true);
 const e={button:0,target:{closest:s=>s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 for(const next of ['walls','base','walls','grade','base']){layer=next;f.listeners['window:pointerdown'](e);}
 assert.deepEqual(calls,['walls','base','walls','base']);busy=true;layer='walls';f.listeners['window:pointerdown'](e);assert.equal(calls.at(-1),'base');
});

test('global undo and redo restore exact generated wall ownership without regeneration',()=>{
 let host;const wall={cancelPointerGesture(){},apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,hasDraft:()=>false};const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);
 f.soffits[1].onclick();const state=host.state(),before=JSON.parse(JSON.stringify(state.wallEdits||{})),generated=JSON.stringify(state.mergedWalls);state.wallEdits={$drafts:{test:{members:[state.mergedWalls[0].id],faces:[],sketch:{nodes:[],edges:[]}}}};host.recordHistory(before);host.changed();const after=JSON.stringify(state.wallEdits);
 const originalMerge=f.ctx.WallGeometry.mergeCoplanar;f.ctx.WallGeometry.mergeCoplanar=()=>{throw Error('Undo must not regenerate ownership');};
 try{const key=k=>f.listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});key('z');assert.equal(JSON.stringify(state.wallEdits),JSON.stringify(before));assert.equal(JSON.stringify(state.mergedWalls),generated);key('y');assert.equal(JSON.stringify(state.wallEdits),after);assert.equal(JSON.stringify(state.mergedWalls),generated);}finally{f.ctx.WallGeometry.mergeCoplanar=originalMerge;}
});
test('rake cleanup is a sixth stage with reversible wall and foundation comparisons and save/reload',()=>{
 const {ctx,stages,soffits,elements,listeners}=fixture(true),input=require('./fixtures/complex-roof-corner.json');
 const key=key=>listeners['window:keydown']({key,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});
 const pixel=p=>({...p,x:p.x+5,y:p.y+5}),points=input.roof.points.map(pixel);
 ctx.activeGeometry={points,connections:input.roof.connections.map(c=>({...c,start:points[c.startIdx],end:points[c.endIdx]})),manualFaces:input.roof.faces.map(f=>({...f,points:f.points.map(pixel),holes:(f.holes||[]).map(r=>r.map(pixel))}))};
 ctx.dsmMin=input.options.ground;ctx.WallMode.setEnabled(true);soffits[0].onclick();
 const aligned=ctx.WallMode.serialize();assert.equal(aligned.stage,7);assert.equal(aligned.chimneyCleanupReport.alignments.length,1);assert.equal(aligned.geometry.faces.length,9);
 const alignedBase=JSON.stringify(aligned.base);
 stages[4].onclick();stages[6].onclick();assert.equal(JSON.stringify(ctx.WallMode.serialize().base),alignedBase);
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...aligned,savedAt:Date.now()+1000}});
 assert.equal(ctx.WallMode.serialize().stage,7);assert.equal(JSON.stringify(ctx.WallMode.serialize().base),alignedBase);
 stages[5].onclick();const cleaned=ctx.WallMode.serialize();assert.equal(cleaned.stage,6);assert.equal(cleaned.rakeCleanupReport.paths.length,1);assert.equal(cleaned.geometry.faces.length,10);
 assert.ok(cleaned.baseCleanupApplied);const base=JSON.stringify(cleaned.base),roof=JSON.stringify(cleaned.roof);
 stages[4].onclick();const detailed=ctx.WallMode.serialize();assert.equal(detailed.stage,5);assert.equal(detailed.geometry.faces.length,13);assert.notEqual(JSON.stringify(detailed.base),base);
 stages[5].onclick();assert.equal(JSON.stringify(ctx.WallMode.serialize().base),base);assert.equal(ctx.WallMode.serialize().geometry.faces.length,10);
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:{...cleaned,savedAt:Date.now()+10000}});
 assert.equal(ctx.WallMode.serialize().stage,6);assert.equal(JSON.stringify(ctx.WallMode.serialize().base),base);
 assert.equal(JSON.stringify(ctx.WallMode.serialize().roof),roof);
 stages[4].onclick();elements.get('wall-rebuild').onclick();assert.equal(ctx.WallMode.serialize().stage,7);
 key('z');assert.equal(ctx.WallMode.serialize().stage,5);assert.equal(JSON.stringify(ctx.WallMode.serialize().base),JSON.stringify(detailed.base));
 key('y');assert.equal(ctx.WallMode.serialize().stage,7);assert.equal(ctx.WallMode.serialize().geometry.faces.length,9);
});
test('translucency defaults on and toolbar preference round trips',()=>{const f=fixture(true);f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();assert.notEqual(f.ctx.WallMode.serialize().translucent,false);f.elements.get('wall-translucency-toggle').onclick();const saved=f.ctx.WallMode.serialize();assert.equal(saved.translucent,false);f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});assert.equal(f.ctx.WallMode.serialize().translucent,false);f.elements.get('wall-translucency-toggle').onclick();assert.equal(f.ctx.WallMode.serialize().displayMode,'textured');assert.equal(f.ctx.WallMode.serialize().translucent,false);f.ctx.WallMode.restore('fixture',{exteriorsWalls:f.ctx.WallMode.serialize()});assert.equal(f.ctx.WallMode.serialize().displayMode,'textured');f.elements.get('wall-translucency-toggle').onclick();assert.equal(f.ctx.WallMode.serialize().translucent,true);});

test('visible line hits take priority over face rays without consuming placement tools',()=>{
 const calls=[];let busy=false,wallHost;const base={cancelPointerGesture(){},setup(){},render(){},draw2D(){},draw3D(){},clearSelection(){},busy:()=>false},wall={cancelPointerGesture(){},apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>busy,pickLine:()=>{calls.push('line');return true;},down:()=>{calls.push('place');return true;}};
 const f=fixture(true,{createBaseEditor:()=>base,createWallEditor:h=>{wallHost=h;return wall;},wallNearestSurface:()=>{calls.push('face');return null;}});f.ctx.WallMode.setEnabled(true);wallHost.setLayer('walls');const e={button:0,target:{closest:s=>s==='#three-view-wrapper'||s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 f.listeners['window:pointerdown'](e);assert.deepEqual(calls,['line']);busy=true;f.listeners['window:pointerdown'](e);assert.deepEqual(calls,['line','place']);
});

test('From Roof clears editor interactions before replacing state and regenerates its base',()=>{
 const calls=[];let host;
 const wall={leave(){calls.push(host.state());if(host.state())host.state().wallEdits={$surfaces:[{id:'cancelled-preview'}]};},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false};
 const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.activeGeometry.connections[0].type='eave';f.soffits[1].onclick();
 const old=host.state();old.wallEdits={$surfaces:[{id:'old-chamfer'}]};old.base.sketch={nodes:[{id:'stale',x:99,y:99,z:99}],edges:[]};
 f.elements.get('wall-rebuild').onclick();assert.equal(calls.at(-1),old);assert.notEqual(host.state(),old);assert.equal(host.state().wallEdits,undefined);assert.ok(!JSON.stringify(host.state().base).includes('stale'));
});

test('advanced roof bound setting defaults on and persists independently of roof visibility and rebuild',()=>{
 const f=fixture(true);f.ctx.activeGeometry.connections[0].type='eave';f.soffits[1].onclick();
 const toggle=f.elements.get('wall-roof-bounds');assert.equal(toggle.checked,true);
 f.elements.get('wall-roof-visibility').onclick();assert.equal(toggle.checked,true);
 toggle.onchange({target:{checked:false}});let saved=f.ctx.WallMode.serialize();assert.equal(saved.boundExtrusionToRoof,false);
 f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});assert.equal(toggle.checked,false);
 f.elements.get('wall-rebuild').onclick();assert.equal(f.ctx.WallMode.serialize().boundExtrusionToRoof,false);
 toggle.onchange({target:{checked:true}});assert.equal(f.ctx.WallMode.serialize().boundExtrusionToRoof,true);
});

test('consecutive identical nudges share undo, while direction and modifier changes split it',()=>{
 let host;const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},hasDraft:()=>false,busy:()=>false,keyDown(e){if(!e.key.startsWith('Arrow'))return false;const state=host.state(),before=JSON.parse(JSON.stringify(state.wallEdits||{}));host.recordHistory(before);state.wallEdits={value:(state.wallEdits?.value||0)+(e.shiftKey?6:1)};host.changed();return true;}};
 const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 const key=(key,extra={})=>f.listeners['window:keydown']({key,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){},...extra});
 for(let i=0;i<50;i++)key('ArrowLeft');assert.equal(host.state().wallEdits.value,50);key('ArrowUp');assert.equal(host.state().wallEdits.value,51);
 key('z',{ctrlKey:true});assert.equal(host.state().wallEdits.value,50);key('z',{ctrlKey:true});assert.equal(host.state().wallEdits.value,undefined);key('y',{ctrlKey:true});assert.equal(host.state().wallEdits.value,50);
 key('ArrowLeft',{shiftKey:true});key('ArrowLeft');key('z',{ctrlKey:true});assert.equal(host.state().wallEdits.value,56);key('z',{ctrlKey:true});assert.equal(host.state().wallEdits.value,50);
});


test('base visibility queries do not switch layers or cancel wall drawing',()=>{
 let host;const f=fixture(true,{createBaseEditor:h=>{host=h;return {setup(){},render(){},draw2D(){},draw3D(){},clearSelection(){}};},getVector3:p=>p,wallPointPickVisible:()=>false});
 const before=host.layer();
 assert.equal(host.pickVisible({x:1,y:1,z:0}),false);assert.equal(host.layer(),before);
 assert.equal(typeof host.selectVisibleLayer,'function');
});


test('roof trim settings survive regeneration, save/load and global undo without changing the roof',()=>{
 let host;const R=require('../public/measure/internal/editor_scripts/roof_trim.js');const f=fixture(true,{RoofTrim:R,createRoofTrimEditor:h=>{host=h;return {reset(){},update(){},clear(){},finish(){},busy:()=>false,hasSelection:()=>false,key:()=>false};}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();const before=f.ctx.WallMode.serialize(),edge=R.panels(before.roof)[0];host.set(R.setHeight({},[edge.id],12));host.commit({});assert.equal(f.ctx.WallMode.serialize().roofTrim.edges[edge.id].height,12*.0254);f.elements.get('wall-rebuild').onclick();assert.equal(f.ctx.WallMode.serialize().roofTrim.edges[edge.id].height,12*.0254);assert.equal(JSON.stringify(f.ctx.WallMode.serialize().roof),JSON.stringify(before.roof));
 const prior=f.ctx.WallMode.serializeRoofTrim();host.set(R.setHeight(prior,[edge.id],0));host.commit(prior);const key=(k,shift=false)=>f.listeners['window:keydown']({key:k,ctrlKey:true,shiftKey:shift,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});key('z');assert.equal(f.ctx.WallMode.serialize().roofTrim.edges[edge.id].height,12*.0254);key('z',true);assert.equal(f.ctx.WallMode.serialize().roofTrim.edges[edge.id].height,0);const saved=f.ctx.WallMode.serialize();f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});assert.equal(f.ctx.WallMode.serializeRoofTrim().edges[edge.id].height,0);f.elements.get('wall-roof-visibility').onclick();assert.equal(host.visible(),false);
});
test('From Roof is one full undo item and preserves earlier edits and redo',()=>{
 let host;const wall={leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false,busy:()=>false};
 const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 const clone=x=>JSON.parse(JSON.stringify(x)),stable=()=>{const s=clone(host.state());delete s.savedAt;return s;};
 const initialEdits=clone(host.state().wallEdits||{});host.recordHistory(initialEdits);host.state().wallEdits={$surfaces:[],note:'hand edited drawing and trim'};host.changed();
 host.state().base.sketch={nodes:[{id:'drawing',x:2,y:3,z:0}],edges:[]};host.state().customSavedGeometry={marker:'preserve entire state'};
 const before=stable();f.elements.get('wall-rebuild').onclick();const after=stable();assert.notDeepEqual(after,before);assert.equal(after.options.soffit,'auto');assert.equal(after.wallEdits,undefined);
 const key=(key,shiftKey=false)=>f.listeners['window:keydown']({key,ctrlKey:true,shiftKey,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});
 const merge=G.mergeCoplanar;G.mergeCoplanar=()=>{throw Error('Undo/redo must restore snapshots without rebuilding');};
 try{key('z');assert.deepEqual(stable(),before);key('z');assert.deepEqual(clone(host.state().wallEdits),initialEdits);key('y');assert.equal(host.state().wallEdits.note,'hand edited drawing and trim');key('z',true);assert.deepEqual(stable(),after);key('z');assert.deepEqual(stable(),before);}finally{G.mergeCoplanar=merge;}
});

test('failed From Roof restores the previous building and leaves undo history intact',()=>{
 let host;const f=fixture(true,{createWallEditor:h=>{host=h;return {leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false,busy:()=>false};}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 host.recordHistory({});host.state().wallEdits={note:'keep this'};host.changed();const before=JSON.parse(JSON.stringify(host.state()));delete before.savedAt;
 const extrude=G.extrude;G.extrude=()=>{throw Error('test generation failure');};try{f.elements.get('wall-rebuild').onclick();}finally{G.extrude=extrude;}
 const after=JSON.parse(JSON.stringify(host.state()));delete after.savedAt;assert.deepEqual(after,before);assert.match(f.elements.get('wall-status').textContent,/test generation failure/);
 f.listeners['window:keydown']({key:'z',ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});assert.equal(host.state().wallEdits.note,undefined);
});

test('roof mode disables exterior trim rendering, picking, shortcuts and Auto trim',()=>{
 let trimHost,picks=0,keys=0,auto=0,refreshes=0;
 const f=fixture(true,{createRoofTrimEditor:h=>{trimHost=h;return {reset(){},finish(){},update(){},pick(){picks++;return true;},key(){keys++;return true;},refresh(){refreshes++;return [];},busy:()=>false,hasSelection:()=>false};},createWallEditor:()=>({leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false,autoTrim(){auto++;}})});
 const event={key:'Delete',button:0,target:{closest:()=>false},preventDefault(){throw Error('Roof input must not be consumed');},stopImmediatePropagation(){throw Error('Roof input must not be intercepted');}};
 const check=()=>{assert.equal(trimHost.visible(),false);f.listeners['window:keydown'](event);for(const type of ['pointerdown','click','dblclick'])f.listeners['window:'+type]?.(event);f.elements.get('wall-auto-trim').onclick();f.ctx.WallMode.renderRoofTrim3D();assert.equal(picks,0);assert.equal(keys,0);assert.equal(auto,0);assert.equal(refreshes,0);};
 check();f.ctx.WallMode.setEnabled(true);assert.equal(trimHost.visible(),true);f.ctx.WallMode.setEnabled(false);check();
});

test('default finish settings persist, undo, redo and survive From Roof',()=>{
 let materials;const f=fixture(true,{ExteriorMaterials:{siding:{},unassigned:{}},WallFeatures:{mountUI:(a,b,c,m)=>materials=m,closeUI(){}}});f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 const expected={material:'siding',color:'#123456',trimColor:'#abcdef'};materials.defaults(expected);assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.WallMode.serialize().finishDefaults)),expected);
 const key=k=>f.listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});key('z');assert.equal(materials.defaults().color,'#80868b');key('y');assert.equal(materials.defaults().color,expected.color);
 f.elements.get('wall-rebuild').onclick();assert.equal(materials.defaults().trimColor,expected.trimColor);const saved=f.ctx.WallMode.serialize();f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});assert.equal(materials.defaults().material,'siding');assert.equal(f.ctx.WallMode.finishDefaults.color,expected.color);
});

test('marquee releases cannot invoke the face double-click handler',()=>{
 let afterBox=true,draws=0;
 const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},consumeSelectionClick:()=>afterBox,doubleClick(){draws++;return true;}};
 let host;const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.WallMode.setEnabled(true);host.setLayer('walls');
 const e={button:0,target:{closest:s=>s==='#three-view-wrapper'||s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 f.listeners['window:click'](e);f.listeners['window:dblclick'](e);assert.equal(draws,0);
 afterBox=false;f.listeners['window:dblclick'](e);assert.equal(draws,1);
});

test('rectangle starts before roof-trim or face picking and a click still picks a point first',()=>{
 let callback,pointHits=0,trimHits=0;
 const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,cancelPointerGesture(){},startBox(e,click){callback=click;return true;},finishPointer(){},pickPoint(){pointHits++;return true;}};
 const trim={update(){},reset(){},refresh(){},pick(){trimHits++;return false;},finish(){},hasSelection:()=>false};
 const f=fixture(true,{createWallEditor:()=>wall,createRoofTrimEditor:()=>trim});f.ctx.WallMode.setEnabled(true);
 const e={button:0,target:{closest:s=>s==='#three-view-wrapper'||s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 f.listeners['window:pointerdown'](e);assert.equal(pointHits,0);assert.equal(trimHits,0);
 callback();assert.equal(pointHits,1);assert.equal(trimHits,1);
});

test('loading with the 2D canvas present draws SVG roof faces without requiring a 3D vector',()=>{
 const f=fixture(),paths=[];
 const element=()=>({setAttribute(k,v){this[k]=v;},appendChild(){},replaceChildren(){}});
 f.ctx.document.createElementNS=(ns,type)=>{const e=element();if(type==='path')paths.push(e);return e;};
 f.elements.set('geoSvg',element());f.elements.set('geo-rotation-group',element());
 assert.doesNotThrow(()=>f.ctx.WallMode.setEnabled(true));
 assert.ok(paths.length);assert.equal(paths[0]['fill-rule'],'evenodd');assert.match(paths[0].d,/^M.* Z$/);
});


test('initial renderer keeps a merged wall and chimney in one mesh and removes the shared seam',()=>{
 const {ctx,soffits}=fixture();ctx.activeGeometry.connections[0].type='eave';ctx.WallMode.setEnabled(true);soffits[0].onclick();
 const state=ctx.WallMode.serialize(),p=(x,z)=>({x,y:0,z});
 state.alignedWalls=[{id:'left',sourceId:'left',mergeGroup:'common',bottom:[p(0,0),p(2,0)],top:[p(0,3),p(2,3)]},{id:'right',sourceId:'c',mergeGroup:'common',chimney:{id:'c',side:0},bottom:[p(2,0),p(4,0)],top:[p(2,3),p(4,3)]}];
 state.roofVisible=false;state.gapHighlights=false;state.wallCenters=false;state.savedAt=Date.now()+10000;
 ctx.WallMode.beforeProjectLoad();ctx.WallMode.restore('fixture',{exteriorsWalls:state});
 class Group{constructor(){this.children=[];this.userData={};}add(o){this.children.push(o);o.parent=this;}remove(o){this.children=this.children.filter(c=>c!==o);}}
 class Geometry{setFromPoints(points){this.points=points;return this;}setAttribute(k,v){this[k]=v;return this;}setIndex(){return this;}computeVertexNormals(){}}
 class Material{constructor(args){Object.assign(this,args);}}
 class Object3D{constructor(geometry,material){this.geometry=geometry;this.material=material;this.userData={};}}
 ctx.THREE={Group,BufferGeometry:Geometry,Float32BufferAttribute:class{constructor(array){this.array=array;}},Mesh:Object3D,Line:Object3D,LineSegments:Object3D,Points:Object3D,MeshBasicMaterial:Material,LineBasicMaterial:Material,PointsMaterial:Material};
 ctx.ExteriorModel=require('../public/measure/internal/editor_scripts/exterior_model.js');ctx.scene=new Group();ctx.getVector3=p=>p;ctx.disposeObject3D=()=>{};ctx.WallMode.render3D();
 const objects=ctx.scene.children[0].children,meshes=objects.filter(o=>o.userData.pickLayer==='walls');
 assert.equal(meshes.length,1,'material source category cannot split the common plane');
 const wire=objects.filter(o=>o.geometry.position&&o.material.opacity===.95);assert.equal(wire.length,1);
 // No internal upright appears in the rendered line pairs (world conversion is irrelevant).
 const a=wire[0].geometry.position.array;let verticals=0;for(let i=0;i<a.length;i+=6)if(a[i]===a[i+3]&&a[i+1]===a[i+4])verticals++;
 assert.equal(verticals,2,'only the outer uprights are rendered');
});


test('P routes face-plane mode and drawing clicks ahead of marquee and model picking',()=>{
 let plane=false,draws=0,boxes=0,picks=0;
 const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false,cancelPointerGesture(){},planeActive:()=>plane,togglePlane(){plane=!plane;return true;},planeDown(){draws++;return true;},startBox(){boxes++;return true;},pickPoint(){picks++;return true;}};
 const f=fixture(true,{createWallEditor:()=>wall});f.ctx.WallMode.setEnabled(true);
 const e={key:'p',button:0,target:{closest:s=>s==='#three-view-wrapper'||s==='#viewport,#three-view-wrapper'},preventDefault(){},stopImmediatePropagation(){}};
 f.listeners['window:keydown'](e);assert.equal(plane,true);
 f.listeners['window:pointerdown'](e);assert.equal(draws,1);assert.equal(boxes,0);assert.equal(picks,0);
 f.listeners['window:keydown']({...e,repeat:true});assert.equal(plane,true);
 f.listeners['window:keydown']({...e,target:{closest:s=>s==='input,textarea,select,[contenteditable=true]'}});assert.equal(plane,true);
 f.listeners['window:keydown'](e);assert.equal(plane,false);
});


test('selection-only history restores mixed selections, skips without discarding, and geometry always restores selection',()=>{
 let host,selection={points:[],lines:[],faces:[]};const clone=v=>JSON.parse(JSON.stringify(v));
 const wall={apply:w=>w,draw2D(){},draw3D(){},busy:()=>false,clear(){selection={points:[],lines:[],faces:[]};},selectionSnapshot:()=>clone(selection),restoreSelection:s=>{selection=clone(s);}};
 const f=fixture(true,{createWallEditor:h=>{host=h;return wall;}});f.ctx.activeGeometry.connections[0].type='eave';f.soffits[1].onclick();f.ctx.WallMode.setEnabled(true);
 const input=fn=>{f.listeners['window:change']();fn();f.flushTimers();};
 const key=k=>{f.listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});f.flushTimers();};
 const a={points:['a','b'],lines:['ab'],faces:['front']},b={points:['a','b','oops'],lines:['ab'],faces:['front']};
 input(()=>{selection=clone(a);});input(()=>{selection=clone(b);});key('z');assert.deepEqual(selection,a);key('y');assert.deepEqual(selection,b);key('z');
 const before=clone(host.state().wallEdits||{});
 input(()=>{host.recordHistory(before);host.state().wallEdits={moved:true};host.changed();selection={points:['moved-a','moved-b'],lines:['moved-ab'],faces:['moved-front']};});
 const moved=clone(selection);key('z');assert.deepEqual(selection,a);assert.equal(JSON.stringify(host.state().wallEdits),JSON.stringify(before));key('y');assert.deepEqual(selection,moved);assert.equal(host.state().wallEdits.moved,true);
 const savedState=f.ctx.WallMode.serialize(),codec=require('../public/measure/internal/editor_scripts/editor_history.js');
 const savedHistory=codec.unpack(codec.pack(f.ctx.WallMode.serializeHistory()));
 f.ctx.WallMode.beforeProjectLoad();selection={points:[],lines:[],faces:[]};
 f.ctx.WallMode.restore('fixture',{exteriorsWalls:savedState},savedHistory);
 assert.deepEqual(selection,moved,'saved selection restores on reload');
 input(()=>{selection=clone(b);});f.elements.get('wall-undo-selections').onchange({target:{checked:false}});key('z');assert.deepEqual(selection,a);assert.equal(JSON.stringify(host.state().wallEdits),JSON.stringify(before));key('y');assert.deepEqual(selection,moved);
 f.elements.get('wall-undo-selections').onchange({target:{checked:true}});key('y');assert.deepEqual(selection,b,'skipped selection still exists on redo');
 key('z');input(()=>{selection={points:['new'],lines:[],faces:[]};});key('y');assert.deepEqual(selection,{points:['new'],lines:[],faces:[]},'new selection branches history');
});

test('selection undo preference defaults on and survives rebuild and project restore',()=>{
 const f=fixture(true);f.ctx.activeGeometry.connections[0].type='eave';f.soffits[1].onclick();assert.notEqual(f.ctx.WallMode.serialize().undoSelections,false);
 f.elements.get('wall-undo-selections').onchange({target:{checked:false}});f.elements.get('wall-rebuild').onclick();assert.equal(f.ctx.WallMode.serialize().undoSelections,false);
 const saved=f.ctx.WallMode.serialize();f.ctx.WallMode.beforeProjectLoad();f.ctx.WallMode.restore('fixture',{exteriorsWalls:saved});assert.equal(f.ctx.WallMode.serialize().undoSelections,false);
});



test('wall orbit exposes undersides, survives replacement controls, and restores the roof limit',()=>{
 let updates=0;const original={maxPolarAngle:Math.PI/2,update(){updates++;}},f=fixture(false,{controls:original});
 f.ctx.WallMode.setEnabled(true);assert.equal(original.maxPolarAngle,170*Math.PI/180);f.ctx.WallMode.syncVisibility();f.ctx.WallMode.setEnabled(false);assert.equal(original.maxPolarAngle,Math.PI/2);assert.equal(updates,1);
 f.ctx.WallMode.setEnabled(true);const replacement={maxPolarAngle:Math.PI/2,update(){updates++;}};f.ctx.controls=replacement;f.ctx.WallMode.syncVisibility();assert.equal(replacement.maxPolarAngle,170*Math.PI/180);f.ctx.WallMode.beforeProjectLoad();assert.equal(replacement.maxPolarAngle,Math.PI/2);assert.equal(updates,2);
});

test('persistent selection readout reports points lines and grouped faces independently of status messages',()=>{
 let host,snapshot={},points=[];const updates=[];
 const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},interaction:()=>null,selectionSnapshot:()=>({draft:snapshot}),pointSelection:()=>points};
 const f=fixture(true,{createWallEditor:h=>{host=h;return wall;},setInterval:(fn,ms)=>{if(ms===150)updates.push(fn);return 0;}});f.ctx.WallMode.setEnabled(true);host.setLayer('walls');
 f.ctx.document.querySelector=()=>null;const read=()=>{updates.forEach(fn=>fn());return f.elements.get('wall-selection-counts').textContent;};
 snapshot={faceSelection:[{solid:'a'},{solid:'b'}]};assert.equal(read(),'Selected: 0 points · 0 lines · 2 faces');
 host.message('Another tool status');assert.equal(read(),'Selected: 0 points · 0 lines · 2 faces');
 snapshot={lineSelection:[{id:'a'},{id:'b'}]};assert.equal(read(),'Selected: 0 points · 2 lines · 0 faces');
 snapshot={};points=[{}, {}, {}];assert.equal(read(),'Selected: 3 points · 0 lines · 0 faces');points=[];assert.equal(read(),'Selected: 0 points · 0 lines · 0 faces');
});

test('editor redraw requests coalesce and a commit upgrades the pending render',()=>{
 const frames=[];let host;const wall={apply:w=>w,draw2D(){},draw3D(){},clear(){},busy:()=>false};
 const f=fixture(true,{requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},createWallEditor:h=>{host=h;return wall;}});
 f.ctx.WallMode.setEnabled(true);frames.length=0;
 for(let i=0;i<10;i++)host.redraw();host.changed();host.redraw();assert.equal(frames.length,1);
 frames.shift()();host.redraw();assert.equal(frames.length,1);frames.shift()();
});

test('project finish palette counts visible finishes, resolves defaults, and omits sticker type colors',()=>{
 let materials,host;
 const {ctx,soffits}=fixture(true,{WallFeatures:{mountUI(a,b,c,m){materials=m;}},ExteriorModel:{collect:state=>state.wallEdits.$surfaces||[]},ExteriorFinishes:{resolve:(face,defaults)=>({color:face.finishColor||defaults.color})},createWallEditor:h=>{host=h;return {leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false};}});
 ctx.WallMode.setEnabled(true);soffits[1].onclick();host.state().finishDefaults={color:'#112233',trimColor:'#abcdef'};
 host.state().wallEdits={$surfaces:[{finishColor:'#778899'},{finishColor:'#778899'},{finishColor:'#778899'},{},{finishColor:'#ABCDEF'},{feature:{type:'window'},finishColor:'#ff0000'}]};
 assert.deepEqual(Array.from(materials.projectColors()),['#778899','#112233','#abcdef']);assert.equal(materials.projectId(),'fixture');
});
