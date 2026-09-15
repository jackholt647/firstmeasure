const test=require('node:test'),assert=require('node:assert/strict'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const p=(x,y,z)=>({x,y,z}),a=p(0,0,0),b=p(4,0,0),c=p(4,4,0),d=p(0,4,0),e=p(0,0,4),f=p(4,0,4),g=p(4,4,4),h=p(0,4,4);
const cube=()=>[[a,b,f,e],[b,c,g,f],[c,d,h,g],[d,a,e,h],[a,d,c,b],[e,f,g,h]].map((points,i)=>({id:'f'+i,points,material:'brick'}));
function closed(faces){faces=faces.map(f=>f.curvedSurface?.logical?K.surfaceOutline(f):f);for(const f of faces){K.validateFace(f);for(const r of [f.points,...(f.holes||[])])for(let i=0;i<r.length;i++){const coverage=W.sharedIntervals(r[i],r[(i+1)%r.length],faces.filter(g=>g!==f)).reduce((s,[a,b])=>s+b-a,0);assert.ok(coverage>.9999||(1-coverage)*Math.hypot(r[i].x-r[(i+1)%r.length].x,r[i].y-r[(i+1)%r.length].y,r[i].z-r[(i+1)%r.length].z)<=K.CONTACT,'Open seam on '+f.id+': '+JSON.stringify([r[i],r[(i+1)%r.length]])+' '+coverage);}}}
test('edge chamfer starts symmetric, preserves the house, and makes one joined bevel',()=>{const scene=cube(),before=JSON.stringify(scene),r=W.chamfer(scene,{edges:[[a,e]]},.2);assert.equal(JSON.stringify(scene),before);assert.equal(r.faces.length,7);assert.deepEqual(r.metrics[0].angles,[45,45]);assert.ok(Math.abs(r.metrics[0].distances[0]-.2*Math.SQRT2)<1e-8);closed(r.faces);});
test('asymmetric edge chamfer supports 75/15 degree cuts',()=>{const r=W.chamfer(cube(),{edges:[[a,e]]},.2,30);assert.deepEqual(r.metrics[0].angles,[75,15]);assert.ok(r.metrics[0].distances[1]>r.metrics[0].distances[0]);closed(r.faces);});
test('two adjoining selected edges join without an overlap or gap',()=>{for(const angle of [0,15,-15])closed(W.chamfer(cube(),{edges:[[a,e],[a,b]]},.2,angle).faces);});
test('three adjoining edges close with a triangular corner face',()=>{const r=W.chamfer(cube(),{edges:[[a,e],[a,b],[a,d]]},.2);assert.ok(r.faces.some(f=>f.chamferCorner&&f.points.length===3));closed(r.faces);});
test('a point chamfer cuts all three axes and rotation changes tilted cuts independently of depth',()=>{const scene=cube(),r=W.chamfer(scene,{points:[a]},.2),t=W.chamfer(scene,{points:[a]},.2,10,0),u=W.chamfer(scene,{points:[a]},.2,10,90);assert.equal(r.faces.filter(f=>f.chamfer).length,1);assert.equal(r.faces.find(f=>f.chamfer).points.length,3);assert.notDeepEqual(t.metrics[0].distances,u.metrics[0].distances);for(const result of [r,t,u])closed(result.faces);});
test('multiple separate corners are cut together',()=>{closed(W.chamfer(cube(),{points:[a,g]},.2,5,35).faces);});
test('drawn lines on a face can form a bevel without requiring two face records',()=>{const scene=cube(),before=JSON.stringify(scene),r=W.chamfer(scene,{edges:[[p(0,0,1),p(4,0,1)]]},.2);assert.ok(r.additions.length);assert.ok(r.amount>0);assert.equal(JSON.stringify(scene),before);});
test('bevel endpoints meet sloping top and foundation faces instead of leaving square caps',()=>{const scene=cube().map(f=>({...f,points:f.points.map(p=>({...p,z:p.z===4?4+p.x*.2+p.y*.3:p.z}))})),r=W.chamfer(scene,{edges:[[a,e]]},.2);closed(r.faces);const bevel=r.faces.find(f=>f.chamfer),top=bevel.points.filter(p=>p.z>3);assert.ok(top.every(p=>Math.abs(p.z-(4+p.x*.2+p.y*.3))<1e-5));});
test('oversized chamfers clamp to a nonempty fitting bevel instead of rejecting',()=>{const r=W.chamfer(cube(),{edges:[[a,e]]},5);assert.ok(r.limited);assert.ok(r.amount>2.8&&r.amount<4/Math.SQRT2);assert.ok(r.additions.length);closed(r.faces);});

test('open walls with differently sloped roof boundaries chamfer without a roof cap',()=>{
 const scene=[{id:'front',points:[a,b,p(4,0,5),e]},{id:'side',points:[d,a,e,p(0,4,3)]}];
 for(const depth of [0,.000001,.005,.2]){const before=JSON.stringify(scene),r=W.chamfer(scene,{edges:[[a,e]]},depth);assert.equal(JSON.stringify(scene),before);if(!r.additions.length)continue;
 const bevel=r.additions.find(f=>f.points.length===4);assert.ok(bevel);const top=bevel.points.filter(p=>p.z>3);assert.equal(top.length,2);assert.ok(top.every(p=>Math.abs(p.z-(4+p.x*.25-p.y*.25))<1e-6));
 assert.equal(r.additions.length,1);for(const patch of r.additions){const joined=patch.points.map((p,i)=>W.sharedIntervals(p,patch.points[(i+1)%patch.points.length],r.faces.filter(f=>f!==patch)).reduce((s,[a,b])=>s+b-a,0));assert.equal(joined.filter(c=>c>.9999).length,2);}
 }
});

test('saved house edges produce finite nonempty live bevels across small and oversized depths',()=>{
 const {faces,edges}=require('./fixtures/chamfer-house.json'),before=JSON.stringify(faces);assert.equal(edges.length,48);
 for(const edge of edges)for(const depth of [.001,.01,.05,.1,.3,1,5]){const r=W.chamfer(faces,{edges:[edge]},depth);assert.ok(r.amount>0&&r.amount<=depth);assert.ok(r.additions.length,'No preview for '+W.edgeKey(...edge)+' at '+depth);for(const face of r.faces)K.validateFace(face);}
 assert.equal(JSON.stringify(faces),before);
});
test('point tilt limits fit without rejecting and multiple edges clamp together',()=>{
 const point=W.chamfer(cube(),{points:[a]},.2,60,35);assert.ok(point.limited);assert.ok(point.additions.length);assert.ok(point.angleOffset<60);closed(point.faces);
 const edges=W.chamfer(cube(),{edges:[[a,e],[a,b],[a,d]]},10);assert.ok(edges.limited&&edges.amount>0);assert.ok(edges.additions.length);closed(edges.faces);
});

test('two geometric sides resolve across duplicate and split face records',()=>{
 const original=cube(),duplicate=[...original,{...original[0],id:'duplicate'}];closed(W.chamfer(duplicate,{edges:[[a,e]]},.2).faces);
 const low={...original[0],points:[a,b,p(4,0,2),p(0,0,2)]},high={...original[0],id:'split',points:[p(0,0,2),p(4,0,2),f,e]},split=[low,high,...original.slice(1)],r=W.chamfer(split,{edges:[[a,e]]},.2);assert.ok(r.additions.length);closed(r.faces);
});
test('all saved-house boundary lines start and produce bevels, including previously excluded records',()=>{
 const {faces}=require('./fixtures/chamfer-house.json'),edges=new Map();for(const face of faces)for(const ring of [face.points,...(face.holes||[])])for(let i=0;i<ring.length;i++)edges.set(W.edgeKey(ring[i],ring[(i+1)%ring.length]),[ring[i],ring[(i+1)%ring.length]]);assert.equal(edges.size,103);
 for(const edge of edges.values()){W.chamfer(faces,{edges:[edge]},0);for(const depth of [.005,.05,.3]){const r=W.chamfer(faces,{edges:[edge]},depth);assert.ok(r.amount>0&&r.additions.length,'Missing bevel '+W.edgeKey(...edge));for(const f of r.faces)K.validateFace(f);}}
});
test('horizontal chamfer trims both three-way end corners, including nearly coincident face coordinates',()=>{
 const scene=cube();scene[1]={...scene[1],points:scene[1].points.map(p=>({...p,x:p.x+2e-7})),retainedPoints:[{...b,x:b.x+2e-7}]};scene[3]={...scene[3],retainedPoints:[a]};const result=W.chamfer(scene,{edges:[[a,b]]},.2);
 for(const end of [a,b])assert.ok(!result.faces.some(f=>[...f.points,...(f.retainedPoints||[])].some(p=>Math.hypot(p.x-end.x,p.y-end.y,p.z-end.z)<1e-5)),'Old end corner survived');
 closed(result.faces);
});

test('roof support supplies the second chamfer plane without becoming editable duplicate roof geometry',()=>{
 const wall={id:'wall',points:[a,b,f,e]},roof={id:'roof',chamferSupportOnly:true,points:[e,f,p(4,4,5),p(0,4,5)]},before=JSON.stringify(roof),r=W.chamfer([wall,roof],{edges:[[e,f]]},.2);assert.ok(r.additions.length);assert.ok(!r.faces.some(f=>f.id==='roof'));assert.ok(!r.replacements.some(r=>r.face.id==='roof'));assert.equal(JSON.stringify(roof),before);
});

test('line motion updates wall and base contacts together despite small height mismatch',()=>{
 const scene=[{id:'wall',points:[a,b,f,e]},{id:'base',baseId:'base',points:[p(0,0,-.0005),p(4,0,-.0005),p(4,4,-.0005),p(0,4,-.0005)]}],before=JSON.stringify(scene),result=W.slideLines(scene,[[a,b]],p(0,1,0),.2);
 assert.deepEqual(new Set(result.affected),new Set(['wall','base']));for(const face of result.faces){assert.ok(!face.points.some(p=>Math.abs(p.y)<1e-5&&Math.abs(p.z)<.002));assert.equal(face.points.filter(p=>Math.abs(p.y-.2)<1e-5&&Math.abs(p.z+.0005)<1e-5).length,2);}assert.equal(JSON.stringify(scene),before);
});

test('chamfer endpoints follow sloped incident seams retained inside merged face records',()=>{
 const tip=p(0,0,2),frontLow={id:'front-low',points:[a,b,p(4,0,3),tip]},frontHigh={id:'front-high',points:[tip,p(4,0,3),f,e]},sideLow={id:'side-low',points:[d,a,tip,p(0,4,1.5)]},sideHigh={id:'side-high',points:[p(0,4,1.5),tip,e,h]},scene=[...cube(),frontLow,frontHigh,sideLow,sideHigh];
 const r=W.chamfer(scene,{edges:[[a,tip]]},.2),bevel=r.additions.find(f=>f.points.length===4);assert.ok(bevel);const top=bevel.points.filter(p=>p.z>1);assert.equal(top.length,2);
 assert.ok(top.some(p=>Math.abs(p.y)<1e-5&&Math.abs(p.z-(2+p.x*.25))<1e-5),'Front endpoint left the original sloped line');assert.ok(top.some(p=>Math.abs(p.x)<1e-5&&Math.abs(p.z-(2-p.y*.125))<1e-5),'Side endpoint left the original sloped line');
});
test('skewed three-way corners retain their original end-edge directions with single and adjoining chamfers',()=>{
 const transform=p=>({x:p.x+.25*p.y+.15*p.z,y:p.y+.1*p.z,z:p.z+.2*p.x-.12*p.y}),scene=cube().map(f=>({...f,points:f.points.map(transform)}));
 for(const edges of [[[a,e]],[[a,e],[a,b]]]){const r=W.chamfer(scene,{edges:edges.map(pair=>pair.map(transform))},.15);assert.ok(r.additions.length);closed(r.faces);
 const tip=transform(e),endEdges=[[e,f],[e,h]].map(pair=>pair.map(transform)),nearTip=r.additions.flatMap(f=>f.points).filter(p=>Math.hypot(p.x-tip.x,p.y-tip.y,p.z-tip.z)<1);
 assert.ok(nearTip.length>=2);for(const q of nearTip)assert.ok(endEdges.some(([a,b])=>{const v={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},l2=v.x*v.x+v.y*v.y+v.z*v.z,t=((q.x-a.x)*v.x+(q.y-a.y)*v.y+(q.z-a.z)*v.z)/l2;return t>=0&&t<=1&&Math.hypot(q.x-a.x-t*v.x,q.y-a.y-t*v.y,q.z-a.z-t*v.z)<1e-5;}),'New endpoint is off the existing edge');}
});

test('measured chamfer width stays exact at symmetric and asymmetric angles, including multiple edges',()=>{
 for(const edges of [[[a,e]],[[a,e],[a,b]]])for(const angle of [0,15,30,-30]){
  const r=W.chamfer(cube(),{edges,widthMode:true},.4,angle);assert.equal(r.limited,false);
  for(const m of r.metrics){const [u,v]=m.shoulders;assert.ok(Math.abs(Math.hypot(u.x-v.x,u.y-v.y,u.z-v.z)-.4)<1e-8);}
  closed(r.faces);
 }
});
test('typed corner width measures the widest span of the new corner face',()=>{
 for(const angle of [0,10]){const r=W.chamfer(cube(),{points:[a],widthMode:true},.4,angle,30),ps=r.metrics[0].shoulders;const width=Math.max(...ps.flatMap((p,i)=>ps.slice(i+1).map(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z))));assert.ok(Math.abs(width-.4)<1e-8);closed(r.faces);}
});

