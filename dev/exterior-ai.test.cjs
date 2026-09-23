const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('AI remains narrow, bounds positions, saves every view, caps refinements, restores captures and cancels stale runs',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{const page=await browser.newPage();let calls=0,requests=[];
 await page.route('http://localhost/**',async route=>{if(route.request().url().endsWith('exterior_ai.php')){calls++;requests.push(route.request().postDataJSON());await route.fulfill({json:{result:{x:20+calls,y:10,matched:false,confidence:.6,explanation:'Move back to match the roof silhouette.'}}});}else await route.fulfill({contentType:'text/html',body:'<style>#wall-panel{width:190px}</style><section id="wall-panel">General controls</section>'});});
 await page.goto('http://localhost/');await page.evaluate(()=>{
  window.FIRSTMEASURE_EXTERIOR_AI=true;window.currentProjectId='fullhouse_'+'a'.repeat(32);
  class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new V(this.x,this.y,this.z);}copy(v){Object.assign(this,v);return this;}lerpVectors(a,b,t){for(const k of ['x','y','z'])this[k]=a[k]+(b[k]-a[k])*t;return this;}}
  window.camera={position:new V(),fov:45,aspect:1,lookAt(){},updateMatrixWorld(){}};window.controls={target:new V(),enabled:true,enableDamping:true,update(){}};window.scene={};const canvas=document.createElement('canvas');canvas.width=canvas.height=100;canvas.getContext('2d').fillRect(0,0,100,100);window.renderer={domElement:canvas,render(){}};
  const g={min:{x:0,y:0,z:0},max:{x:10,y:10,z:8},center:{x:5,y:5,z:4},faces:[{points:[{x:0,y:0},{x:10,y:0},{x:10,y:10}]}],groundAt:p=>p.x*.1,toScene:p=>new V(p.x*2,p.z*2,p.y*2)};
  window.WallMode={enabled:true,aiGeometry:()=>g};window.ProjectResources={reportImages:async()=>[]};window.ExteriorPDF={initializePhotoSlots:s=>s.photoSlots={front:{image:{dataUrl:canvas.toDataURL('image/png')}}}};
 });
 await page.addScriptTag({path:'public/measure/internal/editor_scripts/exterior_ai.js'});await page.addScriptTag({path:'public/measure/internal/editor_scripts/exterior_performance.js'});await page.evaluate(()=>ExteriorPerf.mount(document.querySelector('#wall-panel')));
 await page.getByRole('tab',{name:'Speed',exact:true}).click();assert.equal(await page.locator('#wall-panel').evaluate(e=>e.getBoundingClientRect().width),410);
 await page.getByRole('tab',{name:'AI',exact:true}).click();assert.equal(await page.locator('#wall-panel').evaluate(e=>e.getBoundingClientRect().width),190);assert.equal(await page.evaluate(()=>ExteriorPerf.enabled),false);
 assert.equal(await page.evaluate(()=>{try{ExteriorAI.validatePosition({x:Infinity,y:2},{x0:0,x1:10,y0:0,y1:10},{x:5,y:5});return false;}catch(e){return true;}}),true);
 await page.getByRole('button',{name:'Jump to front with AI'}).click();await page.getByText('Finished: three-refinement limit reached. Match remains uncertain.',{exact:true}).waitFor();assert.equal(calls,5);assert.equal(requests[0].images.length,2);assert.equal(requests[4].images.length,3);assert.equal(requests[4].context.phase,'final review');assert.equal(requests[4].context.current.position.z,24*.1+1.8288);
 assert.equal(await page.locator('[data-log] img').count(),6);assert.equal(await page.evaluate(()=>camera.position.y),(24*.1+1.8288)*2);assert.equal(await page.evaluate(()=>controls.target.y),8);
 await page.getByRole('button',{name:'Last saved run'}).click();assert.equal(await page.locator('[data-log] img').count(),6);
 // A change of project during an outstanding response must never move the camera.
 await page.route('http://localhost/exterior_ai.php',async route=>{await page.evaluate(()=>window.currentProjectId='fullhouse_'+'b'.repeat(32));await route.fulfill({json:{result:{x:35,y:10,matched:false,confidence:.6,explanation:'stale'}}});});
 const old=await page.evaluate(()=>({...camera.position}));await page.getByRole('button',{name:'Jump to front with AI'}).click();await page.getByText('Project or exterior mode changed; run stopped.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>({...camera.position})),old);
 await page.route('http://localhost/exterior_ai.php',route=>route.fulfill({json:{result:{x:25,y:10,matched:true,confidence:.32,explanation:'Exact match uncertain.'}}}));
 await page.evaluate(()=>{camera.isOrthographicCamera=true;window.toggleProjection=()=>{camera.isOrthographicCamera=false;window.switchedProjection=true;};});
 await page.getByRole('button',{name:'Jump to front with AI'}).click();await page.getByText('Finished: AI stopped at low confidence. Visual match is unverified.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.switchedProjection),true);
 }finally{await browser.close();}
});
