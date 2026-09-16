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


test('copied window aligns across a gap with coplanar window edges',()=>{
 const source={id:'window',feature:{type:'window'},points:[p(0,0,0),p(1,0,0),p(1,0,1),p(0,0,1)]},clip=W.copyGeometry([source],source.points),target={points:[p(-10,0,-10),p(10,0,-10),p(10,0,10),p(-10,0,10)]},options={normal:p(0,-1,0),points:[p(0,0,2),p(1,0,2),p(1,0,3),p(0,0,3)],screen:q=>({x:q.x*100,y:q.z*100})};
 const location=p(4,0,2.56),raw=W.pasteGeometry(clip,0,target,location,{...options,snap:false}),result=W.pasteGeometry(clip,0,target,location,options);
 assert.equal(result.valid,true);assert.ok(result.snap);assert.ok(result.points.some(p=>Math.abs(p.z-2)<1e-8));assert.ok(result.points.every(p=>Math.abs(p.x-raw.points[result.points.indexOf(p)].x)<1e-8));
 assert.equal(result.guides.filter(g=>Math.abs(g.from.z-g.target.z)<1e-8).length,2);assert.ok(result.guides.every(g=>result.points.some(p=>W.vertexKey(p)===W.vertexKey(g.from))));assert.deepEqual(raw.guides,[]);
 const away=W.pasteGeometry(clip,0,target,p(4,0,2.8),options);assert.equal(away.guides.length,0);
});
const testPointAlignment=(axis)=>{
 const source={id:'different-size',points:[p(0,0,0),p(2,0,0),p(2,0,1.5),p(0,0,1.5)]},clip=W.copyGeometry([source],source.points),targets=axis==='height'?[p(6,0,.06),p(7,0,.06),p(7,0,3.4),p(6,0,3.4)]:[p(.06,0,6),p(3.5,0,6),p(3.5,0,7),p(.06,0,7)],result=W.snapGeometryOnPlane(clip,0,targets,[],q=>({x:q.x*100,y:q.z*100}),12);
 const coordinate=axis==='height'?'z':'x',other=axis==='height'?'x':'z';assert.ok(Math.abs(result.points[0][coordinate]-.06)<1e-8);assert.equal(result.points[0][other],source.points[0][other]);assert.ok(W.planeAlignmentGuides(result.points,targets,result.mounts[0].frame).length);assert.equal(result.points[2].x-result.points[0].x,2);assert.equal(result.points[2].z-result.points[0].z,1.5);
};
test('different-size moving geometry aligns any vertex horizontally across a gap',()=>testPointAlignment('height'));
test('different-size moving geometry aligns any vertex vertically across a gap',()=>testPointAlignment('width'));


test('copied stickers snap around corners and guides reach the actual reference sticker',()=>{
 const source={id:'window',feature:{type:'window',preset:0},points:[p(0,0,2),p(1,0,2),p(1,0,3),p(0,0,3)]},clip=W.copyGeometry([source],source.points),target={points:[p(5,-5,0),p(5,5,0),p(5,5,6),p(5,-5,6)]},location=p(5,1,2.56),options={normal:p(1,0,0),bound:true,screen:q=>({x:q.y*100,y:q.z*100})};
 const raw=W.pasteGeometry(clip,0,target,location,{...options,snap:false});const height=Math.max(...raw.points.map(p=>p.z))+.06;
 const reference={...source,points:source.points.map(q=>({...q,z:q.z+height-3}))};
 const result=W.pasteGeometry(clip,0,target,location,{...options,stickerFaces:[reference]});
 assert.equal(result.valid,true);assert.ok(Math.abs(Math.max(...result.points.map(p=>p.z))-height)<1e-8);assert.ok(result.points.every(p=>p.x===5));assert.equal(result.faces[0].feature.type,'window');
 assert.ok(result.guides.some(g=>reference.points.some(q=>q.x===g.target.x&&q.y===g.target.y&&q.z===g.target.z)));
 const frame=W.clipboardFrame(location,options.normal),targets=W.stickerAlignmentTargets([reference],frame),corner=p(5,0,height),guides=W.planeAlignmentGuides(result.points,[corner,...targets],frame);
 assert.ok(guides.some(g=>reference.points.some(q=>q.x===g.target.x&&q.y===g.target.y&&Math.abs(q.z-height)<1e-8&&Math.abs(g.target.z-height)<1e-8)),'reference sticker wins over the projected wall corner');
 const free=W.pasteGeometry(clip,0,target,location,{...options,stickerFaces:[reference],snap:false});assert.deepEqual(free.points,raw.points);assert.equal(free.guides.length,0);
});