test('each selected edge clamps independently while larger chamfers keep growing',()=>{
 const small=cube().map(f=>({...f,id:'small-'+f.id,points:f.points.map(p=>({x:p.x*.05,y:p.y*.05,z:p.z}))})),large=cube().map(f=>({...f,id:'large-'+f.id,points:f.points.map(p=>({...p,x:p.x+10}))})),scene=[...small,...large],selection={edges:[[a,e],[p(10,0,0),p(10,0,4)]],widthMode:true},before=JSON.stringify(scene);
 const width=m=>Math.hypot(m.shoulders[0].x-m.shoulders[1].x,m.shoulders[0].y-m.shoulders[1].y,m.shoulders[0].z-m.shoulders[1].z);
 const one=W.chamfer(scene,selection,1),two=W.chamfer(scene,selection,2);
 assert.ok(one.metrics[0].limited);assert.ok(two.metrics[0].limited);assert.equal(two.metrics[1].limited,false);
 assert.ok(Math.abs(width(one.metrics[0])-width(two.metrics[0]))<.001);
 assert.ok(Math.abs(width(one.metrics[1])-1)<1e-8);assert.ok(Math.abs(width(two.metrics[1])-2)<1e-8);
 closed(one.faces);closed(two.faces);assert.equal(JSON.stringify(scene),before);
 const reversed=W.chamfer(scene,{...selection,edges:selection.edges.slice().reverse()},2);assert.ok(Math.abs(width(reversed.metrics[0])-2)<1e-8);
 const shrunk=W.chamfer(scene,selection,.1);assert.equal(shrunk.limited,false);assert.ok(shrunk.metrics.every(m=>Math.abs(width(m)-.1)<1e-8));
});

