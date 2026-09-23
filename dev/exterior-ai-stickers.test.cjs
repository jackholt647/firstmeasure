const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('opaque captures exclude occluded faces; both query styles, row selection and saved history work',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{
 const page=await browser.newPage(),requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://stickers.test/**',async route=>{
  if(route.request().url().endsWith('exterior_ai.php')){const d=route.request().postDataJSON();requests.push(d);await route.fulfill({json:{result:{faces:d.faceIds.map(face=>({face,windows:face,doors:0,garageDoors:null,evidence:'Visible openings',...(d.output==='placements'?{placements:[{type:'window',x:20,y:20,width:30,height:40}]}:{})}))},rawResponse:{output:[{type:'reasoning',summary:[{text:'A short summary'}]}]}}});}
  else await route.fulfill({contentType:'text/html',body:'<div id="ai-stickers" style="width:190px"></div>'});
 });
 async function setup(){
 await page.goto('http://stickers.test/');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
 for(const name of ['vendor/clipper-lib-6.4.2-clipper','vendor/earcut-3.2.3-earcut.dev','exterior_geometry','wall_solid_geometry','wall_features','exterior_ai_stickers'])await page.addScriptTag({path:'public/measure/internal/editor_scripts/'+name+'.js'});
 await page.evaluate(()=>{
  window.currentProjectId='fullhouse_'+'a'.repeat(32);const p=(x,y,z)=>({x,y,z});
  const f=(id,x1,x2,y)=>({id,signature:id,points:[p(x1,y,0),p(x2,y,0),p(x2,y,3),p(x1,y,3)]});
  const faces=[f('wall:left',-4,0,0),f('wall:right',0,4,0),f('wall:hidden',-2,2,2)];
  window.source={faces,occluders:faces,toScene:p=>new THREE.Vector3(p.x,p.z,p.y)};
  window.camera=new THREE.PerspectiveCamera(45,1.5,.1,100);camera.position.set(0,1.8,-13);camera.lookAt(0,1.5,0);camera.updateMatrixWorld();
  window.renderer={domElement:{width:600,height:400}};
  window.applied=[];window.WallMode={applyAIPlacements:record=>{applied.push(record);return {placed:record.rows.reduce((n,r)=>n+r.placements.length,0),skipped:[]};},enabled:true,aiStickerScene:()=>source,selectAIFace:(id,signature)=>window.selectedFace={id,signature}};
  const c=document.createElement('canvas');c.width=20;c.height=20;c.getContext('2d').fillRect(0,0,20,20);
  window.ExteriorAI={context:()=>({id:'rotation-test',project:currentProjectId,front:c.toDataURL('image/jpeg'),steps:[]})};window.ProjectResources={reportImages:async()=>[]};
  return ExteriorAIStickers.mount(document.getElementById('ai-stickers'));
 });
 }
 await setup();const capture=await page.evaluate(()=>{const before=JSON.stringify(camera.toJSON()),result=ExteriorAIStickers.captureFaces(source,camera,600,400);return {...result,unchanged:before===JSON.stringify(camera.toJSON())};});
 assert.deepEqual(capture.faces.map(f=>f.id),['wall:left','wall:right']);assert.ok(capture.unchanged);assert.notEqual(capture.highlights[1],capture.highlights[2]);assert.ok(capture.faces.every(f=>f.visiblePixels>64));
 const seam=await page.evaluate(async image=>{const img=new Image();img.src=image;await img.decode();const c=document.createElement('canvas');c.width=600;c.height=400;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(298,165,5,65).data;let darkRows=0;for(let y=0;y<65;y++)if(Array.from({length:5},(_,x)=>pixels[(y*5+x)*4]<90).some(Boolean))darkRows++;return darkRows;},capture.image);
 assert.equal(seam,65,'coplanar neighboring faces retain a continuous visible boundary');
 await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>!ExteriorAIStickers.busy);await page.getByText('Finished',{exact:true}).waitFor();assert.equal(requests.length,1);assert.deepEqual(requests[0].faceIds,[1,2]);assert.equal(requests[0].images.length,2);
 const faceOrder=()=>page.locator('tbody tr td:first-child').allTextContents();
 await page.getByRole('button',{name:'Sort by windows',exact:true}).click();assert.deepEqual(await faceOrder(),['2','1']);
 assert.equal(await page.locator('th[aria-sort="descending"]').innerText(),'W ↓');
 await page.locator('tbody tr').first().click();assert.deepEqual(await page.evaluate(()=>selectedFace),{id:'wall:right',signature:'wall:right'});
 await page.getByRole('button',{name:'Sort by windows',exact:true}).click();assert.deepEqual(await faceOrder(),['1','2']);
 await page.getByRole('button',{name:'Sort by doors',exact:true}).click();assert.deepEqual(await faceOrder(),['1','2']);
 await page.getByRole('button',{name:'Sort by garage doors',exact:true}).click();assert.deepEqual(await faceOrder(),['1','2']);
 assert.equal(await page.locator('details').evaluate(e=>e.open),false);
 await page.getByLabel('Ask',{exact:true}).selectOption('each');await page.getByLabel('Model',{exact:true}).selectOption('gpt-6-astra');assert.equal(await page.getByLabel('Thinking').locator('option[value="none"]').evaluate(e=>e.disabled),true);
 await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>!ExteriorAIStickers.busy);await page.getByText('Finished',{exact:true}).waitFor();assert.equal(requests.length,3);assert.ok(requests.slice(1).every(r=>r.faceIds.length===1&&r.model==='gpt-6-astra'));assert.notEqual(requests[1].images[1],requests[2].images[1]);
 await setup();assert.equal(await page.getByLabel('History',{exact:true}).locator('option').count(),3);assert.equal(await page.getByRole('row',{name:'Select face 2',exact:true}).count(),1);assert.equal(await page.getByText('Finished',{exact:true}).count(),1);
 // Placement requests keep both query styles and persist their geometry application report.
 await page.getByLabel('Output',{exact:true}).selectOption('placements');await page.getByLabel('Ask',{exact:true}).selectOption('all');
 await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>!ExteriorAIStickers.busy);await page.getByText('Finished',{exact:true}).waitFor();
 assert.equal(requests.at(-1).output,'placements');assert.equal(requests.at(-1).faceHints.length,2);assert.ok(requests.at(-1).faceHints.every(f=>f.supported&&f.outline.length===4));
 assert.equal(await page.evaluate(()=>applied.length),1);assert.equal(await page.evaluate(()=>applied[0].faces.filter(f=>f.placementFrame).length),2);await page.getByText('2 stickers added · 0 skipped · Ctrl+Z to undo',{exact:true}).waitFor();
 await page.getByLabel('Ask',{exact:true}).selectOption('each');await page.getByRole('button',{name:'Run',exact:true}).click();await page.waitForFunction(()=>!ExteriorAIStickers.busy);await page.getByText('Finished',{exact:true}).waitFor();assert.ok(requests.slice(-2).every(r=>r.faceHints.length===1&&r.output==='placements'));assert.equal(await page.evaluate(()=>applied.length),2);
 await setup();assert.equal(await page.evaluate(()=>applied.length),0,'loading history does not apply again');await page.getByText('2 stickers added · 0 skipped · Ctrl+Z to undo',{exact:true}).waitFor();
 // Partial failures stay attached to their face, and invalid identity/count responses are rejected.
 await page.route('http://stickers.test/exterior_ai.php',async route=>{const d=route.request().postDataJSON();await route.fulfill(d.faceIds[0]===2?{status:502,json:{error:'Test upstream failure'}}:{json:{result:{faces:[{face:1,windows:3,doors:0,garageDoors:0,evidence:'Visible'}]}}});});
 await page.getByLabel('Ask',{exact:true}).selectOption('each');await page.getByRole('button',{name:'Run',exact:true}).click();await page.getByText('Finished with errors',{exact:true}).waitFor();
 assert.match(await page.getByRole('row',{name:'Select face 1',exact:true}).innerText(),/3/);assert.match(await page.getByRole('row',{name:'Select face 2',exact:true}).innerText(),/!/);
 assert.equal(await page.getByRole('alert').innerText(),'Test upstream failure');
 await page.getByRole('button',{name:'Sort by windows',exact:true}).click();assert.deepEqual(await faceOrder(),['1','2']);
 await page.getByRole('button',{name:'Sort by windows',exact:true}).click();assert.deepEqual(await faceOrder(),['1','2']);
 const invalid=await page.evaluate(()=>{let rejected=0;for(const rows of [[{face:8,windows:1,doors:0,garageDoors:0,evidence:'bad'}],[{face:1,windows:-1,doors:0,garageDoors:0,evidence:'bad'}],[]])try{ExteriorAIStickers.validateRows(rows,[1]);}catch{rejected++;}return rejected;});assert.equal(invalid,3);
 const rejectedBoxes=await page.evaluate(()=>{let n=0;for(const p of [{type:'window',x:95,y:0,width:20,height:10},{type:'window',x:0,y:0,width:0,height:20},{type:'roof',x:0,y:0,width:20,height:20}])try{ExteriorAIStickers.validateRows([{face:1,windows:1,doors:0,garageDoors:0,evidence:'test',placements:[p]}],[1],'placements');}catch{n++;}return n;});assert.equal(rejectedBoxes,3);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

