import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const source = file => readFile(new URL(`../../${file}`,import.meta.url),'utf8');
const launch = () => chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('header and docking menus use placement icons and follow the cursor across iframe documents',async()=>{
  const browser=await launch();
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.setContent('<style>body{margin:0}main{height:800px}iframe{position:absolute;left:180px;top:80px;width:900px;height:600px;border:0}header{height:48px}</style><main><section id="window"></section></main><iframe srcdoc="<style>body{margin:0}header{height:48px;display:flex}#menu-host{position:fixed;inset:0;pointer-events:none}</style><header><span id=title>Project</span><div id=controls></div></header><div id=menu-host></div>"></iframe>');
    await page.addScriptTag({content:await source('libraries/window-manager/window-manager.js')});
    const frame=page.locator('iframe').contentFrame();await frame.locator('header').waitFor();
    const childFrame=page.frames().find(frame=>frame!==page.mainFrame());
    await childFrame.addScriptTag({content:await source('libraries/window-manager/window-manager.js')});
    await childFrame.evaluate(()=>FirstMateWindows.ensureStyles());
    for(const inside of [true,false]) {
      await page.evaluate(inside=>{
        window.control?.destroy();const el=document.createElement('section');el.style.pointerEvents='none';document.querySelector('main').append(el);
        const child=document.querySelector('iframe').contentDocument;
        // The parent owns window geometry; the child owns project chrome.
        window.control=FirstMateWindows.attach({element:el,header:child.querySelector('header'),title:child.querySelector('#title'),controlsHost:child.querySelector('#controls'),host:document.querySelector('main'),menuHost:inside?child.querySelector('#menu-host'):document.body,mode:'modal',customChrome:true,presentationModes:true,allowFullscreen:false});
      },inside);
      const cursor={x:180+420,y:80+20};
      await page.mouse.click(cursor.x,cursor.y,{button:'right'});
      const menu=inside?frame.locator('.fm-window-menu'):page.locator('.fm-window-menu');
      await menu.waitFor();const box=await menu.boundingBox();
      assert.ok(Math.abs(box.x-cursor.x)<2 && Math.abs(box.y-cursor.y-6)<2,'header menu appears by the pointer');
      assert.equal(await menu.locator('[data-dock-placement] svg').count(),6);
      assert.equal(await menu.locator('.fm-window-dock-options hr').count(),1);
      assert.equal(await menu.locator('[data-dock-placement]').first().textContent(),'');
      await menu.getByRole('menuitem',{name:'Dock left',exact:true}).click();
      assert.equal(await page.evaluate(()=>control.state.dockSide),'left');
      await frame.locator('[data-window-action=place]').click({button:'right'});
      const dockMenu=inside?frame.locator('.fm-window-menu'):page.locator('.fm-window-menu');
      assert.equal(await dockMenu.locator('button').count(),6);
      await dockMenu.getByRole('menuitem',{name:'Dock bottom right',exact:true}).click();
      assert.equal(await page.evaluate(()=>control.state.dockSide),'bottom-right');
    }
  } finally {await browser.close();}
});

test('project iframe identity does not become a full-window tooltip',async()=>{
  const browser=await launch();
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.setContent('<main class="main"></main>');
    await page.evaluate(()=>{window.Portal={};window.FirstMateWindows={};window.crypto.randomUUID=()=> 'fixture-project';});
    await page.addScriptTag({content:await source('libraries/platform-ui/platform-ui.js')});
    await page.addScriptTag({content:await source('libraries/window-manager/project-windows.js')});
    await page.evaluate(()=>{
      const project=FirstMateProjectWindows.open({id:'p',title:'Project address'});
      project.frame.src='about:blank';project.frame.style.visibility='visible';
      FirstMateProjectWindows.update(project.token,{title:'Updated address'});
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('iframe').getAttribute('aria-label'),'Updated address');
    assert.equal(await page.locator('iframe').getAttribute('title'),null);
    assert.equal(await page.locator('iframe').getAttribute('data-fm-tooltip'),null);
    await page.locator('iframe').dispatchEvent('mouseover');await page.waitForTimeout(500);
    assert.equal(await page.locator('.fm-tooltip.visible').count(),0);
  } finally {await browser.close();}
});

test('Overview note composer joins the + Note and pin segments without an inner rounded edge',async()=>{
  const app=await source('libraries/apps/project-request/app.js');
  const start=app.indexOf("    const button = $('#rProjectNoteAdd');");
  const end=app.indexOf("    $('#rProjectNotesToggle')",start);
  const browser=await launch();
  try {
    const page=await browser.newPage();
    await page.setContent('<style>button{height:34px;border:0;padding:8px;border-radius:8px}.tools{display:flex;gap:6px}</style><div class="tools"><button id="rProjectNoteAdd">Send</button></div>');
    await page.evaluate(code=>{window.$=s=>document.querySelector(s);window.editingProjectNoteId='';window.commitProjectNote=options=>window.sent=options;window.renderSend=new Function(code);window.renderSend();},app.slice(start,end));
    const main=page.locator('#rProjectNoteAdd'),pin=page.getByRole('button',{name:'Add pinned note'});
    assert.equal((await main.textContent()).trim(),'+ Note');
    const a=await main.boundingBox(),b=await pin.boundingBox();assert.equal(a.x+a.width,b.x);assert.equal(a.y,b.y);assert.equal(a.height,b.height);
    assert.equal(await main.evaluate(el=>getComputedStyle(el).borderTopRightRadius),'0px');
    assert.equal(await pin.evaluate(el=>getComputedStyle(el).borderTopLeftRadius),'0px');
    await pin.click();assert.equal(await page.evaluate(()=>sent.pin),true);
    await page.evaluate(()=>{editingProjectNoteId='note';renderSend();});assert.equal(await pin.isVisible(),false);
  } finally {await browser.close();}
});