test('chamfer snapping aligns both sides to points at different heights along the edge',()=>{
 const screen=p=>({x:p.x*100,y:p.y*100}),raw=W.chamfer(cube(),{edges:[[a,e]]},.2),targets=[p(.29,0,4),p(0,.30,3)];
 const snap=W.chamferSnap(raw.metrics,targets,.2,0,screen);assert.equal(snap.targets.length,2);
 const fit=W.chamfer(cube(),{edges:[[a,e]]},snap.amount,snap.angle),ps=fit.metrics[0].shoulders;
 for(const target of targets)assert.ok(ps.some(p=>Math.hypot(p.x-target.x,p.y-target.y)<1e-8));
 assert.equal(W.chamferSnap(raw.metrics,[p(2,0,4)],.2,0,screen),null);
 assert.equal(W.chamferSnap(raw.metrics,[p(.29,.03,4)],.2,0,screen),null);
});
test('wheel snapping adjusts the angle for a single target while retaining depth',()=>{
 const raw=W.chamfer(cube(),{edges:[[a,e]]},.2),snap=W.chamferSnap(raw.metrics,[p(.29,0,4)],.2,0,p=>({x:p.x*100,y:p.y*100}),10,true);
 assert.ok(snap);assert.equal(snap.amount,.2);assert.notEqual(snap.angle,0);
 const fit=W.chamfer(cube(),{edges:[[a,e]]},snap.amount,snap.angle);assert.ok(fit.metrics[0].shoulders.some(p=>Math.abs(p.x-.29)<1e-8&&Math.abs(p.y)<1e-8));
});

