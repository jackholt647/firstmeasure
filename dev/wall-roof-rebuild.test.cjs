// Smart rebuild: a roof change after wall work keeps the wall work (docs/architecture/exterior-roof-rebuild.md).
// Scenarios run the real wall mode, generator and draft follow on the user's house (ce52, which the dev pilot copies).
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const dir=path.join(__dirname,'../public/measure/internal/editor_scripts/'),req=name=>require(dir+name);
const G=req('wall_geometry.js'),R=req('wall_roof_rebuild.js'),T=req('roof_trim.js'),fixture=require('./fixtures/ce52-roof-rebuild.json');
const copy=v=>JSON.parse(JSON.stringify(v));
// Roof lines of the house, by index: the chimney cricket's two short lines drawn as rakes, the
// side-wall flashing under the upper eave R3, and the dormer's front head wall.
const CRICKET=[96,97],UNDER_EAVE=25,EAVE_ABOVE=2,DORMER_FRONT=51;

function house(){
 const W=copy(fixture.walls),C=W.context,elements=new Map(),listeners={},storage=new Map(),timers=new Map();let timerId=0,host=null;
 const el=(id='')=>({id,hidden:false,disabled:false,value:'',textContent:'',dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},attributes:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]??null;},removeAttribute(k){delete this.attributes[k];},addEventListener(){},
  prepend(...c){c.forEach(x=>this.appendChild(x));},append(...c){c.forEach(x=>this.appendChild(x));},querySelector(){return null;},appendChild(child){if(child.id)elements.set(child.id,child);},remove(){elements.delete(this.id);},querySelectorAll(){return [];}});
 const document={readyState:'loading',head:el(),body:el(),createElement:()=>el(),addEventListener:(name,fn)=>listeners[name]=fn,querySelectorAll:()=>[],getElementById(id){if(id==='geoSvg'||id==='measurement-panel')return elements.get(id)||null;if(!elements.has(id))elements.set(id,el(id));return elements.get(id);}};
 const points=fixture.pixels.points.map(p=>({...p})),connections=fixture.pixels.connections.map(c=>({start:points[c.startIdx],end:points[c.endIdx],type:c.type}));
 // Faces share the roof's point objects, as the face resolver's faces do: moving a point moves its faces.
 const toPixel=p=>({x:p.x/C.mpp+C.width/2,y:p.y/C.mpp+C.height/2,z:p.z}),shared=p=>{const q=toPixel(p);return points.find(r=>Math.hypot(r.x-q.x,r.y-q.y)<1e-6&&Math.abs(r.z-q.z)<1e-9)||q;};
 const manualFaces=W.roof.faces.map(f=>({points:f.points.map(shared),holes:(f.holes||[]).map(r=>r.map(shared))}));
 const ctx={console,performance,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){},document,location:{origin:'http://rebuild-test'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  activeGeometry:{points,connections,manualFaces},imageWidth:C.width,imageHeight:C.height,mapCenterLat:C.lat,mapCenterLng:C.lng,dsmMin:0,viewRotation:0,currentZoom:1,selectedPoints:new Set(),selectedLines:new Set(),tempPoint:null,layerData:{},isMeasurementMode:false,
  addEventListener:(name,fn)=>listeners['window:'+name]=fn,currentProjectId:'ce52',getMetersPerPx:()=>C.mpp,confirm:()=>{throw Error('A smart rebuild never asks to discard work.');},
  ExteriorGeometry:req('exterior_geometry.js'),ExteriorModel:req('exterior_model.js'),WallGeometry:G,WallChimneyCleanup:req('wall_chimney_cleanup.js'),WallRakeCleanup:req('wall_rake_cleanup.js'),WallChimneys:req('wall_chimneys.js'),WallGaps:req('wall_gaps.js'),GroundGeometry:req('ground_geometry.js'),
  BaseGeometry:req('base_geometry.js'),BaseSketchGeometry:req('base_sketch_geometry.js'),WallSolidGeometry:req('wall_solid_geometry.js'),WallBaseBinding:req('wall_base_binding.js'),WallParapets:req('wall_parapets.js'),WallClosedSoffits:req('wall_closed_soffits.js'),RoofTrim:T,WallRoofRebuild:R,EditorHistory:req('editor_history.js'),
  WallAxisCuts:req('wall_axis_cuts.js'),WallTrim:req('wall_trim.js'),WallSteps:req('wall_steps.js'),WallFeatures:{...req('wall_features.js'),mountUI(){},closeUI(){}},getVector3:p=>({...p,distanceTo:q=>Math.hypot(p.x-(q.x||0),p.y-(q.y||0),p.z-(q.z||0))}),camera:{position:{x:0,y:-10,z:2}},requestAnimationFrame:()=>0,cancelAnimationFrame(){}};
 ctx.window=ctx;vm.createContext(ctx);
 // The real draft follow (reflow) behind a wall editor that draws nothing.
 vm.runInContext(fs.readFileSync(dir+'wall_face_draft.js','utf8'),ctx);
 const draft=ctx.createWallFaceDraft({state:()=>host?.state(),walls:()=>[],active:()=>false,selected:()=>null,select(){},screen:()=>({x:0,y:0}),toPixel:p=>p,message(){},redraw(){},commit(){},hit:()=>null,roof:()=>null});
 ctx.createWallEditor=h=>{host=h;return {leave(){},clear(){},apply:w=>w,draw2D(){},draw3D(){},hasDraft:()=>false,busy:()=>false,reflowDrafts:(b,c,e)=>draft.reflow(b,c,e)};};
 vm.runInContext(fs.readFileSync(dir+'ground_editor.js','utf8'),ctx);vm.runInContext(fs.readFileSync(dir+'wall_mode.js','utf8'),ctx);
 listeners.DOMContentLoaded();ctx.WallMode.restore('ce52',{exteriorsWalls:W});
 // Entering wall mode records the roof the stored walls were built from; nothing changes.
 ctx.WallMode.setEnabled(true);
 const toWalls=()=>ctx.WallMode.setEnabled(true),toRoof=()=>ctx.WallMode.setEnabled(false),key=k=>listeners['window:keydown']({key:k,ctrlKey:true,target:{closest:()=>false},preventDefault(){},stopImmediatePropagation(){}});
 // Move roof points (plan metres; height from the given roof plane, as a drag on the roof does).
 const movePoints=(ids,dx,dy,plane=null)=>{for(const i of ids){const p=points[i];p.x+=dx/C.mpp;p.y+=dy/C.mpp;if(plane){const m={x:(p.x-C.width/2)*C.mpp,y:(p.y-C.height/2)*C.mpp};p.z=plane.dx*m.x+plane.dy*m.y+plane.k;}}};
 return {ctx,W,points,connections,manualFaces,elements,toWalls,toRoof,key,movePoints,state:()=>host.state(),saved:()=>ctx.WallMode.serialize(),note:()=>elements.get('base-status')?.textContent||''};
}
// A window, door or sticker drawn on a drafted wall, as Plane mode stores it.
let featureId=0;
function addFeature(edits,key,type,{width=.6,height=.9,sill=.4,at=null}={}){
 const d=edits.$drafts[key],region=d.faces.find(f=>!f.opening&&!f.feature&&!f.solidId&&f.points.length>=3)||d.faces[0],xs=region.points.map(p=>p.x),ys=region.points.map(p=>p.y);
 const cx=at?at.x:(Math.min(...xs)+Math.max(...xs))/2,y0=at?at.y-height/2:Math.min(...ys)+Math.min(sill,(Math.max(...ys)-Math.min(...ys))*.15),h=at?height:Math.min(height,(Math.max(...ys)-y0)*.6),w=at?width:Math.min(width,(Math.max(...xs)-Math.min(...xs))*.5),n=++featureId;
 const ids=[0,1,2,3].map(i=>'rb'+n+'-'+i),corners=[[cx-w/2,y0],[cx+w/2,y0],[cx+w/2,y0+h],[cx-w/2,y0+h]];
 d.sketch.nodes.push(...corners.map(([x,y],i)=>({x,y,z:0,id:ids[i]})));d.sketch.edges.push(...ids.map((a,i)=>({id:'rbe'+n+'-'+i,a,b:ids[(i+1)%4],fixed:false,userConnection:true})));
 const face={id:'rb-'+type+'-'+n,points:corners.map(([x,y],i)=>({x,y,z:0,nodeId:ids[i]})),opening:true,holes:[],feature:{type,preset:0,shape:'rectangle',axis:{x:d.u.x,y:d.u.y,z:0}}};d.faces.push(face);
 return {key,id:face.id,world:()=>{const p=face.points[0];return {x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};}};
}
const draftOf=(edits,wallId)=>Object.keys(edits.$drafts).find(k=>!edits.$drafts[k].frame&&edits.$drafts[k].members.includes(wallId));
// Wherever the sticker is now: a face that split keeps it in the part it sits on.
const featureWorld=(edits,key,id)=>{const d=Object.values(edits.$drafts).find(d=>d.faces?.some(f=>f.id===id)),f=d?.faces.find(f=>f.id===id);if(!f)return null;const p=f.points[0];return {x:d.origin.x+d.u.x*p.x,y:d.origin.y+d.u.y*p.x,z:p.y};};
const ids=walls=>walls.map(w=>w.id).sort();
// Everything a change did not reach must come back exactly as it was.
function assertUntouched(before,after,report){
 const touched=new Set([...report.movedWalls,...report.removedWalls]);
 for(const [key,d] of Object.entries(before.wallEdits.$drafts)){if(d.frame||d.members.some(id=>touched.has(id)))continue;assert.deepEqual(after.wallEdits.$drafts[key],d,'untouched draft '+key);}
 const afterWalls=new Map(after.alignedWalls.map(w=>[w.id,w]));for(const w of before.alignedWalls)if(!touched.has(w.id))assert.deepEqual(afterWalls.get(w.id),w,'untouched wall '+w.id);
 // Surfaces change only when the report says they moved with a wall or went with one.
 const changed=before.wallEdits.$surfaces.filter(f=>!f.closedSoffit&&!f.parapet&&JSON.stringify(after.wallEdits.$surfaces.find(g=>g.id===f.id))!==JSON.stringify(f));
 assert.ok(changed.length<=report.surfaces.moved+report.surfaces.removed,'changed surfaces: '+changed.map(f=>f.id).join(', '));
 const features=s=>Object.values(s.wallEdits.$drafts).reduce((n,d)=>n+(d.faces||[]).filter(f=>f.feature&&!f.solidId).length,0)+s.wallEdits.$surfaces.filter(f=>f.feature).length;
 assert.equal(features(after),features(before)-(report.features||[]).length,'every sticker is kept or reported');
}


