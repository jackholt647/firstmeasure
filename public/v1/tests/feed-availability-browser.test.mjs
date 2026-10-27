import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('Feed registers independently while project Photos is offered or off', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const source = await readFile(new URL('../../libraries/apps/photos/feed.js', import.meta.url), 'utf8');
  try {
    for (const enabled of [true, false]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<main></main>');
      await page.evaluate(enabled => {
        window.registeredApps = [];
        window.Portal = {
          cfg: { userOrgId: 'offered-photos-org', userId: 'user' },
          util: { escapeHtml: String, injectCSS() {} }, ui: { showToast() {} },
          apps: { registerPortalApp: app => window.registeredApps.push(app.id) },
          tabs: { renderTabs() {} }, routeState: { get: () => ({}) },
          appFlags: { has: (group, flag) => group === 'platform' && flag === 'photos_feed' && enabled, load: async () => {} }
        };
      }, enabled);
      await page.addScriptTag({ content: source });
      await page.waitForTimeout(900);
      assert.deepEqual(await page.evaluate(() => window.registeredApps), enabled ? ['portal.photos_feed'] : []);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
