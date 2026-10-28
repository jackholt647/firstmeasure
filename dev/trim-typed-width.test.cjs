// FM-299: trim widths are typed in inches with the shared number entry, before
// or after T, and T keeps cycling (sides for line trim, sizes for stickers).
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
const T=require('../public/measure/internal/editor_scripts/wall_trim.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
// The wall editor fixture is shared with wall-face-draft.test.cjs.
const source=fs.readFileSync(__dirname+'/wall-face-draft.test.cjs','utf8'),start=source.indexOf('function fixture('),end=source.indexOf('\nfunction ',start+10);
const fixture=new Function('require','vm','fs','B','S','G','return ('+source.slice(start,end)+')')(require,vm,fs,B,S,G);
const p=(x,z,y=0)=>({x,y,z}),inch=.0254;
function numbers(){const ctx={document:{getElementById:()=>null}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_distance_input.js','utf8'),ctx);return ctx.ExteriorDistanceInput;}
// Keys go where wall mode sends them: the number entry first (a tool's input, else the trim width), then the editor.
function setup(options){const input=numbers(),f=fixture({...options,globals:{...(options.globals||{}),ExteriorDistanceInput:input}});
 const type=(...keys)=>{for(const key of keys){const e={key,preventDefault(){},stopImmediatePropagation(){}};if(!input.key(e,f.editor.distanceInput()||f.editor.trimInput()))f.editor.key(e);}};return {...f,type,input};}
const window=(id,x)=>({id,points:[p(x,1),p(x+1,1),p(x+1,2),p(x,2)],feature:{type:'window'}});
const trimOf=(state,id)=>Math.round((state.wallEdits.$surfaces.find(s=>s.id===id).feature.trim?.width||0)/inch*1e6)/1e6;

test('stickers: T then a number, a number then T, and T straight after a number keeps it',()=>{
 const state={wallEdits:{$surfaces:[window('a',0),window('b',2)]}},f=setup({state,walls:[],selected:null});
 f.editor.restoreSelection({selectedSolid:'a',faceSelection:[{solid:'a'},{solid:'b'}]});
 f.type('t');assert.deepEqual([trimOf(state,'a'),trimOf(state,'b')],[2,2],'T alone still cycles to two inches');
 f.type('6');assert.deepEqual([trimOf(state,'a'),trimOf(state,'b')],[6,6],'T then 6 is six inch trim');
 f.type('Backspace','1','0');assert.deepEqual([trimOf(state,'a'),trimOf(state,'b')],[10,10],'Backspace edits the number');
 f.type('t');assert.equal(trimOf(state,'a'),10,'T straight after a number keeps it');
 f.type('t');assert.equal(trimOf(state,'a'),0,'T again cycles on from it');
 f.type('Escape');const before=f.history.length;
 f.type('3','.','5');assert.equal(trimOf(state,'a'),0,'a number before T waits');assert.equal(f.history.length,before);
 f.type('t');assert.deepEqual([trimOf(state,'a'),trimOf(state,'b')],[3.5,3.5],'3.5 then T');
 f.type('t');assert.equal(trimOf(state,'a'),4,'the next T steps from a typed width to the next size');
 f.type('-','2');assert.equal(trimOf(state,'a'),4,'a negative width is ignored');
});

test('a number typed as a single sticker\'s height becomes its trim width when T follows',()=>{
 const state={wallEdits:{$surfaces:[window('a',0)]}},f=setup({state,walls:[],selected:null}),points=JSON.stringify(state.wallEdits.$surfaces[0].points);
 f.editor.restoreSelection({selectedSolid:'a'});f.listeners.pointermove(f.e(.5,1.5));
 assert.equal(f.editor.distanceInput()?.label,'Height','digits size a single sticker until T');
 f.type('6');f.type('t');
 assert.equal(f.editor.busy(),false);const a=M.collect(state).find(s=>s.feature?.type==='window');
 assert.equal(JSON.stringify(a.points),points,'the height preview is dropped');assert.ok(Math.abs(a.feature.trim.width-6*inch)<1e-9,'6 then T is six inch trim');
 f.type('8');assert.ok(Math.abs(M.collect(state).find(s=>s.feature).feature.trim.width-8*inch)<1e-9,'after T, digits set the trim, not the height');
});

test('line trim: a typed width survives T cycling sides, before or after T',()=>{
 const f=setup({});f.editor.doubleClick(f.e(2,0),f.w);f.editor.doubleClick(f.e(2,4),f.w);f.editor.down(f.e(2,0,true));f.listeners.pointerup(f.e(2,0,true));f.editor.key({key:'u'});f.editor.clear();
 assert.ok(f.editor.pickLine3D(f.e(2,2)));f.listeners.pointerup(f.e(2,2));
 const width=()=>{const strips=f.state.wallEdits.$surfaces.filter(s=>s.trim);return Math.round(strips.reduce((n,s)=>n+Math.max(...s.points.map(q=>q.x))-Math.min(...s.points.map(q=>q.x)),0)/inch*1000)/1000;};
 f.type('4');assert.equal(f.editor.busy(),false,'nothing happens before T');
 f.type('t');assert.equal(f.editor.interaction(),'trim');assert.equal(width(),4,'4 then T is four inch trim');assert.match(f.message(),/Trim 4 in · first side/);
 f.type('t');assert.equal(width(),4,'T cycles to the other side at the typed width');assert.match(f.message(),/opposite side/);
 f.type('8');assert.equal(width(),8,'a number after T starts fresh, not 48');
 f.type('t');assert.equal(width(),8,'centered halves still add up to the width');assert.match(f.message(),/centered/);
 const count=f.history.length;f.type('Enter');assert.equal(f.history.length,count+1);assert.equal(width(),8);
});

test('faces: T then a number sets the inside trim width',()=>{
 const state={wallEdits:{$surfaces:[{id:'wall',points:[p(0,0),p(4,0),p(4,3),p(0,3)],material:'siding'}]}},f=setup({state,walls:[],selected:null});
 f.editor.restoreSelection({selectedSolid:'wall',faceSelection:[{solid:'wall'}]});
 f.type('t');assert.ok(T.insideLayers(state.wallEdits.$surfaces,['wall']).every(l=>Math.abs(l.width-6*inch)<1e-9));
 f.type('4');const layers=T.insideLayers(state.wallEdits.$surfaces,['wall']);assert.equal(layers.length,4);assert.ok(layers.every(l=>Math.abs(l.width-4*inch)<1e-9),'T then 4 is four inch inside trim');
 f.type('Escape');f.editor.restoreSelection({selectedSolid:state.wallEdits.$surfaces.find(s=>!s.trim).id,faceSelection:[{solid:state.wallEdits.$surfaces.find(s=>!s.trim).id}]});
 f.type('t');assert.equal(T.insideLayers(state.wallEdits.$surfaces,['wall']).length,0,'T alone still toggles it off');
 f.type('3','t');assert.ok(T.insideLayers(state.wallEdits.$surfaces,['wall']).every(l=>Math.abs(l.width-3*inch)<1e-9),'3 then T is three inch inside trim');
});

test('placing a sticker: a typed width and T are interchangeable',()=>{
 const host={id:'host',points:[p(0,0),p(5,0),p(5,5),p(0,5)]},f=setup({state:{wallEdits:{$surfaces:[host]}},walls:[],selected:null,featureHost:()=>({solid:host,points:host.points})});
 f.editor.featureCommand('window',0,true);f.listeners.pointermove(f.e(2,2));
 f.type('5');assert.equal(f.editor.featurePlacement().trimInches,5);f.type('t');assert.equal(f.editor.featurePlacement().trimInches,5,'T straight after a number keeps it');
 f.type('t');assert.equal(f.editor.featurePlacement().trimInches,6);f.type('t','1','.','5');assert.equal(f.editor.featurePlacement().trimInches,1.5);
 f.editor.down(f.e(2,2));const placed=M.collect(f.state).find(s=>s.feature?.type==='window');assert.ok(Math.abs(placed.feature.trim.width-1.5*inch)<1e-9,f.message());
});
