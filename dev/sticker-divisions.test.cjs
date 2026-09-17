const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../public/measure/internal/editor_scripts/wall_features.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js');
const ft=F.FT,rect=(x,z,w,h)=>[{x,y:0,z},{x:x+w,y:0,z},{x:x+w,y:0,z:z+h},{x,y:0,z:z+h}];
const sticker=(type='window')=>({id:'opening',points:rect(ft,ft,4*ft,7*ft),holes:[],feature:{type,preset:2,axis:{x:1,y:0,z:0}},material:'siding',finishColor:'#abcdef'});
const area=f=>{const fr=W.faceFrame(f);return K.area({points:f.points.map(p=>W.inFrame(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(fr,p)))});};
test('typed division uses top/left distances and preserves area, type and appearance',()=>{
 for(const type of ['window','door','garage']){const f=sticker(type),before=JSON.stringify(f),r=F.divideSticker([f],'horizontal',5*ft);
  assert.equal(JSON.stringify(f),before);assert.equal(r.faces.length,2);assert.deepEqual(r.faces.map(f=>Math.round(F.dimensions(f.points,f.feature).height)).sort(),[2,5]);
  assert.ok(Math.abs(r.faces.reduce((s,f)=>s+area(f),0)-28*ft*ft)<1e-6);assert.equal(new Set(r.faces.map(f=>f.feature.divisionGroup)).size,1);assert.equal(new Set(r.faces.map(f=>f.feature.divisionSection)).size,2);
  for(const p of r.faces){assert.equal(p.feature.type,type);assert.equal(p.material,f.material);assert.equal(p.finishColor,f.finishColor);}
  const v=F.divideSticker(r.faces,'vertical',ft);assert.equal(v.faces.length,4);assert.ok(v.faces.every(f=>[1,3].includes(Math.round(F.dimensions(f.points,f.feature).width))));assert.equal(F.divisionSegments(v.faces).length,4);
  assert.throws(()=>F.divideSticker([f],'horizontal',7*ft),/inside/);assert.throws(()=>F.divideSticker([f],'horizontal',0),/inside/);assert.throws(()=>F.divideSticker(r.faces,'horizontal',5*ft),/already/);
 }
});
test('deleting one crossed divider merges only its two sections; later cuts span the whole sticker',()=>{
 let faces=F.divideSticker(F.divideSticker([sticker()],'horizontal',5*ft).faces,'vertical',2*ft).faces;
 const bottom=F.divisionSegments(faces).find(s=>s.pair.every(p=>Math.abs(p.x-3*ft)<1e-6)&&Math.max(...s.pair.map(p=>p.z))<3.01*ft);
 assert.ok(bottom);const merged=F.mergeStickerDivider(faces,bottom.pair);assert.equal(merged.removed.length,2);faces=[...faces.filter(f=>!merged.removed.includes(f.id)),merged.face];assert.equal(faces.length,3);
 assert.equal(F.divisionSegments(faces).length,3);assert.ok(Math.abs(faces.reduce((s,f)=>s+area(f),0)-28*ft*ft)<1e-6);
 const all=F.divideSticker(faces,'vertical',ft);assert.equal(all.faces.length,5);assert.equal(new Set(all.faces.map(f=>f.feature.divisionGroup)).size,1);
 assert.equal(F.mergeStickerDivider(faces,[sticker().points[0],sticker().points[1]]),null,'outer edge is not a divider');
});
test('copy/transform/paste retains sections but assigns independent identities to each placed copy',()=>{
 const faces=F.divideSticker([sticker()],'horizontal',5*ft).faces,points=faces.flatMap(f=>f.points),clip=W.copyGeometry(faces,points,[]);
 assert.equal(clip.faces.length,2);const a=F.remapDivisionGroups(clip.faces),b=F.remapDivisionGroups(clip.faces);
 assert.equal(a[0].feature.divisionGroup,a[1].feature.divisionGroup);assert.notEqual(a[0].feature.divisionGroup,b[0].feature.divisionGroup);assert.notEqual(a[0].feature.divisionGroup,faces[0].feature.divisionGroup);
 assert.equal(F.divisionSegments(a).length,1);assert.deepEqual(JSON.parse(JSON.stringify(a)),a,'metadata survives save/load');
 assert.equal(W.mergeConnectedFaces(a).length,0,'generic cleanup must not erase intentional sections');
});
test('report counts a divided sticker once with its outer size/perimeter and excludes dividers from trim',()=>{
 const faces=F.divideSticker(F.divideSticker([sticker()],'horizontal',5*ft).faces,'vertical',2*ft).faces,wall={id:'wall',points:rect(0,0,10*ft,10*ft),material:'siding'},m=R.build({faces:[wall,...faces]});
 assert.equal(m.openings.length,1);const o=m.openings[0];assert.equal(o.sections.length,4);assert.equal(o.dividers.length,4);assert.ok(Math.abs(o.width-4)<1e-5);assert.ok(Math.abs(o.height-7)<1e-5);assert.ok(Math.abs(o.perimeter-22)<1e-5);assert.ok(Math.abs(o.area-28)<1e-5);assert.ok(Math.abs(m.totals.net-72)<1e-5);
 const copied=F.remapDivisionGroups(faces).map((f,i)=>({...f,id:'copy'+i,points:f.points.map(p=>({...p,x:p.x+5*ft}))}));assert.equal(R.build({faces:[wall,...faces,...copied]}).openings.length,2);
});
test('PDF draws dashed divisions while retaining one opening schedule entry',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),faces=F.divideSticker([sticker()],'horizontal',5*ft).faces,wall={id:'wall',points:rect(0,0,10*ft,10*ft),material:'siding'},model=R.build({faces:[wall,...faces]});
 assert.equal(model.openings.length,1);
 if(source.includes('function rasterScene(')){
  const PDF=require('../public/measure/internal/editor_scripts/exterior_pdf.js'),render=walls=>PDF.rasterScene(walls,{x:0,y:-1},240,240,false,10),withLines=render(model.walls),plain=render(model.walls.map(w=>({...w,openings:w.openings.map(o=>({...o,dividers:[]}))}))),changed=withLines.pixels.reduce((n,v,i)=>n+(v!==plain.pixels[i]),0);assert.ok(changed>0,'visible divisions must appear in the PDF diagram');
  const cover={...model.walls[0],id:'cover',points:wall.points.map(p=>({...p,y:-1})),holes:[],openings:[]},hidden=render([...model.walls,cover]),hiddenPlain=render([...model.walls.map(w=>({...w,openings:w.openings.map(o=>({...o,dividers:[]}))})),cover]);assert.deepEqual(hidden.pixels,hiddenPlain.pixels,'dividers cannot bleed through a closer wall');
 }else{
  const ctx={window:{}},calls=[],doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s]},{get:(target,key)=>key in target?target[key]:(...args)=>calls.push([key,...args])});vm.createContext(ctx);vm.runInContext(source,ctx);ctx.window.drawExteriorReportPages(doc,model,{},()=>{},{});assert.ok(calls.some(c=>c[0]==='setLineDashPattern'&&c[1].length===2));
 }
});
