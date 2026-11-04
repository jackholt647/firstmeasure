import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// FM-329: on a phone, every letter typed into a report order's address re-renders the order, which runs the project
// details tray's default. The tray is a sheet there and the order pages hold the form, so the tray must not open by
// itself: opening it focused its close button and closing it again at once left nothing focused, and the keyboard shut.
const source = (await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const from = source.indexOf('  // The project details tray is the one owner');
const to = source.indexOf("  // The tray's divider begins", from);
const tray = source.slice(from, to);
const launch = () => chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: 'chrome', headless: true });

async function orderPage(browser, { mobile }) {
  const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <div id="rOverlay" class="r-overlay active${mobile ? ' mobile-order mobile-order-location' : ''}"><div class="r-win">
      <div class="r-window-bar" data-window-mobile="${mobile}"><button id="rProjectIdentityTrigger">Project</button></div>
      <div data-panel="map"><div class="r-tab-content"><div class="r-overview-details"><input id="rAddress" aria-label="Property address"></div></div></div>
    </div></div>`);
  await page.addScriptTag({ content: `
    var overviewWorkflowMode='report',requestedWorkflow='report',activeBaseProject=null,detailsTrayAsked=false,mobile=${mobile};
    const isMobileProjectOrder=()=>mobile,shouldUseMobileOrderPagination=()=>mobile,projectOpenId=()=>null,hasReportOrdered=()=>false;
    const syncTrayMeasurements=()=>{},syncDetailsTrayTop=()=>{},ensureOrderContactFields=()=>{};
    ${tray}
    window.syncDetailsTray=syncDetailsTray;window.trayOpen=()=>detailsTrayOpen;
    document.getElementById('rProjectIdentityTrigger').onclick=()=>setDetailsTrayOpen(!detailsTrayOpen,{user:true});
    // The order's input handler: the first letter makes an unsaved project, and every letter re-renders the order.
    document.getElementById('rAddress').addEventListener('input',()=>{activeBaseProject={};syncDetailsTray();});
    syncDetailsTray();
  ` });
  return page;
}

test('typing an address on a phone keeps the field focused and the tray closed', async () => {
  const browser = await launch();
  try {
    const page = await orderPage(browser, { mobile: true });
    await page.locator('#rAddress').tap();
    for (const letter of '4555 Main') {
      await page.keyboard.type(letter);
      const state = await page.evaluate(() => ({ active: document.activeElement?.id || document.activeElement?.tagName, open: trayOpen() }));
      assert.deepEqual(state, { active: 'rAddress', open: false }, `after typing "${letter}"`);
    }
    assert.equal(await page.locator('#rAddress').inputValue(), '4555 Main');
    await page.locator('#rProjectIdentityTrigger').tap();
    assert.equal(await page.evaluate(() => trayOpen()), true, 'a person can still open the tray');
  } finally { await browser.close(); }
});

test('on a desktop the order still opens the details tray by itself', async () => {
  const browser = await launch();
  try {
    const page = await orderPage(browser, { mobile: false });
    assert.equal(await page.evaluate(() => trayOpen()), true);
    await page.locator('#rAddress').click();
    await page.keyboard.type('12 Oak');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'rAddress');
  } finally { await browser.close(); }
});
