const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('overlay alignment persists per image centrally and restores after reload',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
  const records=new Map(),script=fs.readFileSync('public/measure/internal/editor_scripts/resource_3d_overlay.js','utf8'),css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8');let png;
  const html=`<div id="three-container" style="position:relative;width:800px;height:650px"></div><style>${css}</style><script>window.currentProjectId='fixture';</script><script>${script}</script>`;
  async function context(){const ctx=await browser.newContext();await ctx.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.pathname.endsWith('project_resources.php')){const name=url.searchParams.get('name');if(req.method()==='POST'){records.set(name,JSON.parse(req.postData()));return route.fulfill({json:{ok:true}});}if(name.endsWith('.png'))return route.fulfill({contentType:'image/png',body:png});return records.has(name)?route.fulfill({json:records.get(name)}):route.fulfill({status:404,json:{error:'Missing'}});}return route.fulfill({contentType:'text/html',body:html});});return ctx;}
  const ctx=await context(),page=await ctx.newPage();await page.goto('https://overlay.test/editor');
  png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=400;c.height=200;return c.toDataURL().split(',')[1];}),'base64');
  const show=name=>page.evaluate(async name=>{const c=document.createElement('canvas');c.width=400;c.height=200;await Resource3DOverlay.show({image:c,label:name,project:'fixture',name});},name);
  const a='internal-resource-a.png',b='internal-resource-b.png';await show(a);
  await page.locator('[data-photo="right"]').click();await page.getByRole('slider',{name:'Photo rotation'}).fill('3.2');await page.getByRole('slider',{name:'Photo size'}).fill('140');await page.getByRole('slider',{name:'Photo opacity'}).fill('80');
  await show(b);assert.equal(await page.getByRole('slider',{name:'Photo rotation'}).inputValue(),'0');await page.getByRole('slider',{name:'Photo rotation'}).fill('-2.1');await show(a);
  const values=async p=>p.locator('.resource-3d-background img').evaluate(el=>({left:el.style.left,top:el.style.top,width:el.style.width,transform:el.style.transform,opacity:el.style.opacity}));const expected=await values(page);assert.match(expected.transform,/3.2deg/);assert.equal(expected.left,'410px');assert.equal(expected.opacity,'0.8');
  await new Promise(resolve=>setTimeout(resolve,350));
  await page.reload();await page.locator('#resource-3d-controls').waitFor({state:'visible'});assert.deepEqual(await values(page),expected);
  const other=await context(),fresh=await other.newPage();await fresh.goto('https://overlay.test/editor');await fresh.locator('#resource-3d-controls').waitFor({state:'visible'});assert.deepEqual(await values(fresh),expected,'restores from project storage in a fresh browser context');
  await show(b);assert.equal(await page.getByRole('slider',{name:'Photo rotation'}).inputValue(),'-2.1');
  await page.locator('[data-photo="remove"]').click();await new Promise(resolve=>setTimeout(resolve,100));await page.reload();await new Promise(resolve=>setTimeout(resolve,700));assert.equal(await page.locator('#resource-3d-controls').isVisible(),false);
  await other.close();await ctx.close();
 }finally{await browser.close();}
});
