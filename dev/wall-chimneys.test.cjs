const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z=5)=>({x,y,z});
const box=(x0,y0,x1,y1,z=0)=>[p(x0,y0,z),p(x1,y0,z),p(x1,y1,z),p(x0,y1,z)];
function roof(points,closed=true){return {points,connections:points.slice(0,closed?points.length:-1).map((_,i)=>({startIdx:i,endIdx:(i+1)%points.length,type:['chimney_back','chimney_edge','chimney_front','chimney_edge'][i%4]})),faces:[]};}
function fixture(points=box(8,4,12,6,5),closed=true){const base=box(0,0,10,10),walls=base.map((a,i)=>({id:'w'+i,targetId:'ground',bottom:[a,base[(i+1)%4]],top:[{...a,z:5},{...base[(i+1)%4],z:5}]})),r=roof(points,closed),state={roof:r,chimneys:C.detect(r),base:{faces:[{points:base}]},wallEdits:{},options:{ground:0}};return {state,walls};}
const polygon=w=>({id:w.id,chimney:w.chimney,points:[w.bottom[0],w.bottom[1],w.top[1],w.top[0]],holes:[]});
function area(f){const frame=W.faceFrame(f),ps=f.points.map(p=>W.inFrame(frame,p));return Math.abs(ps.reduce((sum,p,i)=>sum+p.x*ps[(i+1)%ps.length].y-p.y*ps[(i+1)%ps.length].x,0))/2;}
test('closed chimney is retained and splits siding into exposed chimney walls',()=>{const {state,walls}=fixture(),result=C.compose(walls,state),shell=result.filter(w=>w.chimney);assert.equal(state.chimneys.items.length,1);assert.equal(shell.length,3);assert.equal(result.filter(w=>!w.chimney).length,5);assert.equal(shell.reduce((s,w)=>s+area(polygon(w)),0),30);assert.ok(shell.every(w=>w.bottom.every(p=>p.z===0)));assert.equal(result.filter(w=>!w.chimney).reduce((s,w)=>s+area(polygon(w)),0),190);});
test('three-sided roof chimney extends by the same depth beyond the open roof crossing',()=>{const {state,walls}=fixture([p(10,4),p(8,4),p(8,6),p(10,6)],false);assert.equal(state.chimneys.warnings.length,0);assert.equal(state.chimneys.items[0].inferred,true);assert.deepEqual([...new Set(state.chimneys.items[0].points.map(p=>p.x))].sort((a,b)=>a-b),[8,12]);assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,3);});
test('rotation, reversed line ordering, and split/duplicate endpoints do not alter detection',()=>{const angle=.31,rotate=p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z}),r=roof([p(10,4),p(9,4),p(8,4),p(8,6),p(10,6)].map(rotate),false);r.connections.reverse();r.connections.push({...r.connections[0]});const d=C.detect(r);assert.equal(d.items.length,1);assert.equal(d.items[0].points.length,4);assert.ok(Math.abs(Math.abs(d.items[0].points.reduce((s,p,i,ps)=>s+p.x*ps[(i+1)%4].y-p.y*ps[(i+1)%4].x,0)/2)-8)<1e-6);});
test('internal volumes remain stored and become exposed after editing the base footprint',()=>{const {state,walls}=fixture(box(4,4,6,6,5));assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,0);state.wallEdits.$base={faces:[{points:box(0,0,5,10)}]};assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,3);assert.equal(state.chimneys.items.length,1);});
test('chimney bottom follows a pitched base including its plane beyond the perimeter',()=>{const {state,walls}=fixture();state.base.faces[0].points.forEach(p=>p.z=1+p.y*.1);for(const w of C.compose(walls,state).filter(w=>w.chimney))for(const p of w.bottom)assert.ok(Math.abs(p.z-(1+p.y*.1))<1e-6);});
test('ambiguous branches and incomplete outlines are not silently invented',()=>{const r=roof([p(0,0),p(1,0),p(1,1)],false);assert.equal(C.detect(r).items.length,0);assert.ok(C.detect(r).warnings.length);r.points.push(p(1,-1));r.connections.push({startIdx:1,endIdx:3,type:'chimney_edge'});assert.equal(C.detect(r).items.length,0);assert.ok(C.detect(r).warnings.length);});
test('moving a front side updates the closed volume without changing roof source points',()=>{const {state,walls}=fixture(),original=JSON.stringify(state.roof),shell=C.compose(walls,state).filter(w=>w.chimney),front=shell.find(w=>w.bottom.every(p=>p.x===12)),before=JSON.stringify(C.compose(walls,state));C.moveSide(state,front.chimney,{x:-1,y:0,z:0});assert.equal(Math.max(...C.definitions(state)[0].points.map(p=>p.x)),11);assert.equal(C.compose(walls,state).filter(w=>w.chimney).reduce((s,w)=>s+area(polygon(w)),0),20);assert.equal(JSON.stringify(state.roof),original);state.wallEdits={};assert.equal(JSON.stringify(C.compose(walls,state)),before);});
test('normal M surface output drives the footprint and survives save/reload',()=>{const {state,walls}=fixture(),shell=C.compose(walls,state).filter(w=>w.chimney),front=polygon(shell.find(w=>w.bottom.every(p=>p.x===12)));front.chimney={...front.chimney,drivesFootprint:true};const moved=W.moveFabric(shell.map(w=>w.id===front.id?front:polygon(w)),front.id,-1);state.wallEdits.$surfaces=moved.faces;const def=C.definitions(state)[0];assert.equal(Math.max(...def.points.map(p=>p.x)),11);assert.equal(C.definitions(JSON.parse(JSON.stringify(state)))[0].points[1].x,def.points[1].x);});
test('preexisting drafted faces are clipped without destroying their stored split points',()=>{const {state,walls}=fixture(),face=polygon(walls[1]),original=JSON.stringify(face),parts=C.visibleParts(face,state);assert.equal(parts.length,2);assert.equal(parts.reduce((s,f)=>s+area(f),0),40);assert.equal(JSON.stringify(face),original);});
test('invalid side moves are atomic',()=>{const {state,walls}=fixture(),front=C.compose(walls,state).find(w=>w.chimney&&w.bottom.every(p=>p.x===12)),before=JSON.stringify(state);assert.throws(()=>C.moveSide(state,front.chimney,{x:-5,y:0,z:0}));assert.equal(JSON.stringify(state),before);});

