const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('default finishes stay visible and custom texture choices preserve colors',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:900px"></div></body>');
 await page.addScriptTag({path:'public/measure/internal/editor_scripts/wall_features.js'});
 await page.evaluate(()=>{window.defaults={material:'siding',color:'#123456',trimColor:'#abcdef'};WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:value=>value?(window.defaults=value):window.defaults});});
 await page.getByRole('button',{name:'Wall materials',exact:true}).click();assert.equal(await page.getByLabel('Default color',{exact:true}).isVisible(),true);assert.equal(await page.locator('#wall-material-picker details').count(),0);assert.equal(await page.locator('#wall-material-picker select').count(),0);
 await page.getByRole('button',{name:'Default texture',exact:true}).click();await page.getByRole('menuitemradio',{name:'Brick',exact:true}).click();assert.deepEqual(await page.evaluate(()=>defaults),{material:'brick',color:'#123456',trimColor:'#abcdef'});assert.equal(await page.getByRole('button',{name:'Default texture',exact:true}).getAttribute('aria-expanded'),'false');
 await page.getByLabel('Default color',{exact:true}).fill('#998877');assert.equal(await page.evaluate(()=>defaults.color),'#998877');
 await page.getByRole('button',{name:'Default texture',exact:true}).click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>defaults.material),'masonry');
 await page.getByRole('button',{name:'Default texture',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('region',{name:'Wall materials',exact:true}).isVisible(),true);assert.equal(await page.getByRole('button',{name:'Default texture',exact:true}).getAttribute('aria-expanded'),'false');
 }finally{await browser.close();}
});
