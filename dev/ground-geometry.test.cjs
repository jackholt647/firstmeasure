const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/measure/internal/editor_scripts/ground_geometry.js');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const p=(x,y,z)=>({x,y,z});
const near=(a,b,t=1e-5)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
test('quad terrain triangulates, preserves height, and gains a local grade with an added point',()=>{
    const g=T.fromPlane({x0:0,x1:10,y0:0,y1:10},{dx:.1,dy:.2,k:2});
    assert.equal(g.faces.length,2);near(T.height(g,p(5,5,0)),3.5);
    const changed=T.mesh([...g.points,p(5,5,6)]);assert.equal(changed.faces.length,4);near(T.height(changed,p(5,5,0)),6);
    near(T.height(g,p(5,5,0)),3.5);assert.equal(T.height(g,p(-2,-2,0)),null);
    assert.throws(()=>T.mesh([...g.points,p(0,0,5)]),/separation/);
});
test('wall bottoms follow sloped ground, with lower roofs still intercepting first',()=>{
    const g=T.fromPlane({x0:-1,x1:11,y0:-2,y1:2},{dx:.2,dy:0,k:1});
    const s={id:'E',kind:'perimeter',direction:'down',a:p(0,0,8),b:p(10,0,8)};
    let r=G.extrude({faces:[]},[s],g);assert.equal(r.walls.length,1);near(r.walls[0].bottom[0].z,1);near(r.walls[0].bottom[1].z,3);
    r=G.extrude({faces:[{points:[p(0,-1,4),p(5,-1,4),p(5,1,4),p(0,1,4)]}]},[s],g);
    assert.equal(r.walls.length,2);near(r.walls[0].bottom[0].z,4);near(r.walls[1].bottom[1].z,3);
});
test('piecewise terrain preserves a grade break; uncovered spans warn instead of extrapolating',()=>{
    const g=T.mesh([p(0,-1,0),p(10,-1,0),p(10,1,0),p(0,1,0),p(5,0,3)]);
    const r=G.extrude({faces:[]},[{id:'E',kind:'perimeter',direction:'down',a:p(-2,0,8),b:p(12,0,8)}],g);
    assert.equal(r.walls.length,2);near(r.walls[0].bottom[1].z,3);near(r.walls[1].bottom[0].z,3);assert.equal(r.warnings.length,1);
});
test('terrain above roof produces no inverted walls; upward flashing still targets roof only',()=>{
    const g=T.fromPlane({x0:-1,x1:11,y0:-1,y1:1},{dx:0,dy:0,k:9});
    const source={id:'E',kind:'perimeter',direction:'down',a:p(0,0,8),b:p(10,0,8)};
    assert.equal(G.extrude({faces:[]},[source],g).walls.length,0);
    assert.equal(G.extrude({faces:[]},[{...source,direction:'up'}],g).walls.length,0);
});
test('robust low surface fit rejects canopy and isolated ditch samples',()=>{
    const samples=[];
    for(let y=-10;y<=10;y+=2)for(let x=-10;x<=10;x+=2){const i=samples.length;let z=100+.12*x-.07*y+Math.sin(i)*.04;if(i%4===0)z+=8;if(i%23===0)z-=6;samples.push(p(x,y,z));}
    const r=T.fit(samples);near(r.plane.dx,.12,.005);near(r.plane.dy,-.07,.005);near(r.plane.k,100,.03);assert.ok(r.stats.inliers>70);
    assert.deepEqual(r,T.fit(samples),'fit must be deterministic');
});
test('DSM sampler excludes roof and no-data and remains bounded',()=>{
    const ctx={width:200,height:200,mpp:.5},data=new Float32Array(40000);
    for(let iy=0;iy<200;iy++)for(let ix=0;ix<200;ix++){const x=(ix-100)*.5,y=(iy-100)*.5;data[iy*200+ix]=100+x*.1+y*.05;if(Math.abs(x)<5&&Math.abs(y)<5)data[iy*200+ix]+=10;if(ix<10)data[iy*200+ix]=-9999;}
    const roof={faces:[{points:[p(-5,-5,110),p(5,-5,110),p(5,5,110),p(-5,5,110)]}]};
    const samples=T.sampleDSM(data,ctx,roof);assert.ok(samples.length<=256);assert.ok(samples.every(p=>!G.contains(roof.faces[0],p)));
    const r=T.fit(samples);near(r.plane.dx,.1,.005);near(r.plane.dy,.05,.005);near(r.plane.k,100,.05);
    assert.throws(()=>T.fit(samples.slice(0,3)),/Too few/);
});

test('legacy detailed grades become a visible four-corner reference without changing the roof',()=>{
 const roof={faces:[{points:[p(0,0,8),p(10,0,8),p(10,10,8),p(0,10,8)]}]},before=JSON.stringify(roof),legacy=T.mesh([p(0,0,0),p(10,0,1),p(10,10,2),p(0,10,1),p(5,5,1)],{source:'DSM',visible:false});
 const ref=T.reference(legacy,roof);assert.equal(ref.points.length,4);assert.equal(ref.visible,true);assert.equal(ref.source,'DSM');for(const q of ref.points)near(q.z,.1*q.x+.1*q.y);assert.equal(JSON.stringify(roof),before);
 ref.visible=false;assert.equal(T.reference(ref,roof).visible,false);const flat=T.reference({...legacy,source:'Manual'},roof);assert.ok(flat.points.every(q=>q.z===flat.points[0].z));
});


test('single DSM samples preserve zero and negative elevations, reject no-data, and map the saved origin',()=>{
 const data=new Float32Array(16).fill(-9999),ctx={width:4,height:4,mpp:.5,lat:0,lng:0};data[5]=0;data[6]=-2.5;
 assert.deepEqual(T.sampleDSMPoint(data,ctx,{x:1,y:1}),p(-.5,-.5,0));assert.equal(T.sampleDSMPoint(data,ctx,{x:2,y:1}).z,-2.5);
 assert.throws(()=>T.sampleDSMPoint(data,ctx,{x:-1,y:0}),/inside/);assert.throws(()=>T.sampleDSMPoint(data,ctx,{x:0,y:0}),/No DSM height/);assert.throws(()=>T.sampleDSMPoint(null,ctx,{x:1,y:1}),/load/);
 const moved=T.sampleDSMPoint(data,ctx,{x:1,y:1},{...ctx,lng:1/111132,lat:2/111132});near(moved.x,-1.5);near(moved.y,1.5);
 const roof={faces:[{points:[p(0,0,8),p(1,0,8),p(1,1,8),p(0,1,8)]}]},ground=T.fromPlane(T.bounds(roof),{dx:0,dy:0,k:0},{source:'DSM point',sampledPoint:p(-.5,-.5,0),simpleGrade:1});assert.deepEqual(T.reference(ground,roof).sampledPoint,ground.sampledPoint);assert.equal(T.reference(ground,roof).source,'DSM point');assert.equal(T.initial(null,ctx,roof,NaN).plane.k,0);
});
