// Regression tests for production hotfix 68fe2cab (portal refresh storage reads),
// checked against canonical's implementation (3a85b3fe): cards hydrate from
// summaries (bulk `projects/list` summary_ids, or `?view=portal-card`), the
// summary route reads only the manifest and the artifact catalog, and the board
// polls every two minutes. Reauthorization and `unchanged` revisions are covered
// by project-summary-access.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const core = fs.readFileSync(new URL('../../portal/scripts/core.js', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../../libraries/apps/projects/viewer.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source markers not found: ${start}`);
  return source.slice(from, to);
};
const hydrateSource = between(core, '  async function hydratePlatformProjectFromFirstMeasure(', '  async function listPlatformProjectCandidates(');
const pageSource = between(core, '  async function projectPageFromCandidates(', '  async function hydratePlatformProjectFromFirstMeasure(');
const refreshSource = between(core, '  const firstMeasureRefreshPages =', '  async function listFirstMeasureProjectCandidates(');
const text = (...values) => values.map(v => v == null ? '' : String(v).trim()).find(Boolean) || '';
const fixture = { id: 'platform-1', platform_project_id: 'platform-1', measurement: { id: 'measurement-1' }, status: 'processing', resident: 'Customer', thumbnail: '/custom-cover.png' };

function browser(response, listResponse = { projects: [] }) {
  const requests = [];
  const ctx = vm.createContext({
    Map, Set, JSON, Error, Promise,
    cleanText: text, cleanMeasurementText: text, measurementIdFromAssetUrl: () => '',
    normalizeProjectRecord: p => p, fmUrl: p => '/v1/firstmeasure/' + p,
    currentActor: () => 'actor@example.test',
    firstMeasureRejectionMetadata: m => ({ rejection_reason: m.rejection_reason || '' }),
    reportReleaseHoldIsActive: (...items) => items.some(p => p?.delivery?.release_hold?.status === 'held'),
    isFirstMeasureCompleteStatus: (...statuses) => statuses.includes('completed'),
    fmJson: async url => { requests.push(url); return response; },
    fmPost: async (route, payload) => { requests.push({ route, payload }); return listResponse; },
    paginateProjects: projects => ({ projects, pagination: { total_count: projects.length } })
  });
  vm.runInContext(refreshSource + pageSource + hydrateSource, ctx);
  return { ctx, requests };
}

