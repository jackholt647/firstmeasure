const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('../public/v1/node_modules/three');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const source=fs.readFileSync('public/measure/internal/editor_scripts/exterior_ai.js','utf8');
const sandbox={window:{}};vm.runInNewContext(source,sandbox);const AI=sandbox.window.ExteriorAI;
test('all eight equal-radius views frame wide/tall models on slopes using independent Three.js projection',()=>{
 for(const [width,depth,height,slope,aspect] of [[30,9,12,0,16/9],[10,18,32,.12,.6],[40,7,10,-.18,1.2],[12,12,9,.3,2]]){
  const g={min:{x:-width/2,y:-depth/2,z:100},max:{x:width/2,y:depth/2,z:100+height},center:{x:0,y:0,z:100+height/2},groundAt:p=>100+p.x*slope+p.y*.03};
  const result=AI.orbit(g,aspect);assert.equal(result.positions.length,8);
  for(let i=0;i<8;i++){
   const p=result.positions[i];assert.ok(Math.abs(Math.hypot(p.x,p.y)-result.radius)<1e-9);assert.ok(Math.abs(p.z-g.groundAt(p)-1.8288)<1e-9);
   assert.ok(Math.abs(p.x-Math.sin(i*Math.PI/4)*result.radius)<1e-9);
   const c=new THREE.PerspectiveCamera(45,aspect,.01,100000);c.position.set(p.x,p.z,p.y);c.lookAt(0,g.center.z,0);c.updateMatrixWorld();
   for(const x of [g.min.x,g.max.x])for(const y of [g.min.y,g.max.y])for(const z of [g.min.z,g.max.z]){
    const q=new THREE.Vector3(x,z,y).project(c);assert.ok(Math.abs(q.x)<.901&&Math.abs(q.y)<.901&&q.z>-1&&q.z<1,JSON.stringify({q,p,aspect}));
   }
  }
  assert.ok(result.positions.some((p,i)=>!AI.fits(g,AI.orbitPosition(g,result.radius*.98,i),aspect)),'radius stays close to the minimum common fit');
 }
 assert.throws(()=>AI.validateChoice({view:9,confidence:.9,explanation:'invalid'}));
 assert.throws(()=>AI.validateChoice({view:2.5,confidence:.9,explanation:'invalid'}));
});
test('one Luna request compares eight textured captures, selects a saved pose, restores history and rejects stale responses',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  const page=await browser.newPage();let requests=[],logs=[];page.on('console',m=>logs.push(m.text()));
  await page.route('http://localhost/**',async route=>{
   if(route.request().url().endsWith('exterior_ai.php')){requests.push(route.request().postDataJSON());await route.fulfill({json:{rawResponse:{id:'response-example',output:[{text:'original output'}]},result:{view:6,confidence:.83,explanation:'View 6 has the matching garage and dormer arrangement.'}}});}
   else await route.fulfill({contentType:'text/html',body:'<style>#wall-panel{width:190px}</style><section id="wall-panel">General controls</section>'});
  });
  await page.goto('http://localhost/');await page.evaluate(()=>{
   window.originalToDataURL=HTMLCanvasElement.prototype.toDataURL;window.FIRSTMEASURE_EXTERIOR_AI=true;window.currentProjectId='fullhouse_'+'a'.repeat(32);
   class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new V(this.x,this.y,this.z);}copy(v){Object.assign(this,v);return this;}lerpVectors(a,b,t){for(const k of ['x','y','z'])this[k]=a[k]+(b[k]-a[k])*t;return this;}}
   window.camera={position:new V(),fov:20,zoom:2,aspect:1,isOrthographicCamera:true,lookAt(){},updateMatrixWorld(){},updateProjectionMatrix(){}};
   window.toggleProjection=()=>camera.isOrthographicCamera=false;
   window.controls={target:new V(),enabled:true,enableDamping:true,update(){}};window.scene={};
   const canvas=document.createElement('canvas');canvas.width=240;canvas.height=180;canvas.getContext('2d').fillRect(0,0,240,180);window.renderer={domElement:canvas,render(){throw Error('Wireframe fallback forbidden');}};
   const g={min:{x:-5,y:-5,z:0},max:{x:5,y:5,z:8},center:{x:0,y:0,z:4},groundAt:p=>p.x*.1,toScene:p=>new V(p.x*2,p.z*2,p.y*2)};
   window.ExteriorRendered={captureStatus:{active:true,pending:0,errors:[]},render(){window.renderedFrames=(window.renderedFrames||0)+1;return true;}};
   window.WallMode={enabled:true,aiGeometry:()=>g,prepareAICapture(){window.texturePrepared=true;ExteriorRendered.captureStatus.pending=1;setTimeout(()=>ExteriorRendered.captureStatus.pending=0,100);}};
   window.ProjectResources={reportImages:async()=>[]};window.ExteriorPDF={initializePhotoSlots:s=>s.photoSlots={front:{image:{dataUrl:canvas.toDataURL('image/png')}}}};
  });
  await page.addScriptTag({path:'public/measure/internal/editor_scripts/exterior_ai.js'});await page.addScriptTag({path:'public/measure/internal/editor_scripts/exterior_performance.js'});await page.evaluate(()=>ExteriorPerf.mount(document.querySelector('#wall-panel')));
  await page.getByRole('tab',{name:'AI',exact:true}).click();assert.equal(await page.locator('#wall-panel').evaluate(e=>e.getBoundingClientRect().width),190);
  await page.getByRole('button',{name:'Capture 8 views'}).click();await page.getByText('All eight textured views saved. Choose Ask Luna to run or rerun AI.',{exact:true}).waitFor();await page.getByRole('button',{name:'Ask Luna',exact:true}).click();await page.getByText('Finished: View 6 selected. Compare with the front photo.',{exact:true}).waitFor();
  assert.equal(requests.length,1);
  const firstImages=requests[0].images;
  await page.evaluate(()=>{HTMLCanvasElement.prototype.toDataURL=()=>{throw Error('Replay must not recapture');};});
  await page.getByRole('button',{name:'Ask Luna',exact:true}).click();await page.getByText('Finished: View 6 selected. Compare with the front photo.',{exact:true}).waitFor();
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);
  assert.deepEqual(requests[1].images,firstImages);
  assert.equal(await page.locator('[data-log] img').count(),9);
