const test=require('node:test'),assert=require('node:assert/strict'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z)=>({x,y,z});
const back={id:'back',points:[p(-5,0,-5),p(5,0,-5),p(5,0,5),p(-5,0,5)]};
const a=p(-1,0,0),b=p(1,0,0),c=p(1,0,2),d=p(-1,0,2),e=p(-1,1,0),f=p(1,1,0),g=p(1,1,2),h=p(-1,1,2);
const faces=[[a,b,f,e],[b,c,g,f],[c,d,h,g],[d,a,e,h],[e,f,g,h]].map((points,i)=>({id:'face'+i,points,material:'brick'})),selected=[a,b,c,d,e,f,g,h],scene=[back,...faces];
test('copy includes only complete boundaries and ranks the uncopied supporting plane',()=>{
 const before=JSON.stringify(scene),clip=W.copyGeometry(scene,selected);assert.equal(clip.faces.length,5);assert.equal(clip.points.length,8);assert.equal(clip.mounts[0].count,4);assert.ok(Math.abs(clip.mounts[0].frame.n.y-1)<1e-8);
 const partial=W.copyGeometry(scene,selected.filter(p=>p!==g));assert.equal(partial.faces.length,2);assert.equal(JSON.stringify(scene),before);
});
test('paste rotates depth onto another wall and rejects mounts beyond its boundary',()=>{
 const clip=W.copyGeometry(scene,selected),target={points:[p(10,-5,-5),p(10,5,-5),p(10,5,5),p(10,-5,5)]},result=W.pasteGeometry(clip,0,target,p(10,0,0),{normal:p(1,0,0),snap:false});
 assert.equal(result.valid,true);assert.ok(result.points.every(p=>p.x>=10-1e-8&&p.x<=11+1e-8));assert.ok(result.points.some(p=>Math.abs(p.x-11)<1e-8),'protrusion depth must survive');for(let i=0;i<selected.length;i++)for(let j=0;j<i;j++){const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);assert.ok(Math.abs(distance(selected[i],selected[j])-distance(result.points[i],result.points[j]))<1e-8);}assert.equal(result.faces.length,5);assert.ok(result.faces.every(f=>f.material==='brick'));
 assert.equal(W.pasteGeometry(clip,0,target,p(10,5,0),{normal:p(1,0,0),snap:false}).valid,false);
});
test('paste snaps contact points and edges while free placement remains independent',()=>{
 const clip=W.copyGeometry(scene,selected),target={points:back.points},location=p(.03,0,1),screen=p=>({x:p.x*100,y:p.z*100}),options={normal:p(0,1,0),points:[a],screen};
 const raw=W.pasteGeometry(clip,0,target,location,{...options,snap:false}),snapped=W.pasteGeometry(clip,0,target,location,options);assert.equal(raw.snap,null);assert.ok(snapped.snap);assert.ok(snapped.points.some(p=>Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)<1e-8));
});
test('points and lines can be copied without inventing a face',()=>{
 const clip=W.copyGeometry([back],[a,b],[[a,b]]);assert.equal(clip.faces.length,0);assert.equal(clip.edges.length,1);assert.equal(clip.mounts.length,1);
});

test('paste rejects a mounting footprint crossing a target opening',()=>{
 const clip=W.copyGeometry(scene,selected),target={points:back.points,holes:[[p(-.2,0,.8),p(.2,0,.8),p(.2,0,1.2),p(-.2,0,1.2)]]};
 const result=W.pasteGeometry(clip,0,target,p(0,0,1),{normal:p(0,1,0),snap:false});assert.equal(result.valid,false);
});