test('identify keeps line ids through a type change, a move, a deletion and an added line',()=>{
 const roof=fixture.walls.roof,next=copy(roof);
 next.connections[CRICKET[0]].type='valley';next.points[roof.connections[DORMER_FRONT].startIdx].x+=.2;next.connections.splice(10,1);next.connections.push({startIdx:0,endIdx:5,type:'eave'});
 const r=R.identify(roof,next),byId=new Map(r.roof.connections.map(c=>[c.id,c]));
 assert.equal(r.changed,true);assert.equal(r.counts.type,1);assert.equal(r.counts.removed,1);assert.equal(r.counts.added,1);assert.ok(r.counts.moved>=1);
 assert.equal(byId.get('R'+(CRICKET[0]+1)).type,'valley');assert.ok(!byId.has('R11'),'the deleted line keeps no id');assert.equal(byId.get('R149').type,'eave','a new line gets an id no earlier roof used');
 for(let i=11;i<roof.connections.length;i++)if(i!==CRICKET[0])assert.equal(byId.get('R'+(i+1)).type,roof.connections[i].type,'later lines keep their ids after a deletion');
 // Sources, and so generated walls, carry the kept ids.
 assert.ok(G.buildSources(r.roof,fixture.walls.options).sources.some(s=>s.id.startsWith('R'+(DORMER_FRONT+1))));
 assert.equal(R.identify(roof,copy(roof)).changed,false);
});

