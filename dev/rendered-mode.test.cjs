const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('Rendered builds a separate PBR scene, loads real assets, exports 4K, and restores editor rendering',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('http://rendered.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'){return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body style="margin:0"><div id="three-view-wrapper" style="position:relative;width:1200px;height:800px"></div></body>'});}const file=path.resolve('public/measure/internal',url.pathname.slice(1));assert.ok(file.startsWith(path.resolve('public/measure/internal')+path.sep));await route.fulfill({path:file});});
  await page.goto('http://rendered.test/');
  await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
  for(const name of ['vendor/clipper-lib-6.4.2-clipper','vendor/earcut-3.2.3-earcut.dev','exterior_geometry','wall_solid_geometry','wall_features','exterior_finishes','exterior_rendered'])await page.addScriptTag({url:'http://rendered.test/editor_scripts/'+name+'.js'});
  const initial=await page.evaluate(()=>{
   const p=(x,y,z)=>({x,y,z}),vector=p=>new THREE.Vector3(p.x,p.z,p.y),source=new THREE.Scene(),group=new THREE.Group();source.add(group);
   window.demoFaces=[];
   const face=(points,material,holes=[],feature)=>{
    const data={points,holes,material,feature,finishColor:material==='siding'?'#adbbbd':material==='shingles'?'#4c5357':undefined},fr=WallSolidGeometry.faceFrame(data),flat=[points,...holes].flat(),local=p=>WallSolidGeometry.inFrame(fr,p),geometry=new THREE.BufferGeometry().setFromPoints(flat.map(vector));geometry.setIndex(ExteriorGeometry.triangles(points.map(local),holes.map(r=>r.map(local))).triangles.flat());geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#aaaaaa',side:THREE.DoubleSide}));mesh.userData.pickLayer='walls';ExteriorFinishes.prepare(mesh,data,flat);group.add(mesh);demoFaces.push(data);return mesh;
   };
   const w1=[p(.8,0,1),p(2.4,0,1),p(2.4,0,2.5),p(.8,0,2.5)],w2=w1.map(p=>({...p,x:p.x+4.5})),door=[p(3.3,0,.04),p(4.25,0,.04),p(4.25,0,2.2),p(3.3,0,2.2)];
   face([p(0,0,0),p(8,0,0),p(8,0,3),p(0,0,3)],'siding',[w1,w2,door]);
   face([p(0,4,0),p(0,0,0),p(0,0,3),p(0,2,4.4),p(0,4,3)],'brick');
   const garage=[p(8,.65,.04),p(8,3.45,.04),p(8,3.45,2.3),p(8,.65,2.3)];
   face([p(8,0,0),p(8,4,0),p(8,4,3),p(8,2,4.4),p(8,0,3)],'siding',[garage]);
   face([p(8,4,0),p(0,4,0),p(0,4,3),p(8,4,3)],'siding');
   face([p(-.3,-.3,2.85),p(8.3,-.3,2.85),p(8.3,2,4.4),p(-.3,2,4.4)],'shingles');
   face([p(-.3,2,4.4),p(8.3,2,4.4),p(8.3,4.3,2.85),p(-.3,4.3,2.85)],'shingles');
   for(const points of [w1,w2])face(points,'unassigned',[],{type:'window',axis:{x:1,y:0,z:0}});
   face(door,'unassigned',[],{type:'door',axis:{x:1,y:0,z:0}});face(garage,'unassigned',[],{type:'garage',axis:{x:0,y:1,z:0}});
   const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1200,800);document.getElementById('three-view-wrapper').appendChild(renderer.domElement);
   const camera=new THREE.PerspectiveCamera(42,1.5,.05,100);camera.position.set(12,6,-11);camera.lookAt(4,1.6,1.5);
   group.children[4].name='roof-top';group.children[4].material.side=THREE.FrontSide;
   const underside=group.children[4].clone();underside.name='roof-underside';underside.material=underside.material.clone();underside.material.side=THREE.BackSide;group.add(underside);
   const renderScene=renderer.render.bind(renderer);renderer.render=(scene,camera)=>{window.demoSides=scene.children.filter(o=>o.name.startsWith('rendered-roof-')).map(o=>o.material.side);return renderScene(scene,camera);};
   window.demo={group,source,renderer,camera,vector,before:JSON.stringify(demoFaces),originalMaterial:group.children[0].material,originalGeometry:group.children[0].geometry};
   ExteriorRendered.update(group,{enabled:true,scene:source,vector});const draw=()=>ExteriorRendered.render(renderer,source,camera);window.demo.draw=draw;window.demo.timer=setInterval(draw,150);draw();return group.children.length;
  });
  await page.getByRole('status').filter({hasText:'2K materials'}).waitFor({timeout:60000});
  // Compile after HDR prefiltering; shader failures are observable in the console.
  await page.evaluate(()=>demo.draw());
  const output=process.env.RENDERED_SCREENSHOT||path.join(require('node:os').tmpdir(),'firstmeasure-rendered-demo.png');await page.screenshot({path:output});
  await page.getByLabel('Render lighting',{exact:true}).selectOption('golden');await page.evaluate(()=>demo.draw());
  const exported=page.waitForEvent('download',{timeout:60000});await page.getByRole('button',{name:'Save 4K',exact:true}).click();const download=await exported;assert.equal(download.suggestedFilename(),'exterior-rendered-4k.png');
  const result=await page.evaluate(()=>{
   const {renderer,source,camera,group}=demo;clearInterval(demo.timer);
   const pixels=new Uint8Array(4);renderer.getContext().readPixels(600,400,1,1,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,pixels);
   const stable=demo.before===JSON.stringify(demoFaces)&&group.children[0].geometry===demo.originalGeometry&&group.children[0].material===demo.originalMaterial;
   ExteriorRendered.stop();const fallback=ExteriorRendered.render(renderer,source,camera);ExteriorRendered.update(group,{enabled:true,scene:source,vector:demo.vector});demo.draw();ExteriorRendered.stop();
   return {sides:window.demoSides,stable,count:group.children.length,fallback,huds:document.querySelectorAll('#exterior-rendered-controls').length,encoding:renderer.outputEncoding,tone:renderer.toneMapping,shadow:renderer.shadowMap.enabled,size:renderer.getSize(new THREE.Vector2()).toArray(),pixels:Array.from(pixels)};
  });
  assert.deepEqual(result.sides,[0,1]);assert.equal(result.stable,true);assert.equal(result.count,initial);assert.equal(result.fallback,false);assert.equal(result.huds,1);assert.equal(result.encoding,3000);assert.equal(result.tone,0);assert.equal(result.shadow,false);assert.deepEqual(result.size,[1200,800]);assert.equal(errors.length,0,errors.join('\n'));
  console.log('Rendered visual fixture:',output);
 }finally{await browser.close();}
});
