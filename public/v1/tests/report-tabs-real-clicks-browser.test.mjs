// 1M8-205 (reopened) and 1M8-232: real clicks on the report tabs a customer uses, in Chrome.
// The page runs the real measurements app (loaded twice, as index.php and the apps runtime both load it),
// the real navigation, the real tab renderer and the project modal's real opening-tab code from
// project-request/app.js. The host does what the project modal does between clicks: it repaints its header
// (opening tabs, then the report navigation only), the runtime destroys and re-mounts the app into the
// panel's main region, and the project is re-hydrated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const shell = await read('libraries/apps/project-request/app.js');
const measurementsApp = await read('libraries/apps/measurements/project.js');
const slice = (name, through = name) => {
  const start = shell.indexOf('  function ' + name + '(');
  const last = shell.indexOf('  function ' + through + '(', start);
  assert.ok(start >= 0 && last >= 0, name);
  return shell.slice(start, shell.indexOf('\n  }', last) + 4);
};
const shellCode = [slice('projectReportOrderExists', 'openingProjectTabs'), slice('renderOpeningReportTabs')].join('\n');
// The project modal's own report-pane rules, so a mouse click lands on what a customer sees.
const paneCss = shell.slice(shell.indexOf('    .r-measure-body{'), shell.indexOf('\n', shell.indexOf('    .r-measure-pane.active{')));

const project = (id) => ({
  id, address: id + ' Main St', status: 'completed', workflow_state: 'measurement_ordered', has_report: true,
  report_url: `/v1/firstmeasure/projects/${id}/artifacts/Report.pdf`, summary_url: `/v1/firstmeasure/projects/${id}/artifacts/Summary.pdf`,
  xml_url: `/v1/firstmeasure/projects/${id}/artifacts/model_data.xml`, measurement_project: { id, status: 'completed' }
});

