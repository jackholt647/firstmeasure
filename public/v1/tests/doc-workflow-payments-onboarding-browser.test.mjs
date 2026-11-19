import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-26: Payment terms says where a deposit due on signature is paid (the customer portal) and, while online payments
// are not set up, leads to setup: a pill on the deposit and, on this person's first payment terms (their tour not
// finished), a skippable callout. Review & send says in colour whether the proposal carries a pay link, with a quiet
// Set up payments. Both ask once for their tour. Hosts without the payments services (the customer) show none of it.
const SCHEDULE=[{label:'Deposit',percent:30,due_rule:'on_signature'},{label:'Final payment',percent:70,due_rule:'project_completion'}];

async function mount(page,{status,tourDone=false,audience='internal',services=true}={}){
 await page.route('https://pay.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host" style="width:900px;height:800px"></div>'});
 });
 await page.goto('https://pay.test/');
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({SCHEDULE,status,tourDone,audience,services})=>{
  window.__APP={userOrgId:'org'};window.tours=[];window.asks=[];window.setups=0;window.payStatus=status;
  window.FirstMateGuides={refresh:()=>Promise.resolve(true),
   experience:(id)=>({id,progress:tourDone?{status:'completed'}:null}),
   play:(id,options)=>{tours.push({id,over:!!options?.over,showing:options?.showing?.()});return Promise.resolve({status:'completed'});}};
  const workflow={schema_version:1,steps:[
   {id:'terms',title:'Payment terms',audience:['internal','customer'],items:[{kind:'payment_schedule',writes:'params.payment_schedule',label:'Payment schedule'}]},
   {id:'review',title:'Review & send',audience:['internal','customer'],items:[{kind:'review',label:'Before you send'}]}]};
  const host={
   paymentsStatus:(options={})=>{asks.push(options.fresh===true);return Promise.resolve(window.payStatus);},
   setUpPayments:()=>{setups+=1;window.payStatus={ready:true,reason:'',can_set_up:false};return Promise.resolve(true);}
  };
  FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience,state:{params:{scope_items:[{id:'roof',name:'Roof',quantity:'1',unit_price:10000}],payment_schedule:SCHEDULE}},scope:{project:{id:'p'}},onWrite:()=>{},services:services?host:{}});
 },{SCHEDULE,status,tourDone,audience,services});
 await page.waitForSelector('.fmdw-sched');
}
const NOT_SET_UP={ready:false,reason:'no_merchant_account',can_set_up:true};
const toReview=async(page)=>{await page.locator('[data-fmdw-continue]').click();await page.waitForSelector('[data-fmdw-review-pay]',{state:'attached'});};

test('first payment terms offer setup; the deposit says where it is paid; review says there is no pay link',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{status:NOT_SET_UP});
  await page.locator('[data-fmdw-pay-callout]').waitFor();
  assert.match(await page.locator('[data-fmdw-pay-callout]').textContent(),/Set up payments to automatically take a payment from your customer when you deliver your proposal/);
  // Only the payment due on signature is marked, with a Set up pill.
  assert.equal(await page.locator('[data-fmdw-sched-pay]').count(),1);
  assert.equal(await page.locator('[data-fmdw-sched-pay="setup"]').count(),1);
  assert.match(await page.locator('[data-fmdw-sched-pay]').textContent(),/customer portal/);
  assert.equal(await page.locator('[data-fmdw-sched-pay] [data-fmdw-pay-setup]').count(),1);
  // Skippable.
  await page.locator('[data-fmdw-pay-skip]').click();
  assert.equal(await page.locator('[data-fmdw-pay-callout]').count(),0);
  await page.waitForFunction(()=>tours.length>0);
  assert.deepEqual(await page.evaluate(()=>tours),[{id:'documents.payment_terms_tutorial',over:true,showing:true}]);

  // Review & send: amber, read-only, a quiet way into setup; its tour asked once.
  await toReview(page);
  await page.locator('[data-fmdw-pay-note="off"]').waitFor();
  assert.match(await page.locator('[data-fmdw-pay-note]').textContent(),/read-only, with no pay link/);
  assert.equal(await page.locator('[data-fmdw-pay-note] .fmdw-btn.ghost[data-fmdw-pay-setup]').count(),1);
  await page.waitForFunction(()=>tours.length>1);
  assert.equal((await page.evaluate(()=>tours))[1].id,'documents.review_send_tutorial');

  // Setting up from there asks again, fresh, and turns the note green.
  await page.locator('[data-fmdw-pay-note] [data-fmdw-pay-setup]').click();
  await page.locator('[data-fmdw-pay-note="ready"]').waitFor();
  assert.equal(await page.evaluate(()=>setups),1);
  assert.equal(await page.evaluate(()=>asks.at(-1)),true);
  assert.match(await page.locator('[data-fmdw-pay-note]').textContent(),/\$3,000\.00 deposit online in their customer portal/);
 }finally{await browser.close();}
});

test('after setup from the pill the deposit is paid online; ready payments show no setup',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{status:NOT_SET_UP});
  await page.locator('[data-fmdw-sched-pay] [data-fmdw-pay-setup]').click();
  await page.locator('[data-fmdw-sched-pay="ready"]').waitFor();
  assert.equal(await page.locator('[data-fmdw-pay-callout], [data-fmdw-pay-setup]').count(),0);
  await toReview(page);
  await page.locator('[data-fmdw-pay-note="ready"]').waitFor();
  assert.equal(await page.locator('[data-fmdw-pay-setup]').count(),0);
 }finally{await browser.close();}
});

test('the callout is for the first time only; the deposit pill stays',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page,{status:NOT_SET_UP,tourDone:true});
  await page.locator('[data-fmdw-sched-pay="setup"]').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-fmdw-pay-callout]').count(),0);
  assert.equal(await page.locator('[data-fmdw-sched-pay] [data-fmdw-pay-setup]').count(),1);
 }finally{await browser.close();}
});

test('the customer, or a host without the payments services, sees none of it',async()=>{
 for(const options of [{audience:'customer'},{services:false}]){
  const browser=await launch();
  try{
   const page=await browser.newPage();await mount(page,{status:NOT_SET_UP,...options});
   await page.waitForTimeout(900);
   assert.equal(await page.locator('[data-fmdw-pay-callout], [data-fmdw-sched-pay]').count(),0);
   assert.deepEqual(await page.evaluate(()=>tours),[]);
  }finally{await browser.close();}
 }
});
