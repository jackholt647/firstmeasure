const test=require('node:test'),assert=require('node:assert/strict');
const SCRIPTS='public/measure/internal/editor_scripts/';
test('Wall materials: slim header, collapsible remembered sections, no disclaimers, one face colour row',async t=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1366,height:768}});
 await page.route('http://picker.test/**',route=>route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:620px;width:900px"></div></body>'}));
 const mount=async()=>{await page.goto('http://picker.test/');await page.addScriptTag({content:'window.THREE={}'});for(const name of ['wall_features','exterior_finishes'])await page.addScriptTag({path:SCRIPTS+name+'.js'});
  await page.evaluate(()=>{window.calls=[];let roof={...ExteriorFinishes.roofDefault},stickers={};WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:v=>v?(calls.push(['defaults',v]),v):{material:'brick',color:'#80868b',trimColor:'#f5f3ef'},roof:v=>v?(roof=v):roof,stickers:v=>{if(v)Object.assign(stickers,v);return ExteriorFinishes.stickerDefaults({stickers});},color:c=>calls.push(['color',c]),paint:m=>calls.push(['paint',m]),projectColors:()=>['#112233','#445566','#778899','#aabbcc','#ddeeff','#123123','#321321'],colors:()=>true});});
  await page.getByRole('button',{name:'Wall materials',exact:true}).click();};
 await page.goto('http://picker.test/');await page.evaluate(()=>localStorage.clear());await mount();
 const picker=page.locator('#wall-material-picker'),text=await picker.innerText();
 for(const gone of ['Applies to current and future faces','Color is independent of material','Shows in Textured mode and on the PDF cover','Windows are glass','Select a face to edit its finish','Common','Recent','In this project','WALL MATERIALS'])assert.ok(!text.includes(gone),'removed: '+gone);
 assert.equal(await picker.locator('[data-palette]').count(),1,'one colour row');assert.equal(await picker.locator('[aria-label="Recent colors"],[aria-label="Common colors"]').count(),0);
 const row=picker.getByRole('group',{name:'Project colors'});assert.equal(await row.locator('button').count(),7,'reset plus the six most used');
 await row.getByRole('button',{name:'Use default finish color'}).click();await row.getByRole('button',{name:'Use color #445566'}).click();await picker.getByRole('button',{name:'Brick',exact:true}).first().click();
 assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c[0]!=='defaults')),[['color','default'],['color','#445566'],['paint','brick']],'face colour and material still paint or apply');
 // Header on one row with the close button.
 const head=await picker.locator('.exterior-picker-heading').boundingBox(),close=await picker.getByRole('button',{name:'Close wall materials'}).boundingBox();assert.ok(head.height<=30&&close.y>=head.y&&close.y+close.height<=head.y+head.height+1,'slim header: '+head.height);
 // Sections: Faces and Walls open, Roof and Stickers collapsed by default; toggles are keyboard buttons and remembered.
 const toggles=['Faces','Wall defaults','Roof','Stickers'];for(const name of toggles)assert.ok(await page.getByRole('button',{name:new RegExp('^'+name)}).count(),name);
 const expanded=async()=>Promise.all(toggles.map(name=>page.getByRole('button',{name:new RegExp('^'+name)}).getAttribute('aria-expanded')));
 assert.deepEqual(await expanded(),['true','true','true','true'],'every section starts open');assert.equal(await page.getByLabel('Sticker trim',{exact:true}).isVisible(),true);
 // The plain-mode colour switch says what it does and lives with the wall defaults.
 const check=page.getByLabel('Show material colours in Opaque and Translucent',{exact:true});assert.equal(await check.isVisible(),true);assert.ok(await page.locator('[data-section="walls"]').locator('input[type=checkbox]').count());assert.match(await check.locator('xpath=..').getAttribute('title'),/Opaque and Translucent/);
 for(const name of ['Default texture','Default colour','Default trim'])assert.ok((await page.locator('[data-section="walls"]').innerText()).includes(name),name);
 await page.getByRole('button',{name:/^Roof/}).click();await page.getByRole('button',{name:/^Stickers/}).click();
 const fit=await picker.evaluate(p=>({scroll:p.scrollHeight,client:p.clientHeight}));assert.ok(fit.scroll<=fit.client+1,'fits without scrolling at 1366x768 with Roof and Stickers collapsed: '+JSON.stringify(fit));
 assert.equal(await page.getByLabel('Sticker trim',{exact:true}).isVisible(),false);await page.getByRole('button',{name:/^Stickers/}).focus();await page.keyboard.press('Enter');assert.equal(await page.getByLabel('Sticker trim',{exact:true}).isVisible(),true);
 await page.getByRole('button',{name:/^Faces/}).click();assert.equal(await picker.getByRole('button',{name:'Brick',exact:true}).first().isVisible(),false);
 assert.match(await page.getByRole('button',{name:/^Wall defaults/}).innerText(),/Brick/,'sections show a summary');
 await mount();assert.deepEqual(await expanded(),['false','true','false','true'],'open state is remembered');
 assert.equal(await page.getByLabel('Default color',{exact:true}).isVisible(),true);
});
