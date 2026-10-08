const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry'),P=require('../public/measure/internal/editor_scripts/wall_parapets'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),M=require('../public/measure/internal/editor_scripts/exterior_model'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry');
const p=(x,y,z=5)=>({x,y,z}),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function fixture(points=[p(0,0),p(10,0),p(10,8),p(0,8)],types=['parapet','parapet','parapet','parapet'],reverse=false){
 const roof={points,faces:[{id:0,points}],connections:points.map((_,i)=>({startIdx:reverse?(i+1)%points.length:i,endIdx:reverse?i:(i+1)%points.length,type:types[i]||'eave'}))};
 const r=G.build(roof,{soffit:24,ground:0});return {roof,...r};
}
test('a single parapet rises two feet above the roof with a six-inch cap and inward return',()=>{
 const f=fixture(undefined,['parapet']),before=JSON.stringify(f),faces=P.build(f.roof,f.sources,f.extruded);
 assert.equal(faces.length,5);const cap=faces.find(f=>f.id.endsWith(':cap')),inner=faces.find(f=>f.id.endsWith(':inside'));
 near(Math.max(...cap.points.map(p=>p.y)),.1524);assert.ok(cap.points.every(p=>p.z===5+.6096));
 near(Math.min(...inner.points.map(p=>p.z)),5);assert.ok(K.normal(cap.points).z>.99);assert.ok(K.normal(inner.points).y>.99);
 faces.forEach(K.validateFace);assert.equal(JSON.stringify(f),before);
});
for(const reverse of [false,true])test(`closed parapets share cap and inside corners with reversed lines=${reverse}`,()=>{
 const f=fixture(undefined,undefined,reverse),faces=P.build(f.roof,f.sources,f.extruded),caps=faces.filter(f=>f.id.endsWith(':cap')),inner=faces.filter(f=>f.id.endsWith(':inside'));
 assert.equal(caps.length,4);assert.equal(inner.length,4);faces.forEach(K.validateFace);
 const total=caps.reduce((sum,f)=>sum+K.area(f),0),union=K.union(caps).reduce((sum,f)=>sum+K.area(f),0);
 near(total,union);near(total,80-(10-2*P.WIDTH)*(8-2*P.WIDTH));
 const vertices=inner.flatMap(f=>f.points),counts=new Map();vertices.forEach(p=>{const key=K.pointKey(p);counts.set(key,(counts.get(key)||0)+1);});assert.ok([...counts.values()].every(n=>n===2));
});
test('concave adjoining parapets meet without overlapping cap area',()=>{
 const f=fixture([p(0,0),p(10,0),p(10,4),p(6,4),p(6,8),p(0,8)],Array(6).fill('parapet'));
 const faces=P.build(f.roof,f.sources,f.extruded),caps=faces.filter(f=>f.id.endsWith(':cap'));assert.equal(faces.length,18);faces.forEach(K.validateFace);
 near(caps.reduce((sum,f)=>sum+K.area(f),0),K.union(caps).reduce((sum,f)=>sum+K.area(f),0));
});
test('cap materialization uses only surviving parapet tops, including merged wall records',()=>{
 const f=fixture(undefined,['parapet']),wall=f.extruded.find(w=>w.sourceId.startsWith('R1.'));
 assert.equal(P.build(f.roof,f.sources,[]).length,0);
 const merged={...wall,sourceId:'another-edge',top:[p(-2,0),p(4,0)]};
 const faces=P.build(f.roof,f.sources,[merged,merged]);assert.equal(faces.length,5);assert.ok(faces.flatMap(f=>f.points).every(p=>p.x>=0&&p.x<=4));
});
for(const reverse of [false,true])for(const shape of ['single','corner','straight'])test(`open ${shape} parapet seals only exposed ends, reversed=${reverse}`,()=>{
 const points=shape==='straight'?[p(0,0),p(5,0),p(10,0),p(10,8),p(0,8)]:undefined;
 const f=fixture(points,shape==='single'?['parapet']:['parapet','parapet'],reverse),faces=P.build(f.roof,f.sources,f.extruded),ends=faces.filter(f=>f.parapet.part==='end');
 assert.equal(ends.length,2);faces.forEach(K.validateFace);
 for(const end of ends){near(K.area({points:end.points.map(p=>K.local(K.frame(end),p))}),P.WIDTH*P.HEIGHT);const cap=faces.find(f=>f.id===end.id.replace(/:end-\d$/,':cap'));assert.ok(cap);assert.equal(end.points.filter(p=>cap.points.some(q=>K.pointKey(p)===K.pointKey(q))).length,2,'end shares both top corners with the cap');}
 const saved=JSON.parse(JSON.stringify({wallEdits:{$surfaces:faces}}));assert.deepEqual(M.collect(saved),faces,'end faces persist as editable geometry');
});
test('a removed middle interval leaves four sealed parapet ends',()=>{
 const f=fixture(undefined,['parapet']),w=f.extruded.find(w=>w.sourceId.startsWith('R1.'));
 const faces=P.build(f.roof,f.sources,[{...w,top:[p(0,0),p(3,0)]},{...w,top:[p(7,0),p(10,0)]}]);
 assert.equal(faces.filter(f=>f.parapet.part==='end').length,4);faces.forEach(K.validateFace);
});
test('ordinary editable surfaces preserve an adjusted inside height across serialization',()=>{
 const f=fixture(),faces=P.build(f.roof,f.sources,f.extruded);
 const pairs=faces.filter(f=>f.id.endsWith(':inside')).map(f=>f.points.filter(p=>p.z===5));
 const edited=W.slideLines(faces,pairs,{x:0,y:0,z:1},-.3048),state={wallEdits:{$surfaces:edited.faces}};
 const saved=JSON.parse(JSON.stringify(state)),collected=M.collect(saved);
 assert.equal(collected.length,12);collected.forEach(K.validateFace);
 near(Math.min(...collected.flatMap(f=>f.points).map(p=>p.z)),5-.3048);
 assert.deepEqual(M.collect(saved),collected,'collection does not regenerate the defaults');
});
test('Resoffit keeps automatic parapet caps six inches wide',()=>{
 const R=require('../public/measure/internal/editor_scripts/wall_resoffit'),f=fixture();
 const faces=[...f.extruded.map(w=>({id:w.id,points:[...w.bottom,...w.top.slice().reverse()]})),...P.build(f.roof,f.sources,f.extruded)];
 const changed=R.apply(faces,R.candidates(faces,f.roof,f.sources).map(c=>c.pair),.3048,f.roof,f.sources);
 const inside=changed.faces.filter(f=>f.parapet?.part==='inside');
 near(Math.min(...inside.flatMap(f=>f.points).map(p=>p.y)),.3048+P.WIDTH);
 const caps=changed.faces.filter(f=>f.parapet?.part==='cap');assert.ok(caps.every(f=>K.normal(f.points).z>.99));changed.faces.forEach(K.validateFace);
});

