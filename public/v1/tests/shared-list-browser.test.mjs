import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('shared panels remain compact, styled and usable in Contacts and Channels',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://shared.test/**',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
  await page.goto('https://shared.test/');
  await page.setContent('<style>body{margin:0;font:18px Arial}#app{height:700px;display:flex;flex-direction:column;background:#f0f2f5}main{flex:1;min-height:0;overflow:auto}</style><div id="app"><section id="shared"></section><main>App content</main></div>');
  await page.evaluate(()=>{
   window.Portal={cfg:{orgId:'org'},tabs:{activateTab:tab=>window.openedTab=tab}};
   window.requests=[];window.PlatformAPI={request:async url=>{requests.push(url);return {items:[],next_cursor:''};}};
  });
  await page.addScriptTag({content:await readFile(process.env.SHARED_LIST_SOURCE||new URL('../../libraries/apps/partners/shared-list.js',import.meta.url),'utf8')});
  for(const width of [1280,375])for(const type of ['contact','channel']){
   await page.setViewportSize({width,height:800});
   await page.evaluate(type=>{window.dispose?.();window.dispose=FirstMateSharedList.mount(document.querySelector('#shared'),type);},type);
   const summary=page.locator('summary');
   assert.equal(await page.locator('details').getAttribute('open'),null);
   assert.ok((await page.locator('#shared').boundingBox()).height<60);
   assert.equal(await summary.evaluate(e=>getComputedStyle(e).fontSize),'13px');
   assert.ok((await page.locator('main').boundingBox()).height>600);
   await summary.click();
   assert.equal(await page.locator('select').first().evaluate(e=>getComputedStyle(e).borderRadius),'7px');
   assert.equal(await page.locator('select').first().evaluate(e=>getComputedStyle(e).fontSize),'12px');
   await page.locator('[data-direction]').selectOption('outbound');
   await page.waitForFunction(()=>requests.at(-1).includes('/shares?'));
   assert.ok(await page.locator('details').evaluate(e=>e.scrollWidth<=e.clientWidth));
   await summary.click();
  }
  await page.evaluate(()=>{PlatformAPI.request=async()=>({items:[{resource:{type:'contact',id:'c',owner_org_id:'other'},owner:{name:'Partner'},data:{name:'Shared customer'}}]});dispose();dispose=FirstMateSharedList.mount(document.querySelector('#shared'),'contact');});
  await page.locator('summary').click();
  await page.getByRole('button',{name:'Open shared contact'}).click();
  assert.equal(await page.evaluate(()=>openedTab),'partners');
  assert.equal(await page.evaluate(()=>__fmPendingCollaborationResource.resource.id),'c');
 }finally{await browser.close();}
});
