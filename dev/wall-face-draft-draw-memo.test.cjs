// Drawing memos must never change what is drawn. These tests drive the wall
// drafting editor's draw2D/draw3D over saved houses through repeated frames,
// selection changes, in-place edits and their reversal, undo-style replacement
// with equal values, and marker toggles, and compare every frame's SVG calls,
// 3D scene (objects, geometry, materials, userData and render-part reuse) and
// model state:
// - against the same editor with its draw memos switched off, always;
// - against the editor before the memos were added (REFERENCE), when git can
//   read that commit. Retire this comparison once drawing intentionally changes.
// Extra saved houses: set FM_DRAW_MODELS to a directory of exported projects
// (default output/full-house-speed-20261019/models when it exists).
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const SCRIPTS='public/measure/internal/editor_scripts/',REFERENCE='43b2fa22';
const req=name=>require('../'+SCRIPTS+name+'.js');
const M={ExteriorGeometry:req('exterior_geometry'),ExteriorModel:req('exterior_model'),WallAxisCuts:req('wall_axis_cuts'),WallTrim:req('wall_trim'),WallSteps:req('wall_steps'),WallFeatures:req('wall_features'),WallSolidGeometry:req('wall_solid_geometry'),BaseGeometry:req('base_geometry'),BaseSketchGeometry:req('base_sketch_geometry'),WallGeometry:req('wall_geometry'),WallChimneys:req('wall_chimneys'),WallClosedSoffits:req('wall_closed_soffits')};
// Compare behavior, not checkout line endings (function sources are serialized).
const lf=text=>text.replace(/\r\n/g,'\n'),current=lf(fs.readFileSync(SCRIPTS+'wall_face_draft.js','utf8'));

