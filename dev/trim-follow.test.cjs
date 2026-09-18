const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const rect=(id,x0,x1,z0,z1,extra={})=>({id,points:[{x:x0,y:0,z:z0},{x:x1,y:0,z:z0},{x:x1,y:0,z:z1},{x:x0,y:0,z:z1}],holes:[],...extra});
function scene(){const wall=rect('wall',.2,3.8,.2,3.8,{trimData:{host:'wall',layers:[]}}),trim=rect('trim',0,.2,0,4,{trim:true,material:'trim-wood',finishColor:'#abc123',trimData:{host:'wall',layers:[{id:'edge',pair:[{x:0,y:0,z:0},{x:0,y:0,z:4}],width:.2}]}}),far=rect('unrelated',10,10.2,0,4,{trim:true});return [wall,trim,far];}
test('extrusion carries perimeter trim from immutable inputs, including its editable source edge',()=>{const faces=scene(),saved=JSON.stringify(faces),engine=M.createExtrusion({face:faces[0],scene:faces});for(const amount of [.5,-.4,.2]){const r=engine.preview(amount),part=r.replacements.find(r=>r.face.id==='trim').pieces[0];assert.ok(part.points.every(p=>Math.abs(p.y+amount)<1e-8));assert.ok(part.trimData.layers[0].pair.every(p=>Math.abs(p.y+amount)<1e-8));assert.equal(part.finishColor,'#abc123');assert.ok(!r.replacements.some(r=>r.face.id==='unrelated'));K.validateFace(part);}assert.equal(JSON.stringify(faces),saved);});
test('static trim option leaves attached trim fixed during extrusion and movement',()=>{const faces=scene(),r=M.createExtrusion({face:faces[0],scene:faces,keepTrimStatic:true}).preview(.5);assert.deepEqual(r.replacements.find(r=>r.face.id==='trim').pieces[0].points,faces[1].points);const clip=W.copyGeometry(faces,faces[0].points,[]),preview=W.transformGeometry(clip,0,{delta:{x:.5,y:0}}),move=W.transformSelection(faces,clip,preview,{keepTrimStatic:true});assert.deepEqual(move.faces.find(f=>f.id==='trim').points,faces[1].points);});
test('raising a face preserves top trim width and extends its side trim',()=>{const wall=rect('wall',.2,3.8,0,3.8),side=rect('side',0,.2,0,3.8,{trim:true}),top=rect('top',.2,3.8,3.8,4,{trim:true}),cap={...wall,points:wall.points.map(p=>({...p,z:p.z===3.8?4.8:p.z}))},r=W.followTrim([wall,side,top],{faces:[cap,side,top]},['wall']);const s=r.faces[1],t=r.faces[2];assert.equal(Math.max(...s.points.map(p=>p.z)),4.8);assert.ok(Math.abs(Math.max(...t.points.map(p=>p.z))-Math.min(...t.points.map(p=>p.z))-.2)<1e-8);assert.equal(Math.max(...t.points.map(p=>p.z)),5);});
test('perpendicular trim stretches only at the shared moving edge',()=>{const cap={id:'cap',points:[{x:0,y:0,z:3},{x:2,y:0,z:3},{x:2,y:2,z:3},{x:0,y:2,z:3}]},trim=rect('side-trim',0,.2,0,3,{trim:true}),next={...cap,points:cap.points.map(p=>({...p,z:4}))},r=W.followTrim([cap,trim],{faces:[next,trim]},['cap']);assert.deepEqual(r.faces[1].points.map(p=>p.z),[0,0,4,4]);K.validateFace(r.faces[1]);});
test('multi-face extrusion carries each independent trim once',()=>{const [a,t]=scene(),b={...a,id:'b',points:a.points.map(p=>({...p,x:p.x+10})),trimData:{host:'b',layers:[]}},u={...t,id:'u',points:t.points.map(p=>({...p,x:p.x+10})),trimData:{host:'b',layers:[]}},r=M.createExtrusions({members:[{face:a},{face:b}],scene:[a,t,b,u]}).preview(.4);for(const id of ['trim','u']){const replacements=r.replacements.filter(r=>r.face.id===id);assert.equal(replacements.length,1);assert.ok(replacements[0].pieces[0].points.every(p=>Math.abs(p.y+.4)<1e-8));}});

test('moving only a supporting top edge resizes trim from the changed face',()=>{const wall=rect('wall',.2,3.8,0,3.8),side=rect('side',0,.2,0,3.8,{trim:true}),top=rect('top',.2,3.8,3.8,4,{trim:true}),faces=[wall,side,top],result=W.slideLines(faces,[[wall.points[2],wall.points[3]]],{x:0,y:0,z:1},.5),r=W.followTrim(faces,result,['wall']);assert.equal(Math.max(...r.faces.find(f=>f.id==='side').points.map(p=>p.z)),4.3);assert.equal(Math.max(...r.faces.find(f=>f.id==='top').points.map(p=>p.z)),4.5);});
test('normal face movement carries its coplanar trim as a whole',()=>{const faces=scene(),r=W.moveFabric(faces,'wall',.3);assert.ok(r.faces.find(f=>f.id==='trim').points.every(p=>Math.abs(p.y+.3)<1e-8));assert.deepEqual(r.faces.find(f=>f.id==='unrelated').points,faces[2].points);});

