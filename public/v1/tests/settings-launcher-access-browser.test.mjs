import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-236: Settings is offered only when it has a page for the person: their own pages the organization switched on, or a
   page their permissions open (the section gates in settings/company.js). */
test('the Settings launcher is hidden for someone who can only view reports', async () => {
  const core = await readFile(new URL('../../portal/scripts/core.js', import.meta.url), 'utf8');
  const start = core.indexOf('  const SETTINGS_PERMISSIONS = ');
  const gate = core.slice(start, core.indexOf('  function renderSidebarLaunchers(', start));
  assert.ok(start > 0 && gate.includes('function settingsAvailable()'), 'the gate is in core.js');
  const launchers = core.slice(core.indexOf('  function renderSidebarLaunchers('), core.indexOf('  function renderTabs('));
  assert.match(launchers, /const settingsTab = settingsAvailable\(\) \? list\.find/, 'the launcher uses the gate');

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<body></body>');
    await page.addScriptTag({ content: `
      window.Portal = { currentUser: { permissions: {} }, appFlags: { on: new Set(), has(group, key) { return this.on.has(group + '.' + key); }, value(group, key, fallback) { return this.on.has(group + '.' + key) || fallback; } } };
      function hasPerm(key) { const p = window.Portal.currentUser.permissions || {}; return !!p['*'] || !!p[key]; }
      ${gate}
      window.check = (permissions, flags = []) => { window.Portal.currentUser.permissions = permissions; window.Portal.appFlags.on = new Set(flags); return settingsAvailable(); };
    ` });
    const check = (permissions, flags) => page.evaluate(([p, f]) => window.check(p, f), [permissions, flags]);
    assert.equal(await check({}), true, 'nothing hidden before permissions arrive');
    assert.equal(await check({ view_reports: true }), false, 'view reports only: no Settings');
    assert.equal(await check({ view_reports: true, order_reports: true }), false, 'ordering adds no Settings page');
    for (const key of ['manage_company_settings', 'manage_company_users', 'manage_company_user_permissions', 'manage_report_settings', 'manage_billing']) {
      assert.equal(await check({ view_reports: true, [key]: true }), true, key);
    }
    assert.equal(await check({ '*': true }), true, 'owner');
    assert.equal(await check({ view_reports: true }, ['platform.my_settings']), true, 'My Settings switched on for the organization');
    assert.equal(await check({ view_reports: true }, ['apps.notifications']), true, 'Notifications switched on');
    assert.equal(await check({ view_reports: true }, ['apps.assistant']), false, 'AI Agents needs project access too');
  } finally { await browser.close(); }
});
