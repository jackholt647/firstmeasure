import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const source = await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8');
test('shared backdrops cover managed and legacy modals, native dialogs and iframe workspaces',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<style>body{margin:0;background:repeating-linear-gradient(45deg,#fff 0 10px,#333 10px 20px)}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.78);display:grid;place-items:center}.window{background:#fff;width:800px;height:650px}dialog{width:300px;background:white}dialog::backdrop{background:rgba(0,0,0,.8);backdrop-filter:blur(2px)}</style><div class="overlay" id="project" data-fm-modal-id="project" style="z-index:100"><div class="window">Project</div></div>`);
  await page.addScriptTag({content:source});
  await page.evaluate(()=>FirstMateWindows.backdrops.setEffect('blur'));
  await page.waitForFunction(()=>document.querySelector('#project').dataset.fmBackdrop==='active');
  const css=selector=>page.locator(selector).evaluate(el=>({blur:getComputedStyle(el).backdropFilter,background:getComputedStyle(el).backgroundColor}));
  assert.deepEqual(await css('#project'),{blur:'blur(8px)',background:'rgba(11, 16, 24, 0.58)'});
  await page.evaluate(()=>{const el=document.createElement('div');el.id='child';el.className='overlay';el.style.zIndex=120;el.innerHTML='<div class="window">Child</div>';document.body.append(el);});
  await page.waitForFunction(()=>document.querySelector('#child').dataset.fmBackdrop==='active');
  assert.equal((await css('#project')).blur,'none');assert.equal((await css('#project')).background,'rgba(0, 0, 0, 0)');
  assert.equal((await css('#child')).blur,'blur(8px)');
  assert.equal((await css('#child')).background,'rgba(11, 16, 24, 0.58)');
  await page.evaluate(()=>{const p=document.createElement('div');p.id='popover';p.className='modal';p.dataset.fmModalId='popover';p.style.cssText='position:fixed;top:10px;right:10px;width:100px;height:100px;background:white;z-index:200';document.body.append(p);});
  await page.waitForTimeout(40);
  assert.equal((await css('#popover')).background,'rgb(255, 255, 255)');
  await page.evaluate(()=>{const next=document.createElement('dialog');next.id='second';document.body.append(next);const d=document.createElement('dialog');d.id='native';d.textContent='Native';document.body.append(d);d.showModal();});
  await page.waitForFunction(()=>document.querySelector('#native').dataset.fmNativeBackdrop==='active');
  assert.equal((await css('#child')).blur,'none');
  assert.equal(await page.locator('#native').evaluate(el=>getComputedStyle(el,'::backdrop').backdropFilter),'blur(8px)');
  assert.equal(await page.locator('#native').evaluate(el=>getComputedStyle(el,'::backdrop').backgroundColor),'rgba(11, 16, 24, 0.58)');
  await page.evaluate(()=>document.querySelector('#second').showModal());
  await page.waitForFunction(()=>document.querySelector('#second').dataset.fmNativeBackdrop==='active');
  assert.equal(await page.locator('#native').evaluate(el=>getComputedStyle(el,'::backdrop').backdropFilter),'none');
  await page.evaluate(()=>document.querySelector('#second').close());
  await page.waitForFunction(()=>document.querySelector('#native').dataset.fmNativeBackdrop==='active');
  await page.evaluate(()=>{document.querySelector('#native').close();document.querySelector('#child').remove();});
  await page.waitForFunction(()=>document.querySelector('#project').dataset.fmBackdrop==='active');
  await page.evaluate(()=>{const f=document.createElement('iframe');f.id='workspace';f.style.cssText='width:100%;height:100%;border:0';document.querySelector('.window').replaceChildren(f);});
  const frame=page.frames().find(frame=>frame.parentFrame());
  await frame.setContent('<style>body{margin:0;background:repeating-linear-gradient(45deg,#fff 0 10px,#333 10px 20px)}.overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:grid;place-items:center}</style><div class="overlay" data-fm-modal-id="nested"><div style="background:white;padding:40px">Nested child</div></div>');
  await frame.addScriptTag({content:source});
  await frame.waitForFunction(()=>document.querySelector('.overlay').dataset.fmBackdrop==='active');
  assert.equal((await css('#project')).blur,'blur(8px)');
  assert.equal(await frame.locator('.overlay').evaluate(el=>getComputedStyle(el).backdropFilter),'blur(8px)');
  await page.screenshot({path:new URL('../../../output/modal-backdrops-20261012/nested.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.evaluate(()=>FirstMateWindows.backdrops.setEffect('dim'));
  await page.waitForFunction(()=>document.documentElement.dataset.fmBackdropEffect==='dim');
  await frame.waitForFunction(()=>document.documentElement.dataset.fmBackdropEffect==='dim');
  assert.equal((await css('#project')).blur,'none');
  assert.equal(await frame.locator('.overlay').evaluate(el=>getComputedStyle(el).backdropFilter),'none');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  await page.evaluate(()=>FirstMateWindows.backdrops.setEffect('blur'));
  await page.waitForFunction(()=>document.documentElement.dataset.fmBackdropEffect==='dim');
  assert.equal((await css('#project')).blur,'none');
  await page.evaluate(()=>{const el=document.querySelector('#project');el.removeAttribute('data-fm-modal-id');el.style.background='transparent';el.style.pointerEvents='none';});
  await page.waitForFunction(()=>!document.querySelector('#project').hasAttribute('data-fm-backdrop'));
  assert.equal((await css('#project')).blur,'none');
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});

test('modal windows create a backdrop and release it on docking, hide and destroy',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  await page.setContent('<style>body{margin:0}main{width:1200px;height:900px;position:relative}</style><main><div id="panels"></div><section><header>Window</header><input value="Unsaved draft"></section></main>');
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{FirstMateWindows.backdrops.setEffect('blur');window.win=FirstMateWindows.attach({element:document.querySelector('section'),header:document.querySelector('header'),host:document.querySelector('main'),contentTarget:document.querySelector('#panels'),mode:'modal'});});
  await page.waitForFunction(()=>document.querySelector('.fm-window-backdrop').dataset.fmBackdrop==='active');
  assert.equal(await page.locator('section').evaluate(el=>getComputedStyle(el).backdropFilter),'none');
  await page.evaluate(()=>win.dock('right'));
  assert.equal(await page.locator('.fm-window-backdrop').isVisible(),false);
  await page.evaluate(()=>{win.setMode('modal');win.setVisible(false);});
  assert.equal(await page.locator('.fm-window-backdrop').isVisible(),false);
  await page.evaluate(()=>win.setVisible(true));
  assert.equal(await page.locator('.fm-window-backdrop').isVisible(),true);
  assert.equal(await page.locator('input').inputValue(),'Unsaved draft');
  await page.evaluate(()=>win.destroy());
  assert.equal(await page.locator('.fm-window-backdrop').count(),0);
 } finally {await browser.close();}
});

test('auto falls back to dim when the graphics probe is refused',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div data-fm-modal-id="test" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">Test</div>');
  await page.evaluate(()=>HTMLCanvasElement.prototype.getContext=()=>null);
  await page.addScriptTag({content:source});
  await page.waitForFunction(()=>document.documentElement.dataset.fmBackdropEffect==='dim');
  assert.equal(await page.locator('[data-fm-modal-id]').evaluate(el=>getComputedStyle(el).backdropFilter),'none');
 } finally {await browser.close();}
});
