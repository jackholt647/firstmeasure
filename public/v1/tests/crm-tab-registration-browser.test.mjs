// The portal lists the CRM tab from the manifest alone, before its bundle has loaded (the bundle loads when the
// tab first opens). Without it the tab never shows and More apps cannot open it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
const lib = (p) => readFile(new URL('../../libraries/' + p, import.meta.url), 'utf8');
test('the CRM tab is listed before its bundle loads, like Feedback', async () => {
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('http://portal.test/**', async (route) => { const u = new URL(route.request().url()); if (u.pathname.startsWith('/libraries/')) { try { return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../..' + u.pathname, import.meta.url), 'utf8') }); } catch { return route.fulfill({ status: 404, body: '' }); } } return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message)); await page.goto('http://portal.test/');
const entitlement = (id) => ({ id, allowed: true, visible: { desktop: true, mobile: true }, visible_devices: ['desktop', 'mobile'], reasons: [] });
await page.evaluate((ents) => {
  const effective = { 'apps.crm': true, 'crm.views': true, 'apps.feedback': true, 'platform.expanded_access': true, 'platform.more_apps': true };
  window.PlatformAPI = { capabilities: { current: () => ({ loaded_at: 'x', org_id: 'org', definitions_by_key: Object.fromEntries(Object.keys(effective).map((k) => [k, { key: k }])), definitions: [{ key: 'apps.crm', kind: 'app', runtime_app_id: 'crm' }, { key: 'apps.feedback', kind: 'app', runtime_app_id: 'feedback' }], effective_by_key: effective }), value: (k, d) => effective[k] ?? d } };
  window.Portal = { currentUser: { app_entitlements: ents, permissions: {} }, appExperience: { app_ids: ['portal.crm', 'portal.feedback'], device_types: { types: [{ id: 'desktop' }, { id: 'mobile' }], classify: [] } } };
}, [entitlement('portal.crm'), entitlement('portal.feedback')]);
await page.addScriptTag({ content: await lib('app-runtime/firstmate-embeddable-apps.js') });
await page.addScriptTag({ url: 'http://portal.test/libraries/apps/firstmate-apps-manifest.js' });
const listed = await page.evaluate(() => window.FirstMateEmbeddableApps.listApps({ surface: 'portal_tab', source: 'portal_shell', chrome: 'tab' }).map((m) => m.id));
assert.ok(listed.includes('portal.feedback'), 'the harness lists a known app');
assert.ok(listed.includes('portal.crm'), 'the CRM tab is listed from the manifest');
await browser.close();
});
