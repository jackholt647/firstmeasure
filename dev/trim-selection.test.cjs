// The Trim menu's Selection section, end to end: the real menu, wall mode's
// undo transaction and the real wall editor writers, without a browser.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),R=require('../public/measure/internal/editor_scripts/roof_trim.js'),T=require('../public/measure/internal/editor_scripts/wall_trim.js'),F=require('../public/measure/internal/editor_scripts/wall_features.js');
const dir='public/measure/internal/editor_scripts/',inch=.0254;
// wall mode's own test fixture, shared with wall-mode.test.cjs.
const source=fs.readFileSync(__dirname+'/wall-mode.test.cjs','utf8'),start=source.indexOf('function fixture(withBase'),end=source.indexOf('\ntest(',start);
const wallModeFixture=new Function('require','vm','fs','G','return ('+source.slice(start,end)+')')(require,vm,fs,G);
function wallEditorFactory(){
 const ctx={console,performance,getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),camera:{position:{x:0,y:-10,z:2}},requestAnimationFrame:()=>0,cancelAnimationFrame(){},addEventListener(){},
  ExteriorGeometry:require('../'+dir+'exterior_geometry.js'),ExteriorModel:require('../'+dir+'exterior_model.js'),WallAxisCuts:require('../'+dir+'wall_axis_cuts.js'),WallTrim:T,WallSteps:require('../'+dir+'wall_steps.js'),WallFeatures:F,WallSolidGeometry:require('../'+dir+'wall_solid_geometry.js'),BaseGeometry:require('../'+dir+'base_geometry.js'),BaseSketchGeometry:require('../'+dir+'base_sketch_geometry.js'),WallGeometry:G};
 ctx.window=ctx;vm.createContext(ctx);for(const name of ['wall_editor.js','wall_face_draft.js'])vm.runInContext(fs.readFileSync(dir+name,'utf8'),ctx);return ctx;
}
function menuFactory(){
 const nodes=new Map(),element=()=>({style:{setProperty(){}},dataset:{},children:[],classList:{toggle(){}},replaceChildren(){this.children=[];},appendChild(n){this.children.push(n);},value:'',hidden:false,addEventListener(){},setAttribute(){},focus(){},blur(){},querySelector(q){if(q[0]==='#')return nodes.get(q.slice(1));this.found||={};return this.found[q]||=element();},querySelectorAll(){return this.children;},set innerHTML(html){for(const m of html.matchAll(/<(?:button|input|select|span|section|div)[^>]*id="([^"]+)"[^>]*>/g)){const n=element();n.value=m[0].match(/value="([^"]+)"/)?.[1]||'';nodes.set(m[1],n);}},get parentElement(){return parent;}}),parent={insertBefore(node){nodes.set(node.id,node);}};
 const ctx={RoofTrim:R,WallTrim:T,document:{querySelector:()=>parent,createElement:element,head:{appendChild(){}},getElementById:()=>null}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(dir+'roof_trim_editor.js','utf8'),ctx);return {ctx,nodes};
}
const p=(x,z,y=0)=>({x,y,z});
function setup(){
 let wallHost,wallEditor,menu;const walls=wallEditorFactory(),dom=menuFactory();
 const f=wallModeFixture(true,{console,WallTrim:T,WallSolidGeometry:require('../'+dir+'wall_solid_geometry.js'),createWallEditor:h=>{wallHost=h;wallEditor=walls.createWallEditor(h);return wallEditor;},createRoofTrimEditor:h=>{menu=dom.ctx.createRoofTrimEditor(h);return menu;}});
 f.ctx.activeGeometry.connections[0].type='eave';f.ctx.WallMode.setEnabled(true);f.soffits[1].onclick();
 const state=wallHost.state(),window={id:'win',points:[p(5.5,1),p(6.5,1),p(6.5,2),p(5.5,2)].map(q=>({...q,x:q.x+100})),feature:{type:'window'}};
 // Two stored wall faces meeting at a corner, a third face and a window, away from the generated walls.
 const at=q=>({...q,x:q.x+100});
 state.wallEdits={$surfaces:[{id:'front',points:[p(0,0),p(4,0),p(4,3),p(0,3)].map(at),material:'siding'},{id:'side',points:[p(0,0),p(0,0,-3),p(0,3,-3),p(0,3)].map(at),material:'siding'},{id:'panel',points:[p(5,0),p(7,0),p(7,3),p(5,3)].map(at),material:'siding'},window]};
 const roof=state.roof,eave=R.panels(roof).find(s=>s.type==='eave');assert.ok(eave,'the fixture roof has an eave');menu.refresh(roof);
 dom.nodes.get('roof-trim-tool').onclick();
 const corner=[at(p(0,0)),at(p(0,3))];
 const select=()=>{wallEditor.restoreSelection({draft:{lineSelection:[{id:'corner',pair:corner}],faceSelection:[{solid:'panel'},{solid:'win'}],selectedSolid:'panel'}});menu.restoreSelection({selected:[eave.id]});menu.update();};
 select();
 const key=(k,extra={})=>f.listeners['window:keydown']?.({key:k,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){},stopPropagation(){},...extra});
 return {f,state,menu,wallEditor,eave,corner,select,key,dom,settings:()=>f.ctx.WallMode.serialize().roofTrim};
}
const lineLayers=s=>[...new Map(s.wallEdits.$surfaces.flatMap(f=>f.trimData?.layers||[]).filter(l=>!l.side&&!l.joinIds).map(l=>[l.id,l])).values()];
const faceLayers=s=>T.insideLayers(s.wallEdits.$surfaces,['panel']);
const opening=s=>s.wallEdits.$surfaces.find(f=>f.id==='win').feature;

