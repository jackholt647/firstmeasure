// FM-608: the document setup's style carousel (guided-experiences/documents-setup.js, part `style`). A mouse drag turns
// it as a finger does, a short drag springs back, the card going round comes in from beyond its new side (a copy leaves
// past the old one), the style in the middle opens full screen and Escape (the step's escape()) closes that first, and
// the step asks the sheet to float its Back and Done over it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = (name) => readFile(new URL('../../libraries/' + name, import.meta.url), 'utf8');

test('the style carousel turns with a mouse drag, slides the wrapping card in and opens a style full screen', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<div class="gxs"><div class="gxs-step" style="height:760px;display:flex;flex-direction:column;padding:24px"><div class="gxs-body" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column"></div></div></div>');
    for (const name of ['doc-model/firstmate-doc-model.js', 'doc-widgets/firstmate-doc-widgets.js', 'doc-renderer/firstmate-doc-renderer.js']) await page.addScriptTag({ content: await lib(name) });
    await page.addScriptTag({ type: 'module', content: (await lib('guided-experiences/documents-setup.js')) + '\nwindow.__mount = mount;' });
    await page.waitForFunction(() => typeof window.__mount === 'function');
    await page.evaluate(() => {
      const previews = ['thm_clean', 'thm_margin', 'thm_triangles'].map((id) => ({ theme_id: id, name: id, description: `${id} style`, resolved_definition: FMDocModel.createDocument({ kind: 'document' }), widget_data: {}, theme: null, theme_vars: {} }));
      window.chosen = [];
      window.handle = window.__mount(document.querySelector('.gxs-body'), {
        options: { part: 'style' }, selections: { document_kind: 'invoice' }, step: { title: 'Choose your style' },
        L: (key, text) => text, esc: (value) => String(value), change: (patch) => window.chosen.push(patch.theme_id), read: async () => ({ previews })
      });
    });
    await page.waitForSelector('.gxd-card[data-role=center]');
    const roles = () => page.evaluate(() => [...document.querySelectorAll('.gxd-card:not(.gxd-ghost)')].map((card) => `${card.dataset.theme}:${card.dataset.role}`).join(' '));
    assert.equal(await roles(), 'thm_clean:center thm_margin:side thm_triangles:side');
    assert.ok(await page.evaluate(() => document.querySelector('.gxs-step').hasAttribute('data-float-foot')), 'the sheet floats its Back and Done over this step');
    const box = await page.locator('.gxd-card[data-role=center]').boundingBox();
    const drag = async (dx) => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + box.width / 2 + dx * i / 10, box.y + box.height / 2 + 2);
      await page.mouse.up();
    };
    // A short, slow drag springs back.
    await drag(-20); await page.waitForTimeout(600);
    assert.equal(await roles(), 'thm_clean:center thm_margin:side thm_triangles:side');
    // A long drag to the left brings the next style to the middle; the one on the left (Triangles) goes round to the right.
    await drag(-260);
    assert.equal(await page.locator('.gxd-ghost').count(), 1, 'a copy leaves past the left edge while the card comes round');
    const entering = await page.evaluate(() => getComputedStyle(document.querySelector('.gxd-card[data-theme=thm_triangles]:not(.gxd-ghost)')).opacity);
    assert.ok(Number(entering) < 0.5, `the wrapping card fades in from beyond the right (opacity ${entering})`);
    await page.waitForTimeout(700);
    assert.equal(await roles(), 'thm_clean:side thm_margin:center thm_triangles:side');
    assert.equal(await page.locator('.gxd-ghost').count(), 0);
    assert.equal((await page.evaluate(() => window.chosen)).at(-1), 'thm_margin');
    // The drag's click does not also pick the card it ended over.
    assert.equal(await roles(), 'thm_clean:side thm_margin:center thm_triangles:side');
    // Full screen, then Escape closes only that.
    await page.locator('.gxd-card[data-role=center]').hover();
    await page.locator('.gxd-card[data-role=center] .gxd-expand').click();
    assert.equal(await page.locator('.gxd-view').count(), 1);
    assert.match(await page.locator('.gxd-view-bar').textContent(), /thm_margin/);
    await page.locator('.gxd-view [data-view-go="1"]').click();
    assert.match(await page.locator('.gxd-view-bar').textContent(), /thm_triangles/);
    assert.equal(await page.evaluate(() => window.handle.escape()), true);
    assert.equal(await page.locator('.gxd-view').count(), 0);
    assert.equal(await page.evaluate(() => window.handle.escape()), false, 'with nothing open, Escape is the sheet\'s');
    assert.equal(await roles(), 'thm_clean:side thm_margin:side thm_triangles:center');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
