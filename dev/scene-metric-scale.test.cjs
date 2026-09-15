const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
function fn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0);let i=source.indexOf('{',start),depth=1;for(i++;depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}return source.slice(start,i);}
function fixture(radius=20,mpp=.1,width=800,height=600){class Vector3{constructor(x,y,z){Object.assign(this,{x,y,z});}}const ctx={THREE:{Vector3},imageWidth:width,imageHeight:height,layerData:{dsm:[[]]},dsmMin:140,ELEVATION_OFFSET:.5,getRadiusMeters:()=>radius,getMetersPerPx:()=>mpp};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(['getZScale','getHorizontalSceneUnitsPerMeter','getScenePlaneSize','imagePointToSceneXZ','getVector3'].map(fn).join('\n'),ctx);return {ctx,vector:p=>ctx.getVector3({x:width/2+p.x/mpp,y:height/2+p.y/mpp,z:p.z})};}
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),p=(x,y,z)=>({x,y,z});
test('production renderer uses equal metre scales on all axes across imagery sizes',()=>{
 for(const radius of [10,20,50,100])for(const mpp of [.05,.1,.25])for(const [w,h]of [[800,600],[400,1200]]){const {vector,ctx}=fixture(radius,mpp,w,h),o=vector(p(0,0,150));for(const q of [p(1,0,150),p(0,1,150),p(0,0,151)])assert.ok(Math.abs(dist(vector(q),o)-ctx.getHorizontalSceneUnitsPerMeter())<1e-9);}
});
test('a snapped circle stays circular through production image-to-scene conversion on vertical and inclined faces',()=>{
 const {vector,ctx}=fixture(),center=p(2,3,150);
 for(const u of [p(1,0,0),p(Math.SQRT1_2,0,Math.SQRT1_2)]){const v=p(0,1,0),n=p(-u.z,0,u.x),start=p(center.x+2*u.x,center.y,center.z+2*u.z),curve=K.arcPreview(start,center,p(center.x,center.y+2,center.z),n,{},false);curve.sweep=2*Math.PI;
 const origin=vector(center),a=vector(start),b=vector(K.curvePoint(curve,.25));assert.ok(Math.abs(dist(a,origin)-dist(b,origin))<1e-9);
 for(const q of K.curveSamples(curve))assert.ok(Math.abs(dist(vector(q),origin)-2*ctx.getHorizontalSceneUnitsPerMeter())<1e-8);
 }
});
test('invalid radius falls back to one consistent scale',()=>{for(const radius of [0,-2,NaN,undefined]){const {ctx}=fixture(radius);assert.equal(ctx.getZScale(),ctx.getHorizontalSceneUnitsPerMeter());assert.ok(ctx.getZScale()>0);}});
