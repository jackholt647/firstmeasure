const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js'),T=require('../public/measure/internal/editor_scripts/wall_trim.js'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,y,z)=>({x,y,z}),cap={id:'cap',chimney:{id:'chimney',cap:true,volume:true},points:[p(0,0,4),p(4,0,4),p(4,4,4),p(0,4,4)],holes:[]},wall={id:'wall',material:'siding',points:[p(0,0,0),p(4,0,0),p(4,0,4),p(0,0,4)]};
test('new and persisted chimney tops get a dedicated default while custom finishes and trim survive',()=>{
 const points=cap.points,roof={points,connections:points.map((_,i)=>({startIdx:i,endIdx:(i+1)%4,type:['chimney_back','chimney_edge','chimney_front','chimney_edge'][i]})),faces:[]},state={roof,chimneys:C.detect(roof),wallEdits:{},base:{faces:[]}};C.syncVolumes(state);assert.equal(state.wallEdits.$surfaces.find(f=>f.chimney.cap).material,'chimney-top');
 const saved={wallEdits:{$surfaces:[structuredClone(cap),{...structuredClone(cap),id:'trim',trim:true,material:'trim-horizontal'},{...structuredClone(cap),id:'custom',material:'stone',finishColor:'#abcd12'}],$drafts:{d:{chimney:cap.chimney,faces:[{material:'default'}]}}}};C.syncVolumes(saved);assert.deepEqual(saved.wallEdits.$surfaces.map(f=>f.material),['chimney-top','trim-horizontal','stone']);assert.equal(saved.wallEdits.$drafts.d.faces[0].material,'chimney-top');
 const before=JSON.stringify(saved);C.syncVolumes(saved);assert.equal(JSON.stringify(saved),before);
});
test('chimney tops stay light and untextured even when the project defaults to siding',()=>{
 const ctx={WallSolidGeometry:W,THREE:{Float32BufferAttribute:class{}},WallMode:{finishDefaults:{material:'siding',color:'#111111'}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_finishes.js','utf8'),ctx);
 const mesh={geometry:{setAttribute(){}},userData:{}},f={...cap,material:'chimney-top'};ctx.ExteriorFinishes.prepare(mesh,f,f.points);let color;const material={map:'old siding',color:{set:v=>color=v,multiplyScalar(){}}};ctx.ExteriorFinishes.apply(mesh,material);assert.equal(color,'#d4d0c8');assert.equal(material.map,null);assert.equal(ctx.ExteriorFinishes.resolve(cap).material,'chimney-top');
});
test('chimney top center is excluded from report geometry and area while its trim remains',()=>{
 const source={...cap,material:'chimney-top'},pair=[cap.points[0],cap.points[1]],parts=T.partition([wall,source],[pair],0,.1524,[pair],'#eeeeee',{materials:['chimney-top']}).replacements.flatMap(r=>r.pieces);
 assert.ok(parts.some(f=>f.trim));assert.ok(parts.some(f=>!f.trim&&f.material==='chimney-top'));
 const plain=R.build({faces:[wall,source]}),trimmed=R.build({faces:[wall,...parts]});assert.equal(plain.returns.length,0);assert.equal(plain.totals.returns,0);assert.equal(trimmed.walls.length,1);assert.equal(trimmed.totals.net,plain.totals.net);assert.ok(trimmed.returns.every(f=>f.trim&&f.material==='trim-horizontal'));assert.ok(Math.abs(trimmed.totals.returns-4*.1524/.3048**2)<1e-7);assert.ok([...trimmed.walls,...trimmed.returns].every(f=>f.material!=='chimney-top'));assert.equal(trimmed.returns.length,1);
});
