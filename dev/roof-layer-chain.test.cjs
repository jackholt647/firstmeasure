const test=require('node:test'),assert=require('node:assert/strict'),G=require('../public/measure/internal/editor_scripts/wall_geometry'),{build}=require('./roof-generation-fixture.cjs'),fixture=require('./fixtures/canopy-junction-roof.json');
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
for(const gap of [0,.011,.03])test(`three roof layers resolve finite nearest contacts across ${gap}m survey gap`,()=>{
 const rect=(id,x0,x1,z)=>({id,points:[{x:x0,y:0,z},{x:x1,y:0,z},{x:x1,y:4,z},{x:x0,y:4,z}]}),roof={faces:[rect('bottom',-2,0,2),rect('middle',gap,2,3),rect('top',-2,2,5)]};
 const line=(id,x,z,parentId,direction,kind,y0=0,y1=4)=>({id,a:{x,y:y0,z},b:{x,y:y1,z},parentId,direction,kind});
 const sources=[line('flash',0,2,'bottom','up','flashing'),line('middle',gap,3,'middle','down','perimeter'),line('top',0,5,'top','down','perimeter',1,3)];
 const walls=G.extrude(roof,sources,0).walls,upper=walls.filter(w=>w.sourceId==='top'),lower=walls.filter(w=>w.sourceId==='flash');
 assert.ok(upper.length&&lower.length);
 assert.ok(upper.every(w=>w.targetId===(gap<=.02?'middle':'bottom')));
 assert.ok(lower.every(w=>w.targetId===(gap<=.02?'middle':'top')));
});
for(const angle of [0,.71,2.1])test(`captured lower-to-middle roof contact is filled at rotation ${angle}`,()=>{
 const f=structuredClone(fixture),c=Math.cos(angle),s=Math.sin(angle),rotate=p=>({...p,x:c*p.x-s*p.y,y:s*p.x+c*p.y});
 f.roof.points=f.roof.points.map(rotate);for(const face of f.roof.faces){face.points=face.points.map(rotate);face.holes=(face.holes||[]).map(r=>r.map(rotate));}
 // Extrusion itself must find the middle roof, before any gap-fill pass.
 const sources=G.buildSources(f.roof,{...f.options,soffit:24,roofContacts:true}).sources,walls=G.extrude(f.roof,sources,0).walls;
 const contact=sources.find(s=>s.id==='R86');assert.ok(contact);
 const p=mix(contact.a,contact.b,.15),span=walls.find(w=>w.sourceId==='R86'&&G.onEdge(p,...w.bottom,.002));
 assert.ok(span,'the previously missing interval exists');assert.equal(span.targetId,13,'lowest roof meets the middle roof, not the main roof');
 assert.ok(span.top.every(p=>Math.abs(p.z-40.93000335693359)<.002));
 if(angle===0){const r=build(f,24);assert.ok(r.composed.some(w=>G.onEdge(p,...w.top,.02)&&Math.min(...w.bottom.map(p=>p.z))<=40.306&&Math.max(...w.top.map(p=>p.z))>=40.929),'contact survives dedupe and merge');}
});


test('near-boundary contact is limited to the finite middle roof and requires flashing',()=>{
 const face=(id,x0,x1,y0,y1,z)=>({id,points:[{x:x0,y:y0,z},{x:x1,y:y0,z},{x:x1,y:y1,z},{x:x0,y:y1,z}]}),roof={faces:[face('low',-2,0,0,4,2),face('mid',.011,2,1,3,3),face('high',-2,2,0,4,5)]},flash={id:'flash',a:{x:0,y:0,z:2},b:{x:0,y:4,z:2},parentId:'low',kind:'flashing',direction:'up'};
 const walls=G.extrude(roof,[flash],0).walls;
 assert.equal(walls.find(w=>G.onEdge({x:0,y:2},...w.bottom)).targetId,'mid');
 for(const y of [.5,3.5])assert.equal(walls.find(w=>G.onEdge({x:0,y},...w.bottom)).targetId,'high','outside the contact keeps its actual next roof');
 assert.ok(G.extrude(roof,[{...flash,kind:'perimeter'}],0).walls.every(w=>w.targetId==='high'),'nearby unrelated edges are not bridged');
});