test('a roof slope stops at the crossing instead of lifting the exposed chimney through the roof',()=>{const {state,walls}=fixture([p(10,4,5),p(8,4,6),p(8,6,6),p(10,6,5)],false);for(const w of C.compose(walls,state).filter(w=>w.chimney))for(const p of w.top)assert.ok(Math.abs(p.z-5)<1e-6);});
test('wall material above the chimney volume and its wire are preserved',()=>{const {state,walls}=fixture();walls.forEach(w=>w.top.forEach(p=>p.z=7));assert.equal(C.compose(walls,state).filter(w=>!w.chimney).reduce((s,w)=>s+area(polygon(w)),0),270);assert.equal(C.visibleParts(polygon(walls[1]),state).reduce((s,f)=>s+area(f),0),60);assert.equal(C.visibleSegments(p(10,5,0),p(10,5,7),state)[0][0].z,5);});

test('wall faces, edges and points stop at the complete upper chimney shaft',()=>{
 const {state,walls}=fixture();C.syncVolumes(state);walls.forEach(w=>w.top.forEach(p=>p.z=7));
 const cap=state.wallEdits.$surfaces.find(f=>f.chimney.cap),height=cap.points[0].z;
 const inside=C.compose(walls,state).filter(w=>!w.chimney&&w.bottom.every(p=>p.x===10&&p.y>=4&&p.y<=6));
 assert.equal(inside.length,1);inside[0].bottom.forEach(p=>assert.ok(Math.abs(p.z-height)<1e-8));
 assert.ok(Math.abs(C.visibleParts(polygon(walls[1]),state).reduce((s,f)=>s+area(f),0)-(70-2*height))<1e-8);
 const edge=C.visibleSegments(p(10,3,5.1),p(10,7,5.1),state);assert.equal(edge.length,2);assert.equal(edge[0][1].y,4);assert.equal(edge[1][0].y,6);
 assert.deepEqual(C.visibleSegments(p(10,5,5.1),p(10,5,5.1),state),[]);
 assert.equal(C.visibleSegments(p(10,4.2,6),p(10,5.8,6),state).length,1,'geometry above the actual cap remains visible');
 const covered={points:[p(10,4.2,5.01),p(10,5.8,5.01),p(10,5.8,5.2),p(10,4.2,5.2)]};assert.deepEqual(C.visibleParts(covered,state),[]);
 covered.joinedChimneys=[state.chimneys.items[0].id];assert.deepEqual(C.visibleParts(covered,state),[covered],'intentional explicit fills retain their override');
});

