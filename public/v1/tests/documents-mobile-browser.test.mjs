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

test('on a phone the as-sent editor lists the values by line, types them in a sheet that steps through them, and shows the page at a readable zoom', async () => {
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
    // It opens on Values: every value from the data, once, under the line it is on.
    assert.equal(await page.locator('.fmse-seg [aria-selected="true"]').innerText(), 'Values');
    const groups = await page.locator('.fmse-vgroup').evaluateAll((list) => list.map((group) => ({ title: group.querySelector('h3')?.innerText.trim(), rows: [...group.querySelectorAll('.fmse-vrow')].map((row) => `${row.querySelector('.fmse-vlabel').innerText.trim()}=${row.querySelector('b').innerText.trim()}`) })));
    assert.deepEqual(groups, [{ title: 'Shingles × 12', rows: ['Name=Shingles', 'Quantity=12'] }, { title: 'Vents × 3', rows: ['Name=Vents', 'Quantity=3'] }], 'grouped by line; totals are not offered');
    const rows = await page.locator('.fmse-vrow').evaluateAll((list) => list.map((row) => { const r = row.getBoundingClientRect(); return { h: Math.round(r.height), font: parseFloat(getComputedStyle(row.querySelector('b')).fontSize) }; }));
    assert.ok(rows.every((row) => row.h >= 44 && row.font >= 14), `thumb-sized rows in reading-size text: ${JSON.stringify(rows)}`);
    // A value opens the sheet along the bottom with the value's name.
    await page.locator('.fmse-vrow', { hasText: 'Shingles' }).tap();
    await page.waitForTimeout(350); // it rises in
    const sheet = await page.locator('.fmse-pop').boundingBox();
    assert.ok(Math.round(sheet.x) === 0 && Math.round(sheet.width) === 390 && Math.round(sheet.y + sheet.height) === 844, `a bottom sheet: ${JSON.stringify(sheet)}`);
    assert.equal(await page.locator('.fmse-pop-label').innerText(), 'NAME');
    assert.equal(await page.locator('.fmse-vrow[data-fmse-active]').innerText().then((text) => text.includes('Shingles')), true, 'its row is marked');
    // The arrow goes to the next value without writing an unchanged one.
    await page.locator('.fmse-pop [data-fmse-step="1"]').tap();
    assert.equal(await page.locator('[data-fmse-input]').inputValue(), '12');
    await page.locator('[data-fmse-input]').fill('14');
    await page.locator('.fmse-pop [data-fmse-apply]').tap();
    await page.waitForFunction(() => window.calls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.calls[1]), ['write', [{ path: 'params.items.0.quantity', text: '14' }]], 'the value is written as data through the same writer');
    await page.waitForSelector('.fmse-vrow:has-text("14")');
    assert.equal(await page.locator('.fmse-vgroup h3').first().innerText(), 'Shingles × 14', 'the list follows the new value');
    // A tap elsewhere in the list puts the sheet away.
    await page.locator('.fmse-vrow', { hasText: 'Vents' }).tap();
    await page.waitForSelector('.fmse-pop');
    await page.locator('.fmse-values-hint').tap();
    assert.equal(await page.locator('.fmse-pop').count(), 0);
    // Page: the render at 100% (text at reading size), pannable, with − and +.
    await page.locator('.fmse-seg [data-fmse-view="page"]').tap();
    assert.equal(await page.locator('.fmse-values').isVisible(), false);
    assert.equal(await page.locator('[data-fmse-zoom-fit]').innerText(), '100%');
    const runFont = () => page.locator('.fmdoc-run[data-binding-kind="input"]').first().evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(await runFont() >= 16, 'a value on the page is a readable size');
    assert.ok(await page.locator('[data-fmse-scroll]').evaluate((el) => el.scrollWidth > el.clientWidth), 'the page pans sideways at 100%');
    await page.locator('[data-fmse-zoom-by="1"]').tap();
    assert.equal(await page.locator('[data-fmse-zoom-fit]').innerText(), '125%');
    await page.locator('[data-fmse-zoom-fit]').tap();
    const fit = Number((await page.locator('[data-fmse-zoom-fit]').innerText()).replace('%', ''));
    assert.ok(fit < 100 && fit > 30, `the percentage fits the page to the screen: ${fit}`);
    assert.ok(await page.locator('[data-fmse-scroll]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'a fitted page does not pan sideways');
    await page.locator('[data-fmse-zoom-fit]').tap();
    assert.equal(await page.locator('[data-fmse-zoom-fit]').innerText(), '100%', 'and back to 100%');
    // Two fingers zoom too: spreading them to twice the distance doubles it, about where they are.
    const pinched = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-fmse-scroll]');
      const touch = (id, x, y) => new Touch({ identifier: id, target: scroller, clientX: x, clientY: y });
      const fire = (type, touches) => scroller.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches }));
      fire('touchstart', [touch(1, 150, 400), touch(2, 250, 400)]);
      fire('touchmove', [touch(1, 100, 400), touch(2, 300, 400)]);
      fire('touchend', []);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return document.querySelector('[data-fmse-zoom-fit]').textContent;
    });
    assert.equal(pinched, '200%');
    // A value on the page opens the same sheet.
    await page.locator('[data-fmse-zoom-fit]').tap();
    await page.locator('.fmdoc-run[data-binding-kind="input"]', { hasText: 'Vents' }).tap();
    await page.waitForSelector('.fmse-pop');
    assert.equal(await page.locator('.fmse-pop-label').innerText(), 'NAME');
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

