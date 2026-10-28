import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/* 1M8-207: with the platform off the users list shows each user's FirstMeasure level; an owner or unknown level must not read as Viewer. */
const source = await readFile(new URL('../../libraries/apps/people/people-data.js', import.meta.url), 'utf8');
const window = { FirstMatePeople: { kit: { t: (_key, fallback) => fallback, term: (_key, fallback) => fallback, ICONS: {} } }, __APP: {} };
vm.runInNewContext(source, { window, console, location: { hostname: 'localhost', origin: 'http://localhost' } });
const data = window.FirstMatePeople.data;

test('signup owner (role "owner", no level) reads as super admin and is protected', () => {
  const owner = { id: 'user_1', role: 'owner', permissions: { '*': true }, org_permissions: { level: 'owner', items: {} } };
  assert.equal(data.userLegacy(owner).level, 'super_admin');
  assert.equal(data.isOwner(owner), true);
  assert.equal(data.isOwner({ role: 'owner' }), true);
});

/* 1M8-251: another active super admin may suspend, archive or lower the owner (an owner who left); nobody else may. */
async function protectionFor(me) {
  const owner = { id: 'user_owner', email: 'owner@example.test', role: 'owner', permissions: { '*': true }, org_permissions: { level: 'owner', items: {} } };
  const win = { FirstMatePeople: { kit: { t: (_key, fallback) => fallback, term: (_key, fallback) => fallback, ICONS: {} } }, __APP: { userOrgId: 'org_test', userId: me.id, userEmail: me.email },
    Portal: { util: { hasPerm: () => true } },
    PlatformAPI: { users: { list: async () => ({ users: [owner, me] }) } } };
  vm.runInNewContext(source, { window: win, console, location: { hostname: 'localhost', origin: 'http://localhost' } });
  const people = win.FirstMatePeople.data;
  await people.load();
  return people.protection(people.user('user_owner'));
}

test('only another active super admin may change the owner', async () => {
  const superAdmin = { id: 'user_admin', email: 'admin@example.test', role: 'super_admin', status: 'active', org_permissions: { level: 'super_admin', items: {} } };
  assert.equal(await protectionFor(superAdmin), '');
  assert.equal(await protectionFor({ ...superAdmin, status: 'disabled' }), 'owner', 'a suspended super admin');
  assert.equal(await protectionFor({ ...superAdmin, role: 'admin', org_permissions: { level: 'admin', items: {} } }), 'owner', 'an admin');
});

test('the five FirstMeasure levels keep their own labels', () => {
  for (const level of ['viewer', 'manager', 'admin', 'super_admin']) assert.equal(data.userLegacy({ org_permissions: { level } }).level, level);
  const custom = data.userLegacy({ org_permissions: { level: 'custom', items: { order_reports: true, manage_billing: true } } });
  assert.equal(custom.level, 'custom');
  assert.equal(custom.items.manage_billing, true);
});

test('an unknown level is read from the flags instead of defaulting to viewer', () => {
  const adminFlags = { order_reports: true, view_reports: true, manage_billing: true, manage_company_settings: true, manage_report_settings: true, manage_company_users: true };
  assert.equal(data.userLegacy({ role: 'member', permissions: adminFlags }).level, 'admin');
  assert.equal(data.userLegacy({ role: 'member', effective_permissions: { '*': true } }).level, 'super_admin');
  assert.equal(data.userLegacy({ role: 'member', permissions: { order_reports: true, manage_billing: true } }).level, 'custom');
  assert.equal(data.userLegacy({ role: 'member', permissions: {} }).level, 'viewer');
  assert.equal(data.userLegacy({}).level, 'viewer');
});

/* 1M8-209 and 1M8-213: the invite applies the chosen level through the permissions endpoint and reports an existing account. */
async function inviteWith({ canSetLevels, level, existing = false }) {
  const calls = [];
  const win = { FirstMatePeople: { kit: { t: (_key, fallback) => fallback, term: (_key, fallback) => fallback, ICONS: {} } }, __APP: { userOrgId: 'org_test' },
    Portal: { util: { hasPerm: (key) => key === 'manage_company_users' || (canSetLevels && key === 'manage_company_user_permissions') } },
    PlatformAPI: { users: {
      create: async (_org, body) => { calls.push(['create', body.role]); return { document: { id: 'user_new', data: { email: body.email } }, emailed: true, existing_account: existing }; },
      setPermissions: async (_org, id, chosen, items) => { calls.push(['setPermissions', id, chosen, items.manage_billing]); },
      list: async () => ({ users: [] })
    } } };
  vm.runInNewContext(source, { window: win, console, location: { hostname: 'localhost', origin: 'http://localhost' } });
  const result = await win.FirstMatePeople.data.invite({ name: 'New', email: 'new@example.test', level });
  return { calls, result };
}

test('the invite sets the chosen level only for someone who may set levels', async () => {
  const allowed = await inviteWith({ canSetLevels: true, level: 'admin' });
  assert.deepEqual(allowed.calls, [['create', 'viewer'], ['setPermissions', 'user_new', 'admin', true]]);
  assert.equal(allowed.result.levelError, '');
  const denied = await inviteWith({ canSetLevels: false, level: 'admin' });
  assert.deepEqual(denied.calls, [['create', 'viewer']]);
  const viewer = await inviteWith({ canSetLevels: true, level: 'viewer', existing: true });
  assert.deepEqual(viewer.calls, [['create', 'viewer']]);
  assert.equal(viewer.result.existingAccount, true);
});
