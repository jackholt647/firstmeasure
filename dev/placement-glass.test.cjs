// The placement menu's Glass box through wall mode and the real wall editor
// (FM-534): the box reached the face draft only in tests that called the draft
// directly, so on the page it unticked itself and doors were placed plain.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js'),F=require('../public/measure/internal/editor_scripts/wall_features.js');
const dir='public/measure/internal/editor_scripts/';
// wall mode's own test fixture, shared with wall-mode.test.cjs.
const source=fs.readFileSync(__dirname+'/wall-mode.test.cjs','utf8'),start=source.indexOf('function fixture(withBase'),end=source.indexOf('\n}\n',start)+2;
const wallModeFixture=new Function('require','vm','fs','G','return ('+source.slice(start,end)+')')(require,vm,fs,G);
function wallEditorFactory(){
 const ctx={console,performance,getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),camera:{position:{x:0,y:-10,z:2}},requestAnimationFrame:()=>0,cancelAnimationFrame(){},addEventListener(){},
  ExteriorGeometry:require('../'+dir+'exterior_geometry.js'),ExteriorModel:require('../'+dir+'exterior_model.js'),WallAxisCuts:require('../'+dir+'wall_axis_cuts.js'),WallTrim:require('../'+dir+'wall_trim.js'),WallSteps:require('../'+dir+'wall_steps.js'),WallFeatures:F,WallSolidGeometry:require('../'+dir+'wall_solid_geometry.js'),BaseGeometry:require('../'+dir+'base_geometry.js'),BaseSketchGeometry:require('../'+dir+'base_sketch_geometry.js'),WallGeometry:G};
 ctx.window=ctx;vm.createContext(ctx);for(const name of ['wall_editor.js','wall_face_draft.js'])vm.runInContext(fs.readFileSync(dir+name,'utf8'),ctx);return ctx;
}

test('every wall editor method wall mode calls exists on the wall editor',()=>{
 const walls=wallEditorFactory();let editor;wallModeFixture(true,{console,createWallEditor:h=>editor=walls.createWallEditor(h)});
 const used=[...new Set([...fs.readFileSync(dir+'wall_mode.js','utf8').matchAll(/wallEditor\??\.(\w+)/g)].map(m=>m[1]))];
 assert.ok(editor&&used.length>20);assert.deepEqual(used.filter(name=>typeof editor[name]!=='function'),[]);
});

test('ticking Glass in the placement menu reaches the wall editor and stays ticked (FM-534)',()=>{
 const walls=wallEditorFactory();let editor,mounted;
 const f=wallModeFixture(true,{console,WallFeatures:{...F,mountUI(...args){mounted=args;}},createWallEditor:h=>editor=walls.createWallEditor(h)});
 f.ctx.WallMode.setEnabled(true);assert.ok(mounted,'wall mode mounts the sticker bar');
 const [command,,,materials]=mounted;
 assert.equal(materials.placementGlass(true),false,'nothing to set without a placement session');
 command('door',0,true);assert.equal(materials.placement()?.type,'door');assert.equal(materials.placement().glass,false,'off by default');
 assert.equal(materials.placementGlass(true),true,'the box is accepted');assert.equal(materials.placement().glass,true,'and read back ticked');
 command('door',2,true);assert.equal(materials.placement().glass,true,'another size in the same session stays glass');
 assert.equal(materials.placementGlass(false),true);assert.equal(materials.placement().glass,false);
});
