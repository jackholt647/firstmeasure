const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/measure/internal/editor_scripts/wall_trim.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');
const p=(x,z,y=0)=>({x,y,z}),face={id:'wall',points:[p(0,0),p(4,0),p(4,3),p(0,3)],material:'siding',finishColor:'#112233'};
const area=f=>{const fr=W.faceFrame(f);return K.area({points:f.points.map(p=>W.inFrame(fr,p)),holes:(f.holes||[]).map(r=>r.map(p=>W.inFrame(fr,p)))});};
test('trim cycles a six inch band to either side and two three inch halves without changing surface area',()=>{
 for(const variant of [0,1,2]){const before=JSON.stringify(face),result=T.partition([face],[[p(2,0),p(2,3)]],variant);assert.equal(result.replacements.length,1);const pieces=result.replacements[0].pieces,trim=pieces.find(f=>f.trim);assert.equal(JSON.stringify(face),before);assert.equal(trim.material,'trim-vertical');assert.ok(Math.abs(area(trim)-3*.1524)<1e-6);assert.ok(Math.abs(pieces.reduce((s,f)=>s+area(f),0)-12)<1e-6);assert.ok(pieces.every(f=>f.points.every(p=>p.y===0)));const xs=trim.points.map(p=>p.x);if(variant===2){assert.ok(Math.abs(Math.min(...xs)-1.9238)<1e-6);assert.ok(Math.abs(Math.max(...xs)-2.0762)<1e-6);}assert.ok(pieces.filter(f=>!f.trim).every(f=>f.finishColor==='#112233'));}
});
test('corner trim covers six inches into both walls for every cycle',()=>{
 const adjacent={id:'second',points:[p(4,0),p(4,0,3),p(4,3,3),p(4,3)]};
 for(let v=0;v<3;v++){const result=T.partition([face,adjacent],[[p(4,0),p(4,3)]],v);assert.equal(result.corner,true);assert.equal(result.replacements.length,2);for(const replacement of result.replacements)assert.ok(Math.abs(replacement.pieces.filter(f=>f.trim).reduce((s,f)=>s+area(f),0)-3*.1524)<1e-6);}
});
test('coplanar divider cycles one side, opposite side, then centered across its two faces',()=>{
 const faces=[{...face,points:[p(0,0),p(2,0),p(2,3),p(0,3)]},{...face,id:'right',points:[p(2,0),p(4,0),p(4,3),p(2,3)]}];
 for(let v=0;v<3;v++){const result=T.partition(faces,[[p(2,0),p(2,3)]],v);const strips=result.replacements.flatMap(r=>r.pieces.filter(f=>f.trim));assert.equal(strips.length,v===2?2:1);assert.ok(Math.abs(strips.reduce((s,f)=>s+area(f),0)-3*.1524)<1e-6);}
});
test('horizontal trim stops at existing perpendicular face dividers and excludes holes',()=>{
 const left={...face,points:[p(0,0),p(2,0),p(2,3),p(0,3)],holes:[[p(.5,1),p(1,1),p(1,2),p(.5,2)]]},right={...face,id:'right',points:[p(2,0),p(4,0),p(4,3),p(2,3)]};
 const result=T.partition([left,right],[[p(.1,1.5),p(.4,1.5)]],2);assert.equal(result.replacements.length,1);const pieces=result.replacements[0].pieces;assert.ok(pieces.filter(f=>f.trim).every(f=>f.material==='trim-horizontal'&&f.points.every(p=>p.x<=2)));assert.ok(Math.abs(pieces.reduce((s,f)=>s+area(f),0)-5.5)<1e-6);
});

test('finish type and color survive clipboard transforms and prevent merges across different colors',()=>{
 const clip=W.copyGeometry([face],face.points);assert.equal(clip.faces[0].material,'siding');assert.equal(clip.faces[0].finishColor,'#112233');const changed=W.transformGeometry(clip,0,{angle:Math.PI/4});assert.equal(changed.faces[0].finishColor,'#112233');
 const other={...face,id:'other',points:[p(4,0),p(8,0),p(8,3),p(4,3)],finishColor:'#ffffff'};assert.equal(W.mergeConnectedFaces([face,other]).length,0);other.finishColor=face.finishColor;assert.equal(W.mergeConnectedFaces([face,other]).length,1);const extrusion=W.extrude(face,.2);assert.ok([extrusion.cap,...extrusion.sides].every(f=>f.finishColor==='#112233'));
});