test('copied nearly full-height door chooses the floor despite nearby header and garage heights',()=>{
 const FT=.3048,height=7*FT,door={id:'door',feature:{type:'door'},points:[p(0,0,0),p(3*FT,0,0),p(3*FT,0,80/12*FT),p(0,0,80/12*FT)]},clip=W.copyGeometry([door],door.points),wall={points:[p(0,0,0),p(4,0,0),p(4,0,height),p(0,0,height)]},garage={feature:{type:'garage'},points:[p(0,.3,0),p(4,.3,0),p(4,.3,height-.04),p(0,.3,height-.04)]};
 for(const z of [.01,.2,.5,.9]){const result=W.pasteGeometry(clip,0,wall,p(2,0,z),{normal:p(0,-1,0),bound:true,stickerFaces:[garage],screen:p=>({x:p.x*100,y:p.z*100})});assert.equal(result.valid,true);assert.ok(Math.abs(Math.min(...result.points.map(p=>p.z)))<1e-8);assert.ok(Math.abs(Math.max(...result.points.map(p=>p.z))-80/12*FT)<1e-8);}
 const frame=W.faceFrame(wall),targets=[p(0,0,0),p(0,0,height-.04)],moving=door.points.map(q=>({...q,z:q.z+.05}));const snap=W.planeAlignment(moving,targets,frame,p=>({x:p.x*100,y:p.z*100}),12,['v'],p(2,0,.1));assert.ok(Math.abs(snap.y-(height-.04-80/12*FT-.05))<1e-8,'nearest edge translation wins over pointer-to-target distance');
});


test('pasted sticker ranks snap translations from the no-snap placement',()=>{
 const h=80/12*.3048,door={id:'door',feature:{type:'door'},points:[p(0,0,0),p(.9144,0,0),p(.9144,0,h),p(0,0,h)]},clip=W.copyGeometry([door],door.points);
 const wall={points:[p(0,0,0),p(5,0,0),p(5,0,4),p(0,0,4)]},location=p(2,0,.3+h/2),options={normal:p(0,-1,0),bound:true,screen:p=>({x:p.x*100,y:p.z*100})};
 const free=W.pasteGeometry(clip,0,wall,location,{...options,snap:false}),bottom=Math.min(...free.points.map(p=>p.z)),top=Math.max(...free.points.map(p=>p.z));
 const targets=[p(0,0,bottom-.05),p(0,0,top-.102)];
 for(const points of [targets,[...targets].reverse()]){
  const result=W.pasteGeometry(clip,0,wall,location,{...options,points});
  assert.equal(result.valid,true);assert.ok(Math.abs(Math.min(...result.points.map(p=>p.z))-(bottom-.05))<1e-8);
 }
});


test('pasted door clamps to local sloped floor when its cursor is below the valid center range',()=>{
 const door={id:'door',feature:{type:'door'},points:[p(0,0,0),p(1,0,0),p(1,0,2),p(0,0,2)]},clip=W.copyGeometry([door],door.points),wall={points:[p(0,0,0),p(6,0,.6),p(6,0,3),p(3,0,3),p(3,0,4),p(0,0,4)]};
 for(const z of [-4,0,1,1.25,1.5,1.75,2,3,8]){
  const result=W.pasteGeometry(clip,0,wall,p(4.5,0,z),{normal:p(0,-1,0),bound:true,snap:false});
  assert.equal(result.valid,true);const expected=Math.max(.5,Math.min(1,z-1));
  assert.ok(Math.abs(Math.min(...result.points.map(p=>p.z))-expected)<1e-8,`cursor ${z}`);
  assert.ok(Math.abs(Math.min(...result.points.map(p=>p.x))-4)<1e-8);
 }
});
