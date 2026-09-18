const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('core views fill a three by three board and open photos without closing Files',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8'),script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8');
 const html=`<style>#google-earth-wrapper{position:relative;width:95vw;height:90vh}${css}</style><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>window.currentProjectId='fixture';window.WallMode={enabled:true};window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${script}</script>`;
 const file={name:'internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-front.png',original_name:'Front.png',elevation_view:'front',role:'customer'};
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.pathname.endsWith('project_resources.php'))return u.searchParams.has('name')?route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')}):route.fulfill({json:{files:[file]}});if(u.searchParams.has('action'))return route.fulfill({json:{manifest:{}}});return route.fulfill({contentType:'text/html',body:html});});
 await page.goto('https://core.test/editor.php');await page.locator('.resource-core-grid').waitFor({state:'visible'});assert.equal(await page.locator('.resource-core-cell').count(),9);
 for(const width of [1200,700]){await page.setViewportSize({width,height:800});const cells=await page.locator('.resource-core-cell').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));assert.equal(cells[0].y,cells[2].y);assert.ok(cells[3].y>cells[0].y);assert.ok(Math.abs(cells[0].width-cells[2].width)<1);}
 await page.getByRole('button',{name:'Open Front view',exact:true}).click();await page.locator('#project-resources canvas').waitFor({state:'visible'});assert.ok(await page.locator('.resource-library').isVisible());
 await page.locator('[data-action="coreViews"]').click();assert.ok(await page.locator('.resource-core-grid').isVisible());assert.equal(await page.locator('#project-resources canvas').isVisible(),false);
 await page.reload();await page.locator('.resource-core-grid').waitFor({state:'visible'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