test('A: retyping the chimney cricket from rake to valley keeps every wall, draft, sticker, extrusion and trim setting',()=>{
 const h=house(),edits=h.state().wallEdits;
 const window1=addFeature(edits,draftOf(edits,'R52:1:roof-2'),'window'),door=addFeature(edits,draftOf(edits,'envelope-0-1-1'),'door',{width:.9,height:2,sill:0}),sticker=addFeature(edits,draftOf(edits,'R26:0:body-1'),'sticker',{width:.3,height:.3,sill:1});
 const trimEdges=T.perimeter(h.state().roof).slice(0,3).map(e=>e.id);h.state().roofTrim=T.setHeight(h.state().roofTrim,trimEdges,8);
 const before=copy(h.saved());assert.ok(before.wallEdits.$surfaces.some(f=>/-side-/.test(f.id)),'the house has extrusions');
 h.toRoof();for(const i of CRICKET){assert.equal(h.connections[i].type,'rake');h.connections[i].type='valley';}h.toWalls();
 const after=copy(h.saved()),report=h.ctx.WallMode.roofRebuild;
 assert.equal(report.lines.type,2);assert.deepEqual(report.walls,{moved:0,removed:0,added:0,kept:before.alignedWalls.length});
 assert.deepEqual(after.wallEdits,before.wallEdits,'drafts, stickers, extrusions and loose lines are untouched');
 assert.deepEqual(after.alignedWalls,before.alignedWalls);assert.deepEqual(after.roofTrim,before.roofTrim);
 assert.deepEqual(after.roof.connections.filter(c=>CRICKET.map(i=>'R'+(i+1)).includes(c.id)).map(c=>c.type),['valley','valley']);
 assert.ok(!after.sources.some(s=>/^R9[78]\./.test(s.id)),'the cricket lines drive nothing');
 // Roof trim is the roof's: it follows the line types; every other panel is unchanged.
 const lines=CRICKET.map(i=>{const c=h.W.roof.connections[i];return [h.W.roof.points[c.startIdx],h.W.roof.points[c.endIdx]];}),onCricket=p=>lines.some(([a,b])=>G.onEdge(p.a,a,b,.01)&&G.onEdge(p.b,a,b,.01));
 const panels=roof=>T.panels(roof,before.roofTrim).filter(p=>!onCricket(p)).map(p=>p.id);assert.deepEqual(panels(after.roof),panels(before.roof));assert.ok(!T.perimeter(after.roof).some(onCricket),'no trim runs along the valleys');
 assert.match(h.note(),/2 lines changed type\): no walls changed; everything else was kept/);
 for(const f of [window1,door,sticker])assert.ok(featureWorld(after.wallEdits,f.key,f.id));
});

