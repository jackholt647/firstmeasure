const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.FIRSTMEASURE_PLAYWRIGHT_MODULE||'../public/v1/node_modules/playwright-core');
const chromiumPath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&fs.existsSync(p))||null;
// FM-344: a customer's photos come from the order's reference catalog, not stored uploads. They are overlaid
// behind the model like the tech's own photos, keep their alignment and come back after a reload.
test('customer reference photos can be overlaid and their alignment persists',{skip:!chromiumPath&&'no Chromium on this host'},async()=>{
 const browser=await chromium.launch({headless:true,executablePath:chromiumPath,args:['--no-sandbox']});
 try{
  const read=f=>fs.readFileSync('public/measure/internal/editor_scripts/'+f,'utf8'),records=new Map(),errors=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const manifest={elevation_photos:{'front-left':{url:'customer-reference-0.jpg',original_name:'Structure 1 · front-left'}},resubmissions:[{images:['/uploads/fixture/side.png']}]};
  const html=`<style>#google-earth-wrapper{position:relative;width:1200px;height:700px}${read('project_resources.css')}</style><div id="three-container" style="position:relative;width:800px;height:650px"></div><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>window.currentProjectId='fixture';window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${read('resource_3d_overlay.js')}</script><script>${read('project_resources.js')}</script>`;
  const ctx=await browser.newContext({viewport:{width:1300,height:800}});
  await ctx.route('**/*',route=>{const req=route.request(),u=new URL(req.url()),name=u.searchParams.get('name');
   if(u.pathname.endsWith('project_resources.php')){if(req.method()==='POST'){if(name?.startsWith('internal-markup-overlay-'))records.set(name,JSON.parse(req.postData()));return route.fulfill({json:{ok:true}});}if(!name)return route.fulfill({json:{files:[]}});return records.has(name)?route.fulfill({json:records.get(name)}):route.fulfill({status:404,json:{error:'Missing'}});}
   if(/\.(jpe?g|png)$/.test(u.pathname))return route.fulfill({contentType:'image/png',body:png});
   if(u.searchParams.get('action')==='project_feedback')return route.fulfill({json:{manifest}});
   return route.fulfill({contentType:'text/html',body:html});});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://reference-overlay.test/editor.php');await page.locator('#tabResources').click();
  const customer=page.locator('.resource-section[data-role=customer]');await customer.locator('.resource-file-card').nth(1).waitFor();
  assert.equal(await customer.locator('.resource-overlay-shortcut').count(),2,'every customer photo offers the overlay shortcut');
  await customer.locator('.resource-overlay-shortcut').first().click();await page.locator('#resource-3d-controls').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>Resource3DOverlay.imageName),'customer-reference-0.jpg');
  await page.waitForFunction(()=>document.querySelector('.resource-section[data-role=customer] .resource-overlay-shortcut')?.getAttribute('aria-pressed')==='true');
  await page.locator('[data-photo="right"]').click();await page.getByRole('slider',{name:'Photo rotation'}).fill('2.5');
  // The toolbar's Overlay button is enabled for an open customer photo too.
  await customer.locator('.resource-file-card').nth(1).locator('button').first().click();await page.locator('#project-resources canvas').waitFor({state:'visible'});
  const toolbar=page.locator('[data-action="overlay"]');await page.waitForFunction(()=>!document.querySelector('[data-action="overlay"]').disabled);
  await toolbar.click();await page.waitForFunction(()=>Resource3DOverlay.imageName==='reference-resubmission-0-0');
  assert.equal(await page.getByRole('slider',{name:'Photo rotation'}).inputValue(),'0');
  await customer.locator('.resource-overlay-shortcut').first().click();await page.waitForFunction(()=>Resource3DOverlay.imageName==='customer-reference-0.jpg');
  assert.equal(await page.getByRole('slider',{name:'Photo rotation'}).inputValue(),'2.5','alignment is kept per reference photo');
  await new Promise(resolve=>setTimeout(resolve,400));
  const active=[...records.values()].find(r=>'name' in r);assert.equal(active.name,'customer-reference-0.jpg');assert.equal(active.src,'https://reference-overlay.test/projects/fixture/artifacts/customer-reference-0.jpg');
  // A fresh load restores the reference overlay from its own URL; there is no stored file for it.
  await page.evaluate(()=>localStorage.clear());await page.reload();await page.locator('#resource-3d-controls').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>Resource3DOverlay.imageName),'customer-reference-0.jpg');
  assert.equal(await page.getByRole('slider',{name:'Photo rotation'}).inputValue(),'2.5');
  assert.equal(await page.locator('.resource-3d-background img').evaluate(el=>el.style.left),'410px');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('a cross-site photo without CORS is shown from its own URL',{skip:!chromiumPath&&'no Chromium on this host'},async()=>{
 const browser=await chromium.launch({headless:true,executablePath:chromiumPath,args:['--no-sandbox']});
 try{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),script=fs.readFileSync('public/measure/internal/editor_scripts/resource_3d_overlay.js','utf8');
  const page=await browser.newPage();
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname==='photos.other.test')return route.fulfill({contentType:'image/png',body:png});if(u.pathname.endsWith('project_resources.php'))return route.fulfill(route.request().method()==='POST'?{json:{ok:true}}:{status:404,json:{}});return route.fulfill({contentType:'text/html',body:`<div id="three-container" style="position:relative;width:800px;height:650px"></div><script>window.currentProjectId='fixture';</script><script>${script}</script>`});});
  await page.goto('https://overlay.test/editor');
  const src=await page.evaluate(async()=>{const img=new Image();img.src='https://photos.other.test/front.png';await img.decode();await Resource3DOverlay.show({image:img,label:'Front',project:'fixture',name:'reference-elevations-0',src:img.src});return document.querySelector('.resource-3d-background img').src;});
  assert.equal(src,'https://photos.other.test/front.png');
  assert.equal(await page.locator('#resource-3d-controls').isVisible(),true);
 }finally{await browser.close();}
});
