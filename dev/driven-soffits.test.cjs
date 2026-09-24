const test=require('node:test'),assert=require('node:assert/strict'),G=require('../public/measure/internal/editor_scripts/wall_geometry.js');
function roofFixture({ring=Array.from({length:8},(_,i)=>({x:4*Math.cos(i*Math.PI/4),y:4*Math.sin(i*Math.PI/4),z:5})),apex={x:0,y:0,z:7},seed=0,measured=true,depth=6}={}){
 const points=ring.map(p=>({...p})),faces=ring.map((p,i)=>({id:'pitch'+i,points:[p,ring[(i+1)%ring.length],apex]})),connections=ring.map((_,i)=>({startIdx:i,endIdx:(i+1)%ring.length,type:'eave'}));
 if(measured){const a=ring[seed],b=ring[(seed+1)%ring.length],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),n={x:-dy/len,y:dx/len};points.push(...[a,b].map(p=>({x:p.x+n.x*depth*G.INCH,y:p.y+n.y*depth*G.INCH,z:4.5})));connections.push({startIdx:ring.length,endIdx:ring.length+1,type:'roof_to_wall'});}
 return {points,faces,connections};
}
const options={soffit:'auto',defaultSoffitInches:24,roofContacts:true};
const perimeter=r=>r.sources.filter(s=>s.kind==='perimeter'&&!s.boundaryReference);
test('measured six-inch contact drives a flat connected turret instead of the two-foot default',()=>{
 const roof=roofFixture(),before=JSON.stringify(roof),enabled=G.buildSources(roof,options),disabled=G.buildSources(roof,{...options,drivenSoffits:false});
 const next=perimeter(enabled),old=perimeter(disabled);assert.ok(next.length>=8);assert.ok(next.every(s=>Math.abs(s.setback-6*G.INCH)<1e-6));assert.ok(old.some(s=>Math.abs(s.setback-24*G.INCH)<1e-6));
 const span=ss=>{const z=ss.flatMap(s=>[s.a.z,s.b.z]);return Math.max(...z)-Math.min(...z);};assert.ok(span(next)<1e-6);assert.ok(span(old)>.1);assert.equal(JSON.stringify(roof),before);
});
test('the default wins where a different pitch keeps the adjoining height flatter',()=>{
 const ring=[{x:0,y:0,z:5},{x:4,y:0,z:5},{x:4,y:16,z:5},{x:0,y:16,z:5}],roof=roofFixture({ring,apex:{x:.8,y:3.2,z:7},seed:3});
 const sources=G.buildSources(roof,options).sources,bottom=sources.find(s=>s.kind==='perimeter'&&s.parentId==='pitch0');assert.ok(bottom);assert.ok(Math.abs(bottom.setback-24*G.INCH)<1e-6);assert.ok(bottom.drivenSoffit);
});
test('a separate roof at the same height does not inherit the measured depth',()=>{
 const roof=roofFixture(),other=roofFixture({measured:false});const offset=roof.points.length;roof.points.push(...other.points.map(p=>({...p,x:p.x+20})));roof.faces.push(...other.faces.map(f=>({...f,id:'other'+f.id,points:f.points.map(p=>({...p,x:p.x+20}))})));roof.connections.push(...other.connections.map(c=>({...c,startIdx:c.startIdx+offset,endIdx:c.endIdx+offset})));
 const sources=G.buildSources(roof,options).sources.filter(s=>String(s.parentId).startsWith('other'));assert.ok(sources.length);assert.ok(sources.every(s=>Math.abs(s.setback-24*G.INCH)<1e-6&&!s.drivenSoffit));
});
test('no measured seed leaves the existing calculation unchanged',()=>{
 const roof=roofFixture({measured:false});assert.deepEqual(G.buildSources(roof,options),G.buildSources(roof,{...options,drivenSoffits:false}));
});
test('driven geometry is independent of connection order and roof rotation',()=>{
 const roof=roofFixture(),base=perimeter(G.buildSources(roof,options));for(const angle of [.71,2.1]){const rotate=p=>({x:p.x*Math.cos(angle)-p.y*Math.sin(angle),y:p.x*Math.sin(angle)+p.y*Math.cos(angle),z:p.z}),rotated={points:roof.points.map(rotate),faces:roof.faces.map(f=>({...f,points:f.points.map(rotate)})),connections:[...roof.connections].reverse()};const next=perimeter(G.buildSources(rotated,options));assert.equal(next.length,base.length);assert.ok(next.every(s=>Math.abs(s.setback-6*G.INCH)<1e-6));assert.ok(next.every(s=>Math.abs(s.a.z-base[0].a.z)<1e-6));}
});

test('measured depths larger than the default remain authoritative and zero soffit remains zero',()=>{
 const roof=roofFixture({depth:36}),enabled=perimeter(G.buildSources(roof,options));assert.ok(enabled.every(s=>Math.abs(s.setback-36*G.INCH)<1e-6));
 const zero=perimeter(G.buildSources(roof,{...options,soffit:0}));assert.ok(zero.every(s=>s.setback===0&&!s.drivenSoffit));
});
test('rakes interrupt driven eave propagation',()=>{
 const roof=roofFixture();roof.connections[1].type='rake';roof.connections[7].type='rake';const next=perimeter(G.buildSources(roof,options)).filter(s=>['pitch2','pitch3','pitch4','pitch5','pitch6'].includes(s.parentId));assert.ok(next.length);assert.ok(next.every(s=>Math.abs(s.setback-24*G.INCH)<1e-6&&!s.drivenSoffit));
});
test('competing measured contacts keep both anchors and resolve independently of enumeration',()=>{
 const roof=roofFixture(),second=roofFixture({seed:4,depth:12}),offset=roof.points.length;roof.points.push(...second.points.slice(8));roof.connections.push({startIdx:offset,endIdx:offset+1,type:'roof_to_wall'});
 const normalize=r=>perimeter(r).map(s=>({parent:s.parentId,depth:s.setback,a:s.a,b:s.b})).sort((a,b)=>a.parent.localeCompare(b.parent)||a.a.x-b.a.x||a.a.y-b.a.y);
 const forward=G.buildSources(roof,options),reverse=G.buildSources({...roof,connections:[...roof.connections].reverse(),faces:[...roof.faces].reverse()},options);const rounded=v=>JSON.parse(JSON.stringify(v,(k,x)=>typeof x==='number'?Number(x.toFixed(7)):x));assert.deepEqual(rounded(normalize(reverse)),rounded(normalize(forward)));
 for(const [parent,depth] of [['pitch0',6],['pitch4',12]])assert.ok(forward.sources.filter(s=>s.parentId===parent&&s.kind==='perimeter').every(s=>Math.abs(s.setback-depth*G.INCH)<1e-6));
});