test('B: moving the flashing under the upper eave moves its walls and their stickers; the rest is untouched; one undo step',()=>{
 const h=house(),edits=h.state().wallEdits,roof=h.W.roof,line=roof.connections[UNDER_EAVE],a=roof.points[line.startIdx],b=roof.points[line.endIdx];
 const len=Math.hypot(b.x-a.x,b.y-a.y),n={x:-(b.y-a.y)/len,y:(b.x-a.x)/len},eave=roof.connections[EAVE_ABOVE],mid={x:(roof.points[eave.startIdx].x+roof.points[eave.endIdx].x)/2,y:(roof.points[eave.startIdx].y+roof.points[eave.endIdx].y)/2},side=Math.sign((mid.x-a.x)*n.x+(mid.y-a.y)*n.y),out={x:n.x*side*.15,y:n.y*side*.15};
 // The face over this wall also draws the lower wall below the roof: one sticker on each part.
 const face=draftOf(edits,'R26:0:body-1'),d=edits.$drafts[face],upper=h.state().alignedWalls.find(w=>w.id==='R26:0:body-1'),lower=h.state().alignedWalls.find(w=>w.id==='envelope-0-8-1'),local=(w,s,t)=>{const lo={x:w.bottom[0].x+(w.bottom[1].x-w.bottom[0].x)*s,y:w.bottom[0].y+(w.bottom[1].y-w.bottom[0].y)*s,z:w.bottom[0].z+(w.bottom[1].z-w.bottom[0].z)*s},hi=w.top[0].z+(w.top[1].z-w.top[0].z)*s;return {x:(lo.x-d.origin.x)*d.u.x+(lo.y-d.origin.y)*d.u.y,y:lo.z+(hi-lo.z)*t};};
 const moving=addFeature(edits,face,'sticker',{width:.2,height:.2,at:local(upper,.85,.5)}),below=addFeature(edits,face,'window',{width:.5,height:.6,at:local(lower,.5,.4)}),still=addFeature(edits,draftOf(edits,'R52:1:roof-2'),'window');
 // An extrusion pushed 20 cm out of the upper wall: four sides on the wall and a cap off it.
 const onUpper=(s,t)=>{const lo={x:upper.bottom[0].x+(upper.bottom[1].x-upper.bottom[0].x)*s,y:upper.bottom[0].y+(upper.bottom[1].y-upper.bottom[0].y)*s,z:upper.bottom[0].z+(upper.bottom[1].z-upper.bottom[0].z)*s};return {...lo,z:lo.z+(upper.top[0].z+(upper.top[1].z-upper.top[0].z)*s-lo.z)*t};},ring=[onUpper(.55,.35),onUpper(.7,.35),onUpper(.7,.65),onUpper(.55,.65)],cap=ring.map(p=>({x:p.x-out.x/.15*.2,y:p.y-out.y/.15*.2,z:p.z}));
 const extrusion=[...ring.map((p,i)=>({id:'rb-extrusion-side-'+i,points:[p,ring[(i+1)%4],cap[(i+1)%4],cap[i]].map(q=>({...q})),holes:[]})),{id:'rb-extrusion-cap',points:cap.map(q=>({...q})),holes:[]}];edits.$surfaces.push(...extrusion);
 const before=copy(h.saved()),from=moving.world();
 h.toRoof();h.movePoints([line.startIdx,line.endIdx],out.x,out.y);h.toWalls();
 const after=copy(h.saved()),report=h.ctx.WallMode.roofRebuild;
 assert.ok(report.lines.moved>=1);assert.ok(report.movedWalls.includes('R26:0:body-1'),JSON.stringify(report));
 // The walls the flashing drives keep their ids and stand 15 cm further out.
 const old=before.alignedWalls.find(w=>w.id==='R26:0:body-1'),now=after.alignedWalls.find(w=>w.id==='R26:0:body-1');
 assert.ok(Math.abs((now.bottom[0].x-old.bottom[0].x)*n.x*side+(now.bottom[0].y-old.bottom[0].y)*n.y*side-.15)<.01);
 assert.deepEqual(ids(after.alignedWalls.filter(w=>!report.addedWalls.includes(w.id))),ids(before.alignedWalls.filter(w=>!report.removedWalls.includes(w.id))),'every other wall keeps its id');
 assertUntouched(before,after,report);
 assert.deepEqual(featureWorld(after.wallEdits,still.key,still.id),still.world(),'a sticker on an unaffected wall is untouched');
 assert.deepEqual(featureWorld(after.wallEdits,below.key,below.id),below.world(),'a window on the part of the face that held still stays put');
 assert.equal(report.drafts.split,1,'the face split where the roof moved part of it');
 for(const f of extrusion){const g=after.wallEdits.$surfaces.find(g=>g.id===f.id);assert.ok(g,f.id);g.points.forEach((q,i)=>assert.ok(Math.abs(q.x-f.points[i].x-out.x)<1e-6&&Math.abs(q.y-f.points[i].y-out.y)<1e-6&&q.z===f.points[i].z,'the extrusion moved with its wall: '+f.id));}
 assert.equal(report.surfaces.moved,extrusion.length);
 const to=featureWorld(after.wallEdits,moving.key,moving.id);
 if(to)assert.ok(Math.abs((to.x-from.x)*n.x*side+(to.y-from.y)*n.y*side-.15)<.01&&Math.abs(to.z-from.z)<1e-9,'the sticker moved with its wall');
 else assert.ok(report.features.includes('sticker'),'a sticker that could not follow is reported');
 assert.match(h.note(),/lines? moved\): \d+ walls? moved.*1 edited wall was split where the roof moved part of it/);assert.match(h.note(),/Undo restores/);
 // One undo step returns the walls, their edits and the roof they were built from; the next switch does not redo it.
 h.key('z');const undone=copy(h.saved());assert.deepEqual(undone.wallEdits,before.wallEdits);assert.deepEqual(undone.alignedWalls,before.alignedWalls);
 h.toRoof();h.toWalls();assert.deepEqual(copy(h.saved()).wallEdits,before.wallEdits,'undo is not reapplied by the next mode switch');
 h.key('y');assert.deepEqual(copy(h.saved()).alignedWalls,after.alignedWalls);
});

