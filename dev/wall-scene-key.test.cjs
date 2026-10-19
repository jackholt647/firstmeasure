// The wall composition cache key (wallSceneInputs in wall_mode.js) must contain every state path the composition
// reads: composing from the projection alone gives the same walls, and changing everything it omits changes neither
// the key nor the walls. Uses the real modules, loaded the way dev/wall-mode.test.cjs does.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const E='../public/measure/internal/editor_scripts/',req=n=>require(E+n);
function fixture(){
 const elements=new Map(),listeners={},storage=new Map();
 const el=(id='')=>({id,hidden:false,disabled:false,value:'',textContent:'',dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},
  prepend(...c){c.forEach(x=>this.appendChild(x));},append(...c){c.forEach(x=>this.appendChild(x));},querySelector(){return null;},appendChild(child){if(child.id)elements.set(child.id,child);},remove(){elements.delete(this.id);},
  querySelectorAll(selector){return selector==='[data-stage]'?stages:selector==='[data-soffit]'?soffits:selector==='[data-resoffit]'?resoffits:[];}});
 const stages=[1,2,3,4,5,6,7].map(n=>({...el(),dataset:{stage:String(n)}})),soffits=['auto','12','18','24'].map(n=>({...el(),dataset:{soffit:n}})),resoffits=['0','0.5','1','1.5','2','wallless'].map(n=>({...el(),dataset:{resoffit:n}}));
 const document={readyState:'loading',head:el(),body:el(),createElement:()=>el(),addEventListener:(name,fn)=>listeners[name]=fn,querySelectorAll:()=>[],
  getElementById(id){if(id==='geoSvg'||id==='measurement-panel')return elements.get(id)||null;if(!elements.has(id))elements.set(id,el(id));return elements.get(id);}};
 const points=[{x:0,y:0,z:8},{x:10,y:0,z:8},{x:10,y:10,z:8},{x:0,y:10,z:8}];
 const ctx={console,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},document,location:{origin:'http://wall-test'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  activeGeometry:{points,connections:[{start:points[0],end:points[1],type:'unknown'}],manualFaces:[{points}]},imageWidth:10,imageHeight:10,mapCenterLat:0,mapCenterLng:0,dsmMin:0,viewRotation:0,currentZoom:1,
  selectedPoints:new Set(),selectedLines:new Set(),tempPoint:null,layerData:{},isMeasurementMode:false,getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),camera:{position:{x:0,y:-10,z:2}},
  addEventListener:(name,fn)=>listeners['window:'+name]=fn,currentProjectId:'fixture',getMetersPerPx:()=>1,confirm:()=>false,
  ExteriorModel:req('exterior_model.js'),ExteriorGeometry:req('exterior_geometry.js'),WallGeometry:req('wall_geometry.js'),WallChimneyCleanup:req('wall_chimney_cleanup.js'),WallRakeCleanup:req('wall_rake_cleanup.js'),WallChimneys:req('wall_chimneys.js'),WallGaps:req('wall_gaps.js'),GroundGeometry:req('ground_geometry.js'),
  BaseGeometry:req('base_geometry.js'),BaseSketchGeometry:req('base_sketch_geometry.js'),WallSolidGeometry:req('wall_solid_geometry.js'),WallClosedSoffits:req('wall_closed_soffits.js'),WallBaseBinding:req('wall_base_binding.js'),
  WallAxisCuts:req('wall_axis_cuts.js'),WallTrim:req('wall_trim.js'),WallSteps:req('wall_steps.js'),WallFeatures:{...req('wall_features.js'),mountUI(){},closeUI(){}},WallParapets:req('wall_parapets.js'),EditorHistory:req('editor_history.js')};
 ctx.window=ctx;ctx.exitMeasurementMode=()=>{};vm.createContext(ctx);
 const run=n=>vm.runInContext(fs.readFileSync(require.resolve(E+n),'utf8'),ctx,{filename:n});
 run('ground_editor.js');run('wall_face_draft.js');run('wall_editor.js');
 let src=fs.readFileSync(require.resolve(E+'wall_mode.js'),'utf8');
 const anchor='    window.WallMode={selectionActions,';assert.ok(src.includes(anchor),'test accessor anchor');
 src=src.replace(anchor,"    window.__wm={compose:()=>perf_composeCurrentWalls(),inputs:wallSceneInputs,getState:()=>state,setState:s=>{state=s;},getStage:()=>stage,setStage:n=>{stage=n;},reset:()=>{wallSceneKey=null;wallSceneOwner=null;baseTerrainKey='';baseTerrainCache=null;}};\n"+anchor);
 vm.runInContext(src,ctx,{filename:'wall_mode.js'});listeners.DOMContentLoaded();ctx.WallMode.restore('fixture',{});
 return ctx;
}
const ARRAYS={2:'extruded',3:'deduplicated',4:'gapRepaired',5:'mergedWalls',6:'cleanedWalls',7:'alignedWalls'};
function scramble(s){
 const e=s.wallEdits||{};
 for(const f of e.$surfaces||[]){f.id=String(f.id)+'~';f.material='zz';f.finishColor='#123456';f.trimData={junk:1};f.retainedPoints=[{x:1,y:2,z:3}];f.draftKey='zz';f.regionId='zz';if(f.feature)f.feature={...f.feature,junk:1};}
 for(const d of Object.values(e.$drafts||{})){d.sketch={nodes:[],edges:[],outlines:[],next:0};d.joinedChimneys=['zz'];d.generatedRoofContact=!d.generatedRoofContact;d.sourcePointsVersion=99;for(const f of d.faces||[]){f.id='zz';f.material='zz';}}
 e.$loose={points:[{x:9,y:9,z:9}],edges:[]};e.$joints=['zz'];e.$removedSurfaceEdges=['zz'];e.$removedSurfacePoints=['zz'];
 for(const k of ['sources','warnings','geometry','groundCandidates','roofSignature','savedAt','context','finishDefaults','roofTrim','extrusionWarnings','gapReport','mergeReport','displayMode','wallCenters','lineCenters'])s[k]='zz';
 if(s.base)s.base.sketch={junk:1};if(e.$base)e.$base.sketch={junk:1};if(s.roof){s.roof.points=[];s.roof.connections=[];}
}
for(const name of ['exterior-engine-saved','exterior-phantom-line','exterior-base-binding'])test(`wall scene key covers every composition input: ${name}`,()=>{
 const ctx=fixture(),W=ctx.__wm,raw=JSON.parse(fs.readFileSync(`dev/fixtures/${name}.json`,'utf8'));
 ctx.WallMode.restore('fixture',{exteriorsWalls:raw,exteriorsView:{enabled:true,savedAt:Number.MAX_SAFE_INTEGER}});
 const s0=W.getState(),stage=W.getStage();assert.ok(s0&&stage>=2,'fixture restored with walls');assert.ok((s0.chimneys?.items||[]).length>0,'the fixture exercises the chimney inputs');
 let checked=0;
 for(const st of [2,3,4,5,6,7].filter(n=>s0[ARRAYS[n]])){
  W.setStage(st);W.reset();const reference=JSON.stringify(W.compose());
  const projected=JSON.parse(JSON.stringify(W.inputs(s0,st)));W.reset();W.setState(projected);
  let fromProjection;try{fromProjection=JSON.stringify(W.compose());}finally{W.setState(s0);W.reset();}
  assert.equal(fromProjection,reference,`stage ${st}: the projection alone composes the same walls`);checked++;
 }
 W.setStage(stage);W.reset();const baseline=JSON.stringify(W.compose()),scrambled=JSON.parse(JSON.stringify(s0));scramble(scrambled);
 assert.equal(JSON.stringify(W.inputs(scrambled,stage)),JSON.stringify(W.inputs(s0,stage)),'omitted paths do not change the key');
 W.setState(scrambled);W.reset();let after;try{after=JSON.stringify(W.compose());}finally{W.setState(s0);W.reset();}
 assert.equal(after,baseline,'omitted paths do not change the composition');assert.ok(checked>=3);
 // Sensitivity: perturb sampled values anywhere in the state; whenever the walls change, the key must change.
 const leaves=[];(function walk(o,path){if(Array.isArray(o))o.forEach((v,i)=>walk(v,[...path,i]));else if(o&&typeof o==='object')for(const k of Object.keys(o))walk(o[k],[...path,k]);else if(typeof o==='number'||typeof o==='boolean')leaves.push(path);})(s0,[]);
 let seed=11,changedWalls=0;const random=()=>(seed=(seed*16807)%2147483647)/2147483647,keyOf=s=>JSON.stringify([stage,W.inputs(s,stage)]);
 const edits=[...Array.from({length:240},()=>leaves[Math.floor(random()*leaves.length)]).map(path=>s=>{let o=s;for(const k of path.slice(0,-1))o=o[k];const k=path.at(-1);o[k]=typeof o[k]==='boolean'?!o[k]:o[k]+.37;}),
  // Inputs these fixtures do not contain: an edited chimney outline and a chimney volume mode.
  s=>{const c=s.chimneys.items[0];(s.wallEdits.$chimneys||={})[c.id]={points:c.points.map(p=>({...p,x:p.x+.4}))};},
  s=>{const c=s.chimneys.items[0];(s.wallEdits.$chimneyVolumes||={})[c.id]={mode:'surface'};}];
 for(const edit of edits){const copy=JSON.parse(JSON.stringify(s0));edit(copy);W.setState(copy);W.reset();let walls;try{walls=JSON.stringify(W.compose());}catch(e){walls='error: '+e.message;}finally{W.setState(s0);W.reset();}
  if(walls!==baseline){changedWalls++;assert.notEqual(keyOf(copy),keyOf(s0),'a change that alters the walls must alter the key');}}
 assert.ok(changedWalls>=2,'the sampled edits reach the composition');
});
