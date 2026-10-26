import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// The Documents tab and a document on a phone (the platform's 760px window
// breakpoint): the tab's header is one row with a single New that holds
// Upload, New's dialog fills the screen, the document's top bar keeps Preview,
// Send and its menu on one row, the last step keeps Send in view, and the
// as-sent editor types values in a sheet that steps to the next one through
// the same writer. A desktop keeps every one of these as it was.

const libraries = new URL('../../libraries/', import.meta.url);
const read = (path) => readFile(new URL(path, libraries), 'utf8');
const css = await read('apps/documents/documents.css');
const documentsSource = await read('apps/documents/project.js');
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
const DESKTOP = { viewport: { width: 1600, height: 1000 } };
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const between = (from, to) => { const a = documentsSource.indexOf(from); const b = documentsSource.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `slice ${from}`); return documentsSource.slice(a, b); };

async function pageFor(browser, device) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://docs.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif;background:#f8fafc}#tab{position:absolute;inset:0}</style><div id="tab"></div>' });
  });
  await page.goto('http://docs.test/');
  return { page, errors, context };
}

/** The Docs tab over the shared gallery, with the document engine stubbed: New records what it was asked. */
async function mountDocsTab(page) {
  await page.evaluate(() => {
    const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.__APP = { userOrgId: 'org', userId: 'sam' };
    const flags = { current: () => ({ raw: { platform: { documents: true } }, effective: { platform: { documents: true } } }), value: () => true };
    window.Portal = { cfg: window.__APP, appFlags: flags, modules: {}, util: { escapeHtml, injectCSS(id, text) { let el = document.getElementById('css_' + id); if (!el) { el = document.createElement('style'); el.id = 'css_' + id; document.head.append(el); } el.textContent = text; } }, ui: { showToast() {} } };
    window.PlatformAPI = { media: { fileUrl: () => '', thumbnailUrl: () => '' }, projectDocuments: { list: async () => ({ documents: [], uploaded_documents: [] }) } };
    window.created = [];
    const engineApi = { openCreateModal: (prefill, opts) => window.created.push({ prefill, opts }), openDocument() {}, openPreview() {}, getDocs: () => [], refresh() {} };
    window.FirstMateEmbeddableApps = { escapeHtml, registerApp() {}, unregisterApp() {}, mount: async (host, id, context) => { context.params.embed.onReady(engineApi); return { destroy() {}, setActive() {} }; } };
  });
  await page.addScriptTag({ url: '/libraries/apps/photos/feed.js' });
  await page.addScriptTag({ url: '/libraries/apps/docs/project.js' });
  await page.evaluate(() => window.Portal.ProjectDocsTab.mount({ panelRoot: document.querySelector('#tab'), active: true, host: { getProject: () => ({ id: 'p1', name: '2205 Mimosa Pl' }), projectOrgId: () => 'org' } }));
  await page.waitForSelector('[data-gallery-toolbar-action="new_document"]');
}

const headerControls = (page) => page.evaluate(() => {
  const bar = document.querySelector('.fm-docs-gallery .pf-toolbar');
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
  const named = { icon: bar.querySelector('.pf-title i'), search: bar.querySelector('.pf-search'), tags: bar.querySelector('[data-local-tags]'), shown: bar.querySelector('[data-gallery-toolbar-action="shown"]'), new: bar.querySelector('[data-gallery-toolbar-action="new_document"]'), upload: bar.querySelector('.pf-upload') };
  return { bar: { ...box(bar), scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth }, controls: Object.fromEntries(Object.entries(named).map(([key, el]) => [key, shown(el) ? box(el) : null])), phone: document.documentElement.hasAttribute('data-fm-doc-phone') };
});