test('B2: turning the flashing about one end turns its walls and their faces with it',()=>{
 const h=house(),roof=h.W.roof,line=roof.connections[UNDER_EAVE],a=roof.points[line.startIdx],b=roof.points[line.endIdx],len=Math.hypot(b.x-a.x,b.y-a.y),n={x:-(b.y-a.y)/len,y:(b.x-a.x)/len};
 const before=copy(h.saved());h.toRoof();h.movePoints([line.endIdx],n.x*.25,n.y*.25);h.toWalls();
 const after=copy(h.saved()),report=h.ctx.WallMode.roofRebuild,moved=new Set(report.movedWalls);
 assert.ok(moved.has('R26:0:body-1')&&moved.has('R26:0:body-2:roof-2'));
 // Each face that follows its walls lies in their new plane.
 let followed=0;for(const d of Object.values(after.wallEdits.$drafts)){if(d.frame||!d.members.some(id=>moved.has(id)))continue;followed++;
  for(const w of d.members.map(id=>after.alignedWalls.find(w=>w.id===id)).filter(Boolean))for(const p of [...w.bottom,...w.top])assert.ok(Math.abs((p.x-d.origin.x)*-d.u.y+(p.y-d.origin.y)*d.u.x)<.001,'face in its wall plane');}
 assert.ok(followed>0);assertUntouched(before,after,report);
});

