const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('selection updates existing marker buffers and preserves meshes and visibility',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{const page=await browser.newPage({viewport:{width:400,height:400}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.setContent('<style>body{margin:0}</style><canvas></canvas>');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});await page.addScriptTag({path:'public/measure/internal/editor_scripts/wall_editor.js'});
 const result=await page.evaluate(()=>{
 const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),preserveDrawingBuffer:true,antialias:false});renderer.setSize(400,400);
 const scene=new THREE.Scene(),group=new THREE.Group();scene.add(group);const camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);camera.position.z=10;camera.updateMatrixWorld();
 const wall=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.MeshBasicMaterial({color:'#887744',side:THREE.DoubleSide}));group.add(wall);
 wallSelectablePoints(group,p=>new THREE.Vector3(p.x,p.y,p.z),[{p:{x:0,y:0,z:0},key:'front',color:'#e7ad52',size:8,selectedSize:12},{p:{x:1,y:0,z:-1},key:'hidden',color:'#e7ad52',size:8,selectedSize:12}]);
 exteriorSurfaceDisplay(group,'opaque');const markers=group.children.find(o=>o.isPoints),geometry=markers.geometry,position=geometry.getAttribute('position'),surface=wall.geometry;
 const pixel=x=>{const data=new Uint8Array(4),gl=renderer.getContext();gl.readPixels(x,200,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return Array.from(data);};
 renderer.render(scene,camera);const before=pixel(200);markers.userData.updatePointSelection(new Set(['front','hidden']));renderer.render(scene,camera);const selected=pixel(200),hidden=pixel(300);
 markers.userData.updatePointSelection(new Set());renderer.render(scene,camera);const after=pixel(200);
 const entries=Array.from({length:10000},(_,i)=>({p:{x:10+i,y:0,z:0},key:String(i),color:'#e7ad52',size:8,selectedSize:12})),large=new THREE.Group();wallSelectablePoints(large,p=>new THREE.Vector3(p.x,p.y,p.z),entries);const start=performance.now();large.children[0].userData.updatePointSelection(new Set(entries.map(e=>e.key)));const ms=performance.now()-start;
 return {same:markers.geometry===geometry&&geometry.getAttribute('position')===position&&wall.geometry===surface,before,selected,hidden,after,count:markers.geometry.drawRange.count,ms};
 });assert.equal(result.same,true);assert.equal(result.count,1);assert.ok(result.selected.slice(0,3).every(v=>v>245));assert.ok(result.hidden[0]<245);assert.deepEqual(result.after,result.before);assert.deepEqual(errors,[]);console.log('10,000 marker selection attribute update: '+result.ms.toFixed(2)+' ms');
 }finally{await browser.close();}
});
