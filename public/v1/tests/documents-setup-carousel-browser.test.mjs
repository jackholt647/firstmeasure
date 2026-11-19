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

// FM-614: after the style, the template's wording beside it (part `copy`). The fields are the template's copy, typing
// changes the document on the right at once (the same rewrite the finish saves), a field's text is marked in the
// document while it has focus, and the changes are the setup's `copy` selection.
test('the wording step edits the template copy beside its document', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<div class="gxs"><div class="gxs-step" style="height:760px;display:flex;flex-direction:column;padding:24px"><div class="gxs-title-actions"></div><div class="gxs-body" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column"></div></div></div>');
    for (const name of ['doc-model/firstmate-doc-model.js', 'doc-widgets/firstmate-doc-widgets.js', 'doc-renderer/firstmate-doc-renderer.js']) await page.addScriptTag({ content: await lib(name) });
    await page.addScriptTag({ type: 'module', content: (await lib('guided-experiences/documents-setup.js')) + '\nwindow.__mount = mount;' });
    await page.waitForFunction(() => typeof window.__mount === 'function');
    await page.evaluate(() => {
      const definition = FMDocModel.createDocument({ kind: 'document' });
      const text = (id, words, style) => ({ ...FMDocModel.createNode('text'), id, props: { blocks: [{ id: `${id}_b`, type: 'paragraph', align: 'left', ...(style ? { style_ref: style } : {}), runs: [{ text: words, font: { weight: 700 } }] }] } });
      definition.pages[0].children = [text('nd_title', 'Roof replacement proposal', 'h1'), text('nd_intro', 'Complete tear-off and replacement of the roof at the address above.'), text('nd_terms_h', 'Terms', 'h2'), text('nd_terms', 'This proposal is valid for 30 days. Work is scheduled once it is signed.')];
      const fields = [
        { node_id: 'nd_title', role: 'title', text: 'Roof replacement proposal' },
        { node_id: 'nd_intro', role: 'text', text: 'Complete tear-off and replacement of the roof at the address above.' },
        { node_id: 'nd_terms_h', role: 'heading', text: 'Terms' },
        { node_id: 'nd_terms', role: 'text', text: 'This proposal is valid for 30 days. Work is scheduled once it is signed.' }
      ];
      window.changes = []; window.reads = [];
      window.handle = window.__mount(document.querySelector('.gxs-body'), {
        options: { part: 'copy' }, selections: { document_kind: 'invoice', theme_id: 'thm_clean' }, step: { title: 'Check your wording' },
        actions: document.querySelector('.gxs-title-actions'),
        L: (key, text) => text, esc: (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        change: (patch) => window.changes.push(patch),
        read: async (provider, name, ref) => { window.reads.push([provider, name, ref.args]); return { fields, preview: { theme_id: 'thm_clean', resolved_definition: definition, widget_data: {}, theme: null, theme_vars: {} } }; }
      });
    });
    await page.waitForSelector('[data-copy="nd_terms"]');
    assert.deepEqual(await page.evaluate(() => window.reads[0].slice(0, 2)), ['document-setup', 'copy']);
    assert.equal((await page.evaluate(() => window.reads[0][2])).theme_id, 'thm_clean', 'the wording of the style chosen');
    assert.equal(await page.locator('.gxs-title-actions [data-advanced]').count(), 1, 'Advanced sits beside the step title');
    assert.equal(await page.locator('[data-copy="nd_title"]').inputValue(), 'Roof replacement proposal');
    const shown = (id) => page.evaluate((node) => document.querySelector(`.gxd-copy-view [data-node-id="${node}"]`)?.textContent.trim(), id);
    await page.waitForFunction(() => document.querySelector('.gxd-copy-view [data-node-id="nd_title"]'));
    assert.equal(await shown('nd_title'), 'Roof replacement proposal');
    await page.locator('[data-copy="nd_title"]').fill('Your new roof');
    await page.locator('[data-copy="nd_terms"]').fill('Valid for 60 days.\n\nDeposit due at signing.');
    await page.waitForFunction(() => document.querySelector('.gxd-copy-view [data-node-id="nd_title"]')?.textContent.includes('Your new roof'));
    const terms = await page.evaluate(() => [...document.querySelector('.gxd-copy-view [data-node-id="nd_terms"]').querySelectorAll('p,div')].map((node) => node.textContent.trim()).filter(Boolean).join(' | '));
    assert.match(terms, /Valid for 60 days\..*Deposit due at signing\./, 'a blank line makes two paragraphs');
    assert.deepEqual((await page.evaluate(() => window.changes)).at(-1).copy, { nd_title: 'Your new roof', nd_terms: 'Valid for 60 days.\n\nDeposit due at signing.' });
    // Typing it back as it was is no change.
    await page.locator('[data-copy="nd_title"]').fill('Roof replacement proposal');
    assert.deepEqual(Object.keys((await page.evaluate(() => window.changes)).at(-1).copy), ['nd_terms']);
    // The field with focus marks its text in the document.
    await page.locator('[data-copy="nd_intro"]').focus();
    assert.equal(await page.locator('.gxd-copy-view [data-node-id="nd_intro"].gxd-copy-mark').count(), 1);
    assert.equal(await page.evaluate(() => window.handle.valid()), true);
    await page.evaluate(() => window.handle.destroy());
    assert.equal(await page.locator('.gxs-title-actions [data-advanced]').count(), 0, 'Advanced leaves with the step');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// FM-615: the first question's large proposal says it is the one to start with by its size alone (no badge), and a
// question with two answers has the same gutter between its tiles as either side of them, and sits midway between
// the question and the footer (the sheet's own step padding, 8px above and 24px below, framing it as in guided-setup.js).
test('two-answer questions are spaced evenly and the first question has no recommended badge', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addScriptTag({ type: 'module', content: (await lib('guided-experiences/documents-setup.js')) + '\nwindow.__mount = mount;' });
    await page.waitForFunction(() => typeof window.__mount === 'function');
    const show = (part, width) => page.evaluate(({ part, width }) => {
      document.body.innerHTML = `<div class="gxs"><div class="gxs-step" style="width:${width}px;box-sizing:border-box;padding:8px 28px 24px;display:flex;flex-direction:column"><h2 style="margin:4px 0 12px;font-size:22px">Question</h2><div class="gxs-body"></div></div></div>`;
      window.__mount(document.querySelector('.gxs-body'), { options: { part }, selections: {}, step: { title: 'Question' }, L: (key, text) => text, esc: (value) => String(value), change: () => {} });
    }, { part, width });
    await show('kind', 900);
    assert.equal(await page.locator('.gxd-feature').count(), 1, 'the proposal is still the large choice');
    assert.equal(await page.locator('.gxd-badge').count(), 0, 'no "Recommended to start" badge');
    for (const [part, width] of [['presentation', 900], ['detail', 1200], ['scope', 700]]) {
      await show(part, width);
      const m = await page.evaluate(() => {
        const box = (node) => node.getBoundingClientRect(), step = box(document.querySelector('.gxs-step')), title = box(document.querySelector('h2'));
        const [a, b] = [...document.querySelectorAll('.gxd-pair .gxd-tile')].map(box);
        return { left: a.left - step.left - 28, middle: b.left - a.right, right: step.right - 28 - b.right, above: a.top - title.bottom, below: step.bottom - Math.max(a.bottom, b.bottom) };
      });
      assert.ok(Math.abs(m.left - m.middle) <= 1 && Math.abs(m.right - m.middle) <= 1, `${part} at ${width}px: even gutters ${JSON.stringify(m)}`);
      assert.ok(Math.abs(m.above - m.below) <= 4, `${part} at ${width}px: as much room above as below ${JSON.stringify(m)}`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
