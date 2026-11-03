// Jack, November 3: Reports keeps a 3D Model sub-tab, so the full-size model is a click away beside the small one in
// the project details tray. Chrome runs the real measurements app, the real report navigation, the real widget runtime
// and project widgets, and the real roof viewer; the tab follows the viewer's rule (Full House reports, or roof-only
// reports; no longer gated by firstmeasure.roof_model_viewer).
// REPORT_MODEL_SCREENSHOT=<path.png> saves what the open tab shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const repo = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, repo), 'utf8');
const shell = await read('libraries/apps/project-request/app.js');
const paneCss = shell.slice(shell.indexOf('    .r-measure-body{'), shell.indexOf('\n', shell.indexOf('    .r-measure-pane.active{')));
const xml = '<ROOT><ROOF><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/><POINT id="e" data="30,30,0"/><POINT id="f" data="0,30,0"/><LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/><LINE id="ce" path="c,e" type="RAKE"/><LINE id="ef" path="e,f" type="EAVE"/><LINE id="fd" path="f,d" type="RAKE"/><FACE><POLYGON path="ab,bc,cd,da" pitch="7"/></FACE><FACE><POLYGON path="cd,ce,ef,fd" pitch="7"/></FACE></ROOF></ROOT>';

const project = (id, extra = {}) => ({
  id, address: id + ' Main St', status: 'completed', workflow_state: 'measurement_ordered', has_report: true,
  report_url: `/v1/firstmeasure/projects/${id}/artifacts/Report.pdf`, summary_url: `/v1/firstmeasure/projects/${id}/artifacts/Summary.pdf`,
  xml_url: `/v1/firstmeasure/projects/${id}/artifacts/model_data.xml`, measurement_project: { id, status: 'completed' }, ...extra
});

async function boot(browser, flags) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', async request => {
    const url = new URL(request.request().url());
    if (url.pathname.endsWith('model_data.xml')) return request.fulfill({ contentType: 'application/xml', body: xml });
    if (url.pathname.endsWith('.pdf')) return request.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4' });
    if (url.pathname.startsWith('/libraries/') || url.pathname.startsWith('/measure/internal/')) {
      const type = (url.pathname.endsWith('.json') ? 'application/json' : 'text/javascript') + '; charset=utf-8';
      return readFile(new URL(url.pathname.slice(1), repo)).then(body => request.fulfill({ contentType: type, body }), () => request.fulfill({ status: 404, body: '' }));
    }
    return request.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0;font-family:Arial"><div id="rOverlay" class="r-overlay active"><header class="r-modal-header"><nav id="rProjectViewerTabs"></nav><div class="modal-shell-actions"></div></header><div class="r-preview-panel active" data-panel="measurements"><div class="r-tab-content"><div class="r-tab-main"></div></div></div></div></body>' });
  });
  await page.goto('https://portal.test/portal/?tab=projects');
  await page.evaluate((flags) => {
    const registered = [];
    window.FirstMateEmbeddableApps = { registerApp: definition => registered.push(definition), registered };
    window.PlatformCommerce = { onReady: fn => fn(), price: () => 7, credit: value => String(value) };
    window.Portal = {
      appFlags: { current: () => ({}), has: (app, flag) => flags[flag] === true, value: (app, flag, fallback) => flag in flags ? flags[flag] : fallback },
      util: { fmUrl: path => 'https://portal.test/v1/firstmeasure/' + path },
      ui: { showToast: (...args) => (window.toasts ||= []).push(args) }
    };
  }, { measurement_report_summary: true, ...flags });
  await page.addStyleTag({ content: '[data-panel="measurements"],.r-tab-content,.r-tab-main{position:relative;height:700px}#rMeasureTabs{display:flex;gap:6px;padding:8px}#rMeasureTabs button{padding:6px 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:600 13px Arial}#rMeasureTabs button.active{background:#1f2937;color:#fff}' + paneCss });
  await page.addScriptTag({ url: 'https://portal.test/libraries/navigation/portal-navigation.js' });
  await page.addScriptTag({ content: await read('portal/scripts/project_viewer.js') });
  await page.addScriptTag({ url: 'https://portal.test/libraries/platform-widgets/runtime.js' });
  await page.addScriptTag({ url: 'https://portal.test/libraries/platform-widgets/project-widgets.js' });
  await page.evaluate(() => {
    Portal.navigation.registerSchema('project', { history: 'push' });
    Portal.navigation.registerSchema('projectTab', { history: 'push', scope: { project: true } });
    Portal.navigation.registerSchema('reportView', { default: 'model', history: 'push', scope: { project: true, projectTab: 'measurements' } });
  });
  await page.addScriptTag({ content: await read('libraries/apps/measurements/project.js') });
  await page.evaluate(() => {
    let activeBaseProject = null, reportOrderState = null;
    // A Reports tab beside Map and Docs: the report views stay in their own strip under Reports.
    const host = {
      getProject: () => activeBaseProject, setProject: value => { activeBaseProject = value; },
      getReportOrderState: () => reportOrderState, setReportOrderState: value => { reportOrderState = value; },
      reportNavigationContext: () => ({ ordered: true, tabs: ['map', 'measurements', 'docs'].map(id => ({ id, label: id })), activeTab: 'measurements' })
    };
    const module = () => Portal.modules.projectMeasurements;
    window.openProject = next => {
      activeBaseProject = next;
      reportOrderState = { ordered: true, hasReadyReport: true, status: 'completed', reportUrl: next.report_url, summaryUrl: next.summary_url, xmlUrl: next.xml_url };
      module().mount({ host, panelRoot: document.querySelector('[data-panel="measurements"]'), active: true });
      module().selectInitialMeasurementTab('standard');
      module().renderReportNavigation();
    };
  });
  return { page, errors };
}