test('plane rotate and mirror preserve depth, dimensions, metadata and rigid topology',()=>{
 const clip=W.copyGeometry(scene,selected),before=JSON.stringify(clip),turned=W.transformGeometry(clip,0,{angle:Math.PI/2}),flipped=W.transformGeometry(turned,0,{flip:'x'});
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
 for(const q of [turned,flipped])for(let i=0;i<selected.length;i++)for(let j=0;j<i;j++)assert.ok(Math.abs(distance(q.points[i],q.points[j])-distance(selected[i],selected[j]))<1e-8);
 assert.ok(flipped.faces.every(f=>f.material==='brick'));assert.equal(JSON.stringify(clip),before);
 const restored=W.transformGeometry(flipped,0,{flip:'x'});restored.points.forEach((p,i)=>assert.ok(distance(p,turned.points[i])<1e-8));
 const result=W.transformSelection(scene,clip,turned);assert.equal(result.faces.length,scene.length);assert.equal(result.affected.length,5);assert.deepEqual(result.faces[0],back);
});

test('selection transform updates coincident points in every incident owner',()=>{
 const clip=W.copyGeometry(scene,selected),moved=W.transformGeometry(clip,0,{delta:{x:2,y:1}}),extra={id:'neighbor',points:[a,p(-4,0,0),p(-4,0,-1)]},result=W.transformSelection([...scene,extra],clip,moved);
 assert.ok(result.affected.includes('neighbor'));assert.deepEqual(result.faces.at(-1).points[0],moved.points[0]);
});


test('plane movement snaps selected geometry without changing its shape or depth',()=>{
 const clip=W.copyGeometry(scene,selected),target={x:a.x+.04,y:a.y,z:a.z+.02},snapped=W.snapGeometryOnPlane(clip,0,[target],[],p=>({x:p.x*100,y:p.z*100}));
 assert.ok(Math.hypot(snapped.points[0].x-target.x,snapped.points[0].y-target.y,snapped.points[0].z-target.z)<1e-8);
 snapped.points.forEach((p,i)=>assert.equal(p.y,clip.points[i].y));
 const offPlane=W.snapGeometryOnPlane(clip,0,[{...target,y:2}],[],p=>({x:p.x*100,y:p.z*100}));assert.equal(offPlane,clip);
});


test('resize depth is anchored on the mounting plane and axis changes preserve prior dimensions',()=>{
 const clip=W.copyGeometry(scene,selected),all=W.geometryScale(clip,0,2),depth=W.geometryScale(all,0,.5,'z');
 const range=(c,k)=>Math.max(...c.points.map(p=>p[k]))-Math.min(...c.points.map(p=>p[k]));assert.equal(range(all,'x'),4);assert.equal(range(all,'z'),4);assert.equal(range(all,'y'),2);assert.equal(range(depth,'x'),4);assert.equal(range(depth,'z'),4);assert.equal(range(depth,'y'),1);
 for(let i=0;i<clip.points.length;i++)if(clip.points[i].y===0)assert.equal(depth.points[i].y,0,'mounting points stay on supporting face');
});

test('resize snaps a growing vertex to a target point or finite edge',()=>{
 const clip=W.copyGeometry(scene,selected),screen=p=>({x:p.x*100,y:p.z*100});
 const target={...a,x:-2};assert.ok(Math.abs(W.snapGeometryScale(clip,0,1.96,'x',[target],[],screen)-2)<1e-8);
 assert.ok(Math.abs(W.snapGeometryScale(clip,0,1.96,'x',[],[[p(-2,0,-2),p(-2,0,4)]],screen)-2)<1e-8);
});


test('resize snaps the interior of a moving edge to a drawn target point',()=>{
 const clip=W.copyGeometry(scene,selected),screen=p=>({x:p.x*100,y:p.z*100});assert.ok(Math.abs(W.snapGeometryScale(clip,0,1.96,'all',[p(.3,0,3)],[],screen)-2)<1e-8);
});


test('a valid nearly vertical face is not rejected by its degenerate foundation projection',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),face={points:[p(1,2,1),p(3,2,1),p(3,2.000003,3),p(1,1.999999,3)]},base={id:'base',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]};
 assert.doesNotThrow(()=>K.validateFace(face));assert.throws(()=>K.triangles(face.points),/valid planar region/,'old XY-only triangulation rejects this valid rendered face');assert.equal(W.belowBase(face,[base]),null);
 const buried={points:face.points.map(q=>({...q,z:q.z-5}))};assert.deepEqual(W.belowBase(buried,[base]),{cuts:[]});
});

