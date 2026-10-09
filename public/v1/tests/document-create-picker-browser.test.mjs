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
  template('tpl_old', 'contract', 'Retired contract', { status: 'archived' })
];

async function open(browser, { pinned = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>${css}</style><main></main>`);
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
      const api = () => ({ documents: { settings: async () => ({ settings: { pinned_template_ids: window.__pinned } }), pinTemplates: async (org, ids) => { window.calls.push(['pin', ids]); return { ok: true }; }, types: async () => window.__types, saveTypes: async (org, types, assignments) => { window.calls.push(['types', types, assignments]); window.__types = { ...window.__types, types: types.map((type, index) => ({ ...type, id: type.id || 'new_' + index })), assignments }; return window.__types; } } });
      const loadCatalog = async () => ({ types: [['proposal','Proposal'],['contract','Contract'],['change_order','Change Order'],['invoice','Invoice'],['completion_certificate','Completion Certificate'],['document','Document']].map(([id, label]) => ({ id, label })) });
      const loadTemplates = async () => window.__templates;
      const startPaperUpload = (templateId, type) => window.calls.push(['upload', templateId, type]);
      const ensureInlineStyles = () => {};
      const templateDefinition = async () => ({ params: {} });
      const paramFieldHtml = () => '';
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
    // Never pinned by the organization: one of each everyday type, in the user's department.
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Roof replacement · Itemized proposal', 'Roofing contract', 'Change order', 'Invoice']);
    // The library starts on the user's own department; archived templates never show.
    const library = await names(page, '.fmdx-tpl-grid');
    assert.ok(library.includes('Quick roof quote') && !library.includes('Gutter proposal') && !library.includes('Retired contract'));
    await page.locator('[data-pick-department="dep_gutter"]').click();
    assert.ok((await names(page, '.fmdx-tpl-grid')).includes('Gutter proposal'));
    // Types are filters with counts; a type with nothing to group is not one.
    assert.equal(await page.locator('.fmdx-fchips [data-pick-type="generic"]').count(), 0);
    await page.locator('.fmdx-fchips [data-pick-type="contract"]').click();
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Roofing contract', 'Paper contract intake']);
    await page.locator('.fmdx-fchips [data-pick-type=""]').click();
    // Search narrows across names and types, and keeps typing focus.
    await page.locator('[data-tpl-search]').pressSequentially('inv');
    assert.deepEqual(await names(page, '.fmdx-tpl-grid'), ['Invoice']);
    assert.equal(await page.locator('.fmdx-tpl-row').count(), 0, 'pinned steps aside while searching');
    await page.locator('[data-tpl-search]').fill('');
    // Six compact tiles fit a row at this width.
    const tops = await page.locator('.fmdx-tpl-grid .fmdx-tpl').evaluateAll((list) => list.map((el) => Math.round(el.getBoundingClientRect().top)));
    assert.ok(tops.filter((top) => top === tops[0]).length >= 6, `tiles on the first row: ${tops.filter((top) => top === tops[0]).length}`);
    if (process.env.CREATE_SHOT) await page.screenshot({ path: process.env.CREATE_SHOT });
    // One click on a template starts it.
    await page.locator('.fmdx-tpl-grid [data-pick-template="tpl_quick"]').click();
    await page.waitForFunction(() => window.calls.some((call) => call[0] === 'create'));
    assert.deepEqual(await page.evaluate(() => window.calls.find((call) => call[0] === 'create')), ['create', 'proposal', 'tpl_quick']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('pins are the organization\'s, Blank asks what kind, and Upload goes to paper intake', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await open(browser, { pinned: ['tpl_inv'] });
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Invoice']);
    await page.locator('.fmdx-tpl-grid .fmdx-tpl', { hasText: 'Change order' }).hover();
    await page.locator('.fmdx-tpl-grid [data-pin-template="tpl_co"]').click();
    assert.deepEqual(await names(page, '.fmdx-tpl-row'), ['Invoice', 'Change order']);
    await page.locator('.fmdx-tpl-row [data-pin-template="tpl_inv"]').click();
    assert.deepEqual(await page.evaluate(() => window.calls.filter((call) => call[0] === 'pin').map((call) => call[1])), [['tpl_inv', 'tpl_co'], ['tpl_co']]);
    // Blank: no type filter in use, so it asks; the generic type reads as a plain document.
    await page.locator('[data-create-blank]').click();
    assert.match(await page.locator('.fmdx-menu').innerText(), /Completion Certificate[\s\S]*Other/);
    await page.locator('.fmdx-menu [data-menu-type="change_order"]').click();
    await page.waitForFunction(() => window.calls.some((call) => call[0] === 'create'));
    assert.deepEqual(await page.evaluate(() => window.calls.find((call) => call[0] === 'create')), ['create', 'change_order', null]);
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
