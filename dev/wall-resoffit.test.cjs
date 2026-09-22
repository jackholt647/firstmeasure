const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),G=require('../public/measure/internal/editor_scripts/wall_geometry'),K=require('../public/measure/internal/editor_scripts/exterior_geometry');
const p=(x,y,z)=>({x,y,z});
function fixture(angle=90){
 const slope=angle===90?0:1,at=y=>4+slope*(y-.6096),z=(x,y)=>5+.2*y;
 const wall=(id,a,b)=>({id,points:[p(...a,0),p(...b,0),p(...b,z(...b)),p(...a,z(...a))],holes:[]});
 const faces=[wall('front',[0,.6096],[4,.6096]),wall('right',[4,.6096],[at(3),3]),wall('left',[0,3],[0,.6096])];
 const roof={faces:[{id:1,points:[p(-5,-3,z(-5,-3)),p(12,-3,z(12,-3)),p(12,9,z(12,9)),p(-5,9,z(-5,9))]}]};
 const sources=[{id:'front-eave',kind:'perimeter',type:'eave',parentId:1,originalA:p(0,0,5),originalB:p(4,0,5),a:p(0,.6096,z(0,.6096)),b:p(4,.6096,z(4,.6096)),setback:.6096,sourcePlane:{dx:0,dy:.2,k:5}}];
 return {faces,roof,sources,pair:[faces[0].points[3],faces[0].points[2]],at,z};
}
for(const angle of [90,45])test(`resoffit slides a shared ${angle}-degree corner along the unchanged neighbor plane`,()=>{
 const f=fixture(angle),before=JSON.stringify(f),r=R.apply(f.faces,[f.pair],.1524,f.roof,f.sources),front=r.faces[0],side=r.faces[1];
 assert.equal(r.faces.length,3);assert.ok(front.points.every(p=>Math.abs(p.y-.1524)<1e-8));
 assert.ok(side.points.every(p=>Math.abs(p.x-f.at(p.y))<1e-8));
 assert.ok(front.points.filter(p=>p.z>0).every(p=>Math.abs(p.z-f.z(p.x,p.y))<1e-8));
 assert.equal(JSON.stringify(f),before);for(const face of r.faces)K.validateFace(face);
});
test('multiple selected wall planes meet simultaneously without extra return faces',()=>{
 const f=fixture(),right=f.faces[1],outer=4+.6096;
 f.sources.push({id:'right-eave',kind:'perimeter',type:'eave',parentId:1,originalA:p(outer,.6096,5),originalB:p(outer,3,5),a:right.points[0],b:right.points[1],setback:.6096,sourcePlane:{dx:0,dy:.2,k:5}});
 const r=R.apply(f.faces,[f.pair,[right.points[2],right.points[3]]],.1524,f.roof,f.sources);
 assert.equal(r.faces.length,3);assert.ok(r.faces[0].points.every(p=>Math.abs(p.y-.1524)<1e-8));assert.ok(r.faces[1].points.every(p=>Math.abs(p.x-(outer-.1524))<1e-8));
});
test('unrelated geometry remains unchanged and repeated depths are absolute',()=>{
 const f=fixture(),other={id:'other',points:[p(8,1,0),p(9,1,0),p(9,1,2),p(8,1,2)]};f.faces.push(other);
 const a=R.apply(f.faces,[f.pair],.1524,f.roof,f.sources),b=R.apply(a.faces,a.pairs,.3048,f.roof,f.sources);
 assert.deepEqual(b.faces.find(f=>f.id==='other'),other);assert.ok(b.faces[0].points.every(p=>Math.abs(p.y-.3048)<1e-8));
});
test('invalid depth or non-soffit lines reject without modifying geometry',()=>{
 const f=fixture(),before=JSON.stringify(f.faces);for(const d of [-1,NaN,6])assert.throws(()=>R.apply(f.faces,[f.pair],d,f.roof,f.sources));assert.throws(()=>R.apply(f.faces,[[f.faces[0].points[0],f.faces[0].points[1]]],.2,f.roof,f.sources));assert.equal(JSON.stringify(f.faces),before);
});