test('trim stops at a finite drawn segment and follows connected collinear segments past intersections',()=>{
 const pair=[p(1,1),p(2,1)],segments=[pair,[p(2,1),p(3,1)],[p(2,0),p(2,2)],[p(3.1,1),p(3.8,1)]];
 let pieces=T.partition([face],[pair],0,.1524,[]).replacements.flatMap(r=>r.pieces.filter(f=>f.trim));assert.ok(pieces.every(f=>f.points.every(p=>p.x>=1&&p.x<=2)));assert.ok(Math.abs(pieces.reduce((s,f)=>s+area(f),0)-.1524)<1e-6);
 pieces=T.partition([face],[pair],0,.1524,segments).replacements.flatMap(r=>r.pieces.filter(f=>f.trim));assert.ok(pieces.every(f=>f.points.every(p=>p.x>=1&&p.x<=3)));assert.ok(Math.abs(pieces.reduce((s,f)=>s+area(f),0)-2*.1524)<1e-6);
 assert.equal(T.runs([pair,segments[1]],segments).length,1);
});
function shell(outline){return outline.map(([x,y],i)=>{const [xx,yy]=outline[(i+1)%outline.length];return {id:'side-'+i,points:[{x,y,z:0},{x:xx,y:yy,z:0},{x:xx,y:yy,z:3},{x,y,z:3}]};});}
test('auto trim excludes reentrant corners, regardless of face winding, while retaining ground-to-roof outside corners',()=>{
 const faces=shell([[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]]),base={faces:[{points:faces.map(f=>f.points[0])}]},roof={faces:[{points:base.faces[0].points.map(p=>({...p,z:3}))}]};
 for(const source of [faces,faces.map((f,i)=>({...f,points:i%2?f.points.slice().reverse():f.points}))]){
  const pairs=T.candidates(source,{roof,base});assert.equal(pairs.length,5);assert.ok(!pairs.some(([p])=>p.x===2&&p.y===2));assert.ok(pairs.every(pair=>Math.min(...pair.map(p=>p.z))===0&&Math.max(...pair.map(p=>p.z))===3));
 }
});
test('auto trim handles oblique outside angles, coplanar wall splits, and repeated applications',()=>{
 const faces=shell([[0,0],[2,0],[4,0],[5,3],[1,3]]),pairs=T.candidates(faces);assert.equal(pairs.length,4);assert.ok(!pairs.some(([p])=>p.x===2&&p.y===0));
 const result=T.partition(faces,pairs,0,.1524,pairs),replaced=new Map(result.replacements.map(r=>[r.face.id,r.pieces])),next=faces.flatMap(f=>replaced.get(f.id)||[f]);
 assert.ok(next.some(f=>f.trim));assert.ok(Math.abs(next.reduce((s,f)=>s+area(f),0)-faces.reduce((s,f)=>s+area(f),0))<1e-5);assert.equal(T.candidates(next).length,0);
});
test('roof boundary overlaps are removed without excluding a whole connected corner run',()=>{
 const faces=shell([[0,0],[4,0],[4,4],[0,4]]),roof={faces:[{points:[{x:0,y:0,z:2},{x:0,y:0,z:3},{x:-1,y:0,z:3}]}]},pairs=T.candidates(faces,{roof}),corner=pairs.find(([p])=>p.x===0&&p.y===0);
 assert.equal(pairs.length,4);assert.equal(Math.max(...corner.map(p=>p.z)),2);
});


test('horizontal trim cycles above, below, centered across opposite face windings and different frame origins',()=>{
 const lower={id:'lower',points:[p(0,0),p(4,0),p(4,1.5),p(0,1.5)]},upper={id:'upper',points:[p(0,1.5),p(4,1.5),p(4,3),p(0,3)]},pair=[p(0,1.5),p(4,1.5)];
 for(const reverse of [false,true])for(let rotation=0;rotation<4;rotation++)for(const reverseLine of [false,true]){
  let points=upper.points.slice(rotation).concat(upper.points.slice(0,rotation));if(reverse)points.reverse();
  for(let variant=0;variant<3;variant++){
   const result=T.partition([lower,{...upper,points}],reverseLine?[pair.slice().reverse()]:[pair],variant),strips=result.replacements.flatMap(r=>r.pieces.filter(f=>f.trim));
   assert.equal(strips.length,variant===2?2:1);assert.ok(Math.abs(strips.reduce((sum,f)=>sum+area(f),0)-4*.1524)<1e-6);
   const zs=strips.flatMap(f=>f.points.map(p=>p.z));assert.ok(Math.abs(Math.min(...zs)-(variant===0?1.5:variant===1?1.3476:1.4238))<1e-6);assert.ok(Math.abs(Math.max(...zs)-(variant===0?1.6524:variant===1?1.5:1.5762))<1e-6);
  }
 }
});


