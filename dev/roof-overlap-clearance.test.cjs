const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),B=require('../public/measure/internal/editor_scripts/base_geometry');
const {build}=require('./roof-generation-fixture.cjs');
const p=(x,y,z)=>({x,y,z}),mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
function fixture(type='skylight',depth=.4,angle=0){
 const turn=p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z});
 const upper=[p(0,0,5),p(6,0,5),p(6,3,5.6),p(0,3,5.6)].map(turn);
 const lower=[p(2,-4,4),p(4,-4,4),p(6.2,depth,4),p(2.5,depth,4)].map(turn);
 const points=[...upper,...lower];return {roof:{points,faces:[{id:0,points:upper},{id:1,points:lower}],connections:points.map((_,i)=>({startIdx:i,endIdx:i<4?(i+1)%4:4+(i-3)%4,type:i<4?type:'skylight'}))},ground:{points:[p(-30,-30,0),p(30,-30,0),p(30,30,0),p(-30,30,0)],faces:[[0,1,2],[0,2,3]]}};
}
function noPiercing(walls,roof){
 const plane=G.plane(roof.points);
 for(const w of walls){const ts=G.splitParameters(...w.bottom,[roof]);for(let i=1;i<ts.length;i++){
  const t=(ts[i-1]+ts[i])/2,p=mix(...w.bottom,t),top=mix(...w.top,t),z=plane.dx*p.x+plane.dy*p.y+plane.k;
  assert.ok(!G.contains(roof,p)||z<=p.z+.002||z>=top.z-.002,`${w.id} passes through roof ${roof.id}`);
 }}
}
for(const type of ['skylight','parapet'])for(const depth of [.4,1.4])for(const angle of [0,.71])test(`${type} clears a ${depth}m crossing roof as a complete run at ${angle}`,()=>{
 const f=fixture(type,depth,angle),before=JSON.stringify(f),r=build(f),sources=r.state.sources.filter(s=>s.id.startsWith('R1.'));
 assert.ok(sources.length);for(const s of sources){assert.ok(Math.abs(s.setback-depth)<1e-6);for(const p of [s.a,s.b])assert.ok(Math.abs(-p.x*Math.sin(angle)+p.y*Math.cos(angle)-depth)<1e-6);}
 const upper=r.state.sources.filter(s=>s.parentId===0);for(const s of upper)for(const p of [s.a,s.b])assert.ok(-p.x*Math.sin(angle)+p.y*Math.cos(angle)>=depth-1e-6,'side returns stop at the same inset line');
 noPiercing(r.composed,f.roof.faces[1]);assert.equal(r.open.length,0);assert.equal(JSON.stringify(f),before);
 // Force the fallback path as well: the original zero-overhang roof must
 // not be unioned back into the area removed by the clearance.
 const base=B.fromRoof(f.roof,f.ground,[],.6096,null,r.state.sources);
 const outside= {x:0.5*Math.cos(angle)-.1*Math.sin(angle),y:.5*Math.sin(angle)+.1*Math.cos(angle)};
 assert.ok(!base.faces.some(f=>G.contains(f,outside)),'no unsupported corner pillar is recreated by foundation fallback');
});
test('captured project has no generated wall passing through the walkway roof',()=>{
 const r=build(require('./fixtures/canopy-junction-roof.json'));
 noPiercing(r.composed,r.state.roof.faces.find(f=>f.id===2));
 const run=r.state.sources.filter(s=>s.parentId===21&&s.overlapClearanceRoofIds?.includes(2));assert.ok(run.length);
 for(const s of run)assert.ok(Math.abs(s.setback-.403102808)<.00001);
});
for(const mode of ['separate','above','inside'])test(`${mode} roof does not force a skylight soffit`,()=>{
 const f=fixture();const lower=f.roof.faces[1];for(const p of lower.points){if(mode==='separate')p.x+=20;if(mode==='above')p.z+=10;if(mode==='inside'){p.x=2+(p.x-2)/4.2;p.y=1+(p.y+4)/4.4;}}
 const r=G.buildSources(f.roof,{soffit:24,roofContacts:true});
 assert.ok(r.sources.filter(s=>s.parentId===0).every(s=>s.setback===0));
});

test('a shallower front clearance resolves the corner without a second deep side inset',()=>{
 const f=fixture('skylight',.05),r=G.buildSources(f.roof,{soffit:24,roofContacts:true});
 const left=r.sources.filter(s=>s.id.startsWith('R2.'));assert.ok(left.length);assert.ok(left.every(s=>s.setback===0));
 const reorder=structuredClone(f);reorder.roof.connections.reverse();reorder.roof.faces.reverse();
 const next=G.buildSources(reorder.roof,{soffit:24,roofContacts:true});
 const normalized=s=>s.filter(s=>s.parentId===0).map(s=>[s.a.x,s.a.y,s.b.x,s.b.y,s.setback].map(v=>+v.toFixed(6)).join(',')).sort();
 assert.deepEqual(normalized(next.sources),normalized(r.sources));
});
test('a roof opening through the proposed setback does not supply a continuous contact',()=>{
 const f=fixture('parapet',1.4);f.roof.faces[0].holes=[[p(2,1,5.2),p(3,1,5.2),p(3,2,5.4),p(2,2,5.4)]];
 const r=G.buildSources(f.roof,{soffit:24,roofContacts:true});assert.ok(r.sources.filter(s=>s.id.startsWith('R1.')).every(s=>s.setback===0));
});
