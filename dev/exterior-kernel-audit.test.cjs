// Regressions from the 2026-10-16 full-house audit: planar kernel and extrusion (#9, #10, #29-#36).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root='../public/measure/internal/editor_scripts/';
const K=require(root+'exterior_geometry.js'),M=require(root+'exterior_model.js'),W=require(root+'wall_solid_geometry.js'),C=require(root+'wall_chimneys.js');
const p=(x,y,z=0)=>({x,y,z}),P=a=>a.map(([x,y])=>p(x,y)),wallXZ=a=>a.map(([x,z])=>p(x,0,z));
const localArea=f=>{const fr=K.frame(f);return K.area({points:f.points.map(q=>K.local(fr,q)),holes:(f.holes||[]).map(r=>r.map(q=>K.local(fr,q)))});};
const area3=pts=>{let x=0,y=0,z=0;for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];x+=(a.y-b.y)*(a.z+b.z);y+=(a.z-b.z)*(a.x+b.x);z+=(a.x-b.x)*(a.y+b.y);}return Math.hypot(x,y,z)/2;};
// Two panels joined by a retraced zero-width bridge, as left by a cut through a bridged ring.
const bridged=x=>wallXZ([[x,0],[x+1,0],[x+1,.5],[x+3,.5],[x+3,0],[x+4,0],[x+4,1],[x+3,1],[x+3,.5],[x+1,.5],[x+1,1],[x,1]]);
function savedHouse(name){
 const state=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8'));C.normalizeDrafts(state.wallEdits);C.syncFoundation(state);
 return {state,faces:M.collect(state,C.compose(state.mergedWalls||[],state)),base:state.wallEdits.$base||state.base};
}

test('#9 splitting a face twice gives each new region its own identity, and extrusion still works',()=>{
 const first=M.prepareEdits({},{$surfaces:[{id:'X',points:bridged(0),holes:[]}]},{});assert.deepEqual(first.$surfaces.map(f=>f.id),['X','X~region-1']);
 const second=structuredClone(first);second.$surfaces.find(f=>f.id==='X').points=bridged(10);
 const after=M.prepareEdits({},second,first),ids=after.$surfaces.map(f=>f.id);
 assert.equal(new Set(ids).size,ids.length,JSON.stringify(ids));assert.ok(ids.includes('X~region-2'));
 assert.doesNotThrow(()=>M.createExtrusion({face:after.$surfaces[0],scene:after.$surfaces}).preview(.2));
 assert.doesNotThrow(()=>W.moveFabric(after.$surfaces,'X',.2));
});

test('#9 the loader gives saved duplicate face identities unique ids without touching geometry',()=>{
 const square=x=>wallXZ([[x,0],[x+1,0],[x+1,1],[x,1]]);
 const edits={$surfaces:[{id:'X',points:square(0)},{id:'X~region-1',points:square(3)},{id:'X~region-2',points:square(6)},{id:'X~region-1',points:square(9)}],$drafts:{d:{faces:[{id:'r',points:[]},{id:'r',points:[]}]}}};
 const geometry=JSON.stringify(edits.$surfaces.map(f=>f.points));
 assert.throws(()=>K.topology(edits.$surfaces),/Duplicate face identity/);
 assert.equal(M.restoreDraftFaceOwnership(edits),true);
 assert.deepEqual(edits.$surfaces.map(f=>f.id),['X','X~region-1','X~region-2','X~region-3'],'the first record keeps its identity');
 assert.deepEqual(edits.$drafts.d.faces.map(f=>f.id),['r','r~region-1']);
 assert.equal(JSON.stringify(edits.$surfaces.map(f=>f.points)),geometry);
 assert.equal(M.restoreDraftFaceOwnership(edits),false,'idempotent');
 assert.doesNotThrow(()=>M.createExtrusion({face:edits.$surfaces[0],scene:edits.$surfaces}).preview(.2));
});

test('#33 split regions keep only their own anchors, so moving or extruding one leaves the other alone',()=>{
 const [a,b]=K.normalizeFaces({id:'s',points:bridged(0),holes:[]});
 assert.ok(a.points.every(q=>q.x<=1)&&b.points.every(q=>q.x>=3));
 for(const [mine,other] of [[a,b],[b,a]])assert.ok(!(mine.retainedPoints||[]).some(q=>other.points.some(r=>K.pointKey(r)===K.pointKey(q))&&!mine.points.some(r=>K.pointKey(r)===K.pointKey(q))));
 for(const move of [W.moveFabric,W.moveSurface]){const r=move([a,b],a.id,.2),b2=r.faces.find(f=>f.id===b.id);assert.equal(JSON.stringify(b2.points),JSON.stringify(b.points),move.name+' left the sibling in place');}
 const cap=M.createExtrusion({face:a,scene:[b]}).preview(.3).cap;assert.ok((cap.retainedPoints||[]).every(q=>q.x<=1+1e-9),'no sibling corners float in front of the other region');
});