// Minimal three.js stand-in that keeps everything the editor sets.
function fakeThree(){
 class V2{constructor(x=0,y=0){this.x=x;this.y=y;}set(x,y){this.x=x;this.y=y;return this;}}
 class V3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}clone(){return new V3(this.x,this.y,this.z);}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z;}}
 class Color{constructor(c){const s=typeof c==='number'?c:parseInt(String(c).replace('#',''),16);this.hex=Number.isFinite(s)?s:String(c);this.r=((this.hex>>16)&255)/255;this.g=((this.hex>>8)&255)/255;this.b=(this.hex&255)/255;}getHex(){return this.hex;}}
 class Attr{constructor(array,itemSize){this.array=Array.from(array);this.itemSize=itemSize;this.count=this.array.length/itemSize;}getX(i){return this.array[i*this.itemSize];}getY(i){return this.array[i*this.itemSize+1];}getZ(i){return this.array[i*this.itemSize+2];}setX(i,v){this.array[i*this.itemSize]=v;return this;}setXYZ(i,x,y,z){const k=i*this.itemSize;this.array[k]=x;this.array[k+1]=y;this.array[k+2]=z;return this;}}
 class BufferGeometry{constructor(){this.attributes={};this.index=null;}setFromPoints(ps){this.attributes.position=new Attr(ps.flatMap(p=>[p.x,p.y,p.z===undefined?0:p.z]),3);return this;}setIndex(i){this.index=i==null?null:Array.from(i);return this;}setAttribute(n,a){this.attributes[n]=a;return this;}getAttribute(n){return this.attributes[n];}computeVertexNormals(){this.normals=true;}dispose(){this.disposed=(this.disposed||0)+1;}}
 const defaults={opacity:1,transparent:false,depthTest:true,depthWrite:true,visible:true,side:0,size:1,sizeAttenuation:true,linewidth:1,polygonOffset:false,polygonOffsetFactor:0,polygonOffsetUnits:0,vertexColors:false};
 class Material{constructor(type,params={}){Object.assign(this,defaults,{type},params);this.color=new Color(params.color===undefined?0xffffff:params.color);this.userData={};}dispose(){this.disposed=(this.disposed||0)+1;}}
 const material=type=>class extends Material{constructor(p){super(type,p);}};
 class Object3D{constructor(){this.children=[];this.parent=null;this.userData={};this.renderOrder=0;this.visible=true;this.position=new V3();this.scale=new V3(1,1,1);this.rotation=new V3();}add(...os){for(const o of os){if(o.parent)o.parent.remove(o);o.parent=this;this.children.push(o);}return this;}remove(o){const i=this.children.indexOf(o);if(i>=0){this.children.splice(i,1);o.parent=null;}return this;}traverse(fn){fn(this);for(const c of this.children.slice())c.traverse(fn);}updateMatrixWorld(){}}
 class Group extends Object3D{}
 class Mesh extends Object3D{constructor(g,m){super();this.geometry=g;this.material=m;this.isMesh=true;}}
 class Line extends Object3D{constructor(g,m){super();this.geometry=g;this.material=m;this.isLine=true;}computeLineDistances(){this.lineDistances=true;return this;}}
 class LineSegments extends Line{constructor(g,m){super(g,m);this.isLineSegments=true;}}
 class Points extends Object3D{constructor(g,m){super();this.geometry=g;this.material=m;this.isPoints=true;}}
 return {Vector2:V2,Vector3:V3,Color,Float32BufferAttribute:Attr,BufferGeometry,Object3D,Group,Mesh,Line,LineSegments,Points,DoubleSide:2,MeshBasicMaterial:material('MeshBasicMaterial'),LineBasicMaterial:material('LineBasicMaterial'),LineDashedMaterial:material('LineDashedMaterial'),PointsMaterial:material('PointsMaterial'),ShapeUtils:{triangulateShape:c=>c.slice(2).map((_,i)=>[0,i+1,i+2])}};
}
// One editor over a private copy of a saved house, drawn the way wall mode
// draws it: inside the visibility snapshots, with persistent render parts.
function instance(source,house,{memo=true}={}){
 let state=structuredClone(house.state);const ctx={console,performance,...M,THREE:fakeThree(),EXTERIOR_DISABLE_DRAW_MEMO:!memo,addEventListener(){},requestAnimationFrame:()=>0,cancelAnimationFrame(){}};
 ctx.window=ctx;vm.createContext(ctx);
 for(const name of ['wall_editor','exterior_scene_cache'])vm.runInContext(fs.readFileSync(SCRIPTS+name+'.js','utf8'),ctx);
 vm.runInContext(source,ctx);
 const parts=new ctx.ExteriorSceneCache();ctx.WallMode={renderChunk:(key,input,parent,build)=>parts.pending?parts.part(key,input,parent,build):build(parent)};
 // Like wall mode, walls are composed again only when the state's value changes.
 let walls=[],wallsKey=null;const composed=()=>{const key=JSON.stringify(state);if(key!==wallsKey){wallsKey=key;walls=M.WallChimneys.compose(structuredClone(house.walls),state);}return walls;};
 const editor=ctx.createWallFaceDraft({state:()=>state,walls:composed,active:()=>true,selected:()=>null,select(){},toPixel:p=>({x:p.x*10+3,y:7-p.y*10,z:p.z}),screen:p=>({x:p.x*100,y:p.z*100}),projectPoint:()=>({x:0,y:0,z:0}),roofVisible:()=>true,wallsVisible:()=>true,commit(){},redraw(){},message(){}});
 const ids=new WeakMap();let next=0;const id=o=>{if(!ids.has(o))ids.set(o,++next);return ids.get(o);};
 const plain=v=>JSON.stringify(v,(k,x)=>typeof x==='function'?'fn:'+String(x).length:x instanceof ctx.THREE.Color?x.getHex():x);
 const describe=o=>({t:o.constructor.name,id:id(o),ro:o.renderOrder,vis:o.visible,ud:plain(o.userData),at:[o.position,o.scale,o.rotation].map(v=>[v.x,v.y,v.z]),ld:o.lineDistances,obr:o.onBeforeRender?String(o.onBeforeRender).length:null,rc:Object.prototype.hasOwnProperty.call(o,'raycast')?String(o.raycast):null,
  geo:o.geometry&&{id:id(o.geometry),index:o.geometry.index,normals:o.geometry.normals,attrs:Object.entries(o.geometry.attributes).map(([k,a])=>[k,a.itemSize,a.array])},
  mat:o.material&&{id:id(o.material),props:plain(o.material)}});
 const frame=()=>{
  const out={};composed();
  M.WallClosedSoffits.withSnapshot(state,()=>M.WallChimneys.withVisibilitySnapshot(state,()=>{
   const calls=[];try{editor.draw2D({},(type,attrs)=>calls.push([type,Object.entries(attrs).map(([k,v])=>[k,v===undefined?'(undefined)':v])]),.5);out.svg=calls;}catch(e){out.svg='error: '+e.message;}
   const group=new ctx.THREE.Group();parts.begin('view');try{editor.draw3D(group,p=>new ctx.THREE.Vector3(p.x,p.z,-p.y));out.reuse=parts.commit();const rows=[];group.traverse(o=>rows.push(describe(o)));out.scene=rows;}catch(e){parts.rollback();out.scene='error: '+e.message;}
  }));
  out.state=JSON.stringify(state);return JSON.stringify(out);
 };
 return {get state(){return state;},replaceState(next){state=next;},editor,frame};
}
// The same input script for every editor: frames are compared step by step.
function script(e){
 const steps=[],snap=label=>steps.push([label,e.frame()]),s=e.state,edits=s.wallEdits||{},surfaces=edits.$surfaces||[],drafts=Object.entries(edits.$drafts||{});
 snap('first frame');snap('unchanged frame');
 const solid=surfaces.find(f=>!f.deleted&&!f.drafted),usable=([,d])=>d.faces?.length&&d.sketch?.nodes?.length,boundary=([,d])=>d.sketch.nodes.some(n=>n.generatedBoundary);
 const draft=drafts.find(x=>usable(x)&&boundary(x))||drafts.find(usable),other=drafts.find(x=>x!==draft&&usable(x));
 if(solid){e.editor.restoreSelection({selectedSolid:solid.id,faceSelection:[{solid:solid.id}]});snap('solid selected');e.editor.restoreSelection({solidPoints:solid.points.slice(0,2).map(p=>M.WallSolidGeometry.vertexKey(p)),solidEdges:[M.WallSolidGeometry.edgeKey(solid.points[0],solid.points[1])]});snap('solid points');}
 if(draft){const [key,d]=draft,face=d.faces.find(f=>!f.solidId)||d.faces[0],ids=[...d.sketch.nodes.filter(n=>n.generatedBoundary),...d.sketch.nodes].map(n=>n.id);
  e.editor.restoreSelection({selectedRegion:{draft:key,face:face.id},faceSelection:[{draft:key,face:face.id}],activeDraftKey:key});snap('region selected');
  // A generated point mid-edge is shown only while picked: shown nodes follow the picks.
  const [a,b]=face.points;d.sketch.nodes.push({id:'probe',x:(a.x+b.x)/2,y:(a.y+b.y)/2,generatedBoundary:true});snap('probe point added');
  e.editor.restoreSelection({activeDraftKey:key,picked:['probe',...ids.slice(0,2)]});snap('nodes picked');
  e.editor.restoreSelection({activeDraftKey:key,picked:ids.slice(3,6)});snap('other nodes picked');
  e.editor.restoreSelection({activeDraftKey:key,picked:['probe']});snap('probe picked again');
  e.editor.restoreSelection({draftSelection:{[key]:ids.slice(1,4),...(other?{[other[0]]:other[1].sketch.nodes.slice(0,2).map(n=>n.id)}:{})}});snap('draft selection');
  e.editor.restoreSelection({activeDraftKey:key,picked:ids.slice(0,3),pickedLines:(d.sketch.edges||[]).slice(0,3).map(edge=>edge.id)});snap('lines picked');}
 e.editor.restoreSelection({});snap('selection cleared');
 // Preview-style edits mutate objects in place, then restore their values.
 if(solid){const p=solid.points[0],x=p.x;p.x+=.013;snap('surface moved');snap('surface moved, unchanged frame');p.x=x;snap('surface restored');}
 if(draft){const n=draft[1].sketch.nodes.find(n=>!n.fixed)||draft[1].sketch.nodes[0],y=n.y;n.y+=.011;snap('node moved');n.y=y;snap('node restored');}
 // Undo replaces the edits with equal values, then with different ones.
 const saved=JSON.stringify(s.wallEdits||null);s.wallEdits=JSON.parse(saved)||undefined;snap('replaced with equal values');
 if(s.wallEdits?.$surfaces?.length>1){s.wallEdits.$surfaces.pop();snap('surface removed');s.wallEdits=JSON.parse(saved);snap('undo');}
 s.lineCenters=false;s.wallCenters=false;snap('markers off');delete s.lineCenters;delete s.wallCenters;snap('markers on');
 // A new state object with the same value is not composed again (no chimney scene).
 e.replaceState({...e.state});snap('state object replaced');e.replaceState(structuredClone(e.state));snap('state cloned');
 return steps;
}
function houses(){
 const list=[],add=(name,raw)=>{const state=raw.exteriorsWalls||raw,walls=state.alignedWalls||state.cleanedWalls||state.mergedWalls||raw.walls||[];if(state.wallEdits||walls.length)list.push({name,state,walls});};
 for(const name of ['exterior-base-binding','exterior-engine-reloaded','exterior-engine-saved','exterior-phantom-line','local-resoffit-three-foot','saved-wall-contact-drafts','connected-move-editor','merged-chimney-roof-contact','remote-indent-chimney','saved_extrusion','move-gap-snap','merged-wall-extrusion-wire','basement-door-trim-selection'])add(name,JSON.parse(fs.readFileSync('dev/fixtures/'+name+'.json','utf8')));
 // Closed soffit panels (presentation splits siding) and a divided window
 // (division seams dash the shared wire); no saved fixture has both.
 const C=M.WallClosedSoffits,F=M.WallFeatures,ft=F.FT,p=(x,y,z)=>({x,y,z}),w={id:'wall',bottom:[p(1,1,0),p(9,1,0)],top:[p(1,1,4.5),p(9,1,4.5)]};
 const state={closedSoffits:true,sources:[{id:'edge',kind:'perimeter',type:'eave',setback:1,a:p(0,1,4.5),b:p(10,1,4.5),originalA:p(0,0,4),originalB:p(10,0,4)}],wallEdits:{}};
 const rect=(x,z,width,height)=>[p(x,1,z),p(x+width,1,z),p(x+width,1,z+height),p(x,1,z+height)],opening={id:'opening',points:rect(2,1,4*ft,6*ft),holes:[],feature:{type:'window',preset:2,axis:{x:1,y:0,z:0}},material:'siding'};
 state.wallEdits.$surfaces=[...C.build(state,[w]),{id:'host',material:'siding',points:[...w.bottom,w.top[1],w.top[0]],holes:[]},...F.divideSticker([opening],'vertical',2*ft).faces.map((f,i)=>({...f,id:'opening-'+i}))];
 list.push({name:'closed soffit and divided window',state,walls:[w]});
 const dir=process.env.FM_DRAW_MODELS||'output/full-house-speed-20261019/models';
 if(fs.existsSync(dir))for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort())add('model '+file,JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')));
 return list;
}
function compare(a,b,name){
 const x=script(a),y=script(b);assert.equal(x.length,y.length,name);
 for(let i=0;i<x.length;i++){assert.equal(x[i][0],y[i][0]);if(x[i][1]!==y[i][1]){const p=JSON.parse(x[i][1]),q=JSON.parse(y[i][1]),part=['svg','scene','reuse','state'].find(k=>JSON.stringify(p[k])!==JSON.stringify(q[k]));assert.fail(name+': "'+x[i][0]+'" differs in '+part);}}
 return x.length;
}
test('draw memos reproduce the unmemoized draw output, frame by frame, on saved houses',()=>{
 let frames=0;for(const house of houses())frames+=compare(instance(current,house),instance(current,house,{memo:false}),house.name);
 assert.ok(frames>100,'too few frames compared: '+frames);
});
test('optimized drawing reproduces the pre-optimization editor output on saved houses',t=>{
 let reference;try{reference=lf(execFileSync('git',['show',REFERENCE+':'+SCRIPTS+'wall_face_draft.js'],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','ignore']}));}catch(e){t.skip('reference commit '+REFERENCE+' is not available');return;}
 let frames=0;for(const house of houses())frames+=compare(instance(current,house),instance(reference,house),house.name);
 assert.ok(frames>100,'too few frames compared: '+frames);
});
test('chimney clipping shared through a render generation is never mutated by its readers',()=>{
 // Freeze every clipped part the editor receives; a reader that writes to one throws.
 const visibleParts=M.WallChimneys.visibleParts,freeze=(parts,face)=>{for(const part of parts)if(part!==face){for(const ring of [part.points,...(part.holes||[])]){for(const p of ring)Object.freeze(p);Object.freeze(ring);}Object.freeze(part.holes);Object.freeze(part);}return Object.freeze(parts);};
 let clipped=0;
 for(const house of houses().filter(h=>h.state.chimneys?.items?.length)){
  let frozen;M.WallChimneys.visibleParts=(face,state)=>freeze(visibleParts(face,state),face);
  try{frozen=script(instance(current,house));}finally{M.WallChimneys.visibleParts=visibleParts;}
  const plain=script(instance(current,house));
  for(let i=0;i<plain.length;i++)assert.equal(frozen[i][1],plain[i][1],house.name+': "'+plain[i][0]+'" changed when clipped parts were frozen');
  clipped++;
 }
 assert.ok(clipped>0);
});
