import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../libraries/platform-notifications/platform-push.js', import.meta.url), 'utf8');
function setup(platform) {
  const listeners = new Map(), saved = [], removed = [], storage = new Map();
  let unregistered = 0;
  const info = { platform, capabilities: ['push'] };
  const window = {
    __APP: { userOrgId: 'org', userBranchId: 'branch' }, location: {},
    addEventListener(name, fn) { listeners.set(name, fn); }, dispatchEvent() {},
    PhoneFeatures: platform ? {
      isNative: () => true, ready: Promise.resolve(info), info: () => info,
      pushStatus: async () => ({ granted: false }),
      pushRegister: async () => ({ token: 'device-token', platform, environment: 'development' }),
      pushUnregister: async () => { unregistered++; },
    } : undefined,
    PlatformAPI: { notifications: {
      registerDevice: async (org, device) => { saved.push({ org, ...device }); return { device: { id: 'device-id' } }; },
      unregisterDevice: async (...args) => { removed.push(args); },
    } },
  };
  const store = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  vm.runInNewContext(source, { window, console, localStorage: store, sessionStorage: store,
    document: { addEventListener(name, fn) { listeners.set(name, fn); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  });
  return { window, listeners, saved, removed, unregistered: () => unregistered };
}

for (const platform of ['android', 'ios']) {
  test(`${platform}: core host registers push and releases it before logout`, async () => {
    const app = setup(platform);
    assert.equal((await app.window.PlatformPush.enable()).granted, true);
    assert.deepEqual(app.saved, [{ org: 'org', token: 'device-token', platform, branch_id: 'branch', environment: 'sandbox' }]);
    let prevented = false;
    const logout = app.listeners.get('click')({
      target: { closest: () => ({ href: '/logout.php' }) },
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true, 'navigation must stop before the first asynchronous operation');
    await logout;
    assert.deepEqual(app.removed, [['org', 'device-id']]);
    assert.equal(app.unregistered(), 1);
    assert.equal(app.window.location.href, '/logout.php');
  });
}

test('desktop does not register native push or intercept logout', async () => {
  const app = setup();
  assert.equal(app.window.PlatformPush.available(), false);
  assert.equal((await app.window.PlatformPush.enable()).available, false);
  await app.listeners.get('click')({ target: { closest: () => ({ href: '/logout.php' }) }, preventDefault() { assert.fail('desktop logout intercepted'); } });
  assert.equal(app.saved.length, 0);
});
