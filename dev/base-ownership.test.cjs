const test=require('node:test'),assert=require('node:assert/strict');
const path='../public/measure/internal/editor_scripts/';
const B=require(path+'base_geometry.js'),S=require(path+'base_sketch_geometry.js'),G=require(path+'wall_geometry.js'),F=require(path+'wall_base_binding.js'),C=require(path+'wall_chimneys.js'),K=require(path+'exterior_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),copy=structuredClone;
function graphIsSupported(base){
 const on=(p,f)=>{const pl=G.plane(f.points);return Math.abs(p.z-pl.dx*p.x-pl.dy*p.y-pl.k)<K.CONTACT&&G.contains(f,p);},nodes=base.sketch.nodes;
 for(const f of base.faces)for(const p of f.points)assert.ok(distance(p,nodes.find(n=>n.id===p.nodeId))<K.CONTACT,'face corner must reference its own height');
 for(const n of nodes)assert.ok(base.faces.some(f=>on(n,f)),'orphan graph node '+JSON.stringify(n));
 for(const e of base.sketch.edges){const a=nodes.find(n=>n.id===e.a),b=nodes.find(n=>n.id===e.b);assert.ok(base.faces.some(f=>[0,.25,.5,.75,1].every(t=>on(p(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t),f))),'edge crosses between base supports '+JSON.stringify([a,b]));}
 for(let i=0;i<nodes.length;i++)for(let j=0;j<i;j++)assert.ok(distance(nodes[i],nodes[j])>K.CONTACT,'duplicate same-height graph vertex');
 const keys=base.sketch.edges.map(e=>[e.a,e.b].sort().join('|'));assert.equal(new Set(keys).size,keys.length);
}
test('real chimney contact joins the base without losing its silhouette or reintroducing a draft seam',()=>{
 const state=copy(require('./fixtures/exterior-engine-reloaded.json')),base=state.wallEdits.$base||state.base,area=base.faces.reduce((n,f)=>n+K.area(f),0);
 C.syncFoundation(state,{force:true});assert.equal(base.faces.length,1);assert.ok(Math.abs(K.area(base.faces[0])-area)<.00001);assert.ok(base.chimneyFoundationParts.length);S.resolve(base);assert.equal(base.faces.length,1);graphIsSupported(base);
 const once=JSON.stringify(base);C.syncFoundation(state);assert.equal(JSON.stringify(base),once);
 // Point-only contacts must still be separate simple polygons.
 const square=(x,y)=>({points:[p(x,y),p(x+1,y),p(x+1,y+1),p(x,y+1)]});assert.equal(K.union([square(0,0),square(1,1)]).length,2);
});
test('cut, recess across the cut, pitch and raise keep each wire on its own base plane',()=>{
 let base={faces:[{id:'base',points:[p(0,0),p(12,0),p(12,8),p(0,8)]}]};S.ensure(base);S.connect(base,[S.add(base,p(6,0)),S.add(base,p(6,8))]);assert.equal(base.faces.length,2);
 const source={points:[p(2,0),p(8,0),p(8,0,3),p(2,0,3)]},cap={points:source.points.map(p=>({...p,y:p.y+1}))};base=B.extrudeWall(base,source,cap);assert.equal(base.faces.length,2);graphIsSupported(base);
 // Interior bottom anchor on a new recessed wall, plus a wall crossing both bases.
 let edits={$surfaces:[{id:'recess',points:[p(2,1),p(8,1),p(8,1,3),p(2,1,3)],retainedPoints:[p(3,1),p(7,1),p(3,1,2)]},{id:'back',points:[p(0,8),p(12,8),p(12,8,5),p(0,8,5)]}]};
 const first=base.faces.find(f=>G.contains(f,p(3,4))),id=first.id;
 for(const mode of ['pitch','raise']){const before=copy(base),face=base.faces.find(f=>f.id===id);Object.assign(face,mode==='pitch'?B.transform(face,'pitch',Math.tan(Math.PI/18),{x:0,y:1},B.center(face)):B.transform(face,'move',1.5));S.rebind(before,base);edits=F.follow(edits,before,base);graphIsSupported(base);}
 assert.equal(base.faces.length,2);const f=base.faces.find(f=>f.id===id),plane=G.plane(f.points),anchor=edits.$surfaces[0].retainedPoints.find(p=>Math.abs(p.x-3)<1e-7&&p.z!==2);assert.ok(anchor);assert.ok(Math.abs(anchor.z-plane.dx*3-plane.dy-plane.k)<1e-7);
 assert.ok(edits.$surfaces[0].retainedPoints.some(p=>p.x===7&&p.z===0));assert.ok(edits.$surfaces[0].retainedPoints.some(p=>p.x===3&&p.z===2));
 S.resolve(base);assert.equal(base.faces.length,2);graphIsSupported(base);
});
test('saved stale heights and detached chimney footprint upgrade without moving either user base plane',()=>{
 const state=copy(require('./fixtures/exterior-base-binding.json')),base=state.wallEdits.$base||state.base,planes=base.faces.slice(0,2).map(f=>G.plane(f.points));
 S.upgrade(base);C.syncFoundation(state);assert.equal(base.faces.length,2);graphIsSupported(base);
 for(let i=0;i<2;i++)for(const p of base.faces[i].points)assert.ok(Math.abs(p.z-planes[i].dx*p.x-planes[i].dy*p.y-planes[i].k)<1e-6);
 assert.equal(base.sketch.nodes.filter(p=>Math.abs(p.x+1.370405)<1e-5&&Math.abs(p.y+4.067051)<1e-5).length,2);
 const once=JSON.stringify(base);assert.equal(S.upgrade(base),false);C.syncFoundation(state);assert.equal(JSON.stringify(base),once);
});
test('draft conversion retains only anchors owned by the changed wall region',()=>{
 const base={faces:[{id:'base',points:[p(0,0),p(8,0),p(8,4),p(0,4)]}]},raised=copy(base);raised.faces[0].points.forEach(p=>p.z=1);
 const d={origin:p(0,0),u:{x:1,y:0},members:['front'],faces:[{id:'lower',points:[p(0,0),p(8,0),p(8,2),p(0,2)]},{id:'upper',points:[p(0,2),p(8,2),p(8,4),p(0,4)]}]};S.ensure(d);S.add(d,p(3,0));S.add(d,p(4,3));const next=F.follow({$drafts:{front:d}},base,raised),surface=next.$surfaces[0];
 assert.equal(next.$surfaces.length,1);assert.ok(surface.retainedPoints.some(p=>p.x===3&&p.z===1));assert.ok(surface.retainedPoints.every(p=>p.z<=2));assert.equal(next.$drafts.front.faces[1].solidId,undefined);
});
test('rounding-sized boundary intersections do not leave old-height wall corners after pitch and raise',()=>{
 const before={faces:[{id:'base',points:[p(0,0),p(8,0),p(8,4),p(0,4)]}]},tilted=copy(before);tilted.faces[0]=B.transform(tilted.faces[0],'pitch',.2,{x:1,y:0},p(4,2));
 const wall={points:[p(-.0000002,0),p(8.0000002,0),p(8.0000002,0,4),p(-.0000002,0,4)]};
 const first=F.face(wall,before,tilted),raised=copy(tilted);raised.faces[0]=B.transform(raised.faces[0],'move',1.5);const next=F.face(first,tilted,raised);
 assert.equal(first.points.length,4);assert.equal(next.points.length,4);for(const q of next.points.filter(q=>q.z!==4))assert.ok(Math.abs(q.z-(.2*(q.x-4)+1.5))<1e-7);
});
test('legacy wall conversion removes stray ownership records without removing valid drafting anchors',()=>{
 const state=copy(require('./fixtures/exterior-base-binding.json')),edits=state.wallEdits,count=()=>edits.$surfaces.reduce((n,f)=>n+(f.retainedPoints?.length||0),0),before=count();
 assert.equal(F.upgrade(edits),true);assert.equal(before-count(),4);assert.equal(F.upgrade(edits),false);
});
