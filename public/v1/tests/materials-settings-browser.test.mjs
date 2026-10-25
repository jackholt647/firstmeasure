// The Materials tab's settings gear (materials/settings.js): it opens one modal whose sub-tabs mount the panels the
// Settings app already uses (price book, suppliers, report defaults) and the tab's own resource categories. A sub-tab
// shows only when the organization has its feature on and the person may use it; with none allowed there is no gear.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

const libraries = new URL('../../libraries/', import.meta.url);
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function serve(){
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (!path.startsWith('/libraries/')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head></head><body><div id="rOverlay" class="r-overlay"><div class="r-tab-content" style="display:flex;height:700px"><aside class="r-tab-sidebar" style="width:420px;position:relative"></aside><div class="r-tab-main" id="main" style="flex:1"></div></div></div></body></html>'); return; }
    try {
      const body = await readFile(new URL(path.slice('/libraries/'.length), libraries));
      res.setHeader('Content-Type', types[path.slice(path.lastIndexOf('.'))] || 'text/plain');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Stubs for what the tab and the panels read and write; every call is recorded in window.calls.
async function open(page, port, { perms = true, flags = ['platform.pricebook', 'apps.firstmeasure', 'platform.materials'], supplierTools = false } = {}){
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(({ perms, flags, supplierTools }) => {
    const calls = window.calls = [];
    const TYPES = window.TYPES = [['material', 'Materials'], ['labor', 'Labor'], ['equipment', 'Equipment']].map(([id, name]) => ({ id, name, icon: 'fa-box', color: '#123456', revision: 1 }));
    window.__APP = { userOrgId: 'org' };
    window.FirstMateEmbeddableApps = { registerApp(app){ window.mtApp = app; } };
    window.Portal = { util: { hasPerm: () => perms }, cfg: { userOrgId: 'org' }, modules: {}, navigation: { registerHandler(){}, read: () => ({}) },
      appFlags: { current: () => ({}), has: (group, flag) => flags.includes(`${group}.${flag}`), value: (group, flag, fallback) => flags.includes(`${group}.${flag}`) || fallback } };
    window.DEFAULTS = () => ({ materials: { enabled: true, waste: {}, rules: [] }, labor: { enabled: false, items: [] } });
    window.MaterialsAPI = {
      request: async (path) => { calls.push(['materials-request', path]); return path.includes('measurement-defaults') ? { settings: window.DEFAULTS(), industry: window.DEFAULTS(), catalog: { measurements: [], work_items: [] }, revision: 0, stored: false } : { ledger: { revision: 0, sets: [], orders: [], deliveries: [] } }; },
      resourceTypes: {
        list: async () => ({ resource_types: TYPES }),
        create: async (org, input) => { calls.push(['type-create', input.name]); return { resource_type: { ...input, revision: 1 } }; },
        patch: async (org, id, input) => { calls.push(['type-patch', id, input.name, input.line_item_sources]); return { resource_type: { ...input, revision: (input.expected_revision || 0) + 1 } }; }
      },
      suppliers: { list: async (org) => { calls.push(['suppliers-list', org]); return { suppliers: [] }; } },
      projects: { list: async () => ({ material_lists: [], resource_types: TYPES }) },
      labor: { requirements: async () => ({ status: 'empty', requirements: [], counts: { open: 0, warning: 0, covered: 0 } }) },
      lists: {}, orders: {}
    };
    window.PlatformAPI = {
      baseUrl: () => `${location.origin}/v1/platform`,
      request: async (path) => (path.includes('calculus') ? { ledger: { sets: [] } } : { documents: [] }),
      publication: { list: async () => ({ items: [] }), read: async () => ({ status: 'missing' }) },
      media: { list: async () => ({ media: [] }) }
    };
    // The price book renderer is the shared library; this stands in for it and records mounts.
    window.FirstMatePricebook = { configure(options){ calls.push(['pricebook-configure', options.currentOrganizationId?.()]); }, loadState: async () => {}, getState: () => ({ items: [] }),
      mount(host){ calls.push(['pricebook-mount']); host.innerHTML = '<div data-stub-pricebook>Price book items</div>'; return { destroy(){ calls.push(['pricebook-destroy']); } }; } };
    if (supplierTools) window.FirstMateSupplierTools = { mount(host, options){ calls.push(['supplier-tools', options.surface]); host.innerHTML = '<div data-stub-supplier-tools>Supplier columns</div>'; return { destroy(){} }; } };
    window.FirstMateWidgets = { mount: (stage) => { stage.textContent = '3D model'; return { setVisible(){}, destroy(){} }; } };
    window.activeProject = { id: 'p1', title: 'Saved' };
    window.host = { kind: 'project_workspace', getProject: () => window.activeProject, getActivePreviewTab: () => 'materials' };
  }, { perms, flags, supplierTools });
  await page.addScriptTag({ url: '/libraries/platform-widgets/scope-data.js' });
  await page.addScriptTag({ url: '/libraries/apps/materials/settings.js?v=test' });
  await page.addScriptTag({ url: '/libraries/apps/materials/project.js?v=test' });
  await page.evaluate(() => {
    const project = window.activeProject;
    window.handle = window.mtApp.mount({ project, projectId: project.id, entityId: project.id, orgId: 'org', active: true, panelRoot: document.getElementById('main'), sidebarRoot: document.querySelector('aside'), overlayRoot: document.getElementById('rOverlay'), host: window.host, projectWorkspace: window.host });
  });
  await page.locator('[data-mt-new-category-list="material"]').waitFor();
  return errors;
}

const visiblePane = (page) => page.evaluate(() => [...document.querySelectorAll('[data-mts-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.mtsPane));
const selectedTab = (page) => page.evaluate(() => document.querySelector('.mts-tab[aria-selected="true"]')?.dataset.mtsTab);

test('the gear opens the materials settings modal and its sub-tabs switch, each mounting its existing panel', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const errors = await open(page, server.address().port, { supplierTools: true });
    const gear = page.locator('[data-mt-materials-settings]');
    await gear.waitFor();
    assert.equal(await gear.getAttribute('aria-label'), 'Materials settings');
    assert.equal(await gear.getAttribute('data-fm-tooltip'), 'Materials settings', 'a tooltip, not subtitle text');
    // It is the last of the header actions, at the top right.
    assert.equal(await page.evaluate(() => document.querySelector('.mt-workspace-actions').lastElementChild.matches('[data-mt-materials-settings]')), true);

    await gear.click();
    await page.locator('.mts-overlay.is-open').waitFor();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].map((tab) => tab.dataset.mtsTab)), ['pricebook', 'suppliers', 'defaults', 'categories']);
    assert.equal(await page.evaluate(() => document.querySelector('.mts-modal').getAttribute('role')), 'dialog');
    // Tabs explain themselves with tooltips; the modal has no subtitle text.
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].every((tab) => tab.dataset.fmTooltip.length > 10)), true);
    assert.equal(await selectedTab(page), 'pricebook');
    assert.deepEqual(await visiblePane(page), ['pricebook']);
    await page.locator('[data-stub-pricebook]').waitFor();
    const inkAt = () => page.evaluate(() => document.querySelector('.mts-ink').style.transform);
    const firstInk = await inkAt();

    // Suppliers: the Settings supplier editor is loaded on demand and mounted, with the reserved supplier tools slot.
    await page.locator('[data-mts-tab="suppliers"]').click();
    assert.equal(await selectedTab(page), 'suppliers');
    assert.deepEqual(await visiblePane(page), ['suppliers']);
    await page.locator('[data-mts-pane="suppliers"] .sup-wrap').waitFor();
    await page.locator('[data-mts-supplier-tools] [data-stub-supplier-tools]').waitFor();
    let calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(([kind, org]) => kind === 'suppliers-list' && org === 'org'));
    assert.ok(calls.some(([kind, surface]) => kind === 'supplier-tools' && surface === 'materials_settings'));
    assert.notEqual(await inkAt(), firstInk, 'the active tab indicator moves');

    // Report defaults: the Settings measurement defaults editor, loaded on demand.
    await page.locator('[data-mts-tab="defaults"]').click();
    assert.deepEqual(await visiblePane(page), ['defaults']);
    await page.waitForFunction(() => !!window.FirstMateMeasurementDefaults && !document.querySelector('[data-mts-pane="defaults"] .mts-state .mts-spin'));
    assert.ok((await page.evaluate(() => window.calls)).some(([kind, path]) => kind === 'materials-request' && String(path).includes('measurement-defaults')));

    // Resource categories: the tab's columns, renamed and added through the tab's own writers.
    await page.locator('[data-mts-tab="categories"]').click();
    assert.deepEqual(await visiblePane(page), ['categories']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-mts-cat]')].map((row) => row.dataset.mtsCat)), ['material', 'labor', 'equipment']);
    assert.equal(await page.locator('[data-mts-cat] [data-mts-cat-remove]').count(), 0, 'the built-in columns cannot be removed');
    await page.locator('[data-mts-cat-add] input').fill('Dumpsters');
    await page.locator('[data-mts-cat-add] button').click();
    await page.waitForFunction(() => window.calls.some(([kind, name]) => kind === 'type-create' && name === 'Dumpsters'));
    await page.locator('.mts-cat:has([data-mts-cat-remove]) .mts-cat-name').waitFor();
    assert.equal(await page.locator('.mts-cat:has([data-mts-cat-remove]) .mts-cat-name').inputValue(), 'Dumpsters');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-mt-category-name]')].some((input) => input.value === 'Dumpsters'));
    const rename = page.locator('[data-mts-cat="labor"] .mts-cat-name');
    await rename.fill('Install');
    await rename.press('Tab');
    await page.waitForFunction(() => window.calls.some(([kind, id, name]) => kind === 'type-patch' && id === 'labor' && name === 'Install'));
    await page.locator('[data-mts-cat="material"] [data-mts-cat-source="pricebook"]').click();
    await page.waitForFunction(() => window.calls.some(([kind, id, , sources]) => kind === 'type-patch' && id === 'material' && Array.isArray(sources) && !sources.includes('pricebook')));

    // The arrow keys move between sub-tabs; panels stay mounted while the modal is open.
    await page.locator('[data-mts-tab="categories"]').focus();
    await page.keyboard.press('Home');
    assert.equal(await selectedTab(page), 'pricebook');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await selectedTab(page), 'categories');
    assert.equal((await page.evaluate(() => window.calls)).filter(([kind]) => kind === 'pricebook-mount').length, 1);

    // Escape closes it and unmounts the panels.
    await page.keyboard.press('Escape');
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });
    calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(([kind]) => kind === 'pricebook-destroy'));
    // The close button works the same way on a second open.
    await gear.click();
    await page.locator('.mts-overlay.is-open').waitFor();
    await page.locator('[data-mts-close]').click();
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('sub-tabs follow the organization features and the person; with none allowed there is no gear', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const errors = await open(page, server.address().port, { flags: ['platform.materials'] });
    await page.locator('[data-mt-materials-settings]').click();
    await page.locator('.mts-overlay.is-open').waitFor();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].map((tab) => tab.dataset.mtsTab)), ['categories'], 'no price book, suppliers or report defaults without their features');
    await page.locator('[data-mts-close]').click();
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);

    const denied = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await open(denied, server.address().port, { perms: false });
    await denied.locator('.mt-workspace-actions').waitFor();
    assert.equal(await denied.locator('[data-mt-materials-settings]').count(), 0);
    assert.deepEqual(await denied.evaluate(() => window.FirstMateMaterialsSettings.sections({ categories: {} })), []);
  } finally { await browser.close(); server.close(); }
});
