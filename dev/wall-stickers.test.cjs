// The sticker outline model (wall_stickers.js): reading any sticker face, the
// transforms every edit uses, and the one closed-face check.
const test=require('node:test'),assert=require('node:assert/strict');
const dir='../public/measure/internal/editor_scripts/',S=require(dir+'wall_stickers.js'),K=require(dir+'exterior_geometry.js'),F=require(dir+'wall_features.js');
const P=(x,z)=>({x,y:0,z}),near=(a,b,t=1e-6)=>Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0))<=t;
// A face on the wall plane y = 0, as the editor stores it in world coordinates.
function archedFace(){
 const tl=P(1,2),apex=P(1.5,2.3),tr=P(2,2),arch=K.splineThrough([tl,tr],[apex]),samples=K.curveSamples(arch).slice(1,-1);
 return {points:[P(1,1),P(2,1),tr,...samples.slice().reverse().map(p=>({...p})),tl],curves:[arch],feature:{type:'window',preset:null,shape:'custom'}};
}
const vertices=o=>o.loop.map(v=>S.world(o.frame,v));

test('a rectangle reads as four straight vertices and writes back the same ring',()=>{
 const face={points:[P(1,1),P(2,1),P(2,2),P(1,2)],feature:{type:'window'}},o=S.read(face);
 assert.equal(o.loop.length,4);assert.ok(o.loop.every(v=>!v.seg));
 const back=S.toWorld(o).points;assert.equal(back.length,4);for(const p of face.points)assert.ok(back.some(q=>near(p,q)),JSON.stringify(p));
});
test('an arched window reads as four vertices and one spline through its apex; samples are never controls',()=>{
 const o=S.read(archedFace());assert.equal(o.loop.length,4,JSON.stringify(o.loop));
 const arched=o.loop.find(v=>v.seg);assert.equal(arched.seg.type,'spline');assert.equal(arched.seg.via.length,1);
 assert.ok(near(S.world(o.frame,arched.seg.via[0]),P(1.5,2.3)),'the apex is the spline control');
 assert.equal(S.controls(o).length,5,'four corners and the apex');
 const {points,curves}=S.toWorld(o);assert.equal(curves.length,1);assert.ok(points.filter(p=>p.curveSample).length>3,'tessellation is derived');
});
test('a stored outline is used while the face matches it, and re-read when the face changed',()=>{
 const face=archedFace(),o=S.read(face),w=S.toWorld(o),stored={points:w.points,curves:w.curves,feature:{...face.feature,outline:o}};
 assert.equal(JSON.stringify(S.read(stored)),JSON.stringify(o));
 const moved={...stored,points:stored.points.map(p=>({...p,x:p.x+.5}))};assert.ok(Math.abs(vertices(S.read(moved))[0].x-vertices(o)[0].x-.5)<1e-6||vertices(S.read(moved)).some(p=>Math.abs(p.x-2.5)<1e-6),'re-read from the moved face');
});
test('translate moves every control and keeps the arch exactly',()=>{
 const o=S.read(archedFace()),t=S.translate(o,.3,-.2),a=S.toWorld(o).points,b=S.toWorld(t).points;
 assert.equal(a.length,b.length);const shift={x:S.world(t.frame,{x:.3,y:-.2}).x-S.world(t.frame,{x:0,y:0}).x,z:S.world(t.frame,{x:.3,y:-.2}).z-S.world(t.frame,{x:0,y:0}).z};
 a.forEach((p,i)=>assert.ok(near({...p,x:p.x+shift.x,z:p.z+shift.z},b[i]),'rigid at '+i));
});
test('moving the apex alone reshapes the arch; the corners stay',()=>{
 const o=S.read(archedFace()),apex=S.controls(o).find(c=>c.id.startsWith('c')),m=S.moveControls(o,[apex.id],0,.1);
 vertices(o).forEach((p,i)=>assert.ok(near(p,vertices(m)[i]),'corner '+i+' stays'));
 const via=m.loop.find(v=>v.seg).seg.via[0];assert.ok(near(S.world(m.frame,via),P(1.5,2.4)),'apex raised');S.check(m);
});
test('moving one arch end keeps the arch rise over its chord and the other corners',()=>{
 const o=S.read(archedFace()),ids=S.controls(o).filter(c=>c.id.startsWith('v')),tr=ids.find(c=>near(S.world(o.frame,c),P(2,2))),m=S.moveControls(o,[tr.id],.2,0);
 const w=vertices(m);assert.ok(w.some(p=>near(p,P(2.2,2))),'the moved end');for(const p of [P(1,1),P(2,1),P(1,2)])assert.ok(w.some(q=>near(q,p)),'unmoved '+JSON.stringify(p));
 const via=S.world(m.frame,m.loop.find(v=>v.seg).seg.via[0]);assert.ok(Math.abs(via.z-2.3)<1e-6&&Math.abs(via.x-1.6)<1e-6,'apex follows the chord: '+JSON.stringify(via));S.check(m);
});
test('deleting an arch end keeps a closed face: the arch continues from the neighbouring corner',()=>{
 const o=S.read(archedFace()),tl=S.controls(o).find(c=>near(S.world(o.frame,c),P(1,2))),d=S.deleteControls(o,[tl.id]);
 assert.ok(d,'still a sticker');assert.equal(d.loop.length,3);assert.ok(d.loop.some(v=>v.seg?.type==='spline'),'the arch is kept as a curve');S.check(d);
 assert.equal(S.deleteControls(S.read({points:[P(0,0),P(1,0),P(1,1)],feature:{}}),['v0']),null,'two straight vertices are no face');
});
test('a legacy 48-point round window reads as an ellipse; translate keeps it, a skew makes a spline',()=>{
 const pts=F.shape({left:1,right:2,bottom:1,top:1.6},'circle').map(p=>P(p.x,p.y)),o=S.read({points:pts,feature:{type:'vent',shape:'circle'}});
 assert.equal(o.loop.length,2);assert.ok(o.loop.every(v=>v.seg?.type==='ellipse'));
 const b=S.outlineBounds(o);assert.ok(Math.abs(b.right-b.left-1)<1e-6&&Math.abs(b.top-b.bottom-.6)<1e-6);
 const w=S.toWorld(o);assert.equal(w.curves.length,2);for(const p of w.points)assert.ok(Math.abs(((p.x-1.5)/.5)**2+((p.z-1.3)/.3)**2-1)<1e-6,'on the ellipse');
 assert.ok(S.translate(o,.1,0).loop.every(v=>v.seg?.type==='ellipse'));assert.ok(S.affine(o,p=>({x:p.x+p.y*.2,y:p.y})).loop.every(v=>v.seg?.type==='spline'));
 const back=S.read({points:w.points,curves:w.curves,feature:{type:'vent',shape:'circle'}});assert.equal(back.loop.length,2,'its own written form reads back');
});
test('resize scales controls into the box; check refuses a crossing and a sliver',()=>{
 const o=S.read(archedFace()),r=S.resize(o,{left:0,right:2,bottom:0,top:2.6}),b=S.outlineBounds(r);assert.ok(Math.abs(b.right-2)<1e-9&&Math.abs(b.top-2.6)<1e-9);
 const rect=S.read({points:[P(0,0),P(1,0),P(1,1),P(0,1)],feature:{}});assert.throws(()=>S.check(S.moveControls(rect,['v1'],-2,.5)),/cross itself/);
 assert.throws(()=>S.check(S.resize(rect,{left:0,right:.005,bottom:0,top:1})),/0.4 inches/);
});
test('an arch read from its reversed curve and a refitted apex off the ring read the same',()=>{
 const f=archedFace(),c=f.curves[0],rev={...f,curves:[{...K.splineThrough([c.controls[2],c.controls[0]],[c.controls[1]])}]};
 const a=S.read(f),b=S.read(rev);assert.equal(b.loop.length,4);assert.ok(near(S.world(b.frame,b.loop.find(v=>v.seg).seg.via[0]),P(1.5,2.3)));assert.equal(S.controls(a).length,S.controls(b).length);
});
test('a ring that starts at an arch end and wraps through the arch keeps every corner',()=>{
 const tl=P(.5,2),apex=P(1,2.3),tr=P(1.5,2),arch=K.splineThrough([tr,tl],[apex]),samples=K.curveSamples(arch).slice(1,-1);
 const face={points:[tl,P(.5,0),P(1.5,0),tr,...samples],curves:[arch],feature:{type:'door'}},o=S.read(face);
 assert.equal(o.loop.length,4,JSON.stringify(o.loop));assert.equal(o.loop.filter(v=>v.seg).length,1);S.check(o);
 for(const p of [P(.5,0),P(1.5,0),tl,tr])assert.ok(vertices(o).some(q=>near(p,q)),'corner '+JSON.stringify(p));
});