test('#10 a hole touching its outline stays a hole through booleans and normalization',()=>{
 const halves=K.union([{points:P([[0,0],[4,0],[4,3],[0,5],[4,7],[4,10],[0,10]])},{points:P([[4,0],[10,0],[10,10],[4,10],[4,7],[4,3]])}]);
 assert.equal(halves.length,1);assert.equal(halves[0].holes.length,1);assert.ok(Math.abs(K.area(halves[0])-92)<1e-9);
 const keyhole=K.normalizeFaces({id:'k',points:P([[0,0],[10,0],[10,10],[0,10],[0,5],[4,7],[4,3],[0,5]]),holes:[]});
 assert.equal(keyhole.length,1);assert.ok(Math.abs(K.area({points:keyhole[0].points,holes:keyhole[0].holes})-92)<1e-9);
 // End to end: a corner cut pinches a vertical wall at elevation; the published wall keeps its opening.
 const [region]=K.difference({points:P([[0,0],[10,0],[10,10],[0,10]])},[{points:P([[0,2],[4,0],[5,5]])}]);
 const lift=q=>p(1.5+.8*q.x,-4+.6*q.x,161+q.y*.3),face={id:'wall-1',points:region.points.map(lift),holes:region.holes.map(h=>h.map(lift))};
 const out=M.prepareEdits({},{$surfaces:[face]},{}),n=K.normal(face.points);
 assert.ok(Math.abs(out.$surfaces.reduce((s,f)=>s+localArea(f),0)-26.7)<1e-6,'the cut area stays open');
 assert.ok(out.$surfaces.every(f=>{const m=K.normal(f.points);return m.x*n.x+m.y*n.y+m.z*n.z>0;}),'no reversed patch covers the opening');
});

test('#10 a ring pinched at a vertex on its own edge splits into its two regions',()=>{
 const regions=K.union([{points:P([[3,2],[0,5],[2,5],[2,6],[0,6],[0,2]])}]);
 assert.equal(regions.length,2);assert.ok(Math.abs(regions.reduce((s,r)=>s+K.area(r),0)-6.5)<1e-9);
 for(const r of regions)assert.doesNotThrow(()=>K.triangles(r.points,r.holes));
});

test('#29 faces whose holes touch the outline triangulate in every orientation',()=>{
 const square=P([[0,0],[10,0],[10,10],[0,10]]),cases=[K.difference({points:square},[{points:P([[0,5],[4,7],[4,3]])}]),K.difference({points:square},[{points:P([[0,1],[1,0],[2,1],[1,2]])}]),K.difference({points:P([[0,0],[7,0],[7,9],[0,9]])},[{points:P([[0,6],[2,6],[2,8],[0,8]])},{points:P([[0,5],[4,7],[2,0]])}])];
 for(const regions of cases)for(const r of regions){const expected=K.area(r);for(let d=0;d<360;d++){const a=d*Math.PI/180+.0123,c=Math.cos(a),s=Math.sin(a),R=q=>p(3.1+c*q.x-s*q.y,-2.7+s*q.x+c*q.y);
  const t=K.triangles(r.points.map(R),r.holes.map(h=>h.map(R))),total=t.triangles.reduce((sum,ids)=>sum+Math.abs(K.signedArea(ids.map(i=>t.points[i]))),0);assert.ok(Math.abs(total-expected)<1e-6,`rotation ${d}`);}}
 // The same region on tilted planes at house elevation, as validateFace sees it.
 const [region]=cases[2],unit=v=>{const l=Math.hypot(v.x,v.y,v.z);return p(v.x/l,v.y/l,v.z/l);},cross=(a,b)=>p(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);
 for(let ai=0;ai<36;ai++)for(const tilt of [.3,.6,.9,1.2,1.4,Math.PI/2]){const az=ai*Math.PI/18,n=unit(p(Math.cos(az)*Math.sin(tilt),Math.sin(az)*Math.sin(tilt),Math.cos(tilt))),u=unit(Math.abs(n.z)<.9?cross(p(0,0,1),n):cross(p(1,0,0),n)),v=cross(n,u),lift=q=>p(2.3+u.x*q.x+v.x*q.y,-4.1+u.y*q.x+v.y*q.y,161.3+u.z*q.x+v.z*q.y);
  assert.doesNotThrow(()=>K.validateFace({points:region.points.map(lift),holes:region.holes.map(h=>h.map(lift))}),`azimuth ${ai*10} tilt ${tilt}`);}
});

