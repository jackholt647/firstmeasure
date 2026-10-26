// Materials settings (materials/settings.js): one set of sub-tabs shown in a project's Materials tab (the gear opens a
// modal) and in Settings › Materials (mountInline). Each sub-tab mounts the panel the Settings app already uses (price
// book, suppliers, calculations) or the Materials tab's resource categories. A sub-tab shows only when the organization
// has its feature on and the person may use it; with none allowed there is no gear and no Settings section. The global
// assistant is docked on the right in a private materials-settings conversation and can be collapsed.
// Set MTS_SHOTS to a directory to save screenshots of both surfaces at 1600x1000 and 1280x800.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

const publicRoot = new URL('../../', import.meta.url);
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf' };
const FONT_AWESOME = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css';
const shots = process.env.MTS_SHOTS || '';

// The page is styled like the portal: fonts.css (which names Montserrat for bare divs, buttons and inputs), the
// platform font on the body, and the Font Awesome version the portal loads.
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="${FONT_AWESOME}" crossorigin="anonymous"><style>body{margin:0;font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f6f8}</style></head><body><div id="rOverlay" class="r-overlay"><div class="r-tab-content" style="display:flex;height:700px"><aside class="r-tab-sidebar" style="width:420px;position:relative"></aside><div class="r-tab-main" id="main" style="flex:1"></div></div></div><div id="settingsPane" style="padding:24px 24px 0"></div></body></html>`;

async function serve(){
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/fonts.css' || path.startsWith('/fonts/') || path.startsWith('/libraries/')) {
      try {
        const body = await readFile(new URL(path.slice(1), publicRoot));
        res.setHeader('Content-Type', types[path.slice(path.lastIndexOf('.'))] || 'text/plain');
        res.end(body);
      } catch { res.statusCode = 404; res.end(); }
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Stubs for what the tab and the panels read and write; every call is recorded in window.calls.
async function stub(page, port, { perms = true, flags = ['platform.pricebook', 'apps.firstmeasure', 'platform.materials', 'apps.assistant'], off = [], supplierTools = 'real', assistant = true } = {}){
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(({ perms, flags, off, assistant }) => {
    const calls = window.calls = [];
    const TYPES = window.TYPES = [['material', 'Materials'], ['labor', 'Labor'], ['equipment', 'Equipment']].map(([id, name]) => ({ id, name, icon: 'fa-box', color: '#123456', revision: 1 }));
    window.__APP = { userOrgId: 'org' };
    window.FirstMateEmbeddableApps = { registerApp(app){ window.mtApp = app; } };
    const known = (group, flag) => flags.includes(`${group}.${flag}`) ? true : off.includes(`${group}.${flag}`) ? false : undefined;
    window.Portal = { util: { hasPerm: () => perms }, cfg: { userOrgId: 'org' }, modules: {}, navigation: { registerHandler(){}, read: () => ({}) },
      appFlags: { current: () => ({}), has: (group, flag) => known(group, flag) === true, value: (group, flag, fallback) => known(group, flag) ?? fallback } };
    window.DEFAULTS = () => ({ materials: { enabled: true, waste: { base_percent: 10, per_cut_foot_percent: 0.4, steep_percent: 4, min_percent: 8, max_percent: 20 }, rules: [
      { key: 'shingles', enabled: true, label: 'Shingles', group: 'Roofing', terms: [{ measurement: 'roof.squares', factor: 1 }], waste: 'roof', package: { unit: 'bundle', coverage: 0.3333 }, product_id: 'p1', product_type: '' },
      { key: 'drip', enabled: true, label: 'Drip edge', group: 'Roofing', terms: [{ measurement: 'roof.eaves', factor: 1 }, { measurement: 'roof.rakes', factor: 1 }], waste: 5, product_id: '', product_type: 'drip edge' }] },
      labor: { enabled: true, items: [{ item: 'tear_off', enabled: true }] } });
    window.CATALOG = { measurements: [{ id: 'roof.squares', label: 'Roof squares', unit: 'sq' }, { id: 'roof.eaves', label: 'Eaves', unit: 'lf' }, { id: 'roof.rakes', label: 'Rakes', unit: 'lf' }], work_items: [{ id: 'tear_off', label: 'Tear off', description: 'Remove the old roof.' }, { id: 'install', label: 'Install', description: 'Install the new roof.' }] };
    window.MaterialsAPI = {
      request: async (path, options = {}) => {
        calls.push(['materials-request', path, options.method || 'GET', options.body]);
        if (path.endsWith('/settings/conversation')) return { thread: { id: 'thread_materials', subject_id: 'materials-settings' } };
        if (path.includes('measurement-defaults')) return options.method === 'PUT' ? { settings: options.body.settings, revision: 1 } : { settings: window.DEFAULTS(), industry: window.DEFAULTS(), catalog: window.CATALOG, revision: 0, stored: false };
        return { ledger: { revision: 0, sets: [], orders: [], deliveries: [] } };
      },
      resourceTypes: {
        list: async () => ({ resource_types: TYPES.map((row) => ({ ...row })) }),
        create: async (org, input) => { calls.push(['type-create', input.name, org]); return { resource_type: { ...input, revision: 1 } }; },
        patch: async (org, id, input) => { calls.push(['type-patch', id, input.name, input.line_item_sources, org]); return { resource_type: { ...input, revision: (input.expected_revision || 0) + 1 } }; },
        archive: async (org, id) => { calls.push(['type-archive', id, org]); return {}; }
      },
      suppliers: { list: async (org) => { calls.push(['suppliers-list', org]); return { suppliers: [{ id: 'sup1', name: 'ABC Supply', revision: 1, offerings: [{ item_id: 'p1', sku: '', price_cents: 3200 }], locations: [] }] }; } },
      projects: { list: async () => ({ material_lists: [], resource_types: TYPES }) },
      labor: { requirements: async () => ({ status: 'empty', requirements: [], counts: { open: 0, warning: 0, covered: 0 } }) },
      lists: {}, orders: {}
    };
    window.PlatformAPI = {
      baseUrl: () => `${location.origin}/v1/platform`,
      request: async (path) => (path.includes('calculus') ? { ledger: { sets: [] } } : { documents: [] }),
      publication: { list: async () => ({ items: [] }), read: async (org, input) => input?.provider === 'materials-inputs' ? { value: [{ id: 'p1', name: 'Architectural shingles', type: 'Shingles' }, { id: 'p2', name: 'Drip edge 10ft', type: 'Drip edge' }] } : { status: 'missing' } },
      media: { list: async () => ({ media: [] }) }
    };
    // The price book renderer is the shared library; this stands in for it and records mounts.
    window.FirstMatePricebook = { configure(options){ calls.push(['pricebook-configure', options.currentOrganizationId?.()]); }, loadState: async () => {}, getState: () => ({ items: [{ id: 'p1', name: 'Architectural shingles', unit: 'bundle', internal_cost: 32 }] }),
      mount(host){ calls.push(['pricebook-mount']); host.innerHTML = '<div data-stub-pricebook>Price book items</div>'; return { destroy(){ calls.push(['pricebook-destroy']); } }; } };
    // The docked agent is the platform assistant's surface renderer; this records how it is mounted.
    if (assistant) window.PlatformAssistant = { mountSurface(host, options){
      calls.push(['assistant-mount', options.orgId]);
      window.assistantOptions = options;
      host.innerHTML = '<div data-stub-assistant style="height:100%;background:#fafafa">Agent</div>';
      const ready = options.loadContext().then((context) => { calls.push(['assistant-thread', context.main_thread.id]); });
      return { ready, destroy(){ calls.push(['assistant-destroy']); } };
    } };
    window.FirstMateWidgets = { mount: (stage) => { stage.textContent = '3D model'; return { setVisible(){}, destroy(){} }; } };
    window.activeProject = { id: 'p1', title: 'Saved' };
    window.host = { kind: 'project_workspace', getProject: () => window.activeProject, getActivePreviewTab: () => 'materials' };
  }, { perms, flags, off, assistant });
  if (supplierTools === 'real') await page.addScriptTag({ url: '/libraries/guided-experiences/supplier-columns.js?v=test' });
  await page.addScriptTag({ url: '/libraries/platform-widgets/scope-data.js' });
  await page.addScriptTag({ url: '/libraries/apps/materials/settings.js?v=test' });
  return errors;
}

async function openTab(page){
  await page.addScriptTag({ url: '/libraries/apps/materials/project.js?v=test' });
  await page.evaluate(() => {
    const project = window.activeProject;
    window.handle = window.mtApp.mount({ project, projectId: project.id, entityId: project.id, orgId: 'org', active: true, panelRoot: document.getElementById('main'), sidebarRoot: document.querySelector('aside'), overlayRoot: document.getElementById('rOverlay'), host: window.host, projectWorkspace: window.host });
  });
  await page.locator('[data-mt-new-category-list="material"]').waitFor();
}

const visiblePane = (page) => page.evaluate(() => [...document.querySelectorAll('[data-mts-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.mtsPane));
const selectedTab = (page) => page.evaluate(() => document.querySelector('.mts-tab[aria-selected="true"]')?.dataset.mtsTab);
const tabIds = (page) => page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].map((tab) => tab.dataset.mtsTab));

// Every element in the shell renders in the page body's font, never fonts.css's Montserrat or a browser default.
async function assertFonts(page, scope){
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate((scope) => {
    const body = getComputedStyle(document.body).fontFamily;
    const wrong = [...document.querySelectorAll(`${scope}, ${scope} *`)].filter((el) => el.getClientRects().length && !el.closest('i, svg, [data-stub-assistant], [data-stub-pricebook]') && !/^(I|SVG|PATH)$/i.test(el.tagName))
      .map((el) => ({ tag: el.tagName, cls: String(el.className).split(' ')[0], font: getComputedStyle(el).fontFamily })).filter((row) => row.font !== body);
    return { body, wrong: wrong.slice(0, 8), count: wrong.length };
  }, scope);
  assert.match(report.body, /^'?Inter/);
  assert.deepEqual(report.wrong, [], `${report.count} elements use another font than the body's (${report.body})`);
}

