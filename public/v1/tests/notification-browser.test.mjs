import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../libraries/platform-notifications/platform-notifications.js', import.meta.url), 'utf8');
test('silent deliveries remain visible without alerts; hidden bell items can still alert', async () => {
  let response = { notifications: [] }, sounds = 0, celebrations = 0;
  const window = {
    PlatformAPI: { notifications: { list: async () => response, setUserState: async () => ({}) } },
    PlatformCelebrations: { indicator: () => sounds++, fromNotification: () => celebrations++ }
  };
  runInNewContext(source, { window, setTimeout });
  const load = () => window.PlatformNotifications.load('org');
  await load();
  response = { notifications: [{ id: 'silent', presentation: { sound: false, badge: false, bell: true } }] };
  let state = await load();
  assert.equal(state.notifications.length, 1);
  assert.equal(state.unread_count, 0);
  assert.equal(sounds, 0);
  response.in_app_alerts = [{ id: 'message', presentation: { sound: true, bell: false } }];
  state = await load();
  assert.equal(state.notifications.length, 1);
  assert.equal(sounds, 1);
  await load();
  assert.equal(sounds, 1, 'polling does not repeat alerts');
  response.notifications.push({ id: 'celebration', kind: 'celebration', presentation: { sound: false, bell: true } });
  state = await load();
  assert.equal(state.notifications.length, 2);
  assert.equal(celebrations, 0);
  assert.equal(sounds, 1);
});
