// 1M8-231: customers without platform expanded access saw "This session does not have
// permission to perform this action" after ordering a report. The order succeeded, but the
// portal's project store then wrote the project to the platform projects API, which needs
// manage_projects and expanded access; production refused it and the save toast showed the
// server's message. Without expanded access the store keeps projects in the page cache only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const viewer = await readFile(new URL('../../portal/scripts/project_viewer.js', import.meta.url), 'utf8');
const core = await readFile(new URL('../../portal/scripts/core.js', import.meta.url), 'utf8');

function portalStore({ expanded }) {
  const local = new Map();
  const writes = [];
  const toasts = [];
  const refused = (method) => async (...args) => {
    writes.push([method, ...args]);
    const error = new Error('This session does not have permission to perform this action.');
    error.status = 403;
    error.code = 'permission_denied';
    throw error;
  };
  const projects = {
    save: refused('save'),
    patch: refused('patch'),
    remove: refused('remove'),
    get: async () => ({ missing: true }),
    baseline: () => null
  };
  const context = {
    window: {
      Portal: {
        platformExpandedAccess: () => expanded,
        ui: { showToast: (title, body) => toasts.push([title, body]) }
      },
      __APP: { userOrgId: 'org-customer', userId: 'user-manager' },
      addEventListener() {}, dispatchEvent() {},
      PlatformAPI: { projects, orgs: { get: async () => ({}) }, contacts: { setProjectContacts: refused('contacts') } }
    },
    localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value) },
    console: { ...console, warn() {} },
    setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(viewer, context);
  return { store: context.window.Portal.ProjectStore, writes, toasts };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const queuedOrder = () => [
  { address: '123 Order Lane', residentName: 'Pat Customer', contacts: '[]', report_mode: 'full' },
  { success: true, folder: 'measurement-231', project: { id: 'measurement-231', status: 'queued' } }
];

test('1M8-231: ordering without expanded access makes no platform project write and shows no error', async () => {
  const { store, writes, toasts } = portalStore({ expanded: false });
  const draft = store.save({ id: 'project_draft', address: '123 Order Lane', workflow_state: 'draft' });
  assert.equal(draft.id, 'project_draft');
  const ordered = store.fromQueue(...queuedOrder());
  assert.equal(ordered.workflow_state, 'measurement_ordered');
  assert.equal((await store.saveRemote(ordered)).id, ordered.id, 'saveRemote returns the cached project');
  assert.equal(await store.removeRemote('project_draft'), true);
  await settle();
  assert.deepEqual(writes, [], 'no platform projects API call');
  assert.deepEqual(toasts, [], 'no "permission" toast after a successful order');
  assert.equal(store.findByMeasurement({ id: 'measurement-231' }).id, ordered.id, 'the order stays in the page cache');
});

test('1M8-231: with expanded access the store still saves to the platform and reports real failures', async () => {
  const { store, writes, toasts } = portalStore({ expanded: true });
  store.fromQueue(...queuedOrder());
  await settle();
  assert.equal(writes[0]?.[0], 'save');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][1], /permission/);
});

test('1M8-231: the portal shares one expanded-access check with the project store', () => {
  assert.match(core, /window\.Portal\.platformExpandedAccess = platformExpandedAccess;/);
});