test('collinear boundary points are snap targets but do not limit edge chamfers',()=>{
 const scene=cube().map(f=>({...f,points:f.points.flatMap((p,i)=>{const q=f.points[(i+1)%f.points.length];return [p,{x:p.x+(q.x-p.x)*.05,y:p.y+(q.y-p.y)*.05,z:p.z+(q.z-p.z)*.05}];})})),before=JSON.stringify(scene);
 const r=W.chamfer(scene,{edges:[[a,e]],widthMode:true},1);
 assert.equal(r.limited,false);assert.ok(Math.abs(Math.hypot(...['x','y','z'].map(k=>r.metrics[0].shoulders[0][k]-r.metrics[0].shoulders[1][k]))-1)<1e-8);closed(r.faces);
 const near=W.chamfer(scene,{edges:[[a,e]]},.14);assert.ok(W.chamferSnap(near.metrics,[p(.2,0,4)],.14,0,p=>({x:p.x*100,y:p.y*100})));
 assert.equal(JSON.stringify(scene),before);
});

test('point chamfer snaps to three incident targets with fitted tilt and rotation',()=>{
 const raw=W.chamfer(cube(),{points:[a]},.2),len=raw.metrics[0].distances[0],targets=[p(len+.01,0,0),p(0,len-.01,0),p(0,0,len+.015)],screen=p=>({x:(p.x+p.z*.3)*100,y:(p.y+p.z*.7)*100});
 const snap=W.pointChamferSnap(raw.metrics,targets,.2,0,0,screen);assert.equal(snap.targets.length,3);
 const fit=W.chamfer(cube(),{points:[a]},snap.amount,snap.angle,snap.rotation);
 for(const target of targets)assert.ok(fit.metrics[0].shoulders.some(p=>Math.hypot(p.x-target.x,p.y-target.y,p.z-target.z)<1e-8));closed(fit.faces);
 assert.equal(W.pointChamferSnap(raw.metrics,[p(3,0,0)],.2,0,0,screen),null);
 const single=W.pointChamferSnap(raw.metrics,[targets[0]],.2,0,0,screen);assert.equal(single.targets.length,1);
});
test('point chamfer passes collinear intermediate anchors',()=>{
 const scene=cube().map(f=>({...f,points:f.points.flatMap((p,i)=>{const q=f.points[(i+1)%f.points.length];return [p,{x:p.x+(q.x-p.x)*.02,y:p.y+(q.y-p.y)*.02,z:p.z+(q.z-p.z)*.02}];})}));
 const r=W.chamfer(scene,{points:[a],widthMode:true},.5);assert.equal(r.limited,false);closed(r.faces);assert.ok(r.faces.every(f=>f.points.every(p=>Math.hypot(p.x,p.y,p.z)>.001)));
});