// Every tab icon is a Font Awesome 6.0 glyph (the portal's version): its ::before has content.
async function assertIcons(page){
  const ready = await page.evaluate(() => [...document.styleSheets].some((sheet) => String(sheet.href).includes('font-awesome')));
  assert.ok(ready, 'Font Awesome loads in the fixture');
  const icons = await page.evaluate(() => [...document.querySelectorAll('.mts-tab i, .mts-agent-toggle i, .mts-mark i')].map((i) => [i.className, getComputedStyle(i, '::before').content]));
  assert.ok(icons.length >= 2);
  for (const [name, content] of icons) assert.ok(content && content !== 'none' && content !== 'normal' && content !== '""', `${name} has a glyph`);
}

async function shot(page, name){
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

test('the gear opens the materials settings modal; its sub-tabs switch, each mounting its existing panel, beside the agent', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = await stub(page, server.address().port);
    await openTab(page);
    const gear = page.locator('[data-mt-materials-settings]');
    await gear.waitFor();
    assert.equal(await gear.getAttribute('aria-label'), 'Materials settings');
    assert.equal(await gear.getAttribute('data-fm-tooltip'), 'Materials settings', 'a tooltip, not subtitle text');
    assert.equal(await page.evaluate(() => document.querySelector('.mt-workspace-actions').lastElementChild.matches('[data-mt-materials-settings]')), true);

    await gear.click();
    await page.locator('.mts-overlay.is-open').waitFor();
    assert.deepEqual(await tabIds(page), ['pricebook', 'suppliers', 'calculations', 'categories']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].map((tab) => tab.textContent.trim())), ['Price book', 'Suppliers', 'Calculations', 'Resource categories']);
    assert.equal(await page.evaluate(() => document.querySelector('.mts-modal').getAttribute('role')), 'dialog');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-mts-tab]')].every((tab) => tab.dataset.fmTooltip.length > 10)), true);
    // It nearly fills the window it opens in, with a small inset.
    await page.waitForTimeout(400);
    const box = await page.locator('.mts-modal').boundingBox();
    assert.ok(box.x >= 16 && box.x <= 24 && box.y >= 16 && box.y <= 24 && 1600 - box.x - box.width <= 24 && 1000 - box.y - box.height <= 24, JSON.stringify(box));
    assert.equal(await selectedTab(page), 'pricebook');
    assert.deepEqual(await visiblePane(page), ['pricebook']);
    await page.locator('[data-stub-pricebook]').waitFor();
    const inkAt = () => page.evaluate(() => document.querySelector('.mts-ink').style.transform);
    const firstInk = await inkAt();

    // The agent is docked on the right, in the person's materials-settings conversation, and told the open sub-tab.
    await page.locator('[data-mts-agent] [data-stub-assistant]').waitFor();
    await page.waitForFunction(() => window.calls.some(([kind, id]) => kind === 'assistant-thread' && id === 'thread_materials'));
    let calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(([kind, path, method]) => kind === 'materials-request' && path === '/organizations/org/settings/conversation' && method === 'POST'));
    assert.ok(calls.some(([kind, org]) => kind === 'assistant-mount' && org === 'org'));
    const agentBox = await page.locator('[data-mts-agent]').boundingBox();
    assert.ok(agentBox.width >= 320 && agentBox.x + agentBox.width >= box.x + box.width - 2, 'the agent is on the right');
    assert.deepEqual(await page.evaluate(() => window.assistantOptions.getContext()), { surface: 'materials_settings', tab: 'pricebook' });
    await assertFonts(page, '.mts-overlay');
    await assertIcons(page);
    await shot(page, 'modal-1600-pricebook');

    // Suppliers: the supplier columns get the organization id as a string, and the Settings supplier editor sits below.
    await page.locator('[data-mts-tab="suppliers"]').click();
    assert.equal(await selectedTab(page), 'suppliers');
    assert.deepEqual(await visiblePane(page), ['suppliers']);
    await page.locator('[data-mts-pane="suppliers"] .sup-wrap').waitFor();
    await page.locator('[data-mts-supplier-tools] .gxsc-col').waitFor();
    calls = await page.evaluate(() => window.calls);
    assert.ok(calls.filter(([kind]) => kind === 'suppliers-list').length >= 2, 'both the columns and the editor list suppliers');
    assert.ok(calls.filter(([kind]) => kind === 'suppliers-list').every(([, org]) => org === 'org'), 'every supplier read names the organization id');
    const supplierText = await page.locator('[data-mts-pane="suppliers"]').innerText();
    assert.doesNotMatch(supplierText, /function|exceeding|max param length|could not/i);
    assert.match(supplierText, /ABC Supply/);
    // The columns have a sensible height and the editor below is fully usable: the pane scrolls as one page.
    const tools = await page.locator('[data-mts-supplier-tools]').boundingBox();
    const editor = await page.locator('[data-mts-pane="suppliers"] .sup-wrap').boundingBox();
    assert.ok(tools.height <= 440, `columns ${tools.height}px`);
    assert.ok(editor.y >= tools.y + tools.height && editor.height >= 460, `editor ${JSON.stringify(editor)}`);
    assert.equal(await page.evaluate(() => window.assistantOptions.getContext().tab), 'suppliers');
    assert.notEqual(await inkAt(), firstInk, 'the active tab indicator moves');
    await assertFonts(page, '.mts-overlay');
    await shot(page, 'modal-1600-suppliers');

    // Calculations: the measurement defaults editor, loaded on demand, compact rows with folded details.
    await page.locator('[data-mts-tab="calculations"]').click();
    assert.deepEqual(await visiblePane(page), ['calculations']);
    await page.locator('[data-mts-pane="calculations"] [data-md-rule="0"]').waitFor();
    assert.ok((await page.evaluate(() => window.calls)).some(([kind, path]) => kind === 'materials-request' && String(path).includes('measurement-defaults')));
    assert.equal(await page.locator('[data-mts-pane="calculations"] select').count(), 0, 'no native dropdowns');
    assert.equal(await page.locator('[data-mts-pane="calculations"] .md-details').count(), 0, 'details start folded');
    assert.equal(await page.locator('[data-mts-pane="calculations"] p').count(), 0, 'explanations are tooltips, not paragraphs');
    // The price book item is a custom dropdown.
    await page.locator('[data-md-rule="1"] [data-md-dd="product"]').click();
    await page.locator('.md-dd-pop .md-dd-opt', { hasText: 'Drip edge 10ft' }).click();
    await page.waitForFunction(() => window.calls.some(([kind, path, method, body]) => kind === 'materials-request' && method === 'PUT' && body?.settings?.materials?.rules?.[1]?.product_id === 'p2'));
    // Details unfold under the row: the measurement and waste choices are a dropdown and segmented controls.
    await page.locator('[data-md-rule="1"] .md-icon[data-md-toggle]').click();
    await page.locator('[data-md-rule="1"] .md-details').waitFor();
    await page.locator('[data-md-rule="1"] [data-md-field="waste_kind"] [data-md-seg="roof"]').click();
    await page.waitForFunction(() => window.calls.some(([kind, , method, body]) => kind === 'materials-request' && method === 'PUT' && body?.settings?.materials?.rules?.[1]?.waste === 'roof'));
    await page.locator('[data-md-rule="1"] [data-md-term="1"] [data-md-dd="measurement"]').click();
    await page.locator('.md-dd-pop .md-dd-opt', { hasText: 'Roof squares' }).click();
    await page.waitForFunction(() => window.calls.some(([kind, , method, body]) => kind === 'materials-request' && method === 'PUT' && body?.settings?.materials?.rules?.[1]?.terms?.[1]?.measurement === 'roof.squares'));
    await page.locator('[data-md-work="install"]').click();
    await page.waitForFunction(() => window.calls.some(([kind, , method, body]) => kind === 'materials-request' && method === 'PUT' && body?.settings?.labor?.items?.some((row) => row.item === 'install' && row.enabled)));
    await assertFonts(page, '.mts-overlay');
    await shot(page, 'modal-1600-calculations');

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

    // The agent collapses and comes back; the panels keep their space.
    const paneWidth = async () => (await page.locator('.mts-panes').boundingBox()).width;
    const before = await paneWidth();
    await page.locator('[data-mts-agent-toggle]').click();
    assert.equal(await page.locator('[data-mts-agent-toggle]').getAttribute('aria-pressed'), 'false');
    await page.waitForTimeout(400);
    assert.ok(await paneWidth() > before + 300, 'collapsing the agent gives its width to the settings');
    await page.locator('[data-mts-agent-toggle]').click();
    assert.equal(await page.locator('[data-mts-agent-toggle]').getAttribute('aria-pressed'), 'true');

    // The arrow keys move between sub-tabs; panels stay mounted while the modal is open.
    await page.locator('[data-mts-tab="categories"]').focus();
    await page.keyboard.press('Home');
    assert.equal(await selectedTab(page), 'pricebook');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await selectedTab(page), 'categories');
    assert.equal((await page.evaluate(() => window.calls)).filter(([kind]) => kind === 'pricebook-mount').length, 1);

    // Escape closes it and unmounts the panels and the agent.
    await page.keyboard.press('Escape');
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });
    calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(([kind]) => kind === 'pricebook-destroy'));
    assert.ok(calls.some(([kind]) => kind === 'assistant-destroy'));
    await gear.click();
    await page.locator('.mts-overlay.is-open').waitFor();
    await page.locator('[data-mts-close]').click();
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });

    // At 1280x800 the modal still fills its window beside the agent.
    if (shots) {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const tab of ['pricebook', 'suppliers', 'calculations']) {
        await gear.click();
        await page.locator('.mts-overlay.is-open').waitFor();
        await page.locator(`[data-mts-tab="${tab}"]`).click();
        await page.waitForTimeout(500);
        await shot(page, `modal-1280-${tab}`);
        await page.keyboard.press('Escape');
        await page.locator('.mts-overlay').waitFor({ state: 'detached' });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('Settings › Materials mounts the same sub-tabs inline, with the organization\'s resource categories and the agent', async () => {
  const company = await readFile(new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');
  // The section is declared once, gated by the same checks, and mounts the shared shell.
  assert.match(company, /const canMaterials = \(window\.FirstMateMaterialsSettings\?\.sections\?\.\(\{ surface:'settings' \}\) \|\| \[\]\)\.length > 0;/);
  assert.match(company, /\{ id:'materials', allowed:canMaterials, icon:'fas fa-boxes-stacked'/);
  assert.match(company, /FirstMateMaterialsSettings\?\.mountInline\?\.\(host, \{ orgId:\(\) => currentOrgId\(\)/);
  assert.match(company, /FirstMateSupplierSettings\.mount\(suppliersPane, \{ orgId:\(\) => currentOrgId\(\),/, 'Settings › Pricebook › Suppliers passes the organization id, not the function');
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[1600, 1000], [1280, 800]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = await stub(page, server.address().port);
      await page.evaluate(() => { document.getElementById('rOverlay').style.display = 'none'; window.inline = window.FirstMateMaterialsSettings.mountInline(document.getElementById('settingsPane'), { orgId: () => 'org' }); });
      await page.locator('[data-mts-shell="settings"] [data-stub-pricebook]').waitFor();
      assert.deepEqual(await tabIds(page), ['pricebook', 'suppliers', 'calculations', 'categories']);
      assert.equal(await page.locator('[data-mts-shell="settings"] [data-mts-close]').count(), 0, 'no close button inside Settings');
      assert.equal(await page.locator('[data-mts-shell="settings"] h2').count(), 0, 'the Settings heading names it');
      await page.locator('[data-mts-shell="settings"] [data-mts-agent] [data-stub-assistant]').waitFor();
      const shell = await page.locator('[data-mts-shell="settings"]').boundingBox();
      assert.ok(shell.y + shell.height <= height && shell.y + shell.height >= height - 40, `the page fills the window: ${JSON.stringify(shell)}`);
      await assertFonts(page, '[data-mts-shell="settings"]');
      await assertIcons(page);
      await shot(page, `settings-${width}-pricebook`);
      await page.locator('[data-mts-tab="suppliers"]').click();
      await page.locator('[data-mts-supplier-tools] .gxsc-col').waitFor();
      await page.locator('[data-mts-pane="suppliers"] .sup-wrap').waitFor();
      assert.doesNotMatch(await page.locator('[data-mts-pane="suppliers"]').innerText(), /function|exceeding|could not/i);
      await shot(page, `settings-${width}-suppliers`);
      await page.locator('[data-mts-tab="calculations"]').click();
      await page.locator('[data-mts-pane="calculations"] [data-md-rule="0"]').waitFor();
      await assertFonts(page, '[data-mts-shell="settings"]');
      await shot(page, `settings-${width}-calculations`);
      // Resource categories in Settings write the organization's resource types directly.
      await page.locator('[data-mts-tab="categories"]').click();
      await page.locator('[data-mts-cat="labor"]').waitFor();
      const rename = page.locator('[data-mts-cat="labor"] .mts-cat-name');
      await rename.fill('Install');
      await rename.press('Tab');
      await page.waitForFunction(() => window.calls.some(([kind, id, name, , org]) => kind === 'type-patch' && id === 'labor' && name === 'Install' && org === 'org'));
      await page.locator('[data-mts-cat-add] input').fill('Dumpsters');
      await page.locator('[data-mts-cat-add] button').click();
      await page.waitForFunction(() => window.calls.some(([kind, name, org]) => kind === 'type-create' && name === 'Dumpsters' && org === 'org'));
      await shot(page, `settings-${width}-categories`);
      await page.evaluate(() => window.inline.destroy());
      assert.equal(await page.locator('[data-mts-shell]').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
});

test('sub-tabs follow the organization features and the person; with none allowed there is no gear and no section', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const errors = await stub(page, server.address().port, { flags: ['platform.materials'], supplierTools: 'none', assistant: false });
    await openTab(page);
    await page.locator('[data-mt-materials-settings]').click();
    await page.locator('.mts-overlay.is-open').waitFor();
    assert.deepEqual(await tabIds(page), ['categories'], 'no price book, suppliers or calculations without their features');
    assert.equal(await page.locator('[data-mts-agent-toggle]').count(), 0, 'no agent without the assistant');
    await page.locator('[data-mts-close]').click();
    await page.locator('.mts-overlay').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);

    // Resource categories is an organization switch (materials.resource_categories); off, the sub-tab is gone.
    const mvp = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await stub(mvp, server.address().port, { flags: ['platform.pricebook', 'apps.firstmeasure', 'platform.materials'], off: ['materials.resource_categories'], supplierTools: 'none', assistant: false });
    assert.deepEqual(await mvp.evaluate(() => window.FirstMateMaterialsSettings.sections({ categories: {} })), ['pricebook', 'suppliers', 'calculations']);
    assert.deepEqual(await mvp.evaluate(() => window.FirstMateMaterialsSettings.sections({ surface: 'settings' })), ['pricebook', 'suppliers', 'calculations']);
    const onlyCategories = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await stub(onlyCategories, server.address().port, { flags: ['platform.materials'], off: ['materials.resource_categories'], supplierTools: 'none', assistant: false });
    assert.deepEqual(await onlyCategories.evaluate(() => window.FirstMateMaterialsSettings.sections({ surface: 'settings' })), [], 'no Settings section when nothing is allowed');

    const denied = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await stub(denied, server.address().port, { perms: false, supplierTools: 'none' });
    await openTab(denied);
    await denied.locator('.mt-workspace-actions').waitFor();
    assert.equal(await denied.locator('[data-mt-materials-settings]').count(), 0);
    assert.deepEqual(await denied.evaluate(() => window.FirstMateMaterialsSettings.sections({ categories: {} })), []);
    assert.equal(await denied.evaluate(() => window.FirstMateMaterialsSettings.mountInline(document.getElementById('settingsPane'), { orgId: 'org' })), null);
  } finally { await browser.close(); server.close(); }
});
