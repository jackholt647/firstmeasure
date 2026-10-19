// Preview performance shortcuts must return exactly what the plain code returns.
// Pure helpers are compared with their reference definitions. Editor gestures
// (line move/extrude, entity move/extrude, face extrude/move, geometry move/rotate,
// nudges, with a render after every step) run twice in child processes: once on
// the current files and once on a reference build of the same files with every
// preview shortcut textually reverted. Every step's state, history, selection,
// message and drawn preview must match, including -0, undefined keys and shared
// references. Extra saved houses: PREVIEW_EQUIVALENCE_MODELS=dir|file;...
// To compare against a commit instead: PREVIEW_EQUIVALENCE_BASE=<commit>.
// Timing runs (no rendering or comparison): see the child's timing option.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),DIR=path.join(ROOT,'public/measure/internal/editor_scripts');
const FILES={draft:path.join(DIR,'wall_face_draft.js'),solid:path.join(DIR,'wall_solid_geometry.js'),model:path.join(DIR,'exterior_model.js')};

// Each shortcut, reverted to the code it replaced. A failed match means the
// shortcut changed: update its reference here together with the shortcut.
const REVERT={
 draft:[
  ['function jsonCopy(v){try{return jsonCopyValue(v);}catch{return JSON.parse(JSON.stringify(v));}}','function jsonCopy(v){return JSON.parse(JSON.stringify(v));}'],
  ["  const next=v!==undefined&&typeof v!=='function'&&typeof v!=='symbol'&&p&&Object.getPrototypeOf(p)===null&&typeof edits.toJSON!=='function'?copy({...edits,$drafts:null}):copy(edits);",'  const next=copy(edits);'],
  ['motion=t.lineMotion;','motion=null;'],
  ['motion=chosen.pairMotion;','motion=null;'],
  ['graph=solidEdges.length?wire():null','graph=wire()'],
  ['t.preview=null;t.measure=null;t.pathSnap=null;','t.preview=null;t.measure=null;t.pathSnap=null;host.state().wallEdits=copy(t.before);'],
  ['host.state().wallEdits=edits;}else host.state().wallEdits=copy(t.before);','host.state().wallEdits=edits;}'],
  ['function movesByKey(moves){const index=new Map();for(const m of moves){const key=W.vertexKey(m.from);if(!index.has(key))index.set(key,m);}return p=>index.get(W.vertexKey(p));}','function movesByKey(moves){return p=>moves.find(m=>W.vertexKey(m.from)===W.vertexKey(p));}'],
  ["copyWithDrafts(tool.before,tool.mode==='extrude'||tool.upperChimney?tool.sceneDrafts:null)",'copyWithDrafts(tool.before,tool.sceneDrafts)'],
  ['let fromBox;const near=p=>{if(fromBox===undefined)fromBox=W.contactBox?W.contactBox(result.moves.map(m=>m.from),2e-5):null;return !W.inContactBox||W.inContactBox(p,fromBox);};','const near=()=>true;'],
  ['validateEdits(edits,t.before,true)','validateEdits(edits,t.before)'],
  ['t.normalMode?copyWithDrafts(t.stageBefore||t.before,t.sceneDrafts):shareWithDrafts(t.stageBefore||t.before,t.sceneDrafts)','copyWithDrafts(t.stageBefore||t.before,t.sceneDrafts)'],
 ],
 solid:[
  ["const vertexKey=p=>Number(p.x).toFixed(6)+','+Number(p.y).toFixed(6)+','+Number(p.z).toFixed(6);","const vertexKey=p=>[p.x,p.y,p.z].map(v=>Number(v).toFixed(6)).join(',');"],
  ["const edgeKey=(a,b)=>{const x=vertexKey(a),y=vertexKey(b);return y<x?y+'|'+x:x+'|'+y;};","const edgeKey=(a,b)=>[vertexKey(a),vertexKey(b)].sort().join('|');"],
  [" const point=p=>{if(edges.length&&!inContactBox(p,all))return p;let nearest=null,error=.002;for(let i=0;i<edges.length;i++){if(!inContactBox(p,boxes[i]))continue;const [a,b]=edges[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<K.CONTACT*K.CONTACT)continue;"," const point=p=>{let nearest=null,error=.002;for(const [a,b]of edges){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<K.CONTACT*K.CONTACT)continue;"],
  [" const selected=p=>pairs.some(([a,b],i)=>inContactBox(p,pairBoxes[i])&&(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-8?Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)<1e-5:pointOnEdge(p,a,b))),vertices="," const selected=p=>pairs.some(([a,b])=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-8?Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)<1e-5:pointOnEdge(p,a,b)),vertices="],
  ["matching=p=>inContactBox(p,moveBox)?moves.find(m=>Math.hypot(...Object.values(sub(m.from,p)))<1e-5):undefined,","matching=p=>moves.find(m=>Math.hypot(...Object.values(sub(m.from,p)))<1e-5),"],
  ["  if(!touches(f))return f;",""],
  ["radius=options.radius??.15,screens=new Map();let best=null;","radius=options.radius??.15;let best=null;"],
  ["const floor=Math.abs(t-amount)*(options.minPixelsPerMeter||0);if(floor>radius)continue;","const floor=Math.abs(t-amount)*(options.minPixelsPerMeter||0);"],
  ["let a=screens.get(p);if(a===undefined){a=options.screen(at(amount));screens.set(p,a);}const b=options.screen(at(t));","const a=options.screen(at(amount)),b=options.screen(at(t));"],
  ['if(inContactBox(p,box)&&pointOnEdge(p,a,b)){','if(pointOnEdge(p,a,b)){'],
  ['return inContactBox(p,box)?moves.find(m=>Math.hypot(p.x-m.from.x,p.y-m.from.y,p.z-m.from.z)<=K.CONTACT):undefined;','return moves.find(m=>Math.hypot(p.x-m.from.x,p.y-m.from.y,p.z-m.from.z)<=K.CONTACT);'],
  ['f.points.every(p=>originalKeys.has(vertexKey(p)))','f.points.every(p=>original.points.some(q=>vertexKey(p)===vertexKey(q)))'],
  ['function jsonEqual(a,b){try{const kind=jsonKind(a);return kind===jsonKind(b)&&jsonSame(a,b,kind);}catch{return JSON.stringify(a)===JSON.stringify(b);}}','function jsonEqual(a,b){return JSON.stringify(a)===JSON.stringify(b);}'],
 ],
 model:[
  ['function copy(x){try{return jsonCopyValue(x);}catch{return JSON.parse(JSON.stringify(x));}}','function copy(x){return JSON.parse(JSON.stringify(x));}'],
  ['validateEdits(next,before,true)','validateEdits(next,before)'],
 ],
};
function referenceSources(){
 const out={};for(const [name,file]of Object.entries(FILES)){let text=fs.readFileSync(file,'utf8');for(const [from,to]of REVERT[name]){const count=text.split(from).length-1;if(count!==1)throw Error(path.basename(file)+': expected one '+JSON.stringify(from.slice(0,60))+', found '+count);text=text.replace(from,()=>to);}out[file]=text;}
 return out;
}
function baseSources(commit){const {execFileSync}=require('node:child_process');return Object.fromEntries(Object.values(FILES).map(file=>[file,execFileSync('git',['show',commit+':'+path.relative(ROOT,file).replace(/\\/g,'/')],{cwd:ROOT,encoding:'utf8',maxBuffer:64<<20})]));}