test('chimney clipping follows the edited cap and retains the shaft when just its lid is deleted',()=>{
 const {state}=fixture();C.syncVolumes(state);const cap=state.wallEdits.$surfaces.find(f=>f.chimney.cap);
 cap.points.forEach(p=>p.z=6+p.y*.1);
 assert.ok(Math.abs(C.visibleSegments(p(10,5,0),p(10,5,8),state)[0][0].z-6.5)<1e-8);
 cap.deleted=true;assert.ok(Math.abs(C.visibleSegments(p(10,5,0),p(10,5,8),state)[0][0].z-5.3048)<1e-8);
 state.wallEdits.$surfaces.forEach(f=>f.deleted=true);
 assert.equal(C.visibleSegments(p(10,5,0),p(10,5,8),state)[0][0].z,5,'removing the entire upper shaft restores the roof-height volume');
});

test('a cap edited through a face draft still defines chimney clipping height',()=>{
 const {state}=fixture();C.syncVolumes(state);const cap=state.wallEdits.$surfaces.find(f=>f.chimney.cap);
 cap.drafted=true;const frame=W.faceFrame({...cap,points:cap.points.map(p=>({...p,z:6.5}))});
 const points=cap.points.map((p,i)=>({...W.inFrame(frame,{...p,z:6.5}),nodeId:'p'+i}));
 state.wallEdits.$drafts={cap:{frame,chimney:cap.chimney,faces:[{points}]}};
 assert.ok(Math.abs(C.visibleSegments(p(10,5,0),p(10,5,8),state)[0][0].z-6.5)<1e-8);
 state.wallEdits.$drafts.cap.deletedFaces=[points.map(p=>p.nodeId).sort().join('|')];
 assert.ok(Math.abs(C.visibleSegments(p(10,5,0),p(10,5,8),state)[0][0].z-5.3048)<1e-8);
});
test('selecting a moved chimney as a new draft and deleting its visible face retain the volume override',()=>{const {state,walls}=fixture(),front=polygon(C.compose(walls,state).find(w=>w.chimney&&w.bottom.every(p=>p.x===12)));front.chimney.drivesFootprint=true;front.points.forEach(p=>p.x=11);front.drafted=true;state.wallEdits.$surfaces=[front];assert.equal(Math.max(...C.definitions(state)[0].points.map(p=>p.x)),11);front.deleted=true;assert.equal(Math.max(...C.definitions(state)[0].points.map(p=>p.x)),11);});
test('a manual opening remains a hole when the surrounding wall is clipped by a chimney',()=>{const {state,walls}=fixture(),f=polygon(walls[1]);f.holes=[[p(10,1,1),p(10,2,1),p(10,2,2),p(10,1,2)]];const pieces=C.visibleParts(f,state);assert.equal(pieces.reduce((n,p)=>n+(p.holes?.length||0),0),1);});
test('extruded chimney returns retain their material identity without becoming footprint drivers',()=>{const {state,walls}=fixture(),front=polygon(C.compose(walls,state).find(w=>w.chimney&&w.bottom.every(p=>p.x===12)));const result=W.extrude(front,.5);assert.ok(result.sides.length);assert.ok(result.sides.every(f=>f.chimney.id===front.chimney.id&&!f.chimney.drivesFootprint));});

