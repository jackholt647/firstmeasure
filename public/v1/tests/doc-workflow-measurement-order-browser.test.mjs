import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-19: a proposal's measurements step offers "Order measurements" while the project has none and the host can
// order them (FirstMeasure, through the project's own order workflow in a dialog), and reads the project again
// once an order is placed. The host decides whether it can, for the keys the step asks for.
const FIELDS=[{key:'roofSquares',label:'Roof area',unit:'sq'},{key:'wastePercent',label:'Waste',unit:'%'},{key:'eavesLf',label:'Eaves',unit:'ft'}];

async function serve(page,childHtml=''){
 await page.route('https://order.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  if(url.searchParams.get('projectPane'))return route.fulfill({contentType:'text/html; charset=utf-8',body:childHtml});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host"></div>'});
 });
 await page.goto('https://order.test/');
}

async function mountStep(page,{canOrder=true,ordered=false,afterOrder=null,placed=true}={}){
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({FIELDS,canOrder,ordered,afterOrder,placed})=>{
  window.__APP={userOrgId:'org'};window.calls={canOrder:[],order:0,reads:0};
  let values={};
  const services={
   projectMeasurements:async()=>{calls.reads++;return {values,source:'the measurement report on this project'};},
   canOrderMeasurements:({keys})=>{calls.canOrder.push(keys);return canOrder;},
   orderMeasurements:async()=>{calls.order++;if(placed&&afterOrder)values=afterOrder;return placed;},
   measurementsOrdered:()=>ordered
  };
  const workflow={schema_version:1,steps:[{id:'roof',title:'Roof',items:[{kind:'measurements',writes:'params.measurements',prefill:'project.measurements',fields:FIELDS}]}]};
  FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience:'internal',state:{params:{}},scope:{project:{id:'project_a'}},onWrite:()=>{},services});
 },{FIELDS,canOrder,ordered,afterOrder,placed});
 await page.waitForFunction(()=>window.calls.reads>0&&!document.querySelector('.fmdw-meas-source .fa-spin'));
}
const status=page=>page.evaluate(()=>[...document.querySelectorAll('.fmdw-meas-source')].map(p=>p.textContent.trim()).join(' / '));

test('a project with no measurements offers the order, and the step fills in once one is placed',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await serve(page);
  await mountStep(page,{afterOrder:{roofSquares:24.5,eavesLf:130}});
  assert.equal(await page.locator('[data-fmdw-meas-order]').count(),1);
  assert.match(await status(page),/Order one, or enter the measurements by hand/);
  // The host is asked for the keys this step prices from.
  assert.deepEqual(await page.evaluate(()=>calls.canOrder.at(-1)),['roofSquares','wastePercent','eavesLf']);
  await page.locator('[data-fmdw-meas-order]').click();
  await page.waitForFunction(()=>document.querySelector('[data-fmdw-meas="roofSquares"]')?.value==='24.5');
  assert.equal(await page.locator('[data-fmdw-meas="eavesLf"]').inputValue(),'130');
  assert.equal(await page.evaluate(()=>calls.order),1);
  assert.equal(await page.locator('[data-fmdw-meas-order]').count(),0,'nothing left to order');
 }finally{await browser.close();}
});

test('an order still being measured says so; closing the dialog without one changes nothing',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await serve(page);
  await mountStep(page,{placed:false});
  await page.locator('[data-fmdw-meas-order]').click();
  await page.waitForFunction(()=>calls.order===1&&!document.querySelector('[data-fmdw-meas-order]:disabled'));
  assert.equal(await page.locator('[data-fmdw-meas-order]').count(),1,'still offered');
  assert.equal(await page.evaluate(()=>calls.reads),1,'not read again');

  const placed=await browser.newPage();await serve(placed);
  await mountStep(placed,{afterOrder:{}});
  await placed.locator('[data-fmdw-meas-order]').click();
  await placed.waitForFunction(()=>/Measurements ordered/.test(document.querySelector('.fmdw-meas-source')?.textContent||''));
  assert.equal(await placed.locator('[data-fmdw-meas-order]').count(),0);

  // Opened again later, a pending order is still "ordered", with nothing to order.
  const later=await browser.newPage();await serve(later);
  await mountStep(later,{canOrder:false,ordered:true});
  assert.match(await status(later),/Measurements ordered/);
  assert.equal(await later.locator('[data-fmdw-meas-order]').count(),0);
 }finally{await browser.close();}
});

test('a host that cannot order them offers nothing',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await serve(page);
  await mountStep(page,{canOrder:false});
  assert.equal(await page.locator('[data-fmdw-meas-order]').count(),0);
  assert.match(await status(page),/no measurement report yet\. Enter the measurements by hand/);
 }finally{await browser.close();}
});

test('the order dialog holds a pane of the same project opened in its report order workflow',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();
  // The pane's document: what project-request does in a pane, reduced to the bridge calls.
  await serve(page,`<script>
   const token=new URLSearchParams(location.search).get('projectPane');
   parent.FirstMateProjectLayout.ready(token,window,{openProject:async(project,options)=>{parent.opened={id:project.id,options};}});
   window.closeSelf=()=>parent.FirstMateProjectLayout.closed(token);
  </script>`);
  await page.addScriptTag({url:'/libraries/window-manager/project-layout.js'});
  await page.evaluate(()=>{
   window.events=[];
   window.pane=FirstMateProjectLayout.frame(document.getElementById('host'),{project:{id:'project_a'},tab:'map',options:{workflow:'report'},label:'Order measurements',loading:'Opening the order form…',
    onReady:child=>events.push('ready:'+(child.location.search.includes('projectPane')?'pane':'other')),onClosed:()=>events.push('closed')});
  });
  await page.waitForFunction(()=>window.opened);
  assert.deepEqual(await page.evaluate(()=>opened),{id:'project_a',options:{workflow:'report',tab:'map',fromRoute:false}});
  assert.equal(await page.locator('iframe[aria-label="Order measurements"]').count(),1);
  await page.waitForFunction(()=>document.querySelector('.r-project-pane-status')?.hidden);
  // Closing itself (its own close or Escape) takes the pane away and tells the dialog.
  await page.frames().find(frame=>frame.url().includes('projectPane')).evaluate(()=>{setTimeout(closeSelf,0);});
  await page.waitForFunction(()=>events.includes('closed'));
  assert.deepEqual(await page.evaluate(()=>events),['ready:pane','closed']);
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.evaluate(()=>FirstMateProjectLayout.accepts('x',window)),false);
 }finally{await browser.close();}
});
