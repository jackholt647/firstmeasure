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
test('two corners of one outline within the weld distance become one corner; further apart they stay',()=>{
 // An edge shorter than the weld distance is not a drawn step: the weld distance is the one measure of that.
 const items=[{point:p(0,0,0),planes:[Y],ring:'a'},{point:p(.004,0,0),planes:[Y],ring:'a'},{point:p(.001,0,0),planes:[],ring:null}];
 const {moves,skipped}=W.weldPlan(items,QUARTER);assert.equal(skipped,0);assert.equal(moves.length,2);
 const after=apply(items,moves);assert.ok(after.every(i=>far(i.point,after[0].point)<=1e-12),'one point');
 assert.deepEqual(W.weldPlan([{point:p(0,0,0),planes:[Y],ring:'a'},{point:p(.007,0,0),planes:[Y],ring:'a'}],QUARTER).moves,[]);
});
test('a step that planes hold open stays, and so does a short edge of an outline that keeps its edges',()=>{
 // A wall section pushed in by 4 mm: the return's two corners lie on the wall plane and on the recess plane, which
 // never meet. Merging them would pull the recess corner off the return, so nothing moves.
 const wall={n:p(0,1,0),k:0},recess={n:p(0,1,0),k:-.004},side={n:p(1,0,0),k:2},owners=new Map([['wall',{plane:wall}],['recess',{plane:recess}],['return',{plane:side}]]);
 const A=p(2,0,1),B=p(2,-.004,1),items=[{point:{...A},owner:'wall',ring:'wall'},{point:{...A},owner:'return',ring:'return'},{point:{...B},owner:'return',ring:'return'},{point:{...B},owner:'recess',ring:'recess'}],why=[];
 assert.deepEqual(W.weldPlan(items,QUARTER,why,owners).moves,[]);assert.ok(why.some(w=>w.reason==='step'),JSON.stringify(why.map(w=>w.reason)));
 // The base has its own sketch and never loses an edge to a weld (keep).
 const base=[{point:p(0,0,0),planes:[Z],ring:'b',keep:true},{point:p(.004,0,0),planes:[Z],ring:'b',keep:true},{point:p(.001,0,0),planes:[],ring:null}];
 const kept=W.weldPlan(base,QUARTER);assert.deepEqual(kept.moves,[]);assert.equal(kept.skipped,1);
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
test('two corners of one outline a tenth of a millimetre apart are one corner stored twice, and weld',()=>{
 const items=[{point:p(0,0,0),planes:[Y],ring:'a'},{point:p(.0001,0,0),planes:[Y],ring:'a'},{point:p(.00005,0,0),planes:[],ring:null}];
 const {moves,skipped}=W.weldPlan(items,QUARTER);assert.equal(skipped,0);assert.equal(moves.length,2);assert.ok(moves.every(m=>far(m.to,p(0,0,0))<=1e-12));
});

test('a weld never pulls one point apart: where its uses cannot all go, none does',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),plane=(n,k)=>({n,k});
 // A house corner: the right wall (plane y=0) and the left wall (plane x=0) share it. A leftover point 7 mm along the
 // right wall, on a plane of its own beside the left wall's, is inside a 5/16 in weld. The left wall's corner cannot
 // go there (it would leave its plane). The right wall's corner went anyway, and the two walls no longer met.
 const corner=p(0,0,3),stray=p(.007,0,3),owners=new Map([['stray',{plane:plane(p(1,0,0),.007)}],['right',{plane:plane(p(0,1,0),0)}],['left',{plane:plane(p(1,0,0),0)}]]);
 const items=[{point:stray,owner:'stray',ring:null,grid:true},{point:{...corner},owner:'right',ring:'right:0'},{point:{...corner},owner:'left',ring:'left:0'}],why=[];
 const plan=W.weldPlan(items,.3125*.0254,why,owners);
 assert.deepEqual(plan.moves,[],JSON.stringify(plan.moves));assert.ok(why.some(w=>w.reason==='split'),JSON.stringify(why.map(w=>w.reason)));
 // Without the left wall there is nothing to pull apart, and the corner and the leftover point become one.
 const alone=W.weldPlan(items.filter(i=>i.owner!=='left'),.3125*.0254,[],owners);assert.equal(alone.moves.length,1);
});

