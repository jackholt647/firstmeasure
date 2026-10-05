import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const lib=new URL('../../libraries/',import.meta.url);
test('retained project lazily opens contact in the owning portal and closes only after success',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  const modal=await readFile(new URL('apps/contacts/modal.js',lib),'utf8');
  await page.route('https://contact.test/**',route=>route.fulfill({contentType:route.request().url().includes('contacts/modal.js')?'text/javascript':'text/html',body:route.request().url().includes('contacts/modal.js')?modal:'<style>body{margin:0}main{position:relative;width:100vw;height:100vh}</style><main class="main"></main>'}));
  await page.goto('https://contact.test/');
  await page.evaluate(()=>{
   window.Portal={cfg:{orgId:'org'},modules:{},ProjectStore:{list:()=>[],getAll:()=>[]},PhotoFeed:{mountProjectGallery(node){node.innerHTML='<button style="height:38px">Upload media</button>';}}};
   window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[]}}),projects:async()=>({projects:[]})}};
  });
  for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','window-manager/project-windows.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
  await page.evaluate(()=>window.record=FirstMateProjectWindows.open({id:'p'}));
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument?.readyState==='complete');
  await page.evaluate(async()=>{
   window.closedCalls=0;
   FirstMateProjectWindows.ready(record.token,record.frame.contentWindow,{openProject:async()=>{},close(){closedCalls++;}});
   await record.ready;
  });
  assert.equal(await page.evaluate(()=>!!Portal.modules.contacts),false);
  await page.evaluate(async()=>{
   let rejected=false;try{await FirstMateProjectWindows.openContact(record.token,window,{id:'wrong'});}catch{rejected=true;}
   if(!rejected)throw Error('Foreign child accepted');
   await FirstMateProjectWindows.openContact(record.token,record.frame.contentWindow,{id:'c',name:'Primary Contact'},{projects:[]});
  });
  assert.equal(await page.locator('#fmContactOverlay').isVisible(),true);
  assert.equal(await page.locator('#fmContactName').inputValue(),'Primary Contact');
  assert.equal(await page.evaluate(()=>FirstMateProjectWindows.size),0);
  assert.equal(await page.evaluate(()=>closedCalls),1);
  for(const width of [1400,600]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(()=>Portal.modules.contacts.setLayout({panes:[{tab:'media'}],sidebar:false}));
   await page.getByRole('button',{name:'Upload media'}).waitFor();
   const inset=await page.locator('[data-contact-pane="media"]').evaluate(p=>({padding:getComputedStyle(p).paddingTop,offset:p.querySelector('button').getBoundingClientRect().top-p.getBoundingClientRect().top}));
   assert.equal(inset.padding,width>760?'18px':'12px');assert.ok(inset.offset>=parseFloat(inset.padding));
   await page.evaluate(()=>Portal.modules.contacts.setLayout({panes:[{tab:'projects'},{tab:'media'}]}));
   assert.equal(await page.locator('[data-contact-pane="projects"]').evaluate(p=>getComputedStyle(p).paddingTop),inset.padding);
  }
  await page.evaluate(()=>{
   Portal.modules.contacts.open=async()=>{throw Error('Contact load failed');};
   window.failedRecord=FirstMateProjectWindows.open({id:'failed'});
  });
  await page.waitForFunction(()=>failedRecord.frame.contentDocument?.readyState==='complete');
  await page.evaluate(async()=>{try{await FirstMateProjectWindows.openContact(failedRecord.token,failedRecord.frame.contentWindow,{id:'c'});}catch{}});
  assert.equal(await page.evaluate(()=>FirstMateProjectWindows.size),1,'failure preserves the project');
 }finally{await browser.close();}
});
