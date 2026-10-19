const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {chromium}=require('../public/v1/node_modules/playwright-core');

test('the frame pipeline retains each compiled program once, per renderer, within its bound',()=>{
 const context={window:{},requestAnimationFrame:()=>1,cancelAnimationFrame(){}};context.window=context;
 vm.createContext(context);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_frame_pipeline.js','utf8'),context);
 const programs=[{usedTimes:1},{usedTimes:3}];context.renderer={info:{programs}};
 context.ExteriorFramePipeline.flush();context.ExteriorFramePipeline.flush();
 assert.deepEqual(programs.map(p=>p.usedTimes),[2,4]);
 programs.push({usedTimes:1});context.ExteriorFramePipeline.flush();assert.equal(programs[2].usedTimes,2);
 const many=Array.from({length:300},()=>({usedTimes:1}));context.renderer={info:{programs:many}};context.ExteriorFramePipeline.flush();
 assert.equal(many.filter(p=>p.usedTimes===2).length,256);
});

test('WebGL: replaced exterior materials reuse their compiled program; occlusion hits match intersectObjects',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:300,height:300}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<canvas></canvas>');
  await page.addInitScript(()=>{});
  await page.evaluate(()=>{window.__links=0;for(const C of [WebGLRenderingContext,WebGL2RenderingContext]){const f=C.prototype.linkProgram;C.prototype.linkProgram=function(...a){window.__links++;return f.apply(this,a);};}});
  await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
  for(const name of ['exterior_frame_pipeline','wall_editor'])await page.addScriptTag({path:'public/measure/internal/editor_scripts/'+name+'.js'});
  const result=await page.evaluate(()=>{
   window.renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas')});renderer.setSize(300,300);
   const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.set(0,0,10);camera.updateMatrixWorld();
   const frameLinks=[];let mesh;
   for(let i=0;i<6;i++){
    // Editor order: the frame pipeline flushes, the exterior view rebuilds (disposing the previous materials), then WebGL draws.
    // Even-numbered frames rebuild synchronously before the flush, as a direct render3D after a commit does.
    if(i%2===0)ExteriorFramePipeline.retainPrograms();else ExteriorFramePipeline.flush();
    if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
    mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({color:'#887744',transparent:true,opacity:.3,depthWrite:false,side:THREE.DoubleSide}));scene.add(mesh);
    renderer.render(scene,camera);frameLinks.push(window.__links);
   }
   // Random occluders and rays: the early-exit test agrees with collecting every intersection.
   let seed=7;const random=()=>(seed=(seed*16807)%2147483647)/2147483647;
   const occluders=[];for(let i=0;i<40;i++){const m=new THREE.Mesh(i%3?new THREE.PlaneGeometry(random()*3,random()*3):new THREE.BoxGeometry(random(),random(),random()),new THREE.MeshBasicMaterial({side:i%2?THREE.DoubleSide:THREE.FrontSide}));m.position.set(random()*8-4,random()*8-4,random()*8-4);m.rotation.set(random()*3,random()*3,random()*3);if(i%7===0)m.layers.set(2);m.updateMatrixWorld();occluders.push(m);}
   let agree=0,hits=0,total=0;const ray=new THREE.Raycaster();
   for(let r=0;r<600;r++){
    const frame={meshes:occluders};
    ray.set(new THREE.Vector3(random()*10-5,random()*10-5,random()*10-5),new THREE.Vector3(random()-.5,random()-.5,random()-.5).normalize());ray.far=random()*12;if(r%5===0)ray.layers.set(2);else ray.layers.set(0);
    const expected=ray.intersectObjects(occluders,false).length>0,actual=wallOcclusionHit(ray,frame);total++;if(expected===actual)agree++;if(expected)hits++;
   }
   return {frameLinks,agree,hits,total};
  });
  assert.deepEqual(errors,[]);
  // The first frame compiles the program; replacing the material afterwards does not relink it.
  assert.ok(result.frameLinks[0]>=1);assert.equal(result.frameLinks.at(-1),result.frameLinks[0],JSON.stringify(result.frameLinks));
  assert.equal(result.agree,result.total);assert.ok(result.hits>30&&result.hits<result.total-30,JSON.stringify(result));
 }finally{await browser.close();}
});