// The steps (doc-workflow inside the document screen) with the documents app's
// phone dropdown, sliced from the app the way the dialogs above are.
const selectMenuCode = between('  const SelectMenu=window.FirstMateSelectMenu', "  SelectMenu.install(");
async function workflowSteps(page, { phone }) {
  if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { document.querySelector('#tab').innerHTML = '<div class="fmdx-shell"><div class="fmdx-workflow-host"><div class="fmdx-wfrun-main" id="wf"></div></div></div>'; });
  for (const file of ['doc-markdown/firstmate-markdown.js', 'doc-model/firstmate-doc-model.js', 'doc-renderer/firstmate-doc-renderer.js', 'doc-workflow/firstmate-doc-workflow.js']) await page.addScriptTag({ url: '/libraries/' + file });
  await page.evaluate((code) => {
    window.FirstMateSelectMenu = undefined;
    new Function(`${code}\nSelectMenu.install('html[data-fm-doc-phone] :is(.fmdx-workflow-host,.fmdx-history-modal)', 'all');`)();
    window.writes = [];
    const choice = (id, name, price, selected) => ({ id, name, quantity: 34, unit: 'sq', unit_price: price, selection: { mode: 'choice', group_id: 'shingle', group_title: 'Shingle', selected } });
    const scope_items = [{ id: 'roof', name: 'Roof replacement', quantity: 1, unit: 'ea', children: [
      { id: 'tear', name: 'Remove existing roofing', quantity: 35, unit: 'sq', unit_price: 85 },
      choice('ns', 'GAF Timberline NS', 348, false), choice('hdz', 'GAF Timberline HDZ', 398, true)
    ] }];
    const workflow = { schema_version: 1, name: 'Proposal', contract: { params: {} }, steps: [
      { id: 'lines', title: 'Line items', audience: ['internal'], items: [{ kind: 'line_items_review', writes: 'params.scope_items', label: 'Line items' }] },
      { id: 'terms', title: 'Payment terms', audience: ['internal'], items: [{ kind: 'payment_schedule', writes: 'params.payment_schedule', label: 'Payment schedule', required: true }] },
      { id: 'review', title: 'Review & send', audience: ['internal'], items: [{ kind: 'review', label: 'Before you send' }] }
    ] };
    window.handle = FMDocWorkflow.mount(document.querySelector('#wf'), { workflow, audience: 'internal', contract: workflow.contract, labels: { finish: 'Send' },
      state: { params: { scope_items, payment_schedule: [{ id: 'deposit', label: 'Deposit', kind: 'percent', percent: 30, due_rule: 'on_signature' }, { id: 'final', label: 'Final payment', kind: 'percent', percent: 70, due_rule: 'project_completion' }] }, outputs: {}, current_step: 'lines', completed_steps: ['lines', 'terms'] },
      onWrite: (path, value) => window.writes.push([path, value]), services: {} });
  }, selectMenuCode);
  await page.waitForSelector('.fmdw-lir-row');
}
const boxes = (page, selector) => page.locator(selector).evaluateAll((list) => list.filter((el) => el.getClientRects().length && getComputedStyle(el).display !== 'none').map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; }));

