import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../../libraries/apps/documents/project.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../../libraries/apps/documents/documents.css', import.meta.url), 'utf8');
const between = (from, to) => { const a = source.indexOf(from); const b = source.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `slice ${from}`); return source.slice(a, b); };
const typeCode = between('  const TYPE_META = {', '  function openModal(');
const menuEnd = '    return { el: menu, close };\n  }';
const modalCode = source.slice(source.indexOf('  function openModal('), source.indexOf(menuEnd.replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n')) + menuEnd.length + (source.includes('\r\n') ? 1 : 0));
const createCode = between('    async function openCreateModal(', '    function setEditorFocus(');

const template = (id, type, name, extra = {}) => ({ id, document_type: type, name, status: 'active', description: name + ' description', metadata: {}, department_ids: [], ...extra });
const TEMPLATES = [
  template('tpl_roof', 'proposal', 'Roof replacement · Itemized proposal', { metadata: { default: true }, department_ids: ['dep_roof'] }),
  template('tpl_quick', 'proposal', 'Quick roof quote', { department_ids: ['dep_roof'] }),
  template('tpl_gutter', 'proposal', 'Gutter proposal', { department_ids: ['dep_gutter'] }),
  template('tpl_contract', 'contract', 'Roofing contract'),
  template('tpl_co', 'change_order', 'Change order'),
  template('tpl_inv', 'invoice', 'Invoice'),
  template('tpl_cert', 'completion_certificate', 'Completion certificate'),
  template('tpl_paper', 'contract', 'Paper contract intake', { metadata: { intake: 'upload' } }),
  // Produced by payments, never started by hand.
  template('tpl_receipt', 'payment_receipt', 'Payment receipt', { metadata: { system: true } }),
  template('tpl_old', 'contract', 'Retired contract', { status: 'archived' })
];

async function open(browser, { pinned = null, viewport = { width: 1280, height: 860 } } = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>${css}</style><main></main>`);
  // project.js sets this on a phone (syncPhoneFlag); the harness loads only the picker.
  if (viewport.width <= 760) await page.evaluate(() => document.documentElement.setAttribute('data-fm-doc-phone', ''));
  await page.evaluate(({ typeCode, modalCode, createCode, TEMPLATES, pinned }) => {
    window.calls = [];
    const helpers = `
      function cleanText(value){ return String(value ?? '').trim(); }
      function firstText(...values){ for (const value of values) { const text = cleanText(value); if (text) return text; } return ''; }
      const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
      function arrayValue(value){ return Array.isArray(value) ? value : []; }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const state = { departmentId: '', departmentContext: { enabled: true, show_selector: true, department_label: 'Department', departments_label: 'Departments', departments: [{ id: 'dep_roof', label: 'Roofing' }, { id: 'dep_gutter', label: 'Gutters' }], member_department_ids: ['dep_roof'] } };
      const orgId = () => 'org';
      const project = () => ({ name: 'Maple Street' });
      const showToast = (...args) => window.calls.push(['toast', ...args]);
      const errorMessage = (error, fallback) => (error && error.message) || fallback;
      const api = () => ({ workflows: { get: async () => { await new Promise((r) => setTimeout(r, 400)); return { definition: { steps: [{ id: 's' }] } }; } }, documents: { settings: async () => ({ settings: { pinned_template_ids: window.__pinned } }), pinTemplates: async (org, ids) => { window.calls.push(['pin', ids]); return { ok: true }; }, types: async () => window.__types, saveTypes: async (org, types, assignments) => { window.calls.push(['types', types, assignments]); window.__types = { ...window.__types, types: types.map((type, index) => ({ ...type, id: type.id || 'new_' + index })), assignments }; return window.__types; } } });
      const loadCatalog = async () => ({ types: [['proposal','Proposal'],['contract','Contract'],['change_order','Change Order'],['invoice','Invoice'],['completion_certificate','Completion Certificate'],['document','Document']].map(([id, label]) => ({ id, label })) });
      const loadTemplates = async () => window.__templates;
      const startPaperUpload = (templateId, type) => window.calls.push(['upload', templateId, type]);
      const ensureInlineStyles = () => {};
      const ensureWorkflowRuntime = () => new Promise((r) => setTimeout(() => r({}), 400));
      const normalizeWorkflowRecord = (record) => record;
      const showOpeningScreen = (title) => { window.calls.push(['opening', title, Math.round(performance.now() - window.__clicked)]); return { cancel(){ window.calls.push(['opening-cancel']); } }; };
      const createDocumentRecord = async (body) => { window.calls.push(['createDoc', body.template_id]); return { document: { id: 'd1' } }; };
      const rememberStandaloneDoc = () => {};
      const loadDocs = () => {};
      const openWorkflowView = (doc) => window.calls.push(['openWorkflow', doc.id]);
      const templateDefinition = async () => ({ params: {} });
      const paramFieldHtml = () => '';
      const capabilityEnabled = () => false;
    `;
    window.__templates = TEMPLATES; window.__pinned = pinned;
    const kinds = [['proposal','Proposal'],['contract','Contract'],['change_order','Change Order'],['invoice','Invoice'],['completion_certificate','Completion Certificate'],['generic','Plain document']];
    window.__types = { types: kinds.map(([id, label]) => ({ id, label: id === 'generic' ? 'Other' : label, kind: id, color: '', icon: '', department_ids: [], archived: false })), assignments: {}, kinds: kinds.map(([id, label]) => ({ id, label })) };
    // Step two is not under test: record that the picker handed over.
    const create = createCode.replace('      async function renderStepTwo(){', '      async function renderStepTwo(){ window.calls.push([\'create\', wizard.type, wizard.template && wizard.template.id]); return;');
    // eslint-disable-next-line no-new-func
    window.openCreate = new Function(`${helpers}\n${typeCode}\n${modalCode}\n${create}\nreturn openCreateModal;`)();
  }, { typeCode, modalCode, createCode, TEMPLATES, pinned });
  await page.evaluate(() => window.openCreate());
  await page.waitForSelector('[data-tpl-search]');
  return { page, errors };
}
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const names = (page, scope) => page.locator(`${scope} .fmdx-tpl strong`).allInnerTexts();

test('New document shows the everyday templates pinned, the user\'s departments, and creates on one click', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser);
    // Never pinned by the organization: a proposal, an invoice, a change order and a completion
    // certificate (FM-562), each one word, its type's name: no type line and no pin.
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Proposal', 'Invoice', 'Change Order', 'Completion Certificate']);
    assert.deepEqual(await page.locator('.fmdx-tpl-row [data-pick-template]').evaluateAll((list) => list.map((el) => el.dataset.pickTemplate)), ['tpl_roof', 'tpl_inv', 'tpl_co', 'tpl_cert']);
    assert.equal(await page.locator('.fmdx-tpl-row small, .fmdx-tpl-row [data-pin-template]').count(), 0, 'no type line, no pin');
    const tints = await page.locator('.fmdx-tpl-row .fmdx-tpl').evaluateAll((list) => list.map((el) => getComputedStyle(el.querySelector('.fmdx-tpl-icon')).backgroundColor));
    assert.equal(new Set(tints).size, 4, `color-coded: ${tints}`);
    // No Blank and no Scan paper: Upload is the one button beside search.
    assert.deepEqual(await page.locator('.fmdx-create-top > .fmdx-btn').evaluateAll((list) => list.filter((b) => b.getClientRects().length).map((b) => b.innerText.trim())), ['Upload']);
    // The library starts on the user's own department; archived templates never show.
    const library = await names(page, '.fmdx-tpl-grid');
    assert.ok(library.includes('Quick roof quote') && !library.includes('Gutter proposal') && !library.includes('Retired contract') && !library.includes('Payment receipt'));
    await page.locator('[data-pick-department="dep_gutter"]').click();
    assert.ok((await names(page, '.fmdx-tpl-grid')).includes('Gutter proposal'));
    // Types are filters with counts; a type with nothing to group is not one.
    assert.equal(await page.locator('.fmdx-fchips [data-pick-type="generic"]').count(), 0);
    await page.locator('.fmdx-fchips [data-pick-type="contract"]').click();
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Paper contract intake', 'Roofing contract']);
    await page.locator('.fmdx-fchips [data-pick-type=""]').click();
    // Search narrows across names and types, and keeps typing focus.
    await page.locator('[data-tpl-search]').pressSequentially('inv');
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Invoice']);
    assert.equal(await page.locator('.fmdx-tpl-row').count(), 0, 'pinned steps aside while searching');
    await page.locator('[data-tpl-search]').fill('');
    // Six compact tiles fit a row at this width.
    const columns = await page.locator('.fmdx-tpl-grid').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.ok(columns >= 4, `columns: ${columns}`);
    // Every type has its own color, and the library reads grouped by type.
    const colors = await page.locator('.fmdx-fchips [data-pick-type]:not([data-pick-type=""])').evaluateAll((list) => list.map((el) => el.style.getPropertyValue('--fmdx-type')));
    assert.equal(new Set(colors).size, colors.length, `distinct colors: ${colors}`);
    const order = await page.locator('.fmdx-tpl-grid .fmdx-tpl small').allInnerTexts();
    assert.deepEqual(order, [...order].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'types are contiguous');
    assert.equal(order.filter((label, index) => index > 0 && label !== order[index - 1] && order.indexOf(label) !== index).length, 0, `grouped by type: ${order}`);
    // The dialog uses the height the window gives it.
    assert.ok(await page.locator('.fmdx-create-modal').evaluate((el) => el.getBoundingClientRect().height) >= 700, 'tall dialog in a tall window');
    // Each type is a headed group, and only the library scrolls.
    assert.deepEqual(await page.locator('.fmdx-tpl-group h3').evaluateAll((list) => list.map((el) => el.childNodes[1].textContent.trim())), ['Proposal', 'Contract', 'Change Order', 'Invoice', 'Completion Certificate']);
    await page.setViewportSize({ width: 1280, height: 420 });
    const scroll = await page.evaluate(() => { const lib = document.querySelector('.fmdx-tpl-scroll'); const body = document.querySelector('[data-create-body]'); const search = document.querySelector('[data-tpl-search]').getBoundingClientRect().top; lib.scrollTop = 400; return { library: lib.scrollTop > 0, body: body.scrollTop, searchStill: Math.round(document.querySelector('[data-tpl-search]').getBoundingClientRect().top) === Math.round(search) }; });
    assert.deepEqual(scroll, { library: true, body: 0, searchStill: true });
    // In a short window the pinned row keeps its full height and nothing scrolls sideways.
    const fit = await page.evaluate(() => { const row = document.querySelector('.fmdx-tpl-row'); const tile = row.querySelector('.fmdx-tpl'); const body = document.querySelector('[data-create-body]'); return { rowHoldsTile: row.clientHeight >= tile.offsetHeight, noSideScroll: body.scrollWidth <= body.clientWidth && document.querySelector('.fmdx-tpl-scroll').scrollWidth <= document.querySelector('.fmdx-tpl-scroll').clientWidth }; });
    assert.deepEqual(fit, { rowHoldsTile: true, noSideScroll: true });
    // A hidden header button really is hidden.
    assert.equal(await page.evaluate(() => { const b = document.createElement('button'); b.className = 'fmdx-btn'; b.hidden = true; document.body.append(b); const shown = getComputedStyle(b).display; b.remove(); return shown; }), 'none');
    await page.setViewportSize({ width: 1280, height: 860 });
    if (process.env.CREATE_SHOT) await page.screenshot({ path: process.env.CREATE_SHOT });
    // One click on a template starts it.
    await page.locator('.fmdx-tpl-grid [data-pick-template="tpl_quick"]').click();
    await page.waitForFunction(() => window.calls.some((call) => call[0] === 'create'));
    assert.deepEqual(await page.evaluate(() => window.calls.find((call) => call[0] === 'create')), ['create', 'proposal', 'tpl_quick']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a phone the pinned templates are a grid of tiles and the library folds away until asked for', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser, { pinned: ['tpl_roof', 'tpl_contract', 'tpl_co', 'tpl_inv'], viewport: { width: 433, height: 870 } });
    // Every pinned tile is in view: two across, a square of four, never a sideways scroll.
    const grid = await page.evaluate(() => {
      const row = document.querySelector('.fmdx-tpl-row');
      const tiles = [...row.querySelectorAll('.fmdx-tpl')].map((el) => el.getBoundingClientRect());
      const box = row.getBoundingClientRect();
      return { columns: getComputedStyle(row).gridTemplateColumns.split(' ').length, rows: new Set(tiles.map((r) => Math.round(r.top))).size, inside: tiles.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1), sideScroll: row.scrollWidth > row.clientWidth };
    });
    assert.deepEqual(grid, { columns: 2, rows: 2, inside: true, sideScroll: false });
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Proposal', 'Contract', 'Change Order', 'Invoice']);
    const top = await page.locator('.fmdx-create-top').evaluate((el) => { const search = el.querySelector('.fmdx-create-search').getBoundingClientRect(); const buttons = [...el.querySelectorAll('.fmdx-btn')].filter((b) => b.getClientRects().length); return { buttons: buttons.map((b) => b.innerText.trim()), oneLine: buttons.every((b) => Math.abs(b.getBoundingClientRect().top - search.top) < 2) }; });
    assert.deepEqual(top, { buttons: ['Upload'], oneLine: true }, 'Upload sits beside search');
    // The library is one button with its count until it is opened.
    assert.equal(await page.locator('.fmdx-tpl-grid').count(), 0, 'library folded');
    assert.equal(await page.locator('[data-pick-type]').count(), 0, 'type filters fold with it');
    const toggle = page.locator('[data-library-toggle]');
    assert.match(await toggle.innerText(), /Show all templates\s*7/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    if (process.env.PHONE_SHOT) await page.screenshot({ path: process.env.PHONE_SHOT });
    await toggle.click();
    assert.ok((await names(page, '.fmdx-tpl-grid')).includes('Quick roof quote'), 'library open');
    assert.equal(await page.locator('[data-library-toggle]').getAttribute('aria-expanded'), 'true');
    await page.locator('[data-library-toggle]').click();
    assert.equal(await page.locator('.fmdx-tpl-grid').count(), 0, 'folds again');
    // A search shows its results whether or not the library is open.
    await page.locator('[data-tpl-search]').pressSequentially('inv');
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Invoice']);
    assert.equal(await page.locator('[data-library-toggle]').count(), 0);
    await page.locator('[data-tpl-search]').fill('');
    assert.equal(await page.locator('.fmdx-tpl-grid').count(), 0, 'folded again once the search is cleared');
    await page.locator('.fmdx-tpl-row [data-pick-template="tpl_inv"]').click();
    await page.waitForFunction(() => window.calls.some((call) => call[0] === 'create'));
    assert.deepEqual(errors, []);
    await page.close();
    // With nothing pinned there is nothing to fold behind.
    const bare = await open(browser, { pinned: [], viewport: { width: 433, height: 870 } });
    assert.equal(await bare.page.locator('[data-library-toggle]').count(), 0);
    assert.ok((await names(bare.page, '.fmdx-tpl-grid')).length > 0);
  } finally { await browser.close(); }
});

test('picking a template with a workflow answers at once and cannot be clicked twice', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser);
    await page.evaluate(() => { window.__templates.find((tpl) => tpl.id === 'tpl_quick').metadata = { default_workflow_id: 'wf_quick' }; });
    const tile = page.locator('.fmdx-tpl-grid [data-pick-template="tpl_quick"]');
    await page.evaluate(() => { window.__clicked = performance.now(); });
    // Two clicks in quick succession, as an impatient hand does.
    await tile.evaluate((el) => { el.click(); el.click(); });
    // The document screen is asked for in the same tick and the dialog steps out of the way.
    const first = await page.evaluate(() => window.calls.filter((call) => call[0] === 'opening'));
    assert.equal(first.length, 1, 'one opening screen');
    assert.equal(first[0][1], 'Quick roof quote');
    assert.ok(first[0][2] < 50, `opening screen after ${first[0][2]}ms`);
    assert.equal(await page.locator('.fmdx-modal-back').evaluate((el) => getComputedStyle(el).display), 'none');
    await page.waitForFunction(() => window.calls.some((call) => call[0] === 'openWorkflow'));
    assert.deepEqual(await page.evaluate(() => window.calls.filter((call) => call[0] === 'createDoc')), [['createDoc', 'tpl_quick']]);
    assert.equal(await page.locator('.fmdx-modal-back').count(), 0, 'dialog closed once the document opens');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('pins are the organization\'s, kept from the library, and Upload goes to paper intake', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser, { pinned: ['tpl_inv'] });
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Invoice']);
    await page.locator('.fmdx-tpl-grid .fmdx-tpl', { hasText: 'Quick roof quote' }).hover();
    await page.locator('.fmdx-tpl-grid [data-pin-template="tpl_quick"]').click();
    await page.locator('.fmdx-tpl-grid .fmdx-tpl', { hasText: 'Roof replacement' }).hover();
    await page.locator('.fmdx-tpl-grid [data-pin-template="tpl_roof"]').click();
    // Two pinned of one type read by their own names; one alone reads as its type.
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Invoice', 'Quick roof quote', 'Roof replacement · Itemized proposal']);
    await page.locator('.fmdx-tpl-grid [data-pin-template="tpl_inv"]').click();
    assert.deepEqual(await page.evaluate(() => window.calls.filter((call) => call[0] === 'pin').map((call) => call[1])), [['tpl_inv', 'tpl_quick'], ['tpl_inv', 'tpl_quick', 'tpl_roof'], ['tpl_quick', 'tpl_roof']]);
    assert.equal(await page.locator('[data-create-blank], [data-create-scan]').count(), 0, 'no Blank, no Scan paper');
    // Upload: no type filter in use, so it asks; the generic type reads as a plain document.
    await page.locator('[data-create-upload]').click();
    assert.match(await page.locator('.fmdx-menu').innerText(), /Completion Certificate[\s\S]*Other/);
    await page.locator('.fmdx-menu [data-menu-type="change_order"]').click();
    assert.deepEqual(await page.evaluate(() => window.calls.find((call) => call[0] === 'upload')), ['upload', '', 'change_order']);
    assert.deepEqual(errors, []);
    await page.close();
    // Upload with a type filter in use needs no question.
    const second = await open(browser, { pinned: [] });
    await second.page.locator('.fmdx-fchips [data-pick-type="contract"]').click();
    await second.page.locator('[data-create-upload]').click();
    assert.deepEqual(await second.page.evaluate(() => window.calls.find((call) => call[0] === 'upload')), ['upload', '', 'contract']);
    assert.equal(await second.page.locator('.fmdx-tpl-row').count(), 0, 'an organization may pin nothing');
  } finally { await browser.close(); }
});

test('document types belong to the organization: renamed, added, given departments, and templates refiled', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser);
    await page.locator('[data-manage-types]').click();
    // Rename Proposal, give Contract to Gutters only, add a type of our own.
    await page.locator('[data-type-row="0"] [data-type-label]').fill('Estimates');
    await page.locator('[data-type-row="0"] [data-type-label]').dispatchEvent('change');
    await page.locator('[data-type-row="1"] [data-type-department="dep_gutter"]').click();
    await page.locator('[data-types-add]').click();
    await page.locator('[data-type-row="6"] [data-type-label]').fill('Warranties');
    await page.locator('[data-type-row="6"] [data-type-label]').dispatchEvent('change');
    await page.locator('[data-types-save]').click();
    await page.waitForSelector('[data-tpl-search]');
    const saved = await page.evaluate(() => window.calls.find((call) => call[0] === 'types'));
    assert.equal(saved[1][0].label, 'Estimates');
    assert.deepEqual(saved[1][1].department_ids, ['dep_gutter']);
    assert.equal(saved[1][6].label, 'Warranties');
    // The picker uses the new names, and a type given to another department is out of this user's view.
    assert.match(await page.locator('.fmdx-fchips [data-pick-type="proposal"]').innerText(), /Estimates/);
    assert.ok(!(await names(page, '.fmdx-tpl-grid')).includes('Roofing contract'), 'Contract now belongs to Gutters');
    // File a template under the new type.
    await page.locator('[data-manage-types]').click();
    await page.locator('[data-template-type="tpl_cert"]').selectOption({ label: 'Warranties' });
    await page.locator('[data-types-save]').click();
    await page.waitForSelector('[data-tpl-search]');
    await page.locator('.fmdx-fchips [data-pick-type="new_6"]').click();
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Completion certificate']);
    if (process.env.TYPES_SHOT) { await page.locator('[data-manage-types]').click(); await page.screenshot({ path: process.env.TYPES_SHOT }); }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