test('an internal chimney remains hidden when a wall-only edit leaves its footprint inside the house',()=>{const {state,walls}=fixture(box(4,4,6,6,5));state.wallEdits.$drafts=Object.fromEntries(walls.map(w=>[w.id,{members:[w.id],origin:w.bottom[0],u:{x:1,y:0},faces:[{points:[],solidId:'replacement'}]}]));const lower=box(0,0,5,10),upper=box(0,0,10,10);state.wallEdits.$surfaces=[...lower.map((a,i)=>({id:'lower-'+i,points:[{...a,z:0},{...lower[(i+1)%4],z:0},{...lower[(i+1)%4],z:2},{...a,z:2}]})),...upper.map((a,i)=>({id:'upper-'+i,points:[{...a,z:2},{...upper[(i+1)%4],z:2},{...upper[(i+1)%4],z:5},{...a,z:5}]}))];const base=JSON.stringify(state.base),shell=C.compose(walls,state).filter(w=>w.chimney);assert.equal(shell.length,0);assert.equal(JSON.stringify(state.base),base);});

test('chimney visibility clips tapered walls with a repeated closing corner and leaves unaffected faces intact',()=>{
 const {state}=fixture(),f={points:[p(10,3,0),p(10,7,0),p(10,7,4),p(10,3,0)]},before=JSON.stringify(f),parts=C.visibleParts(f,state);
 assert.ok(parts.length);assert.ok(parts.reduce((s,f)=>s+area(f),0)<area(f));assert.equal(JSON.stringify(f),before);
 const elsewhere={points:f.points.map(q=>({...q,x:q.x+20}))};assert.equal(C.visibleParts(elsewhere,state)[0],elsewhere);
});

test('unrelated wall elevations do not subdivide a rectangular chimney shaft',()=>{
 const {state,walls}=fixture();
 state.wallEdits.$surfaces=Array.from({length:30},(_,i)=>({id:'remote-'+i,points:[p(100,100,i/8),p(100,101,i/8),p(100,101,i/8+.1),p(100,100,i/8+.1)]}));
 const before=JSON.stringify(state.wallEdits),shell=C.compose(walls,state).filter(w=>w.chimney);
 assert.equal(shell.length,3);assert.equal(shell.reduce((s,w)=>s+area(polygon(w)),0),30);assert.equal(JSON.stringify(state.wallEdits),before);
});

test('legacy chimney draft repair separates side ownership and preserves manually drawn points',()=>{
 const d={chimney:{id:'chimney',side:1},members:['chimney:side-0','chimney:side-1','chimney:side-1:part-1','chimney:side-2'],faces:[{points:box(0,0,2,4)}],sketch:{outlines:[box(0,0,2,4)],edges:[{a:'user-connected',b:'corner'}],nodes:[{id:'generated',x:0,y:1,fixed:false},{id:'user-connected',x:0,y:2,fixed:false},{id:'user-placed',x:0,y:3,fixed:false,userDraftPoint:true},{id:'interior',x:1,y:2,fixed:false},{id:'corner',x:0,y:0,fixed:true}]}},edits={$drafts:{side:d}},geometry=JSON.stringify(d.faces);
 C.normalizeDrafts(edits);assert.deepEqual(d.members,['chimney:side-1','chimney:side-1:part-1']);assert.equal(d.sketch.nodes.length,5);assert.equal(d.sketch.nodes.filter(n=>n.generatedBoundary).length,1);assert.equal(d.sketch.nodes[0].generatedBoundary,true);assert.equal(JSON.stringify(d.faces),geometry);const once=JSON.stringify(edits);C.normalizeDrafts(edits);assert.equal(JSON.stringify(edits),once);
});


