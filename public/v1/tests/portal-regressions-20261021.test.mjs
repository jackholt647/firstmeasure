// Regression tests for the customer portal fixes after the 2026-10-20 release (31f87be5):
// 1M8-205 report tab selection, 1M8-210 cancelled orders, 1M8-208 stale summaries,
// 1M8-202 contact placeholder, 1M8-206 draft classification, 1M8-211 impersonation
// sidebar, and the platform sync that production orgs without expanded access refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright-core';

const read = path => fs.readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const measurements = read('libraries/apps/measurements/project.js');
const shell = read('libraries/apps/project-request/app.js');
const viewer = read('libraries/apps/projects/viewer.js');
const core = read('portal/scripts/core.js');
const portal = read('portal/index.php');
const projectViewer = read('portal/scripts/project_viewer.js');
const fn = (source, name) => {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source markers not found: ${start}`);
  return source.slice(from, to);
};
const text = (...values) => values.map(v => v == null ? '' : String(v).trim()).find(Boolean) || '';

// Report tabs as a roof-only order sees them: the 3D model tab is gated off unless enabled.
function tabContext({ model = false, route = {}, tabs = ['summary', 'standard', 'customer'] } = {}) {
  const pushes = [];
  const ctx = vm.createContext({
    window: { Portal: { navigation: { read: () => ({ ...route }), push: patch => { pushes.push(patch); Object.assign(route, patch); } } } },
    measurementTabs: () => [...(model ? ['model'] : []), ...tabs].map(id => ({ id, disabled: false })),
    reportModelViewerEnabled: () => model,
    activeMeasurementProjectId: () => 'measurement-1',
    renderMeasurementsPanel: () => {}
  });
  vm.runInContext(`let activeMeasurementTab = 'model'; let userMeasurementTab = ''; let userMeasurementTabProject = '';
    ${fn(measurements, 'setActiveMeasurementTab')}
    ${fn(measurements, 'selectInitialMeasurementTab')}
    this.active = () => activeMeasurementTab;`, ctx);
  return { ctx, pushes, route };
}

test('1M8-205: a hidden model tab opens Standard, not Summary, and does not write the route', () => {
  const { ctx, pushes } = tabContext();
  assert.equal(ctx.selectInitialMeasurementTab('standard', { model: true }), 'standard');
  assert.deepEqual(pushes, []);
  ctx.setActiveMeasurementTab('model');
  assert.equal(ctx.active(), 'standard', 'an unavailable tab falls back to Standard');
});

test('1M8-205: the model tab opens first only where it is offered', () => {
  const { ctx } = tabContext({ model: true });
  assert.equal(ctx.selectInitialMeasurementTab('standard', { model: true }), 'model');
  assert.equal(ctx.selectInitialMeasurementTab('standard', { model: false }), 'standard');
});

test('1M8-205: later hydrates keep the tab the user chose or the route names', () => {
  for (const choice of ['customer', 'summary', 'standard']) {
    const { ctx, route } = tabContext();
    ctx.selectInitialMeasurementTab('standard', { model: true });
    ctx.setActiveMeasurementTab(choice, { user: true });
    assert.equal(route.reportView, choice);
    ctx.selectInitialMeasurementTab('standard', { model: true });
    assert.equal(ctx.active(), choice);
    delete route.reportView;
    ctx.selectInitialMeasurementTab('standard', { model: true });
    assert.equal(ctx.active(), choice, 'the user choice holds without the route too');
  }
  const { ctx } = tabContext({ route: { reportView: 'customer' } });
  assert.equal(ctx.selectInitialMeasurementTab('standard', { model: true }), 'customer');
});

test('1M8-205: hydration paths no longer ask for the model tab directly', () => {
  assert.doesNotMatch(shell, /setActiveMeasurementTab\([^;]*\? 'model'/);
  assert.match(shell, /selectInitialMeasurementTab\(reportOrderState\.includeInspection \? 'instant' : 'standard', \{ model:data\?\.development_report === true \}\)/);
  assert.match(measurements, /if \(route\.reportView\) setActiveMeasurementTab\(route\.reportView, \{ updateRoute:false \}\);/);
});

test('1M8-205: in the browser the highlighted header tab matches the open report through re-hydrates', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent('<div id="rOverlay" class="r-overlay active"><header class="r-modal-header"><div class="modal-shell-actions"></div></header><section><div id="rMeasureTabs"></div><div class="r-measure-pane" data-measure-pane="summary"></div><div class="r-measure-pane" data-measure-pane="standard"></div><div class="r-measure-pane" data-measure-pane="customer"></div></section></div>');
    await page.evaluate(() => { window.Portal = {}; });
    await page.addScriptTag({ content: projectViewer });
    await page.evaluate(() => {
      window.route = {};
      Portal.navigation = { read: () => ({ ...route }), push: patch => Object.assign(route, patch) };
      window.state = { mounted: true, host: {} };
      window.context = { ordered: true, tabs: [{ id: 'map' }, { id: 'measurements' }], activeTab: 'measurements' };
      window.callHost = () => context;
      window.currentPanelRoot = () => document.querySelector('section');
      window.setActivePreviewTab = id => { context.activeTab = id; };
      window.reportModelViewerEnabled = () => false;
      window.activeMeasurementProjectId = () => 'measurement-1';
      window.measurementTabs = () => ['summary', 'standard', 'customer'].map(id => ({ id, label: id }));
      window.renderMeasurementsPanel = () => {
        renderReportNavigation();
        document.querySelectorAll('.r-measure-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.measurePane === activeMeasurementTab));
      };
    });
    await page.addScriptTag({ content: `var activeMeasurementTab = 'model', userMeasurementTab = '', userMeasurementTabProject = '';
      ${fn(measurements, 'reportHeaderTabs')}${fn(measurements, 'renderReportNavigation')}
      ${fn(measurements, 'setActiveMeasurementTab')}${fn(measurements, 'selectInitialMeasurementTab')}
      window.hydrate = () => selectInitialMeasurementTab('standard', { model: true });
      hydrate();` });
    const state = () => page.evaluate(() => ({
      highlighted: document.querySelector('#rMeasureTabs .active')?.dataset.tab,
      selected: [...document.querySelectorAll('#rMeasureTabs [aria-selected=true]')].map(e => e.dataset.tab),
      pane: document.querySelector('.r-measure-pane.active')?.dataset.measurePane
    }));
    assert.deepEqual(await state(), { highlighted: 'standard', selected: ['standard'], pane: 'standard' });
    for (const id of ['customer', 'summary', 'standard', 'customer']) {
      await page.locator(`#rMeasureTabs [data-tab="${id}"]`).click();
      assert.deepEqual(await state(), { highlighted: id, selected: [id], pane: id });
      await page.evaluate(() => { hydrate(); hydrate(); });
      assert.deepEqual(await state(), { highlighted: id, selected: [id], pane: id }, 'a re-hydrate keeps ' + id);
    }
  } finally { await browser.close(); }
});

