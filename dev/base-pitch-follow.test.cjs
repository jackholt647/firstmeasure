// A sloped base folds an attached wall's bottom corner across its neighbouring edge by a sliver. Following the base
// resolves that sliver instead of rejecting (and silently reverting) the whole base edit; a real cut is refused.
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../public/measure/internal/editor_scripts/base_geometry.js'),F=require('../public/measure/internal/editor_scripts/wall_base_binding.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const fixture=require('./fixtures/base-pitch-fold.json'),copy=v=>JSON.parse(JSON.stringify(v));
const pitched=deg=>{const next=copy(fixture.base),f=next.faces.find(x=>x.id==='base-face-27:step-3');Object.assign(f,B.transform(copy(f),'pitch',Math.tan(deg*Math.PI/180),{x:1,y:0},B.center(f)));return next;};
const area=f=>{const frame=W.faceFrame(f);return K.area({points:f.points.map(p=>W.inFrame(frame,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(frame,p)))});};
test('a small base pitch keeps the attached wall valid and planar',()=>{
 for(const deg of [3,6,10]){const after=F.face(copy(fixture.surface),fixture.base,pitched(deg));
  const frame=W.faceFrame(after);assert.ok(frame);for(const p of after.points)assert.ok(Math.abs(W.inFrame(frame,p).z)<1e-5,'planar');
  B.validate({points:after.points.map(p=>W.inFrame(frame,p))});assert.ok(Math.abs(area(after)-area(fixture.surface))<.5,deg+'deg keeps the wall');}
});
test('the folded sliver was what made the edit fail before',()=>{
 const after=pitched(6),f=fixture.surface,out=[];for(let i=0;i<f.points.length;i++){const r=F.edge(f.points[i],f.points[(i+1)%f.points.length],fixture.base,after);for(const p of r||[f.points[i]])if(!out.length||Math.hypot(out.at(-1).x-p.x,out.at(-1).y-p.y,out.at(-1).z-p.z)>1e-7)out.push(p);}
 const frame=W.faceFrame({points:out});assert.throws(()=>B.validate({points:out.map(p=>W.inFrame(frame,p))}));
});
