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
    const r=G.buildSources({points,connections:[{startIdx:0,endIdx:1,type:'eave'},{startIdx:2,endIdx:3,type:'head_wall'}],faces:[rect(0,0,10,10,8),rect(0,.6096,10,5,3)]},{soffit:'auto'});
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
 const roof={points,connections:[{startIdx:0,endIdx:1,type:'rake'},{startIdx:2,endIdx:3,type:'head_wall'},{startIdx:4,endIdx:5,type:'head_wall'}],faces:[rect(0,0,10,10,8),rect(0,.22,8,5,3)]};
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

test('flashing alignment retains substantial height differences and unrelated nearby returns',()=>{
 const input=driftedFlashing();for(const p of input[0].top)p.z=4.8;input[2].sourceRoofId='unrelated';
 const result=G.deduplicate(input).walls,flash=result.find(w=>w.kind==='flashing'),turn=result.find(w=>w.id==='return');
 for(const p of flash.top)near(p.z,4.8);
 near(turn.bottom[0].y,-.001);near(turn.top[0].y,-.001);
 assert.ok(result.some(w=>w.kind==='perimeter'&&w.bottom.every(p=>p.z>=4.8)),'a real height step keeps its upper wall portion');
});