assert.equal(requests[0].images.length,9);assert.equal(requests[0].mode,'orbit-front-v2');assert.ok(!JSON.stringify(requests[0].context).includes('north'));
  assert.equal(await page.locator('[data-log] img').count(),9);assert.equal(await page.locator('section[data-selected] strong').innerText(),'View 6 · selected');
  const saved=await page.evaluate(async()=>{const r=indexedDB.open('firstmeasure-exterior-ai',1);const db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result));const q=db.transaction('runs').objectStore('runs').getAll();return await new Promise(resolve=>q.onsuccess=()=>{db.close();resolve(q.result[0]);});});
  assert.equal(saved.steps.length,9);assert.equal(saved.attempts.length,2);assert.equal(saved.attempts[1].rawResponse.id,'response-example');assert.equal(logs.filter(m=>m.startsWith('Full model response')).length,2);const views=saved.steps.slice(1);assert.equal(new Set(views.map(s=>s.angle)).size,8);
  assert.deepEqual(await page.evaluate(()=>({...camera.position})),views[5].scenePosition);assert.equal(await page.evaluate(()=>camera.fov),45);assert.equal(await page.evaluate(()=>camera.zoom),1);assert.equal(await page.evaluate(()=>controls.enabled&&controls.enableDamping&&window.texturePrepared),true);
  assert.equal(await page.evaluate(()=>camera.isOrthographicCamera),false);assert.ok(await page.evaluate(()=>window.renderedFrames)>8);
  await page.getByRole('button',{name:'Last saved run'}).click();assert.equal(await page.locator('[data-log] img').count(),9);
  await page.getByRole('button',{name:'Rotate to View 2',exact:true}).click();await page.getByText('Viewing View 2.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>({...camera.position})),views[1].scenePosition);
  // All ten requests must be dispatched before any response is released.
  const batchRoutes=[];let batchImages=[];
  await page.route('http://localhost/exterior_ai.php',async route=>{
   batchRoutes.push(route);batchImages.push(route.request().postDataJSON());
   if(batchRoutes.length===10)await Promise.all(batchRoutes.map((r,i)=>r.fulfill(i===9?{status:502,json:{error:'test failure'}}:{json:{result:{view:i<5?2:i<8?(i%2?8:1):3,betweenView:i<5?null:i<8?(i%2?1:8):null,confidence:.8,explanation:'sample'}}})));
  });
  const beforeBatch=await page.evaluate(()=>({...camera.position}));
  await page.getByRole('button',{name:'Ask Luna ×10',exact:true}).click();
  await page.getByText('Sample complete: 9/10 successful. Camera unchanged.',{exact:true}).waitFor();
  assert.equal(batchRoutes.length,10);for(const r of batchImages)assert.deepEqual(r,requests[0]);
  assert.deepEqual(await page.evaluate(()=>({...camera.position})),beforeBatch);
  assert.match(await page.locator('[data-batch="'+await page.locator('section[data-batch]').getAttribute('data-batch')+'"]').innerText(),/View 2: 5\/10/);
  assert.match(await page.locator('section[data-batch]').innerText(),/halfway between Views 8 and 1: 3\/10/);
  assert.match(await page.locator('section[data-batch]').innerText(),/1 failed or stopped/);
  await page.evaluate(()=>HTMLCanvasElement.prototype.toDataURL=window.originalToDataURL);
  await page.route('http://localhost/exterior_ai.php',async route=>route.fulfill({json:{result:{view:8,betweenView:1,confidence:.8,explanation:'Between the neighboring views.'}}}));
  await page.getByRole('button',{name:'Capture 8 views'}).click();await page.getByText('All eight textured views saved. Choose Ask Luna to run or rerun AI.',{exact:true}).waitFor();await page.getByRole('button',{name:'Ask Luna',exact:true}).click();await page.getByText('Finished: halfway between Views 8 and 1 selected. Compare with the front photo.',{exact:true}).waitFor();
  const midpoint=await page.evaluate(()=>{const g=WallMode.aiGeometry(),r=ExteriorAI.orbit(g,240/180).radius;return {...g.toScene(ExteriorAI.orbitPosition(g,r,7.5))};});
  assert.deepEqual(await page.evaluate(()=>({...camera.position})),midpoint);
  // A stale model response may not move the camera after the project changes.
  let poseAtResponse;
  await page.route('http://localhost/exterior_ai.php',async route=>{poseAtResponse=await page.evaluate(()=>({...camera.position}));await page.evaluate(()=>window.currentProjectId='fullhouse_'+'b'.repeat(32));await route.fulfill({json:{result:{view:3,confidence:.9,explanation:'stale'}}});});
  await page.getByRole('button',{name:'Capture 8 views'}).click();await page.getByText('All eight textured views saved. Choose Ask Luna to run or rerun AI.',{exact:true}).waitFor();await page.getByRole('button',{name:'Ask Luna',exact:true}).click();await page.getByText('Project or exterior mode changed; run stopped.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>({...camera.position})),poseAtResponse);
  // Missing materials fail before any API request or capture; controls recover.
  await page.evaluate(()=>ExteriorRendered.captureStatus.errors=['roof-albedo.jpg']);
  await page.getByRole('button',{name:'Capture 8 views'}).click();await page.getByText('A texture failed to load. Reload the editor and retry the capture.',{exact:true}).waitFor();assert.equal(await page.locator('[data-log] img').count(),1);assert.equal(await page.evaluate(()=>controls.enabled),true);
 }finally{await browser.close();}
});

test('midpoint choices wrap around and reject non-adjacent candidates',()=>{
 for(const [view,betweenView,index] of [[1,2,.5],[2,1,.5],[8,1,7.5],[1,8,7.5],[4,null,3]]){const r={view,betweenView,confidence:.8,explanation:'test'};AI.validateChoice(r);assert.equal(AI.choiceIndex(r),index);}
 for(const betweenView of [1,3,0,9,1.5])assert.throws(()=>AI.validateChoice({view:1,betweenView,confidence:.8,explanation:'invalid'}));
});

test('distribution clusters reversed midpoint pairs and keeps failures out of choice counts',()=>{
 const result=(view,betweenView)=>({result:{view,betweenView,confidence:.8,explanation:'test'}});
 const d=AI.distribution([result(8,1),result(1,8),result(2,null),{error:'failed'}]);
 assert.equal(d.length,2);assert.equal(d[0].index,7.5);assert.equal(d[0].count,2);assert.equal(d[1].count,1);
});