test('manual merge joins connected coplanar material chains without joining corners or other materials',()=>{
 const face=(id,x,y,material)=>({id,material,points:[p(x,y,0),p(x+1,y,0),p(x+1,y+1,0),p(x,y+1,0)]});
 const scene=[face('a',0,0),face('b',1,0),face('c',2,0),face('brick',3,0,'brick'),face('corner',3,1),face('apart',6,0)],before=JSON.stringify(scene),groups=W.mergeConnectedFaces(scene);
 assert.equal(groups.length,1);assert.equal(groups[0].faces.length,3);assert.equal(groups[0].pieces.length,1);assert.ok(Math.abs(K.area(groups[0].pieces[0])-3)<1e-8);assert.equal(JSON.stringify(scene),before);
});

test('wall fillet is an exact tangent conic with a closed sampled shell',()=>{
 const result=W.fillet(cube(),{edges:[[a,e]]},.2);assert.ok(result.additions.length>4);assert.ok(result.additions.every(f=>f.curvedSurface?.type==='conic-ruled'));closed(result.faces);
 const arc=result.additions[0].curvedSurface.start,mid=K.curvePoint(arc,.5),radius=.2*Math.SQRT2;assert.ok(Math.abs(Math.hypot(mid.x-radius,mid.y-radius)-radius)<1e-8);const at0=K.curvePoint(arc,.00001);assert.ok(Math.abs(at0.x-arc.start.x)<1e-8||Math.abs(at0.y-arc.start.y)<1e-8);
});
test('adjacent wall fillets trim into a closed shared corner',()=>{const result=W.fillet(cube(),{edges:[[a,e],[a,b]]},.1);assert.ok(result.amount>0);closed(result.faces);});

