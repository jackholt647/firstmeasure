const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../public/measure/internal/editor_scripts/wall_chimneys.js');
const ctx={width:20,height:20,mpp:.25,lat:0,lng:0};
const p=(x,y,z=10)=>({x,y,z});
function generate(points,data,origin=ctx){
 const roof={points,connections:points.map((_,i)=>({startIdx:i,endIdx:(i+1)%points.length,type:'chimney_edge'})),faces:[]};
 const state={roof,chimneys:C.detect(roof,{sampleHeight:C.heightSampler(data,ctx,origin),resolution:ctx.mpp}),wallEdits:{},base:{faces:[]}};
 C.syncVolumes(state);return state;
}
const cap=s=>s.wallEdits.$surfaces.find(f=>f.chimney.cap);
const rect=[p(-.5,-.5),p(.5,-.5),p(.5,.5),p(-.5,.5)];
function put(data,x,y,z){data[Math.round(10+y/.25)*20+Math.round(10+x/.25)]=z;}
test('initial flat chimney top uses the highest footprint pixel including a narrow isolated peak',()=>{
 const data=Array(400).fill(10);put(data,.25,.25,12.7);put(data,.75,0,40);
 const s=generate(rect,data);assert.ok(cap(s).points.every(p=>p.z===12.7));
 assert.equal(s.chimneys.items[0].dsmTop,12.7);
 const sides=s.wallEdits.$surfaces.filter(f=>!f.chimney.cap);assert.ok(sides.every(f=>Math.max(...f.points.map(p=>p.z))===12.7));
 const saved=JSON.parse(JSON.stringify(s));cap(saved).points.forEach(p=>p.z=14);C.syncVolumes(saved);assert.ok(cap(saved).points.every(p=>p.z===14));
});
test('polygon test excludes high pixels inside the bounding box but outside the chimney',()=>{
 const data=Array(400).fill(11);put(data,.5,.5,30);put(data,0,0,12);
 const s=generate([p(0,-.6),p(.6,0),p(0,.6),p(-.6,0)],data);
 assert.ok(cap(s).points.every(p=>p.z===12));
});
test('missing, invalid, roof-only and subpixel footprints retain the one-foot fallback',()=>{
 for(const value of [null,NaN,-9999,Infinity,10,9]){
  const s=generate(rect,Array(400).fill(value));assert.ok(cap(s).points.every(p=>Math.abs(p.z-10.3048)<1e-9));
 }
 const small=[p(.03,.03),p(.2,.03),p(.2,.2),p(.03,.2)];
 assert.ok(cap(generate(small,Array(400).fill(20))).points.every(p=>p.z===10.3048));
});
test('usable height below one foot is used exactly; zero and negative elevations remain valid',()=>{
 for(const [roofZ,topZ]of [[10,10.1],[-2,0],[-3,-1]]){
  const s=generate(rect.map(p=>({...p,z:roofZ})),Array(400).fill(topZ));assert.ok(cap(s).points.every(p=>p.z===topZ));
 }
});
test('maximum scan honors the saved origin and raster bounds',()=>{
 const data=Array(400).fill(null);put(data,1,0,15);
 const origin={...ctx,lng:1/111132};assert.equal(C.heightSampler(data,ctx,origin).maximumInside(rect),15);
 assert.equal(C.heightSampler(data,ctx).maximumInside(rect),null);
 assert.equal(C.heightSampler(data,ctx).maximumInside(rect.map(p=>({...p,x:p.x+20}))),null);
});
