const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
function fixture(){const ctx={WallSolidGeometry:W,ExteriorGeometry:K,THREE:{Float32BufferAttribute:class{constructor(array,size){this.array=array;this.itemSize=size;}}}};ctx.window=ctx;vm.createContext(ctx);for(const name of ['exterior_finishes','wall_editor'])vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/'+name+'.js','utf8'),ctx);return ctx;}
function mesh(){return {userData:{},geometry:{setAttribute(name,value){this[name]=value;}}};}
test('shingle rows follow roof contours and use physical distance up the slope',()=>{const ctx=fixture(),m=mesh(),p=(x,y)=>({x,y,z:y/2}),face={material:'shingles',points:[p(0,0),p(4,0),p(4,4),p(0,4)]};ctx.ExteriorFinishes.prepare(m,face,face.points);const uv=m.geometry.uv.array;assert.ok(Math.abs(uv[1]-uv[3])<1e-8);assert.ok(Math.abs(Math.abs(uv[2]-uv[0])-4/.9144)<1e-8);assert.ok(Math.abs(Math.abs(uv[5]-uv[3])-Math.hypot(4,2)/.6096)<1e-8);});
test('sloped fascia grain follows its roof edge instead of world horizontal',()=>{const ctx=fixture(),R=require('../public/measure/internal/editor_scripts/roof_trim.js'),roof={faces:[{points:[{x:0,y:0,z:3},{x:4,y:0,z:3},{x:4,y:4,z:5},{x:0,y:4,z:5}]}]},classified={...roof,points:roof.faces[0].points,connections:[{startIdx:1,endIdx:2,type:'rake'}]},face=R.panels(classified,R.setHeight({},R.perimeter(classified).map(e=>e.id),6)).find(f=>Math.abs(f.a.z-f.b.z)>1),m=mesh();ctx.ExteriorFinishes.prepare(m,face,face.points);const uv=m.geometry.uv.array;assert.ok(Math.abs(uv[1]-uv[3])<1e-8);assert.ok(Math.abs(uv[5]-uv[3])>0);});
test('textured presentation retains boundary lines, hides points, and restores prior visibility and maps on exit',()=>{const ctx=fixture(),savedMap={},color={getHex:()=>0x808080,setHex(){},multiplyScalar(){}},surface={isMesh:true,userData:{},material:{color,map:savedMap,opacity:.3,transparent:true,depthTest:false,depthWrite:false}},objects=[surface,{isLine:true,visible:true},{isPoints:true,visible:true},{isSprite:true,visible:false}],group={traverse:f=>objects.forEach(f)};ctx.exteriorSurfaceDisplay(group,'textured');assert.deepEqual(objects.slice(1).map(o=>o.visible),[true,false,false]);assert.equal(surface.material.opacity,1);ctx.exteriorSurfaceDisplay(group,'translucent');assert.deepEqual(objects.slice(1).map(o=>o.visible),[true,true,false]);assert.equal(surface.material.map,savedMap);assert.equal(surface.material.opacity,.3);});
test('unassigned walls use matte gray without a texture map',()=>{const ctx=fixture();let value;const m={color:{set:c=>value=c},map:'old'};ctx.ExteriorFinishes.apply({userData:{pickLayer:'walls'}},m);assert.equal(value,'#80868b');assert.equal(m.map,null);});
test('default base stays plain concrete even when the wall default has a texture',()=>{
 const ctx=fixture();ctx.WallMode={finishDefaults:{material:'siding',color:'#ff0000'}};
 for(const data of [{baseId:'base-1'},{pickLayer:'base',exteriorFinish:{material:'default',normal:{x:0,y:0,z:1}}}]){
  let color;const m={color:{set:v=>color=v,multiplyScalar(){}},map:'old-wall-texture'};
  ctx.ExteriorFinishes.apply({userData:data},m);assert.equal(color,'#b3afa7');assert.equal(m.map,null);
 }
 let color;const m={color:{set:v=>color=v},map:'old'};
 ctx.ExteriorFinishes.apply({userData:{baseId:'base-1',exteriorFinish:{material:'default',color:'#aaaaaa'}}},m);
 assert.equal(color,'#aaaaaa');assert.equal(m.map,null);
});


test('textured outlines are muted and depth tested, then restore line colors and opacity',()=>{
 const ctx=fixture();let hex=0xffcc00;const material={color:{getHex:()=>hex,setHex:v=>hex=v},opacity:.95,transparent:true,depthTest:false,depthWrite:true,vertexColors:true},line={isLine:true,visible:true,userData:{},material},group={traverse:f=>f(line)};
 ctx.exteriorSurfaceDisplay(group,'textured');assert.equal(line.visible,true);assert.equal(hex,0x303840);assert.equal(material.opacity,.35);assert.equal(material.depthTest,true);assert.equal(material.depthWrite,false);assert.equal(material.vertexColors,false);
 ctx.exteriorSurfaceDisplay(group,'translucent');assert.equal(hex,0xffcc00);assert.equal(material.opacity,.95);assert.equal(material.depthTest,false);assert.equal(material.vertexColors,true);
});


test('the selected trim source line remains visible in textured mode while other markers stay hidden',()=>{
 const ctx=fixture(),selected={isSprite:true,visible:true,userData:{exteriorSelection:true}},marker={isSprite:true,visible:true,userData:{}},group={traverse:f=>[selected,marker].forEach(f)};
 ctx.exteriorSurfaceDisplay(group,'textured');assert.equal(selected.visible,true);assert.equal(marker.visible,false);
});

test('default finishes inherit material and colors while explicit assignments remain independent',()=>{
 const ctx=fixture(),F=ctx.ExteriorFinishes,d={material:'siding-vertical',color:'#123456',trimColor:'#abcdef'},resolve=f=>JSON.parse(JSON.stringify(F.resolve(f,d)));
 for(const face of [{},{material:'default'},{chimney:{id:'chimney-1'}}])assert.deepEqual(resolve(face),{material:'siding-vertical',color:'#123456'});
 assert.deepEqual(resolve({material:'brick'}),{material:'brick',color:'#123456'});
 assert.deepEqual(resolve({material:'default',finishColor:'#654321'}),{material:'siding-vertical',color:'#654321'});
 assert.deepEqual(resolve({material:'trim-horizontal'}),{material:'trim-horizontal',color:'#abcdef'});
 assert.deepEqual(resolve({material:'trim-vertical',finishColor:'#112233'}),{material:'trim-vertical',color:'#112233'});
 assert.equal(resolve({material:'unassigned'}).material,'unassigned','explicit smooth finish does not inherit a texture');
 ctx.WallMode={finishDefaults:d};assert.equal(F.resolve({}).color,'#123456');ctx.WallMode.finishDefaults={...d,color:'#987654'};assert.equal(F.resolve({}).color,'#987654');assert.equal(F.resolve({finishColor:'#654321'}).color,'#654321');
});

test('unassigned downward returns use soffit while explicit materials and colors override it',()=>{
 const ctx=fixture(),points=[{x:0,y:0,z:3},{x:0,y:2,z:3},{x:4,y:2,z:3},{x:4,y:0,z:3}],d={material:'brick',color:'#123456'};
 assert.equal(ctx.ExteriorFinishes.resolve({points},d).material,'soffit');assert.equal(ctx.ExteriorFinishes.resolve({points:[...points].reverse()},d).material,'brick');
 assert.equal(ctx.ExteriorFinishes.resolve({points,material:'default'},d).material,'brick');assert.equal(ctx.ExteriorFinishes.resolve({points,material:'siding-vertical',finishColor:'#abcdef'},d).color,'#abcdef');
 const m=mesh();ctx.ExteriorFinishes.prepare(m,{points},points);assert.equal(m.userData.exteriorFinish.material,'soffit');
});
test('roof rendering uses shingles above and soffit below for either winding and preserves openings',()=>{
 const ctx=fixture();Object.assign(ctx.THREE,{FrontSide:0,BackSide:1,DoubleSide:2,Vector2:class{constructor(x,y){Object.assign(this,{x,y});}},ShapeUtils:{triangulateShape:(points,holes)=>K.triangles(points,holes).triangles},BufferGeometry:class{setFromPoints(points){this.points=points;return this;}setIndex(ids){this.indices=ids;}setAttribute(name,value){this[name]=value;}},MeshBasicMaterial:class{constructor(options){Object.assign(this,options);}},Mesh:class{constructor(geometry,material){Object.assign(this,{geometry,material,userData:{}});}}});
 const p=(x,y)=>({x,y,z:3+y/2}),points=[p(0,0),p(4,0),p(4,4),p(0,4)],hole=[p(1,1),p(1,2),p(2,2),p(2,1)],vector=p=>({x:p.x,y:p.z,z:p.y});
 for(const reverse of [false,true]){const face={points:reverse?[...points].reverse():points,holes:[hole]},before=JSON.stringify(face),meshes=ctx.ExteriorFinishes.roofMeshes(face,vector,true);assert.equal(meshes.length,2);assert.equal(meshes[0].material.side,0);assert.equal(meshes[1].material.side,1);assert.equal(meshes[0].userData.exteriorFinish.material,'shingles');assert.equal(meshes[1].userData.exteriorFinish.material,'soffit');
  let area=0;const g=meshes[0].geometry;for(let i=0;i<g.indices.length;i+=3){const [a,b,c]=g.indices.slice(i,i+3).map(j=>g.points[j]),ny=(b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z);assert.ok(ny>0);area+=ny/2;}assert.equal(area,15);assert.equal(JSON.stringify(face),before);
  const plain=ctx.ExteriorFinishes.roofMeshes(face,vector,false);assert.equal(plain.length,1);assert.equal(plain[0].material.side,2);
 }
});
test('alignment guides stay bright yellow and visible in every surface display mode',()=>{
 const ctx=fixture(),material={color:'#FFD700',depthTest:false,opacity:1},line={isLine:true,visible:true,userData:{alignmentGuide:true},material};
 for(const mode of ['translucent','opaque','textured']){ctx.exteriorSurfaceDisplay({traverse:fn=>fn(line)},mode);assert.equal(line.visible,true);assert.equal(material.color,'#FFD700');assert.equal(material.depthTest,false);assert.equal(material.opacity,1);}
});

test('dimension labels never regain wall depth clipping when display mode changes',()=>{
 const ctx=fixture();for(const data of [{wallFeature:true},{wallLength:2},{moveIndicator:true},{wallFeature:true,exteriorSelection:true}]){
 const label={isSprite:true,visible:true,userData:data,material:{depthTest:false,depthWrite:false,opacity:1,transparent:true}};
 for(const mode of ['opaque','textured','translucent','opaque']){ctx.exteriorSurfaceDisplay({traverse:fn=>fn(label)},mode);assert.equal(label.material.depthTest,false);assert.equal(label.material.depthWrite,false);}
 }
});

test('selected stickers win coplanar depth ties and textured selection outlines remain visible',()=>{
 const ctx=fixture(),feature={isMesh:true,userData:{exteriorFeature:true,exteriorSelected:true},material:{opacity:.5,transparent:true,depthWrite:false}},outline={isLine:true,visible:true,userData:{exteriorSelection:true},material:{depthTest:false,depthWrite:false}};
 for(const mode of ['opaque','textured']){ctx.exteriorSurfaceDisplay({traverse:fn=>[feature,outline].forEach(fn)},mode);assert.equal(feature.renderOrder,2);assert.equal(feature.material.depthTest,true);assert.equal(feature.material.polygonOffsetFactor,-4);assert.equal(outline.material.depthTest,true);assert.equal(outline.material.depthWrite,false);assert.equal(outline.material.userData.wallLineDepthBias.pixels.value,6);}
 feature.userData.exteriorSelected=false;ctx.exteriorSurfaceDisplay({traverse:fn=>fn(feature)},'opaque');assert.equal(feature.renderOrder,1);assert.equal(feature.material.polygonOffsetFactor,-1);
});

test('opaque point markers remain whole overlays above filled surfaces',()=>{
 const ctx=fixture(),point={isPoints:true,visible:true,userData:{},material:{opacity:1,transparent:false,depthTest:false,depthWrite:true}},group={traverse:fn=>fn(point)};
 for(const mode of ['opaque','translucent','opaque']){ctx.exteriorSurfaceDisplay(group,mode);assert.equal(point.visible,true);assert.equal(point.material.depthTest,false);assert.equal(point.material.depthWrite,false);assert.equal(point.renderOrder,1000);}
});

test('opening UVs fit one complete texture and follow the saved feature axis',()=>{
 const ctx=fixture();ctx.WallFeatures=require('../public/measure/internal/editor_scripts/wall_features.js');const p=(x,z)=>({x,y:0,z}),face={points:[p(2,3),p(3,3),p(3,5),p(2,5)],feature:{type:'window',axis:{x:1,y:0,z:0}}},before=JSON.stringify(face),m=mesh();ctx.ExteriorFinishes.prepare(m,face,face.points);assert.deepEqual(Array.from(m.geometry.uv.array),[0,0,1,0,1,1,0,1]);assert.ok(Math.abs(m.userData.exteriorFinish.width-1)<1e-8);assert.ok(Math.abs(m.userData.exteriorFinish.height-2)<1e-8);assert.equal(JSON.stringify(face),before);
 face.feature.axis={x:0,y:0,z:1};ctx.ExteriorFinishes.prepare(m,face,face.points);assert.deepEqual(Array.from(m.geometry.uv.array),[0,1,0,0,1,0,1,1]);assert.ok(Math.abs(m.userData.exteriorFinish.width-2)<1e-8);
});
test('window door garage and vent textures are distinct, shared, and released with materials',()=>{
 const ctx=fixture(),canvasContext=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>o[k]||(()=>{})});ctx.document={createElement:()=>({getContext:()=>canvasContext})};ctx.THREE.CanvasTexture=class{constructor(canvas){this.image=canvas;this.userData={};}dispose(){this.disposed=true;}};ctx.THREE.ClampToEdgeWrapping=1001;
 const maps=[],materials=[];for(const type of ['window','door','garage','vent']){const data={exteriorFinish:{feature:true,featureType:type,width:1,height:2}},listeners={},m={userData:{},color:{set(){}},addEventListener:(event,fn)=>listeners[event]=fn};ctx.ExteriorFinishes.apply({userData:data},m);maps.push(m.map);materials.push(m);assert.equal(m.map.wrapS,1001);assert.equal(m.map.userData.users,1);const second={userData:{},color:{set(){}}};ctx.ExteriorFinishes.apply({userData:data},second);assert.equal(second.map,m.map);assert.equal(m.map.userData.users,2);listeners.dispose();assert.equal(second.map.userData.users,1);}
 assert.equal(new Set(maps).size,4);
});
test('opening trim texture spans its width and retains coplanar priority in textured mode',()=>{
 const ctx=fixture(),m=mesh(),face={openingTrim:true,trim:true,material:'trim-horizontal',finishColor:'#abcdef',points:[{x:0,y:0,z:2},{x:1,y:0,z:2},{x:1.05,y:0,z:2.05},{x:-.05,y:0,z:2.05}]};ctx.ExteriorFinishes.prepare(m,face,face.points);const ys=Array.from(m.geometry.uv.array).filter((_,i)=>i%2);assert.equal(Math.min(...ys),0);assert.equal(Math.max(...ys),1);assert.equal(m.userData.exteriorFinish.color,'#abcdef');const object={isMesh:true,userData:{openingTrim:true},material:{}};ctx.exteriorSurfaceDisplay({traverse:fn=>fn(object)},'textured');assert.equal(object.material.polygonOffsetFactor,-2);
});

test('opaque faces use depth bias to preserve coplanar lines without exposing hidden edges',()=>{
 const ctx=fixture(),fill={isMesh:true,userData:{},material:{opacity:.3,transparent:true,depthTest:false,depthWrite:false,polygonOffset:false,polygonOffsetFactor:0,polygonOffsetUnits:0}},line={isLine:true,visible:true,userData:{},material:{opacity:1,transparent:false,depthTest:false,depthWrite:true}},group={traverse:fn=>[fill,line].forEach(fn)};
 for(const mode of ['opaque','textured','opaque']){ctx.exteriorSurfaceDisplay(group,mode);assert.equal(fill.material.polygonOffset,true);assert.equal(fill.material.polygonOffsetFactor,1);assert.equal(fill.material.polygonOffsetUnits,1);assert.equal(fill.material.depthWrite,true);assert.equal(line.material.depthTest,true);assert.equal(line.material.depthWrite,false);}
 ctx.exteriorSurfaceDisplay(group,'translucent');assert.equal(fill.material.polygonOffset,false);assert.equal(fill.material.polygonOffsetFactor,0);assert.equal(line.material.depthTest,false);
});
