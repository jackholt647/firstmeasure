const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
const p=(x,y,z)=>({x,y,z});
const rect=(x0,y0,x1,y1,z)=>({points:[p(x0,y0,z),p(x1,y0,z),p(x1,y1,z),p(x0,y1,z)]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} ≠ ${b}`);
test('12 inch inset follows the roof pitch and walls reach ground without changing the roof',()=>{
    const points=[p(0,0,5),p(10,0,5),p(10,10,10),p(0,10,10)];
    const roof={points,connections:[{startIdx:0,endIdx:1,type:'eave'}],faces:[{points}]};
    const original=JSON.stringify(roof),r=G.build(roof,{soffit:12,ground:1,tolerance:.1});
    near(r.sources[0].a.y,.3048);near(r.sources[0].a.z,5+.3048*.5);
    near(r.extruded[0].bottom[0].z,1);assert.equal(JSON.stringify(roof),original);
    const geo=G.topology(r.extruded);assert.equal(geo.faces.length,1);assert.equal(geo.points.length,4);
    near(geo.faces[0].area,10*(5+.3048*.5-1));
    assert.equal(geo.faces[0].triangles.length,2);
});
test('inset walls miter into a closed rectangle at shared corners',()=>{
    const points=rect(0,0,10,8,6).points;
    const connections=points.map((_,i)=>({startIdx:i,endIdx:(i+1)%4,type:'eave'}));
    const r=G.buildSources({points,connections,faces:[{points}]},{soffit:12});
    assert.equal(r.sources.length,4);
    for(let i=0;i<4;i++){near(r.sources[i].b.x,r.sources[(i+1)%4].a.x);near(r.sources[i].b.y,r.sources[(i+1)%4].a.y);}
});
test('flashing extrudes up to the nearest covering roof, skips uncovered spans',()=>{
    const roof={faces:[{id:0,...rect(0,-2,10,0,2)},{id:1,...rect(0,-1,5,2,6)},{id:2,...rect(0,-1,5,2,9)}]};
    const source={id:'F',kind:'flashing',direction:'up',parentId:0,a:p(0,0,2),b:p(10,0,2)};
    const r=G.extrude(roof,[source],0);assert.equal(r.walls.length,1);near(r.walls[0].top[0].z,6);near(r.walls[0].top[1].x,5);assert.equal(r.warnings.length,1);
});
test('downward walls split at a lower roof footprint and stop on that roof',()=>{
    const roof={faces:[{id:0,...rect(0,-1,10,1,8)},{id:1,...rect(0,-1,5,1,3)}]};
    const source={id:'E',kind:'perimeter',direction:'down',parentId:0,a:p(0,0,8),b:p(10,0,8)};
    const r=G.extrude(roof,[source],0);assert.equal(r.walls.length,2);near(r.walls[0].bottom[0].z,3);near(r.walls[1].bottom[0].z,0);
});
test('roof holes do not intercept a vertical extrusion',()=>{
    const f={id:1,...rect(0,-1,10,1,3),holes:[rect(4,-.5,6,.5,3).points]};
    const r=G.extrude({faces:[f]},[{id:'E',kind:'perimeter',direction:'down',parentId:0,a:p(0,0,8),b:p(10,0,8)}],0);
    assert.equal(r.walls.length,3);near(r.walls[1].bottom[0].z,0);
});
test('auto setback infers the distance from lower flashing',()=>{
    const points=[p(0,0,8),p(10,0,8),p(0,.6096,3),p(10,.6096,3)];
    const upper={points:[p(0,0,8),p(10,0,8),p(10,10,10),p(0,10,10)]};
    const r=G.buildSources({points,connections:[{startIdx:0,endIdx:1,type:'eave'},{startIdx:2,endIdx:3,type:'head_wall'}],faces:[upper,rect(0,.6096,10,5,3)]},{soffit:'auto'});
    const e=r.sources.find(s=>s.kind==='perimeter');near(e.setback,.6096);assert.equal(e.inferred,true);
});
const wall=(kind,x0,x1,y,z0,z1)=>({id:kind,kind,sourceId:kind,bottom:[p(x0,y,z0),p(x1,y,z0)],top:[p(x0,y,z1),p(x1,y,z1)]});
test('dedupe preserves flashing and non-overlapping horizontal and vertical wall portions',()=>{
    const a=wall('flashing',2,8,.2,3,8),b=wall('perimeter',0,10,0,0,8);
    const before=JSON.stringify([a,b]),r=G.deduplicate([a,b],.3),geo=G.topology(r.walls);
    assert.equal(r.walls.filter(w=>w.kind==='flashing').length,1);assert.equal(r.walls.length,4);
    near(geo.faces.reduce((s,f)=>s+f.area,0),80);assert.equal(JSON.stringify([a,b]),before);
});
test('nearby parallel walls with no vertical overlap are retained',()=>{
    const r=G.deduplicate([wall('flashing',0,10,.2,8,10),wall('perimeter',0,10,0,0,6)],.3);
    assert.equal(r.walls.length,2);assert.equal(r.removed,0);
});
test('vertical wall vertices at the same plan position remain separate after serialization',()=>{
    const geo=G.topology([wall('perimeter',0,10,0,0,8)]);
    const restored=JSON.parse(JSON.stringify(geo));assert.equal(restored.points.length,4);
    assert.ok(restored.connections.some(c=>{const a=restored.points[c.startIdx],b=restored.points[c.endIdx];return a.x===b.x&&a.y===b.y&&a.z!==b.z;}));
});
test('dedupe splits sloping flashing where overlap starts partway along a wall',()=>{
    const flash={...wall('flashing',0,10,.1,0,10),bottom:[p(0,.1,4),p(10,.1,8)]};
    const r=G.deduplicate([flash,wall('perimeter',0,10,0,0,6)],.2);
    const area=G.topology(r.walls).faces.reduce((n,f)=>n+f.area,0);
    near(area,95); // flashing 40 + perimeter 60 - duplicate triangle 5
    assert.ok(r.removed>0);
});
test('unrelated roof planes do not scatter vertices along a straight wall',()=>{
    const faces=Array.from({length:100},(_,i)=>({id:i+1,points:[p(0,20,i*.1),p(10,20,10-i*.07),p(10,30,10-i*.07),p(0,30,i*.1)]}));
    const r=G.extrude({faces},[{id:'E',kind:'perimeter',direction:'down',a:p(0,0,8),b:p(10,0,8)}],0);
    assert.equal(r.walls.length,1);assert.equal(G.topology(r.walls).points.length,4);
});
test('adjacent coplanar roof patches produce one wall with four corners',()=>{
    const faces=Array.from({length:50},(_,i)=>({id:i+1,...rect(i*.2,-1,(i+1)*.2,1,3)}));
    const r=G.extrude({faces},[{id:'E',kind:'perimeter',direction:'down',a:p(0,0,8),b:p(10,0,8)}],0);
    assert.equal(r.walls.length,1);assert.equal(G.topology(r.walls).points.length,4);
    near(G.topology(r.walls).faces[0].area,50);
});
test('collinear source edges merge but a genuine roof pitch break stays',()=>{
    const sources=[{id:'A',kind:'perimeter',direction:'down',a:p(0,0,8),b:p(5,0,8)},{id:'B',kind:'perimeter',direction:'down',a:p(10,0,8),b:p(5,0,8)}];
    assert.equal(G.extrude({faces:[]},sources,0).walls.length,1);
    sources[1].a.z=10;
    assert.equal(G.extrude({faces:[]},sources,0).walls.length,2);
});
test('measured roof boundary eaves survive nonplanar face fitting',()=>{
    const {roof,options}=require('./fixtures/wall-roof-regression.json');
    const before=JSON.stringify(roof),r=G.build(roof,options);
    for(const id of ['R16','R55']){
        assert.ok(r.sources.some(s=>s.id.startsWith(id+'.')),`${id} must generate a source`);
        assert.ok(r.extruded.some(w=>w.sourceId.startsWith(id+'.')),`${id} must extrude`);
        assert.ok(r.deduplicated.some(w=>w.sourceId.startsWith(id+'.')),`${id} must remain after dedupe`);
    }
    assert.ok(!r.warnings.some(w=>w.includes('no resolved roof face')));
    assert.equal(JSON.stringify(roof),before);
});
test('projecting eave uses the long flashing below it instead of short neighboring overlaps',()=>{
    const {roof,options}=require('./fixtures/wall-roof-regression.json');
    const r=G.build(roof,options),source=r.sources.find(s=>s.id.startsWith('R39.'));
    near(source.setback,.3981431653388);
    const flash=r.sources.find(s=>s.id==='R43');
    near(source.a.x,flash.a.x);near(source.a.y,flash.a.y);
    near(source.b.x,flash.b.x);near(source.b.y,flash.b.y);
    assert.ok(r.extruded.some(w=>w.sourceId.startsWith('R39.')));
    assert.ok(!r.deduplicated.some(w=>w.sourceId.startsWith('R39.')),'aligned perimeter wall must not duplicate flashing');
    for(const id of ['R31.','R36.']){
        const s=r.sources.find(s=>s.id.startsWith(id));
        assert.ok(Math.hypot(s.b.x-s.a.x,s.b.y-s.a.y)>.6,'projecting side must not collapse');
    }
    for(const s of r.sources)assert.ok(Math.hypot(s.b.x-s.a.x,s.b.y-s.a.y)>=.005);
    for(const w of r.deduplicated)for(const p of [...w.bottom,...w.top])assert.ok([p.x,p.y,p.z].every(Number.isFinite));
});
test('lower inset eave crosses its corner hip and reaches the flashing wall',()=>{
    const {roof,options}=require('./fixtures/wall-roof-regression.json'),r=G.build(roof,options);
    const pieces=r.sources.filter(s=>s.id.startsWith('R48.')),flash=r.sources.find(s=>s.id==='R46');
    assert.equal(pieces.length,2);assert.equal(pieces[0].parentId,8);assert.equal(pieces[1].parentId,5);
    const p=pieces[0].a,u={x:flash.b.x-flash.a.x,y:flash.b.y-flash.a.y};
    near((p.x-flash.a.x)*u.y-(p.y-flash.a.y)*u.x,0);
    near(pieces[0].b.z,pieces[1].a.z);near(pieces[0].b.x,pieces[1].a.x);
    assert.ok(Math.hypot(pieces[0].b.x-p.x,pieces[0].b.y-p.y)>.28);
    const wall=r.deduplicated.find(w=>w.sourceId===pieces[0].id);assert.ok(wall);
    near(wall.bottom[0].z,options.ground);
});
test('source generation preserves flashing endpoints without speculative forward extensions or bases',()=>{
    const {roof,options}=require('./fixtures/wall-roof-regression.json'),before=JSON.stringify(roof),r=G.build(roof,options);
    for(const id of ['R40','R42','R44']){
        const flash=r.sources.find(s=>s.id===id),connection=roof.connections[Number(id.slice(1))-1];
        assert.deepEqual(flash.a,roof.points[connection.startIdx]);assert.deepEqual(flash.b,roof.points[connection.endIdx]);
        assert.equal(flash.direction,'up');
    }
    assert.ok(r.sources.every(s=>s.kind==='flashing'||s.kind==='perimeter'));
    assert.ok(!r.sources.some(s=>/-return-|-base/.test(s.id)));
    assert.equal(JSON.stringify(roof),before);
});

test('overlapping corner support uses the upper roof and stops the narrow wall at the lower roof',()=>{
    const {roof,options}=require('./fixtures/wall-roof-regression.json');
    for(const faces of [roof.faces,[...roof.faces].reverse()]){
        const r=G.build({...roof,faces},options);
        const source=r.sources.find(s=>s.id==='R13.0');
        assert.equal(source.parentId,9,'lower roof must remain available as an extrusion target');
        const walls=r.extruded.filter(w=>w.sourceId===source.id);
        assert.ok(walls.length);
        for(const w of walls){
            assert.equal(w.targetId,1);
            for(const p of w.bottom)assert.ok(p.z>options.ground+2,'corner strip must not hang down to ground');
        }
    }
});

test('stacked roof flashing stops at the inset eave instead of leaving a terminal spur',()=>{
 const c=require('./fixtures/wall_gap_case.json');
 const input=G.extrude(c.roof,G.buildSources(c.roof,c.options).sources,c.ground).walls;
 const before=JSON.stringify(input),result=G.deduplicate(input,c.options.tolerance).walls;
 assert.ok(input.some(w=>w.id==='R23:1'));
 assert.ok(!result.some(w=>w.id==='R23:1'),'the short continuation under the neighboring roof is removed');
 const end=result.find(w=>w.id==='R23:0').top[1],corner=input.find(w=>w.id==='R4.0:0').top[0];
 assert.ok(Math.hypot(end.x-corner.x,end.y-corner.y)<.002,'flashing ends at the crossing inset eave');
 assert.equal(JSON.stringify(input),before);
 const rounded=value=>JSON.stringify(value,(_,v)=>typeof v==='number'?+v.toFixed(7):v);
 assert.equal(rounded(G.deduplicate(result,c.options.tolerance).walls),rounded(result));
});
test('terminal trim preserves long branches, different-height crossings and connected returns',()=>{
 const make=(id,a,b,kind='flashing',top=6)=>({id,sourceId:id,kind,bottom:a.map((x,i)=>({x,y:b[i],z:2})),top:a.map((x,i)=>({x,y:b[i],z:top}))});
 const f=make('f',[0,0],[0,4.2]),cross=make('cross',[-2,2],[4,4],'perimeter');
 assert.equal(G.deduplicate([f,cross],.45).walls.find(w=>w.id==='f').top[1].y,4);
 for(const walls of [[f,{...cross,top:cross.top.map(p=>({...p,z:8}))}],[f,cross,make('return',[0,1],[4.2,4.2])],[{...f,bottom:[f.bottom[0],{x:0,y:5,z:2}],top:[f.top[0],{x:0,y:5,z:6}]},cross]]){
  const expected=walls[0].top[1].y;
  assert.equal(G.deduplicate(walls,.45).walls.find(w=>w.id==='f').top[1].y,expected);
 }
});

test('generation welds millimetre roof-fit disagreements at shared wall columns',()=>{
 const c=require('./fixtures/base-rebuild-chimney.json'),before=JSON.stringify(c.walls),walls=G.deduplicate(c.walls,0).walls;
 const columns=walls.flatMap(w=>[0,1].map(i=>({w,b:w.bottom[i],t:w.top[i]})));
 for(let i=0;i<columns.length;i++)for(let j=i+1;j<columns.length;j++){const a=columns[i],b=columns[j];if(a.w===b.w)continue;if(Math.hypot(a.b.x-b.b.x,a.b.y-b.b.y)<=.005&&Math.abs(a.b.z-b.b.z)<=.01&&Math.abs(a.t.z-b.t.z)<=.01){assert.deepEqual(a.b,b.b);assert.deepEqual(a.t,b.t);}}
 assert.equal(JSON.stringify(c.walls),before);
});
test('soffit inference records its evidence and falls back only when that evidence is removed',()=>{
 const points=[p(0,0,8),p(10,0,8),p(0,.22,3),p(8,.22,3),p(0,.6096,3),p(2,.6096,3)];
 const upper={points:[p(0,0,8),p(10,0,8),p(10,10,10),p(0,10,10)]};
 const roof={points,connections:[{startIdx:0,endIdx:1,type:'rake'},{startIdx:2,endIdx:3,type:'head_wall'},{startIdx:4,endIdx:5,type:'head_wall'}],faces:[upper,rect(0,.22,8,5,3)]};
 const sources=G.buildSources(roof,{soffit:'auto'}).sources,source=sources.find(s=>s.kind==='perimeter');
 assert.deepEqual(source.setbackFrom,['R2']);near(source.setback,.22);
 assert.equal(G.soffitWithoutSources(source,sources,['R3']),null,'unrelated cleanup does not alter an inferred soffit');
 near(G.soffitWithoutSources(source,sources,['R2']).setback,.6096,'other supporting flashing wins before the default');
 near(G.soffitWithoutSources(source,sources,['R2','R3']).setback,18*G.INCH);
 const manual=G.buildSources(roof,{soffit:12}).sources.find(s=>s.kind==='perimeter');
 assert.equal(G.soffitWithoutSources(manual,sources,['R2','R3']),null,'explicit soffit dimensions stay fixed');
});
function driftedFlashing(){
 const flashing={...wall('flashing',2,4,0,3,4.97),sourceRoofId:'lower',targetId:'upper'};
 flashing.bottom[0].y=flashing.top[0].y=.001;flashing.bottom[1].y=flashing.top[1].y=-.001;
 const perimeter={...wall('perimeter',0,10,0,0,5),sourceRoofId:'upper'};
 const turn={id:'return',sourceId:'return',kind:'perimeter',sourceRoofId:'lower',bottom:[p(4.25,-.001,0),p(4.25,-.06,0)],top:[p(4.25,-.001,3),p(4.25,-.06,3)]};
 return [flashing,perimeter,turn];
}
test('generated flashing and its return align to their common roof wall before deduplication',()=>{
 const input=driftedFlashing(),before=structuredClone(input),result=G.deduplicate(input).walls;
 const flash=result.find(w=>w.kind==='flashing'),turn=result.find(w=>w.id==='return');
 for(const p of [...flash.bottom,...flash.top])near(p.y,0);
 for(const p of flash.top)near(p.z,5);
 near(turn.bottom[0].y,0);near(turn.top[0].y,0);near(turn.bottom[1].y,-.06);
 assert.ok(!result.some(w=>w.kind==='perimeter'&&w.bottom.every(p=>p.z>4)),'fitted roof drift leaves no ledge');
 assert.deepEqual(input,before);
 assert.deepEqual(G.deduplicate(result).walls,result,'repair is stable on subsequent rebuilds');
});
test('flashing alignment requires the same roof and a sub-five-millimetre plane discrepancy',()=>{
 for(const scenario of ['unrelated roof','distinct plane']){
  const input=driftedFlashing();
  if(scenario==='unrelated roof')input[1].sourceRoofId='different';
  else for(const edge of [input[0].bottom,input[0].top])for(const p of edge)p.y+=.02;
  const flash=G.deduplicate(input).walls.find(w=>w.kind==='flashing');
  assert.deepEqual(flash.bottom,input[0].bottom,scenario);assert.deepEqual(flash.top,input[0].top,scenario);
 }
});
test('generated boundary cleanup keeps junctions, real corners and cumulative curvature',()=>{
 const ring=[{x:0,y:0,z:0},{x:1,y:0,z:.01},{x:2,y:0,z:0},{x:2,y:0,z:3},{x:0,y:0,z:3}];
 assert.equal(G.simplifyGeneratedRing(ring).length,4);
 assert.equal(G.simplifyGeneratedRing(ring,[ring[1]]).length,5,'adjoining wall endpoints are not disposable stations');
 const corner=[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1.01,y:0,z:.01},{x:1.01,y:0,z:3},{x:0,y:0,z:3}];
 assert.equal(G.simplifyGeneratedRing(corner).length,5,'small physical turns survive');
 const curve=Array.from({length:21},(_,i)=>({x:i,y:0,z:.002*i*i}));
 const simplified=G.simplifyGeneratedRing([...curve,{x:20,y:0,z:5},{x:0,y:0,z:5}]);
 assert.ok(simplified.length>4,'local near-collinearity cannot accumulate into flattening a curved boundary');
 assert.equal(G.simplifyGeneratedRing([{x:0,y:0,z:0},{x:2,y:0,z:.001},{x:4,y:0,z:0}]).length,3,'never collapse a face into a line');
});
test('flashing strips on a generated wall run drop survey stations like perimeter strips',()=>{
 // A perimeter strip and two flashing strips over a lower roof share one
 // plane. The eave top and the roof-contact bottom carry millimetre noise
 // at the strip stations; only the step at x=2 is a real corner.
 const strips=()=>[
  {id:'w',sourceId:'R1.0',kind:'perimeter',bottom:[p(0,0,0),p(2,0,0)],top:[p(0,0,8),p(2,0,8.003)]},
  {id:'f1',sourceId:'R2',kind:'flashing',bottom:[p(2,0,1),p(4,0,2.002)],top:[p(2,0,8.003),p(4,0,7.998)]},
  {id:'f2',sourceId:'R2',kind:'flashing',bottom:[p(4,0,2.002),p(6,0,3)],top:[p(4,0,7.998),p(6,0,8)]}];
 assert.equal(G.surveyedGeneratedRun(strips()),true);
 assert.equal(G.surveyedGeneratedRun([...strips(),{...strips()[0],id:'c',chimney:{id:'c'}}]),false,'chimney strips keep their stations');
 assert.equal(G.surveyedGeneratedRun([{...strips()[0],sourceId:undefined}]),false,'user walls keep their points');
 const walls=G.mergeCoplanar(strips()).walls,geo=G.topology(walls),face=geo.faces[0];
 assert.equal(geo.faces.length,1);
 const ring=face.pointIndices.map(i=>geo.points[i]).map(q=>[q.x,q.z].map(v=>+v.toFixed(6)).join(',')).sort();
 assert.deepEqual(ring,['0,0','0,8','2,0','2,1','6,3','6,8'],'only the corners remain');
 // The stations are snapped onto their straight runs in every strip that shares them.
 const at=(id,edge,i)=>walls.find(w=>w.id===id)[edge][i].z;
 assert.ok(Math.abs(at('w','top',1)-8)<1e-9&&Math.abs(at('f1','top',0)-8)<1e-9&&Math.abs(at('f1','top',1)-8)<1e-9&&Math.abs(at('f2','top',0)-8)<1e-9);
 assert.ok(Math.abs(at('f1','bottom',1)-2)<1e-9&&Math.abs(at('f2','bottom',0)-2)<1e-9);
 // A wall turning away at a station is a real junction: that station stays.
 const side={id:'side',sourceId:'R9.0',kind:'perimeter',bottom:[p(4,0,2.002),p(4,-3,2.002)],top:[p(4,0,7.998),p(4,-3,7.998)]};
 const joined=G.mergeCoplanar([...strips(),side]).walls,geo2=G.topology(joined),run=geo2.faces.find(f=>f.mergeGroup);
 const kept=run.pointIndices.map(i=>geo2.points[i]);
 assert.ok(kept.some(q=>q.x===4&&q.z===7.998)&&kept.some(q=>q.x===4&&q.z===2.002),'stations shared with the side wall stay');
 assert.deepEqual(joined.find(w=>w.id==='side').top,side.top,'the side wall is not moved');
});
test('two generated runs sharing a survey line drop its stations together; another run protects a station only where it turns',()=>{
 // A perimeter run and a flashing run above it keep separate merge groups
 // (as chimney clean-up and flashing groups leave them) but share the roof
 // contact line z=3. Both carry the same survey stations at x=2 and x=4, and
 // deduplication left a 0.3 mm crack between the perimeter strips at x=4.
 const runs=()=>[
  {id:'a1',sourceId:'R1.0',kind:'perimeter',mergeGroup:'A',bottom:[p(0,0,0),p(2,0,0)],top:[p(0,0,3),p(2,0,3.004)]},
  {id:'a2',sourceId:'R1.0',kind:'perimeter',mergeGroup:'A',bottom:[p(2,0,0),p(4,0,0)],top:[p(2,0,3.004),p(4,0,2.997)]},
  {id:'a3',sourceId:'R1.0',kind:'perimeter',mergeGroup:'A',bottom:[p(4.0003,0,0),p(6,0,0)],top:[p(4.0003,0,2.997),p(6,0,3)]},
  {id:'b1',sourceId:'R2',kind:'flashing',mergeGroup:'B',bottom:[p(0,0,3),p(2,0,3.004)],top:[p(0,0,5),p(2,0,5)]},
  {id:'b2',sourceId:'R2',kind:'flashing',mergeGroup:'B',bottom:[p(2,0,3.004),p(4,0,2.997)],top:[p(2,0,5),p(4,0,5)]},
  {id:'b3',sourceId:'R2',kind:'flashing',mergeGroup:'B',bottom:[p(4,0,2.997),p(6,0,3)],top:[p(4,0,5),p(6,0,5)]}];
 const outline=(geo,group)=>geo.faces.filter(f=>f.mergeGroup===group).flatMap(f=>f.pointIndices.map(i=>geo.points[i])).map(q=>[q.x,q.z].map(v=>+v.toFixed(4)).join(',')).sort();
 const geo=G.topology(runs());
 assert.deepEqual(outline(geo,'A'),['0,0','0,3','6,0','6,3'],'the perimeter run has only its corners');
 assert.deepEqual(outline(geo,'B'),['0,3','0,5','6,3','6,5'],'the flashing run has only its corners');
 // Every strip that has a station, on either side of the shared line and of the crack, is snapped onto the same straight line.
 const walls=G.canonicalGeneratedWalls(runs()),z=(id,edge,i)=>walls.find(w=>w.id===id)[edge][i].z;
 for(const [id,edge,i]of [['a1','top',1],['a2','top',0],['b1','bottom',1],['b2','bottom',0],['a2','top',1],['a3','top',0],['b2','bottom',1],['b3','bottom',0]])assert.ok(Math.abs(z(id,edge,i)-3)<1e-9,id+' '+edge+' '+i);
 assert.deepEqual(outline(G.topology(walls),'A'),outline(geo,'A'),'a second pass keeps the same outline');
 // A side wall turning away at x=4 is a real junction: both runs keep that station.
 const side={id:'side',sourceId:'R9.0',kind:'perimeter',bottom:[p(4,0,0),p(4,-3,0)],top:[p(4,0,2.997),p(4,-3,2.997)]};
 const turned=G.topology([...runs(),side]);
 assert.ok(outline(turned,'A').includes('4,2.997')&&outline(turned,'B').includes('4,2.997'));
 assert.ok(!outline(turned,'A').includes('2,3.004')&&!outline(turned,'B').includes('2,3.004'),'the straight station at x=2 still goes');
 // The same outline seeds a new wall draft.
 const rings=G.generatedGroupOutline(runs(),runs().filter(w=>w.mergeGroup==='A'));
 assert.deepEqual(rings.flatMap(f=>f.points).map(q=>[q.x,q.z].map(v=>+v.toFixed(4)).join(',')).sort(),outline(geo,'A'));
});
test('rebuilt faces drop survey stations together and keep user points, other faces\' vertices and shared edges',()=>{
 // A rebuilt wall and the rebuilt flashing face above it share a roof-contact
 // edge carrying Resoffit roof samples at x=1, 2 and 3.
 const wall=()=>({id:'wall',surveyedRun:true,points:[p(0,0,0),p(4,0,0),p(4,0,3),p(3,0,3.003),p(2,0,2.996),p(1,0,3.002),p(0,0,3)],retainedPoints:[p(2,0,2.996),p(1,0,1)]});
 const flashing=()=>({id:'flashing',surveyedRun:true,points:[p(0,0,3),p(1,0,3.002),p(2,0,2.996),p(3,0,3.003),p(4,0,3),p(4,0,5),p(0,0,5)]});
 const xs=f=>f.points.filter(q=>q.z>2.5&&q.z<3.5).map(q=>q.x).sort((a,b)=>a-b);
 let r=G.cleanSurveyedFaces([wall(),flashing()]);
 assert.deepEqual(r.faces.map(xs),[[0,4],[0,4]],'both faces lose the same stations');
 assert.deepEqual(r.faces[0].retainedPoints,[p(1,0,1)],'retained anchors at removed stations go too');
 assert.ok(r.chords.length&&r.chords.every(c=>[c.a.x,c.b.x].sort().join()==='0,4'&&c.stations.length===3),'selections on the station edges map to the kept edge');
 // A side wall that is not rebuilt meets the run at x=2: that station stays in both.
 const side={id:'side',points:[p(2,0,2.996),p(2,-3,2.996),p(2,-3,0),p(2,0,0)]};
 r=G.cleanSurveyedFaces([wall(),flashing(),side]);
 assert.deepEqual(r.faces.slice(0,2).map(xs),[[0,2,4],[0,2,4]]);assert.equal(r.faces[2],side,'other faces are never rewritten');
 // So does a corner of another face a fraction of a millimetre away.
 const near={id:'near',points:[p(2.0004,0,2.996),p(2.0004,-3,2.996),p(2.0004,-3,0)]};
 assert.deepEqual(G.cleanSurveyedFaces([wall(),flashing(),near]).faces.slice(0,2).map(xs),[[0,2,4],[0,2,4]]);
 // A user point stays.
 assert.deepEqual(G.cleanSurveyedFaces([wall(),flashing()],{protect:[p(3,0,3.003)]}).faces.map(xs),[[0,3,4],[0,3,4]]);
 // A station on another face's edge goes only where the kept edge still passes through it.
 const ledge={id:'ledge',points:[p(0,0,3),p(2,0,2.996),p(2,1,2.996),p(0,1,3)]};
 assert.deepEqual(xs(G.cleanSurveyedFaces([wall(),ledge],{eligible:f=>f.id==='wall'}).faces[0]),[0,2,4]);
 const exact={id:'wall',surveyedRun:true,points:[p(0,0,0),p(4,0,0),p(4,0,3),p(2,0,3),p(0,0,3)]},flat={id:'ledge',points:[p(0,0,3),p(4,0,3),p(4,1,3),p(0,1,3)]};
 assert.deepEqual(xs(G.cleanSurveyedFaces([exact,flat]).faces[0]),[0,4]);
 // Faces that are not rebuilt from generated geometry keep every point.
 const user={...wall(),surveyedRun:false};assert.equal(G.cleanSurveyedFaces([user]).faces[0],user);
});

test('flashing alignment retains substantial height differences and unrelated nearby returns',()=>{
 const input=driftedFlashing();for(const p of input[0].top)p.z=4.8;input[2].sourceRoofId='unrelated';
 const result=G.deduplicate(input).walls,flash=result.find(w=>w.kind==='flashing'),turn=result.find(w=>w.id==='return');
 for(const p of flash.top)near(p.z,4.8);
 near(turn.bottom[0].y,-.001);near(turn.top[0].y,-.001);
 assert.ok(result.some(w=>w.kind==='perimeter'&&w.bottom.every(p=>p.z>=4.8)),'a real height step keeps its upper wall portion');
});

test('canonical generated runs change source coordinates and filled triangle boundaries together',()=>{
 const heights=[4,3.98,3.975,4.002,3.99,4.01,4.005,4],input=heights.slice(1).map((z,i)=>({id:'part-'+i,sourceId:'roof',kind:'perimeter',bottom:[p(i,0,0),p(i+1,0,0)],top:[p(i,0,heights[i]),p(i+1,0,z)]})),original=structuredClone(input),walls=G.mergeCoplanar(input).walls,geo=G.topology(walls);
 assert.deepEqual(input,original,'generation never overwrites source measurements');assert.ok(walls.every(w=>w.top.every(p=>Math.abs(p.z-4)<1e-8)));
 assert.ok(geo.faces[0].triangles.flat().every(i=>geo.points[i].z===0||Math.abs(geo.points[i].z-4)<1e-8));assert.equal(geo.faces[0].pointIndices.length,4);
 assert.deepEqual(G.canonicalGeneratedWalls(walls),walls,'canonicalization is stable on repeated passes');
 const protectedWalls=original.map(w=>({...w,mergeGroup:'protected'}));assert.deepEqual(G.canonicalGeneratedWalls(protectedWalls,['part-2']),protectedWalls,'authored owners stay protected');
});


test('merged source overlaps produce one filled region, while holes and disconnected regions stay valid',()=>{
 const K=require('../public/measure/internal/editor_scripts/exterior_geometry'),strip=(id,a,b,low,high)=>({id,sourceId:'roof',kind:'perimeter',mergeGroup:'merged',bottom:[p(a,0,low),p(b,0,low)],top:[p(a,0,high),p(b,0,high)]});
 const overlap=G.topology([strip('a',0,3,0,3),strip('b',2,5,0,3)]);
 assert.equal(overlap.faces.length,1);assert.equal(overlap.faces[0].area,15);assert.equal(overlap.points.length,4);assert.equal(overlap.connections.length,4);
 const holed=G.topology([strip('left',0,1,0,4),strip('right',3,4,0,4),strip('bottom',1,3,0,1),strip('top',1,3,3,4),strip('island',6,7,0,1)]);
 assert.equal(holed.faces.length,2);assert.equal(holed.faces.reduce((a,f)=>a+f.area,0),13);assert.equal(holed.faces.filter(f=>f.holes?.length).length,1);
 for(const geo of [overlap,holed])for(const face of geo.faces){K.validateFace({points:face.pointIndices.map(i=>geo.points[i]),holes:(face.holes||[]).map(r=>r.map(i=>geo.points[i]))});assert.deepEqual(new Set(face.triangles.flat()),new Set([...face.pointIndices,...(face.holes||[]).flat()]));}
});

test('FM-312: a merged wall touched a fraction of a micron off its corner still meshes instead of stopping walls from drawing, saving or loading',()=>{
 // Two walls after a roof edit on a real house: the eave wall's top corner sits
 // 5e-8 m beside the merged wall's corner, which twisted the merged outline below
 // the polygon grid. topology threw "The face does not define a valid planar
 // region" from render, serialize and restore, so the project could not open.
 const walls=[
  {id:'envelope-0-30-3',sourceId:'R105.1',kind:'perimeter',type:'eave',bottom:[p(5.5344029195994,-11.83268717540892,63.709999084472656),p(6.194613,-11.176371,63.709999084472656)],top:[p(5.5344029195994,-11.83268717540892,69.8420177518614),p(6.194612948418327,-11.176370951824193,69.84227460815869)],mergeGroup:'envelope-0-30-1|envelope-0-30-3'},
  {id:'envelope-0-0-1:roof-1',sourceId:'envelope-0-0',kind:'perimeter',type:'wall',bottom:[p(6.194613,-11.176371,63.709999084472656),p(6.27090956010378,-11.25312037273506,63.709999084472656)],top:[p(6.194613,-11.176371,69.84296310753994),p(6.27090956010378,-11.25312037273506,69.74048822518337)],mergeGroup:'envelope-0-0-1:roof-1|envelope-0-0-1:roof-2|envelope-0-0-1:roof-3'}];
 const warn=console.warn;console.warn=()=>{};let geo;try{geo=G.topology(walls);}finally{console.warn=warn;}
 assert.equal(geo.faces.length,2);
 for(const [i,w] of walls.entries()){
  const face=geo.faces.find(f=>f.mergeGroup===w.mergeGroup),width=Math.hypot(w.bottom[1].x-w.bottom[0].x,w.bottom[1].y-w.bottom[0].y),height=(w.top[0].z-w.bottom[0].z+w.top[1].z-w.bottom[1].z)/2;
  assert.ok(face.triangles.length>=2,'wall '+i+' is filled');assert.ok(Math.abs(face.area-width*height)<1e-3,`wall ${i}: ${face.area} vs ${width*height}`);
 }
});
