const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
const T=require('../public/measure/internal/editor_scripts/wall_trim.js');
// The wall editor fixture is shared with wall-face-draft.test.cjs.
const source=fs.readFileSync(__dirname+'/wall-face-draft.test.cjs','utf8'),start=source.indexOf('function fixture('),end=source.indexOf('\nfunction ',start+10);
const fixture=new Function('require','vm','fs','B','S','G','return ('+source.slice(start,end)+')')(require,vm,fs,B,S,G);
const p=(x,z,y=0)=>({x,y,z}),inch=.0254;
const scene=()=>({wallEdits:{$surfaces:[{id:'wall',points:[p(0,0),p(4,0),p(4,3),p(0,3)],holes:[[p(.5,1),p(1,1),p(1,2),p(.5,2)]],material:'siding'},{id:'next',points:[p(4,0),p(8,0),p(8,3),p(4,3)],material:'siding'}]}});
const pick=(f,ids)=>f.editor.restoreSelection({selectedSolid:ids[0],faceSelection:ids.map(solid=>({solid}))});

test('T on a selected face adds inside trim in one step, leaves the neighbour alone and toggles off',()=>{
 const state=scene(),f=fixture({state,walls:[],selected:null}),neighbour=JSON.stringify(state.wallEdits.$surfaces[1]),before=JSON.stringify(state.wallEdits);
 pick(f,['wall']);assert.equal(f.editor.faceTrimItems().length,1);assert.equal(f.editor.faceTrimItems()[0].width,0);
 f.editor.key({key:'t',preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(f.history.length,1,f.message());assert.equal(JSON.stringify(f.history[0]),before);
 const surfaces=state.wallEdits.$surfaces;assert.equal(JSON.stringify(surfaces.find(s=>s.id==='next')),neighbour,'the neighbour is untouched');
 const layers=T.insideLayers(surfaces,['wall']);assert.equal(layers.length,8,'outline and hole edges');assert.ok(layers.every(l=>Math.abs(l.width-6*inch)<1e-12));
 assert.ok(surfaces.filter(s=>s.trim).every(s=>s.points.every(q=>q.x<=4+1e-9)),'no strip crosses onto the neighbour');
 const items=f.editor.faceTrimItems();assert.equal(items.length,1,'the face stays selected');assert.ok(Math.abs(items[0].width-6)<1e-9);
 f.editor.key({key:'t',preventDefault(){},stopImmediatePropagation(){}});assert.equal(f.history.length,2);assert.equal(T.insideLayers(state.wallEdits.$surfaces,['wall']).length,0);assert.ok(!state.wallEdits.$surfaces.some(s=>s.trim));
});

test('face trim width and colour change separately and each change is one undo step',()=>{
 const state=scene(),f=fixture({state,walls:[],selected:null});pick(f,['wall']);
 assert.equal(f.editor.applyFaceTrim(null,'#aa0000',{onlyTrimmed:true}),false);assert.equal(f.history.length,0);assert.equal(f.editor.faceTrimItems().length,1,'the face stays selected');assert.equal(T.insideLayers(state.wallEdits.$surfaces,['wall']).length,0,'a colour alone does not add trim');
 assert.equal(f.editor.applyFaceTrim(4*inch,null,{color:'#123456'}),true,f.message());const added=JSON.stringify(state.wallEdits);
 assert.ok(T.insideLayers(state.wallEdits.$surfaces,['wall']).every(l=>Math.abs(l.width-4*inch)<1e-12&&l.finishColor==='#123456'));
 assert.equal(f.editor.applyFaceTrim(null,'#00ff00'),true);let layers=T.insideLayers(state.wallEdits.$surfaces,['wall']);assert.ok(layers.every(l=>Math.abs(l.width-4*inch)<1e-12&&l.finishColor==='#00ff00'),'colour keeps the width');
 assert.ok(state.wallEdits.$surfaces.filter(s=>s.trim).every(s=>s.finishColor==='#00ff00'));
 assert.equal(f.editor.applyFaceTrim(8*inch,null),true);layers=T.insideLayers(state.wallEdits.$surfaces,['wall']);assert.ok(layers.every(l=>Math.abs(l.width-8*inch)<1e-12&&l.finishColor==='#00ff00'),'width keeps the colour');
 const items=f.editor.faceTrimItems();assert.ok(Math.abs(items[0].width-8)<1e-9);assert.equal(items[0].color,'#00ff00');
 // Undo restores the snapshot taken before each step.
 state.wallEdits=f.history.at(-1);layers=T.insideLayers(state.wallEdits.$surfaces,['wall']);assert.ok(layers.every(l=>Math.abs(l.width-4*inch)<1e-12&&l.finishColor==='#00ff00'));
 state.wallEdits=f.history.at(-2);assert.equal(JSON.stringify(state.wallEdits),added);
});

test('face trim follows the face when it is moved',()=>{
 const state=scene(),f=fixture({state,walls:[],selected:null});pick(f,['wall']);f.editor.applyFaceTrim(6*inch,null);
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),faces=state.wallEdits.$surfaces,inner=faces.find(s=>!s.trim&&T.hostOf(s)==='wall');
 const moved=W.followTrim(faces,{faces:faces.map(s=>s===inner?{...s,points:s.points.map(q=>({...q,y:q.y+.5})),holes:(s.holes||[]).map(r=>r.map(q=>({...q,y:q.y+.5})))}:s),moves:[],affected:[inner.id]},[inner.id]);
 assert.ok(moved.faces.filter(s=>s.trim&&T.hostOf(s)==='wall').every(s=>s.points.every(q=>Math.abs(q.y-.5)<1e-9)),'every strip of the face moves with it');
 assert.ok(moved.faces.find(s=>s.id==='next').points.every(q=>q.y===0));
});
