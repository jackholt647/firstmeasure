const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
// Point weld (WallSolidGeometry.weldPlan / weldPlanes): points within the weld distance become one point, and the
// faces of one wall share one plane. A quarter inch is the default distance.
const p=(x,y,z)=>({x,y,z}),QUARTER=.25*.0254,far=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const X={n:p(1,0,0),k:4},Y={n:p(0,1,0),k:0},Z={n:p(0,0,1),k:0};
const apply=(items,moves)=>items.map(item=>{const m=moves.find(m=>m.owner===(item.owner??null)&&far(m.from,item.point)<=1e-9);return m?{...item,point:m.to}:item;});

test('a corner of two walls and a base, with a loose twin, becomes the one point their planes meet in',()=>{
 const items=[{point:p(4,0,0),planes:[X],ring:'a'},{point:p(4.0000004,.0014,.002),planes:[Y],ring:'b'},{point:p(4.001,.0005,0),planes:[Z],ring:'c'},{point:p(4.002,.001,.003),planes:[],ring:null}];
 const {moves,skipped}=W.weldPlan(items,QUARTER);assert.equal(skipped,0);assert.equal(moves.length,3);
 for(const m of moves)assert.ok(far(m.to,p(4,0,0))<=1e-9,JSON.stringify(m));
 // Welded once, there is nothing left to weld.
 assert.deepEqual(W.weldPlan(apply(items,moves),QUARTER).moves,[]);
});
test('points further apart than the weld distance, and a weld distance of zero, change nothing',()=>{
 const items=[{point:p(0,0,0),planes:[],ring:null},{point:p(.007,0,0),planes:[],ring:null}];
 assert.deepEqual(W.weldPlan(items,QUARTER).moves,[]);assert.equal(W.weldPlan(items,.01).moves.length,1,'a wider setting welds them');
 assert.deepEqual(W.weldPlan([{point:p(0,0,0),planes:[]},{point:p(.001,0,0),planes:[]}],0).moves,[]);
});
test('two corners of one outline are a drawn step: they are never merged, and nothing near them is pulled across',()=>{
 const items=[{point:p(0,0,0),planes:[Y],ring:'a'},{point:p(.004,0,0),planes:[Y],ring:'a'},{point:p(.001,0,0),planes:[],ring:null}];
 const {moves,skipped}=W.weldPlan(items,QUARTER);assert.equal(skipped,1);assert.deepEqual(moves,[]);
});
test('a fixed point does not move: the others come to it, and two fixed points leave the group alone',()=>{
 const one=W.weldPlan([{point:p(1,0,0),planes:[Y],ring:'a',fixed:true},{point:p(1.002,0,0),planes:[Y],ring:'b'}],QUARTER);
 assert.equal(one.moves.length,1);assert.ok(far(one.moves[0].to,p(1,0,0))<=1e-12);
 const two=W.weldPlan([{point:p(1,0,0),planes:[Y],ring:'a',fixed:true},{point:p(1.002,0,0),planes:[Y],ring:'b',fixed:true},{point:p(1.001,0,0),planes:[],ring:null}],QUARTER);
 assert.deepEqual(two.moves,[]);assert.equal(two.skipped,1);
});
test('a point whose plane does not pass through the shared corner stays, and the others still weld',()=>{
 // Two walls and a flat base meet at (4,0,0). A sloped base face has its corner 2.5 mm below: it cannot come.
 const sloped={n:p(0,0,1),k:-.0025},items=[{point:p(4,0,0),owner:'A',ring:'A'},{point:p(4.001,.001,0),owner:'B',ring:'B'},{point:p(4.0005,.0004,0),owner:'F',ring:'F'},{point:p(4,0,-.0025),owner:'S',ring:'S'}];
 const owners=new Map([['A',{plane:X}],['B',{plane:Y}],['F',{plane:Z}],['S',{plane:sloped}]]),{moves}=W.weldPlan(items,QUARTER,null,owners);
 assert.ok(!moves.some(m=>m.owner==='S'),'the sloped face keeps its corner');
 const after=apply(items,moves);for(const id of ['A','B','F'])assert.ok(far(after.find(i=>i.owner===id).point,p(4,0,0))<=1e-9,id);
});
test('faces of one wall stored a tenth of a millimetre apart take one plane; a real half-inch inset does not',()=>{
 const face=(id,y,x0,x1,tilt=0)=>[p(x0,y,0),p(x1,y+tilt,0),p(x1,y+tilt,3),p(x0,y,3)].map(point=>({point,owner:id,ring:id}));
 const plane=points=>{const n=W.normal(points);return {n,k:n.x*points[0].x+n.y*points[0].y+n.z*points[0].z};};
 const build=parts=>{const items=parts.flat(),owners=new Map();for(const id of new Set(items.map(i=>i.owner)))owners.set(id,{plane:plane(items.filter(i=>i.owner===id).map(i=>i.point))});return {items,owners};};
 // Offset by 0.1 mm, and tilted by 0.2 mm over its length: both are storage noise.
 for(const noisy of [face('B',.0001,4.002,8),face('B',0,4.002,8,.0002)]){
  const {items,owners}=build([face('A',0,0,12),noisy]),{lay,planes}=W.weldPlanes(items,owners);
  assert.deepEqual([...lay.keys()],['B'],'the narrower face takes the wider face\'s plane');assert.equal(planes.get('B'),planes.get('A'));
 }
 const inset=build([face('A',0,0,12),face('B',.0127,4.002,8)]),result=W.weldPlanes(inset.items,inset.owners);
 assert.equal(result.lay.size,0);assert.notEqual(result.planes.get('B'),result.planes.get('A'));
 // A fixed plane is the one others join, whatever its width; a soft (deleted) face neither gives nor takes one.
 const fixed=build([face('A',0,0,12),face('B',.0001,4,5)]);fixed.owners.get('B').fixed=true;assert.deepEqual([...W.weldPlanes(fixed.items,fixed.owners).lay.keys()],['A']);
 const soft=build([face('A',0,0,12),face('B',.0001,4,5)]);soft.owners.get('B').soft=true;assert.equal(W.weldPlanes(soft.items,soft.owners).lay.size,0);
});
test('a drawing keeps its points on its own micron grid: it is not nudged again, and other points go exactly to it',()=>{
 const items=[{point:p(1,0,0),planes:[Y],ring:'d1',grid:true},{point:p(1.0000008,0,0),planes:[Y],ring:'d2',grid:true},{point:p(1.0000015,0,.0000004),planes:[Y],ring:'s'}];
 const {moves}=W.weldPlan(items,QUARTER);assert.equal(moves.length,1,'only the face corner moves');assert.ok(far(moves[0].to,p(1,0,0))<=1e-12);
});