// The refused PUTs production logged come in bursts from the project list page: it reads the
// platform mirror, lists FirstMeasure orders, then imports every order the mirror lacks.
// Replay that sequence with the real core.js list and import code (CORE_SOURCE and VIEWER_SOURCE may
// point at older files to show the requests they send) and an order placed through the real project store.
const coreSource = process.env.CORE_SOURCE ? await readFile(process.env.CORE_SOURCE, 'utf8') : core;
const viewerSource = process.env.VIEWER_SOURCE ? await readFile(process.env.VIEWER_SOURCE, 'utf8') : viewer;
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source markers not found: ${start}`);
  return source.slice(from, to);
};

async function customerListPageThenOrder() {
  const requests = [];
  const refused = method => async (orgId, id) => {
    requests.push(`${method} /v1/platform/organizations/${orgId}/projects/${id}`);
    throw Object.assign(new Error('This session does not have permission to perform this action.'), { status: 403, code: 'permission_denied' });
  };
  const platformAPI = {
    projects: {
      // The mirror the portal wrote before 10/20: one old order.
      list: async orgId => { requests.push(`GET /v1/platform/organizations/${orgId}/projects`); return { documents: [{ id: 'project_oct20', data: { id: 'project_oct20', measurement: { id: 'm-oct20' } } }] }; },
      save: refused('PUT'), patch: refused('PATCH'), remove: refused('DELETE'),
      get: async () => ({ missing: true }), baseline: () => null
    },
    orgs: { get: async () => ({}) },
    contacts: { setProjectContacts: refused('PUT contacts') }
  };
  const toasts = [];
  const local = new Map();
  const window = {
    __APP: { userOrgId: 'org_customer', userId: 'user_manager', platformExpandedAssets: false },
    Portal: { capabilities: { current: () => ({}), value: (key, fallback) => (key === 'platform.expanded_access' ? false : fallback) },
      ui: { showToast: (title, body) => toasts.push(body) } },
    PlatformAPI: platformAPI, addEventListener() {}, dispatchEvent() {}
  };
  const ctx = vm.createContext({
    window, APP: window.__APP, console: { ...console, warn() {} }, setTimeout, clearTimeout,
    localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value) },
    cleanText: value => String(value ?? '').trim(),
    currentActor: () => ({ email: 'manager@example.com', organization_id: 'org_customer' }),
    fmPost: async (path, payload) => { requests.push(`POST /v1/firstmeasure/${path} ${payload.filter}`); return { projects: payload.filter === 'org' ? [{ id: 'm-oct22' }, { id: 'm-oct21' }, { id: 'm-oct20' }] : [], pagination: { total_pages: 1 } }; },
    normalizeFirstMeasureProjectRecord: project => ({ ...project, measurement: { id: project.id } }),
    dedupeProjectsByIdentity: projects => [...new Map(projects.map(project => [project.id, project])).values()],
    remoteProjectFromDocument: document => document?.data || null,
    projectMeasurementKeys: project => [project.measurement?.id].filter(Boolean),
    measurementKeys: measurement => [measurement?.id].filter(Boolean),
    platformProjectNeedsFirstMeasureSync: () => true,
    platformProjectFromFirstMeasure: project => ({ id: 'project_' + project.id, contacts: [], measurement: project.measurement }),
    truthyField: value => value === true || value === '1',
    withTimeout: promise => promise,
    projectPageFromCandidates: async projects => ({ projects: projects.map(project => project.id) }),
    listPlatformProjectCandidates: async () => (await platformAPI.projects.list('org_customer')).documents.map(document => document.data),
    googleMapsApiKey: () => 'key', portalActionJson: async () => ({})
  });
  vm.runInContext([
    coreSource.includes('  function platformExpandedAccess(') ? between(coreSource, '  function platformExpandedAccess(', '  async function savePlatformProjectFromFirstMeasure(') : '',
    between(coreSource, '  async function savePlatformProjectFromFirstMeasure(', '  const withTimeout ='),
    between(coreSource, '  async function existingPlatformProjectsByMeasurementKey(', '  function platformProjectNeedsFirstMeasureSync('),
    'this.warmFirstMeasureProjectImport = fields => { this.warm = listFirstMeasureProjectCandidates({ ...fields, max_pages: 5 }); };',
    between(coreSource, '  async function routeProjectAction(', '  async function postAction('),
    'this.routeProjectAction = routeProjectAction;'
  ].join('\n'), ctx);
  vm.runInContext(viewerSource, ctx);
  // Opening My Projects, then ordering a report from the project window.
  const listed = await ctx.routeProjectAction('list_projects', { filter: 'org', page: 1, limit: 35 });
  await ctx.warm;
  const store = window.Portal.ProjectStore;
  store.save({ id: 'project_draft', address: '123 Order Lane', workflow_state: 'draft' });
  store.fromQueue({ address: '123 Order Lane', contacts: '[]', platform_project_id: 'project_draft' }, { success: true, folder: 'm-oct22b', project: { id: 'm-oct22b' } });
  await settle();
  return { requests, toasts, listed: listed.data };
}

test('1M8-231: the list page and an order make no platform project write without expanded access', async () => {
  const { requests, toasts, listed } = await customerListPageThenOrder();
  const writes = requests.filter(request => !request.startsWith('GET ') && !request.startsWith('POST /v1/firstmeasure/'));
  assert.deepEqual(writes, [], 'no PUT, PATCH or DELETE to the platform projects API');
  assert.deepEqual(toasts, []);
  assert.ok(listed.projects.includes('m-oct22'), 'orders since the release are listed');
});
