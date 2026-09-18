const {chromium}=require('../public/v1/node_modules/playwright-core');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://training.test/**',route=>{
   if(route.request().method()==='GET')return route.fulfill({contentType:'text/html',body:'<main id="editorModal"><h1>Practice projects</h1><div id="projEditorList"></div></main>'});
   const body=route.request().postDataJSON();
   return route.fulfill({json:{success:true,capability:{available:body.source==='ready',missing:body.source==='ready'?[]:['front','back','left','right']}}});
  });
  await page.goto('http://training.test/');
  await page.evaluate(()=>{window.Portal={cfg:{tutorials:{projects_enabled:true}},escapeHtml:s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')};});
  await page.addScriptTag({path:path.resolve('public/measure/internal/portal_scripts/tutorials.js')});
  await page.evaluate(()=>{
   Tutorials.currentEditorPage=0;Tutorials.curriculum={chapters:[{projects:[{project_id:'ready',name:'Ready source'},{project_id:'missing',name:'Roof source'}]}]};
   window.updateProject=(...args)=>Tutorials.updateProject(...args);
   Tutorials.ensureEditorCss();Tutorials.renderProjectList(0);
  });
  const exterior=page.locator('#proj-row-0').getByRole('checkbox',{name:'Full exteriors'}),roof=page.locator('#proj-row-1').getByRole('checkbox',{name:'Full exteriors'});
  await page.waitForFunction(()=>Tutorials.curriculum.chapters[0].projects[0].measurement_scope==='full_house');
  assert.equal(await exterior.isChecked(),true);assert.equal(await roof.isChecked(),false);assert.equal(await roof.isDisabled(),true);
  assert.equal(await page.locator('#proj-row-0 .tut-grade-switch input').isDisabled(),true);
  await exterior.uncheck();assert.equal(await page.evaluate(()=>Tutorials.curriculum.chapters[0].projects[0].measurement_scope),'roof');
  await page.evaluate(()=>Tutorials.renderProjectList(0));assert.equal(await exterior.isChecked(),false,'rerender preserves explicit roof override');
  await exterior.check();assert.equal(await exterior.isChecked(),true);
  await page.locator('#proj-row-1 input[placeholder="Real Project ID"]').fill('ready');await page.locator('#proj-row-1 input[placeholder="Real Project ID"]').blur();
  assert.equal(await roof.isChecked(),true,'changing source resets default even for a cached capability');
  const snapshot=await page.evaluate(()=>JSON.stringify(Tutorials.curriculum));
  await page.evaluate(s=>{Tutorials.curriculum=JSON.parse(s);Tutorials.renderProjectList(0);},snapshot);
  assert.equal(await exterior.isChecked(),true,'saved curriculum scope survives reload');
  assert.deepEqual(errors,[]);
  console.log('PASS: exterior defaults, unavailable data, toggle persistence, cached source replacement and ungraded UI');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