async function boot(browser, { support = false, route = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], downloads = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', async request => {
    const url = new URL(request.request().url());
    if (url.pathname.endsWith('model_data.xml')) { downloads.push(url.pathname); return request.fulfill({ contentType: 'application/xml', body: '<DATA_EXPORT/>' }); }
    if (url.pathname.endsWith('.pdf')) return request.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4' });
    return request.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="rOverlay" class="r-overlay active"><header class="r-modal-header"><nav id="rProjectViewerTabs"></nav><div class="modal-shell-actions"></div></header><div class="r-preview-panel active" data-panel="measurements"><div class="r-tab-content"><div class="r-tab-main"></div></div></div></div>' });
  });
  await page.goto('https://portal.test/portal/?tab=projects');
  await page.evaluate(({ support, route }) => {
    // Production's report flags: the Summary tab on, the roof 3D viewer off.
    const flags = { measurement_report_summary: true, roof_model_viewer: false };
    const registered = [];
    window.FirstMateEmbeddableApps = { registerApp: definition => registered.push(definition), registered };
    window.PlatformCommerce = { onReady: fn => fn(), price: () => 7, credit: value => String(value) };
    window.Portal = {
      appFlags: { current: () => ({}), has: (app, flag) => flags[flag] === true, value: (app, flag, fallback) => flag in flags ? flags[flag] : fallback },
      util: { fmUrl: path => 'https://portal.test/v1/firstmeasure/' + path },
      ui: { showToast: (...args) => (window.toasts ||= []).push(args) }
    };
    Object.assign(window, { __support: support, __route: route });
  }, { support, route });
  await page.addStyleTag({ content: '[data-panel="measurements"],.r-tab-content,.r-tab-main{position:relative;height:640px}' + paneCss });
  await page.addScriptTag({ content: await read('libraries/navigation/portal-navigation.js') });
  await page.addScriptTag({ content: await read('portal/scripts/project_viewer.js') });
  await page.evaluate(() => {
    Portal.navigation.registerSchema('project', { history: 'push' });
    Portal.navigation.registerSchema('projectTab', { history: 'push', scope: { project: true } });
    // Without the route case, reportView is out of scope and never survives in the address.
    Portal.navigation.registerSchema('reportView', { default: 'model', history: 'push', scope: { project: true, projectTab: window.__route ? 'measurements' : 'never' } });
  });
  // index.php's copy, then the runtime's copy of the same file under another ?v= key.
  await page.addScriptTag({ content: measurementsApp });
  await page.evaluate(() => { window.__runtimeApp = FirstMateEmbeddableApps.registered.at(-1); });
  await page.addScriptTag({ content: measurementsApp });
  await page.addScriptTag({ content: `
    var activePreviewTab = 'measurements', activeBaseProject = null, requestedWorkflow = 'project', reportOrderState = null, reorderMeasurementProjectId = '';
    const $ = selector => document.querySelector(selector);
    const tab = id => ({ id, label: id, icon: '' });
    function projectViewerTabs(){ return ['map', 'measurements', 'photos'].map(tab); }
    function weatherReportsEnabled(){ return false; }
    function reportFollowupEnabled(){ return !!window.__support; }
    function appFeatureEnabled(app, flag){ return flag === 'measurement_report_summary'; }
    function hasReportOrdered(){ return !!reportOrderState?.ordered; }
    function projectMeasurementsModule(){ return Portal.modules.projectMeasurements; }
    function setActiveMeasurementTab(...args){ return projectMeasurementsModule().setActiveMeasurementTab(...args); }
    function setActivePreviewTab(id){ activePreviewTab = id; Portal.navigation.set({ project: activeBaseProject.id, projectTab: id }, { history: 'replace' }); renderHeader(); }
    // app.js renderWorkflowState's tail: the opening tabs, then only the report navigation.
    function renderHeader(){ renderOpeningReportTabs(); projectMeasurementsModule()?.renderReportNavigation?.(); }
    ${shellCode}
    const host = {
      getProject: () => activeBaseProject, setProject: value => { activeBaseProject = value; },
      getReportOrderState: () => reportOrderState, setReportOrderState: value => { reportOrderState = value; },
      reportNavigationContext: () => ({ ordered: reportOrderExists(), tabs: projectViewerTabs(), activeTab: activePreviewTab }),
      reportFollowupEnabled: () => reportFollowupEnabled(),
      setActivePreviewTab: id => setActivePreviewTab(id)
    };
    const mainRegion = () => document.querySelector('[data-panel="measurements"] .r-tab-main');
    // The runtime's mount: destroy the previous handle, mount the registered definition into the main region.
    window.runtimeMount = () => { const app = window.__runtimeApp; app.mount({ host, roots: { main: mainRegion() }, panelRoot: mainRegion(), active: true }); };
    window.runtimeRemount = () => { Portal.modules.projectMeasurements.reset(); runtimeMount(); };
    // hydrateFromBaseProject for a returned report: order state, opening view, header repaint.
    window.hydrate = () => {
      reportOrderState = { ordered: true, hasReadyReport: true, status: 'completed', reportUrl: activeBaseProject.report_url, summaryUrl: activeBaseProject.summary_url, xmlUrl: activeBaseProject.xml_url };
      // app.js mounts through Portal.modules with the outer panel before every call.
      projectMeasurementsModule().mount({ host, panelRoot: document.querySelector('[data-panel="measurements"]'), active: true });
      projectMeasurementsModule().selectInitialMeasurementTab('standard', { model: true });
      renderHeader();
    };
    window.openProject = next => {
      activeBaseProject = next; activePreviewTab = 'measurements'; reportOrderState = null;
      Portal.navigation.set({ project: next.id, projectTab: 'measurements', reportView: null }, { history: 'push' });
      renderHeader();
      runtimeRemount();
      hydrate();
    };
  ` });
  return { page, errors, downloads };
}

