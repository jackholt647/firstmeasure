const test=require('node:test'),assert=require('node:assert/strict'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js');
const rect=(x,z,w,h,y=0)=>[{x,y,z},{x:x+w,y,z},{x:x+w,y,z:z+h},{x,y,z:z+h}];
const area=faces=>faces.reduce((sum,f)=>{const frame=W.faceFrame(f);return sum+K.area({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))});},0);
test('overlapping window geometry cuts actual wall polygons and agrees with report net area',()=>{
 const wall={id:'wall',points:rect(0,0,4,4)},window={id:'window',feature:{type:'window'},points:rect(1,1,1,2)},before=JSON.stringify(wall),cut=M.cutOpenings(wall,[window]);
 assert.equal(area(cut),14);assert.equal(cut[0].holes.length,1);assert.equal(JSON.stringify(wall),before);assert.equal(area(cut.flatMap(f=>M.cutOpenings(f,[window]))),14);
 const report=R.build({faces:[...cut,window]});assert.ok(Math.abs(report.totals.net*.3048**2-14)<1e-6);assert.ok(Math.abs(report.totals.gross*.3048**2-16)<1e-6);
 window.points=rect(2,0,2,3);assert.equal(area(M.cutOpenings(wall,[window])),10);assert.equal(area(M.cutOpenings(wall,[])),16);
});
test('existing holes and crossing openings are deducted once; unrelated parallel walls are untouched',()=>{
 const a={feature:{type:'window'},points:rect(1,1,2,2)},b={feature:{type:'window'},points:rect(2,1,2,2)},wall={points:rect(0,0,4,4),holes:[a.points]};
 assert.equal(area(M.cutOpenings(wall,[a,b])),10);const behind={points:rect(0,0,4,4,1)};assert.equal(M.cutOpenings(behind,[a])[0],behind);assert.equal(M.cutOpenings(a,[b])[0],a);
});

test('spatial opening index matches exact cuts across cells, large faces, and mutations',()=>{
 const features=Array.from({length:200},(_,i)=>({feature:{type:'window'},points:rect(i*8-800,1,1,2)})),wall={points:rect(-800,0,4,4)};
 const indexed=M.indexOpenings(features);assert.ok(indexed.query([[-800,-796],[0,0],[0,4]]).length<=2);
 assert.deepEqual(M.cutOpenings(wall,indexed),M.cutOpenings(wall,features));assert.equal(area(M.cutOpenings(wall,indexed)),14);
 features[0].points[0].z+=.25;assert.deepEqual(M.cutOpenings(wall,M.indexOpenings(features)),M.cutOpenings(wall,features));
 features[0].deleted=true;assert.equal(area(M.cutOpenings(wall,M.indexOpenings(features))),16);
 const huge={points:rect(-100000,0,200000,4)};assert.equal(M.indexOpenings(features).query([[-100000,100000],[0,0],[0,4]]).length,200);
 const crossing={feature:{type:'window'},points:rect(-.001,1,1,2)},edge={points:rect(0,0,4,4)};
 assert.deepEqual(M.cutOpenings(edge,M.indexOpenings([crossing])),M.cutOpenings(edge,[crossing]));
});
