import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const contact = await readFile(new URL('../../libraries/apps/contacts/modal.js', import.meta.url), 'utf8');
const manager = await readFile(new URL('../../libraries/window-manager/window-manager.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel:'chrome', headless:true });
try {
  const page = await browser.newPage({ viewport:{ width:1500, height:950 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<style>body{margin:0}.main{position:absolute;left:200px;top:0;right:0;height:950px}#platformTopbar{height:50px}#mainPanels{height:900px}</style><main class="main"><header id="platformTopbar"></header><div id="mainPanels"></div></main>');
  await page.evaluate(() => { window.Portal = { modules:{}, modals:{ register(){ return { unregister(){} }; } } }; });
  await page.addScriptTag({ content:manager });
  await page.addScriptTag({ content:contact });
  await page.evaluate(() => Portal.modules.contacts.open({ name:'Ada Example' }, { projectsComplete:true }));
  const win = page.locator('.fm-contact-win');
  assert.equal(await page.locator('#fmContactWindowTitle').textContent(), 'Ada Example');
  assert.equal(await page.locator('#fmContactTitle').textContent(), 'Ada Example');
  assert.equal(await page.locator('.fm-contact-window-identity .fa-address-card').count(), 1);
  assert.equal(await page.locator('.fm-contact-title-line .fa-address-card').count(), 1);
  for (const [action, mode] of [['place','docked'], ['maximize','full'], ['fullscreen','fullscreen'], ['floating','floating'], ['modal','modal']]) {
    await page.locator(`[data-window-action=${action}]`).click();
    assert.equal(await win.getAttribute('data-window'), mode);
    await page.locator('#fmContactName').fill('Updated Contact');
    assert.equal(await page.locator('#fmContactWindowTitle').textContent(), 'Updated Contact');
    await page.locator('[data-window-action=minimize]').click();
    assert.equal(await win.getAttribute('data-window'), 'minimized');
    assert.equal(await page.locator('.fm-contact-content').isVisible(), false);
    assert.equal(await page.locator('#fmContactWindowTitle').textContent(), 'Updated Contact');
    await page.locator('[data-window-action=minimize]').click();
    assert.equal(await win.getAttribute('data-window'), mode);
    assert.equal(await page.locator('#fmContactName').inputValue(), 'Updated Contact');
  }
  await page.locator('[data-window-action=close]').click();
  assert.equal(await win.isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: contact placements, both icon titles, minimize/restore, unsaved name, close');
} finally {
  await browser.close();
}
