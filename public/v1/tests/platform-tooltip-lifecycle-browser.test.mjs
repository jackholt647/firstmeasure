import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('tooltips dismiss across stopped events, moving controls, iframe exits and keyboard escape', async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage(); page.setDefaultTimeout(4000);
  await page.setContent('<button id="close" title="Close project" style="position:absolute;top:30px;left:30px">X</button><button id="other" style="position:absolute;top:150px;left:30px">Other</button>');
  await page.addScriptTag({content:process.env.TOOLTIP_ASSET_ORIGIN ? await (await fetch(`${process.env.TOOLTIP_ASSET_ORIGIN}/libraries/platform-ui/platform-ui.js?verify=${Date.now()}`)).text() : await readFile(new URL('../../libraries/platform-ui/platform-ui.js',import.meta.url),'utf8')});
  await page.evaluate(()=>{for(const type of ['mouseout','pointerdown','focusout'])document.querySelector('#close').addEventListener(type,e=>e.stopPropagation());});
  const visible=()=>page.locator('#fmTooltip.visible').count();
  await page.locator('#close').hover(); await page.waitForSelector('#fmTooltip.visible');
  await page.locator('#other').hover(); assert.equal(await visible(),0);
  await page.locator('#close').hover(); await page.waitForSelector('#fmTooltip.visible');
  await page.locator('#close').click(); assert.equal(await visible(),0);
  await page.waitForTimeout(2600); // Existing stationary-pointer suppression after activation.
  await page.locator('#other').hover(); await page.locator('#close').hover(); await page.waitForSelector('#fmTooltip.visible');
  await page.evaluate(()=>document.querySelector('#close').style.left='300px');
  await page.waitForFunction(()=>!document.querySelector('#fmTooltip').classList.contains('visible'));
  await page.locator('#close').hover(); await page.waitForSelector('#fmTooltip.visible');
  await page.evaluate(()=>document.querySelector('#close').hidden=true);
  await page.waitForFunction(()=>!document.querySelector('#fmTooltip').classList.contains('visible'));
  await page.evaluate(()=>{document.querySelector('#close').hidden=false;document.activeElement.blur();});
  await page.locator('#other').focus(); await page.keyboard.press('Shift+Tab'); await page.waitForSelector('#fmTooltip.visible');
  await page.keyboard.press('Escape'); assert.equal(await visible(),0);
  await page.locator('#other').hover(); await page.locator('#close').hover(); await page.waitForSelector('#fmTooltip.visible');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur'))); assert.equal(await visible(),0);
  await page.locator('#other').hover(); await page.locator('#close').hover();
  await page.evaluate(()=>document.querySelector('#close').style.top='300px');
  await page.waitForTimeout(400); assert.equal(await visible(),0);
 } finally {await browser.close();}
});