// What the customer sees: the highlighted tab of every visible report strip and the open pane.
const view = page => page.evaluate(() => {
  const strips = [...document.querySelectorAll('#rOverlay #rMeasureTabs, #rOverlay #rOpeningReportTabs')].filter(strip => strip.querySelector('[data-tab]'));
  return {
    strips: strips.length,
    tabs: strips.flatMap(strip => [...strip.querySelectorAll('[data-tab]')].map(e => e.dataset.tab)),
    highlighted: strips.flatMap(strip => [...strip.querySelectorAll('[data-tab].active')].map(e => e.dataset.tab)),
    selected: strips.flatMap(strip => [...strip.querySelectorAll('[data-tab][aria-selected=true]')].map(e => e.dataset.tab)),
    pane: [...document.querySelectorAll('.r-measure-pane.active')].map(e => e.dataset.measurePane)
  };
});
const clickTab = (page, id) => page.locator(`#rOverlay #rMeasureTabs [data-tab="${id}"], #rOverlay #rOpeningReportTabs [data-tab="${id}"]`).first().click();
const between = {
  'a header repaint': 'renderHeader()',
  'a runtime remount': 'runtimeRemount(); renderHeader()',
  'a re-hydrate': 'hydrate()',
  'a remount, re-hydrate and repaints': 'runtimeRemount(); hydrate(); renderHeader(); renderHeader()'
};

for (const support of [false, true]) for (const route of [true, false]) {
  const label = `${support ? 'Support tab, full report strip' : 'flat report header'}, ${route ? 'with' : 'without'} reportView in the address`;
  test(`1M8-205: the highlighted tab is the open report through real clicks (${label})`, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const { page, errors } = await boot(browser, { support, route });
      for (const id of ['measurement-a', 'measurement-b', 'measurement-a']) {
        await page.evaluate(next => openProject(next), project(id));
        let state = await view(page);
        assert.deepEqual(state.tabs.filter(t => !t.startsWith('project:')), ['summary', 'standard', 'customer', 'xml', ...(support ? ['changes'] : [])], JSON.stringify(state));
        for (const [step, script] of Object.entries(between)) {
          for (const tabId of ['summary', 'standard', 'customer', 'xml']) {
            await clickTab(page, tabId);
            state = await view(page);
            assert.deepEqual([state.strips, state.highlighted, state.selected, state.pane], [1, [tabId], [tabId], [tabId]], `${id}: clicked ${tabId}: ${JSON.stringify(state)}`);
            await page.evaluate(script);
            state = await view(page);
            assert.deepEqual([state.strips, state.highlighted, state.selected, state.pane], [1, [tabId], [tabId], [tabId]], `${id}: ${tabId} after ${step}: ${JSON.stringify(state)}`);
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test('1M8-205: a second copy of the report app defers to the first', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page } = await boot(browser);
    assert.deepEqual(await page.evaluate(() => ({
      same: Portal.modules.projectMeasurements.definition === window.__runtimeApp,
      registered: FirstMateEmbeddableApps.registered.every(definition => definition === window.__runtimeApp)
    })), { same: true, registered: true });
  } finally { await browser.close(); }
});

for (const support of [false, true]) {
  test(`1M8-232: the XML tab is in the report header and downloads the model (${support ? 'full report strip' : 'flat header'})`, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const { page, downloads } = await boot(browser, { support });
      await page.evaluate(next => openProject(next), project('measurement-x'));
      await clickTab(page, 'xml');
      await page.evaluate('runtimeRemount(); hydrate(); renderHeader()');
      assert.deepEqual((await view(page)).pane, ['xml']);
      const download = page.waitForEvent('download');
      await page.locator('.r-measure-pane.active [data-download-xml]').click();
      assert.match((await download).suggestedFilename(), /^model_.*\.xml$/);
      // The Summary tab's metrics read the same file, so the download is the last request for it.
      assert.equal(downloads.at(-1), '/v1/firstmeasure/projects/measurement-x/artifacts/model_data.xml');
    } finally { await browser.close(); }
  });
}