test('on a phone the Docs header is one row, search opens over it, and New holds Upload', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, PHONE);
    await mountDocsTab(page);
    const { bar, controls, phone } = await headerControls(page);
    assert.equal(phone, true);
    for (const key of ['icon', 'search', 'tags', 'shown', 'new']) assert.ok(controls[key], `${key} is in the header`);
    assert.equal(controls.upload, null, 'Upload is not its own button');
    const tops = Object.values(controls).filter(Boolean).map((entry) => entry.top + entry.height / 2);
    assert.ok(Math.max(...tops) - Math.min(...tops) < 6, `one row: ${JSON.stringify(controls)}`);
    assert.ok(bar.scrollWidth <= bar.clientWidth && Object.values(controls).filter(Boolean).every((entry) => entry.right <= 390), 'nothing runs off the screen');
    assert.ok(bar.height <= 64, `a single header row: ${bar.height}`);
    assert.ok(controls.search.width <= 40, 'search is an icon until it is used');
    await page.locator('.fm-docs-gallery .pf-search').tap();
    await page.waitForTimeout(350);
    const open = await headerControls(page);
    assert.ok(open.controls.search.width >= 300, `search opens across the row: ${open.controls.search.width}`);
    await page.locator('.fm-docs-gallery .pf-search input').fill('roof');
    // Leaving the field folds it back to its icon, marked as in use, and New is there again.
    await page.locator('.fm-docs-gallery .pf-search input').evaluate((input) => input.blur());
    await page.waitForTimeout(100);
    const folded = await headerControls(page);
    assert.ok(folded.controls.search.width <= 40 && folded.controls.new, 'search folds back with its words kept');
    assert.equal(await page.locator('.fm-docs-gallery .pf-search input').inputValue(), 'roof');
    await page.locator('[data-gallery-toolbar-action="new_document"]').tap();
    const created = await page.evaluate(() => window.created.map((entry) => typeof entry.opts?.onUploadFiles));
    assert.deepEqual(created, ['function'], 'New opens the New dialog with Upload in it');
    const picked = await page.evaluate(() => { const input = document.querySelector('[data-doc-upload-input]'); let clicked = false; input.click = () => { clicked = true; }; window.created[0].opts.onUploadFiles(); return clicked; });
    assert.equal(picked, true, 'Upload in the dialog opens the same file picker');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a desktop the Docs header keeps its search field, New and Upload', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, DESKTOP);
    await mountDocsTab(page);
    const { controls, phone } = await headerControls(page);
    assert.equal(phone, false);
    for (const key of ['icon', 'search', 'tags', 'shown', 'new', 'upload']) assert.ok(controls[key], `${key} is in the header`);
    assert.ok(controls.search.width >= 200, 'the search field is a field');
    assert.ok(controls.upload.left > controls.new.right, 'Upload sits after New');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// New's dialog, sliced from the documents app the way document-create-picker-browser.test.mjs does.
const typeCode = between('  const TYPE_META = {', '  function openModal(');
const menuEnd = '    return { el: menu, close };\n  }';
const modalCode = documentsSource.slice(documentsSource.indexOf('  function openModal('), documentsSource.indexOf(menuEnd) + menuEnd.length);
const createCode = between('    async function openCreateModal(', '    function setEditorFocus(');