const applyTrim=(faces,result)=>{const map=new Map(result.replacements.map(r=>[r.face.id,r.pieces]));return faces.flatMap(f=>map.get(f.id)||[f]);};
test('auto trim includes convex horizontal underside edges above the ground',()=>{
 const faces=shell([[0,0],[4,0],[4,4],[0,4]]).map(f=>({...f,points:f.points.map(p=>({...p,z:p.z+2}))})),bottom={id:'underside',points:[p(0,2),p(4,2),p(4,2,4),p(0,2,4)]},top={id:'top',points:bottom.points.map(p=>({...p,z:5}))};faces.push(bottom,top);
 const pairs=T.candidates(faces,{roof:{faces:[top]}});assert.equal(pairs.filter(pair=>pair.every(p=>p.z===2)).length,4);assert.equal(pairs.length,8);
 const next=applyTrim(faces,T.partition(faces,pairs,0,.1524,pairs));assert.ok(next.some(f=>f.trim&&f.points.every(p=>p.z===2)));
 assert.equal(T.candidates(next,{roof:{faces:[top]}}).length,0);
 assert.equal(T.candidates(faces,{roof:{faces:[top]},base:{faces:[bottom]}}).length,4);
});
test('removing trim restores the original finish and removes its redundant boundaries',()=>{
 const pair=[p(2,0),p(2,3)],trimmed=applyTrim([face],T.partition([face],[pair]));const selected=trimmed.find(f=>f.trim),saved=JSON.parse(JSON.stringify(trimmed)),result=T.remove(saved,saved.find(f=>f.trim)),restored=applyTrim(saved,result);
 assert.equal(restored.length,1);assert.equal(restored[0].points.length,4);assert.equal(restored[0].material,'siding');assert.equal(restored[0].finishColor,'#112233');assert.ok(!restored[0].trim);assert.deepEqual(result.pairs,[pair]);assert.equal(area(restored[0]),12);
});
test('removing one crossing trim retains the other strip and its needed corner points',()=>{
 const a=[p(1,0),p(1,3)],b=[p(0,1),p(4,1)],trimmed=applyTrim([face],T.partition([face],[a,b],0,.1524,[a,b]));
 const selected=trimmed.find(f=>f.trimData.layers.length===1&&f.trimData.layers[0].pair[0].x===1),withoutA=applyTrim(trimmed,T.remove(trimmed,selected)),strips=withoutA.filter(f=>f.trim);
 assert.equal(strips.length,1);assert.ok(strips[0].points.every(p=>p.z>=1&&p.z<=1.152401));assert.equal(strips[0].points.length,4);assert.ok(Math.abs(area(strips[0])-4*.1524)<1e-6);
 const plain=applyTrim(withoutA,T.remove(withoutA,strips[0]));assert.equal(plain.length,1);assert.equal(plain[0].points.length,4);assert.equal(area(plain[0]),12);
});


test('legacy trim recovers its original divider and wall finish from saved draft regions',()=>{
 const source={...face,id:'draft:wall:region'},pair=[p(0,1),p(4,1)],old=applyTrim([source],T.partition([source],[pair]));for(const f of old)delete f.trimData;
 const adopted=T.adoptLegacy(old,[source]),selected=adopted.find(f=>f.trim),restored=applyTrim(adopted,T.remove(adopted,selected));assert.equal(K.edgeKey(...selected.trimData.layers[0].pair),K.edgeKey(...pair));assert.equal(restored.length,1);assert.equal(restored[0].points.length,4);assert.equal(restored[0].material,'siding');assert.equal(restored[0].finishColor,'#112233');
});
test('trim source lines follow a copied or transformed face',()=>{
 const pair=[p(2,0),p(2,3)],trimmed=applyTrim([face],T.partition([face],[pair])),move=p=>({...p,x:p.x+10}),moved=trimmed.map(f=>({...f,...K.mapCurveData(f,move),points:f.points.map(move)})),selected=moved.find(f=>f.trim),result=T.remove([...trimmed,...moved],selected);
 assert.deepEqual(result.pairs,[pair.map(move)]);const remaining=applyTrim([...trimmed,...moved],result);assert.ok(remaining.some(f=>f.trim&&f.points.every(p=>p.x<10)));assert.ok(!remaining.some(f=>f.trim&&f.points.every(p=>p.x>=10)));
});


