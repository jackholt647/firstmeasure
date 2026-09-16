// Run from the repository root. Optional argument: an exported editor state JSON.
// CPU-only harness: includes actual editor/geometry code, excludes DOM/WebGL,
// persistence and history owned by WallMode. Timings are not browser FPS.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const M=require('../public/measure/internal/editor_scripts/exterior_model.js');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const rect=(x,z,w,h)=>[{x,y:0,z},{x:x+w,y:0,z},{x:x+w,y:0,z:z+h},{x,y:0,z:z+h}];
const median=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)];
function measure(fn,n=7){const values=[];for(let i=0;i<n+2;i++){const start=performance.now();fn(i);if(i>=2)values.push(performance.now()-start);}return +median(values).toFixed(2);}
// Reference implementation from before the broad phase/cache optimization.
function referenceCut(face,features){const frame=W.faceFrame(face),local=p=>K.local(frame,p),shape=f=>({points:f.points.map(local),holes:(f.holes||[]).map(r=>r.map(local))});const cuts=features.filter(f=>f.feature&&f.points.every(p=>Math.abs(local(p).z)<=.002)).map(shape);return K.difference(shape(face),cuts);}
const scaling=[];
for(const count of [20,100,1000]){
 const walls=Array.from({length:count},(_,i)=>({points:rect(i*8,0,4,4)})),features=walls.map((_,i)=>({feature:{type:'window'},points:rect(i*8+1,1,1,2)}));
 const optimized=()=>{const index=M.indexOpenings(features);for(const wall of walls)M.cutOpenings(wall,index);};
 const indexedMs=measure(optimized,3),referenceMs=count<=100?measure(()=>{for(const wall of walls)referenceCut(wall,features);},3):null;
 const index=M.indexOpenings(features),candidates=walls.reduce((n,f)=>n+index.query([[f.points[0].x,f.points[1].x],[0,0],[0,4]]).length,0);
 scaling.push({walls:count,windows:count,allPairs:count*count,indexedCandidates:candidates,indexedMs,referenceMs});
}
// Reuse the editor's established non-WebGL fixture, without registering tests.
const file=path.resolve('dev/wall-face-draft.test.cjs'),harness=new Module(file,module);harness.filename=file;harness.paths=Module._nodeModulePaths(path.dirname(file));const requireFixture=harness.require.bind(harness);harness.require=id=>id==='node:test'?()=>{}:requireFixture(id);harness._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports={fixture,renderGlobals};',file);
const {fixture,renderGlobals}=harness.exports,input=JSON.parse(fs.readFileSync(process.argv[2]||'dev/fixtures/exterior-engine-reloaded.json','utf8'));
const create=()=>fixture({state:structuredClone(input),walls:input.walls||[],selected:null,globals:{...renderGlobals(),WallChimneys:require('../public/measure/internal/editor_scripts/wall_chimneys.js')}});
const editor=create();let objects=0;const renderMs=measure(()=>{objects=0;editor.editor.draw3D({add(){objects++;}},p=>p);});
const feature=M.collect(editor.state).find(f=>f.feature);let moveMs=null;
if(feature){editor.editor.geometryCommand('m',{points:feature.points,event:editor.e(2,2)});moveMs=measure(i=>editor.editor.distanceInput()?.set((i+1)*.01));editor.editor.key({key:'Escape'});}
const deletion=[];
for(let i=0;i<5;i++){const f=create(),solid=f.state.wallEdits.$surfaces?.find(f=>!f.deleted&&!f.drafted&&!f.feature);if(!solid)break;f.editor.restoreSelection({solidPoints:[W.vertexKey(solid.points[0])]});const start=performance.now();f.editor.key({key:'Delete'});deletion.push(performance.now()-start);}
console.log(JSON.stringify({cpuOnly:true,scaling,editor:{faces:M.collect(input).length,renderObjects:objects,renderMs,moveGeometryMs:moveMs,deleteGeometryMs:deletion.length?+median(deletion).toFixed(2):null}},null,2));