test('lower-layer minimum clearance overrides a shallower requested soffit',()=>{
 const f=fixture();Object.assign(f.sources[0],{clearanceRoofIds:[2],contactSetback:.5});
 const r=R.apply(f.faces,[f.pair],.1524,f.roof,f.sources);assert.equal(r.limited,true);assert.ok(r.faces[0].points.every(p=>Math.abs(p.y-.5)<1e-8));
});

test('parallel roof intersections far from the generated setback are not soffit candidates',()=>{
 const f=fixture();f.sources[0].setback=2.5;assert.equal(R.candidates(f.faces,f.roof,f.sources).length,0);
});

test('shortening a neighbor clips intermediate roof vertices to the new wall corner',()=>{
 const f=fixture(),right=f.faces[1];right.points.splice(3,0,p(4,.8,f.z(4,.8)));
 const r=R.apply(f.faces,[f.pair],1.2,f.roof,f.sources);assert.ok(r.faces[1].points.every(p=>p.y>=1.2-1e-7));K.validateFace(r.faces[1]);
});


test('an inset consumes a short neighbor and joins the surviving planes across it',()=>{
 const f=fixture(),wall=(id,a,b)=>({id,points:[p(...a,0),p(...b,0),p(...b,f.z(...b)),p(...a,f.z(...a))]});
 f.faces[1]=wall('short',[4,.6096],[4,1]);f.faces.push(wall('diagonal',[4,1],[5,2]));
 const r=R.apply(f.faces,[f.pair],1.2,f.roof,f.sources),front=r.faces.find(f=>f.id==='front'),side=r.faces.find(f=>f.id==='diagonal');
 assert.equal(r.faces.find(f=>f.id==='short').deleted,true);
 assert.ok(front.points.some(p=>Math.abs(p.x-4.2)<1e-7&&Math.abs(p.y-1.2)<1e-7));
 assert.ok(side.points.every(p=>Math.abs(p.x-p.y-3)<1e-7));
 for(const face of r.faces.filter(f=>!f.deleted))K.validateFace(face);
});

test('a lower roof boundary continues its contacted sheet instead of jumping to an overlapping upper roof',()=>{
 const f=fixture(),lowZ=(x,y)=>2+y;
 f.roof.faces.push({id:2,points:[p(-2,.6096,lowZ(0,.6096)),p(8,.6096,lowZ(0,.6096)),p(8,2,lowZ(0,2)),p(-2,2,lowZ(0,2))]});
 for(const face of f.faces)face.points=face.points.map(q=>q.z===0?{...q,z:lowZ(q.x,q.y)}:q);
 f.pair=f.faces[0].points.slice(2);
 const r=R.apply(f.faces,[f.pair],.1524,f.roof,f.sources),front=r.faces[0];
 assert.equal(front.points.length,4);
 assert.ok(front.points.filter(q=>q.z<4).every(q=>Math.abs(q.z-lowZ(q.x,q.y))<1e-7));
 assert.ok(front.points.filter(q=>q.z>4).every(q=>Math.abs(q.z-f.z(q.x,q.y))<1e-7));
});


test('a moved wall top is split at the new roof hip instead of cutting across the pitches',()=>{
 const f=fixture(),z=(x,y)=>5+Math.min(x,y);
 f.roof={faces:[{id:1,points:[p(-2,-2,3),p(-2,8,3),p(8,8,13)]},{id:2,points:[p(-2,-2,3),p(8,-2,3),p(8,8,13)]}]};
 for(const face of f.faces)face.points=face.points.map(q=>q.z>0?{...q,z:z(q.x,q.y)}:q);
 f.faces[0].points.splice(3,0,p(.6096,.6096,z(.6096,.6096)));f.sources[0].sourcePlane={dx:0,dy:1,k:5};
 f.pair=f.faces[0].points.slice(2,4);
 const r=R.apply(f.faces,[f.pair],1.2,f.roof,f.sources),top=r.faces[0].points.filter(q=>q.z>0).sort((a,b)=>a.x-b.x);
 assert.ok(top.some(q=>Math.abs(q.x-1.2)<1e-7&&Math.abs(q.y-1.2)<1e-7));
 for(let i=1;i<top.length;i++){const a=top[i-1],b=top[i],x=(a.x+b.x)/2,y=(a.y+b.y)/2;assert.ok(Math.abs((a.z+b.z)/2-z(x,y))<1e-7);}
});
