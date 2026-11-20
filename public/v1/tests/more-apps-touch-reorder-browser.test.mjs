// On a phone the left column's order is set in More apps: holding a pinned app
// picks it up and dragging it moves it among the pinned apps (GP-126). Runs
// core.js's own renderAdvancedAppMenu and its stylesheet with stubbed neighbours,
// on a touch screen the size of the reporter's phone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const core = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');
const slice = (from, to) => {
  const start = core.indexOf(from);
  const end = core.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `core.js has ${from}`);
  return core.slice(start, end);
};
const render = slice('  function renderAdvancedAppMenu(', '  function openAdvancedAppMenu(');
const sidebarLinksCss = (() => {
  const start = core.indexOf("injectCSS('sidebar_links', `") + "injectCSS('sidebar_links', `".length;
  return core.slice(start, core.indexOf('`);', start));
})();

const APPS = [
  ['portal.viewer', 'My Projects', true], ['portal.contacts', 'My Contacts', true], ['portal.partners', 'Subcontractors', true],
  ['portal.scheduling', 'Scheduling', true], ['portal.crm', 'CRM', false], ['portal.stats', 'Stats', false]
];

const harness = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${sidebarLinksCss}</style></head><body><aside class="sidebar"></aside>
<script>
  window.saves = [];
  window.pinned = ${JSON.stringify(APPS.filter((app) => app[2]).map((app) => app[0]))};
  window.failSave = false;
  (() => {
    let advancedAppMenuOpen = true, advancedAppMenuLauncher = null, advancedAppMenuAbort = null, advancedAppMenuOverlay = null;
    let advancedAppMenuEditing = false, advancedAppMenuOrder = null, advancedAppMenuPopped = '', advancedAppMenuQuietClicksUntil = 0;
    const apps = ${JSON.stringify(APPS)};
    const advancedAppMenuEnabled = () => true, closeAdvancedAppMenu = () => {}, launcherSetupPending = () => false;
    const sidebarShownThin = () => false, setLeftColumnWidthMode = () => {}, openLauncherEntry = () => {};
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
    const cleanText = (value) => String(value ?? '').trim();
    const pinnedAppIds = () => [...window.pinned];
    const appLauncherEntries = () => apps.map(([appId, label]) => ({ key:appId, appId, label, icon:'fa-star', pinnable:true, pinned:window.pinned.includes(appId) }));
    const updateAdvancedAppPin = async (appId, pinned) => { window.pinned = pinned ? [...window.pinned, appId] : window.pinned.filter((id) => id !== appId); };
    const saveSidebarAppOrder = (ids) => {
      window.saves.push(ids);
      advancedAppMenuOrder = null;
      if (window.failSave) return Promise.reject(new Error('Saving failed'));
      window.pinned = [...ids];
      renderAdvancedAppMenu();
      return Promise.resolve();
    };
    ${render}
    window.renderMenu = () => renderAdvancedAppMenu();
  })();
  window.renderMenu();