async function openNewDialog(page, { phone = false } = {}) {
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main></main>`);
  if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.evaluate(({ typeCode, modalCode, createCode }) => {
    window.calls = [];
    const helpers = `
      function cleanText(value){ return String(value ?? '').trim(); }
      function firstText(...values){ for (const value of values) { const text = cleanText(value); if (text) return text; } return ''; }
      const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
      function arrayValue(value){ return Array.isArray(value) ? value : []; }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const state = { departmentId: '', departmentContext: { enabled: false } };
      const orgId = () => 'org';
      const project = () => ({ name: 'Mimosa' });
      const showToast = () => {};
      const errorMessage = (error, fallback) => fallback;
      const api = () => ({ documents: { settings: async () => ({ settings: {} }), pinTemplates: async () => ({}), types: async () => ({ types: [{ id: 'proposal', label: 'Proposal', kind: 'proposal', department_ids: [] }], assignments: {}, kinds: [{ id: 'proposal', label: 'Proposal' }] }) } });
      const loadCatalog = async () => ({ types: [{ id: 'proposal', label: 'Proposal' }] });
      const loadTemplates = async () => [{ id: 'tpl_roof', document_type: 'proposal', name: 'Roof replacement · Itemized proposal', status: 'active', metadata: { default: true }, department_ids: [] }, { id: 'tpl_quick', document_type: 'proposal', name: 'Quick roof quote', status: 'active', metadata: {}, department_ids: [] }];
      const startPaperUpload = (templateId, type) => window.calls.push(['paper', type]);
      const ensureInlineStyles = () => {};
      const ensureWorkflowRuntime = async () => null;
      const normalizeWorkflowRecord = (record) => record;
      const showOpeningScreen = () => ({ cancel(){} });
      const createDocumentRecord = async () => ({ document: { id: 'd1' } });
      const rememberStandaloneDoc = () => {};
      const loadDocs = () => {};
      const openWorkflowView = () => {};
      const templateDefinition = async () => ({ params: {} });
      const paramFieldHtml = () => '';
    `;
    window.openCreate = new Function(`${helpers}\n${typeCode}\n${modalCode}\n${createCode}\nreturn openCreateModal;`)();
    window.openCreate({}, { onUploadFiles: () => window.calls.push(['files']) });
  }, { typeCode, modalCode, createCode });
  await page.waitForSelector('[data-tpl-search]');
}

test('on a phone New fills the screen and offers Upload beside Blank', async () => {
  const browser = await launch();
  try {
    const { page, errors, context } = await pageFor(browser, PHONE);
    await openNewDialog(page, { phone: true });
    await page.waitForTimeout(400);
    const box = await page.locator('.fmdx-create-modal').boundingBox();
    assert.deepEqual([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], [0, 0, 390, 844], 'full screen');
    const buttons = await page.locator('.fmdx-create-top > .fmdx-btn').evaluateAll((list) => list.filter((b) => b.getClientRects().length).map((b) => b.innerText.trim()));
    assert.deepEqual(buttons, ['Blank', 'Upload', 'Scan paper']);
    assert.ok(await page.locator('.fmdx-create-body, [data-create-body]').evaluate((el) => el.scrollWidth <= el.clientWidth), 'nothing scrolls sideways');
    await page.locator('[data-create-files]').tap();
    assert.deepEqual(await page.evaluate(() => window.calls), [['files']]);
    assert.equal(await page.locator('.fmdx-modal-back').count(), 0, 'the dialog closes for the file picker');
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});

test('on a desktop New keeps its dialog, Blank and Upload', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, DESKTOP);
    await openNewDialog(page);
    const box = await page.locator('.fmdx-create-modal').boundingBox();
    assert.ok(box.width <= 1080 && box.x > 0 && box.y > 0, 'a dialog, not the whole screen');
    const buttons = await page.locator('.fmdx-create-top > .fmdx-btn').evaluateAll((list) => list.filter((b) => b.getClientRects().length).map((b) => b.innerText.trim()));
    assert.deepEqual(buttons, ['Blank', 'Upload']);
    await page.locator('[data-create-upload]').click();
    assert.equal(await page.locator('.fmdx-menu').count(), 1, 'Upload still asks what kind of document');
    assert.equal(await page.locator('.fmdx-menu-scrim').count(), 0, 'no phone scrim on a desktop');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// The document's top bar, from renderDocScreen's own markup.
const headerCode = between('      const statusLabel = STATUS_LABELS', "      root.querySelector('[data-fmdx-back]')");
async function docScreen(page, { phone, readOnly = false }) {
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root" style="position:fixed;inset:0"></div>`);
  if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.evaluate(({ headerCode, readOnly }) => {
    const run = new Function('root', 'doc', 'readOnly', 'state', `
      const STATUS_LABELS = { signed: 'Signed' };
      const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      const cleanText = (value) => String(value ?? '').trim();
      const firstText = (...values) => values.map((v) => String(v ?? '').trim()).find(Boolean) || '';
      const isAmendableStatus = (status) => ['signed', 'completed'].includes(status);
      const progressChip = (record) => '<span class="fmdx-chip ' + record.status + '">' + record.status + '</span>';
      const capabilityEnabled = () => true;
      ${headerCode}`);
    run(document.querySelector('#root'), { title: 'Roof replacement · Itemized proposal for 2205 Mimosa Pl', status: readOnly ? 'signed' : 'draft' }, readOnly, { dataPanelOpen: false, trayTab: 'data', wfAgentOpen: false });
    const total = document.querySelector('[data-card-total]');
    if (total) total.textContent = '$23,256.25';
  }, { headerCode, readOnly });
}
const topBar = (page) => page.evaluate(() => {
  const top = document.querySelector('[data-fmdx-editor-screen] > .fmdx-editor-top');
  const shown = [...top.querySelectorAll('button, input, strong')].filter((el) => el.getClientRects().length && getComputedStyle(el).display !== 'none').map((el) => { const r = el.getBoundingClientRect(); return { key: Object.keys(el.dataset).find((k) => k.startsWith('fmdx')) || el.className, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; });
  const r = top.getBoundingClientRect();
  return { height: Math.round(r.height), display: getComputedStyle(top).display, overflow: top.scrollWidth > top.clientWidth, shown };
});

test('on a phone the document top bar is one row: back, title, Preview, Send and the menu', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, PHONE);
    await docScreen(page, { phone: true });
    let bar = await topBar(page);
    const keys = bar.shown.map((entry) => entry.key);
    for (const key of ['fmdxBack', 'fmdxTitle', 'fmdxPreview', 'fmdxSend', 'fmdxMore']) assert.ok(keys.includes(key), `${key} shows: ${keys}`);
    for (const key of ['fmdxDataToggle', 'fmdxAgentBtn', 'fmdxTheme', 'fmdxHistory', 'fmdxPdf']) assert.ok(!keys.includes(key), `${key} is in the menu`);
    assert.ok(bar.height <= 64 && !bar.overflow && bar.shown.every((entry) => entry.right <= 390), `one row that fits: ${JSON.stringify(bar)}`);
    // With Back to steps showing too (the layout editor of a document with steps), it still fits.
    await page.evaluate(() => { document.querySelector('[data-fmdx-mode-toggle]').hidden = false; });
    bar = await topBar(page);
    assert.ok(!bar.overflow && bar.shown.every((entry) => entry.right <= 390), `Back to steps fits as well: ${JSON.stringify(bar.shown)}`);
    // And on a small phone.
    await page.setViewportSize({ width: 360, height: 740 });
    bar = await topBar(page);
    assert.ok(!bar.overflow && bar.shown.every((entry) => entry.right <= 360 - 4), `fits at 360: ${JSON.stringify(bar.shown)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    // A signed document: Amend moves into the menu; Preview and the menu stay.
    await docScreen(page, { phone: true, readOnly: true });
    bar = await topBar(page);
    assert.ok(!bar.shown.some((entry) => entry.key === 'fmdxAmend') && bar.shown.some((entry) => entry.key === 'fmdxMore'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a desktop the document top bar keeps every action', async () => {
  const browser = await launch();
  try {
    const { page } = await pageFor(browser, DESKTOP);
    await docScreen(page, { phone: false });
    const bar = await topBar(page);
    assert.equal(bar.display, 'flex');
    const keys = bar.shown.map((entry) => entry.key);
    for (const key of ['fmdxBack', 'fmdxTitle', 'fmdxDataToggle', 'fmdxAgentBtn', 'fmdxTheme', 'fmdxHistory', 'fmdxPreview', 'fmdxPdf', 'fmdxMore', 'fmdxSend']) assert.ok(keys.includes(key), `${key} shows: ${keys}`);
  } finally { await browser.close(); }
});

async function workflowAtLastStep(page, { phone }) {
  if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { document.querySelector('#tab').innerHTML = '<div class="fmdx-shell"><div class="fmdx-workflow-host"><div class="fmdx-wfrun-main" id="wf"></div></div></div>'; });
  for (const file of ['doc-markdown/firstmate-markdown.js', 'doc-model/firstmate-doc-model.js', 'doc-renderer/firstmate-doc-renderer.js', 'doc-workflow/firstmate-doc-workflow.js']) await page.addScriptTag({ url: '/libraries/' + file });
  await page.evaluate(() => {
    window.ran = [];
    const workflow = { schema_version: 1, name: 'Proposal', contract: { params: { note: { type: 'text' } } }, steps: [
      { id: 'details', title: 'Details', audience: ['internal'], items: [{ kind: 'field', writes: 'params.note', label: 'Note', type: 'text' }] },
      { id: 'review', title: 'Review & send', audience: ['internal'], items: [{ kind: 'field', writes: 'params.note', label: 'Note', type: 'text' }] }
    ] };
    window.handle = FMDocWorkflow.mount(document.querySelector('#wf'), { workflow, audience: 'internal', contract: workflow.contract, labels: { finish: 'Send' },
      state: { params: { note: 'Front slope first' }, outputs: {}, current_step: 'review', completed_steps: ['details'] },
      onWrite() {}, onComplete: () => window.ran.push('send'),
      services: { deliverables: async () => [{ id: 'edit_manually', label: 'Edit manually', icon: 'fa-pen-ruler', quiet: true, run: () => window.ran.push('edit') }, { id: 'present', label: 'Present', icon: 'fa-chalkboard-user', run: () => window.ran.push('present') }] } });
  });
  await page.waitForSelector('[data-fmdw-deliver-run="1"]');
}

test('on a phone the last step keeps Send, Present and Edit manually in view', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, PHONE);
    await workflowAtLastStep(page, { phone: true });
    const foot = await page.evaluate(() => [...document.querySelectorAll('.fmdw-foot button')].filter((b) => b.getClientRects().length && !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; }));
    for (const label of ['Edit manually', 'Present', 'Send']) assert.ok(foot.some((entry) => entry.text === label), `${label}: ${JSON.stringify(foot)}`);
    assert.ok(foot.every((entry) => entry.left >= 0 && entry.right <= 390 && entry.height >= 44), `every footer button is whole and easy to tap: ${JSON.stringify(foot)}`);
    const send = foot.find((entry) => entry.text === 'Send');
    assert.ok(send.right - send.left >= 250, 'Send is the wide button');
    await page.locator('[data-fmdw-deliver-run="1"]').tap();
    assert.deepEqual(await page.evaluate(() => window.ran), ['present']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

async function sentEditor(page) {
  for (const file of ['doc-markdown/firstmate-markdown.js', 'doc-model/firstmate-doc-model.js', 'doc-widgets/firstmate-doc-widgets.js', 'doc-renderer/firstmate-doc-renderer.js', 'doc-sent-editor/firstmate-doc-sent-editor.js']) await page.addScriptTag({ url: '/libraries/' + file });
  await page.evaluate(() => {
    window.PlatformLanguage = { text: (namespace, key, fallback) => fallback };
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
    window.FMDocSentEditor.open({
      title: 'Estimate',
      load: async () => payload(),
      writeInputs: async (writes) => { window.calls.push(['write', writes]); M.setPath(data, writes[0].path, Number(writes[0].text)); return payload(); },
      setTextOverride: async (nodeId, blocks, base) => { window.calls.push(['text', nodeId]); return payload(); },
      actions: [
        { id: 'layout', label: 'Edit layout', icon: 'fa-object-group', run: () => window.calls.push(['layout']) },
        { id: 'pdf', label: 'Download PDF', icon: 'fa-download', run: () => window.calls.push(['pdf']) },
        { id: 'done', label: 'Done', icon: 'fa-check', primary: true, run: (editor) => editor.close() }
      ]
    });
  });
  await page.waitForSelector('.fmdoc-run[data-binding-kind="input"]');
}
const visible = (page, selector) => page.locator(selector).evaluateAll((list) => list.filter((el) => el.getClientRects().length && getComputedStyle(el).display !== 'none').map((el) => el.innerText.trim()));

test('on a phone the as-sent editor keeps Done in view and types values in a sheet that steps through them', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, PHONE);
    await sentEditor(page);
    assert.deepEqual(await visible(page, '[data-fmse-actions] .fmse-btn'), ['Done']);
    assert.equal(await page.locator('.fmse-legend').isVisible(), false, 'the colour key is behind ?');
    await page.locator('[data-fmse-key]').tap();
    assert.equal(await page.locator('.fmse-legend').isVisible(), true);
    await page.locator('[data-fmse-more]').tap();
    assert.deepEqual(await visible(page, '[data-fmse-menu] button'), ['Edit layout', 'Download PDF']);
    assert.equal(await page.locator('.fmse-legend').isVisible(), false, 'one header sheet at a time');
    await page.locator('[data-fmse-menu] button', { hasText: 'Download PDF' }).tap();
    assert.deepEqual(await page.evaluate(() => window.calls), [['pdf']]);
    // A value opens a sheet along the bottom with the value's name.
    await page.locator('.fmdoc-run[data-binding-kind="input"]', { hasText: 'Shingles' }).tap();
    await page.waitForTimeout(350); // it rises in
    const sheet = await page.locator('.fmse-pop').boundingBox();
    assert.ok(Math.round(sheet.x) === 0 && Math.round(sheet.width) === 390 && Math.round(sheet.y + sheet.height) === 844, `a bottom sheet: ${JSON.stringify(sheet)}`);
    assert.equal(await page.locator('.fmse-pop-label').innerText(), 'NAME');
    // The arrow goes to the next value without writing an unchanged one.
    await page.locator('.fmse-pop [data-fmse-step="1"]').tap();
    assert.equal(await page.locator('[data-fmse-input]').inputValue(), '12');
    await page.locator('[data-fmse-input]').fill('14');
    await page.locator('.fmse-pop [data-fmse-apply]').tap();
    await page.waitForFunction(() => window.calls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.calls[1]), ['write', [{ path: 'params.items.0.quantity', text: '14' }]], 'the value is written as data through the same writer');
    await page.waitForSelector('.fmdoc-run[data-binding-kind="input"]:text-is("14")');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a desktop the as-sent editor keeps its actions and colour key in view', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, DESKTOP);
    await sentEditor(page);
    assert.deepEqual(await visible(page, '[data-fmse-actions] .fmse-btn'), ['Edit layout', 'Download PDF', 'Done']);
    assert.equal(await page.locator('.fmse-legend').isVisible(), true);
    assert.equal(await page.locator('[data-fmse-key]').isVisible(), false);
    assert.equal(await page.locator('[data-fmse-more]').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
