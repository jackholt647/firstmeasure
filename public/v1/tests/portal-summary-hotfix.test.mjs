import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('../../portal/scripts/core.js', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../../libraries/apps/projects/viewer.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
const hydrateSource = core.slice(core.indexOf('  async function hydratePlatformProjectFromFirstMeasure('), core.indexOf('  async function listPlatformProjectCandidates('));
const pageSource = core.slice(core.indexOf('  async function projectPageFromCandidates('), core.indexOf('  async function hydratePlatformProjectFromFirstMeasure('));
const text = (...values) => values.map(v => v == null ? '' : String(v).trim()).find(Boolean) || '';
const fixture = { id: 'platform-1', platform_project_id: 'platform-1', measurement: { id: 'measurement-1' }, status: 'processing', resident: 'Customer', thumbnail: '/custom-cover.png' };
function browser(response) {
  const requests = [];
  const ctx = vm.createContext({
    cleanText: text, cleanMeasurementText: text, measurementIdFromAssetUrl: () => '',
    normalizeProjectRecord: p => p, fmUrl: p => '/v1/firstmeasure/' + p,
    firstMeasureRejectionMetadata: m => ({ rejection_reason: m.rejection_reason || '' }),
    reportReleaseHoldIsActive: (...items) => items.some(p => p?.delivery?.release_hold?.status === 'held'),
    isFirstMeasureCompleteStatus: (...statuses) => statuses.includes('completed'),
    fmJson: async url => { requests.push(url); return response; },
    paginateProjects: projects => ({ projects, pagination: { total_count: projects.length } })
  });
  vm.runInContext(pageSource + hydrateSource, ctx);
  return { ctx, requests };
}
test('card refresh requests summaries and preserves identity, custom cover and report links', async () => {
  const { ctx, requests } = browser({ project: { summary_only: true, manifest: { status: 'completed' }, artifact_flags: { has_report_pdf: true, has_summary_pdf: true, has_model_data: true } } });
  const result = await ctx.projectPageFromCandidates([fixture]);
  const p = result.projects[0];
  assert.deepEqual(requests, ['projects/measurement-1?view=portal-card']);
  assert.equal(p.id, 'platform-1');
  assert.equal(p.thumbnail, '/custom-cover.png');
  assert.equal(p.resident, 'Customer');
  assert.equal(p.has_report, true);
  assert.match(p.report_url, /artifacts\/Report.pdf$/);
  assert.match(p.summary_url, /artifacts\/Summary.pdf$/);
  assert.match(p.xml_url, /artifacts\/model_data.xml$/);
  assert.equal(p._summaryHydrated, true);
  assert.equal(p._detailHydrated, false);
});
test('summary hydration preserves release holds and rejection metadata', async () => {
  const { ctx } = browser({ project: { summary_only: true, manifest: { status: 'completed', delivery: { release_hold: { status: 'held' } }, rejection_reason: 'coverage' }, artifact_flags: { has_report_pdf: true, has_summary_pdf: true } } });
  const p = await ctx.hydratePlatformProjectFromFirstMeasure({ ...fixture, has_report: true, report_url: '/old.pdf', summary_url: '/old-summary.pdf' }, { summaryOnly: true });
  assert.equal(p.has_report, false);
  assert.equal(p.report_url, null);
  assert.equal(p.summary_url, null);
  assert.equal(p.rejection_reason, 'coverage');
});
test('new browser accepts old server detail response during rolling deployment', async () => {
  const { ctx } = browser({ project: { manifest: { status: 'completed' }, files: [{ name: 'Report.pdf' }] } });
  const p = await ctx.hydratePlatformProjectFromFirstMeasure(fixture, { summaryOnly: true });
  assert.equal(p.has_report, true);
  assert.equal(p._detailHydrated, true);
});
test('ordinary hydration still requests full detail', async () => {
  const { ctx, requests } = browser({ project: { manifest: { status: 'processing' }, files: [] } });
  await ctx.hydratePlatformProjectFromFirstMeasure(fixture);
  assert.deepEqual(requests, ['projects/measurement-1']);
});
test('summary cards do not enter automatic full-detail display hydration', () => {
  const source = viewer.slice(viewer.indexOf('  function needsDisplayHydration('), viewer.indexOf('  function scheduleHydratedDisplayRefresh('));
  const ctx = vm.createContext({ resolveResidentFields: p => ({ name: p.resident || '' }) });
  vm.runInContext(source, ctx);
  assert.equal(ctx.needsDisplayHydration({ id: 'x', _summaryHydrated: true }), false);
  assert.equal(ctx.needsDisplayHydration({ id: 'x' }), true);
});
test('opening a summary card still fetches full project details', async () => {
  const source = viewer.slice(viewer.indexOf('  async function hydrateProjectDetails('), viewer.indexOf('  function hydrateProjectsForDisplay('));
  let calls = 0;
  const ctx = vm.createContext({ firstMeasureProjectId: () => 'measurement-1', fmJson: async () => { calls++; throw new Error('test boundary'); } });
  vm.runInContext(source, ctx);
  await ctx.hydrateProjectDetails({ ...fixture, _summaryHydrated: true, _detailHydrated: false });
  assert.equal(calls, 1);
});
test('two-minute periodic refresh retains fast post-submit polling', () => {
  assert.match(viewer, /pollTimer = setInterval\(\(\)=>\{ fetchProjects\(false\); \}, 120000\);/);
  assert.match(viewer, /const delays = \[4000, 8000, 15000, 25000, 40000\];/);
});
test('summary route uses manifest only; default route and access errors remain intact', async () => {
  const route = api.slice(api.indexOf('  app.get("/projects/:id",'), api.indexOf('  app.get("/projects/:id/instant",'));
  let handler, reads = 0, details = 0;
  const manifest = { id: 'm', artifacts: { has_report_pdf: true, has_model_data: true } };
  const ctx = vm.createContext({ app: { get: (_, fn) => { handler = fn; } },
    getProjectId: params => params.id, asRecord: value => value || {},
    readManifest: async id => { reads++; if (id === 'denied') throw new Error('denied'); return manifest; },
    buildLegacyManifest: m => ({ ...m, ...m.artifacts }),
    getProjectDetail: async () => { details++; return { manifest, files: [] }; },
    projectIncludesWeatherReport: () => false
  });
  vm.runInContext(route, ctx);
  const result = await handler({ params: { id: 'm' }, query: { view: 'portal-card' } });
  assert.equal(result.project.summary_only, true);
  assert.equal(result.project.artifact_flags.has_report_pdf, true);
  assert.equal(result.project.artifact_flags.has_summary_pdf, false);
  assert.equal(reads, 1); assert.equal(details, 0);
  await handler({ params: { id: 'm' }, query: {} });
  assert.equal(details, 1);
  await assert.rejects(handler({ params: { id: 'denied' }, query: { view: 'portal-card' } }), /denied/);
});
