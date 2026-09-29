import { chromium } from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const project=process.env.PROJECT_WINDOW_URL ? await (await fetch(process.env.PROJECT_WINDOW_URL)).text() : await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const manager=process.env.WINDOW_MANAGER_URL ? await (await fetch(process.env.WINDOW_MANAGER_URL)).text() : await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8');
const css=project.slice(project.indexOf('  const css = `')+15,project.indexOf('`;',project.indexOf('  const css = `')));
const integration=project.slice(project.indexOf('  function syncProjectWindowModalRegistration(){'),project.indexOf('  function setProjectModalFullscreen('));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1500,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(`<style>body{margin:0}.main{position:absolute;left:200px;top:0;right:0;height:950px}#platformTopbar{height:50px}#mainPanels{height:900px}</style><main class="main"><header id="platformTopbar"></header><div id="mainPanels"><button id="underlying">Background</button></div></main><div id="rOverlay" class="r-overlay active"><div class="r-win"><aside class="r-left"><input value="Unsaved project"><p>App controlled left pane</p></aside><div class="r-right"><div class="r-modal-header"><div class="r-tabbar"><button class="r-tab active">Documents</button><button class="r-tab">Measurements</button></div><div class="modal-shell-actions"><button id="rProjectHeaderAction">App action</button><button id="rFullscreenToggle"></button><button id="rMapCloseX"></button></div></div><div class="r-preview">App controlled content</div></div></div></div>`);
 await page.addStyleTag({content:css});await page.addScriptTag({content:manager});
 await page.addScriptTag({content:`let projectModalWindow=null,requestModalHandle=null,projectModalFullscreen=false;const $=s=>document.querySelector(s);function injectCSS(id,css){const s=document.createElement('style');s.textContent=css;document.head.append(s);}let registered=0;window.Portal={modals:{register(){registered++;return {unregister(){registered--;}};}}};function syncProjectModalFullscreenRoute(){}function close(){projectModalWindow.setVisible(false);} ${integration} ensureProjectWindow();projectModalWindow.setVisible(true);syncProjectWindowModalRegistration();`});
 const win=page.locator('.r-win');const input=page.locator('.r-left input');await input.fill('Keep this draft');
 assert.equal(await page.locator('.fm-window-header').count(),0);
 const initial=await win.boundingBox();assert.equal(initial.width,1440);assert.equal(await page.evaluate(()=>registered),1);
 for(const [action,mode] of [['place','docked'],['maximize','full'],['fullscreen','fullscreen'],['floating','floating'],['modal','modal']]){
  await page.locator(`[data-window-action=${action}]`).click();assert.equal(await win.getAttribute('data-window'),mode);
  const b=await win.boundingBox();
  if(mode==='full'){assert.equal(b.x,200);assert.equal(b.y,50);assert.equal(b.width,1300);}
  if(mode==='fullscreen'){assert.equal(b.x,0);assert.equal(b.y,0);assert.equal(b.width,1500);assert.equal(b.height,950);}
  if(mode==='modal')assert.deepEqual(b,initial);
  assert.equal(await page.evaluate(()=>registered),['modal','fullscreen'].includes(mode)?1:0);
  assert.equal(await input.inputValue(),'Keep this draft');
  await page.locator('[data-window-action=minimize]').click();assert.equal(await win.getAttribute('data-window'),'minimized');assert.equal(await input.isVisible(),false);
  await page.locator('[data-window-action=minimize]').click();assert.equal(await win.getAttribute('data-window'),mode);assert.equal(await input.inputValue(),'Keep this draft');
 }
 await page.locator('[data-window-action=floating]').click();const before=await win.boundingBox();
 const header=await page.locator('.r-modal-header').boundingBox();
 await page.mouse.move(header.x+280,header.y+12);await page.mouse.down();await page.mouse.move(header.x+240,header.y+42);await page.mouse.up();
 assert.notEqual((await win.boundingBox()).x,before.x,'Floating header drags the same project');
 await page.locator('.r-modal-header').click({button:'right',position:{x:280,y:12}});assert.equal(await page.locator('.fm-window-menu').isVisible(),true);await page.keyboard.press('Escape');
 await page.locator('[data-resize=e]').press('ArrowLeft');assert.ok((await win.boundingBox()).width<before.width);
 await page.locator('[data-window-action=place]').click();assert.notEqual(await page.locator('#mainPanels').evaluate(e=>e.style.width),'');
 await page.evaluate(()=>{const host=document.querySelector('.main'),e=document.createElement('section');e.innerHTML='<header>Other window</header>';host.append(e);const other=FirstMateWindows.attach({element:e,header:e.firstChild,host});if(Number(e.style.zIndex)<=Number(document.querySelector('#rOverlay').style.zIndex))throw Error('Window stacking failed');other.destroy();});
 await page.locator('[data-window-action=pin]').click();assert.equal(await win.getAttribute('data-pinned'),'true');
 await page.locator('[data-window-action=modal]').click();await page.screenshot({path:'../../output/project-window-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-window-action=fullscreen]').click();assert.equal((await win.boundingBox()).width,390);
 await page.screenshot({path:'../../output/project-window-mobile.png'});
 await page.locator('[data-window-action=close]').click();assert.equal(await win.isVisible(),false);assert.equal(await page.locator('#mainPanels').evaluate(e=>e.style.width),'');assert.deepEqual(errors,[]);
 console.log('PASS: custom header; five placements and minimize/restore; draft preservation; resize; pin; mobile; close releases dock.');
}finally{await browser.close();}