test('raised parapets inset the visible roof by cap width without changing source geometry',()=>{
 const f=fixture(),before=JSON.stringify(f.roof),surfaces=P.build(f.roof,f.sources,f.extruded),roof=P.roofWithInsets(f.roof,surfaces);
 near(roof.faces.reduce((s,f)=>s+K.area(f),0),(10-2*P.WIDTH)*(8-2*P.WIDTH));
 assert.ok(roof.faces.flatMap(f=>f.points).every(p=>p.z===5));
 const outside=surfaces.filter(f=>f.parapet.part==='outside');assert.equal(outside.length,4);near(Math.min(...outside.flatMap(f=>f.points).map(p=>p.z)),5);near(Math.max(...outside.flatMap(f=>f.points).map(p=>p.z)),5+P.HEIGHT);
 assert.equal(JSON.stringify(f.roof),before);assert.equal(P.roofWithInsets(f.roof,[]),f.roof);
 const C=require('../public/measure/internal/editor_scripts/wall_chimneys');assert.deepEqual(C.roofWithOpenings({roof:f.roof,wallEdits:{$surfaces:surfaces}}),roof);
});

test('parapet roof insets compose with chimney openings and edited cap heights',()=>{
 const f=fixture(),surfaces=P.build(f.roof,f.sources,f.extruded),C=require('../public/measure/internal/editor_scripts/wall_chimneys');
 for(const cap of surfaces.filter(f=>f.parapet.part==='cap'))for(const p of cap.points)p.z+=1;
 const state={roof:f.roof,wallEdits:{$surfaces:surfaces},chimneys:{items:[{id:'test',points:[p(2,2),p(3,2),p(3,3),p(2,3)]}]}};
 const result=C.roofWithOpenings(state);near(result.faces.reduce((sum,f)=>sum+K.area(f),0),(10-2*P.WIDTH)*(8-2*P.WIDTH)-1);
});