test('generated upper chimney starts at the roof and reaches a flat cap one foot above its highest roof contact',()=>{
 const {state,walls}=fixture(box(4,4,6,6,5));state.roof.faces=[{id:'slope',points:box(0,0,10,10).map(p=>({...p,z:5+p.x/4}))}];
 const source=JSON.stringify(state.roof);C.syncVolumes(state);
 const faces=state.wallEdits.$surfaces,cap=faces.find(f=>f.chimney.cap);
 assert.equal(faces.length,5);assert.ok(cap.points.every(p=>Math.abs(p.z-6.8048)<1e-8));
 assert.ok(faces.filter(f=>!f.chimney.cap).every(f=>f.points.slice(0,-2).every(p=>Math.abs(p.z-5-p.x/4)<1e-8)));
 assert.ok(faces.every(f=>C.visibleParts(f,state).length===1));
 assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,0,'shaft is not duplicated by old generated strips');
 const roof=C.roofWithOpenings(state);assert.equal(roof.faces.length,1);assert.equal(roof.faces[0].holes.length,1);
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');assert.equal(K.area(roof.faces[0]),96);
 assert.ok(roof.faces[0].holes[0].every(p=>Math.abs(p.z-5-p.x/4)<1e-8));assert.equal(JSON.stringify(state.roof),source);
 const before=JSON.stringify(state);C.syncVolumes(state);assert.equal(JSON.stringify(state),before);
});
test('chimney height accounts for a roof ridge crossing its footprint, not just the corners',()=>{
 const {state}=fixture(box(4,4,6,6,5));state.roof.faces=[{points:box(0,0,5,10).map(p=>({...p,z:5+p.x/5}))},{points:box(5,0,10,10).map(p=>({...p,z:7-p.x/5}))}];
 C.syncVolumes(state);const cap=state.wallEdits.$surfaces.find(f=>f.chimney.cap);assert.ok(cap.points.every(p=>Math.abs(p.z-6.3048)<1e-8));
 assert.equal(C.roofWithOpenings(state).faces.length,2);
});
test('ordinary face move raises the chimney cap and stretches all four walls; reload retains edits and deletions',()=>{
 const {state}=fixture(box(4,4,6,6,5));C.syncVolumes(state);const faces=state.wallEdits.$surfaces,cap=faces.find(f=>f.chimney.cap),bottom=faces.filter(f=>!f.chimney.cap).flatMap(f=>f.points.filter(p=>p.z===5));
 const result=W.moveSurface(faces,cap.id,.9144);state.wallEdits.$surfaces=result.faces;
 const moved=result.faces.find(f=>f.id===cap.id);assert.ok(moved.points.every(p=>Math.abs(p.z-6.2192)<1e-8));
 assert.ok(result.faces.filter(f=>!f.chimney.cap).every(f=>f.points.filter(p=>p.z>5).every(p=>Math.abs(p.z-6.2192)<1e-8)));
 assert.equal(result.faces.flatMap(f=>f.points.filter(p=>p.z===5)).length,bottom.length);
 moved.deleted=true;const reloaded=JSON.parse(JSON.stringify(state)),before=JSON.stringify(reloaded);C.syncVolumes(reloaded);assert.equal(JSON.stringify(reloaded),before);
});
test('chimney side moves update its roof opening through the same footprint metadata',()=>{
 const {state}=fixture(box(4,4,6,6,5));state.roof.faces=[{points:box(0,0,10,10,5)}];C.syncVolumes(state);const face=state.wallEdits.$surfaces.find(f=>f.chimney.side===1);
 state.wallEdits.$surfaces=W.moveSurface(state.wallEdits.$surfaces,face.id,.5).faces;
 assert.equal(Math.max(...C.definitions(state)[0].points.map(p=>p.x)),6.5);
 assert.equal(Math.max(...C.roofWithOpenings(state).faces[0].holes[0].map(p=>p.x)),6.5);
});

test('existing edited shafts receive an upper extension without duplicating or resetting their lower faces',()=>{
 const {state,walls}=fixture();const old=C.compose(walls,state).filter(w=>w.chimney).map(polygon);state.wallEdits.$surfaces=old;
 const oldJSON=JSON.stringify(old),oldCount=old.length;C.syncVolumes(state);const generated=state.wallEdits.$surfaces.filter(f=>f.chimney.volume);
 assert.equal(generated.length,5);assert.ok(generated.every(f=>f.points.every(p=>p.z>=5)));
 assert.equal(JSON.stringify(state.wallEdits.$surfaces.slice(0,oldCount)),oldJSON);
 assert.equal(state.wallEdits.$chimneyVolumes[state.chimneys.items[0].id].mode,'upper');
});