test('corner trim run follows around 90-degree and oblique returns without copying foreign anchors',()=>{
 for(const degrees of [90,9]){
  const wall=rect('wall',.2,3.8,0,3),layer={id:'left-corner',pair:[{x:0,y:0,z:0},{x:0,y:0,z:3}],width:.2},front=rect('front-band',0,.2,0,3,{trim:true,trimData:{host:'wall',layers:[layer]},retainedPoints:[{x:.1,y:0,z:1},{x:2,y:0,z:1}]}),angle=degrees*Math.PI/180,u={x:-Math.cos(angle),y:Math.sin(angle)},side={id:'return-band',trim:true,points:[{x:0,y:0,z:0},{x:u.x*.2,y:u.y*.2,z:0},{x:u.x*.2,y:u.y*.2,z:3},{x:0,y:0,z:3}],holes:[],trimData:{host:'side-wall',layers:[layer]},retainedPoints:[{x:u.x*.1,y:u.y*.1,z:1},{x:2,y:0,z:1}]},upper={...side,id:'upper-return',points:side.points.map(p=>({...p,z:p.z+4}))},scene=[wall,front,side,upper],original=JSON.stringify(scene);
  for(const amount of [-.3,.3]){const r=M.createExtrusion({face:wall,scene}).preview(amount),moved=r.replacements.find(r=>r.face.id===side.id)?.pieces[0];assert.ok(moved,'shared trim run must include its other plane');assert.ok(moved.points.every((p,i)=>Math.abs(p.y-side.points[i].y+amount)<1e-8));assert.equal(moved.retainedPoints.length,1);assert.ok(moved.retainedPoints.every(p=>W.ownsPoint(moved,p)));assert.ok(!r.replacements.some(r=>r.face.id===upper.id),'same run outside selected height stays fixed');r.replacements.flatMap(r=>r.pieces).forEach(K.validateFace);}
  assert.equal(JSON.stringify(scene),original);
 }
});
test('legacy trim wire ignores off-face inherited anchors but preserves real loose geometry',()=>{const trim=rect('trim',0,.2,0,3,{trim:true,retainedPoints:[{x:.1,y:0,z:1},{x:2,y:0,z:1}]}),wire=W.surfaceWire({$surfaces:[trim],$loose:{points:[{x:5,y:5,z:5}],edges:[]}});assert.ok(wire.nodes.some(p=>p.x===.1&&p.z===1));assert.ok(!wire.nodes.some(p=>p.x===2&&p.z===1));assert.ok(wire.nodes.some(p=>p.x===5&&p.y===5));});

test('extrusion returns cannot resize a coplanar neighboring garage door',()=>{const wall=rect('wall',0,3,0,3),door={id:'garage',feature:{type:'garage'},points:[{x:0,y:0,z:0},{x:0,y:2,z:0},{x:0,y:2,z:3},{x:0,y:0,z:3}],holes:[]},r=M.createExtrusion({face:wall,scene:[wall,door]}).preview(-.6);assert.ok(!r.replacements.some(r=>r.face.id==='garage'));assert.ok(r.sides.every(f=>!f.feature));});

test('moving along a saved vertical trim run extends it instead of translating its base',()=>{
 const cap={id:'cap',points:[{x:0,y:0,z:3},{x:2,y:0,z:3},{x:2,y:2,z:3},{x:0,y:2,z:3}]},trim=rect('side',0,.2,0,3,{trim:true,trimData:{layers:[{id:'vertical',pair:[{x:0,y:0,z:0},{x:0,y:0,z:3}]}]}});
 for(const z of [2,4]){const moved={...cap,points:cap.points.map(p=>({...p,z}))},r=W.followTrim([cap,trim],{faces:[moved,trim]},['cap']),side=r.faces.find(f=>f.id==='side');assert.deepEqual(side.points.map(p=>p.z),[0,0,z,z]);assert.deepEqual(side.trimData.layers[0].pair.map(p=>p.z),[0,z]);}
});

test('a lower corner run follows a moved cross-band without turning diagonal',()=>{
 const wall=rect('upper',0,3,2.2,5),band=rect('band',0,3,2,2.2,{trim:true}),
  corner={id:'corner',trim:true,points:[{x:0,y:0,z:0},{x:0,y:.2,z:0},{x:0,y:.2,z:2},{x:0,y:0,z:2}],trimData:{layers:[{id:'vertical',pair:[{x:0,y:0,z:0},{x:0,y:0,z:2}]}]}},
  side={id:'side',points:[{x:0,y:.2,z:0},{x:0,y:3,z:0},{x:0,y:3,z:2},{x:0,y:.2,z:2}]},scene=[wall,band,corner,side];
 for(const amount of [-.6,.6]){
  const cap={...wall,points:wall.points.map(p=>({...p,y:p.y+amount}))},r=W.followTrim(scene,{faces:[cap,band,corner,side]},['upper']),moved=r.faces.find(f=>f.id==='corner');
  assert.ok(moved.points.every((p,i)=>Math.abs(p.y-corner.points[i].y-amount)<1e-8),'both ends follow lateral displacement');
  assert.deepEqual(moved.points.map(p=>p.z),corner.points.map(p=>p.z));
  assert.ok(moved.trimData.layers[0].pair.every(p=>Math.abs(p.y-amount)<1e-8));
  const neighbor=r.faces.find(f=>f.id==='side');assert.ok(neighbor.points.some(p=>Math.abs(p.y-(.2+amount))<1e-8&&p.z===0),'adjoining wall follows the lower endpoint');
  r.faces.forEach(K.validateFace);
 }
});
