const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('finish palette reuses custom and project colors without changing material, and persists per project',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:1100}});
  await page.route('http://palette.test/**',route=>route.fulfill({contentType:'text/html',body:'<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:1000px"></div></body>'}));
  const mount=async()=>{await page.goto('http://palette.test');await page.addScriptTag({path:'public/measure/internal/editor_scripts/wall_features.js'});await page.evaluate(()=>{
   window.currentProjectId='one';window.applied=[];window.scans=0;window.material='siding';window.projectColors=['#123ABC','#123abc','#556677','bad'];
   WallFeatures.mountUI(()=>{},()=>null,()=>false,{projectColors:()=>{scans++;return projectColors;},color:c=>applied.push(c),paint:m=>{material=m;},defaults:()=>({material:'siding',color:'#80868b',trimColor:'#f5f3ef'})});
  });await page.getByRole('button',{name:'Wall materials',exact:true}).click();};
  await mount();
  const common=page.getByRole('group',{name:'Common colors'}),project=page.getByRole('group',{name:'Project colors'}),recent=page.getByRole('group',{name:'Recent colors'});
  assert.equal(await common.locator('[data-color]').count(),6);assert.equal(await project.locator('[data-color]').count(),2);
  assert.deepEqual(await common.locator('[data-color]').allTextContents(),['','','','','','']);
  await page.getByLabel('Finish color',{exact:true}).fill('#a17b93');
  await recent.getByRole('button',{name:'Use color #a17b93',exact:true}).click();
  await project.getByRole('button',{name:'Use color #123abc',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>applied),['#a17b93','#a17b93','#123abc']);assert.equal(await page.evaluate(()=>material),'siding');
  assert.deepEqual(await recent.locator('[data-color]').evaluateAll(bs=>bs.map(b=>b.dataset.color)),['#123abc','#a17b93']);
  assert.equal(await page.getByLabel('Finish color',{exact:true}).inputValue(),'#123abc');
  await common.getByRole('button',{name:'Use default finish color'}).click();assert.equal(await page.evaluate(()=>applied.at(-1)),'default');
  const before=await page.evaluate(()=>scans);await page.evaluate(()=>{for(let i=0;i<50;i++)WallFeatures.refreshUI();});assert.equal(await page.evaluate(()=>scans),before,'frame refresh must not scan geometry');
  await mount();assert.deepEqual(await recent.locator('[data-color]').evaluateAll(bs=>bs.map(b=>b.dataset.color)),['#123abc','#a17b93']);
  await page.getByRole('button',{name:'Close wall materials'}).click();await page.evaluate(()=>{currentProjectId='two';projectColors=['#778899'];});await page.getByRole('button',{name:'Wall materials',exact:true}).click();
  assert.equal(await recent.locator('[data-color]').count(),0);assert.deepEqual(await project.locator('[data-color]').evaluateAll(bs=>bs.map(b=>b.dataset.color)),['#778899']);
  await page.getByLabel('Default color',{exact:true}).fill('#bbccee');assert.equal(await recent.getByRole('button',{name:'Use color #bbccee'}).count(),1);
 }finally{await browser.close();}
});
