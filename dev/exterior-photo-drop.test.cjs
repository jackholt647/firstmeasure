const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('order page accepts photos outside the bank and blocks drops while locked',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium')});
 try{
  const page=await browser.newPage();await page.route('https://order.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>New exterior project</h1><div id="order-references"></div>'}));await page.goto('https://order.test/');
  await page.addScriptTag({path:'public/measure/internal/portal_scripts/full_house_references.js'});
  const drop=name=>page.evaluate(name=>{const dt=new DataTransfer();dt.items.add(new File(['photo'],name,{type:'image/png'}));const e=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt});document.querySelector('h1').dispatchEvent(e);return e.defaultPrevented;},name);
  assert.equal(await drop('front.png'),true);assert.equal(await page.locator('.reference-card').count(),1);
  await page.evaluate(()=>FullHouseReferences.lock(true));assert.equal(await drop('back.png'),true);assert.equal(await page.locator('.reference-card').count(),1);
  assert.match(await page.locator('.reference-error').textContent(),/wait/);
  await page.evaluate(()=>FullHouseReferences.lock(false));await drop('back.png');assert.equal(await page.locator('.reference-card').count(),2);
 }finally{await browser.close();}
});
test('external file drops upload from the model and preserve ordinary drags',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium')});
 try{
  const page=await browser.newPage(),uploads=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  const script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8');
  const html=`<div id="google-earth-wrapper"><div class="map-view-tabs"></div><div id="model">Model</div></div><script>window.currentProjectId='first';window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${script}</script>`;
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.pathname.endsWith('project_resources.php')){
    if(req.method()==='POST'){const bytes=req.postDataBuffer();uploads.push({url:u,bytes});return route.fulfill({json:{ok:true,sha256:createHash('sha256').update(bytes).digest('hex')}});}
    return route.fulfill({json:{files:[]}});
   }
   if(u.searchParams.has('action'))return route.fulfill({json:{manifest:{}}});
   if(u.pathname.endsWith('.css'))return route.fulfill({body:''});
   return route.fulfill({contentType:'text/html',body:html});
  });
  await page.goto('https://drop.test/editor.php');
  const drop=()=>page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(new File(['photo'],'front.png',{type:'image/png'}));const target=document.querySelector('#model');target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));const hint=!document.querySelector('.resource-page-drop').hidden;const e=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt});target.dispatchEvent(e);return {hint,prevented:e.defaultPrevented};});
  assert.deepEqual(await drop(),{hint:true,prevented:true});
  await page.waitForFunction(()=>document.querySelector('#project-resources').textContent.includes('1 file(s) saved'));
  assert.equal(await page.locator('#project-resources').isVisible(),true);
  assert.equal(uploads.length,2,'one chunk and one published index');
  assert.ok(uploads.every(u=>[...u.url.searchParams.values()].includes('first')));
  assert.equal(await page.locator('.resource-page-drop').isVisible(),false);
  assert.equal(await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','internal');const e=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt});document.querySelector('#model').dispatchEvent(e);return e.defaultPrevented;}),false);
  await page.evaluate(()=>window.currentProjectId='second');await drop();
  await page.waitForFunction(()=>document.querySelector('#project-resources').textContent.includes('1 file(s) saved'));
  assert.equal(uploads.length,4);assert.ok(uploads.slice(2).every(u=>[...u.url.searchParams.values()].includes('second')));
  await page.evaluate(()=>window.currentProjectId='');await drop();
  await page.waitForFunction(()=>document.querySelector('#project-resources').textContent.includes('Open a saved project before uploading.'));
  assert.equal(uploads.length,4);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
