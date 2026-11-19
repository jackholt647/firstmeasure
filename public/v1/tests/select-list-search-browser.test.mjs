import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* GP-107: the Money receipt review's "Reimburse to" picker lists every person in the organization. The shared select
   list gains an opt-in search box (pinned items stay listed) and a floating placement, so the open list is not cut off
   by the dialog's scrolling body; Escape closes only the list. Lists without the options behave as before. */
const libraries = new URL('../../libraries/', import.meta.url);
const PEOPLE = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, name: `Person ${String(i).padStart(2, '0')}` }))
  .concat([{ id: 'zoe', name: 'Zoë Lambert' }, { id: 'ana', name: 'Ana Zorić' }]);
const PAGE = `<!doctype html><style>
  body{margin:0;height:100vh;font:14px sans-serif}
  .shade{position:absolute;inset:0;backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
  .modal{width:420px;max-height:300px;display:flex;flex-direction:column;overflow:hidden;background:#fff}
  .body{overflow:auto;min-height:0;padding:16px}
  label{display:flex;flex-direction:column;font-weight:700}
  select{height:38px}
</style><div class="shade"><form class="modal" id="form"><div class="body"><div style="height:200px">Receipt</div>
  <label>Reimburse to<select name="reimburse_user" id="who"><option value="">No reimbursement</option>
  ${PEOPLE.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}<option value="__other__">Other person…</option></select></label>
  <label>Plain<select id="plain"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
</div></form></div>`;

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://select.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL(url.pathname.slice('/libraries/'.length), libraries)) });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE });
    });
    await page.goto('http://select.test/');
    await page.addScriptTag({ url: 'http://select.test/libraries/select-list/select-list.js' });
    await page.evaluate(() => {
      // Like the portal's modal stack: Escape from document capture closes the dialog unless already handled.
      window.closedDialog = 0; window.submitted = 0; window.changes = [];
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) window.closedDialog++; }, true);
      document.getElementById('form').addEventListener('submit', (event) => { event.preventDefault(); window.submitted++; });
      const who = document.getElementById('who');
      who.addEventListener('change', () => window.changes.push(who.value));
      window.who = FirstMateSelectList.attach(who, {
        items: [...who.options].map((o) => ({ value: o.value, label: o.textContent, pinned: o.value === '' || o.value === '__other__' })),
        label: 'Reimburse to', floating: true, search: { placeholder: 'Search people', empty: 'No matches' }
      });
      window.plain = FirstMateSelectList.attach(document.getElementById('plain'), { label: 'Plain' });
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

const visibleValues = (page) => page.evaluate(() => [...window.who.menu.querySelectorAll('[role="option"]')].filter((n) => !n.hidden).map((n) => n.dataset.value));

test('typing filters the people, accents ignored, and pinned choices stay listed', async () => {
  await withPage(async (page) => {
    await page.locator('.fm-select-list-trigger').first().click();
    const search = page.locator('.fm-select-list-search');
    assert.equal(await search.evaluate((node) => node === document.activeElement), true, 'the search box has focus when the list opens');
    assert.equal(await search.getAttribute('placeholder'), 'Search people');
    await search.fill('zo');
    assert.deepEqual(await visibleValues(page), ['', 'zoe', 'ana', '__other__']);
    await search.fill('an zo');
    assert.deepEqual(await visibleValues(page), ['', 'ana', '__other__'], 'every word starts a word of the name');
    await search.fill('person 3');
    assert.deepEqual(await visibleValues(page), ['', ...Array.from({ length: 10 }, (_, i) => `u${30 + i}`), '__other__']);
    await search.fill('nobody here');
    assert.deepEqual(await visibleValues(page), ['', '__other__']);
    assert.equal(await page.locator('.fm-select-list-empty').isVisible(), true, '"No matches" shows');
    await search.fill('zoe');
    assert.deepEqual(await visibleValues(page), ['', 'zoe', '__other__'], 'Zoë without the accent');
    await search.fill('lambert');
    assert.equal(await page.locator('.fm-select-list-empty').isVisible(), false);
    await search.press('ArrowDown');
    await search.press('Enter');
    assert.equal(await page.evaluate(() => window.who.select.value), 'zoe', 'Enter picks the highlighted match');
    assert.deepEqual(await page.evaluate(() => [window.changes, window.submitted]), [['zoe'], 0], 'a change event, and Enter does not submit the form');
    assert.equal(await page.evaluate(() => window.who.popup.hidden), true);
    assert.match(await page.locator('.fm-select-list-trigger').first().innerText(), /Zoë Lambert/);
    // Reopening starts from an empty search.
    await page.locator('.fm-select-list-trigger').first().click();
    assert.equal(await search.inputValue(), '');
    assert.equal((await visibleValues(page)).length, PEOPLE.length + 2);
    await page.locator('[role="option"][data-value="u5"]').click();
    assert.equal(await page.evaluate(() => window.who.select.value), 'u5');
  });
});

test('the open list floats over the dialog instead of being cut off by its scrolling body', async () => {
  await withPage(async (page) => {
    await page.locator('.fm-select-list-trigger').first().click();
    const geometry = await page.evaluate(() => {
      const popup = window.who.popup.getBoundingClientRect(), trigger = window.who.button.getBoundingClientRect();
      const body = document.querySelector('.body').getBoundingClientRect();
      const option = window.who.menu.querySelector('[role="option"]:not([hidden])').getBoundingClientRect();
      const hit = document.elementFromPoint(option.left + option.width / 2, option.top + option.height / 2);
      return { popup: { top: popup.top, bottom: popup.bottom, left: popup.left, width: popup.width }, trigger: { top: trigger.top, bottom: trigger.bottom, left: trigger.left, width: trigger.width }, body: { bottom: body.bottom }, hit: hit?.closest('[role="option"]')?.dataset.value, fixed: getComputedStyle(window.who.popup).position };
    });
    assert.equal(geometry.fixed, 'fixed');
    assert.ok(Math.abs(geometry.popup.left - geometry.trigger.left) < 1.5 && Math.abs(geometry.popup.width - geometry.trigger.width) < 1.5, 'aligned with the button');
    assert.ok(geometry.popup.top >= geometry.trigger.bottom || geometry.popup.bottom <= geometry.trigger.top, 'beside the button, not over it');
    assert.ok(geometry.popup.bottom <= 600 && geometry.popup.top >= 0, 'inside the viewport');
    assert.ok(geometry.popup.bottom > geometry.body.bottom || geometry.popup.top < geometry.body.bottom, 'not clipped to the dialog body');
    assert.equal(geometry.hit, '', 'the first option is on top and can be clicked');
  });
});

test('Escape closes only the list, not the dialog around it', async () => {
  await withPage(async (page) => {
    await page.locator('.fm-select-list-trigger').first().click();
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => [window.who.popup.hidden, window.closedDialog, document.activeElement === window.who.button]), [true, 0, true]);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.closedDialog), 1, 'with the list closed, Escape reaches the dialog');
  });
});

test('a list without the options keeps its old shape, and a disabled select cannot be opened', async () => {
  await withPage(async (page) => {
    const plain = page.locator('.fm-select-list-trigger').nth(1);
    await plain.click();
    assert.deepEqual(await page.evaluate(() => [window.plain.popup === window.plain.menu, !!window.plain.filter, window.plain.wrap.querySelectorAll('.fm-select-list-search').length, getComputedStyle(window.plain.menu).position]), [true, false, 0, 'absolute']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.plain.select.value), 'b');
    await page.evaluate(() => { window.plain.select.disabled = true; window.plain.sync(); });
    assert.equal(await plain.isDisabled(), true);
  });
});
