import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-104: a workflow of one step (the invoice) has no step list; the step and its preview share the page. A question
// shown or hidden by another answer on the step (`when`) appears in place, and a host with its own buttons
// (footer:false, the Finances invoice dialog) hides the runtime's footer and checks the step with handle.validate().
const ONE_STEP={schema_version:1,name:'Invoice',steps:[{id:'invoice',title:'Invoice',sections:[
 {id:'bill',title:'What to bill',items:[{kind:'text',writes:'params.bill',label:'Bill',required:true}]},
 {id:'details',title:'Details',items:[
  {kind:'date',writes:'params.issue_date',label:'Issued'},
  {kind:'boolean',writes:'params.tax_enabled',label:'Sales tax'},
  {kind:'percent',writes:'params.tax_percent',label:'Tax %',when:'params.tax_enabled != false'},
  {kind:'boolean',writes:'params.render_paid_in_full',label:'Paid in full'}]}]}]};
const TWO_STEPS={schema_version:1,steps:[{id:'one',title:'One',items:[{kind:'text',writes:'params.a',label:'A'}]},{id:'two',title:'Two',items:[{kind:'text',writes:'params.b',label:'B'}]}]};

async function mount(page,{workflow=ONE_STEP,width=1200,params={},options={}}={}){
 await page.setViewportSize({width,height:800});
 await page.route('https://single.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host" style="height:700px;display:flex"></div>'});
 });
 await page.goto('https://single.test/');
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({workflow,params,options})=>{
  window.writes=[];
  window.handle=FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience:'internal',state:{params},scope:{},
   onWrite:(path,value)=>window.writes.push([path,value]),preview:{resolve:async()=>({}),...(options.pinned?{pinned:true,collapsible:true}:{})},
   footer:options.footer});
 },{workflow,params,options});
 await page.waitForSelector('[data-fmdw-root]');
}
const box=(page,selector)=>page.locator(selector).first().boundingBox();

test('one step: no step list, the step beside its preview; several steps keep the list',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page);
  assert.equal(await page.locator('.fmdw.single-step').count(),1);
  assert.equal(await page.locator('.fmdw-rail').isVisible(),false,'no column of steps');
  const main=await box(page,'.fmdw-main');const preview=await box(page,'[data-fmdw-preview]');const frame=await box(page,'[data-fmdw-root]');
  assert.ok(Math.abs(main.x-frame.x)<2,'the step starts at the left edge');
  assert.ok(preview.x>main.x+main.width-8,'the preview is on the right');

  const several=await browser.newPage();await mount(several,{workflow:TWO_STEPS});
  assert.equal(await several.locator('.fmdw.single-step').count(),0);
  assert.equal(await several.locator('.fmdw-rail').isVisible(),true);

  // Stacked (a narrow host): one column, the questions above the pinned preview's bar.
  const narrow=await browser.newPage();await mount(narrow,{width:600,options:{pinned:true}});
  await narrow.waitForSelector('.fmdw.narrow.single-step');
  const stacked=await box(narrow,'.fmdw-main');const root=await box(narrow,'[data-fmdw-root]');
  assert.ok(Math.abs(stacked.width-root.width)<2,'the step takes the whole width');
  const bar=await box(narrow,'[data-fmdw-preview-head]');
  assert.ok(bar.y>=stacked.y+stacked.height-2,'the preview sits under the step');
 }finally{await browser.close();}
});

test('an answer that hides a question redraws the step in place; footer:false leaves finishing to the host',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{params:{tax_enabled:true,tax_percent:8},options:{footer:false}});
  assert.equal(await page.locator('.fmdw-foot').isVisible(),false,'the host has its own buttons');
  assert.equal(await page.locator('.fmdw-percent input').inputValue(),'8');
  await page.locator('.fmdw-toggle-row',{hasText:'Sales tax'}).locator('[data-fmdw-toggle]').click();
  await page.waitForFunction(()=>!document.querySelector('.fmdw-percent'));
  assert.deepEqual(await page.evaluate(()=>writes.at(-1)),['params.tax_enabled',false]);
  await page.locator('.fmdw-toggle-row',{hasText:'Sales tax'}).locator('[data-fmdw-toggle]').click();
  await page.waitForSelector('.fmdw-percent input');
  await page.fill('.fmdw-percent input','150');await page.locator('.fmdw-percent input').blur();
  assert.deepEqual(await page.evaluate(()=>writes.at(-1)),['params.tax_percent',100],'a percentage is at most 100');

  assert.equal(await page.evaluate(()=>handle.validate()),false,'what to bill is required');
  assert.equal(await page.locator('.fmdw-item.invalid').count(),1);
  await page.fill('input[type=text][data-fmdw-control]','Final payment');await page.locator('input[type=text][data-fmdw-control]').blur();
  assert.equal(await page.evaluate(()=>handle.validate()),true);
 }finally{await browser.close();}
});
