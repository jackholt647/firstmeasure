import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// The as-sent editor (docs/architecture/document-as-sent-editing.md) on a real
// render: data values are typed into, calculated values are not, and edited
// text is saved with its values still bound.

const lib = (path) => readFile(new URL(`../../libraries/${path}`, import.meta.url), 'utf8');
const sources = await Promise.all(['doc-markdown/firstmate-markdown.js', 'doc-model/firstmate-doc-model.js', 'doc-widgets/firstmate-doc-widgets.js', 'doc-renderer/firstmate-doc-renderer.js', 'doc-sent-editor/firstmate-doc-sent-editor.js'].map(lib));
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  for (const content of sources) await page.addScriptTag({ content });
  await page.evaluate(() => {
    const M = window.FMDocModel;
    const doc = M.createDocument();
    doc.computed = { total_cents: 'sum(params.items[].amount_cents)' };
    doc.components = { row: { params: { item: { type: 'line' } }, root: M.createNode('text', { frame: { x: 0, y: 0, w: 400, h: 20 }, props: { blocks: [{ runs: [{ bind: 'item.name' }, { text: ' \u00d7 ' }, { bind: 'item.quantity | qty' }] }] } }) } };
    doc.pages[0].children.push(
      M.createNode('text', { id: 'intro', frame: { x: 72, y: 72, w: 468, h: 40 }, props: { blocks: [{ runs: [{ text: 'Prepared for ' }, { bind: 'customer.name' }] }] } }),
      M.createNode('repeater', { id: 'rows', frame: { x: 72, y: 130, w: 468, h: 80 }, props: { source: '{{params.items}}', component: 'row', as: 'row' } }),
      M.createNode('text', { id: 'total', frame: { x: 72, y: 240, w: 468, h: 30 }, props: { blocks: [{ runs: [{ text: 'Total ' }, { bind: 'computed.total_cents | money' }] }] } })
    );
    const data = { params: { items: [{ name: 'Shingles', quantity: 12, amount_cents: 120000 }, { name: 'Vents', quantity: 3, amount_cents: 9000 }] }, customer: { name: 'Dana' } };
    const payload = () => {
      const resolved = M.resolveBindings(doc, data, { trace: true });
      M.walkNodes(resolved, (node) => { if (node.type === 'text' && !node.generated) node.as_sent = { fingerprint: 'fp', edited: false, conflict: false }; });
      return { resolved_definition: resolved, widget_data: {}, theme: {}, theme_vars: {} };
    };
    window.calls = [];
    window.editor = window.FMDocSentEditor.open({
      title: 'Estimate',
      load: async () => payload(),
      writeInputs: async (writes) => { window.calls.push(['write', writes]); M.setPath(data, writes[0].path, Number(writes[0].text)); return payload(); },
      setTextOverride: async (nodeId, blocks, base) => { window.calls.push(['text', nodeId, blocks, base]); return payload(); },
      actions: [{ id: 'done', label: 'Done', primary: true, run: (editor) => editor.close() }]
    });
  });
  await page.waitForSelector('.fmdoc-run[data-binding-kind="input"]');
  return { page, errors };
}

test('a data value is typed into; a calculated one is not', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser);
    const kinds = await page.$$eval('.fmdoc-run[data-binding-kind]', (spans) => spans.map((span) => [span.textContent, span.getAttribute('data-binding-kind')]));
    assert.deepEqual(kinds, [['Dana', 'upstream'], ['Shingles', 'input'], ['12', 'input'], ['Vents', 'input'], ['3', 'input'], ['$1,290.00', 'derived']]);
    await page.click('.fmdoc-run[data-binding-kind="derived"]');
    assert.match(await page.textContent('.fmse-pop'), /calculated/i);
    const quantity = page.locator('.fmdoc-run[data-binding-kind="input"]', { hasText: '12' });
    await quantity.click();
    const input = page.locator('[data-fmse-input]');
    assert.equal(await input.inputValue(), '12');
    await input.fill('14');
    await input.press('Enter');
    await page.waitForFunction(() => window.calls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.calls[0]), ['write', [{ path: 'params.items.0.quantity', text: '14' }]]);
    await page.waitForSelector('.fmdoc-run[data-binding-kind="input"]:text-is("14")');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('edited text is saved with its values still bound', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser);
    await page.click('[data-node-id="intro"] .fmdoc-run[data-run-index="0"]');
    assert.equal(await page.getAttribute('[data-node-id="intro"]', 'contenteditable'), 'true');
    assert.equal(await page.getAttribute('[data-node-id="intro"] .fmdoc-run[data-run-index="1"]', 'contenteditable'), 'false', 'the bound value is not typed into as text');
    await page.evaluate(() => {
      const span = document.querySelector('[data-node-id="intro"] .fmdoc-run[data-run-index="0"]');
      span.textContent = 'Estimate prepared for ';
    });
    await page.click('.fmse-tools [data-done]');
    await page.waitForFunction(() => window.calls.length === 1);
    const [kind, nodeId, blocks, base] = await page.evaluate(() => window.calls[0]);
    assert.deepEqual([kind, nodeId, base], ['text', 'intro', 'fp']);
    assert.deepEqual(blocks[0].runs, [{ text: 'Estimate prepared for ' }, { bind: 'customer.name' }]);
    // Generated rows have no template text to edit.
    assert.equal(await page.$('[data-node-id^="rows__i0"][data-fmse-text]'), null);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
