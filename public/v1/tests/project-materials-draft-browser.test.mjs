// The Project tab (Materials) on a new project that is not saved yet, and its loading states.
// A draft shows the whole tab with its empty states and reads nothing about the project; the first write saves the
// project once through the project window (host.ensureProject) and the tab carries on with the new id. While the rail's
// module or the requirements are loading they say so once, styled, and a failure says so instead of spinning.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

const libraries = new URL('../../libraries/', import.meta.url);
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function serve(control){
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (!path.startsWith('/libraries/')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head></head><body><div id="rOverlay" class="r-overlay"><div class="r-tab-content" style="display:flex;height:700px"><aside class="r-tab-sidebar" style="width:420px;position:relative"></aside><div class="r-tab-main" id="main" style="flex:1"></div></div></div></body></html>'); return; }
    if (path.endsWith('/scope-of-work.js')) {
      if (control.failRail) { res.statusCode = 500; res.end('no'); return; }
      await control.railGate;
    }
    try {
      const body = await readFile(new URL(path.slice('/libraries/'.length), libraries));
      res.setHeader('Content-Type', types[path.slice(path.lastIndexOf('.'))] || 'text/plain');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Stubs for everything the tab reads and writes; every call is recorded in window.calls.
async function open(page, port, { projectId = '', requirements = 'empty' } = {}){
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(({ projectId, requirements }) => {
    const calls = window.calls = [];
    const TYPES = [['material', 'Materials'], ['labor', 'Labor'], ['equipment', 'Equipment']].map(([id, name]) => ({ id, name, icon: 'fa-box', color: '#123456', revision: 1 }));
    const lists = window.lists = [];
    window.__APP = { userOrgId: 'org' };
    window.FirstMateEmbeddableApps = { registerApp(app){ window.mtApp = app; } };
    window.Portal = { util: {}, cfg: { userOrgId: 'org' }, modules: {}, navigation: { registerHandler(){}, read: () => ({}) } };
    let releaseRequirements;
    window.requirementsGate = requirements === 'pending' ? new Promise((resolve) => { releaseRequirements = resolve; }) : null;
    window.releaseRequirements = () => releaseRequirements?.();
    window.MaterialsAPI = {
      request: async (path) => { calls.push(['materials-request', path]); return { ledger: { revision: 0, sets: [], orders: [], deliveries: [] } }; },
      resourceTypes: { list: async (org) => { calls.push(['types', org]); return { resource_types: TYPES }; } },
      projects: {
        list: async (org, pid) => { calls.push(['list', pid]); return { material_lists: lists.filter((list) => list.project_id === pid), resource_types: TYPES }; },
        create: async (org, pid, payload) => { calls.push(['create', pid, payload.resource_type]); const list = { ...payload, id: `list_${lists.length}`, project_id: pid, revision: 1, status: 'planning', current_items: [] }; lists.push(list); return { material_list: list }; }
      },
      labor: { requirements: async (org, pid) => {
        calls.push(['requirements', pid]);
        if (requirements === 'fail') throw new Error('The requirements service is down.');
        if (window.requirementsGate) await window.requirementsGate;
        return { status: 'empty', requirements: [], counts: { open: 0, warning: 0, covered: 0 } };
      } },
      lists: {}, orders: {}
    };
    window.PlatformAPI = {
      baseUrl: () => `${location.origin}/v1/platform`,
      request: async (path) => { calls.push(['platform', path]); return path.includes('calculus') ? { ledger: { sets: [] } } : { documents: [] }; },
      publication: { list: async (org, source) => { calls.push(['publication-list', source.target?.projectId]); return { items: [] }; }, read: async (org, source) => { calls.push(['read', source.export, source.target?.projectId]); return { status: 'missing' }; } },
      media: { list: async (org, query) => { calls.push(['media', query.projectId]); return { media: [] }; } }
    };
    window.FirstMateWidgets = { mount: (stage) => { stage.textContent = '3D model'; calls.push(['roof-widget']); return { setVisible(){}, destroy(){} }; } };
    window.activeProject = projectId ? { id: projectId, title: 'Saved' } : null;
    window.host = { kind: 'project_workspace', getProject: () => window.activeProject, getActivePreviewTab: () => 'materials',
      ensureProject: async () => { calls.push(['ensure']); await new Promise((resolve) => setTimeout(resolve, 60)); window.activeProject = { id: 'project_new', title: '' }; return window.activeProject; } };
    // Stands in for the guided setups' hold (a capture listener on the document): it must see a draft's write only
    // after the project is saved.
    document.addEventListener('click', (event) => { if (event.target.closest?.('[data-mt-generate-column]')) calls.push(['document-capture', window.activeProject?.id || '']); }, true);
  }, { projectId, requirements });
  await page.addScriptTag({ url: '/libraries/platform-widgets/scope-data.js' });
  await page.addScriptTag({ url: '/libraries/apps/materials/project.js?v=test' });
  await page.evaluate((projectId) => {
    const project = window.activeProject;
    window.handle = window.mtApp.mount({ project, projectId, entityId: projectId, orgId: 'org', active: true, panelRoot: document.getElementById('main'), sidebarRoot: document.querySelector('aside'), overlayRoot: document.getElementById('rOverlay'), host: window.host, projectWorkspace: window.host });
  }, projectId);
  return errors;
}
const projectCalls = (calls) => calls.filter(([kind]) => !['types', 'roof-widget', 'document-capture'].includes(kind));

test('a draft shows the whole tab with empty states, reads nothing about the project and saves on the first write', async () => {
  const control = { railGate: Promise.resolve() };
  const server = await serve(control);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
    const errors = await open(page, server.address().port);
    await page.locator('[data-scope-draft-empty]').waitFor();
    await page.locator('[data-mt-new-category-list="material"]').waitFor();
    await page.waitForTimeout(300);
    const view = await page.evaluate(() => ({
      railLoading: !!document.querySelector('.mt-rail-state'),
      railText: document.querySelector('aside').textContent,
      tabs: [...document.querySelectorAll('[data-scope-view]')].map((tab) => tab.dataset.scopeView),
      tray: document.querySelector('[data-mt-req-tray]')?.dataset.status,
      traySpinning: !!document.querySelector('[data-mt-req-tray] .mt-spin'),
      trayText: document.querySelector('[data-mt-req-tray] .mt-req-panel')?.textContent,
      columns: [...document.querySelectorAll('.mt-resource-column')].map((column) => column.dataset.resourceType),
      generate: !!document.querySelector('[data-mt-generate-column="material"]'),
      loadingCard: document.querySelector('#main').textContent.includes('Loading scope')
    }));
    assert.equal(view.railLoading, false, 'the rail is drawn, not loading');
    assert.match(view.railText, /No measurements yet/);
    assert.ok(view.tabs.includes('roof') && view.tabs.includes('documents') && view.tabs.includes('aerial'), JSON.stringify(view.tabs));
    assert.equal(view.tray, 'empty');
    assert.equal(view.traySpinning, false, 'requirements do not spin on a draft');
    assert.match(view.trayText, /No requirements yet/);
    assert.match(view.trayText, /Nothing is required yet/);
    assert.ok(view.columns.length >= 2, 'the resource panes are there: ' + JSON.stringify(view.columns));
    assert.equal(view.generate, true, 'Generate is offered on a draft');
    assert.equal(view.loadingCard, false);
    await page.locator('[data-scope-view="documents"]').click();
    assert.match(await page.locator('[data-scope-panel="documents"]').textContent(), /No documents yet/);
    await page.locator('[data-scope-view="aerial"]').click();
    await page.locator('[data-scope-panel="aerial"]').getByText('No project photos yet.').waitFor();
    // Opening the tab and looking around read nothing about the project and saved nothing.
    assert.deepEqual(projectCalls(await page.evaluate(() => window.calls)), []);
    assert.equal(await page.evaluate(() => window.calls.filter(([kind]) => kind === 'roof-widget').length), 0, 'no report viewer reads for a draft');

    // The first write saves the project once, then goes ahead on the saved project.
    await page.locator('[data-mt-new-category-list="material"]').click();
    await page.waitForFunction(() => window.calls.some(([kind]) => kind === 'create'));
    let calls = await page.evaluate(() => window.calls);
    assert.equal(calls.filter(([kind]) => kind === 'ensure').length, 1);
    assert.deepEqual(calls.find(([kind]) => kind === 'create'), ['create', 'project_new', 'material']);
    assert.ok(calls.findIndex(([kind]) => kind === 'ensure') < calls.findIndex(([kind]) => kind === 'list'), 'the lists are read only once the project is saved');
    assert.ok(calls.every(([kind, id]) => !['list', 'requirements', 'create', 'media'].includes(kind) || id === 'project_new'), JSON.stringify(calls));
    await page.locator('[data-mt-list-name]').first().waitFor();
    // Later writes use the saved project; it is never saved again.
    await page.locator('[data-mt-new-category-list="material"]').click();
    await page.waitForFunction(() => window.calls.filter(([kind]) => kind === 'create').length === 2);
    calls = await page.evaluate(() => window.calls);
    assert.equal(calls.filter(([kind]) => kind === 'ensure').length, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('a draft write is held ahead of the guided setup hold, so the setup sees the saved project', async () => {
  const control = { railGate: Promise.resolve() };
  const server = await serve(control);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
    await open(page, server.address().port);
    await page.locator('[data-mt-generate-column="material"]').waitFor();
    await page.evaluate(() => { window.MaterialsAPI.projects.initializeFromScope = async (org, pid) => { window.calls.push(['generate', pid]); return { material_lists: [] }; }; });
    await page.locator('[data-mt-generate-column="material"]').click();
    await page.waitForFunction(() => window.calls.some(([kind]) => kind === 'document-capture'));
    await page.waitForTimeout(200);
    const calls = await page.evaluate(() => window.calls);
    const capture = calls.filter(([kind]) => kind === 'document-capture');
    assert.deepEqual(capture, [['document-capture', 'project_new']], 'the click reaches the document once, after the save: ' + JSON.stringify(calls));
    assert.ok(calls.findIndex(([kind]) => kind === 'ensure') < calls.findIndex(([kind]) => kind === 'document-capture'));
    assert.equal(calls.filter(([kind]) => kind === 'ensure').length, 1);
  } finally { await browser.close(); server.close(); }
});

test('loading says so once and styled; a saved project with no report still loads; failures show an error', async () => {
  let release;
  const control = { railGate: new Promise((resolve) => { release = resolve; }) };
  const server = await serve(control);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
    const errors = await open(page, server.address().port, { projectId: 'p1', requirements: 'pending' });
    await page.locator('[data-mt-rail-state="loading"]').waitFor();
    await page.locator('[data-mt-req-skeleton]').waitFor({ state: 'attached' });
    const loading = await page.evaluate(() => {
      const rail = document.querySelector('[data-mt-rail-state]'), tray = document.querySelector('[data-mt-req-tray]');
      return { role: rail.getAttribute('role'), busy: rail.getAttribute('aria-busy'), spinner: !!rail.querySelector('.mt-spin'), styled: getComputedStyle(rail).display === 'flex' && getComputedStyle(rail.firstElementChild).justifyContent === 'center',
        tabs: rail.querySelectorAll('.mt-rail-state-tabs span').length, text: rail.textContent.trim(),
        status: tray.dataset.status, said: (tray.textContent.match(/Working out what this project requires/g) || []).length, skeletonText: tray.querySelector('[data-mt-req-skeleton]').textContent.trim() };
    });
    assert.deepEqual({ ...loading, text: undefined }, { role: 'status', busy: 'true', spinner: true, styled: true, tabs: loading.tabs, text: undefined, status: 'loading', said: 1, skeletonText: '' });
    assert.ok(loading.tabs >= 3);
    assert.match(loading.text, /Loading measurements, documents and photos/);
    // The rail's module arrives: a saved project with no report shows the report viewer and its empty documents.
    release();
    await page.locator('[data-scope-view="roof"]').waitFor();
    await page.evaluate(() => window.releaseRequirements());
    await page.waitForFunction(() => document.querySelector('[data-mt-req-tray]')?.dataset.status === 'empty');
    const calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(([kind, id]) => kind === 'list' && id === 'p1'));
    assert.ok(calls.some(([kind]) => kind === 'roof-widget'));
    assert.equal(calls.filter(([kind]) => kind === 'ensure').length, 0, 'a saved project is never saved by reading it');
    assert.equal(await page.locator('.mt-rail-state').count(), 0);
    assert.deepEqual(errors, []);

    // The rail's module fails to load: an error with a retry, not a spinner.
    control.failRail = true;
    const failing = await browser.newPage({ viewport: { width: 1500, height: 800 } });
    await open(failing, server.address().port, { projectId: 'p2', requirements: 'fail' });
    await failing.locator('[data-mt-rail-state="error"]').waitFor();
    assert.equal(await failing.locator('[data-mt-rail-state="error"] .mt-spin').count(), 0);
    assert.equal(await failing.locator('[data-mt-rail-retry]').count(), 1);
    await failing.waitForFunction(() => document.querySelector('[data-mt-req-tray]')?.dataset.status === 'error');
    const tray = await failing.evaluate(() => ({ spinning: !!document.querySelector('[data-mt-req-tray] .mt-spin'), text: document.querySelector('[data-mt-req-tray]').textContent }));
    assert.equal(tray.spinning, false);
    assert.match(tray.text, /The requirements service is down\./);
    // Retrying after the module is back draws the rail.
    control.failRail = false;
    control.railGate = Promise.resolve();
    await failing.locator('[data-mt-rail-retry]').click();
    await failing.locator('[data-scope-view="roof"]').waitFor();
  } finally { await browser.close(); server.close(); }
});