test('a third return along a horizontal divider does not force six inches onto both sides of the wall',()=>{
 const lower={id:'lower',points:[p(0,0),p(4,0),p(4,1.5),p(0,1.5)]},upper={id:'upper',points:[p(0,1.5),p(4,1.5),p(4,3),p(0,3)]},shelf={id:'shelf',points:[p(0,1.5),p(4,1.5),p(4,1.5,1),p(0,1.5,1)]},pair=[p(0,1.5),p(4,1.5)];
 for(let variant=0;variant<3;variant++){
  const result=T.partition([lower,upper,shelf],[pair],variant),strips=result.replacements.filter(r=>r.face.id!=='shelf').flatMap(r=>r.pieces.filter(f=>f.trim));
  assert.ok(Math.abs(strips.reduce((sum,f)=>sum+area(f),0)-4*.1524)<1e-6);
  const zs=strips.flatMap(f=>f.points.map(p=>p.z));assert.ok(Math.abs(Math.min(...zs)-(variant===0?1.5:variant===1?1.3476:1.4238))<1e-6);
 }
});
test('ground trim finds sloped shared base boundaries, excluding roofs and floating edges',()=>{
 const wall={id:'slope',points:[p(0,0),p(4,1),p(4,3),p(0,3)]},base={faces:[{points:[p(1,.25),p(3,.75),p(3,.75,2),p(1,.25,2)]}]};
 assert.deepEqual(T.groundCandidates([wall],{base}),[[p(1,.25),p(3,.75)]]);
 assert.equal(T.groundCandidates([wall],{base:{faces:[]}}).length,0);
});
test('merging walls preserves trim bands and provenance instead of joining through their source seam',()=>{
 const pair=[p(0,1.5),p(4,1.5)],source=[{...face,id:'lower',points:[p(0,0),p(4,0),p(4,1.5),p(0,1.5)]},{...face,id:'upper',points:[p(0,1.5),p(4,1.5),p(4,3),p(0,3)]}];
 const trimmed=applyTrim(source,T.partition(source,[pair],2,.1524,[pair],'#efeadd')),before=JSON.stringify(trimmed),groups=W.mergeConnectedFaces(trimmed,{preserveTrim:true});
 assert.ok(groups.every(g=>g.faces.every(f=>!f.trim)));assert.equal(JSON.stringify(trimmed),before);
 assert.ok(trimmed.filter(f=>f.trim).every(f=>f.finishColor==='#efeadd'));
 const restored=applyTrim(trimmed,T.remove(trimmed,trimmed.find(f=>f.trim)));assert.ok(!restored.some(f=>f.trim));assert.ok(Math.abs(restored.reduce((s,f)=>s+area(f),0)-12)<1e-8);
});


test('material filtering trims only enabled owners without changing corner or divider classification',()=>{
 const siding={...face,material:'siding'},brick={id:'brick-side',material:'brick',points:[p(4,0),p(4,0,3),p(4,3,3),p(4,3)]},pair=[p(4,0),p(4,3)];
 const result=T.partition([siding,brick],[pair],0,.1524,[pair],'#abcdef',{materials:['siding']});assert.equal(result.corner,true);assert.deepEqual(result.replacements.map(r=>r.face.id),['wall']);assert.ok(Math.abs(result.replacements[0].pieces.filter(f=>f.trim).reduce((s,f)=>s+area(f),0)-3*.1524)<1e-6);
 assert.equal(T.partition([siding,brick],[pair],0,.1524,[pair],null,{materials:[]}).replacements.length,0);
 assert.equal(T.partition([{...siding,material:'default'}],[pair],0,.1524,[pair],null,{materials:['brick'],defaults:{material:'siding'}}).replacements.length,0);
 assert.equal(T.partition([{...siding,material:'default'}],[pair],0,.1524,[pair],null,{materials:['siding'],defaults:{material:'siding'}}).replacements.length,1);
 const walls=shell([[0,0],[4,0],[4,4],[0,4]]).map(f=>({...f,material:'brick'}));assert.equal(T.candidates(walls,{materials:['siding']}).length,0);assert.equal(T.candidates(walls,{materials:['brick']}).length,4);
 for(const id of ['siding','siding-vertical','soffit','unassigned'])assert.equal(T.defaultMaterial(id),true);for(const id of ['brick','stone','masonry','stucco','chimney-top'])assert.equal(T.defaultMaterial(id),false);
});
