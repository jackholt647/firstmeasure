import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-25: in Compare the chosen Good/Better/Best column is a little wider and edited in place (a line's name and price,
// a line added by name and price or from the price book with the + at its bottom, a line taken off); hovering a line
// marks the same line in every column; the first compare view asks for the line items tour once.
const option=(id,name,selected,lines)=>({id,name,quantity:'1',unit_price:0,selection:{mode:'choice',group_id:'roof',group_title:'Roof',selected},children:lines});
const ITEMS=[{id:'scope',name:'Roof Replacement',quantity:'1',unit_price:0,children:[
 option('good','Good',false,[{id:'good_sh',name:'Basic shingles',quantity:'10',unit:'sq',unit_price:100},{id:'good_tear',name:'Remove Existing Roofing',quantity:'1',unit_price:1700,pricebook_ref:{item_id:'pb_tear'}}]),
 option('best','Best',true,[{id:'best_sh',name:'Premium shingles',quantity:'10',unit:'sq',unit_price:150},{id:'best_tear',name:'Remove Existing Roofing',quantity:'1',unit_price:1700,pricebook_ref:{item_id:'pb_tear'}}])]}];

async function mount(page,{readonly=false}={}){
 await page.route('https://cmp.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host" style="width:1100px"></div>'});
 });
 await page.goto('https://cmp.test/');
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({ITEMS,readonly})=>{
  window.__APP={userOrgId:'org'};window.writes=[];window.tours=[];
  window.FirstMateGuides={play:(id,options)=>{tours.push({id,over:!!options?.over,showing:options?.showing?.()});return Promise.resolve({status:'completed'});}};
  window.FirstMatePricebook={loadState:async()=>null,getState:()=>({items:[{id:'pb_vent',name:'Ridge Vent Pro',unit:'ft',unit_price:7},{id:'pb_ice',name:'Ice & Water Shield',unit:'roll',unit_price:78}]}),
   scopeItemFromPricebook:(id,measurements)=>id==='pb_vent'?{id:'made_vent',name:'Ridge Vent Pro',unit:'ft',quantity:String(measurements.ridge_ft),unit_price:7,pricebook_ref:{item_id:'pb_vent'},selection:{mode:'always',selected:true}}:null};
  const workflow={schema_version:1,steps:[{id:'lines',title:'Lines',items:[{kind:'line_items_review',writes:'params.scope_items',generate:false,compare:true}]}]};
  FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience:'internal',readonly,state:{params:{scope_items:ITEMS,measurements:{ridge_ft:40}}},scope:{project:{id:'p'}},onWrite:(path,value)=>writes.push({path,value}),services:{}});
 },{ITEMS,readonly});
 await page.waitForSelector('.fmdw-lir-compare');
}
const last=page=>page.evaluate(()=>writes.filter(w=>w.path==='params.scope_items').at(-1).value[0]);
const lineOf=(scope,optionId,lineId)=>scope.children.find(o=>o.id===optionId).children.find(l=>l.id===lineId);
const width=locator=>locator.evaluate(node=>node.getBoundingClientRect().width);
const settled=page=>page.waitForFunction(()=>{const cols=[...document.querySelectorAll('.fmdw-lir-col')];return cols.length&&getComputedStyle(cols[0].parentElement).gridTemplateColumns.split(' ').every(Boolean)&&!cols[0].getAnimations({subtree:false}).length;}).then(()=>page.waitForTimeout(350));