test('bounded paste finds edge placements on rotated concave planes after large overshoots',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),small={points:[p(-.3,-.3,0),p(.3,-.3,0),p(.3,.3,0),p(-.3,.3,0)]},clip=W.copyGeometry([small],small.points);
 for(const tilt of [0,.4])for(const angle of [.1,.7,1.9]){
  const frame=W.clipboardFrame(p(10,20,3),p(Math.sin(tilt),0,Math.cos(tilt))),c=Math.cos(angle),s=Math.sin(angle),world=q=>K.world(frame,p(q.x*c-q.y*s,q.x*s+q.y*c,0)),target={points:[[0,0],[10,0],[10,1],[1,1],[1,10],[0,10]].map(([x,y])=>world(p(x,y,0)))};
  for(const q of [p(-100,0,0),p(100,100,0),p(0,100,0)]){const result=W.pasteGeometry(clip,0,target,K.world(frame,q),{normal:frame.n,bound:true,snap:false});assert.equal(result.valid,true,JSON.stringify({tilt,angle,q}));const contact=result.points.map(p=>K.local(frame,p)),local={points:target.points.map(p=>K.local(frame,p))};assert.ok(K.difference({points:contact},[local]).reduce((sum,f)=>sum+K.area(f),0)<1e-7);}
 }
});

test('bounded paste remains valid at sloping tops and at opening boundaries',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),clip=W.copyGeometry(scene,selected),frame=W.clipboardFrame(p(2,3,4),p(.6,.8,0)),world=q=>K.world(frame,q),target={points:[p(-5,-5,0),p(5,-5,0),p(4,5,0),p(-3,4,0)].map(world),holes:[[p(-1,-2,0),p(1,-2,0),p(1,1,0),p(-1,1,0)].map(world)]};
 for(const q of [p(-100,0,0),p(100,1,0),p(0,100,0),p(2,100,0),p(0,0,0)]){const result=W.pasteGeometry(clip,0,target,world(q),{normal:frame.n,bound:true,snap:false});assert.equal(result.valid,true,JSON.stringify(q));for(const f of result.faces)K.validateFace(f);}
});

test('flip preserves inclined mounting plane, depth and bounds with uneven vertex spacing',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),n=p(.6,0,.8),frame=W.clipboardFrame(p(4,5,6),n),ps=[p(-2,-1,0),p(-1.5,-1,0),p(2,-1,0),p(2,3,0),p(-2,3,0),p(0,0,2)].map(q=>K.world(frame,q)),clip={points:ps,edges:[],faces:[],mounts:[{frame}]};
 for(const flip of ['x','y']){const result=W.transformGeometry(clip,0,{flip});result.points.forEach((q,i)=>{const a=K.local(frame,ps[i]),b=K.local(frame,q);assert.ok(Math.abs(a.z-b.z)<1e-8);assert.ok(Math.abs(b.x-(flip==='x'?-a.x:a.x))<1e-8);assert.ok(Math.abs(b.y-(flip==='y'?2-a.y:a.y))<1e-8);});}
});

test('curve definitions follow copied geometry through rotation, flip and paste',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),curve={type:'ellipse',center:p(0,0,0),u:p(1,0,0),v:p(0,0,1),radiusX:1,radiusY:2,sweep:Math.PI},face={id:'arc',points:K.curveSamples(curve),curves:[curve]},clip=W.copyGeometry([face],face.points),moved=W.transformGeometry(clip,0,{angle:.4,flip:'x'}),target={points:[p(10,-5,-5),p(10,5,-5),p(10,5,5),p(10,-5,5)]},result=W.pasteGeometry(moved,0,target,p(10,0,0),{normal:p(1,0,0),snap:false});assert.equal(result.faces[0].curves.length,1);const c=result.faces[0].curves[0],start=K.curvePoint(c,0);assert.ok(result.points.some(q=>Math.hypot(q.x-start.x,q.y-start.y,q.z-start.z)<1e-8));assert.equal(c.radiusY,2);
});
