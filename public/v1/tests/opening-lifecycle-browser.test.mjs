import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const windows=await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8');
const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
const core=await readFile(new URL('../../portal/scripts/core.js',import.meta.url),'utf8');
const modalManager=core.slice(core.indexOf('  function createModalManager(){'),core.indexOf('  function projectRouteId('));
const launch=()=>chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('modal shell opens synchronously, paints before load, and discards a closed request',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage();await page.setContent('<main>Page</main>');await page.addScriptTag({content:windows});
  const immediate=await page.evaluate(()=>{
   window.loaded=false;window.rendered=false;window.painted=false;requestAnimationFrame(()=>painted=true);
   window.modal=FirstMateWindows.opening.openModal({title:'Example',load:({signal})=>{window.signal=signal;loaded=true;window.sawPaint=painted;return new Promise(resolve=>window.resolveLoad=resolve);},render:()=>rendered=true});
   return {open:modal.dialog.open,busy:modal.body.getAttribute('aria-busy'),loaded};
  });
  assert.deepEqual(immediate,{open:true,busy:'true',loaded:false});
  await page.waitForFunction(()=>loaded);assert.equal(await page.evaluate(()=>sawPaint),true);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.evaluate(()=>signal.aborted),true);
  assert.equal(await page.evaluate(async()=>(await modal.ready).status),'cancelled');await page.evaluate(()=>resolveLoad('late'));
  assert.equal(await page.evaluate(()=>rendered),false);assert.equal(await page.locator('dialog').count(),0);
 }finally{await browser.close();}
});

test('shared native modal joins the stack so Escape closes the child, not its parent',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage();await page.setContent('<div id="parent" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">Parent</div>');await page.addScriptTag({content:windows});
  await page.addScriptTag({content:modalManager+'window.Portal={modals:createModalManager()};'});
  await page.evaluate(()=>{
   window.parentClosed=false;Portal.modals.register(document.querySelector('#parent'),{id:'parent',onClose:()=>parentClosed=true});
   window.child=FirstMateWindows.opening.openModal({title:'Child',load:()=>new Promise(()=>{})});
  });
  assert.equal(await page.evaluate(()=>Portal.modals.top().id.startsWith('opening-modal-')),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog'));
  assert.equal(await page.evaluate(()=>parentClosed),false);assert.equal(await page.evaluate(async()=>(await child.ready).status),'cancelled');
  assert.equal(await page.evaluate(()=>Portal.modals.top().id),'parent');
 }finally{await browser.close();}
});

test('new requests win races; errors offer retry and removed targets abort',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage();await page.setContent('<main><div id="target"></div></main>');await page.addScriptTag({content:windows});
  await page.evaluate(()=>{window.target=document.querySelector('#target');window.first=FirstMateWindows.opening.run(target,{load:()=>new Promise(resolve=>window.resolveFirst=resolve),render:value=>target.textContent=value});});
  await page.waitForFunction(()=>typeof resolveFirst==='function');
  await page.evaluate(()=>window.second=FirstMateWindows.opening.run(target,{load:()=> 'new',render:value=>target.textContent=value}));
  assert.equal(await page.evaluate(async()=>(await second.ready).status),'ready');
  await page.evaluate(()=>resolveFirst('old'));assert.equal(await page.evaluate(async()=>(await first.ready).status),'cancelled');assert.equal(await page.locator('#target').textContent(),'new');
  await page.evaluate(()=>{window.attempts=0;window.failed=FirstMateWindows.opening.run(target,{load(){if(++attempts===1)throw Error('test');return 'recovered';},render:value=>target.textContent=value});});
  assert.equal(await page.evaluate(async()=>(await failed.ready).status),'error');assert.equal(await page.locator('#target').getAttribute('aria-busy'),null);
  await page.getByRole('button',{name:'Retry'}).click();await page.waitForFunction(()=>target.textContent==='recovered');
  await page.evaluate(()=>{window.removed=FirstMateWindows.opening.begin(target);target.remove();});
  await page.waitForFunction(()=>removed.signal.aborted);
 }finally{await browser.close();}
});

test('embedded app mounts default to a loading shell and unmount cancels pending work',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage();await page.setContent('<div id="panel"></div>');await page.addScriptTag({content:windows});await page.addScriptTag({content:runtime});
  await page.evaluate(()=>{
   window.panel=document.querySelector('#panel');window.calls=0;
   window.PlatformLanguage={ensure:()=>new Promise(resolve=>window.releaseLanguage=resolve)};
   FirstMateEmbeddableApps.registerApp({id:'example',mount(context){calls++;panel.textContent='Ready';window.context=context;return {destroy(){panel.textContent='';}};}});
   window.result=FirstMateEmbeddableApps.mount(panel,'example');
  });
  assert.equal(await page.locator('#panel').getAttribute('aria-busy'),'true');assert.equal(await page.getByRole('status').isVisible(),true);
  await page.waitForFunction(()=>typeof releaseLanguage==='function');
  await page.evaluate(()=>FirstMateEmbeddableApps.unmount(panel));await page.evaluate(()=>releaseLanguage());
  assert.equal(await page.evaluate(async()=>await result),null);assert.equal(await page.evaluate(()=>calls),0);assert.equal(await page.locator('#panel').getAttribute('aria-busy'),null);
  await page.evaluate(()=>{PlatformLanguage.ensure=async()=>{};window.ready=FirstMateEmbeddableApps.mount(panel,'example');});
  await page.evaluate(async()=>await ready);assert.equal(await page.locator('#panel').textContent(),'Ready');assert.equal(await page.evaluate(()=>context.isCurrent()),true);
  await page.evaluate(()=>FirstMateEmbeddableApps.unmount(panel));assert.equal(await page.evaluate(()=>context.signal.aborted),true);
  assert.equal(await page.evaluate(async()=>{const detached=document.createElement('div');FirstMateEmbeddableApps.registerApp({id:'detached',mount:()=>({})});return !!(await FirstMateEmbeddableApps.mount(detached,'detached'));}),true);
 }finally{await browser.close();}
});