test('#29 a vertex beside its own edge is a spike, not a pinch',()=>{
 // A clipped roof region from the layered-turrets fixture, one grid step wide at its base.
 const t=K.triangles(P([[8.498295,-5.889721],[8.498294,-5.889721],[8.498572,-5.89]]));assert.equal(t.triangles.length,1);
});

test('#29 a triangular opening touching a gable wall side renders after grid rounding',()=>{
 for(let deg=0;deg<360;deg+=30)for(const tipZ of [1.1,1.5,1.9])for(const apex of [5.6,6.71,7.82,9.3,11.89]){
  const a=deg*Math.PI/180,u={x:Math.cos(a),y:Math.sin(a)},lift=(s,h)=>p(2.4+u.x*s,-5.3+u.y*s,161.3+h);
  const wall={id:'gable',points:[lift(0,0),lift(6,0),lift(6,2.5),lift(3,apex),lift(0,2.5)]},sticker={id:'win',feature:{type:'window'},points:[lift(0,tipZ),lift(1.5,tipZ+1),lift(1.5,tipZ-1)]};
  for(const part of M.cutOpenings(wall,[sticker])){const frame=W.faceFrame(part),local=q=>W.inFrame(frame,q);
   assert.doesNotThrow(()=>K.triangles(part.points.map(local),(part.holes||[]).map(r=>r.map(local))),`render ${deg} ${tipZ} ${apex}`);assert.doesNotThrow(()=>K.validateFace(part));}
 }
});

test('#30 results with a repeated corner or sub-grid width are rejected before publication',()=>{
 const cap={id:'c',points:[p(0,0,0),p(1,0,0),p(1,0,1)]};
 assert.throws(()=>M.validateResult({cap,sides:[{id:'t',points:[p(0,0,0),p(1e-8,0,0),p(0,0,2)]}]}),/zero-area face/);
 assert.throws(()=>M.validateResult({cap:{id:'s',points:[p(0,0,0),p(5,0,0),p(5,0,5e-7),p(0,0,5e-7)]}}),/zero-area face/);
 assert.doesNotThrow(()=>M.validateResult({cap:{id:'d',points:[p(0,0,0),p(4,0,0),p(4,0,2),p(0,0,0)]}}),'a closing repeat of a real triangle is still three corners');
 // A generated wall 1.5 um wide (layered-turrets fixture) is refused up front.
 const sliver={id:'sliver',points:[p(3.320762,4.045946,64),p(3.3207609,4.0459449,64),p(3.3207609,4.0459449,67.0117),p(3.320762,4.045946,67.0117)]};
 assert.throws(()=>M.createExtrusion({face:sliver,scene:[]}),/no area/);
});

test('#30 roof-clipped saved-house sweeps publish no seam slivers',()=>{
 const {state,faces,base}=savedHouse('exterior-engine-saved.json');
 for(const [id,amounts] of [['draft:R14:0:wall-region-0',[-3,-1.5,-.1]],['draft:R15.0:0:wall-region-0',[.3048,1]],['draft:R15.2:0:wall-region-0',[-2,1.3]],['draft:R7.0:0:base-face-6',[-1]]]){
  const face=faces.find(f=>f.id===id);assert.ok(face,id);const engine=M.createExtrusion({face,scene:faces,base,roof:state.roof});
  for(const amount of amounts){const r=engine.preview(amount);for(const f of [r.cap,...r.sides].filter(f=>f&&!f.deleted&&!f.curvedSurface))assert.ok(area3(f.points)>=1e-5,`${id} at ${amount}: ${f.id} ${area3(f.points)}`);M.validateResult(r);}
 }
});

test('#31 a sliver collapsed on the grid no longer fails the boolean',()=>{
 const ring=[[0,0],[-955196,-10],[0,0],[44300,-10]].map(([x,y])=>p(x*1e-6,y*1e-6));
 assert.deepEqual(K.difference({points:ring,holes:[]},[]),[]);
 const {state,faces,base}=savedHouse('exterior-engine-reloaded.json'),face=faces.find(f=>f.id==='draft:R13:0|R8.0:0|gap-fill-1.0:0:wall-region-0'),engine=M.createExtrusion({face,scene:faces,base,roof:state.roof});
 for(const amount of [-1.59,-1.595,-1.597,-1.6,-1.61])assert.doesNotThrow(()=>engine.preview(amount),String(amount));
});