test('the Selection section counts a mixed selection by type and shows no trim yet',()=>{
 const {menu}=setup(),s=menu.summary();
 assert.equal(s.total,4);assert.deepEqual({...s.counts},{line:1,face:1,window:1,eave:1});
 assert.equal(s.text,'4 selected · 1 wall line · 1 face (inside trim) · 1 eave · 1 window');assert.equal(s.width,0);assert.equal(s.color,null);assert.equal(s.missing,true);
});

test('one width and colour reach every type through its writer, as one undo step',()=>{
 const t=setup(),{state,menu,eave}=t,before=JSON.stringify({edits:state.wallEdits,roof:t.settings()});
 assert.equal(menu.applySelection({width:4,fallback:'#123456'}),true);
 assert.ok(lineLayers(state).length>=1&&lineLayers(state).every(l=>Math.abs(l.width-4*inch)<1e-9&&l.finishColor==='#123456'),'wall line trim, both walls of the corner');
 assert.equal(new Set(state.wallEdits.$surfaces.filter(f=>f.trim&&f.trimData?.layers.some(l=>!l.side)).map(f=>T.hostOf(f))).size,2,'line trim stays two-sided');
 assert.ok(faceLayers(state).length===4&&faceLayers(state).every(l=>Math.abs(l.width-4*inch)<1e-9&&l.finishColor==='#123456'),'inside trim on the face');
 assert.ok(Math.abs(opening(state).trim.width-4*inch)<1e-9);assert.equal(opening(state).trim.color,'#123456');
 assert.ok(Math.abs(t.settings().edges[eave.id].height-4*inch)<1e-9);
 const s=menu.summary();assert.equal(s.total,4,'the selection survives the change');assert.equal(s.width,4);
 t.key('z',{ctrlKey:true});
 assert.equal(JSON.stringify({edits:state.wallEdits,roof:t.settings()}),before,'one Ctrl+Z reverts every type');
});

test('mixed values show as mixed; a colour change keeps widths and a width change keeps colours',()=>{
 const t=setup(),{state,menu}=t;menu.applySelection({width:4});
 // Give the face a different width through the menu with only the face selected.
 t.wallEditor.restoreSelection({draft:{faceSelection:[{solid:state.wallEdits.$surfaces.find(f=>!f.trim&&T.hostOf(f)==='panel').id}],selectedSolid:state.wallEdits.$surfaces.find(f=>!f.trim&&T.hostOf(f)==='panel').id}});menu.restoreSelection({selected:[]});
 assert.equal(menu.summary().total,1);menu.applySelection({width:6});t.select();t.wallEditor.restoreSelection({draft:{lineSelection:[{id:'corner',pair:t.corner}],faceSelection:[{solid:state.wallEdits.$surfaces.find(f=>!f.trim&&T.hostOf(f)==='panel').id},{solid:'win'}],selectedSolid:state.wallEdits.$surfaces.find(f=>!f.trim&&T.hostOf(f)==='panel').id}});menu.update();
 let s=menu.summary();assert.equal(s.total,4);assert.equal(s.width,null,'widths differ: mixed');assert.equal(t.dom.nodes.get('trim-selection-custom').placeholder,'Mixed');
 menu.applySelection({color:'#aa0000'});s=menu.summary();assert.equal(s.color,'#aa0000');assert.equal(s.width,null,'colour alone leaves the widths mixed');
 assert.ok(faceLayers(state).every(l=>Math.abs(l.width-6*inch)<1e-9));assert.ok(Math.abs(opening(state).trim.width-4*inch)<1e-9);assert.ok(lineLayers(state).every(l=>Math.abs(l.width-4*inch)<1e-9));
 menu.applySelection({width:3});s=menu.summary();assert.equal(s.width,3);assert.equal(s.color,'#aa0000','width alone keeps the colour');
 assert.equal(t.dom.nodes.get('trim-selection-color').value,'#aa0000');
});

test('Remove takes trim off every selected item; T adds trim with the current settings and keeps the menu open',()=>{
 const t=setup(),{state,menu,eave}=t;
 t.key('t');let s=menu.summary();assert.equal(s.missing,false,'T trims everything that had none');assert.equal(t.dom.nodes.get('roof-trim-options').hidden,false,'the menu stays open');
 assert.ok(lineLayers(state).length&&faceLayers(state).length&&opening(state).trim&&t.settings().edges[eave.id].height>0);
 assert.equal(menu.applySelection({remove:true}),true);s=menu.summary();assert.equal(s.width,0);
 assert.equal(lineLayers(state).length,0);assert.equal(faceLayers(state).length,0);assert.equal(opening(state).trim,undefined);assert.equal(t.settings().edges[eave.id].height,0);
});
