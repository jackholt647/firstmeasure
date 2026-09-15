const test=require('node:test'),assert=require('node:assert/strict'),F=require('../public/measure/internal/editor_scripts/wall_base_binding.js'),B=require('../public/measure/internal/editor_scripts/base_geometry.js'),S=require('../public/measure/internal/editor_scripts/base_sketch_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),base={faces:[{id:'left',points:[p(0,0),p(4,0),p(4,4),p(0,4)]},{id:'right',points:[p(4,0),p(8,0),p(8,4),p(4,4)]}]},raised=structuredClone(base);raised.faces[0].points.forEach(p=>p.z=1);
const wall={id:'front',points:[p(0,0),p(8,0),p(8,0,4),p(0,0,4)]};
test('raising one base section creates distinct wall corners at both heights of the step',()=>{for(const reverse of [false,true]){const input=structuredClone(wall);if(reverse)input.points.reverse();const next=F.face(input,base,raised);assert.ok(next.points.some(p=>p.x===4&&p.z===1));assert.ok(next.points.some(p=>p.x===4&&p.z===0));assert.ok(next.points.some(p=>p.x===0&&p.z===1));assert.ok(!next.points.some(p=>p.x===0&&p.z===0));assert.ok(next.points.some(p=>p.x===8&&p.z===0));assert.equal(input.points.length,4);}});
test('drafted wall geometry and metadata follow a pitched base without changing unrelated faces',()=>{const d={origin:p(0,0),u:{x:1,y:0},members:['front'],faces:[{id:'region',material:'brick',points:wall.points.map(p=>({x:p.x,y:p.z,z:0}))}]};S.ensure(d);const edits={$drafts:{front:d},$surfaces:[{id:'remote',points:[p(20,0),p(24,0),p(24,0,4),p(20,0,4)]}]},before=JSON.stringify(edits),next=F.follow(edits,base,raised);assert.equal(JSON.stringify(edits),before);assert.equal(next.$drafts.front.faces[0].solidId,next.$surfaces[1].id);assert.deepEqual(next.$surfaces[0],edits.$surfaces[0]);assert.equal(next.$surfaces[1].points.filter(p=>p.x===4).length,2);assert.equal(next.$surfaces[1].material,'brick');const lowered=F.follow(next,raised,base);assert.ok(lowered.$surfaces[1].points.filter(p=>p.z<2).every(p=>p.z===0));});
test('height snap aligns a complete tilted edge exactly and rejects distant targets',()=>{const a={id:'moving',points:[p(0,0,-.4),p(4,0,.6),p(4,4,.6),p(0,4,-.4)]},other={id:'target',points:[p(0,4,0),p(4,4,1),p(4,8,1),p(0,8,0)]},snap=B.heightSnap(a,[other],.37,p=>({x:p.x*100,y:p.z*100}));assert.ok(snap);assert.ok(Math.abs(snap.amount-.4)<1e-8);assert.match(snap.kind,/plane/);assert.ok(snap.guide.every(p=>Math.abs(p.z-.25*p.x)<1e-8));assert.equal(B.heightSnap(a,[other],2,p=>({x:p.x*100,y:p.z*100})),null);});

test('a wall on a shared base seam keeps the lower support regardless of face order',()=>{
 const seam={id:'seam',points:[p(4,0),p(4,4),p(4,4,4),p(4,0,4)]};
 for(const reverse of [false,true]){const before=structuredClone(base),after=structuredClone(raised);if(reverse){before.faces.reverse();after.faces.reverse();}assert.deepEqual(F.face(seam,before,after),seam);}
});
test('a sloping wall edge crossing the old plane is not mistaken for a supported bottom edge',()=>{
 const floating={points:[p(0,0,-1),p(8,0,1),p(8,0,5),p(0,0,5)]},flat={faces:[{id:'whole',points:[p(0,0),p(8,0),p(8,4),p(0,4)]}]},up=structuredClone(flat);up.faces[0].points.forEach(p=>p.z=2);
 assert.deepEqual(F.face(floating,flat,up),floating);
});
test('raising a subdivided recessed base keeps the top edge and the adjoining lower section fixed',()=>{
 const recessed={faces:[{id:'left',points:[p(0,1),p(4,1),p(4,4),p(0,4)]},{id:'right',points:[p(4,1),p(8,1),p(8,4),p(4,4)]}]},up=structuredClone(recessed);up.faces[0].points.forEach(p=>p.z=1.5);
 const f={id:'recess',points:[p(0,1),p(8,1),p(8,1,4),p(0,1,4)],retainedPoints:[p(6,1,2)]},edits={$surfaces:[f]},next=F.follow(edits,recessed,up).$surfaces[0];
 for(const q of [p(4,1,0),p(4,1,1.5),p(8,1,0),p(8,1,4),p(0,1,4)])assert.ok(next.points.some(v=>Math.hypot(v.x-q.x,v.y-q.y,v.z-q.z)<1e-7));assert.deepEqual(next.retainedPoints,f.retainedPoints);
});