test('point fillet removes the original corner and joins a closed analytic quadric patch',()=>{
 const result=W.fillet(cube(),{points:[a]},.12);assert.equal(result.additions.length,1);assert.ok(result.additions[0].curvedSurface.logical);assert.ok(result.additions.every(f=>f.curvedSurface?.type==='quadric-corner'));closed(result.faces);
 assert.ok(result.faces.every(f=>f.points.every(p=>Math.hypot(p.x,p.y,p.z)>.001)));
 const surface=result.additions[0].curvedSurface,extent=Math.max(...surface.shoulders.map(p=>Math.hypot(p.x,p.y,p.z)));
 for(const f of result.additions)for(const p of f.points)assert.ok(Math.abs((p.x/extent-1)**2+(p.y/extent-1)**2+(p.z/extent-1)**2-2)<.0001);
 const moved=K.mapCurveData(result.additions[0],p=>({x:p.x+2,y:p.y-3,z:p.z+1}));assert.equal(moved.curvedSurface.origin.x,2);
});

test('point fillet follows oblique adjoining edges with unequal setbacks',()=>{
 const map=p=>({x:p.x+.25*p.z,y:p.y+.2*p.x,z:p.z}),scene=cube().map(f=>({...f,points:f.points.map(map)})),result=W.fillet(scene,{points:[map(a)]},.1,7,30);
 assert.ok(result.additions.every(f=>f.curvedSurface?.type==='quadric-corner'));closed(result.faces);assert.ok(result.faces.every(f=>f.points.every(p=>Math.hypot(p.x,p.y,p.z)>.001)));
 for(const p of result.metrics[0].shoulders)assert.ok(scene.some(f=>W.sharedIntervals(map(a),p,[f]).some(([lo,hi])=>hi-lo>.999)));
});

