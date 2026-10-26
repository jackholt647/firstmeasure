/**
 * One browser may be signed in to several accounts in turn (the account switcher, signup sandbox launches).
 * The browser's project cache and pending report order belong to one organization and one person: another
 * account never reads them, and a cache that does not say whose it is is never used.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const viewer = await readFile(new URL('../../portal/scripts/project_viewer.js', import.meta.url), 'utf8');
const billing = await readFile(new URL('../../libraries/apps/billing/app.js', import.meta.url), 'utf8');
const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');

function browser(local = new Map()) {
  const localStorage = {
    getItem: (key) => (local.has(key) ? local.get(key) : null),
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: (key) => local.delete(key),
    key: (index) => [...local.keys()][index] ?? null,
    get length() { return local.size; }
  };
  return { local, localStorage };
}

function loadStore(shared, app) {
  const context = { window: { Portal: {}, __APP: { ...app }, addEventListener() {} }, localStorage: shared.localStorage, console };
  vm.createContext(context);
  vm.runInContext(viewer, context);
  return { store: context.window.Portal.ProjectStore, window: context.window };
}

const project = (id, address, contactName) => ({
  id, platform_project_id: id, address, title: address,
  contacts: [{ id: `contact_${id}`, name: contactName, email: `${id}@example.test` }]
});

test('a project cached by one account is not offered to another account in the same browser', () => {
  const shared = browser();
  const first = loadStore(shared, { userOrgId: 'org_first', userId: 'user_first' });
  first.store.cache(project('project_first_a', '1 First Street', 'First Customer'));
  first.store.cache(project('project_first_b', '2 First Street', 'Second Customer'));
  assert.deepEqual([...first.store.cachedIds()].sort(), ['project_first_a', 'project_first_b']);

  // A new organization signed in on the same browser (a reload, so the page loads again).
  const second = loadStore(shared, { userOrgId: 'org_second', userId: 'user_second' });
  assert.deepEqual([...second.store.cachedIds()], []);
  assert.equal(second.store.get('project_first_a'), null);
  // Another person in the first organization does not read the first person's cache either.
  const colleague = loadStore(shared, { userOrgId: 'org_first', userId: 'user_colleague' });
  assert.deepEqual([...colleague.store.cachedIds()], []);

  // The first account still finds its own projects when it signs in again.
  const again = loadStore(shared, { userOrgId: 'org_first', userId: 'user_first' });
  assert.equal(again.store.get('project_first_a')?.address, '1 First Street');
});

test('the page reads the cache of the account it is signed in as now, not the one it loaded with', () => {
  const shared = browser();
  const page = loadStore(shared, { userOrgId: 'org_first', userId: 'user_first' });
  page.store.cache(project('project_first_a', '1 First Street', 'First Customer'));
  page.window.__APP = { userOrgId: 'org_second', userId: 'user_second' };
  assert.equal(page.store.get('project_first_a'), null);
  assert.deepEqual([...page.store.cachedIds()], []);
});

test('without a known organization and person nothing is cached or read', () => {
  const shared = browser();
  const anonymous = loadStore(shared, {});
  const returned = anonymous.store.cache(project('project_nobody', '3 Nowhere Road', 'Nobody'));
  assert.equal(returned.address, '3 Nowhere Road');
  assert.equal(shared.local.size, 0);
  assert.equal(anonymous.store.get('project_nobody'), null);
  // An organization alone is not enough: the person decides whose cache it is.
  const orgOnly = loadStore(shared, { userOrgId: 'org_first' });
  orgOnly.store.cache(project('project_org_only', '4 Org Road', 'Org'));
  assert.equal(shared.local.size, 0);
});

test('the old browser-wide cache and a cache filed under another account are never read', () => {
  const legacy = JSON.stringify({ version: 1, projects: { project_old: project('project_old', '5 Old Road', 'Old Customer') }, measurementIndex: {} });
  const shared = browser(new Map([['fm_platform_project_store_v1', legacy]]));
  const page = loadStore(shared, { userOrgId: 'org_second', userId: 'user_second' });
  assert.equal(shared.local.has('fm_platform_project_store_v1'), false, 'the unscoped cache is dropped');
  assert.equal(page.store.get('project_old'), null);
  // A record under this account's key that names another owner is ignored.
  shared.local.set('fm_platform_project_store_v1:org_second:user_second', JSON.stringify({ version: 1, org_id: 'org_first', user_id: 'user_first', projects: { project_old: project('project_old', '5 Old Road', 'Old Customer') }, measurementIndex: {} }));
  assert.equal(page.store.get('project_old'), null);
  assert.deepEqual([...page.store.cachedIds()], []);
});

test('the cache falls back to the email when the session has no platform user id', () => {
  const shared = browser();
  const first = loadStore(shared, { userOrgId: 'org_first', userEmail: 'First@Example.test' });
  first.store.cache(project('project_email', '6 Email Way', 'Email Customer'));
  assert.ok(shared.local.has('fm_platform_project_store_v1:org_first:first@example.test'));
  const other = loadStore(shared, { userOrgId: 'org_first', userEmail: 'other@example.test' });
  assert.equal(other.store.get('project_email'), null);
});

function readPendingFrom(app, stored) {
  const start = billing.indexOf('  function readPending(');
  const end = billing.indexOf('\n  function ', start + 1);
  assert.ok(start > 0 && end > start, 'billing readPending is present');
  const local = new Map(stored === undefined ? [] : [['fm_pending_order_v1', JSON.stringify(stored)]]);
  const context = { window: { __APP: app }, localStorage: browser(local).localStorage, PENDING_ORDER_KEY: 'fm_pending_order_v1' };
  vm.createContext(context);
  vm.runInContext(billing.slice(start, end), context);
  return context.readPending();
}

test('a pending report order is only ever offered to the account that placed it', () => {
  const order = { v: 3, organization_id: 'org_first', user_id: 'user_first', fields: { address: '1 First Street' } };
  assert.equal(readPendingFrom({ userOrgId: 'org_first', userId: 'user_first' }, order)?.fields.address, '1 First Street');
  assert.equal(readPendingFrom({ userOrgId: 'org_second', userId: 'user_second' }, order), null);
  assert.equal(readPendingFrom({ userOrgId: 'org_first', userId: 'user_colleague' }, order), null);
  // An order that does not say whose it is (written before this change) is ignored.
  assert.equal(readPendingFrom({ userOrgId: 'org_first', userId: 'user_first' }, { v: 3, fields: { address: '1 First Street' } }), null);
  assert.equal(readPendingFrom({}, order), null);
  assert.equal(readPendingFrom({ userOrgId: 'org_first', userId: 'user_first' }, undefined), null);
});

test('the order form records whose pending order it is', () => {
  const start = request.indexOf('  function capturePendingOrder(');
  const end = request.indexOf('\n  function ', start + 1);
  const body = request.slice(start, end);
  assert.match(body, /organization_id: String\(window\.__APP\?\.userOrgId/);
  assert.match(body, /user_id: String\(window\.__APP\?\.userId/);
});