test('deleting a coplanar chimney/wall divider retains the joined face and all outer edges',()=>{
 const {state}=fixture(box(8,0,12,2,5)),id=state.chimneys.items[0].id;
 const left={id:'house',material:'siding',finishColor:'#abcdef',points:[p(0,0,0),p(8,0,0),p(8,0,5),p(0,0,5)],holes:[]},right={id:'chimney',chimney:{id,side:0},material:'siding',finishColor:'#abcdef',points:[p(8,0,0),p(12,0,0),p(12,0,5),p(8,0,5)],holes:[]};
 const result=W.removeFaceEdges([left,right],[[p(8,0,0),p(8,0,5)]]);assert.equal(result.merged.length,1);assert.equal(result.removed.length,2);const merged=JSON.parse(JSON.stringify(result.merged[0]));assert.equal(area(merged),60);assert.equal(merged.material,'siding');assert.equal(merged.finishColor,'#abcdef');assert.deepEqual(merged.joinedChimneys,[id]);assert.equal(merged.chimney,undefined);
 assert.equal(C.visibleParts(merged,state).reduce((n,f)=>n+area(f),0),60);for(let i=0;i<merged.points.length;i++){const a=merged.points[i],b=merged.points[(i+1)%merged.points.length];assert.deepEqual(C.visibleSegments(a,b,state,merged.chimney,merged.joinedChimneys),[[a,b]]);}
 const groups=W.mergeConnectedFaces([left,right]);assert.equal(groups.length,1);assert.equal(C.visibleParts(groups[0].pieces[0],state).reduce((n,f)=>n+area(f),0),60);
 const ordinary={...merged,joinedChimneys:[]};assert.ok(C.visibleParts(ordinary,state).reduce((n,f)=>n+area(f),0)<60,'unjoined walls still clip against the chimney');
});

test('saved overlapping chimney seam merges the coplanar wall despite a perpendicular side and roof crossing',()=>{
 const input=require('./fixtures/chimney-overlapping-wall.json'),before=JSON.stringify(input),result=W.removeFaceEdges(input.faces,[input.pair]),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 assert.equal(result.merged.length,1);assert.deepEqual(result.removed,input.faces.slice(0,2).map(f=>f.id));assert.ok(!result.removed.includes(input.faces[2].id));
 const merged=result.merged[0];K.validateFace(merged);const frame=W.faceFrame(merged),expected=K.union(input.faces.slice(0,2).map(f=>({points:f.points.map(p=>W.inFrame(frame,p)),holes:[]}))).reduce((s,f)=>s+K.area(f),0);assert.ok(Math.abs(area(merged)-expected)<1e-6);
 assert.ok(W.sharedIntervals(...input.pair,[merged]).some(([lo,hi])=>hi-lo>0),'outer portion above the wall stays defined');assert.equal(JSON.stringify(input),before);
});

test('roof split hides the rear lower chimney and keeps exposed lower sides meeting upper sides',()=>{
 const {state,walls}=fixture();state.roof.faces=[{points:box(0,0,10,10,5)}];C.syncVolumes(state);const c=C.definitions(state)[0],upper=state.wallEdits.$surfaces.filter(f=>!f.chimney.cap),lower=C.compose(walls,state).filter(w=>w.chimney);
 assert.equal(upper.length,4);assert.equal(lower.length,3);assert.ok(upper.every(f=>f.points.every(p=>p.z>=5)));assert.ok(lower.every(w=>w.top.every(p=>p.z<=5)));assert.ok(!lower.some(w=>w.bottom.every(p=>p.x===8)),'rear side inside the house is absent');
 const before=JSON.stringify(state);C.syncVolumes(state);assert.equal(JSON.stringify(state),before);
});

test('mixed wall/chimney draft ownership survives load, including older pruned owners',()=>{
 for(const pruned of [false,true]){
  const members=['wall','c:side-0','c:side-0:part-1'],key=members.join('|'),faces=[{id:'region',points:box(0,0,3,4)}];
  const edits={$drafts:{[key]:{chimney:{id:'c',side:0},members:pruned?members.slice(1):[...members],faces}}};
  C.normalizeDrafts(edits);const d=edits.$drafts[key];assert.deepEqual([...d.members].sort(),[...members].sort());assert.equal(d.chimney,undefined);assert.deepEqual(d.joinedChimneys,['c']);assert.deepEqual(d.faces,faces);
  const once=JSON.stringify(edits);C.normalizeDrafts(edits);assert.equal(JSON.stringify(edits),once);
 }
});
test('legacy full shafts migrate at the roof without resetting custom cap height or finish',()=>{
 const {state,walls}=fixture(),c=state.chimneys.items[0];state.wallEdits.$chimneyVolumes={[c.id]:{version:1,mode:'full'}};state.wallEdits.$surfaces=c.points.map((p,i)=>({id:c.id+':volume-side-'+i,chimney:{id:c.id,side:i,volume:true,drivesFootprint:true},material:'stucco',finishColor:'#abcdef',points:[{...p,z:0},{...c.points[(i+1)%4],z:0},{...c.points[(i+1)%4],z:7},{...p,z:7}],holes:[]}));
 C.syncVolumes(state);assert.equal(state.wallEdits.$chimneyVolumes[c.id].mode,'upper');assert.ok(state.wallEdits.$surfaces.every(f=>Math.min(...f.points.map(p=>p.z))===5&&Math.max(...f.points.map(p=>p.z))===7&&f.material==='stucco'&&f.finishColor==='#abcdef'));assert.equal(C.compose(walls,state).filter(w=>w.chimney).length,3);
});