test('explicit fillets have one logical curved face and no sampled point controls',()=>{
 for(const selection of [{edges:[[a,e]]},{points:[a]}]){const result=W.fillet(cube(),selection,.12),faces=K.compactSurfaces(result.faces),curved=faces.filter(f=>f.curvedSurface?.logical);assert.equal(curved.length,1);const mesh=K.surfaceMesh(curved[0]);assert.ok(mesh.triangles.length>4);const wire=W.surfaceWire({$surfaces:faces});assert.ok(wire.nodes.filter(p=>!p.curveSample).length<=10,wire.nodes.filter(p=>!p.curveSample).length);}
});

test('copying visible curve controls includes adjoining faces without selecting render samples',()=>{
 const faces=K.compactSurfaces(W.fillet(cube(),{edges:[[a,e]]},.12).faces),controls=W.surfaceWire({$surfaces:faces}).nodes.filter(p=>!p.curveSample),clip=W.copyGeometry(faces,controls);assert.equal(clip.faces.length,faces.length);assert.equal(clip.faces.filter(f=>f.curvedSurface?.logical).length,1);
 const moved=W.transformGeometry(clip,0,{delta:{x:.1,y:.2}}),result=W.transformSelection(faces,clip,moved);for(const f of result.faces)K.validateFace(f);assert.equal(result.faces.filter(f=>f.curvedSurface?.logical).length,1);
});

test('roof-contact point fillet keeps a visible preview despite sub-micron shared-plane differences',()=>{
 const input=require('./fixtures/point-fillet-roof-contact.json'),before=JSON.stringify(input);
 for(const amount of [.01,.05,.15]){
  const result=W.fillet(input.scene,{points:[input.point]},amount);
  assert.equal(result.amount,amount,'An ordinary corner must not silently clamp to zero');
  assert.equal(result.replacements.length,2);
  const surfaces=K.compactSurfaces(result.faces),patches=surfaces.filter(f=>f.curvedSurface?.logical);
  assert.equal(patches.length,1);assert.equal(patches[0].curvedSurface.type,'quadric-corner');
  assert.ok(K.surfaceMesh(patches[0]).triangles.length>4);
  assert.ok(result.replacements.every(r=>r.pieces.every(f=>f.points.every(p=>Math.hypot(p.x-input.point.x,p.y-input.point.y,p.z-input.point.z)>.001))));
 }
 assert.equal(JSON.stringify(input),before);
});

test('large point fillets stay one analytic face throughout growth and size limiting',()=>{
 const scene=cube(),before=JSON.stringify(scene),times=[];
 for(const amount of [.2,.8,1.5,4,20]){
  const start=performance.now(),result=W.fillet(scene,{points:[a]},amount),edits={$surfaces:result.faces};
  require('../public/measure/internal/editor_scripts/exterior_model.js').validateEdits(edits);
  const wire=W.surfaceWire(edits);times.push(performance.now()-start);
  assert.equal(result.additions.length,1);assert.equal(result.additions[0].curvedSurface.logical,true);
  assert.ok(result.amount>0);assert.equal(edits.$surfaces.filter(f=>f.curvedSurface).length,1);
  assert.ok(wire.nodes.filter(p=>!p.curveSample).length<=10);
  const mesh=K.surfaceMesh(result.additions[0]);assert.ok(mesh.triangles.length>20);
 }
 assert.equal(JSON.stringify(scene),before);
 // A generous guard for shared CI hosts, catching the prior multi-second freeze.
 assert.ok(Math.max(...times)<2000,'Corner preview stalled: '+times.map(t=>t.toFixed(0)).join(', ')+' ms');
});
