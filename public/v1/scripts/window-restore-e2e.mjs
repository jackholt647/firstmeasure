import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<main style="width:1200px;height:800px"><div id="content"></div><section><header><span>Inspector</span></header><article>Content</article></section></main>');
  await page.addScriptTag(process.env.WINDOW_MANAGER_URL ? {url:process.env.WINDOW_MANAGER_URL} : {path:path.resolve('../libraries/window-manager/window-manager.js')});
  await page.evaluate(()=>{window.controller=FirstMateWindows.attach({element:document.querySelector('section'),header:document.querySelector('header'),title:document.querySelector('span'),body:document.querySelector('article'),host:document.querySelector('main'),contentTarget:document.querySelector('#content'),name:'inspector'});});
  const title=page.locator('.fm-window-title');
  for(const mode of ['floating','docked','full']) {
    await page.evaluate(mode=>controller.setMode(mode),mode);
    const before=await page.locator('section').boundingBox();
    for(const action of ['click','Enter','Space','button','header']) {
      // Icons are replaced while handling the click; its bubbling path must
      // still count as a control click, not a second title-bar action.
      await page.locator('[data-window-action=minimize] i').evaluate(icon=>icon.click());
      assert.equal(await page.locator('section').getAttribute('data-window'),'minimized');
      assert.equal(await title.getAttribute('aria-label'),'Restore inspector');
      if(action==='click')await title.click();
      else if(action==='button')await page.locator('[data-window-action=minimize]').click();
      else if(action==='header')await page.locator('header').click({position:{x:3,y:3}});
      else await title.press(action);
      assert.equal(await page.locator('section').getAttribute('data-window'),mode);
      assert.equal(await page.locator('.fm-window-menu').count(),0);
      assert.deepEqual(await page.locator('section').boundingBox(),before);
    }
  }
  await page.locator('[data-window-action=minimize]').click();
  await title.click({button:'right'});
  assert.equal(await page.locator('.fm-window-menu').count(),1);
  await page.keyboard.press('Escape');
  await title.press('Alt+Space');
  assert.equal(await page.locator('.fm-window-menu').count(),1);
  await page.keyboard.press('Escape');
  await title.click();
  await title.click();
  assert.equal(await page.locator('.fm-window-menu').count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: 15 restore interactions preserve mode and geometry; right-click, Alt+Space and open-window menus preserved.');
} finally {await browser.close();}