test('captured merged wall uses the same roof contact as the upper chimney',()=>{
 const state=structuredClone(require('./fixtures/merged-chimney-roof-contact.json'));
 const wall=state.wallEdits.$surfaces.find(f=>f.id.startsWith('region-R4'));
 const corner=f=>f.points.find(p=>Math.abs(p.x-8.495090542)<1e-5&&Math.abs(p.z-162.57)<.01);
 const chimney=state.wallEdits.$surfaces.find(f=>f.id.endsWith(':volume-side-2'));
 assert.ok(Math.abs(corner(wall).z-corner(chimney).z)>.0024);
 const ids=state.wallEdits.$surfaces.map(f=>f.id),count=wall.points.length;
 C.alignRoofContacts(state);assert.deepEqual(corner(wall),corner(chimney));
 assert.equal(wall.points.length,count);assert.deepEqual(state.wallEdits.$surfaces.map(f=>f.id),ids);
 const before=JSON.stringify(state);C.alignRoofContacts(state);assert.equal(JSON.stringify(state),before);
});

test('roof-contact repair preserves nearby deliberate points away from the old clipping height',()=>{
 const state=structuredClone(require('./fixtures/merged-chimney-roof-contact.json'));
 const wall=state.wallEdits.$surfaces.find(f=>f.id.startsWith('region-R4'));
 const corner=wall.points.find(p=>Math.abs(p.x-8.495090542)<1e-5&&Math.abs(p.z-162.57)<.01);
 corner.z+=.001;const before=JSON.stringify(wall);C.alignRoofContacts(state);assert.equal(JSON.stringify(wall),before);
});


test('new wall cuts and selectable segments meet the actual roof instead of the chimney reference plane',()=>{
 const {state,walls}=fixture();state.roof.faces=[{points:box(0,0,14,10,5.01)}];walls.forEach(w=>w.top.forEach(p=>p.z=6));
 const result=C.compose(walls,state),over=result.filter(w=>!w.chimney&&w.bottom.every(p=>p.x===10&&p.y>=4&&p.y<=6));
 assert.ok(over.length);assert.ok(over.every(w=>w.bottom.every(p=>Math.abs(p.z-5.01)<1e-8)));
 const face={id:'wall',points:[p(10,4,0),p(10,6,0),p(10,6,6),p(10,4,6)]};
 const parts=C.visibleParts(face,state);assert.ok(parts.length);assert.ok(parts.every(f=>f.points.every(p=>p.z>=5.01-1e-8)));
 assert.deepEqual(C.visibleSegments(p(10,4.2,5.005),p(10,5.8,5.005),state),[]);
 assert.equal(C.visibleSegments(p(10,4.2,5.015),p(10,5.8,5.015),state).length,1);
});


test('previous explicit fills repair on load without disabling generated-wall clipping',()=>{
 const {state}=fixture();state.roof.faces=[{points:box(0,0,14,10,5)}];const points=[p(10,4,1),p(10,6,1),p(10,6,4),p(10,4,4)],filled={id:'filled-face-123',points},generated={id:'ordinary-wall',points:structuredClone(points)};state.wallEdits.$surfaces=[filled,generated];
 assert.equal(C.visibleParts(filled,state).length,0);C.syncVolumes(state);
 assert.deepEqual(C.visibleParts(filled,state),[filled]);assert.equal(C.visibleParts(generated,state).length,0);
 const before=JSON.stringify(state);C.syncVolumes(state);assert.equal(JSON.stringify(state),before);
});