// The opening header and the hydrated report header must agree that a cancelled order is an order.
function orderContext({ reorder = '' } = {}) {
  const ctx = vm.createContext({ reorderMeasurementProjectId: reorder, hasReportOrdered: () => false, activeBaseProject: null });
  vm.runInContext(fn(shell, 'projectReportOrderExists') + fn(shell, 'reportOrderExists'), ctx);
  return ctx;
}

test('1M8-210: a cancelled or rejected order keeps the report layout after hydration', () => {
  const ctx = orderContext();
  for (const project of [
    { id: 'project_1', status: 'cancelled', measurement_project: { id: 'measurement-1', status: 'cancelled' } },
    { id: 'project_2', status: 'rejected_no_coverage', measurement_project_id: 'measurement-2' }
  ]) {
    ctx.activeBaseProject = project;
    assert.equal(ctx.projectReportOrderExists(project), true);
    assert.equal(ctx.reportOrderExists(), true);
  }
  ctx.activeBaseProject = { id: 'project_3', workflow_state: 'draft' };
  assert.equal(ctx.reportOrderExists(), false);
  const reordering = orderContext({ reorder: 'measurement-1' });
  reordering.activeBaseProject = { measurement_project: { id: 'measurement-1', status: 'cancelled' } };
  assert.equal(reordering.reportOrderExists(), false, 'a reorder shows the ordering layout');
  assert.match(fn(shell, 'openingProjectTabs'), /const ordered=projectReportOrderExists\(project\);/);
  assert.match(shell, /reportNavigationContext: \(\) => \(\{ordered:reportOrderExists\(\)/);
});

test('1M8-210: the header tabs for a cancelled order match the opening tabs', () => {
  const ctx = vm.createContext({ window: { Portal: {}, addEventListener() {} }, document: { addEventListener() {} } });
  vm.runInContext(projectViewer, ctx);
  const projectTabs = [{ id: 'map' }, { id: 'measurements' }];
  const cancelledTabs = [{ id: 'summary' }, { id: 'standard' }, { id: 'customer', disabled: true }];
  const order = orderContext();
  order.activeBaseProject = { status: 'cancelled', measurement_project: { id: 'measurement-1' } };
  const flat = ctx.window.Portal.ProjectViewer.reportHeaderTabs(projectTabs, cancelledTabs, order.reportOrderExists());
  assert.deepEqual(Array.from(flat, tab => tab.id), ['project:map', 'summary', 'standard', 'customer']);
});

function summaryRows({ cancelled = false, rejected = false, held = false, complete = false, pending = true } = {}) {
  const ctx = vm.createContext({
    globalThis: {},
    reportOrderIsCompleteLike: () => complete, reportOrderIsActivelyPending: () => pending,
    reportOrderIsCancelled: () => cancelled, reportOrderIsRejected: () => rejected, reportOrderReleaseHoldIsActive: () => held,
    weatherReportInfo: () => ({ ordered: false, url: '' }), weatherReportsEnabled: () => false,
    reportOrderIncludesInstant: () => false, reportOrderIncludesGutters: () => false,
    reportSummaryStandardDetail: () => '', reportSummaryIsFullHouse: () => false
  });
  vm.runInContext(fn(measurements, 'reportSummaryReportRows') + fn(measurements, 'reportSummaryStatusLabel'), ctx);
  return Array.from(ctx.reportSummaryReportRows({}), row => ({ processing: row.processing, label: ctx.reportSummaryStatusLabel(row) }));
}

test('1M8-210: report summary rows say Cancelled or Not available, never Processing, for closed orders', () => {
  assert.deepEqual(summaryRows({ cancelled: true }).map(row => row.label), ['Cancelled', 'Cancelled']);
  assert.deepEqual(summaryRows({ rejected: true }).map(row => row.label), ['Not available', 'Not available']);
  assert.deepEqual(summaryRows({ held: true }).map(row => row.label), ['Not available', 'Not available']);
  assert.deepEqual(summaryRows().map(row => row.label), ['Processing', 'Processing'], 'an open order is still processing');
});

test('1M8-208: ids the batched summary omits read their own summary instead of keeping order-time status', async () => {
  const requests = [];
  const ctx = vm.createContext({
    Map, Set, JSON, Error, Promise,
    cleanText: text, cleanMeasurementText: text, measurementIdFromAssetUrl: () => '',
    normalizeProjectRecord: p => p, fmUrl: p => '/v1/firstmeasure/' + p, currentActor: () => 'actor@example.test',
    firstMeasureRejectionMetadata: () => ({}), reportReleaseHoldIsActive: () => false,
    isFirstMeasureCompleteStatus: (...statuses) => statuses.includes('completed'),
    fmJson: async url => { requests.push(url); return { project: { summary_only: true, status: 'completed', manifest: { status: 'completed' }, artifact_flags: { has_report_pdf: true } } }; },
    fmPost: async (route, payload) => { requests.push({ route, payload }); return { projects: [] }; },
    paginateProjects: projects => ({ projects, pagination: { total_count: projects.length } })
  });
  vm.runInContext(between(core, '  const firstMeasureRefreshPages =', '  async function listFirstMeasureProjectCandidates(')
    + between(core, '  async function projectPageFromCandidates(', '  async function listPlatformProjectCandidates('), ctx);
  const result = await ctx.projectPageFromCandidates([{ id: 'platform-1', platform_project_id: 'platform-1', measurement: { id: 'measurement-old' }, status: 'processing' }]);
  assert.equal(requests[0].route, 'projects/list');
  assert.deepEqual(requests.slice(1), ['projects/measurement-old?view=portal-card']);
  assert.equal(result.projects[0].status, 'completed');
  assert.equal(result.projects[0].has_report, true);
});

test('1M8-202: tile and list patches write the same contact placeholders as the full render', () => {
  const patch = between(viewer, '        const tileResident = tile.querySelector', '        const addr = row.querySelector');
  assert.doesNotMatch(patch, /'N\/A'/);
  assert.match(patch, /tileContact\.displayName \|\| tileContact\.name \|\| \(globalThis\.PlatformLanguage\?\.text\('projects','fm_contact_unavailable','Not provided'\) \?\? 'Not provided'\)/);
  assert.match(viewer, /contact\.displayName \|\| contact\.name \|\| \(globalThis\.PlatformLanguage\?\.text\('projects','fm_contact_unavailable','Not provided'\) \?\? 'Not provided'\)/);
  assert.match(patch, /residentCols\[0\]\.textContent = resident\.name \|\| '\\u2014';/);
  assert.match(viewer, /data-col="resident"[^`]*\$\{escapeHtml\(resident\.name \|\| '\\u2014'\)\}/);
});

const drafts = [
  [{ workflow_state: 'draft', work_plan_ids: ['plan_1'], work_projection: { plans: [{ id: 'plan_1' }] } }, true, 'auto-created work plans'],
  [{ workflow_state: 'draft', photos: [{ id: 'p' }], notes: 'gate code 1234' }, true, 'an explicit draft with photos and notes'],
  [{ workflow_state: 'draft', proposals: [{ id: 'proposal_1' }] }, false, 'a draft with a proposal'],
  [{ workflow_state: 'draft', measurement_project: { id: 'measurement-1' } }, false, 'a draft with an order'],
  [{ workflow_state: 'project', work_plan_ids: ['plan_1'] }, true, 'a new project with only an auto-created plan'],
  [{ workflow_state: 'project', photos: [{ id: 'p' }] }, false, 'a project with photos'],
];

test('1M8-206: drafts stay drafts in the projects viewer', () => {
  const ctx = vm.createContext({
    hasProjectProposals: p => !!p?.proposals?.length, hasScheduledAppointment: () => false,
    hasMeasurementOrder: p => !!(p?.measurement_project?.id || p?.measurement?.id)
  });
  vm.runInContext(fn(viewer, 'hasMeaningfulProjectActivity') + fn(viewer, 'isDraftProject'), ctx);
  for (const [project, draft, label] of drafts) assert.equal(ctx.isDraftProject(project), draft, label);
  // Shared records carry no activity of their own, so the draft filter leaves them in.
  assert.match(viewer, /project\._shared \|\| !isDraftProject\(project\)/);
});

test('1M8-206: drafts stay drafts in the portal project list', () => {
  const ctx = vm.createContext({
    cleanText: text, hasProjectProposals: p => !!p?.proposals?.length, hasScheduledAppointment: () => false,
    projectMeasurementKeys: p => [p?.measurement_project?.id, p?.measurement?.id].filter(Boolean)
  });
  vm.runInContext(between(core, '  const hasMeaningfulProjectActivity =', '  const projectMatchesSearch =').replace('const hasMeaningfulProjectActivity', 'var hasMeaningfulProjectActivity'), ctx);
  for (const [project, draft, label] of drafts) assert.equal(ctx.isDraftPlatformProject(project), draft, label);
});

test('1M8-211: the impersonation banner offsets the sidebar only on mobile', () => {
  const style = between(portal, '/* Push everything below the banner */', '</style>');
  assert.doesNotMatch(style.split('@media')[0], /\.sidebar/);
  assert.match(style, /@media \(max-width: 820px\) \{\s*\.sidebar \{ top: 44px !important;/);
});

test('1M8-211: desktop impersonation keeps the Settings row inside the viewport', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const css = between(portal, '    *{box-sizing:border-box}', '    /* The Android host');
    const banner = between(portal, '/* Push everything below the banner */', '</style>');
    for (const width of [1280]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      await page.setContent(`<style>${css}</style><style>${banner}</style><aside class="sidebar"><div style="flex:1"></div><div id="settings" style="height:44px">Settings</div></aside><main style="flex:1"></main>`);
      const rect = await page.locator('#settings').evaluate(e => e.getBoundingClientRect().toJSON());
      assert.ok(rect.bottom <= 720 + 0.5, `settings row bottom ${rect.bottom} at ${width}px`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('platform sync is skipped and the board lists FirstMeasure directly without expanded access', async () => {
  const saves = [];
  const ctx = vm.createContext({
    APP: { userOrgId: 'org_1', platformExpandedAssets: false }, cleanText: text,
    window: { Portal: { capabilities: { current: () => ({}), value: (key, fallback) => (key === 'platform.expanded_access' ? ctx.expanded : fallback) } },
      PlatformAPI: { projects: { save: async (...args) => saves.push(args) } } },
    platformProjectFromFirstMeasure: () => ({ id: 'project_1', contacts: [], measurement: {} }), measurementKeys: () => []
  });
  ctx.expanded = false;
  vm.runInContext(fn(core, 'platformExpandedAccess') + between(core, '  async function savePlatformProjectFromFirstMeasure(', '  const firstMeasureRefreshPages ='), ctx);
  assert.equal(await ctx.savePlatformProjectFromFirstMeasure({ id: 'measurement-1' }), null);
  assert.deepEqual(saves, []);
  ctx.expanded = true;
  await ctx.savePlatformProjectFromFirstMeasure({ id: 'measurement-1' });
  assert.equal(saves.length, 1);
  ctx.window.Portal.capabilities.current = () => null;
  assert.equal(ctx.platformExpandedAccess(), false, 'before capabilities load the session flag decides');
  const list = between(core, "    if (action === 'list_projects') {", "    if (action === 'queue') {");
  assert.match(list, /const platformProjects = platformExpandedAccess\(\) \? await listPlatformProjectCandidates\(\)/);
});