test('C: deleting the line that drives a wall removes that wall and reports its sticker; the rest is kept',()=>{
 const h=house(),edits=h.state().wallEdits,lost=addFeature(edits,draftOf(edits,'R52:1:roof-2'),'window'),kept=addFeature(edits,draftOf(edits,'envelope-0-1-1'),'door',{width:.9,height:2,sill:0});
 const before=copy(h.saved());
 h.toRoof();h.connections.splice(DORMER_FRONT,1);h.toWalls();
 const after=copy(h.saved()),report=h.ctx.WallMode.roofRebuild;
 assert.equal(report.lines.removed,1);assert.ok(report.removedWalls.includes('R52:1:roof-2'));assert.ok(!after.alignedWalls.some(w=>w.id==='R52:1:roof-2'));
 assert.equal(featureWorld(after.wallEdits,lost.key,lost.id),null);assert.ok(report.features.includes('window'));
 assert.deepEqual(featureWorld(after.wallEdits,kept.key,kept.id),kept.world());
 assertUntouched(before,after,report);
 assert.ok(report.addedWalls.every(id=>/^R\d+\./.test(id)),'walls the deletion exposes come from roof lines');
 assert.match(h.note(),/1 line removed\).*1 wall removed.*removed with its roof line.*Removed with them: 1 window/);
});

test('D: adding a roof facet (a raised bump-out on the main roof) adds walls only under it and keeps every existing wall and edit',()=>{
 const h=house(),C=h.W.context,K=req('exterior_geometry.js'),face=h.W.roof.faces.slice().sort((a,b)=>K.area(b)-K.area(a))[0],plane=G.plane(face.points),c=face.points.reduce((s,p)=>({x:s.x+p.x/face.points.length,y:s.y+p.y/face.points.length}),{x:0,y:0});
 const l=Math.hypot(plane.dx,plane.dy),down={x:-plane.dx/l,y:-plane.dy/l},across={x:-down.y,y:down.x},on=(u,v)=>{const x=c.x+across.x*u+down.x*v,y=c.y+across.y*u+down.y*v;return {x,y,z:plane.dx*x+plane.dy*y+plane.k};};
 const foot=[on(-.8,.6),on(.8,.6),on(.8,-.6),on(-.8,-.6)],top=Math.max(...foot.map(p=>p.z))+1,roof=[top,top,top+.15,top+.15].map((z,i)=>({...foot[i],z}));assert.ok(foot.every(p=>G.contains(face,p)));
 const before=copy(h.saved());
 h.toRoof();
 const pixel=p=>{const q={x:p.x/C.mpp+C.width/2,y:p.y/C.mpp+C.height/2,z:p.z};h.points.push(q);return q;},f=foot.map(pixel),r=roof.map(pixel),line=(a,b,type)=>h.connections.push({start:a,end:b,type});
 line(f[0],f[1],'head_wall');line(f[1],f[2],'side_wall');line(f[2],f[3],'head_wall');line(f[3],f[0],'side_wall');line(r[0],r[1],'eave');line(r[1],r[2],'rake');line(r[2],r[3],'eave');line(r[3],r[0],'rake');h.manualFaces.push({points:r,holes:[]});
 h.toWalls();
 const after=copy(h.saved()),report=h.ctx.WallMode.roofRebuild,fresh=new Set(['R149','R150','R151','R152','R153','R154','R155','R156']);
 assert.equal(report.lines.added,8);assert.equal(report.faces.added,1);assert.equal(report.walls.moved,0);assert.equal(report.walls.removed,0);assert.ok(report.walls.added>=4,JSON.stringify(report.walls));
 assert.ok(report.addedWalls.every(id=>fresh.has(id.split(/[.:]/)[0])),report.addedWalls.join());
 assert.deepEqual(after.wallEdits.$drafts,before.wallEdits.$drafts);assert.deepEqual(after.alignedWalls.filter(w=>!report.addedWalls.includes(w.id)),before.alignedWalls);
 assert.match(h.note(),/8 lines added\): \d+ new walls; everything else was kept/);
});

