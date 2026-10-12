const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('core views fill a three by three board and open photos without closing Files',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8'),script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8');
 const html=`<style>#google-earth-wrapper{position:relative;width:95vw;height:90vh}${css}</style><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>window.currentProjectId='fixture';window.WallMode={enabled:true};window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${script}</script>`;
 const file={name:'internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-front.png',original_name:'Front.png',elevation_view:'front',role:'customer'};
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.pathname.endsWith('project_resources.php'))return u.searchParams.has('name')?route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')}):route.fulfill({json:{files:[file,{...file,name:file.name.replace('front','back'),original_name:'Back.png',elevation_view:'back'}]}});if(u.searchParams.has('action'))return route.fulfill({json:{manifest:{}}});return route.fulfill({contentType:'text/html',body:html});});
 await page.goto('https://core.test/editor.php');await page.locator('.resource-core-grid').waitFor({state:'visible'});assert.equal(await page.locator('.resource-core-cell').count(),9);
 for(const width of [1200,700]){await page.setViewportSize({width,height:800});const cells=await page.locator('.resource-core-cell').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));assert.equal(cells[0].y,cells[2].y);assert.ok(cells[3].y>cells[0].y);assert.ok(Math.abs(cells[0].width-cells[2].width)<1);}
 await page.getByRole('button',{name:'Open Front view',exact:true}).click();await page.locator('#project-resources canvas').waitFor({state:'visible'});assert.ok(await page.locator('.resource-library').isVisible());
 assert.equal((await page.locator('.resource-library').boundingBox()).width,336);
 const tiles=await page.locator('.resource-media-tile').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));assert.equal(tiles.length,2);assert.equal(tiles[0].y,tiles[1].y);assert.ok(tiles[1].x>tiles[0].x);assert.ok(Math.abs(tiles[0].width-tiles[1].width)<1);
 assert.equal(await page.locator('.resource-thumbnail img').count(),2);
 await page.locator('[data-action="coreViews"]').click();assert.ok(await page.locator('.resource-core-grid').isVisible());assert.equal(await page.locator('#project-resources canvas').isVisible(),false);
 await page.reload();await page.locator('.resource-core-grid').waitFor({state:'visible'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('videos lead the edge-to-edge file list and play in the center of Core Views',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8'),css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8');
  const videos=['Walkthrough','Back yard'].map((title,i)=>({name:'internal-resource-video-'+i+'.webm',original_name:title+'.webm',role:i?'tech':'customer'}));
  const files=[{name:'internal-resource-front.png',original_name:'Front.png',elevation_view:'front',role:'qa',updated_at:'2099-01-01'},...videos];
  await page.route('**/*',route=>{const u=new URL(route.request().url()),name=u.searchParams.get('name');if(u.pathname.endsWith('project_resources.php')){
   if(name?.endsWith('.webm')){const bytes=fs.readFileSync('dev/fixtures/resources-landscape.webm'),range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;return route.fulfill({status:range?206:200,contentType:'video/webm',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length}:{})},body:bytes.subarray(start,end+1)});}
   if(name)return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});return route.fulfill({json:{files}});
  }if(u.searchParams.has('action'))return route.fulfill({json:{manifest:{}}});return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>#google-earth-wrapper{position:relative;width:95vw;height:90vh}${css}</style><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>window.currentProjectId='video-fixture';window.WallMode={enabled:true};window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${script}</script>`});});
  await page.goto('https://core-video.test/editor.php');await page.waitForFunction(()=>document.querySelector('.resource-core-video video')?.readyState>=2);
  assert.deepEqual(await page.locator('.resource-toolbar > button').evaluateAll(es=>es.slice(0,3).map(e=>e.dataset.action)),['files','upload','coreViews']);
  assert.equal(await page.locator('.resource-library .resource-tray-heading').count(),0);assert.equal(await page.locator('.resource-library [data-action=coreViews]').count(),0);
  assert.equal(await page.locator('.resource-section').first().getAttribute('data-role'),'videos');assert.equal(await page.locator('.resource-section[data-role=videos] .resource-media-tile').count(),2);
  const pane=await page.locator('.resource-library').boundingBox(),section=await page.locator('.resource-section').first().boundingBox();assert.equal(section.x,pane.x);assert.ok(Math.abs(section.width-(pane.width-1))<1);
  assert.equal(await page.locator('.resource-core-cell').count(),9);assert.equal(await page.locator('.resource-core-cell').nth(4).locator('video[controls]').count(),1);assert.equal(await page.locator('.resource-core-grid svg').count(),0);
  const video=page.locator('.resource-core-video video');await video.evaluate(v=>{v.currentTime=.2;return v.play();});await page.waitForFunction(()=>!document.querySelector('.resource-core-video video').paused);
  await page.locator('[data-action=files]').click();assert.equal(await page.locator('.resource-library').isVisible(),false);assert.equal(await page.locator('[data-action=coreViews]').getAttribute('aria-pressed'),'true');await page.locator('[data-action=files]').click();
  await page.getByRole('combobox',{name:'Core view video'}).selectOption(videos[1].name);await page.waitForFunction(()=>document.querySelector('.resource-core-video video')?.readyState>=2);assert.ok((await video.getAttribute('src')).includes('video-1.webm'));
  await video.evaluate(v=>{v.currentTime=.25;});await page.waitForFunction(()=>!document.querySelector('.resource-core-video video').seeking);await page.getByRole('button',{name:'Open video',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.resource-player video')?.readyState>=2);assert.ok(Math.abs(await page.locator('.resource-player video').evaluate(v=>v.currentTime)-.25)<.1);assert.equal(await page.locator('[data-action=coreViews]').getAttribute('aria-pressed'),'false');
  await page.locator('[data-action=coreViews]').click();await page.waitForFunction(()=>document.querySelector('.resource-core-video video')?.readyState>=2);await video.evaluate(v=>v.play());await page.evaluate(()=>{const b=document.createElement('button');b.textContent='Model';b.onclick=()=>switchMapLayer('model');document.querySelector('.map-view-tabs').append(b);});await page.getByRole('button',{name:'Model',exact:true}).click();assert.equal(await video.evaluate(v=>v.paused),true);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