const tabs = page => page.locator('#rMeasureTabs [data-tab]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.tab, label: node.textContent.trim() })));

test('Reports › 3D Model shows the full-size viewer for a roof report when the organization has the roof model viewer', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader'] });
  try {
    const { page, errors } = await boot(browser, { roof_model_viewer: true });
    await page.evaluate(next => openProject(next), project('measurement-roof'));
    const shown = await tabs(page);
    assert.deepEqual(shown.map(tab => tab.id), ['summary', 'model', 'standard', 'customer', 'xml'], JSON.stringify(shown));
    assert.equal(shown.find(tab => tab.id === 'model').label, '3D Model');
    // The PDF stays the first view; the model is a click away.
    assert.equal(await page.locator('#rMeasureTabs [data-tab].active').getAttribute('data-tab'), 'summary');
    await page.locator('#rMeasureTabs [data-tab="model"]').click();
    assert.equal(await page.locator('.r-measure-pane.active').getAttribute('data-measure-pane'), 'model');
    await page.waitForFunction(() => document.querySelector('#rMeasurementModel .fm-roof-canvas canvas') && document.querySelector('#rMeasurementModel .fm-roof-message')?.hidden, null, { timeout: 45000 });
    // Full size: the viewer fills the Reports pane, not a tray-sized box.
    const box = await page.locator('#rMeasurementModel .fm-roof-canvas').boundingBox();
    assert.ok(box.width > 900 && box.height > 300, JSON.stringify(box));
    if (process.env.REPORT_MODEL_SCREENSHOT) await page.screenshot({ path: process.env.REPORT_MODEL_SCREENSHOT });
    await page.locator('#rMeasureTabs [data-tab="standard"]').click();
    assert.equal(await page.locator('#rMeasurementModel canvas').count(), 0, 'leaving the tab releases the viewer');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Reports › 3D Model is on every finished report, roof-only and Full House, without roof_model_viewer', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    let { page } = await boot(browser, { roof_model_viewer: false });
    await page.evaluate(next => openProject(next), project('measurement-roof'));
    assert.deepEqual((await tabs(page)).map(tab => tab.id), ['summary', 'model', 'standard', 'customer', 'xml']);
    await page.close();
    ({ page } = await boot(browser, { roof_model_viewer: false }));
    await page.evaluate(next => openProject(next), project('exteriors_x', { manifest: { measurement_scope: 'full_house' } }));
    assert.deepEqual((await tabs(page)).map(tab => tab.id), ['summary', 'model', 'standard', 'customer', 'xml']);
  } finally { await browser.close(); }
});