test('FM-312: a roof edit that leaves a merged wall a micron off its neighbour still opens wall mode, saves and reloads',()=>{
 // Two roof corners dragged in roof mode, as in the training project: one merged
 // wall outline came out twisted below the polygon grid. Wall mode went black and
 // every reload stopped with "Load Error: The face does not define a valid planar region."
 const h=house(),warn=console.warn;console.warn=()=>{};
 try{
  h.toRoof();h.movePoints([104],-0.7032000327796861,1.1270847774117665);h.movePoints([92],-1.7749465434945915,3.203106422243907);
  h.toWalls();assert.ok(h.ctx.WallMode.roofRebuild?.walls,'the walls followed the roof');
  const saved=copy(h.saved());assert.ok(saved.geometry.faces.length>0);
  for(const f of saved.geometry.faces)assert.ok(f.triangles.length,'every wall face is filled');
  // Newer than the reloading page's own local backup of the fixture.
  const reload=house();reload.ctx.WallMode.restore('ce52',{exteriorsWalls:{...saved,savedAt:Date.now()+1e6}});
  assert.deepEqual(copy(reload.saved()).alignedWalls,saved.alignedWalls,'the saved walls load again');
 }finally{console.warn=warn;}
});

test('FM-312: walls a roof edit cannot draw are never kept: the earlier walls stay, saved and undoable',()=>{
 const h=house(),roof=h.W.roof,line=roof.connections[UNDER_EAVE],before=copy(h.saved()),old=JSON.stringify(before.alignedWalls.find(w=>w.id==='R26:0:body-1').bottom);
 const topology=G.topology,warn=console.warn;let refused=0;
 // The wall the roof edit moves cannot be drawn where it moved to.
 G.topology=walls=>{const moved=walls.find(w=>w.id==='R26:0:body-1');if(moved&&JSON.stringify(moved.bottom)!==old){refused++;throw Error('The face does not define a valid planar region.');}return topology(walls);};
 h.ctx.confirm=()=>false;console.warn=()=>{};
 try{
  h.toRoof();h.movePoints([line.startIdx,line.endIdx],.15,0);h.toWalls();
  assert.ok(refused>0,'the moved walls were tried');
  const after=copy(h.saved());
  assert.deepEqual(after.alignedWalls,before.alignedWalls,'the earlier walls are kept');assert.deepEqual(after.wallEdits,before.wallEdits);
  assert.ok(after.keptRoofSignature,'Rebuild from roof is still offered');
  h.key('z');assert.deepEqual(copy(h.saved()).alignedWalls,before.alignedWalls,'no half-applied undo step was recorded');
 }finally{G.topology=topology;console.warn=warn;}
});

test('patch applies only the roof change to walls as they are now, and a neighbouring id pairs with its line',()=>{
 const w=(id,x0,x1,y=0,top=3,src='R1')=>({id,sourceId:src+'.0',kind:'perimeter',bottom:[{x:x0,y,z:0},{x:x1,y,z:0}],top:[{x:x0,y,z:top},{x:x1,y,z:top}]});
 const A=[w('R1.0:0',0,4),w('R2.0:0',4,8,0,3,'R2'),w('R3.0:1',8,9,0,3,'R3')],B=[w('R1.0:0',0,4,.2),w('R2.0:0',4,8,0,3,'R2'),w('R3.0:0',8,9.5,0,3,'R3')];
 const current=[{...w('R1.0:0',0,4),top:[{x:0,y:0,z:2.9},{x:4,y:0,z:3}]},A[1],A[2],w('R9.0:0',20,22,0,3,'R9')];
 const r=R.patchWalls(current,A,B);
 assert.equal(r.walls[0].top[0].z,2.9,'an edit-time height survives');assert.equal(r.walls[0].bottom[0].y,.2,'the roof move is applied');
 assert.equal(r.walls[1],current[1],'an unchanged wall is the same object');assert.equal(r.walls[3],current[3],'a wall the generator no longer knows is kept');
 assert.deepEqual(r.moved.map(m=>m.after.id).sort(),['R1.0:0','R3.0:1']);assert.equal(r.walls[2].bottom[1].x,9.5);assert.equal(r.removed.length,0);assert.equal(r.added.length,0);
});
