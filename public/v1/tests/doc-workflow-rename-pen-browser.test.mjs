import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-22: a line's name and description in the proposal's line items (rows, and Good/Better/Best compare columns)
// carry a pen that shows on hover. Clicking it opens the same editor a double-click opens, without choosing the
// option, and a read-only list has no pens.
const option=(id,name,description,selected)=>({id,name,description,quantity:'1',unit_price:0,selection:{mode:'choice',group_id:'roof',group_title:'Roof',selected},
 children:[{id:`${id}_line`,name:`${name} shingles`,quantity:'10',unit:'sq',unit_price:100}]});
const ITEMS=[{id:'scope',name:'Roof Replacement',description:'Complete sloped roof replacement.',quantity:'1',unit_price:0,
 children:[option('good','Good','A dependable roof.',false),option('best','Best','The thickest shingle.',true),{id:'vent',name:'Ridge Vent',description:'Vents the attic.',quantity:'40',unit:'ft',unit_price:5}]}];

async function mount(page,{compare=false,readonly=false}={}){
 await page.route('https://pen.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host"></div>'});
 });
 await page.goto('https://pen.test/');
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({ITEMS,compare,readonly})=>{
  window.__APP={userOrgId:'org'};window.writes=[];
  // The portal's modal stack closes the project window on Escape from document capture, unless already handled.
  window.windowClosed=0;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented)window.windowClosed+=1;},true);
  const workflow={schema_version:1,steps:[{id:'lines',title:'Lines',items:[{kind:'line_items_review',writes:'params.scope_items',generate:false,compare}]}]};
  FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience:'internal',readonly,state:{params:{scope_items:ITEMS}},scope:{project:{id:'p'}},onWrite:(path,value)=>writes.push({path,value}),services:{}});
 },{ITEMS,compare,readonly});
 await page.waitForSelector('[data-fmdw-rename]');
}
const pen=(page,id,which)=>page.locator(`[data-fmdw-lir="${id}"] [data-fmdw-rename="${which}"] [data-fmdw-rename-pen], [data-fmdw-rename-item="${id}"] [data-fmdw-rename="${which}"] [data-fmdw-rename-pen]`).first();
const opacity=locator=>locator.evaluate(node=>getComputedStyle(node).opacity);
// Waits out the fade-in.
const shown=locator=>locator.evaluate(node=>new Promise(done=>{const tick=()=>getComputedStyle(node).opacity==='1'?done(true):requestAnimationFrame(tick);tick();}));

test('every name and description has a pen that shows on hover and opens the editor',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page);
  // Group head, options and a plain line: one pen per name and per description.
  assert.equal(await page.locator('[data-fmdw-rename-pen]').count(),await page.locator('[data-fmdw-rename]').count());
  await page.mouse.move(0,0);
  assert.equal(await opacity(pen(page,'vent','name')),'0','hidden until hovered');
  await page.locator('[data-fmdw-lir="vent"]').hover();
  await shown(pen(page,'vent','name'));

  // The description's pen focuses the description; Done saves this estimate's text.
  await pen(page,'vent','description').click();
  const editor=page.locator('[data-fmdw-lir="vent"] .fmdw-lir-edit');
  await editor.waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-fmdw-edit-description]')),true);
  await editor.locator('[data-fmdw-edit-name]').fill('Ridge Vent Plus');
  await editor.locator('[data-fmdw-edit-done]').click();
  await page.waitForFunction(()=>/Ridge Vent Plus/.test(document.querySelector('[data-fmdw-lir="vent"] [data-fmdw-rename="name"]')?.textContent||''));
  assert.equal(await page.evaluate(()=>writes.filter(w=>w.path==='params.scope_items').at(-1).value[0].children[2].display_name),'Ridge Vent Plus');

  // The group head's name pen focuses the name; double-click still works too.
  await pen(page,'scope','name').click();
  await page.locator('[data-fmdw-rename-item="scope"] .fmdw-lir-edit').waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-fmdw-edit-name]')),true);
  await page.keyboard.press('Escape');
  // Escape cancels only the rename, never the project window around it.
  assert.equal(await page.locator('[data-fmdw-rename-item="scope"] .fmdw-lir-edit').count(),0);
  assert.equal(await page.evaluate(()=>windowClosed),0,'Escape reached the window');
  // Until its row is hovered, a name sits over its hidden description: hover first, as a person does.
  await page.locator('[data-fmdw-lir="vent"] .fmdw-lir-amount').hover();
  await shown(pen(page,'vent','name'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-fmdw-lir="vent"] .fmdw-lir-name-line')).transform==='none');
  await page.locator('[data-fmdw-lir="vent"] [data-fmdw-rename="name"]').dblclick();
  await page.locator('[data-fmdw-lir="vent"] .fmdw-lir-edit').waitFor();
 }finally{await browser.close();}
});

test('in Compare the pen edits an option without choosing it; a read-only list has no pens',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{compare:true});
  const good=page.locator('.fmdw-lir-col[data-fmdw-lir="good"]');
  await good.hover();
  await shown(pen(page,'good','name'));
  await pen(page,'good','name').click();
  await good.locator('.fmdw-lir-edit').waitFor();
  assert.equal(await good.locator('[data-fmdw-lir-choose]').isChecked(),false,'Good is not chosen by the pen');
  assert.equal(await page.locator('.fmdw-lir-col[data-fmdw-lir="best"] [data-fmdw-lir-choose]').isChecked(),true);
  await good.locator('[data-fmdw-edit-description]').fill('Our lowest price.');
  await good.locator('[data-fmdw-edit-done]').click();
  await page.waitForFunction(()=>/Our lowest price\./.test(document.querySelector('.fmdw-lir-col[data-fmdw-lir="good"] .fmdw-lir-desc')?.textContent||''));

  const locked=await browser.newPage();await mount(locked,{readonly:true});
  assert.equal(await locked.locator('[data-fmdw-rename-pen]').count(),0);
 }finally{await browser.close();}
});
