const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('textured finish pixels match swatches and remain stable when 3D tile output encoding changes',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});
 try{
  const page=await browser.newPage();await page.setContent('<body></body>');
  for(const path of ['public/v1/node_modules/three/build/three.min.js','public/measure/internal/editor_scripts/exterior_finishes.js','public/measure/internal/editor_scripts/wall_editor.js'])await page.addScriptTag({path});
  const result=await page.evaluate(()=>{
   const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(32,32);document.body.appendChild(renderer.domElement);
   const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=2;
   const material=new THREE.MeshBasicMaterial({color:'#ffb866'}),mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);scene.add(mesh);
   mesh.userData.exteriorFinish={material:'unassigned',color:'#ffb866'};
   const pixel=()=>{renderer.render(scene,camera);const p=new Uint8Array(4);renderer.getContext().readPixels(16,16,1,1,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,p);return Array.from(p).slice(0,3);};
   const samples=[];for(const encoding of [THREE.LinearEncoding,THREE.sRGBEncoding,THREE.LinearEncoding]){renderer.outputEncoding=encoding;exteriorSurfaceDisplay(scene,'textured');samples.push(pixel());}
   mesh.userData.exteriorFinish={material:'siding',color:'#ffb866',normal:{x:0,y:1,z:0}};
   const siding=[];for(const encoding of [THREE.LinearEncoding,THREE.sRGBEncoding]){renderer.outputEncoding=encoding;exteriorSurfaceDisplay(scene,'textured');siding.push(pixel());}
   renderer.outputEncoding=THREE.LinearEncoding;exteriorSurfaceDisplay(scene,'translucent');const restored=pixel();
   exteriorSurfaceDisplay(scene,'textured');mesh.userData.exteriorSelected=true;exteriorSurfaceDisplay(scene,'textured');const selected=pixel();mesh.userData.exteriorSelected=false;exteriorSurfaceDisplay(scene,'textured');const deselected=pixel();
   renderer.dispose();return {samples,siding,restored,selected,deselected};
  });
  const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<=2);
  for(const pixel of result.samples)assert.ok(close(pixel,[255,184,102]),JSON.stringify(result));
  assert.ok(close(...result.siding),JSON.stringify(result));
  assert.ok(close(result.restored,[255,184,102]),'leaving textured mode restores the original drawing material: '+JSON.stringify(result));
  assert.ok(close(result.deselected,result.siding[0]));assert.ok(result.selected[1]>result.deselected[1],'selection still brightens the surface');
 }finally{await browser.close();}
});