</script></body></html>`;

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function phone(browser){
  const context = await browser.newContext({ viewport:{ width:433, height:870 }, isMobile:true, hasTouch:true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(harness());
  await page.waitForSelector('.fm-advanced-apps-overlay.is-compact .fm-advanced-app-tile');
  const cdp = await context.newCDPSession(page);
  const touch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x:point.x, y:point.y, id:1 }] : [] });
  const center = (appId) => page.evaluate((id) => {
    const rect = document.querySelector(`[data-pin-drag-app="${id}"]`).getBoundingClientRect();
    return { x:rect.x + rect.width / 2, y:rect.y + rect.height / 2 };
  }, appId);
  const tiles = () => page.evaluate(() => [...document.querySelectorAll('.fm-advanced-apps-grid > .fm-advanced-app-tile')].map((tile) => tile.dataset.pinDragApp));
  // Holds a tile, then drags it onto another in small steps and lets go.
  const drag = async (from, to, { hold = 700, release = 'touchEnd' } = {}) => {
    const a = await center(from), b = await center(to);
    await touch('touchStart', a);
    await page.waitForTimeout(hold);
    for (let step = 1; step <= 10; step += 1) {
      await touch('touchMove', { x:a.x + (b.x - a.x) * step / 10, y:a.y + (b.y - a.y) * step / 10 });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(260);
    if (release === 'touchCancel') await touch('touchCancel');
    else await touch('touchEnd');
    await page.waitForTimeout(150);
  };
  return { page, context, errors, touch, center, tiles, drag };
}

test('holding a pinned app and dragging it puts the left column in a new order (GP-126)', async () => {
  const browser = await launch();
  try {
    const { page, context, errors, tiles, drag } = await phone(browser);
    assert.deepEqual(await tiles(), ['portal.viewer', 'portal.contacts', 'portal.partners', 'portal.scheduling', 'portal.crm', 'portal.stats']);
    // From outside edit mode: the hold starts editing and picks the app up.
    await drag('portal.partners', 'portal.viewer');
    assert.equal(await page.locator('.fm-advanced-apps-overlay').evaluate((node) => node.classList.contains('is-editing')), true);
    assert.deepEqual(await page.evaluate(() => window.saves), [['portal.partners', 'portal.viewer', 'portal.contacts', 'portal.scheduling']]);
    assert.equal(await page.locator('[data-advanced-app-home]').evaluate((node) => node.closest('.fm-advanced-app-tile').dataset.pinDragApp), 'portal.partners', 'the first is the home app');
    assert.equal(await page.locator('.fm-advanced-app-tile.is-pinned [data-advanced-app-pin]').first().getAttribute('aria-pressed'), 'true', 'letting go did not unpin the app');
    assert.match(await page.locator('.fm-advanced-apps-edit-hint').textContent(), /Hold a pinned app and drag it/);

    // In edit mode a shorter hold picks an app up; it goes after the one it is dragged past.
    await drag('portal.contacts', 'portal.scheduling', { hold:400 });
    assert.deepEqual(await page.evaluate(() => window.saves.at(-1)), ['portal.partners', 'portal.viewer', 'portal.scheduling', 'portal.contacts']);
    assert.equal(await page.locator('.fm-advanced-app-tile.is-lifted').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.pinned), ['portal.partners', 'portal.viewer', 'portal.scheduling', 'portal.contacts']);

    // An unpinned app does not move, and nothing moves onto one.
    const saves = await page.evaluate(() => window.saves.length);
    await drag('portal.crm', 'portal.viewer');
    await drag('portal.contacts', 'portal.crm');
    assert.equal(await page.evaluate(() => window.saves.length), saves);
    assert.deepEqual((await tiles()).slice(0, 4), ['portal.partners', 'portal.viewer', 'portal.scheduling', 'portal.contacts']);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('a swipe still scrolls, a cancelled drag puts the apps back and a failed save shows the saved order (GP-126)', async () => {
  const browser = await launch();
  try {
    const { page, context, errors, touch, center, tiles, drag } = await phone(browser);
    const before = await tiles();
    // A quick swipe over the apps is not a hold: nothing is picked up or saved.
    const start = await center('portal.scheduling');
    await touch('touchStart', start);
    for (let step = 1; step <= 6; step += 1) await touch('touchMove', { x:start.x, y:start.y - step * 20 });
    await touch('touchEnd');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.fm-advanced-apps-overlay').evaluate((node) => node.classList.contains('is-editing')), false);
    assert.deepEqual(await page.evaluate(() => window.saves), []);

    await drag('portal.scheduling', 'portal.viewer', { release:'touchCancel' });
    assert.deepEqual(await page.evaluate(() => window.saves), []);
    assert.deepEqual(await tiles(), before, 'a cancelled drag puts the tiles back');

    await page.evaluate(() => { window.failSave = true; });
    await drag('portal.scheduling', 'portal.viewer', { hold:400 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.saves.length), 1);
    assert.deepEqual(await tiles(), before, 'a failed save shows the order that is saved');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
