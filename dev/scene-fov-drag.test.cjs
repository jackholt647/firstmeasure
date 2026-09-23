const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('FOV slider keeps dragging across its range with live camera synchronization',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{const page=await browser.newPage();await page.setContent('<div id="panel"></div>');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.js'});
 const source=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8');
 await page.addScriptTag({content:`const panel=document.getElementById('panel');let _enh={},_sceneDirty3D=false;const camera=new THREE.PerspectiveCamera(45,1,.01,2000);camera.position.set(0,0,10);const controls={target:new THREE.Vector3()};\n`+source.slice(source.indexOf('function sync3DPerspectiveFovUI()'),source.indexOf('// §20  CAMERA PRESETS'))+'\n'+source.slice(source.indexOf('    const fovGroup ='),source.indexOf('    container.appendChild(panel);',source.indexOf('    const fovGroup =')))+'\nsync3DPerspectiveFovUI();setInterval(sync3DPerspectiveFovUI,16);'});
 const input=page.locator('#perspectiveFovRange'),rect=await input.boundingBox();
 await page.mouse.move(rect.x+rect.width*.36,rect.y+rect.height/2);await page.mouse.down();
 for(const fraction of [.6,.95,.5,.05,.8]){await page.mouse.move(rect.x+rect.width*fraction,rect.y+rect.height/2,{steps:12});const value=Number(await input.inputValue());assert.ok(Math.abs(value-(15+85*fraction))<8,`drag ${fraction}: ${value}`);}
 await page.mouse.up();assert.equal(await input.getAttribute('data-dragging'),null);
 }finally{await browser.close();}
});