// Serialization that keeps what JSON drops: -0, NaN, undefined keys, holes and
// which objects are the same object (as back-references in visiting order).
function strict(value){
 const seen=new Map();
 const walk=v=>{
  if(v===null)return 'null';
  switch(typeof v){case 'number':return Object.is(v,-0)?'-0':String(v);case 'string':return JSON.stringify(v);case 'boolean':return String(v);case 'undefined':return 'undefined';case 'function':return 'function';case 'symbol':return 'symbol';case 'bigint':return v+'n';}
  if(seen.has(v))return '@'+seen.get(v);seen.set(v,seen.size);
  if(Array.isArray(v)){let s='[';for(let i=0;i<v.length;i++)s+=(i?',':'')+(i in v?walk(v[i]):'hole');return s+']';}
  if(v instanceof Map)return 'Map{'+[...v].map(([k,x])=>walk(k)+'=>'+walk(x)).join(',')+'}';
  if(v instanceof Set)return 'Set{'+[...v].map(walk).join(',')+'}';
  return '{'+Object.keys(v).map(k=>JSON.stringify(k)+':'+walk(v[k])).join(',')+'}';
 };
 return walk(value);
}
const digest=v=>crypto.createHash('sha1').update(strict(v)).digest('hex').slice(0,20);

function childMain(){
 const [,, ,mode,input,output,optionsText]=process.argv,options=JSON.parse(optionsText||'{}');
 // Deterministic ids and random choices in every realm.
 let clock=1789000000000,seed=12345;const now=()=>++clock,random=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
 Date.now=now;Math.random=random;
 if(mode!=='optimized'){
  const sources=mode==='reference'?referenceSources():baseSources(mode.slice(5)),map=new Map(Object.entries(sources).map(([k,v])=>[path.resolve(k).toLowerCase(),v]));
  const read=fs.readFileSync;fs.readFileSync=function(file,...rest){if(typeof file==='string'){const text=map.get(path.resolve(file).toLowerCase());if(text!==undefined){const enc=typeof rest[0]==='string'?rest[0]:rest[0]?.encoding;return enc?text:Buffer.from(text);}}return read.call(this,file,...rest);};
  const js=Module._extensions['.js'];Module._extensions['.js']=function(module,filename){const text=map.get(path.resolve(filename).toLowerCase());if(text!==undefined)return module._compile(text,filename);return js.call(this,module,filename);};
 }
 process.chdir(ROOT);
 const file=path.join(ROOT,'dev/wall-face-draft.test.cjs'),harness=new Module(file,module);harness.filename=file;harness.paths=Module._nodeModulePaths(path.dirname(file));const req=harness.require.bind(harness);harness.require=id=>id==='node:test'?()=>{}:req(id);
 harness._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports={fixture,renderGlobals};',file);
 const {fixture,renderGlobals}=harness.exports,W=require(FILES.solid);
 const data=JSON.parse(fs.readFileSync(input,'utf8')),source=data.exteriorsWalls||data.state||data,initial=JSON.stringify(source);
 const state=JSON.parse(initial),walls=source.walls||source.alignedWalls||source.cleanedWalls||[];if(!state.wallEdits)state.wallEdits={};
 const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z}),mul=(a,s)=>({x:a.x*s,y:a.y*s,z:a.z*s}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}),unit=a=>mul(a,1/Math.hypot(a.x,a.y,a.z));
 const worldOf=(d,p)=>d.frame?W.fromFrame(d.frame,p):{x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};
 // Segments of the saved house, in world space.
 const segments=[];const edits=state.wallEdits;
 for(const f of edits.$surfaces||[])if(!f.deleted&&!f.drafted&&!f.curvedSurface)for(const r of [f.points,...(f.holes||[])])for(let i=0;i<r.length;i++)segments.push([r[i],r[(i+1)%r.length]]);
 for(const d of Object.values(edits.$drafts||{}))for(const f of d.faces||[])if(!f.solidId&&!f.boundaryHole)for(let i=0;i<f.points.length;i++)segments.push([f.points[i],f.points[(i+1)%f.points.length]].map(p=>worldOf(d,p)));
 for(const w of walls)if(w.bottom&&w.top)segments.push([w.bottom[0],w.bottom[1]],[w.top[0],w.top[1]],[w.bottom[1],w.top[1]]);
 const points=segments.flat();if(!points.length)throw Error('No geometry in '+input);
 // Optional loose wire over a few face edges (line extrusions add to it).
 if(options.loose)edits.$loose={points:[],edges:segments.filter(([a,b])=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>.4).slice(0,3).map(pair=>pair.map(p=>({x:p.x,y:p.y,z:p.z})))};
 const lo=['x','y','z'].map(k=>Math.min(...points.map(p=>p[k]))),hi=['x','y','z'].map(k=>Math.max(...points.map(p=>p[k])));
 const center={x:(lo[0]+hi[0])/2,y:(lo[1]+hi[1])/2,z:(lo[2]+hi[2])/2},extent=Math.max(1,hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]),scale=700/extent;
 // Orthographic camera looking down at the house from the front right.
 const D=unit({x:.55,y:.75,z:-.38}),SX=unit(cross(D,{x:0,y:0,z:1})),SY=cross(SX,D),rect={left:0,top:0,width:1600,height:900};
 const screen=p=>{const q=sub(p,center);return {x:800+dot(q,SX)*scale,y:450-dot(q,SY)*scale,visible:true};};
 const rayOrigin=(x,y)=>add(add(center,add(mul(SX,(x-800)/scale),mul(SY,(450-y)/scale))),mul(D,-1000));
 const projectPoint=(d,e)=>{const o=worldOf(d,{x:0,y:0}),U=sub(worldOf(d,{x:1,y:0}),o),V=sub(worldOf(d,{x:0,y:1}),o),N=cross(U,V),den=dot(N,D);if(Math.abs(den)<1e-9)return null;const R=rayOrigin(e.clientX,e.clientY),h=sub(add(R,mul(D,dot(sub(o,R),N)/den)),o),uu=dot(U,U),uv=dot(U,V),vv=dot(V,V),hu=dot(h,U),hv=dot(h,V),det=uu*vv-uv*uv;return {x:(hu*vv-hv*uv)/det,y:(hv*uu-hu*uv)/det,z:0};};
 class Vector3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}copy(v){return this.set(v.x,v.y,v.z);}clone(){return new Vector3(this.x,this.y,this.z);}add(v){return this.set(this.x+v.x,this.y+v.y,this.z+v.z);}sub(v){return this.set(this.x-v.x,this.y-v.y,this.z-v.z);}multiplyScalar(s){return this.set(this.x*s,this.y*s,this.z*s);}dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}cross(v){return this.set(this.y*v.z-this.z*v.y,this.z*v.x-this.x*v.z,this.x*v.y-this.y*v.x);}lengthSq(){return this.dot(this);}length(){return Math.sqrt(this.lengthSq());}normalize(){return this.multiplyScalar(1/(this.length()||1));}distanceTo(v){return Math.hypot(this.x-v.x,this.y-v.y,this.z-v.z);}}
 // Closest points between the pick ray and a segment, as three.js computes them.
 class Ray{constructor(){this.origin=new Vector3();this.direction=new Vector3();}
  distanceSqToSegment(v0,v1,onRay,onSegment){const center=new Vector3().copy(v0).add(v1).multiplyScalar(.5),dir=new Vector3().copy(v1).sub(v0).normalize(),diff=this.origin.clone().sub(center),extent=new Vector3().copy(v0).distanceTo(v1)*.5,a01=-this.direction.dot(dir),b0=diff.dot(this.direction),b1=-diff.dot(dir),c=diff.lengthSq(),det=Math.abs(1-a01*a01);let s0,s1,sq;
   if(det>0){s0=a01*b1-b0;s1=a01*b0-b1;const ext=extent*det;if(s0>=0){if(s1>=-ext){if(s1<=ext){s0/=det;s1/=det;sq=s0*(s0+a01*s1+2*b0)+s1*(a01*s0+s1+2*b1)+c;}else{s1=extent;s0=Math.max(0,-(a01*s1+b0));sq=-s0*s0+s1*(s1+2*b1)+c;}}else{s1=-extent;s0=Math.max(0,-(a01*s1+b0));sq=-s0*s0+s1*(s1+2*b1)+c;}}
    else if(s1<=-ext){s0=Math.max(0,-(-a01*extent+b0));s1=s0>0?-extent:Math.min(Math.max(-extent,-b1),extent);sq=-s0*s0+s1*(s1+2*b1)+c;}else if(s1<=ext){s0=0;s1=Math.min(Math.max(-extent,-b1),extent);sq=s1*(s1+2*b1)+c;}else{s0=Math.max(0,-(a01*extent+b0));s1=s0>0?extent:Math.min(Math.max(-extent,-b1),extent);sq=-s0*s0+s1*(s1+2*b1)+c;}}
   else{s1=a01>0?-extent:extent;s0=Math.max(0,-(a01*s1+b0));sq=-s0*s0+s1*(s1+2*b1)+c;}
   if(onRay)onRay.copy(this.direction).multiplyScalar(s0).add(this.origin);if(onSegment)onSegment.copy(dir).multiplyScalar(s1).add(center);return sq;}}
 class Raycaster{constructor(){this.ray=new Ray();}setFromCamera(v){const o=rayOrigin((v.x+1)/2*rect.width,(1-v.y)/2*rect.height);this.ray.origin.copy(o);this.ray.direction.copy(D);}intersectObjects(ms){return ms.length?[{object:ms[0]}]:[];}}
 const base=renderGlobals();class DetDate extends Date{static now(){return now();}}const detMath=Object.create(Math);detMath.random=random;
 const globals={...base,THREE:{...base.THREE,Vector3,Raycaster},getVector3:p=>new Vector3(p.x,p.y,p.z),renderer:{domElement:{getBoundingClientRect:()=>rect}},camera:{position:add(center,mul(D,-1000))},WallChimneys:require(path.join(DIR,'wall_chimneys.js')),Date:DetDate,Math:detMath};
 const f=fixture({state,walls,selected:null,roof:source.roof,globals,screen,projectPoint});f.normalize();
 const start=JSON.stringify(state.wallEdits),log=[];
 const record=label=>{if(options.record===false){log.push({label});return;}let drawn='-';if(options.draw!==false){const objects=[];try{f.editor.draw3D({add:o=>objects.push(o)},p=>p);drawn=digest(objects.map(o=>[o.constructor?.name,o.geometry?.points,o.geometry?.attributes,o.material?.color,o.material?.opacity,o.userData,o.renderOrder]));}catch(error){drawn='draw error: '+error.message;}}
  log.push({label,interaction:f.editor.interaction?.()??null,message:f.message(),history:f.history.length,state:digest(state.wallEdits),top:f.history.length?digest(f.history.at(-1)):'-',selection:digest(f.editor.selectionSnapshot?.()),drawn});};
 const act=(label,fn)=>{const begin=performance.now();try{fn();}catch(error){label+=' threw '+error.message;}const ms=performance.now()-begin;record(label);if(options.timing)log.at(-1).ms=ms;};
 const reset=()=>{f.editor.key({key:'Escape'});state.wallEdits=JSON.parse(start);f.editor.restoreSelection({});};
 const event=(p,dx=0,dy=0)=>{const s=screen(p);return {clientX:s.x+dx,clientY:s.y+dy,button:0,buttons:0,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,target:{closest:s=>s==='#three-view-wrapper'},stopImmediatePropagation(){},preventDefault(){}};};
 const unique=[...new Map(segments.filter(([a,b])=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>.4).map(pair=>[W.edgeKey(...pair),pair])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,pair])=>pair);
 const count=Math.min(options.pairs??3,unique.length),chosen=Array.from({length:count},(_,i)=>JSON.parse(JSON.stringify(unique[Math.floor((i+.5)*unique.length/count)])));
 const steps=[[5,-3],[12,-8],[22,-14],[35,-22],[48,-30],[-9,6],[-20,13],[-34,21],[2,26],[0,-41]];
 for(const [n,pair]of chosen.entries()){
  const [a,b]=pair,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2},move=(dx,dy)=>f.listeners.pointermove(event(mid,dx,dy)),select=()=>f.editor.restoreSelection({lineSelection:[{id:W.edgeKey(a,b),pair:[a,b]}]});
  // M: move the selected line, cycle its face, nudge (commits), cancel.
  act(n+' M',()=>{select();move(0,0);f.editor.key({key:'m'});});
  for(const [i,[dx,dy]]of steps.slice(0,6).entries())act(n+' M move '+i,()=>move(dx,dy));
  act(n+' M cycle',()=>f.editor.key({key:'m'}));
  for(const [i,[dx,dy]]of steps.slice(6).entries())act(n+' M cycled move '+i,()=>move(dx,dy));
  act(n+' M nudge',()=>f.editor.key({key:'ArrowRight'}));act(n+' M escape',()=>f.editor.key({key:'Escape'}));reset();
  // E: extrude the line, toggle perpendicular, place.
  act(n+' E',()=>{select();move(0,0);f.editor.key({key:'e'});});
  for(const [i,[dx,dy]]of steps.slice(0,5).entries())act(n+' E move '+i,()=>move(dx,dy));
  act(n+' E toggle',()=>f.editor.key({key:'e'}));
  for(const [i,[dx,dy]]of steps.slice(5).entries())act(n+' E normal move '+i,()=>move(dx,dy));
  act(n+' E place',()=>f.editor.down(event(mid,0,-41)));reset();
  // Entity tools: an external line move, a line extrusion across a face, and point moves/extrusions.
  act(n+' line move',()=>f.editor.beginEntity('move',{pair:[a,b],event:event(mid)}));
  for(const [i,[dx,dy]]of steps.slice(0,6).entries())act(n+' line move '+i,()=>move(dx,dy));
  act(n+' line move place',()=>f.editor.down(event(mid,22,-14)));reset();
  act(n+' line extrude',()=>f.editor.beginEntity('extrude',{pair:[a,b],event:event(mid)}));
  for(const [i,[dx,dy]]of steps.entries())act(n+' line extrude '+i,()=>move(dx,dy));
  act(n+' line extrude place',()=>f.editor.down(event(mid,0,-41)));reset();
  for(const mode of ['move','extrude']){
   const at=(dx,dy)=>f.listeners.pointermove(event(a,dx,dy));
   act(n+' point '+mode,()=>f.editor.beginEntity(mode,{point:a,event:event(a)}));
   for(const [i,[dx,dy]]of steps.slice(0,6).entries())act(n+' point '+mode+' '+i,()=>at(dx,dy));
   act(n+' point '+mode+' place',()=>f.editor.down(event(a,35,-22)));reset();
  }
  // Arrow nudges of a selected line (each commits).
  act(n+' nudge select',()=>{select();move(0,0);});
  for(const key of ['ArrowUp','ArrowUp','ArrowLeft','ArrowRight'])act(n+' nudge '+key,()=>f.editor.key({key}));
  reset();
 }
 // E and M on whole faces: stored surfaces and editable draft regions.
 const pick=(list,n)=>Array.from({length:Math.min(n,list.length)},(_,i)=>list[Math.floor((i+.5)*list.length/Math.min(n,list.length))]);
 const centerOf=ps=>ps.reduce((s,p)=>({x:s.x+p.x/ps.length,y:s.y+p.y/ps.length,z:s.z+p.z/ps.length}),{x:0,y:0,z:0});
 const solidFaces=pick((edits.$surfaces||[]).filter(f=>!f.deleted&&!f.drafted&&!f.curvedSurface&&!f.feature&&!f.trim&&f.points?.length>=3).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),options.faces??2).map(f=>({label:'solid '+f.id,selection:{selectedSolid:f.id,preferredSolid:f.id,faceSelection:[{solid:f.id}]},center:centerOf(f.points),points:JSON.parse(JSON.stringify(f.points))}));
 const regionFaces=pick(Object.entries(edits.$drafts||{}).flatMap(([key,d])=>(d.faces||[]).filter(f=>!f.solidId&&!f.boundaryHole&&!f.feature&&f.points?.length>=3).map(f=>({label:'region '+key+':'+f.id,selection:{activeDraftKey:key,preferredDraft:key,preferredRegion:f.id,selectedRegion:{draft:key,face:f.id},faceSelection:[{draft:key,face:f.id}]},center:centerOf(f.points.map(p=>worldOf(d,p))),points:f.points.map(p=>worldOf(d,p))}))).sort((a,b)=>a.label<b.label?-1:a.label>b.label?1:0),options.faces??2);
 for(const face of [...solidFaces,...regionFaces])for(const k of ['e','m']){
  const move=(dx,dy)=>f.listeners.pointermove(event(face.center,dx,dy));
  act(face.label+' '+k,()=>{f.editor.restoreSelection(face.selection);move(0,0);f.editor.key({key:k});});
  for(const [i,[dx,dy]]of steps.slice(0,7).entries())act(face.label+' '+k+' '+i,()=>move(dx,dy));
  act(face.label+' '+k+' place',()=>f.editor.down(event(face.center,35,-22)));reset();
 }
 // Geometry transforms (M move, R rotate) of a face's points.
 if(options.geometry!==false)for(const face of [...solidFaces,...regionFaces])for(const k of ['m','r']){
  const move=(dx,dy)=>f.listeners.pointermove(event(face.center,dx,dy));
  act(face.label+' geometry '+k,()=>{f.editor.restoreSelection({});move(0,0);f.editor.geometryCommand(k,{points:face.points,event:event(face.center)});});
  for(const [i,[dx,dy]]of steps.slice(0,7).entries())act(face.label+' geometry '+k+' '+i,()=>move(dx,dy));
  act(face.label+' geometry '+k+' place',()=>f.editor.down(event(face.center,35,-22)));reset();
 }
 fs.writeFileSync(output,JSON.stringify(log));
}

