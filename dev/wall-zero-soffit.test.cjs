const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry');
const R=require('../public/measure/internal/editor_scripts/wall_resoffit');
const B=require('../public/measure/internal/editor_scripts/base_geometry');
const p=(x,y,z)=>({x,y,z}),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function roof(pitch,type='eave'){
 const points=[p(0,0,5),p(10,0,5),p(10,12,5+pitch),p(0,12,5+pitch)];
 return {points,faces:[{id:0,points:points.slice()}],connections:points.map((_,i)=>({startIdx:i,endIdx:(i+1)%4,type:i===0?type:'eave'}))};
}
for(const [pitch,type,depth]of [[0,'eave',0],[.99,'eave',0],[1,'eave',24*G.INCH],[6,'eave',24*G.INCH],[6,'parapet',0],[6,'skylight',0]]){
 test(`${type} at ${pitch}/12 uses the correct From Roof default`,()=>{
  const input=roof(pitch,type),before=JSON.stringify(input);
  const result=G.build(input,{soffit:'auto',defaultSoffitInches:24,roofContacts:true,ground:0});
  const source=result.sources.find(s=>s.id.startsWith('R1.'));
  assert.ok(source);near(source.setback,depth);near(source.a.y,depth);near(source.b.y,depth);
  assert.ok(result.extruded.some(w=>w.sourceId===source.id));assert.equal(JSON.stringify(input),before);
 });
}
for(const [pitch,type]of [[0,'eave'],[.5,'rake'],[6,'parapet'],[6,'skylight']]){
 test(`manual Resoffit overrides zero default for ${type} at ${pitch}/12`,()=>{
  const input=roof(pitch,type),result=G.build(input,{soffit:24,ground:0});
  const faces=result.extruded.map(w=>({id:w.id,points:[...w.bottom,...w.top.slice().reverse()]}));
  const choice=R.candidates(faces,input,result.sources).find(c=>c.source.id.startsWith('R1.'));
  assert.ok(choice,'zero-depth roof-contact line is selectable');
  const changed=R.apply(faces,[choice.pair],.3048,input,result.sources);
  assert.ok(changed.faces.find(f=>f.id===choice.faceId).points.every(p=>Math.abs(p.y-.3048)<1e-7));
  const again=R.apply(changed.faces,changed.pairs,.1524,input,result.sources);
  assert.ok(again.faces.find(f=>f.id===choice.faceId).points.every(p=>Math.abs(p.y-.1524)<1e-7));
 });
}
test('inset skylights and shared glass-roof seams do not generate perimeter walls',()=>{
 const input=roof(0),hole=[p(2,2,5),p(4,2,5),p(4,4,5),p(2,4,5)];
 input.faces[0].holes=[hole];input.points.push(...hole);
 input.connections.push(...hole.map((_,i)=>({startIdx:4+i,endIdx:4+(i+1)%4,type:'skylight'})));
 input.faces.push({id:1,points:hole});
 assert.equal(G.buildSources(input,{soffit:24}).sources.filter(s=>s.type==='skylight').length,0);
 input.faces.pop();
 assert.equal(G.buildSources(input,{soffit:24}).sources.filter(s=>s.type==='skylight').length,0,'hole alone is not an exterior');
});
test('mixed flat and pitched roof preserves different depths with measured flashing enabled',()=>{
 const input=roof(6),flat=[p(-10,0,5),p(0,0,5),p(0,12,5),p(-10,12,5)];
 input.faces.push({id:1,points:flat});input.points.push(...flat,p(-10,.6,3),p(0,.6,3));
 input.connections.push({startIdx:4,endIdx:5,type:'eave'},{startIdx:8,endIdx:9,type:'head_wall'});
 for(const soffit of [24,'auto']){
  const result=G.buildSources(input,{soffit,roofContacts:true});
  near(result.sources.find(s=>s.id.startsWith('R1.')).setback,(soffit==='auto'?18:24)*G.INCH);
  near(result.sources.find(s=>s.id.startsWith('R5.')).setback,0);
 }
});
test('only the exposed portion of a partly shared skylight edge generates a wall',()=>{
 const input=roof(6,'skylight');
 input.faces.push({id:1,points:[p(0,-4,3),p(5,-4,3),p(5,0,5),p(0,0,5)]});
 const sources=G.buildSources(input,{soffit:24}).sources.filter(s=>s.type==='skylight');
 assert.ok(sources.length);
 for(const s of sources){near(s.setback,0);assert.ok(s.a.x>=5&&s.b.x>=5);near(s.a.y,0);near(s.b.y,0);}
});
test('foundation fallback follows zero-soffit sides as well as the chosen pitched-roof inset',()=>{
 for(const pitch of [0,6]){
  const input=roof(pitch,'parapet'),sources=G.buildSources(input,{soffit:24}).sources;
  const grade={points:[p(-20,-20,0),p(20,-20,0),p(20,20,0),p(-20,20,0)]};
  const base=B.fromRoof(input,grade,[],24*G.INCH,null,sources);
  const points=base.faces.flatMap(f=>f.points);
  near(Math.min(...points.map(p=>p.y)),0);
  near(Math.max(...points.map(p=>p.y)),12-(pitch?24*G.INCH:0));
 }
});
