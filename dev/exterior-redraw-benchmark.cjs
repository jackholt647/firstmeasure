// CPU-only 2D/3D preparation benchmark. Uses a private in-memory clone; never saves the project.
// Reuses the geometry fixture, excluding real DOM, WebGL, and GPU execution.
const fs=require('fs'),path=require('path'),Module=require('module');
const source=path.resolve('dev/wall-face-draft.test.cjs'),m=new Module(source,module);m.filename=source;m.paths=Module._nodeModulePaths(path.dirname(source));const r=m.require.bind(m);m.require=id=>id==='node:test'?()=>{}:r(id);m._compile(fs.readFileSync(source,'utf8')+'\nmodule.exports={fixture,renderGlobals};',source);
if(!process.argv[2])throw Error('Usage: node dev/exterior-redraw-benchmark.cjs <exported wall state or app_metadata.json>');
const input=JSON.parse(fs.readFileSync(process.argv[2])),state=input.exteriorsWalls||input;
const {fixture,renderGlobals}=m.exports;const counts=new Map();
const profile={enabled:true,measure(name,fn){const start=performance.now();try{return fn();}finally{const a=counts.get(name)||[];a.push(performance.now()-start);counts.set(name,a);}}};
const f=fixture({state:structuredClone(state),walls:state.alignedWalls||state.cleanedWalls||state.mergedWalls||[],selected:null,globals:{...renderGlobals(),EXTERIOR_DISABLE_RENDER_CACHE:process.argv.includes('--uncached'),ExteriorPerf:profile,WallChimneys:require('../public/measure/internal/editor_scripts/wall_chimneys.js')}});
const moving=process.argv.includes('--move'),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
if(moving){const feature=M.collect(f.state).find(face=>face.feature);if(!feature)throw Error('No sticker in benchmark model');if(!f.editor.geometryCommand('m',{points:feature.points,event:f.e(2,2)}))throw Error('Could not start move');if(f.editor.interaction()!=='Transform geometry')throw Error('Move failed: '+f.message());}
const values=[],states=new Set();for(let i=0;i<30;i++){if(moving)f.listeners.pointermove(f.e(2+(i+1)*.01,2+(i+1)*.003));if(moving)states.add(JSON.stringify(f.state.wallEdits));require('../public/measure/internal/editor_scripts/wall_chimneys.js').withVisibilitySnapshot(f.state,()=>{let start=performance.now();f.editor.draw2D({},()=>({}),1);const two=performance.now()-start;start=performance.now();f.editor.draw3D({add(){}},p=>p);values.push({two,three:performance.now()-start});});}
if(moving&&states.size<10)throw Error('Movement benchmark did not produce enough distinct positions');
console.log(JSON.stringify({distinctPositions:states.size,moving,uncached:process.argv.includes('--uncached'),means:values.slice(5).reduce((a,b)=>({two:a.two+b.two/25,three:a.three+b.three/25}),{two:0,three:0}),timings:[...counts].map(([name,v])=>({name,mean:v.reduce((a,b)=>a+b,0)/v.length,calls:v.length}))},null,2));