test('card refresh requests summaries in bulk and preserves identity, custom cover and report links', async () => {
  const summary = { summary_only: true, manifest: { status: 'completed' }, artifact_flags: { has_report_pdf: true, has_summary_pdf: true, has_model_data: true } };
  const { ctx, requests } = browser(null, { projects: [{ id: 'measurement-1', project: summary }] });
  const result = await ctx.projectPageFromCandidates([fixture]);
  const p = result.projects[0];
  assert.equal(requests.length, 1, 'one bulk summary request, no per-card detail requests');
  assert.equal(requests[0].route, 'projects/list');
  assert.deepEqual([...requests[0].payload.summary_ids], ['measurement-1']);
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

test('a single card hydrates through the portal-card summary view', async () => {
  const { ctx, requests } = browser({ project: { summary_only: true, manifest: { status: 'completed' }, artifact_flags: { has_report_pdf: true } } });
  const p = await ctx.hydratePlatformProjectFromFirstMeasure(fixture, { summaryOnly: true });
  assert.deepEqual(requests, ['projects/measurement-1?view=portal-card']);
  assert.equal(p._summaryHydrated, true);
  assert.equal(p.has_report, true);
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
  const source = between(viewer, '  function needsDisplayHydration(', '  function scheduleHydratedDisplayRefresh(');
  const ctx = vm.createContext({ resolveResidentFields: p => ({ name: p.resident || '' }) });
  vm.runInContext(source, ctx);
  assert.equal(ctx.needsDisplayHydration({ id: 'x', _summaryHydrated: true }), false);
  assert.equal(ctx.needsDisplayHydration({ id: 'x' }), true);
});

test('opening a summary card still fetches full project details', async () => {
  const source = between(viewer, '  async function hydrateProjectDetails(', '  function hydrateProjectsForDisplay(');
  const urls = [];
  const ctx = vm.createContext({ firstMeasureProjectId: () => 'measurement-1', fmJson: async url => { urls.push(url); throw new Error('test boundary'); } });
  vm.runInContext(source, ctx);
  await ctx.hydrateProjectDetails({ ...fixture, _summaryHydrated: true, _detailHydrated: false });
  assert.deepEqual(urls, ['projects/measurement-1']);
});

test('two-minute periodic refresh retains fast post-submit polling', () => {
  const pollStart = viewer.indexOf('    pollTimer = setInterval(');
  assert.ok(pollStart >= 0, 'portal board poll not found');
  const pollEnd = viewer.slice(pollStart).search(/\r?\n  \}\r?\n/);
  const pollSource = viewer.slice(pollStart, pollStart + pollEnd);
  const timers = [];
  const fetches = [];
  const ctx = vm.createContext({
    pollTimer: null, viewMode: 'tiles', document: { hidden: false },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetchProjects: redraw => fetches.push(redraw),
    loadWorkBoards: async () => null,
    window: { Portal: {} }
  });
  vm.runInContext(pollSource, ctx);
  assert.deepEqual(timers.map(t => t.ms), [120000]);
  timers[0].fn();
  assert.deepEqual(fetches, [false]);
  ctx.document.hidden = true; timers[0].fn();
  assert.deepEqual(fetches, [false], 'hidden pages do not poll');

  timers.length = 0;
  vm.runInContext('let _burstTimers = [];' + between(viewer, '  function scheduleBurstPolls(', '\n  window.addEventListener(') + ';scheduleBurstPolls();', ctx);
  assert.deepEqual(timers.map(t => t.ms), [4000, 8000, 15000, 25000, 40000]);
});

test('summary route uses manifest and catalog only; default route and access errors remain intact', async () => {
  const start = api.indexOf('  app.get("/projects/:id",');
  const route = ts.transpileModule(api.slice(start, api.indexOf('  app.get("/projects/:id/instant",', start)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let handler, reads = 0, details = 0, catalog = 0;
  const storage = [];
  const forbiddenRead = name => async () => { storage.push(name); throw new Error(name + ' must not be read'); };
  const manifest = { id: 'm', organization_id: 'org', has_report_pdf: true, artifacts: { has_model_data: true } };
  const ctx = vm.createContext({ createHash, Boolean, String, JSON,
    app: { get: (_, fn) => { handler = fn; } },
    getProjectId: params => params.id, asRecord: value => value || {},
    requirePlatformAuth: async () => ({ orgId: 'org', identity: { email: 'a@example.test' } }),
    FirstMeasureError: class extends Error { constructor(code, status, message) { super(message); this.code = code; this.statusCode = status; } },
    readManifest: async id => { reads++; if (id === 'denied') throw new Error('denied'); return manifest; },
    catalogState: async () => { catalog++; return { generation: '1', ready: true }; },
    buildLegacyManifest: m => ({ ...m }),
    getProjectDetail: async () => { details++; return { manifest, files: [] }; },
    readAppMetadata: forbiddenRead('app_metadata'), readPdfState: forbiddenRead('pdf_state'),
    readBrandingDefaults: forbiddenRead('branding_defaults'), listProjectFiles: forbiddenRead('listing'),
    listProjectArtifacts: forbiddenRead('listing'), readListedProjectJson: forbiddenRead('json'),
    projectIncludesWeatherReport: () => false
  });
  vm.runInContext(route, ctx);
  const result = await handler({ params: { id: 'm' }, query: { view: 'portal-card' } });
  assert.equal(result.project.summary_only, true);
  assert.equal(result.project.artifact_flags.has_report_pdf, true);
  assert.equal(result.project.artifact_flags.has_summary_pdf, false);
  assert.equal(result.project.artifact_flags.has_model_data, true);
  assert.equal(reads, 1); assert.equal(catalog, 1); assert.equal(details, 0);
  assert.deepEqual(storage, []);
  const full = await handler({ params: { id: 'm' }, query: {} });
  assert.equal(details, 1);
  assert.equal(full.project.manifest, manifest);
  await assert.rejects(handler({ params: { id: 'denied' }, query: { view: 'portal-card' } }), /denied/);
  assert.equal(details, 1);
});