test('the chosen column is wider and edited in place; hover marks the same line in every column',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page);
  const good=page.locator('.fmdw-lir-col[data-fmdw-lir="good"]'),best=page.locator('.fmdw-lir-col[data-fmdw-lir="best"]');
  assert.ok(await width(best)>await width(good)*1.2,'Best (chosen) is wider');
  assert.equal(await good.locator('input[data-fmdw-cmp-name], [data-fmdw-cmp-add-open]').count(),0,'Good is read as it is');
  assert.equal(await best.locator('input[data-fmdw-cmp-name]').count(),2);

  // The same price book line is marked in both columns; a line only one option has is marked alone.
  await best.locator('[data-fmdw-cmp-line="best_tear"]').hover();
  assert.deepEqual(await page.locator('li.hover').evaluateAll(nodes=>nodes.map(n=>n.dataset.fmdwCmpLine).sort()),['best_tear','good_tear']);
  await good.locator('[data-fmdw-cmp-line="good_sh"]').hover();
  assert.deepEqual(await page.locator('li.hover').evaluateAll(nodes=>nodes.map(n=>n.dataset.fmdwCmpLine)),['good_sh']);

  // A name is this estimate's name; a price is the line's amount, its quantity kept.
  await best.locator('[data-fmdw-cmp-line="best_sh"] [data-fmdw-cmp-name]').fill('GAF Timberline UHDZ');
  await best.locator('[data-fmdw-cmp-line="best_sh"] [data-fmdw-cmp-name]').press('Enter');
  assert.equal(lineOf(await last(page),'best','best_sh').display_name,'GAF Timberline UHDZ');
  await best.locator('[data-fmdw-cmp-line="best_sh"] [data-fmdw-cmp-price]').fill('$1,800');
  await best.locator('[data-fmdw-cmp-line="best_sh"] [data-fmdw-cmp-price]').press('Enter');
  const priced=lineOf(await last(page),'best','best_sh');
  assert.equal(priced.quantity,'10');assert.equal(priced.unit_price,180);
  assert.equal(await best.locator('[data-fmdw-cmp-line="best_sh"] [data-fmdw-cmp-price]').inputValue(),'1,800.00');
  assert.equal(await best.locator('[data-fmdw-lir-amount="best"]').textContent(),'$3,500.00');
  assert.equal(await page.locator('[data-fmdw-lir-total]').textContent(),'$3,500.00');

  // + : a typed name and price is a line; the row opens again for the next one.
  await best.locator('[data-fmdw-cmp-add-open]').click();
  await best.locator('[data-fmdw-cmp-add-name]').fill('Gutter guard');
  await best.locator('[data-fmdw-cmp-add-price]').fill('300');
  await best.locator('[data-fmdw-cmp-add-price]').press('Enter');
  let scope=await last(page);
  const typed=scope.children.find(o=>o.id==='best').children.at(-1);
  assert.equal(typed.name,'Gutter guard');assert.equal(typed.unit_price,300);
  await page.waitForFunction(()=>document.activeElement?.matches('[data-fmdw-cmp-add-name]'));

  // ... or a price book item, sized from the measurements.
  await best.locator('[data-fmdw-cmp-add-name]').fill('vent');
  await best.locator('[data-fmdw-cmp-pick="0"]').waitFor();
  assert.match(await best.locator('[data-fmdw-cmp-suggest]').textContent(),/Ridge Vent Pro/);
  await best.locator('[data-fmdw-cmp-add-name]').press('Enter');
  scope=await last(page);
  const fromBook=scope.children.find(o=>o.id==='best').children.at(-1);
  assert.equal(fromBook.pricebook_ref.item_id,'pb_vent');assert.equal(fromBook.quantity,'40');
  assert.equal(await best.locator('[data-fmdw-lir-amount="best"]').textContent(),'$4,080.00');
  await page.keyboard.press('Escape');
  await best.locator('[data-fmdw-cmp-add-open]').waitFor();

  // Taking a line off.
  await best.locator('[data-fmdw-cmp-line="best_tear"]').hover();
  await best.locator('[data-fmdw-cmp-line="best_tear"] [data-fmdw-cmp-remove]').click();
  assert.equal((await last(page)).children.find(o=>o.id==='best').children.some(l=>l.id==='best_tear'),false);

  // Choosing Good makes it the wide, editable one.
  await good.locator('.fmdw-lir-col-total').click();
  await settled(page);
  assert.ok(await width(good)>await width(best)*1.2,'Good (chosen) is wider');
  assert.equal(await good.locator('input[data-fmdw-cmp-name]').count(),2);
  assert.equal(await best.locator('input[data-fmdw-cmp-name]').count(),0);

  // The line items tour was asked for once, over a setup if one plays.
  await page.waitForFunction(()=>tours.length>0);
  assert.deepEqual(await page.evaluate(()=>tours),[{id:'documents.compare_tutorial',over:true,showing:true}]);
 }finally{await browser.close();}
});

test('a read-only compare view has nothing to edit and asks for no tour',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{readonly:true});
  assert.equal(await page.locator('[data-fmdw-cmp-name], [data-fmdw-cmp-price], [data-fmdw-cmp-add-open], [data-fmdw-cmp-remove]').count(),0);
  await page.waitForTimeout(900);
  assert.deepEqual(await page.evaluate(()=>tours),[]);
 }finally{await browser.close();}
});
