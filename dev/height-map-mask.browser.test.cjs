const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('2D mask tools hide the height mesh, coexist with crop, undo, and restore saved project masks',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:900,height:540}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://mask.test/**',route=>route.fulfill({contentType:'text/html',body:'<html></html>'}));await page.goto('http://mask.test/');
  await page.setContent('<style>body{margin:0;background:#171c22}#tab-view2d{height:530px}#viewport{position:relative;overflow:hidden}#zoom-layer{position:absolute;width:100px;height:100px;transform:translate(10px,10px) scale(3);transform-origin:0 0;background:linear-gradient(135deg,#709166,#384e41)}</style><div id="tab-view2d" class="active"><div id="viewport"><div id="zoom-layer"></div></div></div><input id="cropRange" value="0" type="hidden">');
  await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
  await page.evaluate(()=>{
   Object.assign(window,{imageWidth:100,imageHeight:100,mapCenterLat:40,mapCenterLng:-90,currentProjectId:'one',getMetersPerPx:()=>1,currentZoom:3,panX:10,panY:10,viewRotation:0,dsmMin:0,getZScale:()=>1,isMaskedPixel:()=>false,isHeightMeshContextCurrent:()=>true});
   window.layerData={dsm:[new Float32Array(10000).fill(5)]};window.geometry=new THREE.PlaneGeometry(100,100,99,99);window.mesh=new THREE.Mesh(geometry);window.WallMode={enabled:true,prepareHeightMask(){window.prepared=true;}};document.body.classList.add('wall-mode-active');
  });
  const input=fs.readFileSync('public/measure/internal/editor_scripts/interaction_2d.js','utf8'),scene=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8');
  await page.addScriptTag({content:input.slice(input.indexOf('function screenToImage('),input.indexOf('function updateSnapRadius(',input.indexOf('function screenToImage(')))});
  await page.addScriptTag({content:scene.slice(scene.indexOf('function update3DCrop()'),scene.indexOf('function update3DTextureForView()'))});
  await page.addScriptTag({path:'public/measure/internal/editor_scripts/height_map_mask.js'});
  await page.evaluate(()=>{window.wallClicks=0;window.addEventListener('pointerdown',()=>wallClicks++,true);HeightMapMask.restore('one',null);window.total=geometry.index.count;});
  await page.click('#height-mask-toggle');
  const draw=async(a,b)=>{const box=await page.locator('#viewport').boundingBox();await page.mouse.move(box.x+10+a[0]*3,box.y+10+a[1]*3);await page.mouse.down();await page.mouse.move(box.x+10+b[0]*3,box.y+10+b[1]*3,{steps:6});await page.mouse.up();};
  await page.evaluate(()=>wallClicks=0);await draw([20,20],[70,20]);
  const first=await page.evaluate(()=>({saved:HeightMapMask.serialize(),count:geometry.index.count,total,clicks:wallClicks,unchanged:layerData.dsm[0].every(v=>v===5)}));
  assert.ok(first.count<first.total);assert.equal(first.clicks,0);assert.ok(first.unchanged);
  assert.equal(await page.evaluate(()=>{const p=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,20*100+45);mesh.updateMatrixWorld();return new THREE.Raycaster(p.clone().add(new THREE.Vector3(0,0,30)),new THREE.Vector3(0,0,-1)).intersectObject(mesh).length;}),0,'masked hedge cannot intercept ground picking');
  await page.click('#height-mask-rectangle');await draw([50,50],[80,75]);
  await page.click('#height-mask-erase');await draw([75,70],[55,55]);
  const erased=await page.evaluate(()=>HeightMapMask.serialize().runs);await page.click('#height-mask-undo');assert.notDeepEqual(await page.evaluate(()=>HeightMapMask.serialize().runs),erased);await page.click('#height-mask-redo');assert.deepEqual(await page.evaluate(()=>HeightMapMask.serialize().runs),erased);
  await page.evaluate(()=>{document.getElementById('cropRange').value='20';update3DCrop();});
  assert.equal(await page.evaluate(()=>geometry.attributes.position.getZ(0)),0);assert.ok(await page.evaluate(()=>geometry.index.count<total));
  await page.click('#height-mask-clear');assert.equal(await page.evaluate(()=>geometry.index.count),first.total);assert.equal(await page.evaluate(()=>geometry.attributes.position.getZ(0)),0,'clear retains crop');
  await page.click('#height-mask-undo');const saved=await page.evaluate(()=>HeightMapMask.serialize());
  await page.evaluate(()=>{WallMode.enabled=false;HeightMapMask.syncMode();});assert.equal(await page.evaluate(()=>geometry.index.count),first.total);
  await page.evaluate(()=>{WallMode.enabled=true;HeightMapMask.syncMode();});assert.ok(await page.evaluate(()=>geometry.index.count<total));
  await page.evaluate(()=>{HeightMapMask.reset();currentProjectId='two';HeightMapMask.restore('two',null);});assert.deepEqual(await page.evaluate(()=>HeightMapMask.serialize().runs),[]);
  await page.evaluate(saved=>{currentProjectId='one';HeightMapMask.restore('one',saved);},saved);assert.deepEqual(await page.evaluate(()=>HeightMapMask.serialize().runs),saved.runs);
  await page.click('#height-mask-toggle');
  fs.mkdirSync('output/height-map-mask-20261008',{recursive:true});await page.screenshot({path:'output/height-map-mask-20261008/toolbar.png'});
  const before=await page.evaluate(()=>HeightMapMask.serialize().runs),box=await page.locator('#viewport').boundingBox();
  await page.mouse.move(box.x+40,box.y+40);await page.mouse.down();await page.mouse.move(box.x+100,box.y+100);await page.keyboard.press('Escape');await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>HeightMapMask.serialize().runs),before,'Escape cancels the whole pending rectangle');
  await page.click('#height-mask-clear');await page.click('#height-mask-draw');await page.click('#height-mask-brush');
  await page.evaluate(()=>{viewRotation=Math.PI/2;HeightMapMask.render();});
  const rotated=await page.locator('#viewport').boundingBox();
  // Image (30,40) rotates to screen image (60,30) around the image center.
  await page.mouse.click(rotated.x+10+60*3,rotated.y+10+30*3);
  assert.ok(await page.evaluate(()=>HeightMapMask.serialize().runs.some(([start,count])=>start<=4030&&start+count>4030)),'rotated painting remains aligned with DSM pixels');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
