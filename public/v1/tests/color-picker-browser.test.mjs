import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('shared picker replaces native dialogs and preserves existing color event contracts', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 650 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main style="font-family:Arial"><label>Brand color <input id="color" type="color" value="#123456"><input id="text" value="#123456"></label><input id="disabled" type="color" disabled></main>');
    await page.addScriptTag({ content: await readFile(new URL('../../libraries/color-picker/firstmate-color-picker.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      window.events = []; window.nativePrevented = false;
      for (const type of ['input', 'change']) document.querySelector('#color').addEventListener(type, event => window.events.push([event.type, event.target.value, event.bubbles]));
      document.addEventListener('click', event => { if (event.target.id === 'color') window.nativePrevented = event.defaultPrevented; }, true);
    });
    await page.locator('#color').click();
    assert.equal(await page.getByRole('dialog', { name: 'Choose color' }).count(), 1);
    assert.equal(await page.evaluate(() => window.nativePrevented), true);
    assert.equal(await page.locator('[data-hex]').inputValue(), '#123456');
    await page.evaluate(() => { document.documentElement.style.setProperty('--primary','#ffcc00'); document.documentElement.style.setProperty('--on-primary','#101828'); });
    assert.deepEqual(await page.locator('.fm-color-done').evaluate(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color })), { background: 'rgb(255, 204, 0)', color: 'rgb(16, 24, 40)' });
    await page.locator('[data-hex]').fill('#aabbcc');
    assert.equal(await page.locator('#color').inputValue(), '#aabbcc');
    assert.deepEqual(await page.evaluate(() => window.events), [['input', '#aabbcc', true], ['change', '#aabbcc', true]]);
    await page.locator('[data-hex]').fill(''); await page.locator('[data-hex]').pressSequentially('#fedcba');
    assert.equal(await page.locator('[data-hex]').inputValue(), '#fedcba');
    assert.equal(await page.locator('#color').inputValue(), '#fedcba');
    await page.getByRole('spinbutton', { name: 'Red', exact: true }).fill('');
    await page.getByRole('spinbutton', { name: 'Red', exact: true }).pressSequentially('128');
    assert.equal(await page.getByRole('spinbutton', { name: 'Red', exact: true }).inputValue(), '128');
    assert.equal(await page.locator('#color').inputValue(), '#80dcba');
    await page.locator('[data-hex]').fill('#aabbcc');
    await page.locator('[data-hex]').fill('bad hex'); await page.locator('[data-hex]').press('Tab');
    assert.match(await page.getByRole('status').textContent(), /3 or 6 digit/);
    assert.equal(await page.locator('#color').inputValue(), '#aabbcc');
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    assert.equal(await page.locator('#color').inputValue(), '#123456');
    await page.getByRole('slider', { name: 'Saturation and brightness' }).focus();
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await page.locator('#color').inputValue(), '#123456');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'color');
    // Editing an adjacent hex field must not be mistaken for clicking its label's color input.
    await page.locator('#text').click(); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'color'; input.id = 'dynamic'; input.value = '#0088ff'; document.body.append(input); });
    await page.locator('#dynamic').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-hex]').inputValue(), '#0088ff');
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 380 && box.y + box.height <= 650);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('#dynamic').showPicker());
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.FirstMateColorPicker.open(document.querySelector('#disabled')));
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => {
      const host = document.createElement('section'); host.id = 'rerender';
      host.innerHTML = '<input id="replaced" type="color" value="#111111">'; document.body.append(host);
      window.rerenderEvents = [];
      host.addEventListener('input', event => { window.rerenderEvents.push(['input', event.target.value]); host.innerHTML = `<input id="replaced" type="color" value="${event.target.value}">`; });
      host.addEventListener('change', event => window.rerenderEvents.push(['change', event.target.value]));
    });
    await page.locator('#replaced').click();
    await page.locator('[data-hex]').fill('#112233'); await page.locator('[data-hex]').fill('#223344');
    assert.equal(await page.locator('#replaced').inputValue(), '#223344');
    assert.deepEqual(await page.evaluate(() => window.rerenderEvents), [['input','#112233'],['change','#112233'],['input','#223344'],['change','#223344']]);
    // Some consumers replace the backing control on change rather than input.
    await page.evaluate(() => {
      const host = document.querySelector('#rerender');
      host.replaceWith(host.cloneNode(true));
      const next = document.querySelector('#rerender');
      next.addEventListener('change', event => {
        next.innerHTML = `<input id="replaced" type="color" value="${event.target.value}">`;
      });
      window.FirstMateColorPicker.close();
    });
    await page.locator('#replaced').click();
    const plane = await page.locator('.fm-color-plane').boundingBox();
    await page.mouse.move(plane.x + 20, plane.y + 20);
    await page.mouse.down();
    await page.mouse.move(plane.x + 80, plane.y + 60, { steps: 8 });
    const midway = await page.locator('#replaced').inputValue();
    await page.mouse.move(plane.x + 180, plane.y + 90, { steps: 8 });
    await page.mouse.up();
    assert.notEqual(await page.locator('#replaced').inputValue(), midway);
    assert.equal(await page.getByRole('dialog').count(), 1);
    // A retargeted click after a gesture is not a new outside press.
    await page.locator('body').dispatchEvent('click');
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.locator('#replaced').click();
    await page.locator('#text').click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('color conversions handle primary colors, shorthand, hue wrap and channel boundaries', async () => {
  const source = await readFile(new URL('../../libraries/color-picker/firstmate-color-picker.js', import.meta.url), 'utf8');
  const vm = await import('node:vm'); const context = vm.createContext({}); vm.runInContext(source, context);
  const api = context.FirstMateColorPicker;
  assert.equal(api.normalize('#AbC'), '#aabbcc'); assert.equal(api.normalize('not a color'), null);
  assert.equal(api.rgbToHex([-1, 256, 127.6]), '#00ff80');
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#123456', '#abcdef']) assert.equal(api.rgbToHex(api.hsvToRgb(api.rgbToHsv(api.hexToRgb(hex)))), hex);
  assert.equal(api.rgbToHex(api.hsvToRgb({ h: 360, s: 1, v: 1 })), '#ff0000');
});