test('on a phone the steps are one level of cards with thumb-sized fields, the step title once and the platform dropdown', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, PHONE);
    await workflowSteps(page, { phone: true });
    const chips = await boxes(page, '.fmdw-step');
    assert.ok(chips.every((chip) => chip.h >= 44 && chip.w >= 44), `step chips are 44px: ${JSON.stringify(chips)}`);
    // Line items: quantity and price a thumb tall, buttons 40px, nothing past the row.
    const nums = await boxes(page, '.fmdw-lir-row:not(.fmdw-lir-group-head) .fmdw-lir-num');
    assert.ok(nums.length && nums.every((box) => box.h >= 44), `quantity and price are 44px: ${JSON.stringify(nums)}`);
    const buttons = await boxes(page, '.fmdw-lir-actions .fmdw-icon-btn');
    assert.ok(buttons.every((box) => box.h >= 40 && box.w >= 40), `line buttons are 40px: ${JSON.stringify(buttons)}`);
    const head = await page.locator('.fmdw-lir-choice-head').evaluate((el) => { const box = el.getBoundingClientRect(); return { right: Math.round(box.right), children: [...el.children].filter((c) => c.getClientRects().length).map((c) => { const r = c.getBoundingClientRect(); return { cls: c.className, right: Math.round(r.right), h: Math.round(r.height) }; }) }; });
    assert.ok(head.children.every((child) => child.right <= head.right), `the choice line keeps everything inside it: ${JSON.stringify(head)}`);
    assert.ok(head.right <= 390);
    await page.screenshot({ path: process.env.MOBILE_SHOTS ? `${process.env.MOBILE_SHOTS}/test-steps-lines-390.png` : undefined }).catch(() => {});
    // Payment terms: its only question does not repeat the step's name; no card in a card.
    await page.locator('[data-fmdw-step="terms"]').tap();
    await page.waitForSelector('.fmdw-sched-row');
    assert.equal(await page.locator('.fmdw-step-head h2').innerText(), 'Payment terms');
    assert.equal(await page.locator('.fmdw-item-sole .fmdw-field-label').isVisible(), false, 'the label under the title is gone');
    const frames = await page.evaluate(() => ['.fmdw-section', '.fmdw-sched'].map((selector) => getComputedStyle(document.querySelector(selector)).borderTopWidth));
    assert.deepEqual(frames, ['0px', '0px'], 'the section and the question card fall away');
    const fields = await boxes(page, '.fmdw-sched-row :is(input,select)');
    assert.ok(fields.every((box) => box.h >= 44) && fields.every((box) => box.right <= 390), `fields are 44px and fit: ${JSON.stringify(fields)}`);
    const due = await boxes(page, '.fmdw-sched-row:first-child .fmdw-sched-due');
    assert.ok(due[0].w >= 160, `when it is due has room: ${JSON.stringify(due)}`);
    // When it is due opens the platform's dropdown and writes like the select.
    await page.locator('.fmdw-sched-row').first().locator('.fmdw-sched-due').tap({ force: true });
    await page.waitForSelector('[data-fm-select-menu]');
    assert.deepEqual(await page.locator('[data-fm-select-menu] [role=option]').allTextContents(), ['On receipt', 'On signature', 'On completion', 'When invoiced', 'Specific date']);
    if (process.env.MOBILE_SHOTS) await page.screenshot({ path: `${process.env.MOBILE_SHOTS}/test-steps-terms-menu-390.png` });
    await page.locator('[data-fm-select-menu] [role=option]', { hasText: 'On receipt' }).tap();
    const written = await page.evaluate(() => window.writes.filter(([path]) => path === 'params.payment_schedule').at(-1)?.[1]?.[0]?.due_rule);
    assert.equal(written, 'on_receipt', 'the choice is written through the step');
    // Review: options in plain words.
    await page.locator('[data-fmdw-step="review"]').tap();
    await page.waitForSelector('.fmdw-review-checks');
    const check = await page.locator('.fmdw-review-checks').innerText();
    assert.match(check, /Shingle has options\. The price uses the one selected\./);
    assert.doesNotMatch(check, /choice group/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 360, height: 740 });
    await page.locator('[data-fmdw-step="lines"]').tap();
    await page.waitForSelector('.fmdw-lir-row');
    const narrow = await boxes(page, '.fmdw-lir-row, .fmdw-lir-choice-head, .fmdw-lir-num');
    assert.ok(narrow.every((box) => box.right <= 360), `fits at 360: ${JSON.stringify(narrow)}`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a desktop the steps keep their cards, labels and browser selects', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser, DESKTOP);
    await workflowSteps(page, { phone: false });
    await page.locator('[data-fmdw-step="terms"]').click();
    await page.waitForSelector('.fmdw-sched-row');
    assert.equal(await page.locator('.fmdw-item-sole .fmdw-field-label').isVisible(), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.fmdw-section')).borderTopWidth), '1px');
    assert.equal(await page.locator('.fmdw-sched-due').first().evaluate((el) => [getComputedStyle(el).pointerEvents, Math.round(el.getBoundingClientRect().height)].join(' ')), 'auto 34');
    await page.locator('.fmdw-sched-due').first().click();
    assert.equal(await page.locator('[data-fm-select-menu]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// History, sliced from the documents app: automatic step versions in a row are one row with a count.
const historyCode = between('    const HISTORY_CUTS = {', '    function updateSaveState(){');
async function openHistory(page, { phone }) {
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main></main>`);
  if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.evaluate(({ historyCode, modalCode }) => {
    const helpers = `
      function cleanText(value){ return String(value ?? '').trim(); }
      function firstText(...values){ for (const value of values) { const text = cleanText(value); if (text) return text; } return ''; }
      const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
      function arrayValue(value){ return Array.isArray(value) ? value : []; }
      const isPhone = () => document.documentElement.hasAttribute('data-fm-doc-phone');
      const state = { doc: { id: 'd1', status: 'draft', title: 'Proposal' } };
      const orgId = () => 'org';
      const flushAllWrites = async () => {};
      const isReadOnlyStatus = () => false;
      const showToast = () => {};
      const errorMessage = (error, fallback) => fallback;
      const openPreview = () => {};
      const at = (minutes) => new Date(Date.UTC(2026, 9, 26, 14, minutes)).toISOString();
      const revisions = [
        ...Array.from({ length: 10 }, (_, i) => ({ seq: 13 - i, cut: 'workflow', actor_name: 'Sam Rivera', source: { kind: 'person' }, updated_at: at(40 - i), sections: ['workflow_state'] })),
        { seq: 3, cut: 'edit', actor_name: 'Sam Rivera', source: { kind: 'person' }, updated_at: at(20), sections: ['params'] },
        { seq: 2, cut: 'workflow', actor_name: 'Sam Rivera', source: { kind: 'person' }, updated_at: at(10), sections: ['workflow_state'] },
        { seq: 1, cut: 'created', actor_name: 'Sam Rivera', source: { kind: 'person' }, updated_at: at(0), sections: [] }
      ];
      const api = () => ({ revisions: { list: async () => ({ revisions }), diff: async () => ({ diff: { fields: [] } }) } });
    `;
    window.openHistory = new Function(`${helpers}\n${modalCode}\n${historyCode}\nreturn openHistoryMenu;`)();
    window.openHistory();
  }, { historyCode, modalCode });
  await page.waitForSelector('.fmdx-hist-row');
}
const historyRows = (page) => page.locator('[data-hist-list] > .fmdx-hist-row, [data-hist-list] .fmdx-hist-run-items > .fmdx-hist-row').evaluateAll((list) => list.filter((row) => row.getClientRects().length).map((row) => row.querySelector('strong').innerText.replace(/\s+/g, ' ').trim() + ' ' + row.querySelector('em').innerText.trim()));

for (const device of [['phone', PHONE], ['desktop', DESKTOP]]) {
  test(`on a ${device[0]} History shows a run of automatic step versions as one row with a count`, async () => {
    const browser = await launch();
    try {
      const { page, errors } = await pageFor(browser, device[1]);
      await openHistory(page, { phone: device[0] === 'phone' });
      assert.deepEqual(await historyRows(page), ['Workflow step10 versions #4–13', 'Edited #3', 'Workflow step #2', 'Created #1'], 'ten in a row are one row; a single one stays itself');
      assert.match(await page.locator('[data-hist-run] small').first().innerText(), /Sam Rivera · Oct 26, \d+:\d\d (AM|PM) – \d+:\d\d (AM|PM)/, 'who, and from when to when');
      if (process.env.MOBILE_SHOTS && device[0] === 'phone') await page.screenshot({ path: `${process.env.MOBILE_SHOTS}/test-history-390.png` });
      await page.locator('[data-hist-run]').click();
      const open = await historyRows(page);
      assert.equal(open.length, 14, 'it opens to every version');
      assert.equal(await page.locator('[data-hist-run]').getAttribute('aria-expanded'), 'true');
      await page.locator('[data-hist-seq="9"]').click();
      assert.equal(await page.locator('.fmdx-hist-head strong').innerText(), '#9 · Workflow step', 'a version inside it opens like any other');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
