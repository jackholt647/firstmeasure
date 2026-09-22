const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');

test('working plane edits use real camera rays, keyboard events, WebGL rendering and saved geometry',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:750}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<style>body{margin:0;background:#15212b;color:white;font:16px system-ui}#status{position:absolute;bottom:12px;left:12px}select{position:absolute;top:8px;left:8px}</style><div id="three-view-wrapper"><canvas></canvas></div><select id="base-selection"><option value="point">Points</option><option value="line">Lines</option><option value="face">Faces</option></select><div id="status"></div>');
  await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
  for(const name of ['vendor/clipper-lib-6.4.2-clipper','vendor/earcut-3.2.3-earcut.dev','exterior_geometry','wall_geometry','base_geometry','base_sketch_geometry','wall_solid_geometry','wall_features','wall_axis_cuts','wall_trim','wall_steps','exterior_model','wall_editor','wall_face_draft'])await page.addScriptTag({path:'public/measure/internal/editor_scripts/'+name+'.js'});
  await page.evaluate(()=>{
   window.isFreeMove=true;window.getVector3=p=>new THREE.Vector3(p.x,p.y,p.z);window.camera=new THREE.PerspectiveCamera(45,1000/750,.1,200);camera.up.set(0,0,1);camera.position.set(9,-16,10);camera.lookAt(3,0,2);camera.updateMatrixWorld();
   window.renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setSize(1000,750);renderer.setClearColor('#15212b');
   const p=(x,z)=>({x,y:0,z});window.model={wallEdits:{$surfaces:[{id:'wall',points:[p(0,0),p(4,0),p(4,4),p(0,4)]}],$loose:{points:[p(5,1),p(7,1)],edges:[[p(5,1),p(7,1)]]}}};window.historyEdits=[];
   window.screenPoint=p=>{const q=getVector3(p).project(camera);return {x:(q.x+1)*500,y:(1-q.y)*375,visible:q.z>=-1&&q.z<=1};};
   const scene=new THREE.Scene();let group;
   window.render=()=>{if(group){scene.remove(group);group.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});}group=new THREE.Group();scene.add(group);editor.draw3D(group,getVector3);renderer.render(scene,camera);};
   window.editor=createWallFaceDraft({state:()=>model,walls:()=>[],active:()=>true,selected:()=>null,toPixel:p=>p,screen:screenPoint,commit:before=>historyEdits.push(JSON.parse(JSON.stringify(before))),redraw:()=>render(),message:s=>document.getElementById('status').textContent=s});
   const canvas=renderer.domElement;canvas.addEventListener('pointerdown',e=>editor.down(e));canvas.addEventListener('dblclick',e=>editor.doubleClick(e));window.addEventListener('keydown',e=>{if(editor.key(e)){e.preventDefault();e.stopImmediatePropagation();}});
   editor.togglePlane(model.wallEdits.$surfaces[0]);render();
  });
  const clickWorld=async(p,modifiers=[])=>{const q=await page.evaluate(p=>screenPoint(p),p);for(const k of modifiers)await page.keyboard.down(k);await page.mouse.click(q.x,q.y);for(const k of modifiers)await page.keyboard.up(k);};
  await clickWorld({x:5,y:0,z:1});await clickWorld({x:7,y:0,z:1},['Shift']);assert.equal(await page.evaluate(()=>editor.pointSelection().length),2);
  await page.keyboard.press('m');const target=await page.evaluate(()=>screenPoint({x:8,y:0,z:2}));await page.mouse.move(target.x,target.y);await page.waitForTimeout(60);await page.mouse.click(target.x,target.y);
  assert.equal(await page.evaluate(()=>historyEdits.length),1);assert.ok(await page.evaluate(()=>editor.pointSelection().every(p=>Math.abs(p.y)<1e-8&&p.z>1.9)));
  await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');const destination=await page.evaluate(()=>screenPoint({x:4,y:0,z:6}));await page.mouse.move(destination.x,destination.y);await page.waitForTimeout(60);await page.mouse.click(destination.x,destination.y);
  assert.equal(await page.evaluate(()=>historyEdits.length),2);assert.equal(await page.evaluate(()=>editor.busy()),false);assert.ok(await page.evaluate(()=>editor.pointSelection().every(p=>Math.abs(p.y)<1e-8&&p.z>5.9)));
  await page.keyboard.press('ArrowRight');await page.keyboard.press('r');await page.evaluate(()=>editor.distanceInput().set(30));await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>historyEdits.length),4);assert.ok(await page.evaluate(()=>editor.pointSelection().every(p=>Math.abs(p.y)<1e-8)));
  const out=path.join(process.env.TEMP||require('os').tmpdir(),'exterior-plane-editor');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'plane-edit.png')});
  const saved=await page.evaluate(()=>JSON.stringify(model.wallEdits));await page.keyboard.press('m');await page.mouse.move(700,300);await page.waitForTimeout(60);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>JSON.stringify(model.wallEdits)),saved);
  await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>editor.pointSelection().length),0);assert.equal(await page.evaluate(()=>editor.planeActive()),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
