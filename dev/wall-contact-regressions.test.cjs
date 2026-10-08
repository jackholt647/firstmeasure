const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('./roof-generation-fixture.cjs'),fixture=require('./fixtures/three-layer-wall-contacts.json');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),C=require('../public/measure/internal/editor_scripts/wall_chimneys');
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const r=build(fixture,24);
const covers=(walls,p)=>walls.some(w=>{
 if(!G.onEdge(p,...w.top,.002))return false;
 const a=w.top[0],b=w.top[1],dx=b.x-a.x,dy=b.y-a.y,t=((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy);
 return p.z>mix(...w.bottom,t).z&&p.z<mix(...w.top,t).z;
});
test('lower glass-roof contact keeps the upper wall straight through the hip split',()=>{
 const side=r.state.sources.find(s=>s.id==='R73.sky0.0'),end=r.state.sources.find(s=>s.id==='R77.0');
 const u={x:side.b.x-side.a.x,y:side.b.y-side.a.y},v={x:end.b.x-end.a.x,y:end.b.y-end.a.y};
 const t=((end.a.x-side.a.x)*v.y-(end.a.y-side.a.y)*v.x)/(u.x*v.y-u.y*v.x),corner={x:side.a.x+t*u.x,y:side.a.y+t*u.y,z:41.5};
 for(const k of [.85,.95,.99])assert.ok(covers(r.composed,{...mix(side.a,corner,k),z:41.5}),'wall reaches the square corner without a diagonal cut');
 assert.ok(covers(r.composed,{...mix(corner,end.b,.05),z:41.5}),'adjoining return extends to the moved corner');
 const joined=r.composed.filter(w=>w.top.some(p=>Math.hypot(p.x-corner.x,p.y-corner.y)<.002));
 assert.ok(joined.length>=2,'both wall runs share the corner');
});
test('projecting chimney retains all three exposed lower sides after covered siding is removed',()=>{
 const c=r.state.chimneys.items.find(c=>c.sourceConnections.includes(53));assert.ok(c);
 for(const [side,ts]of [[0,[.1,.5,.9]],[1,[.1,.3]],[3,[.7,.9]]])for(const t of ts){
  const p={...mix(c.points[side],c.points[(side+1)%4],t),z:37};
  assert.ok(covers(r.composed.filter(w=>w.chimney?.id===c.id),p),`exposed side ${side} reaches below the roof`);
 }
 assert.ok(!covers(r.composed.filter(w=>w.chimney?.id===c.id),{...mix(c.points[2],c.points[3],.5),z:37}),'buried back face stays hidden');
});
test('captured three-layer building retains the upper wall above the glass roof',()=>{
 const upper=r.state.sources.find(s=>s.id==='R11.0'),lower=r.state.sources.find(s=>s.id==='R72.0');assert.ok(upper&&lower);
 for(const t of [.1,.5,.9]){
  const p={...mix(lower.a,lower.b,t),z:41.5};
  assert.ok(r.composed.some(w=>{if(!G.onEdge(p,...w.top,.002))return false;const dx=w.top[1].x-w.top[0].x,dy=w.top[1].y-w.top[0].y,t=((p.x-w.top[0].x)*dx+(p.y-w.top[0].y)*dy)/(dx*dx+dy*dy);return p.z>mix(...w.bottom,t).z&&p.z<mix(...w.top,t).z;}),'middle wall covers the exposed height above the lower roof');
 }
});
test('completed chimney remains attached to the inset house footprint',()=>{
 const c=r.state.chimneys.items.find(c=>c.sourceConnections.includes(89));assert.ok(c);
 const [a,b]=[c.points[2],c.points[3]],length=Math.hypot(b.x-a.x,b.y-a.y),out={x:(b.y-a.y)/length,y:-(b.x-a.x)/length};
 const body=C.buildingBase(r.state);
 for(const t of [.2,.5,.8]){const p=mix(a,b,t),q={x:p.x+out.x*.05,y:p.y+out.y*.05};assert.ok(body.some(f=>G.contains(f,q)),'no soffit-width moat behind the chimney');}
});
