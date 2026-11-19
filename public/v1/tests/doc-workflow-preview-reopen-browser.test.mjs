import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-24: closing the docked live preview with its X is never a one-way trip. A host with its own full-screen preview
// (Docs, the document setup) has no footer Preview toggle, so a Preview button at the top right of every step brings
// the preview back; it shows only while the preview is closed, and the choice is remembered either way.
async function mount(page,{fullPreview=true,width=1400,hidden=false}={}){
 await page.setViewportSize({width,height:800});
 await page.route('https://reopen.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(url.pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div id="host" style="height:700px;display:flex"></div>'});
 });
 await page.goto('https://reopen.test/');
 await page.addScriptTag({url:'/libraries/doc-model/firstmate-doc-model.js'});
 await page.addScriptTag({url:'/libraries/doc-workflow/firstmate-doc-workflow.js'});
 await page.evaluate(({fullPreview,hidden})=>{
  if(hidden)localStorage.setItem('fmdw:preview',JSON.stringify({hidden:true}));
  window.__APP={userOrgId:'org'};
  const workflow={schema_version:1,steps:[
   {id:'one',title:'One',items:[{kind:'text',writes:'params.a',label:'A'}]},
   {id:'two',title:'Two',items:[{kind:'text',writes:'params.b',label:'B'}]}]};
  const services=fullPreview?{openFullPreview:()=>{window.fullOpened=true;}}:{};
  window.handle=FMDocWorkflow.mount(document.getElementById('host'),{workflow,audience:'internal',state:{params:{}},scope:{},
   onWrite:()=>{},services,preview:{resolve:async()=>({})}});
 },{fullPreview,hidden});
 await page.waitForSelector('[data-fmdw-preview]',{state:'attached'});
}
const visible=(page,selector)=>page.locator(selector).first().isVisible();

test('a host with a full-screen preview gets a Preview button back after the X, on every step',async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await mount(page);
  assert.equal(await page.locator('[data-fmdw-preview-toggle]').count(),0,'no footer toggle for this host');
  assert.equal(await visible(page,'[data-fmdw-preview]'),true);
  assert.equal(await visible(page,'[data-fmdw-preview-reopen]'),false,'hidden while the preview shows');

  await page.click('[data-fmdw-preview-hide]');
  assert.equal(await visible(page,'[data-fmdw-preview]'),false);
  assert.equal(await page.evaluate(()=>handle.previewVisible()),false);
  assert.equal(await visible(page,'.fmdw-step-head [data-fmdw-preview-reopen]'),true,'Preview shows at the top of the step');

  // The step head is redrawn on the next step; the button is still there and still works.
  await page.click('[data-fmdw-continue]');
  await page.waitForFunction(()=>/Two/.test(document.querySelector('[data-fmdw-step-head] h2')?.textContent||''));
  assert.equal(await visible(page,'[data-fmdw-preview-reopen]'),true);
  await page.click('[data-fmdw-preview-reopen]');
  assert.equal(await visible(page,'[data-fmdw-preview]'),true);
  assert.equal(await visible(page,'[data-fmdw-preview-reopen]'),false);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fmdw:preview')).hidden),false,'reopening is remembered');

  // Closed and remembered: the next open starts closed, with the button.
  await page.click('[data-fmdw-preview-hide]');
  await page.evaluate(()=>{handle.destroy?.();document.getElementById('host').innerHTML='';});
  await page.evaluate(()=>FMDocWorkflow.mount(document.getElementById('host'),{workflow:{schema_version:1,steps:[{id:'one',title:'One',items:[{kind:'text',writes:'params.a',label:'A'}]}]},
   audience:'internal',state:{params:{}},scope:{},onWrite:()=>{},services:{openFullPreview:()=>{}},preview:{resolve:async()=>({})}}));
  await page.waitForSelector('[data-fmdw-preview-reopen]',{state:'visible'});
  assert.equal(await visible(page,'[data-fmdw-preview]'),false);
 }finally{await browser.close();}
});

test('too narrow to dock, nothing offers it; a host without a full-screen preview keeps its footer toggle',async()=>{
 const browser=await launch();
 try{
  const narrow=await browser.newPage();await mount(narrow,{width:700,hidden:true});
  await narrow.waitForSelector('.fmdw.narrow');
  assert.equal(await visible(narrow,'[data-fmdw-preview-reopen]'),false);

  const plain=await browser.newPage();await mount(plain,{fullPreview:false});
  assert.equal(await plain.locator('[data-fmdw-preview-reopen]').count(),0,'the footer toggle is its way back');
  await plain.click('[data-fmdw-preview-hide]');
  await plain.click('[data-fmdw-preview-toggle]');
  assert.equal(await visible(plain,'[data-fmdw-preview]'),true);
 }finally{await browser.close();}
});