test('#34 a vertical or zero-area roof face does not break roof-clipped extrusion',()=>{
 const wall={id:'w',points:[p(0,0,0),p(4,0,0),p(4,0,2.5),p(0,0,2.5)]},slope={id:'r1',points:[p(-1,-1,2.5),p(5,-1,2.5),p(5,3,4),p(-1,3,4)]};
 const reference=M.createExtrusion({face:wall,scene:[],roof:{faces:[slope]}}).preview(.5);
 for(const extra of [{id:'v',points:[p(20,20,3),p(24,20,3),p(24,20,5),p(20,20,5)]},{id:'d',points:[p(20,20,3),p(22,20,3),p(24,20,3)]}]){
  const r=M.createExtrusion({face:wall,scene:[],roof:{faces:[slope,extra]}}).preview(.5);assert.equal(JSON.stringify(r),JSON.stringify(reference),extra.id);
 }
});

test('#35 a repeated vertex in the extruded face sweeps no zero-length return',()=>{
 const b0=p(0,0,0),face={id:'wall:tri',points:[b0,p(4,0,0),p(4,0,2),{...b0}]},roof={faces:[{id:'r',points:[p(-5,-5,3),p(9,-5,3),p(9,5,3.5),p(-5,5,3.5)]}]};
 for(const withRoof of [false,true])for(const amount of [-.3,.3]){const r=M.createExtrusion({face,scene:[],...(withRoof?{roof}:{})}).preview(amount);assert.equal(r.sides.length,3);assert.ok(r.sides.every(f=>K.frame(f)));}
});

test('#36 a slightly leaning wall is still clipped by the roof',()=>{
 const roof={faces:[{id:'r',points:[p(-2,-3,5.4),p(6,-3,5.4),p(6,2,1.4),p(-2,2,1.4)]}]},roofZ=q=>3-.8*q.y;
 for(const lean of [0,.001,.03]){const wall={id:'w',points:[p(0,0,0),p(4,0,0),p(4,-lean,2.5),p(0,-lean,2.5)]},r=M.createExtrusion({face:wall,scene:[],roof}).preview(-1);
  assert.ok(Math.max(...[r.cap,...r.sides].filter(f=>!f.deleted).flatMap(f=>f.points).map(q=>q.z-roofZ(q)))<1e-6,`lean ${lean}`);}
 assert.equal(W.horizontalSweep(p(0,.9,Math.sin(3*Math.PI/180))),false,'steeper faces are not walls');
});

test('#36 a leaning wall stays planar when its ground contact follows a pitched base',()=>{
 const g=q=>.05*q.y,base={faces:[{id:'b',points:[p(-5,-5,g(p(0,-5))),p(9,-5,g(p(0,-5))),p(9,5,g(p(0,5))),p(-5,5,g(p(0,5)))]}]};
 const wall={id:'w',points:[p(0,0,0),p(4,0,0),p(4,-.002,2.5),p(0,-.002,2.5)]};
 for(const amount of [-.6,.6]){const r=M.createExtrusion({face:wall,scene:[],base}).preview(amount);K.validateFace(r.cap);
  const bottom=r.cap.points.filter(q=>q.z<1);assert.equal(bottom.length,2);for(const q of bottom)assert.ok(Math.abs(q.z-g(q))<1e-9,'ground contact on the base');}
});

test('#32 an unhosted wall leaves its ground edge to the base, and sweeps it without one',()=>{
 const wall={id:'w',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(0,0,3)]},left={id:'l',points:[p(0,0,0),p(0,0,3),p(0,4,3),p(0,4,0)]},base={faces:[{id:'b',points:[p(0,0,0),p(4,0,0),p(4,4,0),p(0,4,0)]}]};
 const ground=f=>f.points.every(q=>Math.abs(q.z)<1e-9);
 for(const amount of [-.5,.5]){
  assert.ok(!M.createExtrusion({face:wall,scene:[wall,left],base}).preview(amount).sides.some(ground),'no return on the base plane');
  assert.ok(M.createExtrusion({face:wall,scene:[wall,left]}).preview(amount).sides.some(ground),'without a base the whole boundary sweeps');
 }
 const floor={id:'f',points:[p(1,1,0),p(3,1,0),p(3,3,0),p(1,3,0)]};
 assert.equal(M.createExtrusion({face:floor,scene:[],base}).preview(.4).sides.length,4,'a face lying on the ground still sweeps every edge');
});
