const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('./roof-generation-fixture.cjs'),fixture=require('./fixtures/three-layer-wall-contacts.json');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),C=require('../public/measure/internal/editor_scripts/wall_chimneys');
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const r=build(fixture,24);
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
