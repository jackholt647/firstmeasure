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