test('a point on a straight edge is not a corner because it is a micron off the line',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z});
 // The side of a wall with a point 0.76 m down it that a drawing's micron grid left 1.2 microns off the line.
 const on=p(0,1.2e-6,2.2),wall={id:'wall',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(0,0,3),on],holes:[]},index=W.loadBearingIndex([wall]);
 assert.equal(index.point(on),false);assert.equal(index.marker(on),false);assert.equal(index.point(p(0,0,3)),true,'a real corner still is');
 // A real jog, half a millimetre, is a corner.
 const jog=p(0,.0005,2.2);assert.equal(W.loadBearingIndex([{...wall,points:[...wall.points.slice(0,4),jog]}]).point(jog),true);
});

test('a drawn line a little off the face edge it stands for is still read as that edge',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z});
 const wall={id:'wall',points:[p(0,0,0),p(4,0,0),p(4,0,3),p(0,0,3)],holes:[]},index=W.loadBearingIndex([wall]);
 // The corner line, with its top end 5 mm along the wall: it holds the wall's side, so it is load-bearing (orange).
 const slanted=[p(0,0,0),p(.005,0,3)];assert.equal(index.edge(...slanted,true),true);
 // Only a drawing's own line is read that way: a free-standing copy beside the edge holds nothing.
 assert.equal(index.edge(...slanted),false);
 // Deleting it must take the side it stands for; a line exactly on the side has nothing extra to take.
 assert.deepEqual(index.pairs(...slanted),[[p(0,0,3),p(0,0,0)]]);assert.deepEqual(index.pairs(p(0,0,0),p(0,0,3)),[]);
 // Not the edge: 2 cm away; crossing it at an angle; a line across the middle of the wall.
 assert.equal(index.edge(p(.02,0,0),p(.02,0,3),true),false);assert.equal(index.edge(p(-.003,0,1),p(1,0,1.2),true),false);assert.equal(index.edge(p(1,0,0),p(1,0,3),true),false);
});

test('a point left beside a line of its own drawing is put on the line, by the weld\'s rules',()=>{
 const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),p=(x,y,z)=>({x,y,z}),plane=(n,k)=>({n,k}),inch=.0254;
 const wall=plane(p(0,1,0),0),owners=new Map([['d:wall',{plane:wall}],['d:side',{plane:plane(p(1,0,0),0)}]]),line={a:p(0,0,0),b:p(0,0,3),owner:'d:wall'};
 // A cut's start point 2 mm beside the edge it was placed on.
 const beside=p(.002,0,1.5),items=[{point:line.a,owner:'d:wall'},{point:line.b,owner:'d:wall'},{point:beside,owner:'d:wall',grid:true}];
 const moves=W.seatPlan(items,owners,[line],.25*inch);assert.equal(moves.length,1);assert.deepEqual(moves[0],{from:beside,to:p(0,0,1.5),owner:'d:wall'});
 // Further than the weld distance it is a point of its own; with the weld off nothing moves.
 assert.deepEqual(W.seatPlan([{point:p(.02,0,1.5),owner:'d:wall'}],owners,[line],.25*inch),[]);assert.deepEqual(W.seatPlan(items,owners,[line],0),[]);
 // Another wall holds the same point and would have to leave its plane: nothing moves, the point is not split.
 const shared=[...items,{point:{...beside},owner:'d:side'}];owners.get('d:side').plane=plane(p(1,0,0),.002);assert.deepEqual(W.seatPlan(shared,owners,[line],.25*inch),[]);
 // A held point stays, and a point by the line's end is left to the weld.
 assert.deepEqual(W.seatPlan([{point:beside,owner:'d:wall',fixed:true}],owners,[line],.25*inch),[]);assert.deepEqual(W.seatPlan([{point:p(.002,0,.003),owner:'d:wall'}],owners,[line],.25*inch),[]);
});