if(require.main===module&&process.argv[2]==='--child'){childMain();}
else{
 const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),os=require('node:os');
 const M=require(FILES.model),W=require(FILES.solid);
 const run=(mode,input,options)=>{const out=path.join(os.tmpdir(),'preview-equivalence-'+process.pid+'-'+crypto.randomBytes(4).toString('hex')+'.json');try{const r=spawnSync(process.execPath,[__filename,'--child',mode,input,out,JSON.stringify(options||{})],{cwd:ROOT,encoding:'utf8',maxBuffer:64<<20});if(r.status!==0)throw Error(mode+' run failed: '+(r.stderr||r.error?.message||'').slice(-2000));return JSON.parse(fs.readFileSync(out,'utf8'));}finally{fs.rmSync(out,{force:true});}};
 const compare=(input,options)=>{const reference=process.env.PREVIEW_EQUIVALENCE_BASE?'base:'+process.env.PREVIEW_EQUIVALENCE_BASE:'reference',a=run('optimized',input,options),b=run(reference,input,options);
  assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.deepEqual(a[i],b[i],path.basename(input)+' step '+i+' ('+b[i].label+')');return a;};
 // Edge values JSON treats specially, in every position.
 const edgeValues=()=>{const date=new Date(0),boxed=new Number(3),typed=new Float32Array([1.1,-0]),nullProto=Object.assign(Object.create(null),{b:1,a:-0}),withToJSON={x:1,toJSON(){return {y:2};}},klass=new (class P{constructor(){this.x=1;}})();
  return [0,-0,1.5,-1e-7,1e21,NaN,Infinity,-Infinity,'',"a\"b\\ \ud800",true,false,null,undefined,()=>1,Symbol('s'),[],[undefined,()=>1,Symbol('t'),NaN,-0,,3],{},{a:undefined,b:()=>1,c:Symbol('u'),d:NaN,e:-0,f:[1,{g:undefined}]},{2:'two',1:'one',b:'b',a:'a'},JSON.parse('{"__proto__":{"x":1},"y":2}'),date,boxed,typed,nullProto,withToJSON,klass,new Map([[1,2]]),{nested:{date,boxed,typed,nullProto,withToJSON,klass}}];};
 const outcome=fn=>{try{return {value:strict(fn())};}catch(error){return {error:error.constructor.name};}};
 const fuzz=(n,seed=7)=>{let s=seed;const r=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};const leaf=()=>{const k=Math.floor(r()*9);return [()=>r()*20-10,()=>-0,()=>Math.round(r()*4),()=>NaN,()=>undefined,()=>'k'+Math.floor(r()*3),()=>r()<.5,()=>null,()=>Infinity][k]();};
  const make=d=>{const k=r();if(d>3||k<.35)return leaf();if(k<.65)return Array.from({length:Math.floor(r()*4)},()=>make(d+1));const o={};for(let i=Math.floor(r()*4);i>0;i--)o[['x','y','z','id','points'][Math.floor(r()*5)]]=make(d+1);return o;};return Array.from({length:n},()=>make(0));};
 const mutate=(v,seed)=>{if(v===null||typeof v!=='object')return v;const c=JSON.parse(JSON.stringify(v));let s=seed;const r=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};const visit=(o,depth)=>{if(!o||typeof o!=='object')return;const keys=Object.keys(o);if(!keys.length)return;const k=keys[Math.floor(r()*keys.length)];if(depth>2||r()<.3){const x=o[k];o[k]=typeof x==='number'?(r()<.5?x+1e-12:-x):r()<.5?undefined:x;if(r()<.2){delete o[k];o[k]=x;}}else visit(o[k],depth+1);};visit(c,0);return c;};
 const houses=()=>['exterior-phantom-line.json','exterior-base-binding.json','merged-chimney-roof-contact.json','remote-indent-chimney.json','saved_extrusion.json','move-gap-snap.json'].map(f=>path.join(__dirname,'fixtures',f));
 const extraModels=()=>(process.env.PREVIEW_EQUIVALENCE_MODELS||'').split(';').filter(Boolean).flatMap(p=>fs.statSync(p).isDirectory()?fs.readdirSync(p).filter(f=>f.endsWith('.json')).map(f=>path.join(p,f)):[p]);

 test('preview copies equal a JSON round trip, including dropped and special values',()=>{
  for(const value of [...edgeValues(),...fuzz(400)])assert.deepEqual(outcome(()=>M.jsonCopy(value)),outcome(()=>JSON.parse(JSON.stringify(value))));
  const shared={x:1},cyclic={a:1};cyclic.self=cyclic;assert.deepEqual(outcome(()=>M.jsonCopy({p:shared,q:shared})),outcome(()=>JSON.parse(JSON.stringify({p:shared,q:shared}))),'shared objects become separate copies');
  assert.throws(()=>M.jsonCopy(cyclic),TypeError);assert.throws(()=>M.jsonCopy(undefined),SyntaxError);assert.throws(()=>M.jsonCopy({n:1n}),TypeError);
  for(const file of houses()){const value=JSON.parse(fs.readFileSync(file,'utf8')),copy=M.jsonCopy(value);assert.equal(strict(copy),strict(JSON.parse(JSON.stringify(value))));}
  // wall_face_draft.js keeps the same function for its own realm.
  const body=file=>fs.readFileSync(file,'utf8').match(/function jsonCopyValue\(v\)\{[\s\S]*?\r?\n\}/)[0].replace(/\r/g,'');assert.equal(body(FILES.draft),body(FILES.model));
 });
 test('JSON equality equals comparing JSON strings',()=>{
  const values=[...edgeValues(),...fuzz(300,11)];
  for(const a of values)for(const b of values.slice(0,60))assert.equal(W.jsonEqual(a,b),JSON.stringify(a)===JSON.stringify(b),strict([a,b]));
  for(const [i,a]of fuzz(300,23).entries()){const b=mutate(a,i+1);assert.equal(W.jsonEqual(a,b),JSON.stringify(a)===JSON.stringify(b),strict([a,b]));assert.equal(W.jsonEqual(a,structuredClone(a)),true);}
  for(const file of houses()){const value=JSON.parse(fs.readFileSync(file,'utf8'));for(let i=0;i<40;i++){const b=mutate(value,i+1);assert.equal(W.jsonEqual(value,b),JSON.stringify(value)===JSON.stringify(b));}}
 });
 test('vertex and edge keys keep their exact strings',()=>{
  const reference=p=>[p.x,p.y,p.z].map(v=>Number(v).toFixed(6)).join(','),edge=(a,b)=>[reference(a),reference(b)].sort().join('|');
  const numbers=[0,-0,1e-7,-1e-7,5e-7,-5e-7,4.9999995e-7,0.0000005,-0.0000005,1.0000005,-1.0000005,2.5e-6,123456.7891235,-98765.4321005,1e20,1e21,-1e21,NaN,Infinity,-Infinity,0.1+0.2,undefined,'3.25',null,true];
  let s=3;const r=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};for(let i=0;i<4000;i++)numbers.push((r()-.5)*Math.pow(10,Math.floor(r()*12)-4),Math.round((r()-.5)*2e9)/2e6+(r()<.5?5e-7:0));
  for(let i=0;i<numbers.length;i++){const p={x:numbers[i],y:numbers[(i*7+3)%numbers.length],z:numbers[(i*13+5)%numbers.length]},q={x:numbers[(i*5+1)%numbers.length],y:numbers[i],z:numbers[(i*3+2)%numbers.length]};assert.equal(W.vertexKey(p),reference(p));assert.equal(W.edgeKey(p,q),edge(p,q));assert.equal(W.edgeKey(q,p),edge(q,p));assert.equal(W.edgeKey(p,p),edge(p,p));}
 });
 test('validating a fresh copy compares prior surfaces when needed, with identical results',()=>{
  for(const file of houses()){
   const data=JSON.parse(fs.readFileSync(file,'utf8')),before=(data.exteriorsWalls||data.state||data).wallEdits||{};
   for(let i=0;i<12;i++){const edits=mutate(before,i+1);if(i%3===0&&edits.$surfaces?.length)edits.$surfaces.push({...JSON.parse(JSON.stringify(edits.$surfaces[0])),id:'extra-'+i});
    const a=JSON.parse(JSON.stringify(edits)),b=JSON.parse(JSON.stringify(edits)),run=(e,unshared)=>{try{M.validateEdits(e,before,unshared);return strict(e);}catch(error){return 'error: '+error.message;}};
    assert.equal(run(a,true),run(b,false),path.basename(file)+' '+i);}
  }
 });
 test('line slides, trim following, snaps and transforms equal the reference geometry on saved houses',()=>{
  // The reference wall_solid_geometry.js, compiled beside the real one (same kernel modules).
  const R=new Module(FILES.solid,module);R.filename=FILES.solid;R.paths=Module._nodeModulePaths(DIR);R._compile(referenceSources()[FILES.solid],FILES.solid);const ref=R.exports;
  const both=(fn,...args)=>[W,ref].map(api=>{try{return strict(fn(api,...JSON.parse(JSON.stringify(args))));}catch(error){return 'error: '+error.message;}});
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}),unit=a=>{const l=Math.hypot(a.x,a.y,a.z);return {x:a.x/l,y:a.y/l,z:a.z/l};};
  let slides=0;
  for(const file of [...houses(),path.join(__dirname,'fixtures/basement-door-trim-selection.json')]){
   const data=JSON.parse(fs.readFileSync(file,'utf8')),source=data.exteriorsWalls||data.state||data,edits=source.wallEdits||{},base=edits.$base||source.base;
   const scene=[...(edits.$surfaces||[]).filter(f=>!f.drafted&&!f.curvedSurface),...(base?.faces||[]).map(f=>({...f,id:'base:'+f.id,baseId:f.id}))];
   const faces=scene.filter(f=>!f.deleted&&!f.baseId&&f.points.length>=3&&W.normal(f.points));
   for(const [n,face]of faces.filter((_,i)=>i%Math.max(1,Math.floor(faces.length/6))===0).entries()){
    const normal=W.normal(face.points),pair=[face.points[n%face.points.length],face.points[(n+1)%face.points.length]],along=unit(sub(pair[1],pair[0])),direction=unit(cross(normal,along));
    const screen=p=>({x:p.x*60+p.y*25,y:-p.z*60+p.y*12});
    for(const amount of [.05,-.3,.8])for(const preserveConnections of [false,true]){
     const [a,b]=both((api,scene,pair,direction)=>{const result=api.slideLines(scene,[pair],direction,amount,{preserveConnections});return api.followTrim(scene,result,(result.affected||[]).filter(id=>!scene.find(f=>f.id===id)?.trim));},scene,pair,direction);
     assert.equal(a,b,path.basename(file)+' slide '+face.id+' '+amount);slides++;
    }
    const candidates=W.motionSnapCandidates(pair,[pair],direction,scene,{alignmentNormal:normal,excludeMoving:true});
    for(let amount=-2;amount<=2;amount+=.173){const [a,b]=both((api,candidates,pair,direction)=>api.motionSnap(pair,[pair],direction,amount,[],{candidates,screen,radius:12,minPixelsPerMeter:33.33}),candidates,pair,direction);assert.equal(a,b,path.basename(file)+' snap '+face.id+' '+amount);}
    const [a,b]=both((api,scene,face)=>{const clip=api.copyGeometry(scene,face.points,[]);return api.transformSelection(scene,clip,api.transformGeometry(clip,0,{delta:{x:.4,y:-.25}}));},scene,face);
    assert.equal(a,b,path.basename(file)+' transform '+face.id);
   }
  }
  assert.ok(slides>100);
  // Trim runs bound across a corner (the bindings pass of followTrim).
  const rect=(id,x0,x1,z0,z1,extra={})=>({id,points:[{x:x0,y:0,z:z0},{x:x1,y:0,z:z0},{x:x1,y:0,z:z1},{x:x0,y:0,z:z1}],holes:[],...extra});
  const wall=rect('upper',0,3,2.2,5),band=rect('band',0,3,2,2.2,{trim:true}),corner={id:'corner',trim:true,points:[{x:0,y:0,z:0},{x:0,y:.2,z:0},{x:0,y:.2,z:2},{x:0,y:0,z:2}],trimData:{layers:[{id:'vertical',pair:[{x:0,y:0,z:0},{x:0,y:0,z:2}]}]}},side={id:'side',points:[{x:0,y:.2,z:0},{x:0,y:3,z:0},{x:0,y:3,z:2},{x:0,y:.2,z:2}]};
  for(const amount of [-.6,-.05,.3,.6])for(const keep of [false,true]){const [a,b]=both((api,scene,cap)=>api.followTrim(scene,{faces:[cap,...scene.slice(1)]},['upper'],keep),[wall,band,corner,side],{...wall,points:wall.points.map(p=>({...p,y:p.y+amount}))});assert.equal(a,b,'corner run '+amount);}
 });
 for(const file of houses())test('editor previews are identical with and without the preview shortcuts: '+path.basename(file),()=>{const log=compare(file,{pairs:2,faces:1});assert.ok(log.some(step=>/offset|snap|Extrusion|Move/.test(step.message)),'the gestures reached their previews');});
 test('editor previews are identical with and without the preview shortcuts: loose wire',()=>{const log=compare(houses()[0],{pairs:3,faces:0,loose:true});assert.ok(log.some(step=>/E place/.test(step.label)&&step.history>0));});
 for(const file of extraModels())test('editor previews are identical on saved house '+path.basename(file),()=>{compare(file,{pairs:3});});
 test('the reference build reverts every shortcut',()=>{const sources=referenceSources();for(const [name,file]of Object.entries(FILES))assert.notEqual(sources[file],fs.readFileSync(file,'utf8'),name);});
}
