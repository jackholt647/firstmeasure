import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(path.join(root, 'public/libraries/platform-banners/platform-banners.js'), 'utf8');

function storage(){
  const values = new Map();
  return {
    getItem(key){ return values.get(key) ?? null; },
    setItem(key, value){ values.set(key, String(value)); }
  };
}

function bannerRuntime(sessionStorage, { orgId = 'org_one', userId = 'user_one' } = {}){
  let serverDismissals = 0;
  const entry = {
    id: 'payment_setup', state: 'active', priority: 100,
    visible_surfaces: ['topbar', 'sidebar', 'notification'],
    dismissible: { topbar: false, sidebar: false, notification: false }
  };
  const window = {
    Portal: { cfg: { userOrgId: orgId }, currentUser: { id: userId } },
    PlatformAPI: { attention: {
      async list(){ return { entries: [entry] }; },
      async dismiss(){ serverDismissals++; }
    } }
  };
  const document = { body: null, readyState: 'loading', addEventListener(){} };
  vm.runInNewContext(source, { window, document, sessionStorage, console });
  return { banners: window.PlatformBanners, get serverDismissals(){ return serverDismissals; } };
}

test('each banner placement hides for the current session without changing server dismissal', async () => {
  const sharedSession = storage();
  const first = bannerRuntime(sharedSession);
  await first.banners.load('org_one');
  assert.equal(first.banners.entriesForSurface('topbar').length, 1);
  assert.equal(first.banners.entriesForSurface('sidebar').length, 1);

  await first.banners.dismiss('payment_setup', 'topbar');
  assert.equal(first.banners.entriesForSurface('topbar').length, 0);
  assert.equal(first.banners.entriesForSurface('sidebar').length, 1);
  assert.equal(first.banners.entriesForSurface('notification').length, 1);
  await first.banners.load('org_one'); // Polling must not restore the top bar.
  assert.equal(first.banners.entriesForSurface('topbar').length, 0);

  await first.banners.dismiss('payment_setup', 'sidebar');
  assert.equal(first.banners.entriesForSurface('sidebar').length, 0);
  assert.equal(first.banners.entriesForSurface('notification').length, 1);
  await first.banners.dismiss('payment_setup', 'notification');
  assert.equal(first.banners.entriesForSurface('notification').length, 1);
  assert.equal(first.serverDismissals, 0);

  const reloaded = bannerRuntime(sharedSession);
  await reloaded.banners.load('org_one');
  assert.equal(reloaded.banners.entriesForSurface('topbar').length, 0);
  assert.equal(reloaded.banners.entriesForSurface('sidebar').length, 0);

  const newSession = bannerRuntime(storage());
  await newSession.banners.load('org_one');
  assert.equal(newSession.banners.entriesForSurface('topbar').length, 1);
  assert.equal(newSession.banners.entriesForSurface('sidebar').length, 1);
});

test('session hides are scoped to the organization and user', async () => {
  const sharedSession = storage();
  const first = bannerRuntime(sharedSession);
  await first.banners.load('org_one');
  await first.banners.dismiss('payment_setup', 'topbar');

  const otherUser = bannerRuntime(sharedSession, { userId: 'user_two' });
  await otherUser.banners.load('org_one');
  assert.equal(otherUser.banners.entriesForSurface('topbar').length, 1);

  const otherOrg = bannerRuntime(sharedSession, { orgId: 'org_two' });
  await otherOrg.banners.load('org_two');
  assert.equal(otherOrg.banners.entriesForSurface('topbar').length, 1);
});
